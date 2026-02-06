/* SafeTrek – Full Beta (Routes + Weather + Assisted Exit + Plans + Packlist)
   Flow:
   1) Profil (Belastbarkeit, Pausen, Sicherheits-Puffer)
   2) Tagesform (Energie, Schmerz, mentale Überforderung)
   3) Frage: "Möchtest du Tourenvorschläge?"
   4) Region
   5) Route-Liste (saubere Wege) + Auswahl
   6) Route-Karte + Wetter + Assisted Exit POIs
   7) Pläne A/B/C + Packliste + Exit Details
*/

const chatEl = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const quickRepliesEl = document.getElementById("quickReplies");
const resetBtn = document.getElementById("resetBtn");

const STORAGE_KEY = "safetrek_full_beta_v4";

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// ---------- State ----------
const defaultState = {
  step: "start",
  profile: { stamina: null, breakNeed: null, safety: null },
  daily: { energy: null, pain: null, mental: null },

  wantsRoutes: null,
  region: null,
  radiusKm: 15,

  // Route candidates are OSM ways (ordered geometry -> no zigzag jumps)
  routeCandidates: [], // [{ id, name, lengthKm, center:[lat,lon] }]
  route: null,         // { id, name, coords:[[lat,lon]...], lengthKm, bbox }
  weather: null,       // { tempC, windKmh, rainChance }
  exits: [],           // [{ id, kind, name, lat, lon, distToRouteM }]

  plans: null,         // { readiness, guidance, plans:[...] }

  history: []
};

let state = loadState();

// ---------- Helpers ----------
function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    return { ...structuredClone(defaultState), ...JSON.parse(raw) };
  }catch{
    return structuredClone(defaultState);
  }
}
function resetAll(){
  localStorage.removeItem(STORAGE_KEY);
  state = structuredClone(defaultState);
  render();
  startIfEmpty();
}
function nowLabel(){
  const d = new Date();
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}
function pushMsg(role, text){
  state.history.push({ role, text, t: nowLabel() });
  saveState();
  render();
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function round(n,d=0){ const p = 10**d; return Math.round(n*p)/p; }
function toInt1to5(v){
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < 1 || r > 5) return null;
  return r;
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
function bboxFromCoords(coords){
  let minLat= 999, minLon= 999, maxLat= -999, maxLon= -999;
  for (const [lat,lon] of coords){
    minLat = Math.min(minLat, lat);
    minLon = Math.min(minLon, lon);
    maxLat = Math.max(maxLat, lat);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLat, minLon, maxLat, maxLon };
}
function lengthKmFromCoords(coords){
  let km=0;
  for (let i=1;i<coords.length;i++){
    const [a1,o1]=coords[i-1], [a2,o2]=coords[i];
    km += haversineKm(a1,o1,a2,o2);
  }
  return km;
}

// ---------- Regions ----------
const REGIONS = {
  "München":   { lat: 48.137154, lon: 11.576124 },
  "Garmisch":  { lat: 47.4921,   lon: 11.0958 },
  "Salzburg":  { lat: 47.80949,  lon: 13.05501 },
  "Innsbruck": { lat: 47.2682,   lon: 11.3923 }
};

// ---------- Overpass ----------
async function overpass(query){
  const url = "https://overpass-api.de/api/interpreter";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });
  if (!resp.ok) throw new Error("Overpass Fehler: " + resp.status);
  return await resp.json();
}

// We deliberately use WAY geometries (ordered) -> no “zigzag jump”
async function searchTrailWays(regionName, radiusKm){
  const r = REGIONS[regionName];
  if (!r) throw new Error("Unbekannte Region");
  const radiusM = Math.round(radiusKm * 1000);

  // Pull walkable ways with geometry around region center.
  // We filter later by length.
  const q = `
    [out:json][timeout:35];
    (
      way(around:${radiusM},${r.lat},${r.lon})["highway"~"path|footway|track"]["foot"!~"no"];
    );
    out tags geom;
  `;

  const data = await overpass(q);
  const ways = (data.elements || []).filter(e => e.type==="way" && Array.isArray(e.geometry) && e.geometry.length >= 25);

  const candidates = [];
  for (const w of ways){
    const coords = w.geometry.map(p => [p.lat, p.lon]);
    const km = lengthKmFromCoords(coords);
    if (km < 1.2 || km > 18) continue;          // keep sane “route-like” segments
    const name = w.tags?.name || w.tags?.ref || "Weg/Trail (OSM)";
    const center = coords[Math.floor(coords.length/2)];
    candidates.push({ id: w.id, name, lengthKm: round(km,1), center });
  }

  // Sort by “useful hiking-ish length” and unique names
  candidates.sort((a,b) => b.lengthKm - a.lengthKm);
  const seen = new Set();
  const unique = [];
  for (const c of candidates){
    const k = c.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(c);
    if (unique.length >= 10) break;
  }
  return unique;
}

