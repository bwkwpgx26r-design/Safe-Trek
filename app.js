// app.js
// SafeTrek – Single-file app logic (Chat + Routes + Plans + Weather + Assisted Exit)
// Works with index.html IDs: chatMessages/chatInput/chatSend/quickReplies/map/routeInfo

// ---------- State ----------
const defaultState = {
  view: "dash",
  chat: {
    history: [],
    step: "idle",
    profile: { stamina:null, breakNeed:null, safety:null, energy:null, pain:null },
    wantsRoutes: null,
    region: null,
    radiusKm: 25,
    candidates: [],
    selectedCandidateIndex: null,
    plans: null
  },
  selectedRoute: null,     // { id, name, coords, lengthKm, ascentM, descentM, bbox }
  weather: null,           // { tempC, windKmh, rainChance, code }
  exits: [],               // [{kind,name,lat,lon,distToRouteM,info}]
  map: { instance:null, layer:null, markers:[] }
};

let state = loadState();

// ---------- DOM ----------
const chatEl = () => document.getElementById("chatMessages");
const inputEl = () => document.getElementById("chatInput");
const sendEl  = () => document.getElementById("chatSend");
const quickEl = () => document.getElementById("quickReplies");
const routeInfoEl = () => document.getElementById("routeInfo");
const mapEl = () => document.getElementById("map");

