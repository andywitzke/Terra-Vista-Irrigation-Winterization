const path = require('node:path');
const express = require('express');
const config = require('./config');
const svc = require('./service');
const { all, get, run, getSetting, setSetting } = require('./db');
const { geocode } = require('./geocode');
const { login, logout, requireRole, sessionRole } = require('./auth');
const { isValidDate, normalizePref, formatPhone, HttpError } = require('./util');

const app = express();
app.set('trust proxy', 1); // one reverse proxy (Render, Fly, nginx) in front
app.use(express.json({ limit: '100kb' }));

/** Wrap async handlers so thrown HttpErrors become JSON responses. */
const h = (fn) => async (req, res, next) => {
  try {
    const result = await fn(req, res);
    if (result !== undefined && !res.headersSent) res.json(result);
  } catch (err) {
    next(err);
  }
};

// Tiny in-memory rate limiter for public write endpoints.
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = hits.get(key) || { n: 0, reset: now + windowMs };
    if (now > entry.reset) Object.assign(entry, { n: 0, reset: now + windowMs });
    entry.n++;
    hits.set(key, entry);
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    if (entry.n > max) return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
    next();
  };
}

const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};

// ------------------------------------------------------------------ public

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) =>
  res.json({
    neighborhoodName: config.neighborhoodName,
    mapsKey: config.googleMapsBrowserKey,
    mapId: config.googleMapsMapId,
    smsEnabled: config.smsEnabled,
    role: sessionRole(req),
  })
);

app.get('/api/days', (req, res) =>
  res.json(
    svc.listDays({ publicOnly: true }).map((d) => ({ id: d.id, date: d.date, remaining: d.remaining, full: d.full }))
  )
);

app.post(
  '/api/signups',
  rateLimit(20, 10 * 60 * 1000),
  h(async (req) => {
    const s = await svc.createSignup(req.body || {});
    return svc.describeSignup(s);
  })
);

app.get('/api/signups/:token', h(async (req) => svc.describeSignup(svc.getSignupByToken(req.params.token))));

app.put(
  '/api/signups/:token',
  rateLimit(30, 10 * 60 * 1000),
  h(async (req) => svc.describeSignup(await svc.updateSignupByToken(req.params.token, req.body || {})))
);

app.delete('/api/signups/:token', h(async (req) => svc.describeSignup(await svc.cancelSignupByToken(req.params.token))));

app.post(
  '/api/resend-link',
  rateLimit(5, 10 * 60 * 1000),
  h(async (req) => {
    await svc.resendLinks(req.body?.phone);
    // Same answer whether or not we found anything, so the endpoint can't be used to probe numbers.
    return { ok: true };
  })
);

app.post('/api/login', rateLimit(20, 10 * 60 * 1000), login);
app.post('/api/logout', logout);

// ------------------------------------------------------------------ staff (tech + admin)

const staff = express.Router();
staff.use(requireRole('admin', 'tech'));

staff.get('/days', (req, res) => res.json(svc.listDays()));
staff.get('/days/:id', h(async (req) => svc.dayView(id(req))));
staff.post('/days/:id/start', h(async (req) => (await svc.startDay(id(req)), svc.dayView(id(req)))));
staff.post(
  '/days/:id/end',
  h(async (req) => {
    const moved = await svc.endDay(id(req), { rollover: Boolean(req.body?.rollover) });
    return { moved, view: svc.dayView(id(req)) };
  })
);
staff.post('/days/:id/rollover', h(async (req) => ({ moved: await svc.rolloverDay(id(req)), view: svc.dayView(id(req)) })));
staff.post(
  '/days/:id/optimize',
  h(async (req) => {
    const { lat, lng } = req.body || {};
    svc.reoptimize(id(req), Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);
    await svc.processQueue(id(req));
    return svc.dayView(id(req));
  })
);
staff.put(
  '/days/:id/order',
  h(async (req) => {
    if (!Array.isArray(req.body?.ids)) throw new HttpError(400, 'ids must be an array');
    svc.reorder(id(req), req.body.ids);
    await svc.processQueue(id(req));
    return svc.dayView(id(req));
  })
);

