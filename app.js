/* SafeTrek – Single-file App Logic (Beta)
   - Dashboard → Chat → Route Map
   - OSM Routes via Nominatim + Overpass
   - Weather via Open-Meteo
   - Assisted Exit POIs via Overpass
   - Plan A/B/C Cards + Visualisierung
   - SOS / "Ich schaffe es nicht weiter" (Exit + Hinweise)

   Hinweis: APIs sind public & können rate-limited sein → wir zeigen Ladezustände + Fallbacks.
*/

const LS_KEY = "safetreks_state_v15";

const defaultState = {
  view: "dash",
  dash: { region: "München", radiusKm: 25, lastCandidates: [] },
  chat: {
    step: "idle",
    history: [],
    profile: {
      stamina: null, breakNeed: null, safety: null, energy: null, pain: null,
      today: ""
    },
    wantsRoutes: null,
    region: "",
    radiusKm: 25,
    candidates: [],
    selected: null, // selected route object with coords etc
    plans: null,    // {A,B,C}
    exits: []       // assisted exits for selected route
  }
};

let state = loadState();

// ---- DOM ----
const el = {
  dashBtn: document.getElementById("btnDash"),
  chatBtn: document.getElementById("btnChat"),
  routeBtn: document.getElementById("btnRoute"),

  viewDash: document.getElementById("viewDash"),
  viewChat: document.getElementById("viewChat"),
  viewRoute: document.getElementById("viewRoute"),

  btnStartChat: document.getElementById("btnStartChat"),
  btnNewPlan: document.getElementById("btnNewPlan"),
  dashRegion: document.getElementById("dashRegion"),
  dashRadius: document.getElementById("dashRadius"),
  btnDashSuggest: document.getElementById("btnDashSuggest"),
  dashRouteList: document.getElementById("dashRouteList"),

  chatMessages: document.getElementById("chatMessages"),
  quickReplies: document.getElementById("quickReplies"),
  chatInput: document.getElementById("chatInput"),
  chatSend: document.getElementById("chatSend"),

  btnRouteBack: document.getElementById("btnRouteBack"),
  btnRecenter: document.getElementById("btnRecenter"),
  btnSOS: document.getElementById("btnSOS"),
  routeSummary: document.getElementById("routeSummary"),

  map: document.getElementById("map")
};

// ---- View control ----
function showView(name) {
  state.view = name;
  document.querySelectorAll("[data-view]").forEach(v => {
    v.style.display = (v.getAttribute("data-view") === name) ? "block" : "none";
  });
  saveState();

  if (name === "dash") renderDash();
  if (name === "chat") {
    renderChat();
    setTimeout(() => el.chatInput?.focus(), 80);
  }
  if (name === "route") {
    ensureMap();
    setTimeout(() => {
      mapInvalidateSafe();
      renderRoutePanel();
    }, 120);
  }
}
window.showView = showView; // used by index or debugging

// ---- Persistence ----
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch(e) {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(defaultState);
    const parsed = JSON.parse(raw);
    return deepMerge(structuredClone(defaultState), parsed);
  } catch(e) {
    return structuredClone(defaultState);
  }
}
function deepMerge(base, extra) {
  if (typeof base !== "object" || base === null) return extra ?? base;
  if (Array.isArray(base)) return Array.isArray(extra) ? extra : base;
  const out = { ...base };
  if (typeof extra !== "object" || extra === null) return out;
  for (const k of Object.keys(extra)) {
    out[k] = deepMerge(base[k], extra[k]);
  }
  return out;
}

// ---- Helpers ----
const fmt = {
  km: (n) => (n == null ? "?" : (Math.round(n * 10) / 10).toString()),
  m: (n) => (n == null ? "?" : Math.round(n).toString()),
  time: () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
};

function chatPush(role, payload) {
  // payload can be string OR {type, ...}
  const msg = (typeof payload === "string")
    ? { role, type: "text", text: payload, t: fmt.time() }
    : { role, t: fmt.time(), ...payload };

  state.chat.history.push(msg);
  saveState();
  renderChat();
}

function setQuickReplies(arr) {
  el.quickReplies.innerHTML = "";
  (arr || []).forEach(txt => {
    const b = document.createElement("button");
    b.className = "qbtn";
    b.type = "button";
    b.textContent = txt;
    b.onclick = () => handleChatInput(txt);
    el.quickReplies.appendChild(b);
  });
}

