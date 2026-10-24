#!/usr/bin/env node
// Every service the worker calls, faked in one process, so the worker can be
// loaded with thousands of users without spending anyone's EMT quota or
// breaking a public service's fair-use policy. Point the worker at it with
// EMT_BASE, GBFS_BASE, PHOTON_BASE, NOMINATIM_BASE, ROUTING_BASE, SUPABASE_URL
// and PUSH_SINK (run.mjs does).
//
// Answers are in each service's own shape, built from the synthetic city in
// world.mjs, and every call is counted: GET /__stats is the point of the
// exercise — whether EMT calls grow with active stops or with users.
//
//   PORT=8790                listen port
//   FAKE_LATENCY=150-600     ms, uniform, per upstream answer
//   FAKE_FAIL_525=0.02       share of EMT/GBFS answers that are HTTP 525
//   FAKE_QUOTA=0             share of EMT answers that are code 98
//   LOAD_USERS=.load/users.json   seeds the test users' saved stops

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { world, stopsNear, metres } from "./world.mjs";

const PORT = Number(process.env.PORT ?? 8790);
const [LAT_MIN, LAT_MAX] = (process.env.FAKE_LATENCY ?? "150-600").split("-").map(Number);
const FAIL_525 = Number(process.env.FAKE_FAIL_525 ?? 0);
const QUOTA = Number(process.env.FAKE_QUOTA ?? 0);

/* ---- counters ------------------------------------------------------------ */

let stats;
function resetStats() {
  stats = {
    since: Date.now(),
    calls: {}, // "emt:arrivals" → n
    failuresInjected: { http525: 0, quota98: 0 },
    emtByAccount: {}, // EMT login email → calls
    arrivalStops: new Set(),
    pushes: 0,
    maxInFlight: 0,
  };
}
resetStats();
const count = (key) => { stats.calls[key] = (stats.calls[key] ?? 0) + 1; };
const tokens = new Map(); // EMT accessToken → login email
let inFlight = 0;

/* ---- helpers ------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const latency = () => LAT_MIN + Math.random() * Math.max(0, LAT_MAX - LAT_MIN);
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body == null ? "" : JSON.stringify(body));
};
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
const madridDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const [day, month, year] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid" })
    .format(d).split("/");
  return `${day}/${month}/${year}`;
};

/* ---- EMT ----------------------------------------------------------------- */

function arrivalsFor(stopId) {
  const stop = world.stops.get(stopId);
  if (!stop) return { code: "80", description: "Bus Stop disabled or not exists", data: [] };
  const now = Date.now() / 1000;
  const arrive = [];
  for (const entry of stop.lines) {
    const line = world.lines.get(entry.line);
    const leg = entry.direction === "A" ? line.toA : line.toB;
    const at = leg.find((s) => s.stopId === stopId);
    if (!at) continue;
    // Buses leave the start every `headway`, running ~5.5 m/s.
    const travel = at.distance / 5.5;
    const sinceDeparture = (now + line.phase - travel) % line.headway;
    for (let k = 0; k < 2; k++) {
      const eta = Math.round(line.headway - sinceDeparture + k * line.headway);
      const run = Math.floor((now + line.phase - travel) / line.headway) - k;
      arrive.push({
        line: line.label, stop: stopId, bus: Number(line.code) * 100 + ((run % 40) + 40) % 40,
        destination: entry.direction === "A" ? line.nameA : line.nameB,
        estimateArrive: eta, DistanceBus: Math.max(0, Math.round(Math.min(at.distance, eta * 5.5))),
        isHead: "False", geometry: { type: "Point", coordinates: stop.coordinates },
      });
    }
  }
  arrive.sort((a, b) => a.estimateArrive - b.estimateArrive);
  return arrive.length
    ? { code: "00", description: "Data recovered OK", data: [{ Arrive: arrive, StopInfo: [] }] }
    : { code: "01", description: "No estimations", data: [{ Arrive: [], StopInfo: [] }] };
}

function detailFor(stopId) {
  const stop = world.stops.get(stopId);
  if (!stop) return { code: "81", description: "No detail", data: [] };
  return { code: "00", description: "Data recovered OK", data: [{ stops: [{
    stop: stop.id, name: stop.name, postalAddress: `${stop.name}, Madrid`,
    geometry: { type: "Point", coordinates: stop.coordinates },
    dataLine: stop.lines.map((entry) => {
      const line = world.lines.get(entry.line);
      return { line: line.code, label: line.label, direction: entry.direction,
        headerA: line.nameA, headerB: line.nameB, startTime: "06:00", stopTime: "23:45",
        maxFreq: String(Math.round(line.headway / 60) + 4), minFreq: String(Math.round(line.headway / 60)),
        dayType: "LA" };
    }),
  }] }] };
}

