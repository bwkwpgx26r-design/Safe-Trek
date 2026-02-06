// SafeTrek Beta – Web-App (no build). Chat-Flow + Regel-Engine + lokale Speicherung.
// Kein Notruf. Kein Ersatz für alpine Beratung/Bergrettung.

const chatEl = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const quickRepliesEl = document.getElementById("quickReplies");
const resetBtn = document.getElementById("resetBtn");

const STORAGE_KEY = "safetrek_beta_state_v1";

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// ---------- State ----------
const defaultState = {
  step: "start",
  profile: { stamina: null, breakNeed: null, safety: null },
  daily: { energyToday: null, painToday: null, anxietyToday: null },
  lastPlans: null,
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

    if (m.role === "bot"){
      const wrap = document.createElement("div");
      wrap.appendChild(meta);
      wrap.appendChild(bubble);
      row.appendChild(wrap);
    } else {
      const wrap = document.createElement("div");
      wrap.appendChild(meta);
      wrap.appendChild(bubble);
      row.appendChild(wrap);
    }
    chatEl.appendChild(row);

    // Karten nach bestimmten Bot-Nachrichten
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

  // Autoscroll
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
  // Dynamische Vorschläge je Step
  const s = state.step;
  if (s === "ask_stamina") return ["1","2","3","4","5"];
  if (s === "ask_breakNeed") return ["1","2","3","4","5"];
  if (s === "ask_safety") return ["2","3","4","5"];
  if (s === "ask_energy") return ["1","2","3","4","5"];
  if (s === "ask_pain") return ["1","2","3","4","5"];
  if (s === "ask_anxiety") return ["1","2","3","4","5"];
  if (s === "after_plans") return ["Packliste", "Assisted Exit", "Neue Tagesform", "Profil ändern"];
  if (s === "after_packlist") return ["Zurück zu Plänen", "Assisted Exit", "Neue Tagesform"];
  if (s === "after_exit") return ["Zurück zu Plänen", "Packliste", "Neue Tagesform"];
  return [];
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

// ---------- Cards ----------
function plansCards(result){
  const wrap = document.createElement("div");
  wrap.className = "card";

  const h = document.createElement("h3");
  h.textContent = "Touren-Optionen (Beta)";
  wrap.appendChild(h);

  const p = document.createElement("p");
  p.textContent = `Readiness: ${result.readiness.toFixed(1)} / 5 — ${result.guidance}`;
  wrap.appendChild(p);

  for (const plan of result.plans){
    const box = document.createElement("div");
    box.className = "card";
    const hh = document.createElement("h3");
    hh.textContent = plan.label;
    box.appendChild(hh);

    const pills = document.createElement("div");
    pills.innerHTML = `
      <span class="pill">Distanz: ${plan.distanceKm} km</span>
      <span class="pill">Höhenmeter: ${plan.elevationM} m</span>
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
    weather: { tempC: 12, rainChance: 45, windKmh: 18 } // Platzhalter
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
  const adjHm = Math.round(base.elevationM * intensityMultiplier);

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

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function round(n,d=0){ const p = 10**d; return Math.round(n*p)/p; }

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

function handleUserInput(text){
  const raw = String(text ?? "").trim();
  if (!raw) return;

  pushMsg("user", raw);

  // Routing je Step
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

    // RouteBase ist hier Demo (später: echte Route/Region)
    const routeBase = { distanceKm: 7.5, elevationM: 320, durationMin: 160 };
    const result = generatePlans({ profile: state.profile, daily: state.daily, routeBase });
    state.lastPlans = result;
    state.step = "after_plans";
    saveState();

    pushMsg("bot", "[CARDS:PLANS]");
    return pushMsg("bot", "Was möchtest du als Nächstes? Packliste oder Assisted Exit?");
  }

  // Post Actions
  if (state.step === "after_plans"){
    return handleMenu(raw);
  }
  if (state.step === "after_packlist"){
    return handleMenu(raw);
  }
  if (state.step === "after_exit"){
    return handleMenu(raw);
  }

  // fallback
  pushMsg("bot", "Ich habe das nicht ganz verstanden. Tippe z.B. „Packliste“, „Assisted Exit“, „Neue Tagesform“ oder „Profil ändern“.");
}

function handleMenu(raw){
  const t = raw.toLowerCase();

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
    // Tagesform neu abfragen, Profil behalten
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

  pushMsg("bot", "Optionen: „Packliste“, „Assisted Exit“, „Neue Tagesform“, „Profil ändern“.");
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
