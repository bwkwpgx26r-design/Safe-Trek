/* ============================================================
   SafeTrek – app.js v10
   Layout bleibt unverändert. Nur Logik/Flow:
   - Wizard -> Region (Region + Radius mit Highlight)
   - Routes -> Route wählen -> Summary -> Pack -> Navigation
   - Wetter (Open-Meteo, kein Key) + Höhenmeter (OpenTopoData)
   - Map: Leaflet, Plan A/B/C, SOS Overlay
   ============================================================ */

console.log("SafeTrek app.js loaded v10");

const CFG = {
  VERSION: "10",
  OVERPASS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ],
  REGIONS: {
    munich:    { key:"munich",    label:"München & Umland",   lat:48.137154, lon:11.576124 },
    garmisch:  { key:"garmisch",  label:"Garmisch & Alpen",   lat:47.491000, lon:11.095000 },
    innsbruck: { key:"innsbruck", label:"Innsbruck & Tirol",  lat:47.269200, lon:11.404100 }
  },

  ROUTE_PICK_LIMIT: 10,

  // Geometry cleanup
  STITCH_MAX_JOIN_M: 900,
  SIMPLIFY_EVERY_N: 2,

  // Elevation
  ELEV_SAMPLE_MAX_POINTS: 120,
  ELEV_BATCH_SIZE: 60,
  ELEV_RETRIES: 2,
  ELEV_DELAY_MS: 220,

  // Exits
  EXIT_SAMPLE_POINTS: 12,
  EXIT_AROUND_M: 700,
  EXIT_MAX: 12,
  EXIT_DEDUPE_M: 45,

  // Map
  MAP_MAX_ZOOM: 18
};

const state = {
  screen: "splash",
  wizardStep: 0,
  wizard: [null,null,null,null],

  regionKey: "munich",
  region: CFG.REGIONS.munich,
  radiusKm: 30,
  userPinnedCenter: null,

  routePicks: [],
  activeRoute: null,

  plan: "A",
  stressMode: false,

  map: null,
  tile: null,
  layerMain: null,
  layerPlan: null,
  layerExits: null,

  overlaySOS: null
};

/* ------------------ Basic navigation ------------------ */
function go(id){
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const el = document.getElementById(id);
  if(el) el.classList.add("active");
  state.screen = id;

  if(id === "region"){
    renderRegionSummary();
    highlightRegionChips();
    highlightRadiusChips();
  }

  if(id === "map"){
    ensureMap();
    setTimeout(invalidateMap, 160);
    setTimeout(invalidateMap, 600);
  }
}

function enterAsGuest(){ go("home"); }
function noop(){}

window.addEventListener("load", () => {
  setTimeout(() => go("auth"), 1200);
});

/* ------------------ Wizard flow ------------------ */
function selectWizard(step, value){
  state.wizard[step] = value;

  const cur = document.querySelector(`.wizard-step[data-step="${step}"]`);
  if(cur) cur.classList.remove("active");

  if(step < 3){
    state.wizardStep++;
    const next = document.querySelector(`.wizard-step[data-step="${state.wizardStep}"]`);
    if(next) next.classList.add("active");
  } else {
    // ✅ After check-in: ask for region + radius
    go("region");
  }
}

/* ------------------ Public API for HTML ------------------ */
window.SafeTrek = {
  setRegion: (key) => {
    if(!CFG.REGIONS[key]) return;
    state.regionKey = key;
    state.region = CFG.REGIONS[key];
    state.userPinnedCenter = null;
    highlightRegionChips();
    renderRegionSummary();
  },
  setRadiusKm: (km) => {
    state.radiusKm = km;
    highlightRadiusChips();
    renderRegionSummary();
  },
  useMyLocation: async () => {
    const pos = await getGeoOnce(6500);
    if(pos){
      state.userPinnedCenter = { lat: pos.lat, lon: pos.lon };
      // pick nearest region only for label
      state.regionKey = nearestRegionKey(pos.lat, pos.lon);
      state.region = CFG.REGIONS[state.regionKey];
      highlightRegionChips();
      renderRegionSummary("Standort gesetzt");
    } else {
      renderRegionSummary("Standort nicht verfügbar");
    }
  },
  confirmRegion: async () => {
    go("routes");
    await SafeTrek.loadRoutes(true);
  },
  loadRoutes: async (forceReload=false) => {
    await loadRouteCards(forceReload);
  },

  // Flow screens
  openSummary: () => { updateSummaryUI(); go("summary"); },
  openPack: () => { updatePackUI(); go("pack"); },
  startNavigation: () => { updateNavUI(); go("nav"); },
  cantContinue: () => { updateNavExitUI(true); }
};

