import { createTracking } from "./tracking.js";
import { mapsDirections } from "./directions.js";
import { setupEmtAccount } from "./emt-account.js";
import { createLive } from "./live.js";
import {
  readCache,
  writeArrivalCache,
  readNearbyCell,
  writeNearbyCell,
  readStops,
  writeStops,
  readDetails,
  writeDetail,
  readBikeSaved,
  writeBikeSaved,
  readBikeNear,
  writeBikeNear,
  readBikeAccount,
  writeBikeAccount,
  readBikeTrips,
  writeBikeTrips,
  setUserCacheScope,
} from "./cache.js";
import {
  mergeTripHistory,
  tripIdentity,
  tripsAreOldestFirst,
  updateTripDiagnostics,
  mergeTripDiagnostics,
  TRIP_DIAGNOSTIC_LABELS,
} from "./trips.js";

/** The basemap, for every map in the app.
 *
 * Six call sites had drifted onto two providers — CARTO dark for the two maps
 * a redesign happened to touch, OpenStreetMap for the four it did not — which
 * meant a dark bus map sitting next to light bike maps in the same session.
 * Nobody chose that; it was just where the redesign stopped.
 *
 * CARTO began requiring a key in August 2026 and watermarks unauthenticated
 * tiles. `CARTO_KEY` is the one place to put it. Empty means the tiles still
 * render, watermarked — a legible degradation rather than a blank map.
 */
// Free tier, non-commercial: 5M tile requests a month against roughly 100k of
// expected use. It is a browser key, so it ships in this file and is public by
// nature — CARTO scopes it by domain rather than by secrecy.
const CARTO_KEY = "cb1_28ep_1_fa139875e4e92c05028f7b23";
// Vector, because CARTO is retiring raster. `dark-matter-nolabels-gl-style`
// is the exact equivalent of the old `dark_nolabels` raster style — it is
// missing from their migration table, but it exists.
const BASEMAP_STYLE =
  `https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json?key=${CARTO_KEY}`;
// Attribution comes from the source's TileJSON, which MapLibre fetches and
// renders — verified live as "© CARTO, © OpenStreetMap contributors", which
// satisfies the free tier's condition. Adding our own on top only duplicated
// it. The style.json's inline source carries none, which is what misled me.

/** Every map in the app.
 *
 * MapLibre takes [lng, lat], which is the order EMT already hands us, so
 * coordinates go in unflipped — the opposite of Leaflet, which wanted
 * [lat, lon] and made a flip necessary at every call site.
 *
 * `interactive: false` replaces the six separate options Leaflet needed to
 * make a map behave as a picture rather than something to navigate.
 */
function createMap(container, { center, zoom = 15, interactive = true, controls = false } = {}) {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    center,
    zoom,
    interactive,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }));
  // A GL map asks for no tiles until its container has a real size, and these
  // are all created inside dialogs or panes that start hidden. Leaflet needed
  // the same nudge via invalidateSize; miss it and you get a blank map that
  // has successfully loaded its style.
  map.once("load", () => {
    map.resize();
    // MapLibre renders even the compact attribution expanded to start with.
    // On a phone-first map the credit belongs behind the ⓘ until asked for —
    // it stays one tap away, which is what CARTO's terms require.
    map.getContainer().querySelector(".maplibregl-ctrl-attrib")
      ?.classList.remove("maplibregl-compact-show");
  });
  if (controls) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  return map;
}

const MADRID = [-3.7038, 40.4168];

/** MapLibre's LngLatBounds has no `pad`, and the raw viewport is a hard edge:
 *  a stop one pixel outside it would flicker in and out while panning. */
function paddedBounds(map, ratio) {
  const box = map.getBounds();
  const dLng = (box.getEast() - box.getWest()) * ratio;
  const dLat = (box.getNorth() - box.getSouth()) * ratio;
  return new maplibregl.LngLatBounds(
    [box.getWest() - dLng, box.getSouth() - dLat],
    [box.getEast() + dLng, box.getNorth() + dLat],
  );
}

/** `myLocation` is [lat, lon] — geolocation's order, and what every distance
 *  calculation in this file expects. MapLibre wants [lng, lat]. Flip here and
 *  nowhere else; EMT's own coordinates are already [lon, lat] and go straight
 *  through untouched. */
function myLngLat() {
  return myLocation ? [myLocation[1], myLocation[0]] : MADRID;
}

/** A DOM element marker, which is how every custom pin in this app is drawn:
 *  it keeps the stylesheet doing the work instead of restating each pin as GL
 *  paint properties. */
function domMarker(html, className, lngLat, options = {}) {
  const element = document.createElement("div");
  element.className = className;
  element.innerHTML = html;
  return new maplibregl.Marker({ element, ...options }).setLngLat(lngLat);
}

const API = "https://emt-arrivals.zancato-t.workers.dev";
const THEME_KEY = "emt:theme";
const HUB_CARD_LIMIT = 3;
const NEAREST_BIKE_STATION_LIMIT = 2;
// Hubs per /journeys request. One until the worker says it can take more:
// each response carries its limit, which is how a plan upgrade reaches the
// page without a release.
let journeyBatchSize = 1;
const savedTheme = localStorage.getItem(THEME_KEY);
let themeChoice = ["light", "dark"].includes(savedTheme) ? savedTheme : "system";
if (themeChoice === "system") document.documentElement.removeAttribute("data-theme");
else document.documentElement.dataset.theme = themeChoice;
let authClient = null;
let authSession = null;
let authUser = null;
// The map's boards arrive over sockets; polling covers whatever is not live.
const live = createLive({
  base: API,
  token: () => authSession?.access_token ?? null,
  onBoard: (board) => putBoard(board.stopId, board),
});
// null until /auth/emt answers, so requests sent before then are not
// counted as coming from an unconnected account.
let emtConnected = null;
// Flip back to true once the worker from #15 onwards is deployed.
const SEND_AUDIENCE = false;
let isOwner = false;
let myLocation = null;
let places = [];
let journeyPayload = null;
let journeyInitialPending = true;
let journeyCell = null;
let journeyLoadedAt = 0;
let journeyTimer = null;
let journeyRerun = false;
let busListMode = localStorage.getItem("emt:bus-list-mode") === "stops" ? "stops" : "places";

const listEl = document.getElementById("stops");
const statusEl = document.getElementById("status");
const mapEl = document.getElementById("map");
const viewListBtn = document.getElementById("view-list");
const viewMapBtn = document.getElementById("view-map");
const addDialog = document.getElementById("add-dialog");
const addStopMapEl = document.getElementById("add-stop-map");
const addStopNearbyList = document.getElementById("add-stop-nearby");
const addStopMessage = document.getElementById("add-stop-message");
const authButton = document.getElementById("auth-button");
const authDialog = document.getElementById("auth-dialog");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authMessage = document.getElementById("auth-message");
const accountMenu = document.getElementById("account-menu");
const accountMenuEmail = document.getElementById("account-menu-email");
const accountSignout = document.getElementById("account-signout");
const metricsOpen = document.getElementById("metrics-open");
const metricsDialog = document.getElementById("metrics-dialog");
const metricsContent = document.getElementById("metrics-content");
const metricsRangeButtons = [...document.querySelectorAll("[data-metrics-hours]")];
const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
const placesDialog = document.getElementById("places-dialog");
const placesForm = document.getElementById("places-form");
const placesList = document.getElementById("places-list");
const placesMessage = document.getElementById("places-message");
const busModePlaces = document.getElementById("bus-mode-places");
const busModeStops = document.getElementById("bus-mode-stops");
const menuBikes = document.getElementById("menu-bikes");
const headerContext = document.getElementById("header-context");
const nearbyStopsDialog = document.getElementById("nearby-stops-dialog");
const nearbyStopsList = document.getElementById("nearby-stops-list");
const nearbyStopsMessage = document.getElementById("nearby-stops-message");
const placeEditor = document.getElementById("place-editor");
const placeSearchResults = document.getElementById("place-search-results");
const placePicked = document.getElementById("place-picked");
let placePickerMap = null;
let placePickerMarker = null;
let placeDraft = null;

function setTheme(choice) {
  themeChoice = ["light", "dark"].includes(choice) ? choice : "system";
  if (themeChoice === "system") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  } else {
    document.documentElement.dataset.theme = themeChoice;
    localStorage.setItem(THEME_KEY, themeChoice);
  }
  for (const button of themeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === themeChoice));
  }
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.content = themeChoice === "system"
      ? (meta.media.includes("light") ? "#f4f6fa" : "#12141a")
      : (themeChoice === "light" ? "#f4f6fa" : "#12141a");
  }
}

for (const button of themeButtons) {
  button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
}
setTheme(themeChoice);

// One fetch feeds both: the card glances at the first two, the sheet shows
// the board. The worker serves both from one shared cached payload.
const CARD_ARRIVALS = 2;
const BOARD_ARRIVALS = 8;

let stops = [];
// Every arrival board the page holds, one per stop id: saved stops, map
// previews, route probes and the boards journeys were planned on. Cards, hub
// cards, the stop sheet, popups and live buses all read this one record, and
// putBoard() re-renders all of them, so no two views of a stop can disagree.
// Only saved stops' boards are persisted.
let arrivals = readCache();
const boardFailures = new Set(); // stops whose last fetch failed with no board to show
let details = readDetails();

function stopTitle(stop) {
  return stop.label || details[stop.stop_id]?.name || `Stop ${stop.stop_id}`;
}

/** The lines EMT says serve this stop — the answer to "why is nothing due?".
 *
 * Detail gives objects with the signed label and today's service hours; area
 * search gives bare codes. Devices that cached the old string-only shape are
 * still out there, so tolerate both rather than blanking their cards.
 */
function normaliseLine(l) {
  return typeof l === "string"
    ? { line: l, label: l, from: null, to: null, dayType: null, headers: [] }
    : l;
}

function lineIdentity(value) {
  const raw = typeof value === "object" ? value?.line ?? value?.label : value;
  const code = String(raw ?? "").trim().toUpperCase();
  return /^\d+$/.test(code) ? code.replace(/^0+(?=\d)/, "") : code;
}

/** A stable colour per line, used for its label everywhere and for its route
 *  on the map — same line, same colour, on every surface.
 *
 * Hue comes from the line code by an FNV-1a hash quantised into 24 steps, so
 * neighbouring codes land far apart on the wheel instead of in the same muddy
 * corner. Saturation and lightness each get a hash bit, kept to values that
 * stay readable on the dark card.
 */
const lineColorCache = new Map();

function lineColor(code) {
  const key = String(code ?? "");
  const hit = lineColorCache.get(key);
  if (hit) return hit;

  // FNV-1a: small keys like "5" and "107" have to land far apart, which a
  // plain multiply-and-add hash does not guarantee.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Quantised into 24 hues and two tones: a free-running hue puts two lines
  // five degrees apart often enough to matter on a card listing six of them.
  // Colliding outright is fine; looking almost-the-same is not.
  const hue = (hash % 24) * 15;
  const light = ((hash >>> 5) & 1) ? 66 : 52;
  const sat = ((hash >>> 6) & 1) ? 75 : 55;
  const color = `hsl(${hue} ${sat}% ${light}%)`;
  lineColorCache.set(key, color);
  return color;
}

/** Hours for lines whose stop has no detail record, keyed by line code.
 *  undefined = never asked or in flight, null = asked and got nothing. */
const lineHours = new Map();

