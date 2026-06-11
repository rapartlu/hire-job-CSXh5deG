// Deliveroo capture dashboard -- Node.js/Express backend.
// Routes:
//   GET /              serve dashboard SPA
//   GET /cert.pem      serve mitmproxy CA cert for browser installation
//   GET /api/captures  list recent captures (no bodies)
//   GET /api/captures/:id  single capture with full req/resp bodies
//   GET /api/endpoints  grouped endpoint summary
//   GET /api/captures.csv  full export as CSV
//   POST /api/search   multi-area restaurant search via Deliveroo API (Milestone 2)

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { QUERY: DELIVEROO_QUERY, DEFAULT_VARS } = require('./deliveroo-query.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/captures.db';
const DATA_DIR = path.dirname(DB_PATH);
// The proxy runs mitmproxy with confdir=/data/mitmproxy, so the CA cert lands
// at /data/mitmproxy/mitmproxy-ca-cert.pem on the shared volume. The legacy
// path (a direct child of the data dir) is kept as a fallback in case an older
// proxy image is still running.
const CERT_PATHS = [
  path.join(DATA_DIR, 'mitmproxy', 'mitmproxy-ca-cert.pem'),
  path.join(DATA_DIR, 'mitmproxy-ca-cert.pem'),
];

function findCert() {
  return CERT_PATHS.find((p) => fs.existsSync(p));
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

// CA cert download -- browser needs this to trust the proxy
app.get('/cert.pem', (req, res) => {
  const certPath = findCert();
  if (!certPath) {
    return res.status(404).json({
      error: 'Cert not yet available -- proxy may still be starting (give it a few seconds)',
    });
  }
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="mitmproxy-ca-cert.pem"');
  res.sendFile(certPath);
});

// List captures -- no bodies to keep payload small
app.get('/api/captures', (req, res) => {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT id, ts, method, url, resp_status FROM captures ORDER BY id DESC LIMIT 200'
      )
      .all();
    db.close();
    res.json(rows);
  } catch (err) {
    if (err.code === 'SQLITE_CANTOPEN') return res.json([]);
    res.status(500).json({ error: err.message });
  }
});

// Single capture with full bodies
app.get('/api/captures/:id', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id);
    db.close();
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint summary -- grouped by method + path
app.get('/api/endpoints', (req, res) => {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT
           method,
           REPLACE(REPLACE(url, 'https://', ''), 'http://', '') AS path,
           COUNT(*) AS count
         FROM captures
         GROUP BY method, path
         ORDER BY count DESC
         LIMIT 100`
      )
      .all();
    db.close();
    res.json(rows);
  } catch (err) {
    if (err.code === 'SQLITE_CANTOPEN') return res.json([]);
    res.status(500).json({ error: err.message });
  }
});

// Debug: all Deliveroo hosts seen through the proxy
// Useful when the captures table is empty -- shows whether ANY Deliveroo
// traffic is reaching the addon and which domains are being proxied.
app.get('/api/debug/hosts', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT host, first_seen, last_seen, request_count, is_captured
       FROM seen_hosts
       ORDER BY request_count DESC`
    ).all();
    db.close();
    res.json(rows);
  } catch (err) {
    if (err.code === 'SQLITE_CANTOPEN') return res.json([]);
    if (err.code === 'SQLITE_ERROR' && err.message.includes('no such table')) {
      // Old DB schema (before seen_hosts was added) -- return empty
      return res.json([]);
    }
    res.status(500).json({ error: err.message });
  }
});

// Full CSV export
app.get('/api/captures.csv', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM captures ORDER BY id DESC').all();
    db.close();
    const headers = [
      'id', 'ts', 'method', 'url',
      'req_headers', 'req_body',
      'resp_status', 'resp_headers', 'resp_body',
    ];
    const csv = [
      headers.join(','),
      ...rows.map(row =>
        headers.map(h => JSON.stringify(row[h] != null ? row[h] : '')).join(',')
      ),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="captures.csv"');
    res.send(csv);
  } catch (err) {
    if (err.code === 'SQLITE_CANTOPEN') return res.status(404).send('No captures yet');
    res.status(500).json({ error: err.message });
  }
});

// ── Milestone 2: Multi-area restaurant search ──────────────────────────────

