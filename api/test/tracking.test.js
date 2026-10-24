import { env, runInDurableObject, runDurableObjectAlarm, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  bikeTransition, busTransition, notificationText, BIKE_INTERVAL, BUS_INTERVAL,
  inSchedule, nextScheduleEdge, nextScheduleStart, validSchedule, watchStatus, madridTime, LOCATION_FRESH,
} from "../src/tracking-rules.js";
import { validateWatch, watchLimits, validLocation, DEVICE_PAUSE, DEVICE_FORGET } from "../src/tracking.js";
import { bikeFeed, stopPoller } from "../src/pollers.js";
import { sendPush, validateSubscription } from "../src/push.js";
import worker from "../src/index.js";

const busWatch = { kind: "bus", targetId: "5138", line: "70", destination: "PLAZA", label: "Home" };
const bikeWatch = { kind: "bike", targetId: "1", label: "Rack" };
const station = (bikes) => ({ bikes, inService: true, renting: true });
const bus = (seconds, vehicleId = "123") => ({ seconds, vehicleId, line: "70", destination: "PLAZA" });
afterEach(() => vi.restoreAllMocks());

describe("watch validation", () => {
  it("keeps a Madrid location for directions but never lets it change the watch identity", () => {
    const plain = validateWatch(busWatch);
    const placed = validateWatch({ ...busWatch, coordinates: [-3.70381234567, 40.41681234567] });
    expect(placed.coordinates).toEqual([-3.703812, 40.416812]);
    expect(placed.id).toBe(plain.id);
    expect(validateWatch({ ...busWatch, coordinates: [2.17, 41.38] }).coordinates).toBeUndefined();
    expect(validateWatch({ ...busWatch, coordinates: "x" }).coordinates).toBeUndefined();
  });
});

// Sol, a rack at Sol, and a point ~6 km north.
const SOL = [-3.7038, 40.4168];
const placedRack = { ...bikeWatch, coordinates: SOL, radius: 1000 };
const FAR = [-3.69, 40.47];
/** A window around (or away from) Madrid's current time, so a runner's own
 *  Date.now() lands inside (or outside) it. */
function windowFrom(now, startOffset, endOffset) {
  const { minute } = madridTime(now);
  const clock = (m) => { const v = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; };
  return { days: [0, 1, 2, 3, 4, 5, 6], from: clock(minute + startOffset), to: clock(minute + endOffset) };
}

