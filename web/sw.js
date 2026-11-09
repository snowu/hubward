// No fetch handler: transport data and application updates retain their normal
// network caching behavior. This worker exists only to display background push.

// A fixed worker must not wait for every open window to close before it runs:
// take over at once, including pages loaded before it existed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
/** A target's [lon, lat], or null. The page turns it into a Maps link: a
 *  window the worker opens is a browser window, which neither Android nor iOS
 *  hands to the Maps app, so the worker only ever opens Hubward. */
function targetCoordinates(target) {
  const [lon, lat] = Array.isArray(target?.coordinates) ? target.coordinates.map(Number) : [];
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

self.addEventListener("push", (event) => {
  let message;
  try { message = event.data?.json(); } catch { /* Show a useful fallback. */ }
  event.waitUntil((async () => {
    // Chrome only lets a push go without a system notification when the page
    // is focused; there the page shows its own banner instead of a duplicate.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const focused = windows.find((client) => client.focused && client.visibilityState === "visible");
    if (focused) return focused.postMessage({ type: "push", message });
    // Android draws neither an SVG icon nor a coloured badge: without these
    // PNGs it falls back to Chrome's own logo. The badge is read as alpha only.
    return self.registration.showNotification(message?.title || "Hubward", {
      body: message?.body || "A tracked stop has an update.",
      icon: new URL("icon-192.png", self.registration.scope).href,
      badge: new URL("badge-96.png", self.registration.scope).href,
      tag: message?.tag || "hubwise-update",
      // Each watch keeps one notification. A new bus, or a rack's new count,
      // replaces it with a sound; a bus counting down ("in 7 min", "in 5")
      // replaces it quietly.
      renotify: message?.quiet !== true,
      silent: message?.quiet === true,
      timestamp: Number.isFinite(message?.timestamp) ? message.timestamp : Date.now(),
      data: { target: message?.target },
      // A tap walks you there (through Hubward); the button just opens the stop.
      actions: targetCoordinates(message?.target) ? [{ action: "open", title: "Open in Hubward" }] : [],
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(self.registration.scope);
  const target = event.notification.data?.target;
  const coordinates = event.action === "open" ? null : targetCoordinates(target);
  const type = coordinates ? "directions" : "open";
  if (["bus", "bike"].includes(target?.kind) && /^\d+$/.test(target?.id)) {
    url.searchParams.set("trackKind", target.kind);
    url.searchParams.set("trackId", target.id);
  }
  if (coordinates) url.searchParams.set("directions", coordinates.join(","));
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    // Bring an open app forward and let it open the target itself. navigate()
    // rejects for a page this worker does not control, which left the tap
    // doing nothing at all; reloading the app was never wanted anyway.
    if (existing) {
      try {
        const focused = await existing.focus();
        focused.postMessage({ type, target });
        return;
      } catch { /* fall through to a fresh window */ }
    }
    return self.clients.openWindow(url.href);
  })());
});