staff.post('/signups/:id/complete', h(async (req) => svc.completeSignup(id(req), { techNotes: req.body?.techNotes })));
staff.post('/signups/:id/uncomplete', h(async (req) => svc.uncompleteSignup(id(req))));
staff.post('/signups/:id/move-next', h(async (req) => svc.moveToNextDay(id(req), { notify: req.body?.notify !== false })));

staff.post(
  '/location',
  h(async (req) => {
    const { lat, lng, accuracy } = req.body || {};
    svc.setTechLocation({ lat: Number(lat), lng: Number(lng), accuracy: Number(accuracy) });
    return { ok: true };
  })
);
staff.get('/location', (req, res) => res.json(svc.techLocation()));

app.use('/api/staff', staff);

// ------------------------------------------------------------------ admin

const admin = express.Router();
admin.use(requireRole('admin'));

admin.post(
  '/days',
  h(async (req) => {
    const dates = Array.isArray(req.body?.dates) ? req.body.dates : [req.body?.date];
    const capacity = Number(req.body?.capacity) || config.defaultCapacity;
    if (!dates.length || !dates.every(isValidDate)) throw new HttpError(400, 'Use dates in YYYY-MM-DD format.');
    if (capacity < 1 || capacity > 200) throw new HttpError(400, 'Capacity must be between 1 and 200.');
    for (const date of dates) {
      run('INSERT INTO work_days (date, capacity) VALUES (?, ?) ON CONFLICT(date) DO NOTHING', date, capacity);
    }
    return svc.listDays();
  })
);

admin.put(
  '/days/:id',
  h(async (req) => {
    const day = svc.getDay(id(req));
    const b = req.body || {};
    const capacity = b.capacity === undefined ? day.capacity : Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 200) throw new HttpError(400, 'Capacity must be between 1 and 200.');
    const status = ['scheduled', 'in_progress', 'done'].includes(b.status) ? b.status : day.status;
    run(
      'UPDATE work_days SET capacity = ?, is_open = ?, notes = ?, status = ?, route_locked = ? WHERE id = ?',
      capacity,
      b.isOpen === undefined ? day.is_open : b.isOpen ? 1 : 0,
      String(b.notes ?? day.notes).slice(0, 500),
      status,
      b.routeLocked === undefined ? day.route_locked : b.routeLocked ? 1 : 0,
      day.id
    );
    return svc.listDays();
  })
);

admin.delete(
  '/days/:id',
  h(async (req) => {
    const day = svc.getDay(id(req));
    const n = get(`SELECT COUNT(*) AS n FROM signups WHERE assigned_day_id = ? AND status IN ('scheduled','completed')`, day.id).n;
    if (n && !req.query.force) {
      throw new HttpError(409, `${n} neighbor(s) are scheduled on this day. Move them first (use "Roll over") or delete anyway.`);
    }
    // Anyone still scheduled becomes unscheduled rather than silently disappearing.
    run(`UPDATE signups SET status = 'unscheduled', route_order = NULL WHERE assigned_day_id = ? AND status = 'scheduled'`, day.id);
    run('DELETE FROM work_days WHERE id = ?', day.id);
    return svc.listDays();
  })
);

