/* =========================
   SafeTrek – app.js (Full rewrite w/ fixes)
   - Route cards persist
   - Route Summary card
   - Plan A/B/C cards + buttons
   - SOS button (always available in chat)
   - Smart back navigation from route view
   ========================= */

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);

const chatEl = $("#chatMessages") || $("#chat") || $("#chatEl");        // one of these must exist
const quickRepliesEl = $("#quickReplies") || $("#quickRepliesEl");
const chatInputEl = $("#chatInput") || $("#inputChat") || $("#chatText");
const chatSendBtn = $("#chatSend") || $("#btnSend") || $("#sendBtn");

// Optional UI buttons (if present)
const btnOpenChat = $("#btnOpenChat") || $("#openChat");
const btnBackToDash = $("#btnBackToDash") || $("#btnBackRoute") || $("#routeBack");

// ---------- State ----------
const defaultState = {
  view: "dash",

  selectedRegion: "",
  radiusKm: 20,

  selectedRoute: null,   // loaded route with geometry (coords)
  weather: null,         // {tempC, windKmh, rainChance, ...}
  exits: [],             // [{kind, name, lat, lon, distToRouteM}, ...]

  plans: null,           // computed plans A/B/C
  activePlan: null,      // "Plan A" | "Plan B" | "Plan C"

  chat: {
    step: "idle",
    history: [],

    // user profile
    profile: {
      stamina: null,     // 1-5
      breakNeed: null,   // 1-5
      safety: null,      // 2-5
      energy: null,      // 1-5
      pain: null,        // 1-5
      anxiety: null      // 1-5
    },

    // chat routing
    chatRegion: "",
    chatRadiusKm: 20,
    chatCandidates: [] // list of route summaries (id,name,lengthKm,...)
  }
};

let state = loadState() || structuredClone(defaultState);