function minutesOf(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Today's service windows for every line at this stop.
 *
 * Two sources, same shape: a stop with a detail record carries its own hours,
 * and one without borrows the line's. `fetchMissing` is off for stops you have
 * not saved — browsing the map should not fire a request per line per pin.
 */
function serviceWindows(stopId, { fetchMissing = false } = {}) {
  const today = todayDayType();
  const windows = [];
  for (const line of stopLines(stopId)) {
    if (line.from && line.to) {
      windows.push({
        label: line.label,
        from: line.from,
        to: line.to,
        overnight: minutesOf(line.to) < minutesOf(line.from),
      });
      continue;
    }
    const days = lineHours.get(line.line);
    if (days === undefined) {
      if (fetchMissing) fetchLineHours(line.line);
      continue;
    }
    const row = days?.find((d) => d.dayType === today);
    if (row?.from && row?.to) windows.push({ ...row, label: line.label });
  }
  return windows;
}

/** When the first bus is expected, for a stop with nothing due.
 *
 * Returns null when a line should be running right now — then an empty board
 * means EMT has no estimate, not that the stop is asleep, and promising a
 * first bus at 07:00 when it is 09:00 would be a lie.
 */
function nextServiceStart(stopId, { fetchMissing = false } = {}) {
  const windows = serviceWindows(stopId, { fetchMissing });
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  let best = null;
  for (const w of windows) {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (from == null || to == null) continue;
    const running = w.overnight ? nowMins >= from || nowMins <= to : nowMins >= from && nowMins <= to;
    if (running) return null;
    // Already past today: the next one is tomorrow's.
    const wait = from >= nowMins ? from - nowMins : from + 1440 - nowMins;
    if (!best || wait < best.wait) best = { wait, at: w.from, label: w.label };
  }
  return best;
}

function fmtWait(mins) {
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

/** What an empty arrival board should say. */
function emptyBoardText(stopId, { fetchMissing = false } = {}) {
  const next = nextServiceStart(stopId, { fetchMissing });
  if (!next) return "No buses due right now";
  return `First bus ${next.at} · ${next.label} · ${fmtWait(next.wait)}`;
}

/** Which timetable applies today: LA (weekday), SA, or FE (Sunday/holiday).
 *
 * EMT stamps it on every stop detail it sends, which beats deriving it from
 * the date — that would call a public holiday an ordinary Tuesday. We only
 * fall back to the weekday when no saved stop has a detail record at all.
 */
function todayDayType() {
  for (const detail of Object.values(details)) {
    for (const line of detail?.lines ?? []) {
      const stamped = normaliseLine(line).dayType;
      if (stamped) return stamped;
    }
  }
  const day = new Date().getDay();
  return day === 0 ? "FE" : day === 6 ? "SA" : "LA";
}

/** The lines a stop serves, each listed once, preferring the richer record.
 *
 * Two identity spaces collide here. EMT's code and the label a bus is signed
 * with differ for the same line (519 is signed N19, 833 is SE833), so an
 * arrival naming "N19" has to be recognised as detail's 519. But codes and
 * labels are not interchangeable either: line 001 is signed "1" while a
 * *different* line, 361, is signed "001". Treating identity as symmetric
 * merges those two into one and loses a real line.
 *
 * So the rule is directional. Detail entries deduplicate on their code alone.
 * An arrival, which only ever names a label, is added only when neither the
 * codes nor the labels already seen account for it.
 */
function stopLines(stopId) {
  const known = [];
  const codes = new Set();
  const labels = new Set();
  for (const entry of details[stopId]?.lines ?? []) {
    const line = normaliseLine(entry);
    const code = lineIdentity(line.line);
    if (!code || codes.has(code)) continue;
    codes.add(code);
    labels.add(lineIdentity(line.label));
    known.push(line);
  }
  // EMT's stop-detail catalogue has holes for valid stops. Arrivals is a
  // separate source and still identifies the routes serving those stops, so
  // it completes the list. It reports the label ("5") where detail and area
  // search carry the code ("005"), so identity — never the raw string — is
  // what tells one line from another across the two; comparing the strings
  // listed the same line twice in every stop that needed healing.
  for (const arrival of arrivals[stopId]?.arrivals ?? []) {
    const id = lineIdentity(arrival.line);
    if (!id || codes.has(id) || labels.has(id)) continue;
    codes.add(id);
    labels.add(id);
    known.push(normaliseLine(arrival.line));
  }
  return known;
}

function metresBetweenCoordinates([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const y = lat2 - lat1;
  return Math.round(Math.sqrt(x * x + y * y) * 111_320);
}

function metresFromCurrent(coordinates) {
  if (!myLocation || !Array.isArray(coordinates)) return null;
  return metresBetweenCoordinates([myLocation[1], myLocation[0]], coordinates);
}

function proximity(value) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

function formatDistance(metres) {
  if (metres == null) return null;
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

/** "Nº 30 · 107 · 129 · 5", each line in its own colour.
 *
 * Built as nodes rather than a string so the labels carry the same colour here
 * as on the map and in the arrival rows — a plain grey run of numbers is the
 * one place the colours were missing.
 */
/** "How far away is it", written the same way everywhere.
 *
 * Saved stops carried the ◎ mark while hubs and bike stations printed a bare
 * number, so the same fact looked like three different fields depending on
 * which card you were reading.
 */
function distanceLabel(metres) {
  const text = formatDistance(metres);
  return text ? `◎ ${text}` : null;
}

function stopMetaNode(stopId) {
  const wrap = document.createDocumentFragment();
  wrap.append(`Nº ${stopId}`);
  for (const line of stopLines(stopId)) {
    wrap.append(" · ");
    const label = document.createElement("span");
    label.className = "meta-line";
    label.textContent = line.label;
    label.style.color = lineColor(line.label);
    wrap.append(label);
  }
  const distance = distanceLabel(metresFromCurrent(details[stopId]?.coordinates));
  if (distance) wrap.append(` · ${distance}`);
  return wrap;
}

/** A detail with no coordinates is the stub we save when EMT answers 81. */
function isStub(detail) {
  return !detail || !detail.coordinates;
}

// Past a day out, EMT is not counting down to anything: 888888 is "running to
// schedule, no GPS estimate yet" and 999999 marks a vehicle's *next* run.
const SCHEDULED_SECONDS = 24 * 3600;

function fmtCountdown(seconds) {
  // EMT's sentinel: "running on schedule, no GPS estimate yet". Not a
  // countdown; render it as words.
  if (seconds >= SCHEDULED_SECONDS) return "scheduled";
  if (seconds <= 0) return "due";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  // Bare m:ss. A stop is never an hour out in practice, and dropping the unit
  // letters makes every countdown the same shape — which, with tabular
  // figures, means the column stops twitching as the seconds tick.
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  // A stop is never really an hour out. If EMT says otherwise, the exact
  // figure is not the point and "72:05" would read as a broken clock.
  return ">1h";
}

function fmtAge(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function updateFreshnessDot(dot, fetchedAt) {
  const ageMs = fetchedAt ? Math.max(0, Date.now() - Number(fetchedAt)) : null;
  const state = ageMs == null ? "unknown" : ageMs < 60_000
    ? "fresh" : ageMs < 5 * 60_000 ? "aging" : "stale";
  const label = fetchedAt ? `Updated ${fmtAge(Number(fetchedAt))}` : "Never updated";
  dot.className = `freshness-dot ${state}`;
  dot.title = label;
  dot.setAttribute("aria-label", label);
}

function freshnessDot(fetchedAt) {
  const dot = document.createElement("span");
  dot.dataset.fetchedAt = fetchedAt ? String(fetchedAt) : "";
  updateFreshnessDot(dot, fetchedAt);
  return dot;
}

function openWalkingDirections(coordinates) {
  if (!coordinates) return;
  const [lon, lat] = coordinates;
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${lat},${lon}`);
  url.searchParams.set("travelmode", "walking");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

const WALKING_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="1.8"></circle><path d="m10.5 8 2.5-1 2.5 2.5 2.5 1"></path><path d="m13 7-2 5 3 2 1.5 5"></path><path d="m11 12-3 3-2 4"></path></svg>';
const BIKE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="16" r="3.5"></circle><circle cx="18" cy="16" r="3.5"></circle><path d="m6 16 4-7h6l2 7M10 9l2 7h-6M9 6h3M15 6h2l-1 3"></path></svg>';
// A line with a stop at each end. The old zigzag was meant to read as a route
// and read as a letter N instead.
const LINES_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M6 17c0-4 2-5 6-5s6-1 6-5"></path>'
  + '<circle cx="6" cy="17.5" r="2.2" fill="currentColor" stroke="none"></circle>'
  + '<circle cx="18" cy="6.5" r="2.2" fill="currentColor" stroke="none"></circle></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M20 12a8 8 0 1 1-2.4-5.7"></path><path d="M20 4v4.5h-4.5"></path></svg>';
const REMOVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M7 7l10 10M17 7 7 17"></path></svg>';

// The header and the stop sheet were still drawing a ↻ text glyph, which sits
// on a different baseline and weight from the drawn icons beside it. One
// refresh mark everywhere, defined once.
for (const id of ["refresh-all", "sheet-refresh"]) {
  document.getElementById(id).innerHTML = REFRESH_ICON;
}
const INFO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none"></circle></svg>';

function openTransitDirections(place) {
  if (!myLocation || !place) return;
  const [lat, lon] = myLocation;
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", `${lat},${lon}`);
  url.searchParams.set("destination", `${place.lat},${place.lon}`);
  url.searchParams.set("travelmode", "transit");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

function placeDistance(place) {
  if (!myLocation) return null;
  return metresBetweenCoordinates([myLocation[1], myLocation[0]], [place.lon, place.lat]);
}

function activeDestinations() {
  return places.filter((place) => place.enabled !== false &&
    (placeDistance(place) == null || placeDistance(place) > place.geofence_radius_m))
    .sort((a, b) => proximity(placeDistance(a)) - proximity(placeDistance(b)))
    .slice(0, HUB_CARD_LIMIT);
}

/* ---- Go anywhere -------------------------------------------------------- */

// A one-off destination: somewhere searched for rather than saved as a Hub.
// It is planned exactly like one and drawn as the first card. It survives a
// reload — you search, put the phone away, and look again at the corner — but
// not the day.
// Per user, like every other personal cache: it is where someone is going.
const goKey = () => (authUser ? `emt:go:${authUser.id}` : null);
const GO_ID = "go";
const GO_KEEP_MS = 12 * 3600 * 1000;
const WALK_SHOWN_UP_TO_M = 3000;

function readGoPlace() {
  if (!goKey()) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(goKey()) ?? "null");
    if (!saved || Date.now() - Number(saved.setAt) > GO_KEEP_MS) return null;
    if (!Number.isFinite(saved.lat) || !Number.isFinite(saved.lon)) return null;
    return { id: GO_ID, name: String(saved.name ?? "Destination"), address: saved.address ?? null,
      lat: saved.lat, lon: saved.lon, setAt: saved.setAt };
  } catch {
    return null;
  }
}

let goPlace = null;

function setGoPlace(place) {
  goPlace = place
    ? { id: GO_ID, name: place.name, address: place.address ?? null, lat: place.lat, lon: place.lon, setAt: Date.now() }
    : null;
  try {
    if (goPlace && goKey()) localStorage.setItem(goKey(), JSON.stringify(goPlace));
    else if (goKey()) localStorage.removeItem(goKey());
  } catch {
    // A private window still plans; it just forgets on reload.
  }
  if (journeyPayload) {
    journeyPayload = { ...journeyPayload,
      destinations: journeyPayload.destinations.filter((item) => item.destination.id !== GO_ID) };
  }
  renderGoForm();
  render();
  if (goPlace) scheduleJourneys({ force: true });
}

const goForm = document.getElementById("go-form");
const goQuery = document.getElementById("go-query");
const goResults = document.getElementById("go-results");
const goCurrent = document.getElementById("go-current");
const goMessage = document.getElementById("go-message");

function renderGoForm() {
  // The body's dataset rather than `section`, which is declared further down
  // and is not readable yet on the first render.
  goForm.hidden = !authSession || document.body.dataset.section === "bikes"
    || busListMode !== "places" || listEl.hidden;
  goCurrent.hidden = !goPlace;
  document.getElementById("go-current-name").textContent = goPlace ? `To ${goPlace.name}` : "";
}

goForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = goQuery.value.trim();
  if (query.length < 3) {
    goMessage.textContent = "Type at least three letters";
    return;
  }
  const button = document.getElementById("go-search");
  button.disabled = true;
  goMessage.textContent = "Searching Madrid…";
  try {
    const results = await api(`/places/geocode?q=${encodeURIComponent(query)}`);
    goResults.replaceChildren(...results.map((result) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = result.displayName;
      choice.addEventListener("click", () => {
        goResults.replaceChildren();
        goQuery.value = "";
        goQuery.blur();
        goMessage.textContent = "";
        setGoPlace({
          // The first part of a geocoder's answer is the name; the rest is
          // the district and city you already know you are in.
          name: String(result.displayName).split(",")[0].trim().slice(0, 80) || query,
          address: result.displayName, lat: Number(result.lat), lon: Number(result.lon),
        });
        window.scrollTo({ top: 0 });
      });
      return choice;
    }));
    goMessage.textContent = results.length ? "" : "Nothing found in Madrid";
  } catch (err) {
    goMessage.textContent = `Could not search: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});
document.getElementById("go-clear").addEventListener("click", () => {
  goResults.replaceChildren();
  goMessage.textContent = "";
  setGoPlace(null);
});
document.getElementById("go-save").addEventListener("click", () => {
  if (!goPlace) return;
  placesMessage.textContent = "";
  renderPlacesDialog();
  placesDialog.showModal();
  openPlaceEditor({ name: goPlace.name, address: goPlace.address, lat: goPlace.lat, lon: goPlace.lon });
});

/** What the planner is asked about: the one-off destination first, then the
 *  hubs you are not already at. */
function journeyDestinations() {
  return [goPlace, ...activeDestinations()].filter(Boolean);
}

function journeyFor(placeId) {
  return journeyPayload?.destinations?.find((item) => item.destination.id === placeId);
}

function setPlaceReachability(card, waitSeconds, walkSeconds) {
  card.classList.remove("reachability-comfortable", "reachability-tight", "reachability-missed");
  const margin = Number(waitSeconds) - Number(walkSeconds);
  if (!Number.isFinite(margin)) return;
  card.classList.add(margin < 0
    ? "reachability-missed"
    : margin < 120 ? "reachability-tight" : "reachability-comfortable");
}

// A deliberate copy of the planner's constants (api/src/journey-planner.js):
// Pages deploys only web/, so the page cannot import the worker's module
// (ADR 0001). Change them together.
const WALK_METRES_PER_SECOND = 1.3;
const DEFAULT_HEADWAY_SECONDS = 10 * 60;
const MIN_HEADWAY_SECONDS = 3 * 60;
const MAX_HEADWAY_SECONDS = 30 * 60;

/** A hub card's first leg, timed from the boarding stop's board in the shared
 *  store, so the card and the stop sheet it opens never disagree. The pick is
 *  a copy of the planner's nextDeparture() in api/src/journey-planner.js: the
 *  first bus you can still walk to, else one headway after the last one
 *  listed. The planner's own snapshot is only the fallback, for a worker too
 *  old to send boards. */
function firstLegTimes(option) {
  const leg = option.firstLeg;
  const board = arrivals[String(option.originStop.stopId)];
  if (!board) {
    return {
      fetchedAt: leg.fetchedAt ?? journeyPayload.generatedAt,
      times: leg.arrivals ?? [],
      wait: leg.selectedArrival ?? leg.arrivals?.[0],
    };
  }
  const ids = new Set([lineIdentity(leg.label), lineIdentity(leg.line)].filter(Boolean));
  const times = board.arrivals
    .filter((bus) => ids.has(lineIdentity(bus.line)))
    .map((bus) => Number(bus.seconds)).filter(Number.isFinite).sort((a, b) => a - b);
  const walk = Number(option.originStop.walkSeconds
    ?? (option.originStop.distanceM ?? 0) / WALK_METRES_PER_SECOND);
  let wait = times.find((seconds) => seconds >= walk) ?? null;
  if (wait == null && times.length) {
    const observed = times.length > 1 ? times.at(-1) - times.at(-2) : DEFAULT_HEADWAY_SECONDS;
    const headway = Math.min(MAX_HEADWAY_SECONDS,
      Math.max(MIN_HEADWAY_SECONDS, observed || DEFAULT_HEADWAY_SECONDS));
    wait = times.at(-1) + Math.ceil((walk - times.at(-1)) / headway) * headway;
  }
  return { fetchedAt: board.fetchedAt, times, wait };
}

function placeRouteRow(option, card, { primary = false } = {}) {
  const route = document.createElement("div");
  route.className = `place-route${primary ? "" : " place-route-alternative"}`;
  const first = document.createElement("strong");
  first.className = "place-line";
  first.style.color = lineColor(option.firstLeg.label);
  first.textContent = option.firstLeg.label;
  const copy = document.createElement("p");
  const leg = firstLegTimes(option);
  const wait = leg.wait;
  const connection = (option.type === "direct"
    ? "direct"
    : `then ${option.secondLeg.label} · ${option.transfer.walkM} m transfer`)
    + (option.estimatedSeconds != null && journeyPayload?.generatedAt
      ? ` · there by ${arrivalClock(journeyPayload.generatedAt + option.estimatedSeconds * 1000)}`
      : "");
  const origin = document.createElement("button");
  origin.type = "button";
  origin.className = "stop-open place-stop-open";
  const walkMetres = option.originStop.walkMetres ?? option.originStop.distanceM;
  origin.textContent = `Stop ${option.originStop.stopId} · ${Math.round(walkMetres)} m walk`;
  origin.setAttribute("aria-label", `Open stop ${option.originStop.stopId} for arrivals and tracking`);
  origin.append(tracking.indicator("bus", option.originStop.stopId, option.firstLeg.label));
  origin.addEventListener("click", (event) => {
    event.stopPropagation();
    const stopId = String(option.originStop.stopId);
    mergeNearbyDetails([{ ...option.originStop, stopId, lines: [option.firstLeg] }], { onlySaved: false });
    openStop(stops.find((stop) => String(stop.stop_id) === stopId) ?? { stop_id: stopId, label: null, id: null });
  });
  origin.addEventListener("keydown", (event) => event.stopPropagation());
  const detail = document.createElement("small");
  detail.textContent = connection;
  // The one after, when there is one. Same reasoning as the stop cards showing
  // two arrivals: the useful question is not only "can I make this bus" but
  // "what happens if I don't" — and at night, when the next N-line may be half
  // an hour behind, that is the difference between leaving now and finishing
  // the drink.
  const following = leg.times
    .filter((seconds) => seconds > (wait ?? -1))
    .slice(0, 2);
  if (following.length) {
    const later = document.createElement("span");
    later.className = "route-later";
    later.dataset.fetchedAt = String(leg.fetchedAt);
    later.dataset.seconds = following.join(",");
    later.textContent = ` · then ${following.map((s) => fmtCountdown(s)).join(", ")}`;
    detail.append(later);
  }
  if (option.incidents?.length) {
    const warning = document.createElement("span");
    warning.className = "route-incident";
    warning.textContent = " · ⚠ Detour";
    warning.title = option.incidents.map((incident) => incident.title).filter(Boolean).join("\n");
    detail.append(warning);
  }
  copy.append(origin, document.createElement("br"), detail);
  const eta = document.createElement("time");
  const fetchedAt = leg.fetchedAt;
  const elapsed = Math.floor((Date.now() - fetchedAt) / 1000);
  eta.className = "eta";
  eta.textContent = wait == null ? "—" : fmtCountdown(wait - elapsed);
  if (wait != null) {
    eta.dataset.seconds = String(wait);
    eta.dataset.fetchedAt = String(fetchedAt);
    eta.dataset.walkSeconds = String(option.originStop.walkSeconds ?? "");
    if (primary) setPlaceReachability(card, wait - elapsed, option.originStop.walkSeconds);
  }
  route.append(first, copy, eta);
  const directions = document.createElement("button");
  directions.className = "place-route-directions";
  directions.type = "button";
  directions.title = `Walk to stop ${option.originStop.stopId}`;
  directions.setAttribute("aria-label", directions.title);
  directions.innerHTML = WALKING_ICON;
  directions.disabled = !option.originStop.coordinates;
  directions.addEventListener("click", (event) => {
    event.stopPropagation();
    openWalkingDirections(option.originStop.coordinates);
  });
  route.insertBefore(directions, eta);
  return route;
}

function arrivalClock(epochMs) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(epochMs));
}

/** One more way there, laid out like a bus row: badge, what to do, a
 *  directions button and the time it takes door to door. */
function modeRow({ icon, label, action, detail, seconds, directionsTitle, directionsTo }) {
  const row = document.createElement("div");
  row.className = "place-route place-route-mode";
  const badge = document.createElement("strong");
  badge.className = "place-line place-mode";
  // Inline like a bus line's colour, so every interface style's own
  // .place-line colour gives way to it the same way.
  badge.style.color = "var(--accent)";
  badge.innerHTML = icon;
  badge.setAttribute("aria-label", label);
  const copy = document.createElement("p");
  const small = document.createElement("small");
  small.textContent = `${detail} · there by ${arrivalClock(Date.now() + seconds * 1000)}`;
  copy.append(action, document.createElement("br"), small);
  const directions = document.createElement("button");
  directions.className = "place-route-directions";
  directions.type = "button";
  directions.title = directionsTitle;
  directions.setAttribute("aria-label", directionsTitle);
  directions.innerHTML = WALKING_ICON;
  directions.disabled = !directionsTo;
  directions.addEventListener("click", (event) => {
    event.stopPropagation();
    openWalkingDirections(directionsTo);
  });
  const total = document.createElement("time");
  total.className = "eta mode-total";
  total.textContent = `${Math.max(1, Math.round(seconds / 60))} min`;
  row.append(badge, copy, directions, total);
  return row;
}

function bikeRouteRow(bike) {
  const pickup = document.createElement("button");
  pickup.type = "button";
  pickup.className = "stop-open place-stop-open";
  pickup.textContent = `BiciMAD ${bike.pickup.number} · ${bike.pickup.walkM} m walk`;
  pickup.setAttribute("aria-label", `Open BiciMAD station ${bike.pickup.number}`);
  pickup.addEventListener("click", (event) => {
    event.stopPropagation();
    openBikeStation(bikeById.get(String(bike.pickup.id)) ?? bike.pickup);
  });
  const bikes = bike.pickup.bikes == null ? "" : `${bike.pickup.bikes} bike${bike.pickup.bikes === 1 ? "" : "s"} · `;
  const docks = bike.dropoff.freeBases == null ? "" : ` (${bike.dropoff.freeBases} free)`;
  return modeRow({
    icon: BIKE_ICON,
    label: "BiciMAD",
    action: pickup,
    detail: `${bikes}${formatDistance(bike.rideM)} ride · dock at ${bike.dropoff.number}${docks}`,
    seconds: bike.estimatedSeconds,
    directionsTitle: `Walk to BiciMAD ${bike.pickup.number}`,
    directionsTo: bike.pickup.coordinates,
  });
}

function walkRouteRow(walk, place) {
  const action = document.createElement("b");
  action.textContent = "Walk";
  return modeRow({
    icon: WALKING_ICON,
    label: "On foot",
    action,
    detail: `about ${formatDistance(walk.metres)}`,
    seconds: walk.seconds,
    directionsTitle: `Walk to ${place.name}`,
    directionsTo: [place.lon, place.lat],
  });
}

function placeCard(place) {
  const card = document.createElement("article");
  card.className = "place-card";
  const heading = document.createElement("div");
  heading.className = "place-card-heading";
  const title = document.createElement("h2");
  title.textContent = place.name;
  const distance = document.createElement("span");
  distance.className = "muted";
  distance.textContent = distanceLabel(placeDistance(place)) ?? "—";
  const planned = journeyFor(place.id);
  const options = planned?.options?.slice(0, 3) ?? [];
  const option = options[0];
  const fullRoute = document.createElement("button");
  fullRoute.className = "place-directions place-transit-directions";
  fullRoute.type = "button";
  fullRoute.title = `Transit directions to ${place.name}`;
  fullRoute.setAttribute("aria-label", fullRoute.title);
  fullRoute.textContent = "➤";
  fullRoute.disabled = !myLocation;
  fullRoute.addEventListener("click", () => openTransitDirections(place));

  // The journey already names its lines and their directions, so this is a
  // straight wire-up: draw exactly the legs this card is telling you to take.
  const legs = document.createElement("button");
  legs.className = "place-directions";
  legs.type = "button";
  legs.title = options.length ? `Show all routes to ${place.name} on the map` : "No routes to draw";
  legs.setAttribute("aria-label", legs.title);
  legs.innerHTML = LINES_ICON;
  legs.disabled = options.length === 0;
  legs.addEventListener("click", async () => {
    legs.disabled = true;
    try {
      await showJourneyRoutes(options, place.name);
    } finally {
      legs.disabled = false;
    }
  });
  // Every boarding option the planner offers, not only the suggested one: the
  // best bus changes as you walk, and an alert for any of them is useful.
  const hubWatches = (planned?.options ?? []).map((choice) => ({
    kind: "bus", targetId: String(choice.originStop.stopId), line: choice.firstLeg.label,
    label: `To ${place.name}`, coordinates: choice.originStop.coordinates,
  }));
  heading.append(title, distance, fullRoute, tracking.setButton(hubWatches, place.name), legs);
  card.append(heading);

  let route;
  if (!myLocation || !journeyPayload || !option) {
    route = document.createElement("div");
    route.className = "place-route";
    const status = document.createElement("span");
    status.className = "place-route-status";
    status.textContent = !myLocation
      ? "Waiting for your location…"
      : !journeyPayload || !planned ? "Loading…" : "No route";
    route.append(status);
  }
  else {
    route = placeRouteRow(option, card, { primary: true });
    const alternatives = options.slice(1).map((alternative) => {
      const row = placeRouteRow(alternative, card);
      row.hidden = true;
      return row;
    });
    if (alternatives.length) {
      card.classList.add("has-alternatives");
      route.classList.add("place-route-expandable");
      route.tabIndex = 0;
      route.setAttribute("role", "button");
      route.setAttribute("aria-expanded", "false");
      route.setAttribute("aria-label", `Show ${alternatives.length} alternative route${alternatives.length === 1 ? "" : "s"}`);
      const toggle = () => {
        const expanded = route.getAttribute("aria-expanded") === "true";
        route.setAttribute("aria-expanded", String(!expanded));
        card.classList.toggle("routes-expanded", !expanded);
        route.setAttribute("aria-label", expanded ? `Show ${alternatives.length} alternative route${alternatives.length === 1 ? "" : "s"}` : "Hide alternative routes");
        alternatives.forEach((row) => { row.hidden = expanded; });
      };
      route.addEventListener("click", toggle);
      route.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
    }
    card.append(route, ...alternatives);
  }
  title.append(freshnessDot(option ? firstLegTimes(option).fetchedAt : journeyPayload?.generatedAt));
  if (!route.parentNode) card.append(route);
  // The other ways there, always in view: they are not alternatives to the
  // bus so much as the answer to "is the bus even worth it".
  if (myLocation && planned) {
    if (planned.bike) card.append(bikeRouteRow(planned.bike));
    if (planned.walk && planned.walk.metres <= WALK_SHOWN_UP_TO_M) card.append(walkRouteRow(planned.walk, place));
  }
  if (place.id === GO_ID) card.classList.add("place-card-go");
  return card;
}

function renderPlaces() {
  const destinations = journeyDestinations();
  if (destinations.length && !journeyPayload) {
    if (journeyInitialPending) {
      const loader = document.createElement("div");
      loader.className = "hubwise-loader";
      loader.setAttribute("role", "status");
      loader.setAttribute("aria-label", "Loading Hubward");
      listEl.replaceChildren(loader);
    } else {
      listEl.replaceChildren();
    }
    return;
  }
  const blocks = [];
  blocks.push(...destinations.map(placeCard));
  if (destinations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = places.length ? "No other hubs" : "No hubs saved";
    blocks.push(empty);
  }
  const nearestBikes = (bikeNear.stations ?? [])
    .filter((station) => Array.isArray(station.coordinates))
    .sort((a, b) => proximity(distanceToStation(a)) - proximity(distanceToStation(b)))
    .slice(0, NEAREST_BIKE_STATION_LIMIT);
  if (nearestBikes.length) {
    blocks.push(sectionHeading("Nearest BiciMAD"));
    for (const station of nearestBikes) {
      const bike = bikeCard(station, bikeSaved.find((row) => row.station_id === station.id) ?? null);
      bike.classList.add("place-nearest-bike");
      blocks.push(bike);
    }
  }
  listEl.replaceChildren(...blocks);
}

function renderSavedStops() {
  listEl.replaceChildren(
    ...[...stops]
      .sort((a, b) => proximity(metresFromCurrent(details[a.stop_id]?.coordinates)) -
        proximity(metresFromCurrent(details[b.stop_id]?.coordinates)))
      .map((stop) => {
      const cached = arrivals[stop.stop_id];
      const card = document.createElement("article");
      card.className = "stop";

      const titleWrap = document.createElement("div");
      titleWrap.className = "title";
      const title = document.createElement("h2");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "stop-open";
      open.textContent = stopTitle(stop);
      open.setAttribute("aria-label", `Open stop ${stop.stop_id} for arrivals and tracking`);
      open.append(tracking.indicator("bus", stop.stop_id));
      open.addEventListener("click", (event) => { event.stopPropagation(); openStop(stop); });
      title.append(open);
      const num = document.createElement("span");
      num.className = "stop-num";
      num.replaceChildren(stopMetaNode(stop.stop_id));
      titleWrap.append(title, num);

      // Card taps open the stop; the buttons on it must not also open it.
      card.addEventListener("click", () => openStop(stop));

      const refresh = document.createElement("button");
      refresh.className = "icon-btn";
      refresh.innerHTML = REFRESH_ICON;
      refresh.title = "Refresh this stop";
      refresh.addEventListener("click", (event) => {
        event.stopPropagation();
        refreshStop(stop.stop_id, { force: true });
      });

      const remove = document.createElement("button");
      remove.className = "icon-btn danger-icon";
      remove.innerHTML = REMOVE_ICON;
      remove.title = "Remove this stop";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteStop(stop.id);
      });

      const coordinates = details[stop.stop_id]?.coordinates;
      const walking = document.createElement("button");
      walking.className = "icon-btn";
      walking.innerHTML = WALKING_ICON;
      walking.title = `Walk to stop ${stop.stop_id}`;
      walking.setAttribute("aria-label", walking.title);
      walking.disabled = !coordinates;
      walking.addEventListener("click", (event) => {
        event.stopPropagation();
        openWalkingDirections(coordinates);
      });

      const routes = document.createElement("button");
      routes.className = "icon-btn";
      routes.innerHTML = LINES_ICON;
      routes.title = `Show the lines running at stop ${stop.stop_id}`;
      routes.setAttribute("aria-label", routes.title);
      routes.disabled = stopLines(stop.stop_id).length === 0;
      routes.addEventListener("click", async (event) => {
        event.stopPropagation();
        routes.disabled = true;
        try {
          await showRoutesForStop(stop.stop_id, stopTitle(stop));
        } finally {
          routes.disabled = false;
        }
      });

      const list = document.createElement("ul");
      if (!cached) {
        list.innerHTML = `<li class="muted">No data yet</li>`;
      } else if (cached.arrivals.length === 0) {
        // EMT answering "no estimations" is not a failure — at night, or on a
        // daytime-only bay, it is the true answer. Saying when the first bus
        // is due turns "nothing here" into something you can act on, and makes
        // one stop's empty board legible next to another stop's full one.
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = emptyBoardText(stop.stop_id, { fetchMissing: true });
        list.replaceChildren(li);
      } else {
        // Count down from the age of the fetch, not from the raw value, so a
        // cached payload shows the time remaining now rather than when fetched.
        const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
        // The card is the glance: next bus and the one after it. The stop
        // sheet shows the rest of the board.
        for (const bus of cached.arrivals.slice(0, CARD_ARRIVALS)) {
          const li = document.createElement("li");
          const line = document.createElement("span");
          line.className = "line";
          line.textContent = bus.line;
          line.style.color = lineColor(bus.line);
          const eta = document.createElement("span");
          eta.className = "eta";
          eta.textContent = fmtCountdown(bus.seconds - elapsed);
          eta.dataset.seconds = String(bus.seconds);
          eta.dataset.fetchedAt = String(cached.fetchedAt);
          const destination = document.createElement("span");
          destination.className = "destination";
          destination.textContent = bus.destination || "";
          destination.hidden = !bus.destination;
          line.append(tracking.indicator("bus", stop.stop_id, bus.line));
          li.append(line, destination, eta);
          list.append(li);
        }
      }

      // The dot keeps freshness visible without spending a full row on it.
      // Its tooltip and accessible label retain the exact age.
      title.append(freshnessDot(cached?.fetchedAt));

      const controls = document.createElement("div");
      controls.className = "controls";
      controls.append(routes, walking, refresh, remove);

      const head = document.createElement("div");
      head.className = "head";
      head.append(titleWrap, controls);

      card.append(head, list);
      return card;
    })
  );
}

function render() {
  const current = places.find((place) => place.enabled !== false &&
    placeDistance(place) != null && placeDistance(place) <= place.geofence_radius_m);
  headerContext.hidden = !current;
  headerContext.querySelector("span").textContent = current ? `At ${current.name}` : "";
  renderGoForm();
  if (authSession && busListMode === "places") return renderPlaces();
  return renderSavedStops();
}

const pendingGets = new Map();

const emtAccount = setupEmtAccount({ request: api, onState: (connected) => { emtConnected = connected; } });
const trackingClear = document.getElementById("tracking-clear");
const tracking = createTracking({
  api, signedIn: () => !!authSession,
  locate: (kind, id) => (kind === "bike" ? bikeById.get(String(id))?.coordinates : details[id]?.coordinates) ?? null,
  position: () => myLocation,
  changed: () => {
    render();
    renderBikes();
    if (stopDialog.open) { renderSheetArrivals(); renderSheetService(); }
    if (bikeDialog.open) renderBikeSheet();
    refreshBikePopup();
    rebuildBikeMarkers();
    rebuildMarkers();
    renderNearbyPins();
    tracking.renderList(document.getElementById("tracking-list"));
    const count = tracking.count();
    trackingClear.hidden = !count;
    trackingClear.textContent = `Stop tracking everything (${count})`;
  },
});
document.getElementById("tracking-open").addEventListener("click", () => {
  document.getElementById("tracking-dialog").showModal();
  void tracking.load();
});
trackingClear.addEventListener("click", async () => {
  if (!window.confirm(`Stop all ${tracking.count()} tracked alerts?`)) return;
  trackingClear.disabled = true;
  try { await tracking.removeAll(); }
  catch (error) { window.alert(`Could not stop every alert: ${error.message}`); }
  finally { trackingClear.disabled = false; }
});

async function api(path, init = {}) {
  const isWrite = init.method && init.method !== "GET";
  const requestKey = isWrite ? null : `${authUser?.id ?? "public"}:${path}`;
  if (requestKey && pendingGets.has(requestKey)) return pendingGets.get(requestKey);
  const authorization = authSession?.access_token
    // x-hubwise-emt is held back until the worker that allows it in CORS is
    // deployed: the one live now fails every preflight that carries it.
    ? { Authorization: `Bearer ${authSession.access_token}`,
        ...(emtConnected === null || !SEND_AUDIENCE ? {} : { "x-hubwise-emt": emtConnected ? "connected" : "unconnected" }) }
    : {};
  const operation = (async () => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: isWrite
        ? { "content-type": "application/json", ...authorization, ...init.headers }
        : { ...authorization, ...init.headers },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || body.error || `HTTP ${res.status}`);
      err.kind = body.error; // "quota" | "auth" | "not_found" | "upstream"
      if (err.kind === "user_auth") showSignedOut("Session expired — sign in again.");
      // Either "connect your account" or "EMT rejected it": the worker says which.
      if (err.kind === "emt_account") statusEl.textContent = err.message;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  })();
  if (requestKey) pendingGets.set(requestKey, operation);
  try {
    return await operation;
  } finally {
    if (requestKey && pendingGets.get(requestKey) === operation) pendingGets.delete(requestKey);
  }
}

function showSignedOut(message = "") {
  live.reset();
  tracking.clear();
  emtAccount.reset();
  authSession = null;
  authUser = null;
  isOwner = false;
  metricsOpen.hidden = true;
  setUserCacheScope(null);
  stops = [];
  places = [];
  goPlace = null;
  journeyPayload = null;
  journeyInitialPending = true;
  bikeSaved = [];
  resetBikePrivateState();
  authButton.textContent = "Sign in";
  authButton.title = "Sign in with an email link";
  authButton.setAttribute("aria-label", "Sign in");
  if (accountMenu.open) accountMenu.close();
  fab.hidden = true;
  bikeAccountEl.hidden = true;
  render();
  renderBikes();
  if (message) statusEl.textContent = message;
}

async function applySession(session) {
  if (!session) return showSignedOut();
  if (authSession?.access_token === session.access_token && authUser) return;
  authSession = session;
  authUser = session.user;
  // Reopen with the new token, i.e. with this user's EMT account.
  live.reset();
  setUserCacheScope(authUser.id);
  goPlace = readGoPlace();
  emtAccount.reset();
  void emtAccount.load();
  void tracking.load();
  resetBikePrivateState();
  stops = readStops();
  bikeSaved = readBikeSaved();
  authButton.textContent = "☰";
  authButton.title = "Account menu";
  authButton.setAttribute("aria-label", "Open account menu");
  accountMenuEmail.textContent = authUser.email || "Signed in";
  fab.hidden = section === "bikes";
  render();
  renderBikes();

  let metricsAvailable = false;
  try {
    const me = await api("/auth/me");
    isOwner = me.owner === true;
    metricsAvailable = me.metricsAvailable === true;
  } catch {
    isOwner = false;
  }
  bikeAccountEl.hidden = section !== "bikes" || !isOwner;
  metricsOpen.hidden = !isOwner || !metricsAvailable;
  if (isOwner) showCachedBikeAccount();
  await Promise.all([loadStops(), loadBikeSaved(), loadPlaces()]);
}

async function loadPlaces() {
  if (!authSession) return;
  try {
    places = await api("/places");
    render();
    scheduleJourneys({ force: true });
    renderPlacesDialog();
  } catch (err) {
    // The migration is deliberately non-breaking: saved stops remain the UI
    // until places.sql has been applied.
    statusEl.textContent = `Hubs unavailable: ${err.message}`;
    render();
  }
}

let journeyLoad = null;

async function loadJourneys({ force = false } = {}) {
  if (journeyLoad) {
    // A destination picked while a plan is out must not wait a whole minute.
    if (force) journeyRerun = true;
    return journeyLoad;
  }
  if (!authSession || !myLocation) return;
  const destinations = journeyDestinations();
  if (destinations.length === 0) return;
  const cell = `${myLocation[0].toFixed(3)},${myLocation[1].toFixed(3)}`;
  if (!force && cell === journeyCell && Date.now() - journeyLoadedAt < 60_000) return;
  if (!journeyPayload) {
    journeyInitialPending = true;
    render();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const operation = (async () => { try {
    const batches = [];
    const size = journeyBatchSize;
    for (let index = 0; index < destinations.length; index += size) {
      batches.push(destinations.slice(index, index + size));
    }
    const payloads = await Promise.all(batches.map((batch) => api("/journeys", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        origin: { lat: myLocation[0], lon: myLocation[1] },
        destinations: batch.map((place) => ({
          id: place.id, name: place.name, lat: place.lat, lon: place.lon,
          destinationRadiusM: place.destination_radius_m,
        })),
      }),
    })));
    journeyPayload = {
      origin: payloads[0]?.origin,
      destinations: payloads.flatMap((payload) => payload.destinations ?? []),
      generatedAt: Math.max(...payloads.map((payload) => payload.generatedAt ?? 0)),
      calls: payloads.reduce((total, payload) => {
        for (const [key, value] of Object.entries(payload.calls ?? {})) {
          total[key] = (total[key] ?? 0) + Number(value ?? 0);
        }
        return total;
      }, {}),
    };
    journeyInitialPending = false;
    journeyCell = cell;
    journeyLoadedAt = Date.now();
    for (const payload of payloads) {
      for (const [stopId, board] of Object.entries(payload.boards ?? {})) putBoard(stopId, board);
    }
    const limit = Math.max(...payloads.map((payload) => Number(payload.maxDestinations) || 1));
    journeyBatchSize = Math.min(12, Math.max(1, limit));
    render();
  } catch (err) {
    journeyInitialPending = false;
    statusEl.textContent = err.name === "AbortError"
      ? "Journey request timed out"
      : `Could not plan journeys: ${err.message}`;
    render();
  } finally {
    clearTimeout(timeout);
  } })();
  journeyLoad = operation;
  try {
    return await operation;
  } finally {
    if (journeyLoad === operation) journeyLoad = null;
    if (journeyRerun) {
      journeyRerun = false;
      scheduleJourneys({ force: true });
    }
  }
}

function scheduleJourneys({ force = false } = {}) {
  if (journeyTimer != null) clearTimeout(journeyTimer);
  journeyTimer = setTimeout(() => { journeyTimer = null; void loadJourneys({ force }); }, 250);
}

async function initAuth() {
  try {
    const config = await api("/auth/config");
    authClient = window.supabase.createClient(config.url, config.anonKey);
    const { data, error } = await authClient.auth.getSession();
    if (error) throw error;
    await applySession(data.session);
    authClient.auth.onAuthStateChange((_event, session) => {
      // The callback must return immediately: Supabase warns against awaiting
      // more auth methods while its internal session lock is held.
      setTimeout(() => { void applySession(session); }, 0);
    });
  } catch (err) {
    showSignedOut(`Could not initialize sign-in: ${err.message}`);
  }
}

authButton.addEventListener("click", async () => {
  if (authSession) {
    accountMenu.showModal();
    return;
  }
  authMessage.textContent = "";
  authDialog.showModal();
});

accountSignout.addEventListener("click", async () => {
  accountSignout.disabled = true;
  try {
    await tracking.disconnect();
    await authClient.auth.signOut();
  } catch (error) {
    window.alert(`Could not sign out: ${error.message}`);
  } finally {
    accountSignout.disabled = false;
    if (accountMenu.open) accountMenu.close();
  }
});

/* Install from the menu, not only Chrome's own menu. Chromium fires
 * beforeinstallprompt only while it considers the app installable and not
 * yet installed, so the button exists exactly when an install can happen;
 * other browsers never fire it and never show it. */
const appInstall = document.getElementById("app-install");
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); // the button replaces Chrome's mini-infobar
  installPrompt = event;
  appInstall.hidden = window.matchMedia("(display-mode: standalone)").matches;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  appInstall.hidden = true;
});
appInstall.addEventListener("click", async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  // A prompt can be shown only once; if it is declined, Chrome offers again
  // later with a new event, which brings the button back.
  installPrompt = null;
  appInstall.hidden = true;
  await prompt.prompt();
  if (accountMenu.open) accountMenu.close();
});

