/* SafeTrek – App Look + Concierge-Chat (A)
   Views: splash -> home -> dashboard -> route -> chat
   Chat führt ALLES: Region/Radius/Route-Auswahl passiert im Chat, wenn nötig.
   Dashboard ist nur optionaler Shortcut.
*/

const $ = (id) => document.getElementById(id);

const views = {
  splash: $("view-splash"),
  home: $("view-home"),
  dash: $("view-dashboard"),
  route: $("view-route"),
  chat: $("view-chat")
};

const resetBtn = $("resetBtn");

// Dashboard controls
const regionSelect = $("regionSelect");
const radiusSelect = $("radiusSelect");
const btnFindRoutes = $("btnFindRoutes");
const routeStatus = $("routeStatus");
const routeList = $("routeList");
const btnOpenChatNoRoute = $("btnOpenChatNoRoute");

// Route view controls
const btnBackToDash = $("btnBackToDash");
const routeTitle = $("routeTitle");
const routeMeta = $("routeMeta");
const weatherLine = $("weatherLine");
const exitList = $("exitList");
const btnStartChatWithRoute = $("btnStartChatWithRoute");

// Home buttons
const btnGuest = $("btnGuest");
const btnLogin = $("btnLogin");
const btnRegister = $("btnRegister");

// Chat controls
const chatEl = $("chat");
const form = $("form");
const input = $("input");
const quickRepliesEl = $("quickReplies");

// ---------- SW ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(()=>{});
}

// ---------- App State ----------
const STORAGE_KEY = "safetrek_app_v2_concierge";

const defaultState = {
  selectedRegion: "München",
  radiusKm: 15,
  candidates: [],
  selectedRoute: null,   // {id,name,coords,lengthKm,bbox}
  weather: null,         // {tempC, windKmh, rainChance}
  exits: [],             // {kind,name,lat,lon,distToRouteM}

  chat: {
    step: "idle",
    profile: { stamina:null, breakNeed:null, safety:null },
    daily: { energy:null, pain:null, mental:null },
    wantsSuggestions: null,

    // chat-local route search
    chatRegion: null,
    chatRadiusKm: null,
    chatCandidates: [],
    chatPicked: null,

    history: []
  }
};

let state = loadState();

// ---------- Persist ----------
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
function hardReset(){
  localStorage.removeItem(STORAGE_KEY);
  state = structuredClone(defaultState);
  saveState();
  location.reload();
}

// ---------- Views ----------
function showView(which){
  Object.values(views).forEach(v => v.classList.remove("view--active"));
  views[which].classList.add("view--active");

  // black-map fix: if we open route view, force resize a few times
  if (which === "route") {
    setTimeout(() => invalidateMapSafe(true), 0);
    setTimeout(() => invalidateMapSafe(true), 250);
    setTimeout(() => invalidateMapSafe(true), 900);
  }
}

// Splash -> Home
function bootSplash(){
  setTimeout(() => showView("home"), 1700);
}

// ---------- Geo helpers ----------
function haversineKm(lat1, lon1, lat2, lon2){
  const R=6371;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function lengthKm(coords){
  let km=0;
  for (let i=1;i<coords.length;i++){
    const [a1,o1]=coords[i-1], [a2,o2]=coords[i];
    km += haversineKm(a1,o1,a2,o2);
  }
  return km;
}
function bboxFromCoords(coords){
  let minLat= 999, minLon= 999, maxLat=-999, maxLon=-999;
  for (const [lat,lon] of coords){
    minLat=Math.min(minLat,lat); minLon=Math.min(minLon,lon);
    maxLat=Math.max(maxLat,lat); maxLon=Math.max(maxLon,lon);
  }
  return {minLat,minLon,maxLat,maxLon};
}
function distToRouteMeters(routeCoords, lat, lon){
  let bestKm=Infinity;
  for (let i=0;i<routeCoords.length;i+=2){
    const [rlat,rlon]=routeCoords[i];
    const km=haversineKm(rlat,rlon,lat,lon);
    if (km<bestKm) bestKm=km;
  }
  return Math.round(bestKm*1000);
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
  const url="https://overpass-api.de/api/interpreter";
  const resp=await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
    body:"data="+encodeURIComponent(query)
  });
  if (!resp.ok) throw new Error("Overpass Fehler: "+resp.status);
  return await resp.json();
}

