#!/usr/bin/env node
// One command for a whole load run against a local worker:
//
//   node loadtest/run.mjs --riders 100,500,1000 --hold 2m
//
// For each level of concurrent riders it starts a fresh fake upstream and a
// fresh `wrangler dev` (new state directory, so every level starts cold),
// seeds the users, resets the counters, runs k6, and then reads back the
// fake upstream's call counts and the worker's poll log lines. The report —
// one row per level — goes to the terminal and to loadtest/results/.
//
// What it answers: does upstream work grow with active stops, or with
// riders? A local workerd is one process on one machine, so its latencies
// say little about Cloudflare's; the call counts are the result that carries
// over.
//
// Options (defaults in brackets):
//   --riders 100,500   concurrent riders per level        [100]
//   --users N          test users generated               [max riders]
//   --ramp 30s --hold 2m --session 90                     [30s, 2m, 90]
//   --alerts 0.3       share of users with alerts         [0.3]
//   --latency 150-600  fake upstream answer time, ms      [150-600]
//   --fail525 0        share of EMT/GBFS answers that 525 [0]
//   --quota 0          share of EMT answers that are 98   [0]
//   --seed-concurrency 20   parallel calls while seeding  [20]
//
// WRANGLER overrides the dev server command. The default pins 4.152: on 4.125
// (the repo's) the dev proxy in front of workerd crashed under 50 concurrent
// requests ("Error inside ProxyWorker") — a dev-tool fault, not the worker's.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const HERE = import.meta.dirname;
const API = resolve(HERE, "../api");
const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean)
  .map((pair) => pair.trim().split(/\s+/)));
const LEVELS = String(args.riders ?? "100").split(",").map(Number);
const USERS = Number(args.users ?? Math.max(...LEVELS));
const RAMP = args.ramp ?? "30s";
const HOLD = args.hold ?? "2m";
const SESSION = args.session ?? "90";
const FAKE_PORT = 8790;
const WORKER_PORT = 8787;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const WORKER = `http://127.0.0.1:${WORKER_PORT}`;
const K6 = process.env.K6 ?? [resolve(homedir(), ".local/bin/k6")].find(existsSync) ?? "k6";
const STATE = resolve(HERE, ".load/state");
const RESULTS = resolve(HERE, "results");
const WRANGLER = (process.env.WRANGLER ?? "npx -y wrangler@4.152.0").split(" ");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = (text) => {
  const m = /^(\d+)(s|m)$/.exec(text);
  return m ? Number(m[1]) * (m[2] === "m" ? 60 : 1) : Number(text);
};

function start(command, argv, options) {
  const child = spawn(command, argv, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop();
      child.lines.push(...parts);
    });
  }
  return child;
}
function stop(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
}

async function ready(url, child, what, timeout = 90_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not yet */ }
    if (child.exitCode != null) break;
    await sleep(500);
  }
  throw new Error(`${what} did not start:\n${child.lines.slice(-20).join("\n")}`);
}

function k6Metric(summary, name, stat) {
  const metric = summary.metrics?.[name];
  if (!metric) return null;
  const value = metric.values?.[stat] ?? metric[stat];
  return value == null ? null : Number(value);
}