function renderMetrics(payload) {
  const rows = payload.rows ?? [];
  const upstream = rows.filter((row) => row.kind === "upstream");
  const edge = rows.filter((row) => row.kind === "edge");
  const sum = (items, field) => items.reduce((total, row) => total + Number(row[field] || 0), 0);
  const calls = sum(upstream, "upstream_calls");
  const requests = sum(edge, "events");
  const hits = sum(edge.filter((row) => row.cache_status === "hit"), "events");
  const errors = sum(rows.filter((row) => row.outcome !== "ok"), "events");
  const firstSeen = Math.min(...rows.map((row) => Date.parse(row.first_seen)).filter(Number.isFinite));
  const observedHours = Number.isFinite(firstSeen)
    ? Math.min(payload.hours, Math.max(1 / 60, (payload.generatedAt - firstSeen) / 3_600_000))
    : payload.hours;
  const dailyPace = calls / observedHours * 24;
  const observed = observedHours < 1
    ? `${Math.max(1, Math.round(observedHours * 60))}m`
    : `${observedHours.toFixed(1)}h`;
  const summary = document.createElement("div");
  summary.className = "metrics-summary";
  for (const [label, value] of [
    ["Upstream", Math.round(calls).toLocaleString()],
    ["Cache hits", Math.round(hits).toLocaleString()],
    ["Hit rate", requests ? `${(hits / requests * 100).toFixed(1)}%` : "—"],
    ["Errors", Math.round(errors).toLocaleString()],
    ["Observed", observed],
    ["Daily pace", `~${Math.round(dailyPace).toLocaleString()} · ${(dailyPace / 20_000 * 100).toFixed(1)}%`],
  ]) {
    const name = document.createElement("span");
    name.textContent = label;
    const amount = document.createElement("strong");
    amount.textContent = value;
    summary.append(name, amount);
  }
  const byEndpoint = new Map();
  for (const row of upstream) {
    byEndpoint.set(row.endpoint, (byEndpoint.get(row.endpoint) || 0) + Number(row.upstream_calls || 0));
  }
  const table = document.createElement("table");
  table.className = "metrics-table";
  const head = document.createElement("tr");
  for (const value of ["Endpoint", "Calls"]) {
    const th = document.createElement("th");
    th.textContent = value;
    head.append(th);
  }
  table.append(head);
  for (const [endpoint, count] of [...byEndpoint].sort((a, b) => b[1] - a[1])) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = endpoint;
    const amount = document.createElement("td");
    amount.textContent = Math.round(count).toLocaleString();
    row.append(name, amount);
    table.append(row);
  }
  const byWho = new Map();
  for (const row of edge) {
    const name = row.who || "unrecorded";
    const entry = byWho.get(name) ?? { hit: 0, other: 0 };
    entry[row.cache_status === "hit" ? "hit" : "other"] += Number(row.events || 0);
    byWho.set(name, entry);
  }
  const whoTable = byWho.size ? document.createElement("table") : null;
  if (whoTable) {
    whoTable.className = "metrics-table";
    const whoHead = document.createElement("tr");
    for (const value of ["Who asked", "Cache hits", "Fetched"]) {
      const th = document.createElement("th");
      th.textContent = value;
      whoHead.append(th);
    }
    whoTable.append(whoHead);
    for (const [name, { hit, other }] of [...byWho].sort((a, b) => (b[1].hit + b[1].other) - (a[1].hit + a[1].other))) {
      const row = document.createElement("tr");
      for (const value of [name, Math.round(hit).toLocaleString(), Math.round(other).toLocaleString()]) {
        const td = document.createElement("td");
        td.textContent = value;
        row.append(td);
      }
      whoTable.append(row);
    }
  }
  metricsContent.replaceChildren(...[summary, table, whoTable].filter(Boolean));
}

async function loadMetrics(hours = 24) {
  metricsContent.replaceChildren(Object.assign(document.createElement("span"), {
    className: "spinner",
  }));
  try {
    renderMetrics(await api(`/admin/metrics?hours=${hours}`));
  } catch (error) {
    metricsContent.textContent = `Metrics unavailable: ${error.message}`;
  }
}

metricsOpen.addEventListener("click", () => {
  accountMenu.close();
  metricsDialog.showModal();
  void loadMetrics(Number(metricsRangeButtons.find((button) =>
    button.getAttribute("aria-pressed") === "true")?.dataset.metricsHours || 24));
});
document.getElementById("metrics-close").addEventListener("click", () => metricsDialog.close());
for (const button of metricsRangeButtons) {
  button.addEventListener("click", () => {
    for (const candidate of metricsRangeButtons) {
      candidate.setAttribute("aria-pressed", String(candidate === button));
    }
    void loadMetrics(Number(button.dataset.metricsHours));
  });
}

function renderPlacesDialog() {
  placesList.replaceChildren(...places.map((place) => {
    const row = document.createElement("div");
    row.className = "place-manage-row";
    const label = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = place.name;
    const coordinates = document.createElement("small");
    coordinates.textContent = `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
    label.append(name, coordinates);
    const actions = document.createElement("div");
    actions.className = "place-manage-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "✎";
    edit.setAttribute("aria-label", `Edit ${place.name}`);
    edit.addEventListener("click", () => openPlaceEditor(place));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${place.name}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api(`/places/${encodeURIComponent(place.id)}`, { method: "DELETE" });
        places = places.filter((item) => item.id !== place.id);
        journeyPayload = null;
        journeyInitialPending = true;
        renderPlacesDialog();
        render();
        scheduleJourneys({ force: true });
      } catch (err) {
        placesMessage.textContent = `Could not delete hub: ${err.message}`;
        remove.disabled = false;
      }
    });
    actions.append(edit, remove);
    row.append(label, actions);
    return row;
  }));
}

function setPlacePin(lat, lon, { recenter = true } = {}) {
  const point = [Number(lat), Number(lon)];
  if (!point.every(Number.isFinite)) return;
  placeDraft = { ...(placeDraft ?? {}), lat: point[0], lon: point[1] };
  const lngLat = [point[1], point[0]];
  if (!placePickerMarker) {
    placePickerMarker = new maplibregl.Marker({ draggable: true })
      .setLngLat(lngLat).addTo(placePickerMap);
    placePickerMarker.on("dragend", () => {
      const moved = placePickerMarker.getLngLat();
      setPlacePin(moved.lat, moved.lng, { recenter: false });
    });
  } else {
    placePickerMarker.setLngLat(lngLat);
  }
  if (recenter) placePickerMap.jumpTo({ center: lngLat, zoom: 17 });
  placePicked.textContent = `Pin: ${point[0].toFixed(5)}, ${point[1].toFixed(5)}`;
}

function ensurePlacePicker() {
  if (!placePickerMap) {
    placePickerMap = createMap("place-picker-map", { center: MADRID, controls: true });
    placePickerMap.on("click",
      (event) => setPlacePin(event.lngLat.lat, event.lngLat.lng, { recenter: false }));
  }
  requestAnimationFrame(() => {
    placePickerMap.resize();
    const initial = placeDraft?.lat != null
      ? [placeDraft.lat, placeDraft.lon]
      : myLocation ?? [40.4168, -3.7038];
    setPlacePin(initial[0], initial[1]);
  });
}

function closePlaceEditor() {
  placeEditor.hidden = true;
  document.getElementById("place-editor-open").hidden = false;
  placeSearchResults.replaceChildren();
  placeDraft = null;
}

function openPlaceEditor(place = null) {
  placeDraft = place ? { ...place } : null;
  document.getElementById("place-name").value = place?.name ?? "";
  document.getElementById("place-address").value = place?.address ?? "";
  document.getElementById("place-add").textContent = place?.id ? "Save changes" : "Save hub";
  placeSearchResults.replaceChildren();
  placesMessage.textContent = "";
  placeEditor.hidden = false;
  document.getElementById("place-editor-open").hidden = true;
  ensurePlacePicker();
}

document.getElementById("manage-places").addEventListener("click", () => {
  accountMenu.close();
  placesMessage.textContent = "";
  renderPlacesDialog();
  placesDialog.showModal();
});
document.getElementById("places-close").addEventListener("click", () => {
  closePlaceEditor();
  placesDialog.close();
});
document.getElementById("place-editor-open").addEventListener("click", () => openPlaceEditor());
document.getElementById("place-editor-cancel").addEventListener("click", closePlaceEditor);
document.getElementById("place-gps").addEventListener("click", () => {
  if (myLocation) setPlacePin(myLocation[0], myLocation[1]);
  else placesMessage.textContent = "GPS has not returned a location yet.";
});
document.getElementById("place-search").addEventListener("click", async () => {
  const input = document.getElementById("place-address");
  const query = input.value.trim();
  if (query.length < 3) return;
  const button = document.getElementById("place-search");
  button.disabled = true;
  placesMessage.textContent = "Searching Madrid…";
  try {
    const results = await api(`/places/geocode?q=${encodeURIComponent(query)}`);
    placeSearchResults.replaceChildren(...results.map((result) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = result.displayName;
      choice.addEventListener("click", () => {
        input.value = result.displayName;
        placeDraft = { ...(placeDraft ?? {}), address: result.displayName };
        setPlacePin(result.lat, result.lon);
        placeSearchResults.replaceChildren();
      });
      return choice;
    }));
    placesMessage.textContent = results.length ? "" : "No address found";
  } catch (err) {
    placesMessage.textContent = `Could not search addresses: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});
placesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("place-name").value.trim();
  if (!name) return;
  if (!placeDraft || !Number.isFinite(placeDraft.lat) || !Number.isFinite(placeDraft.lon)) {
    placesMessage.textContent = "Pin required";
    return;
  }
  const add = document.getElementById("place-add");
  add.disabled = true;
  try {
    const editingId = placeDraft.id;
    const place = await api(editingId ? `/places/${encodeURIComponent(editingId)}` : "/places", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify({
        name, address: document.getElementById("place-address").value.trim() || null,
        lat: placeDraft.lat, lon: placeDraft.lon,
      }),
    });
    if (editingId) places = places.map((item) => item.id === editingId ? place : item);
    else places.push(place);
    // Saved as a hub: its hub card takes over from the one-off one.
    if (!editingId && goPlace && Math.abs(goPlace.lat - placeDraft.lat) < 1e-6
      && Math.abs(goPlace.lon - placeDraft.lon) < 1e-6) setGoPlace(null);
    document.getElementById("place-name").value = "";
    journeyPayload = null;
    journeyInitialPending = true;
    placesMessage.textContent = `${place.name} saved.`;
    renderPlacesDialog();
    render();
    scheduleJourneys({ force: true });
    closePlaceEditor();
  } catch (err) {
    placesMessage.textContent = `Could not save hub: ${err.message}`;
  } finally {
    add.disabled = false;
  }
});