// “Saubere Route”: use WAY geometry (ordered), not relations.
async function searchTrailWays(regionName, radiusKm){
  const r = REGIONS[regionName];
  const radiusM = Math.round(radiusKm*1000);

  const q = `
    [out:json][timeout:35];
    (
      way(around:${radiusM},${r.lat},${r.lon})["highway"~"path|footway|track"]["foot"!~"no"];
    );
    out tags geom;
  `;

  const data = await overpass(q);
  const ways = (data.elements||[]).filter(e=>e.type==="way" && Array.isArray(e.geometry) && e.geometry.length>=25);

  const candidates=[];
  for (const w of ways){
    const coords=w.geometry.map(p=>[p.lat,p.lon]);
    const km=lengthKm(coords);
    if (km<1.2 || km>18) continue;
    const name=w.tags?.name || w.tags?.ref || "Weg/Trail (OSM)";
    candidates.push({ id:w.id, name, lengthKm: Math.round(km*10)/10 });
  }

  candidates.sort((a,b)=>b.lengthKm-a.lengthKm);
  const seen=new Set();
  const unique=[];
  for (const c of candidates){
    const k=c.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(c);
    if (unique.length>=10) break;
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
  const w = (data.elements||[])[0];
  if (!w || !Array.isArray(w.geometry) || w.geometry.length<10) throw new Error("Keine Geometrie");
  const coords=w.geometry.map(p=>[p.lat,p.lon]);
  const km=Math.round(lengthKm(coords)*10)/10;
  const name=w.tags?.name || w.tags?.ref || "Route (OSM Way)";
  return { id: wayId, name, coords, lengthKm: km, bbox: bboxFromCoords(coords) };
}

async function fetchExitPOIsNearRoute(route){
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
  const nodes = (data.elements||[]).filter(e=>e.type==="node" && Number.isFinite(e.lat) && Number.isFinite(e.lon));

  const exits=[];
  for (const n of nodes){
    const kind =
      n.tags?.amenity==="parking" ? "Parkplatz" :
      n.tags?.highway==="bus_stop" ? "Bus" :
      n.tags?.railway==="station" ? "Bahn" :
      n.tags?.aerialway==="station" ? "Seilbahn" : "Exit";

    const name = n.tags?.name || kind;
    const distM = distToRouteMeters(route.coords, n.lat, n.lon);
    if (distM>900) continue;
    exits.push({ kind, name, lat:n.lat, lon:n.lon, distToRouteM: distM });
  }

  exits.sort((a,b)=>a.distToRouteM-b.distToRouteM);
  return exits.slice(0, 12);
}

// ---------- Weather ----------
async function fetchWeather(lat, lon){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,precipitation&hourly=precipitation_probability&forecast_days=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Weather API Fehler");
  const data = await resp.json();
  const tempC = data?.current?.temperature_2m ?? null;
  const windKmh = data?.current?.wind_speed_10m ?? null;

  let rainChance=null;
  const probs=data?.hourly?.precipitation_probability;
  if (Array.isArray(probs) && probs.length){
    rainChance=Math.max(...probs.slice(0,12));
  }
  return { tempC, windKmh, rainChance };
}

// ---------- Map ----------
let leafletMap=null;
let routePolyline=null;
let exitMarkers=[];

function ensureMap(){
  if (!window.L) return;
  const el = $("map");
  if (!el) return;

  if (!leafletMap){
    leafletMap = L.map("map", { zoomControl:true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom:18,
      attribution:"© OpenStreetMap"
    }).addTo(leafletMap);
  }
  invalidateMapSafe();
}

function invalidateMapSafe(force=false){
  if (!leafletMap) return;
  try{ leafletMap.invalidateSize(force); }catch{}
}

function drawRouteAndExits(route, exits){
  ensureMap();

  if (routePolyline){ routePolyline.remove(); routePolyline=null; }
  for (const m of exitMarkers) m.remove();
  exitMarkers=[];

  routePolyline = L.polyline(route.coords, { weight:4 }).addTo(leafletMap);
  leafletMap.fitBounds(routePolyline.getBounds(), { padding:[20,20] });

  for (const e of exits){
    const color =
      e.kind==="Bahn" ? "#60a5fa" :
      e.kind==="Bus" ? "#34d399" :
      e.kind==="Seilbahn" ? "#fbbf24" :
      e.kind==="Parkplatz" ? "#a78bfa" : "#ffffff";

    const m = L.circleMarker([e.lat,e.lon], { radius:6, weight:2, color }).addTo(leafletMap);
    m.bindPopup(`${e.kind}: ${e.name}<br>~${e.distToRouteM} m von der Route`);
    exitMarkers.push(m);
  }

  // extra invalidates for iOS black map issue
  setTimeout(()=>invalidateMapSafe(true), 0);
  setTimeout(()=>invalidateMapSafe(true), 250);
  setTimeout(()=>invalidateMapSafe(true), 900);
}

window.addEventListener("orientationchange", ()=> setTimeout(()=>invalidateMapSafe(true), 350));
document.addEventListener("visibilitychange", ()=>{
  if (!document.hidden) setTimeout(()=>invalidateMapSafe(true), 250);
});

// ---------- Dashboard UI ----------
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (m)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}