async function level(riders) {
  console.log(`\n=== ${riders} concurrent riders ===`);
  rmSync(STATE, { recursive: true, force: true });
  const fake = start("node", ["fake-upstream.mjs"], {
    cwd: HERE,
    env: { ...process.env, PORT: String(FAKE_PORT), LOAD_USERS: resolve(HERE, ".load/users.json"),
      FAKE_LATENCY: args.latency ?? "150-600", FAKE_FAIL_525: args.fail525 ?? "0", FAKE_QUOTA: args.quota ?? "0" },
  });
  const worker = start(WRANGLER[0], [...WRANGLER.slice(1), "dev", "--local", "--port", String(WORKER_PORT),
    "--env-file", resolve(HERE, ".load/worker.env"), "--persist-to", STATE,
    "--show-interactive-dev-session=false"], { cwd: API, env: process.env });
  try {
    await ready(`${FAKE}/__stats`, fake, "fake upstream");
    await ready(`${WORKER}/auth/config`, worker, "worker");
    try {
      execFileSync("node", ["seed.mjs", "--worker", WORKER, "--concurrency", String(args["seed-concurrency"] ?? 20)],
        { cwd: HERE, stdio: "inherit" });
    } catch {
      // A few seed calls timing out on a busy local runtime leaves a few users
      // without alerts; the level is still worth running. seed.mjs said how many.
      console.warn("seeding had failures; continuing");
    }
    // Count only the load itself, not seeding.
    await fetch(`${FAKE}/__reset`, { method: "POST" });
    const pollsBefore = worker.lines.length;
    const summaryFile = resolve(HERE, `.load/k6-${riders}.json`);
    const started = Date.now();
    let thresholdsPassed = true;
    try {
      execFileSync(K6, ["run", "--quiet", "--summary-export", summaryFile,
        "-e", `WORKER=${WORKER}`, "-e", `RIDERS=${riders}`, "-e", `RAMP=${RAMP}`, "-e", `HOLD=${HOLD}`,
        "-e", `SESSION=${SESSION}`, "k6.js"], { cwd: HERE, stdio: "inherit" });
    } catch (error) {
      // 99: a threshold was crossed. That is a result, not a failed run.
      if (error.status !== 99) throw error;
      thresholdsPassed = false;
    }
    const elapsed = (Date.now() - started) / 1000;
    const fakeStats = await (await fetch(`${FAKE}/__stats`)).json();
    const polls = worker.lines.slice(pollsBefore)
      .map((line) => { try { return JSON.parse(line.slice(line.indexOf("{"))); } catch { return null; } })
      .filter((entry) => entry?.event === "poll");
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    // The worker's own access log: status and time of every request, by route.
    const access = {};
    const faults = {};
    for (const raw of worker.lines.slice(pollsBefore)) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
      const hit = /\[wrangler:info\] (GET|POST|PUT|PATCH|DELETE) (\/[^ ?]*)\S* (\d{3}) .*\((\d+)ms\)/.exec(line);
      if (hit) {
        const route = `${hit[1]} ${hit[2].replace(/\/\d+(?=\/|$)/g, "/:id")}`;
        const entry = access[route] ??= { statuses: {}, ms: [] };
        entry.statuses[hit[3]] = (entry.statuses[hit[3]] ?? 0) + 1;
        entry.ms.push(Number(hit[4]));
      } else if (/ERROR|Uncaught|exceeded|Network connection lost|ProxyWorker/.test(line)) {
        const key = line.trim().slice(0, 140);
        faults[key] = (faults[key] ?? 0) + 1;
      }
    }
    for (const entry of Object.values(access)) {
      entry.ms.sort((x, y) => x - y);
      entry.p95 = entry.ms[Math.floor(entry.ms.length * 0.95)] ?? null;
      entry.count = entry.ms.length;
      delete entry.ms;
    }
    const by = (poller) => polls.filter((p) => p.poller === poller);
    const sum = (list, key) => list.reduce((n, p) => n + (p[key] ?? 0), 0);
    const stopPolls = by("StopPoller");
    const bikePolls = by("BikeFeed");
    return {
      riders, seconds: Math.round(elapsed), thresholdsPassed,
      requests: k6Metric(summary, "http_reqs", "count"),
      requestsPerSecond: k6Metric(summary, "http_reqs", "rate"),
      failedRate: k6Metric(summary, "http_req_failed", "value") ?? k6Metric(summary, "http_req_failed", "rate"),
      p95: {
        all: k6Metric(summary, "http_req_duration", "p(95)"),
        arrivals: k6Metric(summary, "http_req_duration{name:arrivals}", "p(95)"),
        journeys: k6Metric(summary, "http_req_duration{name:journeys}", "p(95)"),
      },
      liveBoards: k6Metric(summary, "live_boards", "count"),
      access, faults,
      routes: Object.fromEntries(Object.keys(summary.metrics)
        .map((key) => /^http_reqs\{name:(.+)\}$/.exec(key)?.[1]).filter(Boolean)
        .map((name) => [name, {
          count: k6Metric(summary, `http_reqs{name:${name}}`, "count"),
          p95: k6Metric(summary, `http_req_duration{name:${name}}`, "p(95)"),
        }])),
      upstream: fakeStats,
      polls: {
        stop: stopPolls.length, stopErrors: stopPolls.filter((p) => p.error).length,
        stopFanOut: sum(stopPolls, "subscribers"), stopFanOutFailed: sum(stopPolls, "failed"),
        bike: bikePolls.length, bikeFanOut: sum(bikePolls, "subscribers"), bikeFanOutFailed: sum(bikePolls, "failed"),
      },
    };
  } finally {
    stop(worker);
    stop(fake);
    await sleep(1500);
  }
}

