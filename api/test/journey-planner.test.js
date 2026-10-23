import { describe, it, expect } from "vitest";
import {
  boardHasLine,
  deduplicateJourneyOptions,
  estimateJourneySeconds,
  linesMatch,
  nearbyAccess,
  compareJourneyOptions,
  plan,
  planJourney,
  prioritizeAccessStops,
  rankJourneySeconds,
  stopsWithLiveLines,
} from "../src/journey-planner.js";

const stop = (stopId, lon, lat, lines = []) => ({
  stopId, coordinates: [lon, lat], lines: lines.map((line) => ({ line, label: line })),
});
const route = (line, toA, toB = []) => ({ line, stops: { toA, toB } });

describe("journey planner", () => {
  it("keeps only lines with live predictions at each boarding stop", () => {
    const stops = [
      { stopId: "1836", lines: [{ label: "29" }, { label: "N2" }] },
      { stopId: "213", lines: [{ label: "70" }] },
    ];
    const boards = new Map([
      ["1836", { arrivals: [{ line: "N2", seconds: 300 }] }],
      ["213", null],
    ]);
    expect(stopsWithLiveLines(stops, boards)).toEqual([
      { stopId: "1836", lines: [{ label: "N2" }] },
    ]);
  });

  it("matches onward lines against live transfer predictions", () => {
    const board = { arrivals: [{ line: "N1" }, { line: "N2" }] };
    expect(boardHasLine(board, { line: "N2" })).toBe(true);
    expect(boardHasLine(board, { label: "29" })).toBe(false);
  });

  it("matches EMT's padded static codes to live arrival labels", () => {
    const stops = [{ stopId: "213", lines: [{ line: "070", label: "070" }] }];
    const boards = new Map([["213", { arrivals: [{ line: "70", seconds: 300 }] }]]);
    expect(stopsWithLiveLines(stops, boards)[0].lines).toEqual([{ line: "070", label: "070" }]);
    expect(boardHasLine(boards.get("213"), { line: "070" })).toBe(true);
    expect(linesMatch({ line: "005" }, { label: "5" })).toBe(true);
  });

  it("sorts nearby access stops by walking distance", () => {
    const result = nearbyAccess([
      stop("far", -3.70, 40.42), stop("near", -3.7001, 40.4001),
    ], { lat: 40.4, lon: -3.7 });
    expect(result.map((item) => item.stopId)).toEqual(["near", "far"]);
  });

  it("ranks a direct ride above a faster transfer", () => {
    const direct = { type: "direct", incidents: [], rankSeconds: 34 * 60, score: 9000 };
    const transfer = { type: "one_transfer", incidents: [], rankSeconds: 21 * 60, score: 1000 };
    expect([transfer, direct].sort(compareJourneyOptions)[0]).toBe(direct);
  });

  it("falls back to transfers, ranked normally, when no direct exists", () => {
    // Directs-first is a hard tier, so the case where there is no direct at
    // all has to keep working: the night N1 -> S10 crossing has none, and
    // "no direct" must mean "rank the transfers", never "no route".
    const slow = { type: "one_transfer", incidents: [], rankSeconds: 40 * 60, score: 100 };
    const quick = { type: "one_transfer", incidents: [], rankSeconds: 12 * 60, score: 9000 };
    const untimed = { type: "one_transfer", incidents: [], rankSeconds: null, score: 1 };
    expect([untimed, slow, quick].sort(compareJourneyOptions))
      .toEqual([quick, slow, untimed]);
  });

  it("still prefers a clean direct over a disrupted one, and both over transfers", () => {
    const clean = { type: "direct", incidents: [], rankSeconds: 40 * 60, score: 9000 };
    const disrupted = { type: "direct", incidents: [{ id: 1 }], rankSeconds: 10 * 60, score: 100 };
    const transfer = { type: "one_transfer", incidents: [], rankSeconds: 5 * 60, score: 10 };
    expect([transfer, disrupted, clean].sort(compareJourneyOptions))
      .toEqual([clean, disrupted, transfer]);
  });

  it("weights walking above riding when ranking, without touching the shown ETA", () => {
    // Same predicted arrival, but one boards 300m further away. The nearer
    // stop must win: nobody walks an extra 300m to arrive at the same time.
    const near = { estimatedSeconds: 1800, originStop: { walkSeconds: 200, distanceM: 260 },
      destinationStop: { distanceM: 100 } };
    const far = { estimatedSeconds: 1800, originStop: { walkSeconds: 430, distanceM: 560 },
      destinationStop: { distanceM: 100 } };
    expect(rankJourneySeconds(near)).toBeLessThan(rankJourneySeconds(far));
    expect(near.estimatedSeconds).toBe(1800);
  });

  it("keeps a direct ride that scores worse than the transfers filling the limit", () => {
    // Reproduces the 29 at Arturo Soria: direct to the destination from 431m
    // away, but a longer ride than several transfers, so a single pool sorted
    // by `score` cut it at rank 9 of 8 — before the live-time ranking that
    // would have chosen it ever saw it.
    const board = { ...stop("board-29", -3.6664, 40.4677, ["29"]), distanceM: 431 };
    const arrive = { ...stop("arrive-29", -3.6790, 40.4470, ["29"]), distanceM: 294 };
    const swap = stop("swap", -3.6700, 40.4600);
    const interchange = { ...stop("interchange", -3.6791, 40.4471, ["T"]), distanceM: 300 };
    // Eight short hops, each one transfer away from the destination, all of
    // them scoring better than the long direct ride.
    const hops = Array.from({ length: 8 }, (_, i) =>
      ({ ...stop(`hop-${i}`, -3.6650, 40.4670, [`H${i}`]), distanceM: 100 + i }));
    const routes = new Map([
      ["29", route("29", [board, ...Array.from({ length: 11 }, (_, i) =>
        stop(`mid-${i}`, -3.667 - i / 1000, 40.466 - i / 1000)), arrive])],
      ["T", route("T", [swap, interchange])],
      ...hops.map((hop, i) => [`H${i}`, route(`H${i}`, [hop, swap])]),
    ]);
    const options = planJourney({
      originStops: [board, ...hops],
      destinationStops: [arrive, interchange],
      routes,
      limit: 8,
    });
    const direct = options.find((option) => option.type === "direct");
    expect(direct?.originStop.stopId).toBe("board-29");
    // ...and it survived despite scoring worse than the transfers that filled
    // the rest of the limit.
    const transfers = options.filter((option) => option.type === "one_transfer");
    expect(transfers.length).toBeGreaterThan(0);
    expect(Math.min(...transfers.map((option) => option.score))).toBeLessThan(direct.score);
  });

  it("preserves a farther direct-line stop before filling by distance", () => {
    const candidates = [
      { stopId: "near-1", distanceM: 50, lines: [{ line: "29" }] },
      { stopId: "near-2", distanceM: 80, lines: [{ line: "70" }] },
      { stopId: "airport", distanceM: 450, lines: [{ line: "125" }] },
    ];
    const destinations = [[{ stopId: "terminal", lines: [{ line: "125" }] }]];
    expect(prioritizeAccessStops(candidates, destinations, 2).map((item) => item.stopId))
      .toEqual(["airport", "near-1"]);
  });

  it("preserves two matching platforms for a destination", () => {
    const candidates = [
      { stopId: "unrelated", distanceM: 20, lines: [{ line: "29" }] },
      { stopId: "outbound", distanceM: 300, lines: [{ line: "107" }] },
      { stopId: "homebound", distanceM: 350, lines: [{ line: "107" }] },
    ];
    const destinations = [[{ stopId: "home", lines: [{ line: "107" }] }]];
    expect(prioritizeAccessStops(candidates, destinations, 2).map((item) => item.stopId))
      .toEqual(["outbound", "homebound"]);
  });

  it("ranks using catchable arrivals rather than a bus the user cannot reach", () => {
    const option = {
      type: "direct",
      originStop: { walkSeconds: 240, distanceM: 200 },
      destinationStop: { distanceM: 130 },
      firstLeg: { stops: 4, arrivals: [120, 420] },
    };
    expect(estimateJourneySeconds(option)).toBe(880);
    expect(option.firstLeg.selectedArrival).toBe(420);
  });

  it("includes live transfer timing in the door-to-door estimate", () => {
    const option = {
      type: "one_transfer",
      originStop: { walkSeconds: 120 },
      destinationStop: { distanceM: 130 },
      firstLeg: { stops: 2, arrivals: [180] },
      transfer: { walkM: 130 },
      secondLeg: { stops: 3, arrivals: [300, 600] },
    };
    expect(estimateJourneySeconds(option)).toBe(970);
    expect(option.secondLeg.selectedArrival).toBe(600);
  });

  it("collapses identical legs produced by different destination stops", () => {
    const common = {
      type: "direct", originStop: { stopId: "213" },
      firstLeg: { line: "070", direction: "toA" },
    };
    const options = [
      { ...common, destinationStop: { stopId: "a" }, estimatedSeconds: 600 },
      { ...common, destinationStop: { stopId: "b" }, estimatedSeconds: 650 },
    ];
    expect(deduplicateJourneyOptions(options)).toEqual([options[0]]);
  });

  it("collapses the same bus sequence boarded at different stops", () => {
    const leg = {
      type: "one_transfer",
      firstLeg: { line: "043", direction: "toA" },
      secondLeg: { line: "009", direction: "toB" },
    };
    const options = [
      { ...leg, originStop: { stopId: "near" }, transfer: {
        fromStop: { stopId: "x1" }, toStop: { stopId: "x1" },
      } },
      { ...leg, originStop: { stopId: "next" }, transfer: {
        fromStop: { stopId: "x2" }, toStop: { stopId: "x2" },
      } },
    ];
    expect(deduplicateJourneyOptions(options)).toEqual([options[0]]);
  });

  it("accepts a direct line only in the direction that reaches the destination", () => {
    const a = { ...stop("a", -3.70, 40.40, ["107"]), distanceM: 80 };
    const z = { ...stop("z", -3.68, 40.46, ["107"]), distanceM: 120 };
    const routes = new Map([["107", route("107", [a, stop("m", -3.69, 40.43), z], [z, a])]]);
    const result = planJourney({ originStops: [a], destinationStops: [z], routes });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "direct", firstLeg: { line: "107", direction: "toA", stops: 2 } });
  });

  it("finds a one-transfer route at nearby stops", () => {
    const home = { ...stop("home", -3.70, 40.40, ["70"]), distanceM: 60 };
    const work = { ...stop("work", -3.66, 40.48, ["27"]), distanceM: 90 };
    const x1 = stop("x1", -3.6800, 40.4500);
    const x2 = stop("x2", -3.6805, 40.4503);
    const routes = new Map([
      ["70", route("70", [home, x1])],
      ["27", route("27", [x2, work])],
    ]);
    const result = planJourney({ originStops: [home], destinationStops: [work], routes });
    expect(result[0]).toMatchObject({
      type: "one_transfer", firstLeg: { line: "70" }, secondLeg: { line: "27" },
      transfer: { fromStop: { stopId: "x1" }, toStop: { stopId: "x2" } },
    });
  });

  it("does not invent a transfer when interchange stops are too far apart", () => {
    const home = { ...stop("home", -3.70, 40.40, ["70"]), distanceM: 60 };
    const work = { ...stop("work", -3.66, 40.48, ["27"]), distanceM: 90 };
    const routes = new Map([
      ["70", route("70", [home, stop("x1", -3.68, 40.45)])],
      ["27", route("27", [stop("x2", -3.67, 40.46), work])],
    ]);
    expect(planJourney({ originStops: [home], destinationStops: [work], routes })).toEqual([]);
  });
});

