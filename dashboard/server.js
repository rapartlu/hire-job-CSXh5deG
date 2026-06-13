// Deliveroo capture dashboard -- Node.js/Express backend.
// Routes:
//   GET /              serve dashboard SPA
//   GET /cert.pem      serve mitmproxy CA cert for browser installation
//   GET /api/captures  list recent captures (no bodies)
//   GET /api/captures/:id  single capture with full req/resp bodies
//   GET /api/endpoints  grouped endpoint summary
//   GET /api/captures.csv  full export as CSV
//   POST /api/search   multi-area restaurant search via Deliveroo API (Milestone 2)
//   GET /api/rules              list all MITM rules (Milestone 3)
//   POST /api/rules             create rule
//   PUT /api/rules/:id          update rule
//   DELETE /api/rules/:id       delete rule
//   POST /api/rules/:id/toggle  toggle active state

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

// ── Milestone 3: Rule engine CRUD ─────────────────────────────────────────

// Open DB for writes (idempotent -- proxy also runs _ensure_db).
// Creates the rules table if absent (e.g. fresh DB before proxy has started).
function getDbWrite() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      scope       TEXT    NOT NULL DEFAULT 'request',
      match_url   TEXT    NOT NULL DEFAULT '',
      target      TEXT    NOT NULL,
      action      TEXT    NOT NULL DEFAULT 'set',
      value       TEXT    NOT NULL DEFAULT 'null',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL
    )
  `);
  return db;
}

// GET /api/rules -- list all rules ordered by id
app.get('/api/rules', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM rules ORDER BY id ASC').all();
    db.close();
    res.json(rows);
  } catch (err) {
    if (err.code === 'SQLITE_CANTOPEN') return res.json([]);
    if (err.message && err.message.includes('no such table')) return res.json([]);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rules -- create a new rule
app.post('/api/rules', (req, res) => {
  const {
    name,
    description = '',
    scope = 'request',
    match_url = '',
    target,
    action = 'set',
    value = 'null',
    active = 1,
  } = req.body || {};

  if (!name || !target) return res.status(400).json({ error: 'name and target are required' });
  if (!['request', 'response'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be request or response' });
  }
  if (!['set', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'action must be set or delete' });
  }

  try {
    const db = getDbWrite();
    const info = db
      .prepare(
        `INSERT INTO rules
           (name, description, scope, match_url, target, action, value, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        description,
        scope,
        match_url,
        target,
        action,
        value,
        active ? 1 : 0,
        new Date().toISOString()
      );
    const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(info.lastInsertRowid);
    db.close();
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rules/:id -- update rule fields
app.put('/api/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

  const {
    name,
    description = '',
    scope = 'request',
    match_url = '',
    target,
    action = 'set',
    value = 'null',
    active = 1,
  } = req.body || {};

  if (!name || !target) return res.status(400).json({ error: 'name and target are required' });

  try {
    const db = getDbWrite();
    const info = db
      .prepare(
        `UPDATE rules
         SET name=?, description=?, scope=?, match_url=?, target=?, action=?, value=?, active=?
         WHERE id=?`
      )
      .run(name, description, scope, match_url, target, action, value, active ? 1 : 0, id);

    if (!info.changes) {
      db.close();
      return res.status(404).json({ error: 'Rule not found' });
    }
    const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
    db.close();
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rules/:id -- remove rule
app.delete('/api/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

  try {
    const db = getDbWrite();
    const info = db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    db.close();
    if (!info.changes) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rules/:id/toggle -- flip active flag
app.post('/api/rules/:id/toggle', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

  try {
    const db = getDbWrite();
    const rule = db.prepare('SELECT id, active FROM rules WHERE id = ?').get(id);
    if (!rule) {
      db.close();
      return res.status(404).json({ error: 'Rule not found' });
    }
    const newActive = rule.active ? 0 : 1;
    db.prepare('UPDATE rules SET active = ? WHERE id = ?').run(newActive, id);
    const updated = db.prepare('SELECT * FROM rules WHERE id = ?').get(id);
    db.close();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Startup: seed example rules ───────────────────────────────────────────
// The proxy seeds these on first init via _ensure_db(). This fallback runs
// in the dashboard in case the dashboard container starts before the proxy
// has a chance to write to the shared volume (race condition on first boot),
// or for customers running the dashboard standalone.

const SEED_RULES = [
  {
    name: 'Include Collection',
    description:
      'Adds COLLECTION to fulfillment_methods. Default Deliveroo web app sends DELIVERY only ' +
      '-- enabling this surfaces pickup/collection venues that are hidden in the standard ' +
      'delivery search, often with no delivery fee.',
    scope: 'request',
    match_url: '/consumer/graphql',
    target: 'fulfillment_methods',
    action: 'set',
    value: '["DELIVERY","COLLECTION"]',
  },
  {
    name: 'Collection Only',
    description:
      'Restricts results to venues offering click-and-collect/pickup only. ' +
      'Useful for browsing collection options without a delivery fee.',
    scope: 'request',
    match_url: '/consumer/graphql',
    target: 'fulfillment_methods',
    action: 'set',
    value: '["COLLECTION"]',
  },
  {
    name: 'Remove Result Cap',
    description:
      'Drops LIMIT_QUERY_RESULTS from ui_features. Deliveroo includes this flag in default ' +
      'web requests -- removing it may increase the number of restaurants returned per search.',
    scope: 'request',
    match_url: '/consumer/graphql',
    target: 'ui_features',
    action: 'set',
    value:
      '["UNAVAILABLE_RESTAURANTS","UI_CARD_BORDER","UI_CAROUSEL_COLOR","UI_PROMOTION_TAG",' +
      '"UI_BACKGROUND","SCHEDULED_RANGES","UI_SPAN_TAGS","UI_CARD_BADGES","TEXT_SEARCH_COMBINED_VIEW"]',
  },
  {
    name: 'Cuisine Filter',
    description:
      'Injects a cuisine keyword into options.query. Change the value to any cuisine ' +
      '("sushi", "pizza", "thai", etc.) to filter results. Set to "" to clear. ' +
      'This overrides whatever is typed in the Deliveroo search box.',
    scope: 'request',
    match_url: '/consumer/graphql',
    target: 'options.query',
    action: 'set',
    value: '"sushi"',
  },
];

function seedExampleRules() {
  try {
    const db = getDbWrite();
    const count = db.prepare('SELECT COUNT(*) as n FROM rules').get().n;
    if (count === 0) {
      const now = new Date().toISOString();
      const insert = db.prepare(
        `INSERT INTO rules
           (name, description, scope, match_url, target, action, value, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      );
      for (const rule of SEED_RULES) {
        insert.run(
          rule.name, rule.description, rule.scope, rule.match_url,
          rule.target, rule.action, rule.value, now
        );
      }
      console.log(`Seeded ${SEED_RULES.length} example rules.`);
    }
    db.close();
  } catch (err) {
    // Non-fatal: proxy will seed on its own init
    console.warn('Rule seed skipped (DB not ready yet):', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  seedExampleRules();
});
