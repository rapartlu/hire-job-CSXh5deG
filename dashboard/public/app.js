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
    if (btn.dataset.tab === 'rules') initRulesTab();
    if (btn.dataset.tab === 'search') initSearchTab();
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

// ── Restaurant Search (Milestone 2) ───────────────────────────────────────

let searchAreas = []; // [{id, label, geohash, city_uname, neighborhood_uname}]
let searchResults = []; // last full result set (unfiltered)
let searchTabReady = false;

function initSearchTab() {
  if (searchTabReady) return;
  searchTabReady = true;

  // Restore saved token
  const saved = localStorage.getItem('deliveroo_token');
  if (saved) {
    document.getElementById('search-token').value = saved;
    document.getElementById('token-status').textContent = 'Token loaded from storage';
  }

  // Restore saved areas
  const savedAreas = localStorage.getItem('deliveroo_areas');
  if (savedAreas) {
    try { searchAreas = JSON.parse(savedAreas); } catch (e) { searchAreas = []; }
  }
  if (!searchAreas.length) {
    // Default example area so the UI isn't blank on first load
    searchAreas = [{ id: uid(), label: 'Biggin Hill', geohash: 'u10h0869370q', city_uname: 'london', neighborhood_uname: 'biggin-hill' }];
  }
  renderAreas();

  document.getElementById('save-token-btn').addEventListener('click', saveToken);
  document.getElementById('add-area-btn').addEventListener('click', addArea);
  document.getElementById('run-search-btn').addEventListener('click', runSearch);
  document.getElementById('filter-multi-only').addEventListener('change', applyFilters);
  document.getElementById('filter-exclude-area').addEventListener('change', applyFilters);
  document.getElementById('filter-exclude-select').addEventListener('change', applyFilters);
  document.getElementById('filter-rule').addEventListener('input', applyFilters);
  document.getElementById('export-results-btn').addEventListener('click', exportResultsCSV);
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function saveToken() {
  const val = document.getElementById('search-token').value.trim();
  if (!val) return;
  localStorage.setItem('deliveroo_token', val);
  document.getElementById('token-status').textContent = 'Saved';
  setTimeout(() => { document.getElementById('token-status').textContent = ''; }, 2000);
}

function persistAreas() {
  localStorage.setItem('deliveroo_areas', JSON.stringify(searchAreas));
}

function renderAreas() {
  const list = document.getElementById('areas-list');
  if (!searchAreas.length) {
    list.innerHTML = '<p class="search-hint">No areas yet. Click "+ Add area".</p>';
    return;
  }
  list.innerHTML = searchAreas.map((a, i) => `
    <div class="area-row" data-id="${a.id}">
      <input class="area-label" type="text" placeholder="Area label" value="${esc(a.label)}" data-field="label">
      <input class="area-geohash" type="text" placeholder="Geohash (e.g. u10h0869370q)" value="${esc(a.geohash)}" data-field="geohash">
      <input class="area-city" type="text" placeholder="city_uname (e.g. london)" value="${esc(a.city_uname || 'london')}" data-field="city_uname">
      <input class="area-slug" type="text" placeholder="neighborhood_uname (e.g. biggin-hill)" value="${esc(a.neighborhood_uname || '')}" data-field="neighborhood_uname">
      <button class="btn btn-sm area-remove" data-idx="${i}" title="Remove">&#10005;</button>
    </div>
  `).join('');

  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const row = e.target.closest('.area-row');
      const id = row.dataset.id;
      const field = e.target.dataset.field;
      const area = searchAreas.find(a => a.id === id);
      if (area) { area[field] = e.target.value; persistAreas(); }
    });
  });

  list.querySelectorAll('.area-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      searchAreas.splice(idx, 1);
      persistAreas();
      renderAreas();
      updateExcludeSelect();
    });
  });

  updateExcludeSelect();
}

function addArea() {
  searchAreas.push({ id: uid(), label: '', geohash: '', city_uname: 'london', neighborhood_uname: '' });
  persistAreas();
  renderAreas();
}

