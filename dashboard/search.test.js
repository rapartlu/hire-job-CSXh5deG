// Unit tests for the Milestone 2 search response-parsing helpers.
// These cover the pure functions that turn a Deliveroo GraphQL response into
// a deduplicated restaurant list, so the multi-area search logic is verified
// without needing a live Deliveroo session.
//
// Run: node dashboard/search.test.js

const assert = require('assert');
const { _internal } = require('./search');

let passed = 0;
function ok(name) { console.log('PASS: ' + name); passed++; }

// 1. Restaurant extraction: nested, aliased structure; dedupe by id; location parse.
{
  const resp = { data: { results: { layoutGroups: [ { data: [ { blocks: [
    { target: { typeName: 'UITargetRestaurant',
      restaurant: { id: 123, name: 'Mr Frango', links: { self: { href: '/menu/London/beckenham/mr-frango/' } } } } },
    { target: { typeName: 'UITargetRestaurant',
      restaurant: { id: 123, name: 'Mr Frango (dup)', links: { self: { href: '/menu/London/beckenham/mr-frango/' } } } } },
    { target: { typeName: 'UITargetRestaurant',
      restaurant: { id: 456, name: 'Pizza Place', links: { self: { href: '/menu/London/bromley/pizza-place/' } } } } },
  ] } ] } ] } } };
  const acc = []; const seen = new Set();
  _internal.extractRestaurants(resp, acc, seen);
  assert.strictEqual(acc.length, 2, 'dedupe by id should yield 2');
  assert.strictEqual(acc[0].name, 'Mr Frango');
  assert.deepStrictEqual(acc[0].location, { city: 'London', area: 'beckenham' });
  assert.strictEqual(acc[1].location.area, 'bromley');
  ok('extractRestaurants dedupe + location parse');
}

// 2. Filter extraction from controlGroups.filters.
{
  const respWithFilters = JSON.stringify({ data: { results: { controlGroups: {
    filters: [ { id: 'offer', header: 'Offers', optionsType: 'MULTI',
      options: [ { id: 'all-offers', header: 'All offers', count: 12, selected: false } ] } ] } } } });
  const filters = _internal.extractFilters(respWithFilters);
  assert.strictEqual(filters.length, 1);
  assert.strictEqual(filters[0].id, 'offer');
  assert.strictEqual(filters[0].options[0].name, 'All offers');
  ok('extractFilters');
}

// 3. applyFiltersToUrl re-points path + sets geohash + filter param.
{
  const url = _internal.applyFiltersToUrl(
    'https://deliveroo.co.uk/restaurants/london/shoreditch?geohash=OLD',
    { geohash: 'NEW', city_uname: 'london', neighborhood_uname: 'bromley' },
    { 'partner-star-rating': 'four-point-five-plus' });
  assert.ok(url.includes('/restaurants/london/bromley'), 'path re-pointed');
  assert.ok(url.includes('geohash=NEW'), 'geohash updated');
  assert.ok(url.includes('partner-star-rating=four-point-five-plus'), 'filter applied');
  ok('applyFiltersToUrl');
}

// 4. buildBody overrides location + url, preserves the GraphQL query.
{
  const tmplBody = JSON.stringify({ query: 'query getHomeFeed', variables: {
    location: { geohash: 'OLD', city_uname: 'london', neighborhood_uname: 'shoreditch', postcode: '' },
    url: 'https://deliveroo.co.uk/restaurants/london/shoreditch?geohash=OLD' } });
  const built = JSON.parse(_internal.buildBody(tmplBody,
    { geohash: 'G2', city_uname: 'london', neighborhood_uname: 'bromley' }, {}));
  assert.strictEqual(built.variables.location.geohash, 'G2');
  assert.strictEqual(built.variables.location.neighborhood_uname, 'bromley');
  assert.ok(built.variables.url.includes('/restaurants/london/bromley'));
  assert.strictEqual(built.query, 'query getHomeFeed', 'query preserved');
  ok('buildBody');
}

// 5. meta extraction (restaurant count).
{
  const meta = _internal.extractMeta(JSON.stringify({ data: { results: { meta: {
    restaurantCount: { results: 42, location: 50 }, title: 'Biggin Hill' } } } }));
  assert.strictEqual(meta.results, 42);
  ok('extractMeta');
}

// 6. locationFromHref handles odd/missing hrefs without throwing.
{
  assert.strictEqual(_internal.locationFromHref(''), null);
  assert.strictEqual(_internal.locationFromHref('/something/else'), null);
  assert.deepStrictEqual(_internal.locationFromHref('/menu/Leeds/hyde-park/curry-house/'),
    { city: 'Leeds', area: 'hyde-park' });
  ok('locationFromHref edge cases');
}

console.log('\nAll ' + passed + ' tests passed.');
