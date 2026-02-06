// SafeTrek Beta – Web-App (no build).
// Erweiterung: echte Hiking-Routen via OpenStreetMap (Overpass) + Karte (Leaflet)

const chatEl = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const quickRepliesEl = document.getElementById("quickReplies");
const resetBtn = document.getElementById("resetBtn");

const STORAGE_KEY = "safetrek_beta_state_v2";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

const defaultState = {
  step: "start",
  profile: { stamina: null, breakNeed: null, safety: null },
  daily: { energyToday: null, painToday: null, anxietyToday: null },
  lastPlans: null,

  // NEU: Route
  route: null,            // { id, name, network, coords: [[lat,lng], ...], distanceKm }
  routeSearch: null,      // { placeKey, radiusM, results: [{id,name,network}] }

  history: []
};

let state = loadState();

// ---------- Helpers ----------
function nowLabel(){
  const d = new Date();
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}
function pushMsg(role, text){
  state.history.push({ role, text, t: nowLabel() });
  saveState();
  render();
}
function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(defaultState), ...parsed };
  }catch{
    return structuredClone(defaultState);
  }
}
function toInt1to5(v){
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 5) return null;
  return Math.round(n);
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function round(n,d=0){ const p = 10**d; return Math.round(n*p)/p; }

// ---------- Map (Leaflet) ----------
let leafletMap = null;
let leafletLine = null;

function ensureMap(containerId){
  const el = document.getElementById(containerId);
  if (!el || !window.L) return;

  if (!leafletMap){
    leafletMap = L.map(containerId, { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "© OpenStreetMap"
    }).addTo(leafletMap);
  } else {
    // wenn Leaflet schon initialisiert ist, muss Container evtl. neu vermessen werden
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }
}

// ---------- Decision Engine ----------
function generatePlans({ profile, daily, routeBase }) {
  const { stamina, breakNeed, safety } = profile;
  const { energyToday, painToday, anxietyToday } = daily;

  const readiness = clamp(
    (stamina * 1.2 + energyToday * 1.5 + (6 - painToday) * 1.0 + (6 - anxietyToday) * 0.8) / 4.5,
    1,
    5
  );

  const safetyBuffer = safety >= 4 ? 1.35 : safety === 3 ? 1.25 : 1.15;
  const breakFactor = breakNeed >= 4 ? 1.25 : breakNeed === 3 ? 1.15 : 1.05;

  const plans = [
    buildPlan("Plan A", routeBase, readiness, safetyBuffer * breakFactor * 1.10, 0.70),
    buildPlan("Plan B", routeBase, readiness, safetyBuffer * breakFactor * 1.00, 0.85),
    buildPlan("Plan C", routeBase, readiness, safetyBuffer * breakFactor * 0.95, 1.00),
  ];

  const guidance =
    readiness <= 2
      ? "Heute konservativ planen. Plan A empfohlen. Wenn Unsicherheit entsteht: früh umdrehen."
      : readiness <= 3
      ? "Plan A oder B sind realistisch. Plane Pausen bewusst ein."
      : "Plan B ist gut machbar. Plan C nur, wenn du dich unterwegs stabil fühlst.";

  return { plans, readiness, guidance };
}

function buildPlan(label, base, readiness, timeMultiplier, intensityMultiplier) {
  const adjDistance = round(base.distanceKm * intensityMultiplier, 1);
  const adjHm = Math.round((base.elevationM || 0) * intensityMultiplier);

  const readinessPenalty = readiness <= 2 ? 1.25 : readiness === 3 ? 1.1 : 1.0;
  const durationMin = Math.round(base.durationMin * timeMultiplier * readinessPenalty);

  const turnBackPct = readiness <= 2 ? 0.40 : readiness === 3 ? 0.48 : 0.55;

  const abortPoints = [
    { when: "nach 20–30 min", note: "Check-in: Atmung, Schmerz, Kopf frei? Wenn nicht: zurück." },
    { when: `${Math.round(turnBackPct * 100)}% der Strecke`, note: "Umkehrpunkt: Wenn du zweifelst, dreh hier um." },
    { when: "bei Wetter-/Bodenwechsel", note: "Wenn Bedingungen kippen: Plan A nutzen oder Exit-Layer." },
  ];

  return {
    label,
    distanceKm: adjDistance,
    elevationM: adjHm,
    durationMin,
    turnBackPct,
    abortPoints,
    riskNote: readiness <= 2 && label !== "Plan A" ? "Heute nicht empfohlen." : "Machbar mit Aufmerksamkeit.",
  };
}

