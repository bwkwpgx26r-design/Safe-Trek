/* SafeTrek – app.js (Full, stable, UI-preserving)
   - Works with screens: routes, summary, map
   - IDs used: routeGrid, routesSub, mapView, mapTitle, summaryTitle, summaryText
   - Optional: if you have dash/chat/etc, it won't break.
*/

/* -------------------------
   Helpers / State
--------------------------*/

const STORAGE_KEY = "safetrex_state_v1";

const REGIONS = {
  "München": { lat: 48.137154, lon: 11.576124, label: "München" },
  "Garmisch": { lat: 47.4917, lon: 11.0955, label: "Garmisch" },
  "Innsbruck": { lat: 47.2682, lon: 11.3923, label: "Innsbruck" }
};

const defaultState = {
  view: "routes",
  selectedRegion: "München",
  radiusKm: 20,

  // routes list (from Overpass)
  routes: [],
  routesMeta: { status: "idle", lastQuery: null, lastError: null },

  // selected route full geometry
  selectedRoute: null,

  // enriched data
  weather: null,
  elevation: null,
  exits: [],

  // plans
  plans: null,
  activePlan: null,

  // navigation back stack
  nav: { stack: [] }
};

let state = loadState();

/* -------------------------
   DOM shortcuts (safe)
--------------------------*/
const el = (id) => document.getElementById(id);

/* -------------------------
   Persist
--------------------------*/
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    // merge default keys
    return deepMerge(structuredClone(defaultState), parsed);
  } catch (_) {
    return structuredClone(defaultState);
  }
}