describe("schedules and radius", () => {
  // Saturday 2026-10-24, 14:00 in Madrid (CEST); DST ends the next night.
  const saturday = Date.UTC(2026, 9, 24, 12, 0);
  const afternoons = { days: [1, 2, 3, 4, 5], from: "15:00", to: "18:00" };
  it("reads the window in Madrid time, overnight windows included", () => {
    expect(madridTime(saturday)).toEqual({ day: 6, minute: 14 * 60 });
    const monday = Date.UTC(2026, 9, 26, 15, 30); // 16:30 CET
    expect(inSchedule(afternoons, monday)).toBe(true);
    expect(inSchedule(afternoons, Date.UTC(2026, 9, 26, 17, 0))).toBe(false); // 18:00, end exclusive
    expect(inSchedule(afternoons, saturday)).toBe(false);
    expect(inSchedule(null, saturday)).toBe(true);
    const fridayNight = { days: [5], from: "23:00", to: "02:00" };
    expect(inSchedule(fridayNight, Date.UTC(2026, 9, 23, 22, 30))).toBe(true); // Sat 00:30
    expect(inSchedule(fridayNight, Date.UTC(2026, 9, 24, 22, 30))).toBe(false); // Sun 00:30
  });
  it("finds the next edge across a DST change and says when a paused watch resumes", () => {
    // Monday 15:00 CET is 14:00 UTC, not the 13:00 a fixed offset would say.
    expect(nextScheduleEdge(afternoons, saturday)).toBe(Date.UTC(2026, 9, 26, 14, 0));
    expect(nextScheduleEdge(afternoons, Date.UTC(2026, 9, 26, 14, 30))).toBe(Date.UTC(2026, 9, 26, 17, 0));
    expect(nextScheduleStart(afternoons, Date.UTC(2026, 9, 26, 14, 30))).toBe(Date.UTC(2026, 9, 27, 14, 0));
    // An overnight window that opened yesterday closes today.
    expect(nextScheduleEdge({ days: [5], from: "23:00", to: "02:00" }, Date.UTC(2026, 9, 23, 22, 30))).toBe(Date.UTC(2026, 9, 24, 0, 0));
  });
  it("pauses a watch out of range or on a stale position, and ignores a radius it cannot measure", () => {
    const now = saturday;
    expect(watchStatus(placedRack, { coordinates: SOL, at: now }, now)).toEqual({ active: true });
    expect(watchStatus(placedRack, { coordinates: FAR, at: now }, now)).toMatchObject({ active: false, reason: "far" });
    expect(watchStatus(placedRack, { coordinates: SOL, at: now - LOCATION_FRESH - 1 }, now)).toMatchObject({ active: false, reason: "stale" });
    expect(watchStatus(placedRack, null, now).active).toBe(true);
    expect(watchStatus({ ...placedRack, coordinates: undefined }, { coordinates: FAR, at: now }, now).active).toBe(true);
    expect(watchStatus({ ...placedRack, radius: null }, { coordinates: FAR, at: now }, now).active).toBe(true);
    expect(watchStatus({ ...placedRack, schedule: afternoons }, { coordinates: SOL, at: now }, now))
      .toEqual({ active: false, reason: "schedule", resumes: Date.UTC(2026, 9, 26, 14, 0) });
  });
  it("validates limits and defaults a new watch to 1 km", () => {
    expect(validateWatch(bikeWatch).radius).toBe(1000);
    expect(validateWatch({ ...bikeWatch, radius: null }).radius).toBeNull();
    expect(validSchedule({ days: [1, 1, 9], from: "15:00", to: "18:00" })).toEqual({ days: [1], from: "15:00", to: "18:00" });
    expect(() => watchLimits({ radius: 750 })).toThrow();
    expect(() => watchLimits({ schedule: { days: [], from: "15:00", to: "18:00" } })).toThrow();
    expect(() => watchLimits({ schedule: { days: [1], from: "15:00", to: "15:00" } })).toThrow();
    expect(() => watchLimits({ schedule: { days: [1], from: "25:00", to: "18:00" } })).toThrow();
    expect(watchLimits({ schedule: null })).toEqual({ schedule: null });
    expect(validLocation([-3.70381, 40.41681])).toEqual([-3.704, 40.417]);
    expect(() => validLocation([0, 100])).toThrow();
  });
});

