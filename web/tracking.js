/** Browser push is opt-in, and only requested in direct response to a tap. */
export function createTracking({ api, signedIn, changed, locate = () => null, position = () => null }) {
  let watches = [];
  let config;
  let deviceCount = 0;
  let thisDevice = false; // this browser holds a subscription the worker accepted
  let generation = 0;
  let busy = false;
  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const registration = () => navigator.serviceWorker.register(new URL("./sw.js", import.meta.url), { scope: "./" });
  const key = (watch) => JSON.stringify([watch.kind, String(watch.targetId), watch.kind === "bus" ? String(watch.line).toUpperCase() : "", watch.destination || ""]);
  const find = (watch) => watches.find((item) => item.id === key(watch));
  const refresh = () => changed();

  async function enable() {
    if (!signedIn()) throw new Error("Sign in to track buses and bike stations.");
    if (!supported()) throw new Error("Push notifications are unavailable here. On iPhone or iPad, add Hubward to your Home Screen and open it there.");
    // Keep the permission request before any network await (Safari gesture rule).
    const permission = await window.Notification.requestPermission();
    if (permission !== "granted") throw new Error("Allow notifications in your browser settings to receive alerts.");
    config ??= await api("/tracking/config");
    if (!config.available) throw new Error("Notifications are not configured yet.");
    await registration();
    await register(await navigator.serviceWorker.ready);
    deviceCount = Math.max(1, deviceCount);
  }

  /** Send this browser's subscription to the worker, replacing it first when
   *  it was made with another server key or the push service has expired it:
   *  the browser keeps handing back a dead subscription as if it were fine. */
  async function register(reg) {
    let subscription = await reg.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, config.publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      subscription ??= await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: config.publicKey,
      });
      const result = await api("/tracking/subscription", { method: "POST", body: JSON.stringify(subscription) });
      if (!result?.expired) {
        thisDevice = true;
        return;
      }
      await subscription.unsubscribe();
      subscription = null;
    }
    throw new Error("The push service keeps rejecting this device. Try again later.");
  }

  function sameKey(subscription, publicKey) {
    const raw = subscription.options?.applicationServerKey;
    if (!raw) return true; // not exposed: nothing to compare, keep it
    const encoded = btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return encoded === publicKey;
  }

  /** Re-register this browser's subscription without prompting. The worker
   *  drops a device the push service rejected, and reinstalling the app can
   *  leave the browser subscribed while the worker has forgotten it; either
   *  way alerts would stop silently until someone tapped Enable again. */
  async function resync() {
    thisDevice = false;
    if (!supported() || window.Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.getRegistration(new URL("./", import.meta.url));
    // Never subscribe on its own: only keep alive what Enable created.
    if (!reg || !(await reg.pushManager.getSubscription())) return;
    config ??= await api("/tracking/config");
    if (config.available) await register(reg);
  }

  /** An installed app can sit in the background for days without reloading;
   *  coming back to it counts as a visit too, or the worker would pause
   *  alerts for a phone that is in daily use. At most every few hours. */
  let checkedInAt = 0;
  async function checkIn() {
    if (!signedIn() || Date.now() - checkedInAt < 6 * 3_600_000) return;
    checkedInAt = Date.now();
    try { await resync(); } catch { /* the next visit tries again */ }
  }

  async function load() {
    const current = ++generation;
    watches = [];
    refresh();
    if (!signedIn()) return;
    checkedInAt = Date.now();
    try { await resync(); } catch { thisDevice = false; }
    try {
      const data = await api("/tracking");
      if (current !== generation) return;
      watches = data.watches;
      deviceCount = data.devices ?? deviceCount;
      refresh();
      void backfillLocations(current);
      void reportLocation(position(), { force: true });
    } catch { /* Tracking availability must not prevent the transport UI loading. */ }
  }

  /** Watches made before notifications carried a location open the app
   *  instead of directions. Re-adding one with a known location fills it in;
   *  the worker keeps the watch and only stores the coordinates. */
  async function backfillLocations(current) {
    for (const watch of watches.filter((item) => !item.coordinates)) {
      const coordinates = locate(watch.kind, watch.targetId);
      if (!coordinates || current !== generation) continue;
      try { await send("POST", { ...watch, coordinates }); } catch { return; }
    }
  }

  /** Tell the worker where the phone is, for watches limited to a radius.
   *  It can only know while the page is open, so it hears on every fix, at
   *  most every 10 minutes unless the phone has moved 200 m. `here` is
   *  [lat, lon], geolocation's order. */
  let reported = null;
  async function reportLocation(here, { force = false } = {}) {
    if (!here || !signedIn() || !watches.some((watch) => watch.radius)) return;
    const coordinates = [here[1], here[0]];
    if (!force && reported && Date.now() - reported.at < 10 * 60_000 && metres(reported.coordinates, coordinates) < 200) return;
    reported = { coordinates, at: Date.now() };
    try {
      const data = await api("/tracking/location", { method: "POST", body: JSON.stringify({ coordinates }) });
      watches = data.watches;
      refresh();
    } catch { reported = null; /* the next fix tries again */ }
  }

  function metres([lon1, lat1], [lon2, lat2]) {
    const x = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
    return Math.hypot(x, lat2 - lat1) * 111_320;
  }

  async function send(method, body) {
    const data = await api("/tracking", { method, body: JSON.stringify(body) });
    watches = data.watches;
    deviceCount = data.devices ?? deviceCount;
  }

  async function toggle(watch) {
    if (busy) return;
    busy = true;
    try {
      const existing = find(watch);
      if (!existing) await enable();
      await send(existing ? "DELETE" : "POST", existing ? { id: existing.id } : watch);
    } finally {
      busy = false;
      refresh();
    }
  }

  /** A set is tracked when every member is; tapping a partly tracked set
   *  completes it, tapping a fully tracked one clears it. */
  async function toggleSet(set) {
    if (busy || !set.length) return;
    busy = true;
    try {
      const all = set.every((watch) => find(watch));
      if (!all) await enable();
      for (const watch of set) {
        const existing = find(watch);
        if (all) await send("DELETE", { id: existing.id });
        else if (!existing) await send("POST", watch);
      }
    } finally {
      busy = false;
      refresh();
    }
  }

  async function removeAll() {
    if (busy) return;
    busy = true;
    try {
      // One DELETE per watch: there are at most 20, and it needs no new route.
      for (const watch of [...watches]) {
        await send("DELETE", { id: watch.id });
      }
    } finally {
      busy = false;
      refresh();
    }
  }

  function isTracked(kind, targetId, line) {
    return watches.some((watch) => watch.kind === kind && watch.targetId === String(targetId) &&
      (line == null || watch.line === String(line).toUpperCase()));
  }

  function indicator(kind, targetId, line) {
    const icon = document.createElement("span");
    icon.className = "tracking-indicator";
    icon.hidden = !isTracked(kind, targetId, line);
    icon.title = "Tracking alerts enabled";
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", icon.title);
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
    return icon;
  }

  const BELL_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="bell-fill" d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>';
  const BELL_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/><path d="M12 2v1"/></svg>';

  // An icon, not a label: "Tracking · stop" pushed the ETA off a phone row.
  function bell(tracked, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn track-button";
    button.innerHTML = tracked ? BELL_ON : BELL_OFF;
    button.setAttribute("aria-pressed", String(tracked));
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      try { await onClick(); }
      catch (error) { window.alert(error.message); }
      finally { button.disabled = false; }
    });
    return button;
  }

  function button(watch) {
    const tracked = !!find(watch);
    return bell(tracked,
      `${tracked ? "Stop tracking" : "Track"} ${watch.kind === "bus" ? `line ${watch.line} at stop` : "bike station"} ${watch.targetId}${watch.destination ? ` towards ${watch.destination}` : ""}`,
      () => toggle(watch));
  }

  /** One bell for several watches, e.g. every boarding option of a hub. */
  function setButton(set, name) {
    const unique = [...new Map(set.map((watch) => [key(watch), watch])).values()];
    const tracked = unique.length > 0 && unique.every((watch) => find(watch));
    const button = bell(tracked,
      `${tracked ? "Stop tracking" : "Track"} all ${unique.length} boarding option${unique.length === 1 ? "" : "s"} to ${name}`,
      () => toggleSet(unique));
    button.disabled = unique.length === 0;
    return button;
  }

  /** Where a rack stands against the worker's rule: it arms below six bikes,
   *  alerts on every bike docked or taken until more than six are, and
   *  re-arms when it drops below six again. */
  function rackState(rack) {
    if (!rack) return "";
    const bikes = rack.bikes === 0 ? "Empty" : `${rack.bikes} ${rack.bikes === 1 ? "bike" : "bikes"}`;
    if (rack.armed) return `${bikes} · alerts on every change`;
    return `${bikes} · alerts once it drops below 6`;
  }

  function renderList(container) {
    container.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "muted";
    intro.textContent = "Buses: checked every 2 min; one alert per bus at 15 min or less. Bikes: checked every 30 sec; once a rack is below 6 bikes, an alert with the count for every bike docked or taken, until more than 6 are available. Tap an alert to limit it to a distance or to set hours.";
    container.append(intro);
    if (watches.length && !deviceCount) {
      const paused = document.createElement("p");
      paused.textContent = "Alerts are paused. Enable notifications on this device to resume checks.";
      container.append(paused);
    }
    if (!watches.length) {
      const empty = document.createElement("p");
      empty.textContent = "Open a stop or bike station and tap the bell.";
      container.append(empty);
    }
    for (const watch of watches) {
      const row = document.createElement("div");
      row.className = "tracking-item";
      // The row opens its radius and schedule; the bell stays on/off.
      const text = document.createElement("button");
      text.type = "button";
      text.className = "tracking-edit";
      text.setAttribute("aria-label", `Alert settings for ${watch.label || watch.targetId}`);
      text.addEventListener("click", () => openEditor(watch));
      text.textContent = `${watch.kind === "bus" ? `Line ${watch.line} · ` : ""}${watch.label || watch.targetId}${watch.destination ? ` → ${watch.destination}` : ""}`;
      const status = document.createElement("small");
      const checked = watch.lastCheck
        ? `checked ${new Date(watch.lastCheck).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "waiting for first check";
      const rack = rackState(watch.rack);
      status.textContent = watch.paused ? pausedText(watch.paused)
        : watch.error || (rack ? `${rack} · ${checked}` : checked.charAt(0).toUpperCase() + checked.slice(1));
      const limits = document.createElement("small");
      limits.textContent = limitsText(watch);
      text.append(document.createElement("br"), status, document.createElement("br"), limits);
      row.append(text, button(watch));
      container.append(row);
    }
    const enableButton = document.createElement("button");
    enableButton.type = "button";
    enableButton.textContent = thisDevice ? "Alerts enabled on this device" : "Enable alerts on this device";
    enableButton.addEventListener("click", async () => {
      enableButton.disabled = true;
      try { await enable(); refresh(); }
      catch (error) { window.alert(error.message); }
      finally { enableButton.disabled = false; }
    });
    container.append(enableButton);
  }

  const DAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const distance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);

  function pausedText(paused) {
    if (paused.reason === "far") return `Paused · ${distance(Math.round(paused.metres / 100) * 100)} away`;
    if (paused.reason === "stale") return "Paused · open Hubward nearby to resume";
    if (paused.reason === "schedule" && paused.resumes) {
      return `Paused · resumes ${new Date(paused.resumes).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
    }
    return "Paused";
  }

  /** "Within 1 km · Mo Tu We 15:00–18:00", or "Anywhere, any time". */
  function limitsText(watch) {
    const where = watch.radius ? `Within ${distance(watch.radius)}` : "Anywhere";
    const s = watch.schedule;
    if (!s) return `${where}, any time`;
    const days = s.days.length === 7 ? "every day"
      : [1, 2, 3, 4, 5, 6, 0].filter((d) => s.days.includes(d)).map((d) => DAY_NAMES[d]).join(" ");
    return `${where} · ${days} ${s.from}–${s.to}`;
  }

  // The editor dialog lives in index.html; it is filled per watch here.
  const editor = {
    dialog: document.getElementById("tracking-edit-dialog"),
    form: document.getElementById("tracking-edit-form"),
    title: document.getElementById("tracking-edit-title"),
    target: document.getElementById("tracking-edit-target"),
    radius: document.getElementById("tracking-edit-radius"),
    days: document.getElementById("tracking-edit-days"),
    hours: document.getElementById("tracking-edit-hours"),
    from: document.getElementById("tracking-edit-from"),
    to: document.getElementById("tracking-edit-to"),
    error: document.getElementById("tracking-edit-error"),
    save: document.getElementById("tracking-edit-save"),
    watch: null,
  };
  const pickedDays = () => [...editor.days.querySelectorAll("button[aria-pressed=true]")].map((b) => Number(b.dataset.day));
  const showHours = () => {
    const any = pickedDays().length > 0;
    editor.hours.hidden = !any;
    editor.from.required = editor.to.required = any;
  };
  editor.radius.addEventListener("click", (event) => {
    const choice = event.target.closest("button");
    if (!choice) return;
    for (const b of editor.radius.querySelectorAll("button")) b.setAttribute("aria-selected", String(b === choice));
  });
  editor.days.addEventListener("click", (event) => {
    const day = event.target.closest("button");
    if (!day) return;
    day.setAttribute("aria-pressed", String(day.getAttribute("aria-pressed") !== "true"));
    showHours();
  });
  document.getElementById("tracking-edit-cancel").addEventListener("click", () => editor.dialog.close());
  editor.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const watch = editor.watch;
    if (!watch) return;
    const days = pickedDays();
    if (days.length && editor.from.value === editor.to.value) {
      editor.error.textContent = "Start and end need to differ.";
      editor.error.hidden = false;
      return;
    }
    const radius = editor.radius.querySelector("button[aria-selected=true]")?.dataset.radius;
    editor.save.disabled = true;
    try {
      const data = await api("/tracking", { method: "PATCH", body: JSON.stringify({
        id: watch.id,
        radius: radius ? Number(radius) : null,
        schedule: days.length ? { days, from: editor.from.value, to: editor.to.value } : null,
      }) });
      watches = data.watches;
      editor.dialog.close();
      refresh();
      void reportLocation(position(), { force: true });
    } catch (error) {
      editor.error.textContent = error.message;
      editor.error.hidden = false;
    } finally {
      editor.save.disabled = false;
    }
  });

  function openEditor(watch) {
    editor.watch = watch;
    editor.title.textContent = watch.label || (watch.kind === "bike" ? `Station ${watch.targetId}` : `Stop ${watch.targetId}`);
    editor.target.textContent = watch.kind === "bus"
      ? `Line ${watch.line}${watch.destination ? ` → ${watch.destination}` : ""} at stop ${watch.targetId}`
      : `Bike station ${watch.targetId}`;
    if (!watch.coordinates) editor.target.textContent += " · location unknown, so the distance limit cannot apply yet";
    for (const b of editor.radius.querySelectorAll("button")) {
      b.setAttribute("aria-selected", String(b.dataset.radius === String(watch.radius ?? "")));
    }
    const days = watch.schedule?.days ?? [];
    for (const b of editor.days.querySelectorAll("button")) b.setAttribute("aria-pressed", String(days.includes(Number(b.dataset.day))));
    editor.from.value = watch.schedule?.from ?? "15:00";
    editor.to.value = watch.schedule?.to ?? "18:00";
    editor.error.hidden = true;
    showHours();
    editor.dialog.showModal();
  }

  async function disconnect() {
    if (!supported()) return;
    const reg = await navigator.serviceWorker.getRegistration(new URL("./", import.meta.url));
    const subscription = await reg?.pushManager.getSubscription();
    if (!subscription) return;
    await api("/tracking/subscription", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
    await subscription.unsubscribe();
  }
  return { load, checkIn, reportLocation, button, setButton, removeAll, count: () => watches.length, indicator, isTracked, renderList, disconnect, clear() { generation++; watches = []; refresh(); } };
}
