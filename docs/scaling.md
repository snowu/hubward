# Scaling to 10k daily users

What would have to change for Hubward to serve about 10,000 people a day,
written 2026-10-24 against the code at `80fb898`. Nothing here is planned;
each item needs its own plan before any code.

The Worker architecture already holds: shared Cache API payloads, one
`StopPoller` per stop, one `BikeFeed` for the city, and Durable Objects for
per-user state all grow with *stops*, not with users. What breaks first is
the free third-party services the app leans on, and the decision that every
user brings their own EMT developer account.

## How these numbers were made

The metrics dataset cannot help: it only ever saw one user, so it says nothing
about how traffic overlaps between users, which is what the shared caches and
pollers save. Everything below is estimated from the code (poll intervals,
cache TTLs, how far each request fans out) plus assumed usage:

- 10k daily users, ~3 opens a day, ~4 saved stops each, ~30% with alerts.
- That is roughly **400–600k Worker requests a day** (~15M a month).

The owner's own usage is still worth one thing: it is a heavy single-user
profile. A week of `npm run metrics` multiplied by 10k gives an upper bound
on per-user requests and uncached EMT calls, safer than the guess above.

## 1. What breaks or gets us banned

These hit their limits at 10k users under any realistic usage.

**Every user needs their own MobilityLabs account.** With
`EMT_ACCOUNT = "required"`, nobody sees a live time until they have
registered as an EMT API developer and connected the account. Few of 10k
people will do that; this is the real ceiling, not infra. Register an app
with EMT (`X-ClientId`/`passKey`) and ask for a higher quota. EMT calls grow
with *active stops* (about 4,600 exist), not users, because `arrivals/` is
shared at the edge, so one well-cached app key can carry everyone. Keep
per-user accounts as an optional extra. Check MobilityLabs' terms for
redistribution at this scale first.

**Supabase's built-in email** sends only a few messages an hour, so magic-link
sign-ups simply stop. Configure custom SMTP (Resend, Postmark, SES or
Cloudflare Email Sending) and raise the auth email rate limit.

**Nominatim** (`api/src/index.js`, `geocodeMadrid`): the public instance
allows at most 1 request a second and forbids app-scale use. The 30-day cache
does not help once many people type different queries. Use a paid geocoder
(Geoapify, MapTiler, Stadia) or self-host Photon.

**routing.openstreetmap.de** (`walkingMatrix`): the FOSSGIS demo server is
fair-use only, not a production backend. Self-host OSRM or Valhalla with a
Madrid extract on a small VPS (~€5–10 a month), or use a commercial matrix
API.

**CARTO basemap** (`CARTO_KEY` in `web/app.js`): the free tier is
non-commercial with 5M tiles a month; the comment there plans for ~100k. 10k
users opening the map is on the order of 40–50M a month. Self-host a Madrid
PMTiles extract (Protomaps) on R2, served through a Worker with the Cache
API: close to free, no quota.

**GitHub Pages**: 100 GB a month soft bandwidth limit, ToS not meant for app
hosting, a `max-age=600` we cannot change, and `snowu.github.io` is an origin
shared with other apps (localStorage, push scope, the manifest `id`
workaround). Move `web/` to Cloudflare Workers static assets on a custom
domain, ideally the same origin as the API. That removes CORS, allows
`immutable` hashed assets, and retires the workflow's `sed` cache-buster.
`ALLOWED_ORIGIN` and `API` change together.

## 2. Worker changes

**Stop calling Supabase twice on every cache miss.** `requestEmt()` in
`src/emt-account.js` runs `authenticatedUser()` (a network call to
`/auth/v1/user`) and then `accountRow()` for every connected user's request
that misses the cache. Verify the JWT locally against Supabase's JWKS
(asymmetric signing keys) and cache the sealed credential row in isolate
memory per user for a few minutes. That also avoids Supabase Auth's per-IP
rate limits: all our traffic comes from a few Cloudflare IPs.

**BikeFeed fan-out** (`src/pollers.js`). One singleton Durable Object calls
every bike watcher's `TrackingRunner` every 30 seconds, whether or not
anything changed. At 3k watchers that is ~8.6M DO requests a day from one
object, near the per-invocation subrequest limit. Call only the runners whose
stations' counts changed since the last poll, and shard the feed (for example
by station-id hash).

**StopPoller fan-out.** Same pattern every 2 minutes. Consider evaluating the
alert rules inside the poller and waking a runner only when it has something
to push. Schedules and radius limits already cut this a lot; keep them on by
default.

**Rate limiting and abuse.** Public routes are open, and `PUT /auth/emt` can
be used to test EMT credentials. Add the Workers Rate Limiting binding, keyed
per IP and per user, and Turnstile on the EMT connect form and sign-in.

**Log volume.** One `poll` line per poll is ~1.4M lines a day at 2k active
stops, past the Workers Logs included tier. Sample successful polls; keep
every error.

**RLS form.** `supabase/bike_ratings.sql` uses bare `auth.uid()`. Switch to
`(select auth.uid())` like the other tables so it is not evaluated per row.
The other tables already have the right indexes.

## 3. Infra and operations

- **Plans:** Workers Paid (already on it, per `PLANNER_TIER = "paid"`) and
  Supabase Pro ($25: no pausing, daily backups). The free tier has no
  backups, and at 10k users that matters more than its quota.
- **Staging:** a `[env.staging]` in `wrangler.toml` with its own Supabase
  project, and the worker deployed from CI after `npm test` rather than by
  hand.
- **Load test** staging with k6 before launch, focused on `/journeys` (the
  paid budget can make dozens of requests per call) and `LiveStop` socket
  counts.
- **Monitoring:** error-rate alerts on the Worker and client-side error
  reporting. Today a broken `app.js` is only caught by `check-web.mjs` before
  a push.
- **GDPR:** a privacy policy, self-serve account deletion, and a clear
  statement that encrypted EMT passwords are stored. Holding 10k third-party
  passwords is a liability in itself, another reason to get an EMT app key.

## Rough monthly cost

| Item | Estimate |
| --- | --- |
| Workers Paid + requests + Durable Objects + logs + Analytics Engine | $10–60 (high end if fan-out stays as it is) |
| Supabase Pro | $25 |
| SMTP | $0–20 |
| Self-hosted tiles on R2 | ~$0–15 |
| Routing/geocoding VPS or API | $5–30 |
| **Total** | **~$50–150** |

This reverses the "free plan, cost cannot balloon" decision in `CLAUDE.md`,
so it should be made on purpose.

## Order

1. EMT app key and custom SMTP: both block sign-ups.
2. Replace Nominatim, the OSM routing server and CARTO; move hosting off
   GitHub Pages.
3. The Worker changes, which only matter once 1 and 2 are done.
