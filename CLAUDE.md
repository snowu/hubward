# EMT Madrid Arrivals

A personal webpage showing live EMT bus arrival times and BiciMAD dock counts
for a handful of saved stops. Opened from a phone home screen. Single user, not
going to any store.

Design doc: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`.
Implementation plan: `docs/superpowers/plans/2026-08-18-emt-arrivals-web-app.md`.
Domain terms (Hub, Board, Planner, Account) are in `GLOSSARY.md`; architecture
decisions are in `docs/adr/`.

**The app is called Hubward** (after the Discworld direction: towards the
Hub). It was Hubwise until 2026-09-25; internal names keep `hubwise` — the
`x-hubwise-emt` header, notification tags and the metrics dataset. The icon is
drawn in `tools/icons/pixel-icon.mjs`.

**The repo is `hubward`; until 2026-10-16 it was `emt_madrid_widget`** (it
started as an Android home screen widget). The page moved with it, from
`snowu.github.io/emt_madrid_widget/` to `snowu.github.io/hubward/`, and the
old address is gone: a home-screen copy installed before the rename has to be
reinstalled from the new one.

**The manifest `id` is `/hubward/`, path and all.** Every app on
`snowu.github.io` shares one origin, and a manifest `id` resolves against the
origin, not the page: the old `"id": "hubwise"` meant
`https://snowu.github.io/hubwise` wherever the page lived, so after the move
Chrome matched the dead install and refused with "already installed". A
path-scoped id is unique per app (Spritewright uses `/spritewright/` for the
same reason). Changing it makes every installed copy a different app.

## Scope

- **In:** EMT Madrid city buses, and BiciMAD (same MobilityLabs API, same
  token).
- **Out (for now):** Metro, Cercanías, interurbanos. Those are CRTM, a separate
  API with a different stop ID namespace. Don't mix the two without an explicit
  decision — stop IDs are not interchangeable.

## Layout

```
web/                 static page, deployed to GitHub Pages. Holds no secrets.
  index.html         every dialog and view lives here; nothing is templated in JS
  app.js             the whole page (~5.7k lines), one ES module, no framework
  live.js            live-map WebSocket client
  tracking.js        alert watches + push subscription UI
  emt-account.js     connect-your-EMT-account dialog
  directions.js      walking-directions links
  appearance.js      theme + interface style, applied before first paint
  sw.js              service worker: notifications only, no offline cache
  cache.js           localStorage read/write helpers
  trips.js           pure trip identity, ordering and incremental-merge helpers
  style.css          system/light/dark themes, phone-first; no preprocessor
  manifest.webmanifest, icon.svg    home-screen install
api/                 Cloudflare Worker. Holds EMT and optional owner MPass credentials.
  src/index.js       routing, CORS, auth boundaries, every edge-cache decision
  src/journey-planner.js  the Planner: plan() over its sources, budgets, night rules, scoring
  src/emt.js         emtClient (token, code-80 retry, success codes) + bus fetchers
  src/emt-account.js per-user EMT connections; requestEmt() is each request's client
  src/bikes.js       BiciMAD stations + local distance filtering
  src/trip-monitor.js bounded 30-minute owner trip reconciliation monitor
  src/stops.js       Supabase REST for saved bus stops and saved bike stations
  src/errors.js      EmtError kinds → HTTP status
  test/              vitest under workerd, recorded fixtures in test/fixtures/
  wrangler.toml      name, bindings, ALLOWED_ORIGIN, PLANNER_TIER. No secrets.
  vitest.config.js   fake credential bindings for tests
supabase/            bus_stops.sql, bike_stations.sql — run by hand, once
.github/workflows/pages.yml    deploys web/ and stamps the cache-buster
```

Page → worker → (EMT | Supabase). The page never calls EMT or Supabase directly:
browser JS keeps no secrets, and EMT sends no CORS headers.

