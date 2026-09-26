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
| `ADDRESS_SUFFIX` | Added to addresses before geocoding, e.g. `Plymouth, MN 55446`, so "123 Main St" lands in the neighborhood |
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

## Deploying on Railway

The repo includes `railway.json`, so Railway builds from the `Dockerfile`, runs one instance, and health-checks `/healthz`.

1. **Create the service.** In [Railway](https://railway.com): **New Project → Deploy from GitHub repo**, then pick
   `Terra-Vista-Irrigation-Winterization`. The first deploy will fail until step 3 is done. That's expected.
2. **Attach a volume** (this keeps sign-ups across redeploys). Right-click the service (or use the command palette)
   → **Attach Volume**, and set the mount path to `/data`. The app finds it automatically through Railway's
   `RAILWAY_VOLUME_MOUNT_PATH`, so you don't need to set `DB_PATH`.
3. **Add variables** (service → **Variables**). Required:
   - `ADMIN_PASSWORD`, `TECH_PASSWORD`. The app refuses to start on Railway with the defaults.
   - `SESSION_SECRET`: any long random string, so staff stay logged in across deploys.

   Recommended:
   - `ADDRESS_SUFFIX`, e.g. `Plymouth, MN 55446`
   - `GOOGLE_MAPS_API_KEY` (and optionally `GOOGLE_MAPS_SERVER_KEY`, `GOOGLE_MAPS_MAP_ID`)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
4. **Get a web address.** Service → **Settings → Networking → Generate Domain** (or add your own domain). Links in texts
   use this domain automatically. Set `BASE_URL` only if you use a custom domain.
5. **Point Google at it.** If your Maps key is restricted to HTTP referrers, add `https://<your-domain>/*`.

Pushing to the connected branch redeploys automatically. To back up, use Admin → Export CSV, or download the database
file from the volume.

Keep it at **one replica**. The app uses a single SQLite file, and more than one instance would split the data.

### Other hosts / Docker

Any host that runs Node 22.13+ with a persistent disk works. Put `DB_PATH` on that disk, set `BASE_URL` to the public
HTTPS URL, and set the passwords and `SESSION_SECRET`. Browsers only allow location sharing over **HTTPS** (or localhost).

```bash
docker build -t winterization .
docker run -p 3000:3000 -v winterization-data:/app/data --env-file .env winterization
```

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