function generatePacklist({ profile, daily, weather }) {
  const items = [];
  add(items, "Wasser", "Stabilisiert Energie & reduziert Stress bei Pausen.");
  if (weather.rainChance >= 40) add(items, "Regenjacke", "Regen erhöht Kälte- und Erschöpfungsdruck.");
  if (weather.windKmh >= 25) add(items, "Zusätzliche Wärmeschicht", "Wind verstärkt Auskühlung.");
  if (profile.breakNeed >= 4) add(items, "Sitzunterlage", "Pausen werden leichter und planbarer.");
  if (daily.painToday >= 4) add(items, "Support-Item (z.B. Bandage)", "Hilft, Abbruch nicht zur Krise werden zu lassen.");
  if (daily.anxietyToday >= 4) add(items, "Beruhigungsanker", "Reduziert mentale Überforderung unterwegs.");
  add(items, "Akku/Offline", "Damit Safety-Inhalte verfügbar bleiben.");
  return items;
}
function add(list, name, why){ list.push({name, why}); }

// ---------- Overpass: echte Hiking-Routen ----------
const PLACES = {
  "München": { key: "munich", lat: 48.137154, lon: 11.576124 },
  "Salzburg": { key: "salzburg", lat: 47.80949, lon: 13.05501 },
  "Innsbruck": { key: "innsbruck", lat: 47.2682, lon: 11.3923 },
  "Garmisch": { key: "garmisch", lat: 47.4921, lon: 11.0958 }
};

async function overpass(query){
  // robust gegen CORS/last
  const url = "https://overpass-api.de/api/interpreter";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });
  if (!resp.ok) throw new Error("Overpass Fehler: " + resp.status);
  return await resp.json();
}

function kmFromCoords(coords){
  // Haversine über Segmente
  let km = 0;
  for (let i=1; i<coords.length; i++){
    const [lat1, lon1] = coords[i-1];
    const [lat2, lon2] = coords[i];
    km += haversineKm(lat1, lon1, lat2, lon2);
  }
  return km;
}
function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2-lat1) * Math.PI/180;
  const dLon = (lon2-lon1) * Math.PI/180;
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

async function searchHikingRoutes(placeName, radiusKm=15){
  const place = PLACES[placeName];
  if (!place) throw new Error("Unbekannter Ort");
  const radiusM = Math.round(radiusKm * 1000);

  // Nur Relations mit route=hiking in Umkreis, nur Tags ausgeben (schnell)
  const q = `
    [out:json][timeout:25];
    (
      rel(around:${radiusM},${place.lat},${place.lon})["route"="hiking"];
    );
    out tags 30;
  `;
  const data = await overpass(q);
  const rels = (data.elements || []).filter(e => e.type === "relation");

  // Aufräumen + Top-Liste
  const cleaned = rels.map(r => ({
    id: r.id,
    name: r.tags?.name || "Unbenannte Route",
    network: r.tags?.network || r.tags?.osmc_symbol || ""
  }));

  // Duplikate grob entfernen
  const seen = new Set();
  const unique = [];
  for (const r of cleaned){
    const k = (r.name + "|" + r.network).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }

  return { placeKey: place.key, radiusM, results: unique.slice(0, 10) };
}

async function loadRouteGeometry(relationId){
  // Relation + Member-Ways mit Geometrie laden
  const q = `
    [out:json][timeout:45];
    rel(${relationId});
    (._;>;);
    out geom;
  `;
  const data = await overpass(q);

  // Wege sammeln und Koordinaten zusammensetzen (einfach: alle Way-Geometrien hintereinander)
  const ways = (data.elements || []).filter(e => e.type === "way" && Array.isArray(e.geometry));
  const coords = [];
  for (const w of ways){
    for (const g of w.geometry){
      coords.push([g.lat, g.lon]);
    }
  }
  if (coords.length < 2) throw new Error("Keine Geometrie gefunden (Route evtl. sehr groß/komplex).");

  const dist = kmFromCoords(coords);

  // Name der Relation aus data holen
  const rel = (data.elements || []).find(e => e.type === "relation" && e.id === relationId);
  const name = rel?.tags?.name || "Route";
  const network = rel?.tags?.network || "";

  return { id: relationId, name, network, coords, distanceKm: round(dist, 1) };
}

