#!/usr/bin/env node
/**
 * apply-brain-patch.js — Cordelius Jarvis Brain Layer
 *
 * Apply on tablet: node apply-brain-patch.js
 *
 * dashboard.js changes (3 patches):
 *   A. Add computeJarvisBrain() function at module level, before http.createServer
 *   B. Add GET /api/jarvis/brain route, before HTML fallthrough
 *   C. Remove <meta http-equiv="refresh"> (full-page reload that drops hash → Home)
 *
 * bot.js changes (4 patches):
 *   D. Add getBrainSummary() helper, before first bot.onText
 *   E-G. Inject brain check at top of /daily, /action, /status handlers
 *
 * Does NOT touch: renderHomePortal, showMod, nav, module HTML, .env, data/*.json,
 *                 existing Jarvis endpoints, Jarvis floating panel.
 */

"use strict";
const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Helpers ──────────────────────────────────────────────────────────────────

function readFile(p) { return fs.readFileSync(p, "utf8"); }
function writeFile(p, s) { fs.writeFileSync(p, s, "utf8"); }
function backup(p) {
  const b = p + ".backup-brain-" + Date.now();
  fs.copyFileSync(p, b);
  return b;
}
function syntaxCheck(p) {
  try { execSync("node --check " + p, { stdio: "inherit" }); return true; }
  catch(e) { return false; }
}

const DASHBOARD = path.join(__dirname, "dashboard.js");
const BOT       = path.join(__dirname, "bot.js");

for (const f of [DASHBOARD, BOT]) {
  if (!fs.existsSync(f)) { console.error("ERROR: not found:", f); process.exit(1); }
}

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD.JS
// ════════════════════════════════════════════════════════════════════════════

let dash = readFile(DASHBOARD);