async function loadWayGeometry(wayId){
  const q = `
    [out:json][timeout:35];
    way(${wayId});
    out tags geom;
  `;
  const data = await overpass(q);
  const w = (data.elements || [])[0];
  if (!w || !Array.isArray(w.geometry) || w.geometry.length < 10) throw new Error("Keine Geometrie");
  const coords = w.geometry.map(p => [p.lat, p.lon]);
  const km = round(lengthKmFromCoords(coords), 1);
  const name = w.tags?.name || w.tags?.ref || "Route (OSM Way)";
  return { id: wayId, name, coords, lengthKm: km, bbox: bboxFromCoords(coords) };
}

// ---------- Weather (Open-Meteo) ----------
async function fetchWeather(lat, lon){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,precipitation&hourly=precipitation_probability&forecast_days=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Weather API Fehler");
  const data = await resp.json();

  const tempC = data?.current?.temperature_2m ?? null;
  const windKmh = data?.current?.wind_speed_10m ?? null;

  let rainChance = null;
  const probs = data?.hourly?.precipitation_probability;
  if (Array.isArray(probs) && probs.length){
    rainChance = Math.max(...probs.slice(0, 12));
  }
  return { tempC, windKmh, rainChance };
}

// ---------- Assisted Exit POIs ----------
function distToRouteMeters(routeCoords, lat, lon){
  // approximate: min distance to any route vertex
  let bestKm = Infinity;
  for (let i=0; i<routeCoords.length; i+=2){ // stride a bit for speed
    const [rlat, rlon] = routeCoords[i];
    const km = haversineKm(rlat, rlon, lat, lon);
    if (km < bestKm) bestKm = km;
  }
  return Math.round(bestKm * 1000);
}

async function fetchExitPOIsNearRoute(route){
  // We query POIs in bounding box, then compute “distance to route”
  const b = route.bbox;

  const q = `
    [out:json][timeout:35];
    (
      node(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["amenity"="parking"];
      node(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["highway"="bus_stop"];
      node(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["railway"="station"];
      node(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["aerialway"="station"];
    );
    out tags;
  `;

  const data = await overpass(q);
  const nodes = (data.elements || []).filter(e => e.type==="node" && Number.isFinite(e.lat) && Number.isFinite(e.lon));

  const exits = [];
  for (const n of nodes){
    const kind =
      n.tags?.amenity === "parking" ? "Parkplatz" :
      n.tags?.highway === "bus_stop" ? "Bus" :
      n.tags?.railway === "station" ? "Bahn" :
      n.tags?.aerialway === "station" ? "Seilbahn" :
      "Exit";

    const name = n.tags?.name || kind;
    const distM = distToRouteMeters(route.coords, n.lat, n.lon);
    if (distM > 900) continue; // “Assisted Exit” should be realistically reachable

    exits.push({ id: n.id, kind, name, lat: n.lat, lon: n.lon, distToRouteM: distM });
  }

  exits.sort((a,b) => a.distToRouteM - b.distToRouteM);
  return exits.slice(0, 12);
}

// ---------- Decision Engine ----------
function computeReadiness(profile, daily){
  const stamina = Number(profile.stamina);
  const energy  = Number(daily.energy);
  const pain    = Number(daily.pain);
  const mental  = Number(daily.mental);

  const readiness = clamp(
    (stamina*1.2 + energy*1.5 + (6-pain)*1.0 + (6-mental)*0.8) / 4.5,
    1, 5
  );
  return readiness;
}

