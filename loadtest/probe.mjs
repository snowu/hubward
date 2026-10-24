#!/usr/bin/env node
// What one action costs upstream, measured: reset the fake's counters, do one
// thing as one user, read the counters back. Cold and warm, so the effect of
// each cache shows. The table multiplies by real usage far more reliably than
// a whole load run does, because nothing else is happening at the time.
//
//   node loadtest/probe.mjs        (after setup.mjs has written .load/)
//
// Runs its own fake upstream and worker on ports 8791/8797, so it never
// collides with a load run's.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const HERE = import.meta.dirname;
const FAKE = "http://127.0.0.1:8791";
const WORKER = "http://127.0.0.1:8797";
const WS = WORKER.replace("http", "ws");
const WRANGLER = (process.env.WRANGLER ?? "npx -y wrangler@4.152.0").split(" ");
const LOAD = resolve(HERE, ".load");
const users = JSON.parse(readFileSync(resolve(LOAD, "users.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The run's env file, pointed at this probe's fake.
writeFileSync(resolve(LOAD, "probe.env"),
  readFileSync(resolve(LOAD, "worker.env"), "utf8").replace(/http:\/\/127\.0\.0\.1:\d+/g, FAKE));

function start(command, argv, options) {
  const child = spawn(command, argv, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.log = "";
  child.stdout.on("data", (c) => { child.log += c; });
  child.stderr.on("data", (c) => { child.log += c; });
  return child;
}
const stop = (child) => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } };
async function ready(url, child, what) {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not yet */ }
    if (child.exitCode != null) break;
    await sleep(500);
  }
  throw new Error(`${what} did not start:\n${child.log.slice(-2000)}`);
}

const state = resolve(LOAD, "probe-state");
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
const fake = start("node", ["fake-upstream.mjs"], { cwd: HERE,
  env: { ...process.env, PORT: "8791", LOAD_USERS: resolve(LOAD, "users.json"), FAKE_LATENCY: "20-20" } });
const worker = start(WRANGLER[0], [...WRANGLER.slice(1), "dev", "--local", "--port", "8797", "--inspector-port", "9239",
  "--env-file", resolve(LOAD, "probe.env"), "--persist-to", state, "--show-interactive-dev-session=false"],
  { cwd: resolve(HERE, "../api") });