// ---------- Helpers ----------
function saveState(){
  try{ localStorage.setItem("safetreks_state", JSON.stringify(state)); }catch(e){}
}
function loadState(){
  try{
    const raw = localStorage.getItem("safetreks_state");
    if(!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return deepMerge(structuredClone(defaultState), parsed);
  }catch(e){
    return structuredClone(defaultState);
  }
}
function deepMerge(a,b){
  if(typeof b !== "object" || b===null) return a;
  for(const k of Object.keys(b)){
    if(Array.isArray(b[k])) a[k]=b[k];
    else if(typeof b[k]==="object" && b[k]!==null) a[k]=deepMerge(a[k]??{}, b[k]);
    else a[k]=b[k];
  }
  return a;
}

function nowTime(){
  return new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

function showView(name){
  state.view = name;
  document.querySelectorAll("[data-view]").forEach(v=>{
    v.style.display = (v.getAttribute("data-view")===name) ? "block" : "none";
  });
  saveState();
  if(name==="route") ensureMap();
}
window.showView = showView; // used by index.html

function pushMsg(role, text, extra){
  state.chat.history.push({ role, text, t: nowTime(), extra: extra || null });
  saveState();
  renderChat();
}

function clearQuick(){
  const el = quickEl(); if(el) el.innerHTML="";
}
function addQuick(label, onClick){
  const el = quickEl(); if(!el) return;
  const b = document.createElement("button");
  b.className="qbtn";
  b.type="button";
  b.textContent=label;
  b.onclick=onClick;
  el.appendChild(b);
}

function queueChatMessage(text){
  const input = inputEl();
  const send = sendEl();
  if(!input || !send) return;
  input.value = text;
  send.click();
}
window.queueChatMessage = queueChatMessage;

// ---------- Render Chat ----------
function renderChat(){
  const el = chatEl(); if(!el) return;
  el.innerHTML = "";

  for(const m of state.chat.history){
    const row = document.createElement("div");
    row.className = `msg ${m.role}`;

    const wrap = document.createElement("div");
    const meta = document.createElement("div");
    meta.className="meta";
    meta.textContent = (m.role==="bot" ? `SafeTrek • ${m.t}` : `Du • ${m.t}`);

    const bubble = document.createElement("div");
    bubble.className="bubble";

    // If message includes card (route list / plan card / summary), render it
    if(m.extra && m.extra.type==="route_cards"){
      bubble.innerHTML = "";
      bubble.appendChild(routeCardsBlock(m.extra.routes));
    } else if(m.extra && m.extra.type==="route_summary"){
      bubble.innerHTML = "";
      bubble.appendChild(routeSummaryCard());
    } else if(m.extra && m.extra.type==="plan_cards"){
      bubble.innerHTML = "";
      bubble.appendChild(planCardsBlock(m.extra.plans));
    } else if(m.extra && m.extra.type==="exit_cards"){
      bubble.innerHTML = "";
      bubble.appendChild(exitCardsBlock(m.extra.exits));
    } else {
      bubble.textContent = m.text;
    }

    wrap.appendChild(meta);
    wrap.appendChild(bubble);
    row.appendChild(wrap);
    el.appendChild(row);
  }

  requestAnimationFrame(()=> el.scrollTop = el.scrollHeight);
  renderQuickReplies();
}

function routeCardsBlock(routes){
  const box = document.createElement("div");
  box.style.display="grid";
  box.style.gap="10px";

  routes.forEach((r, idx)=>{
    const card = document.createElement("div");
    card.className="chat-card";

    const title = document.createElement("div");
    title.className="chat-card__title";
    title.textContent = `🌲 ${r.name}`;

    const meta = document.createElement("div");
    meta.className="chat-card__meta";
    meta.textContent = `~${r.lengthKm} km • ${r.ascentM ?? "?"} hm ↑ • Quelle: OpenStreetMap`;

    const actions = document.createElement("div");
    actions.className="chat-card__actions";

    const bView = document.createElement("button");
    bView.className="secondary";
    bView.type="button";
    bView.textContent="Route ansehen";
    bView.onclick = async ()=>{
      await openCandidateByIndex(idx);
      showView("route");
    };

    const bPick = document.createElement("button");
    bPick.className="primary";
    bPick.type="button";
    bPick.textContent="Diese Route wählen";
    bPick.onclick = async ()=>{
      await openCandidateByIndex(idx);
      // route summary card inside chat
      pushMsg("bot", "", {type:"route_summary"});
      state.chat.step="after_route";
      saveState();
      pushMsg("bot", "Was möchtest du als Nächstes?", null);
      renderChat();
    };

    actions.appendChild(bView);
    actions.appendChild(bPick);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);
    box.appendChild(card);
  });

  return box;
}

function routeSummaryCard(){
  const r = state.selectedRoute;
  const w = state.weather;
  const exits = state.exits || [];

  const card = document.createElement("div");
  card.className="chat-card";

  const title = document.createElement("div");
  title.className="chat-card__title";
  title.textContent = r ? `✅ Ausgewählt: ${r.name}` : "✅ Route gewählt";

  const meta = document.createElement("div");
  meta.className="chat-card__meta";
  meta.textContent = r
    ? `~${r.lengthKm} km • ${r.ascentM ?? "?"} hm ↑ • ${r.descentM ?? "?"} hm ↓`
    : "";

  const weather = document.createElement("div");
  weather.className="chat-card__meta";
  weather.textContent = w
    ? `🌦️ Wetter: ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regen ~${w.rainChance ?? "?"}%`
    : "🌦️ Wetter: konnte nicht geladen werden.";

  const exitLine = document.createElement("div");
  exitLine.className="chat-card__meta";
  exitLine.textContent = exits.length
    ? `🚪 Assisted Exit: ${exits.length} Optionen gefunden (z.B. ${exits[0].kind}: ${exits[0].name})`
    : "🚪 Assisted Exit: keine nahe Option gefunden.";

  const actions = document.createElement("div");
  actions.className="chat-card__actions";

  const bMap = document.createElement("button");
  bMap.className="secondary";
  bMap.type="button";
  bMap.textContent="Karte öffnen";
  bMap.onclick = ()=> showView("route");

  const bPlans = document.createElement("button");
  bPlans.className="primary";
  bPlans.type="button";
  bPlans.textContent="Plan A/B/C berechnen";
  bPlans.onclick = ()=> {
    computePlans();
    pushMsg("bot","", {type:"plan_cards", plans: state.chat.plans});
    state.chat.step="after_plans";
    saveState();
  };

  const bExit = document.createElement("button");
  bExit.className="secondary";
  bExit.type="button";
  bExit.textContent="Assisted Exit anzeigen";
  bExit.onclick = ()=> {
    pushMsg("bot","", {type:"exit_cards", exits: (state.exits||[]).slice(0,6)});
  };

  const bSOS = document.createElement("button");
  bSOS.className="danger";
  bSOS.type="button";
  bSOS.textContent="🆘 Ich schaffe es nicht weiter";
  bSOS.onclick = ()=> sosFlow();

  actions.appendChild(bMap);
  actions.appendChild(bPlans);
  actions.appendChild(bExit);
  actions.appendChild(bSOS);

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(weather);
  card.appendChild(exitLine);
  card.appendChild(actions);

  return card;
}

function planCardsBlock(plans){
  const box = document.createElement("div");
  box.style.display="grid";
  box.style.gap="10px";

  plans.forEach((p)=>{
    const card = document.createElement("div");
    card.className="chat-card";

    const title = document.createElement("div");
    title.className="chat-card__title";
    title.textContent = `🧭 ${p.name}`;

    const meta = document.createElement("div");
    meta.className="chat-card__meta";
    meta.textContent = `${p.summary}`;

    const actions = document.createElement("div");
    actions.className="chat-card__actions";

    const bShow = document.createElement("button");
    bShow.className="primary";
    bShow.type="button";
    bShow.textContent="Auf Karte anzeigen";
    bShow.onclick = ()=> {
      showPlanOnMap(p.key);
      showView("route");
    };

    const bSOS = document.createElement("button");
    bSOS.className="danger";
    bSOS.type="button";
    bSOS.textContent="🆘 Ich schaffe es nicht weiter";
    bSOS.onclick = ()=> sosFlow();

    actions.appendChild(bShow);
    actions.appendChild(bSOS);

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);
    box.appendChild(card);
  });

  return box;
}