function estimateDurationMin(distanceKm, breakNeed, safety){
  // very simple: base pace 18–22 min/km + buffers
  const base = 20; // min/km
  const breakFactor = breakNeed >= 4 ? 1.25 : breakNeed === 3 ? 1.15 : 1.05;
  const safetyFactor = safety >= 4 ? 1.18 : safety === 3 ? 1.12 : 1.05;
  return Math.round(distanceKm * base * breakFactor * safetyFactor);
}

function buildPlans(routeKm, profile, daily, weather){
  const readiness = computeReadiness(profile, daily);
  const breakNeed = Number(profile.breakNeed);
  const safety = Number(profile.safety);

  const weatherPenalty =
    weather && ((weather.rainChance ?? 0) >= 65 || (weather.windKmh ?? 0) >= 30) ? 0.6 : 1.0;

  const baseKm = routeKm;
  const aKm = round(baseKm * 0.70 * weatherPenalty, 1);
  const bKm = round(baseKm * 0.85 * weatherPenalty, 1);
  const cKm = round(baseKm * 1.00 * weatherPenalty, 1);

  const aMin = estimateDurationMin(aKm, breakNeed, safety);
  const bMin = estimateDurationMin(bKm, breakNeed, safety);
  const cMin = estimateDurationMin(cKm, breakNeed, safety);

  let guidance = "";
  if (readiness <= 2.2) guidance = "Heute konservativ: Plan A empfohlen. Früh umdrehen ist Erfolg, nicht Scheitern.";
  else if (readiness <= 3.2) guidance = "Heute realistisch: Plan A oder B. Plane Pausen aktiv ein.";
  else guidance = "Heute stabil: Plan B gut machbar. Plan C nur, wenn du dich unterwegs weiterhin gut fühlst.";

  if (weatherPenalty < 1.0){
    guidance += " Wetter wirkt anspruchsvoller (Regen/Wind). Extra Puffer einplanen.";
  }

  function abortPointsFor(label){
    const pct = label==="A" ? 0.35 : label==="B" ? 0.45 : 0.55;
    return [
      { when: "nach 20–30 min", note: "Check-in: Atmung, Schmerz, Kopf frei? Wenn nein → zurück." },
      { when: `${Math.round(pct*100)}% der Strecke`, note: "Umkehrpunkt: Wenn du zweifelst, dreh hier um." },
      { when: "bei Wetter-/Bodenwechsel", note: "Wenn Bedingungen kippen: Abbrechen + Assisted Exit." }
    ];
  }

  return {
    readiness,
    guidance,
    plans: [
      { label:"Plan A", distanceKm:aKm, durationMin:aMin, abortPoints: abortPointsFor("A") },
      { label:"Plan B", distanceKm:bKm, durationMin:bMin, abortPoints: abortPointsFor("B") },
      { label:"Plan C", distanceKm:cKm, durationMin:cMin, abortPoints: abortPointsFor("C") }
    ]
  };
}

// ---------- Packlist ----------
function packlist(profile, daily, weather){
  const items = [];
  const breakNeed = Number(profile.breakNeed);
  const pain = Number(daily.pain);
  const mental = Number(daily.mental);

  items.push({ name:"Wasser", why:"Stabilisiert Energie & reduziert Stress bei Pausen." });
  items.push({ name:"Snack", why:"Hilft gegen Energieschwankungen und mentale Überforderung." });

  if ((weather?.rainChance ?? 0) >= 40) items.push({ name:"Regenjacke", why:"Regen erhöht Erschöpfungsdruck & Auskühlung." });
  if ((weather?.windKmh ?? 0) >= 25) items.push({ name:"Wärmeschicht", why:"Wind verstärkt Kälte, besonders bei Pausen." });
  if (breakNeed >= 4) items.push({ name:"Sitzunterlage", why:"Macht Pausen leichter & planbarer." });
  if (pain >= 4) items.push({ name:"Support-Item (Bandage etc.)", why:"Reduziert Risiko, dass Abbruch zur Krise wird." });
  if (mental >= 4) items.push({ name:"Beruhigungsanker", why:"Hilft gegen Überforderung (z.B. Atemkarte, Musik, Duft)." });

  items.push({ name:"Akku/Offline", why:"Damit Safety-Inhalte & Karte verfügbar bleiben." });
  return items;
}

// ---------- Leaflet Map ----------
let leafletMap = null;
let routePolyline = null;
let exitMarkers = [];