// ── Guard ────────────────────────────────────────────────────────────────────
if (dash.includes("computeJarvisBrain") || dash.includes("/api/jarvis/brain")) {
  console.log("SKIP dashboard: brain already present.");
} else {
  const dashBackup = backup(DASHBOARD);
  console.log("dashboard backup →", path.basename(dashBackup));

  // ── PATCH A: computeJarvisBrain() at module level ─────────────────────────
  const ANCHOR_A = "const server = http.createServer(";
  if (!dash.includes(ANCHOR_A)) { console.error("ERROR: anchor A missing (http.createServer). Aborting."); process.exit(1); }

  const BRAIN_FN = `
// ── JARVIS BRAIN — fused context, no duplication ──────────────────────────
function computeJarvisBrain() {
  try {
    // 1. Regulation state (private memory + WHOOP)
    const jp  = (typeof buildJarvisPrivateSummary === "function") ? buildJarvisPrivateSummary() : {};
    const mem = (typeof readPrivateJarvisMemory   === "function") ? readPrivateJarvisMemory()   : {};

    // 2. WHOOP snapshot
    let whoop = {};
    try { const w = loadJSON("whoop_today_cache.json", {}); if (w && w.recovery != null) whoop = w; } catch(e) {}

    // 3. Portfolio (lightweight — only totalValueMXN, totalGainPct)
    let pv = { totalValueMXN: 0, totalGainPct: 0 };
    try { const _pv = portfolioValue(); pv = { totalValueMXN: _pv.totalValueMXN || 0, totalGainPct: _pv.totalGainPct || 0 }; } catch(e) {}

    // 4. Top opportunity
    let topOpp = null;
    try { const opp = getOpportunityState(); topOpp = (opp.topOpportunities || [])[0] || null; } catch(e) {}

    // 5. Quick notes (latest 3)
    let quickNotes = [];
    try { quickNotes = (loadJSON("data/jarvis_quick_notes.json", []) || []).slice(-3); } catch(e) {}

    // 6. Action plan (load direct — path confirmed by user)
    let actionPlan = {};
    try { actionPlan = loadJSON("data/jarvis_action_plan.json", {}) || {}; } catch(e) {}

    // 7. Daily brief (load direct)
    let dailyBrief = {};
    try { dailyBrief = loadJSON("data/jarvis_daily_brief.json", {}) || {}; } catch(e) {}

    // 8. News headline bullets (module-level array, max 3)
    let topNewsBullets = [];
    try {
      (news || []).slice(0, 5).forEach(n => {
        const t = (n.title || n.headline || "").trim().slice(0, 90);
        if (t && topNewsBullets.length < 3) topNewsBullets.push(t);
      });
    } catch(e) {}

    // ── Derived state ──────────────────────────────────────────────────────
    const operatingMode  = jp.operatingMode || "NEUTRAL";
    const tradingAllowed = jp.tradingAllowed !== false;
    const tradingMode    = !tradingAllowed
      ? "NO_TRADING"
      : (operatingMode === "ÓPTIMO" ? "ACTIVO" : operatingMode === "MODERADO" ? "CONSERVADOR" : "OBSERVAR");

    const recovery = (whoop.recovery != null) ? Number(whoop.recovery) : null;
    const sleep    = (whoop.sleep    != null) ? Number(whoop.sleep)    : null;

    const topFocus = topOpp ? topOpp.symbol : null;
    const topScore = topOpp ? (topOpp.score || null) : null;
    const focusInPortfolio = topOpp ? !!topOpp.inPortfolio : false;

    // ── Why (deduplicated, max 4 bullets) ────────────────────────────────
    const why = [];
    if (recovery !== null) why.push("Recovery: " + recovery + "%");
    if (sleep    !== null && sleep < 70) why.push("Sleep: " + sleep + "%");
    if (jp.tradingRestrictions && jp.tradingRestrictions.length)
      why.push(jp.tradingRestrictions[0].slice(0, 80));
    if (topFocus) why.push(topFocus + " score " + topScore + "/100" + (focusInPortfolio ? " (en portafolio)" : ""));

    // ── doNow (from mode + action plan, max 3) ────────────────────────────
    const doNow = [];
    if (!tradingAllowed) doNow.push("No ejecutar trades");
    if (topFocus) doNow.push("Revisar tesis de " + topFocus + (focusInPortfolio ? " (ya en portafolio)" : ""));
    const planActions = actionPlan.actions || actionPlan.doNow || [];
    (Array.isArray(planActions) ? planActions : []).slice(0, 2).forEach(a => {
      const s = typeof a === "string" ? a.slice(0, 80) : (a.action || a.text || "").slice(0, 80);
      if (s && !doNow.some(x => x.includes(s.slice(0, 20)))) doNow.push(s);
    });
    if (doNow.length === 0) doNow.push("Revisar portafolio en modo observación");

    // ── avoid (max 3) ────────────────────────────────────────────────────
    const avoid = [];
    if (!tradingAllowed) avoid.push("Overtrading");
    if (recovery !== null && recovery < 50) avoid.push("FOMO — estado físico bajo");
    avoid.push("Abrir posiciones sin tesis clara");

    // ── confidence ───────────────────────────────────────────────────────
    const hasWhoop   = recovery !== null;
    const hasCheckin = !!(mem.todayCheckIn);
    const confidence = (hasWhoop && hasCheckin) ? "ALTA" : (hasWhoop || hasCheckin) ? "MEDIA" : "BAJA";

    // ── telegramSummary (short — fits 1 Telegram message) ────────────────
    const icon = operatingMode === "ÓPTIMO" ? "🟢"
      : (operatingMode === "MODERADO")            ? "🟡"
      : (operatingMode === "REGULACIÓN" || operatingMode === "DESCANSO") ? "🔴" : "⚪";
    const tLines = [icon + " *" + operatingMode + " · " + tradingMode + "*"];
    if (topFocus) tLines.push("Focus: " + topFocus + (topScore ? " " + topScore + "/100" : ""));
    if (why.length) tLines.push("Razón: " + why.slice(0, 2).join(" · "));
    if (doNow.length) tLines.push("Acción: " + doNow.slice(0, 2).join(" · "));
    tLines.push("_Educativo — no es asesoría financiera._");
    const telegramSummary = tLines.join("\\n");

    // ── panelSummary (1–2 lines for UI) ──────────────────────────────────
    let panelSummary = "Jarvis · " + operatingMode + " · " + tradingMode;
    if (topFocus) panelSummary += ". Focus: " + topFocus;
    if (jp.oneLineAdvice) panelSummary += ". " + jp.oneLineAdvice;

    // ── newsSummary (max 3 bullets, no duplication with why/doNow) ───────
    const newsSummary = topNewsBullets;

    return {
      ok:             true,
      state:          operatingMode,
      tradingMode,
      topFocus,
      topScore,
      confidence,
      why,
      doNow,
      avoid,
      telegramSummary,
      panelSummary,
      newsSummary,
      regulationScore:  jp.regulationScore || 5,
      tradingAllowed,
      oneLineAdvice:    jp.oneLineAdvice || "",
      portfolioMXN:     pv.totalValueMXN,
      portfolioGainPct: pv.totalGainPct,
      disclaimer:       "Educativo. No es asesoría financiera."
    };
  } catch(e) {
    return {
      ok: false, error: e.message,
      state: "NEUTRAL", tradingMode: "OBSERVAR",
      telegramSummary: "⚪ *NEUTRAL · OBSERVAR*\\n_Educativo — no es asesoría financiera._",
      disclaimer: "Educativo. No es asesoría financiera."
    };
  }
}

`;

  dash = dash.replace(ANCHOR_A, BRAIN_FN + ANCHOR_A);
  console.log("dashboard PATCH A: computeJarvisBrain() inserted");

  // ── PATCH B: GET /api/jarvis/brain route ────────────────────────────────
  const ANCHOR_B = `  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });\n  res.end(render());`;
  if (!dash.includes(ANCHOR_B)) { console.error("ERROR: anchor B missing (HTML fallthrough). Aborting."); writeFile(DASHBOARD, readFile(dashBackup)); process.exit(1); }

  const BRAIN_ROUTE = `
  if (path === "/api/jarvis/brain" && req.method === "GET") {
    try {
      const b = computeJarvisBrain();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(b));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

`;
  dash = dash.replace(ANCHOR_B, BRAIN_ROUTE + ANCHOR_B);
  console.log("dashboard PATCH B: GET /api/jarvis/brain route inserted");

  // ── PATCH C: remove meta refresh ─────────────────────────────────────────
  // Full-page reload drops the URL hash on Android → browser resets to Home.
  // The anchor is a template-literal expression inside dashboard.js source text.
  // We use String() concat to avoid this script evaluating ${…} at load time.
  const ANCHOR_C_SRC = '<meta http-equiv="refresh" content="' + '${settings.autoRefreshSeconds}' + '">';
  if (dash.includes(ANCHOR_C_SRC)) {
    dash = dash.replace(ANCHOR_C_SRC, '<!-- meta refresh removed: JS setInterval handles data updates without page reload -->');
    console.log("dashboard PATCH C: meta refresh removed");
  } else {
    // Fallback variants (different quote styles editors may produce)
    const variants = [
      "<meta http-equiv='refresh' content='" + "${settings.autoRefreshSeconds}" + "'>",
      '<meta http-equiv=\\"refresh\\" content=\\"' + '${settings.autoRefreshSeconds}' + '\\">',
    ];
    let removed = false;
    for (const v of variants) {
      if (dash.includes(v)) {
        dash = dash.replace(v, '<!-- meta refresh removed: JS intervals handle data updates -->');
        console.log("dashboard PATCH C: meta refresh removed (variant)");
        removed = true; break;
      }
    }
    if (!removed) console.warn("WARN: meta refresh anchor not found — skip PATCH C. Remove manually: line 3219");
  }

  // ── Write + verify ────────────────────────────────────────────────────────
  writeFile(DASHBOARD, dash);
  if (!syntaxCheck(DASHBOARD)) {
    console.error("✗ dashboard.js syntax FAILED — restoring backup");
    fs.copyFileSync(dashBackup, DASHBOARD);
    process.exit(1);
  }
  console.log("✓ dashboard.js node --check passed");
}