function updateExcludeSelect() {
  const sel = document.getElementById('filter-exclude-select');
  const current = sel.value;
  const labels = searchAreas.map(a => a.label).filter(Boolean);
  sel.innerHTML = '<option value="">(pick area)</option>' +
    labels.map(l => `<option value="${esc(l)}" ${l === current ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function runSearch() {
  const tokenRaw = document.getElementById('search-token').value.trim();
  if (!tokenRaw) {
    setSearchStatus('Paste a Bearer token first', 'err');
    return;
  }
  const validAreas = searchAreas.filter(a => a.geohash && a.geohash.trim());
  if (!validAreas.length) {
    setSearchStatus('Add at least one area with a geohash', 'err');
    return;
  }

  const btn = document.getElementById('run-search-btn');
  btn.disabled = true;
  setSearchStatus(`Searching ${validAreas.length} area${validAreas.length > 1 ? 's' : ''}...`, '');

  try {
    const resp = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenRaw, areas: validAreas }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      setSearchStatus('Search failed: ' + (data.error || resp.statusText), 'err');
      return;
    }

    searchResults = data.restaurants || [];
    setSearchStatus(
      `Found ${data.total_unique} unique restaurants across ${data.areas_searched} area${data.areas_searched > 1 ? 's' : ''}`,
      'ok'
    );
    showSearchErrors(data.errors || []);
    document.getElementById('search-results-section').style.display = '';
    updateExcludeSelect();
    applyFilters();
  } catch (err) {
    setSearchStatus('Request failed: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function applyFilters() {
  if (!searchResults.length) return;

  const multiOnly = document.getElementById('filter-multi-only').checked;
  const excludeEnabled = document.getElementById('filter-exclude-area').checked;
  const excludeLabel = document.getElementById('filter-exclude-select').value;
  const ruleText = document.getElementById('filter-rule').value.trim();
  const ruleErr = document.getElementById('rule-error');
  ruleErr.textContent = '';

  let ruleFunc = null;
  if (ruleText) {
    try {
      // eslint-disable-next-line no-new-func
      ruleFunc = new Function('name', 'card_text', 'found_in', 'found_in_count', `return (${ruleText});`);
      // test it compiles ok with a dummy call
      ruleFunc('', '', [], 0);
    } catch (e) {
      ruleErr.textContent = 'Rule error: ' + e.message;
      ruleFunc = null;
    }
  }

  const filtered = searchResults.filter(r => {
    if (multiOnly && r.found_in.length < 2) return false;
    if (excludeEnabled && excludeLabel && r.found_in.length === 1 && r.found_in[0] === excludeLabel) return false;
    if (ruleFunc) {
      try {
        if (!ruleFunc(r.name, r.card_text, r.found_in, r.found_in.length)) return false;
      } catch (e) {
        // rule error on specific row -- include row
      }
    }
    return true;
  });

  document.getElementById('results-summary').textContent =
    filtered.length + ' / ' + searchResults.length + ' restaurants';

  renderResultsTable(filtered);
}

function renderResultsTable(rows) {
  const tbody = document.getElementById('results-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No restaurants match the current filters</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const areasBadges = r.found_in.map(a =>
      `<span class="area-badge">${esc(a)}</span>`
    ).join('');
    return `<tr>
      <td class="result-name">${esc(r.name)}</td>
      <td class="result-card-text url-cell" title="${esc(r.card_text)}">${esc(r.card_text)}</td>
      <td>${areasBadges}</td>
      <td class="result-count">${r.found_in.length}</td>
    </tr>`;
  }).join('');
}

function showSearchErrors(errors) {
  const el = document.getElementById('search-errors');
  if (!errors.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = errors.map(e =>
    `<p>&#9888; <strong>${esc(e.area)}</strong>: ${esc(e.error)}</p>`
  ).join('');
}

function setSearchStatus(msg, type) {
  const el = document.getElementById('search-status');
  el.textContent = msg;
  el.className = 'search-status' + (type ? ' search-status-' + type : '');
}

