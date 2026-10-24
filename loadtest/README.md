# Load test

Thousands of simulated riders against a local worker, with every outside
service faked, so nothing spends anyone's EMT quota or touches a public
service. The plan behind it is `docs/stress-testing.md`; results and what
they mean are in `docs/load-test-results.md`.

```bash
# once: k6 (a single binary; no sudo needed)
#   https://github.com/grafana/k6/releases → put `k6` on PATH or in ~/.local/bin
cd api && npm install

node loadtest/run.mjs --riders 100,500,1000 --hold 2m
```

`run.mjs` does the whole run. For each level of concurrent riders it starts a
fresh fake upstream and a fresh `wrangler dev --local` (new state directory,
so each level starts cold), seeds the users, runs k6, and reads back what
happened upstream. The table lands in the terminal and in `loadtest/results/`.

| file | what it is |
| --- | --- |
| `world.mjs` | a synthetic Madrid from a fixed seed: 160 lines, ~4,400 stops, 680 bike stations |
| `fake-upstream.mjs` | EMT, GBFS, Photon, Nominatim, OSRM, Supabase Auth + PostgREST and push in one Node process; counts every call (`GET /__stats`) |
| `setup.mjs` | test users (bearer `load-<n>`, saved stops drawn Zipf-like towards Sol, real P-256 push keys) and the worker's env file, in `.load/` |
| `seed.mjs` | connects every user's EMT account and registers alerts, so the pollers run during the test |
| `k6.js` | the riders: open the app, refresh arrivals every 20 s, sometimes map + live socket, plan, search, bikes |
| `run.mjs` | the orchestrator |

The worker reaches the fakes through settings that are unset in production:
`EMT_BASE`, `GBFS_BASE`, `PHOTON_BASE`, `NOMINATIM_BASE`, `ROUTING_BASE`,
`SUPABASE_URL` and `PUSH_SINK`.

## Reading the numbers

**Call counts carry over to production; local latencies do not.** `wrangler
dev` is one workerd process on one machine, with k6 competing for the same
CPU, and every outbound fetch costs it a few milliseconds of serialized
time. Response times therefore grow with local concurrency long before
Cloudflare's would. What the fake upstream counted — EMT calls per stop,
Supabase calls per request, pushes per poll — is decided by the worker's
code and caches, and is the same on the edge.

One exception: Cache API is per Cloudflare location, and locally there is
exactly one. Real Madrid traffic mostly lands in one location too, so this
is close, but traffic split across locations would miss more.

## Options

```
--riders 100,500   concurrent riders per level        [100]
--users N          test users generated               [max riders]
--ramp 30s --hold 2m --session 90                     [30s, 2m, 90 s]
--alerts 0.3       share of users with alerts         [0.3]
--latency 150-600  fake upstream answer time, ms      [150-600]
--fail525 0.02     share of EMT/GBFS answers that 525 [0]
--quota 0.01       share of EMT answers that are 98   [0]
```

k6 alone, against any worker that has the overrides set (a staging deploy,
say): `k6 run -e WORKER=https://… -e RIDERS=500 loadtest/k6.js` after
`node loadtest/setup.mjs --fake https://<fake>` and `node loadtest/seed.mjs
--worker https://…`.