function exitCardsBlock(exits){
  const box = document.createElement("div");
  box.style.display="grid";
  box.style.gap="10px";

  if(!exits || !exits.length){
    const p = document.createElement("div");
    p.textContent = "Keine Exit-Optionen gefunden.";
    box.appendChild(p);
    return box;
  }

  exits.forEach((e)=>{
    const card = document.createElement("div");
    card.className="chat-card";

    const title = document.createElement("div");
    title.className="chat-card__title";
    title.textContent = `🚪 ${e.kind}: ${e.name}`;

    const meta = document.createElement("div");
    meta.className="chat-card__meta";
    meta.textContent = `~${Math.round(e.distToRouteM)} m von der Route • ${e.info || ""}`.trim();

    const actions = document.createElement("div");
    actions.className="chat-card__actions";

    const bShow = document.createElement("button");
    bShow.className="primary";
    bShow.type="button";
    bShow.textContent="Auf Karte anzeigen";
    bShow.onclick = ()=> {
      showExitOnMap(e);
      showView("route");
    };

    actions.appendChild(bShow);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);
    box.appendChild(card);
  });

  return box;
}

function renderQuickReplies(){
  clearQuick();
  const s = state.chat.step;

  // profile steps
  if(s==="ask_stamina") ["1","2","3","4","5"].forEach(v=> addQuick(v,()=>handleChatInput(v)));
  if(s==="ask_breakNeed") ["1","2","3","4","5"].forEach(v=> addQuick(v,()=>handleChatInput(v)));
  if(s==="ask_safety") ["2","3","4","5"].forEach(v=> addQuick(v,()=>handleChatInput(v)));
  if(s==="ask_energy") ["1","2","3","4","5"].forEach(v=> addQuick(v,()=>handleChatInput(v)));
  if(s==="ask_pain") ["1","2","3","4","5"].forEach(v=> addQuick(v,()=>handleChatInput(v)));

  if(s==="ask_wants_routes"){
    addQuick("Ja",()=>handleChatInput("ja"));
    addQuick("Nein",()=>handleChatInput("nein"));
  }

  if(s==="ask_region"){
    addQuick("München",()=>handleChatInput("München"));
    addQuick("Salzburg",()=>handleChatInput("Salzburg"));
    addQuick("Innsbruck",()=>handleChatInput("Innsbruck"));
  }

  if(s==="pick_route"){
    // cards already shown; allow refresh
    addQuick("Neu suchen",()=>handleChatInput("neu suchen"));
  }

  if(s==="after_route"){
    addQuick("Plan A/B/C",()=>handleChatInput("pläne berechnen"));
    addQuick("Assisted Exit",()=>handleChatInput("assisted exit"));
    addQuick("Karte öffnen",()=>handleChatInput("karte öffnen"));
    addQuick("🆘",()=>handleChatInput("sos"));
  }
}

// ---------- Start Chat ----------
function startChat(){
  if(!state.chat.history.length){
    pushMsg("bot", "Hi, ich bin SafeTrek. Ich stelle dir ein paar kurze Fragen, damit wir eine sichere Tour planen.");
  }
  // Start Flow
  if(state.chat.step==="idle"){
    state.chat.step = "ask_stamina";
    saveState();
    pushMsg("bot","Wie hoch ist deine Belastbarkeit heute? (1–5)");
  }
  renderChat();
}
window.startChat = startChat;

// Input wiring
document.addEventListener("DOMContentLoaded", ()=>{
  showView(state.view || "dash");
  renderChat();

  const send = sendEl();
  const input = inputEl();
  if(send && input){
    send.onclick = ()=> {
      const raw = (input.value || "").trim();
      if(!raw) return;
      input.value="";
      handleChatInput(raw);
    };
    input.addEventListener("keydown",(e)=>{
      if(e.key==="Enter"){
        e.preventDefault();
        send.click();
      }
    });
  }
});

