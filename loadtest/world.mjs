// A synthetic Madrid for the load test: bus lines, their stops and the
// BiciMAD stations, generated from a fixed seed so every run, the fake
// upstream and the k6 setup all agree on the same city.
//
// Sized like the real network: 160 lines and 4,000–5,000 stops. Lines
// run as gently bent straight lines across the city with a stop every ~350m,
// one stop per side of the street; a stop within 60m of another on a line
// heading the same way is merged into it, so crossings and shared corridors
// give the planner real interchanges.

export const BOX = { south: 40.36, north: 40.5, west: -3.78, east: -3.6 };
const LINES = 160;
const STOP_SPACING = 350;
const MERGE_METRES = 60;
const BIKE_STATIONS = 680;

export function rng(seed) {
  // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_LAT = 111_320;
const M_LON = 111_320 * Math.cos((40.43 * Math.PI) / 180);
export const metres = ([lon1, lat1], [lon2, lat2]) =>
  Math.hypot((lon2 - lon1) * M_LON, (lat2 - lat1) * M_LAT);

const STREETS = ["Alcalá", "Gran Vía", "Serrano", "Bravo Murillo", "Princesa", "Atocha", "Toledo",
  "Arturo Soria", "Castellana", "Embajadores", "Goya", "Velázquez", "Delicias", "Mayor", "Ríos Rosas",
  "Santa Engracia", "López de Hoyos", "General Ricardos", "Marcelo Usera", "Avenida de América"];
const PLACES = ["SOL", "MONCLOA", "PLAZA CASTILLA", "ATOCHA", "CIBELES", "LEGAZPI", "OPORTO", "CANILLAS",
  "ALUCHE", "VALDEBERNARDO", "MANOTERAS", "PAVONES", "CUATRO CAMINOS", "EMBAJADORES", "ALSACIA",
  "BARRIO DEL PILAR", "PUERTA DEL SUR", "SANCHINARRO", "ARGANZUELA", "VILLAVERDE"];

function buildWorld() {
  const random = rng(20261024);
  const stops = new Map(); // id → {id, name, coordinates, lines: [{line, label, direction}]}
  const cells = new Map(); // ~100m grid → stop ids, for merging
  let nextStop = 1;
  const cellOf = ([lon, lat]) => `${Math.round(lat * 1000)}:${Math.round(lon * 1000)}`;

  function stopAt(coordinates, heading, entry) {
    const [lon, lat] = coordinates;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const key = `${Math.round(lat * 1000) + dy}:${Math.round(lon * 1000) + dx}`;
      for (const id of cells.get(key) ?? []) {
        const stop = stops.get(id);
        // Same side of the street only: the heading must roughly agree.
        if (Math.abs(((stop.heading - heading + 540) % 360) - 180) < 60) continue;
        if (metres(stop.coordinates, coordinates) <= MERGE_METRES) {
          if (!stop.lines.some((l) => l.line === entry.line)) stop.lines.push(entry);
          return stop;
        }
      }
    }
    const id = String(nextStop++);
    const stop = { id, name: `${STREETS[random() * STREETS.length | 0]} ${(random() * 180 | 0) + 1}`,
      coordinates, heading, lines: [entry] };
    stops.set(id, stop);
    const key = cellOf(coordinates);
    cells.set(key, [...(cells.get(key) ?? []), id]);
    return stop;
  }

  const lines = new Map();
  for (let n = 1; n <= LINES; n++) {
    const code = String(n).padStart(3, "0");
    const label = String(n);
    const point = () => [BOX.west + random() * (BOX.east - BOX.west), BOX.south + random() * (BOX.north - BOX.south)];
    let a = point(), b = point();
    while (metres(a, b) < 6000) b = point();
    // A bend at the midpoint, up to ~600m sideways.
    const mid = [(a[0] + b[0]) / 2 + (random() - 0.5) * 0.014, (a[1] + b[1]) / 2 + (random() - 0.5) * 0.01];
    const waypoints = [a, mid, b];
    const nameA = PLACES[random() * PLACES.length | 0];
    let nameB = PLACES[random() * PLACES.length | 0];
    while (nameB === nameA) nameB = PLACES[random() * PLACES.length | 0];
    const headway = 360 + (random() * 720 | 0); // 6–18 minutes
    const phase = random() * headway | 0;

    // Sample the polyline every STOP_SPACING metres.
    const samples = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [p, q] = [waypoints[i], waypoints[i + 1]];
      const length = metres(p, q);
      const steps = Math.max(1, Math.round(length / STOP_SPACING));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        samples.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    samples.push(b);

    const direction = (points, dir) => {
      // The two directions stand ~15m apart, one per side of the street.
      const offset = dir === "A" ? 0.00014 : -0.00014;
      const heading = (from, to) => (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI + 360) % 360;
      let distance = 0;
      const out = [];
      points.forEach((p, i) => {
        if (i > 0) distance += metres(points[i - 1], p);
        const next = points[Math.min(i + 1, points.length - 1)];
        const prev = points[Math.max(i - 1, 0)];
        const h = heading(prev, next === prev ? p : next);
        const placed = [Number((p[0] + offset).toFixed(6)), Number((p[1] + offset).toFixed(6))];
        const stop = stopAt(placed, h, { line: code, label, direction: dir });
        out.push({ stopId: stop.id, distance: Math.round(distance), coordinates: placed });
      });
      return out;
    };
    // toA runs towards nameA's end, so it starts at b.
    const toA = direction([...samples].reverse(), "A");
    const toB = direction(samples, "B");
    lines.set(code, { code, label, nameA, nameB, headway, phase, toA, toB });
  }

  const bikes = [];
  for (let i = 0; i < BIKE_STATIONS; i++) {
    const id = String(1000 + i);
    bikes.push({ id, number: String(i + 1), name: `${i + 1} - ${STREETS[random() * STREETS.length | 0]}`,
      lat: Number((BOX.south + random() * (BOX.north - BOX.south) * 0.8 + 0.014).toFixed(6)),
      lon: Number((BOX.west + random() * (BOX.east - BOX.west) * 0.8 + 0.018).toFixed(6)),
      capacity: 18 + (random() * 12 | 0) });
  }

  return { stops, lines, bikes };
}

export const world = buildWorld();

/** Stops within `radius` metres of a point. */
export function stopsNear(lon, lat, radius) {
  const out = [];
  for (const stop of world.stops.values()) {
    if (metres(stop.coordinates, [lon, lat]) <= radius) out.push(stop);
  }
  return out;
}
