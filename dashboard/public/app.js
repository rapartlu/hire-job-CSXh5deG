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
    if (btn.dataset.tab === 'search') initSearch();
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

// ── Search (Milestone 2) ──────────────────────────────────────────────────

let searchInitDone = false;
let exposedFilters = [];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addAreaRow(prefill) {
  const tbody = document.getElementById('areas-tbody');
  const tr = document.createElement('tr');
  const p = prefill || {};
  tr.innerHTML =
    '<td><input class="a-label" placeholder="e.g. Home" value="' + esc(p.label || '') + '"></td>' +
    '<td><input class="a-geohash" placeholder="gcpvj0duq..." value="' + esc(p.geohash || '') + '"></td>' +
    '<td><input class="a-city" placeholder="london" value="' + esc(p.city_uname || '') + '"></td>' +
    '<td><input class="a-hood" placeholder="shoreditch" value="' + esc(p.neighborhood_uname || '') + '"></td>' +
    '<td><button class="btn btn-sm remove-area">&times;</button></td>';
  tr.querySelector('.remove-area').addEventListener('click', () => tr.remove());
  tbody.appendChild(tr);
}

function readAreas() {
  const rows = document.querySelectorAll('#areas-tbody tr');
  const areas = [];
  rows.forEach(tr => {
    const geohash = tr.querySelector('.a-geohash').value.trim();
    const city = tr.querySelector('.a-city').value.trim();
    const hood = tr.querySelector('.a-hood').value.trim();
    const label = tr.querySelector('.a-label').value.trim();
    if (geohash || (city && hood)) {
      areas.push({ label: label || hood || geohash, geohash, city_uname: city, neighborhood_uname: hood });
    }
  });
  return areas;
}

function renderFilters(filters) {
  exposedFilters = filters || [];
  const host = document.getElementById('filters-list');
  if (!exposedFilters.length) {
    host.innerHTML = '<span class="hint">No filters captured yet &mdash; run a filtered search on deliveroo.co.uk and recapture to see options here.</span>';
    return;
  }
  host.innerHTML = exposedFilters.map(f =>
    '<div class="filter-group"><strong>' + esc(f.header) + '</strong>' +
    f.options.map(o =>
      '<label class="filter-opt"><input type="checkbox" data-filter="' + esc(f.id) +
      '" data-value="' + esc(o.id) + '"' + (o.selected ? ' checked' : '') + '> ' +
      esc(o.name) + (o.count != null ? ' <span class="hint">(' + o.count + ')</span>' : '') + '</label>'
    ).join('') + '</div>'
  ).join('');
}

function readFilters() {
  const filters = {};
  document.querySelectorAll('#filters-list input[type=checkbox]:checked').forEach(cb => {
    filters[cb.dataset.filter] = cb.dataset.value;
  });
  return filters;
}

async function initSearch() {
  if (searchInitDone) return;
  searchInitDone = true;
  const statusEl = document.getElementById('search-status');
  const controls = document.getElementById('search-controls');
  try {
    const res = await fetch('/api/search/template');
    const t = await res.json();
    if (!t.ready) {
      statusEl.innerHTML = '&#9888; No restaurant search captured yet. With the proxy running, search a postcode on ' +
        '<a href="https://deliveroo.co.uk" target="_blank" rel="noopener">deliveroo.co.uk</a>, then come back &mdash; ' +
        'this page replays that search across every area you list.';
      return;
    }
    const loc = t.location || {};
    statusEl.innerHTML = '&#10003; Search captured ' +
      (t.capturedAt ? 'at ' + fmtTime(t.capturedAt) : '') +
      (loc.neighborhood_uname ? ' for <strong>' + esc(loc.neighborhood_uname) + '</strong>' : '') +
      '. Add areas below and search them all at once.';
    controls.classList.remove('hidden');
    addAreaRow({
      label: loc.neighborhood_uname || 'Captured area',
      geohash: loc.geohash, city_uname: loc.city_uname, neighborhood_uname: loc.neighborhood_uname,
    });
    addAreaRow({});
    renderFilters(t.exposedFilters);
  } catch (e) {
    statusEl.textContent = 'Could not check for a captured search: ' + e.message;
  }
}

async function runSearch() {
  const areas = readAreas();
  const spinner = document.getElementById('search-spinner');
  const resultsBox = document.getElementById('search-results');
  if (!areas.length) {
    alert('Add at least one area (geohash, or city + neighbourhood).');
    return;
  }
  spinner.classList.remove('hidden');
  try {
    const res = await fetch('/api/search/multi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ areas, filters: readFilters() }),
    });
    const data = await res.json();
    spinner.classList.add('hidden');
    if (!data.ok) {
      document.getElementById('results-summary').innerHTML = '&#9888; ' + esc(data.error || 'Search failed.');
      resultsBox.classList.remove('hidden');
      document.getElementById('area-breakdown').innerHTML = '';
      document.getElementById('results-tbody').innerHTML = '';
      return;
    }
    if (data.exposedFilters && data.exposedFilters.length) renderFilters(data.exposedFilters);

    document.getElementById('results-summary').innerHTML =
      '<strong>' + data.total + '</strong> unique restaurants across ' + data.perArea.length + ' area(s).';

    document.getElementById('area-breakdown').innerHTML = data.perArea.map(a =>
      '<span class="area-chip ' + (a.ok ? 'ok' : 'err') + '">' + esc(a.label) + ': ' +
      (a.ok ? a.count + ' found' : 'failed' + (a.status ? ' (' + a.status + ')' : '')) + '</span>'
    ).join('');

    const tbody = document.getElementById('results-tbody');
    if (!data.restaurants.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No restaurants returned. If areas failed, the captured session may have expired &mdash; recapture a search and retry.</td></tr>';
    } else {
      tbody.innerHTML = data.restaurants.map(r => {
        const loc = r.location ? (r.location.area + (r.location.city ? ', ' + r.location.city : '')) : '&mdash;';
        const link = r.href ? '<a href="https://deliveroo.co.uk' + esc(r.href) + '" target="_blank" rel="noopener">open</a>' : '';
        return '<tr><td>' + esc(r.name) + '</td><td>' + esc(loc) + '</td><td>' +
          r.areas.map(a => '<span class="area-chip sm">' + esc(a) + '</span>').join('') + '</td><td>' + link + '</td></tr>';
      }).join('');
    }
    resultsBox.classList.remove('hidden');
  } catch (e) {
    spinner.classList.add('hidden');
    document.getElementById('results-summary').textContent = 'Search error: ' + e.message;
    resultsBox.classList.remove('hidden');
  }
}

document.getElementById('add-area').addEventListener('click', () => addAreaRow({}));
document.getElementById('run-search').addEventListener('click', runSearch);