function renderRouteList(){
  routeList.innerHTML="";
  state.candidates.forEach((c, idx)=>{
    const div=document.createElement("div");
    div.className="item";
    div.innerHTML = `
      <div class="itemTitle">${idx+1}. ${escapeHtml(c.name)}</div>
      <div class="itemMeta">~${c.lengthKm} km • OpenStreetMap</div>
      <button class="ghost itemBtn" data-id="${c.id}">Route ansehen</button>
    `;
    div.querySelector("button").onclick = () => openRouteById(c.id);
    routeList.appendChild(div);
  });
}

async function openRouteById(wayId){
  routeStatus.textContent="";
  try{
    showView("route");
    routeTitle.textContent="Lade Route…";
    routeMeta.textContent="";
    weatherLine.textContent="";
    exitList.innerHTML="";

    const route = await loadWayGeometry(wayId);
    state.selectedRoute = route;

    const [lat, lon] = route.coords[0];
    try{ state.weather = await fetchWeather(lat, lon); }
    catch{ state.weather = null; }

    try{ state.exits = await fetchExitPOIsNearRoute(route); }
    catch{ state.exits = []; }

    saveState();

    routeTitle.textContent = route.name;
    routeMeta.textContent = `Distanz: ~${route.lengthKm} km • Exit-Punkte: ${state.exits.length}`;

    if (state.weather){
      const w=state.weather;
      weatherLine.textContent = `Wetter: ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regenrisiko ~${w.rainChance ?? "?"}%`;
    } else {
      weatherLine.textContent = "Wetter: konnte gerade nicht geladen werden.";
    }

    exitList.innerHTML="";
    if (!state.exits.length){
      const empty=document.createElement("div");
      empty.className="item";
      empty.innerHTML = `<div class="itemTitle">Keine Exit-Punkte gefunden</div><div class="itemMeta">Versuch eine andere Route oder Region.</div>`;
      exitList.appendChild(empty);
    } else {
      state.exits.slice(0,10).forEach(e=>{
        const div=document.createElement("div");
        div.className="item";
        div.innerHTML = `
          <div class="itemTitle">${e.kind}: ${escapeHtml(e.name)}</div>
          <div class="itemMeta">~${e.distToRouteM} m von der Route</div>
        `;
        exitList.appendChild(div);
      });
    }

    drawRouteAndExits(route, state.exits);

  }catch(err){
    routeTitle.textContent="Fehler beim Laden";
    routeMeta.textContent="Bitte zurück und andere Route wählen.";
  }
}

// ---------- CHAT (Concierge-first) ----------
function chatPush(role, text){
  state.chat.history.push({role, text, t: new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})});
  saveState();
  renderChat();
}