document.getElementById("auth-cancel").addEventListener("click", () => authDialog.close());

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = authEmail.value.trim();
  if (!email || !authClient) return;
  document.getElementById("auth-send").disabled = true;
  authMessage.textContent = "Sending…";
  const { error } = await authClient.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${location.origin}${location.pathname}`,
      // The link verifies email ownership before Supabase creates the user.
      // First-time sign-up and returning sign-in can therefore share one flow.
      shouldCreateUser: true,
    },
  });
  document.getElementById("auth-send").disabled = false;
  authMessage.textContent = error
    ? error.message
    : "Check your email for the secure sign-in link.";
});

const ARRIVALS_REFRESH_MS = 20_000;
const BUS_MAP_REFRESH_MS = 5_000;
const stopRefreshes = new Map();

/** File a board, keeping whichever sample is newer: a journey's 30s planner
 *  board must never overwrite a live one fetched a moment later. */
function putBoard(stopId, payload) {
  const id = String(stopId);
  if (!payload || !Array.isArray(payload.arrivals)) return;
  boardFailures.delete(id);
  if (Number(arrivals[id]?.fetchedAt) >= Number(payload.fetchedAt)) return;
  arrivals[id] = payload;
  boardsChanged();
}

let boardsRenderQueued = false;
/** Every view that shows a board, re-rendered once per burst of updates. */
function boardsChanged() {
  if (boardsRenderQueued) return;
  boardsRenderQueued = true;
  queueMicrotask(() => {
    boardsRenderQueued = false;
    writeArrivalCache(Object.fromEntries(stops
      .filter((stop) => arrivals[stop.stop_id])
      .map((stop) => [stop.stop_id, arrivals[stop.stop_id]])));
    if (!listEl.hidden) render(); // showView renders the list on the way back
    renderSheetArrivals();
    if (!mapEl.hidden) {
      rebuildLiveBusMarkers();
      renderRouteLegend();
      tickPopups();
    }
  });
}

async function refreshStop(stopId, { force = false } = {}) {
  const cached = arrivals[stopId];
  if (!force && cached && Date.now() - cached.fetchedAt < ARRIVALS_REFRESH_MS) return cached;
  if (stopRefreshes.has(stopId)) return stopRefreshes.get(stopId);
  const operation = (async () => {
    try {
      const payload = await api(
        `/arrivals?stop=${encodeURIComponent(stopId)}&limit=${BOARD_ARRIVALS}`
      );
      putBoard(stopId, payload);
      statusEl.textContent = "";
      return arrivals[stopId];
    } catch (err) {
      if (!arrivals[stopId]) {
        boardFailures.add(String(stopId));
        boardsChanged();
      }
      // Keep whatever is on screen; it is labelled with its age already.
      statusEl.textContent =
        err.kind === "quota"
          ? "EMT daily quota spent — showing cached times until it resets."
          : `Could not refresh stop ${stopId}: ${err.message}`;
      return null;
    }
  })();
  stopRefreshes.set(stopId, operation);
  try {
    return await operation;
  } finally {
    if (stopRefreshes.get(stopId) === operation) stopRefreshes.delete(stopId);
  }
}

async function refreshAll({ force = false } = {}) {
  await Promise.all(stops.map((s) => refreshStop(s.stop_id, { force })));
}

async function refreshMapArrivals() {
  // A backgrounded tab still runs its interval. Left on the map view in a
  // pocket, this polled EMT every five seconds for as long as the phone was
  // asleep — most of a 20,000/day quota, spent on buses nobody was watching.
  // visibilitychange refreshes on the way back, so nothing is lost by waiting.
  // The same goes for live sockets: an open one keeps its stop ticking.
  if (!leafletMap || mapEl.hidden || shownRoutes.size === 0 ||
      document.visibilityState !== "visible") {
    live.want([]);
    return;
  }
  const bounds = paddedBounds(leafletMap, 0.25);
  const stopIds = new Set();
  // A stop's arrivals only ever describe buses still heading for it, so the
  // stop a route was opened from is exactly "what is coming to me". Probing
  // further down the line would surface buses that have already gone past.
  // One probe per drawn direction, so a line shown both ways discovers the
  // buses coming each way.
  for (const shown of shownRoutes.values()) {
    const probe = routeProbeStop(shown);
    if (probe) stopIds.add(probe);
  }
  for (const marker of liveBusMarkers.values()) {
    if (marker.busSourceStopId && bounds.contains(marker.getLngLat())) {
      stopIds.add(marker.busSourceStopId);
    }
  }
  live.want(stopIds);
  await Promise.all([...stopIds]
    .filter((stopId) => !live.fresh(stopId))
    .map((stopId) => refreshStop(stopId, { force: true })));
}

/** The one stop worth polling for a displayed direction: the stop the route
 *  was opened from, or — when the direction was cycled and that stop belongs
 *  to the other side of the street — its nearest counterpart on this one. */
function routeProbeStop(shown) {
  const route = routeCache.get(shown.code);
  const candidates = route?.stops?.[shown.direction] ?? [];
  if (!candidates.length) return null;
  const anchor = shown.anchorStopId == null ? null : String(shown.anchorStopId);
  if (anchor && candidates.some((stop) => String(stop.stopId) === anchor)) return anchor;
  const centre = leafletMap?.getCenter();
  const from = (anchor && anchorCoordinates(route, anchor))
    ?? (centre ? [centre.lng, centre.lat] : null);
  if (!from) return null;
  let best = null;
  for (const stop of candidates) {
    if (!Array.isArray(stop.coordinates)) continue;
    const metres = metresBetweenCoordinates(from, stop.coordinates);
    if (!best || metres < best.metres) best = { metres, stopId: String(stop.stopId) };
  }
  return best?.stopId ?? null;
}

function anchorCoordinates(route, stopId) {
  const known = details[stopId]?.coordinates
    ?? nearbyStop(stopId)?.coordinates;
  if (Array.isArray(known)) return known;
  for (const direction of ["toA", "toB"]) {
    const match = (route?.stops?.[direction] ?? [])
      .find((stop) => String(stop.stopId) === stopId);
    if (Array.isArray(match?.coordinates)) return match.coordinates;
  }
  return null;
}

/** Fetch and remember what EMT knows about a stop; throws not_found if it
 *  genuinely does not exist.
 *
 * Detail is preferred (name + coordinates) but EMT's detail table has holes
 * for real stops — stop 30 Plaza Castilla answers 81 there while arrivals
 * serves it happily. So on a detail miss we ask arrivals: code 80 means
 * "disabled or not exists", anything else means the stop is real.
 */
async function resolveStop(stopId) {
  if (details[stopId]) return details[stopId];
  try {
    const detail = await api(`/stops/${encodeURIComponent(stopId)}/detail`);
    details[stopId] = detail;
    writeDetail(stopId, detail);
    return detail;
  } catch {
    // Detail knows nothing; arrivals is the authority on existence.
  }
  try {
    await api(`/arrivals?stop=${encodeURIComponent(stopId)}`);
  } catch (err) {
    throw err; // not_found = bogus id; quota/upstream = try again later
  }
  const stub = { stopId, name: null, address: null, coordinates: null, lines: [] };
  details[stopId] = stub;
  writeDetail(stopId, stub);
  return stub;
}

/** Stops saved before names were resolved get their titles filled in. */
async function hydrateNames() {
  const missing = stops.filter((s) => !details[s.stop_id]);
  if (missing.length > 0) {
    // One stop EMT blips on must not take the rest of the pass down with it:
    // a rejected Promise.all here would skip the healing below entirely.
    await Promise.all(missing.map((s) => resolveStop(s.stop_id).catch(() => null)));
    render();
    rebuildMarkers();
  }
  healStubs();
}

/** Fold area-search records into what we know about stops.
 *
 * arroundxy carries name, lines and coordinates for stops whose detail record
 * EMT simply does not have (stop 30 Plaza Castilla is the standing example).
 * It is strictly better than the empty stub we save on a code 81, so it wins.
 *
 * Only saved stops are kept by default: a pan across town returns dozens of
 * stops per cell, and none of them belong in a device cache until saved.
 */
function mergeNearbyDetails(found, { onlySaved = true } = {}) {
  const saved = savedIds();
  let healed = false;
  for (const s of found) {
    if (onlySaved && !saved.has(s.stopId)) continue;
    if (!isStub(details[s.stopId]) || !s.coordinates) continue;
    const detail = {
      stopId: s.stopId,
      name: s.name ?? null,
      address: null,
      coordinates: s.coordinates,
      lines: s.lines ?? [],
    };
    details[s.stopId] = detail;
    writeDetail(s.stopId, detail);
    healed = true;
  }
  return healed;
}

/** Fill in detail-less saved stops by searching around the ones we can place.
 *
 * A stop with no detail record has no coordinates of its own to search from,
 * but stops travel in clusters — a Plaza Castilla bay is metres from another
 * Plaza Castilla bay we do know. Searching around each known saved stop heals
 * its blind neighbours without the map ever being opened. Nearby results are
 * cached in the worker for a day, so this is close to free.
 */
async function healStubs() {
  if (!stops.some((s) => isStub(details[s.stop_id]))) return;
  const origins = [];
  for (const stop of stops) {
    const coords = details[stop.stop_id]?.coordinates;
    if (!coords) continue;
    // Origins inside one cell resolve to the same fetch, so cluster them here
    // rather than asking the cell loader to dedupe a hundred interchange bays.
    if (origins.some((origin) => metresBetweenCoordinates(origin, coords) < 350)) continue;
    origins.push(coords);
  }
  if (origins.length === 0) return;

  const cells = new Map();
  for (const [lon, lat] of origins) {
    for (const cell of cellsAround(lat, lon)) cells.set(cellKey(cell), cell);
  }
  await loadNearbyCells([...cells.values()]);
  if (mergeNearbyDetails(nearbyStops)) {
    render();
    rebuildMarkers();
  }
}

/* ---- List / Map views ------------------------------------------------- */

let leafletMap = null;
// MapLibre has no layer groups; each collection is its own registry.
const savedPins = new Map(); // stopId → Marker
let liveBusLayerReady = false;
const liveBusMarkers = new Map();
let busMapRefreshAt = 0;
let busUserMarker = null;
let selectedRouteKey = null;
let routeBoardSort = "eta";
let clearedRoutesUndo = [];
let clearedRoutesTimer = null;
let nearbyStops = [];
let closestWalking = new Map();
let closestWalkingOrigin = null;

// Nearby stops are fetched by fixed grid cell rather than as a disc around
// wherever the map happens to be centred. A disc covers a shrinking slice of
// the viewport as you zoom out, and re-centring replaced the whole set — which
// is why pins appeared to jump and disappear while panning.
//
// 0.02° is 2226m of latitude and 1694m of longitude in Madrid, so a cell's
// half-diagonal is 1398m and one call at radius 1400 covers it exactly.
const NEARBY_CELL = 0.02;
const NEARBY_CELL_RADIUS = 1400;
const NEARBY_CELL_TTL = 24 * 60 * 60 * 1000; // stops do not move during a day
const NEARBY_MIN_ZOOM = 14;                  // below this the map is a smear of dots
const NEARBY_CELLS_PER_LOAD = 8;             // one pan must not fan out unboundedly
const nearbyCells = new Map(); // "latIndex:lonIndex" → { stops, fetchedAt }
const nearbyById = new Map();  // stopId → stop, for the by-id lookups

function cellIndex(value) {
  return Math.floor(value / NEARBY_CELL);
}

function cellKey([latIndex, lonIndex]) {
  return `${latIndex}:${lonIndex}`;
}

function cellCentre([latIndex, lonIndex]) {
  return [(lonIndex + 0.5) * NEARBY_CELL, (latIndex + 0.5) * NEARBY_CELL];
}

/** The cells a point could draw stops from, allowing for one sitting just
 *  over a boundary. One cell normally, up to four near a corner. */
function cellsAround(lat, lon, margin = 400) {
  const dLat = margin / 111_320;
  const dLon = margin / (111_320 * Math.cos((lat * Math.PI) / 180));
  const seen = new Map();
  for (const la of [lat - dLat, lat + dLat]) {
    for (const lo of [lon - dLon, lon + dLon]) {
      const cell = [cellIndex(la), cellIndex(lo)];
      seen.set(cellKey(cell), cell);
    }
  }
  return [...seen.values()];
}

function viewportCells(bounds) {
  const cells = [];
  for (let la = cellIndex(bounds.getSouth()); la <= cellIndex(bounds.getNorth()); la += 1) {
    for (let lo = cellIndex(bounds.getWest()); lo <= cellIndex(bounds.getEast()); lo += 1) {
      cells.push([la, lo]);
    }
  }
  return cells;
}

/** Fetch whichever of these cells is not already known, and fold the results
 *  into the shared index. Returns true when anything new arrived. */
async function loadNearbyCells(cells, { force = false } = {}) {
  const missing = [];
  for (const cell of cells) {
    const key = cellKey(cell);
    if (!force && nearbyCells.has(key)) continue;
    const stored = force ? null : readNearbyCell(key);
    if (stored && Date.now() - stored.fetchedAt < NEARBY_CELL_TTL) {
      nearbyCells.set(key, stored);
      continue;
    }
    missing.push(cell);
  }
  if (missing.length === 0) {
    indexNearbyCells();
    return false;
  }
  // Nearest the middle of the request first, so a capped fan-out spends its
  // budget on what the user is actually looking at.
  const focus = leafletMap && !mapEl.hidden
    ? [leafletMap.getCenter().lng, leafletMap.getCenter().lat] : cellCentre(missing[0]);
  missing.sort((a, b) =>
    metresBetweenCoordinates(focus, cellCentre(a)) - metresBetweenCoordinates(focus, cellCentre(b)));

  const fetched = await Promise.all(missing.slice(0, NEARBY_CELLS_PER_LOAD).map(async (cell) => {
    const [lon, lat] = cellCentre(cell);
    try {
      const stops = await api(
        `/stops/nearby?lat=${lat}&lon=${lon}&radius=${NEARBY_CELL_RADIUS}`
      );
      // Keep only what belongs to this cell. Cells tile exactly, so their
      // union is the whole area with nothing counted twice.
      const own = stops.filter((stop) => Array.isArray(stop.coordinates)
        && cellIndex(stop.coordinates[1]) === cell[0]
        && cellIndex(stop.coordinates[0]) === cell[1]);
      const record = { stops: own, fetchedAt: Date.now() };
      nearbyCells.set(cellKey(cell), record);
      writeNearbyCell(cellKey(cell), record);
      return own;
    } catch {
      return null; // the map stays usable without its halo of pins
    }
  }));
  indexNearbyCells();
  return fetched.some(Boolean);
}

function indexNearbyCells() {
  nearbyById.clear();
  for (const { stops } of nearbyCells.values()) {
    for (const stop of stops) nearbyById.set(String(stop.stopId), stop);
  }
  nearbyStops = [...nearbyById.values()];
}

function nearbyStop(stopId) {
  return nearbyById.get(String(stopId));
}

/* ---- Line routes on the map -------------------------------------------- */

// Keyed per direction, not per line. A stop only ever means one direction, so
// a chip tapped in its popup draws that one — but nothing stops someone asking
// for the other as well, and a line running both ways is a reasonable thing to
// want to see. Only the same direction of the same line is deduplicated.
const shownRoutes = new Map(); // "code:direction" → { layer, label, code, direction }
const routeCache = new Map(); // line code → route payload
const routeLoads = new Map();
const routeTrackCache = new Map(); // line + direction → compiled animation track

/** Draw or erase one line's route, in that line's colour.
 *
 * Route geometry is ~25KB a line and never changes during a session, so it is
 * fetched once and kept; the worker holds it for a week.
 */
function routeKey(code, direction) {
  return `${lineIdentity(code)}:${direction}`;
}

/** Every drawn direction of one line, whichever code spelling drew it. */
function shownRoutesFor(code) {
  return [...shownRoutes.values()]
    // A drawn route answers to both of its names: the code it was fetched
    // under and the label its buses are signed with.
    .filter((shown) => lineIdentity(shown.code) === lineIdentity(code)
      || lineIdentity(shown.label) === lineIdentity(code));
}

/** What a chip in `stopId`'s popup refers to: that stop's own direction if the
 *  route is known, otherwise whatever direction of the line is drawn. */
function shownRouteFor(code, stopId) {
  const route = routeCache.get(code);
  const direction = route && stopId != null ? routeStopDirection(route, stopId) : null;
  const drawn = shownRoutesFor(code);
  return (direction ? drawn.find((shown) => shown.direction === direction) : drawn[0]) ?? null;
}

/** Tap semantics: draw this direction, or remove it if it is already up. */
function toggleRoute(code, label, requestedDirection = null, anchorStopId = null) {
  return applyRoute(code, label, requestedDirection, anchorStopId, { toggle: true });
}

/** Draw this direction and leave it drawn. Used where a control means "show
 *  these", not "flip these" — a card's routes button, the nearest-stops
 *  toggle. Returns the drawn record so a caller can undo exactly its own work.
 */
function ensureRoute(code, label, requestedDirection = null, anchorStopId = null) {
  return applyRoute(code, label, requestedDirection, anchorStopId,
    { toggle: false, fit: false, refresh: false });
}

/** Draw one route direction as GL layers.
 *
 * Leaflet needed a DOM marker per arrowhead and per en-route stop — a dozen
 * arrows and ~28 dots for every direction shown, all of them transformed on
 * each frame. GL draws them from one GeoJSON source instead, which is the
 * whole reason vector is worth the port: twenty routes is now geometry in a
 * buffer rather than six hundred DOM nodes.
 *
 * Arrowheads are a symbol layer with `symbol-placement: line`, so MapLibre
 * spaces and rotates them along the path itself — the manual bearing maths
 * per arrow goes away.
 */
function drawRouteLayers(shown) {
  if (!leafletMap?.isStyleLoaded()) return; // re-run from the style's load event
  removeRouteLayers(shown);
  const { sourceId, color, segments, routeStops } = shown;
  const saved = savedIds();
  const seen = new Set();
  const dots = [];
  for (const stop of routeStops) {
    if (seen.has(stop.stopId) || saved.has(stop.stopId) || !stop.coordinates) continue;
    seen.add(stop.stopId);
    dots.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: stop.coordinates },
      properties: { stopId: String(stop.stopId), name: stop.name ?? "" },
    });
  }

  leafletMap.addSource(sourceId, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {},
          geometry: { type: "MultiLineString", coordinates: segments } },
      ],
    },
  });
  leafletMap.addSource(`${sourceId}-stops`, {
    type: "geojson",
    data: { type: "FeatureCollection", features: dots },
  });

  leafletMap.addLayer({
    id: `${sourceId}-line`,
    type: "line",
    source: sourceId,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": 4, "line-opacity": 0.9 },
  });
  leafletMap.addLayer({
    id: `${sourceId}-arrows`,
    type: "symbol",
    source: sourceId,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 90,
      "text-field": "▲",
      "text-size": 13,
      "text-rotation-alignment": "map",
      "text-keep-upright": false,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: { "text-color": color, "text-halo-color": "#0d0f14", "text-halo-width": 1 },
  });
  // Quiet on purpose: the drawn path and the live buses are the subject, and
  // these are every stop on a city-length line.
  leafletMap.addLayer({
    id: `${sourceId}-stops`,
    type: "circle",
    source: `${sourceId}-stops`,
    // Every stop on a city-length line is noise at overview zoom, where the
    // shape of the route is the thing you are reading. Same threshold the
    // nearby pins use, so stops appear and disappear together.
    minzoom: NEARBY_MIN_ZOOM,
    paint: {
      "circle-radius": 4,
      "circle-color": "#12141a",
      "circle-opacity": 0.8,
      "circle-stroke-color": color,
      "circle-stroke-width": 1.5,
      "circle-stroke-opacity": 0.6,
    },
  });
}

function removeRouteLayers(shown) {
  if (!leafletMap) return;
  for (const suffix of ["-line", "-arrows", "-stops"]) {
    const id = `${shown.sourceId}${suffix}`;
    if (leafletMap.getLayer(id)) leafletMap.removeLayer(id);
  }
  for (const id of [shown.sourceId, `${shown.sourceId}-stops`]) {
    if (leafletMap.getSource(id)) leafletMap.removeSource(id);
  }
}

function removeShownRoute(shown) {
  const key = routeKey(shown.code, shown.direction);
  if (!shownRoutes.has(key)) return false;
  removeRouteLayers(shownRoutes.get(key));
  shownRoutes.delete(key);
  return true;
}

async function applyRoute(code, label, requestedDirection, anchorStopId,
  { toggle = true, fit = true, refresh = true } = {}) {
  if (!leafletMap) return null;

  // The direction has to be known before anything can be toggled, and it comes
  // out of the route. After the first draw this is a cache read, so turning a
  // route off never costs a request.
  let route = routeCache.get(code);
  if (!route) {
    statusEl.textContent = `Loading route ${label}…`;
    try {
      route = await api(`/lines/${encodeURIComponent(code)}/route`);
      routeCache.set(code, route);
    } catch (err) {
      statusEl.textContent = `Could not load route ${label}: ${err.message}`;
      return null;
    }
    statusEl.textContent = "";
  }

  // EMT answers to both of a line's names — /lines/519/route and
  // /lines/N19/route are the same route — so the caller's spelling cannot be
  // what identifies it. The payload reports its own canonical code and label;
  // key on those, or one tap draws "519:toB" and the next draws "N19:toB" and
  // neither can ever toggle the other off.
  const canonicalCode = String(route.line ?? code);
  const canonicalLabel = String(route.label ?? label);
  if (!routeCache.has(canonicalCode)) routeCache.set(canonicalCode, route);
  if (!routeCache.has(canonicalLabel)) routeCache.set(canonicalLabel, route);

  // The stop a chip was tapped in serves exactly one direction of that line,
  // so it names the direction outright rather than being guessed at.
  const next = requestedDirection ?? routeStopDirection(route, anchorStopId) ?? "toA";
  const key = routeKey(canonicalCode, next);
  const current = shownRoutes.get(key);
  const anchor = anchorStopId ?? current?.anchorStopId ?? null;
  if (current) {
    // Already drawn. A tap means "off"; a "show these" caller means "nothing
    // to do". Either way the opposite direction is left exactly where it is.
    if (!toggle) return current;
    removeShownRoute(current);
    if (selectedRouteKey === key) selectedRouteKey = null;
    renderRouteLegend();
    rebuildLiveBusMarkers();
    return null;
  }

  const color = lineColor(canonicalLabel);
  const record = {
    sourceId: `route-${key.replace(/[^A-Za-z0-9]/g, "_")}`,
    segments: route.paths?.[next] ?? [],
    routeStops: route.stops?.[next] ?? [],
    color,
    label: canonicalLabel,
    code: canonicalCode,
    direction: next,
    towards: next === "toA" ? route.nameA : route.nameB,
    anchorStopId: anchor,
  };
  shownRoutes.set(key, record);
  drawRouteLayers(record);
  forgetClearedRoutes();
  renderRouteLegend();
  rebuildLiveBusMarkers();

  // Only fit when the route would otherwise be off screen entirely. Moving
  // the map out from under a tap is disorienting on its own, and it cascades:
  // the pan reloads nearby stops, which rebuilds the pins and destroys the
  // popup the chip was tapped in.
  const points = record.segments.flat();
  if (fit && points.length) {
    const bounds = points.reduce(
      (box, at) => box.extend(at), new maplibregl.LngLatBounds(points[0], points[0]));
    const view = leafletMap.getBounds();
    const clear = bounds.getWest() > view.getEast() || bounds.getEast() < view.getWest()
      || bounds.getSouth() > view.getNorth() || bounds.getNorth() < view.getSouth();
    if (clear) leafletMap.fitBounds(bounds, { padding: 40, animate: false });
  }
  // After the fit, never before: the probe is chosen against the viewport.
  if (refresh) void refreshMapArrivals();
  return record;
}

/** EMT's segments chain end to start, so concatenating them gives the path in
 *  travel order — which is what tells us which way the arrows point. */
function orderedPoints(segments) {
  const points = [];
  for (const seg of segments ?? []) {
    for (const pair of seg) {
      const last = points[points.length - 1];
      if (!last || last[0] !== pair[0] || last[1] !== pair[1]) points.push(pair);
    }
  }
  return points;
}

const ARROWS_PER_ROUTE = 12;



/** The lines at a stop that actually have a bus coming.
 *
 * A stop's line list is what it serves; the board is what is running. At
 * 22:40 those are very different things, and drawing five routes for one bus
 * is not showing you anything.
 */
function dueLinesAt(stopId) {
  const due = new Set((arrivals[stopId]?.arrivals ?? [])
    .filter((bus) => Number(bus.seconds) < SCHEDULED_SECONDS)
    .map((bus) => lineIdentity(bus.line)));
  // Arrivals name a line by its label, so a stop's line matches on either of
  // its names. Matching on the code alone discarded detail's record and drew
  // the route under a bare label that no bus could then be matched against.
  return stopLines(stopId).filter((line) =>
    due.has(lineIdentity(line.line)) || due.has(lineIdentity(line.label)));
}

/** Draw every line running at a stop, each in the direction that stop serves.
 *
 * The whole set costs one arrivals call: probe stops dedupe through a Set and
 * every line anchored here resolves to this same stop, whose board already
 * lists all of them. Geometry is the only real cost, and it is fetched one
 * line at a time — a burst of parallel route requests is what made this
 * unusable when it was tried before.
 *
 * Pressing again with all of them up takes them all down.
 */
async function toggleStopRoutes(stopId, { label } = {}) {
  const where = label || `stop ${stopId}`;
  if (!arrivals[stopId]) await refreshStop(stopId);
  const lines = dueLinesAt(stopId);
  if (lines.length === 0) {
    statusEl.textContent = `Nothing due at ${where} to draw.`;
    return [];
  }
  const already = lines.map((line) => shownRouteFor(line.line, stopId)).filter(Boolean);
  if (already.length === lines.length) {
    already.forEach(removeShownRoute);
    renderRouteLegend();
    rebuildLiveBusMarkers();
    statusEl.textContent = "";
    return [];
  }
  const drawn = [];
  for (const [index, line] of lines.entries()) {
    statusEl.textContent = `Drawing ${where}: ${line.label} (${index + 1}/${lines.length})…`;
    const record = await ensureRoute(line.line, line.label, null, stopId);
    if (record) drawn.push(record);
  }
  statusEl.textContent = "";
  void refreshMapArrivals();
  return drawn;
}

/** Bring the map up, centred on a stop, without disturbing the zoom someone
 *  chose. A control that draws routes is useless from the list view. */
function focusMapOn(coordinates) {
  showView("map");
  if (!leafletMap || !Array.isArray(coordinates)) return;
  const zoom = Math.max(leafletMap.getZoom(), NEARBY_MIN_ZOOM);
  leafletMap.jumpTo({ center: coordinates, zoom });
}

/** Card control: show me what is running at this stop, on the map. */
async function showRoutesForStop(stopId, label) {
  focusMapOn(details[stopId]?.coordinates ?? nearbyStop(stopId)?.coordinates);
  await toggleStopRoutes(stopId, { label });
}

/** Hub card control: draw the legs this journey actually tells you to take.
 *  The planner already resolved each leg's line and direction, so nothing is
 *  inferred here. */
async function showJourneyRoutes(options, placeName) {
  if (!options?.length) return;
  const legs = options.flatMap((option) => [
    { leg: option.firstLeg, stopId: option.originStop?.stopId },
    { leg: option.secondLeg, stopId: option.transfer?.toStop?.stopId },
  ]).filter(({ leg }) => leg?.line);
  if (legs.length === 0) return;
  focusMapOn(options[0].originStop?.coordinates);
  for (const [index, { leg, stopId }] of legs.entries()) {
    statusEl.textContent = `Drawing ${placeName}: ${leg.label} (${index + 1}/${legs.length})…`;
    await ensureRoute(leg.line, leg.label, leg.direction ?? null, stopId ?? null);
  }
  statusEl.textContent = "";
  void refreshMapArrivals();
}

// Routes drawn by the nearest-stops toggle, so turning it off removes exactly
// what it added and leaves anything picked by hand alone.
const NEAREST_STOPS_SHOWN = 5;
let nearestStopRoutes = [];

function nearestSavedStops(limit = NEAREST_STOPS_SHOWN) {
  return [...stops]
    .filter((stop) => details[stop.stop_id]?.coordinates)
    .sort((a, b) => proximity(metresFromCurrent(details[a.stop_id].coordinates)) -
      proximity(metresFromCurrent(details[b.stop_id].coordinates)))
    .slice(0, limit);
}

/** One control for "what can I catch near me": the same thing as pressing the
 *  routes button on each of the nearest saved stops. */
async function toggleNearestStopRoutes() {
  if (nearestStopRoutes.length) {
    nearestStopRoutes.forEach(removeShownRoute);
    nearestStopRoutes = [];
    renderRouteLegend();
    rebuildLiveBusMarkers();
    syncMapControls();
    return;
  }
  const nearest = nearestSavedStops();
  if (nearest.length === 0) {
    statusEl.textContent = "No saved stops with a known location yet.";
    return;
  }
  showView("map");
  const drawn = [];
  for (const stop of nearest) {
    if (!arrivals[stop.stop_id]) {
      await refreshStop(stop.stop_id);
    }
    for (const line of dueLinesAt(stop.stop_id)) {
      statusEl.textContent = `Drawing ${stopTitle(stop)}: ${line.label}…`;
      const record = await ensureRoute(line.line, line.label, null, stop.stop_id);
      if (record) drawn.push(record);
    }
  }
  nearestStopRoutes = drawn;
  statusEl.textContent = drawn.length
    ? "" : `Nothing due at your ${nearest.length} nearest stops.`;
  void refreshMapArrivals();
  syncMapControls();
}

/** How long the undo offer stands. It used to stand for ever — nothing
 *  expired it — so a one-off action left a bar sitting over the board. */
const UNDO_VISIBLE_MS = 7_000;

function forgetClearedRoutes() {
  clearTimeout(clearedRoutesTimer);
  clearedRoutesTimer = null;
  clearedRoutesUndo = [];
}

function clearRoutes({ keepUndo = true } = {}) {
  if (keepUndo) {
    clearedRoutesUndo = [...shownRoutes.values()];
    clearTimeout(clearedRoutesTimer);
    clearedRoutesTimer = setTimeout(() => {
      forgetClearedRoutes();
      renderRouteLegend();
    }, UNDO_VISIBLE_MS);
  }
  for (const shown of shownRoutes.values()) removeRouteLayers(shown);
  shownRoutes.clear();
  selectedRouteKey = null;
  nearestStopRoutes = [];
  renderRouteLegend();
  rebuildLiveBusMarkers();
  syncMapControls();
}

function undoClearRoutes() {
  if (!leafletMap || clearedRoutesUndo.length === 0) return;
  for (const shown of clearedRoutesUndo) {
    drawRouteLayers(shown);
    shownRoutes.set(routeKey(shown.code, shown.direction), shown);
  }
  forgetClearedRoutes();
  renderRouteLegend();
  rebuildLiveBusMarkers();
  syncMapControls();
  void refreshMapArrivals();
}

function routeBoardArrival(shown) {
  const stopId = routeProbeStop(shown) ?? shown.anchorStopId;
  const payload = arrivals[String(stopId)];
  const elapsed = payload ? Math.floor((Date.now() - Number(payload.fetchedAt)) / 1000) : 0;
  const matches = (payload?.arrivals ?? []).filter((bus) =>
    lineIdentity(bus.line) === lineIdentity(shown.label)
      || lineIdentity(bus.line) === lineIdentity(shown.code));
  const bus = matches.find((candidate) => Number(candidate.seconds) < SCHEDULED_SECONDS) ?? null;
  const seconds = bus ? Math.max(0, Number(bus.seconds) - elapsed) : null;
  return {
    destination: bus?.destination || shown.towards || "Destination unavailable",
    minutes: Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds / 60)) : null,
  };
}

function setSelectedRoute(key) {
  selectedRouteKey = selectedRouteKey === key ? null : key;
  renderRouteLegend();
  syncRouteSelectionStyles();
}

function syncRouteSelectionStyles() {
  for (const [key, shown] of shownRoutes) {
    const selected = selectedRouteKey === key;
    const dimmed = Boolean(selectedRouteKey) && !selected;
    // Paint properties instead of restyling a polyline object; GL has no
    // z-order to bring forward, so the drawn order is the order.
    const lineId = `${shown.sourceId}-line`;
    if (leafletMap?.getLayer(lineId)) {
      leafletMap.setPaintProperty(lineId, "line-width", selected ? 6 : 4);
      leafletMap.setPaintProperty(lineId, "line-opacity", dimmed ? 0.14 : 0.9);
    }
  }
  for (const marker of liveBusMarkers.values()) {
    const selected = marker.busRouteKey === selectedRouteKey;
    const dimmed = Boolean(selectedRouteKey) && !selected;
    marker.getElement().style.zIndex = selected ? "1000" : "700";
    marker.getElement()?.classList.toggle("is-selected", selected);
    marker.getElement()?.classList.toggle("is-dimmed", dimmed);
  }
}

/** Chips naming what is drawn — the only way to tell one route from another
 *  once several are up, and the way to take them down again. */
function renderRouteLegend() {
  const legend = document.getElementById("route-legend");
  legend.hidden = mapEl.hidden;
  // Once a route is the subject, the city-wide halo of generic stop dots is
  // visual noise. Route-specific stops stay in the route layer; nearby stops
  // return as soon as the final followed route is removed.
  renderNearbyPins();
  legend.replaceChildren();

  const head = document.createElement("div");
  head.className = "route-board-head";
  const title = document.createElement("span");
  title.className = "route-board-title";
  title.textContent = "Following";
  const count = document.createElement("span");
  count.className = "route-board-count";
  count.textContent = String(shownRoutes.size);
  const sort = document.createElement("button");
  sort.type = "button";
  sort.className = "route-board-sort";
  sort.textContent = `Sort · ${routeBoardSort === "eta" ? "soonest" : "line"}`;
  sort.addEventListener("click", () => {
    routeBoardSort = routeBoardSort === "eta" ? "line" : "eta";
    renderRouteLegend();
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "route-board-clear";
  clear.textContent = "Clear all";
  clear.disabled = shownRoutes.size === 0;
  clear.addEventListener("click", () => clearRoutes());
  head.append(title, count, sort, clear);
  legend.append(head);

  const board = document.createElement("div");
  board.className = "route-board";
  const rows = [...shownRoutes.entries()].map(([key, shown]) => ({
    key, shown, arrival: routeBoardArrival(shown),
  }));
  rows.sort(routeBoardSort === "eta"
    ? (a, b) => (a.arrival.minutes ?? Infinity) - (b.arrival.minutes ?? Infinity)
    : (a, b) => String(a.shown.label).localeCompare(String(b.shown.label), "es", { numeric: true }));
  for (const { key, shown, arrival } of rows) {
    const row = document.createElement("div");
    row.className = "route-board-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", String(selectedRouteKey === key));
    row.setAttribute("aria-label", `Select line ${shown.label} towards ${arrival.destination}`);
    const select = () => setSelectedRoute(key);
    row.addEventListener("click", select);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
    const color = lineColor(shown.label);
    const spine = document.createElement("span");
    spine.className = "route-board-spine";
    spine.style.background = color;
    const number = document.createElement("span");
    number.className = "route-board-number";
    number.style.color = color;
    number.textContent = shown.label;
    const destination = document.createElement("span");
    destination.className = "route-board-destination";
    destination.textContent = arrival.destination;
    const eta = document.createElement("span");
    eta.className = `route-board-eta${arrival.minutes != null && arrival.minutes <= 3 ? " soon" : ""}`;
    eta.textContent = arrival.minutes == null ? "—" : String(arrival.minutes);
    if (arrival.minutes != null) {
      const unit = document.createElement("small");
      unit.textContent = "min";
      eta.append(unit);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "route-board-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Stop following ${shown.label}`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeShownRoute(shown);
      if (selectedRouteKey === key) selectedRouteKey = null;
      renderRouteLegend();
      rebuildLiveBusMarkers();
      syncMapControls();
    });
    row.append(spine, number, destination, eta, remove);
    board.append(row);
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "route-board-empty";
    empty.textContent = "Nothing followed yet. Tap a bus on the map to follow its line.";
    board.append(empty);
  }
  legend.append(board);
  if (clearedRoutesUndo.length) {
    const undo = document.createElement("div");
    undo.className = "route-board-undo";
    const message = document.createElement("span");
    message.textContent = `Cleared ${clearedRoutesUndo.length} route${clearedRoutesUndo.length === 1 ? "" : "s"}`;
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "Undo";
    action.addEventListener("click", undoClearRoutes);
    undo.append(message, action);
    legend.append(undo);
  }
  syncRouteSelectionStyles();
}

/** The line list inside a popup, each line a button that draws its route. */
/** How a line chip looks, wherever it is drawn. Shared so a tappable row and
 *  a standalone chip cannot drift apart. */
function paintLineChip(node, l, drawn) {
  node.className = drawn ? "line-chip on" : "line-chip";
  node.textContent = drawn?.towards ? `${l.label} → ${drawn.towards}` : l.label;
  node.style.color = lineColor(l.label);
  node.style.borderColor = lineColor(l.label);
}

/** The star the stop cards use, doing the same job in a popup for a row less
 *  than a full-width "Add this stop" button. */
/** What a stop popup lets you do to it. The star is always offered; the sheet
 *  is only worth opening for a saved stop, since that is where its name is
 *  edited and its full board lives. */
/** What a stop popup lets you do to it: save it, and open it.
 *
 * Both are offered whether or not the stop is saved. The sheet is worth
 * opening either way — it holds the full board, the line hours and a bigger
 * map — it just has nothing to rename or remove until the stop is yours.
 */
function stopPopupActions(seed) {
  const saved = stops.find((row) => row.stop_id === String(seed.stopId));
  return [savedStopStar(seed), stopInfoButton(seed, saved)];
}

function savedStopStar(s) {
  const saved = stops.find((row) => row.stop_id === String(s.stopId));
  const star = document.createElement("button");
  star.type = "button";
  star.className = "pop-star";
  star.textContent = saved ? "★" : "☆";
  star.title = saved ? `Remove stop ${s.stopId} from saved` : `Save stop ${s.stopId}`;
  star.setAttribute("aria-label", star.title);
  star.addEventListener("click", async (event) => {
    event.stopPropagation();
    star.disabled = true;
    try {
      if (saved) await deleteStop(saved.id);
      else {
        await addStopById(String(s.stopId), null, s);
        renderNearbyPins(); // the saved stop drops out of the nearby halo
      }
      statusEl.textContent = "";
    } catch {
      star.disabled = false;
      return;
    }
    // Outside the catch: the save succeeded, and a failure to restore the
    // popup must not be reported — or silently swallowed — as a failed save.
    reopenStopPopup(s.stopId);
  });
  return star;
}


function popupHtml(stop) {
  // Built as DOM, never as a string: line names/labels come from EMT.
  const wrap = document.createElement("div");
  const num = document.createElement("p");
  num.className = "stop-num";
  num.textContent = `Nº ${stop.stop_id}`;
  wrap.append(
    popupHead(stopTitle(stop),
      ...stopPopupActions({ stopId: stop.stop_id, name: stopTitle(stop) })),
    num,
  );

  const cached = arrivals[stop.stop_id];
  const list = lineRowList(stop.stop_id, stopLines(stop.stop_id), cached);
  if (list) {
    wrap.append(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "muted pop-empty";
    empty.textContent = cached ? emptyBoardText(stop.stop_id) : "No data yet";
    wrap.append(empty);
  }

  // Every rendering of arrival data carries its age.
  if (cached) {
    const age = document.createElement("p");
    age.className = "age";
    age.textContent = `updated ${fmtAge(cached.fetchedAt)}`;
    wrap.append(age);
  }
  return wrap;
}

function ensureMap() {
  if (leafletMap) return;
  leafletMap = createMap(mapEl, { center: myLngLat(), zoom: 13 });
  // Route geometry is added as GL layers once the style has loaded; markers
  // are DOM and can be attached immediately.
  leafletMap.on("load", () => {
    liveBusLayerReady = true;
    for (const shown of shownRoutes.values()) drawRouteLayers(shown);
    rebuildLiveBusMarkers();
  });
  if (myLocation) busUserMarker = addUserMarker(leafletMap, myLocation);
  rebuildMarkers();
  leafletMap.on("moveend", loadNearby);
  // A tap on the map itself dismisses whatever popup is open.
  leafletMap.on("click", () => closeMapPopup());

  // Fit once, on the first build, when all pins are known.
  const points = stops.map((s) => details[s.stop_id]?.coordinates).filter(Boolean);
  if (points.length > 0) {
    const bounds = points.reduce(
      (box, at) => box.extend(at), new maplibregl.LngLatBounds(points[0], points[0]));
    leafletMap.fitBounds(bounds, { padding: 48, animate: false });
  } else if (stops.length > 0) {
    // Madrid centre; details may still be resolving.
    leafletMap.jumpTo({ center: MADRID, zoom: 12 });
  }
  loadNearby();
}

/** MapLibre shows one popup per map and keeps it independent of any marker.
 *
 * Leaflet bound a popup to each marker, so every rebuild destroyed whichever
 * one was open and a tick had to scan layers to find it again — the source of
 * a long run of "the popup closed by itself" bugs. Here the map owns the
 * popup and the function that redraws it, so rebuilding pins cannot disturb
 * it and the countdown re-render is one call.
 */
let mapPopup = null;
let mapPopupKey = null;
let mapPopupRender = null;

function showMapPopup(map, lngLat, key, render) {
  closeMapPopup();
  mapPopupKey = key;
  mapPopupRender = render;
  mapPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, maxWidth: "290px" })
    .setLngLat(lngLat)
    .setDOMContent(render())
    .addTo(map);
  mapPopup.on("close", () => {
    if (mapPopupKey !== key) return;
    mapPopup = null;
    mapPopupKey = null;
    mapPopupRender = null;
  });
}

function closeMapPopup() {
  mapPopup?.remove();
  mapPopup = null;
  mapPopupKey = null;
  mapPopupRender = null;
}

/** Redraw the open popup so its countdowns tick like the cards. */
function tickPopups() {
  if (mapEl.hidden || !mapPopup || !mapPopupRender) return;
  mapPopup.setDOMContent(mapPopupRender());
}

/** After saving or unsaving, the open popup is showing stale actions. */
function reopenStopPopup() {
  tickPopups();
}


/** One pin shape for every stop, saved or not.
 *
 * They used to be different objects: Leaflet's default 25×41 teardrop for a
 * saved stop and a small circle for the rest. The teardrop anchors its popup
 * above the icon's tip, the circle anchors at its centre — so saving or
 * unsaving a stop made the open popup jump by the height of a marker.
 * Identical geometry, different paint.
 *
 * The basemap is CARTO dark_nolabels whatever the app's theme, so these are
 * painted for a dark ground: a bright disc for a stop that is yours, a hollow
 * ring for one that is not. The old grey-on-near-black blob read as neither.
 */
const STOP_PIN_RADIUS = 7;

/** Tracked wins over saved when a stop is both: the alert is the more
 *  specific fact, and the saved fill stays underneath the tracked ring. */
function stopPin(lngLat, { saved, stopId }) {
  const pin = domMarker("", `stop-pin${saved ? " saved" : ""}`, lngLat);
  pin.getElement().classList.toggle("tracked", tracking.isTracked("bus", stopId));
  return pin;
}

function rebuildMarkers() {
  if (!leafletMap) return;
  for (const marker of savedPins.values()) marker.remove();
  savedPins.clear();
  for (const stop of stops) {
    const coords = details[stop.stop_id]?.coordinates;
    if (!coords) continue;
    // EMT gives [lon, lat], which is the order MapLibre wants.
    const marker = stopPin(coords, { saved: true, stopId: stop.stop_id }).addTo(leafletMap);
    marker.getElement().addEventListener("click", (event) => {
      event.stopPropagation();
      showMapPopup(leafletMap, coords, `stop:${stop.stop_id}`, () => popupHtml(stop));
    });
    savedPins.set(stop.stop_id, marker);
  }
}

/** A bus, seen from above.
 *
 * It used to be a 44px badge with wheels and a separate arrow — legible, but
 * it sat on top of the map rather than in it. This is a vehicle on the road:
 * oriented by the path's own tangent, so the body points the way and no arrow
 * is needed, with a darker band at the leading end saying which end is front.
 *
 * The line number runs along the body's long axis, which is the only place a
 * five-character label like SE833 fits at this size. It is flipped through
 * 180° whenever the heading would otherwise leave it upside down, so it is
 * never read backwards — the trade is that a bus heading north or south reads
 * vertically.
 */
