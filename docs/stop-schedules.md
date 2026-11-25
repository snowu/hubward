# Scheduled times at a stop

Question (2026-11-25): can we show when buses are *supposed* to pass a stop,
not only the live estimates?

## What the endpoints we already call carry

| source | scheduled data | per stop? |
| --- | --- | --- |
| `stops/{id}/arrives/` | none — live estimates only; `888888` means "on schedule, no GPS", with no time attached | — |
| `stops/{id}/detail/` → `dataLine[]` | `startTime`, `stopTime`, `minFreq`, `maxFreq` (minutes) for today's day type | **yes** |
| `lines/{line}/timetable/` | first/last departure per header (A/B) per day type | no — whole line |
| `lines/{line}/stops/{1\|2}/` | ordered stop list + frequency bands (verified 2026-08-23, not used; no fixture yet) | no — per line, per time band |
| `lines/{line}/route/` | `distance` along the route per stop | geometry only |

So the answer is a **headway, not a timetable**: "every 18–33 minutes,
07:30–23:30". EMT schedules its city lines by interval, and the API publishes
that promise rather than departure clocks. That is what
`GET /stops/:stopId/schedule` now returns:

```json
{ "stopId": "31", "source": "stop", "dayType": "FE",
  "lines": [{ "line": "005", "label": "5", "direction": "A",
              "from": "07:30", "to": "23:30", "headway": { "min": 18, "max": 33 },
              "state": "running", "wait": { "typical": 9, "worst": 33 } }] }
```

`state` is `running`, `not_started` (with `firstBus`, `startsInMinutes`),
`ended` (with tomorrow's `firstBus`), `no_service_today` or `unknown`.
`wait` is arithmetic on the band (half an interval typical, one interval
worst), offered only while the line runs. For a stop with no detail record
(code 81) pass the codes area search knows, `?lines=833,070&day=LA`; hours
then come from each line's timetable and are marked `borrowed`. Cost: the
7-day detail cache, or up to 8 day-cached timetables.

## What it would take to get real per-trip times

EMT publishes a static GTFS feed (listed on the Mobility Database and
Transitland; also via datos.gob.es / CRTM). GTFS `stop_times.txt` has a time
per trip per stop — but for a headway-run network those are typically
timetabled at the termini and interpolated in between, or the feed uses
`frequencies.txt` instead, which is the same headway again. Not checked yet:
this session's network could not reach the feed, so whether EMT's GTFS has
exact times (`exact_times=1`) or frequencies is still open.

If it does have them, it cannot be read by the Worker on demand: the zip is
far beyond a free-plan Worker's CPU and memory. It would need an offline step
(a GitHub Action, weekly) that slices `stop_times` per stop and day type into
small JSON files or a Supabase table, plus a note that its stop ids are
EMT's own (check — CRTM's feed uses a different namespace, see Scope in
CLAUDE.md).

Next steps, in order of cost:
1. Show the headway in the stop sheet beside each line's hours (data is
   already on the page; no new call).
2. Record a `lines/{line}/stops/{dir}/` fixture: its frequency bands by time
   of day ("every 8 min at peak, 15 off-peak") would sharpen the band.
3. Download the GTFS once and check for `frequencies.txt` vs exact
   `stop_times` before building any pipeline.
