import { describe, it, expect } from "vitest";
import { loading, sharedLoad } from "../src/shared-load.js";

const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe("sharedLoad", () => {
  it("runs one load for concurrent callers and hands every one its value", async () => {
    const loads = new Map();
    let calls = 0;
    const load = async () => { calls++; return later(30, { board: "ok" }); };
    const results = await Promise.all([1, 2, 3].map(() => sharedLoad(loads, "k", load, { poll: 5 })));
    expect(calls).toBe(1);
    expect(results).toEqual([{ board: "ok" }, { board: "ok" }, { board: "ok" }]);
  });

  it("gives followers the leader's error rather than loading again", async () => {
    const loads = new Map();
    let calls = 0;
    const load = async () => { calls++; await later(20); throw new Error("EMT down"); };
    const settled = await Promise.allSettled([sharedLoad(loads, "k", load, { poll: 5 }), sharedLoad(loads, "k", load, { poll: 5 })]);
    expect(calls).toBe(1);
    expect(settled.map((s) => s.reason?.message)).toEqual(["EMT down", "EMT down"]);
  });

  it("stops waiting on a stuck leader and loads for itself", async () => {
    const loads = new Map();
    const stuck = sharedLoad(loads, "k", () => later(500, "slow"));
    const follower = await sharedLoad(loads, "k", async () => "own", { poll: 5, patience: 40 });
    expect(follower).toBe("own");
    expect(await stuck).toBe("slow");
  });

  it("forgets the key once settled, so the next caller loads afresh", async () => {
    const loads = new Map();
    await sharedLoad(loads, "k", async () => 1);
    expect(loading(loads, "k")).toBe(false);
    expect(await sharedLoad(loads, "k", async () => 2)).toBe(2);
  });

  it("never hands a follower the leader's promise", async () => {
    // The follower must settle from its own timer, so a leader whose promise
    // is never awaited by anyone else still leaves the follower its value.
    const loads = new Map();
    let release;
    const leader = sharedLoad(loads, "k", () => new Promise((resolve) => { release = resolve; }));
    const follower = sharedLoad(loads, "k", async () => "unused", { poll: 5 });
    expect(follower).not.toBe(leader);
    release("value");
    expect(await follower).toBe("value");
    await leader;
  });
});