const rows = [];
try {
  await ready(`${FAKE}/__stats`, fake, "fake upstream");
  await ready(`${WORKER}/auth/config`, worker, "worker");

  const as = (user) => ({ authorization: `Bearer ${user.token}`, "content-type": "application/json",
    origin: "https://snowu.github.io", "x-hubwise-emt": "connected" });
  const req = (user, method, path, body) => fetch(`${WORKER}${path}`, {
    method, headers: user ? as(user) : { origin: "https://snowu.github.io" }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

  /** Run `action`, and record what reached each upstream while it ran. */
  async function measure(label, action, note = "") {
    await fetch(`${FAKE}/__reset`, { method: "POST" });
    const started = Date.now();
    const statuses = await action();
    const ms = Date.now() - started;
    await sleep(300); // waitUntil cache writes land after the response
    const { calls } = await (await fetch(`${FAKE}/__stats`)).json();
    const group = (prefix) => Object.entries(calls).filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => `${k.slice(prefix.length)} ${v}`).join(", ");
    const total = (prefix) => Object.entries(calls).filter(([k]) => k.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);
    rows.push({ label, statuses: [...new Set([statuses].flat())].join(" "), ms,
      emt: total("emt:"), emtDetail: group("emt:"), supabase: total("supabase:"), supabaseDetail: group("supabase:"),
      other: Object.entries(calls).filter(([k]) => !/^(emt|supabase):/.test(k)).map(([k, v]) => `${k} ${v}`).join(", "), note });
    console.log(`${label}: ${JSON.stringify(calls)} (${ms} ms)`);
  }

  const [a, b, c] = users.filter((u) => u.watches.some((w) => w.kind === "bus")).slice(0, 3);
  const stopId = a.stops[0];
  const other = users.find((u) => !u.stops.includes(stopId) && u !== a);

  await measure("Connect EMT account", async () => (await req(a, "PUT", "/auth/emt", { email: "probe-a@emt.test", password: "x" })).status);
  await req(b, "PUT", "/auth/emt", { email: "probe-b@emt.test", password: "x" });
  await req(c, "PUT", "/auth/emt", { email: "probe-c@emt.test", password: "x" });
  await measure("Open app (config, me, saved stops/stations, EMT status)", async () => Promise.all(
    ["/auth/config", "/auth/me", "/stops", "/bikes/saved", "/auth/emt"].map(async (p) => (await req(a, "GET", p)).status)));
  await measure("Arrivals, cold", async () => (await req(a, "GET", `/arrivals?stop=${stopId}&limit=2`)).status);
  await measure("Arrivals, same stop again at once", async () => (await req(a, "GET", `/arrivals?stop=${stopId}&limit=8`)).status,
    "one board serves every limit");
  await measure("Arrivals, same stop, another user", async () => (await req(b, "GET", `/arrivals?stop=${stopId}`)).status);
  await sleep(4500);
  await measure("Arrivals, same stop 4.5 s later", async () => (await req(a, "GET", `/arrivals?stop=${stopId}`)).status,
    "past the 4 s TTL");
  await measure("Arrivals, guest (signed out), stop nobody asked for", async () => (await req(null, "GET", `/arrivals?stop=${other.stops.at(-1)}`)).status,
    "required accounts: guests get cache only");
  await measure("Stop detail, cold", async () => (await req(a, "GET", `/stops/${stopId}/detail`)).status);
  await measure("Stop detail, warm", async () => (await req(b, "GET", `/stops/${stopId}/detail`)).status);
  const cell = (v) => (Math.floor(v / 0.02) * 0.02 + 0.01).toFixed(2);
  const near = `/stops/nearby?lat=${cell(a.home.lat)}&lon=${cell(a.home.lon)}&radius=1400`;
  await measure("Nearby stops (map cell), cold", async () => (await req(a, "GET", near)).status);
  await measure("Nearby stops (map cell), warm", async () => (await req(b, "GET", near)).status);
  const line = JSON.parse((await req(a, "GET", `/stops/${stopId}/detail`)).body).lines[0].line;
  await measure("Line route, cold", async () => (await req(a, "GET", `/lines/${line}/route`)).status);
  await measure("Bikes nearby + saved, cold", async () => (await req(a, "GET", `/bikes/nearby?lat=${a.home.lat}&lon=${a.home.lon}&radius=700&ids=${a.bikes.join(",")}`)).status);
  await measure("Bikes nearby + saved, warm", async () => (await req(b, "GET", `/bikes/nearby?lat=${b.home.lat}&lon=${b.home.lon}&radius=700&ids=${b.bikes.join(",")}`)).status);
  const journey = (u) => ({ origin: u.home, destinations: u.places.map((p) => ({ ...p, destinationRadiusM: 700 })) });
  await measure("Plan to 3 hubs, cold", async () => (await req(a, "POST", "/journeys", journey(a))).status);
  await measure("Plan to 3 hubs, same user again at once", async () => (await req(a, "POST", "/journeys", journey(a))).status);
  await measure("Plan to 3 hubs, another user elsewhere", async () => (await req(other, "POST", "/journeys", journey(other))).status,
    "unconnected user: cached reads only");
  await measure("Plan to 3 hubs, connected user elsewhere", async () => (await req(c, "POST", "/journeys", journey(c))).status);
  await measure("Address search, 3 prefixes typed, cold", async () => {
    const out = [];
    for (const q of ["ato", "atoc", "atocha"]) out.push((await req(a, "GET", `/places/geocode?q=${q}&lat=${a.home.lat}&lon=${a.home.lon}`)).status);
    return out;
  });
  await measure("Address search, same prefixes, nearby user", async () => {
    const out = [];
    for (const q of ["ato", "atoc", "atocha"]) out.push((await req(b, "GET", `/places/geocode?q=${q}&lat=${a.home.lat}&lon=${a.home.lon}`)).status);
    return out;
  }, "cache key: query + ~1 km grid");
  await measure("Tracking: register device + report position (every app open)", async () => [
    (await req(a, "POST", "/tracking/subscription", a.subscription)).status,
    (await req(a, "POST", "/tracking/location", { coordinates: [a.home.lon, a.home.lat] })).status,
  ]);
  await measure("Live map socket, 2 viewers, 20 s", async () => {
    const open = (u) => new Promise((resolveSocket) => {
      const ws = new WebSocket(`${WS}/live?stop=${stopId}`, ["hubwise", u.token]);
      let boards = 0;
      ws.onmessage = () => { boards++; };
      ws.onerror = () => resolveSocket("error");
      setTimeout(() => { ws.close(); resolveSocket(boards ? 101 : "no boards"); }, 20_000);
    });
    return Promise.all([open(a), open(b)]);
  }, "one EMT call per stop per 5 s tick, whoever watches");
} finally {
  stop(worker);
  stop(fake);
}

const table = [
  "| action | status | EMT calls | Supabase calls | other upstream | notes |",
  "| --- | --- | ---: | ---: | --- | --- |",
  ...rows.map((r) => `| ${r.label} | ${r.statuses} | ${r.emt}${r.emtDetail ? ` (${r.emtDetail})` : ""} | ` +
    `${r.supabase}${r.supabaseDetail ? ` (${r.supabaseDetail})` : ""} | ${r.other || "–"} | ${r.note} |`),
].join("\n");
mkdirSync(resolve(HERE, "results"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(resolve(HERE, "results", `probe-${stamp}.md`), `# Upstream cost per action ${stamp}\n\n${table}\n`);
console.log(`\n${table}\n\nSaved to loadtest/results/probe-${stamp}.md`);
