import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { emtClient, getArrivals, getStopDetail, getNearbyStops, clearTokenMemoryForTest,
  getLineIncidents,
  getLineTimetable,
  getLineRoute } from "../src/emt.js";
import { EmtError } from "../src/errors.js";
import loginOk from "./fixtures/login-ok.json";
import loginBadPassword from "./fixtures/login-bad-password.json";
import arrivalsOk from "./fixtures/arrivals-ok.json";
import arrivalsEmpty from "./fixtures/arrivals-empty.json";
import stopDetailOk from "./fixtures/stop-detail-ok.json";
import arroundxyOk from "./fixtures/arroundxy-ok.json";
import timetableNight from "./fixtures/timetable-night.json";
import timetableDay from "./fixtures/timetable-day.json";
import routeOk from "./fixtures/route-ok.json";

function mockFetch(body, init = {}) {
  // A fresh Response per call: response bodies are single-use.
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify(body), { status: 200, ...init })
  );
}

// The shared login; per-user Accounts are covered in emt-account.test.js.
const emt = emtClient(env);

beforeEach(() => clearTokenMemoryForTest());

describe("the shared login's token", () => {
  beforeEach(async () => {
    await env.KV.delete("emt:token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Login answers `login`; every other call answers arrivals. */
  function mockEmt(login = loginOk) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      new Response(JSON.stringify(String(url).includes("/user/login/") ? login : arrivalsOk)));
  }
  const logins = (spy) => spy.mock.calls.filter(([url]) => String(url).includes("/user/login/"));

  it("logs in and spends the access token", async () => {
    const spy = mockEmt();
    await getArrivals(emt, "1234");
    expect(spy.mock.calls.at(-1)[1].headers.accessToken).toBe("fake-token-abc123");
  });

  it("sends credentials as headers, not as a body", async () => {
    const spy = mockEmt();
    await getArrivals(emt, "1234");
    const [url, init] = logins(spy)[0];
    expect(url).toContain("v1/mobilitylabs/user/login/");
    expect(init.method).toBe("GET");
    expect(init.headers.email).toBe(env.EMT_EMAIL);
    expect(init.headers.password).toBe(env.EMT_PASSWORD);
    expect(init.body).toBeUndefined();
  });

  it("sends every call to EMT_BASE when it is set", async () => {
    const spy = mockEmt();
    await getArrivals(emtClient({ ...env, EMT_BASE: "http://fake.test/" }), "1234");
    const urls = spy.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "http://fake.test/v1/mobilitylabs/user/login/",
      "http://fake.test/v2/transport/busemtmad/stops/1234/arrives/",
    ]);
  });

  it("caches the token in KV so a second call does not log in", async () => {
    const spy = mockEmt();
    await getArrivals(emt, "1234");
    clearTokenMemoryForTest();
    await getArrivals(emt, "1234");
    expect(logins(spy)).toHaveLength(1);
    expect(await env.KV.get("emt:token")).toBe("fake-token-abc123");
  });

  it("shares one login between concurrent calls", async () => {
    const spy = mockEmt();
    await Promise.all([getArrivals(emt, "1"), getArrivals(emt, "2"), getArrivals(emt, "3")]);
    expect(logins(spy)).toHaveLength(1);
  });

  it("throws an auth error on code 89, a 200 response", async () => {
    mockEmt(loginBadPassword);
    await expect(getArrivals(emt, "1234")).rejects.toMatchObject({
      name: "EmtError",
      kind: "auth",
    });
  });

  it("throws a quota error on code 98", async () => {
    mockEmt({ code: "98", description: "limit", data: [] });
    await expect(getArrivals(emt, "1234")).rejects.toMatchObject({ kind: "quota" });
  });

  it("throws an upstream error on a non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("gateway timeout", { status: 504 })
    );
    await expect(getArrivals(emt, "1234")).rejects.toMatchObject({ kind: "upstream" });
  });
});