/* ---- plan(): the whole planner, through its sources --------------------- */

// A made-up corner of Madrid, laid out in metres from Sol so each test can say
// exactly how far apart things are.
const SOL = { lat: 40.4168, lon: -3.7038 };
function at(northM, eastM) {
  return {
    lat: SOL.lat + northM / 111_320,
    lon: SOL.lon + eastM / (111_320 * Math.cos((SOL.lat * Math.PI) / 180)),
  };
}
const busStop = (stopId, northM, eastM, lines) => {
  const { lat, lon } = at(northM, eastM);
  return stop(stopId, lon, lat, lines);
};
const board = (stopId, line, ...seconds) => ({
  stopId, fetchedAt: 0, arrivals: seconds.map((s) => ({ line, seconds: s })),
});

/** In-memory Planner sources. Nearby is an exact straight-line disc; walking
 *  is straight-line unless `walkM` overrides a stop; anything listed in
 *  `failing` rejects. Every read is recorded. */
function world({ stops, routes = {}, boards = {}, walkM = {}, walkingDown = false, failing = [], bikes }) {
  const reads = { nearby: [], board: [], route: [], incidents: [], bikes: 0 };
  const fail = (what) => Promise.reject(new Error(`${what} is down`));
  return {
    reads,
    sources: {
      async nearby(lat, lon, radius) {
        reads.nearby.push(radius);
        return stops.filter((s) => distanceTo(s, { lat, lon }) <= radius);
      },
      board(stopId) {
        reads.board.push(stopId);
        return failing.includes(`board:${stopId}`) ? fail(stopId) : Promise.resolve(boards[stopId] ?? null);
      },
      route(code) {
        reads.route.push(code);
        return failing.includes(`route:${code}`) ? fail(code) : Promise.resolve(routes[code] ?? null);
      },
      incidents(code) {
        reads.incidents.push(code);
        return failing.includes("incidents") ? fail("incidents") : Promise.resolve({ incidents: [] });
      },
      async walking({ origin, destinations }) {
        if (walkingDown) throw new Error("router down");
        return {
          routes: destinations.map((d) => {
            const id = stops.find((s) => s.coordinates[1] === d.lat && s.coordinates[0] === d.lon)?.stopId;
            const metres = walkM[id] ?? distanceTo({ coordinates: [d.lon, d.lat] }, origin);
            return { metres, seconds: metres / 1.3 };
          }),
        };
      },
      ...(bikes === undefined ? {} : {
        bikes() {
          reads.bikes += 1;
          return failing.includes("bikes") ? fail("bikes") : Promise.resolve({ stations: bikes, fetchedAt: 7 });
        },
      }),
    },
  };
}
function distanceTo(s, { lat, lon }) {
  const x = (s.coordinates[0] - lon) * Math.cos((lat * Math.PI) / 180);
  const y = s.coordinates[1] - lat;
  return Math.sqrt(x * x + y * y) * 111_320;
}