function liveBusIcon(bus) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 56 56");
  svg.setAttribute("aria-hidden", "true");
  const bearing = Number.isFinite(bus.bearing) ? Number(bus.bearing) : 0;
  const vehicle = document.createElementNS(ns, "g");
  vehicle.setAttribute("transform", `rotate(${bearing} 28 28)`);

  const body = document.createElementNS(ns, "rect");
  body.setAttribute("class", "live-bus-body");
  body.setAttribute("x", "18");
  body.setAttribute("y", "6");
  body.setAttribute("width", "20");
  body.setAttribute("height", "44");
  body.setAttribute("rx", "9");
  body.setAttribute("fill", lineColor(bus.line));

  const screen = document.createElementNS(ns, "rect");
  screen.setAttribute("class", "live-bus-screen");
  screen.setAttribute("x", "20.5");
  screen.setAttribute("y", "9");
  screen.setAttribute("width", "15");
  screen.setAttribute("height", "8");
  screen.setAttribute("rx", "4");

  // Along the body, and never upside down: the label sits at bearing − 90,
  // so add half a turn whenever that lands in the unreadable half.
  const onScreen = (((bearing - 90) % 360) + 360) % 360;
  const label = onScreen > 90 && onScreen < 270 ? 90 : -90;
  const number = document.createElementNS(ns, "text");
  number.setAttribute("class", "live-bus-number");
  number.setAttribute("x", "28");
  number.setAttribute("y", "32");
  number.setAttribute("transform", `rotate(${label} 28 32)`);
  number.textContent = bus.line;

  vehicle.append(body, screen, number);
  svg.append(vehicle);
  return svg;
}

function movementBearing([oldLon, oldLat], [newLon, newLat]) {
  const dx = (newLon - oldLon) * Math.cos((oldLat * Math.PI) / 180);
  const dy = newLat - oldLat;
  if (Math.abs(dx) + Math.abs(dy) < 1e-7) return null;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** Which of a route's two directions a reported bus is running.
 *
 * EMT's arrivals payload carries no direction field at all, so it has to be
 * inferred. The strongest signal is the stop the estimate came from: the two
 * directions run down opposite sides of the street and barely share stops —
 * live line 27 has 27 and 28 of them with 2 in common — so membership settles
 * almost every bus outright; stop detail's own A/B and the signed destination
 * cover the shared stops. Geometry deliberately is not a fallback — the two
 * directions share carriageways, so "nearest path" is polyline sampling noise
 * and was decisively wrong on half the live samples it decided.
 */
function busRouteDirection(bus, line, route) {
  const byStop = routeStopDirection(route, bus.sourceStopId);
  if (byStop) return byStop;
  if (line.direction === "A") return "toA";
  if (line.direction === "B") return "toB";
  return destinationDirection(bus.destination, route);
}

const routeStopSets = new WeakMap(); // route payload → stop ids per direction

function routeStopDirection(route, stopId) {
  if (stopId == null) return null;
  let sets = routeStopSets.get(route);
  if (!sets) {
    sets = {
      toA: new Set((route.stops?.toA ?? []).map((stop) => String(stop.stopId))),
      toB: new Set((route.stops?.toB ?? []).map((stop) => String(stop.stopId))),
    };
    routeStopSets.set(route, sets);
  }
  const id = String(stopId);
  const inA = sets.toA.has(id);
  const inB = sets.toB.has(id);
  // A terminus, or the rare two-way bay, sits on both lists and says nothing.
  return inA && !inB ? "toA" : inB && !inA ? "toB" : null;
}

/** EMT signs its buses with an abbreviation of the section name, never the
 *  name itself — "EMBAJADORES" for "GLORIETA DE EMBAJADORES", "PLAZA
 *  CASTILLA" for "PLAZA DE CASTILLA" — so this is a token-subset test rather
 *  than the string equality that matched nothing. */
function destinationDirection(destination, route) {
  const wanted = routeNameTokens(destination);
  if (!wanted.size) return null;
  const covers = (name) => {
    const tokens = routeNameTokens(name);
    return tokens.size > 0 && [...wanted].every((token) => tokens.has(token));
  };
  const a = covers(route.nameA);
  const b = covers(route.nameB);
  return a && !b ? "toA" : b && !a ? "toB" : null;
}

function routeNameTokens(value) {
  return new Set(String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().split(/[^A-Z0-9]+/).filter((token) => token.length > 2));
}

function loadBusRoute(bus) {
  const line = busLineCode(bus);
  const cached = routeCache.get(line.line);
  if (cached) return Promise.resolve({ route: cached, line });
  if (!routeLoads.has(line.line)) {
    routeLoads.set(line.line, api(`/lines/${encodeURIComponent(line.line)}/route`)
      .then((route) => {
        routeCache.set(line.line, route);
        return route;
      })
      .finally(() => routeLoads.delete(line.line)));
  }
  return routeLoads.get(line.line).then((route) => ({ route, line }));
}

/** The displayed route a bus belongs to, or null if it belongs to none.
 *
 * A bus whose direction cannot be pinned down still counts: it is a real
 * vehicle on a line the user asked to see, and dropping it leaves an empty
 * map. It simply gets drawn where EMT reports it rather than snapped to the
 * path.
 */
function busShownRoute(bus) {
  const line = busLineCode(bus);
  const drawn = shownRoutesFor(line.line);
  if (drawn.length === 0) return null;
  const route = routeCache.get(line.line) ?? routeCache.get(drawn[0].code);
  if (!route) return null;
  const direction = busRouteDirection(bus, line, route);
  if (direction) {
    const shown = drawn.find((candidate) => candidate.direction === direction);
    return shown ? {
      code: shown.code,
      route,
      direction,
      snapped: true,
      key: routeKey(shown.code, shown.direction),
    } : null;
  }
  // Without a resolved direction a bus can only be placed when there is one
  // drawn direction to place it on. With both up, guessing would be a coin
  // flip between two lines of traffic going opposite ways.
  return drawn.length === 1
    ? {
      code: drawn[0].code,
      route,
      direction: drawn[0].direction,
      snapped: false,
      key: routeKey(drawn[0].code, drawn[0].direction),
    }
    : null;
}

function busRouteTrack(bus) {
  const shown = busShownRoute(bus);
  // A resolved direction is not required to place the bus. `DistanceBus` is
  // measured to the probe stop, and that stop is on the direction being drawn,
  // so `stopProgress − metres` is arithmetic on EMT's own measurement rather
  // than a guess about which way the vehicle faces. Withholding the track here
  // only pushed the marker onto the GPS fix — the one signal that freezes for
  // minutes while the popup's distance keeps counting down.
  if (!shown) return null;
  const { code: shownCode, route, direction } = shown;
  const cacheKey = routeKey(shownCode, direction);
  if (routeTrackCache.has(cacheKey)) return routeTrackCache.get(cacheKey);
  const components = [];
  for (const segment of route.paths?.[direction] ?? []) {
    if (!Array.isArray(segment) || segment.length < 2) continue;
    const current = components.at(-1);
    if (current && metresBetweenCoordinates(current.points.at(-1), segment[0]) <= 80) {
      current.points.push(...segment.slice(1));
    } else {
      components.push({ points: [...segment] });
    }
  }
  // Progress is measured from the start of the whole path, not of a component,
  // so it can be compared with a distance EMT reports along the route.
  let offset = 0;
  for (const component of components) {
    component.cumulative = [0];
    for (let i = 1; i < component.points.length; i += 1) {
      component.cumulative.push(component.cumulative[i - 1]
        + metresBetweenCoordinates(component.points[i - 1], component.points[i]));
    }
    component.offset = offset;
    offset += component.cumulative.at(-1);
  }
  const track = components.length ? { components, length: offset } : null;
  routeTrackCache.set(cacheKey, track);
  return track;
}

function nearestTrackPosition(track, coordinate) {
  const latitudeScale = Math.cos((coordinate[1] * Math.PI) / 180);
  let nearest = null;
  for (let componentIndex = 0; componentIndex < track.components.length; componentIndex += 1) {
    const component = track.components[componentIndex];
    for (let i = 1; i < component.points.length; i += 1) {
      const a = component.points[i - 1];
      const b = component.points[i];
      const dx = (b[0] - a[0]) * latitudeScale;
      const dy = b[1] - a[1];
      const px = (coordinate[0] - a[0]) * latitudeScale;
      const py = coordinate[1] - a[1];
      const length2 = dx * dx + dy * dy;
      const ratio = length2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
      const point = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
      const distance = metresBetweenCoordinates(coordinate, point);
      if (!nearest || distance < nearest.distance) {
        nearest = {
          coordinate: point,
          distance,
          progress: component.offset + component.cumulative[i - 1]
            + (component.cumulative[i] - component.cumulative[i - 1]) * ratio,
        };
      }
    }
  }
  return nearest;
}

function trackCoordinateAt(track, progress) {
  const bounded = Math.max(0, Math.min(progress, track.length));
  let component = track.components[0];
  for (const candidate of track.components) {
    if (bounded >= candidate.offset) component = candidate;
  }
  const local = Math.min(bounded - component.offset, component.cumulative.at(-1));
  let low = 1;
  let high = component.cumulative.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (component.cumulative[middle] < local) low = middle + 1;
    else high = middle;
  }
  const index = low;
  const start = component.cumulative[index - 1];
  const length = component.cumulative[index] - start;
  const ratio = length ? (local - start) / length : 0;
  const a = component.points[index - 1];
  const b = component.points[index];
  return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
}

/** Where a bus is along the drawn path, in metres from its start.
 *
 * EMT publishes two positions per arrival. `geometry.coordinates` is a GPS
 * fix that can sit unchanged for minutes; `DistanceBus` moves on every poll,
 * but night routes have shown it disagreeing with an on-route GPS fix by more
 * than a kilometre. Neither feed is unconditionally authoritative.
 *
 * Measured on line 27, 2026-08-25: across 48 seconds the fix did not change
 * for 43 of them and then jumped 1.1km, while DistanceBus counted 3137 →
 * 2957m smoothly. Once the fix caught up, the along-track distance from it to
 * the stop was 2873m against a reported 2957m — agreement to within 85m.
 *
 * Use the smooth stop distance while both sources broadly agree. If a GPS fix
 * is itself close to the selected route and they differ implausibly, prefer
 * that fix rather than teleporting the marker out of view.
 */
function busTrackProgress(bus, track, route) {
  const metres = Number(bus.metres);
  const source = anchorCoordinates(route, String(bus.sourceStopId));
  const stopOnTrack = source && nearestTrackPosition(track, source);
  const fix = Array.isArray(bus.coordinates) && nearestTrackPosition(track, bus.coordinates);
  const usableFix = fix && fix.distance <= 120 ? fix : null;
  if (Number.isFinite(metres) && stopOnTrack && stopOnTrack.distance <= 120) {
    const progress = stopOnTrack.progress - metres;
    // Before the start of the path the bus has not joined this leg yet — it is
    // still finishing the other one, which is not the line drawn on screen.
    if (progress < 0) return null;
    // A large disagreement with the GPS fix is not evidence against the
    // distance — it is the signature of a fix that has gone stale, measured at
    // 838m on line 27. Preferring the fix there is how a bus came to sit still
    // while its own countdown ran, then jump when the fix finally caught up.
    return progress;
  }
  // No distance reported: fall back to the fix, stale as it may be.
  return usableFix?.progress ?? null;
}

/** Heading from the path itself rather than from two GPS fixes minutes
 *  apart — a bus on a road points along that road. */
function trackBearingAt(track, progress) {
  const ahead = Math.min(track.length, progress + 20);
  const behind = Math.max(0, ahead - 40);
  if (ahead - behind < 1) return null;
  return movementBearing(trackCoordinateAt(track, behind), trackCoordinateAt(track, ahead));
}

