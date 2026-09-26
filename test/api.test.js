process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'admin-pw';
process.env.TECH_PASSWORD = 'tech-pw';
process.env.GOOGLE_MAPS_API_KEY = '';
process.env.TWILIO_ACCOUNT_SID = '';

const test = require('node:test');
const assert = require('node:assert');
const app = require('../server/app');
const { all, run } = require('../server/db');
const { today } = require('../server/util');

let server;
let base;
const cookies = {};

async function req(method, path, body, role) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(role ? { Cookie: cookies[role] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const addDays = (n) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [role, password] of [['admin', 'admin-pw'], ['tech', 'tech-pw']]) {
    const r = await req('POST', '/api/login', { role, password });
    assert.strictEqual(r.status, 200);
    cookies[role] = r.headers.get('set-cookie').split(';')[0];
  }
});
test.after(() => server.close());

test('staff endpoints require the right password', async () => {
  assert.strictEqual((await req('POST', '/api/login', { role: 'admin', password: 'nope' })).status, 401);
  assert.strictEqual((await req('GET', '/api/admin/signups')).status, 401);
  assert.strictEqual((await req('GET', '/api/admin/signups', null, 'tech')).status, 401);
  assert.strictEqual((await req('GET', '/api/staff/days', null, 'tech')).status, 200);
  assert.strictEqual((await req('GET', '/api/staff/days', null, 'admin')).status, 200);
});

