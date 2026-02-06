/* SafeTrek Beta (v16)
   Features:
   - Local Auth: Login / Register / Guest (device-local)
   - Concierge Chat flow: today -> stamina -> breaks -> safety -> energy -> pain -> wants routes -> region -> radius
   - Routes: Nominatim geocode + Overpass route relations + path/footway ways
   - Route quality: stitching (ordered ways), de-dup, simplification
   - Elevation: OpenTopoData SRTM90m sampling -> ascent/descent
   - Weather: Open-Meteo current + precip prob (first hour)
   - Assisted Exit: Overpass POIs (bus stop, station, parking, taxi, info, shelter, hut) near route
   - Plans A/B/C cards + show on map
   - Map: Leaflet + tile fallback + invalidateSize fix for black maps
*/

const LS = {
  STATE: "safetreks_state_beta16",
  USERS: "safetreks_users_beta16",
  SESSION: "safetreks_session_beta16"
};

const DEFAULT = {
  view: "auth",
  session: { mode: "none", userEmail: null }, // mode: none | guest | user
  user: { name: "Gast" },
  dash: { region: "München Umland", radiusKm: 25, lastCandidates: [] },
  chat: {
    step: "idle",
    history: [],
    profile: { today:"", stamina:null, breakNeed:null, safety:null, energy:null, pain:null },
    wantsRoutes: null,
    region: "",
    radiusKm: 25,
    center: null,         // {lat, lon, label}
    candidates: [],        // list of route picks
    selected: null,        // full route with coords, length, ascent, descent, weather
    exits: [],             // assisted exits list
    plans: null,           // {A,B,C}
    activePlanKey: "A",
    highlightExit: null
  }
};

let state = loadState();

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const dom = {
  // nav
  navAuth: $("navAuth"), navDash: $("navDash"), navChat: $("navChat"), navRoute: $("navRoute"),

  // auth
  loginEmail: $("loginEmail"), loginPass: $("loginPass"),
  regName: $("regName"), regEmail: $("regEmail"), regPass: $("regPass"),
  btnLogin: $("btnLogin"), btnRegister: $("btnRegister"), btnGuest: $("btnGuest"),
  authHint: $("authHint"),

  // dash
  dashHello: $("dashHello"),
  btnStartChat: $("btnStartChat"),
  btnNewPlan: $("btnNewPlan"),
  dashRegion: $("dashRegion"), dashRadius: $("dashRadius"),
  btnDashSuggest: $("btnDashSuggest"),
  dashRouteList: $("dashRouteList"),
  chipMuc: $("chipMuc"), chipGap: $("chipGap"), chipInns: $("chipInns"),

  // chat
  chatMessages: $("chatMessages"), quickReplies: $("quickReplies"),
  chatInput: $("chatInput"), chatSend: $("chatSend"),

  // route
  btnRouteBack: $("btnRouteBack"),
  btnRecenter: $("btnRecenter"),
  btnSOS: $("btnSOS"),
  routeSummary: $("routeSummary")
};

// ---- View ----
function showView(name){
  state.view = name;
  document.querySelectorAll("[data-view]").forEach(v=>{
    v.style.display = (v.getAttribute("data-view")===name) ? "block" : "none";
  });
  saveState();

  if(name==="dash") renderDash();
  if(name==="chat") { renderChat(); setTimeout(()=> dom.chatInput?.focus(), 80); }
  if(name==="route") { ensureMap(); setTimeout(()=>{ mapInvalidateSafe(); renderRoutePanel(); }, 160); }
}
window.showView = showView;

// ---- Storage ----
function saveState(){
  try{ localStorage.setItem(LS.STATE, JSON.stringify(state)); }catch(e){}
}
function loadState(){
  try{
    const raw = localStorage.getItem(LS.STATE);
    if(!raw) return structuredClone(DEFAULT);
    return deepMerge(structuredClone(DEFAULT), JSON.parse(raw));
  }catch(e){
    return structuredClone(DEFAULT);
  }
}
function deepMerge(a,b){
  if(Array.isArray(a)) return Array.isArray(b) ? b : a;
  if(typeof a!=="object" || a===null) return (b===undefined ? a : b);
  const out = {...a};
  if(typeof b!=="object" || b===null) return out;
  for(const k of Object.keys(b)){
    out[k] = deepMerge(a[k], b[k]);
  }
  return out;
}

// ---- Auth (local-only beta) ----
function loadUsers(){
  try{ return JSON.parse(localStorage.getItem(LS.USERS) || "[]"); }catch(e){ return []; }
}
function saveUsers(users){
  try{ localStorage.setItem(LS.USERS, JSON.stringify(users)); }catch(e){}
}
function setSession(mode, email){
  state.session.mode = mode;
  state.session.userEmail = email || null;
  saveState();
}
function getSession(){
  try{ return JSON.parse(localStorage.getItem(LS.SESSION) || "null"); }catch(e){ return null; }
}
function storeSession(sess){
  try{ localStorage.setItem(LS.SESSION, JSON.stringify(sess)); }catch(e){}
}
function clearSession(){
  try{ localStorage.removeItem(LS.SESSION); }catch(e){}
}

function hashLite(str){
  // not secure; just prevents plain text in storage (beta local)
  let h = 2166136261;
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h>>>0).toString(16);
}

function authInit(){
  const sess = getSession();
  if(sess?.mode==="guest"){
    setSession("guest", null);
    state.user.name = "Gast";
    saveState();
    showView("dash");
    return;
  }
  if(sess?.mode==="user" && sess?.email){
    const users = loadUsers();
    const u = users.find(x => x.email === sess.email);
    if(u){
      setSession("user", u.email);
      state.user.name = u.name || "User";
      saveState();
      showView("dash");
      return;
    }
  }
  // default
  showView("auth");
}

function showAuthHint(msg){
  if(dom.authHint) dom.authHint.textContent = msg || "";
}

// ---- Chat helpers ----
const fmtTime = () => new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
function chatPush(role, payload){
  const msg = (typeof payload==="string")
    ? { role, type:"text", text:payload, t: fmtTime() }
    : { role, t: fmtTime(), ...payload };

  state.chat.history.push(msg);
  saveState();
  renderChat();
}