function animateBusOnTrack(marker, track, fromProgress, toProgress) {
  const animationId = (marker.busAnimationId ?? 0) + 1;
  marker.busAnimationId = animationId;
  const started = performance.now();
  const duration = BUS_MAP_REFRESH_MS - 500;
  const frame = (now) => {
    const ratio = Math.min(1, (now - started) / duration);
    const coordinate = trackCoordinateAt(
      track, fromProgress + (toProgress - fromProgress) * ratio,
    );
    marker.setLngLat(coordinate);
    if (ratio < 1 && liveBusMarkers.get(marker.busKey) === marker
      && marker.busAnimationId === animationId) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function animateBusMarker(marker, from, to, duration = BUS_MAP_REFRESH_MS - 500) {
  const animationId = (marker.busAnimationId ?? 0) + 1;
  marker.busAnimationId = animationId;
  const started = performance.now();
  const frame = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    marker.setLngLat([
      from[0] + (to[0] - from[0]) * progress,
      from[1] + (to[1] - from[1]) * progress,
    ]);
    if (progress < 1 && liveBusMarkers.get(marker.busKey) === marker
      && marker.busAnimationId === animationId) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function busLineCode(bus) {
  const wanted = lineIdentity(bus.line);
  const candidates = [
    ...(nearbyStop(bus.sourceStopId)?.lines ?? []),
    ...stopLines(bus.sourceStopId),
  ];
  const known = candidates.find((entry) => {
    const line = normaliseLine(entry);
    return lineIdentity(line.line) === wanted || lineIdentity(line.label) === wanted;
  });
  return normaliseLine(known ?? bus.line);
}

/** What you tapped a moving bus to find out.
 *
 * Where it is heading leads, because that is the question. Then when it
 * reaches the stop this estimate belongs to — which is the stop the route was
 * opened from, so it is the one you are standing at — and how far off it is.
 * The vehicle number is an EMT fleet id and means nothing to a passenger; it
 * stays only because it is the one way to tell two buses of a line apart, and
 * it stays at the bottom, muted.
 *
 * No "show route" button: a bus is only ever visible because its route is
 * already drawn, so the button could only have hidden what it offered.
 */
/** A stop's name from whichever source knows it. Probe stops are usually not
 *  saved and often have no detail record, but the route answer names every
 *  stop it calls at, so that is the reliable one here. */
function stopDisplayName(stopId, route) {
  const id = String(stopId);
  const known = details[id]?.name ?? nearbyStop(id)?.name;
  if (known) return known;
  for (const direction of ["toA", "toB"]) {
    const match = (route?.stops?.[direction] ?? []).find((s) => String(s.stopId) === id);
    if (match?.name) return match.name;
  }
  return null;
}

/** Bring a bus and you into the same view.
 *
 * Centring on the bus answers "where is it" but not "how far is it", which is
 * the question you tapped it to ask. Framing both answers both at a glance —
 * the gap on screen *is* the distance.
 *
 * Capped at zoom 16 so a bus at the end of your street does not slam the map
 * into a rooftop view, and it only eases rather than jumps: a tap that teleports
 * the map loses you the context you had.
 */
function frameBusWithUser(busLngLat) {
  if (!leafletMap || !Array.isArray(busLngLat)) return;
  if (!myLocation) {
    leafletMap.easeTo({ center: busLngLat, duration: 450 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds(busLngLat, busLngLat).extend(myLngLat());
  leafletMap.fitBounds(bounds, {
    padding: { top: 70, bottom: 70, left: 55, right: 55 },
    maxZoom: 16,
    duration: 450,
  });
}

function liveBusPopup(bus) {
  const wrap = document.createElement("div");
  const color = lineColor(bus.line);

  const title = document.createElement("h3");
  title.className = "bus-head";
  const label = document.createElement("span");
  label.className = "bus-line";
  label.textContent = String(bus.line);
  label.style.color = color;
  label.style.borderColor = color;
  const towards = document.createElement("span");
  towards.className = "bus-towards";
  towards.textContent = bus.destination ? `→ ${bus.destination}` : "→ destination unknown";
  title.append(label, towards);
  wrap.append(title);

  const ul = document.createElement("ul");
  const seconds = Number(bus.seconds);
  if (Number.isFinite(seconds) && seconds < SCHEDULED_SECONDS) {
    const li = document.createElement("li");
    const where = document.createElement("span");
    where.className = "bus-where";
    where.textContent = bus.sourceStopName || `Stop ${bus.sourceStopId}`;
    const eta = document.createElement("span");
    eta.className = "eta";
    // Counted down from the sample, so it ticks with the rest of the map.
    eta.textContent = fmtCountdown(seconds - Math.floor((Date.now() - bus.fetchedAt) / 1000));
    li.append(where, eta);
    ul.append(li);
  }
  const metres = Number(bus.metres);
  if (Number.isFinite(metres)) {
    const li = document.createElement("li");
    const away = document.createElement("span");
    away.className = "bus-where muted";
    away.textContent = `${formatDistance(metres)} to go`;
    li.append(away);
    ul.append(li);
  }
  if (ul.childElementCount) wrap.append(ul);

  if (bus.vehicleId) {
    const vehicle = document.createElement("p");
    vehicle.className = "bus-vehicle";
    vehicle.textContent = `Vehicle ${bus.vehicleId}`;
    wrap.append(vehicle);
  }
  return wrap;
}

function rebuildLiveBusMarkers() {
  if (!leafletMap || !liveBusLayerReady) return;
  const buses = new Map();
  const collect = (payload) => {
    if (!payload || Date.now() - Number(payload.fetchedAt) > 120_000) return;
    for (const bus of payload.arrivals ?? []) {
      // EMT repeats a vehicle to describe its next run: same id, same fix, a
      // sentinel ETA and a DistanceBus for a trip it has not started. Observed
      // at stop 30, 2026-08-25 — vehicle 2464 as both 349s/407m and
      // 999999s/12567m. Both rows collide on the vehicle id, and placing the
      // wrong one puts a bus 400m away 12km down the road, which is to say it
      // vanishes. Only the row counting down describes where a bus is now.
      if (Number(bus.seconds) >= SCHEDULED_SECONDS) continue;
      const [lon, lat] = bus.coordinates ?? [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const key = bus.vehicleId || `${bus.line}:${lon}:${lat}`;
      const previous = buses.get(key);
      if (!previous || payload.fetchedAt > previous.fetchedAt) {
        buses.set(key, { ...bus, fetchedAt: payload.fetchedAt, sourceStopId: payload.stopId });
      }
    }
  };
  Object.values(arrivals).forEach(collect);
  // Vehicle display is deliberately scoped to routes the user explicitly
  // chose. A map with no directional route has no live-bus workload at all.
  for (const [key, bus] of buses) {
    if (!busShownRoute(bus)) buses.delete(key);
  }
  for (const [key, marker] of liveBusMarkers) {
    if (buses.has(key)) continue;
    marker.remove();
    liveBusMarkers.delete(key);
  }
  for (const [key, bus] of buses) {
    const shown = busShownRoute(bus);
    const track = shown?.snapped ? busRouteTrack(bus) : null;
    const progress = track ? busTrackProgress(bus, track, shown.route) : null;
    const marker = liveBusMarkers.get(key);

    // On the line but not yet on the leg being drawn: placing it anywhere on
    // this path would put it on a street it is not in.
    if (track && progress == null) {
      if (marker) {
        marker.remove();
        liveBusMarkers.delete(key);
      }
      continue;
    }

    // The estimate belongs to the stop the route was opened from, which is the
    // stop the user is standing at — so name it rather than showing its number.
    bus.sourceStopName = stopDisplayName(bus.sourceStopId, shown?.route);
    const coordinate = track ? trackCoordinateAt(track, progress) : bus.coordinates;
    bus.bearing = track
      ? trackBearingAt(track, progress)
      : movementBearing(marker?.busCoordinates ?? bus.coordinates, bus.coordinates);

    if (marker) {
      // A route compiled after the marker was drawn must be allowed to place
      // it, even when EMT has sent nothing new.
      const upgraded = marker.busProgress == null && progress != null;
      if (Number(bus.fetchedAt) <= Number(marker.busFetchedAt) && !upgraded) continue;
      if (track) {
        const from = marker.busProgress ?? progress;
        // A correction this large is EMT re-locking the vehicle, not a bus
        // covering ground. Racing along the path to meet it is precisely the
        // artefact this model exists to remove.
        if (Math.abs(progress - from) > 400) marker.setLngLat(coordinate);
        else animateBusOnTrack(marker, track, from, progress);
      } else {
        const previous = marker.getLngLat();
        // Both ends in [lng, lat] now — the order MapLibre and EMT agree on.
        animateBusMarker(marker, [previous.lng, previous.lat], coordinate);
      }
      marker.liveBus = bus; // so the popup can be re-rendered as it ticks
      marker.busProgress = progress;
      marker.busBearing = bus.bearing ?? marker.busBearing;
      marker.busCoordinates = bus.coordinates;
      marker.busFetchedAt = bus.fetchedAt;
      marker.busSourceStopId = bus.sourceStopId;
      marker.busRouteKey = shown?.key ?? null;
      marker.getElement().replaceChildren(liveBusIcon(bus));
      syncRouteSelectionStyles();
      continue;
    }

    const created = domMarker("", "live-bus-icon", coordinate);
    created.getElement().append(liveBusIcon(bus));
    created.busKey = key;
    created.liveBus = bus;
    created.busProgress = progress;
    created.busBearing = bus.bearing;
    created.busCoordinates = bus.coordinates;
    created.busFetchedAt = bus.fetchedAt;
    created.busSourceStopId = bus.sourceStopId;
    created.busRouteKey = shown?.key ?? null;
    created.getElement().addEventListener("click", (event) => {
      event.stopPropagation();
      showMapPopup(leafletMap, created.getLngLat().toArray(), `bus:${key}`,
        () => liveBusPopup(created.liveBus));
      if (created.busRouteKey) setSelectedRoute(created.busRouteKey);
      frameBusWithUser(created.getLngLat().toArray());
    });
    created.addTo(leafletMap);
    liveBusMarkers.set(key, created);
  }
  syncRouteSelectionStyles();
}

/** Re-render any open popup so its countdown ticks like the list. */

function showView(view) {
  const isMap = view === "map";
  viewListBtn.setAttribute("aria-selected", String(!isMap));
  viewMapBtn.setAttribute("aria-selected", String(isMap));
  // List/Map applies to whichever section is open; the menu decides which.
  if (section === "bikes") {
    showSection("bikes");
    return;
  }
  listEl.hidden = isMap;
  mapEl.hidden = !isMap;
  renderGoForm();
  if (isMap) {
    ensureMap();
    rebuildMarkers();
    rebuildLiveBusMarkers();
    renderNearbyPins();
    renderRouteLegend();
    leafletMap.resize();
  } else {
    renderRouteLegend(); // it lives over the map; the list has no use for it
    render(); // the interval skips list renders while the map is up
  }
  syncMapControls();
}

/* ---- Nearby stops on the map ------------------------------------------ */

function savedIds() {
  return new Set(stops.map((s) => s.stop_id));
}


/** The body both stop popups share.
 *
 * A line with a bus coming gets a row of its own: its chip and its countdown,
 * soonest first. Every other line collapses into one wrapped row of chips.
 *
 * Both halves earn their space. A chip row plus a separate arrivals list named
 * the same lines twice and cost twice the height — but a row each for all
 * thirteen lines at Gran Vía is taller still, and twelve of those rows would
 * say nothing but "—". Rows are for answers; chips are for the rest.
 *
 * Tapping either does the same thing: draw that line's route. The row is the
 * larger target, which is the point — a 22px chip is a poor thing to ask a
 * thumb to hit.
 */
/** Whether a line is inside its service window right now.
 *
 * EMT lists every line a stop serves *today*, which at 10:00 still includes
 * the night buses with their 00:00–05:15 hours. They are not stale and not
 * wrong — they are just not something you can board. Hours it does not know
 * mean "show it": absence of evidence is not a closed line.
 */
function lineRunningNow(line) {
  const from = line.from ? minutesOf(line.from) : null;
  const to = line.to ? minutesOf(line.to) : null;
  if (from == null || to == null) return true;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  // A window whose end is before its start crosses midnight.
  return from <= to ? minutes >= from && minutes <= to : minutes >= from || minutes <= to;
}

function lineRowList(stopId, lines, payload) {
  // Soonest countdown per line, keyed by identity so a board naming "N19"
  // still answers for a stop list carrying 519.
  const due = new Map();
  if (payload) {
    const elapsed = Math.floor((Date.now() - payload.fetchedAt) / 1000);
    for (const bus of payload.arrivals ?? []) {
      if (Number(bus.seconds) >= SCHEDULED_SECONDS) continue;
      const id = lineIdentity(bus.line);
      const seconds = bus.seconds - elapsed;
      if (!due.has(id) || seconds < due.get(id)) due.set(id, seconds);
    }
  }
  const secondsFor = (l) => due.get(lineIdentity(l.label)) ?? due.get(lineIdentity(l.line));

  const entries = [];
  const seen = new Set();
  for (const raw of lines ?? []) {
    const l = normaliseLine(raw);
    const id = lineIdentity(l.line);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    seen.add(lineIdentity(l.label));
    entries.push(l);
  }
  // A board can name a line the stop record never listed.
  for (const bus of payload?.arrivals ?? []) {
    const id = lineIdentity(bus.line);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push(normaliseLine(bus.line));
  }
  if (entries.length === 0) return null;

  const running = entries.filter((l) => secondsFor(l) != null)
    .sort((a, b) => secondsFor(a) - secondsFor(b));
  // A bus on the board beats any timetable; otherwise the window decides.
  const idle = entries.filter((l) => secondsFor(l) == null && lineRunningNow(l));

  const body = document.createElement("div");
  body.className = "pop-lines";
  for (const l of running) {
    const row = lineControl(l, stopId, "pop-line");
    const eta = document.createElement("span");
    eta.className = "eta";
    eta.textContent = fmtCountdown(secondsFor(l));
    row.append(eta);
    body.append(row);
  }
  if (idle.length || running.length === 0) {
    const rest = document.createElement("div");
    rest.className = "pop-idle";
    for (const l of idle) rest.append(lineControl(l, stopId, "pop-chip"));
    // Nothing at all is coming, so one dash covers the whole board.
    if (running.length === 0) {
      const none = document.createElement("span");
      none.className = "eta muted";
      none.textContent = "—";
      rest.append(none);
    }
    body.append(rest);
  }
  return body;
}

/** One tappable line, as a full-width row or as a bare chip. Both draw that
 *  line's route, so they are the same control at two sizes. */
function lineControl(l, stopId, className) {
  const drawn = shownRouteFor(l.line, stopId);
  const control = document.createElement("button");
  control.type = "button";
  control.className = className;
  control.title = drawn ? `Hide route ${l.label}` : `Show route ${l.label}`;
  const chip = document.createElement("span");
  paintLineChip(chip, l, drawn);
  control.append(chip);
  control.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleRoute(l.line, l.label, null, stopId);
  });
  return control;
}


/** A stop popup's first line: its name, and the two things you can do to it. */
function popupHead(title, ...actions) {
  const head = document.createElement("div");
  head.className = "pop-head";
  const heading = document.createElement("h3");
  heading.textContent = title;
  head.append(heading, ...actions.filter(Boolean));
  return head;
}

function stopInfoButton(seed, saved) {
  const stopId = String(saved?.stop_id ?? seed.stopId);
  const info = document.createElement("button");
  info.type = "button";
  info.className = "pop-info";
  info.innerHTML = INFO_ICON;
  info.title = `Open stop ${stopId}`;
  info.setAttribute("aria-label", info.title);
  info.addEventListener("click", (event) => {
    event.stopPropagation();
    // An area-search record knows the name, position and lines that EMT's
    // detail table may not. Seed them, or an unsaved stop opens blank.
    if (seed?.coordinates || seed?.lines) {
      mergeNearbyDetails([seed], { onlySaved: false });
    }
    closeMapPopup();
    // A stop with no row of its own still has everything the sheet reads.
    openStop(saved ?? { stop_id: stopId, label: null, id: null });
  });
  return info;
}

function nearbyPopupHtml(s) {
  const wrap = document.createElement("div");
  const num = document.createElement("p");
  num.className = "stop-num";
  num.textContent = `Nº ${s.stopId}`;
  wrap.append(popupHead(s.name || `Stop ${s.stopId}`, ...stopPopupActions(s)), num);

  // Unsaved stops share the store too; they are simply never persisted.
  const preview = arrivals[s.stopId];
  const failed = boardFailures.has(String(s.stopId));
  if (!preview && !failed) void refreshStop(s.stopId);

  const list = lineRowList(s.stopId, s.lines, preview || null);
  if (list) {
    wrap.append(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "muted pop-empty";
    empty.textContent = failed ? "Could not reach EMT" : "No lines known";
    wrap.append(empty);
  }
  return wrap;
}

const nearbyPins = new Map(); // stopId → circleMarker

/** Add and remove only what changed.
 *
 * Clearing the layer on every pan is what made stops blink out and back: the
 * marker under an open popup was destroyed along with the rest, and every pin
 * that was already correct got rebuilt for nothing.
 */
function renderNearbyPins() {
  if (!leafletMap) return;
  const visible = !mapEl.hidden && shownRoutes.size === 0
    && leafletMap.getZoom() >= NEARBY_MIN_ZOOM;
  const bounds = visible ? paddedBounds(leafletMap, 0.2) : null;
  const saved = savedIds();
  const wanted = new Set();
  if (visible) {
    for (const s of nearbyStops) {
      if (saved.has(s.stopId) || !Array.isArray(s.coordinates)) continue;
      // GeoJSON order is [lon, lat]; Leaflet wants [lat, lon].
      const at = s.coordinates;
      // [lon, lat] already — MapLibre's order. The Leaflet-era flip that used
      // to live here judged every stop out of bounds, so none were ever drawn.
      if (!bounds.contains(at)) continue;
      wanted.add(s.stopId);
      if (nearbyPins.has(s.stopId)) {
        nearbyPins.get(s.stopId).getElement().classList.toggle("tracked", tracking.isTracked("bus", s.stopId));
        continue;
      }
      const pin = stopPin(at, { saved: false, stopId: s.stopId }).addTo(leafletMap);
      pin.getElement().addEventListener("click", (event) => {
        event.stopPropagation();
        showMapPopup(leafletMap, at, `stop:${s.stopId}`, () => nearbyPopupHtml(s));
      });
      nearbyPins.set(s.stopId, pin);
    }
  }
  for (const [stopId, pin] of nearbyPins) {
    if (wanted.has(stopId)) continue;
    pin.remove();
    nearbyPins.delete(stopId);
  }
}

/** Load stops around an explicit point so location can update the bus data
 * even while the bike section (or list view) is on screen. */
async function loadNearbyAt(lat, lon, { force = false } = {}) {
  await loadNearbyCells(cellsAround(lat, lon), { force });
  // A pass over a saved-but-detail-less stop is a free chance to learn it.
  if (mergeNearbyDetails(nearbyStops)) {
    render();
    rebuildMarkers();
  }
  renderNearbyPins();
}

function closestStops() {
  return [...nearbyStops].sort((a, b) =>
    proximity(closestWalking.get(String(a.stopId))?.metres ?? metresFromCurrent(a.coordinates)) -
    proximity(closestWalking.get(String(b.stopId))?.metres ?? metresFromCurrent(b.coordinates))).slice(0, 8);
}

function nearbyStopCard(stop) {
    const card = document.createElement("article");
    card.className = "nearby-stop-card";
    const head = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = stop.name || `Stop ${stop.stopId}`;
    const meta = document.createElement("small");
    const lineLabels = (stop.lines ?? []).map(normaliseLine).map((line) => line.label).filter(Boolean);
    const walk = closestWalking.get(String(stop.stopId));
    meta.textContent = `Nº ${stop.stopId}${walk?.metres != null ? ` · ${distanceLabel(walk.metres)}` : ""}${lineLabels.length ? ` · ${lineLabels.join(" · ")}` : ""}`;
    head.append(name, meta);
    const actions = document.createElement("div");
    const directions = document.createElement("button");
    directions.type = "button";
    directions.innerHTML = WALKING_ICON;
    directions.title = `Directions to stop ${stop.stopId}`;
    directions.setAttribute("aria-label", directions.title);
    directions.addEventListener("click", () => openWalkingDirections(stop.coordinates));
    const saved = stops.find((row) => row.stop_id === String(stop.stopId));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "nearby-stop-favourite";
    save.textContent = saved ? "★" : "☆";
    save.title = saved ? `Remove stop ${stop.stopId} from saved` : `Save stop ${stop.stopId}`;
    save.setAttribute("aria-label", save.title);
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        if (saved) await deleteStop(saved.id);
        else await addStopById(String(stop.stopId), stop.name, stop);
        renderClosestStopsDialog();
      } catch {
        save.disabled = false;
      }
    });
    actions.append(directions, save);
    card.append(head, actions);
    return card;
}

let addStopMap = null;
let addStopMapMarkers = null;

function renderAddStopMap() {
  if (!addDialog.open || !myLocation) return;
  if (!addStopMap) {
    addStopMap = createMap(addStopMapEl, { center: myLngLat(), zoom: 15, controls: true });
    addStopMapMarkers = [];
  }
  for (const marker of addStopMapMarkers) marker.remove();
  addStopMapMarkers = [];
  const you = domMarker("", "dot-pin you", myLngLat());
  you.getElement().title = "You";
  addStopMapMarkers.push(you.addTo(addStopMap));
  const saved = savedIds();
  for (const stop of closestStops()) {
    if (!Array.isArray(stop.coordinates)) continue;
    const pin = domMarker("", `dot-pin${saved.has(String(stop.stopId)) ? " saved" : ""}`,
      stop.coordinates);
    pin.getElement().title = `${stop.stopId} · ${stop.name || "Stop"}`;
    addStopMapMarkers.push(pin.addTo(addStopMap));
  }
  addStopMap.jumpTo({ center: myLngLat(), zoom: 15 });
  requestAnimationFrame(() => addStopMap.resize());
}

function renderClosestStopsDialog() {
  const waiting = !myLocation;
  const closest = waiting ? [] : closestStops();
  const message = waiting ? "Finding your location…" : closest.length ? "" : "No stops within 700 m";
  nearbyStopsMessage.textContent = message;
  addStopMessage.textContent = message;
  nearbyStopsList.replaceChildren(...closest.map(nearbyStopCard));
  addStopNearbyList.replaceChildren(...closest.map(nearbyStopCard));
  renderAddStopMap();
}

async function updateClosestStopsDialog() {
  if ((!nearbyStopsDialog.open && !addDialog.open) || !myLocation) return;
  nearbyStopsMessage.textContent = "Finding nearby stops…";
  addStopMessage.textContent = "Finding nearby stops…";
  await loadNearbyAt(myLocation[0], myLocation[1], { force: true });
  const originKey = `${myLocation[0].toFixed(5)},${myLocation[1].toFixed(5)}`;
  if (closestWalkingOrigin !== originKey) {
    closestWalkingOrigin = originKey;
    closestWalking = new Map();
  }
  renderClosestStopsDialog();
  const candidates = [...nearbyStops]
    .filter((stop) => Array.isArray(stop.coordinates))
    .sort((a, b) => proximity(metresFromCurrent(a.coordinates)) - proximity(metresFromCurrent(b.coordinates)))
    .slice(0, 20);
  if (candidates.length === 0) return;
  try {
    const payload = await api("/walking-distances", {
      method: "POST",
      body: JSON.stringify({
        origin: { lat: myLocation[0], lon: myLocation[1] },
        destinations: candidates.map((stop) => ({
          lat: stop.coordinates[1], lon: stop.coordinates[0],
        })),
      }),
    });
    if (closestWalkingOrigin !== originKey) return;
    closestWalking = new Map(candidates.map((stop, index) =>
      [String(stop.stopId), payload.routes[index]]));
    renderClosestStopsDialog();
  } catch {
    // With no pedestrian route, omit distance rather than relabel air distance.
  }
}

document.getElementById("nearby-stops-open").addEventListener("click", () => {
  nearbyStopsDialog.showModal();
  if (!myLocation) {
    renderClosestStopsDialog();
    refreshLocation({ userInitiated: true, forceNearby: true });
  } else {
    nearbyStopsMessage.textContent = "Loading…";
    nearbyStopsList.replaceChildren();
    void updateClosestStopsDialog();
  }
});
document.getElementById("nearby-stops-close").addEventListener("click", () => nearbyStopsDialog.close());

/** Load stops within 500m of the map centre; one fetch per ~110m cell. */
/** Keep the visible area covered, rather than a disc around the centre.
 *
 * Below NEARBY_MIN_ZOOM nothing is fetched or drawn: the viewport is then
 * several cells across and thousands of dots wide, which is neither useful
 * nor cheap. Saved stops and drawn routes are unaffected.
 */
async function loadNearby() {
  if (!leafletMap || mapEl.hidden) return;
  if (leafletMap.getZoom() < NEARBY_MIN_ZOOM) {
    renderNearbyPins();
    return;
  }
  await loadNearbyCells(viewportCells(paddedBounds(leafletMap, 0.2)));
  if (mergeNearbyDetails(nearbyStops)) {
    render();
    rebuildMarkers();
  }
  renderNearbyPins();
}

viewListBtn.addEventListener("click", () => showView("list"));
viewMapBtn.addEventListener("click", () => showView("map"));

function setBusListMode(mode) {
  busListMode = mode === "stops" ? "stops" : "places";
  document.body.dataset.busListMode = busListMode;
  localStorage.setItem("emt:bus-list-mode", busListMode);
  busModePlaces.setAttribute("aria-selected", String(busListMode === "places"));
  busModeStops.setAttribute("aria-selected", String(busListMode === "stops"));
  const button = document.getElementById("fab");
  const purpose = busListMode === "places" ? "Add hub" : "Add bus stop";
  button.title = purpose;
  button.setAttribute("aria-label", purpose);
  render();
}
busModePlaces.addEventListener("click", () => {
  showSection("buses");
  setBusListMode("places");
});
busModeStops.addEventListener("click", () => {
  showSection("buses");
  setBusListMode("stops");
});
setBusListMode(busListMode);

async function loadStops() {
  if (!authSession) return;
  try {
    stops = await api("/stops");
    writeStops(stops);
  } catch (err) {
    statusEl.textContent = `Showing saved stops: ${err.message}`;
  }
  render();
  refreshAll();
  hydrateNames();
}

async function deleteStop(id) {
  try {
    await api(`/stops/${id}`, { method: "DELETE" });
    stops = stops.filter((s) => s.id !== id);
    writeStops(stops);
    render();
    rebuildMarkers();
    renderNearbyPins(); // the removed stop may now show as nearby
  } catch (err) {
    statusEl.textContent = `Could not remove stop: ${err.message}`;
  }
}


/* ---- Stop sheet: one saved stop, up close ------------------------------ */

const stopDialog = document.getElementById("stop-dialog");
const sheetForm = document.getElementById("stop-form");
const sheetHeading = document.getElementById("sheet-heading");
const sheetMeta = document.getElementById("sheet-meta");
const sheetMapEl = document.getElementById("sheet-map");
const sheetNoMap = document.getElementById("sheet-no-map");
const sheetArrivals = document.getElementById("sheet-arrivals");
const sheetAge = document.getElementById("sheet-age");
const sheetLabel = document.getElementById("sheet-label");
const sheetName = document.getElementById("sheet-name");
const sheetEdit = document.getElementById("sheet-edit");
const sheetRemove = document.getElementById("sheet-remove");
const sheetStar = document.getElementById("sheet-star");
const sheetSave = document.getElementById("sheet-save");
const sheetService = document.getElementById("sheet-service");
const sheetServiceWrap = document.getElementById("sheet-service-wrap");
const sheetDirections = document.getElementById("sheet-directions");

let sheetStop = null;
let sheetMap = null;
let sheetMarker = null;

/** Which of the sheet's controls apply right now.
 *
 * Renaming and removing need a saved row to act on; everything else the sheet
 * shows is public and works for any stop. Saving from in here must not close
 * the sheet — it is the same stop either way, it just gained a name you can
 * edit and a row you can delete.
 */
function syncSheetOwnership() {
  const owned = sheetStop?.id != null;
  sheetRemove.hidden = !owned;
  sheetStar.textContent = owned ? "★" : "☆";
  sheetStar.title = owned ? "Remove from saved stops" : "Save this stop";
  sheetStar.setAttribute("aria-label", sheetStar.title);
  if (sheetStop) {
    sheetHeading.textContent = stopTitle(sheetStop);
    sheetLabel.value = sheetStop.label ?? "";
  }
  // Closing the editor is what reconciles the pencil with ownership, so this
  // is also how a just-saved stop gets its rename control back.
  showNameEditor(false);
}

async function toggleSheetSaved() {
  const stop = sheetStop;
  if (!stop) return;
  sheetStar.disabled = true;
  try {
    if (stop.id != null) {
      await deleteStop(stop.id);
      sheetStop = { stop_id: stop.stop_id, label: null, id: null };
    } else {
      // The nearby record carries the name and position EMT's detail table
      // may be missing for this stop.
      sheetStop = await addStopById(String(stop.stop_id), null,
        nearbyStop(stop.stop_id) ?? null);
    }
    syncSheetOwnership();
  } catch {
    // addStopById and deleteStop already explain themselves in the status bar.
  } finally {
    sheetStar.disabled = false;
  }
}

function openStop(stop) {
  sheetStop = stop;
  sheetHeading.textContent = stopTitle(stop);
  sheetMeta.replaceChildren(stopMetaNode(stop.stop_id));
  sheetLabel.value = stop.label ?? "";
  sheetLabel.placeholder = details[stop.stop_id]?.name || "EMT's name";
  sheetDirections.hidden = !details[stop.stop_id]?.coordinates;
  syncSheetOwnership(); // also closes the name editor and settles the pencil
  stopDialog.showModal();
  renderSheetArrivals();
  renderSheetService();
  showSheetMap();
  // A card's numbers can be a minute old; opening the stop is asking for now.
  refreshStop(stop.stop_id);
}

/** Leaflet measures its container, so the map can only be built once the
 *  dialog is actually laid out. */
function showSheetMap() {
  const coords = details[sheetStop.stop_id]?.coordinates;
  sheetMapEl.hidden = !coords;
  sheetNoMap.hidden = !!coords;
  if (!coords) return;
  // GeoJSON order is what MapLibre wants, so it goes straight through.
  requestAnimationFrame(() => {
    if (!sheetMap) {
      // A 150px map inside a dialog is a picture, not something to navigate.
      sheetMap = createMap(sheetMapEl, { center: coords, zoom: 17, interactive: false });
      sheetMarker = new maplibregl.Marker().setLngLat(coords).addTo(sheetMap);
    } else {
      sheetMarker.setLngLat(coords);
    }
    sheetMap.resize();
    sheetMap.jumpTo({ center: coords, zoom: 17 });
  });
}

function renderSheetArrivals() {
  if (!sheetStop || !stopDialog.open) return;
  const cached = arrivals[sheetStop.stop_id];
  sheetMeta.replaceChildren(stopMetaNode(sheetStop.stop_id));

  if (!cached || cached.arrivals.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = cached
      ? emptyBoardText(sheetStop.stop_id, { fetchMissing: true })
      : "No data yet";
    sheetArrivals.replaceChildren(li);
  } else {
    const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
    const trackingLines = new Set();
    sheetArrivals.replaceChildren(
      ...cached.arrivals.map((bus) => {
        const li = document.createElement("li");
        // A row with no countdown is a later run, not something you are about
        // to catch. It says so in a quieter, shorter row.
        if (Number(bus.seconds) >= SCHEDULED_SECONDS) li.className = "is-scheduled";
        const line = document.createElement("span");
        line.className = "line";
        line.textContent = bus.line;
        line.style.color = lineColor(bus.line);
        const eta = document.createElement("span");
        eta.className = "eta";
        eta.textContent = fmtCountdown(bus.seconds - elapsed);
        li.append(line);
        if (bus.destination) {
          const dest = document.createElement("span");
          dest.className = "dest";
          dest.textContent = bus.destination;
          li.append(dest);
        }
        li.append(eta);
        if (!trackingLines.has(bus.line)) {
          trackingLines.add(bus.line);
          li.append(tracking.button({ kind: "bus", targetId: String(sheetStop.stop_id), line: bus.line,
            label: sheetStop.label || `Stop ${sheetStop.stop_id}`,
            coordinates: details[sheetStop.stop_id]?.coordinates }));
        }
        return li;
      })
    );
  }
  sheetAge.textContent = cached ? `updated ${fmtAge(cached.fetchedAt)}` : "never updated";
}

/** Which lines call here and between what hours — an empty board at 02:00 is
 *  a stop whose lines stop at 23:45, not a stop that is broken. Only stop
 *  detail carries the hours; a stop EMT has no detail record for lists its
 *  lines without them. */
/** Ask the line itself when the stop cannot say.
 *
 * A stop EMT has no detail record for still lists its line codes, and those
 * are exactly what the timetable endpoint is keyed on — so hours borrowed from
 * the line beat "unknown". Answers are cached in the worker for a day and here
 * for the session; a line with no row for today does not run today.
 */
async function fetchLineHours(code) {
  if (lineHours.has(code)) return;
  lineHours.set(code, undefined); // in flight — don't ask twice
  try {
    const { days } = await api(`/lines/${encodeURIComponent(code)}/timetable`);
    lineHours.set(code, days ?? []);
  } catch {
    // Record the miss rather than leaving the row saying "checking…" forever.
    // Closing the sheet forgets it, so reopening retries.
    lineHours.set(code, null);
  }
  render();
  if (stopDialog.open) {
    renderSheetService();
    renderSheetArrivals();
  }
}

function renderSheetService() {
  if (!sheetStop) return;
  const lines = stopLines(sheetStop.stop_id);
  sheetServiceWrap.hidden = lines.length === 0;
  const today = todayDayType();

  sheetService.replaceChildren(
    ...lines.map((l) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "line";
      label.textContent = l.label;
      label.style.color = lineColor(l.label);
      li.append(label);

      const hours = document.createElement("span");
      hours.className = "hours";
      let window = l.from && l.to ? { from: l.from, to: l.to, overnight: false } : null;

      if (!window) {
        const days = lineHours.get(l.line);
        if (days === undefined) {
          hours.textContent = "checking…";
          fetchLineHours(l.line);
        } else if (days === null || days.length === 0) {
          hours.textContent = "hours unknown";
        } else {
          window = days.find((d) => d.dayType === today) ?? null;
          // A line with no row for today's day type is not running today —
          // that is an answer, not a gap.
          if (!window) hours.textContent = "no service today";
        }
      }
      if (window) {
        hours.textContent = `${window.from}–${window.to}`;
        if (window.overnight) hours.textContent += " (+1d)";
      }
      li.append(hours);
      li.append(tracking.button({ kind: "bus", targetId: String(sheetStop.stop_id), line: l.label,
        label: sheetStop.label || `Stop ${sheetStop.stop_id}`,
        coordinates: details[sheetStop.stop_id]?.coordinates }));

      if (l.headers?.length) {
        const route = document.createElement("span");
        route.className = "route";
        route.textContent = l.headers.join(" ↔ ");
        li.append(route);
      }
      return li;
    })
  );
}

/** The name shows as a heading until the pencil is tapped: focusing an input
 *  on open would raise the phone keyboard over everything worth reading. */
/** The name editor, and the pencil that opens it.
 *
 * Both depend on the stop being saved: there is no row to rename otherwise.
 * That check has to live here rather than beside the call, because closing the
 * editor is also what puts the pencil back — `sheetEdit.hidden = editing`
 * cheerfully un-hid it for a stop that had nothing to rename, handing you an
 * editor whose Save could only ever do nothing.
 */
function showNameEditor(editing) {
  const owned = sheetStop?.id != null;
  const open = editing && owned;
  sheetName.hidden = !open;
  sheetSave.hidden = !open;
  sheetEdit.hidden = open || !owned;
  if (open) sheetLabel.focus();
}

sheetEdit.addEventListener("click", () => showNameEditor(true));
sheetStar.addEventListener("click", toggleSheetSaved);

sheetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const stop = sheetStop;
  if (stop?.id == null) return; // nothing to rename until the stop is saved
  const label = sheetLabel.value.trim();
  if (label === (stop.label ?? "")) {
    stopDialog.close();
    return;
  }
  try {
    // An empty name is not a blank title: it hands the stop back to EMT's own.
    const row = await api(`/stops/${encodeURIComponent(stop.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ label: label || null }),
    });
    stops = stops.map((s) => (s.id === row.id ? row : s));
    writeStops(stops);
    render();
    rebuildMarkers();
    stopDialog.close();
  } catch (err) {
    statusEl.textContent = `Could not rename stop: ${err.message}`;
  }
});

// Forget failed lookups on close so the next open asks again; keep the hits.
stopDialog.addEventListener("close", () => {
  for (const [code, days] of lineHours) if (!days) lineHours.delete(code);
});

document.getElementById("sheet-close").addEventListener("click", () => stopDialog.close());
sheetDirections.addEventListener("click", () => {
  openWalkingDirections(details[sheetStop?.stop_id]?.coordinates);
});
document.getElementById("sheet-refresh").addEventListener("click", () =>
  refreshStop(sheetStop.stop_id, { force: true })
);
sheetRemove.addEventListener("click", async () => {
  const id = sheetStop.id;
  if (id == null) return;
  stopDialog.close();
  await deleteStop(id);
});

const fab = document.getElementById("fab");
const addForm = document.getElementById("add-stop");

/** Shared by the dialog form and the map's nearby-pin buttons. */
async function addStopById(stopId, label, seed = null) {
  if (!/^[0-9]+$/.test(stopId)) {
    const err = new Error("Stop numbers are digits only.");
    err.kind = "invalid";
    throw err;
  }
  // Added from a map pin: the area search already told us everything, and it
  // knows stops whose detail record EMT is missing. Don't throw that away.
  if (seed) mergeNearbyDetails([seed], { onlySaved: false });
  statusEl.textContent = `Looking up stop ${stopId}…`;
  let detail;
  try {
    detail = await resolveStop(stopId);
  } catch (err) {
    statusEl.textContent =
      err.kind === "not_found"
        ? `No EMT stop ${stopId} — check the number on the stop sign.`
        : `Could not check stop ${stopId}: ${err.message}`;
    throw err;
  }
  try {
    const row = await api("/stops", {
      method: "POST",
      body: JSON.stringify({ stopId, label: label || detail.name }),
    });
    stops.push(row);
    writeStops(stops);
    statusEl.textContent = "";
    render();
    rebuildMarkers();
    renderNearbyPins(); // its grey pin becomes an accent one
    refreshStop(row.stop_id);
    return row;
  } catch (err) {
    statusEl.textContent = `Could not add stop: ${err.message}`;
    throw err;
  }
}

fab.addEventListener("click", () => {
  statusEl.textContent = "";
  if (busListMode === "places") {
    placesMessage.textContent = "";
    renderPlacesDialog();
    placesDialog.showModal();
    openPlaceEditor();
    return;
  }
  addDialog.showModal();
  renderClosestStopsDialog();
  if (!myLocation) refreshLocation({ userInitiated: true, forceNearby: true });
  else void updateClosestStopsDialog();
});

document.getElementById("add-cancel").addEventListener("click", () => addDialog.close());

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const idInput = document.getElementById("stop-id");
  const labelInput = document.getElementById("stop-label");
  const stopId = idInput.value.trim();
  const userLabel = labelInput.value.trim();
  fab.disabled = true;
  document.getElementById("add-save").disabled = true;
  try {
    await addStopById(stopId, userLabel || null);
    idInput.value = "";
    labelInput.value = "";
    addDialog.close();
  } catch {
    // statusEl already explains; dialog stays open for correcting.
  } finally {
    fab.disabled = false;
    document.getElementById("add-save").disabled = false;
  }
});

document.getElementById("refresh-all").addEventListener("click", async () => {
  if (section !== "bikes") {
    if (!mapEl.hidden && leafletMap) {
      busMapRefreshAt = Date.now();
      const centre = leafletMap.getCenter();
      await Promise.all([
        refreshMapArrivals(),
        loadNearbyAt(centre.lat, centre.lng, { force: true }),
      ]);
      return;
    }
    return busListMode === "places" ? loadJourneys({ force: true }) : refreshAll({ force: true });
  }
  const c = bikeMap?.getCenter();
  if (bikeMap && !bikeMapEl.hidden) void loadBikeCity({ force: true });
  loadBikesNear(c?.lat ?? myLocation?.[0] ?? 40.4168, c?.lng ?? myLocation?.[1] ?? -3.7038, {
    force: true,
  });
});

function tickStopList() {
  const now = Date.now();
  for (const eta of listEl.querySelectorAll(".eta[data-seconds][data-fetched-at]")) {
    const elapsed = Math.floor((now - Number(eta.dataset.fetchedAt)) / 1000);
    const remaining = Number(eta.dataset.seconds) - elapsed;
    eta.textContent = fmtCountdown(remaining);
    if (eta.dataset.walkSeconds) {
      const card = eta.closest(".place-card");
      if (card) setPlaceReachability(card, remaining, eta.dataset.walkSeconds);
    }
  }
  // Keep the "then …" list counting down with everything else.
  for (const later of listEl.querySelectorAll(".route-later[data-seconds]")) {
    const elapsed = Math.floor((Date.now() - Number(later.dataset.fetchedAt)) / 1000);
    const times = later.dataset.seconds.split(",").map(Number)
      .map((seconds) => fmtCountdown(seconds - elapsed));
    later.textContent = ` · then ${times.join(", ")}`;
  }
  for (const age of listEl.querySelectorAll(".age[data-fetched-at]")) {
    age.textContent = `updated ${fmtAge(Number(age.dataset.fetchedAt))}`;
  }
  for (const dot of listEl.querySelectorAll(".freshness-dot[data-fetched-at]")) {
    updateFreshnessDot(dot, dot.dataset.fetchedAt || null);
  }
}

// Update only time-bearing text. Rebuilding every card once a second caused
// needless layout, garbage collection and event-listener churn.
setInterval(() => {
  if (section === "bikes" || mapEl.hidden) live.want([]);
  if (section === "bikes") {
    bikeAgeEl.textContent = bikeAgeText();
    const accountAge = bikeAccountText.querySelector("[data-checked-at]");
    if (accountAge) {
      accountAge.textContent = accountFreshness(accountAge.dataset.checkedAt);
      bikeAccountDot.title = `Checked ${fmtAge(Number(accountAge.dataset.checkedAt))}`;
    }
    return;
  }
  if (mapEl.hidden) tickStopList();
  else if (Date.now() - busMapRefreshAt >= BUS_MAP_REFRESH_MS) {
    busMapRefreshAt = Date.now();
    void refreshMapArrivals();
  }
  tickPopups();
  renderSheetArrivals();
}, 1000);

// Coming back to a backgrounded tab is exactly when the data is most stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    stopLocationRefresh();
    live.want([]);
    return;
  }
  startLocationRefresh();
  void tracking.checkIn();
  if (section === "bikes") {
    const c = bikeMap?.getCenter();
    loadBikesNear(c?.lat ?? myLocation?.[0] ?? 40.4168, c?.lng ?? myLocation?.[1] ?? -3.7038);
    if (bikeMap && !bikeMapEl.hidden) void loadBikeCity();
  } else {
    if (busListMode === "places") loadJourneys();
    else refreshAll();
  }
});

// Scrolling down hands the bottom of the screen to the list; a deliberate
// scroll up, or reaching the top, brings the menu back. Momentum flings
// overshoot the end and bounce back, and the browser bar resizing the viewport
// nudges scrollY, so the position is clamped to the real scroll range, the
// bottom edge never shows the menu, and it takes a sustained scroll up
// (SHOW_AFTER_PX) rather than one frame's jitter.
const HIDE_AFTER_PX = 24;
const SHOW_AFTER_PX = 60;
let scrollAnchor = window.scrollY;
let lastScrollY = window.scrollY;
let scrollFrame = 0;
window.addEventListener("scroll", () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const y = Math.min(Math.max(0, window.scrollY), Math.max(0, max));
    // Direction flipped: measure the new run from where it started.
    if ((y - lastScrollY) * (lastScrollY - scrollAnchor) < 0) scrollAnchor = lastScrollY;
    lastScrollY = y;
    const run = y - scrollAnchor;
    if (y < 40) document.body.classList.remove("nav-hidden");
    else if (y >= max - 4) return;
    else if (run > HIDE_AFTER_PX) document.body.classList.add("nav-hidden");
    else if (run < -SHOW_AFTER_PX) document.body.classList.remove("nav-hidden");
  });
}, { passive: true });

render();

/* ---- BiciMAD ------------------------------------------------------------ */

const bikesEl = document.getElementById("bikes");
const bikeMapEl = document.getElementById("bike-map");
const bikeAgeEl = document.getElementById("bike-age");
const locateBtn = document.getElementById("locate");
const bikeAccountEl = document.getElementById("bike-account");
const bikeAccountDot = document.getElementById("bike-account-dot");
const bikeAccountText = document.getElementById("bike-account-text");
const bikeAccountCheck = document.getElementById("bike-account-check");
const bikeTripsOpen = document.getElementById("bike-trips-open");
const mapActions = document.getElementById("map-actions");
const mapFullscreenBtn = document.getElementById("map-fullscreen");
const nearestRoutesBtn = document.getElementById("map-nearest-routes");

nearestRoutesBtn.addEventListener("click", async () => {
  nearestRoutesBtn.disabled = true;
  try {
    await toggleNearestStopRoutes();
  } finally {
    nearestRoutesBtn.disabled = false;
  }
});

const BIKE_RADIUS = 700;

let section = "buses";
let bikeSaved = [];
let bikeNear = readBikeNear(); // last-known counts, so the list never starts empty
let bikeFetchedAt = bikeNear.fetchedAt ?? null;
let bikeMap = null;
let bikeMarkers = null;
let pendingBikePopupId = null;
let bikePopupControl = null;
let bikePopupStationId = null;
let bikeCell = null;
let bikeSeq = 0;
let bikeUserMarker = null;
// Live counts by station id, from whichever call last saw them: the nearby
// sweep, or the by-ids lookup that keeps saved stations current even when
// they are nowhere near the map.
const bikeById = new Map();
function accountFreshness(checkedAt) {
  if (!checkedAt) return "not checked";
  const age = Date.now() - Number(checkedAt);
  return age < 60_000 ? "<1m" : age < 5 * 60_000 ? "<5m" : ">5m";
}

function showBikeAccount(text, tone = "", checkedAt = null) {
  const label = document.createElement("span");
  label.textContent = text;
  const freshness = document.createElement("small");
  freshness.className = "bike-account-freshness";
  freshness.textContent = accountFreshness(checkedAt);
  if (checkedAt) freshness.dataset.checkedAt = String(checkedAt);
  bikeAccountText.replaceChildren(label, freshness);
  bikeAccountDot.className = `bike-account-dot${tone ? ` ${tone}` : ""}`;
  bikeAccountDot.title = checkedAt ? `Checked ${fmtAge(Number(checkedAt))}` : "Not checked yet";
}

function renderBikeAccountStatus(payload) {
  if (payload?.blocked) {
    showBikeAccount("Blocked", "blocked", payload.checkedAt);
  } else if (!payload?.accountEnabled || !payload?.activeContract) {
    showBikeAccount("Unavailable", "warn", payload?.checkedAt);
  } else {
    showBikeAccount("Account", "ready", payload.checkedAt);
  }
}

function showCachedBikeAccount() {
  const cached = readBikeAccount();
  if (cached) renderBikeAccountStatus(cached);
  else showBikeAccount("Account status not checked");
}

async function loadBikeAccount({ force = false } = {}) {
  if (!force) {
    const cached = readBikeAccount();
    if (cached) {
      renderBikeAccountStatus(cached);
      return;
    }
  }
  bikeAccountCheck.disabled = true;
  showBikeAccount("Checking account…");
  try {
    const payload = await api(`/bikes/account${force ? "?refresh=1" : ""}`);
    writeBikeAccount(payload);
    renderBikeAccountStatus(payload);
  } catch (err) {
    if (err.kind === "auth") {
      showBikeAccount("BiciMAD session expired", "warn");
    } else if (err.kind === "forbidden") {
      showBikeAccount("Account status is owner-only", "warn");
    } else {
      showBikeAccount("Account status unavailable", "warn");
    }
  } finally {
    bikeAccountCheck.disabled = false;
  }
}

bikeAccountCheck.addEventListener("click", () => loadBikeAccount({ force: true }));

const bikeTripsDialog = document.getElementById("bike-trips-dialog");
const bikeTripsForm = document.getElementById("bike-trips-form");
const bikeTripsNumber = document.getElementById("bike-trips-number");
const bikeTripsStatus = document.getElementById("bike-trips-status");
const bikeTripsResults = document.getElementById("bike-trips-results");
const bikeTripsChronological = document.getElementById("bike-trips-chronological");
const bikeTripsGrouped = document.getElementById("bike-trips-grouped");
const bikeTripsRefresh = document.getElementById("bike-trips-refresh");
const bikeTripsSearch = document.getElementById("bike-trips-search");
let loadedBikeTrips = [];
let allBikeTrips = null;
let bikeTripPages = 0;
let bikeTripFieldsSeen = [];
let bikeRatingsLoaded = false;
let bikeTripsSynced = false;
let bikeTripsSync = null;
let bikeTripsCachedAt = null;
let groupBikeTrips = false;
let bikeTripDiagnostics = {};
let bikeTripDiagnosticsLoaded = false;
const bikeRatings = new Map();

function resetBikePrivateState() {
  loadedBikeTrips = [];
  allBikeTrips = null;
  bikeTripPages = 0;
  bikeTripFieldsSeen = [];
  bikeRatingsLoaded = false;
  bikeTripsSynced = false;
  bikeTripsSync = null;
  bikeTripsCachedAt = null;
  bikeTripDiagnostics = {};
  bikeTripDiagnosticsLoaded = false;
  bikeRatings.clear();
}

function euro(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(numeric)
    : null;
}

function tripDate(value, { timeOnly = false } = {}) {
  if (value == null || value === "") return null;
  let date;
  if (typeof value === "number") {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  } else {
    const text = String(value).trim();
    const local = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const timezoneLessIso = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text);
    date = local
      ? new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1]),
        Number(local[4]), Number(local[5]), Number(local[6] || 0))
      : new Date(timezoneLessIso ? `${text}Z` : text);
  }
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, timeOnly ? {
    hour: "2-digit",
    minute: "2-digit",
  } : {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderTripRow(trip) {
  const shownBikeNumber = trip.bikeNumber == null
    ? null
    : String(trip.bikeNumber).replace(/^0+(?=\d)/, "");
  const row = document.createElement("div");
  row.className = "trip-row";
  const started = tripDate(trip.startedAt);
  const ended = tripDate(trip.endedAt, { timeOnly: true });
  if (started || ended) {
    const dates = document.createElement("span");
    dates.className = "trip-dates";
    dates.textContent = `${started ?? "Start unavailable"} → ${ended ?? "End unavailable"}`;
    row.append(dates);
  }
  const timing = document.createElement("span");
  timing.textContent = [trip.interval, trip.minutes == null ? null : `${trip.minutes} min`]
    .filter(Boolean).join(" · ") || "Time unavailable";
  const money = document.createElement("span");
  money.textContent = euro(trip.cost) ?? "Cost unavailable";
  row.append(timing, money);
  if (Number(trip.penaltyCount) || Number(trip.penaltyAmount)) {
    const penalty = document.createElement("span");
    penalty.className = "warn";
    penalty.textContent = `Penalty: ${trip.penaltyCount || 0} · ${euro(trip.penaltyAmount) ?? trip.penaltyAmount ?? 0}`;
    row.append(penalty);
  }
  if (trip.lockFailed || trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed) {
    const incident = document.createElement("span");
    incident.className = "warn";
    incident.textContent = trip.lockFailed ? "Lock failed" : "Dock event recorded";
    row.append(incident);
  }
  return row;
}

function hasTripIssue(trip) {
  return Boolean(Number(trip.penaltyCount) || Number(trip.penaltyAmount) ||
    trip.lockFailed || trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed);
}

function diagnosticValue(field, value) {
  if (value == null || value === "") return "—";
  if ([
    "cost", "previousBalance", "resultingBalance", "dockBonus", "undockBonus",
    "reservationBonus", "penaltyAmount", "extraAmount",
  ].includes(field)) {
    return euro(value) ?? String(value);
  }
  if (["startedAt", "endedAt", "extraDate"].includes(field)) return tripDate(value) ?? String(value);
  if (field === "minutes") return `${value} min`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function renderTripDiagnostics(trip) {
  const entry = bikeTripDiagnostics[tripIdentity(trip)];
  if (!entry?.revisions?.length) return null;
  const history = document.createElement("details");
  history.className = "trip-history";
  const summary = document.createElement("summary");
  summary.textContent = `Updated by EMT · ${entry.revisions.length}`;
  const list = document.createElement("div");
  for (const revision of [...entry.revisions].reverse()) {
    const item = document.createElement("div");
    item.className = "trip-history-revision";
    const observed = new Date(revision.observedAt);
    const time = document.createElement("time");
    time.dateTime = observed.toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    }).format(observed);
    const changes = document.createElement("span");
    changes.textContent = revision.changes.map((change) =>
      `${TRIP_DIAGNOSTIC_LABELS[change.field] ?? change.field}: `
      + `${diagnosticValue(change.field, change.from)} → ${diagnosticValue(change.field, change.to)}`)
      .join(" · ");
    item.append(time, changes);
    list.append(item);
  }
  history.append(summary, list);
  return history;
}

function ratingControl(bikeNumber) {
  const control = document.createElement("div");
  control.className = "bike-rating";
  control.setAttribute("role", "group");
  control.setAttribute("aria-label", `Rate bike ${bikeNumber}`);
  const current = bikeRatings.get(bikeNumber) || 0;
  for (let rating = 1; rating <= 5; rating += 1) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = rating <= current ? "rated" : "";
    star.textContent = rating <= current ? "★" : "☆";
    star.title = `${rating} star${rating === 1 ? "" : "s"}`;
    star.setAttribute("aria-label", `Rate bike ${bikeNumber} ${star.title}`);
    star.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      [...control.children].forEach((button, index) => {
        button.textContent = index < rating ? "★" : "☆";
        button.classList.toggle("rated", index < rating);
      });
      try {
        await api(`/bikes/ratings/${encodeURIComponent(bikeNumber)}`, {
          method: "PUT",
          body: JSON.stringify({ rating }),
        });
        bikeRatings.set(bikeNumber, rating);
        bikeTripsStatus.textContent = `Bike ${bikeNumber} rated ${rating}/5`;
      } catch (err) {
        bikeTripsStatus.textContent = `Could not save rating: ${err.message}`;
        renderBikeTrips();
      }
    });
    control.append(star);
  }
  return control;
}

function copyBikeButton(bikeNumber) {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-bike";
  copy.textContent = "⧉";
  copy.title = `Copy bike ${bikeNumber}`;
  copy.setAttribute("aria-label", copy.title);
  copy.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(bikeNumber);
      bikeTripsStatus.textContent = `Copied bike ${bikeNumber}`;
    } catch {
      bikeTripsStatus.textContent = `Bike number: ${bikeNumber}`;
    }
  });
  return copy;
}

function renderBikeTripGroup(bikeNumber, trips) {
  const group = document.createElement("details");
  group.className = `trip-group${trips.length > 1 || trips.some((trip) =>
    hasTripIssue(trip) || bikeTripDiagnostics[tripIdentity(trip)]) ? " noteworthy" : ""}`;
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = `Bike ${bikeNumber}`;
  const total = trips.reduce((sum, trip) => {
    const cost = Number(trip.cost);
    return sum + (Number.isFinite(cost) ? cost : 0);
  }, 0);
  const meta = document.createElement("small");
  meta.textContent = `${trips.length} trip${trips.length === 1 ? "" : "s"} · ${euro(total)}`;
  heading.append(name, meta);
  summary.append(heading, copyBikeButton(bikeNumber));
  const rows = document.createElement("div");
  rows.className = "trip-rows";
  const tripRows = trips.flatMap((trip) => [renderTripRow(trip), renderTripDiagnostics(trip)].filter(Boolean));
  rows.replaceChildren(ratingControl(bikeNumber), ...tripRows);
  group.append(summary, rows);
  return group;
}

function renderChronologicalTrip(trip, counts) {
  const bikeNumber = String(trip.bikeNumber ?? "unknown").replace(/^0+(?=\d)/, "");
  const card = document.createElement("article");
  const diagnostic = renderTripDiagnostics(trip);
  card.className = `trip-card${counts.get(bikeNumber) > 1 || hasTripIssue(trip) || diagnostic ? " noteworthy" : ""}`;
  const head = document.createElement("div");
  head.className = "trip-card-head";
  const title = document.createElement("strong");
  title.textContent = `Bike ${bikeNumber}`;
  const badges = document.createElement("span");
  badges.className = "trip-badges";
  const badge = (text) => {
    const item = document.createElement("span");
    item.textContent = text;
    badges.append(item);
  };
  if (counts.get(bikeNumber) > 1) badge(`${counts.get(bikeNumber)} rides`);
  if (Number(trip.penaltyCount) || Number(trip.penaltyAmount)) badge("Penalty");
  if (trip.lockFailed) badge("Lock failed");
  else if (trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed) badge("Dock event");
  if (diagnostic) badge("Updated by EMT");
  head.append(title, badges, copyBikeButton(bikeNumber));
  card.append(head, renderTripRow(trip));
  if (diagnostic) card.append(diagnostic);
  card.append(ratingControl(bikeNumber));
  return card;
}

function renderBikeTrips() {
  const counts = new Map();
  for (const trip of loadedBikeTrips) {
    const number = String(trip.bikeNumber ?? "unknown").replace(/^0+(?=\d)/, "");
    counts.set(number, (counts.get(number) || 0) + 1);
  }
  if (!groupBikeTrips) {
    bikeTripsResults.replaceChildren(...loadedBikeTrips.map((trip) => renderChronologicalTrip(trip, counts)));
    return;
  }
  const grouped = new Map();
  for (const trip of loadedBikeTrips) {
    const number = String(trip.bikeNumber ?? "unknown").replace(/^0+(?=\d)/, "");
    if (!grouped.has(number)) grouped.set(number, []);
    grouped.get(number).push(trip);
  }
  bikeTripsResults.replaceChildren(...[...grouped].map(([number, trips]) => renderBikeTripGroup(number, trips)));
}

async function loadBikeRatings() {
  if (bikeRatingsLoaded) return;
  const rows = await api("/bikes/ratings");
  bikeRatings.clear();
  for (const row of rows) bikeRatings.set(String(row.bike_number).replace(/^0+(?=\d)/, ""), row.rating);
  bikeRatingsLoaded = true;
  if (loadedBikeTrips.length) renderBikeTrips();
}

function restoreBikeTrips() {
  if (allBikeTrips) return true;
  const cached = readBikeTrips();
  if (!cached || !Array.isArray(cached.trips)) return false;
  allBikeTrips = cached.trips;
  bikeTripPages = Number(cached.pages) || 0;
  bikeTripFieldsSeen = Array.isArray(cached.fields) ? cached.fields : [];
  bikeTripsCachedAt = Number(cached.syncedAt) || null;
  bikeTripDiagnostics = updateTripDiagnostics(
    [],
    [],
    cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {},
  );
  return true;
}

function filterAndRenderBikeTrips(status = null) {
  const bike = bikeTripsNumber.value.trim();
  if (bike && !/^\d+$/.test(bike)) {
    bikeTripsStatus.textContent = "Enter the number painted on the bike.";
    return false;
  }
  loadedBikeTrips = bike
    ? (allBikeTrips ?? []).filter((trip) => String(trip.bikeNumber) === bike.replace(/^0+(?=\d)/, ""))
    : (allBikeTrips ?? []);
  renderBikeTrips();
  const uniqueBikes = new Set(loadedBikeTrips.map((trip) => trip.bikeNumber)).size;
  if (status) {
    bikeTripsStatus.textContent = status;
  } else if (loadedBikeTrips.length) {
    const cached = bikeTripsCachedAt ? ` · synced ${fmtAge(bikeTripsCachedAt)}` : "";
    bikeTripsStatus.textContent = `${loadedBikeTrips.length} trips · ${uniqueBikes} bikes${cached}`;
  } else {
    bikeTripsStatus.textContent = bike ? `No rides for bike ${bike}` : "No rides cached";
  }
  return true;
}

/** EMTPay exposes page only—there is no observed since/date parameter. Fetch
 * newest-first pages until one overlaps our persistent history, then merge.
 * With no cache this naturally walks the complete history once. */
async function syncBikeTrips({ force = false } = {}) {
  if (bikeTripsSync) return bikeTripsSync;
  if (!force && bikeTripsSynced) return;
  const operation = (async () => {
    restoreBikeTrips();
    if (!bikeTripDiagnosticsLoaded) {
      try {
        const monitored = await api("/bikes/trip-diagnostics");
        bikeTripDiagnostics = mergeTripDiagnostics(bikeTripDiagnostics, monitored.diagnostics);
        bikeTripDiagnosticsLoaded = true;
      } catch {
        // Local comparison remains a complete fallback if monitoring is
        // temporarily unavailable; trip loading itself should still work.
      }
    }
    const existing = allBikeTrips ?? [];
    const known = new Set(existing.map(tripIdentity));
    const fetched = [];
    const fields = new Set();
    const pageSignatures = new Set();
    const oldestFirst = tripsAreOldestFirst(existing);
    const startPage = oldestFirst ? Math.max(0, bikeTripPages - 1) : 0;
    let fetchedPages = 0;
    let maxPageSeen = startPage - 1;
    let overlap = false;
    const maxPages = 50;
    for (let page = startPage; fetchedPages < maxPages; page += 1) {
      bikeTripsStatus.textContent = known.size
        ? `Checking for new trips · page ${page + 1}…`
        : `Loading history · page ${page + 1}…`;
      const query = new URLSearchParams({ page: String(page) });
      const payload = await api(`/bikes/trips?${query}`);
      fetchedPages += 1;
      maxPageSeen = page;
      const signature = payload.matchedOnPage
        .map(tripIdentity)
        .join("|");
      if (signature && pageSignatures.has(signature)) break;
      pageSignatures.add(signature);
      fetched.push(...payload.matchedOnPage);
      for (const field of payload.fields) fields.add(field);
      overlap = known.size > 0 && payload.matchedOnPage.some((trip) => known.has(tripIdentity(trip)));
      if (overlap && !oldestFirst) break;
      if (payload.countOnPage < 30) break;
    }

    const newCount = new Set(
      fetched.filter((trip) => !known.has(tripIdentity(trip))).map(tripIdentity),
    ).size;
    bikeTripDiagnostics = updateTripDiagnostics(existing, fetched, bikeTripDiagnostics);
    allBikeTrips = mergeTripHistory(existing, fetched, oldestFirst);
    bikeTripPages = Math.max(bikeTripPages, maxPageSeen + 1);
    bikeTripFieldsSeen = [...new Set([...bikeTripFieldsSeen, ...fields])].sort();
    bikeTripsCachedAt = Date.now();
    bikeTripsSynced = true;
    writeBikeTrips({
      trips: allBikeTrips,
      pages: bikeTripPages,
      fields: bikeTripFieldsSeen,
      diagnostics: bikeTripDiagnostics,
      syncedAt: bikeTripsCachedAt,
    });
    const suffix = newCount ? `${newCount} new trip${newCount === 1 ? "" : "s"}` : "No new trips";
    filterAndRenderBikeTrips(`${allBikeTrips.length} trips cached · ${suffix}`);
  })();
  bikeTripsSync = operation;
  try {
    await operation;
  } catch (err) {
    bikeTripsStatus.textContent = `Showing cached trips · ${err.message}`;
  } finally {
    if (bikeTripsSync === operation) bikeTripsSync = null;
  }
}

async function loadBikeTrips() {
  if (!filterAndRenderBikeTrips()) return;
  if (!restoreBikeTrips()) {
    bikeTripsStatus.textContent = "Loading history…";
    bikeTripsResults.replaceChildren();
  } else {
    filterAndRenderBikeTrips();
  }
  await syncBikeTrips();
}

bikeTripsOpen.addEventListener("click", () => {
  bikeTripsDialog.showModal();
  void loadBikeRatings().catch((err) => {
    bikeTripsStatus.textContent = `Ratings unavailable: ${err.message}`;
  });
  bikeTripsStatus.textContent = "";
  void loadBikeTrips();
});
bikeTripsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadBikeTrips();
});
function setBikeSearchOpen(open) {
  bikeTripsNumber.hidden = !open;
  bikeTripsSearch.setAttribute("aria-expanded", String(open));
  bikeTripsSearch.title = open ? "Search this bike" : "Open bike search";
  bikeTripsSearch.setAttribute("aria-label", bikeTripsSearch.title);
  if (open) requestAnimationFrame(() => bikeTripsNumber.focus());
}

bikeTripsSearch.addEventListener("click", () => {
  if (bikeTripsNumber.hidden) setBikeSearchOpen(true);
  else void loadBikeTrips();
});
document.getElementById("bike-trips-close").addEventListener("click", () => {
  bikeTripsDialog.close();
  bikeTripsNumber.value = "";
  setBikeSearchOpen(false);
});
bikeTripsRefresh.addEventListener("click", () => void syncBikeTrips({ force: true }));
bikeTripsChronological.addEventListener("click", () => {
  groupBikeTrips = false;
  bikeTripsChronological.setAttribute("aria-pressed", "true");
  bikeTripsGrouped.setAttribute("aria-pressed", "false");
  renderBikeTrips();
});
bikeTripsGrouped.addEventListener("click", () => {
  groupBikeTrips = true;
  bikeTripsChronological.setAttribute("aria-pressed", "false");
  bikeTripsGrouped.setAttribute("aria-pressed", "true");
  renderBikeTrips();
});

function availabilityClass(value, enabled = true) {
  if (!enabled || value == null) return "unavailable";
  if (value === 0) return "empty";
  if (value <= 2) return "low";
  return "good";
}

function distanceToStation(station) {
  if (station.metres != null) return station.metres;
  return metresFromCurrent(station.coordinates);
}

function distanceText(station) {
  return distanceLabel(distanceToStation(station));
}

function bikeTitle(station, saved) {
  return saved?.label || station?.name || `Station ${station?.number ?? ""}`;
}

/** Rentable bikes as a share of the station's physical capacity. Disabled
 * bikes are separate in GBFS and therefore never included in `bikes`. */
function bikeCounts(station) {
  const wrap = document.createElement("div");
  wrap.className = "bike-counts";

  const metric = document.createElement("div");
  metric.className = `bike-metric ${availabilityClass(station.bikes,
    station.inService && station.renting !== false)}`;
  const description = document.createElement("span");
  description.textContent = "🚲 Available";
  const count = document.createElement("strong");
  count.textContent = `${station.bikes ?? "—"}/${station.totalBases || "—"}`;
  count.title = "Rentable bikes / total station capacity";
  metric.append(description, count);
  wrap.append(metric);

  // What the operator's feed knows and the old one did not: a station can be
  // in service but refusing one direction, and docked bikes are not the same
  // thing as rentable ones.
  const trouble =
    !station.inService
      ? "out of service"
      : station.renting === false
          ? "not renting"
          : null;
  if (trouble) {
    const out = document.createElement("span");
    out.className = "bike-note warn";
    out.textContent = trouble;
    wrap.append(out);
  }
  if (station.broken > 0) {
    const broken = document.createElement("span");
    broken.className = "bike-note muted";
    broken.textContent = `🔧 ${station.broken} broken`;
    broken.title = `${station.broken} broken bike${station.broken === 1 ? "" : "s"}`;
    broken.setAttribute("aria-label", broken.title);
    wrap.append(broken);
  }
  return wrap;
}

function bikeCard(station, saved) {
  const card = document.createElement("article");
  card.className = "stop bike";
  const known = station.bikes != null;
  card.classList.toggle("station-unavailable",
    known && (!station.inService || station.renting === false));
  card.addEventListener("click", () => openBikeStation(station));

  const titleWrap = document.createElement("div");
  titleWrap.className = "title";
  const h2 = document.createElement("h2");
  h2.textContent = bikeTitle(station, saved);
  titleWrap.append(h2);

  const distance = document.createElement("span");
  distance.className = "bike-card-distance";
  distance.textContent = distanceText(station) ?? "";
  distance.hidden = !distance.textContent;

  const fav = document.createElement("button");
  fav.className = "bike-favourite";
  fav.textContent = saved ? "★" : "☆";
  fav.title = saved ? "Remove from saved" : "Save this station";
  fav.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleBikeSaved(station, saved);
  });

  const directions = document.createElement("button");
  directions.className = "bike-directions";
  directions.textContent = "➤";
  directions.title = `Walking directions to ${bikeTitle(station, saved)}`;
  directions.setAttribute("aria-label", directions.title);
  directions.disabled = !station.coordinates;
  directions.addEventListener("click", (event) => {
    event.stopPropagation();
    openWalkingDirections(station.coordinates);
  });

  const controls = document.createElement("div");
  controls.className = "controls";
  // The bell shows the tracked state itself, so the title carries no indicator.
  controls.append(directions, tracking.button({
    kind: "bike", targetId: String(station.id), label: bikeTitle(station, saved),
    coordinates: station.coordinates,
  }), fav);

  const head = document.createElement("div");
  head.className = "head bike-head";
  head.append(titleWrap, distance, controls);

  if (known) {
    card.append(head, bikeCounts(station));
  } else {
    // Saved but not yet looked up: "0 bikes" would be a lie, "unknown" is not.
    const pending = document.createElement("p");
    pending.className = "muted";
    pending.textContent = "Counts not loaded yet";
    card.append(head, pending);
  }
  return card;
}

function renderBikes() {
  if (section !== "bikes") return;
  for (const s of bikeNear.stations ?? []) bikeById.set(s.id, s);
  for (const s of bikeNear.savedStations ?? []) {
    bikeById.set(s.id, { ...bikeById.get(s.id), ...s });
  }
  const savedIdSet = new Set(bikeSaved.map((s) => s.station_id));

  const blocks = [];
  if (bikeSaved.length) {
    blocks.push(sectionHeading("Saved"));
    const orderedSaved = [...bikeSaved].sort((a, b) =>
      proximity(distanceToStation(bikeById.get(a.station_id) ?? {})) -
      proximity(distanceToStation(bikeById.get(b.station_id) ?? {})));
    for (const row of orderedSaved) {
      const station = bikeById.get(row.station_id) ?? {
        id: row.station_id,
        number: row.station_id,
        bikes: null,
        inService: true,
      };
      blocks.push(bikeCard(station, row));
    }
  }

  const nearby = (bikeNear.stations ?? [])
    .filter((s) => !savedIdSet.has(s.id))
    .sort((a, b) => proximity(distanceToStation(a)) - proximity(distanceToStation(b)));
  blocks.push(sectionHeading(myLocation ? "Nearest to you" : "Around the map"));
  if (nearby.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No stations nearby";
    blocks.push(empty);
  }
  for (const station of nearby.slice(0, 15)) blocks.push(bikeCard(station, null));

  bikesEl.replaceChildren(...blocks);
  bikeAgeEl.textContent = bikeAgeText();
  bikeAgeEl.hidden = section !== "bikes";
}

/** Counts carry their age, and say when they are the rougher kind. */
function bikeAgeText() {
  if (!bikeFetchedAt) return "never updated";
  const age = `updated ${fmtAge(bikeFetchedAt)}`;
  return bikeNear.source === "mobilitylabs"
    ? `${age} · counts include broken bikes (operator feed unreachable)`
    : age;
}

function sectionHeading(text) {
  const h = document.createElement("h3");
  h.className = "section-heading";
  h.textContent = text;
  return h;
}

async function loadBikesNear(lat, lon, { force = false } = {}) {
  const cell = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!force && cell === bikeCell && Date.now() - (bikeFetchedAt ?? 0) < 45_000) return;
  const seq = ++bikeSeq;
  try {
    const query = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(BIKE_RADIUS) });
    if (bikeSaved.length) query.set("ids", bikeSaved.map((row) => row.station_id).join(","));
    const payload = await api(`/bikes/nearby?${query}`);
    if (seq !== bikeSeq) return;
    bikeNear = payload;
    for (const st of payload.stations ?? []) bikeById.set(st.id, st);
    for (const st of payload.savedStations ?? []) {
      bikeById.set(st.id, { ...bikeById.get(st.id), ...st });
    }
    bikeFetchedAt = payload.fetchedAt;
    bikeCell = cell;
    writeBikeNear(payload);
    renderBikes();
    if (section === "buses" && places.length) render();
    rebuildBikeMarkers();
  } catch (err) {
    statusEl.textContent = `Could not load bike stations: ${err.message}`;
  }
}

async function loadBikeSaved() {
  if (!authSession) {
    bikeSaved = [];
    renderBikes();
    return;
  }
  try {
    bikeSaved = await api("/bikes/saved");
    writeBikeSaved(bikeSaved);
  } catch (err) {
    // The favourites table is optional: bikes work without it. Say so once
    // rather than breaking the whole section.
    statusEl.textContent =
      "Saved stations unavailable";
  }
  renderBikes();
  if (section === "bikes" && bikeSaved.some((row) => !bikeById.has(row.station_id))) {
    const centre = bikeMap?.getCenter() ?? {
      lat: myLocation?.[0] ?? 40.4168,
      lng: myLocation?.[1] ?? -3.7038,
    };
    void loadBikesNear(centre.lat, centre.lng, { force: true });
  }
}

async function toggleBikeSaved(station, saved) {
  if (!authSession) {
    authDialog.showModal();
    return;
  }
  try {
    if (saved) {
      await api(`/bikes/saved/${encodeURIComponent(saved.id)}`, { method: "DELETE" });
      bikeSaved = bikeSaved.filter((s) => s.id !== saved.id);
    } else {
      const row = await api("/bikes/saved", {
        method: "POST",
        body: JSON.stringify({ stationId: station.id, label: station.name }),
      });
      bikeSaved.push(row);
    }
    writeBikeSaved(bikeSaved);
    statusEl.textContent = "";
    renderBikes();
    render();
    rebuildBikeMarkers();
  } catch (err) {
    statusEl.textContent = `Could not save station: ${err.message}`;
  }
}

/* ---- Bike station sheet ------------------------------------------------ */

const bikeDialog = document.getElementById("bike-dialog");
const bikeForm = document.getElementById("bike-form");
const bikeSheetHeading = document.getElementById("bike-sheet-heading");
const bikeSheetMeta = document.getElementById("bike-sheet-meta");
const bikeSheetCounts = document.getElementById("bike-sheet-counts");
const bikeSheetName = document.getElementById("bike-sheet-name");
const bikeSheetLabel = document.getElementById("bike-sheet-label");
const bikeSheetEdit = document.getElementById("bike-sheet-edit");
const bikeSheetSave = document.getElementById("bike-sheet-save");
const bikeSheetRemove = document.getElementById("bike-sheet-remove");
const bikeSheetFavourite = document.getElementById("bike-sheet-favourite");
const bikeSheetMapEl = document.getElementById("bike-sheet-map");
const bikeSheetDirections = document.getElementById("bike-sheet-directions");

let bikeSheetStation = null;
let bikeSheetMap = null;
let bikeSheetMarker = null;

function currentBikeSheetStation() {
  return bikeById.get(bikeSheetStation?.id) || bikeSheetStation;
}

function bikeSavedRow(station) {
  return bikeSaved.find((row) => row.station_id === station?.id) ?? null;
}

function showBikeNameEditor(editing) {
  bikeSheetName.hidden = !editing;
  bikeSheetSave.hidden = !editing;
  bikeSheetEdit.hidden = editing;
  if (editing) bikeSheetLabel.focus();
}

function showBikeSheetMap(station) {
  bikeSheetMapEl.hidden = !station.coordinates;
  if (!station.coordinates) return;
  const at = station.coordinates;
  requestAnimationFrame(() => {
    if (!bikeSheetMap) {
      bikeSheetMap = createMap(bikeSheetMapEl, { center: at, zoom: 17, interactive: false });
      bikeSheetMarker = new maplibregl.Marker().setLngLat(at).addTo(bikeSheetMap);
    } else {
      bikeSheetMarker.setLngLat(at);
    }
    bikeSheetMap.resize();
    bikeSheetMap.jumpTo({ center: at, zoom: 17 });
  });
}

function renderBikeSheet() {
  const station = currentBikeSheetStation();
  if (!station) return;
  const saved = bikeSavedRow(station);
  bikeSheetStation = station;
  bikeSheetHeading.textContent = bikeTitle(station, saved);
  bikeSheetMeta.textContent = station.address
    ? `Nº ${station.number} · ${station.address}`
    : `Nº ${station.number}`;
  bikeSheetCounts.replaceChildren(bikeCounts(station));
  document.getElementById("bike-sheet-tracking").replaceChildren(tracking.button({
    kind: "bike", targetId: String(station.id), label: bikeTitle(station, saved),
    coordinates: station.coordinates,
  }));

  bikeSheetLabel.value = saved?.label ?? "";
  bikeSheetLabel.placeholder = station.name || "BiciMAD station";
  bikeSheetRemove.hidden = !saved;
  bikeSheetFavourite.hidden = !!saved;
  bikeSheetDirections.hidden = !station.coordinates;
  showBikeNameEditor(false);
  showBikeSheetMap(station);
}

function openBikeStation(station) {
  bikeSheetStation = station;
  bikeDialog.showModal();
  renderBikeSheet();
}

bikeSheetEdit.addEventListener("click", () => showBikeNameEditor(true));
document.getElementById("bike-sheet-close").addEventListener("click", () => bikeDialog.close());
bikeSheetDirections.addEventListener("click", () => {
  openWalkingDirections(currentBikeSheetStation()?.coordinates);
});

bikeSheetFavourite.addEventListener("click", async () => {
  await toggleBikeSaved(currentBikeSheetStation(), null);
  renderBikeSheet();
});

bikeSheetRemove.addEventListener("click", async () => {
  const station = currentBikeSheetStation();
  const saved = bikeSavedRow(station);
  if (!saved) return;
  await toggleBikeSaved(station, saved);
  bikeDialog.close();
});

bikeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const station = currentBikeSheetStation();
  const saved = bikeSavedRow(station);
  const label = bikeSheetLabel.value.trim();
  try {
    if (saved) {
      const row = await api(`/bikes/saved/${encodeURIComponent(saved.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ label: label || null }),
      });
      bikeSaved = bikeSaved.map((item) => item.id === row.id ? row : item);
    } else {
      const row = await api("/bikes/saved", {
        method: "POST",
        body: JSON.stringify({ stationId: station.id, label: label || station.name }),
      });
      bikeSaved.push(row);
    }
    writeBikeSaved(bikeSaved);
    renderBikes();
    rebuildBikeMarkers();
    bikeDialog.close();
  } catch (err) {
    statusEl.textContent = `Could not rename station: ${err.message}`;
  }
});