// ---------- Chat Logic ----------
function handleChatInput(raw){
  pushMsg("user", raw);

  const low = String(raw).toLowerCase();

  // global commands
  if(low.includes("dashboard")){
    showView("dash");
    return;
  }
  if(low.includes("neue planung")){
    state.chat = structuredClone(defaultState.chat);
    state.selectedRoute = null;
    state.weather = null;
    state.exits = [];
    saveState();
    pushMsg("bot","Neue Planung gestartet.");
    startChat();
    return;
  }
  if(low==="sos" || low.includes("ich schaffe es nicht")){
    sosFlow();
    return;
  }

  const s = state.chat.step;

  if(s==="ask_stamina"){
    const n = Number(raw);
    if(!(n>=1 && n<=5)) return pushMsg("bot","Bitte 1–5.");
    state.chat.profile.stamina = n;
    state.chat.step="ask_breakNeed";
    saveState();
    return pushMsg("bot","Wie hoch ist dein Pausenbedarf? (1–5)");
  }

  if(s==="ask_breakNeed"){
    const n = Number(raw);
    if(!(n>=1 && n<=5)) return pushMsg("bot","Bitte 1–5.");
    state.chat.profile.breakNeed = n;
    state.chat.step="ask_safety";
    saveState();
    return pushMsg("bot","Wie wichtig ist dir Sicherheit/Puffer? (2–5)");
  }

  if(s==="ask_safety"){
    const n = Number(raw);
    if(!(n>=2 && n<=5)) return pushMsg("bot","Bitte 2–5.");
    state.chat.profile.safety = n;
    state.chat.step="ask_energy";
    saveState();
    return pushMsg("bot","Wie ist deine Energie heute? (1–5)");
  }

  if(s==="ask_energy"){
    const n = Number(raw);
    if(!(n>=1 && n<=5)) return pushMsg("bot","Bitte 1–5.");
    state.chat.profile.energy = n;
    state.chat.step="ask_pain";
    saveState();
    return pushMsg("bot","Wie stark sind Schmerzen/Limitierung heute? (1–5)");
  }

  if(s==="ask_pain"){
    const n = Number(raw);
    if(!(n>=1 && n<=5)) return pushMsg("bot","Bitte 1–5.");
    state.chat.profile.pain = n;
    state.chat.step="ask_wants_routes";
    saveState();
    return pushMsg("bot","Möchtest du Tourenvorschläge? (Ja/Nein)");
  }

  if(s==="ask_wants_routes"){
    if(low.startsWith("j")){
      state.chat.wantsRoutes = true;
      state.chat.step="ask_region";
      saveState();
      return pushMsg("bot","In welcher Region möchtest du Touren? (z.B. München, Salzburg, Innsbruck)");
    }
    if(low.startsWith("n")){
      state.chat.wantsRoutes = false;
      state.chat.step="idle";
      saveState();
      return pushMsg("bot","Alles klar. Wenn du später Touren willst: tippe „neue planung“ oder „Touren vorschlagen“.");
    }
    return pushMsg("bot","Bitte antworte mit Ja oder Nein.");
  }

  if(s==="ask_region"){
    state.chat.region = raw.trim();
    state.chat.step="ask_radius";
    saveState();
    return pushMsg("bot","Wie groß soll der Suchradius sein (km)? (z.B. 20)");
  }

  if(s==="ask_radius"){
    const n = Number(raw);
    if(!(n>=5 && n<=200)) return pushMsg("bot","Bitte eine Zahl 5–200.");
    state.chat.radiusKm = n;
    saveState();
    // Start search
    findRoutesFlow();
    return;
  }

  if(low.includes("touren vorschlagen") || low.includes("touren suchen") || low.includes("routen suchen")){
    // If user triggers from anywhere, ensure we ask region first (as requested)
    state.chat.step="ask_region";
    saveState();
    return pushMsg("bot","Gerne. In welcher Region möchtest du Touren? (z.B. München, Salzburg, Innsbruck)");
  }

  if(s==="pick_route"){
    if(low.includes("neu suchen")){
      return findRoutesFlow();
    }
    const idx = Number(raw);
    if(!(idx>=1 && idx<=state.chat.candidates.length)) return pushMsg("bot","Bitte wähle eine gültige Nummer.");
    openCandidateByIndex(idx-1).then(()=>{
      pushMsg("bot","", {type:"route_summary"});
      state.chat.step="after_route";
      saveState();
      pushMsg("bot","Was möchtest du als Nächstes?");
    });
    return;
  }

  if(s==="after_route" || s==="after_plans"){
    if(low.includes("pläne")){
      computePlans();
      pushMsg("bot","", {type:"plan_cards", plans: state.chat.plans});
      state.chat.step="after_plans";
      saveState();
      return;
    }
    if(low.includes("assisted exit")){
      pushMsg("bot","", {type:"exit_cards", exits: (state.exits||[]).slice(0,6)});
      return;
    }
    if(low.includes("karte")){
      showView("route");
      return;
    }
    if(low.includes("packliste")){
      return pushMsg("bot", buildPacklistText());
    }
    return pushMsg("bot","Du kannst sagen: „Plan A/B/C“, „Assisted Exit“, „Karte öffnen“, „Packliste“ oder „SOS“.");
  }

  // fallback
  pushMsg("bot","Ich habe das nicht ganz verstanden. Tipp: „Touren vorschlagen“ oder „neue planung“.");
}
window.handleChatInput = handleChatInput;