function nearbyFor(lon, lat, radius) {
  const found = stopsNear(lon, lat, radius);
  return {
    code: found.length ? "00" : "01", description: "Data recovered OK",
    data: found.map((stop) => ({
      stopId: stop.id, stopName: stop.name,
      geometry: { type: "Point", coordinates: stop.coordinates },
      lines: stop.lines.map((entry) => ({ line: entry.line, label: world.lines.get(entry.line).label, direction: entry.direction })),
    })),
  };
}

function routeFor(code) {
  const line = world.lines.get(code) ?? [...world.lines.values()].find((l) => l.label === code);
  if (!line) return { code: "80", description: "Line not found", data: {} };
  const path = (leg) => ({ type: "FeatureCollection", features: leg.slice(1).map((s, i) => ({
    type: "Feature", properties: { id: i, name: line.nameA, stroke: "#a95516" },
    geometry: { type: "MultiLineString", coordinates: [[leg[i].coordinates, s.coordinates]] },
  })) });
  const stops = (leg) => ({ type: "FeatureCollection", features: leg.map((s) => ({
    type: "Feature", properties: { stopNum: Number(s.stopId), stopName: world.stops.get(s.stopId).name, distance: s.distance },
    geometry: { type: "Point", coordinates: s.coordinates },
  })) });
  return { code: "00", description: "Data recovered OK", data: {
    label: line.label, line: line.code, nameSectionA: line.nameA, nameSectionB: line.nameB,
    itinerary: { toA: path(line.toA), toB: path(line.toB) },
    stops: { toA: stops(line.toA), toB: stops(line.toB) },
  } };
}

function timetableFor(code) {
  const today = madridDate();
  const tomorrow = madridDate(1);
  return { code: "00", description: "Data recovered OK", data: ["LA", "SA", "FE"].map((dayType) => ({
    line: code, dateIni: "01/01/2026", dateEnd: "31/12/2026", dayType,
    firstTimeServiceA: `${today} 6:00:00`, endTimeServiceA: `${today} 23:45:00`,
    firstTimeServiceB: `${today} 6:15:00`, endTimeServiceB: `${tomorrow} 0:05:00`,
  })) };
}