document.getElementById("bike-sheet-show-map").addEventListener("click", () => {
  const station = currentBikeSheetStation();
  if (!station?.coordinates) return;
  bikeDialog.close();
  showView("map");
  showSection("bikes");
  requestAnimationFrame(() => {
    bikeMap?.jumpTo({ center: station.coordinates, zoom: 18 });
  });
});

/* ---- Bike map ----------------------------------------------------------- */

function ensureBikeMap() {
  if (bikeMap) return;
  bikeMap = createMap(bikeMapEl, { center: myLngLat(), zoom: 15 });
  // MapLibre has no layer group; the markers are tracked here instead.
  bikeMarkers = new Map();
  if (myLocation) bikeUserMarker = addUserMarker(bikeMap, myLocation);
  // The map draws from the whole city, not a fixed radius around its centre:
  // panning only redraws what is already loaded, and zooming out shows every
  // station in view instead of the same handful.
  bikeMap.on("moveend", () => {
    rebuildBikeMarkers();
    void loadBikeCity();
  });
  rebuildBikeMarkers();
  void loadBikeCity();
}

/** Every station, for the map. One call serves the city: the worker already
 *  fetches it whole, and it is ~34KB compressed. Same 45 s freshness as the
 *  nearby list. */
const BIKE_MAP_FAR_ZOOM = 14;
let bikeCity = null;
let bikeCityLoadedAt = 0;
let bikeCityLoad = null;

