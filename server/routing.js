/**
 * Route planning for a single technician.
 *
 * The day is split into a morning block and an afternoon block, each with its own limit:
 *   1. "Any time" stops are assigned to a block: the ones nearest the morning stops go to
 *      the morning, as long as neither block goes over its limit.
 *   2. Morning stops are ordered into the shortest open path starting from the start point.
 *   3. Afternoon stops are ordered into the shortest open path continuing from the last
 *      morning stop.
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

const minDistanceTo = (pt, cluster) => cluster.reduce((m, c) => Math.min(m, distance(c, pt)), Infinity);

/**
 * Split "any time" stops between the morning and afternoon. At least enough go to the
 * morning to keep the afternoon within its limit, never more than the morning has room
 * for, and within those bounds the ones closer to the morning stops go to the morning.
 */
function splitFlexible(flex, amFixed, pmFixed, { start, amCapacity, pmCapacity }) {
  if (!flex.length) return { am: [], pm: [] };
  const amRoom = Math.max(0, amCapacity - amFixed.length);
  const pmRoom = Math.max(0, pmCapacity - pmFixed.length);

  let ordered; // most morning-leaning first
  let preferAm; // how many would rather be in the morning
  if (!amFixed.length && !pmFixed.length) {
    // Nothing to lean toward: walk them as one path and fill the morning first.
    ordered = openPath(flex, start);
    preferAm = flex.length;
  } else {
    const amRef = amFixed.length ? amFixed : start ? [start] : [];
    const pull = (pt) => {
      const d = minDistanceTo(pt, amRef) - minDistanceTo(pt, pmFixed);
      return Number.isNaN(d) ? 0 : d; // negative = closer to the morning stops
    };
    const scored = flex.map((pt) => ({ pt, pull: pull(pt) })).sort((a, b) => a.pull - b.pull);
    ordered = scored.map((x) => x.pt);
    preferAm = scored.filter((x) => x.pull <= 0).length;
  }
  const minAm = flex.length - pmRoom; // below this the afternoon would overflow
  const k = Math.max(0, Math.min(Math.max(preferAm, minAm), amRoom, flex.length));
  return { am: ordered.slice(0, k), pm: ordered.slice(k) };
}

/**
 * @param {Array<{id:any, lat?:number|null, lng?:number|null, pref:'AM'|'PM'|'ANY'}>} stops
 * @param {{start?: {lat:number, lng:number} | null, amCapacity?: number, pmCapacity?: number}} [options]
 * @returns {Array} the same stop objects in visiting order, each tagged with session 'AM' | 'PM'
 */
function planRoute(stops, { start = null, amCapacity = Infinity, pmCapacity = Infinity } = {}) {
  const hasCoords = (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng);
  const located = stops.filter(hasCoords);
  const unlocated = stops.filter((s) => !hasCoords(s));

  const amFixed = located.filter((s) => s.pref === 'AM');
  const pmFixed = located.filter((s) => s.pref === 'PM');
  const flex = located.filter((s) => s.pref !== 'AM' && s.pref !== 'PM');
  const split = splitFlexible(flex, amFixed, pmFixed, { start, amCapacity, pmCapacity });

  const am = openPath([...amFixed, ...split.am], start);
  const pm = openPath([...pmFixed, ...split.pm], am.length ? am[am.length - 1] : start);

  // Stops we couldn't geocode go at the end of their session (flexible ones fill leftover morning room).
  const amUnlocated = unlocated.filter((s) => s.pref === 'AM');
  const pmUnlocated = unlocated.filter((s) => s.pref === 'PM');
  const flexUnlocated = unlocated.filter((s) => s.pref !== 'AM' && s.pref !== 'PM');
  const amLeft = Math.max(0, amCapacity - am.length - amUnlocated.length);
  const amTail = [...amUnlocated, ...flexUnlocated.slice(0, amLeft)];
  const pmTail = [...flexUnlocated.slice(amLeft), ...pmUnlocated];

  const morning = [...am, ...amTail];
  const afternoon = [...pm, ...pmTail];
  morning.forEach((s) => (s.session = 'AM'));
  afternoon.forEach((s) => (s.session = 'PM'));
  return [...morning, ...afternoon];
}

module.exports = { planRoute, distance, pathLength };
