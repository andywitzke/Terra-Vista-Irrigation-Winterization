/**
 * Route planning for a single technician.
 *
 * The day is split into a morning block and an afternoon block:
 *   1. AM stops are ordered into the shortest open path starting from the start point.
 *   2. PM stops are ordered into the shortest open path continuing from the last AM stop.
 *   3. "Any time" stops are inserted wherever they add the least extra travel,
 *      so they naturally fill gaps between or around the AM and PM blocks.
 * Paths use nearest-neighbor construction followed by 2-opt improvement. With
 * ~25 houses per day this runs in well under a millisecond.
 */

const EARTH_RADIUS_M = 6371000;

function distance(a, b) {
  if (!a || !b) return 0; // a missing endpoint means a free (unconstrained) end of the path
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function pathLength(path, start = null) {
  let total = 0;
  let prev = start;
  for (const p of path) {
    total += distance(prev, p);
    prev = p;
  }
  return total;
}

function nearestNeighbor(points, start) {
  const remaining = points.slice();
  const path = [];
  let current = start;
  if (!current) {
    // No fixed start: begin at the point farthest from the centroid (an "edge" of the cluster).
    const c = {
      lat: remaining.reduce((s, p) => s + p.lat, 0) / remaining.length,
      lng: remaining.reduce((s, p) => s + p.lng, 0) / remaining.length,
    };
    let best = 0;
    remaining.forEach((p, i) => {
      if (distance(c, p) > distance(c, remaining[best])) best = i;
    });
    current = remaining.splice(best, 1)[0];
    path.push(current);
  }
  while (remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (distance(current, remaining[i]) < distance(current, remaining[best])) best = i;
    }
    current = remaining.splice(best, 1)[0];
    path.push(current);
  }
  return path;
}

/** 2-opt for an open path with an optional fixed start and a free end. */
function twoOpt(path, start) {
  const p = path.slice();
  const n = p.length;
  if (n < 3) return p;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 1000) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      const before = i === 0 ? start : p[i - 1];
      for (let j = i + 1; j < n; j++) {
        const after = j === n - 1 ? null : p[j + 1];
        const delta =
          distance(before, p[j]) + distance(p[i], after) - distance(before, p[i]) - distance(p[j], after);
        if (delta < -0.01) {
          const reversed = p.slice(i, j + 1).reverse();
          p.splice(i, j - i + 1, ...reversed);
          improved = true;
        }
      }
    }
  }
  return p;
}

function openPath(points, start) {
  if (!points.length) return [];
  return twoOpt(nearestNeighbor(points, start), start);
}

function cheapestInsertionIndex(seq, point, start) {
  let bestIdx = seq.length;
  let bestCost = Infinity;
  for (let i = 0; i <= seq.length; i++) {
    const prev = i === 0 ? start : seq[i - 1];
    const next = i === seq.length ? null : seq[i];
    const cost = distance(prev, point) + distance(point, next) - distance(prev, next);
    if (cost < bestCost) {
      bestCost = cost;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * @param {Array<{id:any, lat?:number|null, lng?:number|null, pref:'AM'|'PM'|'ANY'}>} stops
 * @param {{start?: {lat:number, lng:number} | null}} [options]
 * @returns {Array} the same stop objects in visiting order
 */
function planRoute(stops, { start = null } = {}) {
  const hasCoords = (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng);
  const located = stops.filter(hasCoords);
  const unlocated = stops.filter((s) => !hasCoords(s));

  const am = openPath(located.filter((s) => s.pref === 'AM'), start);
  const pmStart = am.length ? am[am.length - 1] : start;
  const pm = openPath(located.filter((s) => s.pref === 'PM'), pmStart);
  const seq = [...am, ...pm];

  // Insert flexible stops. Process them nearest-to-route first so later ones see a fuller route.
  const flexible = located.filter((s) => s.pref !== 'AM' && s.pref !== 'PM');
  if (!seq.length && flexible.length) {
    seq.push(...openPath(flexible, start));
  } else {
    const pending = flexible.slice();
    while (pending.length) {
      let bestK = 0;
      let bestD = Infinity;
      pending.forEach((pt, k) => {
        const d = Math.min(...seq.map((s) => distance(s, pt)), start ? distance(start, pt) : Infinity);
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      });
      const pt = pending.splice(bestK, 1)[0];
      seq.splice(cheapestInsertionIndex(seq, pt, start), 0, pt);
    }
    // Or-opt pass: try relocating each flexible stop to a better spot.
    const flexIds = new Set(flexible.map((s) => s.id));
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const s of seq.filter((x) => flexIds.has(x.id))) {
        const before = pathLength(seq, start);
        const idx = seq.indexOf(s);
        seq.splice(idx, 1);
        const newIdx = cheapestInsertionIndex(seq, s, start);
        seq.splice(newIdx, 0, s);
        if (pathLength(seq, start) > before - 0.01) {
          seq.splice(newIdx, 1);
          seq.splice(idx, 0, s);
        } else if (newIdx !== idx) {
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // Stops we couldn't geocode go last, still respecting AM before PM.
  const rank = { AM: 0, ANY: 1, PM: 2 };
  unlocated.sort((a, b) => (rank[a.pref] ?? 1) - (rank[b.pref] ?? 1));
  return [...seq, ...unlocated];
}

module.exports = { planRoute, distance, pathLength };
