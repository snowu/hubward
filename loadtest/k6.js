// The load: N riders using the app at once, each looping app sessions the
// way the page makes requests. Run through run.mjs, or directly:
//
//   k6 run -e WORKER=http://127.0.0.1:8787 -e RIDERS=500 -e HOLD=3m loadtest/k6.js
//
// RIDERS is concurrent users ("X thousand at once"), ramped up over RAMP and
// held for HOLD. SESSION is how long one app open lasts. Each session opens
// the app (config, identity, saved stops and stations, arrivals for every
// saved stop), refreshes arrivals every 20 s like ARRIVALS_REFRESH_MS, and
// sometimes opens the map with a live socket, plans to its hubs, searches an
// address as you type, or checks bikes nearby.

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { WebSocket } from "k6/websockets";
import { Counter } from "k6/metrics";

const WORKER = __ENV.WORKER ?? "http://127.0.0.1:8787";
const WS = WORKER.replace(/^http/, "ws");
const RIDERS = Number(__ENV.RIDERS ?? 100);
const SESSION = Number(__ENV.SESSION ?? 90); // seconds
const ORIGIN = "https://snowu.github.io";

const users = new SharedArray("users", () => JSON.parse(open("./.load/users.json")));
const liveBoards = new Counter("live_boards");
// A few failed answers per rider, printed with their bodies: the summary
// alone says how many failed, not why.
let reported = 0;
function watch(response, name) {
  if (response.status >= 200 && response.status < 400) return response;
  if (reported++ < 2) console.error(`FAILED ${name} ${response.status} ${String(response.body ?? response.error).slice(0, 200)}`);
  return response;
}
const ROUTES = ["auth-config", "auth-me", "stops", "bikes-saved", "auth-emt", "arrivals", "nearby", "detail",
  "route", "journeys", "geocode", "bikes-nearby"];

export const options = {
  scenarios: {
    riders: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP ?? "1m", target: RIDERS },
        { duration: __ENV.HOLD ?? "3m", target: RIDERS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:arrivals}": ["p(95)<1500"],
    "http_req_duration{name:journeys}": ["p(95)<8000"],
    // Not limits: k6 only exports per-route numbers for metrics named here.
    ...Object.fromEntries(ROUTES.flatMap((name) => [
      [`http_reqs{name:${name}}`, ["count>=0"]],
      ...(["arrivals", "journeys"].includes(name) ? [] : [[`http_req_duration{name:${name}}`, ["max>=0"]]]),
    ])),
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
// The page asks for nearby stops on a fixed 0.02° grid, radius 1400.
const cell = (v) => (Math.floor(v / 0.02) * 0.02 + 0.01).toFixed(2);

function params(user, name) {
  return {
    headers: {
      Authorization: `Bearer ${user.token}`, Origin: ORIGIN, "x-hubwise-emt": "connected",
      "content-type": "application/json",
    },
    tags: { name },
  };
}

function arrivals(user) {
  const responses = http.batch(user.stops.map((stop) =>
    ["GET", `${WORKER}/arrivals?stop=${stop}&limit=2`, null, params(user, "arrivals")]));
  responses.forEach((r) => watch(r, "arrivals"));
  check(responses, { "arrivals ok": (rs) => rs.every((r) => r.status === 200) });
}

function openApp(user) {
  const opened = http.batch([
    ["GET", `${WORKER}/auth/config`, null, params(user, "auth-config")],
    ["GET", `${WORKER}/auth/me`, null, params(user, "auth-me")],
    ["GET", `${WORKER}/stops`, null, params(user, "stops")],
    ["GET", `${WORKER}/bikes/saved`, null, params(user, "bikes-saved")],
    ["GET", `${WORKER}/auth/emt`, null, params(user, "auth-emt")],
  ]);
  opened.forEach((r, i) => watch(r, ["auth-config", "auth-me", "stops", "bikes-saved", "auth-emt"][i]));
  arrivals(user);
}

function map(user) {
  const { lat, lon } = user.home;
  http.get(`${WORKER}/stops/nearby?lat=${cell(lat)}&lon=${cell(lon)}&radius=1400`, params(user, "nearby"));
  const stop = user.stops[0];
  const detail = http.get(`${WORKER}/stops/${stop}/detail`, params(user, "detail"));
  const line = detail.status === 200 ? detail.json("lines.0.line") : null;
  if (line) http.get(`${WORKER}/lines/${line}/route`, params(user, "route"));
  // One live socket on the stop the route was opened from, for ~30 s.
  const ws = new WebSocket(`${WS}/live?stop=${stop}`, ["hubwise", user.token], { headers: { Origin: ORIGIN } });
  ws.onmessage = () => liveBoards.add(1);
  ws.onerror = () => {};
  ws.onopen = () => setTimeout(() => ws.close(), 30_000);
}

function plan(user) {
  const response = http.post(`${WORKER}/journeys`, JSON.stringify({
    origin: user.home,
    destinations: user.places.map((p) => ({ ...p, destinationRadiusM: 700 })),
  }), { ...params(user, "journeys"), timeout: "25s" });
  watch(response, "journeys");
  check(response, { "journeys ok": (r) => r.status === 200 });
}

const WORDS = ["calle alcala", "gran via", "atocha", "plaza mayor", "serrano", "moncloa", "retiro"];
function search(user) {
  const word = pick(WORDS);
  // One request per prefix of 3+ letters, ~300 ms apart, like the Go box.
  for (let i = 3; i <= word.length; i += 1 + Math.floor(Math.random() * 2)) {
    http.get(`${WORKER}/places/geocode?q=${encodeURIComponent(word.slice(0, i))}&lat=${user.home.lat}&lon=${user.home.lon}`,
      params(user, "geocode"));
    sleep(0.3);
  }
}

function bikes(user) {
  const { lat, lon } = user.home;
  http.get(`${WORKER}/bikes/nearby?lat=${lat}&lon=${lon}&radius=700&ids=${user.bikes.join(",")}`, params(user, "bikes-nearby"));
}

export default function () {
  // Each rider is one test user for the whole run.
  const user = users[(__VU - 1) % users.length];
  openApp(user);
  if (Math.random() < 0.3) bikes(user);
  if (Math.random() < 0.25) map(user);
  if (Math.random() < 0.15) plan(user);
  if (Math.random() < 0.1) search(user);
  // Leave the app open: arrivals every 20 s for the rest of the session.
  const end = Date.now() + SESSION * (0.5 + Math.random()) * 1000;
  while (Date.now() < end) {
    sleep(20);
    arrivals(user);
  }
  // Pocket the phone for a while before the next open.
  sleep(30 + Math.random() * 60);
}