function ensureMap(containerId, center){
  const el = document.getElementById(containerId);
  if (!el || !window.L) return;

  if (!leafletMap){
    leafletMap = L.map(containerId, { zoomControl:true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom:18,
      attribution:"© OpenStreetMap"
    }).addTo(leafletMap);
  }

  setTimeout(() => leafletMap.invalidateSize(), 50);
  if (center) leafletMap.setView(center, 12);
}

function drawRouteAndExits(route, exits){
  ensureMap("map", route.coords[0]);

  // clear previous
  if (routePolyline){ routePolyline.remove(); routePolyline = null; }
  for (const m of exitMarkers) m.remove();
  exitMarkers = [];

  routePolyline = L.polyline(route.coords, { weight:4 }).addTo(leafletMap);
  leafletMap.fitBounds(routePolyline.getBounds(), { padding:[20,20] });

  for (const e of exits){
    const color =
      e.kind==="Bahn" ? "#60a5fa" :
      e.kind==="Bus" ? "#34d399" :
      e.kind==="Seilbahn" ? "#fbbf24" :
      e.kind==="Parkplatz" ? "#a78bfa" : "#ffffff";

    const m = L.circleMarker([e.lat, e.lon], { radius:6, weight:2, color }).addTo(leafletMap);
    m.bindPopup(`${e.kind}: ${e.name}<br>~${e.distToRouteM} m von der Route`);
    exitMarkers.push(m);
  }
}

// ---------- UI Rendering ----------
function render(){
  chatEl.innerHTML = "";
  for (const m of state.history){
    const row = document.createElement("div");
    row.className = `msg ${m.role}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = m.role==="bot" ? `SafeTrek • ${m.t}` : `Du • ${m.t}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;

    const wrap = document.createElement("div");
    wrap.appendChild(meta);
    wrap.appendChild(bubble);
    row.appendChild(wrap);
    chatEl.appendChild(row);

    if (m.role==="bot" && m.text==="[CARDS:ROUTE_LIST]"){
      chatEl.appendChild(routeListCard());
    }
    if (m.role==="bot" && m.text==="[CARDS:ROUTE_OVERVIEW]" && state.route){
      chatEl.appendChild(routeOverviewCard());
      setTimeout(() => drawRouteAndExits(state.route, state.exits), 120);
    }
    if (m.role==="bot" && m.text==="[CARDS:PLANS]" && state.plans){
      chatEl.appendChild(plansCard());
    }
    if (m.role==="bot" && m.text==="[CARDS:PACKLIST]" && state.route){
      chatEl.appendChild(packlistCard());
    }
    if (m.role==="bot" && m.text==="[CARDS:EXIT]" && state.exits.length){
      chatEl.appendChild(exitCard());
    }
  }

  window.requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  renderQuickReplies();
}

function renderQuickReplies(){
  quickRepliesEl.innerHTML = "";
  const opts = quickOptions();
  for (const opt of opts){
    const b = document.createElement("button");
    b.className = "qbtn";
    b.type="button";
    b.textContent = opt;
    b.onclick = () => handleUserInput(opt);
    quickRepliesEl.appendChild(b);
  }
}

function quickOptions(){
  switch(state.step){
    case "ask_stamina": return ["1","2","3","4","5"];
    case "ask_breakNeed": return ["1","2","3","4","5"];
    case "ask_safety": return ["2","3","4","5"];
    case "ask_energy": return ["1","2","3","4","5"];
    case "ask_pain": return ["1","2","3","4","5"];
    case "ask_mental": return ["1","2","3","4","5"];
    case "ask_wantsRoutes": return ["Ja", "Nein"];
    case "ask_region": return Object.keys(REGIONS);
    case "ask_radius": return ["10","15","25"];
    case "pick_route":
      return state.routeCandidates.map((_,i)=>String(i+1)).concat(["Neu suchen", "Abbrechen"]);
    case "after_route":
      return ["Pläne berechnen", "Assisted Exit", "Packliste", "Andere Route", "Neue Tagesform"];
    case "after_plans":
      return ["Assisted Exit", "Packliste", "Andere Route", "Neue Tagesform"];
    case "after_packlist":
      return ["Zurück zu Plänen", "Assisted Exit", "Andere Route"];
    case "after_exit":
      return ["Zurück zu Plänen", "Packliste", "Andere Route"];
    default: return [];
  }
}