// ---- INIT wiring ----
function init() {
  el.dashBtn?.addEventListener("click", () => showView("dash"));
  el.chatBtn?.addEventListener("click", () => { startChat(true); showView("chat"); });
  el.routeBtn?.addEventListener("click", () => showView("route"));

  el.btnStartChat?.addEventListener("click", () => { startChat(true); showView("chat"); });
  el.btnNewPlan?.addEventListener("click", () => resetChat());

  el.btnDashSuggest?.addEventListener("click", () => {
    const region = (el.dashRegion?.value || "").trim();
    const radiusKm = Number(el.dashRadius?.value || 25);
    state.dash.region = region || state.dash.region;
    state.dash.radiusKm = radiusKm;
    saveState();

    // Start chat and continue with route suggestion flow
    startChat(true);
    showView("chat");
    // We will inject after profile sequence ONLY if already answered.
    // If idle, the bot will ask the proper next steps.
    state.chat.region = state.dash.region;
    state.chat.radiusKm = state.dash.radiusKm;
    saveState();

    chatPush("user", "Ja, Tourenvorschläge");
    handleChatInput(state.dash.region);
    handleChatInput(String(state.dash.radiusKm));
  });

  el.chatSend?.addEventListener("click", () => {
    const v = (el.chatInput?.value || "").trim();
    if (!v) return;
    el.chatInput.value = "";
    handleChatInput(v);
  });

  el.chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.chatSend?.click();
  });

  el.btnRouteBack?.addEventListener("click", () => {
    // Back returns to chat (not dashboard)
    showView("chat");
  });
  el.btnRecenter?.addEventListener("click", () => recenterToSelected());
  el.btnSOS?.addEventListener("click", () => triggerSOS());

  // preload dash fields
  el.dashRegion.value = state.dash.region || "";
  el.dashRadius.value = state.dash.radiusKm || 25;

  // initial view
  showView(state.view || "dash");
}
init();

// ---- DASH ----
function renderDash() {
  el.dashRegion.value = state.dash.region || "";
  el.dashRadius.value = state.dash.radiusKm || 25;

  // Show last candidates as cards
  const list = el.dashRouteList;
  list.innerHTML = "";
  const candidates = state.dash.lastCandidates || [];
  if (!candidates.length) {
    list.innerHTML = `<div class="card"><div class="card__title">Noch keine Touren</div><div class="card__meta">Nutze Chat oder den Schnellstart.</div></div>`;
    return;
  }
  candidates.slice(0, 6).forEach((c, idx) => {
    list.appendChild(dashRouteCard(c, idx));
  });
}

function dashRouteCard(route, idx) {
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `
    <div class="card__title">🥾 ${escapeHtml(route.name || "Route")}</div>
    <div class="card__meta">${escapeHtml(route.regionLabel || "")} • Quelle: OpenStreetMap</div>
    <div class="stack" style="margin-top:10px">
      <button class="secondary" type="button">Im Chat anzeigen</button>
    </div>
  `;
  d.querySelector("button").onclick = () => {
    startChat(true);
    showView("chat");
    chatPush("bot", { type:"text", text:`Ich habe noch Touren im Zwischenspeicher. Soll ich dir die Optionen nochmal anzeigen?` });
    state.chat.candidates = state.dash.lastCandidates || [];
    state.chat.step = "pick_route";
    saveState();
    renderChat();
  };
  return d;
}

// ---- CHAT FLOW ----
function resetChat() {
  state.chat = structuredClone(defaultState.chat);
  saveState();
  startChat(false);
  showView("chat");
}

function startChat(ifEmptyOnly = true) {
  if (ifEmptyOnly && state.chat.history.length) return;

  // Welcome + start questions
  state.chat.step = "ask_today";
  saveState();
  chatPush("bot", "Hi, ich bin SafeTrek. Ich helfe dir heute eine sichere, machbare Outdoor-Entscheidung zu treffen.");
  chatPush("bot", "Wie geht’s dir heute gerade? (z.B. „müde“, „okay“, „unsicher“, „fit“)");
  setQuickReplies(["müde", "okay", "unsicher", "fit"]);
}