// Madrid is UTC+2 in July and UTC+1 in January.
const SUMMER_NOON = new Date("2026-07-15T10:00:00Z");
const SUMMER_1AM = new Date("2026-07-15T23:00:00Z");
const hub = (northM, eastM, extra = {}) => ({ id: "home", name: "Home", ...at(northM, eastM), ...extra });
const planFor = (w, destinations, now, tier = "free") =>
  plan({ origin: SOL, destinations }, { sources: w.sources, tier, now });
const optionsOf = (result) => result.destinations[0].options;

describe("plan: day and night", () => {
  const quiet = () => world({ stops: [] });

  it("searches 800m around the rider by day and 2km at night", async () => {
    const day = quiet();
    await planFor(day, [hub(3000, 0)], SUMMER_NOON);
    expect(day.reads.nearby[0]).toBe(800);
    const night = quiet();
    await planFor(night, [hub(3000, 0)], SUMMER_1AM);
    expect(night.reads.nearby[0]).toBe(2000);
  });

  it("starts the night at midnight in Madrid, whatever the UTC offset", async () => {
    const radiusAt = async (iso) => {
      const w = quiet();
      await planFor(w, [hub(3000, 0)], new Date(iso));
      return w.reads.nearby[0];
    };
    expect(await radiusAt("2026-07-15T21:59:00Z")).toBe(800); // 23:59 CEST
    expect(await radiusAt("2026-07-15T22:00:00Z")).toBe(2000); // 00:00 CEST
    expect(await radiusAt("2026-01-15T22:30:00Z")).toBe(800); // 23:30 CET
    expect(await radiusAt("2026-01-15T23:30:00Z")).toBe(2000); // 00:30 CET
    expect(await radiusAt("2026-07-15T04:00:00Z")).toBe(800); // 06:00 CEST
  });

  // Line A runs from the rider to X; line B from Y, 400m from X, to the hub.
  const interchange = () => world({
    stops: [
      busStop("O", 100, 0, ["A"]),
      busStop("X", 2000, 0, ["A"]), busStop("Y", 2000, 400, ["B"]),
      busStop("D", 4000, 400, ["B"]),
    ],
    routes: {
      A: route("A", [busStop("O", 100, 0), busStop("X", 2000, 0)]),
      B: route("B", [busStop("Y", 2000, 400), busStop("D", 4000, 400)]),
    },
    boards: { O: board("O", "A", 120), Y: board("Y", "B", 900) },
  });

  it("counts a 400m walk between stops as a transfer at night but not by day", async () => {
    expect(optionsOf(await planFor(interchange(), [hub(4000, 400)], SUMMER_NOON))).toEqual([]);
    const night = optionsOf(await planFor(interchange(), [hub(4000, 400)], SUMMER_1AM));
    expect(night.map((o) => o.type)).toEqual(["one_transfer"]);
    expect(Math.abs(night[0].transfer.walkM - 400)).toBeLessThan(5);
  });

  it("drops a transfer whose second board could not be read", async () => {
    const w = interchange();
    w.sources.board = (stopId) => Promise.resolve(stopId === "O" ? board("O", "A", 120) : null);
    expect(optionsOf(await planFor(w, [hub(4000, 400)], SUMMER_1AM))).toEqual([]);
  });
});

