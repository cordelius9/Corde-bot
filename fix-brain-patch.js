#!/usr/bin/env node
/**
 * fix-brain-patch.js — fixes two bugs in the already-applied computeJarvisBrain()
 *
 * Bug 1 (NaN recovery): computeJarvisBrain read whoop_today_cache.json directly,
 *   but that file stores raw WHOOP API objects {records:[...]}, not numbers.
 *   Fix: call computeHealthReadiness() which extracts numeric scores from
 *   the in-memory whoopCache.
 *
 * Bug 2 (state mismatch MODERADO vs DEFENSIVO): brain recomputed state from its
 *   own thresholds instead of trusting the existing daily-brief / action-plan.
 *   Fix: use dailyBrief.biologicalState and actionPlan.tradingPermission first,
 *   fall back to jp.operatingMode.
 *
 * Run: node fix-brain-patch.js
 */

"use strict";
const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DASHBOARD = path.join(__dirname, "dashboard.js");
if (!fs.existsSync(DASHBOARD)) { console.error("ERROR: dashboard.js not found"); process.exit(1); }

let src = fs.readFileSync(DASHBOARD, "utf8");

if (!src.includes("computeJarvisBrain")) {
  console.error("ERROR: computeJarvisBrain not found — run apply-brain-patch.js first");
  process.exit(1);
}
if (src.includes("computeHealthReadiness()") && src.includes("dailyBrief.biologicalState")) {
  console.log("SKIP: fixes already applied");
  process.exit(0);
}

const bak = DASHBOARD + ".backup-fix-brain-" + Date.now();
fs.copyFileSync(DASHBOARD, bak);
console.log("backup →", path.basename(bak));

// ── FIX 1: Replace raw WHOOP cache read with computeHealthReadiness() ─────────
// Old: reads the raw JSON file (stores API objects, not numbers)
// New: calls the function that extracts numeric scores from in-memory whoopCache

const OLD_WHOOP = `    let whoop = {};
    try { const w = loadJSON("whoop_today_cache.json", {}); if (w && w.recovery != null) whoop = w; } catch(e) {}

    // Portfolio totals only
    let pv = { totalValueMXN: 0, totalGainPct: 0 };
    try { const _p = portfolioValue(); pv.totalValueMXN = _p.totalValueMXN || 0; pv.totalGainPct = _p.totalGainPct || 0; } catch(e) {}`;

const NEW_WHOOP = `    // computeHealthReadiness() reads in-memory whoopCache and returns numeric scores
    let h = {};
    try { h = (typeof computeHealthReadiness === "function") ? computeHealthReadiness() : {}; } catch(e) {}

    // Portfolio totals only
    let pv = { totalValueMXN: 0, totalGainPct: 0 };
    try { const _p = portfolioValue(); pv.totalValueMXN = _p.totalValueMXN || 0; pv.totalGainPct = _p.totalGainPct || 0; } catch(e) {}`;

if (!src.includes(OLD_WHOOP)) {
  console.error("ERROR: WHOOP anchor not found — already patched or text differs. Check manually.");
  process.exit(1);
}
src = src.replace(OLD_WHOOP, NEW_WHOOP);
console.log("FIX 1: WHOOP section → computeHealthReadiness()");

// ── FIX 2: Replace derived state section with one that trusts daily-brief ─────
// Old: recomputes from raw recovery number, ignores daily-brief / action-plan
// New: uses dailyBrief.biologicalState + actionPlan.tradingPermission first

const OLD_STATE = `    // ── Derived state ──────────────────────────────────────────────────────
    const operatingMode  = jp.operatingMode || "NEUTRAL";
    const tradingAllowed = jp.tradingAllowed !== false;
    const tradingMode    = !tradingAllowed        ? "NO_TRADING"
      : operatingMode === "ÓPTIMO"           ? "ACTIVO"
      : operatingMode === "MODERADO"              ? "CONSERVADOR"
      : "OBSERVAR";

    const recovery = (whoop.recovery != null) ? Number(whoop.recovery) : null;
    const sleep    = (whoop.sleep    != null) ? Number(whoop.sleep)    : null;`;

const NEW_STATE = `    // ── Derived state — trust daily-brief / action-plan, fall back to jp ────
    // dailyBrief and actionPlan may have already computed a more accurate state
    const _dbState   = dailyBrief.biologicalState || dailyBrief.state   || null;
    const _apTrading = actionPlan.tradingPermission || actionPlan.tradingMode || null;
    const operatingMode  = _dbState || jp.operatingMode || "NEUTRAL";
    const _tradingAllowedRaw = _apTrading
      ? (_apTrading !== "NO_TRADING")
      : (jp.tradingAllowed !== false);
    const tradingAllowed = _tradingAllowedRaw;
    const tradingMode    = _apTrading
      ? _apTrading
      : (!tradingAllowed       ? "NO_TRADING"
        : operatingMode === "ÓPTIMO"    ? "ACTIVO"
        : operatingMode === "MODERADO"  ? "CONSERVADOR"
        : "OBSERVAR");

    const recovery = (h.recovery != null) ? Number(h.recovery) : null;
    const sleep    = (h.sleep    != null) ? Number(h.sleep)    : null;`;

if (!src.includes(OLD_STATE)) {
  console.error("ERROR: state anchor not found — already patched or text differs. Check manually.");
  // Don't abort — fix 1 was already applied, continue to write
  console.warn("Skipping FIX 2 — apply manually if needed.");
} else {
  src = src.replace(OLD_STATE, NEW_STATE);
  console.log("FIX 2: state derivation → trusts dailyBrief.biologicalState + actionPlan.tradingPermission");
}

// ── FIX 3: Update hasWhoop to use h.recovery (not whoop.recovery) ─────────────
// Also fix the confidence line which still referenced whoop implicitly
const OLD_CONFIDENCE = `    const hasWhoop   = recovery !== null;`;
const NEW_CONFIDENCE = `    const hasWhoop   = recovery !== null && !isNaN(recovery);`;

if (src.includes(OLD_CONFIDENCE)) {
  src = src.replace(OLD_CONFIDENCE, NEW_CONFIDENCE);
  console.log("FIX 3: confidence guard — exclude NaN from hasWhoop");
} else {
  console.warn("WARN FIX 3: confidence anchor not found — skipping");
}

// ── Write + syntax check ──────────────────────────────────────────────────────
fs.writeFileSync(DASHBOARD, src, "utf8");
try {
  execSync("node --check " + DASHBOARD, { stdio: "inherit" });
  console.log("✓ node --check passed");
} catch(e) {
  console.error("✗ syntax FAILED — restoring backup");
  fs.copyFileSync(bak, DASHBOARD);
  process.exit(1);
}

console.log(`
Done. Restart and test:

  pkill -f "node start-with-env.js" 2>/dev/null || true
  nohup node start-with-env.js > server.log 2>&1 &
  sleep 4
  curl -s http://localhost:3000/api/jarvis/brain | python3 -m json.tool 2>/dev/null | head -40
`);
