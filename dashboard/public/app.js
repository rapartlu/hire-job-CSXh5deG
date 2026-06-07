// Deliveroo Capture Dashboard -- client-side JS

// ── Tab navigation ────────────────────────────────────────────────────────

const tabs = document.querySelectorAll('.tab-btn');
const contents = document.querySelectorAll('.tab-content');

tabs.forEach(btn => {
  btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.remove('active'));
    contents.forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    const tabId = 'tab-' + btn.dataset.tab;
    document.getElementById(tabId).classList.remove('hidden');
    if (btn.dataset.tab === 'live') loadCaptures();
    if (btn.dataset.tab === 'endpoints') loadEndpoints();
  });
});

// ── Live feed ─────────────────────────────────────────────────────────────

let refreshTimer = null;

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString(); }
  catch (e) { return ts || ''; }
}

function statusClass(code) {
  if (!code) return '';
  if (code < 300) return 'status-ok';
  if (code < 400) return 'status-redir';
  return 'status-err';
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search ? u.search.slice(0, 50) : '');
    return path;
  } catch (e) {
    return (url || '').slice(0, 60);
  }
}

function fmtJson(str) {
  if (str === null || str === undefined || str === '') return '(empty)';
  try { return JSON.stringify(JSON.parse(str), null, 2); }
  catch (e) { return str; }
}

async function loadCaptures() {
  try {
    const res = await fetch('/api/captures');
    const rows = await res.json();
    const tbody = document.getElementById('captures-tbody');
    const countEl = document.getElementById('capture-count');
    countEl.textContent = rows.length + ' captures';

    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No captures yet &mdash; browse deliveroo.co.uk with the proxy running</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r =>
      '<tr class="capture-row" data-id="' + r.id + '">' +
        '<td>' + fmtTime(r.ts) + '</td>' +
        '<td><span class="method method-' + r.method + '">' + r.method + '</span></td>' +
        '<td class="url-cell" title="' + r.url + '">' + shortUrl(r.url) + '</td>' +
        '<td><span class="' + statusClass(r.resp_status) + '">' + r.resp_status + '</span></td>' +
      '</tr>'
    ).join('');

    tbody.querySelectorAll('.capture-row').forEach(row => {
      row.addEventListener('click', () => openInspector(row.dataset.id));
    });
  } catch (e) {
    console.error('Failed to load captures', e);
  }
}

async function openInspector(id) {
  const inspector = document.getElementById('inspector');
  try {
    const res = await fetch('/api/captures/' + id);
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('insp-title').textContent = data.method + ' ' + shortUrl(data.url);
    document.getElementById('insp-status').textContent = data.resp_status;
    document.getElementById('insp-req-headers').textContent = fmtJson(data.req_headers);
    document.getElementById('insp-req-body').textContent = fmtJson(data.req_body);
    document.getElementById('insp-resp-headers').textContent = fmtJson(data.resp_headers);
    document.getElementById('insp-resp-body').textContent = fmtJson(data.resp_body);
    inspector.classList.remove('hidden');
  } catch (e) {
    console.error('Failed to load capture', e);
  }
}

document.getElementById('insp-close').addEventListener('click', () => {
  document.getElementById('inspector').classList.add('hidden');
});

document.getElementById('refresh-btn').addEventListener('click', loadCaptures);

document.getElementById('auto-refresh').addEventListener('change', function () {
  clearInterval(refreshTimer);
  if (this.checked) refreshTimer = setInterval(loadCaptures, 5000);
});

// Start auto-refresh immediately
refreshTimer = setInterval(loadCaptures, 5000);
loadCaptures();

// ── Endpoints ─────────────────────────────────────────────────────────────

async function loadEndpoints() {
  try {
    const res = await fetch('/api/endpoints');
    const rows = await res.json();
    const tbody = document.getElementById('endpoints-tbody');

    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="3">No data yet</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(r =>
      '<tr>' +
        '<td><span class="method method-' + r.method + '">' + r.method + '</span></td>' +
        '<td class="url-cell">' + r.path + '</td>' +
        '<td>' + r.count + '</td>' +
      '</tr>'
    ).join('');
  } catch (e) {
    console.error('Failed to load endpoints', e);
  }
}

document.getElementById('endpoints-refresh').addEventListener('click', loadEndpoints);