async function emt(req, res, path) {
  if (Math.random() < FAIL_525) {
    stats.failuresInjected.http525++;
    return send(res, 525, { error: "ssl handshake failed" });
  }
  if (path === "v1/mobilitylabs/user/login/") {
    count("emt:login");
    const email = req.headers.email ?? "unknown";
    const token = `fake-${randomUUID()}`;
    tokens.set(token, email);
    return send(res, 200, { code: "01", description: "Token 24 hours", data: [{ accessToken: token, tokenSecExpiration: 86400 }] });
  }
  const email = tokens.get(req.headers.accesstoken);
  if (!email) return send(res, 200, { code: "80", description: "Invalid token", data: [] });
  if (Math.random() < QUOTA) {
    stats.failuresInjected.quota98++;
    return send(res, 200, { code: "98", description: "Quota exceeded", data: [] });
  }
  stats.emtByAccount[email] = (stats.emtByAccount[email] ?? 0) + 1;
  let m;
  if ((m = path.match(/^v2\/transport\/busemtmad\/stops\/(\d+)\/arrives\/$/))) {
    count("emt:arrivals");
    stats.arrivalStops.add(m[1]);
    return send(res, 200, arrivalsFor(m[1]));
  }
  if ((m = path.match(/^v2\/transport\/busemtmad\/stops\/(\d+)\/detail\/$/))) { count("emt:detail"); return send(res, 200, detailFor(m[1])); }
  if ((m = path.match(/^v2\/transport\/busemtmad\/stops\/arroundxy\/([-\d.]+)\/([-\d.]+)\/(\d+)\/$/))) {
    count("emt:nearby");
    return send(res, 200, nearbyFor(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  if ((m = path.match(/^v2\/transport\/busemtmad\/lines\/([^/]+)\/route\/$/))) { count("emt:route"); return send(res, 200, routeFor(m[1])); }
  if ((m = path.match(/^v2\/transport\/busemtmad\/lines\/([^/]+)\/timetable\/$/))) { count("emt:timetable"); return send(res, 200, timetableFor(m[1])); }
  if (path.startsWith("v1/transport/busemtmad/lines/incidents/")) { count("emt:incidents"); return send(res, 200, { code: "01", data: [] }); }
  count("emt:other");
  return send(res, 404, { code: "90", description: `fake EMT has no ${path}` });
}

/* ---- GBFS ---------------------------------------------------------------- */

function gbfs(res, feed) {
  if (Math.random() < FAIL_525) {
    stats.failuresInjected.http525++;
    return send(res, 525, {});
  }
  count(`gbfs:${feed}`);
  const now = Math.floor(Date.now() / 1000);
  if (feed === "station_information") {
    return send(res, 200, { last_updated: now, data: { stations: world.bikes.map((b) => ({
      station_id: b.id, short_name: b.number, name: b.name, address: b.name, lat: b.lat, lon: b.lon, capacity: b.capacity,
    })) } });
  }
  // Counts drift every 30 s so alert rules see changes.
  const tick = Math.floor(now / 30);
  return send(res, 200, { last_updated: now, data: { stations: world.bikes.map((b, i) => {
    const bikes = (i * 7 + tick * (i % 5)) % (b.capacity + 1);
    return { station_id: b.id, num_bikes_available: bikes, num_bikes_disabled: i % 4,
      num_docks_available: Math.max(0, b.capacity - bikes - (i % 4)), num_docks_disabled: 0,
      is_installed: 1, is_renting: 1, is_returning: 1, status: "IN_SERVICE" };
  }) } });
}

/* ---- geocoding and walking ------------------------------------------------ */

function photon(url) {
  count("photon:search");
  const q = url.searchParams.get("q") ?? "";
  let h = 0;
  for (const c of q) h = (h * 31 + c.charCodeAt(0)) | 0;
  const stops = [...world.stops.values()];
  return { type: "FeatureCollection", features: Array.from({ length: 5 }, (_, i) => {
    const stop = stops[Math.abs(h + i * 977) % stops.length];
    return { type: "Feature", geometry: { type: "Point", coordinates: stop.coordinates },
      properties: { name: `${q} ${i + 1}`, street: stop.name, city: "Madrid", type: "street" } };
  }) };
}

function osrmTable(path) {
  count("routing:table");
  const coords = path.split("/").pop().split("?")[0].split(";").map((p) => p.split(",").map(Number));
  const distances = coords.map((c) => Math.round(metres(coords[0], c) * 1.3));
  return { code: "Ok", distances: [distances], durations: [distances.map((d) => Math.round(d / 1.3))] };
}

/* ---- Supabase ------------------------------------------------------------ */

// Test users sign in with the bearer "load-<n>"; anything else is refused.
function userOf(req) {
  const m = /^Bearer load-(\d+)$/.exec(req.headers.authorization ?? "");
  if (!m) return null;
  return { id: `00000000-0000-4000-8000-${m[1].padStart(12, "0")}`, email: `load${m[1]}@example.test` };
}

const tables = new Map(); // name → rows[]
const rowsOf = (name) => tables.get(name) ?? tables.set(name, []).get(name);

// LOAD_USERS (setup.mjs's users.json) seeds each test user's saved stops and
// stations, as if they had used the app before.
if (process.env.LOAD_USERS) {
  const users = JSON.parse(readFileSync(process.env.LOAD_USERS, "utf8"));
  const created_at = new Date().toISOString();
  for (const user of users) {
    const user_id = userOf({ headers: { authorization: `Bearer ${user.token}` } }).id;
    for (const stop_id of user.stops) rowsOf("bus_stops").push({ id: randomUUID(), user_id, stop_id, label: null, enabled: true, created_at });
    for (const station_id of user.bikes) rowsOf("bike_stations").push({ id: randomUUID(), user_id, station_id, label: null, enabled: true, created_at });
  }
}
function filtersOf(url) {
  const out = [];
  for (const [key, value] of url.searchParams) {
    if (["select", "order", "limit", "on_conflict"].includes(key)) continue;
    if (value.startsWith("eq.")) out.push([key, decodeURIComponent(value.slice(3))]);
  }
  return out;
}

async function postgrest(req, res, url, table) {
  const user = userOf(req);
  // keepSupabaseAwake reads with the anon key alone.
  if (!user && !(req.method === "GET" && url.searchParams.get("limit") === "1")) {
    count("supabase:rest-denied");
    return send(res, 401, { code: "PGRST301", message: "JWT invalid" });
  }
  count(`supabase:${req.method.toLowerCase()} ${table}`);
  const rows = rowsOf(table);
  const mine = (row) => user && row.user_id === user.id &&
    filtersOf(url).every(([key, value]) => String(row[key]) === value);
  const prefer = req.headers.prefer ?? "";
  const represent = prefer.includes("return=representation");
  if (req.method === "GET") return send(res, 200, user ? rows.filter(mine) : rows.slice(0, 1));
  if (req.method === "POST") {
    const body = await readBody(req);
    const inserted = (Array.isArray(body) ? body : [body]).map((input) => {
      const row = { id: randomUUID(), enabled: true, created_at: new Date().toISOString(), ...input, user_id: user.id };
      if (prefer.includes("merge-duplicates")) {
        const existing = rows.findIndex((r) => r.user_id === user.id);
        if (existing >= 0) { rows[existing] = { ...rows[existing], ...row }; return rows[existing]; }
      }
      rows.push(row);
      return row;
    });
    return represent ? send(res, 201, inserted) : send(res, 201, null);
  }
  if (req.method === "PATCH") {
    const body = await readBody(req);
    const changed = rows.filter(mine);
    changed.forEach((row) => Object.assign(row, body));
    return represent ? send(res, 200, changed) : send(res, 204, null);
  }
  if (req.method === "DELETE") {
    tables.set(table, rows.filter((row) => !mine(row)));
    return send(res, 204, null);
  }
  return send(res, 405, { message: "method not allowed" });
}

/* ---- server -------------------------------------------------------------- */

const server = createServer(async (req, res) => {
  // How many requests the worker has open at once: if this stays low while
  // the worker queues, the bottleneck is its outbound connections.
  inFlight++;
  stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
  res.on("close", () => inFlight--);
  const url = new URL(req.url, "http://fake");
  const path = url.pathname;
  try {
    if (path === "/__stats") {
      const emtTotal = Object.entries(stats.calls).filter(([k]) => k.startsWith("emt:")).reduce((n, [, v]) => n + v, 0);
      const accounts = Object.values(stats.emtByAccount);
      return send(res, 200, {
        seconds: Math.round((Date.now() - stats.since) / 1000),
        calls: stats.calls, emtTotal,
        distinctArrivalStops: stats.arrivalStops.size,
        emtAccountsUsed: accounts.length,
        emtBusiestAccount: accounts.length ? Math.max(...accounts) : 0,
        failuresInjected: stats.failuresInjected, pushes: stats.pushes, maxInFlight: stats.maxInFlight,
      });
    }
    if (path === "/__reset" && req.method === "POST") { resetStats(); return send(res, 204, null); }

    // Users, rows and tokens answer at once: the latency under test is EMT's.
    if (path === "/auth/v1/user") {
      count("supabase:auth-user");
      const user = userOf(req);
      return user ? send(res, 200, user) : send(res, 401, { message: "invalid JWT" });
    }
    if (path.startsWith("/rest/v1/")) return await postgrest(req, res, url, path.slice(9));
    if (path === "/push") { stats.pushes++; count("push"); return send(res, 201, null); }

    await sleep(latency());
    if (path.startsWith("/emt/")) return await emt(req, res, path.slice(5));
    if (path.startsWith("/gbfs/")) return gbfs(res, path.slice(6));
    if (path === "/photon/api/") return send(res, 200, photon(url));
    if (path === "/nominatim/search") { count("nominatim:search"); return send(res, 200, []); }
    if (path === "/nominatim/reverse") {
      count("nominatim:reverse");
      return send(res, 200, { name: "", display_name: "Calle Falsa 1, Madrid", address: { road: "Calle Falsa", house_number: "1" } });
    }
    if (path.startsWith("/routing/routed-foot/table/v1/driving/")) return send(res, 200, osrmTable(path));
    count("unknown");
    return send(res, 404, { message: `fake upstream has no ${path}` });
  } catch (error) {
    count("fake-error");
    return send(res, 500, { message: String(error?.message ?? error) });
  }
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, () => {
  console.log(`fake upstream on http://127.0.0.1:${PORT} — ${world.stops.size} stops, ` +
    `${world.lines.size} lines, ${world.bikes.length} bike stations; latency ${LAT_MIN}-${LAT_MAX}ms, ` +
    `525 ${FAIL_525}, quota ${QUOTA}`);
});
