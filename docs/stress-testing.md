# Stress testing

How to load-test Hubward for a few thousand people at once, written
2026-10-24 against `7398e8e`. Nothing here exists yet; it is the test
`docs/scaling.md` says to run before launch.

## Why not just aim it at production

Every request that misses the edge cache goes upstream: EMT on real users'
own accounts, the BiciMAD GBFS feed, Photon, Nominatim, the OSM routing
server, and CARTO in the browser. A few thousand simulated users would spend
EMT quota and break those services' fair-use policies, and likely get the app
blocked. The test needs its own copy of the system with every outside service
replaced by a fake.

## 1. Make the outside services swappable

All of them are hardcoded today:

| Service | Where |
| --- | --- |
| EMT | `BASE` in `src/emt.js` |
| BiciMAD feed (GBFS) | `GBFS` in `src/bikes.js` |
| Photon | `/places/geocode` in `src/index.js` |
| Nominatim | geocode fallback and `/places/reverse` in `src/index.js` |
| OSM routing | `walkingMatrix` in `src/index.js` |
| BiciMAD account / MPass | `USERDATA_URL`, `TRIPS_URL`, `LOGIN_URL` in `src/bicimad-account.js` |
| Push services | `sendPush` posts to whatever URL each subscription holds |

Read each from `env` with the current URL as the default
(`env.EMT_BASE ?? BASE`). Production stays unchanged, and the existing tests
cover it.

## 2. A fake upstream worker

A second Worker that answers from `test/fixtures/`, in each service's own
response shape. It needs:

- **Realistic latency**, e.g. 150–600 ms.
- **Injectable failures:** HTTP 525, code 80, code 98 (quota spent) and slow
  answers. Those are the paths that pile up under load.
- **A count of calls per endpoint, per stop and per account.** This is the
  most important output of the whole test.

Push subscriptions for test devices point at it too, so alert delivery can be
timed without a real push service.

## 3. Staging

- `[env.staging]` in `wrangler.toml`: its own KV namespace, Durable Objects,
  metrics dataset and Supabase project, the upstream URLs pointed at the fake,
  and `ALLOWED_ORIGIN` set to whatever the load generator sends.
- **Test users.** Magic links cannot be scripted. Create a few thousand users
  with Supabase's admin API (service-role key, used only in a script, never in
  the worker) and sign each in by password to get a JWT. Supabase rate-limits
  auth, so do this ahead of the test, not during it.
- Give the test users fake EMT accounts the fake upstream accepts, so the
  per-user account path (`requestEmt()`) is exercised too.

## 4. The load script (k6)

k6 does HTTP and WebSockets, can set `Origin`, and can ramp the *arrival rate*
of users rather than a fixed count. Scenarios, weighted roughly like real use:

- **Open the app:** `/auth/config`, `/auth/me`, `/stops`, `/bikes/saved`,
  then `/arrivals` for each saved stop.
- **Leave it open:** `/arrivals` every 20 s (`ARRIVALS_REFRESH_MS`).
- **Map session:** pan through grid cells (`/stops/nearby`), draw a route,
  then hold a `/live` WebSocket for a few minutes.
- **Search and plan:** type into the Go box — one `/places/geocode` per
  prefix, since it searches as you type — then `/journeys`. The planner is the
  most expensive request by far: one call reads many boards plus the city's
  bike counts.
- **Set up alerts:** create watches and register a device. This fills the
  `StopPoller`s and the `BikeFeed`.

**Which stops matters more than how many users.** The shared caches only help
when users overlap, so random stops measure the wrong thing. Use real stop
ids from area search, weighted so a few are very popular (Zipf-like), with
most users in central Madrid. The same goes for search prefixes and planner
origins: the geocode cache key includes a ~1 km position grid.

**Run it from Europe.** The Cache API is per data centre, so load from the US
would test the wrong one. Grafana k6 Cloud in an EU region, or two or three
small VMs in Madrid or Frankfurt. A laptop on WSL cannot sustain thousands of
virtual users.

## 5. What "X thousand at once" means

10k daily users is not 10k at once. Use clusters around rush hour; a fair
model is 5–10% of the day's users active in the busiest 15 minutes, so
500–1,000 at once for 10k a day. Step up to about three times that (3,000),
and add one spike test of everyone opening the app within the same minute.

## 6. What to measure

1. **Fake-upstream calls against users.** EMT calls should grow with active
   stops and level off as users increase. If they grow with users, caching or
   miss coalescing is broken. This is what the test is for.
2. **p95 latency and error rate per route**, from k6.
3. **Durable Objects.** With 3k–5k alert watchers, read the `poll` log lines:
   alarm duration, `failed` counts, and whether pushes arrive on time.
   `BikeFeed` is expected to fail first (see `docs/scaling.md`).
4. **Worker CPU and memory**, profiled on staging, mainly for `/journeys`.
5. **Supabase:** connections and response times on the open-app path, and
   Auth errors while `/auth/v1/user` is still called on every cache miss.

## Cost

Small. 1,000 virtual users for an hour at about one request every 5 s each is
~720k Worker requests: cents on Workers Paid. Durable Object calls for the
alert scenario cost a few dollars at most. Supabase's free tier may slow the
open-app path down, and that is worth knowing too.

## Order

1. Upstream URL overrides and the fake upstream.
2. Staging and test users.
3. k6 smoke test at 50 virtual users, then steps up to 3k.
4. The alert fan-out test on its own.
5. Fix what broke, run it again.