function renderChat(){
  chatEl.innerHTML="";
  for (const m of state.chat.history){
    const row=document.createElement("div");
    row.className=`msg ${m.role}`;
    const meta=document.createElement("div");
    meta.className="meta";
    meta.textContent = m.role==="bot" ? `SafeTrek • ${m.t}` : `Du • ${m.t}`;
    const bubble=document.createElement("div");
    bubble.className="bubble";
    bubble.textContent=m.text;
    const wrap=document.createElement("div");
    wrap.appendChild(meta); wrap.appendChild(bubble);
    row.appendChild(wrap);
    chatEl.appendChild(row);
  }
    // ✅ Wenn wir gerade im "Route auswählen"-Step sind: Cards nach jedem Render wieder anzeigen
  if (state.chat.step === "pick_route" && Array.isArray(state.chat.chatCandidates) && state.chat.chatCandidates.length) {
    state.chat.chatCandidates.slice(0, 10).forEach((route, index) => {
      const row = document.createElement("div");
      row.className = "msg bot";

      const wrap = document.createElement("div");
      wrap.appendChild(chatRouteCard(route, index));

      row.appendChild(wrap);
      chatEl.appendChild(row);
    });
  }
  window.requestAnimationFrame(()=>window.scrollTo(0,document.body.scrollHeight));
  renderQuickReplies();
}
function chatRouteCard(route, index){
  const card = document.createElement("div");
  card.className = "chat-card";

  const title = document.createElement("div");
  title.className = "chat-card__title";
  title.textContent = `🌲 ${route.name}`;

  const meta = document.createElement("div");
  meta.className = "chat-card__meta";
  meta.textContent = `~${route.lengthKm} km · Quelle: OpenStreetMap`;

  const actions = document.createElement("div");
  actions.className = "chat-card__actions";

  const btnView = document.createElement("button");
  btnView.className = "secondary";
  btnView.textContent = "Route ansehen";
  btnView.onclick = () => {
    openRouteById(route.id);
    showView("route");
  };

  const btnSelect = document.createElement("button");
  btnSelect.textContent = "Diese Route wählen";
  btnSelect.onclick = () => {
    handleChatInput(String(index + 1));
  };

  actions.appendChild(btnView);
  actions.appendChild(btnSelect);

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(actions);

  return card;
}
function renderQuickReplies(){
  quickRepliesEl.innerHTML="";
  const s=state.chat.step;

  const add=(t)=>{
    const b=document.createElement("button");
    b.className="qbtn";
    b.type="button";
    b.textContent=t;
    b.onclick=()=>handleChatInput(t);
    quickRepliesEl.appendChild(b);
  };

  if (s==="ask_stamina") ["1","2","3","4","5"].forEach(add);
  else if (s==="ask_breakNeed") ["1","2","3","4","5"].forEach(add);
  else if (s==="ask_safety") ["2","3","4","5"].forEach(add);
  else if (s==="ask_energy") ["1","2","3","4","5"].forEach(add);
  else if (s==="ask_pain") ["1","2","3","4","5"].forEach(add);
  else if (s==="ask_mental") ["1","2","3","4","5"].forEach(add);

  else if (s==="ask_wantsSuggestions") ["Ja","Nein"].forEach(add);

  else if (s==="ask_useExistingRoute") ["Ja, nutzen","Andere Route"].forEach(add);

  else if (s==="ask_region") Object.keys(REGIONS).forEach(add);
  else if (s==="ask_radius") ["10 km","15 km","25 km"].forEach(add);

  else if (s==="pick_route"){
    const n = state.chat.chatCandidates.length;
    for (let i=1;i<=Math.min(n,10);i++) add(String(i));
    add("Andere Region");
    add("Abbrechen");
  }

  else if (s==="after_route") ["Pläne berechnen","Assisted Exit","Packliste","Karte öffnen","Andere Route"].forEach(add);
  else if (s==="after_plans") ["Assisted Exit","Packliste","Karte öffnen","Andere Route"].forEach(add);
  else if (s==="after_pack") ["Zurück zu Plänen","Assisted Exit","Karte öffnen","Andere Route"].forEach(add);
  else if (s==="after_exit") ["Zurück zu Plänen","Packliste","Karte öffnen","Andere Route"].forEach(add);

  else if (s==="idle") ["Neue Planung starten","Dashboard öffnen"].forEach(add);
}