describe("getArrivals", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses line, seconds, and metres from data[0].Arrive[]", async () => {
    mockFetch(arrivalsOk);
    const result = await getArrivals(emt, "1234");
    expect(result.arrivals[0]).toEqual({
      line: "27",
      seconds: 145,
      metres: 610,
      destination: "PLAZA CASTILLA",
      vehicleId: "4802",
      coordinates: [-3.6899, 40.4477],
    });
  });

  it("sorts soonest-first and keeps everything EMT sent", async () => {
    // Trimming is the route layer's job: the cards take two, the sheet takes all.
    mockFetch(arrivalsOk);
    const { arrivals } = await getArrivals(emt, "1234");
    expect(arrivals.map((a) => a.seconds)).toEqual([145, 640, 1980]);
  });

  it("stamps fetchedAt so the page can show staleness", async () => {
    mockFetch(arrivalsOk);
    const before = Date.now();
    const { fetchedAt } = await getArrivals(emt, "1234");
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("posts stopId and the estimations flag in the body", async () => {
    const spy = mockFetch(arrivalsOk);
    await getArrivals(emt, "1234");
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v2/transport/busemtmad/stops/1234/arrives/");
    expect(init.method).toBe("POST");
    expect(init.headers.accessToken).toBe("cached-token");
    expect(JSON.parse(init.body)).toEqual({
      stopId: "1234",
      Text_EstimationsRequired_YN: "Y",
    });
  });

  it("returns an empty list, not an error, when nothing is due", async () => {
    mockFetch(arrivalsEmpty);
    const { arrivals } = await getArrivals(emt, "1234");
    expect(arrivals).toEqual([]);
  });

  it("re-logs in once and retries when the token is rejected with code 80", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify(arrivalsOk)));

    const { arrivals } = await getArrivals(emt, "1234");
    expect(arrivals).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("gives up with not_found after one failed retry", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })));

    await expect(getArrivals(emt, "9999")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("tolerates a missing DistanceBus", async () => {
    mockFetch({
      code: "00",
      data: [{ Arrive: [{ line: "27", estimateArrive: 100 }] }],
    });
    const { arrivals } = await getArrivals(emt, "1234");
    expect(arrivals[0]).toEqual({
      line: "27",
      seconds: 100,
      metres: null,
      destination: null,
      vehicleId: null,
      coordinates: null,
    });
  });
});

describe("getArrivals success codes", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats code 01 'No estimations found' as an empty success", async () => {
    // Verbatim shape observed live from EMT at night hours, 2026-08-23.
    mockFetch({
      code: "01",
      description: "No estimations found (lapsed: 90 millsecs)",
      datetime: "2026-08-23T00:28:43.293626",
      data: [{ Arrive: [], StopInfo: [], ExtraInfo: [], Incident: {} }],
    });
    const { arrivals } = await getArrivals(emt, "213");
    expect(arrivals).toEqual([]);
  });

  it("still rejects genuinely unknown codes", async () => {
    mockFetch({ code: "42", description: "???", data: [] });
    await expect(getArrivals(emt, "1234")).rejects.toMatchObject({
      kind: "upstream",
      message: expect.stringContaining("42"),
    });
  });
});