// ---------- UI / Cards ----------
function render(){
  chatEl.innerHTML = "";

  for (const m of state.history){
    const row = document.createElement("div");
    row.className = `msg ${m.role}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = m.role === "bot" ? `SafeTrek • ${m.t}` : `Du • ${m.t}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;

    const wrap = document.createElement("div");
    wrap.appendChild(meta);
    wrap.appendChild(bubble);
    row.appendChild(wrap);
    chatEl.appendChild(row);

    if (m.role === "bot" && m.text.startsWith("[CARDS:ROUTE_LIST]") && state.routeSearch){
      chatEl.appendChild(routeListCard(state.routeSearch));
    }
    if (m.role === "bot" && m.text.startsWith("[CARDS:ROUTE_MAP]") && state.route){
      chatEl.appendChild(routeMapCard(state.route));
      // map initialisieren sobald DOM da ist
      setTimeout(() => drawRouteOnMap(state.route), 80);
    }
    if (m.role === "bot" && m.text.startsWith("[CARDS:PLANS]") && state.lastPlans){
      chatEl.appendChild(plansCards(state.lastPlans));
    }
    if (m.role === "bot" && m.text.startsWith("[CARDS:PACKLIST]")){
      chatEl.appendChild(packlistCards());
    }
    if (m.role === "bot" && m.text.startsWith("[CARDS:EXIT]")){
      chatEl.appendChild(exitCards());
    }
  }

  window.requestAnimationFrame(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });

  renderQuickReplies();
}

function renderQuickReplies(){
  quickRepliesEl.innerHTML = "";
  const options = quickReplyOptions();
  for (const opt of options){
    const b = document.createElement("button");
    b.className = "qbtn";
    b.type = "button";
    b.textContent = opt;
    b.onclick = () => handleUserInput(opt);
    quickRepliesEl.appendChild(b);
  }
}

function quickReplyOptions(){
  const s = state.step;
  if (s === "ask_stamina") return ["1","2","3","4","5"];
  if (s === "ask_breakNeed") return ["1","2","3","4","5"];
  if (s === "ask_safety") return ["2","3","4","5"];
  if (s === "ask_energy") return ["1","2","3","4","5"];
  if (s === "ask_pain") return ["1","2","3","4","5"];
  if (s === "ask_anxiety") return ["1","2","3","4","5"];

  if (s === "route_place") return ["München", "Garmisch", "Salzburg", "Innsbruck"];
  if (s === "route_radius") return ["10", "15", "25"];

  if (s === "route_pick" && state.routeSearch){
    // zeige 1..N als Buttons
    return state.routeSearch.results.map((_, i) => String(i+1)).slice(0, 10).concat(["Zurück"]);
  }

  if (s === "after_plans") return ["Route wählen", "Packliste", "Assisted Exit", "Neue Tagesform", "Profil ändern"];
  if (s === "after_packlist") return ["Zurück zu Plänen", "Assisted Exit", "Route wählen", "Neue Tagesform"];
  if (s === "after_exit") return ["Zurück zu Plänen", "Packliste", "Route wählen", "Neue Tagesform"];
  return [];
}

// ----- Cards -----
function routeListCard(search){
  const wrap = document.createElement("div");
  wrap.className = "card";
  const h = document.createElement("h3");
  h.textContent = "Routen in der Nähe (OSM)";
  wrap.appendChild(h);

  const p = document.createElement("p");
  p.textContent = "Tippe eine Zahl (1–10), um eine Route zu laden.";
  wrap.appendChild(p);

  search.results.forEach((r, idx) => {
    const line = document.createElement("p");
    line.className = "smallmuted";
    line.textContent = `${idx+1}. ${r.name}${r.network ? " • " + r.network : ""}`;
    wrap.appendChild(line);
  });

  return wrap;
}

function routeMapCard(route){
  const wrap = document.createElement("div");
  wrap.className = "card";

  const h = document.createElement("h3");
  h.textContent = route.name;
  wrap.appendChild(h);

  const p = document.createElement("p");
  p.textContent = `Distanz (berechnet): ~${route.distanceKm} km • Quelle: OpenStreetMap`;
  wrap.appendChild(p);

  const map = document.createElement("div");
  map.className = "mapBox";
  map.id = "map";
  wrap.appendChild(map);

  const hint = document.createElement("p");
  hint.className = "smallmuted";
  hint.textContent = "Hinweis: Für Beta werden Höhenmeter/Schwierigkeit später ergänzt.";
  wrap.appendChild(hint);

  return wrap;
}