function computeReadiness(profile, daily){
  const stamina=Number(profile.stamina);
  const energy=Number(daily.energy);
  const pain=Number(daily.pain);
  const mental=Number(daily.mental);
  return Math.max(1, Math.min(5, (stamina*1.2 + energy*1.5 + (6-pain)*1.0 + (6-mental)*0.8) / 4.5));
}
function estimateDurationMin(distanceKm, breakNeed, safety){
  const base=20;
  const breakFactor = breakNeed>=4 ? 1.25 : breakNeed===3 ? 1.15 : 1.05;
  const safetyFactor = safety>=4 ? 1.18 : safety===3 ? 1.12 : 1.05;
  return Math.round(distanceKm*base*breakFactor*safetyFactor);
}
function buildPlans(routeKm){
  const readiness = computeReadiness(state.chat.profile, state.chat.daily);
  const breakNeed = Number(state.chat.profile.breakNeed);
  const safety = Number(state.chat.profile.safety);
  const w = state.weather;

  const weatherPenalty = w && ((w.rainChance ?? 0) >= 65 || (w.windKmh ?? 0) >= 30) ? 0.6 : 1.0;

  const baseKm=routeKm;
  const aKm=Math.round(baseKm*0.70*weatherPenalty*10)/10;
  const bKm=Math.round(baseKm*0.85*weatherPenalty*10)/10;
  const cKm=Math.round(baseKm*1.00*weatherPenalty*10)/10;

  const aMin=estimateDurationMin(aKm, breakNeed, safety);
  const bMin=estimateDurationMin(bKm, breakNeed, safety);
  const cMin=estimateDurationMin(cKm, breakNeed, safety);

  let guidance="";
  if (readiness<=2.2) guidance="Heute konservativ: Plan A empfohlen. Früh umdrehen ist Erfolg, nicht Scheitern.";
  else if (readiness<=3.2) guidance="Heute realistisch: Plan A oder B. Pausen aktiv einplanen.";
  else guidance="Heute stabil: Plan B gut machbar. Plan C nur, wenn du dich unterwegs weiterhin gut fühlst.";

  if (weatherPenalty<1.0) guidance += " Wetter wirkt anspruchsvoller (Regen/Wind). Extra Puffer einplanen.";

  const ap=(pct)=>[
    {when:"nach 20–30 min", note:"Check-in: Atmung, Schmerz, Kopf frei? Wenn nein → zurück."},
    {when:`${Math.round(pct*100)}% der Strecke`, note:"Umkehrpunkt: Wenn du zweifelst, dreh hier um."},
    {when:"bei Wetter-/Bodenwechsel", note:"Wenn Bedingungen kippen: Abbrechen + Assisted Exit."}
  ];

  return {
    readiness,
    guidance,
    plans:[
      {label:"Plan A", distanceKm:aKm, durationMin:aMin, abort:ap(0.35)},
      {label:"Plan B", distanceKm:bKm, durationMin:bMin, abort:ap(0.45)},
      {label:"Plan C", distanceKm:cKm, durationMin:cMin, abort:ap(0.55)}
    ]
  };
}
function packlist(){
  const items=[];
  const breakNeed=Number(state.chat.profile.breakNeed);
  const pain=Number(state.chat.daily.pain);
  const mental=Number(state.chat.daily.mental);
  const w=state.weather;

  items.push({name:"Wasser", why:"Stabilisiert Energie & reduziert Stress bei Pausen."});
  items.push({name:"Snack", why:"Hilft gegen Energieschwankungen und mentale Überforderung."});
  if ((w?.rainChance ?? 0) >= 40) items.push({name:"Regenjacke", why:"Regen erhöht Erschöpfungsdruck & Auskühlung."});
  if ((w?.windKmh ?? 0) >= 25) items.push({name:"Wärmeschicht", why:"Wind verstärkt Kälte, besonders bei Pausen."});
  if (breakNeed>=4) items.push({name:"Sitzunterlage", why:"Macht Pausen leichter & planbarer."});
  if (pain>=4) items.push({name:"Support-Item (Bandage etc.)", why:"Reduziert Risiko, dass Abbruch zur Krise wird."});
  if (mental>=4) items.push({name:"Beruhigungsanker", why:"Hilft gegen Überforderung (Atemkarte, Musik, Duft)."});
  items.push({name:"Akku/Offline", why:"Damit Safety-Inhalte verfügbar bleiben."});
  return items;
}

function startChat(){
  showView("chat");

  if (state.chat.history.length === 0){
    chatPush("bot","Hi, ich bin SafeTrek (Beta). Ich begleite dich heute zu einer sicheren, machbaren Outdoor-Entscheidung — ohne Leistungsdruck.");
    chatPush("bot","Hinweis: Kein Notruf. Kein Ersatz für alpine Beratung/Bergrettung.");
    state.chat.step="ask_stamina"; saveState();
    chatPush("bot","Zum Start: Wie ist deine grundsätzliche Belastbarkeit? (1–5)");
  } else {
    renderChat();
  }
}

// --- Concierge route acquisition inside chat ---
async function chatSearchRoutes(region, radiusKm){
  chatPush("bot",`Okay. Ich suche passende Wege in der Region ${region} (${radiusKm} km Radius)…`);
  try{
    const candidates = await searchTrailWays(region, radiusKm);
    state.chat.chatCandidates = candidates;
    saveState();
    if (!candidates.length){
      state.chat.step = "ask_radius"; saveState();
      return chatPush("bot","Ich habe gerade keine geeigneten Wege gefunden. Wähle bitte einen anderen Radius (10/15/25 km) oder eine andere Region.");
    }

    chatPush("bot","Ich habe passende Touren gefunden. Wähle eine Route:");

state.chat.chatCandidates.slice(0,10).forEach((route, index)=>{
  const row = document.createElement("div");
  row.className = "msg bot";

  const wrap = document.createElement("div");
  wrap.appendChild(chatRouteCard(route, index));

  row.appendChild(wrap);
  chatEl.appendChild(row);
});

state.chat.step = "pick_route";
saveState();
    state.chat.step="pick_route"; saveState();
  }catch{
    state.chat.step="ask_radius"; saveState();
    chatPush("bot","Die Routensuche ist gerade langsam (OpenStreetMap/Overpass). Versuch’s bitte nochmal oder nimm 10 km Radius.");
  }
}