// ---------- Cards ----------
function routeListCard(){
  const wrap = document.createElement("div");
  wrap.className="card";

  const h = document.createElement("h3");
  h.textContent = `Routen-Vorschläge (${state.region}, ${state.radiusKm} km)`;
  wrap.appendChild(h);

  const p = document.createElement("p");
  p.textContent = "Wähle eine Nummer. (Diese Vorschläge sind saubere, zusammenhängende Wege aus OpenStreetMap – keine wirren Linien.)";
  wrap.appendChild(p);

  const list = document.createElement("div");
  for (let i=0;i<state.routeCandidates.length;i++){
    const c = state.routeCandidates[i];
    const line = document.createElement("p");
    line.className="smallmuted";
    line.textContent = `${i+1}. ${c.name} • ~${c.lengthKm} km`;
    list.appendChild(line);
  }
  wrap.appendChild(list);
  return wrap;
}

function routeOverviewCard(){
  const wrap = document.createElement("div");
  wrap.className="card";

  const h = document.createElement("h3");
  h.textContent = state.route.name;
  wrap.appendChild(h);

  const pills = document.createElement("div");
  pills.className="pills";
  pills.innerHTML = `
    <span class="pill">Distanz: ~${state.route.lengthKm} km</span>
    <span class="pill">Region: ${state.region}</span>
    <span class="pill">Exit-Punkte: ${state.exits.length}</span>
  `;
  wrap.appendChild(pills);

  if (state.weather){
    const w = state.weather;
    const risk =
      (w.rainChance ?? 0) >= 65 || (w.windKmh ?? 0) >= 30 ? "warn" : "good";
    const riskLabel = risk==="warn" ? "Wetter erhöht Risiko" : "Wetter ok";
    const badgeClass = risk==="warn" ? "warn" : "good";

    const line = document.createElement("p");
    line.innerHTML = `Wetter: <span class="badge ${badgeClass}">${riskLabel}</span> — ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regenrisiko ~${w.rainChance ?? "?"}%`;
    wrap.appendChild(line);
  } else {
    const line = document.createElement("p");
    line.textContent = "Wetter: konnte gerade nicht geladen werden.";
    wrap.appendChild(line);
  }

  const map = document.createElement("div");
  map.className="mapBox";
  map.id="map";
  wrap.appendChild(map);

  const hint = document.createElement("p");
  hint.className="smallmuted";
  hint.textContent = "Grüne Marker = Assisted Exit Optionen (Bus/Bahn/Parkplatz/Seilbahn) in Routennähe.";
  wrap.appendChild(hint);

  return wrap;
}

function plansCard(){
  const wrap = document.createElement("div");
  wrap.className="card";

  const h = document.createElement("h3");
  h.textContent="Plan A/B/C – personalisiert";
  wrap.appendChild(h);

  const r = state.plans.readiness;
  const badge = r <= 2.2 ? ["bad","konservativ"] : r <= 3.2 ? ["warn","realistisch"] : ["good","stabil"];
  const p = document.createElement("p");
  p.innerHTML = `Readiness: <span class="badge ${badge[0]}">${r.toFixed(1)} / 5 (${badge[1]})</span>`;
  wrap.appendChild(p);

  const g = document.createElement("p");
  g.textContent = state.plans.guidance;
  wrap.appendChild(g);

  for (const plan of state.plans.plans){
    const box = document.createElement("div");
    box.className="card";

    const hh = document.createElement("h3");
    hh.textContent = plan.label;
    box.appendChild(hh);

    const pills = document.createElement("div");
    pills.className="pills";
    pills.innerHTML = `
      <span class="pill">Distanz: ${plan.distanceKm} km</span>
      <span class="pill">Dauer: ${plan.durationMin} min</span>
    `;
    box.appendChild(pills);

    const ap = document.createElement("p");
    ap.textContent = "Abbruchpunkte:";
    box.appendChild(ap);

    for (const a of plan.abortPoints){
      const li = document.createElement("p");
      li.className="smallmuted";
      li.textContent = `• ${a.when}: ${a.note}`;
      box.appendChild(li);
    }

    wrap.appendChild(box);
  }

  return wrap;
}