function drawRouteOnMap(route){
  ensureMap("map");
  if (!leafletMap || !route?.coords?.length) return;

  if (leafletLine){
    leafletLine.remove();
    leafletLine = null;
  }

  leafletLine = L.polyline(route.coords, { weight: 4 }).addTo(leafletMap);
  leafletMap.fitBounds(leafletLine.getBounds(), { padding: [20, 20] });
}

// ----- Existing cards -----
function plansCards(result){
  const wrap = document.createElement("div");
  wrap.className = "card";

  const h = document.createElement("h3");
  h.textContent = "Touren-Optionen (Beta)";
  wrap.appendChild(h);

  const p = document.createElement("p");
  p.textContent = `Readiness: ${result.readiness.toFixed(1)} / 5 — ${result.guidance}`;
  wrap.appendChild(p);

  if (state.route){
    const rr = document.createElement("p");
    rr.className = "smallmuted";
    rr.textContent = `Aktive Route: ${state.route.name} (~${state.route.distanceKm} km)`;
    wrap.appendChild(rr);
  } else {
    const rr = document.createElement("p");
    rr.className = "smallmuted";
    rr.textContent = `Tipp: Wähle eine Route, damit Plan A/B/C realistischer wird.`;
    wrap.appendChild(rr);
  }

  for (const plan of result.plans){
    const box = document.createElement("div");
    box.className = "card";
    const hh = document.createElement("h3");
    hh.textContent = plan.label;
    box.appendChild(hh);

    const pills = document.createElement("div");
    pills.innerHTML = `
      <span class="pill">Distanz: ${plan.distanceKm} km</span>
      <span class="pill">Dauer: ${plan.durationMin} min</span>
    `;
    box.appendChild(pills);

    const note = document.createElement("p");
    note.textContent = plan.riskNote;
    box.appendChild(note);

    const ap = document.createElement("p");
    ap.textContent = "Abbruchpunkte:";
    box.appendChild(ap);

    for (const a of plan.abortPoints){
      const li = document.createElement("p");
      li.style.margin = "4px 0";
      li.style.color = "var(--muted)";
      li.textContent = `• ${a.when}: ${a.note}`;
      box.appendChild(li);
    }

    wrap.appendChild(box);
  }
  return wrap;
}

function packlistCards(){
  const wrap = document.createElement("div");
  wrap.className = "card";

  const h = document.createElement("h3");
  h.textContent = "Packliste (begründet)";
  wrap.appendChild(h);

  const items = generatePacklist({
    profile: state.profile,
    daily: state.daily,
    weather: { tempC: 12, rainChance: 45, windKmh: 18 }
  });

  for (const it of items){
    const box = document.createElement("div");
    box.className = "card";
    const t = document.createElement("h3");
    t.textContent = it.name;
    const w = document.createElement("p");
    w.textContent = it.why;
    box.appendChild(t); box.appendChild(w);
    wrap.appendChild(box);
  }
  return wrap;
}

function exitCards(){
  const wrap = document.createElement("div");
  wrap.className = "card";
  const h = document.createElement("h3");
  h.textContent = "Assisted Exit (geplanter Rückzug)";
  wrap.appendChild(h);

  const p = document.createElement("p");
  p.textContent = "Kein Notruf. Diese Infos helfen dir beim sicheren Rückzug, wenn du nicht weiterkannst.";
  wrap.appendChild(p);

  const exits = [
    { title: "Abholpunkt A", detail: "Parkplatz Nord • 25–35 min • mögliche Abholung/Taxi" },
    { title: "Abholpunkt B", detail: "Bushaltestelle Tal • 40–55 min • letzte Verbindung prüfen" },
    { title: "Rückweg-Option", detail: "Forstweg statt Steig • weniger Risiko bei Müdigkeit/Nässe" }
  ];

  for (const e of exits){
    const box = document.createElement("div");
    box.className = "card";
    const t = document.createElement("h3");
    t.textContent = e.title;
    const d = document.createElement("p");
    d.textContent = e.detail;
    box.appendChild(t); box.appendChild(d);
    wrap.appendChild(box);
  }
  return wrap;
}