async function chatLoadRouteByIndex(idx){
  const pick = state.chat.chatCandidates[idx];
  if (!pick) return chatPush("bot","Bitte wähle eine gültige Nummer.");
  chatPush("bot","Lade Route, Wetter und Assisted Exit…");

  try{
    const route = await loadWayGeometry(pick.id);
    state.selectedRoute = route;

    const [lat, lon] = route.coords[0];
    try{ state.weather = await fetchWeather(lat, lon); }catch{ state.weather = null; }
    try{ state.exits = await fetchExitPOIsNearRoute(route); }catch{ state.exits = []; }

    // sync also to dashboard preferences
    state.selectedRegion = state.chat.chatRegion || state.selectedRegion;
    state.radiusKm = state.chat.chatRadiusKm || state.radiusKm;

    saveState();

    chatPush("bot",`Route gesetzt: ${route.name} (~${route.lengthKm} km).`);
    if (state.weather){
      const w = state.weather;
      chatPush("bot",`Wetter: ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regenrisiko ~${w.rainChance ?? "?"}%`);
    } else {
      chatPush("bot","Wetter konnte gerade nicht geladen werden.");
    }

    if (state.exits.length){
      const top = state.exits[0];
      chatPush("bot",`Assisted Exit: Nächste Option ist meist „${top.kind}: ${top.name}“ (~${top.distToRouteM} m von der Route).`);
    } else {
      chatPush("bot","Assisted Exit: Ich habe für diese Route gerade keine nahen Exit-Punkte gefunden.");
    }

    state.chat.step="after_route"; saveState();
    chatPush("bot","Was möchtest du als Nächstes? (Pläne berechnen / Assisted Exit / Packliste / Karte öffnen)");
  }catch{
    chatPush("bot","Diese Route konnte ich nicht sauber laden. Bitte wähle eine andere Nummer.");
    state.chat.step="pick_route"; saveState();
  }
}