function loadBikeCity({ force = false } = {}) {
  if (!force && bikeCity && Date.now() - bikeCityLoadedAt < 45_000) return Promise.resolve();
  bikeCityLoad ??= (async () => {
    try {
      const payload = await api("/bikes/stations");
      bikeCity = payload;
      bikeCityLoadedAt = Date.now();
      for (const st of payload.stations ?? []) bikeById.set(st.id, { ...bikeById.get(st.id), ...st });
      if (Number(payload.fetchedAt) > Number(bikeFetchedAt ?? 0)) bikeFetchedAt = payload.fetchedAt;
      rebuildBikeMarkers();
      refreshBikePopup();
    } catch (err) {
      statusEl.textContent = `Could not load bike stations: ${err.message}`;
    } finally {
      bikeCityLoad = null;
    }
  })();
  return bikeCityLoad;
}

function bikePopup(station) {
  const saved = bikeSaved.find((s) => s.station_id === station.id);
  const wrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = bikeTitle(station, saved);
  const num = document.createElement("p");
  num.className = "stop-num";
  num.textContent = station.address ? `Nº ${station.number} · ${station.address}` : `Nº ${station.number}`;
  wrap.append(title, num, bikeCounts(station));

  // Icons only, like the cards: save, track, and the sheet behind the "i".
  const fav = document.createElement("button");
  fav.type = "button";
  fav.className = "icon-btn bike-favourite";
  fav.textContent = saved ? "★" : "☆";
  fav.title = saved ? "Remove from saved" : "Save this station";
  fav.setAttribute("aria-label", fav.title);
  fav.addEventListener("click", () => {
    toggleBikeSaved(station, saved);
    bikePopupControl?.remove();
  });
  const track = tracking.button({
    kind: "bike", targetId: String(station.id), label: bikeTitle(station, saved),
    coordinates: station.coordinates,
  });
  const info = document.createElement("button");
  info.type = "button";
  info.className = "icon-btn";
  info.title = "Station details";
  info.setAttribute("aria-label", info.title);
  info.innerHTML = INFO_ICON;
  info.addEventListener("click", () => {
    bikePopupControl?.remove();
    openBikeStation(station);
  });
  const actions = document.createElement("div");
  actions.className = "pop-actions";
  actions.append(fav, track, info);
  wrap.append(actions);
  return wrap;
}

/** The open bike popup, redrawn in place: its bell must follow a toggle. */
function refreshBikePopup() {
  if (!bikePopupControl?.isOpen() || bikePopupStationId == null) return;
  const station = bikeById.get(bikePopupStationId);
  if (station) bikePopupControl.setDOMContent(bikePopup(station));
}

function showBikePopupAfterPan(station) {
  pendingBikePopupId = station.id;
  const target = station.coordinates;
  const open = () => {
    if (pendingBikePopupId !== station.id) return;
    pendingBikePopupId = null;
    bikePopupStationId = station.id;
    bikePopupControl = new maplibregl.Popup({ closeButton: false, closeOnClick: true })
      .setLngLat(target)
      .setDOMContent(bikePopup(bikeById.get(station.id) ?? station))
      .addTo(bikeMap);
  };

  bikePopupControl?.remove();
  const centre = bikeMap.getCenter();
  // Already centred: no move will be emitted, so do not wait for one.
  if (metresBetweenCoordinates([centre.lng, centre.lat], target) < 1) {
    open();
    return;
  }
  bikeMap.once("moveend", open);
  bikeMap.panTo(target);
}

/** Bike pins are updated in place, keyed by station. Removing and re-adding
 *  every marker on each refresh made the whole map blink. */
function rebuildBikeMarkers() {
  if (!bikeMarkers || bikeMapEl.hidden) return; // a hidden map has no bounds
  const savedIdSet = new Set(bikeSaved.map((s) => s.station_id));
  const wanted = new Set();
  // Far out, a pin is a dot coloured by availability: 54px labels for a
  // whole district would only be a pile of overlapping text.
  bikeMapEl.classList.toggle("bike-map-far", bikeMap.getZoom() < BIKE_MAP_FAR_ZOOM);
  const bounds = paddedBounds(bikeMap, 0.25);
  const source = bikeCity?.stations ?? bikeNear.stations ?? [];
  for (const station of source) {
    if (!station.coordinates || !bounds.contains(station.coordinates)) continue;
    wanted.add(station.id);
    const takeClass = availabilityClass(station.bikes,
      station.inService && station.renting !== false);
    const capacity = station.totalBases || "—";
    const ring = tracking.isTracked("bike", station.id) ? " tracked"
      : savedIdSet.has(station.id) ? " saved" : "";
    const html =
      `<div class="bike-pin-inner avail-${takeClass}${ring}" ` +
      `aria-label="${station.bikes ?? "Unknown"} rentable bikes out of ${capacity} spaces">` +
      `<span class="${takeClass}">🚲 ${station.bikes ?? "—"}/${capacity}</span></div>`;
    const existing = bikeMarkers.get(station.id);
    if (existing) {
      if (existing.html !== html) {
        existing.marker.getElement().innerHTML = html;
        existing.html = html;
      }
      continue;
    }
    const marker = domMarker(html, "bike-pin", station.coordinates);
    const id = station.id;
    marker.getElement().addEventListener("click", (event) => {
      // The popup closes on any map click. Once the station is centred it
      // opens synchronously, so this same click reaching the map closed it
      // again at once: the first tap worked (it waited for the pan), every
      // later tap on that station did nothing. Tapping it again closes it.
      event.stopPropagation();
      if (bikePopupControl?.isOpen() && bikePopupStationId === id) {
        bikePopupControl.remove();
        return;
      }
      showBikePopupAfterPan(bikeById.get(id) ?? station);
    });
    marker.addTo(bikeMap);
    bikeMarkers.set(id, { marker, html });
  }
  for (const [id, { marker }] of bikeMarkers) {
    if (wanted.has(id)) continue;
    marker.remove();
    bikeMarkers.delete(id);
  }
}

/* ---- Section menu ------------------------------------------------------- */

function showSection(next) {
  if (next !== section) closeFullscreenMap();
  section = next;
  document.body.dataset.section = next;
  const bikes = next === "bikes";
  document.title = bikes ? "BiciMAD" : busListMode === "places" ? "Hubward" : "Stops";
  busModePlaces.setAttribute("aria-selected", String(!bikes && busListMode === "places"));
  busModeStops.setAttribute("aria-selected", String(!bikes && busListMode === "stops"));
  menuBikes.setAttribute("aria-selected", String(bikes));
  fab.hidden = bikes || !authSession;
  bikeAgeEl.hidden = !bikes;
  bikeAccountEl.hidden = !bikes || !isOwner;

  const mapView = viewMapBtn.getAttribute("aria-selected") === "true";
  listEl.hidden = bikes || mapView;
  renderGoForm();
  mapEl.hidden = bikes || !mapView;
  bikesEl.hidden = !bikes || mapView;
  bikeMapEl.hidden = !bikes || !mapView;
  renderRouteLegend();

  if (bikes) {
    if (mapView) {
      ensureBikeMap();
      bikeMap.resize();
      rebuildBikeMarkers(); // bounds exist only now the map is visible
      void loadBikeCity();
    }
    const centre = bikeMap?.getCenter() ?? { lat: myLocation?.[0] ?? 40.4168, lng: myLocation?.[1] ?? -3.7038 };
    loadBikesNear(centre.lat, centre.lng);
    renderBikes();
  } else if (mapView) {
    ensureMap();
    leafletMap.resize();
  } else {
    render();
  }
  syncMapControls();
}

menuBikes.addEventListener("click", () => showSection("bikes"));



function addUserMarker(map, location) {
  const marker = domMarker('<span aria-hidden="true">●</span>', "user-pin",
    [location[1], location[0]]);
  marker.getElement().title = "You are here";
  return marker.addTo(map);
}

function updateUserMarkers() {
  if (!myLocation) return;
  if (leafletMap) {
    if (busUserMarker) busUserMarker.setLngLat(myLngLat());
    else busUserMarker = addUserMarker(leafletMap, myLocation);
  }
  if (bikeMap) {
    if (bikeUserMarker) bikeUserMarker.setLngLat(myLngLat());
    else bikeUserMarker = addUserMarker(bikeMap, myLocation);
  }
}

function syncMapControls() {
  const mapView = viewMapBtn.getAttribute("aria-selected") === "true";
  if (!mapView) closeFullscreenMap();
  mapActions.hidden = !mapView;
  const on = nearestStopRoutes.length > 0;
  nearestRoutesBtn.setAttribute("aria-pressed", String(on));
  nearestRoutesBtn.title = on
    ? "Hide the lines at your nearest saved stops"
    : "Show lines at my nearest saved stops";
}

function closeFullscreenMap() {
  const wasFullscreen = mapEl.classList.contains("map-fullscreen") ||
    bikeMapEl.classList.contains("map-fullscreen");
  mapEl.classList.remove("map-fullscreen");
  bikeMapEl.classList.remove("map-fullscreen");
  document.body.classList.remove("map-is-fullscreen");
  mapFullscreenBtn.title = "Expand map";
  mapFullscreenBtn.setAttribute("aria-label", "Expand map");
  if (wasFullscreen) requestAnimationFrame(() => {
    leafletMap?.resize();
    bikeMap?.resize();
  });
}

let locationRefreshTimer = null;
let locationRequestPending = false;

function applyLocation(position, { recenter = false, forceNearby = false } = {}) {
  myLocation = [position.coords.latitude, position.coords.longitude];
  statusEl.textContent = "";
  updateUserMarkers();
  if (recenter) {
    // Hidden maps can be recentered safely; their size is corrected when they
    // become visible. Background updates never disturb a map the user panned.
    leafletMap?.jumpTo({ center: myLngLat(), zoom: 16 });
    bikeMap?.jumpTo({ center: myLngLat(), zoom: 16 });
  }
  render();
  renderBikes();
  void loadNearbyAt(myLocation[0], myLocation[1], { force: forceNearby }).then(() => {
    if (nearbyStopsDialog.open || addDialog.open) void updateClosestStopsDialog();
  });
  // On the bike map the map's own centre decides what is loaded (moveend).
  // Loading around the GPS fix as well swapped the set every 10 s, and the
  // two areas fought over which stations were on screen.
  const bikeMapShown = section === "bikes" && bikeMap && !bikeMapEl.hidden;
  if (!bikeMapShown || recenter) void loadBikesNear(myLocation[0], myLocation[1], { force: forceNearby });
  scheduleJourneys({ force: forceNearby });
  void tracking.reportLocation(myLocation);
}

function refreshLocation({ userInitiated = false, recenter = false, forceNearby = false } = {}) {
  if (!navigator.geolocation) {
    if (userInitiated) statusEl.textContent = "This browser will not share a location.";
    return;
  }
  if (locationRequestPending) return;
  locationRequestPending = true;
  if (userInitiated) statusEl.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      locationRequestPending = false;
      applyLocation(position, { recenter, forceNearby });
    },
    (err) => {
      locationRequestPending = false;
      if (userInitiated || !myLocation) statusEl.textContent = `Could not get your location: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 8_000, maximumAge: 5_000 }
  );
}

function stopLocationRefresh() {
  if (locationRefreshTimer != null) clearInterval(locationRefreshTimer);
  locationRefreshTimer = null;
}

function startLocationRefresh() {
  stopLocationRefresh();
  if (document.visibilityState !== "visible") return;
  refreshLocation();
  locationRefreshTimer = setInterval(() => refreshLocation(), 10_000);
}

locateBtn.addEventListener("click", () => {
  refreshLocation({ userInitiated: true, recenter: true, forceNearby: true });
});

mapFullscreenBtn.addEventListener("click", () => {
  const activeEl = section === "bikes" ? bikeMapEl : mapEl;
  const activeMap = section === "bikes" ? bikeMap : leafletMap;
  const expanding = !activeEl.classList.contains("map-fullscreen");
  for (const element of [mapEl, bikeMapEl]) element.classList.remove("map-fullscreen");
  activeEl.classList.toggle("map-fullscreen", expanding);
  document.body.classList.toggle("map-is-fullscreen", expanding);
  mapFullscreenBtn.title = expanding ? "Close fullscreen map" : "Expand map";
  mapFullscreenBtn.setAttribute("aria-label", mapFullscreenBtn.title);
  requestAnimationFrame(() => activeMap?.resize());
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("map-is-fullscreen")) {
    closeFullscreenMap();
  }
});

startLocationRefresh();
initAuth();

/** Where a tapped notification leads: that stop's or that dock's sheet. */
async function openNotificationTarget(kind, id) {
  if (!/^\d+$/.test(id || "")) return;
  // A sheet already showing, even this one, cannot be shown again: showModal()
  // throws on an open dialog. Whatever was open gives way to the alert.
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  try {
    if (kind === "bus") {
      openStop(stops.find((stop) => String(stop.stop_id) === id) ?? { stop_id: id, label: null, id: null });
    } else if (kind === "bike") {
      const payload = await api(`/bikes/stations?ids=${encodeURIComponent(id)}`);
      const station = payload.stations?.find((station) => String(station.id) === id);
      if (station) openBikeStation(station);
    }
  } catch (error) { statusEl.textContent = `Could not open notification: ${error.message}`; }
}
const directionsDialog = document.getElementById("directions-dialog");
const directionsApp = document.getElementById("directions-app");
const directionsWeb = document.getElementById("directions-web");

/** A tapped alert's walk: open the stop or dock, then hand off to the Google
 *  Maps app. The launch is tried at once; where the system wants a real tap
 *  for it, the dialog's button is that tap. Leaving for Maps closes it. */
async function openNotificationDirections(kind, id, coordinates) {
  await openNotificationTarget(kind, id);
  const links = mapsDirections(coordinates, navigator.userAgent, navigator.maxTouchPoints);
  if (!links) return;
  const place = document.querySelector("#stop-dialog[open] h2, #bike-dialog[open] h2")?.textContent;
  document.getElementById("directions-place").textContent = place ? `To ${place}` : "";
  directionsApp.href = links.app ?? links.web;
  directionsApp.target = links.app ? "" : "_blank";
  directionsWeb.href = links.web;
  directionsWeb.hidden = !links.app;
  directionsDialog.showModal();
  if (links.app) location.href = links.app;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && directionsDialog.open) directionsDialog.close();
});

const launchParams = new URLSearchParams(location.search);
if (launchParams.has("trackId")) {
  const walkTo = launchParams.get("directions")?.split(",").map(Number);
  if (walkTo?.length === 2) {
    void openNotificationDirections(launchParams.get("trackKind"), launchParams.get("trackId"), walkTo);
  } else {
    void openNotificationTarget(launchParams.get("trackKind"), launchParams.get("trackId"));
  }
  // Opened once; a reload or a home-screen relaunch should not reopen it.
  history.replaceState(null, "", location.pathname);
}

const pushBanner = document.getElementById("push-banner");
let pushBannerTimer;
let pushBannerTarget;

function setBannerDrag(x = 0, y = 0) {
  pushBanner.style.setProperty("--drag-x", `${x}px`);
  pushBanner.style.setProperty("--drag-y", `${y}px`);
  pushBanner.style.setProperty("--drag-opacity", String(Math.max(0, 1 - Math.hypot(x, Math.min(y, 0)) / 240)));
}

function hidePushBanner() {
  clearTimeout(pushBannerTimer);
  delete pushBanner.dataset.dragged;
  pushBanner.hidden = true;
  pushBanner.classList.remove("settling");
  setBannerDrag();
}

navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === "open") {
    void openNotificationTarget(event.data.target?.kind, event.data.target?.id);
    return;
  }
  if (event.data?.type === "directions") {
    const target = event.data.target ?? {};
    void openNotificationDirections(target.kind, target.id, target.coordinates);
    return;
  }
  if (event.data?.type !== "push") return;
  const message = event.data.message ?? {};
  document.getElementById("push-banner-title").textContent = message.title || "Hubward";
  document.getElementById("push-banner-body").textContent = message.body || "";
  pushBannerTarget = message.target;
  // Below the header, not over it: the List/Map toggle and refresh live there.
  // A header scrolled out of view leaves the banner at the top of the screen.
  const headerBottom = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  pushBanner.style.top = `${Math.max(12, headerBottom + 8)}px`;
  hidePushBanner();
  pushBanner.hidden = false;
  navigator.vibrate?.(200);
  pushBannerTimer = setTimeout(hidePushBanner, 8000);
});

// Swipe sideways or up to dismiss; a short movement is still a tap.
let bannerDrag = null;
pushBanner.addEventListener("pointerdown", (event) => {
  bannerDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  pushBanner.setPointerCapture(event.pointerId);
  pushBanner.classList.remove("settling");
  clearTimeout(pushBannerTimer); // not while a finger is on it
});
pushBanner.addEventListener("pointermove", (event) => {
  if (bannerDrag?.id !== event.pointerId) return;
  const dx = event.clientX - bannerDrag.x;
  const dy = Math.min(0, event.clientY - bannerDrag.y);
  if (Math.hypot(dx, dy) > 8) bannerDrag.moved = true;
  setBannerDrag(dx, dy);
});
function endBannerDrag(event) {
  if (bannerDrag?.id !== event.pointerId) return;
  const dx = event.clientX - bannerDrag.x;
  const dy = Math.min(0, event.clientY - bannerDrag.y);
  pushBanner.classList.add("settling");
  if (Math.abs(dx) > 80 || dy < -40) {
    setBannerDrag(Math.abs(dx) > 80 ? Math.sign(dx) * window.innerWidth : 0, dy < -40 ? -200 : 0);
    setTimeout(hidePushBanner, 160);
  } else {
    setBannerDrag();
    pushBannerTimer = setTimeout(hidePushBanner, 8000);
  }
  // A drag must not also count as a tap on the banner.
  if (bannerDrag.moved && event.type === "pointerup") pushBanner.dataset.dragged = "1";
  bannerDrag = null;
}
pushBanner.addEventListener("pointerup", endBannerDrag);
pushBanner.addEventListener("pointercancel", endBannerDrag);
pushBanner.addEventListener("click", () => {
  if (pushBanner.dataset.dragged) {
    delete pushBanner.dataset.dragged;
    return;
  }
  hidePushBanner();
  void openNotificationTarget(pushBannerTarget?.kind, pushBannerTarget?.id);
});