function packlistCard(){
  const wrap = document.createElement("div");
  wrap.className="card";
  const h = document.createElement("h3");
  h.textContent="Packliste (begründet)";
  wrap.appendChild(h);

  const items = packlist(state.profile, state.daily, state.weather);
  for (const it of items){
    const box = document.createElement("div");
    box.className="card";
    const t = document.createElement("h3");
    t.textContent = it.name;
    const w = document.createElement("p");
    w.textContent = it.why;
    box.appendChild(t); box.appendChild(w);
    wrap.appendChild(box);
  }
  return wrap;
}

function exitCard(){
  const wrap = document.createElement("div");
  wrap.className="card";
  const h = document.createElement("h3");
  h.textContent="Assisted Exit – echte Optionen";
  wrap.appendChild(h);

  const p = document.createElement("p");
  p.textContent="Kein Notruf. Das sind reale, nahe Punkte (aus OpenStreetMap) für Rückzug/Abholung/ÖPNV.";
  wrap.appendChild(p);

  for (const e of state.exits.slice(0, 10)){
    const box = document.createElement("div");
    box.className="card";
    const t = document.createElement("h3");
    t.textContent = `${e.kind}: ${e.name}`;
    const d = document.createElement("p");
    d.textContent = `~${e.distToRouteM} m von der Route`;
    box.appendChild(t); box.appendChild(d);
    wrap.appendChild(box);
  }
  return wrap;
}