// Extract restaurant data from a getHomeFeed response.
// Walks layoutGroups -> ui_layouts -> ui_blocks -> UICard -> UITargetRestaurant.
function extractRestaurants(data) {
  const restaurants = [];
  const seen = new Set();

  const layoutGroups = data?.data?.results?.layoutGroups || [];

  for (const group of layoutGroups) {
    for (const layout of (group.data || [])) {
      const blocks = layout.blocks || [];
      for (const block of blocks) {
        if (block.typeName !== 'UICard') continue;
        const target = block.target;
        if (!target || target.typeName !== 'UITargetRestaurant') continue;

        const r = target.restaurant;
        if (!r || !r.id || seen.has(r.id)) continue;
        seen.add(r.id);

        // Collect text from the card's UI lines (name, cuisine, rating, delivery time etc.)
        const cardText = extractCardText(block.uiContent?.default?.uiLines || []);

        restaurants.push({
          id: r.id,
          name: r.name || '',
          href: r.links?.self?.href || '',
          card_text: cardText,
          found_in: [], // populated by caller
        });
      }
    }
  }

  return restaurants;
}

// Concatenate visible text from a UILine array into a compact summary string.
function extractCardText(uiLines) {
  const parts = [];
  for (const line of uiLines) {
    // UITitleLine has a direct text property
    if (typeof line.text === 'string' && line.text.trim()) {
      parts.push(line.text.trim());
    }
    // UITextLine and UIBulletLine have spans
    for (const span of (line.spans || [])) {
      if (span.typeName === 'UISpanText' && typeof span.text === 'string' && span.text.trim()) {
        parts.push(span.text.trim());
      }
    }
  }
  // Dedupe while preserving order
  const dedupedParts = [];
  const seen = new Set();
  for (const p of parts) {
    if (!seen.has(p)) { seen.add(p); dedupedParts.push(p); }
  }
  return dedupedParts.join(' · ');
}

// Call Deliveroo's getHomeFeed API for one area and return restaurant list.
async function fetchAreaRestaurants(bearerToken, area) {
  const {
    geohash,
    city_uname = 'london',
    neighborhood_uname,
  } = area;

  const slug = neighborhood_uname ||
    (area.label || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') ||
    'london';

  const variables = {
    ...DEFAULT_VARS,
    location: {
      geohash,
      city_uname,
      neighborhood_uname: slug,
      postcode: '',
    },
    url: `https://deliveroo.co.uk/restaurants/${city_uname}/${slug}?geohash=${geohash}`,
    uuid: crypto.randomUUID(),
  };

  const token = bearerToken.startsWith('Bearer ') ? bearerToken : `Bearer ${bearerToken}`;

  const response = await fetch('https://api.uk.deliveroo.com/consumer/graphql/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, application/vnd.api+json',
      'Authorization': token,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0 (deliveroo/consumer-web-app; browser)',
      'X-Roo-Client': 'consumer-web-app',
      'X-Roo-Platform': 'web',
      'X-Roo-Country': 'uk',
      'Origin': 'https://deliveroo.co.uk',
      'Referer': 'https://deliveroo.co.uk/',
    },
    body: JSON.stringify({ query: DELIVEROO_QUERY, variables }),
  });

  if (response.status === 401) {
    throw new Error('Token expired or invalid -- paste a fresh Bearer token from browser DevTools');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Deliveroo API ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();

  if (data.errors && data.errors.length) {
    const msgs = data.errors.map((e) => e.message).join('; ');
    throw new Error(`GraphQL error: ${msgs}`);
  }

  return extractRestaurants(data);
}

// POST /api/search
// Body: {
//   token: "eyJ..." | "Bearer eyJ...",
//   areas: [{ label, geohash, city_uname?, neighborhood_uname? }, ...]
// }
// Response: {
//   restaurants: [{ id, name, href, card_text, found_in: [areaLabel, ...] }],
//   total_unique: N,
//   areas_searched: N,
//   errors: [{ area, error }, ...]
// }
app.post('/api/search', async (req, res) => {
  const { token, areas } = req.body || {};

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token required' });
  }
  if (!Array.isArray(areas) || areas.length === 0) {
    return res.status(400).json({ error: 'areas array required' });
  }

  // Cap at 10 areas to avoid hammering the Deliveroo API
  const targetAreas = areas.slice(0, 10);
  const allRestaurants = new Map(); // id -> restaurant
  const errors = [];

  for (const area of targetAreas) {
    if (!area.geohash) {
      errors.push({ area: area.label || '(unnamed)', error: 'geohash required' });
      continue;
    }
    try {
      const restaurants = await fetchAreaRestaurants(token, area);
      for (const r of restaurants) {
        if (allRestaurants.has(r.id)) {
          allRestaurants.get(r.id).found_in.push(area.label || area.geohash);
        } else {
          r.found_in = [area.label || area.geohash];
          allRestaurants.set(r.id, r);
        }
      }
    } catch (err) {
      errors.push({ area: area.label || area.geohash, error: err.message });
    }
    // Polite delay between area requests
    if (targetAreas.indexOf(area) < targetAreas.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  res.json({
    restaurants: Array.from(allRestaurants.values()),
    total_unique: allRestaurants.size,
    areas_searched: targetAreas.length,
    errors,
  });
});

app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
});