function setQuick(arr){
  dom.quickReplies.innerHTML="";
  (arr||[]).forEach(txt=>{
    const b = document.createElement("button");
    b.className="qbtn";
    b.type="button";
    b.textContent = txt;
    b.onclick = ()=> handleChatInput(txt);
    dom.quickReplies.appendChild(b);
  });
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

// ---- Init wiring ----
function init(){
  // nav
  dom.navAuth?.addEventListener("click", ()=> showView("auth"));
  dom.navDash?.addEventListener("click", ()=> showView("dash"));
  dom.navChat?.addEventListener("click", ()=> { startChatIfNeeded(); showView("chat"); });
  dom.navRoute?.addEventListener("click", ()=> showView("route"));

  // auth
  dom.btnGuest?.addEventListener("click", ()=>{
    storeSession({mode:"guest"});
    setSession("guest", null);
    state.user.name = "Gast";
    saveState();
    showView("dash");
  });

  dom.btnRegister?.addEventListener("click", ()=>{
    const name = (dom.regName?.value || "").trim();
    const email = (dom.regEmail?.value || "").trim().toLowerCase();
    const pass = (dom.regPass?.value || "");
    if(!name || !email || pass.length < 6) return showAuthHint("Bitte Name, E-Mail und Passwort (mind. 6 Zeichen).");
    const users = loadUsers();
    if(users.some(u => u.email === email)) return showAuthHint("Diese E-Mail ist bereits registriert (lokal).");
    users.push({ name, email, passHash: hashLite(pass) });
    saveUsers(users);
    showAuthHint("Registriert! Du kannst dich jetzt anmelden.");
  });

  dom.btnLogin?.addEventListener("click", ()=>{
    const email = (dom.loginEmail?.value || "").trim().toLowerCase();
    const pass = (dom.loginPass?.value || "");
    const users = loadUsers();
    const u = users.find(x => x.email === email);
    if(!u) return showAuthHint("Account nicht gefunden. Bitte registrieren oder Gast nutzen.");
    if(u.passHash !== hashLite(pass)) return showAuthHint("Passwort falsch.");
    storeSession({mode:"user", email});
    setSession("user", email);
    state.user.name = u.name || "User";
    saveState();
    showView("dash");
  });

  // dash
  dom.btnStartChat?.addEventListener("click", ()=>{ startChatIfNeeded(true); showView("chat"); });
  dom.btnNewPlan?.addEventListener("click", ()=> resetChatFlow(true));

  dom.chipMuc?.addEventListener("click", ()=>{
    dom.dashRegion.value = "München Umland";
    dom.dashRadius.value = "35";
  });
  dom.chipGap?.addEventListener("click", ()=>{
    dom.dashRegion.value = "Garmisch-Partenkirchen";
    dom.dashRadius.value = "35";
  });
  dom.chipInns?.addEventListener("click", ()=>{
    dom.dashRegion.value = "Innsbruck";
    dom.dashRadius.value = "35";
  });

  dom.btnDashSuggest?.addEventListener("click", ()=>{
    const region = (dom.dashRegion?.value || "").trim();
    const radiusKm = Number(dom.dashRadius?.value || 25);
    state.dash.region = region || state.dash.region;
    state.dash.radiusKm = Number.isFinite(radiusKm) ? radiusKm : 25;
    saveState();

    // Start chat → jump directly to route question flow
    startChatIfNeeded(true);
    showView("chat");

    // If profile not finished, the chat will continue naturally.
    // We prefill region/radius so after "Ja" it continues.
    state.chat.region = state.dash.region;
    state.chat.radiusKm = state.dash.radiusKm;
    saveState();

    // If already reached wantsRoutes step or beyond, we can push.
    handleChatInput("Ja");
    handleChatInput(state.chat.region);
    handleChatInput(String(state.chat.radiusKm));
  });

  // chat composer
  dom.chatSend?.addEventListener("click", ()=>{
    const v = (dom.chatInput?.value || "").trim();
    if(!v) return;
    dom.chatInput.value="";
    handleChatInput(v);
  });
  dom.chatInput?.addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){ e.preventDefault(); dom.chatSend?.click(); }
  });

  // route
  dom.btnRouteBack?.addEventListener("click", ()=> showView("chat"));
  dom.btnRecenter?.addEventListener("click", ()=> recenterToSelected());
  dom.btnSOS?.addEventListener("click", ()=> triggerSOS());

  // initial
  authInit();
}
init();

// ---- Dashboard render ----
function renderDash(){
  dom.dashHello.textContent = `Hi ${state.user?.name || "!"} 👋`;
  dom.dashRegion.value = state.dash.region || "München Umland";
  dom.dashRadius.value = String(state.dash.radiusKm || 25);

  const list = dom.dashRouteList;
  list.innerHTML="";
  const candidates = state.dash.lastCandidates || [];
  if(!candidates.length){
    list.innerHTML = `<div class="card"><div class="card__title">Noch keine Touren</div><div class="card__meta">Starte den Chat oder nutze den Schnellstart.</div></div>`;
    return;
  }
  candidates.slice(0,6).forEach((c, idx)=>{
    const card = document.createElement("div");
    card.className="card";
    card.innerHTML = `
      <div class="card__title">🥾 ${escapeHtml(c.name || "Route")}</div>
      <div class="card__meta">${escapeHtml(c.regionLabel || "")} • Quelle: OpenStreetMap</div>
      <div class="stack" style="margin-top:10px">
        <button class="secondary" type="button">Im Chat anzeigen</button>
      </div>
    `;
    card.querySelector("button").onclick = ()=>{
      startChatIfNeeded(true);
      showView("chat");
      state.chat.candidates = state.dash.lastCandidates || [];
      state.chat.step = "pick_route";
      saveState();
      chatPush("bot", `Ich habe zuletzt gefundene Touren gespeichert. Wähle eine Option:`);
      renderChat();
    };
    list.appendChild(card);
  });
}

// ---- Chat Flow ----
function resetChatFlow(goChat){
  state.chat = structuredClone(DEFAULT.chat);
  saveState();
  if(goChat) showView("chat");
  startChatIfNeeded(false);
}

