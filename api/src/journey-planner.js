import { EmtError } from "./errors.js";

const EARTH_M = 6_371_000;
const WALK_METRES_PER_SECOND = 1.3;
const RIDE_SECONDS_PER_STOP = 90;
const DEFAULT_HEADWAY_SECONDS = 10 * 60;
const MIN_HEADWAY_SECONDS = 3 * 60;
const MAX_HEADWAY_SECONDS = 30 * 60;
const TRANSFER_BUFFER_SECONDS = 60;

export function distanceMetres(a, b) {
  const rad = Math.PI / 180;
  const p1 = Number(a.lat) * rad;
  const p2 = Number(b.lat) * rad;
  const dp = (Number(b.lat) - Number(a.lat)) * rad;
  const dl = (Number(b.lon) - Number(a.lon)) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

function point(stop) {
  return { lat: Number(stop.coordinates?.[1]), lon: Number(stop.coordinates?.[0]) };
}

function lineCode(entry) {
  return String(entry?.line ?? entry?.label ?? "").trim();
}

function lineIdentity(entry) {
  const code = lineCode(entry).toUpperCase();
  return /^\d+$/.test(code) ? code.replace(/^0+(?=\d)/, "") : code;
}

export function linesMatch(a, b) {
  const left = lineIdentity(a);
  return Boolean(left) && left === lineIdentity(b);
}

/** The first bus at or after `readyAt`, else one headway past the last one
 *  listed. web/app.js firstLegTimes() keeps a copy for hub cards: change both. */
function nextDeparture(arrivals, readyAt) {
  const times = (arrivals ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const live = times.find((seconds) => seconds >= readyAt);
  if (live != null) return live;
  if (times.length === 0) return null;
  const observed = times.length > 1 ? times.at(-1) - times.at(-2) : DEFAULT_HEADWAY_SECONDS;
  const headway = Math.min(MAX_HEADWAY_SECONDS, Math.max(MIN_HEADWAY_SECONDS, observed || DEFAULT_HEADWAY_SECONDS));
  return times.at(-1) + Math.ceil((readyAt - times.at(-1)) / headway) * headway;
}

/** Estimate seconds from the user's current position to the Hub. */
export function estimateJourneySeconds(option) {
  const originWalk = Number.isFinite(option.originStop?.walkSeconds)
    ? option.originStop.walkSeconds
    : Number(option.originStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND;
  const firstDeparture = nextDeparture(option.firstLeg?.arrivals, originWalk);
  if (firstDeparture == null) return null;
  option.firstLeg.selectedArrival = Math.round(firstDeparture);
  const firstRide = Number(option.firstLeg?.stops ?? 0) * RIDE_SECONDS_PER_STOP;
  const destinationWalk = Number(option.destinationStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND;
  if (option.type === "direct") return Math.round(firstDeparture + firstRide + destinationWalk);

  const transferWalk = Number(option.transfer?.walkM ?? 0) / WALK_METRES_PER_SECOND;
  const readyForSecond = firstDeparture + firstRide + transferWalk + TRANSFER_BUFFER_SECONDS;
  const secondDeparture = nextDeparture(option.secondLeg?.arrivals, readyForSecond);
  if (secondDeparture == null) return null;
  option.secondLeg.selectedArrival = Math.round(secondDeparture);
  const secondRide = Number(option.secondLeg?.stops ?? 0) * RIDE_SECONDS_PER_STOP;
  return Math.round(secondDeparture + secondRide + destinationWalk);
}

/** What the journey *feels* like, for ranking only — never shown as an ETA.
 *
 * Time on a bus and time on foot are not the same minute. Walking is the part
 * people avoid, in August especially, so it is weighted above riding: without
 * this, ranking on raw predicted arrival happily recommends a stop 300m
 * further away to save two minutes, which is not a trade anyone makes.
 *
 * `estimatedSeconds` stays the honest prediction and is what the card shows.
 */
const WALK_AVERSION = 1.6;

export function rankJourneySeconds(option) {
  if (option?.estimatedSeconds == null) return null;
  const originWalk = Number.isFinite(option.originStop?.walkSeconds)
    ? option.originStop.walkSeconds
    : Number(option.originStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND;
  const onFoot = originWalk
    + Number(option.destinationStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND
    + Number(option.transfer?.walkM ?? 0) / WALK_METRES_PER_SECOND;
  return Math.round(option.estimatedSeconds + onFoot * (WALK_AVERSION - 1));
}

/** Order options the way the rider would choose between them.
 *
 * A direct ride outranks every transfer, whatever the clock says. A transfer
 * is a second fare — about €0.70 without a subscription — and getting off,
 * walking, and waiting again is worse than staying on a bus already going
 * where you are going, even when it arrives a few minutes sooner. No Madrid
 * ride is long enough for that to backfire badly: by day a leg is 15–20
 * minutes, and at night the wider search radius is what buys the choice.
 *
 * Incidents and timing order each group internally, so a disrupted direct
 * falls behind a clean direct — just never behind a transfer.
 */
export function compareJourneyOptions(a, b) {
  const transfer = (option) => Number(option.type !== "direct");
  const disrupted = (option) => Number((option.incidents?.length ?? 0) > 0);
  const untimed = (option) => Number(option.rankSeconds == null);
  return transfer(a) - transfer(b)
    || disrupted(a) - disrupted(b)
    || untimed(a) - untimed(b)
    || (a.rankSeconds ?? Number.POSITIVE_INFINITY)
      - (b.rankSeconds ?? Number.POSITIVE_INFINITY)
    || a.score - b.score;
}

/** Collapse candidates that represent the same journey as experienced by the user.
 * Different nearby destination stops can otherwise produce duplicate legs. */
export function deduplicateJourneyOptions(options) {
  const seen = new Set();
  return (options ?? []).filter((option) => {
    const signature = [
      option.type,
      lineIdentity(option.firstLeg),
      option.firstLeg?.direction,
      option.type === "one_transfer" ? lineIdentity(option.secondLeg) : "",
      option.type === "one_transfer" ? option.secondLeg?.direction : "",
    ].join("|");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function boardHasLine(board, line) {
  const wanted = lineIdentity(line);
  return Boolean(wanted) && (board?.arrivals ?? [])
    .some((arrival) => lineIdentity(arrival) === wanted);
}

export function stopsWithLiveLines(stops, boards) {
  return (stops ?? []).map((stop) => {
    const arrivals = boards.get(String(stop.stopId))?.arrivals ?? [];
    const listed = new Map();
    for (const line of stop.lines ?? []) {
      listed.set(lineIdentity(line), line);
      if (line?.label != null) listed.set(lineIdentity({ line: line.label }), line);
    }
    const live = new Map();
    for (const arrival of arrivals) {
      const code = lineCode(arrival);
      const identity = lineIdentity(arrival);
      if (!code || live.has(identity)) continue;
      live.set(identity, listed.get(identity) ?? { line: code, label: code });
    }
    return { ...stop, lines: [...live.values()] };
  }).filter((stop) => stop.lines.length > 0);
}

export function nearbyAccess(stops, location, maxStops = 6) {
  return (stops ?? [])
    .map((stop) => ({ ...stop, distanceM: Math.round(distanceMetres(location, point(stop))) }))
    .filter((stop) => Number.isFinite(stop.distanceM))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, maxStops);
}

/** Keep scarce live-arrival calls useful in dense areas.
 *
 * A merely nearest-first slice can discard a direct line 450m away because six
 * unrelated stops happen to be closer. So slots are reserved for stops that
 * share a line with the destination — but **one per shared line**, not simply
 * the nearest two stops that share any of them.
 *
 * That distinction is the whole thing at night. A destination served by
 * 9, 29, 52, 73 and N2 will have several stops within 300m serving 9 and 73,
 * and they take every reserved slot; the one stop carrying N2 is 1.3km away
 * and never gets considered. At 01:00 the day lines are asleep and N2 is the
 * only line running, so the hub reports "No route" while a direct bus exists.
 *
 * Reserving per line costs nothing by day — it just means each line the
 * destination is served by gets one chance to be boarded.
 */
export function prioritizeAccessStops(candidates, destinationGroups, maxStops = 6) {
  const selected = [];
  const selectedIds = new Set();
  const add = (stop) => {
    const id = String(stop?.stopId ?? "");
    if (!id || selectedIds.has(id) || selected.length >= maxStops) return;
    selectedIds.add(id);
    selected.push(stop);
  };
  for (const destinations of destinationGroups ?? []) {
    const seen = new Set();
    for (const destinationLine of (destinations ?? []).flatMap((stop) => stop.lines ?? [])) {
      const identity = lineIdentity(destinationLine);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      // Two per line, not one: a line's two directions are different platforms,
      // often across the street from each other, and only one of them is going
      // your way. `candidates` arrives sorted by walking distance.
      (candidates ?? [])
        .filter((candidate) => (candidate.lines ?? [])
          .some((line) => linesMatch(line, destinationLine)))
        .slice(0, 2)
        .forEach(add);
    }
  }
  for (const candidate of candidates ?? []) add(candidate);
  return selected;
}

export function linesAt(stops) {
  const result = new Map();
  for (const stop of stops ?? []) {
    for (const entry of stop.lines ?? []) {
      const code = lineCode(entry);
      if (!code || result.has(`${stop.stopId}:${code}`)) continue;
      result.set(`${stop.stopId}:${code}`, {
        code,
        label: String(entry.label ?? code).trim(),
        stop,
      });
    }
  }
  return [...result.values()];
}

function directedSections(route, fromStopIds, toStopIds) {
  const sections = [];
  for (const direction of ["toA", "toB"]) {
    const stops = route?.stops?.[direction] ?? [];
    for (let from = 0; from < stops.length; from += 1) {
      if (!fromStopIds.has(String(stops[from].stopId))) continue;
      for (let to = from + 1; to < stops.length; to += 1) {
        if (toStopIds.has(String(stops[to].stopId))) {
          sections.push({ direction, stops, from, to });
          break;
        }
      }
    }
  }
  return sections;
}

function routeFor(routes, code) {
  return routes instanceof Map ? routes.get(code) : routes?.[code];
}

function bestDirect(originLines, destinationLines, routes) {
  const destinationByCode = new Map(destinationLines.map((item) => [lineIdentity(item), item]));
  const candidates = [];
  for (const origin of originLines) {
    const destination = destinationByCode.get(lineIdentity(origin));
    if (!destination) continue;
    const route = routeFor(routes, origin.code);
    const sections = directedSections(route,
      new Set([String(origin.stop.stopId)]), new Set([String(destination.stop.stopId)]));
    for (const section of sections) {
      candidates.push({
        type: "direct",
        score: origin.stop.distanceM + destination.stop.distanceM + (section.to - section.from) * 420,
        originStop: origin.stop,
        destinationStop: destination.stop,
        firstLeg: { line: origin.code, label: origin.label, direction: section.direction,
          stops: section.to - section.from },
      });
    }
  }
  return candidates;
}

function bestTransfers(originLines, destinationLines, routes, thresholdM) {
  const candidates = [];
  for (const first of originLines) {
    const firstRoute = routeFor(routes, first.code);
    if (!firstRoute) continue;
    for (const second of destinationLines) {
      if (linesMatch(first, second)) continue;
      const secondRoute = routeFor(routes, second.code);
      if (!secondRoute) continue;
      for (const firstDirection of ["toA", "toB"]) {
        const firstStops = firstRoute.stops?.[firstDirection] ?? [];
        const start = firstStops.findIndex((stop) => String(stop.stopId) === String(first.stop.stopId));
        if (start < 0) continue;
        for (const secondDirection of ["toA", "toB"]) {
          const secondStops = secondRoute.stops?.[secondDirection] ?? [];
          const end = secondStops.findIndex((stop) => String(stop.stopId) === String(second.stop.stopId));
          if (end <= 0) continue;
          let best = null;
          for (let i = start + 1; i < firstStops.length; i += 1) {
            for (let j = 0; j < end; j += 1) {
              const walk = distanceMetres(point(firstStops[i]), point(secondStops[j]));
              if (walk <= thresholdM && (!best || walk < best.walk)) best = { i, j, walk };
            }
          }
          if (!best) continue;
          candidates.push({
            type: "one_transfer",
            score: first.stop.distanceM + second.stop.distanceM + best.walk +
              (best.i - start + end - best.j) * 420 + 600,
            originStop: first.stop,
            destinationStop: second.stop,
            firstLeg: { line: first.code, label: first.label, direction: firstDirection,
              stops: best.i - start },
            transfer: {
              fromStop: firstStops[best.i], toStop: secondStops[best.j], walkM: Math.round(best.walk),
            },
            secondLeg: { line: second.code, label: second.label, direction: secondDirection,
              stops: end - best.j },
          });
        }
      }
    }
  }
  return candidates;
}

export function planJourney({ originStops, destinationStops, routes, transferRadiusM = 200, limit = 8 }) {
  const originLines = linesAt(originStops);
  const destinationLines = linesAt(destinationStops);
  const byScore = (a, b) => a.score - b.score;
  const directs = [...bestDirect(originLines, destinationLines, routes)].sort(byScore);
  const transfers = [...bestTransfers(originLines, destinationLines, routes, transferRadiusM)]
    .sort(byScore);
  // Directs ahead of transfers, rather than one pool sorted by `score`.
  //
  // `score` is walking metres plus 420 per stop ridden. It is a reasonable
  // guess at which candidates deserve a slot, but it knows nothing about when
  // the next bus actually comes — that is what the live ranking in the caller
  // is for, and everything cut here never reaches it. A direct ride is always
  // rankable there, because its boarding stop's board was already read; a
  // transfer needs a second board that only `transferChecks()` of them ever
  // get, so most arrive unrankable and sort last anyway.
  //
  // Sorting the two together let six untimeable transfers take the slots that
  // the 29 at Arturo Soria needed: 431m from the door and direct to the
  // destination, cut at rank 9 of 8 by its longer ride, while the option that
  // won boarded 670m away and left 14 minutes later.
  return [...directs, ...transfers].slice(0, limit);
}

export function uniqueLineCodes(stops) {
  return [...new Set(linesAt(stops).map((item) => item.code))];
}

/* ---- Other ways there: BiciMAD and on foot ----------------------------- */

/** Straight lines to street distance. Madrid's grid is mostly kind; the 2:1
 *  corners (Arturo Soria) are why bus walks go through the router, but a
 *  bike or walking estimate is a comparison figure, not a countdown. */
const STREET_FACTOR = 1.3;
// An e-bike in city traffic, lights included: ~15 km/h. Every BiciMAD bike is
// electric (8,942 of them, 0 mechanical).
const BIKE_METRES_PER_SECOND = 4.2;
// Unlocking at the station and docking at the other end.
const BIKE_HANDLING_SECONDS = 120;
// Same fixed radius as the BiciMAD section: docks do not thin out overnight.
const BIKE_ACCESS_RADIUS = 700;
// Below this a bike is not worth unlocking — walking the same way is as quick.
const BIKE_MIN_RIDE_METRES = 500;
// The counts are up to 45 seconds old. A station down to its last bike or
// dock is a gamble, so it has to be this much closer to win.
const BIKE_SCARCE_COUNT = 2;
const BIKE_SCARCE_PENALTY_METRES = 150;
const BIKE_CANDIDATES = 4;

function stationPoint(station) {
  return { lat: Number(station.coordinates?.[1]), lon: Number(station.coordinates?.[0]) };
}

function bikeCandidates(stations, place, usable, count) {
  return stations
    .filter((station) => Array.isArray(station.coordinates) && station.inService !== false && usable(station))
    .map((station) => ({ station, metres: distanceMetres(place, stationPoint(station)) }))
    .filter(({ metres }) => metres <= BIKE_ACCESS_RADIUS)
    .map((candidate) => ({
      ...candidate,
      cost: candidate.metres + (count(candidate.station) <= BIKE_SCARCE_COUNT ? BIKE_SCARCE_PENALTY_METRES : 0),
    }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, BIKE_CANDIDATES);
}

function stationSummary(station, metres) {
  return {
    id: String(station.id),
    number: String(station.number ?? station.id),
    name: station.name ?? null,
    coordinates: station.coordinates,
    bikes: station.bikes ?? null,
    freeBases: station.freeBases ?? null,
    walkM: Math.round(metres * STREET_FACTOR),
  };
}

/** Rent near the rider, dock near the destination: the best pair, or null.
 *
 * A station renting no bikes, or accepting no returns, is no use at that end
 * — GBFS says which, and MobilityLabs (the fallback) does not, so a missing
 * flag counts as yes. The nearest station to each end is not always the best
 * pair: one 100m further on, in the direction of travel, saves both, so the
 * few nearest at each end are tried against each other.
 */
export function planBikeRide(stations, origin, destination) {
  const pickups = bikeCandidates(stations ?? [], origin,
    (station) => station.renting !== false && Number(station.bikes) >= 1, (station) => Number(station.bikes));
  const docks = bikeCandidates(stations ?? [], destination,
    (station) => station.returning !== false && Number(station.freeBases) >= 1, (station) => Number(station.freeBases));
  let best = null;
  for (const pickup of pickups) {
    for (const dock of docks) {
      if (String(pickup.station.id) === String(dock.station.id)) continue;
      const rideM = distanceMetres(stationPoint(pickup.station), stationPoint(dock.station)) * STREET_FACTOR;
      if (rideM < BIKE_MIN_RIDE_METRES) continue;
      const walkSeconds = (pickup.metres + dock.metres) * STREET_FACTOR / WALK_METRES_PER_SECOND;
      const seconds = walkSeconds + BIKE_HANDLING_SECONDS + rideM / BIKE_METRES_PER_SECOND;
      const rank = seconds + (pickup.cost - pickup.metres + dock.cost - dock.metres) / WALK_METRES_PER_SECOND;
      if (!best || rank < best.rank) best = { rank, seconds, rideM, pickup, dock };
    }
  }
  if (!best) return null;
  return {
    pickup: stationSummary(best.pickup.station, best.pickup.metres),
    dropoff: stationSummary(best.dock.station, best.dock.metres),
    rideM: Math.round(best.rideM),
    estimatedSeconds: Math.round(best.seconds),
  };
}

/** The whole way on foot, for comparison. Short trips are often best walked,
 *  and the bus options cannot say so. */
export function walkEstimate(origin, destination) {
  const metres = Math.round(distanceMetres(origin, destination) * STREET_FACTOR);
  return { metres, seconds: Math.round(metres / WALK_METRES_PER_SECOND) };
}

/* ---- Planning a journey ------------------------------------------------ */

/** How much one journey request may do. The Free plan lets one invocation
 *  make only 50 subrequests, so the page sends one hub per request and the
 *  planner rations routes, transfer boards and incident reads. Workers Paid
 *  allows 10,000, so there every hub goes in one request (sharing the origin's
 *  nearby search, walking matrix and boards) and the search widens. EMT quota
 *  is not the constraint: planning used ~520 calls a day of 20,000 (Sept 2026).
 *  Set PLANNER_TIER = "paid" in wrangler.toml once the account is on Workers
 *  Paid; anything else keeps the free budgets. */
const PLANNER_BUDGETS = {
  free: { destinations: 3, originStops: 8, incidentLines: 4,
    routes: { day: 10, night: 14 }, transfers: { day: 3, night: 8 } },
  paid: { destinations: 12, originStops: 12, incidentLines: 16,
    routes: { day: 24, night: 30 }, transfers: { day: 8, night: 16 } },
};
const plannerBudget = (tier) => PLANNER_BUDGETS[tier === "paid" ? "paid" : "free"];
// The pedestrian matrix takes at most 25 destinations in one call.
const WALKING_MATRIX_LIMIT = 25;
// Below this the gate stops filtering and simply takes the nearest on foot.
const JOURNEY_MIN_ORIGIN_STOPS = 3;
function plannerLocation(value, name) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new EmtError("bad_request", `invalid ${name} coordinates`);
  }
  return { lat, lon };
}

function prioritizedRouteCodes(originStops, destinationGroups, max = 20) {
  const origin = uniqueLineCodes(originStops);
  const destinations = destinationGroups.map(uniqueLineCodes);
  const common = destinations.flatMap((codes) => codes.filter((code) => origin.includes(code)));
  const ordered = [...new Set(common)];
  const queues = [origin, ...destinations].map((codes) => [...codes]);
  while (ordered.length < max && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const code = queue.shift();
      if (code && !ordered.includes(code)) ordered.push(code);
      if (ordered.length === max) break;
    }
  }
  return ordered;
}

/** Cap how long one upstream read may hold up a journey.
 *
 * A journey reads 20–30 boards in parallel and is only as quick as its slowest
 * one. `emtFetch` already aborts a single EMT call at 8s, but the planner need
 * not wait even that long: dropping one stop costs a candidate, while waiting
 * costs the whole plan — the page gives up at 25s. Measured on live traffic,
 * journeys that returned took 16.2s and the rest were cancelled at 25s, with
 * 14–25ms of CPU. All of that was waiting.
 */
export function withinDeadline(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Madrid's own clock, which is the one the rider is living in — and it moves
// with DST, so it cannot be derived from a UTC offset.
function madridHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", hour: "2-digit", hour12: false,
  }).format(now));
}

/** How far a rider is plausibly willing to walk to catch something.
 *
 * By day, 700m: there is a bus, a metro or a bike within 300–500m of anywhere
 * in Madrid, so casting wider only offers worse options: by day every stop is
 * served often enough that the nearest one wins, and a farther stop is just a
 * longer walk to the same bus.
 *
 * After midnight the day lines have stopped, the network is night lines only,
 * and the arithmetic inverts — a 25-minute walk can beat waiting 40 minutes,
 * and on a summer night it is not a hardship. The app's job is to show that
 * the option exists and let the rider judge it. The window opens at 00:00
 * rather than 23:00 because at 23:00 most day lines are still running.
 */
const DAY_ACCESS_RADIUS = 800;
const NIGHT_ACCESS_RADIUS = 2000;
const NIGHT_FROM_HOUR = 0;
const NIGHT_UNTIL_HOUR = 6;

/** How far apart two stops may be and still count as one interchange.
 *
 * By day 200m keeps transfers to what is genuinely the same interchange. At
 * night the same reasoning as the access radius applies, and the numbers are
 * concrete: the closest N1 stop to any S10 stop is 496m — République
 * Argentina to Nuevos Ministerios — so a 200m gate rejects the only sensible
 * way across town at 01:00, which is the pairing Google offers first.
 */
const DAY_TRANSFER_RADIUS = 200;
const NIGHT_TRANSFER_RADIUS = 600;

function isNight(now) {
  const hour = madridHour(now);
  // The window used to start at 23:00 and wrap past midnight, so this was an
  // `||`. It no longer wraps, and `hour >= 0 || hour < 6` is true at every
  // hour of the day — handle both shapes rather than leave that waiting for
  // whoever moves the boundary back.
  return NIGHT_FROM_HOUR < NIGHT_UNTIL_HOUR
    ? hour >= NIGHT_FROM_HOUR && hour < NIGHT_UNTIL_HOUR
    : hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;
}

function accessRadius(night) {
  return night ? NIGHT_ACCESS_RADIUS : DAY_ACCESS_RADIUS;
}

function transferRadius(night) {
  return night ? NIGHT_TRANSFER_RADIUS : DAY_TRANSFER_RADIUS;
}

/** How many transfer stops are worth a board read before ranking (per tier,
 *  see PLANNER_BUDGETS).
 *
 * An option whose transfer stop is never read is not merely unranked — it is
 * discarded, because "no live arrivals for the second leg" and "we never
 * asked" are the same thing to the filter. By day three is plenty. At night
 * the running line is rarely the nearest one: for Hortaleza→General Perón the
 * only viable second leg, S10, ranked sixth by walking distance behind four
 * day lines that were asleep.
 */
function transferChecks(budget, night) {
  return budget.transfers[night ? "night" : "day"];
}

function routeBudget(budget, night) {
  return budget.routes[night ? "night" : "day"];
}

/** Candidates the radius actually reaches, measured the way they are walked.
 *
 * Never down to nothing: in a sparse corner every stop can route past the
 * gate, and an honest long walk is a better answer than "No route". Stops the
 * router had no distance for keep their place rather than being punished for
 * it.
 */
function walkingReachable(candidates, radius) {
  const byWalk = [...candidates].sort((a, b) =>
    (a.walkMetres ?? a.distanceM) - (b.walkMetres ?? b.distanceM));
  const within = byWalk.filter((stop) =>
    !Number.isFinite(stop.walkMetres) || stop.walkMetres <= radius);
  return within.length >= JOURNEY_MIN_ORIGIN_STOPS ? within
    : byWalk.slice(0, JOURNEY_MIN_ORIGIN_STOPS);
}

/** Plan a way from `origin` to each Hub in `destinations`.
 *
 * A destination need not be a saved Hub: the page also sends the one-off
 * place the rider searched for, and plans it the same way. Each destination
 * gets its bus options, plus a BiciMAD ride (`bike`, or null) and the walk.
 *
 * Everything the plan reads comes through `sources` — nearby stops, boards,
 * routes, incidents, the walking matrix and bike counts (optional) — and any
 * of those reads may fail or stall: how long to wait for each, and what a
 * missing answer costs, is decided here. `tier` sizes the search (see
 * PLANNER_BUDGETS) and `now` decides whether Madrid is on its night network.
 * Returns the `/journeys` payload.
 */
export async function plan(body, { sources, tier, now = new Date() }) {
  const night = isNight(now);
  const origin = plannerLocation(body?.origin, "origin");
  const budget = plannerBudget(tier);
  if (!Array.isArray(body?.destinations) || body.destinations.length < 1 || body.destinations.length > budget.destinations) {
    throw new EmtError("bad_request", `destinations must contain 1–${budget.destinations} places`);
  }
  const destinations = body.destinations.map((destination, index) => ({
    id: String(destination.id ?? index),
    name: String(destination.name ?? "Destination").slice(0, 80),
    ...plannerLocation(destination, `destination ${index + 1}`),
    radius: Math.min(accessRadius(night),
      Math.max(200, Number(destination.destinationRadiusM) || 700)),
  }));
  // Bike counts are one city-wide read, shared through the edge cache with the
  // BiciMAD section. They only add an option, so they never hold up the plan.
  const bikesRead = sources.bikes
    ? withinDeadline(sources.bikes(), 4_000)
    : Promise.resolve(null);
  const originRaw = await sources.nearby(origin.lat, origin.lon, accessRadius(night));
  const originCandidates = nearbyAccess(originRaw, origin, 50);
  const destinationStops = await Promise.all(destinations.map(async (destination) =>
    nearbyAccess(await sources.nearby(destination.lat, destination.lon, destination.radius),
      destination, 6)));

  // Walk the candidates *before* choosing among them, not after.
  //
  // The radius is a straight line and feet follow streets. Around Arturo
  // Soria that ratio is close to 2:1 — stop 2030 is 609m across the map and
  // 1260m on foot — so an 800m search was offering boardings 1256m away,
  // which is not the deal the radius makes. Routing the candidates first
  // costs the same single matrix call it always did, and lets the stops that
  // are genuinely out of range lose their slot instead of taking one and
  // then being thrown away.
  const routable = originCandidates.slice(0, WALKING_MATRIX_LIMIT);
  let walkingRouted = false;
  try {
    const matrix = await sources.walking({
      origin,
      destinations: routable.map((stop) => ({
        lat: stop.coordinates?.[1], lon: stop.coordinates?.[0],
      })),
    });
    for (const [index, stop] of routable.entries()) {
      const route = matrix.routes[index];
      if (!Number.isFinite(route?.metres) || !Number.isFinite(route?.seconds)) continue;
      stop.walkMetres = route.metres;
      stop.walkSeconds = route.seconds;
      walkingRouted = true;
    }
  } catch {
    // Journey planning remains available if the public pedestrian router is
    // temporarily down. Without routed timing the UI deliberately stays
    // neutral, and the gate below falls back to the straight-line radius.
  }
  const originStops = prioritizeAccessStops(
    walkingReachable(walkingRouted ? routable : originCandidates, accessRadius(night)),
    destinationStops,
    budget.originStops,
  );
  // Read all candidate boarding boards first. Individual EMT failures are
  // isolated: one bad stop must not hold or reject the entire journey.
  const liveStopIds = originStops.map((stop) => String(stop.stopId));
  const live = new Map(await Promise.all(liveStopIds.map(async (stopId) => {
    return [stopId,
      await withinDeadline(sources.board(stopId), 5_000)];
  })));
  const activeOriginStops = stopsWithLiveLines(originStops, live);

  // Active lines get the scarce route slots first; static lines remain loaded
  // for the fallback used when EMT supplied no live boards at all.
  const plannerOrigins = activeOriginStops.length ? activeOriginStops : originStops;
  const routeCodes = prioritizedRouteCodes(plannerOrigins, destinationStops, routeBudget(budget, night));
  // One line's route failing costs the options on that line, not the plan:
  // boards and incidents are isolated the same way, and with the paid budget
  // there are up to 30 routes for one of them to fail.
  const routeEntries = await Promise.all(routeCodes.map(async (code) =>
    [code, await withinDeadline(sources.route(code), 8_000)]));
  const routes = new Map(routeEntries.filter(([, route]) => route));
  const planned = destinations.map((destination, index) => {
    const transferRadiusM = transferRadius(night);
    const active = planJourney({
      originStops: activeOriginStops,
      destinationStops: destinationStops[index],
      routes,
      transferRadiusM,
    });
    return {
      destination,
      options: activeOriginStops.length ? active : planJourney({
        originStops,
        destinationStops: destinationStops[index],
        routes,
        transferRadiusM,
      }),
    };
  });
  for (const item of planned) {
    for (const option of item.options) {
      const board = live.get(String(option.originStop.stopId));
      const arrivals = board?.arrivals ?? [];
      const matching = arrivals.filter((arrival) => linesMatch(arrival, option.firstLeg));
      option.firstLeg.arrivals = matching.map(({ seconds }) => seconds);
      option.firstLeg.fetchedAt = board?.fetchedAt ?? null;
    }
  }

  let transferStopIds = [];
  if (activeOriginStops.length) {
    // One stop per distinct second leg, so the budget is not spent verifying
    // three variants of the same line while the one line actually running goes
    // unchecked and is therefore thrown away.
    const perLine = new Map();
    for (const item of planned) {
      for (const option of item.options) {
        if (option.type !== "one_transfer") continue;
        const code = String(option.secondLeg?.line ?? "");
        if (code && !perLine.has(code)) perLine.set(code, String(option.transfer.toStop.stopId));
      }
    }
    transferStopIds = [...new Set(perLine.values())].slice(0, transferChecks(budget, night));
    const transferLive = new Map(await Promise.all(transferStopIds.map(async (stopId) => {
      return [stopId,
        await withinDeadline(sources.board(stopId), 5_000)];
    })));
    for (const item of planned) {
      item.options = item.options.filter((option) => {
        if (option.type === "direct") return true;
        const board = transferLive.get(String(option.transfer.toStop.stopId));
        const matching = (board?.arrivals ?? []).filter((arrival) => linesMatch(arrival, option.secondLeg));
        option.secondLeg.arrivals = matching.map(({ seconds }) => seconds);
        return matching.length > 0;
      });
    }
  }
  const incidentCodes = [...new Set(planned.flatMap((item) => item.options.flatMap((option) =>
    [option.firstLeg?.line, option.secondLeg?.line].filter(Boolean))))]
    .slice(0, budget.incidentLines);
  const incidentsByLine = new Map(await Promise.all(incidentCodes.map(async (code) => {
    // Incident data improves ranking, but must never make live journeys fail —
    // and 119 of them timed out in a day, each holding a plan for 8 seconds.
    const payload = await withinDeadline(sources.incidents(code), 3_000);
    return [code, payload?.incidents ?? []];
  })));
  for (const item of planned) {
    for (const option of item.options) {
      option.incidents = [...new Map([
        ...(incidentsByLine.get(option.firstLeg?.line) ?? []),
        ...(incidentsByLine.get(option.secondLeg?.line) ?? []),
      ].map((incident) => [incident.id, incident])).values()];
      option.estimatedSeconds = estimateJourneySeconds(option);
      option.rankSeconds = rankJourneySeconds(option);
    }
    item.options.sort(compareJourneyOptions);
    item.options = deduplicateJourneyOptions(item.options);
  }
  const bikes = await bikesRead;
  for (const item of planned) {
    item.walk = walkEstimate(origin, item.destination);
    item.bike = bikes?.stations ? planBikeRide(bikes.stations, origin, item.destination) : null;
    if (item.bike) item.bike.fetchedAt = bikes.fetchedAt ?? null;
  }
  // The boards behind every boarding stop offered. The page files them in the
  // same per-stop store its cards, sheet and map read, so a hub card and the
  // stop it opens show one set of times and move together on every refresh.
  const boards = {};
  for (const item of planned) {
    for (const option of item.options) {
      const stopId = String(option.originStop.stopId);
      if (!boards[stopId] && live.get(stopId)) boards[stopId] = live.get(stopId);
    }
  }
  return {
    origin,
    destinations: planned,
    boards,
    // How many hubs the page may send in its next request.
    maxDestinations: budget.destinations,
    generatedAt: now.getTime(),
    calls: {
      nearby: 1 + destinations.length,
      walking: walkingRouted ? 1 : 0,
      routes: routeCodes.length,
      arrivals: liveStopIds.length + transferStopIds.length,
      incidents: incidentCodes.length,
      bikes: sources.bikes ? 1 : 0,
    },
  };
}
