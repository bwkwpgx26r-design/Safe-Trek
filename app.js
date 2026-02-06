/* ============================================================
   SAFETREK – app.js (Route Cards PRO)
   - Real Routes (OSM/Overpass) + Plans + Exits + Elevation engine
   - Route list rendered as real cards (Komoot-style)
   - No other files required (injects CSS for cards)
   ============================================================ */

const CFG = {
  OVERPASS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ],
  REGIONS: {
    munich:    { key:"munich",    lat: 48.137154, lon: 11.576124, radiusM: 32000 },
    garmisch:  { key:"garmisch",  lat: 47.491000, lon: 11.095000, radiusM: 32000 },
    innsbruck: { key:"innsbruck", lat: 47.269200, lon: 11.404100, radiusM: 32000 }
  },
  ROUTE_PICK_LIMIT: 10,

  STITCH_MAX_JOIN_M: 900,
  SIMPLIFY_EVERY_N: 2,

  ELEV_SAMPLE_MAX_POINTS: 120,
  ELEV_BATCH_SIZE: 60,
  ELEV_RETRIES: 2,
  ELEV_DELAY_MS: 220,

  EXIT_SAMPLE_POINTS: 14,
  EXIT_AROUND_M: 700,
  EXIT_MAX: 14,
  EXIT_DEDUPE_M: 40,

  MAP_MAX_ZOOM: 18
};

const state = {
  screen: "auth",
  wizardStep: 0,
  wizard: [null,null,null,null],

  regionKey: "munich",
  region: CFG.REGIONS.munich,

  routePicks: [],
  activePick: null,
  activeRoute: null,

  plan: "A",
  stressMode: false,

  map: null,
  tile: null,
  layerMain: null,
  layerPlan: null,
  layerExits: null,
  markerHighlight: null,

  overlaySOS: null
};

/* =========================
   REQUIRED GLOBAL FUNCTIONS
   ========================= */
function go(id){
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const el = document.getElementById(id);
  if(el) el.classList.add("active");
  state.screen = id;

  if(id==="map"){
    ensureMap();
    setTimeout(invalidateMap, 160);
    setTimeout(invalidateMap, 600);
  }
}
function enterAsGuest(){ go("home"); }
function noop(){}

function selectWizard(step, value){
  state.wizard[step] = value;

  const cur = document.querySelector(`.wizard-step[data-step="${step}"]`);
  if(cur) cur.classList.remove("active");

  if(step < 3){
    state.wizardStep++;
    const next = document.querySelector(`.wizard-step[data-step="${state.wizardStep}"]`);
    if(next) next.classList.add("active");
  } else {
    go("routes");
    autoPickRegionThenSearch();
  }
}

function selectPlan(p){
  state.stressMode = false;
  removeSOSOverlay();
  applyPlan(p);
}

function openSOS(){
  state.stressMode = true;
  go("map");
  applyPlan("C");
  showSOSOverlay();
}

/* =========================
   CSS INJECTION (Cards)
   ========================= */