function handleChatInput(raw){
  chatPush("user", raw);
  const s = state.chat.step;

  // global commands
  const low = String(raw).toLowerCase();
  if (low.includes("dashboard öffnen")) { showView("dash"); return; }
  if (low.includes("neue planung")) { state.chat = structuredClone(defaultState.chat); saveState(); startChat(); return; }

  if (s==="ask_stamina"){
    const n = Number(raw); if (!(n>=1 && n<=5)) return chatPush("bot","Bitte 1–5.");
    state.chat.profile.stamina = n; saveState();
    state.chat.step="ask_breakNeed";
    return chatPush("bot","Wie hoch ist dein Pausenbedarf? (1–5)");
  }

  if (s==="ask_breakNeed"){
    const n = Number(raw); if (!(n>=1 && n<=5)) return chatPush("bot","Bitte 1–5.");
    state.chat.profile.breakNeed = n; saveState();
    state.chat.step="ask_safety";
    return chatPush("bot","Wie wichtig ist dir Sicherheit/Puffer? (2–5)");
  }

  if (s==="ask_safety"){
    const n = Number(raw); if (!(n>=2 && n<=5)) return chatPush("bot","Bitte 2–5.");
    state.chat.profile.safety = n; saveState();
    state.chat.step="ask_energy";
    chatPush("bot","Danke. Jetzt Tagesform-Check.");
    return chatPush("bot","Wie ist deine Energie heute? (1–5)");
  }

  if (s==="ask_energy"){
    const n = Number(raw); if (!(n>=1 && n<=5)) return chatPush("bot","Bitte 1–5.");
    state.chat.daily.energy = n; saveState();
    state.chat.step="ask_pain";
    return chatPush("bot","Wie hoch ist heute Schmerz/Körperstress? (1–5)");
  }

  if (s==="ask_pain"){
    const n = Number(raw); if (!(n>=1 && n<=5)) return chatPush("bot","Bitte 1–5.");
    state.chat.daily.pain = n; saveState();
    state.chat.step="ask_mental";
    return chatPush("bot","Wie hoch ist heute mentale Überforderung/Unsicherheit? (1–5)");
  }

  if (s==="ask_mental"){
    const n = Number(raw); if (!(n>=1 && n<=5)) return chatPush("bot","Bitte 1–5.");
    state.chat.daily.mental = n; saveState();
    state.chat.step="ask_wantsSuggestions";
    return chatPush("bot","Möchtest du heute Tourenvorschläge erhalten?");
  }

  if (s==="ask_wantsSuggestions"){
    if (low.startsWith("n")){
      state.chat.wantsSuggestions=false; saveState();
      state.chat.step="idle";
      return chatPush("bot","Okay. Wenn du später willst: „Neue Planung starten“.");
    }
    state.chat.wantsSuggestions=true; saveState();

    // Concierge-first:
    // If a route exists, offer to use it; otherwise go straight to region.
    if (state.selectedRoute){
      state.chat.step="ask_useExistingRoute"; saveState();
      return chatPush("bot",`Ich habe bereits eine Route gespeichert: „${state.selectedRoute.name}“. Soll ich diese verwenden?`);
    }

    state.chat.step="ask_region"; saveState();
    chatPush("bot","Alles klar. In welcher Region möchtest du unterwegs sein?");
    chatPush("bot","Tipp: Wenn du unsicher bist, wähle die Region, die sich heute mental am leichtesten anfühlt.");
    return;
  }

  if (s==="ask_useExistingRoute"){
    if (low.includes("ja")){
      state.chat.step="after_route"; saveState();
      chatPush("bot","Super — ich nutze die gespeicherte Route.");
      return chatPush("bot","Was möchtest du als Nächstes? (Pläne berechnen / Assisted Exit / Packliste / Karte öffnen)");
    }
    // other route
    state.chat.step="ask_region"; saveState();
    return chatPush("bot","Okay. Welche Region möchtest du heute? (München, Garmisch, Salzburg, Innsbruck)");
  }

  if (s==="ask_region"){
    const region = Object.keys(REGIONS).find(r => r.toLowerCase() === low);
    if (!region) return chatPush("bot","Bitte wähle: München, Garmisch, Salzburg oder Innsbruck.");
    state.chat.chatRegion = region;
    state.chat.step="ask_radius"; saveState();
    return chatPush("bot","Wie groß soll der Suchradius sein? (10 km / 15 km / 25 km)");
  }

  if (s==="ask_radius"){
    let km = null;
    if (low.includes("10")) km = 10;
    if (low.includes("15")) km = 15;
    if (low.includes("25")) km = 25;
    if (![10,15,25].includes(km)) return chatPush("bot","Bitte 10 km, 15 km oder 25 km wählen.");
    state.chat.chatRadiusKm = km;
    saveState();
    return chatSearchRoutes(state.chat.chatRegion, km);
  }

  if (s==="pick_route"){
    if (low.includes("abbrechen")){
      state.chat.step="idle"; saveState();
      return chatPush("bot","Okay — abgebrochen. Du kannst jederzeit „Neue Planung starten“.");
    }
    if (low.includes("andere region")){
      state.chat.step="ask_region"; saveState();
      return chatPush("bot","Welche Region möchtest du stattdessen?");
    }
    const idx = Number(raw) - 1;
    if (!Number.isFinite(idx) || idx<0 || idx>=state.chat.chatCandidates.length){
      return chatPush("bot","Bitte eine Zahl wählen (z.B. 1) oder „Andere Region“.");
    }
    return chatLoadRouteByIndex(idx);
  }

  // after route / plans / pack / exit
  if (s==="after_route" || s==="after_plans" || s==="after_pack" || s==="after_exit"){
    if (low.includes("karte")){
      if (!state.selectedRoute){
        return chatPush("bot","Noch keine Route gesetzt. Ich kann zuerst Routen suchen (Region wählen).");
      }
      // Open route view and draw
      showView("route");
      // Fill route view quickly from state
      routeTitle.textContent = state.selectedRoute.name;
      routeMeta.textContent = `Distanz: ~${state.selectedRoute.lengthKm} km • Exit-Punkte: ${state.exits.length}`;
      if (state.weather){
        const w=state.weather;
        weatherLine.textContent = `Wetter: ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regenrisiko ~${w.rainChance ?? "?"}%`;
      } else {
        weatherLine.textContent = "Wetter: konnte gerade nicht geladen werden.";
      }
      exitList.innerHTML="";
      (state.exits || []).slice(0,10).forEach(e=>{
        const div=document.createElement("div");
        div.className="item";
        div.innerHTML = `<div class="itemTitle">${e.kind}: ${escapeHtml(e.name)}</div><div class="itemMeta">~${e.distToRouteM} m von der Route</div>`;
        exitList.appendChild(div);
      });
      drawRouteAndExits(state.selectedRoute, state.exits || []);
      // keep chat state; user can come back
      return;
    }

    if (low.includes("andere route")){
      // Keep profile/daily. Just re-run route selection.
      state.chat.step="ask_region";
      state.chat.chatCandidates=[];
      state.chat.chatPicked=null;
      saveState();
      return chatPush("bot","Okay. Welche Region möchtest du jetzt? (München, Garmisch, Salzburg, Innsbruck)");
    }

    if (low.includes("pläne") || low.includes("plaene")){
      if (!state.selectedRoute) {
        state.chat.step="ask_region"; saveState();
        chatPush("bot","Kein Problem — ich suche zuerst eine Route mit dir.");
        return chatPush("bot","Welche Region möchtest du?");
      }
      const result = buildPlans(state.selectedRoute.lengthKm);
      state.chat._plans = result; saveState();

      chatPush("bot",`Readiness: ${result.readiness.toFixed(1)} / 5`);
      chatPush("bot",result.guidance);

      for (const p of result.plans){
        chatPush("bot",`${p.label}\n• Distanz: ${p.distanceKm} km\n• Dauer: ${p.durationMin} min\n• Abbruchpunkte:\n  - ${p.abort[0].when}: ${p.abort[0].note}\n  - ${p.abort[1].when}: ${p.abort[1].note}\n  - ${p.abort[2].when}: ${p.abort[2].note}`);
      }

      state.chat.step="after_plans"; saveState();
      return chatPush("bot","Als nächstes: Assisted Exit oder Packliste?");
    }

    if (low.includes("pack")){
      const items = packlist();
      chatPush("bot","Packliste (begründet):");
      items.forEach(it=>chatPush("bot",`• ${it.name} — ${it.why}`));
      state.chat.step="after_pack"; saveState();
      return chatPush("bot","Als nächstes: Assisted Exit oder zurück zu Plänen?");
    }

    if (low.includes("exit")){
      if (!state.selectedRoute){
        state.chat.step="ask_region"; saveState();
        chatPush("bot","Ich kann Assisted Exit erst sinnvoll anbieten, wenn wir eine Route gewählt haben.");
        return chatPush("bot","Welche Region möchtest du?");
      }

      if (!state.exits?.length){
        state.chat.step="after_exit"; saveState();
        return chatPush("bot","Ich habe für diese Route gerade keine nahen Exit-Punkte gefunden. Versuch eine andere Route/Region.");
      }

      chatPush("bot","Assisted Exit (nahe Optionen):");
      state.exits.slice(0,6).forEach(e=>chatPush("bot",`• ${e.kind}: ${e.name} (~${e.distToRouteM} m von der Route)`));

      // Professional hint
      chatPush("bot","Wenn du abbrechen möchtest: wähle die nächstliegende Option, reduziere Komplexität (breiter Weg, weniger Steigung) und setze einen klaren Umkehrzeitpunkt.");

      state.chat.step="after_exit"; saveState();
      return chatPush("bot","Möchtest du zurück zu Plänen oder zur Packliste?");
    }

    return chatPush("bot","Optionen: Pläne berechnen, Assisted Exit, Packliste, Karte öffnen, Andere Route");
  }

  if (s==="idle"){
    if (low.includes("dashboard")){
      showView("dash"); return;
    }
    if (low.includes("neu")){
      state.chat = structuredClone(defaultState.chat);
      saveState();
      startChat();
      return;
    }
    return chatPush("bot","Tippe „Neue Planung starten“ oder „Dashboard öffnen“.");
  }

  chatPush("bot","Ich bin unsicher. Nutze die Buttons unten.");
}

