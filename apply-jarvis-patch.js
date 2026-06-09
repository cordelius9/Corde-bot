#!/usr/bin/env node
/**
 * apply-jarvis-patch.js
 *
 * Applies Jarvis Private Memory backend endpoints to dashboard.js.
 * Run once on the tablet: node apply-jarvis-patch.js
 *
 * Adds:
 *   - 5 file constants (data/jarvis_*.json)
 *   - 5 module-level helper functions
 *   - GET /api/jarvis/private-memory
 *   - POST /api/jarvis/check-in
 *   - GET /api/jarvis/memory (only if route not already present)
 *   - initJarvisPrivateMemory() call in boot()
 *
 * Does NOT touch: renderHomePortal, showMod, nav, any module HTML,
 *                 Home/Trading/Health/Jarvis floating UI.
 */

"use strict";
const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const TARGET = path.join(__dirname, "dashboard.js");
const BACKUP = TARGET + ".backup-pre-jarvis-" + Date.now();

if (!fs.existsSync(TARGET)) {
  console.error("ERROR: dashboard.js not found in", __dirname);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

// ── Guard against double-apply ────────────────────────────────────────────────
if (src.includes("JARVIS_PRIVATE_PROFILE_FILE") || src.includes("/api/jarvis/private-memory")) {
  console.log("SKIP: Jarvis Private Memory already present in dashboard.js");
  process.exit(0);
}

// ── Backup ────────────────────────────────────────────────────────────────────
fs.copyFileSync(TARGET, BACKUP);
console.log("Backup created:", path.basename(BACKUP));

// ══════════════════════════════════════════════════════════════════════════════
// PATCH 1 — File constants
// Anchor: const RESEARCH_QUEUE_FILE = "data/research_queue.json";
// ══════════════════════════════════════════════════════════════════════════════
const ANCHOR_CONSTANTS = 'const RESEARCH_QUEUE_FILE = "data/research_queue.json";';
if (!src.includes(ANCHOR_CONSTANTS)) {
  console.error("ERROR: anchor not found — RESEARCH_QUEUE_FILE. Aborting.");
  process.exit(1);
}

const CONSTANTS_BLOCK = `
const JARVIS_PRIVATE_PROFILE_FILE  = "data/jarvis_private_profile.json";
const JARVIS_HEALTH_RULES_FILE     = "data/jarvis_health_rules.json";
const JARVIS_DAILY_QUESTIONS_FILE  = "data/jarvis_daily_questions.json";
const JARVIS_RISK_RULES_FILE       = "data/jarvis_risk_rules.json";
const JARVIS_CHECKINS_FILE         = "data/jarvis_checkins.json";`;

src = src.replace(ANCHOR_CONSTANTS, ANCHOR_CONSTANTS + CONSTANTS_BLOCK);
console.log("PATCH 1 applied: Jarvis file constants");

// ══════════════════════════════════════════════════════════════════════════════
// PATCH 2 — Helper functions at MODULE LEVEL
// Anchor: const server = http.createServer(
// (insert functions just before server is created)
// ══════════════════════════════════════════════════════════════════════════════
const ANCHOR_SERVER = "const server = http.createServer(";
if (!src.includes(ANCHOR_SERVER)) {
  console.error("ERROR: anchor not found — http.createServer. Aborting.");
  process.exit(1);
}

const HELPER_FUNCTIONS = `
// ── JARVIS PRIVATE MEMORY — module-level helpers ──────────────────────────────

const _JARVIS_DEFAULT_HEALTH_RULES = [
  { id:"R1",  active:true, rule:"Si consumo cannabis/alcohol, NO operar ese día ni el siguiente." },
  { id:"R2",  active:true, rule:"Si recovery WHOOP < 40%, modo DESCANSO: solo observar, no decidir." },
  { id:"R3",  active:true, rule:"Si sleep score < 60%, postergar decisiones importantes hasta dormir." },
  { id:"R4",  active:true, rule:"Si strain > 15 (WHOOP), reducir carga cognitiva: menos análisis, más ejecución simple." },
  { id:"R5",  active:true, rule:"Si energía subjetiva <= 4/10, activar modo CONSERVADOR automáticamente." },
  { id:"R6",  active:true, rule:"No revisar portfolio más de 3 veces al día en modo REGULACIÓN." },
  { id:"R7",  active:true, rule:"Antes de cualquier decisión de trading, registrar estado físico y emocional." },
  { id:"R8",  active:true, rule:"Si mood es ansioso/reactivo, esperar 30 min antes de ejecutar cualquier acción." },
  { id:"R9",  active:true, rule:"Tomar nota del patrón: ¿en qué estado físico tomo mejores decisiones?" },
  { id:"R10", active:true, rule:"Celebrar disciplina (seguir reglas) con la misma energía que los resultados." }
];

const _JARVIS_DEFAULT_DAILY_QUESTIONS = [
  { id:"Q1", question:"¿Cómo amaneciste hoy? (energía 1-10, calidad del sueño)" },
  { id:"Q2", question:"¿Consumiste cannabis o alcohol en las últimas 24h?" },
  { id:"Q3", question:"¿Tu mente está clara para tomar decisiones financieras hoy?" },
  { id:"Q4", question:"¿Qué emoción domina tu estado ahora mismo?" },
  { id:"Q5", question:"¿Tienes algo sin resolver que podría sesgar tus decisiones?" },
  { id:"Q6", question:"¿Cuál es tu intención principal para el día de hoy?" },
  { id:"Q7", question:"¿Estás operando desde la claridad o desde el miedo/FOMO?" },
  { id:"Q8", question:"¿Qué aprendiste ayer que aplica hoy?" }
];

const _JARVIS_DEFAULT_RISK_RULES = [
  { id:"RR1", active:true, rule:"Máximo 5% del portafolio en una sola posición nueva." },
  { id:"RR2", active:true, rule:"Stop-loss mental: si una posición cae >15%, revisar tesis antes de aguantar." },
  { id:"RR3", active:true, rule:"No abrir posiciones nuevas cuando el mercado cae >3% en el día." },
  { id:"RR4", active:true, rule:"Cripto: máximo 35% del portafolio total. Rebalancear si se supera." },
  { id:"RR5", active:true, rule:"Revisión semanal obligatoria: portafolio, estado físico, noticias relevantes." }
];

function initJarvisPrivateMemory() {
  try {
    if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
    if (!fs.existsSync(JARVIS_PRIVATE_PROFILE_FILE))
      saveJSON(JARVIS_PRIVATE_PROFILE_FILE, { corePrinciple: "REGULACIÓN > ESTIMULACIÓN", createdAt: new Date().toISOString() });
    if (!fs.existsSync(JARVIS_HEALTH_RULES_FILE))
      saveJSON(JARVIS_HEALTH_RULES_FILE, _JARVIS_DEFAULT_HEALTH_RULES);
    if (!fs.existsSync(JARVIS_DAILY_QUESTIONS_FILE))
      saveJSON(JARVIS_DAILY_QUESTIONS_FILE, _JARVIS_DEFAULT_DAILY_QUESTIONS);
    if (!fs.existsSync(JARVIS_RISK_RULES_FILE))
      saveJSON(JARVIS_RISK_RULES_FILE, _JARVIS_DEFAULT_RISK_RULES);
    if (!fs.existsSync(JARVIS_CHECKINS_FILE))
      saveJSON(JARVIS_CHECKINS_FILE, []);
  } catch(e) { console.log("initJarvisPrivateMemory omitido:", e.message); }
}

function readPrivateJarvisMemory() {
  const profile   = loadJSON(JARVIS_PRIVATE_PROFILE_FILE,  { corePrinciple: "REGULACIÓN > ESTIMULACIÓN" });
  const rules     = loadJSON(JARVIS_HEALTH_RULES_FILE,     _JARVIS_DEFAULT_HEALTH_RULES);
  const questions = loadJSON(JARVIS_DAILY_QUESTIONS_FILE,  _JARVIS_DEFAULT_DAILY_QUESTIONS);
  const riskRules = loadJSON(JARVIS_RISK_RULES_FILE,       _JARVIS_DEFAULT_RISK_RULES);
  const checkins  = loadJSON(JARVIS_CHECKINS_FILE,         []);
  const today     = todayKey();
  const todayCI   = checkins.find(c => c.date === today) || null;
  return {
    ok:             true,
    corePrinciple:  profile.corePrinciple || "REGULACIÓN > ESTIMULACIÓN",
    activeRules:    (Array.isArray(rules) ? rules : []).filter(r => r.active),
    dailyQuestions: Array.isArray(questions) ? questions : [],
    riskRules:      Array.isArray(riskRules) ? riskRules : [],
    todayCheckIn:   todayCI,
    totalCheckIns:  checkins.length
  };
}

function computeJarvisOperatingMode(whoopSnap, checkIn) {
  const recovery = whoopSnap && whoopSnap.recovery != null ? Number(whoopSnap.recovery) : null;
  const sleep    = whoopSnap && whoopSnap.sleep    != null ? Number(whoopSnap.sleep)    : null;
  const strain   = whoopSnap && whoopSnap.strain   != null ? Number(whoopSnap.strain)   : null;
  const energy   = checkIn && checkIn.energy != null ? Number(checkIn.energy) : null;
  const cannabis = checkIn && checkIn.cannabis === true;

  let mode = "NEUTRAL", label = "Estado Neutral", score = 5;
  const healthRiskFlags = [], tradingRestrictions = [], suggestedQuestions = [];

  if (cannabis) {
    mode  = "REGULACIÓN"; label = "Sustancia activa"; score = 1;
    tradingRestrictions.push("Cannabis/alcohol reciente — no operar hoy ni mañana (Regla R1).");
    healthRiskFlags.push("Sustancia activa en las últimas 24h.");
  } else if (recovery !== null && recovery < 40) {
    mode  = "DESCANSO"; label = "Recovery crítico"; score = 2;
    tradingRestrictions.push("Recovery < 40% — solo observar, no decidir (Regla R2).");
    healthRiskFlags.push("Recovery WHOOP muy bajo (" + recovery + "%).");
  } else if (sleep !== null && sleep < 60) {
    mode  = "REGULACIÓN"; label = "Sueño insuficiente"; score = 3;
    tradingRestrictions.push("Sleep < 60% — postergar decisiones (Regla R3).");
    healthRiskFlags.push("Sueño insuficiente (" + sleep + "%).");
  } else if (strain !== null && strain > 15) {
    mode  = "MODERADO"; label = "Strain alto"; score = 4;
    tradingRestrictions.push("Strain alto — reducir carga cognitiva (Regla R4).");
  } else if (energy !== null && energy <= 4) {
    mode  = "REGULACIÓN"; label = "Energía baja"; score = 3;
    tradingRestrictions.push("Energía subjetiva ≤ 4 — modo CONSERVADOR (Regla R5).");
    healthRiskFlags.push("Energía auto-reportada baja (" + energy + "/10).");
  } else if (recovery !== null && recovery >= 75 && (sleep === null || sleep >= 70)) {
    mode  = "ÓPTIMO"; label = "Condición óptima"; score = 9;
  } else if (recovery !== null || energy !== null) {
    mode  = "MODERADO"; label = "Condición moderada"; score = 6;
  }

  if (cannabis || (energy !== null && energy <= 3)) {
    suggestedQuestions.push("¿Estás operando desde la claridad o desde el FOMO?");
    suggestedQuestions.push("¿Tienes algo sin resolver que podría sesgar tus decisiones?");
  } else {
    suggestedQuestions.push("¿Cuál es tu intención principal para el día de hoy?");
  }

  const tradingAllowed = mode !== "REGULACIÓN" && mode !== "DESCANSO";
  const oneLineAdvice = cannabis
    ? "Día de pausa total — sin decisiones financieras hoy."
    : mode === "DESCANSO"  ? "Recovery crítico: solo observa, no ejecutes."
    : mode === "ÓPTIMO"    ? "Condición óptima — puedes revisar y decidir con claridad."
    : mode === "MODERADO"  ? "Condición moderada — decisiones pequeñas y bien fundamentadas."
    : "Estado incierto — registra un check-in para activar el análisis.";

  return { operatingMode: mode, stateLabel: label, regulationScore: score,
           tradingAllowed, tradingRestrictions, healthRiskFlags, suggestedQuestions, oneLineAdvice };
}

function saveJarvisCheckIn(data) {
  const checkins = loadJSON(JARVIS_CHECKINS_FILE, []);
  const today    = todayKey();
  const idx      = checkins.findIndex(c => c.date === today);
  const entry    = {
    date:         today,
    ts:           Date.now(),
    energy:       (data.energy   != null) ? Number(data.energy)          : null,
    mood:         (data.mood     != null) ? String(data.mood).slice(0,60) : null,
    cannabis:     !!data.cannabis,
    sleepQuality: (data.sleepQuality != null) ? Number(data.sleepQuality) : null
  };
  if (idx >= 0) checkins[idx] = entry; else checkins.push(entry);
  if (checkins.length > 200) checkins.splice(0, checkins.length - 200);
  saveJSON(JARVIS_CHECKINS_FILE, checkins);
  return entry;
}

function buildJarvisPrivateSummary() {
  try {
    const mem = readPrivateJarvisMemory();
    let whoopSnap = {};
    try {
      const wc = loadJSON("whoop_today_cache.json", {});
      if (wc && wc.recovery != null) whoopSnap = wc;
    } catch(e2) {}
    const mode = computeJarvisOperatingMode(whoopSnap, mem.todayCheckIn);
    return {
      corePrinciple:       mem.corePrinciple,
      operatingMode:       mode.operatingMode,
      stateLabel:          mode.stateLabel,
      regulationScore:     mode.regulationScore,
      tradingAllowed:      mode.tradingAllowed,
      tradingRestrictions: mode.tradingRestrictions,
      healthRiskFlags:     mode.healthRiskFlags,
      suggestedQuestions:  mode.suggestedQuestions.slice(0, 2),
      oneLineAdvice:       mode.oneLineAdvice,
      activeRules:         (mem.activeRules || []).slice(0, 3).map(r => r.rule),
      todayCheckIn:        !!mem.todayCheckIn,
      dailyQuestion:       (mem.dailyQuestions || [])[0]
                             ? mem.dailyQuestions[0].question
                             : "¿Cómo amaneciste hoy?"
    };
  } catch(e) {
    return { operatingMode:"NEUTRAL", stateLabel:"Estado Neutral", tradingAllowed:true,
             oneLineAdvice:"Sin datos.", activeRules:[], regulationScore:5,
             corePrinciple:"REGULACIÓN > ESTIMULACIÓN", todayCheckIn:false,
             dailyQuestion:"¿Cómo amaneciste hoy?",
             tradingRestrictions:[], healthRiskFlags:[], suggestedQuestions:[] };
  }
}

`;

src = src.replace(ANCHOR_SERVER, HELPER_FUNCTIONS + ANCHOR_SERVER);
console.log("PATCH 2 applied: Jarvis helper functions (module level)");

// ══════════════════════════════════════════════════════════════════════════════
// PATCH 3 — API routes inside the request handler
// Anchor: the HTML page fallthrough (last route before res.end(render()))
// ══════════════════════════════════════════════════════════════════════════════
const ANCHOR_FALLTHROUGH = `  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });\n  res.end(render());`;
if (!src.includes(ANCHOR_FALLTHROUGH)) {
  console.error("ERROR: anchor not found — HTML fallthrough. Aborting.");
  process.exit(1);
}

const API_ROUTES = `
  // ── Jarvis Private Memory endpoints ──────────────────────────────────────

  if (path === "/api/jarvis/private-memory" && req.method === "GET") {
    try {
      const jp = buildJarvisPrivateSummary();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok:true,
        corePrinciple:jp.corePrinciple, operatingMode:jp.operatingMode,
        stateLabel:jp.stateLabel, regulationScore:jp.regulationScore,
        tradingAllowed:jp.tradingAllowed, tradingRestrictions:jp.tradingRestrictions,
        healthRiskFlags:jp.healthRiskFlags, oneLineAdvice:jp.oneLineAdvice,
        suggestedQuestions:jp.suggestedQuestions, todayCheckIn:jp.todayCheckIn,
        dailyQuestion:jp.dailyQuestion, activeRules:jp.activeRules }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok:false, error:e.message }));
    }
  }

  if (path === "/api/jarvis/check-in" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const data  = JSON.parse(body || "{}");
        const entry = saveJarvisCheckIn(data);
        const jp    = buildJarvisPrivateSummary();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok:true, date:entry.date, energy:entry.energy,
          operatingMode:jp.operatingMode, tradingAllowed:jp.tradingAllowed,
          oneLineAdvice:jp.oneLineAdvice }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok:false, error:e.message }));
      }
    });
    return;
  }

`;

src = src.replace(ANCHOR_FALLTHROUGH, API_ROUTES + ANCHOR_FALLTHROUGH);
console.log("PATCH 3 applied: Jarvis API routes (inside request handler)");

// ══════════════════════════════════════════════════════════════════════════════
// PATCH 4 — Boot initialisation
// Anchor: async function boot() {
//          // CORDELIUS_BOOT_LISTEN_FIRST_FIX
// ══════════════════════════════════════════════════════════════════════════════
const ANCHOR_BOOT = `async function boot() {\n  // CORDELIUS_BOOT_LISTEN_FIRST_FIX`;
if (!src.includes(ANCHOR_BOOT)) {
  console.warn("WARN: boot anchor not found — skipping PATCH 4.");
  console.warn("  Add manually at the top of boot(): try { initJarvisPrivateMemory(); } catch(e) {}");
} else {
  src = src.replace(ANCHOR_BOOT,
    `async function boot() {\n  try { initJarvisPrivateMemory(); } catch(e) { console.log("initJarvisPrivateMemory omitido:", e.message); }\n  // CORDELIUS_BOOT_LISTEN_FIRST_FIX`
  );
  console.log("PATCH 4 applied: initJarvisPrivateMemory() in boot()");
}

// ══════════════════════════════════════════════════════════════════════════════
// Write + syntax-check
// ══════════════════════════════════════════════════════════════════════════════
fs.writeFileSync(TARGET, src, "utf8");
console.log("dashboard.js written.");

try {
  execSync("node --check " + TARGET, { stdio: "inherit" });
  console.log("✓ node --check passed — patch applied successfully.");
} catch(e) {
  console.error("✗ node --check FAILED — restoring backup.");
  fs.copyFileSync(BACKUP, TARGET);
  console.error("Restored from", path.basename(BACKUP));
  process.exit(1);
}

console.log("\nDone. Restart the server, then test:");
console.log("  curl http://127.0.0.1:3000/api/jarvis/private-memory");
console.log("  curl -X POST http://127.0.0.1:3000/api/jarvis/check-in \\");
console.log('       -H "Content-Type: application/json" \\');
console.log('       -d \'{"energy":7,"mood":"tranquilo","cannabis":false}\'');
