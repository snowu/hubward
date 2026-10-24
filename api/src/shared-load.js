/* One load per key per isolate, shared without sharing a promise.
 *
 * Workers ties a promise to the request that created it. A request awaiting
 * another request's promise has nothing pending of its own: if the first
 * request finishes before the waiter resumes, the runtime drops the waiter's
 * continuation ("A promise was resolved or rejected from a different request
 * context") and cancels it as hung, a 500. The load test hit exactly that on
 * popular stops, about half of all coalesced waits (docs/load-test-results.md).
 *
 * So followers never await the leader's promise. They poll a plain record on
 * their own timer, which keeps them inside their own request, take the
 * leader's value or error when it lands, and load for themselves if the
 * leader takes longer than `patience`.
 */

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a load for `key` is already running in this isolate. */
export const loading = (loads, key) => loads.has(key);

export async function sharedLoad(loads, key, load, { poll = 20, patience = 15_000 } = {}) {
  const running = loads.get(key);
  if (running) {
    const until = Date.now() + patience;
    while (!running.settled && Date.now() < until) await pause(poll);
    if (running.settled) {
      if (running.failed) throw running.error;
      return running.value;
    }
    // The leader is stuck: do not wait on it any longer.
    return load();
  }
  const entry = { settled: false };
  loads.set(key, entry);
  try {
    entry.value = await load();
    return entry.value;
  } catch (error) {
    entry.failed = true;
    entry.error = error;
    throw error;
  } finally {
    entry.settled = true;
    if (loads.get(key) === entry) loads.delete(key);
  }
}