// ---------- UI wiring ----------
resetBtn.onclick = () => {
  if (!confirm("Wirklich alles zurücksetzen?")) return;
  hardReset();
};

// Home actions (placeholders)
btnLogin.onclick = () => alert("Login ist in dieser Beta noch nicht aktiv.");
btnRegister.onclick = () => alert("Registrieren ist in dieser Beta noch nicht aktiv.");
btnGuest.onclick = () => showView("dash");

// Dashboard restore
regionSelect.value = state.selectedRegion;
radiusSelect.value = String(state.radiusKm);

// Dashboard find routes
btnFindRoutes.onclick = async () => {
  const region = regionSelect.value;
  const radiusKm = Number(radiusSelect.value);

  state.selectedRegion = region;
  state.radiusKm = radiusKm;
  state.candidates = [];
  saveState();

  routeStatus.textContent = "Suche Routen… (5–20 Sekunden)";
  routeList.innerHTML = "";

  try{
    const candidates = await searchTrailWays(region, radiusKm);
    state.candidates = candidates;
    saveState();
    routeStatus.textContent = candidates.length ? `Gefunden: ${candidates.length} Vorschläge` : "Keine Routen gefunden.";
    renderRouteList();
  }catch{
    routeStatus.textContent = "Suche fehlgeschlagen (Overpass ist manchmal langsam). Bitte nochmal versuchen.";
  }
};

// Chat from dashboard (without route is now totally fine)
btnOpenChatNoRoute.onclick = () => startChat();

btnBackToDash.onclick = () => showView("dash");

// Start chat from route detail
btnStartChatWithRoute.onclick = () => startChat();

// Chat form submit
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = input.value.trim();
  if (!val) return;
  input.value = "";
  handleChatInput(val);
});

// Restore dashboard list if cached
function restore(){
  regionSelect.value = state.selectedRegion;
  radiusSelect.value = String(state.radiusKm);
  if (state.candidates?.length) renderRouteList();
}

// ---------- Start ----------
restore();
bootSplash();