// ---------- Persistence ----------
function saveState() {
  try {
    localStorage.setItem("safetreks_state", JSON.stringify(state));
  } catch (e) {}
}
function loadState() {
  try {
    const raw = localStorage.getItem("safetreks_state");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// ---------- View helpers ----------
function safeShowView(name) {
  // prefer existing app function if available
  if (typeof showView === "function") return showView(name);

  // fallback: simple view toggling if you used data-view blocks
  const views = document.querySelectorAll("[data-view]");
  views.forEach(v => (v.style.display = v.getAttribute("data-view") === name ? "block" : "none"));
  state.view = name;
  saveState();
}

// ---------- Chat helpers ----------
function nowTime() {
  try {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function chatPush(role, text) {
  state.chat.history.push({ role, text, t: nowTime() });
  saveState();
  renderChat();
}

function resetChat(keepProfile = true) {
  const profile = keepProfile ? structuredClone(state.chat.profile) : structuredClone(defaultState.chat.profile);
  state.chat = structuredClone(defaultState.chat);
  state.chat.profile = profile;
  saveState();
}

// ---------- SOS (always visible in chat) ----------
function ensureSOSButton() {
  if ($("#sosBtn")) return;

  const btn = document.createElement("button");
  btn.id = "sosBtn";
  btn.type = "button";
  btn.textContent = "🆘 Ich schaffe es nicht weiter";
  btn.style.position = "fixed";
  btn.style.left = "12px";
  btn.style.right = "12px";
  btn.style.bottom = "14px";
  btn.style.zIndex = "9999";
  btn.style.padding = "12px 14px";
  btn.style.borderRadius = "14px";
  btn.style.border = "1px solid #333";
  btn.style.background = "#b00020";
  btn.style.color = "white";
  btn.style.fontWeight = "800";
  btn.style.display = "none";

  btn.onclick = () => handleSOS();

  document.body.appendChild(btn);
}

function setSOSVisible(visible) {
  const btn = $("#sosBtn");
  if (!btn) return;
  btn.style.display = visible ? "block" : "none";
}

function handleSOS() {
  // This is NOT a rescue service. Provide structured safe steps + show exits if available.
  chatPush("bot", "🆘 Okay. Ruhig bleiben. Wir planen jetzt einen sicheren Rückzug (kein Notruf).");

  // Suggest immediate steps
  chatPush("bot",
    "1) Stoppe kurz, trink einen Schluck, atme 30 Sekunden ruhig.\n" +
    "2) Prüfe: Schwindel, starke Schmerzen, Orientierung? Wenn JA → Notruf 112.\n" +
    "3) Wenn NEIN: Wir wählen jetzt den einfachsten Exit."
  );

  if (state.exits && state.exits.length) {
    const top = state.exits[0];
    chatPush("bot", `Nächster Exit: ${top.kind || "Exit"} • ${top.name || "Unbenannt"} (~${top.distToRouteM ?? "?"} m von der Route).`);
    chatPush("bot", "Tippe: „Karte öffnen“, dann zoome ich auf den Exit.");
    state.activePlan = "SOS";
    saveState();
  } else {
    chatPush("bot", "Ich finde gerade keine nahen Exit-Punkte. Option: Umkehren entlang des bekannten Wegs (sicherste Variante).");
  }

  // Offer quick actions
  state.chat.step = "after_route";
  saveState();
  renderChat();
}

// ---------- UI Rendering ----------
function renderChat() {
  if (!chatEl) return;

  chatEl.innerHTML = "";

  // Render history (simple bubbles)
  for (const m of state.chat.history) {
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
  }

  // ✅ Rebuild route candidate cards (pick_route)
  if (
    state.chat.step === "pick_route" &&
    Array.isArray(state.chat.chatCandidates) &&
    state.chat.chatCandidates.length
  ) {
    state.chat.chatCandidates.slice(0, 10).forEach((route, index) => {
      const row = document.createElement("div");
      row.className = "msg bot";
      const wrap = document.createElement("div");
      wrap.appendChild(chatRouteCard(route, index));
      row.appendChild(wrap);
      chatEl.appendChild(row);
    });
  }

  // ✅ Rebuild route summary (after_route)
  if (state.chat.step === "after_route" && state.selectedRoute) {
    const row = document.createElement("div");
    row.className = "msg bot";
    const wrap = document.createElement("div");

    const summary = chatRouteSummaryCard();
    if (summary) wrap.appendChild(summary);

    row.appendChild(wrap);
    chatEl.appendChild(row);
  }

  // ✅ Rebuild plan cards (after_plans)
  if (state.chat.step === "after_plans" && state.plans && Array.isArray(state.plans.plans)) {
    const row = document.createElement("div");
    row.className = "msg bot";
    const wrap = document.createElement("div");

    const head = document.createElement("div");
    head.className = "summary-card";
    head.innerHTML =
      `<div class="summary-card__title">🧭 Deine Pläne</div>
       <div style="font-size:13px;color:#b5b5b5;margin-top:6px;">${state.plans.guidance || ""}</div>`;
    wrap.appendChild(head);

    state.plans.plans.forEach((p, i) => wrap.appendChild(chatPlanCard(p, i)));

    row.appendChild(wrap);
    chatEl.appendChild(row);
  }

  // Scroll + quick replies
  window.requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  renderQuickReplies();

  // SOS visible only when in chat view and route exists OR user is mid-flow
  const inChat = (state.view === "chat");
  setSOSVisible(inChat && (state.selectedRoute || state.chat.step !== "idle"));
}

function renderQuickReplies() {
  if (!quickRepliesEl) return;
  quickRepliesEl.innerHTML = "";

  const s = state.chat.step;

  const add = (t) => {
    const b = document.createElement("button");
    b.className = "qbtn";
    b.type = "button";
    b.textContent = t;
    b.onclick = () => handleChatInput(t);
    quickRepliesEl.appendChild(b);
  };

  // Profile steps
  if (s === "ask_stamina") ["1","2","3","4","5"].forEach(add);
  else if (s === "ask_breakNeed") ["1","2","3","4","5"].forEach(add);
  else if (s === "ask_safety") ["2","3","4","5"].forEach(add);
  else if (s === "ask_energy") ["1","2","3","4","5"].forEach(add);
  else if (s === "ask_pain") ["1","2","3","4","5"].forEach(add);
  else if (s === "ask_anxiety") ["1","2","3","4","5"].forEach(add);

  // Region / routing
  else if (s === "ask_want_routes") ["Ja, Touren vorschlagen", "Nein"].forEach(add);
  else if (s === "ask_region") ["München", "Salzburg", "Innsbruck"].forEach(add);
  else if (s === "ask_radius") ["10","20","30","50"].forEach(add);

  // After route
  else if (s === "after_route") ["Pläne berechnen", "Karte öffnen", "Assisted Exit", "Packliste"].forEach(add);

  // After plans
  else if (s === "after_plans") ["Karte öffnen", "Assisted Exit", "Packliste"].forEach(add);
}

// ---------- Cards ----------
function chatRouteCard(route, index) {
  const card = document.createElement("div");
  card.className = "chat-card";

  const title = document.createElement("div");
  title.className = "chat-card__title";
  title.textContent = `🌲 ${route.name || "Route"}`;

  const meta = document.createElement("div");
  meta.className = "chat-card__meta";
  meta.textContent = `~${route.lengthKm ?? "?"} km • Quelle: OpenStreetMap`;

  const actions = document.createElement("div");
  actions.className = "chat-card__actions";

  const btnView = document.createElement("button");
  btnView.className = "secondary";
  btnView.textContent = "Route ansehen";
  btnView.onclick = () => {
    if (typeof openRouteById === "function") {
      openRouteById(route.id);
      state._cameFromChat = true;
      saveState();
      safeShowView("route");
    } else {
      chatPush("bot", "Ich kann die Karte gerade nicht öffnen (openRouteById fehlt).");
    }
  };

  const btnSelect = document.createElement("button");
  btnSelect.textContent = "Diese Route wählen";
  btnSelect.onclick = () => chatLoadRouteByIndex(index);

  actions.appendChild(btnView);
  actions.appendChild(btnSelect);

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(actions);

  return card;
}

function chatRouteSummaryCard() {
  const route = state.selectedRoute;
  if (!route) return null;

  const w = state.weather;
  const exits = Array.isArray(state.exits) ? state.exits : [];

  const card = document.createElement("div");
  card.className = "summary-card";

  const title = document.createElement("div");
  title.className = "summary-card__title";
  title.textContent = `✅ Ausgewählt: ${route.name || "Route"}`;

  const grid = document.createElement("div");
  grid.className = "summary-grid";

  const pill = (label, value) => {
    const p = document.createElement("div");
    p.className = "summary-pill";
    p.innerHTML = `<strong>${label}</strong>${value}`;
    return p;
  };

  grid.appendChild(pill("Distanz", `~${route.lengthKm ?? "?"} km`));
  grid.appendChild(pill("Region", `${state.selectedRegion || state.chat.chatRegion || "—"} · Radius ${state.radiusKm || state.chat.chatRadiusKm || "—"} km`));
  grid.appendChild(pill("Wetter", w ? `${w.tempC ?? "?"}°C · Wind ${w.windKmh ?? "?"} km/h · Regen ~${w.rainChance ?? "?"}%` : "nicht verfügbar"));
  grid.appendChild(pill("Assisted Exit", exits.length ? `${exits.length} Optionen (nächster ~${exits[0].distToRouteM ?? "?"} m)` : "keine nahen Exits gefunden"));

  const actions = document.createElement("div");
  actions.className = "summary-actions";

  const btnPlans = document.createElement("button");
  btnPlans.textContent = "Pläne berechnen";
  btnPlans.onclick = () => handleChatInput("Pläne berechnen");

  const btnMap = document.createElement("button");
  btnMap.className = "secondary";
  btnMap.textContent = "Karte öffnen";
  btnMap.onclick = () => handleChatInput("Karte öffnen");

  actions.appendChild(btnPlans);
  actions.appendChild(btnMap);

  card.appendChild(title);
  card.appendChild(grid);
  card.appendChild(actions);

  return card;
}

function chatPlanCard(plan, idx) {
  const card = document.createElement("div");
  card.className = "plan-card";

  const top = document.createElement("div");
  top.className = "plan-card__top";

  const left = document.createElement("div");
  const label = document.createElement("div");
  label.className = "plan-card__label";
  label.textContent = plan.label;

  const small = document.createElement("div");
  small.className = "plan-card__small";
  small.textContent = plan.subtitle || "";

  left.appendChild(label);
  left.appendChild(small);

  const right = document.createElement("div");
  right.className = "plan-card__small";
  right.textContent = `~${plan.distanceKm} km · ${plan.durationMin} min`;

  top.appendChild(left);
  top.appendChild(right);

  const meta = document.createElement("div");
  meta.className = "plan-card__meta";
  meta.innerHTML = `
    <div><strong>Umkehr-Check</strong><br>${plan.turnback || "—"}</div>
    <div><strong>Sicherheitsregel</strong><br>${plan.rule || "—"}</div>
  `;

  const actions = document.createElement("div");
  actions.className = "plan-card__actions";

  const btnViz = document.createElement("button");
  btnViz.className = "secondary";
  btnViz.textContent = "Visualisieren";
  btnViz.onclick = () => {
    state.activePlan = plan.label;
    saveState();
    // If you have map route view, open it
    if (typeof openRouteById === "function" && state.selectedRoute?.id) {
      openRouteById(state.selectedRoute.id);
      state._cameFromChat = true;
      saveState();
      safeShowView("route");
      chatPush("bot", `🗺️ ${plan.label} wird auf der Karte hervorgehoben (als nächster Ausbau markieren wir Umkehrpunkt + Exit).`);
    } else {
      chatPush("bot", `🗺️ ${plan.label}: Karte kann gerade nicht geöffnet werden.`);
    }
  };

  const btnUse = document.createElement("button");
  btnUse.textContent = "Diesen Plan nutzen";
  btnUse.onclick = () => {
    state.activePlan = plan.label;
    saveState();
    chatPush("bot", `✅ ${plan.label} aktiv. Ich passe Assisted Exit & Packliste daran an.`);
    state.chat.step = "after_plans";
    saveState();
    renderChat();
  };

  actions.appendChild(btnViz);
  actions.appendChild(btnUse);

  card.appendChild(top);
  card.appendChild(meta);
  card.appendChild(actions);

  return card;
}

// ---------- Core chat flow ----------
function startChat() {
  safeShowView("chat");
  state.view = "chat";
  saveState();

  ensureSOSButton();

  if (!state.chat.history.length) {
    chatPush("bot", "Hi! Ich bin SafeTrek. Lass uns kurz deine heutige Situation einschätzen.");
    state.chat.step = "ask_stamina";
    saveState();
    chatPush("bot", "Wie hoch ist deine Belastbarkeit heute? (1–5)");
    return;
  }

  renderChat();
}

function handleChatInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return;

  // Store user message
  chatPush("user", text);

  const s = state.chat.step;
  const low = text.toLowerCase();

  // Global commands
  if (low.includes("dashboard")) { safeShowView("dash"); state.view="dash"; saveState(); return; }
  if (low.includes("neue planung")) { resetChat(true); startChat(); return; }
  if (low.includes("hilfe")) { chatPush("bot", "Du kannst jederzeit „Pläne berechnen“, „Karte öffnen“ oder 🆘 drücken."); return; }

  // Profile steps
  if (s === "ask_stamina") {
    const n = Number(text);
    if (!(n >= 1 && n <= 5)) return chatPush("bot", "Bitte 1–5.");
    state.chat.profile.stamina = n;
    state.chat.step = "ask_breakNeed";
    saveState();
    return chatPush("bot", "Wie hoch ist dein Pausenbedarf? (1–5)");
  }

  if (s === "ask_breakNeed") {
    const n = Number(text);
    if (!(n >= 1 && n <= 5)) return chatPush("bot", "Bitte 1–5.");
    state.chat.profile.breakNeed = n;
    state.chat.step = "ask_safety";
    saveState();
    return chatPush("bot", "Wie wichtig ist dir Sicherheit/Puffer? (2–5)");
  }

  if (s === "ask_safety") {
    const n = Number(text);
    if (!(n >= 2 && n <= 5)) return chatPush("bot", "Bitte 2–5.");
    state.chat.profile.safety = n;
    state.chat.step = "ask_energy";
    saveState();
    return chatPush("bot", "Wie ist dein Energielevel? (1–5)");
  }

  if (s === "ask_energy") {
    const n = Number(text);
    if (!(n >= 1 && n <= 5)) return chatPush("bot", "Bitte 1–5.");
    state.chat.profile.energy = n;
    state.chat.step = "ask_pain";
    saveState();
    return chatPush("bot", "Wie stark sind Schmerzen/Unwohlsein? (1–5)");
  }

  if (s === "ask_pain") {
    const n = Number(text);
    if (!(n >= 1 && n <= 5)) return chatPush("bot", "Bitte 1–5.");
    state.chat.profile.pain = n;
    state.chat.step = "ask_anxiety";
    saveState();
    return chatPush("bot", "Wie hoch ist mentale Überforderung/Anspannung? (1–5)");
  }

  if (s === "ask_anxiety") {
    const n = Number(text);
    if (!(n >= 1 && n <= 5)) return chatPush("bot", "Bitte 1–5.");
    state.chat.profile.anxiety = n;
    state.chat.step = "ask_want_routes";
    saveState();
    return chatPush("bot", "Möchtest du Tourenvorschläge? (Ja/Nein)");
  }

  // Want routes?
  if (s === "ask_want_routes") {
    if (low.startsWith("n")) {
      state.chat.step = "idle";
      saveState();
      return chatPush("bot", "Alles klar. Wenn du willst: sag „Touren vorschlagen“.");
    }
    state.chat.step = "ask_region";
    saveState();
    return chatPush("bot", "In welcher Region sollen Touren gesucht werden? (z.B. München / Salzburg / Innsbruck)");
  }

  if (s === "ask_region") {
    state.chat.chatRegion = text;
    state.chat.step = "ask_radius";
    saveState();
    return chatPush("bot", "Wie groß soll der Suchradius sein? (10/20/30/50 km)");
  }

  if (s === "ask_radius") {
    const n = Number(text);
    if (!(n >= 5 && n <= 200)) return chatPush("bot", "Bitte eine Zahl, z.B. 20.");
    state.chat.chatRadiusKm = n;
    saveState();
    return findRoutesForChat();
  }

  // After route / after plans commands
  if (low.includes("karte öffnen")) {
    if (state.selectedRoute?.id && typeof openRouteById === "function") {
      state._cameFromChat = true;
      saveState();
      openRouteById(state.selectedRoute.id);
      safeShowView("route");
      return;
    }
    return chatPush("bot", "Ich habe noch keine Route geladen.");
  }

  if (low.includes("assisted exit")) {
    if (state.exits?.length) {
      const list = state.exits.slice(0, 5).map((e, i) => `• ${e.kind || "Exit"}: ${e.name || "Unbenannt"} (~${e.distToRouteM ?? "?"} m)`).join("\n");
      return chatPush("bot", `Hier sind Exit-Optionen (Top 5):\n${list}`);
    }
    return chatPush("bot", "Ich habe gerade keine Exit-Punkte gefunden.");
  }

  if (low.includes("packliste")) {
    return chatPush("bot",
      "📦 Packliste (personalisiert – MVP):\n" +
      "• Wasser + Snack\n" +
      "• Extra Layer (Wind/Temperatur)\n" +
      "• Powerbank\n" +
      "• Offline-Karte / geladenes Handy\n" +
      "• Mini-Notfallset\n" +
      "Wenn du willst: ich passe sie genauer ans Wetter & deine Werte an."
    );
  }

  if (low.includes("pläne") || low.includes("plaene")) {
    if (!state.selectedRoute) return chatPush("bot", "Bitte erst eine Route auswählen.");
    state.plans = computePlans();
    state.chat.step = "after_plans";
    saveState();
    renderChat();
    return;
  }

  // If user types "Touren vorschlagen" anytime
  if (low.includes("touren")) {
    state.chat.step = "ask_region";
    saveState();
    return chatPush("bot", "Welche Region? (z.B. München / Salzburg / Innsbruck)");
  }

  // If stuck
  chatPush("bot", "Ich habe dich. Du kannst „Pläne berechnen“, „Karte öffnen“ oder 🆘 drücken.");
}

// ---------- Route search ----------
async function findRoutesForChat() {
  const region = state.chat.chatRegion;
  const radius = state.chat.chatRadiusKm;

  chatPush("bot", `Okay. Ich suche Touren in „${region}“ (Radius ${radius} km)…`);

  try {
    // Use your existing route search if available
    let candidates = [];
    if (typeof searchRoutesInRegion === "function") {
      candidates = await searchRoutesInRegion(region, radius);
    } else {
      // fallback: no search function
      candidates = [];
    }

    if (!candidates || !candidates.length) {
      state.chat.step = "ask_region";
      saveState();
      return chatPush("bot", "Ich habe gerade keine Touren gefunden. Andere Region versuchen?");
    }

    state.chat.chatCandidates = candidates.slice(0, 10);
    state.chat.step = "pick_route";
    saveState();

    chatPush("bot", "Ich habe passende Touren gefunden. Wähle eine Route aus den Karten:");
    renderChat();
  } catch (e) {
    state.chat.step = "ask_region";
    saveState();
    chatPush("bot", "Die Routensuche ist gerade langsam (OpenStreetMap/Overpass). Versuch’s bitte nochmal.");
  }
}

async function chatLoadRouteByIndex(idx) {
  const pick = state.chat.chatCandidates[idx];
  if (!pick) return chatPush("bot", "Bitte wähle eine gültige Nummer.");

  chatPush("bot", "Lade Route, Wetter und Assisted Exit…");

  try {
    // route geometry
    const route = typeof loadWayGeometry === "function"
      ? await loadWayGeometry(pick.id)
      : pick;

    state.selectedRoute = route;

    // weather/exits near first coord (if available)
    if (route?.coords?.length) {
      const [lat, lon] = route.coords[0];
      try { state.weather = (typeof fetchWeather === "function") ? await fetchWeather(lat, lon) : null; } catch { state.weather = null; }
      try { state.exits = (typeof fetchExitPOIsNearRoute === "function") ? await fetchExitPOIsNearRoute(route) : []; } catch { state.exits = []; }
    } else {
      state.weather = null;
      state.exits = [];
    }

    // sync to dashboard prefs
    state.selectedRegion = state.chat.chatRegion || state.selectedRegion;
    state.radiusKm = state.chat.chatRadiusKm || state.radiusKm;

    state.plans = null;
    state.activePlan = null;

    state.chat.step = "after_route";
    saveState();

    safeShowView("chat");
    state.view = "chat";
    saveState();

    // IMPORTANT: don't text-spam – summary will be rebuilt in renderChat()
    renderChat();
    return;

  } catch (e) {
    chatPush("bot", "Diese Route konnte ich nicht sauber laden. Bitte wähle eine andere.");
    state.chat.step = "pick_route";
    saveState();
  }
}

// ---------- Plan computation ----------
function computePlans() {
  const route = state.selectedRoute;
  const p = state.chat.profile;

  const baseKm = Number(route.lengthKm || 6);
  const safety = Number(p.safety || 3);
  const stamina = Number(p.stamina || 3);
  const breakNeed = Number(p.breakNeed || 3);
  const energy = Number(p.energy || 3);
  const pain = Number(p.pain || 2);
  const anxiety = Number(p.anxiety || 2);

  // crude “load” score: higher => need more conservative
  const load =
    (6 - stamina) * 1.1 +
    breakNeed * 0.7 +
    safety * 0.8 +
    pain * 0.9 +
    anxiety * 0.8 +
    (6 - energy) * 0.8;

  // durations (rough)
  const baseMin = Math.round(baseKm * 14); // 14 min/km as simple heuristic

  // Plan A: shorten distance & add buffer
  const aKm = Math.max(2, Math.round((baseKm * (0.65 + (safety * 0.04))) * 10) / 10);
  const aMin = Math.round(baseMin * 1.15 + load * 8);

  // Plan B: near original with buffer
  const bKm = Math.max(2, Math.round((baseKm * (0.85 + (stamina * 0.03))) * 10) / 10);
  const bMin = Math.round(baseMin * 1.05 + load * 6);

  // Plan C: only if stable
  const cKm = Math.max(2, Math.round((baseKm * (1.0 + (stamina - safety) * 0.03)) * 10) / 10);
  const cMin = Math.round(baseMin * 1.0 + load * 4);

  const guidance =
    load >= 10 ? "Heute konservativ bleiben. Plan A ist wahrscheinlich am sichersten." :
    load >= 7 ? "Plan A/B wirken passend. Hör auf dein Gefühl – wenn Zweifel, umdrehen." :
    "Du wirkst stabil. Plan B ist solide; Plan C nur wenn du dich unterwegs weiterhin gut fühlst.";

  const plans = [
    {
      label: "Plan A",
      subtitle: "konservativ & sicher",
      distanceKm: aKm,
      durationMin: aMin,
      turnback: "Spätestens bei 35–45% der Strecke (oder erster Unsicherheit)",
      rule: "Wenn irgendwas ‚nicht passt‘ → umkehren",
    },
    {
      label: "Plan B",
      subtitle: "ausgewogen",
      distanceKm: bKm,
      durationMin: bMin,
      turnback: "Bei 50% der Zeit: Wenn müde → Umkehr",
      rule: "Pause alle 30–45 Min + Hydration",
    },
    {
      label: "Plan C",
      subtitle: "nur wenn du stabil bleibst",
      distanceKm: cKm,
      durationMin: cMin,
      turnback: "Wenn Wetter kippt oder Energie sinkt → sofort Plan B/A",
      rule: "Keine Extraloops wenn du Druck spürst",
    }
  ];

  return { guidance, plans };
}

// ---------- Route view back button (smart) ----------
function wireRouteBackButton() {
  if (!btnBackToDash) return;

  btnBackToDash.onclick = () => {
    // if we came from chat → back to chat
    if (state._cameFromChat) {
      state._cameFromChat = false;
      saveState();
      safeShowView("chat");
      state.view = "chat";
      saveState();
      renderChat();
    } else {
      safeShowView("dash");
      state.view = "dash";
      saveState();
    }
  };
}

// ---------- Input wiring ----------
function wireChatInput() {
  if (chatSendBtn && chatInputEl) {
    chatSendBtn.onclick = () => {
      const v = chatInputEl.value;
      chatInputEl.value = "";
      handleChatInput(v);
    };
  }

  if (chatInputEl) {
    chatInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const v = chatInputEl.value;
        chatInputEl.value = "";
        handleChatInput(v);
      }
    });
  }

  if (btnOpenChat) {
    btnOpenChat.onclick = () => startChat();
  }
}

// ---------- Boot ----------
function boot() {
  ensureSOSButton();
  wireChatInput();
  wireRouteBackButton();

  // restore last view
  if (state.view) safeShowView(state.view);
  renderChat();
}

boot();