/* ------------------ Region UI helpers ------------------ */
function renderRegionSummary(extra){
  const el = document.getElementById("regionSummary");
  if(!el) return;

  const center = state.userPinnedCenter
    ? `Standort · ${state.userPinnedCenter.lat.toFixed(3)}, ${state.userPinnedCenter.lon.toFixed(3)}`
    : `Region · ${state.region.label}`;

  el.textContent = `${center} · Umkreis ${state.radiusKm} km${extra ? " · " + extra : ""}`;
}

function highlightRegionChips(){
  const map = { munich:"München", garmisch:"Garmisch", innsbruck:"Innsbruck" };
  document.querySelectorAll("#region .chip").forEach(btn => {
    const txt = btn.textContent.trim();
    const should = txt === map[state.regionKey];
    btn.classList.toggle("selected", should);
  });
}

function highlightRadiusChips(){
  document.querySelectorAll("#region .chip").forEach(btn => {
    const t = btn.textContent.trim();
    const m = t.match(/^(\d+)\s?km$/i);
    if(!m) return;
    const km = Number(m[1]);
    btn.classList.toggle("selected", km === state.radiusKm);
  });
}

/* ------------------ Routes: card UI CSS injection ------------------ */
injectRouteCardCSS();

function injectRouteCardCSS(){
  if(document.getElementById("st_cards_css")) return;
  const css = document.createElement("style");
  css.id = "st_cards_css";
  css.textContent = `
    .stCards{ display:grid; grid-template-columns:1fr; gap:14px; padding-bottom:14px; }
    @media(min-width:900px){ .stCards{ grid-template-columns:1fr 1fr; } }

    .stCard{
      border:1px solid rgba(255,255,255,0.10);
      background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.04));
      border-radius:20px;
      padding:14px;
      display:flex;
      flex-direction:column;
      gap:12px;
      box-shadow: 0 20px 56px rgba(0,0,0,0.42);
      overflow:hidden;
    }
    .stHeader{ display:flex; flex-direction:column; gap:6px; min-width:0; }
    .stTitle{
      font-size:16px; font-weight:950; letter-spacing:0.15px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .stMeta{
      display:flex; gap:10px; flex-wrap:wrap; align-items:center;
      font-size:12px; font-weight:850; color:rgba(255,255,255,0.68);
    }
    .stDot{ width:4px;height:4px;border-radius:99px;background:rgba(255,255,255,0.22); }
    .stPreview{
      border:1px solid rgba(255,255,255,0.09);
      border-radius:16px;
      overflow:hidden;
      background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
    }
    .stPreview canvas{ display:block; width:100%; height:96px; }
    .stStats{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .stPill{
      border:1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.04);
      border-radius:999px;
      padding:8px 10px;
      display:flex;
      gap:8px;
      align-items:center;
      font-size:12px;
      font-weight:900;
      color:rgba(255,255,255,0.92);
      white-space:nowrap;
    }
    .stPill small{ font-size:11px; font-weight:900; color:rgba(255,255,255,0.52); }
    .stSafety{
      display:flex; justify-content:space-between; align-items:center; gap:10px;
      border:1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      border-radius:16px;
      padding:10px 12px;
    }
    .stSafetyText{ font-size:12px; font-weight:850; color:rgba(255,255,255,0.90); }
    .stBadge{
      font-size:11px; font-weight:950;
      padding:6px 10px; border-radius:999px;
      border:1px solid rgba(255,255,255,0.10);
      background: rgba(255,255,255,0.04);
      white-space:nowrap;
    }
    .stBadge.good{ border-color: rgba(50,213,131,0.60); }
    .stBadge.warn{ border-color: rgba(255,204,0,0.60); }

    .stActions{ display:flex; gap:10px; margin-top:2px; }
    .stBtn{
      flex:1;
      border-radius:14px;
      border:1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.92);
      padding:12px 12px;
      font-size:13px;
      font-weight:950;
      letter-spacing:0.15px;
      cursor:pointer;
      display:flex; align-items:center; justify-content:center; gap:8px;
    }
    .stBtn.primary{
      border-color: rgba(78,161,255,0.35);
      background: rgba(78,161,255,0.14);
    }

    .stSkeleton{ opacity:.72; animation: stPulse 1.2s ease-in-out infinite alternate; }
    @keyframes stPulse{ from{opacity:.55} to{opacity:.95} }
  `;
  document.head.appendChild(css);
}