describe("plan: choosing between rides", () => {
  it("offers a direct ride ahead of a transfer that arrives sooner", async () => {
    const w = world({
      stops: [
        busStop("O", 100, 0, ["A", "C"]),
        busStop("X", 1000, 0, ["A"]), busStop("Y", 1000, 50, ["B"]),
        busStop("D", 2000, 50, ["B", "C"]),
      ],
      routes: {
        A: route("A", [busStop("O", 100, 0), busStop("X", 1000, 0)]),
        B: route("B", [busStop("Y", 1000, 50), busStop("D", 2000, 50)]),
        C: route("C", [busStop("O", 100, 0), busStop("Q1", 500, 0), busStop("Q2", 900, 0),
          busStop("Q3", 1300, 0), busStop("D", 2000, 50)]),
      },
      boards: {
        O: { stopId: "O", fetchedAt: 0, arrivals: [{ line: "A", seconds: 100 }, { line: "C", seconds: 1500 }] },
        Y: board("Y", "B", 500),
      },
    });
    const options = optionsOf(await planFor(w, [hub(2000, 50)], SUMMER_NOON));
    const transfers = options.filter((o) => o.type === "one_transfer");
    expect(options[0].type).toBe("direct");
    expect(transfers.length).toBeGreaterThan(0);
    expect(Math.min(...transfers.map((o) => o.estimatedSeconds))).toBeLessThan(options[0].estimatedSeconds);
  });
});

