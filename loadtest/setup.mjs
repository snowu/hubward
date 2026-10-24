#!/usr/bin/env node
// Writes what one load run needs into loadtest/.load/ (gitignored):
//
//   worker.env   the worker's settings: every upstream pointed at the fake,
//                fresh EMT_CREDENTIAL_KEY and VAPID keys, accounts required
//   users.json   N test users: bearer token, saved stops and stations, a home
//                position, and a push subscription with real P-256 keys
//
// Saved stops are not uniform: the shared caches only help when users
// overlap, so stops are drawn Zipf-like with central Madrid favoured, the way
// real riders pile onto Sol, Moncloa and Plaza Castilla.
//
//   node setup.mjs --users 1000 [--fake http://127.0.0.1:8790] [--alerts 0.3]

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateKeyPairSync, randomBytes, webcrypto } from "node:crypto";
import { world, rng, metres } from "./world.mjs";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean)
  .map((pair) => pair.trim().split(/\s+/)));
const USERS = Number(args.users ?? 1000);
const FAKE = args.fake ?? "http://127.0.0.1:8790";
const ALERTS = Number(args.alerts ?? 0.3);
const OUT = resolve(import.meta.dirname, ".load");

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

// Popularity: stops nearer Sol rank higher, with noise, then 1/rank^0.9.
const random = rng(7);
const SOL = [-3.7038, 40.4168];
const ranked = [...world.stops.values()]
  .map((stop) => ({ stop, score: metres(stop.coordinates, SOL) * (0.5 + random()) }))
  .sort((a, b) => a.score - b.score)
  .map(({ stop }) => stop);
const weights = ranked.map((_, i) => 1 / (i + 1) ** 0.9);
const total = weights.reduce((a, b) => a + b, 0);
function popularStop() {
  let r = random() * total;
  for (let i = 0; i < ranked.length; i++) if ((r -= weights[i]) <= 0) return ranked[i];
  return ranked.at(-1);
}

async function pushKeys() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { p256dh: b64url(await webcrypto.subtle.exportKey("raw", pair.publicKey)), auth: b64url(randomBytes(16)) };
}

const users = [];
for (let n = 1; n <= USERS; n++) {
  const stops = new Map();
  const count = 2 + Math.floor(random() * 5); // 2–6 saved stops
  while (stops.size < count) { const s = popularStop(); stops.set(s.id, s); }
  const home = [...stops.values()][0].coordinates;
  const bikes = Array.from({ length: 1 + Math.floor(random() * 3) },
    () => world.bikes[Math.floor(random() ** 2 * world.bikes.length)].id);
  const alerts = random() < ALERTS;
  const saved = [...stops.values()];
  users.push({
    n, token: `load-${n}`,
    stops: saved.map((s) => s.id),
    bikes: [...new Set(bikes)],
    home: { lon: home[0], lat: home[1] },
    // Hubs to plan to: popular places, like work, the gym, a friend's.
    places: Array.from({ length: 3 }, (_, i) => {
      const [lon, lat] = popularStop().coordinates;
      return { id: `hub-${n}-${i}`, name: `Hub ${i + 1}`, lat, lon };
    }),
    // Alerts: one bus watch on a line at the first saved stop, sometimes a bike one.
    watches: alerts ? [
      { kind: "bus", targetId: saved[0].id, line: world.lines.get(saved[0].lines[0].line).label,
        coordinates: saved[0].coordinates },
      ...(random() < 0.5 ? [{ kind: "bike", targetId: bikes[0] }] : []),
    ] : [],
    subscription: alerts ? {
      endpoint: `https://fcm.googleapis.com/fcm/send/load-${n}-${b64url(randomBytes(9))}`,
      keys: await pushKeys(),
    } : null,
  });
}

// VAPID: an ECDSA P-256 pair; the worker wants the public key raw and the
// private key as the JWK's `d`.
const vapid = generateKeyPairSync("ec", { namedCurve: "P-256" });
const vapidJwk = vapid.privateKey.export({ format: "jwk" });
const vapidPublic = b64url(Buffer.concat([Buffer.from([4]),
  Buffer.from(vapidJwk.x, "base64url"), Buffer.from(vapidJwk.y, "base64url")]));

const env = {
  EMT_BASE: `${FAKE}/emt/`,
  GBFS_BASE: `${FAKE}/gbfs`,
  PHOTON_BASE: `${FAKE}/photon`,
  NOMINATIM_BASE: `${FAKE}/nominatim`,
  ROUTING_BASE: `${FAKE}/routing`,
  PUSH_SINK: FAKE,
  SUPABASE_URL: FAKE,
  SUPABASE_ANON_KEY: "load-anon-key",
  EMT_ACCOUNT: "required",
  EMT_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
  EMT_EMAIL: "shared@emt.test",
  EMT_PASSWORD: "shared",
  OWNER_USER_ID: "nobody",
  VAPID_PUBLIC_KEY: vapidPublic,
  VAPID_PRIVATE_KEY: vapidJwk.d,
  VAPID_SUBJECT: "mailto:load@example.test",
};

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "worker.env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
writeFileSync(resolve(OUT, "users.json"), JSON.stringify(users));
const distinct = new Set(users.flatMap((u) => u.stops)).size;
console.log(`${USERS} users, ${distinct} distinct saved stops, ` +
  `${users.filter((u) => u.watches.length).length} with alerts → ${OUT}`);