/* ------------------ Routes loading ------------------ */
async function loadRouteCards(forceReload){
  const host = document.getElementById("routeGrid");
  if(!host) return;

  const sub = document.getElementById("routesSub");
  if(sub){
    const place = state.userPinnedCenter ? "Standort" : state.region.label;
    sub.textContent = `${place} · Umkreis ${state.radiusKm} km · passende Vorschläge`;
  }

  host.innerHTML = `<div class="stCards" id="stCards"></div>`;
  const cards = document.getElementById("stCards");

  cards.innerHTML = "";
  for(let i=0;i<4;i++) cards.appendChild(makeSkeletonCard());

  const center = state.userPinnedCenter
    ? { lat: state.userPinnedCenter.lat, lon: state.userPinnedCenter.lon }
    : { lat: state.region.lat, lon: state.region.lon };
  const radiusM = Math.round(state.radiusKm * 1000);

  const q = `
[out:json][timeout:25];
(
  relation(around:${radiusM},${center.lat},${center.lon})["type"="route"]["route"="hiking"];
  relation(around:${radiusM},${center.lat},${center.lon})["type"="route"]["route"="foot"];
);
out tags center ${CFG.ROUTE_PICK_LIMIT};
`;

  let data;
  try{
    data = await overpass(q);
  }catch(e){
    cards.innerHTML = "";
    cards.appendChild(makeErrorCard());
    const r = document.getElementById("stReload");
    if(r) r.onclick = () => SafeTrek.loadRoutes(true);
    return;
  }

  const els = (data.elements || []).filter(e => e.type==="relation" && e.center);
  const picks = els.map(e => ({
    id: e.id,
    name: (e.tags?.name || e.tags?.ref || "Route").slice(0, 80),
    center: [e.center.lat, e.center.lon]
  }));

  // Dedup
  const uniq = [];
  const seen = new Set();
  for(const p of picks){
    const key = `${p.name}|${p.center[0].toFixed(4)}|${p.center[1].toFixed(4)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }

  state.routePicks = uniq.slice(0, CFG.ROUTE_PICK_LIMIT);

  cards.innerHTML = "";
  state.routePicks.forEach(p => cards.appendChild(makeRouteCard(p)));

  // Previews (lazy)
  const cardEls = [...cards.children];
  for(let i=0;i<state.routePicks.length;i++){
    const pick = state.routePicks[i];
    const card = cardEls[i];
    const canvas = card?.querySelector("canvas");
    drawMiniPreview(canvas, null);

    try{
      const coords = await loadRoutePreviewGeometry(pick.id);
      drawMiniPreview(canvas, coords);
    }catch(e){}
    await sleep(110);
  }
}

function makeSkeletonCard(){
  const c = document.createElement("div");
  c.className = "stCard stSkeleton";
  c.innerHTML = `
    <div class="stHeader">
      <div class="stTitle">Lade Tourvorschläge…</div>
      <div class="stMeta">
        <span>Suche läuft</span>
        <span class="stDot"></span>
        <span>Routen werden geladen</span>
      </div>
    </div>
    <div class="stPreview"><canvas width="600" height="190"></canvas></div>
    <div class="stStats">
      <div class="stPill">Distanz <small>km</small> —</div>
      <div class="stPill">Höhenmeter <small>m</small> —</div>
      <div class="stPill">Ausstiege <small>#</small> —</div>
      <div class="stPill">Wetter <small>jetzt</small> —</div>
    </div>
    <div class="stSafety">
      <div class="stSafetyText">Safety-Check wird vorbereitet</div>
      <div class="stBadge">prüfe…</div>
    </div>
    <div class="stActions">
      <button class="stBtn">Route ansehen</button>
      <button class="stBtn primary">Route wählen</button>
    </div>
  `;
  return c;
}

function makeErrorCard(){
  const c = document.createElement("div");
  c.className = "stCard";
  c.innerHTML = `
    <div class="stHeader">
      <div class="stTitle">Routen konnten nicht geladen werden</div>
      <div class="stMeta">
        <span>Netzwerk / Overpass</span>
        <span class="stDot"></span>
        <span>Bitte erneut versuchen</span>
      </div>
    </div>
    <div class="stActions">
      <button class="stBtn primary" id="stReload">Erneut versuchen</button>
    </div>
  `;
  return c;
}

function makeRouteCard(pick){
  const safety = computeSafetyBadge();
  const c = document.createElement("div");
  c.className = "stCard";
  c.innerHTML = `
    <div class="stHeader">
      <div class="stTitle" title="${escapeHtml(pick.name)}">${escapeHtml(pick.name)}</div>
      <div class="stMeta">
        <span>${escapeHtml(state.userPinnedCenter ? "Standort" : state.region.label)}</span>
        <span class="stDot"></span>
        <span>${escapeHtml(safety.label)}</span>
      </div>
    </div>

    <div class="stPreview"><canvas width="600" height="190"></canvas></div>

    <div class="stStats">
      <div class="stPill" data-chip="dist">Distanz <small>km</small> —</div>
      <div class="stPill" data-chip="up">Höhenmeter <small>m</small> —</div>
      <div class="stPill" data-chip="ex">Ausstiege <small>#</small> —</div>
      <div class="stPill" data-chip="wx">Wetter <small>jetzt</small> —</div>
    </div>

    <div class="stSafety">
      <div class="stSafetyText">${escapeHtml(safety.text)}</div>
      <div class="stBadge ${safety.cls}">${escapeHtml(safety.badge)}</div>
    </div>

    <div class="stActions">
      <button class="stBtn" data-act="preview">🗺️ Route ansehen</button>
      <button class="stBtn primary" data-act="select">✓ Route wählen</button>
    </div>
  `;

  // Preview stays as map
  c.querySelector('[data-act="preview"]').onclick = async () => {
    await buildAndShowRoute(pick, c);
    go("map");
  };

  // Select goes to Summary afterwards
  c.querySelector('[data-act="select"]').onclick  = async () => {
    await buildAndShowRoute(pick, c);
    SafeTrek.openSummary();
  };

  return c;
}

/* ------------------ Safety ------------------ */
function computeSafetyBadge(){
  const mood    = state.wizard[0] ?? 2;
  const stamina = state.wizard[1] ?? 2;
  const breaks  = state.wizard[2] ?? 2;
  const safety  = state.wizard[3] ?? 2;

  const capacity = (mood + stamina + breaks) / 3;
  const conservative = (safety >= 3) || (capacity <= 2);

  if(conservative){
    return {
      cls:"warn",
      badge:"konservativ",
      label:"Safety-first",
      text:"Heute konservativ planen – sichere Ausstiege priorisiert"
    };
  }
  return {
    cls:"good",
    badge:"gut machbar",
    label:"Balanced",
    text:"Gute Basis – Alternativen & Exit-Optionen werden berücksichtigt"
  };
}

/* ------------------ Weather (Open-Meteo, no key) ------------------ */
async function fetchWeather(lat, lon){
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&current=temperature_2m,weather_code,wind_speed_10m` +
    `&timezone=Europe/Berlin`;

  const r = await fetch(url, { headers:{ "Accept":"application/json" } });
  if(!r.ok) throw new Error("weather http");
  const d = await r.json();

  const t = d?.current?.temperature_2m;
  const w = d?.current?.wind_speed_10m;
  const code = d?.current?.weather_code;
  const desc = weatherCodeToText(code);

  return {
    tempC: (typeof t === "number" ? t : null),
    windKmh: (typeof w === "number" ? w : null),
    desc
  };
}

function weatherCodeToText(code){
  const c = Number(code);
  if([0].includes(c)) return "klar";
  if([1,2].includes(c)) return "leicht bewölkt";
  if([3].includes(c)) return "bewölkt";
  if([45,48].includes(c)) return "Nebel";
  if([51,53,55].includes(c)) return "Niesel";
  if([61,63,65].includes(c)) return "Regen";
  if([71,73,75].includes(c)) return "Schnee";
  if([80,81,82].includes(c)) return "Schauer";
  if([95,96,99].includes(c)) return "Gewitter";
  return "Wetter";
}

/* ------------------ Route preview geometry + canvas ------------------ */
async function loadRoutePreviewGeometry(relId){
  const q = `
[out:json][timeout:25];
relation(${relId});
(._;>;);
out geom;
`;
  const data = await overpass(q);
  const ways = (data.elements || []).filter(e => e.type==="way" && Array.isArray(e.geometry) && e.geometry.length > 1);
  const segs = ways.map(w => w.geometry.map(p => [p.lat,p.lon]));
  const stitched = stitchSegments(segs);
  const cleaned = dedupeConsecutive(stitched);
  const simplified = simplifyEveryN(cleaned, 4);
  return samplePolyline(simplified, 60);
}

function drawMiniPreview(canvas, coords){
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;

  const g = ctx.createLinearGradient(0,0,0,h);
  g.addColorStop(0, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,w,h);

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for(let i=1;i<6;i++){
    const y = (h/6)*i;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
  }

  if(!coords || coords.length < 2){
    ctx.strokeStyle = "rgba(78,161,255,0.85)";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(w*0.18, h*0.60);
    ctx.lineTo(w*0.82, h*0.44);
    ctx.stroke();
    return;
  }

  let minLat=Infinity,maxLat=-Infinity,minLon=Infinity,maxLon=-Infinity;
  for(const [lat,lon] of coords){
    if(lat<minLat) minLat=lat;
    if(lat>maxLat) maxLat=lat;
    if(lon<minLon) minLon=lon;
    if(lon>maxLon) maxLon=lon;
  }
  const pad = 18;
  const dx = (maxLon-minLon) || 1e-9;
  const dy = (maxLat-minLat) || 1e-9;

  const proj = ([lat,lon]) => {
    const x = pad + ((lon-minLon)/dx) * (w - pad*2);
    const y = pad + (1 - (lat-minLat)/dy) * (h - pad*2);
    return [x,y];
  };

  ctx.strokeStyle = "rgba(78,161,255,0.92)";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  const [x0,y0] = proj(coords[0]);
  ctx.moveTo(x0,y0);
  for(let i=1;i<coords.length;i++){
    const [x,y] = proj(coords[i]);
    ctx.lineTo(x,y);
  }
  ctx.stroke();

  const [xs,ys] = proj(coords[0]);
  const [xe,ye] = proj(coords[coords.length-1]);
  ctx.fillStyle = "rgba(50,213,131,0.95)";
  ctx.beginPath(); ctx.arc(xs,ys,7,0,Math.PI*2); ctx.fill();
  ctx.fillStyle = "rgba(255,204,0,0.95)";
  ctx.beginPath(); ctx.arc(xe,ye,7,0,Math.PI*2); ctx.fill();
}

/* ------------------ Build route (full), update stats, weather, elevation ------------------ */
async function buildAndShowRoute(pick, cardEl){
  ensureMap();
  setTimeout(invalidateMap, 180);

  // Build full route
  const route = await buildRouteFromRelation(pick.id, pick.name);
  state.activeRoute = route;

  // Fetch weather (start point)
  try{
    const start = route.coords?.[0];
    if(start){
      route.weather = await fetchWeather(start[0], start[1]);
    }
  }catch(e){ route.weather = null; }

  renderRouteOnMap(route);
  applyPlan("A");

  // Update card stats
  if(cardEl){
    const distEl = cardEl.querySelector('[data-chip="dist"]');
    const upEl   = cardEl.querySelector('[data-chip="up"]');
    const exEl   = cardEl.querySelector('[data-chip="ex"]');
    const wxEl   = cardEl.querySelector('[data-chip="wx"]');

    if(distEl) distEl.innerHTML = `Distanz <small>km</small> ${route.lengthKm ? round1(route.lengthKm) : "—"}`;
    if(upEl)   upEl.innerHTML   = `Höhenmeter <small>m</small> ${route.elevUpM != null ? Math.round(route.elevUpM) : "—"}`;
    if(exEl)   exEl.innerHTML   = `Ausstiege <small>#</small> ${(route.exits||[]).length}`;

    if(wxEl){
      const w = route.weather;
      wxEl.textContent = w?.tempC != null
        ? `Wetter ${Math.round(w.tempC)}° · ${w.desc}`
        : `Wetter —`;
    }
  }
}

/* ------------------ Build full route from relation ------------------ */
async function buildRouteFromRelation(relId, name){
  const q = `
[out:json][timeout:25];
relation(${relId});
(._;>;);
out geom;
`;
  const data = await overpass(q);

  const ways = (data.elements || []).filter(e => e.type==="way" && Array.isArray(e.geometry) && e.geometry.length > 1);
  const segs = ways.map(w => w.geometry.map(p => [p.lat, p.lon]));

  const stitched = stitchSegments(segs);
  const cleaned  = dedupeConsecutive(stitched);
  const simplified = simplifyEveryN(cleaned, CFG.SIMPLIFY_EVERY_N);

  const lengthKm = polylineLengthKm(simplified);

  let elev = { up:null, down:null };
  try{ elev = await computeElevationGain(simplified); }catch(e){}

  let exits = [];
  try{ exits = await computeAssistedExits(simplified); }catch(e){}

  return { name, coords: simplified, lengthKm, elevUpM: elev.up, elevDownM: elev.down, exits, weather:null };
}

/* ------------------ Summary / Pack / Nav UI ------------------ */
function updateSummaryUI(){
  const r = state.activeRoute;
  const title = document.getElementById("summaryTitle");
  const text  = document.getElementById("summaryText");
  const wxEl  = document.getElementById("summaryWx");
  const elEl  = document.getElementById("summaryElev");
  const exEl  = document.getElementById("summaryExit");

  if(!r){
    if(title) title.textContent = "Deine Route";
    if(text) text.textContent = "Bitte wähle zuerst eine Route.";
    if(wxEl) wxEl.textContent = "Wetter —";
    if(elEl) elEl.textContent = "Höhenmeter —";
    if(exEl) exEl.textContent = "Exits —";
    return;
  }

  if(title) title.textContent = r.name || "Deine Route";

  const km = r.lengthKm ? `${round1(r.lengthKm)} km` : "— km";
  const elev = r.elevUpM != null ? `↑ ${Math.round(r.elevUpM)} m` : "↑ — m";
  const exits = (r.exits||[]).length;

  if(text) text.textContent =
    `${km} · ${elev} · ${exits} Ausstiege in der Nähe.`;

  const wx = r.weather;
  if(wxEl){
    wxEl.textContent = wx?.tempC != null ? `Wetter ${Math.round(wx.tempC)}° · ${wx.desc}` : "Wetter —";
  }
  if(elEl){
    elEl.textContent = r.elevUpM != null ? `Höhenmeter ↑ ${Math.round(r.elevUpM)} m` : "Höhenmeter —";
  }
  if(exEl){
    exEl.textContent = `Exits ${exits}`;
  }
}

function updatePackUI(){
  const r = state.activeRoute;
  const el = document.getElementById("packList");
  if(!el) return;

  if(!r){
    el.textContent = "Bitte wähle zuerst eine Route.";
    return;
  }

  const items = buildPackList(r);
  el.innerHTML = items.map(i => `• ${escapeHtml(i)}`).join("<br>");
}

function buildPackList(route){
  const safety = state.wizard[3] ?? 2;
  const mood   = state.wizard[0] ?? 2;

  const w = route.weather;
  const cold = (w?.tempC != null && w.tempC <= 8);
  const windy = (w?.windKmh != null && w.windKmh >= 25);

  const list = [
    "Wasser (0,5–1,5L je nach Länge)",
    "Snack / schnelle Energie",
    "Geladener Akku (Low-Power Mode)",
    "Offline-Karte / Screenshot wichtiger Punkte",
    "Kleines Erste-Hilfe-Set",
    "Sonnenschutz (Creme + ggf. Kappe)",
    "Leichte Regen-/Windschicht"
  ];

  if(cold) list.push("Wärmere Schicht (Fleece / Longsleeve)");
  if(windy) list.push("Winddichte Jacke");
  if(safety >= 3) list.push("Stirnlampe (Safety-first)");
  if(mood <= 2) list.push("Zusätzliche Pause-Option (Thermos / Sitzpad)");
  if((route.exits||[]).length > 0) list.push("Assisted Exit: Exit-Punkte gespeichert (auf Karte sichtbar)");

  return list;
}

function updateNavUI(){
  const r = state.activeRoute;
  if(!r) return;
  // Navigation screen is simple MVP; user can open map via browser back if desired
  // If you want: auto open map when entering nav:
  // go("map");
  updateNavExitUI(false);
}

function updateNavExitUI(showOverlay){
  const r = state.activeRoute;
  if(!r || !(r.exits||[]).length){
    if(showOverlay) openSOS();
    return;
  }
  if(showOverlay) openSOS();
}

/* ------------------ Stitch / simplify ------------------ */
function stitchSegments(segments){
  if(!segments.length) return [];
  segments = segments.slice().sort((a,b)=> b.length - a.length);
  let path = segments.shift().slice();

  while(segments.length){
    let bestIdx=-1, bestMode=null, bestDist=Infinity;
    const head = path[0];
    const tail = path[path.length-1];

    for(let i=0;i<segments.length;i++){
      const s = segments[i];
      const sH = s[0], sT = s[s.length-1];
      const d1 = haversineM(tail, sH);
      const d2 = haversineM(tail, sT);
      const d3 = haversineM(head, sT);
      const d4 = haversineM(head, sH);
      const local = Math.min(d1,d2,d3,d4);
      if(local < bestDist){
        bestDist = local; bestIdx=i;
        bestMode = (local===d1)?"tail_head":(local===d2)?"tail_tail":(local===d3)?"head_tail":"head_head";
      }
    }

    const seg = segments.splice(bestIdx,1)[0];
    if(bestDist > CFG.STITCH_MAX_JOIN_M) continue;

    if(bestMode==="tail_head") path = path.concat(seg);
    else if(bestMode==="tail_tail") path = path.concat(seg.slice().reverse());
    else if(bestMode==="head_tail") path = seg.concat(path);
    else path = seg.slice().reverse().concat(path);
  }
  return path;
}

function dedupeConsecutive(coords){
  const out=[]; let prev=null;
  for(const c of coords){
    if(!prev || c[0]!==prev[0] || c[1]!==prev[1]) out.push(c);
    prev=c;
  }
  return out;
}

function simplifyEveryN(coords,n){
  if(n<=1 || coords.length<3) return coords;
  const out=[];
  for(let i=0;i<coords.length;i++){
    if(i===0 || i===coords.length-1 || i%n===0) out.push(coords[i]);
  }
  return out;
}

/* ------------------ Elevation (OpenTopoData) ------------------ */
async function computeElevationGain(coords){
  const sampled = samplePolyline(coords, CFG.ELEV_SAMPLE_MAX_POINTS);
  const elevations = [];

  for(let i=0;i<sampled.length;i+=CFG.ELEV_BATCH_SIZE){
    const chunk = sampled.slice(i, i+CFG.ELEV_BATCH_SIZE);
    const vals = await retry(() => fetchElevations(chunk), CFG.ELEV_RETRIES, CFG.ELEV_DELAY_MS);
    elevations.push(...vals);
    await sleep(CFG.ELEV_DELAY_MS);
  }

  let up=0, down=0;
  for(let i=1;i<elevations.length;i++){
    const a=elevations[i-1], b=elevations[i];
    if(a==null || b==null) continue;
    const diff=b-a;
    if(Math.abs(diff)<2) continue;
    if(diff>0) up+=diff; else down+=(-diff);
  }
  return { up: Math.round(up), down: Math.round(down) };
}

async function fetchElevations(latlonArr){
  const loc = latlonArr.map(p=>`${p[0]},${p[1]}`).join("|");
  const url = `https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(loc)}`;
  const r = await fetch(url, { headers:{ "Accept":"application/json" }});
  if(!r.ok) throw new Error("elev http");
  const d = await r.json();
  const res = d?.results || [];
  return res.map(x => (typeof x.elevation==="number" ? x.elevation : null));
}

/* ------------------ Assisted Exit points ------------------ */
async function computeAssistedExits(routeCoords){
  const samples = samplePolyline(routeCoords, CFG.EXIT_SAMPLE_POINTS);

  const parts = samples.map(([lat,lon]) => `
(
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["highway"="bus_stop"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["public_transport"="platform"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["railway"="station"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["railway"="tram_stop"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["amenity"="parking"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["amenity"="shelter"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["tourism"="alpine_hut"];
);
`).join("\n");

  const q = `[out:json][timeout:25]; ${parts} out tags ${CFG.EXIT_MAX*25};`;
  const data = await overpass(q);

  const nodes = (data.elements || []).filter(e => e.type==="node" && typeof e.lat==="number" && typeof e.lon==="number");

  let exits = nodes.map(n => {
    const distM = fastDistancePointToPolylineM([n.lat,n.lon], routeCoords);
    return { lat:n.lat, lon:n.lon, distToRouteM: distM, score: distM ?? 9999 };
  });

  exits = exits.filter(x => x.distToRouteM != null && x.distToRouteM <= 1200);
  exits = dedupeByDistance(exits, CFG.EXIT_DEDUPE_M);
  exits.sort((a,b)=> a.score - b.score);

  return exits.slice(0, CFG.EXIT_MAX);
}

function fastDistancePointToPolylineM(pt, coords){
  let best = Infinity;
  for(let i=0;i<coords.length;i+=6){
    best = Math.min(best, haversineM(pt, coords[i]));
  }
  return best === Infinity ? null : best;
}

function dedupeByDistance(points, thresholdM){
  const out=[];
  for(const p of points){
    let ok=true;
    for(const q of out){
      if(haversineM([p.lat,p.lon],[q.lat,q.lon])<thresholdM){ ok=false; break; }
    }
    if(ok) out.push(p);
  }
  return out;
}

/* ------------------ Leaflet map ------------------ */
function ensureMap(){
  if(state.map) return;

  state.map = L.map("mapView", { zoomControl:true, preferCanvas:true });

  const tiles = [
    { url:"https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" },
    { url:"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" },
    { url:"https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png" }
  ];

  let idx=0;
  const setTile = (i) => {
    idx=i;
    if(state.tile) state.tile.remove();
    state.tile = L.tileLayer(tiles[i].url, { maxZoom: CFG.MAP_MAX_ZOOM });
    state.tile.on("tileerror", () => { if(idx < tiles.length-1) setTile(idx+1); });
    state.tile.addTo(state.map);
  };
  setTile(0);

  state.map.setView([state.region.lat, state.region.lon], 11);
  window.addEventListener("orientationchange", () => setTimeout(invalidateMap, 250));
}

function invalidateMap(){ try{ state.map?.invalidateSize(true); }catch(e){} }

function clearMapLayers(){
  state.layerPlan?.remove(); state.layerPlan=null;
  state.layerMain?.remove(); state.layerMain=null;
  state.layerExits?.remove(); state.layerExits=null;
}

function renderRouteOnMap(route){
  ensureMap();
  clearMapLayers();

  state.layerMain = L.polyline(route.coords.map(c=>[c[0],c[1]]), { color:"#4ea1ff", weight:5, opacity:0.95 }).addTo(state.map);

  state.layerExits = L.layerGroup().addTo(state.map);
  for(const x of (route.exits||[])){
    L.circleMarker([x.lat,x.lon], { radius:7, color:"#ffcc00", weight:2, fillColor:"#ffcc00", fillOpacity:0.9 }).addTo(state.layerExits);
  }

  try{ state.map.fitBounds(state.layerMain.getBounds().pad(0.15)); }catch(e){}
  applyPlan("A");
  setTimeout(invalidateMap, 120);
}

function applyPlan(p){
  state.plan = p;
  const route = state.activeRoute;
  if(!route?.coords?.length || !state.map) return;

  state.layerPlan?.remove(); state.layerPlan=null;
  const coords = route.coords;

  const ratio = (p==="A") ? 1 : (p==="B") ? 0.7 : 0.5;
  const cut = Math.max(2, Math.floor(coords.length * ratio));
  const color = (p==="C") ? "#ffcc00" : "#32d583";
  const weight = (p==="C") ? 7 : 6;

  state.layerPlan = L.polyline(coords.slice(0,cut).map(c=>[c[0],c[1]]), { color, weight, opacity:0.9 }).addTo(state.map);
}

/* ------------------ SOS ------------------ */
function openSOS(){
  state.stressMode = true;
  showSOSOverlay();
}

function showSOSOverlay(){
  removeSOSOverlay();

  const wrap = document.createElement("div");
  wrap.id = "sosOverlay";
  wrap.style.position = "fixed";
  wrap.style.inset = "0";
  wrap.style.zIndex = "9999";
  wrap.style.background = "rgba(0,0,0,0.62)";
  wrap.style.backdropFilter = "blur(8px)";
  wrap.style.display = "flex";
  wrap.style.alignItems = "flex-end";
  wrap.style.justifyContent = "center";
  wrap.style.padding = "18px";

  const sheet = document.createElement("div");
  sheet.style.width = "min(560px, 100%)";
  sheet.style.background = "rgba(18,18,18,0.96)";
  sheet.style.border = "1px solid rgba(255,255,255,0.12)";
  sheet.style.borderRadius = "22px";
  sheet.style.padding = "14px";
  sheet.style.display = "grid";
  sheet.style.gridTemplateColumns = "1fr 1fr";
  sheet.style.gap = "12px";
  sheet.style.boxShadow = "0 18px 48px rgba(0,0,0,0.55)";

  const btn = (label, onClick) => {
    const b = document.createElement("button");
    b.type="button";
    b.textContent=label;
    b.style.width="100%";
    b.style.padding="18px 14px";
    b.style.fontSize="13px";
    b.style.fontWeight="950";
    b.style.borderRadius="18px";
    b.style.border="1px solid rgba(255,255,255,0.12)";
    b.style.background="rgba(255,255,255,0.08)";
    b.style.color="white";
    b.onclick=onClick;
    return b;
  };

  sheet.appendChild(btn("Notruf 112", () => { window.location.href="tel:112"; }));
  sheet.appendChild(btn("Schließen", () => { removeSOSOverlay(); state.stressMode=false; }));

  wrap.appendChild(sheet);
  document.body.appendChild(wrap);
  state.overlaySOS = wrap;
}

function removeSOSOverlay(){
  const el = document.getElementById("sosOverlay");
  if(el) el.remove();
  state.overlaySOS = null;
}

/* ------------------ Overpass + general helpers ------------------ */
async function overpass(query){
  let lastErr=null;
  for(const ep of CFG.OVERPASS){
    try{
      const r = await fetch(ep, { method:"POST", headers:{ "Content-Type":"text/plain;charset=UTF-8" }, body:query });
      if(!r.ok) throw new Error("overpass http");
      return await r.json();
    }catch(e){ lastErr=e; }
  }
  throw lastErr || new Error("overpass fail");
}

function getGeoOnce(timeoutMs){
  return new Promise((resolve) => {
    if(!navigator.geolocation) return resolve(null);
    let done = false;
    const t = setTimeout(() => { if(!done){ done=true; resolve(null);} }, timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (p) => { if(done) return; done=true; clearTimeout(t); resolve({ lat:p.coords.latitude, lon:p.coords.longitude }); },
      () => { if(done) return; done=true; clearTimeout(t); resolve(null); },
      { enableHighAccuracy:false, maximumAge: 60_000, timeout: timeoutMs }
    );
  });
}

function nearestRegionKey(lat, lon){
  let bestK="munich", bestD=Infinity;
  for(const k of Object.keys(CFG.REGIONS)){
    const r = CFG.REGIONS[k];
    const d = haversineM([lat,lon],[r.lat,r.lon]);
    if(d < bestD){ bestD = d; bestK = k; }
  }
  return bestK;
}

function samplePolyline(coords, maxPoints){
  if(coords.length <= maxPoints) return coords;
  const step = Math.max(1, Math.floor(coords.length / maxPoints));
  const out = [];
  for(let i=0;i<coords.length;i+=step) out.push(coords[i]);
  if(out[out.length-1] !== coords[coords.length-1]) out.push(coords[coords.length-1]);
  return out.slice(0, maxPoints);
}

function haversineM(a,b){
  const R=6371000;
  const lat1=a[0]*Math.PI/180;
  const lat2=b[0]*Math.PI/180;
  const dLat=(b[0]-a[0])*Math.PI/180;
  const dLon=(b[1]-a[1])*Math.PI/180;
  const x=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}

function polylineLengthKm(coords){
  let km=0;
  for(let i=1;i<coords.length;i++){
    km += haversineM(coords[i-1], coords[i]) / 1000;
  }
  return km;
}

function round1(n){ return Math.round(n*10)/10; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function retry(fn,times,delayMs){
  let last;
  for(let i=0;i<=times;i++){
    try{ return await fn(); }catch(e){ last=e; await sleep(delayMs); }
  }
  throw last;
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

document.addEventListener("visibilitychange", () => {
  if(!document.hidden && state.screen === "map"){
    setTimeout(invalidateMap, 200);
  }
});