injectCardCSS();
function injectCardCSS(){
  if(document.getElementById("st_card_css")) return;
  const css = document.createElement("style");
  css.id = "st_card_css";
  css.textContent = `
    .stCards{ display:grid; grid-template-columns:1fr; gap:14px; }
    @media(min-width:860px){ .stCards{ grid-template-columns:1fr 1fr; } }

    .stCard{
      border:1px solid rgba(255,255,255,.12);
      background:rgba(0,0,0,.22);
      border-radius:18px;
      padding:12px;
      display:flex;
      flex-direction:column;
      gap:10px;
      box-shadow:0 16px 40px rgba(0,0,0,.35);
      overflow:hidden;
    }

    .stCardTop{ display:flex; gap:10px; align-items:center; }
    .stBadge{
      width:44px;height:44px;border-radius:16px;
      border:1px solid rgba(255,255,255,.12);
      background:rgba(255,255,255,.06);
      display:flex;align-items:center;justify-content:center;
      font-size:18px;
      flex:0 0 auto;
    }
    .stTitle{
      font-weight:1000;
      letter-spacing:.2px;
      line-height:1.1;
      opacity:.95;
      font-size:14px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      max-width: 100%;
    }

    .stPreview{
      width:100%;
      border-radius:16px;
      overflow:hidden;
      border:1px solid rgba(255,255,255,.10);
      background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
    }
    .stPreview canvas{ display:block; width:100%; height:86px; }

    .stChips{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      align-items:center;
    }
    .stChip{
      border:1px solid rgba(255,255,255,.12);
      background:rgba(255,255,255,.05);
      border-radius:999px;
      padding:8px 10px;
      font-size:12px;
      font-weight:900;
      display:flex;
      align-items:center;
      gap:8px;
      user-select:none;
    }

    .stActions{ display:flex; gap:10px; margin-top:2px; }
    .stBtn{
      flex:1;
      border:1px solid rgba(255,255,255,.14);
      background:rgba(255,255,255,.06);
      color:white;
      border-radius:14px;
      padding:12px 12px;
      font-size:18px;
      cursor:pointer;
      font-weight:900;
    }
    .stBtn.primary{
      border-color:rgba(78,161,255,.40);
      background:rgba(78,161,255,.18);
    }

    .stSkeleton{
      opacity:.75;
      animation: stPulse 1.2s ease-in-out infinite alternate;
    }
    @keyframes stPulse{ from{opacity:.55} to{opacity:.95} }
  `;
  document.head.appendChild(css);
}

/* =========================
   REGION (auto, no UI)
   ========================= */
async function autoPickRegionThenSearch(){
  try{
    const pos = await getGeoOnce(4500);
    if(pos){
      state.regionKey = nearestRegionKey(pos.lat, pos.lon);
      state.region = CFG.REGIONS[state.regionKey];
    }
  }catch(e){}
  await loadRoutePicks();
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
  let bestK = "munich", bestD = Infinity;
  for(const k of Object.keys(CFG.REGIONS)){
    const r = CFG.REGIONS[k];
    const d = haversineM([lat,lon],[r.lat,r.lon]);
    if(d < bestD){ bestD = d; bestK = k; }
  }
  return bestK;
}

/* =========================
   ROUTES LIST → REAL CARDS
   ========================= */
