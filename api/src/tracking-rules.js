// Pure transitions: never consume an alert until its push has been accepted.
export const BUS_INTERVAL = 120_000;
export const BIKE_INTERVAL = 30_000;
// A rack arms below 6 bikes and from then on alerts on every change, a bike
// docked or taken, so the phone always shows what is there now. The change
// that takes it above 6 alerts once more and disarms it; dropping below 6
// again re-arms it. Exactly 6 keeps whichever state it had.
export const BIKE_ARM_BELOW = 6;
export const BIKE_DISARM_ABOVE = 6;

export function bikeTransition(previous = {}, station) {
  if (!station || !station.inService || !station.renting ||
      !Number.isInteger(station.bikes) || station.bikes < 0) return { state: previous, alerts: [] };
  const count = station.bikes;
  const armed = count < BIKE_ARM_BELOW ? true : count > BIKE_DISARM_ABOVE ? false : previous.armed === true;
  const change = previous.count == null ? 0 : count - previous.count;
  const notify = change !== 0 && (armed || previous.armed === true);
  return {
    state: { armed, count },
    // The body is also the delivery key: one change, one alert.
    alerts: notify ? [{ bikes: count, change, paused: !armed, body: `${previous.count}→${count}` }] : [],
  };
}

/** Without a lead time, a bus alerts once it is 15 minutes out. */
export const BUS_ALERT_WINDOW = 900;
/** A lead time is "minutes I need to reach the stop", set by the rider: they
 *  know their own walk better than a router does. The alert window is that
 *  plus one poll interval, so a 2-minute board cannot step straight past it. */
export const LEAD_MARGIN_MINUTES = BUS_INTERVAL / 60_000;
export const LEAD_MINUTES_MAX = 30;
/** How far ahead the "then N min" bus may be: past this it is no help, and
 *  EMT's 888888/999999 sentinels are not countdowns at all. */
const THEN_HORIZON = 3600;

export function validLead(value) {
  if (value == null || value === "") return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= LEAD_MINUTES_MAX ? minutes : undefined;
}

export function alertWindow(watch) {
  return Number.isInteger(watch?.leadMinutes)
    ? (watch.leadMinutes + LEAD_MARGIN_MINUTES) * 60 : BUS_ALERT_WINDOW;
}

/** One notification per watch, about the soonest bus inside the window.
 *
 * A bus entering the window is `fresh`: it alerts with sound. While that same
 * bus counts down, each poll where its minutes drop sends a quiet update that
 * replaces the notification in place, so the phone shows one countdown
 * instead of a stack. A second bus already inside the window waits its turn:
 * it alerts, with sound, once it is the soonest, which is when it is the one
 * to catch. Each alert names the bus after it too ("then 14 min").
 */
export function busTransition(previous = {}, arrivals, watch, now) {
  const seen = { ...previous.seen };
  // Keep vehicles through temporary board omissions and ETA corrections, but
  // allow the same vehicle to trigger again on a later circuit.
  for (const [key, time] of Object.entries(seen)) if (now - time > 30 * 60_000) delete seen[key];
  const window = alertWindow(watch);
  const keyOf = (bus) => (bus.vehicleId ? `${bus.vehicleId}:${bus.destination ?? ""}` : `unknown:${bus.destination ?? ""}`);
  const matching = arrivals.filter((bus) => String(bus.line).toUpperCase() === watch.line &&
    (!watch.destination || bus.destination === watch.destination) &&
    Number.isFinite(bus.seconds) && bus.seconds >= 0 && bus.seconds <= THEN_HORIZON)
    .sort((a, b) => a.seconds - b.seconds);
  const inWindow = matching.filter((bus) => bus.seconds <= window);
  // Every refresh of a time is a storage write, so a sighting is refreshed
  // at most every five minutes; the 30-minute expiry absorbs the slack.
  for (const bus of inWindow) {
    const key = keyOf(bus);
    if (seen[key] && now - seen[key] >= 5 * 60_000) seen[key] = now;
  }
  const lead = inWindow[0];
  if (!lead) return { state: { seen }, alerts: [] };
  const key = keyOf(lead);
  const minutes = Math.ceil(lead.seconds / 60);
  const after = matching.find((bus) => bus !== lead && keyOf(bus) !== key);
  const alert = {
    minutes, destination: lead.destination ?? "",
    then: after ? Math.ceil(after.seconds / 60) : null,
    body: `Line ${watch.line}${lead.destination ? ` → ${lead.destination}` : ""}: ${minutes} min away.`,
  };
  let shown = previous.shown ?? null;
  const alerts = [];
  if (!seen[key]) {
    seen[key] = now;
    alerts.push({ ...alert, fresh: true, vehicle: key });
    shown = { vehicle: key, minutes };
  } else if (shown?.vehicle === key && minutes < shown.minutes) {
    // Only ever downwards: a re-estimate pushing the bus back a minute is not
    // worth waking the screen for, and it catches up on the next drop.
    alerts.push({ ...alert, fresh: false, vehicle: `${key}@${minutes}` });
    shown = { vehicle: key, minutes };
  }
  return { state: { seen, ...(shown ? { shown } : {}) }, alerts };
}

