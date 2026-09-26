# Terra Vista Sprinkler Winterization

A small web app for scheduling irrigation-system winterization in the Terra Vista neighborhood.

- **Neighbors** sign up with their address, mobile number and notes, and pick every day that works for them, choosing
  morning, afternoon or any time for each. They get a text with a private link to view, change or cancel.
- **The administrator** opens dates for sign-up (25 spots each by default), sees and edits every sign-up, adds or removes
  people, views everything on a map, and exports to CSV.
- **The technician** gets the day's route, ordered by proximity and AM/PM preference. From a phone they mark houses
  complete, reorder or re-plan the route, share their live location, and move unfinished houses to the next available day.
- **Texts** go out on sign-up, when a neighbor is 2nd in line, when they're next, and when their system is done.

## Pages

| URL | Who | What |
| --- | --- | --- |
| `/` | Neighbors | Sign-up form |
| `/manage.html?t=…` | Neighbors | Private link from the text: status, place in line on service day, edit or cancel |
| `/tech.html` | Technician (password) | Today's route, map, "up next", complete, reorder, move to next day, location sharing |
| `/admin.html` | Admin (password) | Sign-ups, dates, map, text log, settings, CSV export |

The admin password also works on the technician login.

## Quick start

Requires **Node.js 22.13 or newer** (it uses Node's built-in SQLite, so there's nothing native to compile).

```bash
npm install
cp .env.example .env   # then edit it
npm start              # http://localhost:3000
npm test
```

With no Google or Twilio keys everything still works: maps show a notice, addresses aren't placed on the map, and texts
are written to the server log and the admin **Text log** tab instead of being sent.

## Configuration

Set these as environment variables or in `.env` (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `BASE_URL` | Public URL of the site, used for links in texts (e.g. `https://winterize.example.com`) |
| `ADMIN_PASSWORD`, `TECH_PASSWORD` | Staff passwords. **Change the defaults** (`admin` / `tech`). |
| `SESSION_SECRET` | Long random string used to sign login cookies. Without it, staff are logged out on every restart. |
| `ADDRESS_SUFFIX` | Added to addresses before geocoding, e.g. `Rocklin, CA 95765`, so "123 Main St" lands in the neighborhood |
| `GOOGLE_MAPS_API_KEY` | Google Maps Platform key with **Maps JavaScript API** and **Geocoding API** enabled |
| `GOOGLE_MAPS_SERVER_KEY` | Optional separate key for server-side geocoding (useful if the browser key is HTTP-referrer restricted) |
| `GOOGLE_MAPS_MAP_ID` | Optional Map ID for Advanced Markers (`DEMO_MAP_ID` is used otherwise) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID` | Sender for texts |
| `NEIGHBORHOOD_NAME`, `TZ_NAME`, `DEFAULT_DAY_CAPACITY`, `PORT`, `DB_PATH` | Other settings |

### Google Maps

1. In Google Cloud Console, create a project and enable **Maps JavaScript API** and **Geocoding API**.
2. Create an API key. Restrict the browser key to your site's domain (HTTP referrers). If you restrict it that way, create a
   second key for `GOOGLE_MAPS_SERVER_KEY` restricted to the Geocoding API (server calls send no referrer).
3. Optionally create a Map ID (Map Management) and set `GOOGLE_MAPS_MAP_ID`.

Addresses are geocoded once when someone signs up or changes their address. Admins can retry any address that couldn't be
located ("Not located → retry" on the Sign-ups tab).

### Twilio

Create a Twilio account and buy a phone number. For US numbers sending application texts, Twilio requires **A2P 10DLC
registration** (or a verified toll-free number) before messages are delivered reliably, so start that early. Twilio
handles STOP/HELP replies automatically. Every attempt, successful or not, appears in the admin **Text log** tab.

## How scheduling works

- **Capacity.** A person occupies one spot, on the day they're scheduled for. When they sign up they're placed on the
  **earliest** of their chosen days that still has room. Their other chosen days are remembered as backups. Full days show
  as "Full" on the sign-up form. Admins can go over capacity with a checkbox.
- **Route.** For each day, morning stops are put in the shortest order from the start point, afternoon stops continue from
  where the morning ends, and "any time" stops are slotted in wherever they add the least driving. The route uses
  straight-line distance (nearest-neighbor plus 2-opt), which works well inside a neighborhood and doesn't need Google
  quota. Set a **start point** (for example the neighborhood entrance) under Admin → Settings.
- **Locking.** Until the technician starts the day, the route is re-planned automatically as people sign up or change.
  Once the day starts, or the tech reorders stops or taps **Re-plan from here**, the order is kept, and late additions
  are slotted in at the cheapest spot.
- **Notifications.** Nothing about queue position is sent until the tech taps **Start day**. After that, whoever is first in
  the queue gets "you're next" and whoever is second gets "you're 2nd in line". Each completion moves the queue along and
  sends a "done" text (with the tech's notes). Nobody gets the same text twice.
- **Unfinished houses.** **End day…** can move every unfinished stop to the next open day with room, preferring days
  the neighbor said work for them, and texts them the new date. Single stops can be moved with **Move to next day**. If no
  day has room, the stop is marked **Needs a date** for the admin to handle.
- **Location.** The tech ticks **Share my location** (the browser asks for permission). Their position is sent about every
  15 seconds while the page is open and shows on both maps. Phones may pause this when the screen locks or the browser is
  in the background.

## Deploying

Any host that runs Node 22 and has a **persistent disk** for the SQLite file works (Render, Railway, Fly.io, a small VPS).
Put `DB_PATH` on the persistent volume, set `BASE_URL` to the public HTTPS URL, and set the passwords and `SESSION_SECRET`.
Browsers only allow location sharing over **HTTPS** (or localhost).

With Docker:

```bash
docker build -t winterization .
docker run -p 3000:3000 -v winterization-data:/data --env-file .env winterization
```

Back up the database by copying the file at `DB_PATH` (or use Admin → Export CSV).

## Project layout

```
server/
  index.js      start the HTTP server
  app.js        Express routes (public, staff, admin), CSV export
  service.js    capacity, assignment, routes, queue notifications, rollover
  routing.js    route planner (AM → PM blocks, flexible stops inserted cheaply)
  db.js         SQLite schema (node:sqlite)
  auth.js       password login with signed cookies
  sms.js        Twilio REST client (logs instead when not configured)
  geocode.js    Google Geocoding API
public/         static HTML/CSS/JS, no build step
test/           node:test suites (routing + end-to-end API flow)
```
