// Milestone 2 -- multi-area search + location filter engine.
//
// The proxy captures the real Deliveroo restaurant-search request, including
// the live session headers (Authorization, X-Roo-*). This module finds the
// most recent such capture, treats it as a TEMPLATE, and replays it against
// several locations -- overriding only the location and filter parameters.
// Results are merged and deduplicated by restaurant id, so the customer can
// search multiple delivery areas at once and narrow by where restaurants
// physically sit.
//
// Nothing leaves the machine except the replayed calls to Deliveroo's own API,
// using the customer's own captured session. No tokens are stored by this
// module -- they are read from the local capture DB at request time only.

// better-sqlite3 is a native module; load it lazily so the pure response-parsing
// helpers (and their unit tests) can run without the compiled binary present.
function openDb(dbPath) {
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true });
}

// A capture is a usable search template if it's a POST to a Deliveroo GraphQL
// endpoint whose body carries the search query + a `location` variable.
function isSearchTemplate(row) {
  if (!row || row.method !== 'POST') return false;
  const url = row.url || '';
  if (!/deliveroo\.[a-z.]+\/consumer\/graphql/i.test(url) && !/graphql/i.test(url)) {
    return false;
  }
  const body = row.req_body || '';
  // getHomeFeed / search query with a location variable is the listing call.
  return body.includes('"location"') &&
    (body.includes('getHomeFeed') || body.includes('results: search') || body.includes('search('));
}

