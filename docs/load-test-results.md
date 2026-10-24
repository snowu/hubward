# Load test results

What the load test (`loadtest/`, plan in `docs/stress-testing.md`) found,
run 2026-10-24 on a laptop (16 cores, WSL2) against a local `wrangler dev`
4.152 with every upstream faked. Raw tables: `loadtest/results/`.

## What carries over and what does not

**The counts carry over.** How many EMT, Supabase, GBFS and push calls a
request causes is decided by the worker's code and caches, and the fake
counts each one. The same requests on Cloudflare make the same calls.

**The latencies do not.** One local workerd process, with k6 and the fake on
the same machine, saturates near 50 requests a second. Response times grow
with local concurrency long before Cloudflare's would, so no latency below
says anything about production except where it shows a failure mode.

**One caveat on caching.** The Cache API is per Cloudflare location and
locally there is one. Madrid traffic mostly lands in one location too, so
this is close; traffic split across locations would miss more.

Setup per level: 400 test users (saved stops drawn Zipf-like towards Sol,
124 with alerts), N concurrent riders ramped over 30 s and held for 3 min,
sessions of ~90 s refreshing every 20 s, fake upstream answering in 150–600 ms.

## 1. A bug: concurrent misses on one stop returned 500s

**Fixed in #41.** When two riders missed the cache on the same stop at once,
the second awaited the first request's promise. Workers ties a promise to the
request that created it; when the first request finished before the second
resumed, the runtime dropped the second's continuation and cancelled it as
hung:

```
✘ Uncaught Error: The Workers runtime canceled this request because it detected that your Worker's code had hung …
Warning: A promise was resolved or rejected from a different request context than the one it was created in.
GET /arrivals 500 Internal Server Error (57ms)
```

Instrumented, every one of those 500s directly followed a coalesced wait on
`arrivals/<stop>`: 12 of 23 coalesced waits died. With one user it can never
happen, which is why it never showed; at 10k users, popular stops at rush hour
are exactly where it happens. The EMT token cache shared logins the same way.

| | failed requests at 50 riders | runtime faults |
| --- | ---: | ---: |
| before (`results/before-fix-50-riders.md`) | 2.25% | 30 hung, 20 cross-request I/O |
| after | 0.00% of 2,390 | 0 |

## 2. EMT calls grow with stops, not riders

`results/2026-10-24T03-53-13.md`, with the fix:

| riders | requests | failed | EMT calls | distinct stops | EMT per stop | EMT per rider-minute |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 2,390 | 0% | 2,749 | 385 | 7.1 | 12.9 |
| 100 | 4,549 | 0% | 4,807 | 590 | 8.1 | 11.3 |
| 200 | 8,328 | 0% | 7,667 | 940 | 8.2 | 9.0 |
| 400 | 12,506 | 3.1% | 9,821 | 1,280 | 7.7 | 5.8 |

Riders ×8, requests ×5.2, EMT calls ×3.6: EMT work follows the number of
distinct stops in use (7–8 calls each per run), and the cost per rider halves.
The shared caches and pollers do what `docs/scaling.md` assumed.

The 3.1% at 400 riders is the laptop, not the worker: every failure was a
timeout (Supabase reads at their 8 s limit, plans at the page's 25 s) with
the local runtime past ~49 requests a second. At 200 riders, 33 a second,
nothing failed.

**Alert polling is flat in riders**: ~214 stop polls and ~500 bike fan-out
calls per level, set by the 124 users with alerts, not by who has the app
open.

## 3. What each action costs upstream

`node loadtest/probe.mjs`, one action at a time with nothing else running
(`results/probe-2026-10-24T03-38-41.md`):

| action | EMT | Supabase | other |
| --- | ---: | ---: | --- |
| Open app (config, me, saved stops/stations, EMT status) | 0 | 5 | |
| Board, cold | 1 | 2 | |
| Board, warm (any user, within 4 s) | 0 | 0 | |
| Stop detail / map cell / line route, cold | 1 | 2 | |
| Bikes nearby + saved, cold | 0 | 0 | 2 GBFS |
| **Plan to 3 Hubs, cold** | **77** | 3 | 1 walking matrix |
| Plan to 3 Hubs, another connected user elsewhere | 54 | 3 | 1 walking matrix |
| Plan, unconnected user | 0 (cached only) | 3 | 1 walking matrix |
| Address search, per prefix typed | 0 | 1 | 1 Photon (cold) |
| Register device + report position (every app open) | 0 | 2 | |
| Live map, 2 viewers on one stop, 20 s | 4 | 4 | |
| Connect EMT account | 1 login | 2 | |

## 4. What the numbers say to change

In order of payoff.

1. **Give cards their own Board cache.** EMT arrivals per arrival asked was
   1.09–1.38 in the sweep: the cards get almost nothing from the cache. Cards
   refresh every 20 s and `arrivals/` lives 4 s (sized for the live map's 5 s
   polling), so a card only hits when another rider asked for the same stop
   in the last 4 seconds. A separate key with ~15–20 s for cards, as the
   Planner already has (`arrivals-plan/`, 30 s), would make popular stops
   cost one EMT call per window instead of one per rider. The live map keeps
   its own 4 s path.
2. **Stop asking Supabase who the caller is on every cold read.** 0.57–0.75
   Supabase Auth calls per request across the sweep, and every cold read costs
   two Supabase calls (identity + the Account row) before its one EMT call.
   Address search pays one per keystroke even when the result is cached.
   Verify the JWT locally and keep the sealed Account row in isolate memory
   for a few minutes (`docs/scaling.md`, section 2).
3. **The Planner is the big EMT spender.** 54–77 EMT calls per cold plan to
   three Hubs, mostly routes (25) and Boards (22). Routes are cached 7 days,
   so a warm city pays mostly Boards; but each first plan of the day costs a
   rider ~77 of their own quota, and it needs Workers Paid (the free plan
   allows 50 subrequests).
4. **Take the city-wide BikeFeed off the request path.** Every `sync()` — on
   every device registration, so on every app open — calls the single
   `BikeFeed` object, even for users with no bike alerts (an empty list
   becomes a `DELETE`). Locally, 50 concurrent syncs all finished together at
   ~1.2 s against 34–90 ms alone. Production Durable Objects are much faster
   than local SQLite, so confirm on staging, but skipping the call when
   nothing changed costs nothing.

## Not covered yet

- Cloudflare itself: real isolate counts, Durable Object throughput, edge
  locations. Needs the staging environment from `docs/stress-testing.md`;
  `k6.js` runs against it unchanged.
- EMT's real behaviour under load: its latency, the intermittent 525s and
  quota answers. The fake can inject both (`--fail525`, `--quota`); a run with
  them is the next one worth doing.
- Push services' real acceptance rates, and the browser: tiles, page weight.

## Harness pitfalls found on the way

- `wrangler dev` 4.125's dev proxy crashed under ~50 concurrent requests
  ("Error inside ProxyWorker"); the harness pins 4.152.
- Running k6 with `execFileSync` beside a piped `wrangler dev` blocked the
  log pipe, wrangler stalled on its own stdout, and the worker with it:
  arrivals p95 read 7.7 s at 50 riders instead of 2.1 s. The orchestrator
  now runs children asynchronously.
