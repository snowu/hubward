import { validateWatch, watchLimits, validLocation } from "./tracking.js";
import { validateSubscription } from "./push.js";
export { TrackingRunner } from "./tracking.js";
export { BikeFeed, StopPoller } from "./pollers.js";
export { LiveStop } from "./live.js";
import { openLiveSocket } from "./live.js";
import {
  getArrivals,
  getStopDetail,
  getNearbyStops,
  getLineIncidents,
  getLineTimetable,
  getLineRoute,
} from "./emt.js";
import {
  listStops,
  addStop,
  renameStop,
  removeStop,
  listBikeStations,
  addBikeStation,
  renameBikeStation,
  removeBikeStation,
  listBikeRatings,
  rateBike,
  listPlaces,
  addPlace,
  updatePlace,
  removePlace,
  keepSupabaseAwake,
} from "./stops.js";
import {
  getBikeStations,
  getBikeStationInfo,
  getBikeStationStatus,
  mergeBikeStations,
  stationsNear,
} from "./bikes.js";
import { EmtError, errorResponse } from "./errors.js";
import { getBikeAccountStatus, getBikeTrips } from "./bicimad-account.js";
import { authenticatedUser, bearerToken } from "./auth.js";
import { requestEmt, manageEmtAccount, accountRequired } from "./emt-account.js";
import { getBikeTripDiagnostics, monitorBikeTrips } from "./trip-monitor.js";
import { queryMetrics, recordEdgeMetric } from "./metrics.js";
import { plan, withinDeadline } from "./journey-planner.js";

// Must match the daily trigger in wrangler.toml.
const KEEPALIVE_CRON = "17 4 * * *";

// Short-lived, high-traffic data belongs in the Cache API, not KV. Cache API
// operations do not consume the Workers KV daily operation allowance.
const ARRIVALS_CACHE_TTL = 4;
// The planner reads 20–30 boards per journey. At the map's 4-second TTL every
// one of those was a guaranteed cold EMT call on every refresh — the reason
// hubs crawled, and where most of the AbortErrors came from. A hub
// recommendation does not need four-second ETAs: half a minute practically
// never changes which route wins. Its own namespace keeps the live map's
// freshness contract untouched.
const PLANNER_ARRIVALS_CACHE_TTL = 30;
// Bump when a cached payload's *shape* changes: old entries would otherwise
// keep serving the old shape until their TTL runs out (a week, for detail).
const CACHE_VERSION = "v5";
// Stop names/locations never move. A week of cache is quota-free.
const DETAIL_CACHE_TTL = 7 * 24 * 3600;
// Nearby searches are keyed on a ~110m grid so panning the map reuses cells.
const NEARBY_CACHE_TTL = 24 * 3600;
// A line's timetable changes with the season, not with the hour.
const TIMETABLE_CACHE_TTL = 24 * 3600;
// Route geometry changes when EMT redraws a line — a week is generous.
const ROUTE_CACHE_TTL = 7 * 24 * 3600;
// A disruption lasts hours, not seconds. At two minutes every hub refresh
// refetched incidents for every line it was recommending — 753 upstream calls
// in a day, a third of them failing, and those failures land in the planner.
const INCIDENT_CACHE_TTL = 15 * 60;
const GEOCODE_CACHE_TTL = 30 * 24 * 3600;
const WALKING_CACHE_TTL = 7 * 24 * 3600;
// One operator-feed read serves the whole city and every area for 45 seconds.
const BIKES_CACHE_TTL = 45;
// Names and positions only change when a station is built or moved.
const BIKE_INFO_CACHE_TTL = 24 * 3600;
const plannerTier = (env) => (env.PLANNER_TIER === "paid" ? "paid" : "free");
// How many map-grid cells one planner nearby read may take before a single
// direct query is cheaper (see plannerNearby). The rest of each tier's
// budget is the planner's own: PLANNER_BUDGETS in journey-planner.js.
const PLANNER_GRID_CELLS = { free: 4, paid: 12 };
// Cards want the next bus and the one after it; the stop sheet wants the board.
const DEFAULT_ARRIVALS = 2;
const MAX_ARRIVALS = 20;
const edgeLoads = new Map();

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-hubwise-emt",
  };
}