function deepMerge(base, extra) {
  for (const k of Object.keys(extra || {})) {
    const v = extra[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      base[k] = deepMerge(base[k] || {}, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

/* -------------------------
   Navigation (views + back)
--------------------------*/
window.go = function go(viewId) {
  // push a backpoint whenever user navigates between core screens
  // (only if it changes screen)
  if (state.view !== viewId) pushBackPoint(`go:${viewId}`);
  state.view = viewId;
  saveState();
  showView(viewId);
  renderCurrent();
};

function showView(viewId) {
  const screens = document.querySelectorAll(".screen");
  screens.forEach((s) => s.classList.remove("active"));
  const target = document.getElementById(viewId);
  if (target) target.classList.add("active");
}

function renderCurrent() {
  if (state.view === "routes") renderRoutes();
  if (state.view === "summary") renderSummary();
  if (state.view === "map") renderMap();
}

/* --- Back stack --- */
function snapshotState() {
  // capture only app-relevant parts
  return {
    view: state.view,
    selectedRegion: state.selectedRegion,
    radiusKm: state.radiusKm,
    routes: state.routes,
    routesMeta: state.routesMeta,
    selectedRoute: state.selectedRoute,
    weather: state.weather,
    elevation: state.elevation,
    exits: state.exits,
    plans: state.plans,
    activePlan: state.activePlan
  };
}

function pushBackPoint(label = "") {
  state.nav = state.nav || { stack: [] };
  state.nav.stack = state.nav.stack || [];
  state.nav.stack.push({ t: Date.now(), label, snap: snapshotState() });
  if (state.nav.stack.length > 50) state.nav.stack.shift();
  saveState();
}

window.goBack = function goBack() {
  if (!state.nav?.stack?.length) return;
  const last = state.nav.stack.pop();
  const s = last.snap;

  state.view = s.view;
  state.selectedRegion = s.selectedRegion;
  state.radiusKm = s.radiusKm;
  state.routes = s.routes || [];
  state.routesMeta = s.routesMeta || { status: "idle" };
  state.selectedRoute = s.selectedRoute;
  state.weather = s.weather;
  state.elevation = s.elevation;
  state.exits = s.exits || [];
  state.plans = s.plans;
  state.activePlan = s.activePlan;

  saveState();
  showView(state.view);
  renderCurrent();
};

/* -------------------------
   Region + Radius UI hook (optional)
   - if your UI has chips, call these from onclick
--------------------------*/
window.selectRegion = function selectRegion(name) {
  if (!REGIONS[name]) return;
  pushBackPoint("selectRegion");
  state.selectedRegion = name;
  saveState();
  renderRoutes();
};

window.selectRadius = function selectRadius(km) {
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0) return;
  pushBackPoint("selectRadius");
  state.radiusKm = Math.max(2, Math.min(60, n));
  saveState();
  renderRoutes();
};

/* -------------------------
   ROUTES: search + render
--------------------------*/
window.findRoutes = async function findRoutes() {
  // explicit action button can call this
  pushBackPoint("findRoutes");
  await fetchRoutes();
  renderRoutes();
};

async function fetchRoutes() {
  const region = REGIONS[state.selectedRegion] || REGIONS["München"];
  const radius = state.radiusKm || 20;

  state.routesMeta = {
    status: "loading",
    lastQuery: `${region.label} ${radius}km`,
    lastError: null
  };
  saveState();
  renderRoutes();

  try {
    // Overpass query:
    // ways tagged as hiking routes OR paths, within radius around center.
    // We fetch candidates with minimal fields (id + tags + center).
    const q = `
      [out:json][timeout:25];
      (
        relation["route"="hiking"](around:${radius * 1000},${region.lat},${region.lon});
        way["highway"~"path|footway|track"](around:${radius * 1000},${region.lat},${region.lon});
      );
      out tags center 120;
    `.trim();

    const url = "https://overpass-api.de/api/interpreter";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "data=" + encodeURIComponent(q)
    });

    if (!res.ok) throw new Error("Overpass HTTP " + res.status);

    const data = await res.json();
    const items = (data.elements || [])
      .map((e) => normalizeCandidate(e))
      .filter(Boolean);

    // de-duplicate by id+type
    const seen = new Set();
    const uniq = [];
    for (const it of items) {
      const key = `${it.type}:${it.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(it);
    }

    // sort: prefer named, then by "hiking relation", then near center
    uniq.sort((a, b) => {
      const an = a.name ? 0 : 1;
      const bn = b.name ? 0 : 1;
      if (an !== bn) return an - bn;
      const ar = a.type === "relation" ? 0 : 1;
      const br = b.type === "relation" ? 0 : 1;
      if (ar !== br) return ar - br;
      return a.distM - b.distM;
    });

    state.routes = uniq.slice(0, 18);
    state.routesMeta.status = "ready";
    saveState();
  } catch (err) {
    state.routes = [];
    state.routesMeta.status = "error";
    state.routesMeta.lastError = String(err?.message || err);
    saveState();
  }
}

function normalizeCandidate(e) {
  if (!e || !e.id) return null;
  const tags = e.tags || {};
  const name =
    tags.name ||
    tags.ref ||
    (tags.route === "hiking" ? "Wanderroute" : "Weg");

  // center
  const lat = e.center?.lat ?? e.lat;
  const lon = e.center?.lon ?? e.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const region = REGIONS[state.selectedRegion] || REGIONS["München"];
  const distM = haversineM(region.lat, region.lon, lat, lon);

  return {
    type: e.type,
    id: e.id,
    name,
    tags,
    center: { lat, lon },
    distM
  };
}

function renderRoutes() {
  const grid = el("routeGrid");
  const sub = el("routesSub");
  if (!grid) return;

  // header subtitle
  if (sub) {
    const region = REGIONS[state.selectedRegion] || REGIONS["München"];
    sub.textContent = `${region.label} • ${state.radiusKm} km Umkreis`;
  }

  grid.innerHTML = "";

  // status
  if (state.routesMeta?.status === "loading") {
    grid.appendChild(infoCard("Suche läuft…", "Wir holen passende Wanderwege (OpenStreetMap/Overpass)."));
    return;
  }
  if (state.routesMeta?.status === "error") {
    grid.appendChild(infoCard("Keine Daten", `Fehler: ${state.routesMeta.lastError || "Unbekannt"}`));
    grid.appendChild(actionCard("Erneut versuchen", "findRoutes()"));
    return;
  }

  // if none yet
  if (!state.routes?.length) {
    grid.appendChild(infoCard("Noch keine Tourvorschläge", "Wähle Region & Umkreis und starte die Suche."));
    grid.appendChild(actionCard("Touren vorschlagen", "findRoutes()"));
    return;
  }

  // render cards
  state.routes.forEach((r, idx) => {
    grid.appendChild(routeCard(r, idx));
  });
}

function infoCard(title, text) {
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `
    <div class="cardTitle">${escapeHtml(title)}</div>
    <div class="cardSub">${escapeHtml(text)}</div>
  `;
  return d;
}

function actionCard(label, fnCall) {
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `
    <div class="cardSub"> </div>
    <button class="btn" onclick="${fnCall}">${escapeHtml(label)}</button>
  `;
  return d;
}

function routeCard(route, index) {
  const d = document.createElement("div");
  d.className = "card stCard"; // keep your visual style

  const dist = Math.round(route.distM / 100) / 10;

  d.innerHTML = `
    <div class="cardTitle">${escapeHtml(route.name)}</div>
    <div class="cardSub">${escapeHtml(dist)} km entfernt • Quelle: OpenStreetMap</div>

    <div class="stActions">
      <button class="btn ghost small stBtn" data-action="view" data-idx="${index}">Route ansehen</button>
      <button class="btn small stBtn" data-action="select" data-idx="${index}">Route wählen</button>
    </div>
  `;

  // bind clicks (avoid overlay issues)
  d.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async (ev) => {
      const action = b.dataset.action;
      const idx = Number(b.dataset.idx);
      if (!Number.isFinite(idx)) return;

      if (action === "view") {
        await openRouteByIndex(idx, { goTo: "map", backLabel: "viewRoute" });
      }
      if (action === "select") {
        await openRouteByIndex(idx, { goTo: "summary", backLabel: "selectRoute" });
      }
    });
  });

  return d;
}

/* -------------------------
   ROUTE LOAD: geometry + enrich
--------------------------*/
async function openRouteByIndex(idx, opts = {}) {
  const pick = state.routes[idx];
  if (!pick) return;

  pushBackPoint(opts.backLabel || "openRoute");

  // show loading state by moving to target view and rendering placeholder
  state.selectedRoute = { loading: true, name: pick.name };
  state.weather = null;
  state.elevation = null;
  state.exits = [];
  state.plans = null;
  state.activePlan = null;
  saveState();

  if (opts.goTo) {
    state.view = opts.goTo;
    saveState();
    showView(opts.goTo);
    renderCurrent();
  }

  try {
    const route = await loadGeometry(pick);
    state.selectedRoute = route;
    saveState();

    // enrich in parallel
    const [weather, elevation, exits] = await Promise.all([
      safeFetchWeather(route.center.lat, route.center.lon),
      safeFetchElevation(route.coords),
      safeFetchExitsNearRoute(route.coords)
    ]);

    state.weather = weather;
    state.elevation = elevation;
    state.exits = exits || [];
    // create plans
    state.plans = buildPlans(route, elevation);
    state.activePlan = "A";

    saveState();
    renderCurrent();
  } catch (e) {
    state.selectedRoute = null;
    saveState();
    // return to routes on error
    state.view = "routes";
    saveState();
    showView("routes");
    renderRoutes();
    alert("Route konnte nicht geladen werden. Bitte eine andere auswählen.");
  }
}

async function loadGeometry(pick) {
  // For relations (hiking routes), we try to get member ways;
  // For ways, we load geometry directly.
  const url = "https://overpass-api.de/api/interpreter";

  let q = "";
  if (pick.type === "way") {
    q = `
      [out:json][timeout:25];
      way(${pick.id});
      out geom;
    `.trim();
  } else {
    // relation -> fetch member ways geometry
    q = `
      [out:json][timeout:25];
      relation(${pick.id});
      way(r);
      out geom;
    `.trim();
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(q)
  });
  if (!res.ok) throw new Error("Overpass route geometry HTTP " + res.status);

  const data = await res.json();
  const ways = (data.elements || []).filter((e) => e.type === "way" && Array.isArray(e.geometry));
  if (!ways.length) throw new Error("No geometry");

  // Build a reasonably ordered polyline:
  // We chain ways by nearest endpoints to reduce zig-zag.
  const chains = ways.map((w) => w.geometry.map((p) => [p.lat, p.lon]));
  const ordered = stitchPolylines(chains);

  // center
  const center = averageLatLon(ordered);

  const route = {
    id: `${pick.type}:${pick.id}`,
    name: pick.name,
    coords: ordered,
    center
  };

  return route;
}

function stitchPolylines(lines) {
  // Greedy stitching: take first line, then attach next best endpoint match.
  const remaining = lines.slice().filter((l) => l.length >= 2);
  let current = remaining.shift();
  while (remaining.length) {
    const end = current[current.length - 1];
    let bestIdx = -1;
    let bestFlip = false;
    let bestD = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const l = remaining[i];
      const a = l[0];
      const b = l[l.length - 1];
      const d1 = haversineM(end[0], end[1], a[0], a[1]);
      const d2 = haversineM(end[0], end[1], b[0], b[1]);
      if (d1 < bestD) { bestD = d1; bestIdx = i; bestFlip = false; }
      if (d2 < bestD) { bestD = d2; bestIdx = i; bestFlip = true; }
    }

    const next = remaining.splice(bestIdx, 1)[0];
    const segment = bestFlip ? next.slice().reverse() : next;
    // If gap large, just append anyway (prevents “wire” jumps when relation is disjoint)
    current = current.concat(segment);
  }
  return current;
}

function averageLatLon(coords) {
  let sLat = 0, sLon = 0;
  for (const [lat, lon] of coords) { sLat += lat; sLon += lon; }
  return { lat: sLat / coords.length, lon: sLon / coords.length };
}

/* -------------------------
   WEATHER (Open-Meteo)
--------------------------*/
async function safeFetchWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,wind_speed_10m,precipitation,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const c = data.current;
    if (!c) return null;
    return {
      tempC: c.temperature_2m,
      windKmh: c.wind_speed_10m,
      precip: c.precipitation,
      code: c.weather_code
    };
  } catch (_) {
    return null;
  }
}

/* -------------------------
   ELEVATION (stable, lightweight)
   - We sample ~12 points and estimate ascent.
   - Uses Open-Meteo elevation endpoint (CORS friendly).
--------------------------*/
async function safeFetchElevation(coords) {
  try {
    if (!coords?.length) return null;

    // sample points
    const sampleCount = Math.min(12, coords.length);
    const step = Math.max(1, Math.floor(coords.length / sampleCount));
    const samples = [];
    for (let i = 0; i < coords.length && samples.length < sampleCount; i += step) {
      samples.push(coords[i]);
    }

    const lats = samples.map((p) => p[0]).join(",");
    const lons = samples.map((p) => p[1]).join(",");

    const url = `https://api.open-meteo.com/v1/elevation?latitude=${encodeURIComponent(lats)}&longitude=${encodeURIComponent(lons)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    const elev = data.elevation;
    if (!Array.isArray(elev) || elev.length < 2) return null;

    // estimate ascent/descent
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < elev.length; i++) {
      const d = elev[i] - elev[i - 1];
      if (d > 0) gain += d;
      else loss += Math.abs(d);
    }

    const min = Math.min(...elev);
    const max = Math.max(...elev);

    return {
      minM: Math.round(min),
      maxM: Math.round(max),
      gainM: Math.round(gain),
      lossM: Math.round(loss)
    };
  } catch (_) {
    return null;
  }
}

/* -------------------------
   Assisted Exit (POIs near route)
--------------------------*/
async function safeFetchExitsNearRoute(coords) {
  try {
    if (!coords?.length) return [];

    // use center and radius approx
    const center = averageLatLon(coords);
    const radiusM = 1200; // nearby exits around center (fast + stable)

    const q = `
      [out:json][timeout:25];
      (
        node["railway"="station"](around:${radiusM},${center.lat},${center.lon});
        node["highway"="bus_stop"](around:${radiusM},${center.lat},${center.lon});
        node["amenity"="parking"](around:${radiusM},${center.lat},${center.lon});
        node["amenity"="shelter"](around:${radiusM},${center.lat},${center.lon});
        node["tourism"="alpine_hut"](around:${radiusM},${center.lat},${center.lon});
        node["amenity"="cafe"](around:${radiusM},${center.lat},${center.lon});
      );
      out tags 60;
    `.trim();

    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "data=" + encodeURIComponent(q)
    });
    if (!res.ok) return [];

    const data = await res.json();
    const nodes = (data.elements || []).filter((e) => e.type === "node" && Number.isFinite(e.lat) && Number.isFinite(e.lon));

    // compute distance to nearest polyline point
    const exits = nodes.map((n) => {
      const name = n.tags?.name || n.tags?.operator || "Exit-Option";
      const kind =
        n.tags?.railway === "station" ? "Bahnhof" :
        n.tags?.highway === "bus_stop" ? "Bus" :
        n.tags?.amenity === "parking" ? "Parkplatz" :
        n.tags?.amenity === "shelter" ? "Shelter" :
        n.tags?.tourism === "alpine_hut" ? "Hütte" :
        n.tags?.amenity === "cafe" ? "Café" : "POI";

      let best = Infinity;
      for (let i = 0; i < coords.length; i += Math.max(1, Math.floor(coords.length / 60))) {
        const [lat, lon] = coords[i];
        const d = haversineM(lat, lon, n.lat, n.lon);
        if (d < best) best = d;
      }

      return { name, kind, lat: n.lat, lon: n.lon, distToRouteM: Math.round(best) };
    });

    exits.sort((a, b) => a.distToRouteM - b.distToRouteM);
    return exits.slice(0, 8);
  } catch (_) {
    return [];
  }
}