describe("alert thresholds", () => {
  it.each([[990, 870], [901, 781], [901, 900], [1200, 120]])("alerts across %i → %i seconds exactly once", (first, next) => {
    const initial = busTransition({}, [bus(first)], busWatch, 1000);
    expect(initial.alerts).toHaveLength(0);
    const crossed = busTransition(initial.state, [bus(next)], busWatch, 121000);
    expect(crossed.alerts).toHaveLength(1);
    expect(busTransition(crossed.state, [bus(next - 120)], busWatch, 241000).alerts).toHaveLength(0);
  });
  it("alerts immediately below threshold, for each new vehicle, and on a later circuit", () => {
    const first = busTransition({}, [bus(800), bus(850, "456")], busWatch, 1000);
    expect(first.alerts).toHaveLength(2);
    const gap = busTransition(first.state, [], busWatch, 121000);
    expect(busTransition(gap.state, [bus(700)], busWatch, 241000).alerts).toHaveLength(0);
    expect(busTransition(first.state, [bus(800)], busWatch, 31 * 60_000).alerts).toHaveLength(1);
  });
  it("names the bus in the title and leads the body with the wait", () => {
    const alert = busTransition({}, [{ ...bus(170), destination: "PLAZA CASTILLA" }], { ...busWatch, destination: "" }, 1000).alerts[0];
    expect(notificationText(busWatch, alert)).toEqual({ title: "70 → Plaza Castilla", body: "In 3 min · Home · stop 5138" });
    expect(notificationText({ ...busWatch, label: "" }, { ...alert, minutes: 0 }).body).toBe("Due now · Stop 5138");
    const armed = bikeTransition({}, station(0)).state;
    const docked = bikeTransition(armed, station(1));
    expect(notificationText(bikeWatch, docked.alerts[0])).toEqual({ title: "Rack", body: "1 bike available · 1 docked · station 1" });
    const taken = bikeTransition(docked.state, station(0)).alerts[0];
    expect(notificationText({ ...bikeWatch, label: "" }, taken)).toEqual({ title: "Station 1", body: "No bikes available · 1 taken" });
    const full = bikeTransition(docked.state, station(9)).alerts[0];
    expect(notificationText(bikeWatch, full).body).toBe("9 bikes available · alerts paused above 6 · station 1");
  });
  it("rejects invalid ETAs and other routes/directions", () => {
    const rows = [bus(-1), bus(NaN), bus(999999), { ...bus(10), line: "71" }, { ...bus(10), destination: "ELSEWHERE" }];
    expect(busTransition({}, rows, busWatch, 1000).alerts).toHaveLength(0);
  });
  it("arms below six, alerts on every bike docked or taken, once more going above six, and rearms below six", () => {
    let state = {};
    const alerts = [2, 3, 0, 1, 1, 4, 6, 7, 8, 6, 7, 5, 6].map((count) => {
      const result = bikeTransition(state, station(count));
      state = result.state;
      return result.alerts.length;
    });
    expect(alerts).toEqual([0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 1]);
  });
  it("says once that a jump past six pauses alerts, and never turns unavailable/missing counts into zero", () => {
    const empty = bikeTransition({}, station(0)).state;
    const jump = bikeTransition(empty, station(7));
    expect(jump.alerts).toEqual([expect.objectContaining({ bikes: 7, change: 7, paused: true })]);
    expect(bikeTransition(jump.state, station(9)).alerts).toHaveLength(0);
    for (const value of [null, { ...station(0), renting: false }, station(null), station(-1)]) {
      expect(bikeTransition({ armed: false, count: 6 }, value).state).toEqual({ armed: false, count: 6 });
    }
  });
});

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
async function credentials() {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);
  const client = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    config: { VAPID_PUBLIC_KEY: base64url(await crypto.subtle.exportKey("raw", vapid.publicKey)), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: "https://example.org" },
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: {
      p256dh: base64url(await crypto.subtle.exportKey("raw", client.publicKey)), auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    } },
  };
}

/** A signed-in user's runner, reachable by name the way pollers call it. */
async function runner() {
  const user = crypto.randomUUID();
  const stub = env.TRACKING.get(env.TRACKING.idFromName(user));
  const { config, subscription } = await credentials();
  await runInDurableObject(stub, (instance) => { Object.assign(instance.env, config); });
  await stub.identify(user);
  await stub.subscribe(subscription);
  return { stub, subscription, user };
}
const feedStub = () => bikeFeed(env);
const pollBikes = () => runDurableObjectAlarm(feedStub());
const pollStop = (stop) => runDurableObjectAlarm(stopPoller(env, stop));
const feedUsers = () => runInDurableObject(feedStub(), (instance) => instance.subscribers().map((s) => s.user));
/** Counts watch-row writes in a runner while `run` executes. */
async function countWrites(stub, run) {
  await runInDurableObject(stub, (instance) => {
    instance.writes = 0;
    const save = instance.save.bind(instance);
    instance.save = (watch) => { instance.writes++; save(watch); };
  });
  await run();
  return runInDurableObject(stub, (instance) => instance.writes);
}
/** Pretend every device of a runner was last seen `age` ago. */
const age = (stub, ms) => runInDurableObject(stub, (instance) => {
  for (const { id, seenAt, ...subscription } of instance.devices()) instance.putDevice(id, subscription, Date.now() - ms);
});
const stopUsers = (stop) => runInDurableObject(stopPoller(env, stop), (instance) => instance.subscribers().map((s) => s.user));
function feed(count) {
  return Response.json({ data: { stations: [{ station_id: "1", num_bikes_available: count, is_installed: 1, is_renting: 1, is_returning: 1, status: "IN_SERVICE" }] } });
}