function json(body, env, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(env), ...extraHeaders },
  });
}

function metricCaller(requestUrl) {
  const pathname = new URL(requestUrl).pathname;
  if (pathname === "/journeys") return "journey";
  if (pathname === "/arrivals") return "arrivals";
  if (pathname.includes("nearby")) return "nearby";
  return "direct";
}

async function edgeCachedJson(requestUrl, key, ttl, load, ctx, emt, endpoint = "") {
  const started = Date.now();
  const target = key.includes("/") ? key.slice(key.indexOf("/") + 1) : "";
  const metric = (cache, outcome = "ok", error = "") => recordEdgeMetric(emt?.env, {
    endpoint, cache, target, outcome, error, caller: metricCaller(requestUrl), who: emt?.who,
    duration: Date.now() - started,
  });
  const cache = caches.default;
  const cacheUrl = new URL(requestUrl);
  cacheUrl.pathname = `/__edge_cache/${CACHE_VERSION}/${key}`;
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    metric("hit");
    return hit.json();
  }

  // Cache API writes happen after the response. Without an in-flight map, two
  // requests landing on the same warm isolate during that gap both call EMT.
  // Share the loader promise; the map contains public data only.
  const loadKey = cacheKey.url;
  if (edgeLoads.has(loadKey)) {
    metric("coalesced");
    return edgeLoads.get(loadKey);
  }
  const operation = (async () => {
    let fresh;
    try {
      fresh = await load();
      metric("miss");
    } catch (error) {
      metric("miss", "error", error.kind ?? error.name ?? "error");
      throw error;
    }
    const write = cache.put(
      cacheKey,
      new Response(JSON.stringify(fresh), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttl}`,
        },
      }),
    );
    // Cache population is not part of the response's critical path. Workers'
    // execution context keeps it alive after returning without adding latency.
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;
    return fresh;
  })();
  edgeLoads.set(loadKey, operation);
  try {
    return await operation;
  } finally {
    if (edgeLoads.get(loadKey) === operation) edgeLoads.delete(loadKey);
  }
}

/** Arrivals for journey planning: same upstream, longer memory, and tagged
 *  separately so metrics show planner load apart from live-map polling. */
async function cachedPlannerArrivals(requestUrl, emt, stopId, ctx) {
  return edgeCachedJson(requestUrl, `arrivals-plan/${encodeURIComponent(stopId)}`,
    PLANNER_ARRIVALS_CACHE_TTL, () => getArrivals(emt, stopId, "planner"), ctx, emt, "arrivals-plan");
}

async function cachedArrivals(requestUrl, emt, stopId, ctx) {
  return edgeCachedJson(requestUrl, `arrivals/${encodeURIComponent(stopId)}`, ARRIVALS_CACHE_TTL,
    () => getArrivals(emt, stopId, "map"), ctx, emt, "arrivals");
}

async function cachedStopDetail(requestUrl, emt, stopId, ctx) {
  return edgeCachedJson(requestUrl, `detail-v2/${encodeURIComponent(stopId)}`, DETAIL_CACHE_TTL,
    () => getStopDetail(emt, stopId), ctx, emt, "detail");
}

async function cachedTimetable(requestUrl, emt, line, ctx) {
  return edgeCachedJson(requestUrl, `timetable/${encodeURIComponent(line)}`, TIMETABLE_CACHE_TTL,
    () => getLineTimetable(emt, line), ctx, emt, "timetable");
}

async function cachedRoute(requestUrl, emt, line, ctx) {
  return edgeCachedJson(requestUrl, `route/${encodeURIComponent(line)}`, ROUTE_CACHE_TTL,
    () => getLineRoute(emt, line), ctx, emt, "route");
}

async function cachedIncidents(requestUrl, emt, line, ctx) {
  return edgeCachedJson(requestUrl, `incidents/${encodeURIComponent(line)}`, INCIDENT_CACHE_TTL,
    () => getLineIncidents(emt, line), ctx, emt, "incidents");
}

async function cachedBikeInfo(requestUrl, ctx) {
  return edgeCachedJson(requestUrl, "bike-info", BIKE_INFO_CACHE_TTL,
    () => getBikeStationInfo(), ctx);
}

/** Live stations, preferring the operator's own feed.
 *
 * GBFS counts bikes you can actually rent; MobilityLabs counts bikes that are
 * docked, broken ones included. When GBFS is unreachable the older source is
 * still better than an empty map, so it stands in — flagged, so the page can
 * say the counts are the rougher kind.
 */
async function cachedBikeStations(requestUrl, emt, ctx) {
  return edgeCachedJson(requestUrl, "bikes", BIKES_CACHE_TTL, async () => {
    try {
      const [info, status] = await Promise.all([cachedBikeInfo(requestUrl, ctx), getBikeStationStatus()]);
      return { ...mergeBikeStations(info, status), source: "gbfs" };
    } catch {
      return { ...(await getBikeStations(emt)), source: "mobilitylabs" };
    }
  }, ctx);
}

function grid3(n) {
  // ~110m cells: close enough to dedupe map pans, coarse enough to hit often.
  return Number(n).toFixed(3);
}

async function cachedNearby(requestUrl, emt, lat, lon, radius, ctx, caller = "map") {
  const key = `nearby-v2/${grid3(lon)}/${grid3(lat)}/${radius}`;
  return edgeCachedJson(requestUrl, key, NEARBY_CACHE_TTL,
    () => getNearbyStops(emt, { lat, lon, radius }, caller), ctx, emt, "nearby");
}

async function geocodeMadrid(requestUrl, query, ctx) {
  const normalized = String(query ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length < 3 || normalized.length > 120) {
    throw new EmtError("not_found", "address query must be 3–120 characters");
  }
  return edgeCachedJson(requestUrl, `geocode/${encodeURIComponent(normalized.toLocaleLowerCase("es"))}`,
    GEOCODE_CACHE_TTL, async () => {
      const target = new URL("https://nominatim.openstreetmap.org/search");
      target.search = new URLSearchParams({
        q: `${normalized}, Madrid`, format: "jsonv2", addressdetails: "1",
        countrycodes: "es", bounded: "1", viewbox: "-3.888,40.643,-3.517,40.312", limit: "6",
      }).toString();
      const response = await fetch(target, {
        headers: {
          "user-agent": "hubward/1.0 (https://snowu.github.io/hubward/)",
          referer: "https://snowu.github.io/hubward/",
          accept: "application/json",
        },
      });
      if (!response.ok) throw new EmtError("upstream", `address search HTTP ${response.status}`);
      const rows = await response.json();
      return rows.map((row) => ({
        displayName: String(row.display_name ?? ""),
        lat: Number(row.lat), lon: Number(row.lon), type: row.type ?? null,
      })).filter((row) => row.displayName && Number.isFinite(row.lat) && Number.isFinite(row.lon));
    }, ctx);
}

/** The street a dropped map pin stands on, so the card it makes has a name.
 *
 * Keyed on a ~11m grid: a long press is not that precise, and the same corner
 * pressed twice should cost Nominatim one call, not two (its usage policy is
 * one request a second for everyone using this worker).
 */
async function reverseGeocodeMadrid(requestUrl, value, ctx) {
  const { lat, lon } = madridPoint(value);
  const key = `reverse/${lat.toFixed(4)},${lon.toFixed(4)}`;
  return edgeCachedJson(requestUrl, key, GEOCODE_CACHE_TTL, async () => {
    const target = new URL("https://nominatim.openstreetmap.org/reverse");
    target.search = new URLSearchParams({
      lat: lat.toFixed(4), lon: lon.toFixed(4), format: "jsonv2", addressdetails: "1", zoom: "18",
    }).toString();
    const response = await fetch(target, {
      headers: {
        "user-agent": "hubward/1.0 (https://snowu.github.io/hubward/)",
        referer: "https://snowu.github.io/hubward/",
        accept: "application/json",
      },
    });
    if (!response.ok) throw new EmtError("upstream", `address lookup HTTP ${response.status}`);
    const row = await response.json();
    const address = row.address ?? {};
    const street = [address.road ?? address.pedestrian ?? address.square, address.house_number]
      .filter(Boolean).join(" ");
    return {
      // A named place (a museum, a park) beats the street it is on.
      name: String(row.name || street || String(row.display_name ?? "").split(",")[0] || "").trim() || null,
      displayName: row.display_name ? String(row.display_name) : null,
    };
  }, ctx);
}

function madridPoint(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < 40.25 || lat > 40.65 || lon < -3.95 || lon > -3.45) {
    throw new EmtError("not_found", "invalid Madrid coordinate");
  }
  return { lat, lon };
}

async function walkingMatrix(requestUrl, body, ctx) {
  const origin = madridPoint(body?.origin);
  if (!Array.isArray(body?.destinations) || body.destinations.length < 1 || body.destinations.length > 25) {
    throw new EmtError("not_found", "destinations must contain 1–25 coordinates");
  }
  const destinations = body.destinations.map(madridPoint);
  const rounded = [origin, ...destinations]
    .map(({ lon, lat }) => `${lon.toFixed(5)},${lat.toFixed(5)}`);
  return edgeCachedJson(requestUrl, `walking/${rounded.join(";")}`, WALKING_CACHE_TTL, async () => {
    const target = `https://routing.openstreetmap.de/routed-foot/table/v1/driving/${rounded.join(";")}` +
      "?sources=0&annotations=distance,duration";
    const response = await fetch(target, {
      headers: {
        "user-agent": "hubward/1.0 (https://snowu.github.io/hubward/)",
        accept: "application/json",
      },
    });
    if (!response.ok) throw new EmtError("upstream", `walking routes HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== "Ok" || !Array.isArray(payload.distances?.[0])) {
      throw new EmtError("upstream", "walking routes returned no matrix");
    }
    return {
      routes: destinations.map((_point, index) => ({
        metres: payload.distances[0][index + 1] == null
          ? null : Math.round(payload.distances[0][index + 1]),
        seconds: payload.durations?.[0]?.[index + 1] == null
          ? null : Math.round(payload.durations[0][index + 1]),
      })),
      fetchedAt: Date.now(),
    };
  }, ctx);
}

// The page's nearby cache, mirrored. web/app.js tiles a fixed 0.02° grid and
// covers each cell with one radius-1400 search from its centre; the worker
// keys nearby by position *and* radius, so a planner asking for radius 700
// missed every entry the map had just paid for. Two disjoint key spaces for
// the same stops — and the planner's cold misses are what made journeys fail.
const NEARBY_CELL = 0.02;
const NEARBY_CELL_RADIUS = 1400;

function cellCentre(index) {
  return (index + 0.5) * NEARBY_CELL;
}

/** Every cell a circle of `metres` around a point can reach into.
 *
 * Walking the whole range, not just the four corners of the bounding box.
 * Corners are only sufficient while the box spans at most two cells per axis,
 * which held at the daytime 700m and stopped holding the moment the night
 * radius went to 2km: the box then spans three cells across, the middle ones
 * are never sampled, and one of the cells missed is the one the rider is
 * standing in. Journeys came back empty because the nearest stops were never
 * read at all.
 */
function cellsCovering(lat, lon, metres) {
  const dLat = metres / 111_320;
  const dLon = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
  const cells = [];
  for (let la = Math.floor((lat - dLat) / NEARBY_CELL);
    la <= Math.floor((lat + dLat) / NEARBY_CELL); la += 1) {
    for (let lo = Math.floor((lon - dLon) / NEARBY_CELL);
      lo <= Math.floor((lon + dLon) / NEARBY_CELL); lo += 1) {
      cells.push({ lat: cellCentre(la), lon: cellCentre(lo) });
    }
  }
  return cells;
}

function metresApart(aLat, aLon, bLat, bLon) {
  const x = (bLon - aLon) * Math.cos((aLat * Math.PI) / 180);
  const y = bLat - aLat;
  return Math.sqrt(x * x + y * y) * 111_320;
}

/** Stops within `radius` of a point, read from the grid the map keeps warm.
 *
 * Cells are a superset of what was asked for, so the radius still has to be
 * applied here — `nearbyAccess` only sorts and slices, and a destination with
 * a tight geofence would otherwise silently widen.
 *
 * Everything downstream of this is isolated per stop, but the origin's stop
 * list is not: without it there is no plan at all. So a cold grid falls back
 * to the direct query rather than returning nothing.
 */
async function plannerNearby(requestUrl, emt, lat, lon, radius, ctx) {
  const cells = cellsCovering(lat, lon, radius);
  // Reading the map's grid is worth a few requests for the cache sharing, but
  // not a dozen: a Worker invocation may make only 50 subrequests in total,
  // and one journey also spends them on routes, boards and incidents. At the
  // night radius the grid needs twelve cells, which on its own broke that
  // ceiling — past a handful, a single direct query is cheaper and faster,
  // and it is cached for a day just the same.
  if (cells.length > PLANNER_GRID_CELLS[plannerTier(emt.env)]) {
    return cachedNearby(requestUrl, emt, lat, lon, radius, ctx, "planner");
  }
  const results = await Promise.all(cells.map((cell) => withinDeadline(
    cachedNearby(requestUrl, emt, cell.lat, cell.lon, NEARBY_CELL_RADIUS, ctx, "planner"),
    6_000, null,
  )));
  const found = new Map();
  for (const stops of results) {
    for (const stop of stops ?? []) {
      const at = stop.coordinates;
      if (!Array.isArray(at)) continue;
      if (metresApart(lat, lon, at[1], at[0]) > radius) continue;
      found.set(String(stop.stopId), stop);
    }
  }
  if (found.size > 0 || results.some(Boolean)) return [...found.values()];
  // Every cell failed. One direct attempt beats losing the journey outright.
  return cachedNearby(requestUrl, emt, lat, lon, radius, ctx, "planner");
}

/** The Planner's sources: what a plan reads, through the same edge caches as
 *  every other route. Each read may fail or stall; the planner decides how
 *  long to wait and what a missing answer costs. */
function plannerSources(requestUrl, emt, ctx) {
  return {
    nearby: (lat, lon, radius) => plannerNearby(requestUrl, emt, lat, lon, radius, ctx),
    board: (stopId) => cachedPlannerArrivals(requestUrl, emt, stopId, ctx),
    route: (line) => cachedRoute(requestUrl, emt, line, ctx),
    incidents: (line) => cachedIncidents(requestUrl, emt, line, ctx),
    walking: (body) => walkingMatrix(requestUrl, body, ctx),
    bikes: () => cachedBikeStations(requestUrl, emt, ctx),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    try {
      // EMT calls in this request use the caller's own EMT account when they
      // connected one, and the shared login otherwise (see emt-account.js).
      const emt = requestEmt(env, request);
      if (pathname === "/auth/emt" && ["GET", "PUT", "DELETE"].includes(method)) {
        const result = await manageEmtAccount(env, request, {
          // The tracking runner checks on a timer with no signed-in caller, so
          // it keeps its own copy of the ciphertext to use the same account.
          // get(idFromName()) is getByName() spelled for older runtimes too.
          onChange: async (user, row) => env.TRACKING?.get(env.TRACKING.idFromName(user.id)).setEmtAccount(row ? {
            userId: user.id, connectionId: row.connection_id, credentials: row.credentials,
          } : null),
        });
        return json(result, env, 200, { "cache-control": "no-store" });
      }
      if (pathname === "/tracking/config" && method === "GET") {
        return json({ available: Boolean(env.TRACKING && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT), publicKey: env.VAPID_PUBLIC_KEY ?? null }, env);
      }
      if (pathname === "/tracking" || pathname.startsWith("/tracking/")) {
        const user = await authenticatedUser(env, request);
        if (!env.TRACKING || !env.VAPID_PRIVATE_KEY) return json({ message: "Notifications are not configured yet" }, env, 503);
        // get(idFromName()) is getByName() spelled for older runtimes too.
        const runner = env.TRACKING.get(env.TRACKING.idFromName(user.id));
        // Pollers call the runner back by user id, so it needs to know it.
        await runner.identify(user.id);
        let body;
        if (["POST", "PATCH", "DELETE"].includes(method)) {
          const raw = await request.text();
          if (raw.length > 8192) return json({ message: "Request too large" }, env, 413);
          try { body = JSON.parse(raw); } catch { return json({ message: "Invalid JSON" }, env, 400); }
        }
        let result;
        if (pathname === "/tracking" && method === "GET") result = await runner.list();
        else if (pathname === "/tracking" && method === "POST") {
          const watch = validateWatch(body);
          // Bus alerts poll EMT around the clock, so they need a quota of
          // their own. Bike alerts read the operator's public feed and do not.
          if (watch.kind === "bus" && accountRequired(env) && !(await runner.emtAccount())) {
            throw new EmtError("emt_account", "Connect your EMT account from the account menu to track buses.");
          }
          result = await runner.add(watch);
        }
        else if (pathname === "/tracking" && method === "DELETE" && typeof body?.id === "string") result = await runner.remove(body.id);
        else if (pathname === "/tracking" && method === "PATCH" && typeof body?.id === "string") result = await runner.configure(body.id, watchLimits(body));
        else if (pathname === "/tracking/location" && method === "POST") result = await runner.setLocation(validLocation(body?.coordinates));
        else if (pathname === "/tracking/subscription" && method === "POST") result = await runner.subscribe(validateSubscription(body));
        else if (pathname === "/tracking/subscription" && method === "DELETE" && typeof body?.endpoint === "string") result = await runner.unsubscribe(body.endpoint);
        else return json({ message: "Unknown tracking request" }, env, 400);
        return json(result, env, 200, { "cache-control": "no-store" });
      }

      if (pathname === "/auth/config" && method === "GET") {
        return json(
          { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY },
          env,
          200,
          { "cache-control": "public, max-age=86400" },
        );
      }

      if (pathname === "/auth/me" && method === "GET") {
        const user = await authenticatedUser(env, request);
        return json({
          id: user.id,
          email: user.email ?? null,
          owner: user.id === env.OWNER_USER_ID,
          metricsAvailable: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ANALYTICS_TOKEN),
        }, env);
      }

      if (pathname === "/admin/metrics" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "metrics are owner-only");
        }
        const hours = Math.min(720, Math.max(1,
          Number.parseInt(url.searchParams.get("hours") || "24", 10) || 24));
        return json(await queryMetrics(env, hours), env, 200, { "cache-control": "no-store" });
      }

      if (pathname === "/live" && method === "GET" && request.headers.get("Upgrade") === "websocket") {
        return await openLiveSocket(request, env);
      }

      if (pathname === "/arrivals" && method === "GET") {
        const stop = url.searchParams.get("stop");
        if (!stop) return json({ error: "missing stop parameter" }, env, 400);
        // One cached payload holds every arrival EMT sent; `limit` only trims
        // what this caller gets, so the sheet and the cards share one fetch.
        const limit = Math.min(
          MAX_ARRIVALS,
          Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_ARRIVALS)
        );
        const payload = await cachedArrivals(request.url, emt, stop, ctx);
        return json({ ...payload, arrivals: payload.arrivals.slice(0, limit) }, env);
      }

      if (pathname === "/stops" && method === "GET") {
        return json(await listStops(env, bearerToken(request)), env);
      }

      if (pathname === "/places" && method === "GET") {
        return json(await listPlaces(env, bearerToken(request)), env);
      }
      if (pathname === "/places" && method === "POST") {
        return json(await addPlace(env, bearerToken(request), await request.json()), env, 201);
      }
      if (pathname === "/places/geocode" && method === "GET") {
        await authenticatedUser(env, request);
        return json(await geocodeMadrid(request.url, url.searchParams.get("q"), ctx), env);
      }
      if (pathname === "/places/reverse" && method === "GET") {
        await authenticatedUser(env, request);
        return json(await reverseGeocodeMadrid(request.url, {
          lat: url.searchParams.get("lat"), lon: url.searchParams.get("lon"),
        }, ctx), env);
      }
      const place = pathname.match(/^\/places\/([^/]+)$/);
      if (place && method === "PATCH") {
        return json(await updatePlace(env, bearerToken(request), decodeURIComponent(place[1]),
          await request.json()), env);
      }
      if (place && method === "DELETE") {
        await removePlace(env, bearerToken(request), decodeURIComponent(place[1]));
        return new Response(null, { status: 204, headers: cors(env) });
      }

      if (pathname === "/journeys" && method === "POST") {
        await authenticatedUser(env, request);
        return json(await plan(await request.json(), {
          sources: plannerSources(request.url, emt, ctx), tier: plannerTier(env), now: new Date(),
        }), env);
      }

      if (pathname === "/walking-distances" && method === "POST") {
        await authenticatedUser(env, request);
        return json(await walkingMatrix(request.url, await request.json(), ctx), env);
      }

      const detail = pathname.match(/^\/stops\/([^/]+)\/detail$/);
      if (detail && method === "GET") {
        return json(await cachedStopDetail(request.url, emt, decodeURIComponent(detail[1]), ctx), env);
      }

      if (pathname === "/stops/nearby" && method === "GET") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        // searchParams.get returns null, and Number(null) is 0 — hence the
        // explicit has() checks; Madrid is not at 0,0.
        if (!url.searchParams.has("lat") || !url.searchParams.has("lon") ||
            !Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json({ error: "missing lat or lon parameter" }, env, 400);
        }
        const radius = Math.min(3000, Math.max(50, Number(url.searchParams.get("radius")) || 500));
        return json(await cachedNearby(request.url, emt, lat, lon, radius, ctx), env);
      }

      const route = pathname.match(/^\/lines\/([^/]+)\/route$/);
      if (route && method === "GET") {
        const line = decodeURIComponent(route[1]);
        if (!/^[0-9A-Za-z]+$/.test(line)) {
          return json({ error: "not a valid line" }, env, 400);
        }
        return json(await cachedRoute(request.url, emt, line, ctx), env);
      }

      const timetable = pathname.match(/^\/lines\/([^/]+)\/timetable$/);
      if (timetable && method === "GET") {
        const line = decodeURIComponent(timetable[1]);
        if (!/^[0-9A-Za-z]+$/.test(line)) {
          return json({ error: "not a valid line" }, env, 400);
        }
        return json(await cachedTimetable(request.url, emt, line, ctx), env);
      }

      /* ---- BiciMAD ----------------------------------------------------- */

      if (pathname === "/bikes/account" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "BiciMAD account status is owner-only");
        }
        const refresh = url.searchParams.get("refresh") === "1";
        return json(await getBikeAccountStatus(env, { force: refresh }), env);
      }

      if (pathname === "/bikes/trips" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "BiciMAD trip history is owner-only");
        }
        const page = Math.min(1000, Math.max(0, Number.parseInt(url.searchParams.get("page") || "0", 10) || 0));
        const bikeNumber = url.searchParams.get("bike");
        if (bikeNumber && !/^\d+$/.test(bikeNumber)) {
          return json({ error: "not a valid bike number" }, env, 400);
        }
        return json(await getBikeTrips(env, { page, bikeNumber }), env);
      }

      if (pathname === "/bikes/trip-diagnostics" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "BiciMAD trip diagnostics are owner-only");
        }
        return json(await getBikeTripDiagnostics(env), env);
      }

      if (pathname === "/bikes/ratings" && method === "GET") {
        const token = bearerToken(request);
        return json(await listBikeRatings(env, token), env);
      }

      const bikeRating = pathname.match(/^\/bikes\/ratings\/(\d+)$/);
      if (bikeRating && method === "PUT") {
        const token = bearerToken(request);
        const body = await request.json();
        return json(await rateBike(env, token, {
          bikeNumber: bikeRating[1],
          rating: body.rating,
        }), env);
      }

      if (pathname === "/bikes/stations" && method === "GET") {
        const all = await cachedBikeStations(request.url, emt, ctx);
        const ids = url.searchParams.get("ids");
        if (!ids) return json(all, env);
        // A page only ever wants its favourites plus what is on screen.
        const wanted = new Set(ids.split(",").filter(Boolean));
        return json(
          { ...all, stations: all.stations.filter((s) => wanted.has(s.id)) },
          env
        );
      }

      if (pathname === "/bikes/nearby" && method === "GET") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!url.searchParams.has("lat") || !url.searchParams.has("lon") ||
            !Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json({ error: "missing lat or lon parameter" }, env, 400);
        }
        const radius = Math.min(3000, Math.max(50, Number(url.searchParams.get("radius")) || 700));
        const all = await cachedBikeStations(request.url, emt, ctx);
        const savedIds = new Set((url.searchParams.get("ids") || "").split(",").filter(Boolean));
        return json(
          {
            fetchedAt: all.fetchedAt,
            source: all.source,
            stations: stationsNear(all.stations, { lat, lon, radius }),
            savedStations: savedIds.size
              ? all.stations.filter((station) => savedIds.has(station.id))
              : [],
          },
          env
        );
      }

      if (pathname === "/bikes/saved" && method === "GET") {
        return json(await listBikeStations(env, bearerToken(request)), env);
      }

      if (pathname === "/bikes/saved" && method === "POST") {
        const { stationId, label = null } = await request.json();
        return json(await addBikeStation(env, bearerToken(request), { stationId, label }), env, 201);
      }

      const bikeRow = pathname.match(/^\/bikes\/saved\/([^/]+)$/);
      if (bikeRow && method === "PATCH") {
        const { label = null } = await request.json();
        return json(await renameBikeStation(env, bearerToken(request), decodeURIComponent(bikeRow[1]), label), env);
      }
      if (bikeRow && method === "DELETE") {
        await removeBikeStation(env, bearerToken(request), decodeURIComponent(bikeRow[1]));
        return new Response(null, { status: 204, headers: cors(env) });
      }

      if (pathname === "/stops" && method === "POST") {
        const { stopId, label = null } = await request.json();
        return json(await addStop(env, bearerToken(request), { stopId, label }), env, 201);
      }

      const rename = pathname.match(/^\/stops\/([^/]+)$/);
      if (rename && method === "PATCH") {
        const { label = null } = await request.json();
        return json(await renameStop(env, bearerToken(request), decodeURIComponent(rename[1]), label), env);
      }

      const del = pathname.match(/^\/stops\/([^/]+)$/);
      if (del && method === "DELETE") {
        await removeStop(env, bearerToken(request), del[1]);
        return new Response(null, { status: 204, headers: cors(env) });
      }

      return json({ error: "not found" }, env, 404);
    } catch (err) {
      if (err instanceof EmtError) return errorResponse(err, cors(env));
      return errorResponse(new EmtError("upstream", err.message), cors(env));
    }
  },
  async scheduled(controller, env, ctx) {
    if (controller.cron === KEEPALIVE_CRON) {
      ctx.waitUntil(keepSupabaseAwake(env).catch((err) => {
        console.error(JSON.stringify({ event: "supabase_keepalive_failed", message: err.message }));
        throw err;
      }));
      return;
    }
    ctx.waitUntil(monitorBikeTrips(env).catch((err) => {
      console.error(JSON.stringify({ event: "bicimad_trip_monitor_failed", message: err.message }));
      throw err;
    }));
  },
};