async function loadRoutePicks(){
  const container = document.getElementById("routeGrid");
  if(!container) return;

  container.innerHTML = `<div class="stCards" id="stCards"></div>`;
  const cards = document.getElementById("stCards");

  // Skeleton cards
  cards.innerHTML = "";
  for(let i=0;i<4;i++){
    cards.appendChild(makeSkeletonCard());
  }

  const { lat, lon, radiusM } = state.region;
  const q = `
[out:json][timeout:25];
(
  relation(around:${radiusM},${lat},${lon})["type"="route"]["route"="hiking"];
  relation(around:${radiusM},${lat},${lon})["type"="route"]["route"="foot"];
);
out tags center ${CFG.ROUTE_PICK_LIMIT};
`;

  let data;
  try{
    data = await overpass(q);
  }catch(e){
    cards.innerHTML = "";
    const err = document.createElement("div");
    err.className = "stCard";
    err.innerHTML = `
      <div class="stCardTop">
        <div class="stBadge">🔄</div>
        <div class="stTitle"></div>
      </div>
      <div class="stActions">
        <button class="stBtn primary" id="stReload">🔄</button>
      </div>
    `;
    cards.appendChild(err);
    document.getElementById("stReload").onclick = () => loadRoutePicks();
    return;
  }

  const els = (data.elements || []).filter(e => e.type === "relation" && e.center);
  const picksRaw = els.map(e => ({
    id: e.id,
    name: (e.tags?.name || e.tags?.ref || "🥾").slice(0, 80),
    center: [e.center.lat, e.center.lon]
  }));

  // Dedup
  const uniq = [];
  const seen = new Set();
  for(const p of picksRaw){
    const key = `${p.name}|${p.center[0].toFixed(4)}|${p.center[1].toFixed(4)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }

  state.routePicks = uniq.slice(0, CFG.ROUTE_PICK_LIMIT);

  // Render real cards
  cards.innerHTML = "";
  state.routePicks.forEach((p, idx) => {
    cards.appendChild(makeRouteCard(p, idx));
  });

  // Lazy-load better preview geometry per card (nice UX, no freeze)
  for(let i=0;i<state.routePicks.length;i++){
    const pick = state.routePicks[i];
    const card = cards.children[i];
    if(!card) continue;
    const canvas = card.querySelector("canvas");

    // placeholder preview immediately
    drawMiniPreview(canvas, null);

    try{
      const coords = await loadRoutePreviewGeometry(pick.id);
      drawMiniPreview(canvas, coords);
    }catch(e){
      // keep placeholder
    }
    await sleep(130);
  }
}

function makeSkeletonCard(){
  const c = document.createElement("div");
  c.className = "stCard stSkeleton";
  c.innerHTML = `
    <div class="stCardTop">
      <div class="stBadge">🥾</div>
      <div class="stTitle">—</div>
    </div>
    <div class="stPreview"><canvas width="600" height="180"></canvas></div>
    <div class="stChips">
      <div class="stChip">📏 —</div>
      <div class="stChip">↑ —</div>
      <div class="stChip">🚪 —</div>
    </div>
    <div class="stActions">
      <button class="stBtn">🗺️</button>
      <button class="stBtn primary">✓</button>
    </div>
  `;
  return c;
}

function makeRouteCard(pick, idx){
  const c = document.createElement("div");
  c.className = "stCard";

  c.innerHTML = `
    <div class="stCardTop">
      <div class="stBadge">🥾</div>
      <div style="flex:1;min-width:0">
        <div class="stTitle" title="${escapeHtml(pick.name)}">${escapeHtml(pick.name)}</div>
      </div>
    </div>

    <div class="stPreview"><canvas width="600" height="180"></canvas></div>

    <div class="stChips">
      <div class="stChip" data-chip="dist">📏 —</div>
      <div class="stChip" data-chip="elev">↑ —</div>
      <div class="stChip" data-chip="exit">🚪 —</div>
    </div>

    <div class="stActions">
      <button class="stBtn" data-act="preview">🗺️</button>
      <button class="stBtn primary" data-act="select">✓</button>
    </div>
  `;

  const bPrev = c.querySelector('[data-act="preview"]');
  const bSel  = c.querySelector('[data-act="select"]');

  bPrev.onclick = async () => {
    await buildAndShowRoute(pick, { updateCard: c });
  };
  bSel.onclick = async () => {
    await buildAndShowRoute(pick, { updateCard: c });
  };

  return c;
}

/* =========================
   CARD PREVIEW CANVAS
   ========================= */
function drawMiniPreview(canvas, coords){
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;

  const g = ctx.createLinearGradient(0,0,0,h);
  g.addColorStop(0, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,w,h);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
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
    ctx.moveTo(w*0.18, h*0.55);
    ctx.lineTo(w*0.82, h*0.45);
    ctx.stroke();

    ctx.strokeStyle = "rgba(50,213,131,0.6)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(w*0.22, h*0.72);
    ctx.lineTo(w*0.58, h*0.32);
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

  ctx.strokeStyle = "rgba(78,161,255,0.90)";
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

/* =========================
   LOAD PREVIEW GEOMETRY
   ========================= */
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

/* =========================
   BUILD FULL ROUTE + UPDATE CHIPS + SHOW MAP
   ========================= */
async function buildAndShowRoute(pick, { updateCard } = {}){
  state.activePick = pick;
  state.activeRoute = null;

  go("map");
  ensureMap();
  setTimeout(invalidateMap, 180);

  const route = await buildRouteFromRelation(pick.id, pick.name);
  state.activeRoute = route;

  renderRouteOnMap(route);
  applyPlan("A");

  if(updateCard){
    const distEl = updateCard.querySelector('[data-chip="dist"]');
    const elevEl = updateCard.querySelector('[data-chip="elev"]');
    const exitEl = updateCard.querySelector('[data-chip="exit"]');

    if(distEl) distEl.textContent = `📏 ${route.lengthKm ? round1(route.lengthKm)+"km" : "—"}`;
    if(elevEl) elevEl.textContent = `↑ ${route.elevUpM != null ? Math.round(route.elevUpM)+"m" : "—"}`;
    if(exitEl) exitEl.textContent = `🚪 ${(route.exits||[]).length}`;
  }
}

/* =========================
   ROUTE BUILD (real)
   ========================= */
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

  return { name, coords: simplified, lengthKm, elevUpM: elev.up, elevDownM: elev.down, exits };
}

/* =========================
   STITCH / CLEAN
   ========================= */
function stitchSegments(segments){
  if(!segments.length) return [];
  segments = segments.slice().sort((a,b)=> b.length - a.length);
  let path = segments.shift().slice();

  while(segments.length){
    let bestIdx = -1, bestMode = null, bestDist = Infinity;
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
        bestDist = local;
        bestIdx = i;
        bestMode =
          (local===d1) ? "tail_head" :
          (local===d2) ? "tail_tail" :
          (local===d3) ? "head_tail" : "head_head";
      }
    }

    const seg = segments.splice(bestIdx, 1)[0];
    if(bestDist > CFG.STITCH_MAX_JOIN_M) continue;

    if(bestMode === "tail_head") path = path.concat(seg);
    else if(bestMode === "tail_tail") path = path.concat(seg.slice().reverse());
    else if(bestMode === "head_tail") path = seg.concat(path);
    else path = seg.slice().reverse().concat(path);
  }

  return path;
}

function dedupeConsecutive(coords){
  const out = [];
  let prev = null;
  for(const c of coords){
    if(!prev || c[0] !== prev[0] || c[1] !== prev[1]) out.push(c);
    prev = c;
  }
  return out;
}

function simplifyEveryN(coords, n){
  if(n <= 1 || coords.length < 3) return coords;
  const out = [];
  for(let i=0;i<coords.length;i++){
    if(i===0 || i===coords.length-1 || (i % n === 0)) out.push(coords[i]);
  }
  return out;
}

/* =========================
   ELEVATION
   ========================= */
async function computeElevationGain(coords){
  const sampled = samplePolyline(coords, CFG.ELEV_SAMPLE_MAX_POINTS);
  const elevations = [];

  for(let i=0;i<sampled.length;i += CFG.ELEV_BATCH_SIZE){
    const chunk = sampled.slice(i, i+CFG.ELEV_BATCH_SIZE);
    const vals = await retry(() => fetchElevations(chunk), CFG.ELEV_RETRIES, CFG.ELEV_DELAY_MS);
    elevations.push(...vals);
    await sleep(CFG.ELEV_DELAY_MS);
  }

  let up = 0, down = 0;
  for(let i=1;i<elevations.length;i++){
    const a = elevations[i-1], b = elevations[i];
    if(a==null || b==null) continue;
    const diff = b - a;
    if(Math.abs(diff) < 2) continue;
    if(diff > 0) up += diff;
    else down += (-diff);
  }
  return { up: Math.round(up), down: Math.round(down) };
}

async function fetchElevations(latlonArr){
  const loc = latlonArr.map(p => `${p[0]},${p[1]}`).join("|");
  const url = `https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(loc)}`;
  const r = await fetch(url, { headers:{ "Accept":"application/json" }});
  if(!r.ok) throw new Error("elev http");
  const d = await r.json();
  const res = d?.results || [];
  return res.map(x => (typeof x.elevation === "number" ? x.elevation : null));
}

/* =========================
   EXITS
   ========================= */
async function computeAssistedExits(routeCoords){
  const samples = samplePolyline(routeCoords, CFG.EXIT_SAMPLE_POINTS);

  const parts = samples.map(([lat,lon]) => `
(
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["highway"="bus_stop"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["public_transport"="platform"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["railway"="station"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["railway"="tram_stop"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["amenity"="parking"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["amenity"="taxi"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["amenity"="shelter"];
  node(around:${CFG.EXIT_AROUND_M},${lat},${lon})["tourism"="alpine_hut"];
);
`).join("\n");

  const q = `[out:json][timeout:25]; ${parts} out tags ${CFG.EXIT_MAX*25};`;
  const data = await overpass(q);

  const nodes = (data.elements || []).filter(e => e.type==="node" && typeof e.lat==="number" && typeof e.lon==="number");

  let exits = nodes.map(n => {
    const t = n.tags || {};
    const icon =
      t.railway==="station" ? "🚆" :
      t.railway==="tram_stop" ? "🚋" :
      t.highway==="bus_stop" ? "🚍" :
      t.public_transport==="platform" ? "🚏" :
      t.amenity==="parking" ? "🅿️" :
      t.amenity==="taxi" ? "🚕" :
      t.amenity==="shelter" ? "🛖" :
      t.tourism==="alpine_hut" ? "🏔️" : "🚪";

    const distM = fastDistancePointToPolylineM([n.lat,n.lon], routeCoords);
    return { lat:n.lat, lon:n.lon, icon, distToRouteM: distM, score: scoreExit(icon, distM) };
  });

  exits = exits.filter(x => x.distToRouteM != null && x.distToRouteM <= 1200);
  exits = dedupeByDistance(exits, CFG.EXIT_DEDUPE_M);
  exits.sort((a,b) => (a.score - b.score) || (a.distToRouteM - b.distToRouteM));

  return exits.slice(0, CFG.EXIT_MAX);
}

function scoreExit(icon, distM){
  const base =
    icon==="🚆" ? 1 :
    icon==="🚍" ? 2 :
    icon==="🚏" ? 2.2 :
    icon==="🚋" ? 2.4 :
    icon==="🅿️" ? 3 :
    icon==="🏔️" ? 3.2 :
    icon==="🛖" ? 3.4 :
    icon==="🚕" ? 3.8 : 4.2;
  return base + ((distM ?? 9999) / 500);
}
function fastDistancePointToPolylineM(pt, coords){
  let best = Infinity;
  for(let i=0;i<coords.length;i+=6){
    best = Math.min(best, haversineM(pt, coords[i]));
  }
  return best === Infinity ? null : best;
}
function dedupeByDistance(points, thresholdM){
  const out = [];
  for(const p of points){
    let ok = true;
    for(const q of out){
      if(haversineM([p.lat,p.lon],[q.lat,q.lon]) < thresholdM){ ok=false; break; }
    }
    if(ok) out.push(p);
  }
  return out;
}

/* =========================
   MAP
   ========================= */
function ensureMap(){
  if(state.map) return;

  state.map = L.map("mapView", { zoomControl:true, preferCanvas:true });

  const tiles = [
    { url:"https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" },
    { url:"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" },
    { url:"https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png" }
  ];

  let idx = 0;
  const setTile = (i) => {
    idx = i;
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
  if(state.layerPlan){ state.layerPlan.remove(); state.layerPlan=null; }
  if(state.layerMain){ state.layerMain.remove(); state.layerMain=null; }
  if(state.layerExits){ state.layerExits.remove(); state.layerExits=null; }
  if(state.markerHighlight){ state.markerHighlight.remove(); state.markerHighlight=null; }
}

function renderRouteOnMap(route){
  ensureMap();
  clearMapLayers();

  state.layerMain = L.polyline(route.coords.map(c=>[c[0],c[1]]), { color:"#4ea1ff", weight:5, opacity:0.95 }).addTo(state.map);

  state.layerExits = L.layerGroup().addTo(state.map);
  for(const x of (route.exits || [])){
    const m = L.circleMarker([x.lat,x.lon], { radius:7, color:"#ffcc00", weight:2, fillColor:"#ffcc00", fillOpacity:0.9 }).addTo(state.layerExits);
    m.bindPopup(`${x.icon}`);
    x._marker = m;
  }

  try{ state.map.fitBounds(state.layerMain.getBounds().pad(0.15)); }catch(e){}
  applyPlan("A");
  setTimeout(invalidateMap, 120);
}

/* =========================
   PLANS
   ========================= */
function applyPlan(p){
  state.plan = p;
  const route = state.activeRoute;
  if(!route?.coords?.length || !state.map) return;

  if(state.layerPlan){ state.layerPlan.remove(); state.layerPlan=null; }
  const coords = route.coords;

  if(p === "A"){
    state.layerPlan = L.polyline(coords.map(c=>[c[0],c[1]]), { color:"#32d583", weight:6, opacity:0.85 }).addTo(state.map);
    return;
  }

  const cutRatio = (p==="B") ? 0.7 : 0.5;
  const cut = Math.max(2, Math.floor(coords.length * cutRatio));
  state.layerPlan = L.polyline(coords.slice(0, cut).map(c=>[c[0],c[1]]), { color:(p==="B")?"#32d583":"#ffcc00", weight:(p==="B")?6:7, opacity:0.9 }).addTo(state.map);
}

/* =========================
   SOS OVERLAY
   ========================= */
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

  sheet.appendChild(bigBtn("🚪", () => {
    const x = state.activeRoute?.exits?.[0];
    if(x){
      if(state.markerHighlight){ state.markerHighlight.remove(); state.markerHighlight=null; }
      state.markerHighlight = L.marker([x.lat,x.lon]).addTo(state.map);
      state.map.setView([x.lat,x.lon], Math.max(14, state.map.getZoom()), { animate:true });
    }
    removeSOSOverlay();
  }));
  sheet.appendChild(bigBtn("🗺️", () => { removeSOSOverlay(); invalidateMap(); }));
  sheet.appendChild(bigBtn("📞", () => { window.location.href="tel:112"; }));
  sheet.appendChild(bigBtn("✕", () => { removeSOSOverlay(); state.stressMode=false; }));

  wrap.appendChild(sheet);
  document.body.appendChild(wrap);
  state.overlaySOS = wrap;

  applyPlan("C");
}

function bigBtn(icon, onClick){
  const b = document.createElement("button");
  b.type="button";
  b.textContent=icon;
  b.style.width="100%";
  b.style.padding="22px 14px";
  b.style.fontSize="28px";
  b.style.borderRadius="18px";
  b.style.border="1px solid rgba(255,255,255,0.12)";
  b.style.background="rgba(255,255,255,0.08)";
  b.style.color="white";
  b.onclick=onClick;
  return b;
}

function removeSOSOverlay(){
  if(state.overlaySOS){
    state.overlaySOS.remove();
    state.overlaySOS = null;
  }
}

/* =========================
   OVERPASS + UTILS
   ========================= */
async function overpass(query){
  let lastErr=null;
  for(const ep of CFG.OVERPASS){
    try{
      const r = await fetch(ep,{method:"POST",headers:{ "Content-Type":"text/plain;charset=UTF-8" },body:query});
      if(!r.ok) throw new Error("overpass http");
      return await r.json();
    }catch(e){ lastErr=e; }
  }
  throw lastErr || new Error("overpass fail");
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function retry(fn,times,delayMs){
  let last;
  for(let i=0;i<=times;i++){
    try{ return await fn(); }catch(e){ last=e; await sleep(delayMs); }
  }
  throw last;
}
function round1(n){ return Math.round(n*10)/10; }
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
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

/* Optional: keep map healthy */
document.addEventListener("visibilitychange", () => {
  if(!document.hidden && state.screen === "map"){
    setTimeout(invalidateMap, 200);
  }
});