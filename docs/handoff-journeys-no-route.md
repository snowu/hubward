# Handoff: "No route" to Work from Calle de Anastro

Status, 2026-10-26: one cause found, fixed and covered by a test on this
branch (PR #44). Nothing here has been checked against live data yet. The
cloud session that wrote the fix could not reach the worker, EMT or GBFS.
This file lists what to check from a machine that can reach them.

## The symptom

At 09:06 on Calle de Anastro the Hakuna card showed the 29 direct, but the
Work card (3.2 km away) showed **No route**. Its BiciMAD row was fine. In
practice four buses reach Work from there:

- **7** direct to a stop near the office (slower, but no change)
- **70** or **107** to Plaza Castilla, then S10 or one of several other lines

## What was found

Since `2714145` the page remembers the batch size (`emt:journey-batch`), so
one `/journeys` request plans **every hub at once**. The planner's budgets are
per request: on the paid tier that is 12 origin stops, 24 routes and 8
transfer boards. Hubs got them **in order**:

- `prioritizeAccessStops` reserved 2 platforms for each line the first hub
  shares with the origin, then each line of the second hub, and so on. Hakuna
  is served by several lines around Anastro, with platforms on both sides of
  the street. Its reservations could fill all 12 slots, so the stops for the
  7, 70 and 107 never had their boards read, and Work got no options.
- `prioritizedRouteCodes` (the `common` list) and the transfer-board pick had
  the same first-hub-first order.

The fix interleaves all three, so hubs take turns. The test
`plan: several hubs in one request` reproduces it: six local lines run to
the first hub and a single 7 runs to the second. Before the fix the second
hub got `[]` when planned after the first and `["7"]` when planned alone.

## Things to test

### 1. Before vs after, with your own request

Capture a real request on the phone or in desktop devtools with location set
to Anastro. From the network panel, copy:

- the `/journeys` request body (origin plus every destination), into
  `body.json`
- the `Authorization: Bearer …` header (your Supabase JWT), into `TOKEN`

Against the **currently deployed** worker (baseline, should reproduce
"No route"):

```bash
W=https://emt-arrivals.zancato-t.workers.dev
curl -s "$W/journeys" -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -H "origin: https://snowu.github.io" \
  --data @body.json > before.json
```

Against **this branch**, without deploying: run `cd api && npm run dev` (needs
a `.dev.vars` with the real secrets), then repeat with
`W=http://localhost:8787` into `after.json`. Then `npm run deploy` once it
looks right.

Compare the two:

```bash
for f in before.json after.json; do echo "== $f"
  jq -r '.destinations[] | "\(.destination.name): " +
    ([.options[] | [.firstLeg.label, .secondLeg.label // empty] | join("→")] | join(", "))' $f
  jq -c '.calls' $f
done
```

**Expected after the fix:** Work lists the 7 (direct, so ranked first) and
probably 70→… / 107→… transfers. Hakuna still lists the 29.

Another quick check is to send the same body with **only** Work in
`destinations` to the old worker. If Work finds the 7 alone but not in the
batch, the batch is confirmed as the cause.

### 2. If Work is still "No route" after the fix

The cause is then something else. Check these in this order, using
`after.json` and the planner code (`api/src/journey-planner.js`):

1. **Is a 7 / 70 / 107 stop among the boards read?** `boards` in the response
   only lists stops behind offered options, so add a temporary `console.log`
   of `liveStopIds` in `plan()` and watch the `npm run dev` output. If none
   of those stops is there, they lost out in `prioritizeAccessStops` or
   `walkingReachable` (the 800 m on-foot gate).
2. **Do the destination stops include the 7's stop?** `nearbyAccess(…, 6)`
   keeps only the **6 nearest** stops to the hub, within the hub's
   `destinationRadiusM` (capped at 800 m by day). If the office is in a dense
   area, the 7's stop may be the 7th nearest. Compare
   `GET /stops/nearby?lat=…&lon=…&radius=700` around Work.
3. **Line code mismatch.** Origin lines come from live arrivals (labels such as
   `"7"`). Destination lines come from area search (codes such as `"007"`).
   `bestDirect` matches on `lineIdentity` (zeros stripped), but
   `routeFor(routes, origin.code)` and `prioritizedRouteCodes` compare raw
   strings. Check that `/lines/7/route` and `/lines/007/route` both answer.
4. **Direction.** `directedSections` needs the origin stop **before** the
   destination stop in the same `toA`/`toB` list. Check the 7's route answer
   for both stop ids.
5. **Transfers (70/107 at Plaza Castilla).** By day the two stops must be
   within 200 m (`DAY_TRANSFER_RADIUS`). The second line's board must also be
   among the transfer boards read and have a live arrival, or the option is
   dropped (`plan()`, the `transferLive` filter).

### 3. Regression checks

- With one hub saved, the plan is unchanged.
- With 3+ hubs the cards still load in the same time (`timings.busesMs`) and
  `calls.arrivals` / `calls.routes` stay within the budgets. The fix
  reorders slots and does not add any.
- At night (00:00–06:00 Madrid time) the night-line reservation still works.
  A hub served only by an N line keeps its slot when another hub has many
  day lines.

## Deploy

The worker is not deployed by CI: `cd api && npm run deploy`. The page needs
no change.