function startChatIfNeeded(resetIfHasHistory=false){
  if(resetIfHasHistory){
    // keep history but ensure flow is alive
  }
  if(!state.chat.history.length){
    state.chat.step = "ask_today";
    saveState();
    chatPush("bot","Hi, ich bin SafeTrek. Ich helfe dir heute eine sichere, machbare Outdoor-Entscheidung zu treffen.");
    chatPush("bot","Wie geht’s dir heute gerade? (z.B. „müde“, „okay“, „unsicher“, „fit“)");
    setQuick(["müde","okay","unsicher","fit"]);
  }
}

function handleChatInput(raw){
  chatPush("user", raw);
  const low = raw.toLowerCase();

  // global shortcuts
  if(low.includes("neue planung")) return resetChatFlow(true);
  if(low.includes("dashboard")) return showView("dash");
  if(low.includes("karte öffnen")) {
    if(state.chat.selected) return showView("route");
    chatPush("bot","Noch keine Route ausgewählt. Bitte zuerst eine Route wählen.");
    return;
  }
  if(low.includes("ich schaffe es nicht") || low==="sos") return triggerSOS();
  if(low.includes("touren") && state.chat.step==="idle"){
    state.chat.step="ask_wants_routes";
    saveState();
    chatPush("bot","Möchtest du Tourenvorschläge? (Ja/Nein)");
    setQuick(["Ja","Nein"]);
    return;
  }

  const s = state.chat.step;

  if(s==="ask_today"){
    state.chat.profile.today = raw.trim();
    state.chat.step = "ask_stamina";
    saveState();
    chatPush("bot","Wie ist deine Belastbarkeit heute? (1–5)");
    setQuick(["1","2","3","4","5"]);
    return;
  }
  if(s==="ask_stamina"){
    const n = toScale(raw,1,5); if(n==null) return chatPush("bot","Bitte 1–5.");
    state.chat.profile.stamina=n;
    state.chat.step="ask_breakNeed";
    saveState();
    chatPush("bot","Wie hoch ist dein Pausenbedarf? (1–5)");
    setQuick(["1","2","3","4","5"]);
    return;
  }
  if(s==="ask_breakNeed"){
    const n = toScale(raw,1,5); if(n==null) return chatPush("bot","Bitte 1–5.");
    state.chat.profile.breakNeed=n;
    state.chat.step="ask_safety";
    saveState();
    chatPush("bot","Wie wichtig ist dir Sicherheit/Puffer heute? (2–5)");
    setQuick(["2","3","4","5"]);
    return;
  }
  if(s==="ask_safety"){
    const n = toScale(raw,2,5); if(n==null) return chatPush("bot","Bitte 2–5.");
    state.chat.profile.safety=n;
    state.chat.step="ask_energy";
    saveState();
    chatPush("bot","Wie ist deine Energie heute? (1–5)");
    setQuick(["1","2","3","4","5"]);
    return;
  }
  if(s==="ask_energy"){
    const n = toScale(raw,1,5); if(n==null) return chatPush("bot","Bitte 1–5.");
    state.chat.profile.energy=n;
    state.chat.step="ask_pain";
    saveState();
    chatPush("bot","Wie hoch ist Schmerz/Überlastungsrisiko heute? (1–5)");
    setQuick(["1","2","3","4","5"]);
    return;
  }
  if(s==="ask_pain"){
    const n = toScale(raw,1,5); if(n==null) return chatPush("bot","Bitte 1–5.");
    state.chat.profile.pain=n;

    // IMPORTANT: now directly wants routes
    state.chat.step="ask_wants_routes";
    saveState();
    chatPush("bot","Möchtest du Tourenvorschläge? (Ja/Nein)");
    setQuick(["Ja","Nein"]);
    return;
  }
  if(s==="ask_wants_routes"){
    const yes = low.startsWith("j");
    state.chat.wantsRoutes = yes;
    if(!yes){
      state.chat.step="idle";
      saveState();
      setQuick([]);
      chatPush("bot","Alles klar. Wenn du später Touren willst: schreibe „Tourenvorschläge“ oder „neue planung“.");
      return;
    }
    state.chat.step="ask_region";
    saveState();
    chatPush("bot","In welcher Region möchtest du Touren? (München Umland / Garmisch / Innsbruck oder konkreter Ort)");
    setQuick(["München Umland","Garmisch-Partenkirchen","Innsbruck"]);
    return;
  }
  if(s==="ask_region"){
    state.chat.region = raw.trim();
    state.chat.step="ask_radius";
    saveState();
    chatPush("bot","Wie groß soll der Suchradius sein (km)? (z.B. 15, 25, 35, 50)");
    setQuick(["15","25","35","50"]);
    return;
  }
  if(s==="ask_radius"){
    const km = Number(raw);
    if(!Number.isFinite(km) || km<5 || km>200){
      chatPush("bot","Bitte eine Zahl 5–200.");
      return;
    }
    state.chat.radiusKm = km;
    state.chat.step="loading_routes";
    saveState();
    setQuick([]);
    searchRoutesFlow();
    return;
  }

  if(s==="pick_route"){
    const idx = Number(raw);
    if(Number.isFinite(idx) && idx>=1 && idx<=state.chat.candidates.length){
      loadRouteByIndex(idx-1);
      return;
    }
    chatPush("bot","Bitte wähle eine gültige Nummer oder tippe auf „Diese Route wählen“ in einer Karte.");
    return;
  }

  if(s==="after_route"){
    if(low.includes("plan")){ buildPlans(); return; }
    if(low.includes("pack")){ showPacklist(); return; }
    if(low.includes("exit") || low.includes("assisted")){ showExitsInChat(); return; }
    if(low.includes("karte")){ showView("route"); return; }
    chatPush("bot","Sag: „Pläne“, „Assisted Exit“, „Packliste“ oder „Karte öffnen“.");
    setQuick(["Pläne","Assisted Exit","Packliste","Karte öffnen","SOS"]);
    return;
  }

  chatPush("bot","Wenn du Touren willst: „Tourenvorschläge“. Oder „neue planung“.");
}