// ---------- Conversation Flow ----------
function startIfEmpty(){
  if (state.history.length === 0){
    pushMsg("bot", "Hi, ich bin SafeTrek (Beta). Ich helfe dir, heute eine sichere und machbare Entscheidung für draußen zu treffen — ohne Leistungsdruck.");
    pushMsg("bot", "Vorab: Das ist kein Notruf und kein Ersatz für alpine Beratung. Wenn Gefahr besteht: bitte lokale Rettungsdienste kontaktieren.");
    state.step = "ask_stamina";
    saveState();
    pushMsg("bot", "Zum Profil: Wie ist deine grundsätzliche Belastbarkeit? (1–5)");
  } else {
    render();
  }
}

async function handleUserInput(text){
  const raw = String(text ?? "").trim();
  if (!raw) return;

  pushMsg("user", raw);

  if (state.step === "ask_stamina"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot", "Bitte antworte mit 1–5. Wie ist deine Belastbarkeit?");
    state.profile.stamina = n;
    state.step = "ask_breakNeed";
    saveState();
    return pushMsg("bot", "Wie hoch ist dein Pausenbedarf? (1–5)");
  }

  if (state.step === "ask_breakNeed"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot", "Bitte 1–5. Wie hoch ist dein Pausenbedarf?");
    state.profile.breakNeed = n;
    state.step = "ask_safety";
    saveState();
    return pushMsg("bot", "Wie wichtig ist dir ein konservativer Sicherheits-Puffer? (2–5)");
  }

  if (state.step === "ask_safety"){
    const n = toInt1to5(raw);
    if (!n || n < 2) return pushMsg("bot", "Bitte 2–5. Wie wichtig ist dir Sicherheit/Puffer?");
    state.profile.safety = n;
    state.step = "ask_energy";
    saveState();
    pushMsg("bot", "Danke. Jetzt Tagesform-Check.");
    return pushMsg("bot", "Wie ist deine Energie heute? (1–5)");
  }

  if (state.step === "ask_energy"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot", "Bitte 1–5. Wie ist deine Energie heute?");
    state.daily.energyToday = n;
    state.step = "ask_pain";
    saveState();
    return pushMsg("bot", "Wie hoch ist heute Schmerz/Körperstress? (1–5)");
  }

  if (state.step === "ask_pain"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot", "Bitte 1–5. Wie hoch ist heute Schmerz/Körperstress?");
    state.daily.painToday = n;
    state.step = "ask_anxiety";
    saveState();
    return pushMsg("bot", "Wie hoch ist heute mentale Überforderung/Unsicherheit? (1–5)");
  }

  if (state.step === "ask_anxiety"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot", "Bitte 1–5. Wie hoch ist heute mentale Überforderung?");
    state.daily.anxietyToday = n;

    // RouteBase: wenn Route gewählt wurde, nehmen wir Distanz aus echter Route
    const baseDistance = state.route?.distanceKm ?? 7.5;
    const routeBase = { distanceKm: baseDistance, elevationM: 0, durationMin: Math.round(baseDistance * 22) }; // grob: 22 min/km inkl. Puffer
    const result = generatePlans({ profile: state.profile, daily: state.daily, routeBase });

    state.lastPlans = result;
    state.step = "after_plans";
    saveState();

    pushMsg("bot", "[CARDS:PLANS]");
    return pushMsg("bot", "Was möchtest du als Nächstes? Route wählen, Packliste oder Assisted Exit?");
  }

  // Route flow
  if (state.step === "route_place"){
    if (!PLACES[raw]) return pushMsg("bot", "Bitte wähle: München, Garmisch, Salzburg oder Innsbruck.");
    state.routeSearch = { placeKey: raw, radiusM: 15000, results: [] };
    state.step = "route_radius";
    saveState();
    return pushMsg("bot", "Radius in km? (z.B. 10 / 15 / 25)");
  }

  if (state.step === "route_radius"){
    const km = Number(raw);
    if (![10,15,25].includes(km)) return pushMsg("bot", "Bitte 10, 15 oder 25 auswählen.");
    pushMsg("bot", "Suche Routen… (das kann 5–15 Sekunden dauern)");
    try{
      const res = await searchHikingRoutes(state.routeSearch.placeKey, km);
      state.routeSearch = { placeKey: state.routeSearch.placeKey, radiusM: res.radiusM, results: res.results };
      state.step = "route_pick";
      saveState();
      pushMsg("bot", "[CARDS:ROUTE_LIST]");
      return pushMsg("bot", "Tippe die Nummer der Route (1–10).");
    }catch(e){
      state.step = "after_plans";
      saveState();
      return pushMsg("bot", "Route-Suche ist gerade schwierig (Overpass ist manchmal langsam). Versuch es gleich nochmal oder wähle einen kleineren Radius.");
    }
  }

  if (state.step === "route_pick"){
    if (raw.toLowerCase().includes("zurück")) {
      state.step = "after_plans";
      saveState();
      pushMsg("bot", "[CARDS:PLANS]");
      return pushMsg("bot", "Okay — zurück zu den Plänen.");
    }
    const idx = Number(raw) - 1;
    const pick = state.routeSearch?.results?.[idx];
    if (!pick) return pushMsg("bot", "Bitte eine Zahl 1–10 wählen.");
    pushMsg("bot", "Lade Route… (Geometrie & Karte)");
    try{
      const route = await loadRouteGeometry(pick.id);
      state.route = route;
      state.step = "after_plans";
      saveState();
      pushMsg("bot", "[CARDS:ROUTE_MAP]");
      pushMsg("bot", "Route gesetzt. Wenn du willst: „Neue Tagesform“ → Pläne basieren dann auf dieser Route.");
      pushMsg("bot", "[CARDS:PLANS]");
      return pushMsg("bot", "Was möchtest du als Nächstes?");
    }catch(e){
      state.step = "after_plans";
      saveState();
      return pushMsg("bot", "Diese Route ist zu komplex/leer für die Beta-Darstellung. Nimm eine andere Route (oder kleineren Radius).");
    }
  }

  // Menus
  if (state.step === "after_plans" || state.step === "after_packlist" || state.step === "after_exit"){
    return handleMenu(raw);
  }

  pushMsg("bot", "Ich habe das nicht ganz verstanden. Tippe z.B. „Route wählen“, „Packliste“, „Assisted Exit“, „Neue Tagesform“ oder „Profil ändern“.");
}

