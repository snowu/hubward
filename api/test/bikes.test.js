import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getBikeStations,
  getBikeStationInfo,
  getBikeStationStatus,
  mergeBikeStations,
  stationsNear,
} from "../src/bikes.js";
import { clearTokenMemoryForTest, emtClient } from "../src/emt.js";

const emt = emtClient(env);

// Recorded live from EMT 2026-08-23; two stations, fields left as EMT sends them.
const stationsOk = {
  code: "00",
  description: "2 bases recovered",
  data: [
    {
      activate: 1,
      address: "Calle Fuencarral nº 106",
      dock_bikes: 2,
      free_bases: 23,
      geometry: { type: "Point", coordinates: [-3.7021354, 40.4285212] },
      id: 1409,
      light: 0,
      name: "5 - Fuencarral",
      no_available: 0,
      number: "5",
      reservations_count: 0,
      total_bases: 27,
      virtualDelete: false,
      overflow: false,
    },
    {
      address: "Calle Mayor, 6",
      dock_bikes: 0,
      free_bases: 21,
      geometry: { type: "Point", coordinates: [-3.7075, 40.4169] },
      id: 1,
      light: 2,
      name: "1 - Metro Sol",
      no_available: 1,
      number: "1",
      reservations_count: 3,
      total_bases: 24,
      virtualDelete: false,
      overflow: true,
    },
  ],
};

function mockFetch(body, init = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init })
  );
}

beforeEach(async () => {
  clearTokenMemoryForTest();
  await env.KV.put("emt:token", "cached-token");
});
afterEach(() => vi.restoreAllMocks());

describe("getBikeStations", () => {
  it("trims EMT's record to what the page draws", async () => {
    mockFetch(stationsOk);
    const { stations } = await getBikeStations(emt);
    expect(stations[0]).toEqual({
      id: "1409",
      // The number painted on the station is not EMT's key: 1409 is signed "5".
      number: "5",
      name: "5 - Fuencarral",
      address: "Calle Fuencarral nº 106",
      coordinates: [-3.7021354, 40.4285212],
      bikes: 2,
      freeBases: 23,
      totalBases: 27,
      reserved: 0,
      light: 0,
      inService: true,
      overflow: false,
    });
  });

  it("reads no_available as out of service", async () => {
    mockFetch(stationsOk);
    const { stations } = await getBikeStations(emt);
    expect(stations[1]).toMatchObject({ id: "1", inService: false, reserved: 3, overflow: true });
  });

  it("GETs the v2 stations URL and stamps the fetch time", async () => {
    const spy = mockFetch(stationsOk);
    const before = Date.now();
    const { fetchedAt } = await getBikeStations(emt);
    expect(spy.mock.calls[0][0]).toContain("v2/transport/bicimad/stations/");
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("raises on an unexpected code rather than serving an empty city", async () => {
    mockFetch({ code: "42", data: [] });
    await expect(getBikeStations(emt)).rejects.toMatchObject({ kind: "upstream" });
  });

  it("reports a spent quota as quota, like every other EMT call", async () => {
    mockFetch({ code: "98", data: [] });
    await expect(getBikeStations(emt)).rejects.toMatchObject({ kind: "quota" });
  });
});

describe("stationsNear", () => {
  const stations = [
    { id: "a", coordinates: [-3.7038, 40.4168] },
    { id: "b", coordinates: [-3.7048, 40.4168] }, // ~85m west
    { id: "c", coordinates: [-3.8038, 40.4168] }, // ~8km west
    { id: "d", coordinates: null },
  ];

  it("returns what is inside the radius, nearest first, with distances", async () => {
    const near = stationsNear(stations, { lat: 40.4168, lon: -3.7038, radius: 500 });
    expect(near.map((s) => s.id)).toEqual(["a", "b"]);
    expect(near[0].metres).toBe(0);
    expect(near[1].metres).toBeGreaterThan(50);
    expect(near[1].metres).toBeLessThan(120);
  });

  it("skips stations EMT gave no coordinates for", async () => {
    const near = stationsNear(stations, { lat: 40.4168, lon: -3.7038, radius: 20000 });
    expect(near.map((s) => s.id)).not.toContain("d");
  });

  it("honours the limit", async () => {
    expect(stationsNear(stations, { lat: 40.4168, lon: -3.7038, radius: 20000, limit: 1 }))
      .toHaveLength(1);
  });
});

// Recorded live from PBSC's GBFS feed for Madrid, 2026-08-23.
const gbfsInfo = {
  data: {
    stations: [
      {
        station_id: "1406",
        name: "2 - Metro Callao",
        address: "Calle Miguel Moya nº 1",
        lat: 40.4204,
        lon: -3.70569,
        capacity: 27,
        short_name: "2",
      },
      { station_id: "999", name: "gone tomorrow", lat: 40.4, lon: -3.7, capacity: 10, short_name: "9" },
    ],
  },
};

const gbfsStatus = {
  data: {
    stations: [
      {
        station_id: "1406",
        num_bikes_available: 2,
        num_bikes_disabled: 5,
        num_docks_available: 22,
        num_docks_disabled: 0,
        status: "IN_SERVICE",
        is_installed: 1,
        is_renting: 1,
        is_returning: 1,
      },
    ],
  },
};

describe("GBFS station feeds", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads names, positions and the painted number", async () => {
    mockFetch(gbfsInfo);
    const { stations } = await getBikeStationInfo();
    expect(stations[0]).toEqual({
      id: "1406",
      number: "2",
      name: "2 - Metro Callao",
      address: "Calle Miguel Moya nº 1",
      coordinates: [-3.70569, 40.4204],
      totalBases: 27,
    });
  });

  it("keeps rentable and broken bikes apart", async () => {
    mockFetch(gbfsStatus);
    const { status } = await getBikeStationStatus();
    // MobilityLabs would call this 7 bikes; only 2 of them can be rented.
    expect(status[0]).toMatchObject({
      id: "1406",
      bikes: 2,
      broken: 5,
      freeBases: 22,
      renting: true,
      returning: true,
      inService: true,
    });
  });

  it("reads from GBFS_BASE when it is set", async () => {
    const spy = mockFetch(gbfsStatus);
    await getBikeStationStatus({ GBFS_BASE: "http://fake.test/gbfs" });
    expect(String(spy.mock.calls[0][0])).toBe("http://fake.test/gbfs/station_status");
  });

  it("treats a station that is not renting as such", async () => {
    mockFetch({
      data: {
        stations: [
          { station_id: "1", num_bikes_available: 4, status: "IN_SERVICE", is_installed: 1, is_renting: 0, is_returning: 1 },
        ],
      },
    });
    const { status } = await getBikeStationStatus();
    expect(status[0]).toMatchObject({ renting: false, returning: true });
  });

  it("refuses an empty feed rather than emptying the city", async () => {
    mockFetch({ data: { stations: [] } });
    await expect(getBikeStationStatus()).rejects.toMatchObject({ kind: "upstream" });
    mockFetch({ data: { stations: [] } });
    await expect(getBikeStationInfo()).rejects.toMatchObject({ kind: "upstream" });
  });

  it("merges on station id, dropping what the other feed does not know", async () => {
    mockFetch(gbfsInfo);
    const info = await getBikeStationInfo();
    vi.restoreAllMocks();
    mockFetch(gbfsStatus);
    const status = await getBikeStationStatus();

    const merged = mergeBikeStations(info, status);
    expect(merged.stations).toHaveLength(1);
    expect(merged.stations[0]).toMatchObject({
      id: "1406",
      name: "2 - Metro Callao",
      bikes: 2,
      broken: 5,
      totalBases: 27,
    });
  });
});