function toScale(raw,min,max){
  const n = Number(raw);
  if(!Number.isFinite(n)) return null;
  if(n<min || n>max) return null;
  return n;
}

// ---- Render chat (with cards) ----
function renderChat(){
  dom.chatMessages.innerHTML="";
  for(const m of state.chat.history){
    const row = document.createElement("div");
    row.className = `msg ${m.role==="user" ? "user" : "bot"}`;
    const wrap = document.createElement("div");
    wrap.className = "bubbleWrap";

    const meta = document.createElement("div");
    meta.className="meta";
    meta.textContent = (m.role==="user" ? "Du" : "SafeTrek") + " • " + (m.t || "");
    wrap.appendChild(meta);

    if(m.type==="card" && m.cardType==="routeOption"){
      wrap.appendChild(routeOptionCard(m.data));
    } else if(m.type==="card" && m.cardType==="routeSummary"){
      wrap.appendChild(routeSummaryCard());
    } else if(m.type==="card" && m.cardType==="plan"){
      wrap.appendChild(planCard(m.data));
    } else if(m.type==="card" && m.cardType==="exit"){
      wrap.appendChild(exitCard(m.data));
    } else {
      const b = document.createElement("div");
      b.className="bubble";
      b.textContent = m.text || "";
      wrap.appendChild(b);
    }

    row.appendChild(wrap);
    dom.chatMessages.appendChild(row);
  }

  // show route cards if in pick_route
  if(state.chat.step==="pick_route" && state.chat.candidates?.length){
    state.chat.candidates.slice(0,10).forEach((r,i)=>{
      const row = document.createElement("div");
      row.className="msg bot";
      const wrap = document.createElement("div");
      wrap.className="bubbleWrap";
      const meta = document.createElement("div");
      meta.className="meta";
      meta.textContent = `SafeTrek • Option ${i+1}`;
      wrap.appendChild(meta);
      wrap.appendChild(routeOptionCard({route:r,index:i}));
      row.appendChild(wrap);
      dom.chatMessages.appendChild(row);
    });
    setQuick(["1","2","3","4","5","35","50"]);
  }

  if(state.chat.step==="after_route"){
    setQuick(["Pläne","Assisted Exit","Packliste","Karte öffnen","SOS"]);
  }

  requestAnimationFrame(()=> dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight);
}

function routeOptionCard({route,index}){
  const card = document.createElement("div");
  card.className="chatCard";

  const title = document.createElement("div");
  title.className="chatCard__title";
  title.textContent = `🥾 ${route.name || "Route"} (Option ${index+1})`;

  const meta = document.createElement("div");
  meta.className="chatCard__meta";
  meta.textContent = `${route.regionLabel || ""} • Typ: ${route.kind || "Hiking"} • Quelle: OpenStreetMap`;

  const actions = document.createElement("div");
  actions.className="chatCard__actions";

  const bView = document.createElement("button");
  bView.className="secondary";
  bView.textContent="Route ansehen";
  bView.onclick = async ()=>{
    await previewPick(route);
    showView("route");
  };

  const bPick = document.createElement("button");
  bPick.className="primary";
  bPick.textContent="Diese Route wählen";
  bPick.onclick = ()=> loadRouteByIndex(index);

  actions.appendChild(bView);
  actions.appendChild(bPick);

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

function routeSummaryCard(){
  const r = state.chat.selected;
  const exitsN = state.chat.exits?.length || 0;
  const card = document.createElement("div");
  card.className="chatCard";
  card.innerHTML = `
    <div class="chatCard__title">✅ Route gewählt: ${escapeHtml(r?.name || "Route")}</div>
    <div class="chatCard__meta">
      Länge: ~${fmtKm(r?.lengthKm)} km
      • ↑ ${fmtM(r?.ascentM)} m • ↓ ${fmtM(r?.descentM)} m
      • Exits: ${exitsN}
      ${r?.weather ? `• Wetter: ${r.weather.tempC ?? "?"}°C, Wind ${r.weather.windKmh ?? "?"} km/h, Regen ${r.weather.rainChance ?? "?"}%` : ""}
    </div>
  `;
  const actions = document.createElement("div");
  actions.className="chatCard__actions";

  const bMap = document.createElement("button");
  bMap.className="secondary";
  bMap.textContent="Karte öffnen";
  bMap.onclick=()=> showView("route");

  const bPlan = document.createElement("button");
  bPlan.className="primary";
  bPlan.textContent="Pläne A/B/C";
  bPlan.onclick=()=> buildPlans();

  const bExit = document.createElement("button");
  bExit.className="secondary";
  bExit.textContent="Assisted Exit";
  bExit.onclick=()=> showExitsInChat();

  const bSOS = document.createElement("button");
  bSOS.className="danger";
  bSOS.textContent="SOS / Rückzug";
  bSOS.onclick=()=> triggerSOS();

  actions.appendChild(bMap);
  actions.appendChild(bPlan);
  actions.appendChild(bExit);
  actions.appendChild(bSOS);

  card.appendChild(actions);
  return card;
}

function planCard({key,plan}){
  const card = document.createElement("div");
  card.className="chatCard";
  card.innerHTML = `
    <div class="chatCard__title">Plan ${key}: ${escapeHtml(plan.title)}</div>
    <div class="chatCard__meta">${escapeHtml(plan.summary)}</div>
  `;
  const actions = document.createElement("div");
  actions.className="chatCard__actions";

  const bShow = document.createElement("button");
  bShow.className="secondary";
  bShow.textContent="Auf Karte anzeigen";
  bShow.onclick=()=>{
    state.chat.activePlanKey = key;
    saveState();
    showView("route");
    drawSelectedRouteAndPlan();
  };

  const bSOS = document.createElement("button");
  bSOS.className="danger";
  bSOS.textContent="Ich schaffe es nicht weiter";
  bSOS.onclick=()=> triggerSOS();

  actions.appendChild(bShow);
  actions.appendChild(bSOS);
  card.appendChild(actions);
  return card;
}

function exitCard({exit}){
  const card = document.createElement("div");
  card.className="chatCard";
  card.innerHTML = `
    <div class="chatCard__title">🚪 ${escapeHtml(exit.kind)}: ${escapeHtml(exit.name || "Option")}</div>
    <div class="chatCard__meta">~${fmtM(exit.distToRouteM)} m zur Route • ${exit.lat.toFixed(5)}, ${exit.lon.toFixed(5)}</div>
  `;
  const actions = document.createElement("div");
  actions.className="chatCard__actions";
  const b = document.createElement("button");
  b.className="secondary";
  b.textContent="Auf Karte anzeigen";
  b.onclick=()=>{
    state.chat.highlightExit = exit;
    saveState();
    showView("route");
    drawSelectedRouteAndPlan();
  };
  actions.appendChild(b);
  card.appendChild(actions);
  return card;
}

// ---- Search flow ----
async function searchRoutesFlow(){
  chatPush("bot","🔎 Suche Wanderwege & Hiking-Routen (OpenStreetMap)… Das kann 5–25 Sekunden dauern.");

  try{
    const geo = await geocode(state.chat.region);
    if(!geo){
      state.chat.step="ask_region";
      saveState();
      chatPush("bot","Ich konnte die Region nicht finden. Bitte genauer (z.B. „Garmisch-Partenkirchen“).");
      setQuick(["München Umland","Garmisch-Partenkirchen","Innsbruck"]);
      return;
    }
    state.chat.center = geo;
    saveState();

    const picks = await findRoutesOverpass(geo.lat, geo.lon, state.chat.radiusKm);
    if(!picks.length){
      state.chat.step="ask_radius";
      saveState();
      chatPush("bot","Keine passenden Routen gefunden. Versuch 50 km oder andere Region.");
      setQuick(["35","50","80"]);
      return;
    }

    state.chat.candidates = picks;
    state.dash.lastCandidates = picks;
    state.dash.region = state.chat.region;
    state.dash.radiusKm = state.chat.radiusKm;
    saveState();

    chatPush("bot", `Ich habe ${picks.length} Vorschläge. Wähle eine Option:`);
    state.chat.step="pick_route";
    saveState();
    renderChat();

  }catch(e){
    state.chat.step="ask_radius";
    saveState();
    chatPush("bot","Die Routensuche war gerade schwierig (Overpass ist evtl. ausgelastet). Versuch es nochmal oder warte kurz.");
    setQuick(["25","35","50"]);
  }
}

function fmtKm(n){ return (n==null? "?" : (Math.round(n*10)/10).toString()); }
function fmtM(n){ return (n==null? "?" : Math.round(n).toString()); }

async function geocode(q){
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers:{ "Accept":"application/json" } });
  const data = await res.json();
  if(!data?.length) return null;
  return { lat:Number(data[0].lat), lon:Number(data[0].lon), label:data[0].display_name };
}

