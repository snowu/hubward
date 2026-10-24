import { buildPushPayload } from "@block65/webcrypto-web-push";
import { EmtError } from "./errors.js";

export function validateSubscription(value) {
  let url;
  try { url = new URL(value?.endpoint); } catch { throw new EmtError("bad_request", "Invalid push subscription"); }
  // A subscription is untrusted input: never turn the sender into an arbitrary
  // URL fetcher. These are the browser vendors' Web Push services.
  const allowed = url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname.endsWith(".push.services.mozilla.com") ||
    url.hostname === "web.push.apple.com" || url.hostname.endsWith(".notify.windows.com");
  if (url.protocol !== "https:" || url.port || url.username || url.password || !allowed ||
      value.endpoint.length > 2048 || !/^[\w-]{87}$/.test(value.keys?.p256dh ?? "") ||
      !/^[\w-]{22}$/.test(value.keys?.auth ?? "")) {
    throw new EmtError("bad_request", "Invalid push subscription");
  }
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

export async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** `ttl`: seconds the push service may hold the message for a phone that is
 *  asleep or offline; past it the message is dropped without a trace, so it
 *  should be as long as the news stays true. `topic` (at most 32 URL-safe
 *  characters) lets a newer message replace one still waiting in the queue. */
export async function sendPush(env, subscription, payload, { ttl = 120, topic } = {}) {
  const options = { ttl, urgency: "high", ...(topic ? { topic } : {}) };
  const details = await buildPushPayload({ data: JSON.stringify(payload), options }, subscription, {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  });
  // Workers reject redirect: "error". "manual" hands a redirect back as a 3xx,
  // which the caller already treats as a failed delivery: never follow one.
  // PUSH_SINK delivers every notification there instead: the load test's fake
  // upstream (loadtest/). Unset in production. It is operator config, so the
  // check above still keeps subscriptions to the browser vendors' services.
  const target = env.PUSH_SINK
    ? `${env.PUSH_SINK}/push?to=${encodeURIComponent(subscription.endpoint)}`
    : subscription.endpoint;
  const response = await fetch(target, {
    ...details, redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status;
}