describe("getStopDetail", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses name, address, coordinates, and dataLine from data[0].stops[0]", async () => {
    mockFetch(stopDetailOk);
    const detail = await getStopDetail(emt, "1547");
    expect(detail).toMatchObject({
      stopId: "31",
      name: "Plaza Castilla",
      address: "Mateo Inurria, 1 frente Canal de Isabel II",
      coordinates: [-3.68832522654066, 40.4664651874285],
    });
    // The label is what the bus is signed with; the code is what EMT keys on.
    expect(detail.lines[0]).toEqual({
      line: "005",
      label: "5",
      from: "07:30",
      to: "23:30",
      dayType: "FE",
      headers: ["SOL/SEVILLA", "CHAMARTIN"],
      direction: "A",
    });
    expect(detail.lines.map((l) => l.label)).toEqual(["5", "66", "70"]);
  });

  it("reads dataLine, not the lines[] the docs describe", async () => {
    // A v2 detail answer never carries lines[]; reading it left every stop
    // looking like it had no service at all.
    mockFetch({
      code: "00",
      data: [{ stops: [{ stop: "9", name: "X", dataLine: [{ line: "070", label: "70" }] }] }],
    });
    const detail = await getStopDetail(emt, "9");
    expect(detail.lines.map((l) => l.label)).toEqual(["70"]);
  });

  it("GETs the v2 detail URL with the cached token", async () => {
    const spy = mockFetch(stopDetailOk);
    await getStopDetail(emt, "1547");
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v2/transport/busemtmad/stops/1547/detail/");
    expect(init.method).toBe("GET");
    expect(init.headers.accessToken).toBe("cached-token");
  });

  it("re-logs in once and retries when the token is rejected with code 80", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify(stopDetailOk)));
    const detail = await getStopDetail(emt, "1547");
    expect(detail.name).toBe("Plaza Castilla");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("gives up with not_found when code 80 persists after a re-login", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })));
    await expect(getStopDetail(emt, "9999")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("maps code 81 (no such record) straight to not_found without a retry", async () => {
    const spy = mockFetch({
      code: "81",
      description: "There are no such records",
      data: [],
    });
    await expect(getStopDetail(emt, "99999999")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a success code carrying no stops data", async () => {
    mockFetch({ code: "00", description: "Data recovered OK", data: [{}] });
    await expect(getStopDetail(emt, "1547")).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("EMT 5xx blip retry", () => {
  // Cloudflare's edge intermittently fails its own TLS handshake to EMT with
  // a 5xx (HTTP 525); one retry gets through.
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries arrivals once on a 502 and succeeds", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(arrivalsOk)));
    const { arrivals } = await getArrivals(emt, "1234");
    expect(arrivals).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry when both attempts are 5xx", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("gateway timeout", { status: 504 }));
    await expect(getArrivals(emt, "1234")).rejects.toMatchObject({
      kind: "upstream",
      message: expect.stringContaining("504"),
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not burn a retry on a 4xx", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(getArrivals(emt, "1234")).rejects.toMatchObject({
      kind: "upstream",
      message: expect.stringContaining("403"),
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("getNearbyStops", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses id, name, lines, and coordinates from data[]", async () => {
    mockFetch(arroundxyOk);
    const stops = await getNearbyStops(emt, { lat: 40.46737, lon: -3.68967, radius: 500 });
    expect(stops).toEqual([
      {
        stopId: "30",
        name: "Plaza Castilla",
        // Area search sends bare codes: no label, no service hours to be had.
        // Only the fields it can actually fill are serialised — the null hours
        // stop-detail entries carry were 130KB of padding in a 3km answer.
        lines: ["107", "129", "005", "070"].map((code) => ({
          line: code,
          label: code,
        })),
        coordinates: [-3.68967, 40.46737],
      },
      {
        stopId: "31",
        name: "Plaza Castilla",
        lines: ["107", "129", "174"].map((code) => ({
          line: code,
          label: code,
        })),
        coordinates: [-3.6891, 40.4676],
      },
    ]);
  });

  it("GETs the v2 arroundxy URL — v1 silently returns no records", async () => {
    const spy = mockFetch({ code: "00", data: [] });
    await getNearbyStops(emt, { lat: 40.4674, lon: -3.6897, radius: 500 });
    const [url] = spy.mock.calls[0];
    expect(url).toContain("v2/transport/busemtmad/stops/arroundxy/-3.6897/40.4674/500/");
  });

  it("passes a 2 km experimental radius through to EMT", async () => {
    const spy = mockFetch({ code: "00", data: [] });
    await getNearbyStops(emt, { lat: 40.4674, lon: -3.6897, radius: 2000 });
    expect(spy.mock.calls[0][0]).toContain("/-3.6897/40.4674/2000/");
  });

  it("returns an empty list when nothing is around", async () => {
    mockFetch({ code: "00", description: "OK", data: [] });
    const stops = await getNearbyStops(emt, { lat: 40.0, lon: -3.0, radius: 100 });
    expect(stops).toEqual([]);
  });

  it("treats code 01 as an empty nearby result", async () => {
    mockFetch({ code: "01", description: "No records", data: [] });
    const stops = await getNearbyStops(emt, { lat: 40.0, lon: -3.0, radius: 700 });
    expect(stops).toEqual([]);
  });

  it("tolerates EMT sending lines as objects", async () => {
    mockFetch({
      code: "00",
      data: [{ stopId: "30", stopName: "Plaza Castilla", lines: [{ line: "107" }] }],
    });
    const stops = await getNearbyStops(emt, { lat: 40.4674, lon: -3.6897, radius: 500 });
    expect(stops[0].lines.map((l) => l.label)).toEqual(["107"]);
  });
});

describe("getLineIncidents", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T13:00:00Z")); // 15:00 in Madrid
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses v1 and returns only incidents active in Madrid local time", async () => {
    const spy = mockFetch({
      code: "00",
      data: [{ item: [
        {
          guid: "active", title: "Active diversion",
          rssAfectaDesde: "25/08/2026 14:00:00", rssAfectaHasta: "25/08/2026 16:00:00",
          GoogleTransitCause: "08 - Obras", GoogleTransitEffect: "05 - Desvío programado",
          link: "https://example.test/active",
        },
        {
          guid: "stale", title: "Old diversion",
          rssAfectaDesde: "22/08/2026 0:00:00", rssAfectaHasta: "24/08/2026 6:00:00",
        },
      ] }],
    });
    const result = await getLineIncidents(emt, "125");
    expect(spy.mock.calls[0][0]).toContain("v1/transport/busemtmad/lines/incidents/125/");
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toMatchObject({ id: "active", title: "Active diversion" });
  });
});

describe("getLineTimetable", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => vi.restoreAllMocks());

  it("GETs the v2 timetable URL", async () => {
    const spy = mockFetch(timetableDay);
    await getLineTimetable(emt, "833");
    expect(spy.mock.calls[0][0]).toContain("v2/transport/busemtmad/lines/833/timetable/");
  });

  it("widens the window across both directions", async () => {
    mockFetch(timetableDay);
    const { days } = await getLineTimetable(emt, "833");
    // A runs 07:00–20:00, B 07:30–20:30; the line is out there 07:00–20:30.
    expect(days).toEqual([
      {
        dayType: "LA",
        from: "07:00",
        to: "20:30",
        overnight: false,
        validFrom: "01/01/2026",
        validTo: "31/12/2026",
      },
    ]);
  });

  it("keeps a night line's window the right way round", async () => {
    mockFetch(timetableNight);
    const { days } = await getLineTimetable(emt, "523");
    const fe = days.find((d) => d.dayType === "FE");
    // 23:40 on one date to 05:45 on the next — not a 22-hour daytime span.
    expect(fe).toMatchObject({ from: "23:40", to: "05:45", overnight: true });
  });

  it("marks a Friday-night window that ends the next morning as overnight", async () => {
    mockFetch(timetableNight);
    const { days } = await getLineTimetable(emt, "523");
    // 04:40 Friday through 06:15 Saturday: the clocks are in order, the dates
    // are not — this is a day-long window, not a 95-minute one.
    expect(days.find((d) => d.dayType === "V")).toMatchObject({
      from: "04:40",
      to: "06:15",
      overnight: true,
    });
  });

  it("carries every day type EMT has, including Friday nights", async () => {
    mockFetch(timetableNight);
    const { days } = await getLineTimetable(emt, "523");
    expect(days.map((d) => d.dayType)).toEqual(["V", "FE", "LA"]);
  });

  it("reports a line EMT does not know as not_found", async () => {
    mockFetch({ code: "80", description: "no records", data: [] });
    await expect(getLineTimetable(emt, "9999")).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("getLineRoute", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => vi.restoreAllMocks());

  it("GETs the v2 route URL", async () => {
    const spy = mockFetch(routeOk);
    await getLineRoute(emt, "027");
    expect(spy.mock.calls[0][0]).toContain("v2/transport/busemtmad/lines/027/route/");
  });

  it("flattens both directions into drawable segments", async () => {
    mockFetch(routeOk);
    const route = await getLineRoute(emt, "027");
    expect(route).toMatchObject({ line: "027", label: "27", nameB: "PLAZA DE CASTILLA" });
    expect(route.paths.toA).toHaveLength(2); // the one-point feature is not a line
    expect(route.paths.toA[1]).toHaveLength(3);
    expect(route.paths.toB).toHaveLength(1);
  });

  it("rounds coordinates to about ten centimetres", async () => {
    mockFetch(routeOk);
    const { paths } = await getLineRoute(emt, "027");
    expect(paths.toA[0][0]).toEqual([-3.68928, 40.46644]);
  });

  it("carries the stops the line calls at, which ride along for free", async () => {
    mockFetch(routeOk);
    const { stops } = await getLineRoute(emt, "027");
    // The feature with no stopNum is a shape point, not a stop.
    expect(stops.toA).toEqual([
      { stopId: "5602", name: "Plaza Castilla", coordinates: [-3.68928, 40.466632] },
      { stopId: "86", name: "Embajadores", coordinates: [-3.702417, 40.405435] },
    ]);
    expect(stops.toB.map((s) => s.stopId)).toEqual(["86"]);
  });

  it("reports a line with no itinerary as not_found", async () => {
    mockFetch({ code: "00", data: { line: "027" } });
    await expect(getLineRoute(emt, "027")).rejects.toMatchObject({ kind: "not_found" });
  });
});
