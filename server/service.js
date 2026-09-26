/**
 * Business logic: day capacity, assignment, routes, queue notifications, and rollovers.
 * Route handlers stay thin and call into here.
 */
const config = require('./config');
const { tx, all, get, run, getSetting } = require('./db');
const { planRoute, distance } = require('./routing');
const { geocode } = require('./geocode');
const { sendSms } = require('./sms');
const {
  normalizePhone,
  today,
  prettyDate,
  PREF_LABEL,
  normalizePref,
  newToken,
  nowIso,
  HttpError,
} = require('./util');

const ACTIVE = "('scheduled','completed')"; // statuses that occupy a slot on a day
const TECH_LOCATION_FRESH_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- days

/** Slots taken on each day, by the time preference each sign-up holds. */
function sessionCounts({ dayId = null, excludeSignupId = null } = {}) {
  const rows = all(
    `SELECT assigned_day_id AS dayId, time_pref AS pref, COUNT(*) AS n FROM signups
     WHERE assigned_day_id IS NOT NULL AND status IN ${ACTIVE} AND id != ?
     ${dayId ? 'AND assigned_day_id = ?' : ''} GROUP BY assigned_day_id, time_pref`,
    excludeSignupId ?? -1,
    ...(dayId ? [dayId] : [])
  );
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.dayId)) byDay.set(r.dayId, { AM: 0, PM: 0, ANY: 0 });
    byDay.get(r.dayId)[r.pref === 'AM' || r.pref === 'PM' ? r.pref : 'ANY'] += r.n;
  }
  return byDay;
}

/**
 * Room left on a day. Morning and afternoon sign-ups each fill their own session;
 * "any time" sign-ups can go in whichever session has space, so they only need
 * room in the day's total.
 */
function availability(day, c = { AM: 0, PM: 0, ANY: 0 }) {
  const booked = c.AM + c.PM + c.ANY;
  const total = day.am_capacity + day.pm_capacity;
  const anyLeft = Math.max(0, total - booked);
  return {
    booked,
    AM: Math.max(0, Math.min(day.am_capacity - c.AM, anyLeft)),
    PM: Math.max(0, Math.min(day.pm_capacity - c.PM, anyLeft)),
    ANY: anyLeft,
  };
}

function roomFor(day, pref, { excludeSignupId = null } = {}) {
  const c = sessionCounts({ dayId: day.id, excludeSignupId }).get(day.id);
  return availability(day, c)[normalizePref(pref)] > 0;
}

function listDays({ publicOnly = false } = {}) {
  const counts = sessionCounts();
  const completed = new Map(
    all(`SELECT assigned_day_id AS dayId, COUNT(*) AS n FROM signups WHERE status = 'completed' GROUP BY assigned_day_id`).map(
      (r) => [r.dayId, r.n]
    )
  );
  const days = publicOnly
    ? all(`SELECT * FROM work_days WHERE is_open = 1 AND status = 'scheduled' AND date >= ? ORDER BY date`, today())
    : all('SELECT * FROM work_days ORDER BY date');
  return days.map((d) => {
    const c = counts.get(d.id) || { AM: 0, PM: 0, ANY: 0 };
    const a = availability(d, c);
    return {
      ...d,
      is_open: Boolean(d.is_open),
      route_locked: Boolean(d.route_locked),
      booked: a.booked,
      bookedAm: c.AM,
      bookedPm: c.PM,
      bookedAny: c.ANY,
      completed: completed.get(d.id) || 0,
      remaining: a.ANY,
      amRemaining: a.AM,
      pmRemaining: a.PM,
      full: a.ANY <= 0,
    };
  });
}

function getDay(id) {
  const d = get('SELECT * FROM work_days WHERE id = ?', id);
  if (!d) throw new HttpError(404, 'Day not found');
  return d;
}

const SESSION_WORD = { AM: 'morning', PM: 'afternoon', ANY: 'day' };
const fullMessage = (day, pref) => `The ${SESSION_WORD[normalizePref(pref)]} of ${prettyDate(day.date)} is full.`;

// ---------------------------------------------------------------- signups