function exportResultsCSV() {
  if (!searchResults.length) return;

  // Apply current filters to get the visible set
  const multiOnly = document.getElementById('filter-multi-only').checked;
  const excludeEnabled = document.getElementById('filter-exclude-area').checked;
  const excludeLabel = document.getElementById('filter-exclude-select').value;

  const rows = searchResults.filter(r => {
    if (multiOnly && r.found_in.length < 2) return false;
    if (excludeEnabled && excludeLabel && r.found_in.length === 1 && r.found_in[0] === excludeLabel) return false;
    return true;
  });

  const headers = ['id', 'name', 'card_text', 'found_in', 'areas_count', 'href'];
  const csv = [
    headers.join(','),
    ...rows.map(r => [
      JSON.stringify(r.id),
      JSON.stringify(r.name),
      JSON.stringify(r.card_text),
      JSON.stringify(r.found_in.join('; ')),
      r.found_in.length,
      JSON.stringify(r.href),
    ].join(',')),
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'restaurant-search.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Rules (Milestone 3) ───────────────────────────────────────────────────

let rulesTabReady = false;
let editingRuleId = null;

function initRulesTab() {
  if (!rulesTabReady) {
    rulesTabReady = true;
    document.getElementById('add-rule-btn').addEventListener('click', openNewRuleForm);
    document.getElementById('rf-cancel').addEventListener('click', closeRuleForm);
    document.getElementById('rule-form').addEventListener('submit', saveRule);
    document.getElementById('rf-action').addEventListener('change', updateValueRowVisibility);
  }
  loadRules();
}

async function loadRules() {
  try {
    const res = await fetch('/api/rules');
    const rules = await res.json();
    renderRules(rules);
  } catch (e) {
    console.error('Failed to load rules', e);
  }
}

function renderRules(rules) {
  const tbody = document.getElementById('rules-tbody');
  if (!rules.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No rules yet &mdash; click &ldquo;+ New rule&rdquo; to add one. The proxy ships with three disabled examples you can enable.</td></tr>';
    return;
  }
  tbody.innerHTML = rules.map(r => `
    <tr class="rule-row${r.active ? '' : ' rule-inactive'}">
      <td>
        <label class="toggle-switch" title="${r.active ? 'Disable rule' : 'Enable rule'}">
          <input type="checkbox" class="rule-toggle" data-id="${r.id}" ${r.active ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </td>
      <td>
        <span class="rule-name">${esc(r.name)}</span>
        ${r.description ? '<br><small class="rule-desc">' + esc(r.description) + '</small>' : ''}
      </td>
      <td><span class="scope-badge scope-${esc(r.scope)}">${esc(r.scope)}</span></td>
      <td class="mono url-cell" title="${esc(r.target)}">${esc(r.target)}</td>
      <td>${esc(r.action)}</td>
      <td class="mono url-cell" title="${r.action === 'delete' ? '' : esc(r.value)}">${r.action === 'delete' ? '<span class="dim">&mdash;</span>' : esc(r.value)}</td>
      <td class="rule-actions-cell">
        <button class="btn btn-sm rule-edit-btn" data-id="${r.id}" title="Edit rule">&#9998;</button>
        <button class="btn btn-sm btn-danger rule-delete-btn" data-id="${r.id}" title="Delete rule">&#10005;</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.rule-toggle').forEach(cb => {
    cb.addEventListener('change', () => toggleRule(cb.dataset.id));
  });
  tbody.querySelectorAll('.rule-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditRuleForm(btn.dataset.id));
  });
  tbody.querySelectorAll('.rule-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteRule(btn.dataset.id));
  });
}

async function toggleRule(id) {
  try {
    const res = await fetch('/api/rules/' + id + '/toggle', { method: 'POST' });
    if (res.ok) loadRules();
  } catch (e) { console.error('Toggle failed', e); }
}

async function deleteRule(id) {
  if (!confirm('Delete this rule?')) return;
  try {
    await fetch('/api/rules/' + id, { method: 'DELETE' });
    loadRules();
  } catch (e) { console.error('Delete failed', e); }
}

function updateValueRowVisibility() {
  const action = document.getElementById('rf-action').value;
  document.getElementById('rf-value-row').style.display = action === 'delete' ? 'none' : '';
}

function openNewRuleForm() {
  editingRuleId = null;
  document.getElementById('rule-id').value = '';
  document.getElementById('rf-name').value = '';
  document.getElementById('rf-description').value = '';
  document.getElementById('rf-scope').value = 'request';
  document.getElementById('rf-match-url').value = '';
  document.getElementById('rf-target').value = '';
  document.getElementById('rf-action').value = 'set';
  document.getElementById('rf-value').value = '';
  document.getElementById('rf-submit').textContent = 'Add rule';
  document.getElementById('rf-error').textContent = '';
  updateValueRowVisibility();
  document.getElementById('rule-form-wrap').classList.remove('hidden');
  document.getElementById('rf-name').focus();
}

async function openEditRuleForm(id) {
  try {
    const res = await fetch('/api/rules');
    const rules = await res.json();
    const rule = rules.find(r => String(r.id) === String(id));
    if (!rule) return;

    editingRuleId = id;
    document.getElementById('rule-id').value = id;
    document.getElementById('rf-name').value = rule.name;
    document.getElementById('rf-description').value = rule.description || '';
    document.getElementById('rf-scope').value = rule.scope;
    document.getElementById('rf-match-url').value = rule.match_url || '';
    document.getElementById('rf-target').value = rule.target;
    document.getElementById('rf-action').value = rule.action;
    document.getElementById('rf-value').value = rule.value || '';
    document.getElementById('rf-submit').textContent = 'Update rule';
    document.getElementById('rf-error').textContent = '';
    updateValueRowVisibility();
    document.getElementById('rule-form-wrap').classList.remove('hidden');
    document.getElementById('rf-name').focus();
  } catch (e) { console.error('Load rule failed', e); }
}

function closeRuleForm() {
  document.getElementById('rule-form-wrap').classList.add('hidden');
  editingRuleId = null;
}

async function saveRule(e) {
  e.preventDefault();
  const errEl = document.getElementById('rf-error');
  errEl.textContent = '';

  const name = document.getElementById('rf-name').value.trim();
  const description = document.getElementById('rf-description').value.trim();
  const scope = document.getElementById('rf-scope').value;
  const match_url = document.getElementById('rf-match-url').value.trim();
  const target = document.getElementById('rf-target').value.trim();
  const action = document.getElementById('rf-action').value;
  const rawValue = document.getElementById('rf-value').value.trim();
  const value = rawValue || 'null';

  if (!name || !target) { errEl.textContent = 'Name and target are required'; return; }

  if (action === 'set') {
    try { JSON.parse(value); } catch (jsonErr) {
      errEl.textContent = 'Value must be valid JSON — e.g. "text", 42, true, ["a","b"], {"key":"val"}';
      return;
    }
  }

  const body = { name, description, scope, match_url, target, action, value, active: 1 };

  try {
    let res;
    if (editingRuleId) {
      res = await fetch('/api/rules/' + editingRuleId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      errEl.textContent = err.error || 'Save failed';
      return;
    }
    closeRuleForm();
    loadRules();
  } catch (err) {
    errEl.textContent = 'Request failed: ' + err.message;
  }
}