// ════════════════════════════════════════════════════════════════════════════
// BOT.JS
// ════════════════════════════════════════════════════════════════════════════

let bot = readFile(BOT);

// ── Guard ────────────────────────────────────────────────────────────────────
if (bot.includes("getBrainSummary") || bot.includes("/api/jarvis/brain")) {
  console.log("SKIP bot.js: brain already present.");
} else {
  const botBackup = backup(BOT);
  console.log("bot.js backup →", path.basename(botBackup));

  // ── Detect localGet function name (tablet uses localGet, remote uses fetchLocal)
  const localGetFn = bot.includes("function localGet(") ? "localGet"
    : bot.includes("function fetchLocal(") ? "fetchLocal"
    : null;

  if (!localGetFn) {
    console.warn("WARN: neither localGet nor fetchLocal found in bot.js — skipping bot patches.");
  } else {
    console.log("bot.js: detected HTTP helper →", localGetFn + "()");

    // ── PATCH D: getBrainSummary() helper ──────────────────────────────────
    // Insert just before the first bot.onText — guaranteed to be in scope
    const ANCHOR_D = "bot.onText(";
    const firstOnText = bot.indexOf(ANCHOR_D);
    if (firstOnText === -1) {
      console.warn("WARN: bot.onText not found — skipping bot patches.");
    } else {
      const BRAIN_HELPER = `
// ── Brain helper — fetches /api/jarvis/brain and returns compact summary ──
async function getBrainSummary() {
  try {
    const b = await ${localGetFn}("/api/jarvis/brain");
    return (b && b.ok) ? b : null;
  } catch(e) { return null; }
}

`;
      bot = bot.slice(0, firstOnText) + BRAIN_HELPER + bot.slice(firstOnText);
      console.log("bot.js PATCH D: getBrainSummary() inserted");

      // ── PATCH E/F/G: inject brain check at top of /daily, /action, /status
      // Detect send-message helper: node-telegram-bot-api uses bot.sendMessage,
      // custom bots may use sendReply or similar. We detect from the existing code.
      const sendFn = bot.includes("bot.sendMessage(") ? "bot.sendMessage(msg.chat.id,"
        : bot.includes("sendMessage(") ? "sendMessage(msg.chat.id,"
        : "bot.sendMessage(msg.chat.id,";  // fallback

      const BRAIN_CHECK = `
  // Brain-first: if /api/jarvis/brain returns telegramSummary, use it directly
  const _brain = await getBrainSummary();
  if (_brain && _brain.telegramSummary) {
    ${sendFn} _brain.telegramSummary, { parse_mode: "Markdown" });
    return;
  }`;

      let patchCount = 0;
      for (const cmd of ["daily", "action", "status"]) {
        // Find: bot.onText(/\/cmd/,   (note: source has literal \/ which is / in regex)
        // In source text the string is: bot.onText(/\/daily/,
        const searchStr = "bot.onText(/\\/" + cmd + "/";
        const idx = bot.indexOf(searchStr);
        if (idx === -1) { console.warn("WARN: handler not found for /" + cmd + " — skipping"); continue; }

        // Find the opening { of the callback (first { after the match)
        const braceIdx = bot.indexOf("{", idx + searchStr.length);
        if (braceIdx === -1) { console.warn("WARN: opening brace not found for /" + cmd + " — skipping"); continue; }

        // Ensure the callback is async (we need await inside)
        const handlerSlice = bot.slice(idx, braceIdx + 1);
        if (!handlerSlice.includes("async")) {
          // Make it async by replacing first non-async occurrence
          const callbackStart = bot.indexOf("(msg", idx);
          if (callbackStart > -1 && callbackStart < braceIdx) {
            bot = bot.slice(0, callbackStart) + "async (msg" + bot.slice(callbackStart + 4);
          }
          console.log("bot.js: made /" + cmd + " handler async");
        }

        // Re-find the brace after potential async insertion
        const newIdx = bot.indexOf(searchStr);
        const newBrace = bot.indexOf("{", newIdx + searchStr.length);
        bot = bot.slice(0, newBrace + 1) + BRAIN_CHECK + bot.slice(newBrace + 1);
        patchCount++;
        console.log("bot.js PATCH " + (patchCount === 1 ? "E" : patchCount === 2 ? "F" : "G") + ": brain check injected in /" + cmd);
      }
    }
  }

  // ── Write + verify ──────────────────────────────────────────────────────
  writeFile(BOT, bot);
  if (!syntaxCheck(BOT)) {
    console.error("✗ bot.js syntax FAILED — restoring backup");
    fs.copyFileSync(botBackup, BOT);
    process.exit(1);
  }
  console.log("✓ bot.js node --check passed");
}

// ════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════
console.log(`
Done. Restart and test:

  pkill -f "node start-with-env.js" 2>/dev/null || true
  nohup node start-with-env.js > server.log 2>&1 &
  sleep 3
  curl -s http://localhost:3000/api/jarvis/brain | head -c 700
  curl -s http://localhost:3000/api/jarvis/daily-brief | head -c 300
`);