describe("plan: walking to the first stop", () => {
  // Four stops on line A; "near" is 300m across the map but 1300m on foot.
  const stops = [
    busStop("near", 300, 0, ["A"]),
    busStop("s1", 0, 400, ["A"]), busStop("s2", 0, -500, ["A"]), busStop("s3", -600, 0, ["A"]),
  ];

  it("skips a stop that is close on the map but past the radius on foot", async () => {
    const w = world({ stops, walkM: { near: 1300 } });
    await planFor(w, [hub(3000, 0)], SUMMER_NOON);
    expect(w.reads.board).not.toContain("near");
    expect(w.reads.board).toEqual(expect.arrayContaining(["s1", "s2", "s3"]));
  });

  it("takes the three nearest on foot when fewer than three are in range", async () => {
    const w = world({ stops, walkM: { near: 1300, s1: 900, s2: 950, s3: 2000 } });
    await planFor(w, [hub(3000, 0)], SUMMER_NOON);
    expect(w.reads.board.sort()).toEqual(["near", "s1", "s2"]);
  });

  it("falls back to the straight-line radius when the walking router is down", async () => {
    const w = world({ stops, walkM: { near: 1300 }, walkingDown: true });
    await planFor(w, [hub(3000, 0)], SUMMER_NOON);
    expect(w.reads.board).toContain("near");
  });
});

describe("plan: a failing read costs only its own options", () => {
  // Two direct lines from two different stops: C from O1, E from O2.
  const twoLines = (failing) => world({
    stops: [
      busStop("O1", 100, 0, ["C"]), busStop("O2", 0, 150, ["E"]),
      busStop("D", 3000, 0, ["C", "E"]),
    ],
    routes: {
      C: route("C", [busStop("O1", 100, 0), busStop("D", 3000, 0)]),
      E: route("E", [busStop("O2", 0, 150), busStop("D", 3000, 0)]),
    },
    boards: { O1: board("O1", "C", 300), O2: board("O2", "E", 400) },
    failing,
  });
  const lines = async (failing) =>
    optionsOf(await planFor(twoLines(failing), [hub(3000, 0)], SUMMER_NOON)).map((o) => o.firstLeg.line).sort();

  it("keeps the other line when one route fails", async () => {
    expect(await lines(["route:C"])).toEqual(["E"]);
  });

  it("keeps the other stop when one board fails", async () => {
    expect(await lines(["board:O2"])).toEqual(["C"]);
  });

  it("still plans when incidents cannot be read", async () => {
    expect(await lines(["incidents"])).toEqual(["C", "E"]);
  });
});