test('full season flow', async (t) => {
  const d1 = addDays(3);
  const d2 = addDays(4);
  const d3 = addDays(5);
  let r = await req('POST', '/api/admin/days', { dates: [d1, d2, d3], capacity: 3 }, 'admin');
  assert.strictEqual(r.status, 200);
  const [day1, day2, day3] = r.data;

  await t.test('public sees open days with remaining spots', async () => {
    r = await req('GET', '/api/days');
    assert.deepStrictEqual(r.data.map((d) => d.remaining), [3, 3, 3]);
  });

  const tokens = [];
  await t.test('sign-ups fill the earliest acceptable day, then overflow', async () => {
    for (let i = 0; i < 4; i++) {
      r = await req('POST', '/api/signups', {
        name: `Neighbor ${i}`,
        address: `${100 + i} Terra Vista Dr`,
        phone: `(916) 555-01${String(i).padStart(2, '0')}`,
        notes: i === 0 ? 'Dog in yard' : '',
        prefs: [
          { dayId: day1.id, timePref: i % 2 ? 'PM' : 'AM' },
          { dayId: day2.id, timePref: 'ANY' },
        ],
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      tokens.push(r.data.token);
    }
    const s = await Promise.all(tokens.map((tk) => req('GET', `/api/signups/${tk}`)));
    assert.deepStrictEqual(s.map((x) => x.data.assignedDay.date), [d1, d1, d1, d2]);
    assert.strictEqual(s[3].data.timePref, 'ANY');
    r = await req('GET', '/api/days');
    assert.strictEqual(r.data.find((d) => d.id === day1.id).full, true);
  });

  await t.test('confirmation texts include the edit link', () => {
    const msgs = all(`SELECT * FROM sms_log WHERE kind = 'confirmation'`);
    assert.strictEqual(msgs.length, 4);
    assert.match(msgs[0].body, /manage\.html\?t=/);
    assert.strictEqual(msgs[0].to_phone, '+19165550100');
  });

  await t.test('duplicate sign-up is rejected and the link is re-sent', async () => {
    r = await req('POST', '/api/signups', { address: '100 terra vista dr', phone: '916-555-0100', prefs: [{ dayId: day2.id }] });
    assert.strictEqual(r.status, 409);
  });

  await t.test('choosing only full days is rejected', async () => {
    r = await req('POST', '/api/signups', { address: '999 Elm', phone: '9165559999', prefs: [{ dayId: day1.id }] });
    assert.strictEqual(r.status, 409);
  });

  await t.test('neighbor can edit via their link', async () => {
    r = await req('PUT', `/api/signups/${tokens[3]}`, { notes: 'Gate code 1234', prefs: [{ dayId: day3.id, timePref: 'PM' }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.assignedDay.date, d3);
    assert.strictEqual(r.data.timePref, 'PM');
    assert.strictEqual(r.data.notes, 'Gate code 1234');
  });

  await t.test('tech works the day: queue texts and completion', async () => {
    r = await req('GET', `/api/staff/days/${day1.id}`, null, 'tech');
    assert.strictEqual(r.data.queue.length, 3);
    // AM stops (neighbors 0 and 2) come before the PM stop (neighbor 1)
    assert.deepStrictEqual(r.data.queue.map((q) => q.timePref), ['AM', 'AM', 'PM']);
    assert.strictEqual(all(`SELECT * FROM sms_log WHERE kind IN ('next','second')`).length, 0, 'no texts before the day starts');

    r = await req('POST', `/api/staff/days/${day1.id}/start`, null, 'tech');
    const [first, second, third] = r.data.queue;
    let log = all('SELECT * FROM sms_log ORDER BY id');
    assert.ok(log.some((m) => m.kind === 'next' && m.signup_id === first.id));
    assert.ok(log.some((m) => m.kind === 'second' && m.signup_id === second.id));

    r = await req('POST', `/api/staff/signups/${first.id}/complete`, { techNotes: '6 zones blown out' }, 'tech');
    assert.strictEqual(r.data.status, 'completed');
    log = all('SELECT * FROM sms_log ORDER BY id');
    assert.ok(log.some((m) => m.kind === 'complete' && m.signup_id === first.id && m.body.includes('6 zones')));
    assert.ok(log.some((m) => m.kind === 'next' && m.signup_id === second.id));
    assert.ok(log.some((m) => m.kind === 'second' && m.signup_id === third.id));
    // no duplicate "next" texts
    assert.strictEqual(log.filter((m) => m.kind === 'next' && m.signup_id === second.id).length, 1);

    const status = await req('GET', `/api/signups/${tokens.find(Boolean) && all('SELECT token FROM signups WHERE id = ?', second.id)[0].token}`);
    assert.strictEqual(status.data.queuePosition, 1);
  });

  await t.test('ending the day rolls unfinished stops to the next day', async () => {
    r = await req('POST', `/api/staff/days/${day1.id}/end`, { rollover: true }, 'tech');
    assert.strictEqual(r.data.moved.length, 2);
    // Both accepted day2 as well, which has room (neighbor 3 moved to day3).
    assert.deepStrictEqual(r.data.moved.map((m) => m.movedTo), [d2, d2]);
    const moved = all(`SELECT * FROM signups WHERE assigned_day_id = ?`, day2.id);
    assert.ok(moved.every((m) => m.time_pref === 'ANY' && m.notified_next_at === null));
    assert.strictEqual(all(`SELECT * FROM sms_log WHERE kind = 'moved'`).length, 2);
  });

  await t.test('moving when no day has room marks the stop as needing a date', async () => {
    run('UPDATE work_days SET capacity = 1 WHERE id = ?', day3.id);
    const s = all('SELECT id FROM signups WHERE assigned_day_id = ?', day2.id)[0];
    r = await req('POST', `/api/staff/signups/${s.id}/move-next`, {}, 'tech');
    assert.strictEqual(r.data.day, null);
    assert.strictEqual(r.data.signup.status, 'unscheduled');
  });

  await t.test('admin can add, edit, export and delete', async () => {
    r = await req('POST', '/api/admin/signups', { address: '1 Admin Way', phone: '9165551111', assignedDayId: day3.id, timePref: 'AM', allowOverCapacity: true }, 'admin');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const id = r.data.id;
    r = await req('PUT', `/api/admin/signups/${id}`, { notes: '=HYPERLINK("x")' }, 'admin');
    assert.strictEqual(r.status, 200);
    r = await req('GET', `/api/admin/export.csv?dayId=${day3.id}`, null, 'admin');
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.data, /1 Admin Way/);
    assert.match(r.data, /'=HYPERLINK/, 'formula cells are neutralised');
    r = await req('DELETE', `/api/admin/signups/${id}`, null, 'admin');
    assert.strictEqual(r.status, 200);
    r = await req('GET', '/api/admin/signups', null, 'admin');
    assert.ok(!r.data.some((s) => s.id === id));
  });

  await t.test('neighbor can cancel', async () => {
    r = await req('DELETE', `/api/signups/${tokens[3]}`);
    assert.strictEqual(r.data.status, 'cancelled');
  });
});

test('tech location is stored', async () => {
  let r = await req('POST', '/api/staff/location', { lat: 38.8, lng: -121.2, accuracy: 5 }, 'tech');
  assert.strictEqual(r.status, 200);
  r = await req('GET', '/api/staff/location', null, 'admin');
  assert.strictEqual(r.data.lat, 38.8);
  r = await req('POST', '/api/staff/location', { lat: 'x' }, 'tech');
  assert.strictEqual(r.status, 400);
});
