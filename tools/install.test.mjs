/** web/install.js against the real index.html, in jsdom.
 *
 * The cases are Spritewright's test/install.test.mjs, where this script came
 * from, plus Hubward's own: the account menu's button instead of a header
 * button, and waiting for an open dialog. Runs from `npm test` (pretest).
 *
 *   node --test tools/install.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { JSDOM } = createRequire(join(root, "api", "package.json"))("jsdom");
const html = readFileSync(join(root, "web", "index.html"), "utf8");
const code = readFileSync(join(root, "web", "install.js"), "utf8");
const KEY = "hubward:installDismiss:/hubward/";

function browser({ storage = {}, standalone = false, blockedStorage = false } = {}) {
  const dom = new JSDOM(html, { url: "https://snowu.github.io/hubward/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  if (blockedStorage) {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
  }
  window.matchMedia = () => ({ matches: standalone, addEventListener() {} });
  const timers = [];
  window.setTimeout = (fn) => timers.push(fn);
  window.eval(code);
  const $ = (id) => window.document.getElementById(id);
  return {
    window,
    banner: $("install-banner"),
    menuButton: $("app-install"),
    stored: () => window.localStorage.getItem(KEY),
    tick: () => timers.splice(0).forEach((fn) => fn()),
    eligible(outcome = "accepted", { fail = false } = {}) {
      const event = new window.Event("beforeinstallprompt", { cancelable: true });
      event.calls = 0;
      event.prompt = async () => { event.calls += 1; if (fail) throw new Error("prompt failed"); };
      event.userChoice = Promise.resolve({ outcome });
      window.dispatchEvent(event);
      return event;
    },
    click: (el) => el.click(),
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("offers the install in a banner and the account menu, and installs once", async () => {
  const b = browser();
  const event = b.eligible();
  assert.equal(event.defaultPrevented, true);
  assert.equal(b.menuButton.hidden, false);
  assert.equal(b.banner.hidden, true, "the banner waits a moment after load");
  b.tick();
  assert.equal(b.banner.hidden, false);
  b.click(b.banner.querySelector("[data-install]"));
  await b.settle();
  assert.equal(event.calls, 1);
  assert.equal(b.banner.hidden, true);
  assert.equal(b.menuButton.hidden, true);
  assert.equal(b.stored(), null);
  b.click(b.menuButton);
  await b.settle();
  assert.equal(event.calls, 1, "an event is prompted once");
});

test("Not now hides only the banner; the account menu still installs", async () => {
  const b = browser();
  const event = b.eligible();
  b.tick();
  b.click(b.banner.querySelector("[data-dismiss]"));
  assert.equal(b.banner.hidden, true);
  assert.equal(b.menuButton.hidden, false);
  assert.ok(Number(b.stored()) <= Date.now());
  b.click(b.menuButton);
  await b.settle();
  assert.equal(event.calls, 1);
  assert.equal(b.stored(), null, "an accepted install clears the dismissal");
});

test("a recent dismissal quiets the banner for 30 days, never the menu button", async () => {
  const b = browser({ storage: { [KEY]: String(Date.now() - 24 * 3600 * 1000) } });
  b.eligible("dismissed");
  b.tick();
  assert.equal(b.banner.hidden, true);
  assert.equal(b.menuButton.hidden, false);
  b.click(b.menuButton);
  await b.settle();
  const stamp = Number(b.stored());
  assert.ok(stamp <= Date.now() && stamp > Date.now() - 10_000, "declining in the browser counts as Not now");
  const old = browser({ storage: { [KEY]: String(Date.now() - 31 * 24 * 3600 * 1000) } });
  old.eligible();
  old.tick();
  assert.equal(old.banner.hidden, false, "after 30 days it asks again");
});

test("a future timestamp or another Pages app cannot suppress this one", () => {
  for (const storage of [
    { [KEY]: String(Date.now() + 1e15) },
    { "hubward:installDismiss:/spritewright/": String(Date.now()) },
    { "spritewright:installDismiss:/spritewright/": String(Date.now()) },
  ]) {
    const b = browser({ storage });
    b.eligible();
    b.tick();
    assert.equal(b.banner.hidden, false, JSON.stringify(storage));
  }
});

test("a failed prompt does not suppress a later offer", async () => {
  const b = browser({ storage: { [KEY]: String(Date.now()) } });
  b.eligible("accepted", { fail: true });
  b.click(b.menuButton);
  await b.settle();
  assert.equal(b.stored(), null);
  b.eligible();
  b.tick();
  assert.equal(b.banner.hidden, false);
});

test("nothing is offered when already running as an installed app", () => {
  const b = browser({ standalone: true });
  const event = b.eligible();
  b.tick();
  assert.equal(event.defaultPrevented, false);
  assert.equal(b.banner.hidden, true);
  assert.equal(b.menuButton.hidden, true);
});

test("the banner waits for an open dialog, and installing hides everything", () => {
  const b = browser();
  b.window.document.getElementById("account-menu").setAttribute("open", "");
  b.eligible();
  b.tick();
  assert.equal(b.banner.hidden, true, "not over a dialog");
  b.window.document.getElementById("account-menu").removeAttribute("open");
  b.tick();
  assert.equal(b.banner.hidden, false);
  b.window.dispatchEvent(new b.window.Event("appinstalled"));
  assert.equal(b.banner.hidden, true);
  assert.equal(b.menuButton.hidden, true);
});

test("blocked storage still installs", async () => {
  const b = browser({ blockedStorage: true });
  const event = b.eligible();
  b.tick();
  assert.equal(b.banner.hidden, false);
  b.click(b.banner.querySelector("[data-install]"));
  await b.settle();
  assert.equal(event.calls, 1);
});