async function overpass(query){
  const eps = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];
  let last=null;
  for(const ep of eps){
    try{
      const res = await fetch(ep, { method:"POST", headers:{ "Content-Type":"text/plain;charset=UTF-8" }, body:query });
      if(!res.ok) throw new Error("HTTP "+res.status);
      return await res.json();
    }catch(e){ last=e; }
  }
  throw last || new Error("Overpass failed");
}

async function findRoutesOverpass(lat, lon, radiusKm){
  const r = Math.round(radiusKm*1000);

  // Better quality:
  // - hiking relations
  // - foot relations
  // - paths/footways with sac_scale or trail visibility (good hiking indicators)
  const q = `
[out:json][timeout:25];
(
  relation(around:${r},${lat},${lon})["route"="hiking"];
  relation(around:${r},${lat},${lon})["route"="foot"];
  way(around:${r},${lat},${lon})["highway"="path"]["sac_scale"];
  way(around:${r},${lat},${lon})["highway"="footway"]["sac_scale"];
);
out tags center 60;
`;
  const data = await overpass(q);
  const els = data.elements || [];

  const picks = [];
  for(const e of els){
    const isRel = e.type==="relation";
    const isWay = e.type==="way";
    const name = e.tags?.name || e.tags?.ref || (isRel ? "Hiking Route" : "Wanderweg");
    const centerLat = e.center?.lat ?? lat;
    const centerLon = e.center?.lon ?? lon;
    const kind = isRel ? (e.tags?.route || "relation") : (e.tags?.highway || "way");

    picks.push({
      osmType: e.type,
      osmId: e.id,
      name: name.length>70 ? (name.slice(0,70)+"…") : name,
      center: [centerLat, centerLon],
      kind,
      regionLabel: `Nähe ${state.chat.region}`
    });
  }

  // de-dup by name+rounded center
  const uniq=[];
  const seen=new Set();
  for(const p of picks){
    const key = `${p.name}:${Math.round(p.center[0]*1000)}:${Math.round(p.center[1]*1000)}:${p.kind}`;
    if(seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }

  // rank: named first, relations first
  uniq.sort((a,b)=>{
    const aRel = a.osmType==="relation" ? 0 : 1;
    const bRel = b.osmType==="relation" ? 0 : 1;
    if(aRel!==bRel) return aRel-bRel;
    const aNamed = a.name==="Hiking Route" || a.name==="Wanderweg" ? 1 : 0;
    const bNamed = b.name==="Hiking Route" || b.name==="Wanderweg" ? 1 : 0;
    return aNamed-bNamed;
  });

  return uniq.slice(0, 14);
}

// ---- Route load: geometry + stitching + elevation + weather + exits ----
async function loadRouteByIndex(idx){
  const pick = state.chat.candidates[idx];
  if(!pick) return;

  state.chat.step="loading_selected";
  saveState();
  setQuick([]);
  chatPush("bot","⏳ Lade Route (Geometrie), berechne Höhenmeter, Wetter und Assisted Exit…");

  try{
    const route = await loadGeometry(pick);
    // route: {name, coords, lengthKm}
    state.chat.selected = route;
    state.chat.highlightExit = null;

    // weather
    const first = route.coords?.[0];
    if(first){
      try{ route.weather = await fetchWeather(first[0], first[1]); }catch(e){ route.weather = null; }
    }

    // elevation (sample points)
    try{
      const elev = await computeElevationGain(route.coords);
      route.ascentM = elev.ascentM;
      route.descentM = elev.descentM;
    }catch(e){
      route.ascentM = null;
      route.descentM = null;
    }

    // exits
    try{
      state.chat.exits = await fetchAssistedExits(route);
    }catch(e){
      state.chat.exits = [];
    }

    saveState();

    // show summary card
    chatPush("bot", { type:"card", cardType:"routeSummary" });

    // draw on map
    await previewRoute(route);
    renderRoutePanel();

    state.chat.step="after_route";
    saveState();
    setQuick(["Pläne","Assisted Exit","Packliste","Karte öffnen","SOS"]);
  }catch(e){
    state.chat.step="pick_route";
    saveState();
    chatPush("bot","Diese Route konnte ich gerade nicht stabil laden. Bitte wähle eine andere Option.");
  }
}

async function previewPick(pick){
  const route = await loadGeometry(pick);
  state.chat.preview = route;
  saveState();
  await previewRoute(route);
}

async function previewRoute(route){
  ensureMap();
  clearMapOverlays();
  drawRoute(route.coords, {color:"#4ea1ff", weight:5, opacity:.95});
  fitToCoords(route.coords);
  drawExitsOnMap();
  mapInvalidateSafe();
}

async function loadGeometry(pick){
  // For relation: fetch member ways; for way: fetch geometry
  const type = pick.osmType;
  const id = pick.osmId;

  const q = type==="relation"
    ? `
[out:json][timeout:25];
relation(${id});
(._; >;);
out geom;
`
    : `
[out:json][timeout:25];
way(${id});
(._; >;);
out geom;
`;

  const data = await overpass(q);
  const els = data.elements || [];

  // collect way geometries
  const ways = els.filter(e => e.type==="way" && Array.isArray(e.geometry) && e.geometry.length>1);
  if(!ways.length) throw new Error("No ways geometry");

  // build segments
  const segs = ways.map(w => w.geometry.map(g => [g.lat, g.lon]));

  // Stitch segments to reduce zickzack
  const stitched = stitchSegments(segs);

  // Clean duplicates and simplify slightly
  const cleaned = dedupeConsecutive(stitched);
  const simplified = simplifyEveryN(cleaned, 2); // light simplification

  const lengthKm = polylineLengthKm(simplified);

  return {
    name: pick.name,
    kind: pick.kind,
    regionLabel: pick.regionLabel,
    coords: simplified,
    lengthKm
  };
}

// Stitch segments by connecting nearest endpoints (greedy)
function stitchSegments(segments){
  if(!segments.length) return [];
  // pick longest as base
  segments.sort((a,b)=> b.length - a.length);
  let path = segments.shift().slice();

  while(segments.length){
    let bestIdx=-1;
    let bestMode=null;
    let bestDist=Infinity;

    const head = path[0];
    const tail = path[path.length-1];

    for(let i=0;i<segments.length;i++){
      const s = segments[i];
      const sHead = s[0];
      const sTail = s[s.length-1];

      const d1 = haversineM(tail, sHead);
      const d2 = haversineM(tail, sTail);
      const d3 = haversineM(head, sTail);
      const d4 = haversineM(head, sHead);

      const localBest = Math.min(d1,d2,d3,d4);
      if(localBest < bestDist){
        bestDist = localBest;
        bestIdx = i;
        // determine how to attach
        if(localBest===d1) bestMode="tail_to_head";
        else if(localBest===d2) bestMode="tail_to_tail";
        else if(localBest===d3) bestMode="head_to_tail";
        else bestMode="head_to_head";
      }
    }

    const seg = segments.splice(bestIdx,1)[0];
    if(bestDist > 1200){
      // too far -> stop (prevents crazy joins)
      continue;
    }

    if(bestMode==="tail_to_head"){
      path = path.concat(seg);
    } else if(bestMode==="tail_to_tail"){
      path = path.concat(seg.slice().reverse());
    } else if(bestMode==="head_to_tail"){
      path = seg.concat(path);
    } else { // head_to_head
      path = seg.slice().reverse().concat(path);
    }
  }
  return path;
}

function dedupeConsecutive(coords){
  const out=[];
  let prev=null;
  for(const c of coords){
    if(!prev || c[0]!==prev[0] || c[1]!==prev[1]) out.push(c);
    prev=c;
  }
  return out;
}
function simplifyEveryN(coords, n){
  if(coords.length<3) return coords;
  const out=[];
  for(let i=0;i<coords.length;i++){
    if(i===0 || i===coords.length-1 || i % n === 0) out.push(coords[i]);
  }
  return out;
}

function polylineLengthKm(coords){
  let km=0;
  for(let i=1;i<coords.length;i++){
    km += haversineKm(coords[i-1], coords[i]);
  }
  return km;
}
function haversineKm(a,b){
  const R=6371;
  const dLat=(b[0]-a[0])*Math.PI/180;
  const dLon=(b[1]-a[1])*Math.PI/180;
  const lat1=a[0]*Math.PI/180;
  const lat2=b[0]*Math.PI/180;
  const x=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function haversineM(a,b){ return haversineKm(a,b)*1000; }

// ---- Weather ----
async function fetchWeather(lat, lon){
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m&hourly=precipitation_probability&forecast_days=1`;
  const r = await fetch(url, { headers:{ "Accept":"application/json" }});
  const d = await r.json();
  const tempC = d?.current?.temperature_2m;
  const windKmh = d?.current?.wind_speed_10m;
  let rainChance = null;
  if(d?.hourly?.precipitation_probability?.length) rainChance = d.hourly.precipitation_probability[0];
  return { tempC, windKmh, rainChance };
}

// ---- Elevation gain (OpenTopoData SRTM90m) ----
async function computeElevationGain(coords){
  // sample up to 120 points to reduce rate/URL size
  const sample = samplePolyline(coords, 120);
  // batch into chunks of 80 locations (opentopodata limit friendly)
  const elevations = [];
  for(let i=0;i<sample.length;i+=80){
    const chunk = sample.slice(i, i+80);
    const e = await fetchElevations(chunk);
    elevations.push(...e);
    await sleep(200); // small delay to be polite
  }

  let ascent=0, descent=0;
  for(let i=1;i<elevations.length;i++){
    const prev = elevations[i-1];
    const cur = elevations[i];
    if(prev==null || cur==null) continue;
    const diff = cur - prev;
    if(diff>0) ascent += diff;
    else descent += (-diff);
  }
  return { ascentM: Math.round(ascent), descentM: Math.round(descent) };
}

async function fetchElevations(latlonArr){
  const loc = latlonArr.map(p => `${p[0]},${p[1]}`).join("|");
  const url = `https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(loc)}`;
  const r = await fetch(url, { headers:{ "Accept":"application/json" }});
  const d = await r.json();
  const res = d?.results || [];
  return res.map(x => (typeof x.elevation==="number" ? x.elevation : null));
}

function samplePolyline(coords, maxPoints){
  if(coords.length<=maxPoints) return coords;
  const step = Math.max(1, Math.floor(coords.length / maxPoints));
  const out=[];
  for(let i=0;i<coords.length;i+=step) out.push(coords[i]);
  if(out[out.length-1] !== coords[coords.length-1]) out.push(coords[coords.length-1]);
  return out.slice(0, maxPoints);
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ---- Assisted Exit: real POIs near route ----
async function fetchAssistedExits(route){
  const sample = samplePolyline(route.coords, 16);
  const aroundM = 450;

  const parts = sample.map(([lat,lon])=>`
(
  node(around:${aroundM},${lat},${lon})["highway"="bus_stop"];
  node(around:${aroundM},${lat},${lon})["public_transport"="platform"];
  node(around:${aroundM},${lat},${lon})["railway"="station"];
  node(around:${aroundM},${lat},${lon})["railway"="tram_stop"];
  node(around:${aroundM},${lat},${lon})["amenity"="parking"];
  node(around:${aroundM},${lat},${lon})["amenity"="taxi"];
  node(around:${aroundM},${lat},${lon})["amenity"="shelter"];
  node(around:${aroundM},${lat},${lon})["tourism"="alpine_hut"];
  node(around:${aroundM},${lat},${lon})["tourism"="information"];
);
`).join("\n");

  const q = `[out:json][timeout:25]; ${parts} out tags 200;`;
  const data = await overpass(q);
  const nodes = (data.elements || []).filter(e=> e.type==="node" && typeof e.lat==="number" && typeof e.lon==="number");

  const exits = nodes.map(n=>{
    const tags = n.tags || {};
    const kind =
      tags.railway==="station" ? "Bahnhof" :
      tags.railway==="tram_stop" ? "Tram" :
      tags.highway==="bus_stop" ? "Bus" :
      tags.public_transport==="platform" ? "ÖPNV-Platform" :
      tags.amenity==="parking" ? "Parkplatz" :
      tags.amenity==="taxi" ? "Taxi" :
      tags.amenity==="shelter" ? "Unterstand" :
      tags.tourism==="alpine_hut" ? "Hütte" :
      tags.tourism==="information" ? "Info" :
      "Exit";

    const name = tags.name || tags.ref || "";
    const pt = [n.lat, n.lon];
    const dist = distancePointToPolylineM(pt, route.coords);

    return { kind, name, lat:n.lat, lon:n.lon, distToRouteM: dist };
  });

  exits.sort((a,b)=> (a.distToRouteM??1e9) - (b.distToRouteM??1e9));

  // keep unique by rounded coords + kind + name
  const uniq=[];
  const seen=new Set();
  for(const x of exits){
    const key = `${x.kind}:${x.name}:${x.lat.toFixed(5)}:${x.lon.toFixed(5)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    uniq.push(x);
    if(uniq.length>=12) break;
  }
  return uniq;
}

// faster approx: check every 6th point
function distancePointToPolylineM(pt, coords){
  let best=Infinity;
  for(let i=0;i<coords.length;i+=6){
    best = Math.min(best, haversineM(pt, coords[i]));
  }
  return best===Infinity ? null : best;
}

// ---- Plans A/B/C ----
function buildPlans(){
  const r = state.chat.selected;
  if(!r) return chatPush("bot","Bitte zuerst eine Route wählen.");

  const p = state.chat.profile;
  const base = r.lengthKm || 8;
  const safety = p.safety ?? 3;
  const pain = p.pain ?? 2;
  const stamina = p.stamina ?? 3;
  const breaks = p.breakNeed ?? 3;

  const caution = (safety-2)*0.12 + (pain-1)*0.10 + (breaks-1)*0.06;
  const energyFactor = Math.max(0.6, Math.min(1.2, (stamina/3)));

  const A = {
    title: "Standard",
    summary: `Volle Route (~${fmtKm(base)} km). Puffer moderat.`
  };
  const B = {
    title: "Konservativ",
    summary: `Kürzer & mehr Puffer: ~${fmtKm(base * (0.75*energyFactor))} km. Mehr Pausen, Exit-Nähe beachten.`
  };
  const C = {
    title: "Sehr sicher",
    summary: `Maximale Sicherheit: ~${fmtKm(base * (0.55*energyFactor))} km. Früher Umkehrpunkt + Exit-Optionen priorisieren.`
  };

  state.chat.plans = { A,B,C };
  state.chat.activePlanKey="A";
  saveState();

  chatPush("bot","Hier sind deine Pläne. Jeder Plan ist auf der Karte als grüne Overlay-Strecke sichtbar:");
  chatPush("bot",{ type:"card", cardType:"plan", data:{ key:"A", plan:A }});
  chatPush("bot",{ type:"card", cardType:"plan", data:{ key:"B", plan:B }});
  chatPush("bot",{ type:"card", cardType:"plan", data:{ key:"C", plan:C }});
  state.chat.step="after_route";
  saveState();
}

function showPacklist(){
  const r = state.chat.selected;
  const w = r?.weather;
  const p = state.chat.profile;
  const items = [
    "Wasser (0.5–1.5L je nach Dauer/Wärme)",
    "Snack/Notfall-Energie",
    "Powerbank + Kabel",
    "Offline-Karte (Karte öffnen)",
    "Erste Hilfe (Basics)",
    "Schichtprinzip Kleidung"
  ];
  if(w && Number(w.rainChance)>=40) items.push("Regenjacke (Regenrisiko erhöht)");
  if(w && Number(w.tempC)<=6) items.push("Wärmeschicht (kühl)");
  if((p.breakNeed??3)>=4) items.push("Sitzunterlage (hoher Pausenbedarf)");
  if((p.pain??2)>=4) items.push("Stöcke/Bandage (heute sinnvoll)");
  chatPush("bot","🎒 Packliste:\n• " + items.join("\n• "));
}

function showExitsInChat(){
  const exits = state.chat.exits || [];
  if(!exits.length){
    chatPush("bot","Ich habe gerade keine Exit-POIs gefunden (Beta). Öffne die Karte, zoome raus, suche Parkplatz/Ort/ÖPNV.");
    return;
  }
  chatPush("bot","Assisted Exit Optionen (echte OSM-Punkte). Tippe eine an → Karte markiert sie:");
  exits.slice(0,8).forEach(x=>{
    chatPush("bot",{ type:"card", cardType:"exit", data:{ exit:x }});
  });
}

function triggerSOS(){
  const r = state.chat.selected;
  if(!r){
    chatPush("bot","🆘 Ich kann Rückzug nur planen, wenn eine Route gewählt ist. Sag: „Tourenvorschläge“.");
    return;
  }
  chatPush("bot",
`🆘 Rückzug-Assistent (kein Notruf / kein Ersatz für Bergrettung)

1) STOPP: 2 Min ruhig atmen, trinken, warm bleiben.
2) Standort prüfen: „Karte öffnen“.
3) Wähle Exit: Bus/Bahnhof/Parkplatz/Taxi/Unterstand/Hütte/Info.
4) Bei akuter Gefahr/Verletzung: 112 / lokale Bergrettung.

Hier sind die nächsten Exit-Optionen:`);

  showExitsInChat();
}

// ---- Map ----
let map=null, tile=null, activeLine=null, planLine=null, exitMarkers=[], highlightMarker=null;

function ensureMap(){
  if(map) return;

  map = L.map("map", { zoomControl:true, preferCanvas:true });

  const tiles = [
    { url:"https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attr:"© OpenStreetMap" },
    { url:"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", attr:"© CARTO" },
    { url:"https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", attr:"© OpenTopoMap" }
  ];
  let idx=0;

  const setTile=(i)=>{
    if(tile) tile.remove();
    idx=i;
    tile = L.tileLayer(tiles[i].url, { maxZoom:18, attribution:tiles[i].attr });
    tile.on("tileerror", ()=> { if(idx<tiles.length-1) setTile(idx+1); });
    tile.addTo(map);
  };
  setTile(0);

  map.setView([48.137154,11.576124], 11);
}

function mapInvalidateSafe(){
  if(!map) return;
  try{ map.invalidateSize(true); }catch(e){}
}

function clearMapOverlays(){
  if(activeLine){ activeLine.remove(); activeLine=null; }
  if(planLine){ planLine.remove(); planLine=null; }
  exitMarkers.forEach(m=>m.remove());
  exitMarkers=[];
  if(highlightMarker){ highlightMarker.remove(); highlightMarker=null; }
}

function drawRoute(coords, style){
  if(!coords?.length) return;
  activeLine = L.polyline(coords.map(c=>[c[0],c[1]]), style || {color:"#4ea1ff",weight:5,opacity:.95}).addTo(map);
}

function fitToCoords(coords){
  if(!coords?.length) return;
  const b = L.latLngBounds(coords.map(c=>[c[0],c[1]]));
  map.fitBounds(b.pad(0.15));
}

function recenterToSelected(){
  const r = state.chat.selected || state.chat.preview;
  if(r?.coords?.length){
    fitToCoords(r.coords);
    mapInvalidateSafe();
  }
}

function drawSelectedRouteAndPlan(){
  const r = state.chat.selected;
  if(!r?.coords?.length) return;
  ensureMap();
  clearMapOverlays();

  drawRoute(r.coords, {color:"#4ea1ff",weight:5,opacity:.95});

  const key = state.chat.activePlanKey || "A";
  const ratio = key==="A" ? 1 : (key==="B" ? 0.72 : 0.55);
  const cut = Math.max(2, Math.floor(r.coords.length * ratio));
  const sub = r.coords.slice(0, cut);

  planLine = L.polyline(sub.map(c=>[c[0],c[1]]), {color:"#32d583",weight:6,opacity:.85}).addTo(map);

  drawExitsOnMap();
  fitToCoords(r.coords);
  mapInvalidateSafe();
}

function drawExitsOnMap(){
  const exits = state.chat.exits || [];
  exitMarkers.forEach(m=>m.remove());
  exitMarkers=[];

  exits.slice(0,10).forEach(x=>{
    const m = L.circleMarker([x.lat,x.lon], {radius:7,color:"#ffcc00",weight:2,fillColor:"#ffcc00",fillOpacity:.8})
      .addTo(map)
      .bindPopup(`<b>${escapeHtml(x.kind)}</b><br>${escapeHtml(x.name||"") || "—"}<br>~${fmtM(x.distToRouteM)} m zur Route`);
    exitMarkers.push(m);
  });

  if(state.chat.highlightExit){
    const x = state.chat.highlightExit;
    highlightMarker = L.marker([x.lat,x.lon]).addTo(map).bindPopup(`⭐ ${escapeHtml(x.kind)}: ${escapeHtml(x.name||"")}`).openPopup();
  }
}

function renderRoutePanel(){
  const r = state.chat.selected || state.chat.preview;
  if(!r){
    dom.routeSummary.textContent = "Noch keine Route ausgewählt.";
    return;
  }
  const w = r.weather;
  const wLine = w ? `Wetter: ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regen ${w.rainChance ?? "?"}%` : "Wetter: nicht geladen";
  dom.routeSummary.textContent =
    `${r.name || "Route"}\n` +
    `Länge: ~${fmtKm(r.lengthKm)} km\n` +
    `Höhenmeter: ↑ ${fmtM(r.ascentM)} m • ↓ ${fmtM(r.descentM)} m\n` +
    `${wLine}\n` +
    `Assisted Exit: ${state.chat.exits?.length || 0} Punkte`;
}