// ---------- Route Search Flow (Overpass) ----------
async function findRoutesFlow(){
  state.chat.step = "searching";
  saveState();
  pushMsg("bot", `Suche nach Wanderwegen in/um „${state.chat.region}“ (${state.chat.radiusKm} km)…`);

  try{
    const center = await geocodeNominatim(state.chat.region);
    const candidates = await fetchHikingRoutesOverpass(center.lat, center.lon, state.chat.radiusKm);
    state.chat.candidates = candidates;
    state.chat.step = "pick_route";
    saveState();

    if(!candidates.length){
      pushMsg("bot","Ich habe leider keine passenden Routen gefunden. Versuch eine andere Region oder größeren Radius.");
      state.chat.step="ask_region";
      saveState();
      return;
    }

    // Show cards in chat
    pushMsg("bot", "Hier sind Vorschläge:", {type:"route_cards", routes: candidates.slice(0,8)});

    // Also show numbered fallback
    const list = candidates.slice(0,8).map((r,i)=>`${i+1}) ${r.name} (~${r.lengthKm} km)`).join("\n");
    pushMsg("bot", "Alternativ: antworte mit 1–8:\n" + list);

  }catch(e){
    pushMsg("bot","Die Routensuche hat gerade nicht geklappt. Versuch’s gleich nochmal.");
    state.chat.step="ask_region";
    saveState();
  }
}

async function geocodeNominatim(q){
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
  const r = await fetch(url, { headers: { "Accept":"application/json" } });
  const j = await r.json();
  if(!j || !j.length) throw new Error("No geocode");
  return { lat: Number(j[0].lat), lon: Number(j[0].lon) };
}