function handleChatInput(raw) {
  chatPush("user", raw);

  // global commands
  const low = raw.toLowerCase();
  if (low.includes("dashboard")) { showView("dash"); return; }
  if (low.includes("neue planung")) { resetChat(); return; }
  if (low === "hilfe") {
    chatPush("bot","Du kannst jederzeit schreiben: „neue planung“, „dashboard“, „karte öffnen“, „ich schaffe es nicht weiter“.");
  }
  if (low.includes("karte öffnen")) {
    if (state.chat.selected) showView("route");
    else chatPush("bot","Noch keine Route ausgewählt. Wähle zuerst eine Route.");
    return;
  }
  if (low.includes("ich schaffe es nicht weiter") || low.includes("sos")) {
    triggerSOS();
    return;
  }

  const s = state.chat.step;

  if (s === "ask_today") {
    state.chat.profile.today = raw;
    state.chat.step = "ask_stamina";
    saveState();
    chatPush("bot", "Wie ist deine Belastbarkeit heute? (1=sehr niedrig … 5=sehr hoch)");
    setQuickReplies(["1","2","3","4","5"]);
    return;
  }

  if (s === "ask_stamina") {
    const n = toScale(raw, 1, 5); if (n == null) return askAgain("Bitte 1–5.");
    state.chat.profile.stamina = n;
    state.chat.step = "ask_breakNeed";
    saveState();
    chatPush("bot", "Wie hoch ist dein Pausenbedarf? (1–5)");
    setQuickReplies(["1","2","3","4","5"]);
    return;
  }

  if (s === "ask_breakNeed") {
    const n = toScale(raw, 1, 5); if (n == null) return askAgain("Bitte 1–5.");
    state.chat.profile.breakNeed = n;
    state.chat.step = "ask_safety";
    saveState();
    chatPush("bot", "Wie wichtig ist dir Sicherheit / Puffer heute? (2–5)");
    setQuickReplies(["2","3","4","5"]);
    return;
  }

  if (s === "ask_safety") {
    const n = toScale(raw, 2, 5); if (n == null) return askAgain("Bitte 2–5.");
    state.chat.profile.safety = n;
    state.chat.step = "ask_energy";
    saveState();
    chatPush("bot", "Wie ist deine Energie heute? (1–5)");
    setQuickReplies(["1","2","3","4","5"]);
    return;
  }

  if (s === "ask_energy") {
    const n = toScale(raw, 1, 5); if (n == null) return askAgain("Bitte 1–5.");
    state.chat.profile.energy = n;
    state.chat.step = "ask_pain";
    saveState();
    chatPush("bot", "Gibt es Schmerz/Überlastungs-Risiko? (1=kaum … 5=hoch)");
    setQuickReplies(["1","2","3","4","5"]);
    return;
  }

  if (s === "ask_pain") {
    const n = toScale(raw, 1, 5); if (n == null) return askAgain("Bitte 1–5.");
    state.chat.profile.pain = n;

    // WICHTIG: danach direkt Tourenfrage
    state.chat.step = "ask_wants_routes";
    saveState();
    chatPush("bot", "Möchtest du Tourenvorschläge? (Ja/Nein)");
    setQuickReplies(["Ja, Tourenvorschläge", "Nein"]);
    return;
  }

  if (s === "ask_wants_routes") {
    const yes = low.includes("ja");
    state.chat.wantsRoutes = yes;
    if (!yes) {
      state.chat.step = "idle";
      saveState();
      setQuickReplies([]);
      chatPush("bot","Okay. Sag mir einfach, was du brauchst: Packliste, Wetter, Sicherheitscheck, oder schreibe später „Tourenvorschläge“.");
      return;
    }
    state.chat.step = "ask_region";
    saveState();
    chatPush("bot", "In welcher Region möchtest du Vorschläge? (z.B. „München“, „Salzburg“, „Garmisch“)");
    setQuickReplies(["München", "Garmisch-Partenkirchen", "Salzburg", "Innsbruck"]);
    return;
  }

  if (s === "ask_region") {
    state.chat.region = raw.trim();
    state.chat.step = "ask_radius";
    saveState();
    chatPush("bot", "Wie groß soll der Suchradius sein (km)? (z.B. 10, 25, 50)");
    setQuickReplies(["10","25","50","80"]);
    return;
  }

  if (s === "ask_radius") {
    const km = Number(raw);
    if (!Number.isFinite(km) || km < 5 || km > 200) return askAgain("Bitte eine Zahl zwischen 5 und 200.");
    state.chat.radiusKm = km;
    state.chat.step = "loading_routes";
    saveState();

    // search routes
    (async () => {
      try {
        chatPush("bot","🔎 Suche echte Wander-Routen (OpenStreetMap) …");
        setQuickReplies([]);

        const geo = await geocodeRegion(state.chat.region);
        if (!geo) {
          state.chat.step = "ask_region";
          saveState();
          chatPush("bot","Ich konnte die Region nicht finden. Bitte etwas präziser (z.B. „München, Bayern“).");
          return;
        }

        const candidates = await findHikingRoutes(geo.lat, geo.lon, state.chat.radiusKm);
        if (!candidates.length) {
          state.chat.step = "ask_radius";
          saveState();
          chatPush("bot","Ich habe dort gerade keine passenden Hiking-Routen gefunden. Versuch größeren Radius (z.B. 50) oder andere Region.");
          setQuickReplies(["50","80","München","Salzburg"]);
          return;
        }

        state.chat.candidates = candidates;
        state.dash.lastCandidates = candidates;
        state.dash.region = state.chat.region;
        state.dash.radiusKm = state.chat.radiusKm;
        saveState();

        chatPush("bot", { type:"text", text:`Ich habe ${candidates.length} Routen gefunden. Wähle eine Option:` });
        state.chat.step = "pick_route";
        saveState();
        renderChat(); // cards
      } catch(e) {
        state.chat.step = "ask_radius";
        saveState();
        chatPush("bot","Die Suche war gerade schwierig (Overpass/OSM). Versuch es nochmal oder warte 1 Minute.");
        setQuickReplies(["25","50","80"]);
      }
    })();

    return;
  }

  if (s === "pick_route") {
    // allow picking by number
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx < 1 || idx > (state.chat.candidates?.length || 0)) {
      chatPush("bot","Bitte wähle eine gültige Nummer (1, 2, 3 …) oder tippe auf „Diese Route wählen“.");
      return;
    }
    loadRouteByIndex(idx - 1);
    return;
  }

  if (s === "after_route") {
    // next actions
    if (low.includes("pläne") || low.includes("plan")) {
      buildPlans();
      return;
    }
    if (low.includes("pack")) {
      showPacklist();
      return;
    }
    if (low.includes("assisted") || low.includes("exit")) {
      showExitsInChat();
      return;
    }
    if (low.includes("karte")) {
      showView("route");
      return;
    }
    chatPush("bot","Sag: „Pläne“, „Assisted Exit“, „Packliste“ oder „Karte öffnen“.");
    setQuickReplies(["Pläne", "Assisted Exit", "Packliste", "Karte öffnen"]);
    return;
  }

  // idle fallback
  if (low.includes("touren")) {
    state.chat.step = "ask_region";
    saveState();
    chatPush("bot","Alles klar – welche Region?");
    setQuickReplies(["München","Salzburg","Innsbruck"]);
    return;
  }

  chatPush("bot","Ich bin da. Wenn du Touren willst: schreibe „Tourenvorschläge“. Oder „neue planung“.");
}