// ---------- Conversation Flow ----------
function startIfEmpty(){
  if (state.history.length === 0){
    pushMsg("bot", "Hi, ich bin SafeTrek (Beta). Ich helfe dir, heute eine sichere und machbare Entscheidung für draußen zu treffen — ohne Leistungsdruck.");
    pushMsg("bot", "Vorab: Kein Notruf und kein Ersatz für alpine Beratung/Bergrettung.");
    state.step="ask_stamina";
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

  // --- Profile ---
  if (state.step==="ask_stamina"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot","Bitte 1–5. Wie ist deine Belastbarkeit?");
    state.profile.stamina = n;
    state.step="ask_breakNeed"; saveState();
    return pushMsg("bot","Wie hoch ist dein Pausenbedarf? (1–5)");
  }

  if (state.step==="ask_breakNeed"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot","Bitte 1–5. Wie hoch ist dein Pausenbedarf?");
    state.profile.breakNeed = n;
    state.step="ask_safety"; saveState();
    return pushMsg("bot","Wie wichtig ist dir ein konservativer Sicherheits-Puffer? (2–5)");
  }

  if (state.step==="ask_safety"){
    const n = toInt1to5(raw);
    if (!n || n<2) return pushMsg("bot","Bitte 2–5. Wie wichtig ist dir Sicherheit/Puffer?");
    state.profile.safety = n;
    state.step="ask_energy"; saveState();
    pushMsg("bot","Danke. Jetzt Tagesform-Check.");
    return pushMsg("bot","Wie ist deine Energie heute? (1–5)");
  }

  // --- Daily ---
  if (state.step==="ask_energy"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot","Bitte 1–5. Wie ist deine Energie heute?");
    state.daily.energy = n;
    state.step="ask_pain"; saveState();
    return pushMsg("bot","Wie hoch ist heute Schmerz/Körperstress? (1–5)");
  }

  if (state.step==="ask_pain"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot","Bitte 1–5. Wie hoch ist heute Schmerz/Körperstress?");
    state.daily.pain = n;
    state.step="ask_mental"; saveState();
    return pushMsg("bot","Wie hoch ist heute mentale Überforderung/Unsicherheit? (1–5)");
  }

  if (state.step==="ask_mental"){
    const n = toInt1to5(raw);
    if (!n) return pushMsg("bot","Bitte 1–5. Wie hoch ist heute mentale Überforderung?");
    state.daily.mental = n;
    state.step="ask_wantsRoutes"; saveState();
    return pushMsg("bot","Möchtest du heute Tourenvorschläge erhalten?");
  }

  // --- Want Routes ---
  if (state.step==="ask_wantsRoutes"){
    const t = raw.toLowerCase();
    if (t.startsWith("n")) {
      state.wantsRoutes = false; saveState();
      state.step="idle";
      return pushMsg("bot","Okay. Wenn du später willst: tippe einfach „Route“.");
    }
    state.wantsRoutes = true; saveState();
    state.step="ask_region";
    return pushMsg("bot","In welcher Region möchtest du unterwegs sein? (München, Garmisch, Salzburg, Innsbruck)");
  }

  // --- Region & Radius ---
  if (state.step==="ask_region"){
    if (!REGIONS[raw]) return pushMsg("bot","Bitte wähle: München, Garmisch, Salzburg oder Innsbruck.");
    state.region = raw;
    state.step="ask_radius"; saveState();
    return pushMsg("bot","Wie groß soll der Suchradius sein? (10 / 15 / 25 km)");
  }

  if (state.step==="ask_radius"){
    const km = Number(raw);
    if (![10,15,25].includes(km)) return pushMsg("bot","Bitte 10, 15 oder 25 wählen.");
    state.radiusKm = km;
    state.routeCandidates = [];
    state.route = null;
    state.weather = null;
    state.exits = [];
    state.plans = null;
    saveState();

    pushMsg("bot","Suche saubere Routen… (das kann 5–20 Sekunden dauern)");
    try{
      const candidates = await searchTrailWays(state.region, state.radiusKm);
      if (!candidates.length){
        state.step="ask_radius"; saveState();
        return pushMsg("bot","Ich habe gerade keine geeigneten Wege gefunden. Versuch bitte einen anderen Radius oder eine andere Region.");
      }
      state.routeCandidates = candidates;
      state.step="pick_route"; saveState();
      pushMsg("bot","[CARDS:ROUTE_LIST]");
      return pushMsg("bot","Tippe die Nummer der Route (1–10).");
    }catch(e){
      state.step="ask_radius"; saveState();
      return pushMsg("bot","Route-Suche ist gerade langsam (OSM/Overpass). Versuch es gleich nochmal.");
    }
  }

  // --- Pick Route ---
  if (state.step==="pick_route"){
    const low = raw.toLowerCase();
    if (low.includes("abbrechen")){
      state.step="idle"; saveState();
      return pushMsg("bot","Okay — abgebrochen.");
    }
    if (low.includes("neu")){
      state.step="ask_radius"; saveState();
      return pushMsg("bot","Okay. Welcher Radius? (10 / 15 / 25 km)");
    }
    const idx = Number(raw) - 1;
    const pick = state.routeCandidates[idx];
    if (!pick) return pushMsg("bot","Bitte eine Zahl 1–10 wählen, oder „Neu suchen“.");

    pushMsg("bot","Lade Route, Wetter und Assisted Exit…");
    try{
      // route
      const route = await loadWayGeometry(pick.id);
      state.route = route;

      // weather at start
      const [lat, lon] = route.coords[0];
      try{
        state.weather = await fetchWeather(lat, lon);
      }catch{
        state.weather = null;
      }

      // exits near route
      try{
        state.exits = await fetchExitPOIsNearRoute(route);
      }catch{
        state.exits = [];
      }

      state.step="after_route";
      saveState();

      pushMsg("bot","[CARDS:ROUTE_OVERVIEW]");
      return pushMsg("bot","Route ist gesetzt. Was möchtest du jetzt?");
    }catch(e){
      state.step="pick_route"; saveState();
      return pushMsg("bot","Diese Route konnte ich nicht sauber laden. Bitte eine andere auswählen.");
    }
  }

  // --- After Route ---
  if (state.step==="after_route"){
    const t = raw.toLowerCase();

    if (t.includes("pläne") || t.includes("plaene")){
      state.plans = buildPlans(state.route.lengthKm, state.profile, state.daily, state.weather);
      state.step="after_plans"; saveState();
      pushMsg("bot","[CARDS:PLANS]");
      return pushMsg("bot","Möchtest du Assisted Exit oder Packliste sehen?");
    }

    if (t.includes("exit")){
      state.step="after_exit"; saveState();
      pushMsg("bot","[CARDS:EXIT]");
      return pushMsg("bot","Okay. Möchtest du zurück zu Plänen oder zur Packliste?");
    }

    if (t.includes("pack")){
      state.step="after_packlist"; saveState();
      pushMsg("bot","[CARDS:PACKLIST]");
      return pushMsg("bot","Packliste angezeigt. Möchtest du zurück zu Plänen oder zum Assisted Exit?");
    }

    if (t.includes("andere")){
      state.step="pick_route"; saveState();
      pushMsg("bot","[CARDS:ROUTE_LIST]");
      return pushMsg("bot","Wähle eine neue Route (1–10) oder „Neu suchen“.");
    }

    if (t.includes("tagesform") || t.includes("neu")){
      state.daily = { energy:null, pain:null, mental:null };
      state.plans = null;
      state.step="ask_energy"; saveState();
      return pushMsg("bot","Okay — neuer Tagesform-Check. Wie ist deine Energie heute? (1–5)");
    }

    return pushMsg("bot","Optionen: „Pläne berechnen“, „Assisted Exit“, „Packliste“, „Andere Route“, „Neue Tagesform“.");
  }

  // --- After Plans / Packlist / Exit ---
  if (state.step==="after_plans"){
    const t = raw.toLowerCase();
    if (t.includes("exit")){
      state.step="after_exit"; saveState();
      pushMsg("bot","[CARDS:EXIT]");
      return pushMsg("bot","Assisted Exit angezeigt. Möchtest du zur Packliste oder zurück zu Plänen?");
    }
    if (t.includes("pack")){
      state.step="after_packlist"; saveState();
      pushMsg("bot","[CARDS:PACKLIST]");
      return pushMsg("bot","Packliste angezeigt. Möchtest du zurück zu Plänen oder zum Assisted Exit?");
    }
    if (t.includes("andere")){
      state.step="pick_route"; saveState();
      pushMsg("bot","[CARDS:ROUTE_LIST]");
      return pushMsg("bot","Wähle eine neue Route (1–10) oder „Neu suchen“.");
    }
    if (t.includes("tagesform") || t.includes("neu")){
      state.daily = { energy:null, pain:null, mental:null };
      state.plans = null;
      state.step="ask_energy"; saveState();
      return pushMsg("bot","Neuer Tagesform-Check. Wie ist deine Energie heute? (1–5)");
    }
    return pushMsg("bot","Optionen: „Assisted Exit“, „Packliste“, „Andere Route“, „Neue Tagesform“.");
  }

  if (state.step==="after_packlist"){
    const t = raw.toLowerCase();
    if (t.includes("pläne") || t.includes("plaene")){
      state.step="after_plans"; saveState();
      pushMsg("bot","[CARDS:PLANS]");
      return pushMsg("bot","Zurück zu Plänen.");
    }
    if (t.includes("exit")){
      state.step="after_exit"; saveState();
      pushMsg("bot","[CARDS:EXIT]");
      return pushMsg("bot","Assisted Exit angezeigt.");
    }
    if (t.includes("andere")){
      state.step="pick_route"; saveState();
      pushMsg("bot","[CARDS:ROUTE_LIST]");
      return pushMsg("bot","Wähle eine neue Route (1–10) oder „Neu suchen“.");
    }
    return pushMsg("bot","Optionen: „Zurück zu Plänen“, „Assisted Exit“, „Andere Route“.");
  }

  if (state.step==="after_exit"){
    const t = raw.toLowerCase();
    if (t.includes("pläne") || t.includes("plaene")){
      state.step="after_plans"; saveState();
      pushMsg("bot","[CARDS:PLANS]");
      return pushMsg("bot","Zurück zu Plänen.");
    }
    if (t.includes("pack")){
      state.step="after_packlist"; saveState();
      pushMsg("bot","[CARDS:PACKLIST]");
      return pushMsg("bot","Packliste angezeigt.");
    }
    if (t.includes("andere")){
      state.step="pick_route"; saveState();
      pushMsg("bot","[CARDS:ROUTE_LIST]");
      return pushMsg("bot","Wähle eine neue Route (1–10) oder „Neu suchen“.");
    }
    return pushMsg("bot","Optionen: „Zurück zu Plänen“, „Packliste“, „Andere Route“.");
  }

  // Idle fallback
  if (state.step==="idle"){
    if (raw.toLowerCase().includes("route")){
      state.step="ask_region"; saveState();
      return pushMsg("bot","Okay — in welcher Region? (München, Garmisch, Salzburg, Innsbruck)");
    }
    return pushMsg("bot","Wenn du Tourenvorschläge willst, tippe „Route“.");
  }

  pushMsg("bot","Ich bin kurz unsicher, was du meinst. Tippe z.B. „Route“ oder nutze die Buttons.");
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
  resetAll();
});

// ---------- Boot ----------
render();
startIfEmpty();