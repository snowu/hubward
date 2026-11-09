/* Installing Hubward as an app. Ported from Spritewright's pages/install.js
 * (Hex Lab carries an older copy), so the three Pages apps behave alike:
 *
 * - Chromium fires beforeinstallprompt only while the app is installable and
 *   not installed. That event is kept here, and nowhere else: a prompt can be
 *   shown once per event, so two owners would race for it.
 * - A small banner offers the install a moment after load. "Not now" quiets
 *   the banner for 30 days, per app path, so another snowu.github.io app's
 *   dismissal cannot silence this one, and a timestamp from the future (an
 *   old "installed, never ask" stamp) does not count.
 * - The account menu's "Install Hubward" button stays available whatever the
 *   banner does: dismissing the banner is not refusing the app.
 * - A prompt declined in the browser's own dialog counts as "Not now"; an
 *   accepted or failed one clears the stamp, so a later uninstall can offer
 *   it again.
 * - Nothing is offered in standalone mode, and other browsers, which never
 *   fire the event, see nothing.
 *
 * Every element lives in index.html, like every other control: this only
 * shows and hides them. A classic script, independent of app.js, so a fault
 * in either cannot take the other down.
 */
(() => {
  "use strict";
  // The worker only handles pushes (sw.js has no fetch handler), but
  // registering it on load, not only when alerts are switched on, is what
  // Spritewright does and keeps installability from depending on alerts.
  // Same URL and scope tracking.js registers, so it is one registration.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js", { scope: "./", updateViaCache: "none" }).catch(() => {});
    });
  }

  const KEY = `hubward:installDismiss:${new URL(".", document.baseURI).pathname}`;
  const COOLDOWN = 30 * 24 * 3600 * 1000;
  const DELAY = 1200;
  const banner = document.getElementById("install-banner");
  const menuButton = document.getElementById("app-install");
  if (!banner || !menuButton) return;
  let deferred = null;
  let scheduled = false;

  const standalone = () =>
    window.matchMedia?.("(display-mode: standalone)").matches || window.navigator?.standalone === true;
  const dismissed = () => {
    try {
      const at = Number(JSON.parse(localStorage.getItem(KEY) || "0"));
      return Number.isFinite(at) && at > 0 && at <= Date.now() && Date.now() - at < COOLDOWN;
    } catch {
      return false;
    }
  };
  const stamp = (value) => { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private mode */ } };
  const clearDismissal = () => { try { localStorage.removeItem(KEY); } catch { /* private mode */ } };

  function hideAll() {
    banner.hidden = true;
    menuButton.hidden = true;
  }

  async function install() {
    const event = deferred;
    if (!event) return;
    deferred = null; // each event may be prompted once
    hideAll();
    const menu = document.getElementById("account-menu");
    if (menu?.open) menu.close();
    try {
      const choice = await event.prompt();
      const result = event.userChoice ? await event.userChoice : choice;
      if (result?.outcome === "dismissed") stamp(Date.now());
      else clearDismissal();
    } catch {
      // A failed prompt must not suppress a later valid install event.
      clearDismissal();
    }
  }

  function show() {
    if (!banner.hidden || !deferred || standalone() || dismissed()) return;
    // A dialog owns the top layer (sign-in, a stop sheet): wait until it closes.
    if (document.querySelector("dialog[open]")) { maybe(); return; }
    banner.hidden = false;
  }

  function maybe() {
    if (scheduled || !banner.hidden) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; show(); }, DELAY);
  }

  banner.querySelector("[data-install]").addEventListener("click", install);
  banner.querySelector("[data-dismiss]").addEventListener("click", () => {
    stamp(Date.now());
    banner.hidden = true; // the event stays, for the account menu's button
  });
  menuButton.addEventListener("click", install);

  window.addEventListener("beforeinstallprompt", (event) => {
    if (standalone()) return;
    try { event.preventDefault(); } catch { /* the banner replaces Chrome's mini-infobar */ }
    deferred = event;
    menuButton.hidden = false;
    maybe();
  });
  window.addEventListener("appinstalled", () => {
    clearDismissal();
    deferred = null;
    hideAll();
  });
})();