async function fetchHikingRoutesOverpass(lat, lon, radiusKm){
  // Search for hiking routes (route=hiking) and hiking trails (highway=path + sac_scale)
  // Keep it reasonable, because Overpass can be slow.
  const radiusM = Math.round(radiusKm * 1000);

  const query = `
  [out:json][timeout:25];
  (
    relation(around:${radiusM},${lat},${lon})["type"="route"]["route"="hiking"];
    way(around:${radiusM},${lat},${lon})["highway"="path"]["sac_scale"];
  );
  out tags center 60;
  `;

  const url = "https://overpass-api.de/api/interpreter";
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"text/plain" },
    body: query
  });
  const data = await res.json();

  const els = (data.elements || []);
  // Normalize to candidates list with ids
  const candidates = [];
  for(const el of els){
    let name = el.tags?.name || el.tags?.ref || el.tags?.route || (el.type==="way" ? "Wanderweg" : "Hiking Route");
    name = name.length>60 ? name.slice(0,60)+"…" : name;

    const id = `${el.type}:${el.id}`;
    const centerLat = el.center?.lat ?? el.lat ?? lat;
    const centerLon = el.center?.lon ?? el.lon ?? lon;

    candidates.push({
      id,
      name,
      center: [centerLat, centerLon],
      lengthKm: estimateLengthKmFromTags(el.tags),
      ascentM: el.tags?.ascent ? Number(el.tags.ascent) : null,
      descentM: el.tags?.descent ? Number(el.tags.descent) : null,
      tags: el.tags || {}
    });
  }

  // Deduplicate by name+center roughly
  const uniq = [];
  const seen = new Set();
  for(const c of candidates){
    const key = `${c.name}:${Math.round(c.center[0]*1000)}:${Math.round(c.center[1]*1000)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }

  // Sort: prefer named route relations first, then closer to center
  uniq.sort((a,b)=>{
    const ar = a.id.startsWith("relation") ? 0 : 1;
    const br = b.id.startsWith("relation") ? 0 : 1;
    if(ar!==br) return ar-br;
    return 0;
  });

  return uniq.slice(0,12);
}

function estimateLengthKmFromTags(tags){
  // Overpass without geometry doesn't give length; keep placeholder.
  // If tags.distance exists use it, else default rough.
  if(tags?.distance){
    const d = String(tags.distance).replace(",",".");
    const n = parseFloat(d);
    if(Number.isFinite(n)) return Math.round(n*10)/10;
  }
  return 7.5;
}

// ---------- Load selected route geometry ----------
async function openCandidateByIndex(idx){
  const c = state.chat.candidates[idx];
  if(!c) return;

  state.chat.selectedCandidateIndex = idx;
  saveState();

  pushMsg("bot", "Lade Route, Wetter und Assisted Exit…");

  const route = await loadGeometryForCandidate(c);
  state.selectedRoute = route;

  // Weather
  try{
    const [lat, lon] = route.coords[0];
    state.weather = await fetchWeather(lat, lon);
  }catch(e){
    state.weather = null;
  }

  // Exits
  try{
    state.exits = await fetchExitPOIsNearRoute(route);
  }catch(e){
    state.exits = [];
  }

  saveState();
  // Update map + route panel
  updateRoutePanel();
  drawRouteOnMap(route, {label:"Route"});
}

async function loadGeometryForCandidate(c){
  // Load full geometry via Overpass for relation/way
  const [type, idStr] = c.id.split(":");
  const id = Number(idStr);

  const query = `
  [out:json][timeout:25];
  (
    ${type}(${id});
    ${type}(${id}); >;
  );
  out body;
  `;

  const url = "https://overpass-api.de/api/interpreter";
  const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"text/plain" }, body: query });
  const data = await res.json();

  const elements = data.elements || [];
  const nodesById = new Map();
  for(const el of elements){
    if(el.type==="node") nodesById.set(el.id, [el.lat, el.lon]);
  }

  let coords = [];

  if(type==="way"){
    const way = elements.find(e=>e.type==="way" && e.id===id);
    if(!way?.nodes?.length) throw new Error("No way nodes");
    coords = way.nodes.map(nid=>nodesById.get(nid)).filter(Boolean);
  } else if(type==="relation"){
    const rel = elements.find(e=>e.type==="relation" && e.id===id);
    if(!rel?.members?.length) throw new Error("No relation members");

    // Take member ways and stitch by order
    const memberWays = rel.members.filter(m=>m.type==="way").map(m=>m.ref);
    const ways = elements.filter(e=>e.type==="way" && memberWays.includes(e.id));

    for(const w of ways){
      if(w.nodes?.length){
        const part = w.nodes.map(nid=>nodesById.get(nid)).filter(Boolean);
        coords.push(...part);
      }
    }

    // If still empty, fallback to center point
    if(coords.length<2) coords = [c.center, c.center];
  }

  // compute bbox
  const bbox = computeBBox(coords);
  const lengthKm = computePolylineLengthKm(coords);

  return {
    id: c.id,
    name: c.name,
    coords,
    bbox,
    lengthKm: Math.round(lengthKm*10)/10,
    ascentM: c.ascentM,
    descentM: c.descentM
  };
}

function computeBBox(coords){
  let minLat=999, minLon=999, maxLat=-999, maxLon=-999;
  for(const [la,lo] of coords){
    minLat = Math.min(minLat, la);
    minLon = Math.min(minLon, lo);
    maxLat = Math.max(maxLat, la);
    maxLon = Math.max(maxLon, lo);
  }
  return { minLat, minLon, maxLat, maxLon };
}

function computePolylineLengthKm(coords){
  let km=0;
  for(let i=1;i<coords.length;i++){
    km += haversineKm(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
  }
  return km;
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R=6371;
  const toRad = d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1);
  const dLon=toRad(lon2-lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

// ---------- Weather (Open-Meteo) ----------
async function fetchWeather(lat, lon){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,precipitation_probability&timezone=auto`;
  const r = await fetch(url);
  const j = await r.json();
  const cur = j.current || {};
  return {
    tempC: cur.temperature_2m,
    windKmh: cur.wind_speed_10m,
    rainChance: cur.precipitation_probability
  };
}