function handleMenu(raw){
  const t = raw.toLowerCase();

  if (t.includes("route")){
    state.step = "route_place";
    saveState();
    return pushMsg("bot", "Für welche Gegend? (München, Garmisch, Salzburg, Innsbruck)");
  }

  if (t.includes("pack")){
    state.step = "after_packlist";
    saveState();
    pushMsg("bot", "[CARDS:PACKLIST]");
    return pushMsg("bot", "Packliste angezeigt. Möchtest du zurück zu Plänen oder zum Assisted Exit?");
  }

  if (t.includes("exit") || t.includes("rück") || t.includes("rueck")){
    state.step = "after_exit";
    saveState();
    pushMsg("bot", "[CARDS:EXIT]");
    return pushMsg("bot", "Assisted Exit angezeigt. Möchtest du zurück zu Plänen oder zur Packliste?");
  }

  if (t.includes("zurück") || t.includes("zurueck") || t.includes("plän") || t.includes("plan")){
    state.step = "after_plans";
    saveState();
    pushMsg("bot", "[CARDS:PLANS]");
    return pushMsg("bot", "Zurück zu den Optionen. Was möchtest du als Nächstes?");
  }

  if (t.includes("tagesform") || t.includes("neu")){
    state.daily = { energyToday: null, painToday: null, anxietyToday: null };
    state.lastPlans = null;
    state.step = "ask_energy";
    saveState();
    pushMsg("bot", "Okay — neuer Tagesform-Check.");
    return pushMsg("bot", "Wie ist deine Energie heute? (1–5)");
  }

  if (t.includes("profil")){
    state.profile = { stamina: null, breakNeed: null, safety: null };
    state.daily = { energyToday: null, painToday: null, anxietyToday: null };
    state.lastPlans = null;
    state.step = "ask_stamina";
    saveState();
    pushMsg("bot", "Alles klar — Profil neu.");
    return pushMsg("bot", "Wie ist deine grundsätzliche Belastbarkeit? (1–5)");
  }

  pushMsg("bot", "Optionen: „Route wählen“, „Packliste“, „Assisted Exit“, „Neue Tagesform“, „Profil ändern“.");
}

// ---------- Events ----------
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = input.value;
  input.value = "";
  handleUserInput(val);
});

resetBtn.addEventListener("click", () => {
  if (!confirm("Wirklich alles zurücksetzen?")) return;
  localStorage.removeItem(STORAGE_KEY);
  state = structuredClone(defaultState);
  render();
  startIfEmpty();
});

// ---------- Boot ----------
render();
startIfEmpty();