function table(rows) {
  const n = (v, d = 0) => (v == null ? "–" : Number(v).toFixed(d));
  const lines = [
    "| riders | requests | req/s | failed | p95 arrivals | p95 journeys | arrivals asked | EMT arrivals (all callers) | EMT arrivals ÷ asked | distinct stops | EMT calls (all) | EMT per rider-min | Supabase auth per request | pushes | stop polls | bike fan-out |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of rows) {
    const u = r.upstream;
    const asked = r.routes?.arrivals?.count ?? null;
    const emtArrivals = u.calls["emt:arrivals"] ?? 0;
    const riderMinutes = r.riders * (r.seconds / 60);
    lines.push(`| ${r.riders} | ${n(r.requests)} | ${n(r.requestsPerSecond, 1)} | ${n((r.failedRate ?? 0) * 100, 2)}% | ` +
      `${n(r.p95.arrivals)} ms | ${n(r.p95.journeys)} ms | ${n(asked)} | ${n(emtArrivals)} | ` +
      `${asked ? n(emtArrivals / asked, 2) : "–"} | ${n(u.distinctArrivalStops)} | ${n(u.emtTotal)} | ` +
      `${n(u.emtTotal / Math.max(1, riderMinutes), 2)} | ${n((u.calls["supabase:auth-user"] ?? 0) / Math.max(1, r.requests), 2)} | ` +
      `${n(u.pushes)} | ${r.polls.stop} | ${r.polls.bikeFanOut} |`);
  }
  return lines.join("\n");
}

execFileSync("node", ["setup.mjs", "--users", String(USERS), "--fake", FAKE, "--alerts", String(args.alerts ?? 0.3)],
  { cwd: HERE, stdio: "inherit" });
const rows = [];
for (const riders of LEVELS) rows.push(await level(riders));

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
mkdirSync(RESULTS, { recursive: true });
const config = { levels: LEVELS, users: USERS, ramp: RAMP, hold: HOLD, holdSeconds: seconds(HOLD), session: SESSION,
  alerts: args.alerts ?? 0.3, latency: args.latency ?? "150-600", fail525: args.fail525 ?? 0, quota: args.quota ?? 0 };
writeFileSync(resolve(RESULTS, `${stamp}.json`), JSON.stringify({ config, rows }, null, 2));
const statuses = rows.map((r) => [`### ${r.riders} riders: worker access log`, "",
  "| route | requests | statuses | p95 |", "| --- | ---: | --- | ---: |",
  ...Object.entries(r.access ?? {}).sort(([, x], [, y]) => y.count - x.count)
    .map(([route, e]) => `| ${route} | ${e.count} | ${Object.entries(e.statuses).map(([k, v]) => `${k}×${v}`).join(" ")} | ${e.p95} ms |`),
  ...(Object.keys(r.faults ?? {}).length ? ["", "Runtime faults:", "",
    ...Object.entries(r.faults).map(([line, count]) => `- ${count}× \`${line}\``)] : []),
].join("\n")).join("\n\n");
const report = `# Load run ${stamp}\n\n\`${JSON.stringify(config)}\`\n\n${table(rows)}\n\n${statuses}\n`;
writeFileSync(resolve(RESULTS, `${stamp}.md`), report);
console.log(`\n${report}\nSaved to loadtest/results/${stamp}.{json,md}`);