// Find the newest capture that can act as a search template.
function findTemplate(dbPath) {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id, ts, method, url, req_headers, req_body, resp_body
         FROM captures
         WHERE method = 'POST' AND url LIKE '%graphql%'
         ORDER BY id DESC
         LIMIT 50`
      )
      .all();
    return rows.find(isSearchTemplate) || null;
  } catch (err) {
    if (err.code === 'SQLITE_CANTOPEN') return null;
    throw err;
  } finally {
    db.close();
  }
}

// Headers we must NOT forward verbatim when replaying (hop-by-hop or
// content-encoding that fetch sets itself).
const DROP_HEADERS = new Set([
  'host', 'content-length', 'accept-encoding', 'connection',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
]);

function buildHeaders(rawHeadersJson) {
  let parsed = {};
  try { parsed = JSON.parse(rawHeadersJson || '{}'); } catch (_) { parsed = {}; }
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (DROP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (!out['content-type'] && !out['Content-Type']) {
    out['content-type'] = 'application/json';
  }
  return out;
}

// Merge the customer's chosen filters into the Deliveroo `url` variable, which
// is where the web app encodes filters (offer, partner-star-rating, sort, etc).
// filters is a flat object of { paramName: value }.
function applyFiltersToUrl(rawUrl, area, filters) {
  let base = rawUrl;
  try {
    const u = new URL(rawUrl);
    // Re-point the path at the chosen area when we can derive it.
    if (area && area.city_uname && area.neighborhood_uname) {
      u.pathname = `/restaurants/${area.city_uname}/${area.neighborhood_uname}`;
    }
    // Reset then apply geohash + filters.
    if (area && area.geohash) u.searchParams.set('geohash', area.geohash);
    for (const [k, v] of Object.entries(filters || {})) {
      if (v === null || v === undefined || v === '') u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    base = u.toString();
  } catch (_) {
    // If the captured url isn't a clean URL, leave it untouched.
  }
  return base;
}

// Build the replay request body for one area, starting from the template body.
function buildBody(templateBody, area, filters) {
  const payload = JSON.parse(templateBody);
  const vars = payload.variables || {};
  vars.location = {
    geohash: (area && area.geohash) || (vars.location && vars.location.geohash) || '',
    city_uname: (area && area.city_uname) || (vars.location && vars.location.city_uname) || '',
    neighborhood_uname:
      (area && area.neighborhood_uname) || (vars.location && vars.location.neighborhood_uname) || '',
    postcode: (area && area.postcode) || '',
  };
  if (typeof vars.url === 'string') {
    vars.url = applyFiltersToUrl(vars.url, area, filters);
  }
  payload.variables = vars;
  return JSON.stringify(payload);
}

// Derive a human "physical location" label from a restaurant menu link, e.g.
// /menu/London/beckenham/mr-frango/ -> { city: 'London', area: 'beckenham' }.
function locationFromHref(href) {
  if (!href) return null;
  const m = href.match(/\/menu\/([^/]+)\/([^/]+)\//i);
  if (m) return { city: decodeURIComponent(m[1]), area: decodeURIComponent(m[2]) };
  return null;
}

// Recursively walk the GraphQL response and pull out restaurant references.
// Deliveroo nests restaurants deep inside aliased UI layout blocks, so a
// structural deep-walk is more robust than hard-coding the path.
function extractRestaurants(node, acc, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) extractRestaurants(item, acc, seen);
    return;
  }
  // A restaurant target carries { restaurant: { id, name, links } }.
  const r = node.restaurant;
  if (r && (r.id !== undefined) && r.name) {
    const id = String(r.id);
    if (!seen.has(id)) {
      seen.add(id);
      let href = '';
      if (r.links && r.links.self && r.links.self.href) href = r.links.self.href;
      else if (Array.isArray(r.links) && r.links[0] && r.links[0].href) href = r.links[0].href;
      acc.push({ id, name: r.name, href, location: locationFromHref(href) });
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'restaurant') continue;
    extractRestaurants(node[key], acc, seen);
  }
}

// Pull the filters Deliveroo exposed for the captured search, so the UI can
// show the customer what's actually available to toggle.
function extractFilters(respBody) {
  const out = [];
  if (!respBody) return out;
  let json;
  try { json = JSON.parse(respBody); } catch (_) { return out; }
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    // UIControlFilter: { id, header, options: [{ id, header/name, count }] }
    if (node.id && node.header && Array.isArray(node.options) && node.optionsType !== undefined) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        out.push({
          id: node.id,
          header: node.header,
          options: node.options.map((o) => ({
            id: o.id,
            name: o.name || o.header,
            count: o.count,
            selected: !!o.selected,
          })),
        });
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(json);
  return out;
}

// Restaurant count Deliveroo reported for the search (meta.restaurantCount).
function extractMeta(respBody) {
  if (!respBody) return null;
  let json;
  try { json = JSON.parse(respBody); } catch (_) { return null; }
  let result = null;
  (function walk(node) {
    if (result || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.restaurantCount && (node.restaurantCount.results !== undefined)) {
      result = {
        results: node.restaurantCount.results,
        location: node.restaurantCount.location,
        title: node.title,
      };
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  })(json);
  return result;
}

// Replay the captured search against one area.
async function searchArea(template, area, filters) {
  const headers = buildHeaders(template.req_headers);
  const body = buildBody(template.req_body, area, filters);
  const res = await fetch(template.url, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, restaurants: [], error: text.slice(0, 300) };
  }
  const acc = [];
  const seen = new Set();
  try {
    extractRestaurants(JSON.parse(text), acc, seen);
  } catch (_) {
    return { ok: false, status: res.status, restaurants: [], error: 'Unparseable response' };
  }
  return {
    ok: true,
    status: res.status,
    restaurants: acc,
    filters: extractFilters(text),
    meta: extractMeta(text),
  };
}

// Multi-area search: run each area, merge, dedupe by restaurant id, and record
// which areas each restaurant appeared in (so the customer sees coverage).
async function multiAreaSearch(dbPath, areas, filters) {
  const template = findTemplate(dbPath);
  if (!template) {
    return {
      ok: false,
      error: 'No search capture found yet. Run one restaurant search on deliveroo.co.uk with the proxy on, then try again.',
    };
  }
  const merged = new Map();
  const perArea = [];
  let exposedFilters = [];

  for (const area of areas) {
    const label = area.label || area.neighborhood_uname || area.geohash || 'area';
    let r;
    try {
      r = await searchArea(template, area, filters);
    } catch (err) {
      perArea.push({ label, ok: false, error: String(err.message || err), count: 0 });
      continue;
    }
    if (!r.ok) {
      perArea.push({ label, ok: false, error: r.error, status: r.status, count: 0 });
      continue;
    }
    if (r.filters && r.filters.length && !exposedFilters.length) exposedFilters = r.filters;
    perArea.push({ label, ok: true, count: r.restaurants.length, reported: r.meta });
    for (const rest of r.restaurants) {
      if (merged.has(rest.id)) {
        const existing = merged.get(rest.id);
        if (!existing.areas.includes(label)) existing.areas.push(label);
      } else {
        merged.set(rest.id, { ...rest, areas: [label] });
      }
    }
  }

  return {
    ok: true,
    templateCapturedAt: template.ts,
    perArea,
    exposedFilters,
    total: merged.size,
    restaurants: Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Lightweight template status for the UI (no token, no body -- just whether a
// usable search capture exists and what location it was for).
function templateStatus(dbPath) {
  const template = findTemplate(dbPath);
  if (!template) return { ready: false };
  let location = null;
  try {
    const vars = JSON.parse(template.req_body).variables || {};
    if (vars.location) {
      location = {
        city_uname: vars.location.city_uname,
        neighborhood_uname: vars.location.neighborhood_uname,
        geohash: vars.location.geohash,
      };
    }
  } catch (_) { /* ignore */ }
  return {
    ready: true,
    capturedAt: template.ts,
    location,
    exposedFilters: extractFilters(template.resp_body),
  };
}

module.exports = {
  findTemplate,
  isSearchTemplate,
  multiAreaSearch,
  templateStatus,
  // exported for unit-testing the pure helpers
  _internal: { extractRestaurants, extractFilters, extractMeta, applyFiltersToUrl, locationFromHref, buildBody },
};