/* -------------------------
   Plans A/B/C
--------------------------*/
function buildPlans(route, elevation) {
  // simple, stable plans based on length proxy (coords count)
  const lenKm = estimateLengthKm(route.coords);
  const gain = elevation?.gainM ?? null;

  const base = {
    name: route.name,
    lenKm: round1(lenKm),
    gainM: gain
  };

  return {
    A: { ...base, label: "Plan A", factor: 1.0, paceMinPerKm: 16 },
    B: { ...base, label: "Plan B", factor: 0.75, paceMinPerKm: 18 },
    C: { ...base, label: "Plan C", factor: 0.55, paceMinPerKm: 20 }
  };
}

function planPolyline(coords, factor) {
  // show partial route for B/C (simple but effective)
  const n = Math.max(20, Math.floor(coords.length * factor));
  return coords.slice(0, n);
}

/* -------------------------
   SUMMARY render
--------------------------*/
function renderSummary() {
  const titleEl = el("summaryTitle");
  const textEl = el("summaryText");

  if (!titleEl || !textEl) return;

  if (!state.selectedRoute) {
    titleEl.textContent = "Deine Route";
    textEl.textContent = "Bitte wähle zuerst eine Route aus.";
    return;
  }

  if (state.selectedRoute.loading) {
    titleEl.textContent = state.selectedRoute.name || "Route";
    textEl.textContent = "Lade Details…";
    return;
  }

  titleEl.textContent = state.selectedRoute.name || "Route";

  const w = state.weather;
  const e = state.elevation;
  const exits = state.exits || [];

  const parts = [];

  // Weather
  if (w) {
    parts.push(`Wetter: ${fmt(w.tempC)}°C • Wind ${fmt(w.windKmh)} km/h • Niederschlag ${fmt(w.precip)} mm`);
  } else {
    parts.push("Wetter: konnte gerade nicht geladen werden.");
  }

  // Elevation
  if (e) {
    parts.push(`Höhen: min ${e.minM} m • max ${e.maxM} m • ↑${e.gainM} m • ↓${e.lossM} m`);
  } else {
    parts.push("Höhenmeter: konnte gerade nicht geladen werden.");
  }

  // Exits
  if (exits.length) {
    const top = exits[0];
    parts.push(`Assisted Exit: nächste Option meist ${top.kind} „${top.name}“ (~${top.distToRouteM} m von Route)`);
  } else {
    parts.push("Assisted Exit: aktuell keine nahen Exit-Punkte gefunden.");
  }

  // Plans
  if (state.plans) {
    parts.push("Pläne: Plan A/B/C verfügbar (Buttons unten in der Karte/Map).");
  }

  textEl.textContent = parts.join("\n");
}