Deployed: page at `https://snowu.github.io` (the worker's `ALLOWED_ORIGIN`),
worker at `https://emt-arrivals.zancato-t.workers.dev` (the page's `API`).
Both are hardcoded; changing one means changing the other.

## Worker API

Live transport reads are open and share global caches. Saved stops/stations
require a Supabase bearer token for every method; Postgres RLS scopes rows to
that authenticated user.

```
GET    /auth/config                public Supabase URL + publishable/anon key
GET    /auth/me                    current user summary + owner flag
GET    /arrivals?stop=&limit=      limit 1–20, default 2
GET    /live?stop=                 WebSocket (subprotocol "hubwise"): live map boards
GET    /stops                      saved stops (Supabase rows)
POST   /stops                      {stopId, label?}          → 201
PATCH  /stops/:rowId               {label}                    empty label → EMT's name
DELETE /stops/:rowId                                         → 204
GET    /stops/:stopId/detail       name, address, coords, lines
GET    /stops/nearby?lat=&lon=&radius=   radius 50–3000, default 500
GET    /lines/:line/route          both directions: paths + stops
GET    /lines/:line/timetable      service window per day type
GET    /bikes/stations?ids=a,b     all 680, or just the ids asked for
GET    /bikes/nearby?lat=&lon=&radius=&ids=   nearby plus optional saved stations
GET    /bikes/account?refresh=1       cached eligibility; refresh=1 rechecks upstream
GET    /bikes/trips?page=&bike=       owner-only normalized trip history
GET    /bikes/ratings                 current user's bike ratings
PUT    /bikes/ratings/:bikeNumber     {rating: 1..5}
GET    /bikes/saved                favourite stations
POST   /bikes/saved                {stationId, label?}       → 201
PATCH  /bikes/saved/:rowId         {label}
DELETE /bikes/saved/:rowId                                   → 204
```

`:rowId` is the Supabase uuid, not the EMT id — `/stops/:stopId/detail` is the
one route keyed on EMT's number. Errors come back as
`{error: kind, message}` with `user_auth` (401) and `forbidden` (403) for caller
authorization, plus `auth | quota | not_found | upstream` for dependencies.
Upstream auth and upstream failures are 502; quota is 503 until daily reset.

### Cache keys and TTLs

Public transport payloads use the Workers Cache API, which does not consume KV
operations. KV holds shared credentials plus the normalized owner-status cache.
TTLs are declared at the top of `src/index.js`:

| key | storage | TTL | why |
| --- | --- | --- | --- |
| `emt:token` | KV + isolate memory | login expiry − 60s | shared credential, not public data |
| `bicimad:owner-session` | KV + isolate memory | login expiry − 60s | private MPass session, NIF and normalized account status |
| `arrivals/` | Cache API | 4s | supports 5s live-map polling; one full board still serves every view |
| `bikes` | Cache API | 45s | one call serves the whole city, nearby and saved stations |
| `bike-info` | Cache API | 24h | station names and coordinates are nearly static |
| `detail/` | Cache API | 7 days | stops do not move |
| `route/` | Cache API | 7 days | geometry changes when EMT redraws a line |
| `nearby/` | Cache API | 24h | keyed on a ~110m grid (`grid3`); the page asks on a fixed 0.02° grid so every device shares the same keys |
| `timetable/` | Cache API | 24h | changes with the season, not the hour |

`CACHE_VERSION` is currently **v5**. Bump it when a parsed public payload shape
changes so old Cache API objects cannot serve an incompatible response.

## Development

```bash
cd api
npm install
npm test          # web smoke check, then vitest under workerd; 219 tests, no network
npm run check:web # just the browser-load check, on its own
npm run dev       # wrangler dev, needs .dev.vars
npm run deploy    # wrangler deploy
```

The page has no build step: open `web/index.html`, or serve the directory. It
talks to the deployed worker, not a local one, unless you edit `API` in
`app.js`.

**Secrets never go in `wrangler.toml`.** A `[vars]` entry blocks creating a
secret of the same name later. Locally they live in `.dev.vars` (gitignored,
`cp .dev.vars.example .dev.vars`); in production, `wrangler secret put <NAME>`
for each of `EMT_EMAIL`, `EMT_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `OWNER_USER_ID`, plus the optional MPass secrets below.
Tests get fakes from `vitest.config.js`'s miniflare bindings.

**Every user brings their own EMT account, the owner included.** Users connect
their EMT email/password (`/auth/emt`) and EMT calls made for them — including
bus checks for their alerts — use their own quota. With `EMT_ACCOUNT =
"required"` (production) nothing falls back to the shared `EMT_EMAIL` login:
guests and unconnected users get cached payloads but `emt_account` (403) for
anything needing a fresh EMT call, cannot add bus alerts, and are asked to
connect right after signing in. Bike counts need no account (public GBFS). A
stop poller uses only its watchers' connected accounts; a stop nobody
connected for is not polled. `"optional"` allows the shared-login fallback
(the tests default to it). Needs the `EMT_CREDENTIAL_KEY` secret and
`supabase/emt-accounts.sql`; see `docs/emt-account-rollout.md`.

**Tracking is fetched once and shared** (`src/pollers.js`). One `StopPoller`
per tracked bus stop polls arrivals every 2 minutes, and one `BikeFeed` polls
the whole GBFS status every 30 seconds, each on an aligned clock, and call
every subscribed user's `TrackingRunner` with the result (`onBoard` /
`onBikes`). Runners fetch nothing: they hold one user's watches, devices and
alert state, keep their poller subscriptions in step via `sync()` (plus a daily
re-sync alarm), and write storage only when state changes. `sync()` always
sends every poller the whole wanted state, never a diff against what the
runner believes is there: a subscription a poller lost then comes back on the
next app open instead of staying silent until the daily re-sync. A poll drops a
runner that answered "nothing here" only if it did not subscribe again while
the poll was out. Every poll logs one `poll` line, and Workers Logs keeps them
(`[observability]`), so a missed alert can be traced to poll, rule or push
service. A stop poller spends
its watchers' own EMT quotas in turn — one connected watcher per 2-minute
slot — trying the others if the chosen account fails, so one broken
connection never silences everyone else's alerts. The shared login is a last
resort only with `EMT_ACCOUNT = "optional"`.

**A watch can be limited to a radius and a schedule** (`watchStatus()` in
`src/tracking-rules.js`), set by tapping it in the tracking list. Outside
either it is *paused*: `sync()` leaves it out of every poller subscription, so
a stop nobody's schedule covers is not polled at all, and its alert state is
cleared so it restarts from a fresh count rather than reporting what changed
while it slept. The schedule is days plus one window in Madrid time (a window
ending before it starts runs past midnight); the runner's alarm is brought
forward to the next window edge. The radius is measured from the last
position the page reported (`POST /tracking/location`, ~100 m, latest only)
— a web app cannot read location while closed, so this is "where you last
opened the app" and counts for `LOCATION_FRESH` (12 h); a stale position
pauses radius-limited watches. New watches default to 1 km; a watch without
coordinates, or a user who never shared a position, behaves as before.

**Devices that stop opening the app stop costing anything.** Every page load
(and a return to the app after a few hours in the background) re-registers
the device, which stamps its `seenAt`. A device not seen for 5 days
(`DEVICE_PAUSE`) gets no pushes, and a user with no device seen lately drops
out of every poller, so a lost phone or wiped browser stops spending EMT quota
and sending notifications. Opening the app there resumes it; after 30 days
(`DEVICE_FORGET`) the daily re-sync deletes it. Watches belong to the account
and are kept.

The optional `/bikes/account` route first verifies the Supabase user and allows
only `OWNER_USER_ID`. It logs in lazily with the `MPASS_EMAIL`,
`MPASS_PASSWORD`, `MPASS_CLIENT_ID`, `MPASS_PASSKEY`, and `MPASS_DEVICE_ID`
Worker secrets, caching only the resulting token in KV until its reported
expiry. It returns only booleans, the opaque numeric state, and a timestamp—
never PII or upstream identifiers.

Supabase tables are created by hand: paste `supabase/bus_stops.sql` and
`supabase/bike_stations.sql` into the SQL editor, once. The bikes one is
optional — without it the favourites call 502s and the page says so rather than
breaking the section.

**`PLANNER_TIER` sizes hub planning to the Cloudflare plan.** On `"free"` a
Worker invocation may make only 50 subrequests, so the page sends one hub per
`/journeys` request and the planner rations routes, transfer boards and
incident reads. `"paid"` (Workers Paid: 10,000 subrequests) takes every hub in
one request and widens the search — see `PLANNER_BUDGETS` in
`src/journey-planner.js`.
The page learns the batch size from each response's `maxDestinations`, so
flipping the var and redeploying the worker is the whole switch.

**The live map is pushed** (`src/live.js`, `web/live.js`). While the map
shows a route, the page opens one WebSocket per probed stop to that stop's
`LiveStop` object, which fetches the board every 5 seconds for everyone
watching and pushes it to every socket: one EMT call per stop per tick however
many people look. Browsers cannot set socket headers, so the page offers its
sign-in token as a second subprotocol; the worker checks `Origin`, resolves
the viewer's EMT account once, and only echoes `hubwise`. Connected viewers'
quotas are spent in turn; guests may listen but a stop with no connected
viewer is not polled (with `EMT_ACCOUNT = "required"`). Pages close their
sockets when the map is hidden or the tab is backgrounded, and poll
`/arrivals` for any stop whose socket has not delivered lately.

Deploys: pushing to `main` with changes under `web/**` runs the Pages workflow.
The worker is **not** deployed by CI — `npm run deploy` by hand.

## Metrics

Before changing polling intervals, cache TTLs, or journey fan-out, consult the
real EMT usage report:

```bash
cd api
npm run metrics                 # last 24 hours
npm run metrics -- --days 7
```

The command reads the ignored root `.env.metrics`; it needs only a Cloudflare
token scoped to **Account Analytics: Read**. The `hubwise_emt_metrics`
Analytics Engine dataset records two event kinds: `upstream` is every actual
EMT HTTP attempt (retries included), while `edge` records cache hit, miss, and
coalesced application reads. `who` (blob8) says who asked: `guest`,
`connected` or `unconnected` (self-reported by the page in `x-hubwise-emt`),
`signed-in` when the page did not say yet, or `background` for timer-driven
calls such as the pollers; rows written before it existed read `unrecorded`.
No PII, coordinates, credentials, or response bodies are recorded. The owner can view the same aggregates under **Metrics**
in the account menu. Data retention is three months.

`wrangler.toml`'s `compatibility_date` is ahead of the installed runtime, so
tests print a "falling back to 2024-12-30" warning per worker. Expected noise.

## Testing

Recorded EMT fixtures, not live calls — tests shouldn't burn quota. New
fixtures are recorded from a real answer and left in EMT's own shape
(`code`, `data[0].Arrive[]`, capital `D` in `DistanceBus`), with a comment
saying when they were recorded.

Conventions, worth matching:

- `import { env } from "cloudflare:test"` gives real bindings. Reset module-level
  token/session state in `beforeEach`; use unique request keys where a Cache API
  assertion must guarantee a cold miss.
- Upstream is stubbed with `vi.spyOn(globalThis, "fetch")` returning a **fresh
  `Response` per call** — bodies are single-use, and the retry paths call twice.
- `src/index.js` is exercised through `worker.fetch` with
  `createExecutionContext` / `waitOnExecutionContext`, not by importing routes.
- The Planner is the exception: `plan()` is tested directly, with in-memory
  sources (the `world()` helper in `journey-planner.test.js`) and a fixed
  `now`, so night rules are checked at a chosen Madrid hour, not today's.
- Seed `emt:token` in `beforeEach` unless the login path is what is under test;
  otherwise every test needs a login response in its mock.
- A cache test asserts the *second* call makes no upstream request. That is the
  actual contract — not that the value came back.

The Worker routes, auth boundaries, Cache API reuse, concurrent-miss
coalescing, and underlying parsers are covered.

**`tools/check-web.mjs` loads the real page and fails if it throws.** `node
--check` only parses, and cannot see a top-level `const` used before its
declaration, or a listener bound to an id that is not in `index.html` — both
of which take the whole ES module down and leave a blank page. `ac20fe6`
shipped exactly that: syntax-clean, dead on arrival. The check builds a DOM
from `web/index.html` with jsdom, stubs only what a CDN would have supplied
(MapLibre, the Supabase SDK, geolocation, `fetch`), imports `app.js`, and then
asserts every `getElementById` in it resolves against the real HTML.

It runs as `pretest`, so `npm test` covers it, and from `.githooks/pre-push`.
Enable the hook once per clone with `git config core.hooksPath .githooks`;
`--no-verify` skips it.

Two things it does *not* do: it never runs a rendered frame, so layout and CSS
still need a browser, and its jsdom shims (currently `meta.media`) paper over
gaps in the environment only — never over a real fault in the page. The
browser UI otherwise still relies on manual verification rather than DOM
tests.

**A PR that changes the UI carries screenshots.** They live on the one
orphan `screenshots` branch, never on the PR branch, each named
`pr-<number>-<what>.png` (`pr-34-editor-360.png`). Publish with
`tools/pr-screenshot.sh <pr> <image>...`: it commits on top of what the branch
already holds, so earlier PRs' links keep working, and prints raw URLs to put
in a PR comment as `<img src="…" width="320">`. The repo is public, so those
URLs render without sign-in. Take them at 360px wide, in the style the change
was reported in; the page can be served locally for layout, but cannot sign
in (the worker only allows `ALLOWED_ORIGIN`).

## Data source

**EMT MobilityLabs** — https://mobilitylabs.emtmadrid.es
API reference: https://apidocs.emtmadrid.es

Auth flow, all inside the worker:
1. Log in against the auth endpoint to receive an `accessToken`.
2. Token is valid roughly 24h (`tokenSecExpiration` in the login response).
3. Cache it in Worker KV with its expiry and in isolate memory for hot calls.
4. Re-login lazily on an auth-failure code rather than on a timer.

EMT reports failure as a `code` field inside a 200 response, not as an HTTP
status: `01` login ok **and** arrivals-with-no-estimations (empty `Arrive[]`,
e.g. night hours — it is a success there), `89` bad password, `92` no such
user, `98` quota spent; `00` ok (arrivals with data, stop detail), `80` stop
not found / invalid token, `81` no detail record. Handle
both an HTTP error and a 200 carrying an error code.

**Code 80 is ambiguous** — "stop not found" and "your token expired" are the
same code — so `emt.call()` re-logs in once and retries before believing the
stop is bad. Every EMT request goes through an `emtClient(env, {account,
who})`, which owns the token, that retry, the 5xx retry, metrics, and the
codes each endpoint counts as success (`ok`). A new endpoint is a path, its
`ok` codes and a parser: `getArrivals(emt, stopId)` is the model. The Account
travels on the client, never on `env` (ADR 0001).

**Code 81 does not mean the stop is nonexistent.** EMT's detail table has
holes for real stops: stop 30 (Plaza Castilla, lines 107/129/005/070) answers
81 on detail on v1 *and* v2 while arroundxy lists it and arrivals accepts it.
Bogus ids get code 80 with "Bus Stop disabled or not exists" on arrivals.
Validate stop ids against arrivals or arroundxy, never against detail alone.

Versioning: auth is v1; every transport call we make is v2. The docs list
detail under v1 too, but v2 answers identically (verified live 2026-08-23,
stops 1547/28/29), so we don't use it. Some transport endpoints exist under
both but only answer on v2 (`stops/arroundxy/` silently returns "no records"
on v1). When a call comes back empty on principle, try the other version.

Cloudflare↔EMT quirk: outbound TLS from Workers to `openapi.emtmadrid.es`
fails intermittently with HTTP 525 (same class as workerd#776 vs DeepL).
`emtFetch` retries once on any 5xx and passes 4xx straight through — a 4xx is
an answer, not a blip. `emt.call()` sends through it; GBFS reads use it
directly. The token cache means most calls skip login entirely.

Endpoints, verified 2026-08-18 against `fermartv/EMTMadrid`, re-verified live
2026-08-23:

```
Login      GET  v1/mobilitylabs/user/login/     headers: email, password
Arrivals   POST v2/transport/busemtmad/stops/{stop_id}/arrives/
                headers: accessToken
                body:    {stopId, Text_EstimationsRequired_YN: "Y"}
Stop detail GET  v2/transport/busemtmad/stops/{stop_id}/detail/
                headers: accessToken  → data[0].stops[0]:
                {stop, name, postalAddress, geometry.coordinates, dataLine[]}
Area search GET  v2/transport/busemtmad/stops/arroundxy/{lon}/{lat}/{radius}/
                headers: accessToken  → data[]: {stopId, stopName, lines[]}
Line hours GET  v2/transport/busemtmad/lines/{line}/timetable/
                headers: accessToken  → data[]: one row per day type with
                {dayType, dateIni, dateEnd, first/endTimeService A and B}
```

```
Line route GET  v2/transport/busemtmad/lines/{line}/route/
                headers: accessToken  → data:
                {label, line, nameSectionA, nameSectionB,
                 itinerary: {toA, toB}, stops: {toA, toB}}
                stops[] ride along in the same answer: {stopNum, stopName,
                distance} as GeoJSON Points — every stop on the line for free.
```

The itinerary arrives as ~160 one-segment GeoJSON Features per direction, not
one line — they are not guaranteed to join end to end, so keep them as separate
segments and let MapLibre draw the array as one `MultiLineString`. Coordinates come
with 15 decimal places; rounding to 6 (~10cm) roughly halves the payload, which
takes a line from 114KB to about 21KB.

**Every coordinate in this API is GeoJSON `[lon, lat]`** — EMT stop detail,
area search, route geometry, BiciMAD stations. The worker passes them through
in that order and never flips them. MapLibre also takes `[lng, lat]`, so the
page passes them through unflipped too (Leaflet, which the page used before,
wanted `[lat, lon]`). A pin in the sea is a stray flip, every time.

**EMT's own `stroke` is per direction, not per line** (line 27 is `#a95516` out
and `#a9559c` back) and looks procedurally generated rather than branded, so it
is not a line identity. The page derives its own colour per line instead — see
Page behaviour — and uses it for both the drawn route and every label of that
line.

Other line endpoints, verified 2026-08-23 but not used yet:
`lines/{line}/stops/{1|2}/` (ordered stop list + frequency bands),
`lines/info/{yyyymmdd}/` on v1 (index of all 239 lines).
`lines/{line}/` and `lines/{line}/grouproute/` are 404.

**Area search's line records carry only `line`, `label` and `direction`.**
`lineEntry()` is shaped for stop detail, where the service hours are real;
arroundxy has none of them, so serialising its entries through that shape put
`"from":null,"to":null,"dayType":null,"headers":[]` on all 2,673 line entries
of a 3km answer — 130KB of nulls out of 334KB. `areaLine()` drops them and
`roundPair()` cuts the 15-decimal coordinates to 6, taking a 3km answer from
334KB to 189KB. The page caches these by the thousand, so the padding was not
free. Stop *detail* keeps the full shape: there the hours are the point.

**Detail's line list is `dataLine[]`, not the `lines[]` the docs show.** A v2
detail answer has no `lines` key at all, so reading it yields an empty list for
every stop — which is how the page spent a day claiming no stop had any lines.
Each `dataLine` entry is one line for *today's* day type (`dayType` FE/SA/LA)
and carries what the page actually needs:

```
{line: "005", label: "5", direction, headerA, headerB,
 startTime: "07:30", stopTime: "23:30", maxFreq, minFreq}
```

`line` is EMT's internal code, `label` is what the bus is signed with — they
differ (005→5, 070→70, 523→N23, 833→SE833) and arrivals report the *label*.
Area search sends the same pair per line but no hours. A bare code cannot be
turned into a label by trimming zeros; if you only have the code, show it.
`lineEntry()` in `emt.js` normalises both shapes — detail objects and area
search's bare codes — into one record, and `normaliseLine()` in `app.js`
additionally tolerates the string-only shape older devices cached.

`startTime`/`stopTime` are the answer to "how can nothing be due?" — at 02:00 a
Plaza Castilla bay running 07:30–23:45 is correctly empty, not broken.

For a stop EMT has no detail record for, the same answer comes from the line:
`lines/{line}/timetable/` is keyed on the codes area search hands back. Three
traps in that response:

- **The times are datetimes, and the dates matter.** "16/08/2026 23:40" →
  "17/08/2026 5:45" is a night line crossing midnight. Compare instants, not
  clocks, or a Friday-night line running 04:40 → 06:15 *the next morning* reads
  as a 95-minute window. `serviceWindow()` reads `overnight` off the dates for
  exactly this reason.
- **Day types are LA (weekday), SA, FE (Sunday/holiday) and V** — Friday
  nights, which only night lines carry. A line with no row for today does not
  run today: line 833 (signed SE833) is weekdays-only, so on a Sunday its
  absence is the answer.
- **`lines/{line}/info/{date}/` ignores the date** for day-type selection — it
  returns all day types with a fixed `dateRef`. Pick the row yourself, using
  the `dayType` EMT stamps on stop detail (its own calendar, holidays
  included) rather than deriving one from the weekday.

Line hours are the whole line's first and last bus across both directions, so
they can be wider than the stop's own — the page marks borrowed hours with a
`*` rather than passing them off as stop-specific.

`estimateArrive = 888888` is EMT's "running on schedule, no GPS estimate yet"
sentinel, not a real countdown. **`999999` is a second sentinel**, marking a
vehicle's *next* run: EMT repeats the same `bus` id and the same
`geometry.coordinates`, but pairs them with a `DistanceBus` for a trip that has
not started. Observed at stop 30, 2026-08-25 — vehicle 2464 listed as both
349s/407m and 999999s/12567m. The two rows collide on the vehicle id, so
anything keyed on it must take the row that is counting down; the other says
nothing about where the bus is now. Treat anything a day or more out as "not a
countdown" rather than special-casing each number.

Arrivals live at `data[0].Arrive[]`. Per bus:
- `line` — line number (string)
- `estimateArrive` — seconds until arrival
- `DistanceBus` — metres **along the route** to the stop (capital D)

Also present: `bus`, `destination`, `geometry.coordinates`, `isHead`.

`StopInfo[]` in the arrivals answer is always empty — with estimations and
without. It is not a way to learn about a stop.

**An arrival says nothing about which way the bus is going.** There is no
direction field, and `destination` is the abbreviation the bus is signed with,
never the route's own `nameSectionA`/`nameSectionB`: "EMBAJADORES" against
"GLORIETA DE EMBAJADORES", "PLAZA CASTILLA" against "PLAZA DE CASTILLA".
Comparing the two strings for equality matches nothing at all. The direction
is recovered from the stop instead — `stops.toA`/`stops.toB` in the route
answer barely overlap (line 27: 27 and 28 stops, 2 in common), so the stop the
estimate came from names the direction outright for almost every bus; the
signed destination, compared as a token subset, covers the shared ones.
Position is *not* a usable fallback: both directions share carriageways, so
"which path is nearer" is polyline sampling noise.

**`DistanceBus` is the only position that moves.** EMT sends two per arrival
and they are not equally useful. `geometry.coordinates` is a GPS fix that can
sit unchanged for minutes and then jump a kilometre; `DistanceBus` counts down
on every poll. Measured on line 27, 2026-08-25: across 48 seconds one bus's fix
did not change for 43 of them and then moved 1.1km, while its `DistanceBus`
went 3137 → 2957m in steady steps; a mid-route bus stepped 2–4m per 5s poll
with its fix frozen throughout. Once a fix does land, the along-track distance
from it to the stop agrees with `DistanceBus` to within ~85m — the two describe
the same thing and only one of them is current.

So the page places a bus at `stopProgress − DistanceBus` along the compiled
route instead of snapping the fix onto it. Animating the fix is what made buses
sprint to a point and then sit still. `DistanceBus` is not strictly monotonic —
a re-estimate can push a bus back ~25m — but the steps stay small enough to
animate honestly, and a correction beyond 400m is treated as a re-lock and
snapped rather than raced.

**Negative progress means the bus is on the other leg.** A line's two
directions form a loop, so a bus reported 4.9km from a stop that sits 209m
along its direction has not joined that leg yet — it is still finishing the
other one. It is not drawn at all, rather than drawn several kilometres up the
right line in the wrong street.

The worker parses and caches **every** arrival EMT sent, sorted soonest-first,
and `limit` only trims what one caller gets. The card (2) and the stop sheet
(8) therefore share a single fetch.

Quota: ~20,000 calls/day on the generic login. If it ever binds, register an app
in MobilityLabs for a dedicated `X-ClientId` / `passKey` pair.

Attribution: EMT asks that MobilityLabs be credited as the data source.

## BiciMAD

**Counts come from PBSC's own GBFS feed, not MobilityLabs.** PBSC operates
BiciMAD and publishes the system feed at
`https://madrid.publicbikesystem.net/customer/ube/gbfs/v1/en/` — no auth, no
CORS headers (so the worker proxies it), 30s TTL:

```
station_information  names, addresses, lat/lon, capacity, short_name
station_status       num_bikes_available, num_bikes_disabled, num_docks_*,
                     is_renting, is_returning, is_installed, status
system_information   679 stations, 8942 ebikes, 0 mechanical
system_pricing_plans EMPTY — plans: []. No fares here.
```

PBSC currently publishes neither `vehicle_status` nor the legacy
`free_bike_status` for Madrid (both paths return 404), so the public surface
cannot map individual bike ids to their present station. MobilityLabs'
`bikesGo` is empty as well. Trip history can score a known bike id, but cannot
locate it; ranking bikes within a station requires a legitimate customer-app
station-detail response that actually contains those ids.

**MobilityLabs' `dock_bikes` counts bikes that are docked, not bikes you can
rent.** Measured 2026-08-23: the two disagree on **227 of 680 stations**, and
859 bikes city-wide are flagged `num_bikes_disabled`. Metro Callao read 5 bikes
on MobilityLabs and 0 rentable on GBFS. Station ids are the same namespace in
both, so the feeds merge on `station_id`. GBFS is the source; MobilityLabs
stands in when it is unreachable, and the page says so, because its counts are
the rougher kind.

GBFS is a *publication* spec: it has no write operations at all, by design.

The MobilityLabs BiciMAD endpoints, kept as the fallback:

```
Stations GET v2/transport/bicimad/stations/          → 680 stations, one call
Near     GET v2/transport/bicimad/stations/arroundxy/{lon}/{lat}/{radius}/
Station  GET v1/transport/bicimad/stations/{id}/
```

Per station: `id` (EMT's key) and `number` (what is painted on it — they
differ, 1409 is signed "5"), `name`, `address`, `geometry`, `dock_bikes`,
`free_bases`, `total_bases`, `reservations_count`, `light` (0 green / 1 amber /
2 red / 3 black), `no_available` (out of service), `overflow`,
`tipo_estacionPBSC` (FIXED, one VIRTUAL), `bikesGo` (empty everywhere so far).

All stations arrive in one answer, so the worker fetches the whole city at
most once per 45-second edge-cache window and slices it locally — `arroundxy`
is never needed, and an area query usually costs no upstream call at all.
`stationsNear()` filters by an equirectangular
distance, which over a few km in Madrid is accurate to centimetres and far
cheaper than haversine per station. `parseStation()` trims EMT's record to
about a fifth of its size (318KB → ~60KB for the city) and inverts
`no_available` into `inService`, so the page reads the field the way it renders
it. Counts move constantly: the Cache API's 45-second TTL is the freshness
contract, and every rendering carries its age.

**Public transport endpoints do not expose subscriber accounts.** A sweep of
MobilityLabs' transport families found stations but no customer account data.
Its login is an API-developer account (`nameApp: OPENAPI MobilityLabs`, quota),
not a BiciMAD subscription. PBSC's `madrid.publicbikesystem.net/customer/*`
paths are also not what the current BiciMAD app uses for account features.

**Per-user state lives in EMT MPass/EMTPay (mapped from the published Android
app 5.8.8 on 2026-08-23).** The current app uses:

```
GET https://apiemtpay.emtmadrid.es/v2/bicimad/userdata/
    NM_STATE, IT_STATUS, DS_BALANCE, contracts and access media
GET https://apiemtpay.emtmadrid.es/v2/bicimad/trips/
    start/end time, trip cost, old/new balance, bonuses and penalties
GET https://api.mpass.mobi/v1/core/identity/whoami
GET https://api.mpass.mobi/v3/transportcard/list/0
```

The APK also contains live v3/v4 userdata variants. All are authenticated with
a legitimate MPass `accessToken`, user id and device/app headers; trips also
need NIF and the BiciMAD session id. The MPass media-state enum is
`INACTIVO=1`, `ACTIVO=2`, `BLOQUEADO=3`, `PENDIENTE=4`, `SIN_USUARIO=5`, but
those values describe an access medium and must not be assumed to equal
`NM_STATE`. Exact user-state labels require observing the account holder's real
response.

The official customer operation at
`apiemtpay.emtmadrid.es/v1/bicimad/booking/` reserves a **dock/base at a
station** (POST; DELETE cancels). It does not lock a particular bike. PBSC's
Comet frontend has temporary bike-lock operations, but those are fleet-operator
controls and are not customer features.

The older `mpass.mobi` portal additionally references account, linked-card and
debt views through `maas.emtmadrid.es:8243`, but its bundled application key
has rotated. Do not bypass either application or user authentication. The
account owner has approved read-only investigation; use their normally issued
session, never copy embedded app credentials into this repo, and never invoke
write endpoints while researching. Full findings and response fields are in
`docs/bicimad-account-api-research.md`; `tools/bicimad-account.mjs` is the
GET-only probe.

The captured trips request exposes only `page`; no date, cursor or `since`
parameter has been observed. The browser therefore persists normalized trips
per signed-in user and performs overlap-based incremental sync: newest-first
feeds start at page 0 and stop on a known trip; an oldest-first ordering resumes
from the previous final page. A manual Refresh repeats that sync.

A `*/30 * * * *` Cron Trigger polls only trip page 0 while the app is closed.
One KV key holds the latest normalized page and at most four field-delta
revisions per trip. Revisions disappear after 48 hours without another change;
raw EMTPay payloads, credentials and identity fields are never stored. The
owner-only `/bikes/trip-diagnostics` route supplies these revisions to the
existing trip cards.

Aggregate usage *is* available separately: datos.madrid.es publishes
anonymised BiciMAD trips 2017-2023 and station status by day/hour.

## Architecture decisions

**Minimal backend, holding only secrets.** The worker exists because a public
page cannot hold credentials and cannot call EMT directly (CORS). It forwards
requests and retains shared login state, normalized owner status, and one
bounded normalized trip-monitor snapshot; raw account payloads never enter a
cache or browser response.

**Cloudflare Workers, free plan, no card attached.** Past the daily limit the
free plan rejects requests rather than billing. Cost cannot balloon.

**Supabase Auth + RLS for saved data.** Users enter no app password: Supabase
sends an email magic link. The page sends the resulting JWT to the Worker; the
Worker forwards it to PostgREST with the publishable/anon project key. RLS
compares `auth.uid()` with each row's `user_id`, providing the actual tenant
boundary even if a route filter is missed.

**localStorage is a cache, not shared state.** Public arrival/detail/count data
is shared locally. Saved-stop, favourite-station, owner-status and normalized
trip-history caches are namespaced by Supabase user id so two people using one
browser never see each other's data. EMT/Supabase remain authoritative;
`cache.js` only provides last-known and incremental-sync state.

**Stop IDs are typed in by hand.** No GTFS index; build that pipeline only if
hand-entry becomes annoying. (The map's nearby search has since made this
mostly moot for discovery.)

**Personal reads and writes are authenticated.** The page sends its Supabase
JWT, and Postgres RLS authorizes the row. Public transport reads stay open so
all users share the same upstream cache.

**No framework, no build step, no bundler.** `app.js` is one ES module
importing a few small siblings. MapLibre GL and Supabase Auth come from CDN
`<script>` tags.
Every dialog and control is already in `index.html`; JS fills them rather than
templating. Keeping it that way is why a deploy is "copy `web/` to Pages".

## Page behaviour

Two sections — Buses and BiciMAD — behind a top menu, each with a List and a
Map view. The section menu swaps the title, the FAB (add stop) for the locate
button, and which pair of panes is visible.

Two arrivals per stop: the next bus and the fallback if you miss it.

1. **Local countdown.** A 1s interval re-renders so `estimateArrive` and every
   "updated N ago" tick between fetches instead of freezing. It refetches
   nothing.
2. **Staleness marker.** Every rendering of arrival or bike data carries
   "updated N ago".
3. **An empty board says when the first bus is.** "Nothing due" is the true
   answer at 04:00 but it is not a useful one, and it makes one stop look
   broken next to another that has night buses. Where nothing is due, the card
   shows the first departure of the day and the wait — computed from the same
   service windows the sheet lists, borrowing the line's hours for stops EMT
   has no detail record for. If a line *should* be running now, the text stays
   "No buses due right now": EMT having no estimate is a different thing from
   the stop being asleep, and promising a 07:00 first bus at 09:00 would be a
   lie.
4. **Never render empty.** Show last-known data from localStorage rather than a
   spinner or blank — `render()` runs before `loadStops()` on boot. A stale
   number beats a spinner, but only ever with its age attached.
5. **Add/remove stops in the page**, since the phone is the device that has this
   problem. A TUI was considered and dropped: it would run on the laptop, which
   is exactly where you are not when you want to add a stop.

Refresh: on load, on `visibilitychange` back to visible (exactly when the data
is most stale), and manually per-card or all at once.

6. **Tap a card to open the stop.** The sheet holds a small map of where it is,
   the full arrival board rather than the card's two, the lines with today's
   hours, and an editable name. An empty name hands the title back to EMT's.
7. **Heal detail-less stops from area search.** A stop EMT has no detail record
   for (code 81) has no name, lines or coordinates of its own. arroundxy knows
   all three, so on load the page searches around each saved stop it *can*
   place and fills in the blind ones — stops cluster, so a Plaza Castilla bay
   is healed by the bay next to it. Results are cached in the worker for a day,
   so this costs close to nothing.
8. **Line routes on the map, one direction per tap.** Every line in a map
   popup is a chip; tapping draws the direction *that stop* serves and tapping
   again removes it. The legend chip names where the direction ends up
   ("70 → ALSACIA"), which is what tells two chips of one line apart.
   `shownRoutes` is keyed `lineIdentity:direction`, so asking for the other
   direction as well is allowed — it just is never what a single tap does.
   Only the same direction of the same line is deduplicated, which is what
   keeps EMT's two spellings (070/70) from drawing one route twice. Nothing
   *automatically* draws both: they run along the same streets, so an
   unrequested second direction only hides the first.
   Arrowheads along the path give the heading — solid versus dashed is not
   legible at the zoom a phone map sits at. The polylines are
   `interactive: false`: a route running through a stop must not swallow taps
   meant for the pin. With both directions up, a bus whose own direction cannot
   be resolved is not drawn at all: there would be two opposite paths to guess
   between.
9. **Stops en route come free.** The route answer already carries every stop
   the line calls at, so drawing them costs no extra request. They are drawn as
   dots in the line's colour for the direction on screen, skipping saved stops,
   which have their own pin.
10. **Times before you save a stop.** An unsaved stop's popup shows its live
   arrivals, so you can tell whether it is the right side of the road before
   adding it. Those arrivals stay in memory — localStorage is the cache for
   stops you actually keep.
11. **Bikes are counts, not countdowns.** A station card shows rentable bikes
   over total station capacity, lists disabled bikes separately, marks
   out-of-service stations,
   and carries the age of the whole city fetch. The locate button asks for
   geolocation and recentres; without it the map falls back to Puerta del Sol.
   Saved stations are optional — if `bike_stations` was never created, the page
   says so once and the rest of the section still works.

12. **Bus stop search range follows Madrid's clock.** By day, 800m: there is a
   bus, metro or bike within 300–500m of anywhere in the city and every stop is
   served often enough that the nearest one wins, so looking wider only offers a
   longer walk to the same bus. From 00:00 to 06:00 the day lines have stopped,
   the network is night lines only and the arithmetic inverts — a 25-minute walk
   can beat a 40-minute wait — so journey origins and destinations search 2km
   instead. The window opens at midnight, not 23:00: at 23:00 most day lines are
   still running. `isNight()` handles both a wrapping and a non-wrapping window,
   because with `NIGHT_FROM_HOUR = 0` the bare `||` it used to have is true at
   every hour of the day. **Bus stops only.** BiciMAD keeps a fixed 700m at
   every hour: docks do not thin out overnight, and there are often more bikes free then. The hour comes from
   `Intl.DateTimeFormat` on `Europe/Madrid`, never a UTC offset, because the
   rule is about the city's service and has to survive DST.

   **The gate is applied to the distance actually walked.** The radius is a
   straight line and feet follow streets; around Arturo Soria that ratio is
   close to 2:1 — stop 2030 is 609m across the map and 1260m on foot. An 800m
   search was therefore offering boardings 1256m away, which is not the deal
   the radius makes. The pedestrian matrix now routes the 25 nearest
   candidates *before* `prioritizeAccessStops` chooses among them, so a stop
   that is out of range loses its slot instead of taking one and then being
   discarded — same single matrix call it always cost. `walkingReachable()`
   never filters down to nothing: in a sparse corner every stop can route past
   the gate, and an honest long walk beats "No route", so below
   `JOURNEY_MIN_ORIGIN_STOPS` it simply takes the nearest on foot. Stops the
   router had no distance for keep their place, and if the router is down the
   gate falls back to the straight-line radius.

   The walk at the *destination* end is still straight-line, so a hub behind a
   motorway reads as closer than it walks.

   **A direct ride outranks every transfer, whatever the clock says.** A
   transfer is a second fare — about €0.70 without a subscription — and
   getting off, walking and waiting again is worse than staying on a bus
   already going where you are going, even when it arrives a few minutes
   sooner. No Madrid ride is long enough for that to backfire badly: by day a
   leg is 15–20 minutes, and at night the wider search radius is what buys the
   choice instead. `compareJourneyOptions()` is that order — transfers last,
   then incidents, then time — and it is a *preference*, not a measurement, so
   it lives beside the estimator rather than inside it.

   Ranking uses `rankJourneySeconds()`, not the predicted arrival: walking is
   weighted `WALK_AVERSION` (1.6×) above riding, because ranking on raw
   arrival recommends a stop 300m further to save two minutes, which is not a
   trade anyone makes. `estimatedSeconds` stays the honest prediction and is
   what the card shows.

   **Direct rides are never cut for transfers.** `planJourney` scores a
   candidate as walking metres plus 420 per stop ridden, then keeps the best
   `limit` (8). That heuristic decides what survives to the caller's *real*
   ranking by live arrival times — so anything it cuts is never timed at all.
   A direct ride is always rankable there, because its boarding stop's board
   was already read; a transfer needs a second board that only
   `transferChecks()` of them get, so most are unrankable and sort last
   anyway. Sorting both kinds in one pool let six untimeable transfers take
   the slots the 29 at Arturo Soria needed — 431m from the door and direct,
   cut at rank 9 of 8 for having a longer ride, while the winner boarded 670m
   away and left 14 minutes later. Directs are now emitted ahead of transfers.

   The **transfer radius** moves with it: 200m by day, 600m at night. Two
   stops only count as one interchange if they are within that distance, and
   at night the numbers are concrete — the closest N1 stop to any S10 stop is
   496m (República Argentina to Nuevos Ministerios). A 200m gate rejects that
   pairing, which is the one Google offers first for a 01:00 crossing, and the
   hub then reports "No route" while four options exist.
13. **Live buses only for a route you asked to see.** A vehicle's position
   rides along in every arrival, so buses can be drawn on the map for free —
   but only where the page already knows the path they run on. Selecting a
   line direction turns them on for that line and that direction alone;
   clearing the route removes them and stops the polling. Showing every
   visible line at once was tried and abandoned: the geometry fetches alone
   made the map unusable.
14. **Buses are placed by distance, not by their GPS fix**, and glide between
   polls along the compiled path — see the arrivals notes above for why the fix
   is unusable. Heading comes from the path's own tangent, since two fixes
   minutes apart say nothing about which way a bus points.
15. **A bus popup answers "where is it going".** Destination leads, because
   that is the question. Then the stop this estimate belongs to — the stop the
   route was opened from, so the one you are standing at — with a ticking
   countdown and the metres left to run. The vehicle number is an EMT fleet id
   and means nothing to a passenger; it survives only because it is the one
   way to tell two buses of a line apart, and it sits at the bottom, muted.
   There is no "show route" button: a bus is only ever visible *because* its
   route is drawn, so that button could only ever hide what it offered.
16. **Routes are reachable from the cards, not just the map.** A saved stop
   card draws every line *running* at that stop, each in the direction that
   stop serves; a hub card draws the legs of the journey it is recommending,
   whose lines and `toA`/`toB` directions the planner already resolved. The
   map's ≈ control does the same for the nearest saved stops
   (`NEAREST_STOPS_SHOWN`, currently 5) and remembers what it drew, so turning
   it off leaves anything picked by hand alone.

   Only lines with a bus on the board are drawn: a stop's line list is what it
   *serves*, the board is what is *running*, and at 22:40 those differ enough
   that drawing five routes for one bus shows nothing. `dueLinesAt()` is that
   filter.

   The whole set of lines at one stop costs **one** arrivals call — probe stops
   dedupe through a Set, every line anchored there resolves to that same stop,
   and its board already lists all of them. Geometry is fetched one line at a
   time; that is about responsiveness, not quota, since twenty parallel route
   requests stall the map while they land. `toggleRoute` flips a direction,
   `ensureRoute` only ever draws, and `applyRoute` is the shared body.
17. **Nearby stops are cached by grid cell, not fetched as a disc.** A disc
   around the map centre covers a shrinking slice of the viewport as you zoom
   out, and re-centring replaced the whole set — so pins jumped and blinked
   out while panning. The page instead tiles a fixed 0.02° grid (2226m of
   latitude by 1694m of longitude in Madrid, so a 1398m half-diagonal that one
   call at radius 1400 covers exactly), keeps only the stops belonging to each
   cell so the union double-counts nothing, and caches each cell in its own
   localStorage entry for 24h. A dense central cell is ~124 stops ≈ 29KB;
   forty cells are kept, oldest evicted first. Pins are added and removed one
   at a time rather than by clearing the layer.
18. **Below zoom 14 there are no nearby pins at all.** The viewport is then
   several cells across and thousands of dots wide, which is neither useful
   nor cheap. Saved stops and drawn routes are unaffected.
19. **One probe stop per displayed direction, every 5s.** A stop's arrivals
   only ever describe buses still heading *for* it, so polling the stop the
   route was opened from is exactly "what is coming to me" — buses already
   past it are somebody else's problem. Cycling to the other direction reuses
   that stop's nearest counterpart across the street. One stop at 5s is about
   720 calls an hour of map-open time against a 20,000/day quota. Probe stops
   are not saved stops and must never reach `writeArrivalCache`.

20. **One board per stop, whoever fetched it.** `arrivals` in `app.js` is the
   page's only arrival store: saved stops, unsaved map previews, route probes
   and the boards `/journeys` planned on (it returns them as `boards`) all go
   through `putBoard()`, which keeps the newer `fetchedAt` and re-renders every
   view once. Cards, hub cards, the stop sheet, popups and live buses read it,
   so opening a stop from a hub card shows the same times, and a refresh
   anywhere moves them all. Hub cards re-pick their catchable bus from that
   board (`firstLegTimes()`, mirroring the planner's `nextDeparture()`); the
   planner's snapshot is only a fallback. Don't add a second copy of a board.

21. **Go anywhere, not only to hubs.** The Hubward tab opens with a search
   box (`#go-form`, geocoded by `/places/geocode`). The place picked becomes
   a one-off destination, `goPlace` (id `go`), planned by the same `/journeys`
   call as the hubs and drawn as the first card; "Save as hub" opens the hub
   editor prefilled. It is kept per user in localStorage for 12 hours, so the
   card is still there when you look again at the next corner.

   **The box searches as you type** (300ms pause, 3+ letters; a slower answer
   to an older prefix is dropped), and Go/Enter takes the top result once it
   is showing. `/places/geocode` asks **Photon** first: it matches prefixes
   and forgives typos ("calle alcal"), where Nominatim, a whole-word address
   parser, found nothing until a name was typed in full. Nominatim answers
   only when Photon is down or empty. Street-sign abbreviations (`c/`, `avda`,
   `pza`, `pº`, `gta`, `ctra`) are spelled out first, and results are biased to
   the rider's position rounded to ~1km, which is also part of the cache key
   (`geocode-v2/`, 30 days) — every prefix typed is a request, so the edge
   cache is what keeps both public services' fair-use limits comfortable.

   **Or press and hold the map** (right-click on a desktop): a "Dropped pin"
   popup offers "Go here", which sets the same destination, switches to the
   list and leaves a pin on the map. MapLibre has no long-press event, so
   `bindGoHere()` times its touch events (550ms, cancelled by 10px of movement
   or a second finger, ignored on pins and popups) and swallows the lift that
   ends the press — a browser may turn it into a click, and a map click closes
   the popup just opened. The card is named after the fact by
   `GET /places/reverse` (Nominatim, ~11m grid, cached 30 days) without
   re-planning.

   **Every destination card also offers BiciMAD and walking.** The Planner
   reads the city's bike counts once per plan (the same 45s `bikes` cache as
   the BiciMAD section, under a 4s deadline: bikes only ever add an option)
   and returns `bike` and `walk` beside each destination's bus `options`.
   `planBikeRide()` tries the four best stations renting near you against the
   four best accepting returns near the destination (700m, like the BiciMAD
   section), passing over one down to its last two bikes or docks unless it is
   150m closer, and drops rides under 500m. Times are straight lines ×1.3 for
   streets, 4.2 m/s in the saddle and two minutes to unlock and dock — a
   comparison figure, which is why those rows show door-to-door minutes rather
   than a countdown. Walking is shown up to 3km. Every row, buses included,
   ends "there by HH:MM" so the three can be compared at a glance.

Cached payload shapes are versioned in the worker's Cache API keys (`CACHE_VERSION`).
Bump it when a parsed shape changes, or week-old detail entries keep serving
the old one.

Line colour is derived from the line code by FNV-1a, quantised into 24 hues
with lightness and saturation each picked by a hash bit. A free-running hue put
5 and 107 five degrees apart — colliding outright is fine, looking
almost-the-same on a card listing six lines is not. (The docstring above
`lineColor` still says "golden-angle rotation"; the code has been FNV-1a since,
and the comment inside the function is the accurate one.)
The same colour is used for the line's label on a card, its chip in a popup,
its route polyline and its en-route dots: same line, same colour, everywhere.

**GitHub Pages sends `max-age=600` on every asset and gives no way to change
it**, so a phone keeps running the old `app.js` after a deploy — a home-screen
one for longer. The Pages workflow stamps the commit sha onto each local asset
URL (`app.js?v=…`, including the `./cache.js` import inside it) so every deploy
is a new URL. If a change seems not to have shipped, check that stamp first.
The `sed` in that workflow matches asset names literally — **adding a new file
to `web/` means adding it to the workflow's pattern**, or it deploys uncached.

## Reference

Supabase Auth issues the browser session; PostgREST evaluates the user JWT
against the per-table RLS policies. `supabase/migrate_multi_user.sql` converts
the original owner-only tables without discarding existing rows.

`fermartv/emt_madrid` (Home Assistant integration) and `fermartv/EMTMadrid`
(Python wrapper) are useful references for the auth handshake and response
shapes.
