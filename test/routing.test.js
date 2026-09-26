const test = require('node:test');
const assert = require('node:assert');
const { planRoute, pathLength } = require('../server/routing');

// A 5x5 grid of houses ~100m apart.
function grid() {
  const stops = [];
  let id = 1;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) stops.push({ id: id++, lat: 38.8 + r * 0.0009, lng: -121.2 + c * 0.0011, pref: 'ANY' });
  return stops;
}

test('visits every stop exactly once', () => {
  const stops = grid();
  const route = planRoute(stops);
  assert.strictEqual(route.length, stops.length);
  assert.deepStrictEqual(new Set(route.map((s) => s.id)).size, stops.length);
});

test('produces a short path on a grid (close to the serpentine optimum)', () => {
  const stops = grid();
  const route = planRoute(stops);
  // The serpentine path is 24 hops of ~100m; allow a little slack.
  const serpentine = [];
  for (let r = 0; r < 5; r++) {
    const row = stops.slice(r * 5, r * 5 + 5);
    serpentine.push(...(r % 2 ? row.reverse() : row));
  }
  assert.ok(pathLength(route) <= pathLength(serpentine) * 1.15, `${pathLength(route)} vs ${pathLength(serpentine)}`);
});

test('all AM stops come before all PM stops', () => {
  const stops = grid().map((s, i) => ({ ...s, pref: i % 3 === 0 ? 'AM' : i % 3 === 1 ? 'PM' : 'ANY' }));
  const route = planRoute(stops);
  const lastAm = Math.max(...route.map((s, i) => (s.pref === 'AM' ? i : -1)));
  const firstPm = Math.min(...route.map((s, i) => (s.pref === 'PM' ? i : Infinity)));
  assert.ok(lastAm < firstPm, `last AM at ${lastAm}, first PM at ${firstPm}`);
});

test('starts near the given start point', () => {
  const stops = grid();
  const corner = stops[24];
  const route = planRoute(stops, { start: { lat: corner.lat + 0.0002, lng: corner.lng + 0.0002 } });
  assert.strictEqual(route[0].id, corner.id);
});

test('stops without coordinates are appended at the end', () => {
  const stops = [...grid(), { id: 'x', lat: null, lng: null, pref: 'AM' }, { id: 'y', pref: 'PM' }];
  const route = planRoute(stops);
  assert.deepStrictEqual(route.slice(-2).map((s) => s.id), ['x', 'y']);
});

test('handles empty and single-stop input', () => {
  assert.deepStrictEqual(planRoute([]), []);
  assert.strictEqual(planRoute([{ id: 1, lat: 1, lng: 1, pref: 'PM' }]).length, 1);
});