describe("plan: input", () => {
  const empty = () => world({ stops: [] });
  const hubs = (n) => Array.from({ length: n }, (_, i) => hub(1000 + i * 100, 0, { id: `h${i}` }));

  it("takes up to three hubs on the free tier and twelve on paid", async () => {
    expect((await planFor(empty(), hubs(3), SUMMER_NOON, "free")).maxDestinations).toBe(3);
    await expect(planFor(empty(), hubs(4), SUMMER_NOON, "free")).rejects.toMatchObject({ kind: "bad_request" });
    expect((await planFor(empty(), hubs(12), SUMMER_NOON, "paid")).destinations).toHaveLength(12);
    await expect(planFor(empty(), hubs(13), SUMMER_NOON, "paid")).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("treats an unknown tier as free", async () => {
    await expect(planFor(empty(), hubs(4), SUMMER_NOON, "enterprise")).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("rejects coordinates that are not on Earth", async () => {
    await expect(plan({ origin: { lat: 91, lon: 0 }, destinations: hubs(1) },
      { sources: empty().sources, tier: "free", now: SUMMER_NOON })).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("stamps the plan with the time it was asked for", async () => {
    expect((await planFor(empty(), hubs(1), SUMMER_NOON)).generatedAt).toBe(SUMMER_NOON.getTime());
  });
});

describe("plan: BiciMAD and walking", () => {
  const station = (id, northM, eastM, extra = {}) => {
    const { lat, lon } = at(northM, eastM);
    return { id, number: id, name: `Station ${id}`, coordinates: [lon, lat],
      bikes: 8, freeBases: 8, renting: true, returning: true, inService: true, ...extra };
  };
  const bikeWorld = (bikes, failing = []) => world({ stops: [], bikes, failing });

  it("rents near the rider and docks near the destination", async () => {
    const w = bikeWorld([
      station("empty", 50, 0, { bikes: 0 }),
      station("closed", 60, 0, { renting: false }),
      station("near", 200, 0),
      station("full", 3950, 0, { freeBases: 0 }),
      station("dock", 3800, 0),
    ]);
    const result = await planFor(w, [hub(4000, 0)], SUMMER_NOON);
    const { bike } = result.destinations[0];
    expect(bike).toMatchObject({ pickup: { id: "near" }, dropoff: { id: "dock" }, fetchedAt: 7 });
    // ~520m on foot, two minutes at the stations and ~4.68km in the saddle
    // (each 1.3× the straight line; the fixture grid is off haversine by ~0.1%,
    // so these are checked to the nearest few metres).
    expect(bike.pickup.walkM).toBeCloseTo(260, -1);
    expect(bike.rideM).toBeCloseTo(4680, -2);
    expect(bike.estimatedSeconds).toBeCloseTo(520 / 1.3 + 120 + 4680 / 4.2, -1);
    expect(w.reads.bikes).toBe(1);
  });

  it("walks a little further rather than chase the last bike", async () => {
    const w = bikeWorld([
      station("last", 50, 0, { bikes: 1 }),
      station("plenty", 150, 0),
      station("dock", 4000, 0),
    ]);
    const result = await planFor(w, [hub(4000, 0)], SUMMER_NOON);
    expect(result.destinations[0].bike.pickup.id).toBe("plenty");
  });

  it("offers no bike for a trip too short to unlock one, but still the walk", async () => {
    const w = bikeWorld([station("a", 0, 0), station("b", 300, 0)]);
    const result = await planFor(w, [hub(300, 0)], SUMMER_NOON);
    expect(result.destinations[0].bike).toBeNull();
    expect(result.destinations[0].walk.metres).toBeCloseTo(390, -1);
    expect(result.destinations[0].walk.seconds).toBeCloseTo(300, -1);
  });

  it("still plans the buses when bike counts cannot be read", async () => {
    const result = await planFor(bikeWorld([station("a", 0, 0)], ["bikes"]), [hub(4000, 0)], SUMMER_NOON);
    expect(result.destinations[0].bike).toBeNull();
    expect(result.destinations[0].walk.metres).toBeCloseTo(5200, -2);
  });
});