/* -------------------------
   MAP (Leaflet)
--------------------------*/
let map = null;
let mapLayer = null;
let exitLayer = null;

function ensureMap() {
  const div = el("mapView");
  if (!div) return null;

  if (map) return map;

  // Leaflet must be loaded in index.html
  map = L.map(div, { zoomControl: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  return map;
}

function renderMap() {
  const title = el("mapTitle");
  if (title) title.textContent = state.selectedRoute?.name || "Route";

  const m = ensureMap();
  if (!m) return;

  // Clear previous
  if (mapLayer) { mapLayer.remove(); mapLayer = null; }
  if (exitLayer) { exitLayer.remove(); exitLayer = null; }

  if (!state.selectedRoute || state.selectedRoute.loading) {
    // show default view
    const r = REGIONS[state.selectedRegion] || REGIONS["München"];
    m.setView([r.lat, r.lon], 11);
    return;
  }

  // active plan polyline
  const coords = state.selectedRoute.coords || [];
  const planKey = state.activePlan || "A";
  const plan = state.plans?.[planKey] || state.plans?.A;

  const factor =
    planKey === "B" ? 0.75 :
    planKey === "C" ? 0.55 : 1.0;

  const line = planPolyline(coords, factor);

  mapLayer = L.polyline(line, { weight: 5, opacity: 0.9 }).addTo(m);
  m.fitBounds(mapLayer.getBounds().pad(0.12));

  // exits
  if (state.exits?.length) {
    const group = L.layerGroup();
    state.exits.forEach((x) => {
      const marker = L.circleMarker([x.lat, x.lon], { radius: 6, opacity: 0.9, fillOpacity: 0.8 });
      marker.bindPopup(`<b>${escapeHtml(x.kind)}</b><br>${escapeHtml(x.name)}<br>~${x.distToRouteM} m zur Route`);
      group.addLayer(marker);
    });
    exitLayer = group.addTo(m);
  }
}

/* -------------------------
   SOS / Assisted Exit
--------------------------*/
window.openSOS = function openSOS() {
  pushBackPoint("SOS");
  const exits = state.exits || [];
  if (!exits.length) {
    alert("Assisted Exit: Aktuell keine nahe Option gefunden.\n\nHinweis: Kein Notruf / kein Ersatz für Bergrettung.");
    return;
  }

  const lines = exits.slice(0, 6).map((x, i) =>
    `${i + 1}) ${x.kind}: ${x.name} (~${x.distToRouteM} m)`
  );

  alert(
    "Assisted Exit (geplanter Rückzug)\n\n" +
    lines.join("\n") +
    "\n\nHinweis: Kein Notruf / kein Ersatz für Bergrettung."
  );
};

/* -------------------------
   Utilities
--------------------------*/
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function estimateLengthKm(coords) {
  if (!coords || coords.length < 2) return 0;
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a1, o1] = coords[i - 1];
    const [a2, o2] = coords[i];
    m += haversineM(a1, o1, a2, o2);
  }
  return m / 1000;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fmt(x) {
  if (x === null || x === undefined) return "?";
  const n = Number(x);
  if (!Number.isFinite(n)) return "?";
  return Math.round(n);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* -------------------------
   Boot
--------------------------*/
function boot() {
  // If your HTML sets a default screen, respect it.
  // Otherwise, show the stored view.
  showView(state.view || "routes");

  // render routes list view
  renderCurrent();

  // auto-fetch routes once if empty (but avoid spamming)
  if ((!state.routes || state.routes.length === 0) && state.routesMeta?.status !== "loading") {
    // don't push backpoint on boot
    fetchRoutes().then(() => renderRoutes());
  }

  // If you have plan buttons in UI, you can call setPlan('A'/'B'/'C') from onclick
  window.setPlan = function setPlan(k) {
    if (!state.plans || !state.plans[k]) return;
    pushBackPoint("setPlan");
    state.activePlan = k;
    saveState();
    if (state.view === "map") renderMap();
    if (state.view === "summary") renderSummary();
  };
}

document.addEventListener("DOMContentLoaded", boot);