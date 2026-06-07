// Deliveroo capture dashboard -- Node.js/Express backend.
// Routes:
//   GET /              serve dashboard SPA
//   GET /cert.pem      serve mitmproxy CA cert for browser installation
//   GET /api/captures  list recent captures (no bodies)
//   GET /api/captures/:id  single capture with full req/resp bodies
//   GET /api/endpoints  grouped endpoint summary
//   GET /api/captures.csv  full export as CSV

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/captures.db';
const DATA_DIR = path.dirname(DB_PATH);
const CERT_PATH = path.join(DATA_DIR, 'mitmproxy-ca-cert.pem');

app.use(express.static(path.join(__dirname, 'public')));

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

// CA cert download -- browser needs this to trust the proxy
app.get('/cert.pem', (req, res) => {
  if (!fs.existsSync(CERT_PATH)) {
    return res.status(404).json({
      error: 'Cert not yet available -- proxy may still be starting (give it a few seconds)',
    });
  }
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="mitmproxy-ca-cert.pem"');
  res.sendFile(CERT_PATH);
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

app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
});