function askAgain(t){ chatPush("bot", t); }
function toScale(raw, min, max){
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// ---- Render chat ----
function renderChat() {
  if (!el.chatMessages) return;
  el.chatMessages.innerHTML = "";

  for (const m of state.chat.history) {
    const row = document.createElement("div");
    row.className = `msg ${m.role === "user" ? "user" : "bot"}`;

    const wrap = document.createElement("div");
    wrap.className = "bubbleWrap";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (m.role === "user" ? "Du" : "SafeTrek") + " • " + (m.t || "");

    wrap.appendChild(meta);

    if (m.type === "card" && m.cardType === "routeOption") {
      wrap.appendChild(routeOptionCard(m.data));
    } else if (m.type === "card" && m.cardType === "routeSummary") {
      wrap.appendChild(routeSummaryCard());
    } else if (m.type === "card" && m.cardType === "plan") {
      wrap.appendChild(planCard(m.data));
    } else if (m.type === "card" && m.cardType === "exit") {
      wrap.appendChild(exitCard(m.data));
    } else {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.text || "";
      wrap.appendChild(bubble);
    }

    row.appendChild(wrap);
    el.chatMessages.appendChild(row);
  }

  // If we are in pick_route step, ensure route cards are shown again
  if (state.chat.step === "pick_route" && Array.isArray(state.chat.candidates) && state.chat.candidates.length) {
    state.chat.candidates.slice(0, 10).forEach((r, i) => {
      const msg = { role:"bot", type:"card", cardType:"routeOption", t:fmt.time(), data:{ route:r, index:i } };
      // render directly (not pushing to history to avoid duplicates)
      const row = document.createElement("div");
      row.className = "msg bot";
      const wrap = document.createElement("div");
      wrap.className = "bubbleWrap";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `SafeTrek • Option ${i+1}`;
      wrap.appendChild(meta);
      wrap.appendChild(routeOptionCard({ route:r, index:i }));
      row.appendChild(wrap);
      el.chatMessages.appendChild(row);
    });
    setQuickReplies(["1","2","3","4","5","Mehr Radius"]);
  } else if (state.chat.step === "after_route") {
    setQuickReplies(["Pläne", "Assisted Exit", "Packliste", "Karte öffnen", "Ich schaffe es nicht weiter"]);
  }

  requestAnimationFrame(() => {
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  });
}

function routeOptionCard({ route, index }) {
  const card = document.createElement("div");
  card.className = "chatCard";

  const title = document.createElement("div");
  title.className = "chatCard__title";
  title.textContent = `🥾 ${route.name || "Route"}  (Option ${index + 1})`;

  const meta = document.createElement("div");
  meta.className = "chatCard__meta";
  meta.textContent = `${route.regionLabel || ""} • Quelle: OpenStreetMap`;

  const actions = document.createElement("div");
  actions.className = "chatCard__actions";

  const viewBtn = document.createElement("button");
  viewBtn.className = "secondary";
  viewBtn.type = "button";
  viewBtn.textContent = "Route ansehen";
  viewBtn.onclick = async () => {
    await previewRoute(route);
    showView("route");
  };

  const selectBtn = document.createElement("button");
  selectBtn.className = "primary";
  selectBtn.type = "button";
  selectBtn.textContent = "Diese Route wählen";
  selectBtn.onclick = () => loadRouteByIndex(index);

  actions.appendChild(viewBtn);
  actions.appendChild(selectBtn);

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

function routeSummaryCard() {
  const r = state.chat.selected;
  if (!r) return document.createElement("div");
  const card = document.createElement("div");
  card.className = "chatCard";

  card.innerHTML = `
    <div class="chatCard__title">✅ Route gewählt: ${escapeHtml(r.name || "Route")}</div>
    <div class="chatCard__meta">
      Länge: ~${fmt.km(r.lengthKm)} km • Quelle: OpenStreetMap
      ${r.weather ? ` • Wetter: ${r.weather.tempC ?? "?"}°C, Wind ${r.weather.windKmh ?? "?"} km/h, Regenrisiko ${r.weather.rainChance ?? "?"}%` : ""}
    </div>
  `;

  const actions = document.createElement("div");
  actions.className = "chatCard__actions";

  const openMap = document.createElement("button");
  openMap.className = "secondary";
  openMap.textContent = "Karte öffnen";
  openMap.onclick = () => showView("route");

  const plans = document.createElement("button");
  plans.className = "primary";
  plans.textContent = "Pläne berechnen (A/B/C)";
  plans.onclick = () => buildPlans();

  const exits = document.createElement("button");
  exits.className = "secondary";
  exits.textContent = "Assisted Exit";
  exits.onclick = () => showExitsInChat();

  const sos = document.createElement("button");
  sos.className = "danger";
  sos.textContent = "Ich schaffe es nicht weiter";
  sos.onclick = () => triggerSOS();

  actions.appendChild(openMap);
  actions.appendChild(plans);
  actions.appendChild(exits);
  actions.appendChild(sos);
  card.appendChild(actions);
  return card;
}

function planCard({ key, plan }) {
  const card = document.createElement("div");
  card.className = "chatCard";
  const title = document.createElement("div");
  title.className = "chatCard__title";
  title.textContent = `Plan ${key}: ${plan.title}`;

  const meta = document.createElement("div");
  meta.className = "chatCard__meta";
  meta.textContent = `${plan.summary}`;

  const actions = document.createElement("div");
  actions.className = "chatCard__actions";

  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.textContent = "Auf Karte anzeigen";
  btn.onclick = () => {
    state.chat.activePlanKey = key;
    saveState();
    showView("route");
    drawSelectedRouteAndPlan();
  };

  const sos = document.createElement("button");
  sos.className = "danger";
  sos.textContent = "Ich schaffe es nicht weiter";
  sos.onclick = () => triggerSOS();

  actions.appendChild(btn);
  actions.appendChild(sos);

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

function exitCard({ exit }) {
  const card = document.createElement("div");
  card.className = "chatCard";
  card.innerHTML = `
    <div class="chatCard__title">🚪 ${escapeHtml(exit.kind)}: ${escapeHtml(exit.name || "Option")}</div>
    <div class="chatCard__meta">
      Entfernung zur Route: ~${fmt.m(exit.distToRouteM)} m • Koordinaten: ${exit.lat.toFixed(5)}, ${exit.lon.toFixed(5)}
    </div>
  `;

  const actions = document.createElement("div");
  actions.className = "chatCard__actions";

  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.textContent = "Auf Karte anzeigen";
  btn.onclick = () => {
    state.chat.highlightExit = exit;
    saveState();
    showView("route");
    drawSelectedRouteAndPlan();
  };

  actions.appendChild(btn);
  card.appendChild(actions);
  return card;
}

// ---- ROUTE SELECT / LOAD ----
async function loadRouteByIndex(idx) {
  const pick = state.chat.candidates[idx];
  if (!pick) { chatPush("bot", "Bitte wähle eine gültige Option."); return; }

  state.chat.step = "loading_selected";
  saveState();
  chatPush("bot", "⏳ Lade Route, Wetter und Assisted Exit …");

  try {
    const route = await loadRouteGeometry(pick);
    state.chat.selected = route;

    // Weather
    const first = route.coords?.[0];
    if (first) {
      try { route.weather = await fetchWeather(first[0], first[1]); } catch(e) { route.weather = null; }
    }

    // Assisted exits near route
    try {
      state.chat.exits = await fetchExitPOIsNearRoute(route);
    } catch(e) {
      state.chat.exits = [];
    }

    state.chat.step = "after_route";
    saveState();

    // Add structured route summary card
    chatPush("bot", { type:"card", cardType:"routeSummary" });

    // Show map also (optional)
    await previewRoute(route);
    renderRoutePanel();

  } catch(e) {
    state.chat.step = "pick_route";
    saveState();
    chatPush("bot", "Diese Route konnte ich gerade nicht sauber laden. Bitte wähle eine andere Option.");
  }
}

async function previewRoute(routeOrPick) {
  // Accept either pick or full route
  let r = routeOrPick.coords ? routeOrPick : await loadRouteGeometry(routeOrPick);
  state.chat.preview = r;
  saveState();
  ensureMap();
  drawRoute(r.coords, { color:"#4ea1ff", weight:5, opacity:.95 });
  fitToCoords(r.coords);
  renderRoutePanel();
}

function renderRoutePanel() {
  const r = state.chat.selected || state.chat.preview;
  if (!r) {
    el.routeSummary.textContent = "Noch keine Route ausgewählt.";
    return;
  }
  const w = r.weather;
  const wLine = w ? `Wetter: ${w.tempC ?? "?"}°C • Wind ${w.windKmh ?? "?"} km/h • Regen ${w.rainChance ?? "?"}%` : "Wetter: nicht geladen";
  el.routeSummary.textContent =
    `${r.name || "Route"}\n` +
    `Länge: ~${fmt.km(r.lengthKm)} km\n` +
    `${wLine}\n` +
    `Assisted Exit Optionen: ${state.chat.exits?.length || 0}`;
}

// ---- PLANS A/B/C ----
function buildPlans() {
  const r = state.chat.selected;
  if (!r) { chatPush("bot","Wähle zuerst eine Route."); return; }

  // Simple adaptive logic (beta): uses profile to suggest shorter/safer alternatives
  const p = state.chat.profile;
  const safetyBias = (p.safety || 3) >= 4;
  const lowEnergy = (p.energy || 3) <= 2 || (p.stamina || 3) <= 2 || (p.pain || 3) >= 4;

  const base = r.lengthKm || 6;

  const A = {
    title: "Standard-Plan",
    summary: `Volle Route (~${fmt.km(base)} km). Fokus: gleichmäßig, Pausen eingeplant.`
  };
  const B = {
    title: lowEnergy ? "Kürzer & sanfter" : "Mehr Puffer",
    summary: lowEnergy
      ? `Teilstrecke (~${fmt.km(base * 0.65)} km) mit früherem Umkehr-Punkt.`
      : `Gleiche Strecke, aber mehr Pausen + konservativer Zeitpuffer.`
  };
  const C = {
    title: safetyBias ? "Sicherheits-Variante" : "Exit-orientiert",
    summary: safetyBias
      ? `Nur Start-Abschnitt (~${fmt.km(base * 0.45)} km) + klare Abbruchpunkte.`
      : `Route mit Fokus auf nahe Exit-Optionen & schnelle Rückzugspunkte.`
  };

  state.chat.plans = { A, B, C };
  state.chat.activePlanKey = "A";
  saveState();

  chatPush("bot", "Hier sind deine Pläne (Beta). Du kannst jeden Plan visualisieren:");
  ["A","B","C"].forEach(k => chatPush("bot", { type:"card", cardType:"plan", data:{ key:k, plan: state.chat.plans[k] } }));
  state.chat.step = "after_route";
  saveState();
}

// ---- Packlist ----
function showPacklist() {
  const r = state.chat.selected;
  const w = r?.weather;
  const p = state.chat.profile;
  const items = [];

  items.push("Wasser (mind. 0.5–1L; mehr bei Wärme)");
  items.push("Snack/Traubenzucker (Energie-Backup)");
  items.push("Powerbank + Kabel");
  items.push("Offline-Karte (in SafeTrek: Karte öffnen; Cache)");
  items.push("Schichtprinzip Kleidung");

  if (w && Number(w.tempC) <= 5) items.push("Zusatz: warme Schicht (Fleece/Daune)");
  if (w && Number(w.rainChance) >= 40) items.push("Zusatz: Regenjacke / Poncho");
  if ((p.breakNeed || 3) >= 4) items.push("Zusatz: Sitzunterlage / Mini-Pausenset");
  if ((p.pain || 3) >= 4) items.push("Zusatz: Stöcke / Bandage / eigenes Schmerz-Management");

  chatPush("bot", "Packliste (personalisiert):\n• " + items.join("\n• "));
}

// ---- Assisted Exit / SOS ----
function showExitsInChat() {
  const exits = state.chat.exits || [];
  if (!exits.length) {
    chatPush("bot","Ich habe für diese Route gerade keine nahen Exit-Punkte gefunden (Beta). Du kannst trotzdem „Ich schaffe es nicht weiter“ drücken.");
    return;
  }
  chatPush("bot","Assisted Exit Optionen (Beta). Tippe eine an, um sie auf der Karte zu sehen:");
  exits.slice(0, 6).forEach(x => chatPush("bot", { type:"card", cardType:"exit", data:{ exit:x } }));
}

function triggerSOS() {
  // Not emergency. Provide structured steps and show exits.
  chatPush("bot",
`🆘 Rückzug-Assistent (kein Notruf, kein Ersatz für Bergrettung)

1) Stoppen + atmen + trinken (2 Minuten)
2) Standort prüfen (Karte öffnen)
3) Wähle eine Exit-Option (Bus, Parkplatz, Station) – ich zeige dir die nächsten.
4) Wenn akute Gefahr/Verletzung: nutze lokale Notrufnummern / Bergrettung.

Soll ich dir jetzt die nächsten Exit-Optionen anzeigen?`);
  setQuickReplies(["Ja, Exit anzeigen", "Karte öffnen", "Pläne", "Packliste"]);

  // Auto show exits if available
  if (state.chat.exits?.length) {
    showExitsInChat();
  } else {
    chatPush("bot","Ich habe gerade keine Exit-POIs gefunden. Öffne die Karte, zoom raus, suche Straßen/Parkplätze/Orte.");
  }
}

// ---- MAP ----
let map = null;
let tile = null;
let activeLine = null;
let planLine = null;
let exitMarkers = [];
let highlightMarker = null;

function ensureMap() {
  if (map) return;

  map = L.map("map", { zoomControl: true, preferCanvas: true });
  // tile fallback list
  const tiles = [
    { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attr: "© OpenStreetMap" },
    { url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", attr: "© CARTO" },
    { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", attr: "© OpenTopoMap" }
  ];
  let tileIndex = 0;

  function setTile(i){
    if (tile) tile.remove();
    tileIndex = i;
    tile = L.tileLayer(tiles[i].url, { maxZoom: 18, attribution: tiles[i].attr });
    tile.on("tileerror", () => {
      if (tileIndex < tiles.length - 1) setTile(tileIndex + 1);
    });
    tile.addTo(map);
  }
  setTile(0);

  map.setView([48.137154, 11.576124], 11); // Munich default
}

function mapInvalidateSafe() {
  if (!map) return;
  try { map.invalidateSize(true); } catch(e){}
}

function drawRoute(coords, style) {
  if (!map) ensureMap();
  if (activeLine) { activeLine.remove(); activeLine = null; }
  if (!coords?.length) return;
  activeLine = L.polyline(coords.map(c => [c[0], c[1]]), style || { color:"#4ea1ff", weight:5, opacity:.95 }).addTo(map);
  drawExitsOnMap();
}

function fitToCoords(coords) {
  if (!coords?.length || !map) return;
  const latlngs = coords.map(c => [c[0], c[1]]);
  const bounds = L.latLngBounds(latlngs);
  map.fitBounds(bounds.pad(0.15));
}

function recenterToSelected() {
  const r = state.chat.selected || state.chat.preview;
  if (r?.coords?.length) fitToCoords(r.coords);
}

function drawSelectedRouteAndPlan() {
  const r = state.chat.selected;
  if (!r?.coords?.length) return;
  drawRoute(r.coords);

  // plan overlay: just shorten polyline by ratio for B/C
  if (planLine) { planLine.remove(); planLine = null; }
  const key = state.chat.activePlanKey || "A";
  const ratio = key === "A" ? 1 : (key === "B" ? 0.65 : 0.45);
  const cut = Math.max(2, Math.floor(r.coords.length * ratio));
  const sub = r.coords.slice(0, cut);

  planLine = L.polyline(sub.map(c => [c[0], c[1]]), { color:"#32d583", weight:6, opacity:.85 }).addTo(map);

  fitToCoords(r.coords);

  drawExitsOnMap();
}

function drawExitsOnMap() {
  if (!map) return;

  // clear old
  exitMarkers.forEach(m => m.remove());
  exitMarkers = [];
  if (highlightMarker) { highlightMarker.remove(); highlightMarker = null; }

  const exits = state.chat.exits || [];
  exits.slice(0, 10).forEach(x => {
    const m = L.circleMarker([x.lat, x.lon], { radius:7, color:"#ffcc00", weight:2, fillColor:"#ffcc00", fillOpacity:.8 })
      .addTo(map)
      .bindPopup(`<b>${escapeHtml(x.kind)}</b><br>${escapeHtml(x.name || "")}<br>~${fmt.m(x.distToRouteM)} m von der Route`);
    exitMarkers.push(m);
  });

  if (state.chat.highlightExit) {
    const x = state.chat.highlightExit;
    highlightMarker = L.marker([x.lat, x.lon]).addTo(map).bindPopup(`⭐ ${escapeHtml(x.kind)}: ${escapeHtml(x.name||"")}`).openPopup();
  }
}

// When entering route view, ensure route drawn
function onRouteViewOpen() {
  const r = state.chat.selected || state.chat.preview;
  if (!r?.coords?.length) return;
  ensureMap();
  drawRoute(r.coords);
  drawSelectedRouteAndPlan();
  mapInvalidateSafe();
}

// hook view changes
const _showView = showView;
showView = function(name){
  _showView(name);
  if (name === "route") onRouteViewOpen();
};
window.showView = showView;

// ---- ROUTE SEARCH: Nominatim + Overpass ----
async function geocodeRegion(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept":"application/json" } });
  const data = await res.json();
  if (!data?.length) return null;
  return { lat: Number(data[0].lat), lon: Number(data[0].lon), label: data[0].display_name };
}

// Find hiking routes (relations) near point
async function findHikingRoutes(lat, lon, radiusKm) {
  const radiusM = Math.round(radiusKm * 1000);
  const q = `
[out:json][timeout:25];
(
  relation(around:${radiusM},${lat},${lon})["route"="hiking"];
  relation(around:${radiusM},${lat},${lon})["route"="foot"];
);
out tags 40;
`;
  const data = await overpass(q);
  const rels = (data.elements || []).filter(e => e.type === "relation");

  // Normalize, rank by name existence
  const out = rels.map(r => ({
    id: r.id,
    type: "relation",
    name: r.tags?.name || r.tags?.ref || "Unbenannte Route",
    network: r.tags?.network || "",
    regionLabel: `Nähe ${state.chat.region || ""}`,
    tags: r.tags || {}
  }));

  // de-duplicate by name+id
  const seen = new Set();
  const uniq = [];
  for (const r of out) {
    const key = `${r.id}-${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }

  // sort: named first
  uniq.sort((a,b) => (b.name !== "Unbenannte Route") - (a.name !== "Unbenannte Route"));
  return uniq.slice(0, 12);
}

async function loadRouteGeometry(pick) {
  // Overpass relation geometry (members)
  const q = `
[out:json][timeout:25];
relation(${pick.id});
(._; >;);
out geom;
`;
  const data = await overpass(q);

  // Collect ways with geometry
  const ways = (data.elements || []).filter(e => e.type === "way" && Array.isArray(e.geometry));
  const coords = [];
  ways.forEach(w => {
    w.geometry.forEach(g => coords.push([g.lat, g.lon]));
  });

  // fallback: if no geometry, fail
  if (coords.length < 2) throw new Error("No geometry");

  const lengthKm = polylineDistanceKm(coords);

  return {
    id: pick.id,
    name: pick.name,
    regionLabel: pick.regionLabel,
    coords,
    lengthKm
  };
}

// Overpass POST (fast + less URL length issues)
async function overpass(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];
  let lastErr = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: query
      });
      if (!res.ok) throw new Error("Overpass HTTP " + res.status);
      return await res.json();
    } catch(e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass failed");
}

// ---- WEATHER: Open-Meteo ----
async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m&hourly=precipitation_probability&forecast_days=1`;
  const res = await fetch(url, { headers: { "Accept":"application/json" } });
  const d = await res.json();

  const tempC = d?.current?.temperature_2m;
  const windKmh = d?.current?.wind_speed_10m;

  // take next hour probability
  let rainChance = null;
  if (d?.hourly?.precipitation_probability?.length) rainChance = d.hourly.precipitation_probability[0];

  return { tempC, windKmh, rainChance };
}

// ---- Assisted Exit POIs near route ----
async function fetchExitPOIsNearRoute(route) {
  // sample points along route to find nearby POIs
  const sample = samplePolyline(route.coords, 10);
  const aroundM = 350; // within 350m of sampled points

  // build overpass union query for POIs
  const parts = sample.map(([lat,lon]) => `
  (
    node(around:${aroundM},${lat},${lon})["highway"="bus_stop"];
    node(around:${aroundM},${lat},${lon})["railway"="station"];
    node(around:${aroundM},${lat},${lon})["amenity"="parking"];
    node(around:${aroundM},${lat},${lon})["amenity"="bus_station"];
    node(around:${aroundM},${lat},${lon})["tourism"="information"];
  );
  `).join("\n");

  const q = `
[out:json][timeout:25];
${parts}
out tags center 80;
`;
  const data = await overpass(q);
  const nodes = (data.elements || []).filter(e => e.type === "node");

  // map to exits
  const exits = nodes.map(n => {
    const kind =
      (n.tags?.railway === "station") ? "Bahnhof/Station" :
      (n.tags?.amenity === "parking") ? "Parkplatz" :
      (n.tags?.highway === "bus_stop") ? "Bushaltestelle" :
      (n.tags?.amenity === "bus_station") ? "Busbahnhof" :
      (n.tags?.tourism === "information") ? "Info-Punkt" :
      "Exit";

    const name = n.tags?.name || n.tags?.ref || "";
    const lat = n.lat;
    const lon = n.lon;

    const distToRouteM = distancePointToPolylineM([lat,lon], route.coords);

    return { kind, name, lat, lon, distToRouteM };
  });

  // sort by distance to route
  exits.sort((a,b) => a.distToRouteM - b.distToRouteM);

  // keep unique close ones
  const uniq = [];
  const seen = new Set();
  for (const x of exits) {
    const key = `${x.kind}-${x.name}-${x.lat.toFixed(5)}-${x.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(x);
    if (uniq.length >= 10) break;
  }
  return uniq;
}

// ---- Geometry helpers ----
function polylineDistanceKm(coords) {
  let km = 0;
  for (let i=1; i<coords.length; i++) km += haversineKm(coords[i-1], coords[i]);
  return km;
}
function haversineKm(a,b){
  const R = 6371;
  const dLat = (b[0]-a[0]) * Math.PI/180;
  const dLon = (b[1]-a[1]) * Math.PI/180;
  const lat1 = a[0]*Math.PI/180;
  const lat2 = b[0]*Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}

function samplePolyline(coords, count) {
  if (!coords?.length) return [];
  const step = Math.max(1, Math.floor(coords.length / count));
  const out = [];
  for (let i=0; i<coords.length; i+=step) out.push(coords[i]);
  if (out[out.length-1] !== coords[coords.length-1]) out.push(coords[coords.length-1]);
  return out.slice(0, count);
}

// approximate distance point->polyline using nearest segment endpoints (fast beta)
function distancePointToPolylineM(pt, coords) {
  let best = Infinity;
  for (let i=1; i<coords.length; i+=5) { // stride for speed
    const a = coords[i-1], b = coords[i];
    best = Math.min(best, haversineKm(pt, a)*1000, haversineKm(pt, b)*1000);
  }
  return best === Infinity ? null : best;
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}