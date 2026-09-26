/**
 * Regenerates the screenshots used in the user manual.
 *
 *   node docs/manual/capture.js
 *
 * Starts the app on a throwaway database, loads sample neighbors, walks through a
 * service day, and saves screenshots to docs/manual/img/. Needs Playwright with
 * Chromium (npm i -g playwright). The Google map is replaced by a simple stand-in
 * that draws the same pins and route line, so no API key is needed.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')));
}

const ROOT = path.join(__dirname, '..', '..');
const IMG = path.join(__dirname, 'img');
const PORT = 3470;
const B = `http://localhost:${PORT}`;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-manual-')), 'demo.db');
const ADMIN_PW = 'demo-admin';
const TECH_PW = 'demo-tech';

// ---------------------------------------------------------------- sample data (fictional)
const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07'];
const BASE = { lat: 45.0515, lng: -93.4795 };
const at = (dLat, dLng) => ({ lat: BASE.lat + dLat, lng: BASE.lng + dLng });
const PEOPLE = [
  // day 1 (Mon Oct 5)
  ['Pat Olson', '16410 58th Ave N', 'AM', 0, at(0.0012, 0.0021), 'Valve box is by the side gate.'],
  ['Chris Lindqvist', '16435 58th Ave N', 'AM', 0, at(0.0015, 0.0009), ''],
  ['Jordan Berg', '5720 Terra Vista Ln', 'AM', 0, at(-0.0004, 0.0031), 'Dog in the backyard, friendly.'],
  ['Sam Nguyen', '5745 Terra Vista Ln', 'AM', 0, at(-0.0011, 0.0036), ''],
  ['Taylor Swanson', '16520 57th Ave N', 'ANY', 0, at(-0.0019, -0.0008), 'Gate code 4417'],
  ['Morgan Peterson', '16545 57th Ave N', 'ANY', 0, at(-0.0022, -0.0019), ''],
  ['Casey Johnson', '5810 Ranchview Ln', 'ANY', 0, at(0.0031, -0.0012), 'Controller is in the garage.'],
  ['Riley Anderson', '5835 Ranchview Ln', 'ANY', 0, at(0.0036, -0.0024), ''],
  ['Jamie Carlson', '16610 59th Ave N', 'PM', 0, at(0.0044, -0.0041), ''],
  ['Avery Hanson', '16635 59th Ave N', 'PM', 0, at(0.0047, -0.0052), 'Please call when 10 min away.'],
  ['Quinn Larson', '16660 58th Pl N', 'PM', 0, at(0.0028, -0.0058), ''],
  ['Drew Magnuson', '16685 58th Pl N', 'PM', 0, at(0.0019, -0.0063), 'Backflow on north side of house.'],
  // day 2 (Tue Oct 6)
  ['Blake Erickson', '5705 Dunkirk Ln N', 'AM', 1, at(-0.0035, 0.0012), ''],
  ['Reese Thompson', '5730 Dunkirk Ln N', 'ANY', 1, at(-0.0041, 0.0019), ''],
  ['Skyler Holm', '5755 Dunkirk Ln N', 'PM', 1, at(-0.0047, 0.0026), ''],
  // day 3 (Wed Oct 7): morning fills up (limit 2 on this day for the screenshot)
  ['Kendall Strand', '16480 56th Ave N', 'AM', 2, at(-0.0055, 0.0004), ''],
  ['Hayden Moe', '16505 56th Ave N', 'AM', 2, at(-0.0058, -0.0006), ''],
];

// A stand-in for Google Maps: light background, faint street grid, same pins and route line.
const MAP_STUB = `
(() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  class LatLngBounds { constructor(){ this.n=-90; this.s=90; this.e=-180; this.w=180; }
    extend(p){ this.n=Math.max(this.n,p.lat); this.s=Math.min(this.s,p.lat); this.e=Math.max(this.e,p.lng); this.w=Math.min(this.w,p.lng); } }
  class GMap {
    constructor(el){ this.el=el; this.items=new Set(); el.innerHTML=''; el.style.position='relative'; el.style.overflow='hidden';
      el.style.background='#eef2ea';
      el.style.backgroundImage='linear-gradient(#ffffff 3px, transparent 3px), linear-gradient(90deg, #ffffff 3px, transparent 3px), linear-gradient(#e2e8dd 1px, transparent 1px), linear-gradient(90deg, #e2e8dd 1px, transparent 1px)';
      el.style.backgroundSize='140px 110px, 140px 110px, 35px 27px, 35px 27px';
      this.svg=document.createElementNS(SVGNS,'svg'); this.svg.setAttribute('style','position:absolute;inset:0;width:100%;height:100%;pointer-events:none'); el.appendChild(this.svg);
      this.b={n:45.06,s:45.04,e:-93.47,w:-93.49}; }
    setCenter(){} setZoom(){}
    fitBounds(b){ const padLat=(b.n-b.s)*0.12+0.0004, padLng=(b.e-b.w)*0.12+0.0004; this.b={n:b.n+padLat,s:b.s-padLat,e:b.e+padLng,w:b.w-padLng}; this.layout(); }
    xy(p){ const r=this.el.getBoundingClientRect(); return { x:(p.lng-this.b.w)/(this.b.e-this.b.w)*r.width, y:(this.b.n-p.lat)/(this.b.n-this.b.s)*r.height }; }
    layout(){ this.items.forEach(i=>i.draw()); }
  }
  class AdvancedMarkerElement {
    constructor(o){ this.box=document.createElement('div'); this.box.style.cssText='position:absolute;transform:translate(-50%,-50%)';
      if(o.content) this.box.appendChild(o.content); this.box.style.zIndex=o.zIndex||1; this._pos=o.position; this.map=o.map; }
    set map(m){ if(this._map){ this._map.items.delete(this); this.box.remove(); } this._map=m; if(m){ m.items.add(this); m.el.appendChild(this.box); this.draw(); } }
    get map(){ return this._map; }
    set position(p){ this._pos=p; this.draw(); } get position(){ return this._pos; }
    draw(){ if(!this._map||!this._pos) return; const {x,y}=this._map.xy(this._pos); this.box.style.left=x+'px'; this.box.style.top=y+'px'; }
    addListener(){}
  }
  class Polyline {
    constructor(o){ this.path=o.path; this.line=document.createElementNS(SVGNS,'polyline');
      this.line.setAttribute('fill','none'); this.line.setAttribute('stroke','#1f7a4d'); this.line.setAttribute('stroke-width','3'); this.line.setAttribute('stroke-dasharray','6 7'); this.setMap(o.map); }
    setMap(m){ if(this.m){ this.m.items.delete(this); this.line.remove(); } this.m=m; if(m){ m.items.add(this); m.svg.appendChild(this.line); this.draw(); } }
    draw(){ if(!this.m) return; this.line.setAttribute('points', this.path.map(p=>{const q=this.m.xy(p); return q.x+','+q.y;}).join(' ')); }
  }
  class InfoWindow { setContent(){} open(){} }
  window.google = { maps: { importLibrary: async (n) => ({ maps:{ Map:GMap, InfoWindow, Polyline }, marker:{ AdvancedMarkerElement }, core:{ LatLngBounds } })[n] } };
  window.__tvMapsReady && window.__tvMapsReady();
})();`;

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sql(statements) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA busy_timeout = 5000');
  statements(db);
  db.close();
}

async function main() {
  fs.mkdirSync(IMG, { recursive: true });
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      ADMIN_PASSWORD: ADMIN_PW,
      TECH_PASSWORD: TECH_PW,
      SESSION_SECRET: 'manual-screenshots',
      BASE_URL: 'https://your-site.up.railway.app',
      GOOGLE_MAPS_API_KEY: 'demo',
      NODE_ENV: 'development',
      RAILWAY_ENVIRONMENT: '',
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${B}/healthz`)).ok) break;
      } catch {}
      await sleep(100);
    }
    await run();
  } finally {
    server.kill();
  }
}

async function run() {
  const browser = await chromium.launch();
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
  const desktop = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5 };
  const errors = [];
  const newPage = async (ctx) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route(/maps\.googleapis\.com/, (r) => r.fulfill({ contentType: 'text/javascript', body: MAP_STUB }));
    return p;
  };
  const shot = async (target, name, opts = {}) => {
    await sleep(250);
    await target.screenshot({ path: path.join(IMG, `${name}.png`), ...opts });
    console.log('  saved', name);
  };
  const login = async (ctx, role, pw) => {
    const r = await ctx.request.post(`${B}/api/login`, { data: { role, password: pw } });
    if (!r.ok()) throw new Error(`login ${role} failed`);
  };

  // ---- seed
  const adminCtx = await browser.newContext(desktop);
  await login(adminCtx, 'admin', ADMIN_PW);
  const post = async (url, data) => {
    const r = await adminCtx.request.post(B + url, { data });
    const j = await r.json();
    if (!r.ok()) throw new Error(`${url}: ${j.error}`);
    return j;
  };
  const days = await post('/api/admin/days', { dates: DAYS });
  const dayId = (i) => days.find((d) => d.date === DAYS[i]).id;
  await adminCtx.request.put(`${B}/api/admin/days/${dayId(2)}`, { data: { amCapacity: 2 } });
  const ids = [];
  for (const [i, [name, address, pref, day, , notes]] of PEOPLE.entries()) {
    const s = await post('/api/signups', {
      name,
      address,
      phone: `763555${String(100 + i).padStart(4, '0')}`,
      notes,
      prefs: [{ dayId: dayId(day), timePref: pref }, ...(day === 0 ? [{ dayId: dayId(1), timePref: 'ANY' }] : [])],
    });
    ids.push(s.id);
  }
  sql((db) => {
    PEOPLE.forEach(([, address, , , pt], i) =>
      db.prepare('UPDATE signups SET lat = ?, lng = ?, formatted_address = ? WHERE id = ?').run(
        pt.lat,
        pt.lng,
        `${address}, Plymouth, MN 55446, USA`,
        ids[i]
      )
    );
    db.prepare(`INSERT INTO settings (key, value) VALUES ('start_location', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      JSON.stringify({ address: '16400 58th Ave N', formattedAddress: '16400 58th Ave N, Plymouth, MN 55446, USA', ...at(0.0006, 0.0042) })
    );
  });

  // ---- neighbor: sign-up
  console.log('Neighbor pages');
  const pubCtx = await browser.newContext(phone);
  let p = await newPage(pubCtx);
  await p.goto(B + '/');
  await p.waitForSelector('.day');
  await shot(p, 'signup-top');
  await p.fill('#name', 'Alex Rivera');
  await p.fill('#phone', '(763) 555-0199');
  await p.fill('#address', '16455 58th Ave N');
  await p.fill('#notes', 'Side gate is unlocked. Controller is in the garage.');
  await p.click('.day:nth-child(2) .day-head');
  await p.click('.day:nth-child(2) .seg label:nth-child(1) span');
  await p.click('.day:nth-child(3) .day-head');
  await p.click('.day:nth-child(3) .seg label:nth-child(2) span');
  const daysEl = await p.$('#signup-form');
  await daysEl.evaluate((el) => el.querySelector('#days').scrollIntoView());
  await shot(await p.$('#signup-form'), 'signup-form');
  await p.click('#submit');
  await p.waitForSelector('#success-section:not(.hidden)');
  await shot(p, 'signup-success');
  const manageUrl = await p.getAttribute('#success-link', 'href');
  await p.goto(manageUrl.replace('https://your-site.up.railway.app', B));
  await p.waitForSelector('#status-card:not(.hidden)');
  await shot(p, 'manage', { fullPage: true });
  await p.click('details.card summary').catch(() => {});

  // ---- login
  const loginCtx = await browser.newContext(phone);
  p = await newPage(loginCtx);
  await p.goto(B + '/login.html?role=admin');
  await shot(p, 'login');

  // ---- admin (before the day starts)
  console.log('Admin pages');
  const a = await newPage(adminCtx);
  await a.goto(B + '/admin.html#signups');
  await a.waitForSelector('[data-edit]');
  await shot(a, 'admin-signups');
  await a.click(`[data-edit="${ids[4]}"]`);
  await a.waitForSelector('#edit-dlg[open]');
  await shot(await a.$('#edit-dlg'), 'admin-edit');
  await a.keyboard.press('Escape');
  await a.goto(B + '/admin.html#days');
  await a.waitForSelector('[data-am]');
  await shot(a, 'admin-dates');
  await a.goto(B + '/admin.html#settings');
  await a.waitForSelector('#integrations li');
  await shot(a, 'admin-settings');

  // ---- technician
  console.log('Technician pages');
  const techCtx = await browser.newContext({ ...phone, geolocation: { latitude: at(0.0006, 0.0042).lat, longitude: at(0.0006, 0.0042).lng }, permissions: ['geolocation'] });
  await login(techCtx, 'tech', TECH_PW);
  const t = await newPage(techCtx);
  await t.goto(`${B}/tech.html?day=${dayId(0)}`);
  await t.waitForSelector('.stop');
  await shot(t, 'tech-before-start');
  await t.click('#start-btn');
  await t.waitForSelector('#end-btn:not(.hidden)');
  await sleep(600);
  // finish the first three stops
  const view = await (await techCtx.request.get(`${B}/api/staff/days/${dayId(0)}`)).json();
  const notes = ['Blew out 6 zones.', 'Blew out 5 zones. Replaced a cracked backflow cover.', 'Blew out 7 zones.'];
  for (const [i, s] of view.queue.slice(0, 3).entries()) {
    await techCtx.request.post(`${B}/api/staff/signups/${s.id}/complete`, { data: { techNotes: notes[i] } });
  }
  const next = view.queue[3];
  // The tech is between the last finished stop and the next one, sharing location.
  await techCtx.setGeolocation({ latitude: (view.queue[2].lat + next.lat) / 2, longitude: (view.queue[2].lng + next.lng) / 2 });
  await t.reload();
  await t.waitForSelector('.next-card:not(.hidden)');
  await t.waitForSelector('#loc-state.loc-on');
  await sleep(1500);
  await t.reload();
  await t.waitForSelector('#loc-state.loc-on');
  await sleep(800);
  await shot(t, 'tech-top');
  await shot(await t.$('#queue'), 'tech-queue');
  await t.click('.next-card [data-complete]');
  await t.fill('#tech-notes', 'Blew out 6 zones. Front-yard head is broken, replace in spring.');
  await shot(t, 'tech-complete');
  await t.keyboard.press('Escape');
  await t.click('details.card summary');
  await shot(await t.$('details.card'), 'tech-completed');
  await t.click('#end-btn');
  await shot(t, 'tech-end-day');
  await t.keyboard.press('Escape');

  // ---- neighbor on service day
  const secondToken = (await (await adminCtx.request.get(`${B}/api/admin/signups?dayId=${dayId(0)}`)).json()).find(
    (s) => s.id === view.queue[4].id
  ).manageUrl;
  p = await newPage(pubCtx);
  await p.goto(secondToken.replace('https://your-site.up.railway.app', B));
  await p.waitForSelector('#status-card:not(.hidden)');
  await shot(await p.$('#status-card'), 'manage-second-in-line');

  // ---- admin during the day
  await a.goto(B + '/admin.html#map');
  await a.selectOption('#m-day', String(dayId(0)));
  await sleep(800);
  await shot(a, 'admin-map', { fullPage: true });
  await a.goto(B + '/admin.html#texts');
  await a.waitForSelector('#sms-rows tr');
  await shot(a, 'admin-texts');

  await browser.close();
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
