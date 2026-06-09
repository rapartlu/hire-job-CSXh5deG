// Deliveroo capture dashboard -- Node.js/Express backend.
// Routes:
//   GET /              serve dashboard SPA
//   GET /cert.pem      serve mitmproxy CA cert for browser installation
//   GET /api/captures  list recent captures (no bodies)
//   GET /api/captures/:id  single capture with full req/resp bodies
//   GET /api/endpoints  grouped endpoint summary
//   GET /api/captures.csv  full export as CSV
//   GET /api/search/template  whether a usable search capture exists (Milestone 2)
//   POST /api/search/multi    multi-area search + location filter (Milestone 2)

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const search = require('./search');

const app = express();
app.use(express.json({ limit: '1mb' }));
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

// ── Milestone 2: multi-area search + location filter ──────────────────────

// Is there a usable restaurant-search capture to replay? Returns the location
// and exposed filters from the most recent search, never the session token.
app.get('/api/search/template', (req, res) => {
  try {
    res.json(search.templateStatus(DB_PATH));
  } catch (err) {
    res.status(500).json({ ready: false, error: err.message });
  }
});

// Run a multi-area search. Body: { areas: [{ geohash, city_uname,
// neighborhood_uname, label }], filters: { paramName: value } }.
// Replays the captured authenticated search once per area, merges and
// deduplicates restaurants by id, and tags each with the areas it appeared in.
app.post('/api/search/multi', async (req, res) => {
  const { areas, filters } = req.body || {};
  if (!Array.isArray(areas) || areas.length === 0) {
    return res.status(400).json({ ok: false, error: 'Provide at least one area to search.' });
  }
  if (areas.length > 12) {
    return res.status(400).json({ ok: false, error: 'Limit of 12 areas per search to stay within rate limits.' });
  }
  try {
    const result = await search.multiAreaSearch(DB_PATH, areas, filters || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
});