describe("shared pollers and per-user runners", () => {
  it("polls bikes on a 30-second grid, sends encrypted push, and stops once untracked", async () => {
    const { stub, user } = await runner();
    let count = 0;
    const pushes = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("station_status")) return feed(count);
      pushes.push(init);
      return new Response(null, { status: 201 });
    });
    await stub.add(bikeWatch);
    expect(await feedUsers()).toEqual([user]);
    await pollBikes();
    const next = await runInDurableObject(feedStub(), (_, ctx) => ctx.storage.getAlarm());
    expect(next % BIKE_INTERVAL).toBe(0);
    expect(next - Date.now()).toBeLessThanOrEqual(BIKE_INTERVAL);
    const first = (await stub.list()).watches[0];
    expect(first.rack).toEqual({ bikes: 0, armed: true });
    expect(first.state).toBeUndefined();
    count = 1;
    await pollBikes();
    expect(pushes).toHaveLength(1);
    expect(new Headers(pushes[0].headers).get("content-encoding")).toBe("aes128gcm");
    expect(new Headers(pushes[0].headers).get("authorization")).toMatch(/^vapid /);
    expect(pushes[0].body.byteLength).toBeGreaterThan(100);
    // The stubbed fetch accepts anything; the real Workers fetch throws on
    // redirect: "error", which silently failed every push in production.
    expect(pushes[0].redirect).toBe("manual");
    // A rack's count stays true until the next one, which replaces it in the
    // push service's queue: long TTL, one topic per watch.
    expect(new Headers(pushes[0].headers).get("ttl")).toBe("900");
    expect(new Headers(pushes[0].headers).get("topic")).toMatch(/^[0-9a-f]{32}$/);
    await pollBikes();
    expect(pushes).toHaveLength(1);
    await stub.remove(first.id);
    expect(await feedUsers()).toEqual([]);
    await pollBikes(); // the pending poll finds nobody and books no other
    expect(await pollBikes()).toBe(false);
  });
  it("retries failed push without losing the transition and drops expired subscriptions", async () => {
    const { stub, subscription } = await runner();
    let count = 0;
    let status = 503;
    let sends = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("station_status")) return feed(count);
      sends++;
      return new Response(null, { status });
    });
    await stub.add(bikeWatch);
    await pollBikes();
    count = 1;
    await pollBikes();
    expect((await stub.list()).watches[0].error).toBeTruthy();
    status = 201;
    await pollBikes();
    expect(sends).toBe(2);
    expect((await stub.list()).watches[0].error).toBeNull();
    count = 2;
    status = 410;
    await pollBikes();
    expect((await stub.list()).devices).toBe(0);
    await pollBikes(); // nobody to notify: the runner says so and is dropped
    expect(await feedUsers()).toEqual([]);
    // The browser hands back the same dead subscription: it must not be
    // re-registered, or the next send drops it and checks stop again.
    expect(await stub.subscribe(subscription)).toMatchObject({ expired: true });
    expect((await stub.list()).devices).toBe(0);
    await stub.subscribe({ ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/fresh" });
    expect((await stub.list()).devices).toBe(1);
  });
  it("survives upstream failure and keeps polling; no data means no push", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await stub.add(bikeWatch);
    await pollBikes();
    expect((await stub.list()).watches[0].error).toBeTruthy();
    expect(await runInDurableObject(feedStub(), (_, ctx) => ctx.storage.getAlarm())).toBeGreaterThan(Date.now());
  });
  it("does not re-send to a device that already accepted a push when another device fails", async () => {
    const { stub, subscription } = await runner();
    await stub.subscribe({ ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/second" });
    let count = 0;
    let failSecond = true;
    const sends = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("station_status")) return feed(count);
      sends.push(String(url));
      return new Response(null, { status: String(url).endsWith("second") && failSecond ? 503 : 201 });
    });
    await stub.add(bikeWatch);
    await pollBikes();
    count = 1;
    await pollBikes();
    expect(sends.filter((url) => url.endsWith("/test"))).toHaveLength(1);
    failSecond = false;
    await pollBikes();
    expect(sends.filter((url) => url.endsWith("/test"))).toHaveLength(1);
    expect(sends.filter((url) => url.endsWith("/second"))).toHaveLength(2);
  });
  it("rejects stale bike feeds without arming a false empty-rack alert", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const body = await feed(0).json();
      return Response.json({ ...body, last_updated: Math.floor(Date.now() / 1000) - 300 });
    });
    await stub.add(bikeWatch);
    await pollBikes();
    expect((await stub.list()).watches[0].error).toBeTruthy();
    const state = await runInDurableObject(stub, (instance) => instance.rows("watches")[0].state);
    expect(state).toEqual({});
  });
  it("serves two users on one stop with one EMT call per poll, on a two-minute grid", async () => {
    const alice = await runner();
    const bob = await runner();
    const loner = await runner();
    await env.KV.put("emt:token", "test-token");
    const boards = [];
    const pushes = [];
    await alice.stub.add(busWatch);
    await bob.stub.add(busWatch);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/arrives/")) {
        boards.push(String(url));
        return Response.json({ code: "00", data: [{ Arrive: [{ line: "70", destination: "PLAZA", bus: 123, estimateArrive: 300, DistanceBus: 800 }] }] });
      }
      pushes.push(new Headers(init.headers));
      return new Response(null, { status: 201 });
    });
    await pollStop(busWatch.targetId);
    expect(boards).toHaveLength(1);
    // A bus alert is held for a sleeping phone until the bus is due, no longer.
    expect(pushes.map((headers) => [headers.get("ttl"), headers.get("topic")])).toEqual([["300", null], ["300", null]]);
    for (const { stub } of [alice, bob]) {
      const watch = (await stub.list()).watches[0];
      expect(watch.error).toBeNull();
      expect(watch.lastCheck).toBeGreaterThan(0);
    }
    expect((await loner.stub.list()).watches).toEqual([]);
    const next = await runInDurableObject(stopPoller(env, busWatch.targetId), (_, ctx) => ctx.storage.getAlarm());
    expect(next % BUS_INTERVAL).toBe(0);
  });
  it("pauses a device not seen for five days and resumes when the app opens there", async () => {
    const { stub, subscription, user } = await runner();
    const pushes = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("station_status")) return feed(0);
      pushes.push(init);
      return new Response(null, { status: 201 });
    });
    await stub.add(bikeWatch);
    await age(stub, DEVICE_PAUSE - 60_000);
    await pollBikes();
    expect(await feedUsers()).toEqual([user]); // still seen, still polled
    await age(stub, DEVICE_PAUSE + 60_000);
    await pollBikes();
    expect(await feedUsers()).toEqual([]); // no device seen lately: the feed lets go
    expect((await stub.list()).devices).toBe(0);
    await stub.subscribe(subscription); // the app opened on that device again
    expect(await feedUsers()).toEqual([user]);
    expect((await stub.list()).devices).toBe(1);
    expect(pushes).toHaveLength(0);
  });
  it("stops a paused user's bus stop pollers too", async () => {
    const stop = { ...busWatch, targetId: "7777" };
    const { stub, subscription, user } = await runner();
    await env.KV.put("emt:token", "test-token");
    const boards = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/arrives/")) {
        boards.push(String(url));
        return Response.json({ code: "00", data: [{ Arrive: [{ line: "70", destination: "PLAZA", bus: 123, estimateArrive: 300, DistanceBus: 800 }] }] });
      }
      return new Response(null, { status: 201 });
    });
    await stub.add(stop);
    await age(stub, DEVICE_PAUSE + 60_000);
    await pollStop(stop.targetId);
    expect(await stopUsers(stop.targetId)).toEqual([]);
    await pollStop(stop.targetId); // nobody left: no EMT call
    expect(boards).toHaveLength(1);
    await stub.subscribe(subscription);
    expect(await stopUsers(stop.targetId)).toEqual([user]);
  });
  it("repairs a subscription a poller lost the next time the app opens", async () => {
    const { stub, subscription, user } = await runner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 201 }));
    await stub.add(bikeWatch);
    await stub.add({ ...busWatch, targetId: "6666" });
    await runInDurableObject(feedStub(), (instance) => instance.drop(user));
    await runInDurableObject(stopPoller(env, "6666"), (instance) => instance.drop(user));
    await stub.subscribe(subscription);
    expect(await feedUsers()).toEqual([user]);
    expect(await stopUsers("6666")).toEqual([user]);
  });
  it("keeps a runner that subscribed again while a poll it declined was out", async () => {
    const { stub, user } = await runner();
    await stub.add(bikeWatch);
    // Untrack and track again while the feed waits on this runner's answer.
    await runInDurableObject(feedStub(), (instance) => instance.fanOut(async (_, subscriber) => {
      await instance.put(subscriber.user, { stations: ["1"] });
      return { active: false };
    }));
    expect(await feedUsers()).toEqual([user]);
  });
  it("forgets a device after thirty days and lets a paused one make room", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 201 }));
    await stub.add(bikeWatch);
    for (let i = 0; i < 4; i++) {
      const { subscription } = await credentials();
      await stub.subscribe({ ...subscription, endpoint: `https://fcm.googleapis.com/fcm/send/extra-${i}` });
    }
    await age(stub, DEVICE_PAUSE + 60_000);
    const { subscription: sixth } = await credentials();
    await stub.subscribe({ ...sixth, endpoint: "https://fcm.googleapis.com/fcm/send/sixth" });
    const devices = () => runInDurableObject(stub, (instance) => instance.devices().length);
    expect(await devices()).toBe(5); // the oldest paused device made room
    expect((await stub.list()).devices).toBe(1);
    await age(stub, DEVICE_FORGET + 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true); // the daily re-sync
    expect(await devices()).toBe(0);
    expect((await stub.list()).watches).toHaveLength(1); // alerts are the account's, kept
  });
  it("counts a device from before check-ins as seen, and does not rewrite it on every visit", async () => {
    const { stub, subscription } = await runner();
    await runInDurableObject(stub, (instance) => {
      for (const { id, seenAt, ...rest } of instance.devices()) {
        instance.ctx.storage.sql.exec("INSERT OR REPLACE INTO devices VALUES (?, ?)", id, JSON.stringify(rest));
      }
    });
    expect((await stub.list()).devices).toBe(1);
    await stub.subscribe(subscription);
    const stamped = await runInDurableObject(stub, (instance) => instance.devices()[0].seenAt);
    expect(stamped).toBeGreaterThan(0);
    await stub.subscribe(subscription);
    expect(await runInDurableObject(stub, (instance) => instance.devices()[0].seenAt)).toBe(stamped);
  });
  it("writes nothing to a runner while a rack does not change", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("station_status") ? feed(7) : new Response(null, { status: 201 }));
    await stub.add(bikeWatch);
    await pollBikes(); // the first check records the state
    const writes = await countWrites(stub, async () => { await pollBikes(); await pollBikes(); await pollBikes(); });
    expect(writes).toBe(0);
    expect((await stub.list()).watches[0].lastCheck).toBeGreaterThan(0);
  });
  it("moves a runner from the self-polling era onto the shared feed", async () => {
    const { stub, user } = await runner();
    await runInDurableObject(stub, async (instance, ctx) => {
      // What an old runner looks like: a watch, no subscriptions, a 30 s alarm.
      instance.save({ ...bikeWatch, id: "old", targetId: "1", revision: "r", state: {}, lastCheck: 1, error: null });
      instance.setMeta("subscriptions", null);
      await ctx.storage.setAlarm(Date.now() + 100);
    });
    await runDurableObjectAlarm(stub);
    expect(await feedUsers()).toEqual([user]);
    const next = await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm());
    expect(next - Date.now()).toBeGreaterThan(23 * 60 * 60_000); // the daily re-sync
  });
  it("migrates an old runner that was never told its user, once it is", async () => {
    const user = crypto.randomUUID();
    const stub = env.TRACKING.get(env.TRACKING.idFromName(user));
    const { config, subscription } = await credentials();
    await runInDurableObject(stub, async (instance, ctx) => {
      Object.assign(instance.env, config);
      instance.ctx.storage.sql.exec("INSERT INTO devices VALUES ('d', ?)", JSON.stringify(validateSubscription(subscription)));
      instance.save({ ...bikeWatch, id: "old", targetId: "1", revision: "r", state: {}, lastCheck: 1, error: null });
      await ctx.storage.setAlarm(Date.now() + 100);
    });
    await runDurableObjectAlarm(stub);
    const named = await runInDurableObject(stub, (_, ctx) => Boolean(ctx.id.name));
    // Where the runtime exposes the object's name, the alarm alone is enough;
    // otherwise the next /tracking request identifies it and it subscribes.
    if (!named) {
      expect(await feedUsers()).toEqual([]);
      await stub.identify(user);
    }
    expect(await feedUsers()).toEqual([user]);
  });
  it("does not resurrect a watch removed during upstream I/O", async () => {
    const { stub } = await runner();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { entered(); await pending; return feed(0); });
    const { watches } = await stub.add(bikeWatch);
    const checking = pollBikes();
    await started;
    await stub.remove(watches[0].id);
    release();
    await checking;
    expect((await stub.list()).watches).toEqual([]);
    expect(await feedUsers()).toEqual([]);
  });
});