// ---------- Assisted Exit POIs ----------
async function fetchExitPOIsNearRoute(route){
  // Pick several sample points along route and query Overpass for:
  // bus_stop, parking, railway station, taxi, shelter, hut, emergency phone
  const samples = sampleRoutePoints(route.coords, 8);
  const aroundM = 800;

  const parts = samples.map(([la,lo])=>`
    node(around:${aroundM},${la},${lo})["highway"="bus_stop"];
    node(around:${aroundM},${la},${lo})["amenity"="parking"];
    node(around:${aroundM},${la},${lo})["railway"="station"];
    node(around:${aroundM},${la},${lo})["amenity"="shelter"];
    node(around:${aroundM},${la},${lo})["tourism"="alpine_hut"];
    node(around:${aroundM},${la},${lo})["emergency"="phone"];
  `).join("\n");

  const query = `[out:json][timeout:25];(${parts});out center 120;`;
  const url = "https://overpass-api.de/api/interpreter";
  const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"text/plain" }, body: query });
  const data = await res.json();

  const exits = [];
  for(const el of (data.elements||[])){
    const name = el.tags?.name || el.tags?.ref || "Unbenannt";
    let kind = "Exit";
    if(el.tags?.highway==="bus_stop") kind="Bus";
    if(el.tags?.amenity==="parking") kind="Parkplatz";
    if(el.tags?.railway==="station") kind="Bahnhof";
    if(el.tags?.amenity==="shelter") kind="Unterstand";
    if(el.tags?.tourism==="alpine_hut") kind="Hütte";
    if(el.tags?.emergency==="phone") kind="Notruftelefon";

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if(lat==null || lon==null) continue;

    const dist = distancePointToPolylineM([lat,lon], route.coords);
    exits.push({
      kind,
      name,
      lat, lon,
      distToRouteM: dist,
      info: el.tags?.operator || el.tags?.note || ""
    });
  }

  exits.sort((a,b)=>a.distToRouteM - b.distToRouteM);
  return exits.slice(0,12);
}

function sampleRoutePoints(coords, n){
  if(coords.length<=n) return coords;
  const out=[];
  for(let i=0;i<n;i++){
    const t = i/(n-1);
    const idx = Math.floor(t*(coords.length-1));
    out.push(coords[idx]);
  }
  return out;
}

function distancePointToPolylineM(p, line){
  // rough: min haversine to vertices
  let best = Infinity;
  for(const c of line){
    const dKm = haversineKm(p[0],p[1], c[0],c[1]);
    best = Math.min(best, dKm*1000);
  }
  return best;
}

// ---------- Plans A/B/C ----------
function computePlans(){
  const r = state.selectedRoute;
  const prof = state.chat.profile;
  if(!r) return;

  const safety = prof.safety ?? 3;
  const pain = prof.pain ?? 2;
  const stamina = prof.stamina ?? 3;
  const breakNeed = prof.breakNeed ?? 3;

  // Simple heuristic scoring
  const baseKm = r.lengthKm || 8;
  const bufferFactor = 1 + (safety-2)*0.15 + (breakNeed-1)*0.08 + (pain-1)*0.12;
  const targetKm = baseKm / Math.max(0.7, (stamina/4));

  const planA = {
    key:"A",
    name:"Plan A (Normal)",
    summary:`Komplette Route (~${baseKm} km) mit Zeitpuffer x${bufferFactor.toFixed(2)}.`
  };
  const planB = {
    key:"B",
    name:"Plan B (Konservativ)",
    summary:`Kürzer / mehr Puffer: Ziel ~${Math.max(2, Math.round(targetKm*0.75))} km + frühe Exit-Optionen.`
  };
  const planC = {
    key:"C",
    name:"Plan C (Sehr sicher)",
    summary:`Maximale Sicherheit: Fokus auf Exit-Nähe, häufige Pausen, evtl. Umkehrpunkt nach ~${Math.max(1.5, Math.round(targetKm*0.5))} km.`
  };

  state.chat.plans = [planA, planB, planC];
  saveState();
}

function showPlanOnMap(key){
  const r = state.selectedRoute;
  if(!r) return;

  // Plan overlays: mark suggested turnaround and exits
  drawRouteOnMap(r, {label:`Plan ${key}`});

  // add plan marker
  const coords = r.coords;
  const frac = key==="A" ? 0.55 : key==="B" ? 0.4 : 0.28;
  const idx = Math.max(0, Math.min(coords.length-1, Math.floor(coords.length*frac)));
  const turn = coords[idx];

  ensureMap();
  clearMapMarkers();

  const m = L.marker([turn[0], turn[1]]).addTo(state.map.instance).bindPopup(`Plan ${key}: Vorschlag Umkehrpunkt`);
  state.map.markers.push(m);

  // show nearest exits to that turn point
  const exits = (state.exits||[]).slice(0,6);
  for(const e of exits){
    const em = L.circleMarker([e.lat, e.lon], {radius:6}).addTo(state.map.instance)
      .bindPopup(`${e.kind}: ${e.name}<br>~${Math.round(e.distToRouteM)} m zur Route`);
    state.map.markers.push(em);
  }

  updateRoutePanel(`Plan ${key}: Umkehrpunkt + Exit-Optionen markiert.`);
}

function showExitOnMap(exit){
  ensureMap();
  const m = L.marker([exit.lat, exit.lon]).addTo(state.map.instance)
    .bindPopup(`${exit.kind}: ${exit.name}`).openPopup();
  state.map.markers.push(m);
  state.map.instance.setView([exit.lat, exit.lon], 14);
}