function getSignup(id) {
  const s = get('SELECT * FROM signups WHERE id = ?', id);
  if (!s) throw new HttpError(404, 'Sign-up not found');
  return s;
}

function getSignupByToken(token) {
  const s = get('SELECT * FROM signups WHERE token = ?', String(token || ''));
  if (!s) throw new HttpError(404, 'Registration not found');
  return s;
}

function prefsFor(signupId) {
  return all(
    `SELECT p.day_id AS dayId, p.time_pref AS timePref, d.date FROM signup_prefs p
     JOIN work_days d ON d.id = p.day_id WHERE p.signup_id = ? ORDER BY d.date`,
    signupId
  );
}

function manageLink(token) {
  return `${config.baseUrl}/manage.html?t=${encodeURIComponent(token)}`;
}

/** Signup with its preferences and assigned day, safe to show the neighbor who owns it. */
function describeSignup(s) {
  const day = s.assigned_day_id ? get('SELECT * FROM work_days WHERE id = ?', s.assigned_day_id) : null;
  let queuePosition = null;
  if (day && day.status === 'in_progress' && s.status === 'scheduled') {
    ensureRoute(day.id);
    const queue = pendingStops(day.id);
    const idx = queue.findIndex((q) => q.id === s.id);
    if (idx >= 0) queuePosition = idx + 1;
  }
  return {
    id: s.id,
    token: s.token,
    name: s.name,
    address: s.address,
    formattedAddress: s.formatted_address,
    phone: s.phone,
    notes: s.notes,
    smsOptIn: Boolean(s.sms_opt_in),
    status: s.status,
    timePref: s.time_pref,
    assignedDay: day ? { id: day.id, date: day.date, status: day.status } : null,
    queuePosition,
    completedAt: s.completed_at,
    techNotes: s.status === 'completed' ? s.tech_notes : '',
    prefs: prefsFor(s.id),
    manageUrl: manageLink(s.token),
  };
}

function cleanPrefs(prefs) {
  if (!Array.isArray(prefs)) return [];
  const seen = new Map();
  for (const p of prefs) {
    const dayId = Number(p?.dayId);
    if (Number.isInteger(dayId) && dayId > 0) seen.set(dayId, normalizePref(p.timePref));
  }
  return [...seen].map(([dayId, timePref]) => ({ dayId, timePref }));
}

function validateName(name) {
  const n = String(name || '').trim().slice(0, 100);
  if (!n) throw new HttpError(400, 'Please enter your name.');
  return n;
}

function validateContact({ address, phone }) {
  const addr = String(address || '').trim();
  if (addr.length < 4) throw new HttpError(400, 'Please enter your street address.');
  const e164 = normalizePhone(phone);
  if (!e164) throw new HttpError(400, 'Please enter a valid 10-digit mobile phone number.');
  return { address: addr.slice(0, 200), phone: e164 };
}

/**
 * Pick the earliest day from prefs that still has room.
 * @param {boolean} publicRules only days open to the public and not yet started
 */
function chooseDay(prefs, { publicRules, ignoreSignupId = null }) {
  const candidates = prefs
    .map((p) => ({ ...p, day: get('SELECT * FROM work_days WHERE id = ?', p.dayId) }))
    .filter((p) => p.day)
    .sort((a, b) => a.day.date.localeCompare(b.day.date));
  for (const p of candidates) {
    const d = p.day;
    if (d.status === 'done') continue;
    if (publicRules && (!d.is_open || d.status !== 'scheduled' || d.date < today())) continue;
    if (roomFor(d, p.timePref, { excludeSignupId: ignoreSignupId })) return p;
  }
  return null;
}

function savePrefs(signupId, prefs) {
  run('DELETE FROM signup_prefs WHERE signup_id = ?', signupId);
  for (const p of prefs) {
    if (get('SELECT id FROM work_days WHERE id = ?', p.dayId)) {
      run('INSERT INTO signup_prefs (signup_id, day_id, time_pref) VALUES (?, ?, ?)', signupId, p.dayId, p.timePref);
    }
  }
}

