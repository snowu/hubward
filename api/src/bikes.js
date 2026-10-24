import { EmtError } from "./errors.js";
import { emtFetch } from "./emt.js";

// PBSC runs BiciMAD, and publishes the system's own GBFS feed. It is the
// better source: MobilityLabs' dock_bikes counts bikes that are docked, not
// bikes you can rent, and on 227 of 680 stations those differ — 859 bikes
// city-wide are flagged broken. GBFS also says whether a station is renting
// or accepting returns at all. No CORS headers, so the worker proxies it.
const GBFS = "https://madrid.publicbikesystem.net/customer/ube/gbfs/v1/en";
// GBFS_BASE replaces it for the load test (loadtest/). Unset in production.

/** One BiciMAD station, trimmed to what the page draws.
 *
 * EMT's raw record carries a dozen fields the page has no use for
 * (virtualDelete, geofenced_capacity, an always-empty image). 680 stations of
 * them is 318KB; this is about a fifth of that.
 */
function parseStation(raw) {
  return {
    id: String(raw.id),
    // `number` is what is painted on the station; `id` is EMT's key. They
    // differ (station 1409 is signed "5"), and both are worth keeping.
    number: String(raw.number ?? raw.id),
    name: raw.name ?? null,
    address: raw.address ?? null,
    // GeoJSON order: [lon, lat], as everywhere else in this API.
    coordinates: raw.geometry?.coordinates ?? null,
    bikes: Number(raw.dock_bikes ?? 0),
    freeBases: Number(raw.free_bases ?? 0),
    totalBases: Number(raw.total_bases ?? 0),
    reserved: Number(raw.reservations_count ?? 0),
    // 0 green, 1 amber, 2 red, 3 black — EMT's own occupancy signal.
    light: Number(raw.light ?? 0),
    // no_available is EMT's "out of service" flag, inverted here so the page
    // reads it the way it renders it.
    inService: Number(raw.no_available ?? 0) === 0 && raw.virtualDelete !== true,
    overflow: raw.overflow === true,
  };
}

async function gbfs(env, path) {
  const res = await emtFetch(`${env?.GBFS_BASE || GBFS}/${path}`, { method: "GET" });
  if (!res.ok) throw new EmtError("upstream", `GBFS ${path} HTTP ${res.status}`);
  return res.json();
}

/** Names, addresses and positions. These change when a station is built, so
 *  the caller holds them for a day. */
export async function getBikeStationInfo(env) {
  const body = await gbfs(env, "station_information");
  const stations = body.data?.stations ?? [];
  if (stations.length === 0) throw new EmtError("upstream", "GBFS sent no stations");
  return {
    stations: stations.map((s) => ({
      id: String(s.station_id),
      // short_name is what is painted on the station; the id is the key.
      number: String(s.short_name ?? s.station_id),
      name: s.name ?? null,
      address: s.address ?? null,
      // GeoJSON order, to match every other coordinate in this API.
      coordinates: [s.lon, s.lat],
      totalBases: Number(s.capacity ?? 0),
    })),
    fetchedAt: Date.now(),
  };
}

/** Live counts. `num_bikes_available` already excludes broken bikes, which is
 *  the whole reason for preferring this feed. */
export async function getBikeStationStatus(env, { forTracking = false } = {}) {
  const body = await gbfs(env, "station_status");
  if (forTracking && body.last_updated != null && Date.now() / 1000 - Number(body.last_updated) > 120) {
    throw new EmtError("upstream", "GBFS status is stale");
  }
  const stations = body.data?.stations ?? [];
  if (stations.length === 0) throw new EmtError("upstream", "GBFS sent no status");
  return {
    status: stations.map((s) => ({
      id: String(s.station_id),
      bikes: s.num_bikes_available == null ? null : Number(s.num_bikes_available),
      broken: Number(s.num_bikes_disabled ?? 0),
      freeBases: Number(s.num_docks_available ?? 0),
      brokenDocks: Number(s.num_docks_disabled ?? 0),
      // A station can be installed but refusing one direction or both.
      renting: s.is_renting === 1,
      returning: s.is_returning === 1,
      inService: s.is_installed === 1 && s.status === "IN_SERVICE",
    })),
    fetchedAt: Date.now(),
  };
}

/** Join the two feeds into what the page draws. */
export function mergeBikeStations(info, status) {
  const byId = new Map(status.status.map((s) => [s.id, s]));
  return {
    stations: info.stations
      .filter((s) => byId.has(s.id))
      .map((s) => ({ ...s, ...byId.get(s.id), reserved: 0, light: 0, overflow: false })),
    fetchedAt: status.fetchedAt,
  };
}

/** Every BiciMAD station from MobilityLabs — the fallback when GBFS is down.
 *
 * All 680 arrive in one answer, so there is no reason to ask EMT per area —
 * the worker caches this once and slices it for whatever the page asks about.
 */
export async function getBikeStations(emt) {
  const body = await emt.call("v2/transport/bicimad/stations/", { what: "BiciMAD stations" });

  return {
    stations: (body.data ?? []).filter((s) => s?.id != null).map(parseStation),
    fetchedAt: Date.now(),
  };
}

function metresBetween([lon1, lat1], [lon2, lat2]) {
  // Equirectangular approximation: over a few kilometres in Madrid the error
  // is centimetres, and it costs a fraction of what haversine does per station.
  const x = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y) * 111_320;
}

/** Stations within `radius` metres of a point, nearest first. */
export function stationsNear(stations, { lat, lon, radius = 700, limit = 40 }) {
  return stations
    .filter((s) => Array.isArray(s.coordinates))
    .map((s) => ({ ...s, metres: Math.round(metresBetween([lon, lat], s.coordinates)) }))
    .filter((s) => s.metres <= radius)
    .sort((a, b) => a.metres - b.metres)
    .slice(0, limit);
}