/** EMT signs destinations in capitals ("PLAZA CASTILLA"); a notification
 *  reads them faster in ordinary case. */
export function displayCase(text) {
  return String(text ?? "").toLowerCase().replace(/(^|[\s\-/(.])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());
}

/** What the phone shows. Android gives the title one bold line and the body
 *  one more before truncating, so the title names the bus or station and the
 *  body leads with the news: minutes for a bus, the count for bikes. */
export function notificationText(watch, alert) {
  const place = watch.kind === "bike" ? `station ${watch.targetId}` : `stop ${watch.targetId}`;
  const where = watch.label ? `${watch.label} · ${place}` : place.charAt(0).toUpperCase() + place.slice(1);
  if (watch.kind === "bike") {
    // Leads with what is there now; then what just happened.
    const available = alert.bikes === 0 ? "No bikes available" : `${alert.bikes} ${alert.bikes === 1 ? "bike" : "bikes"} available`;
    const moved = Math.abs(alert.change ?? 0);
    const event = alert.paused ? "alerts paused above 6" : moved ? `${moved} ${alert.change > 0 ? "docked" : "taken"}` : "";
    return {
      title: watch.label || `Station ${watch.targetId}`,
      body: [available, event, watch.label ? place : ""].filter(Boolean).join(" · "),
    };
  }
  const destination = displayCase(alert.destination || watch.destination);
  // "Leave now" while the bus is still at least the rider's own walk away;
  // past that it is just the countdown, and they can judge whether to run.
  const wait = alert.minutes <= 0 ? "Due now"
    : Number.isInteger(watch.leadMinutes) && alert.minutes >= watch.leadMinutes ? `Leave now · in ${alert.minutes} min`
      : `In ${alert.minutes} min`;
  return {
    title: destination ? `${watch.line} → ${destination}` : `Line ${watch.line}`,
    body: [wait, alert.then != null ? `then ${alert.then} min` : "", where].filter(Boolean).join(" · "),
  };
}

/* When a watch is live. A watch may carry a schedule (days plus one window,
 * in Madrid time) and a radius (metres around its stop or station). Outside
 * either it is paused: not polled, not alerted, its state cleared so coming
 * back starts from a fresh baseline instead of reporting what changed while
 * nobody was looking. */
export const RADIUS_CHOICES = [500, 1000, 2000];
export const DEFAULT_RADIUS = 1000;
/** How long a position the page reported keeps counting. The page can only
 *  say where the phone is while it is open, so this is "where you last opened
 *  the app". Long enough for a morning check-in to carry the working day,
 *  short enough that yesterday's position does not decide today. */
export const LOCATION_FRESH = 12 * 3_600_000;

const madridClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const madridDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday (0 = Sunday, like Date#getDay) and minute of the day in Madrid. */
export function madridTime(now) {
  const parts = Object.fromEntries(madridClock.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return { day: WEEKDAYS.indexOf(parts.weekday), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Madrid's UTC offset in minutes at an instant (60 or 120). */
function madridOffset(now) {
  const p = Object.fromEntries(madridDate.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((wall - Math.floor(now / 60_000) * 60_000) / 60_000);
}

const toMinute = (text) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** {days: [0..6], from: "HH:MM", to: "HH:MM"} or null. `days` are the days a
 *  window *starts* on; a window whose end is before its start runs past
 *  midnight into the next day. */
export function validSchedule(value) {
  if (value == null) return null;
  const days = Array.isArray(value.days) ? [...new Set(value.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  const from = toMinute(value.from);
  const to = toMinute(value.to);
  if (!days.length || from == null || to == null || from === to) return undefined;
  return { days, from: value.from, to: value.to };
}

export function validRadius(value) {
  if (value == null) return null;
  return RADIUS_CHOICES.includes(Number(value)) ? Number(value) : undefined;
}

export function inSchedule(schedule, now) {
  if (!schedule) return true;
  const { day, minute } = madridTime(now);
  const from = toMinute(schedule.from);
  const to = toMinute(schedule.to);
  if (from < to) return schedule.days.includes(day) && minute >= from && minute < to;
  return (schedule.days.includes(day) && minute >= from) || (schedule.days.includes((day + 6) % 7) && minute < to);
}

/** The next instant the schedule opens or closes, after `now`. */
export function nextScheduleEdge(schedule, now) {
  if (!schedule) return null;
  const { day, minute } = madridTime(now);
  const from = toMinute(schedule.from);
  const to = toMinute(schedule.to);
  let best = Infinity;
  // Yesterday's window can still be open past midnight, hence from -1.
  for (let k = -1; k <= 7; k++) {
    if (!schedule.days.includes((day + k + 7) % 7)) continue;
    for (const edge of [from, to > from ? to : to + 1440]) {
      const delta = k * 1440 + edge - minute;
      if (delta > 0 && delta < best) best = delta;
    }
  }
  if (best === Infinity) return null;
  const start = Math.floor(now / 60_000) * 60_000;
  const guess = start + best * 60_000;
  // Local minutes, so a DST change in between moves the instant by an hour.
  return guess - (madridOffset(guess) - madridOffset(now)) * 60_000;
}

/** The next instant the schedule opens, for "resumes Mon 15:00". */
export function nextScheduleStart(schedule, now) {
  let at = now;
  for (let i = 0; i < 20; i++) {
    at = nextScheduleEdge(schedule, at);
    if (at == null) return null;
    if (inSchedule(schedule, at)) return at;
  }
  return null;
}

function metresBetween([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  return Math.round(Math.hypot(x, lat2 - lat1) * 111_320);
}

/** Whether a watch is live now, and if not, why. A radius only applies once
 *  the page has reported a position and the watch knows where it is; a
 *  watch without either behaves as it always did. */
export function watchStatus(watch, location, now) {
  if (!inSchedule(watch.schedule, now)) return { active: false, reason: "schedule", resumes: nextScheduleStart(watch.schedule, now) };
  if (watch.radius && watch.coordinates && location?.coordinates) {
    if (now - location.at > LOCATION_FRESH) return { active: false, reason: "stale" };
    const metres = metresBetween(location.coordinates, watch.coordinates);
    if (metres > watch.radius) return { active: false, reason: "far", metres };
  }
  return { active: true };
}

/** When a watch's status can next change on its own: a schedule edge, or a
 *  position going stale. Moving is reported by the page and syncs anyway. */
export function nextStatusChange(watch, location, now) {
  const times = [nextScheduleEdge(watch.schedule, now)];
  if (watch.radius && watch.coordinates && location?.coordinates && now - location.at <= LOCATION_FRESH) {
    times.push(location.at + LOCATION_FRESH + 1);
  }
  return times.filter((t) => t != null && t > now).reduce((a, b) => Math.min(a, b), Infinity);
}