function assign(signupId, dayId, timePref) {
  run(
    `UPDATE signups SET assigned_day_id = ?, time_pref = ?, status = 'scheduled', route_order = NULL,
       notified_next_at = NULL, notified_second_at = NULL, updated_at = datetime('now') WHERE id = ?`,
    dayId,
    timePref,
    signupId
  );
}

async function sendToSignup(s, kind, body) {
  if (!s.sms_opt_in) return null;
  return sendSms({ to: s.phone, body, kind, signupId: s.id });
}

const brand = () => `${config.neighborhoodName} Winterization`;

async function sendConfirmation(s) {
  const day = get('SELECT * FROM work_days WHERE id = ?', s.assigned_day_id);
  const when = day ? `${prettyDate(day.date)} (${PREF_LABEL[s.time_pref]})` : 'a day to be confirmed';
  return sendToSignup(
    s,
    'confirmation',
    `${brand()}: You're signed up for ${when} at ${s.address}. ` +
      `We'll text you when you're 2nd in line, next, and when it's done. ` +
      `Edit or cancel: ${manageLink(s.token)} Reply STOP to opt out.`
  );
}

async function createSignup(input, { admin = false } = {}) {
  const name = validateName(input.name);
  const { address, phone } = validateContact(input);
  const notes = String(input.notes || '').trim().slice(0, 1000);
  const smsOptIn = input.smsOptIn === undefined ? true : Boolean(input.smsOptIn);
  const prefs = cleanPrefs(input.prefs);

  // Admins can place someone directly on a day (optionally over capacity).
  const forcedDayId = admin && input.assignedDayId ? Number(input.assignedDayId) : null;
  if (forcedDayId && !prefs.some((p) => p.dayId === forcedDayId)) {
    prefs.push({ dayId: forcedDayId, timePref: normalizePref(input.timePref) });
  }
  if (!admin && !prefs.length) throw new HttpError(400, 'Please choose at least one date that works for you.');

  if (!admin) {
    const dup = all(`SELECT * FROM signups WHERE phone = ? AND status IN ('scheduled','unscheduled')`, phone).find(
      (s) => s.address.trim().toLowerCase() === address.toLowerCase()
    );
    if (dup) {
      await sendToSignup(dup, 'link', `${brand()}: You're already registered. Manage your sign-up: ${manageLink(dup.token)}`);
      throw new HttpError(409, "You're already signed up for this address. We just texted you a link to view or change it.");
    }
  }

  const geo = await geocode(address);

  const signup = tx(() => {
    let chosen;
    if (forcedDayId) {
      const day = getDay(forcedDayId);
      chosen = prefs.find((p) => p.dayId === forcedDayId);
      if (!input.allowOverCapacity && !roomFor(day, chosen.timePref)) throw new HttpError(409, fullMessage(day, chosen.timePref));
    } else if (prefs.length) {
      chosen = chooseDay(prefs, { publicRules: !admin });
      if (!chosen) {
        throw new HttpError(409, 'Sorry, the dates and times you picked just filled up. Please choose another date or time.');
      }
    }
    const info = run(
      `INSERT INTO signups (token, name, address, phone, notes, sms_opt_in, lat, lng, formatted_address, status, assigned_day_id, time_pref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newToken(),
      name,
      address,
      phone,
      notes,
      smsOptIn ? 1 : 0,
      geo?.lat ?? null,
      geo?.lng ?? null,
      geo?.formattedAddress ?? null,
      chosen ? 'scheduled' : 'unscheduled',
      chosen ? chosen.dayId : null,
      chosen ? chosen.timePref : 'ANY'
    );
    const id = Number(info.lastInsertRowid);
    savePrefs(id, prefs);
    return getSignup(id);
  });

  if (!admin || input.sendConfirmation) await sendConfirmation(signup);
  return signup;
}

/** Neighbor edits their own registration via the private link. */
async function updateSignupByToken(token, input) {
  const s = getSignupByToken(token);
  if (s.status === 'cancelled') throw new HttpError(400, 'This registration was cancelled. Please sign up again.');
  if (s.status === 'completed') throw new HttpError(400, 'This winterization is already complete.');

  const name = validateName(input.name ?? s.name);
  const { address, phone } = validateContact({ address: input.address ?? s.address, phone: input.phone ?? s.phone });
  const notes = String(input.notes ?? s.notes).trim().slice(0, 1000);
  const smsOptIn = input.smsOptIn === undefined ? s.sms_opt_in : input.smsOptIn ? 1 : 0;
  const day = s.assigned_day_id ? get('SELECT * FROM work_days WHERE id = ?', s.assigned_day_id) : null;
  const dayStarted = day && day.status !== 'scheduled';

  if (dayStarted && address !== s.address) {
    throw new HttpError(400, 'Your service day has started, so the address can no longer be changed. Please contact the organizer.');
  }
  const geo = address !== s.address ? await geocode(address) : null;
  let moved = false;

  tx(() => {
    if (input.prefs !== undefined && !dayStarted) {
      const prefs = cleanPrefs(input.prefs);
      if (!prefs.length) throw new HttpError(400, 'Please choose at least one date that works for you.');
      const keep = prefs.find((p) => p.dayId === s.assigned_day_id);
      if (keep && s.status === 'scheduled') {
        if (keep.timePref !== s.time_pref) {
          if (!roomFor(day, keep.timePref, { excludeSignupId: s.id })) throw new HttpError(409, fullMessage(day, keep.timePref));
          run(`UPDATE signups SET time_pref = ?, route_order = NULL WHERE id = ?`, keep.timePref, s.id);
        }
      } else {
        const chosen = chooseDay(prefs, { publicRules: true, ignoreSignupId: s.id });
        if (!chosen) throw new HttpError(409, 'Sorry, none of those dates and times have room. Please choose another.');
        assign(s.id, chosen.dayId, chosen.timePref);
        moved = true;
      }
      savePrefs(s.id, prefs);
    }
    run(
      `UPDATE signups SET name = ?, address = ?, phone = ?, notes = ?, sms_opt_in = ?, updated_at = datetime('now') WHERE id = ?`,
      name,
      address,
      phone,
      notes,
      smsOptIn,
      s.id
    );
    if (address !== s.address) {
      run(
        'UPDATE signups SET lat = ?, lng = ?, formatted_address = ?, route_order = NULL WHERE id = ?',
        geo?.lat ?? null,
        geo?.lng ?? null,
        geo?.formattedAddress ?? null,
        s.id
      );
    }
  });

  const updated = getSignup(s.id);
  if (moved) await sendConfirmation(updated);
  return updated;
}

async function cancelSignupByToken(token) {
  const s = getSignupByToken(token);
  if (s.status === 'completed') throw new HttpError(400, 'This winterization is already complete.');
  run(`UPDATE signups SET status = 'cancelled', route_order = NULL, updated_at = datetime('now') WHERE id = ?`, s.id);
  await sendToSignup(s, 'cancelled', `${brand()}: Your sign-up for ${s.address} has been cancelled. Sign up again anytime at ${config.baseUrl}`);
  if (s.assigned_day_id) await processQueue(s.assigned_day_id);
  return getSignup(s.id);
}

async function resendLinks(phoneInput) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new HttpError(400, 'Please enter a valid phone number.');
  const matches = all(`SELECT * FROM signups WHERE phone = ? AND status IN ('scheduled','unscheduled','completed')`, phone);
  for (const s of matches) {
    await sendToSignup(s, 'link', `${brand()}: Manage your sign-up for ${s.address}: ${manageLink(s.token)}`);
  }
  return matches.length;
}

/** Admin edit: any field, including direct day assignment and status. */
async function adminUpdateSignup(id, input) {
  const s = getSignup(id);
  const { address, phone } = validateContact({ address: input.address ?? s.address, phone: input.phone ?? s.phone });
  const geo = address !== s.address ? await geocode(address) : null;
  const oldDay = s.assigned_day_id;

  tx(() => {
    run(
      `UPDATE signups SET name = ?, address = ?, phone = ?, notes = ?, sms_opt_in = ?, tech_notes = ?, updated_at = datetime('now') WHERE id = ?`,
      input.name === undefined ? s.name : validateName(input.name),
      address,
      phone,
      String(input.notes ?? s.notes).trim().slice(0, 1000),
      input.smsOptIn === undefined ? s.sms_opt_in : input.smsOptIn ? 1 : 0,
      String(input.techNotes ?? s.tech_notes).trim().slice(0, 1000),
      s.id
    );
    if (address !== s.address) {
      run(
        'UPDATE signups SET lat = ?, lng = ?, formatted_address = ?, route_order = NULL WHERE id = ?',
        geo?.lat ?? null,
        geo?.lng ?? null,
        geo?.formattedAddress ?? null,
        s.id
      );
    }
    if (input.prefs !== undefined) savePrefs(s.id, cleanPrefs(input.prefs));

    const newDayId = input.assignedDayId === undefined ? s.assigned_day_id : input.assignedDayId ? Number(input.assignedDayId) : null;
    const newPref = input.timePref === undefined ? s.time_pref : normalizePref(input.timePref);
    if (newDayId !== s.assigned_day_id) {
      if (newDayId) {
        const day = getDay(newDayId);
        if (!input.allowOverCapacity && !roomFor(day, newPref, { excludeSignupId: s.id })) {
          throw new HttpError(409, `${fullMessage(day, newPref)} Tick "Allow over capacity" to add them anyway.`);
        }
        assign(s.id, newDayId, newPref);
      } else {
        run(`UPDATE signups SET assigned_day_id = NULL, status = 'unscheduled', route_order = NULL WHERE id = ?`, s.id);
      }
    } else if (newPref !== s.time_pref) {
      const day = s.assigned_day_id ? getDay(s.assigned_day_id) : null;
      if (day && s.status === 'scheduled' && !input.allowOverCapacity && !roomFor(day, newPref, { excludeSignupId: s.id })) {
        throw new HttpError(409, `${fullMessage(day, newPref)} Tick "Allow over capacity" to change it anyway.`);
      }
      run('UPDATE signups SET time_pref = ?, route_order = NULL WHERE id = ?', newPref, s.id);
    }
    const current = getSignup(s.id);
    const wantsStatus = ['scheduled', 'completed', 'unscheduled', 'cancelled'].includes(input.status) ? input.status : null;
    const needsDay = wantsStatus === 'scheduled' || wantsStatus === 'completed';
    if (wantsStatus && wantsStatus !== s.status && wantsStatus !== current.status && !(needsDay && !current.assigned_day_id)) {
      run(
        `UPDATE signups SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END, route_order = NULL WHERE id = ?`,
        input.status,
        input.status,
        nowIso(),
        s.id
      );
    }
  });

  const updated = getSignup(s.id);
  if (updated.assigned_day_id !== oldDay && updated.assigned_day_id && input.notify) {
    await sendMoved(updated);
  }
  if (oldDay) await processQueue(oldDay);
  if (updated.assigned_day_id && updated.assigned_day_id !== oldDay) await processQueue(updated.assigned_day_id);
  return updated;
}

async function deleteSignup(id) {
  const s = getSignup(id);
  run('DELETE FROM signups WHERE id = ?', id);
  if (s.assigned_day_id) await processQueue(s.assigned_day_id);
}

async function regeocode(id) {
  const s = getSignup(id);
  const geo = await geocode(s.address);
  if (!geo) throw new HttpError(422, 'Google could not locate that address. Check the spelling or ADDRESS_SUFFIX setting.');
  run('UPDATE signups SET lat = ?, lng = ?, formatted_address = ?, route_order = NULL WHERE id = ?', geo.lat, geo.lng, geo.formattedAddress, id);
  return getSignup(id);
}

// ---------------------------------------------------------------- routes & queue

function startPoint() {
  const loc = get('SELECT * FROM tech_location WHERE id = 1');
  if (loc && Date.now() - Date.parse(loc.updated_at) < TECH_LOCATION_FRESH_MS) return { lat: loc.lat, lng: loc.lng };
  const depot = getSetting('start_location');
  return depot && Number.isFinite(depot.lat) ? { lat: depot.lat, lng: depot.lng } : null;
}

function depotPoint() {
  const depot = getSetting('start_location');
  return depot && Number.isFinite(depot.lat) ? { lat: depot.lat, lng: depot.lng } : null;
}

function pendingStops(dayId) {
  return all(
    `SELECT * FROM signups WHERE assigned_day_id = ? AND status = 'scheduled'
     ORDER BY route_order IS NULL, route_order, id`,
    dayId
  );
}

function saveOrder(stops) {
  stops.forEach((s, i) =>
    run('UPDATE signups SET route_order = ?, route_session = ? WHERE id = ?', i + 1, s.route_session ?? null, s.id)
  );
}

const asStop = (s) => ({ id: s.id, lat: s.lat, lng: s.lng, pref: s.time_pref, row: s });

/** Plan the pending stops, keeping each half of the day within its limit. */
function plannedOrder(day, pending, start) {
  // Stops already finished today used up part of their session's room.
  const done = all(
    `SELECT route_session AS session, COUNT(*) AS n FROM signups WHERE assigned_day_id = ? AND status = 'completed' GROUP BY route_session`,
    day.id
  );
  const used = (sess) => done.find((d) => d.session === sess)?.n || 0;
  return planRoute(pending.map(asStop), {
    start,
    amCapacity: Math.max(0, day.am_capacity - used('AM')),
    pmCapacity: Math.max(0, day.pm_capacity - used('PM')),
  }).map((st) => ({ ...st.row, route_session: st.session }));
}

/**
 * Keep route_order current. Until the route is locked (tech started the day, reordered,
 * or re-optimized) the whole route is re-planned from the start location every time.
 * Afterwards the tech's order is preserved and newcomers are slotted in cheaply.
 */
function ensureRoute(dayId) {
  const day = getDay(dayId);
  const pending = pendingStops(dayId);
  if (!pending.length) return;
  tx(() => {
    if (!day.route_locked) {
      saveOrder(plannedOrder(day, pending, depotPoint()));
      return;
    }
    const ordered = pending.filter((s) => s.route_order !== null);
    const newcomers = pending.filter((s) => s.route_order === null);
    if (!newcomers.length) return;
    const start = startPoint();
    for (const n of newcomers) {
      if (!Number.isFinite(n.lat)) {
        ordered.push(n);
        continue;
      }
      let bestIdx = ordered.length;
      let bestCost = Infinity;
      for (let i = 0; i <= ordered.length; i++) {
        const prev = i === 0 ? start : ordered[i - 1];
        const next = i === ordered.length ? null : ordered[i];
        const ok = (p) => p && Number.isFinite(p.lat);
        const cost =
          (ok(prev) ? distance(prev, n) : 0) + (ok(next) ? distance(n, next) : 0) - (ok(prev) && ok(next) ? distance(prev, next) : 0);
        if (cost < bestCost) {
          bestCost = cost;
          bestIdx = i;
        }
      }
      ordered.splice(bestIdx, 0, n);
    }
    // A late addition joins the session of the stop it follows (or keeps its own preference).
    ordered.forEach((st, i) => {
      if (st.route_order === null) {
        st.route_session = st.time_pref !== 'ANY' ? st.time_pref : (ordered[i - 1] || ordered[i + 1])?.route_session || 'AM';
      }
    });
    saveOrder(ordered);
  });
}

function reoptimize(dayId, start) {
  const day = getDay(dayId);
  const pending = pendingStops(dayId);
  const from = start && Number.isFinite(start.lat) ? start : startPoint();
  tx(() => {
    saveOrder(plannedOrder(day, pending, from));
    run('UPDATE work_days SET route_locked = 1 WHERE id = ?', dayId);
  });
}

function reorder(dayId, ids) {
  const pending = pendingStops(dayId);
  const byId = new Map(pending.map((s) => [s.id, s]));
  const ordered = ids.map(Number).filter((id) => byId.has(id)).map((id) => byId.get(id));
  for (const s of pending) if (!ordered.includes(s)) ordered.push(s);
  tx(() => {
    saveOrder(ordered);
    run('UPDATE work_days SET route_locked = 1 WHERE id = ?', dayId);
  });
}

function techLocation() {
  const loc = get('SELECT * FROM tech_location WHERE id = 1');
  return loc ? { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, updatedAt: loc.updated_at } : null;
}

function setTechLocation({ lat, lng, accuracy }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, 'Invalid location');
  }
  run(
    `INSERT INTO tech_location (id, lat, lng, accuracy, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = excluded.updated_at`,
    lat,
    lng,
    Number.isFinite(accuracy) ? accuracy : null,
    nowIso()
  );
}

/** Staff view of one day: ordered queue, completed stops, tech location. */
function dayView(dayId) {
  ensureRoute(dayId);
  const day = listDays().find((d) => d.id === Number(dayId));
  if (!day) throw new HttpError(404, 'Day not found');
  const shape = (s) => ({
    id: s.id,
    name: s.name,
    address: s.address,
    formattedAddress: s.formatted_address,
    phone: s.phone,
    notes: s.notes,
    techNotes: s.tech_notes,
    lat: s.lat,
    lng: s.lng,
    timePref: s.time_pref,
    status: s.status,
    routeOrder: s.route_order,
    session: s.route_session,
    completedAt: s.completed_at,
    notifiedNext: Boolean(s.notified_next_at),
    notifiedSecond: Boolean(s.notified_second_at),
  });
  const queue = pendingStops(dayId).map(shape);
  const completed = all(
    `SELECT * FROM signups WHERE assigned_day_id = ? AND status = 'completed' ORDER BY completed_at`,
    dayId
  ).map(shape);
  return { day, queue, completed, techLocation: techLocation(), startLocation: getSetting('start_location') };
}

/** Send "2nd in line" / "you're next" texts. Only runs while the day is in progress. */
async function processQueue(dayId) {
  const day = get('SELECT * FROM work_days WHERE id = ?', dayId);
  if (!day || day.status !== 'in_progress') return;
  ensureRoute(dayId);
  const queue = pendingStops(dayId);
  const [first, second] = queue;
  if (first && !first.notified_next_at) {
    run('UPDATE signups SET notified_next_at = ? WHERE id = ?', nowIso(), first.id);
    await sendToSignup(
      first,
      'next',
      `${brand()}: You're next! Our technician is heading to ${first.address} now. ` +
        `Please make sure gates are unlocked and the backflow/shutoff valve is accessible.`
    );
  }
  if (second && !second.notified_second_at && !second.notified_next_at) {
    run('UPDATE signups SET notified_second_at = ? WHERE id = ?', nowIso(), second.id);
    await sendToSignup(
      second,
      'second',
      `${brand()}: You're 2nd in line! Our technician will be at ${second.address} after one more stop.`
    );
  }
}

async function startDay(dayId) {
  const day = getDay(dayId);
  if (day.status === 'done') run(`UPDATE work_days SET status = 'in_progress', ended_at = NULL WHERE id = ?`, dayId);
  else if (day.status === 'scheduled') {
    ensureRoute(dayId); // lock in the currently planned order
    run(`UPDATE work_days SET status = 'in_progress', started_at = ?, route_locked = 1 WHERE id = ?`, nowIso(), dayId);
  }
  await processQueue(dayId);
}

async function completeSignup(id, { techNotes } = {}) {
  const s = getSignup(id);
  if (s.status !== 'scheduled') throw new HttpError(400, 'Only scheduled stops can be completed.');
  run(
    `UPDATE signups SET status = 'completed', completed_at = ?, tech_notes = ?, updated_at = datetime('now') WHERE id = ?`,
    nowIso(),
    String(techNotes ?? s.tech_notes ?? '').trim().slice(0, 1000),
    id
  );
  const done = getSignup(id);
  if (!done.notified_complete_at) {
    run('UPDATE signups SET notified_complete_at = ? WHERE id = ?', nowIso(), id);
    await sendToSignup(
      done,
      'complete',
      `${brand()}: Your irrigation system at ${done.address} has been winterized.` +
        (done.tech_notes ? ` Technician notes: ${done.tech_notes.replace(/([^.!?])$/, '$1.')}` : '') +
        ' Thank you!'
    );
  }
  if (s.assigned_day_id) await processQueue(s.assigned_day_id);
  return done;
}

async function uncompleteSignup(id) {
  const s = getSignup(id);
  if (s.status !== 'completed') throw new HttpError(400, 'Stop is not completed.');
  run(`UPDATE signups SET status = 'scheduled', completed_at = NULL, route_order = 0 WHERE id = ?`, id);
  // route_order 0 puts it back at the front of the queue
  const pending = pendingStops(s.assigned_day_id);
  saveOrder(pending);
  return getSignup(id);
}

async function sendMoved(s) {
  const day = get('SELECT * FROM work_days WHERE id = ?', s.assigned_day_id);
  if (!day) return;
  await sendToSignup(
    s,
    'moved',
    `${brand()}: Your winterization at ${s.address} has been moved to ${prettyDate(day.date)} (${PREF_LABEL[s.time_pref]}). ` +
      `Details or changes: ${manageLink(s.token)}`
  );
}

/**
 * Move a stop to the next open day with room after its current day, preferring
 * days the neighbor said work for them. Returns {signup, day|null}.
 */
async function moveToNextDay(id, { notify = true } = {}) {
  const s = getSignup(id);
  if (s.status === 'completed' || s.status === 'cancelled') throw new HttpError(400, 'This stop cannot be moved.');
  const current = s.assigned_day_id ? get('SELECT * FROM work_days WHERE id = ?', s.assigned_day_id) : null;
  const candidates = all(
    `SELECT * FROM work_days WHERE is_open = 1 AND status != 'done' AND date >= ? ORDER BY date`,
    today()
  ).filter((d) => !current || (d.id !== current.id && d.date > current.date));
  const prefs = new Map(prefsFor(s.id).map((p) => [p.dayId, p.timePref]));
  // Keep their time of day: a morning person only moves to a day with morning room.
  const prefOn = (d) => prefs.get(d.id) || s.time_pref;
  const withRoom = candidates.filter((d) => roomFor(d, prefOn(d)));
  const target = withRoom.find((d) => prefs.has(d.id)) || withRoom[0] || null;

  if (target) {
    assign(s.id, target.id, prefOn(target));
  } else {
    run(`UPDATE signups SET status = 'unscheduled', assigned_day_id = NULL, route_order = NULL WHERE id = ?`, s.id);
  }
  const updated = getSignup(s.id);
  if (notify) {
    if (target) await sendMoved(updated);
    else
      await sendToSignup(
        updated,
        'moved',
        `${brand()}: We weren't able to get to ${s.address}${current ? ` on ${prettyDate(current.date)}` : ''}. ` +
          `We'll text you as soon as it's rescheduled. Sorry for the delay!`
      );
  }
  if (current) await processQueue(current.id);
  return { signup: updated, day: target };
}

async function rolloverDay(dayId, { notify = true } = {}) {
  getDay(dayId);
  const results = [];
  for (const s of pendingStops(dayId)) {
    const { day } = await moveToNextDay(s.id, { notify });
    results.push({ id: s.id, address: s.address, movedTo: day ? day.date : null });
  }
  return results;
}

async function endDay(dayId, { rollover = false } = {}) {
  getDay(dayId);
  run(`UPDATE work_days SET status = 'done', ended_at = ? WHERE id = ?`, nowIso(), dayId);
  return rollover ? rolloverDay(dayId) : [];
}

module.exports = {
  listDays,
  getDay,
  getSignup,
  getSignupByToken,
  describeSignup,
  prefsFor,
  createSignup,
  updateSignupByToken,
  cancelSignupByToken,
  resendLinks,
  adminUpdateSignup,
  deleteSignup,
  regeocode,
  ensureRoute,
  reoptimize,
  reorder,
  techLocation,
  setTechLocation,
  dayView,
  processQueue,
  startDay,
  endDay,
  completeSignup,
  uncompleteSignup,
  moveToNextDay,
  rolloverDay,
  manageLink,
};
