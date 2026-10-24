#!/usr/bin/env node
// Brings every test user to where a returning user stands before the load
// starts: EMT account connected (production requires one), and for the users
// setup.mjs gave alerts, a device registered, a position reported and their
// watches added — which subscribes the StopPollers and the BikeFeed, so the
// alert fan-out runs in the background for the whole test.
//
//   node seed.mjs [--worker http://127.0.0.1:8787] [--concurrency 50]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean)
  .map((pair) => pair.trim().split(/\s+/)));
const WORKER = args.worker ?? "http://127.0.0.1:8787";
const CONCURRENCY = Number(args.concurrency ?? 50);
const users = JSON.parse(readFileSync(resolve(import.meta.dirname, ".load/users.json"), "utf8"));

let failures = 0;
async function call(user, method, path, body) {
  const response = await fetch(`${WORKER}${path}`, {
    method,
    headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json", origin: "https://snowu.github.io" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    failures++;
    if (failures <= 5) console.error(`${method} ${path} for ${user.token}: ${response.status} ${await response.text()}`);
  } else await response.body?.cancel();
}

async function seed(user) {
  await call(user, "PUT", "/auth/emt", { email: `load${user.n}@emt.test`, password: "load" });
  if (!user.watches.length) return;
  await call(user, "POST", "/tracking/subscription", user.subscription);
  await call(user, "POST", "/tracking/location", { coordinates: [user.home.lon, user.home.lat] });
  for (const watch of user.watches) await call(user, "POST", "/tracking", watch);
}

const started = Date.now();
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < users.length) await seed(users[next++]);
}));
const alerting = users.filter((u) => u.watches.length).length;
console.log(`seeded ${users.length} users (${alerting} with alerts) in ${((Date.now() - started) / 1000).toFixed(1)}s, ${failures} failed calls`);
if (failures) process.exitCode = 1;