// ---------- Map ----------
function ensureMap(){
  if(state.map.instance) return;
  const el = mapEl();
  if(!el) return;

  const map = L.map(el, { zoomControl:true });
  state.map.instance = map;

  // Use OSM tiles with error handling
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "© OpenStreetMap"
  });
  tiles.on("tileerror", ()=> {
    // fallback to another provider if OSM tile fails often (prevents black maps)
    // Still stays free-ish; if blocked, map stays but route visible.
  });
  tiles.addTo(map);

  map.setView([48.137, 11.575], 11); // München default
}

function clearRouteLayer(){
  if(state.map.layer){
    state.map.instance.removeLayer(state.map.layer);
    state.map.layer = null;
  }
}
function clearMapMarkers(){
  for(const m of state.map.markers){
    try{ state.map.instance.removeLayer(m);}catch(e){}
  }
  state.map.markers = [];
}

function drawRouteOnMap(route, opts){
  ensureMap();
  if(!state.map.instance || !route?.coords?.length) return;

  clearRouteLayer();
  const latlngs = route.coords.map(([la,lo])=>[la,lo]);
  const poly = L.polyline(latlngs, {weight:5});
  poly.addTo(state.map.instance);
  state.map.layer = poly;

  // fit bounds
  const b = poly.getBounds();
  state.map.instance.fitBounds(b.pad(0.2));

  updateRoutePanel(opts?.label ? `${opts.label}: ${route.name}` : route.name);
}

function updateRoutePanel(extra){
  const el = routeInfoEl();
  const r = state.selectedRoute;
  const w = state.weather;
  const exits = state.exits || [];

  if(!el){
    return;
  }

  if(!r){
    el.textContent = "Wähle eine Route im Chat.";
    return;
  }

  const lines = [];
  lines.push(`✅ ${r.name}`);
  lines.push(`📏 ~${r.lengthKm} km • ↑ ${r.ascentM ?? "?"} hm • ↓ ${r.descentM ?? "?"} hm`);
  if(w){
    lines.push(`🌦️ Wetter: ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regen ~${w.rainChance ?? "?"}%`);
  } else {
    lines.push(`🌦️ Wetter: konnte nicht geladen werden`);
  }
  if(exits.length){
    lines.push(`🚪 Exit-Optionen: ${exits.length} (nächste: ${exits[0].kind} – ${exits[0].name})`);
  } else {
    lines.push(`🚪 Exit-Optionen: keine gefunden`);
  }
  if(extra) lines.push(`ℹ️ ${extra}`);

  el.textContent = lines.join("\n");
}

// ---------- SOS / Assisted Exit Flow ----------
function sosFlow(){
  const r = state.selectedRoute;
  if(!r){
    pushMsg("bot","🆘 Ich kann dir nur helfen, wenn eine Route gewählt ist. Sag: „Touren vorschlagen“.");
    return;
  }

  pushMsg("bot","🆘 Okay. Erstmal: Bist du in akuter Gefahr (Verletzung, Gewitter, Absturzgefahr)? Wenn ja: 112 / Bergrettung. Wenn nein: ich plane einen sicheren Rückzug.");
  // show exit cards
  pushMsg("bot","", {type:"exit_cards", exits:(state.exits||[]).slice(0,8)});
  pushMsg("bot","Wähle eine Exit-Option (Tippe auf „Auf Karte anzeigen“) oder sag mir: „Bus“, „Parkplatz“, „Bahnhof“.");
}
window.sosFlow = sosFlow;

// Packlist
function buildPacklistText(){
  const prof = state.chat.profile;
  const w = state.weather;

  const list = [];
  list.push("🎒 Packliste (personalisiert)");
  list.push("- Wasser (mind. 0.5–1.5L je nach Dauer)");
  list.push("- Snack/Notfall-Energie");
  list.push("- Powerbank + Offline-Karte");
  list.push("- Erste Hilfe (Basics)");

  if((prof.breakNeed??3) >= 4) list.push("- Sitzkissen / leichte Pause-Decke (hoher Pausenbedarf)");
  if((prof.safety??3) >= 4) list.push("- Rettungsdecke + Pfeife (Sicherheitsfokus)");
  if((prof.pain??2) >= 4) list.push("- Schmerz-/Support-Item (z.B. Bandage) (heute erhöht)");

  if(w){
    if((w.rainChance??0) >= 40) list.push("- Regenjacke (Regenrisiko erhöht)");
    if((w.tempC??15) <= 8) list.push("- Wärmeschicht + Handschuhe (kühl)");
    if((w.windKmh??0) >= 30) list.push("- Windschutz (Wind stärker)");
  }

  return list.join("\n");
}

// expose some for debugging
window.__st = ()=>state;