describe("paused watches", () => {
  it("polls a rack only while the phone is near it, and starts again from a fresh count", async () => {
    const { stub, user } = await runner();
    let count = 0;
    const pushes = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("station_status")) return feed(count);
      pushes.push(init);
      return new Response(null, { status: 201 });
    });
    await stub.add(placedRack);
    expect(await feedUsers()).toEqual([user]); // no position yet: as before
    await stub.setLocation(FAR);
    expect(await feedUsers()).toEqual([]);
    expect((await stub.list()).watches[0].paused).toMatchObject({ reason: "far" });
    await stub.setLocation(SOL);
    expect(await feedUsers()).toEqual([user]);
    await pollBikes();
    count = 1;
    await pollBikes();
    expect(pushes).toHaveLength(1);
    await stub.setLocation(FAR);
    expect((await stub.list()).watches[0].rack).toBeUndefined();
    count = 5;
    await stub.setLocation(SOL);
    await pollBikes(); // 1→5 happened while away: a baseline, not an alert
    expect(pushes).toHaveLength(1);
    expect((await stub.list()).watches[0].rack).toEqual({ bikes: 5, armed: true });
  });
  it("skips a rack that leaves range between syncs", async () => {
    const { stub } = await runner();
    await stub.add(placedRack);
    await runInDurableObject(stub, (instance) => instance.setMeta("location", { coordinates: FAR, at: Date.now() }));
    expect(await stub.onBikes({ stations: { 1: station(0) }, fetchedAt: Date.now() })).toEqual({ active: false });
  });
  it("subscribes a bus stop only inside its schedule and wakes at the next edge", async () => {
    const { stub, user } = await runner();
    const stop = { ...busWatch, targetId: "7171" };
    const now = Date.now();
    const later = windowFrom(now, 60, 120);
    await stub.add({ ...stop, schedule: later });
    expect(await stopUsers("7171")).toEqual([]);
    const listed = (await stub.list()).watches[0];
    expect(listed.paused).toMatchObject({ reason: "schedule" });
    expect(listed.paused.resumes).toBe(nextScheduleEdge(later, now));
    const alarm = await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm());
    expect(alarm).toBe(nextScheduleEdge(later, now));
    await stub.configure(listed.id, { schedule: windowFrom(now, -60, 60) });
    expect(await stopUsers("7171")).toEqual([user]);
    await stub.configure(listed.id, { schedule: null });
    expect((await stub.list()).watches[0]).toMatchObject({ schedule: null, paused: null });
  });
});

describe("tracking API validation", () => {
  it("requires authentication", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await worker.fetch(new Request("https://worker/tracking", { method }), env, createExecutionContext());
      expect(response.status).toBe(401);
    }
  });
  it("delivers to PUSH_SINK instead of the push service when it is set", async () => {
    const { config, subscription } = await credentials();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 201 }));
    expect(await sendPush({ ...config, PUSH_SINK: "http://fake.test" }, subscription, { title: "hi" })).toBe(201);
    expect(String(spy.mock.calls[0][0]))
      .toBe(`http://fake.test/push?to=${encodeURIComponent(subscription.endpoint)}`);
    vi.restoreAllMocks();
  });
  it("rejects arbitrary callback URLs and malformed subscriptions", () => {
    expect(() => validateSubscription({ endpoint: "https://example.com" })).toThrow();
    expect(() => validateSubscription({ endpoint: "https://fcm.googleapis.com.evil.test" })).toThrow();
    expect(() => validateWatch({ kind: "bike", targetId: "../admin" })).toThrow();
    expect(() => validateWatch({ ...busWatch, line: "" })).toThrow();
  });
});