function adminSignupRows({ dayId, status } = {}) {
  const where = [];
  const params = [];
  if (dayId === 'none') where.push('s.assigned_day_id IS NULL');
  else if (dayId) {
    where.push('s.assigned_day_id = ?');
    params.push(Number(dayId));
  }
  if (status) {
    where.push('s.status = ?');
    params.push(String(status));
  } else where.push(`s.status != 'cancelled'`);
  const rows = all(
    `SELECT s.*, d.date AS day_date, d.status AS day_status FROM signups s
     LEFT JOIN work_days d ON d.id = s.assigned_day_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.date IS NULL, d.date, s.status = 'completed', s.route_order IS NULL, s.route_order, s.created_at`,
    ...params
  );
  const prefs = all(
    `SELECT p.signup_id, p.day_id, p.time_pref, d.date FROM signup_prefs p JOIN work_days d ON d.id = p.day_id ORDER BY d.date`
  );
  const bySignup = new Map();
  for (const p of prefs) {
    if (!bySignup.has(p.signup_id)) bySignup.set(p.signup_id, []);
    bySignup.get(p.signup_id).push({ dayId: p.day_id, date: p.date, timePref: p.time_pref });
  }
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    address: s.address,
    formattedAddress: s.formatted_address,
    phone: s.phone,
    notes: s.notes,
    techNotes: s.tech_notes,
    smsOptIn: Boolean(s.sms_opt_in),
    lat: s.lat,
    lng: s.lng,
    status: s.status,
    timePref: s.time_pref,
    assignedDayId: s.assigned_day_id,
    assignedDate: s.day_date,
    routeOrder: s.route_order,
    completedAt: s.completed_at,
    createdAt: s.created_at,
    prefs: bySignup.get(s.id) || [],
    manageUrl: svc.manageLink(s.token),
  }));
}

admin.get('/signups', (req, res) => {
  for (const d of svc.listDays()) if (d.status !== 'done') svc.ensureRoute(d.id);
  res.json(adminSignupRows(req.query));
});

admin.post(
  '/signups',
  h(async (req) => {
    const b = req.body || {};
    const s = await svc.createSignup(
      { ...b, timePref: normalizePref(b.timePref) },
      { admin: true }
    );
    return svc.describeSignup(s);
  })
);

admin.put('/signups/:id', h(async (req) => svc.describeSignup(await svc.adminUpdateSignup(id(req), req.body || {}))));
admin.delete('/signups/:id', h(async (req) => (await svc.deleteSignup(id(req)), { ok: true })));
admin.post('/signups/:id/geocode', h(async (req) => svc.describeSignup(await svc.regeocode(id(req)))));

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheet apps from evaluating formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

admin.get('/export.csv', (req, res) => {
  const rows = adminSignupRows({ dayId: req.query.dayId, status: req.query.status });
  const header = [
    'Service Date', 'Time Preference', 'Route #', 'Status', 'Name', 'Address', 'Google Address', 'Phone',
    'Neighbor Notes', 'Technician Notes', 'Acceptable Dates', 'Texts OK', 'Completed At', 'Signed Up At',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.assignedDate || '',
        r.timePref,
        r.status === 'scheduled' ? r.routeOrder ?? '' : '',
        r.status,
        r.name,
        r.address,
        r.formattedAddress || '',
        formatPhone(r.phone),
        r.notes,
        r.techNotes,
        r.prefs.map((p) => `${p.date} ${p.timePref}`).join('; '),
        r.smsOptIn ? 'yes' : 'no',
        r.completedAt || '',
        r.createdAt,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  const day = req.query.dayId && req.query.dayId !== 'none' ? get('SELECT date FROM work_days WHERE id = ?', Number(req.query.dayId)) : null;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="winterization-${day ? day.date : 'all'}.csv"`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

admin.get('/sms-log', (req, res) =>
  res.json(
    all(
      `SELECT l.*, s.name, s.address FROM sms_log l LEFT JOIN signups s ON s.id = l.signup_id ORDER BY l.id DESC LIMIT 500`
    )
  )
);

admin.get('/settings', (req, res) =>
  res.json({
    startLocation: getSetting('start_location'),
    smsEnabled: config.smsEnabled,
    mapsConfigured: Boolean(config.googleMapsBrowserKey),
    geocodingConfigured: Boolean(config.googleMapsServerKey),
    baseUrl: config.baseUrl,
    addressSuffix: config.addressSuffix,
  })
);

admin.put(
  '/settings',
  h(async (req) => {
    const address = String(req.body?.startAddress || '').trim();
    if (!address) {
      setSetting('start_location', null);
    } else {
      const geo = await geocode(address);
      if (!geo) throw new HttpError(422, 'Could not locate that address. Check the Google Maps key and the spelling.');
      setSetting('start_location', { address, lat: geo.lat, lng: geo.lng, formattedAddress: geo.formattedAddress });
    }
    return { startLocation: getSetting('start_location') };
  })
);

app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ------------------------------------------------------------------ static pages

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
