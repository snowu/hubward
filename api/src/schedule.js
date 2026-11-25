/** What a stop's timetable can honestly say.
 *
 * EMT publishes no per-trip scheduled times at a stop. Madrid's buses run to
 * a headway, not a clock: the operator promises "every 18–33 minutes between
 * 07:30 and 23:30", and the only per-bus times are the live estimates. What
 * the API does publish, per line and per stop, is exactly that promise —
 * stop detail's `dataLine[]` carries the stop's own first and last bus
 * (`startTime`/`stopTime`) and the interval band (`minFreq`/`maxFreq`, minutes)
 * for today's day type. For a stop EMT has no detail record for, the line's
 * own timetable stands in, with hours that are the whole line's rather than
 * this stop's — marked `borrowed`.
 *
 * Everything here is pure: the route in `index.js` fetches, this shapes.
 */

/** "07:30" → minutes after midnight, or null. */
function clockMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function fmtClock(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Minutes after midnight, Madrid time. The rule is about the city's service,
 *  so it is read in the city's zone, never off a UTC offset. */
export function madridMinutes(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** Where `now` sits relative to a service window.
 *
 * A window ending before it starts (23:40 → 05:45) runs past midnight, and is
 * running both late in the evening and early the next morning. With no hours
 * at all the answer is "unknown", never a guess. */
function serviceState(from, to, nowMin, overnight = false) {
  const start = clockMinutes(from);
  const end = clockMinutes(to);
  if (start == null || end == null) return { state: "unknown" };
  const wraps = overnight || end < start;
  const running = wraps ? nowMin >= start || nowMin <= end : nowMin >= start && nowMin <= end;
  if (running) return { state: "running" };
  if (!wraps && nowMin > end) return { state: "ended", firstBus: fmtClock(start) };
  return { state: "not_started", firstBus: fmtClock(start), startsInMinutes: (start - nowMin + 1440) % 1440 };
}

/** The interval band, in minutes, smallest first. EMT sends both as strings;
 *  a zero, missing or unparsable value means it did not say. */
export function headway(minFreq, maxFreq) {
  const values = [Number(minFreq), Number(maxFreq)].filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** One line at this stop, in the shape the page renders.
 *
 * `wait` is only offered while the line runs: with buses arriving every
 * `min`–`max` minutes and a rider turning up at a random moment, the typical
 * wait is half an interval and the worst is a whole one. It is arithmetic on
 * the promise, not a prediction — the arrivals board is the prediction. */
function scheduleLine({ line, label, direction, headers, from, to, overnight, headway: band, borrowed }, nowMin) {
  const status = serviceState(from, to, nowMin, overnight);
  return {
    line,
    label,
    ...(direction ? { direction } : {}),
    headers: headers ?? [],
    from: from ?? null,
    to: to ?? null,
    ...(overnight ? { overnight: true } : {}),
    headway: band ?? null,
    ...(borrowed ? { borrowed: true } : {}),
    ...status,
    ...(status.state === "running" && band
      ? { wait: { typical: Math.round(band.min / 2), worst: band.max } }
      : {}),
  };
}

/** A stop's timetable from its own detail record. */
export function scheduleFromDetail(detail, now = new Date()) {
  const nowMin = madridMinutes(now);
  return {
    stopId: detail.stopId,
    name: detail.name ?? null,
    source: "stop",
    dayType: detail.lines.find((l) => l.dayType)?.dayType ?? null,
    lines: detail.lines.map((l) => scheduleLine(l, nowMin)),
  };
}

/** A detail-less stop's timetable, borrowed from each line's own hours.
 *
 * `timetables` are `getLineTimetable()` answers. Without the stop's own
 * record there is no day type stamped by EMT's calendar, so the caller passes
 * the one it trusts (the page has `todayDayType()`); a line with no row for
 * it does not run today, which is reported as such rather than dropped. */
export function scheduleFromTimetables(stopId, timetables, dayType, now = new Date()) {
  const nowMin = madridMinutes(now);
  return {
    stopId: String(stopId),
    name: null,
    source: "line",
    dayType: dayType ?? null,
    lines: timetables.map((t) => {
      const row = t.days.find((d) => d.dayType === dayType);
      if (!row) {
        return { line: t.line, label: t.line, headers: [], from: null, to: null,
          headway: null, borrowed: true, state: "no_service_today" };
      }
      return scheduleLine({ line: t.line, label: t.line, from: row.from, to: row.to,
        overnight: row.overnight, borrowed: true }, nowMin);
    }),
  };
}
