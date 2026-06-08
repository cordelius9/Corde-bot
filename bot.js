"use strict";
// ============================================================
// Jarvis Bot — Cordelius OS Telegram Agent
// Zero external dependencies — pure Node built-ins only
// ============================================================
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ── Manual .env loader (no dotenv package needed) ─────────────────────────────
// Same pattern as dashboard.js — env vars loaded by shell (start.sh sets -a . .env)
// This loader is a belt-and-suspenders fallback for direct invocation.
function loadEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      // Only set if not already in environment (shell-exported vars take priority)
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch(e) { /* .env optional — shell may have already exported vars */ }
}
loadEnv();

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN  || "";
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY   || "";
// Use the bot-specific model if set, else the dashboard model, else the safe default
const CLAUDE_MODEL     = process.env.CLAUDE_MODEL_BOT    ||
                         process.env.CLAUDE_MODEL         ||
                         "claude-haiku-4-5-20251001";
const CORDELIUS_PORT   = Number(process.env.PORT)         || 3000;
const POLL_TIMEOUT_S   = 30;   // Telegram long-poll seconds
const MAX_REPLY_TOKENS = 500;
const FETCH_TIMEOUT_MS = 5000; // 5s per local API call

// Guard: token is required to run
if (!TELEGRAM_TOKEN) {
  console.error("[Jarvis Bot] ERROR: TELEGRAM_BOT_TOKEN no configurado. Agrega al .env y reinicia.");
  process.exit(1);
}
if (!ANTHROPIC_KEY) {
  console.warn("[Jarvis Bot] ADVERTENCIA: ANTHROPIC_API_KEY no configurado — solo respuestas locales.");
}

console.log(`[Jarvis Bot] Iniciado · modelo: ${CLAUDE_MODEL} · Cordelius puerto ${CORDELIUS_PORT}`);

// ── Local Cordelius HTTP fetch ─────────────────────────────────────────────────
function fetchLocal(apiPath) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS + 500);
    const req = http.get(
      { hostname: "127.0.0.1", port: CORDELIUS_PORT, path: apiPath,
        headers: { "Accept": "application/json" }, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          clearTimeout(timer);
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
        res.on("error", () => { clearTimeout(timer); resolve(null); });
      }
    );
    req.on("error",   () => { clearTimeout(timer); resolve(null); });
    req.on("timeout", () => { req.destroy(); clearTimeout(timer); resolve(null); });
  });
}

// ── Context builder — fetches all local Cordelius APIs in parallel ─────────────
async function buildTelegramJarvisContext() {
  const [memR, ctxR, whoopR, dbR, dailyR] = await Promise.allSettled([
    fetchLocal("/api/jarvis/memory"),
    fetchLocal("/api/jarvis/context"),
    fetchLocal("/api/whoop/today"),
    fetchLocal("/api/autopilot/database"),
    fetchLocal("/api/daily/today")
  ]);

  const get = (r) => (r.status === "fulfilled" ? r.value : null);
  const mem   = get(memR);
  const ctx   = get(ctxR);
  const whoop = get(whoopR);
  const db    = get(dbR);
  const daily = get(dailyR);

  return {
    memory:          mem,
    context:         ctx,
    whoop:           whoop,
    db:              db,
    daily:           daily,
    dashboardOnline: mem !== null || whoop !== null
  };
}

// ── Build Claude system prompt from Cordelius context ─────────────────────────
function buildSystemPrompt(ctx) {
  const lines = [
    "Eres Jarvis, el copiloto inteligente de Cordelius OS — el sistema operativo personal de Pedro.",
    "Responde en español mexicano, directo y conciso. Máximo 3 párrafos cortos.",
    "No eres asesor financiero ni médico. Todo análisis es educativo/paper. No des órdenes de compra/venta.",
    "Portafolio en GBM (México), Plata (USA fraccional), Bitso (cripto). Cripto tiene concentración alta — siempre señálalo.",
  ];

  if (!ctx.dashboardOnline) {
    lines.push("\n⚠️ ALERTA: Cordelius Dashboard offline. Responde sin datos en tiempo real. Sugiere verificar que dashboard.js esté corriendo.");
    return lines.join("\n");
  }

  // Memory summary from /api/jarvis/memory
  const mem = ctx.memory;
  if (mem && mem.memorySummary && mem.memorySummary !== "Sin memoria disponible todavía.") {
    lines.push("\nMEMORIA PERSONAL (historial comprimido de Cordelius):");
    lines.push(mem.memorySummary);
  }

  // WHOOP live state
  const wh = ctx.whoop;
  if (wh && wh.ok) {
    if (wh.connected) {
      lines.push(`\nWHOOP LIVE: recovery ${wh.recovery ?? "—"}%, sueño ${wh.sleep ?? "—"}%, HRV ${wh.hrv != null ? Number(wh.hrv).toFixed(1) : "—"} ms, strain ${wh.strain != null ? Number(wh.strain).toFixed(1) : "—"}, modo ${wh.operatingMode}.`);
    } else {
      lines.push(`\nWHOOP: no conectado. Modo operativo estimado: ${wh.operatingMode}.`);
    }
    if (wh.suggestion) lines.push(`Sugerencia del sistema: ${wh.suggestion}`);
  }

  // Daily learning capacity + risk
  const snap = ctx.daily && ctx.daily.snapshot;
  if (snap && snap.learning) {
    const l = snap.learning;
    lines.push(`\nCAPACIDAD TRADING HOY: ${l.tradingCapacity || "—"} · RIESGO RECOMENDADO: ${l.riskRecommendation || "—"}.`);
    if (l.nextDaySuggestions && l.nextDaySuggestions.length) {
      lines.push("Sugerencias para hoy: " + l.nextDaySuggestions.slice(0, 2).join(" | "));
    }
  }

  return lines.join("\n");
}

// ── Anthropic API call ────────────────────────────────────────────────────────
function callClaude(systemPrompt, userText) {
  if (!ANTHROPIC_KEY) return Promise.resolve(null);
  const payload = JSON.stringify({
    model:      CLAUDE_MODEL,
    max_tokens: MAX_REPLY_TOKENS,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userText }]
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers:  {
        "content-type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-length":    Buffer.byteLength(payload)
      },
      timeout: 25000
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const txt = j && j.content && j.content[0] && j.content[0].text;
          resolve(txt || null);
        } catch { resolve(null); }
      });
    });
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

// ── Command handlers ──────────────────────────────────────────────────────────
function safeStr(v, fallback = "—") {
  return (v !== null && v !== undefined && String(v).trim() !== "") ? String(v) : fallback;
}

async function cmdStatus(ctx) {
  if (!ctx.dashboardOnline) {
    return "⚠️ *Cordelius OS offline.*\nVerifica que `dashboard.js` esté corriendo:\n`bash scripts/health_check.sh`";
  }
  const mem = ctx.memory;
  const lines = ["*Cordelius OS · Estado*", "Dashboard: ✅ Online"];
  if (mem && mem.sources) {
    const s = mem.sources;
    lines.push(`Salud: ${s.health ? "✅" : "⚠️ sin datos"} · Días registrados: ${s.dailyLearning || 0}`);
    lines.push(`Decisiones recientes: ${s.recentDecisions || 0}`);
    lines.push(`Patrones: ${s.patterns ? "✅ detectados" : "⏳ acumulando datos (mín 3 días)"}`);
    lines.push(`Autopilot nivel: ${s.autopilotLevel || 1}`);
  }
  const wh = ctx.whoop;
  if (wh) lines.push(`WHOOP: ${wh.connected ? "✅ conectado" : "⚠️ sin conexión"} · Modo ${safeStr(wh.operatingMode)}`);
  const snap = ctx.daily && ctx.daily.snapshot;
  if (snap && snap.learning) {
    lines.push(`Capacidad hoy: *${safeStr(snap.learning.tradingCapacity)}* · Riesgo: *${safeStr(snap.learning.riskRecommendation)}*`);
  }
  return lines.join("\n");
}

async function cmdHealth(ctx) {
  const wh = ctx.whoop;
  if (!ctx.dashboardOnline || !wh || !wh.ok) {
    return "⚠️ Sin datos de salud. Dashboard offline o WHOOP no configurado.";
  }
  const snap = ctx.daily && ctx.daily.snapshot;
  const l    = (snap && snap.learning) || {};
  const lines = [
    "*Health · WHOOP Readiness*",
    wh.connected ? "✅ WHOOP conectado" : "⚠️ WHOOP sin conexión — datos estimados"
  ];
  if (wh.recovery  != null) lines.push(`Recovery:  *${wh.recovery}%*`);
  if (wh.sleep     != null) lines.push(`Sueño:     *${wh.sleep}%*`);
  if (wh.hrv       != null) lines.push(`HRV:       *${Number(wh.hrv).toFixed(1)} ms*`);
  if (wh.strain    != null) lines.push(`Strain:    *${Number(wh.strain).toFixed(1)}*`);
  lines.push(`Modo:      *${safeStr(wh.operatingMode)}*`);
  if (wh.suggestion) lines.push(`💡 ${wh.suggestion}`);
  if (l.tradingCapacity)   lines.push(`\nCapacidad trading: *${l.tradingCapacity}*`);
  if (l.riskRecommendation) lines.push(`Recomendación riesgo: *${l.riskRecommendation}*`);
  lines.push("\n_No es consejo médico._");
  return lines.join("\n");
}

async function cmdPortfolio(ctx) {
  if (!ctx.dashboardOnline) {
    return "⚠️ Dashboard offline — sin datos de portafolio.";
  }
  const p = ctx.context && ctx.context.context && ctx.context.context.portfolio;
  if (!p || p.error) return "⚠️ Sin datos de portafolio disponibles ahora.";
  const lines = [
    "*Portafolio · Resumen Educativo*",
    `💰 Valor:    *$${Number(p.totalMXN || 0).toLocaleString("es-MX")} MXN*`,
    `📈 Ganancia: *${(p.gainPct >= 0 ? "+" : "") + p.gainPct}%*`,
    `₿  Cripto:   *${p.cryptoPct}%* del total`,
    `📊 Régimen:  *${safeStr(p.regime)}*`
  ];
  if (p.topWinner) lines.push(`🏆 Mejor:    ${p.topWinner.sym} (${p.topWinner.pct >= 0 ? "+" : ""}${p.topWinner.pct}%, score ${p.topWinner.score}/100)`);
  if (p.topLoser)  lines.push(`⚠️ Más débil: ${p.topLoser.sym} (${p.topLoser.pct}%, score ${p.topLoser.score}/100)`);
  if ((p.cryptoPct || 0) > 50) {
    lines.push(`\n🔴 _Concentración cripto elevada (${p.cryptoPct}%). Considera diversificación — riesgo de volatilidad alta._`);
  }
  lines.push("\n_Análisis educativo — no es asesoría financiera._");
  return lines.join("\n");
}

async function cmdMemory(ctx) {
  if (!ctx.dashboardOnline) return "⚠️ Dashboard offline — sin memoria disponible.";
  const mem = ctx.memory;
  if (!mem || !mem.memorySummary || mem.memorySummary === "Sin memoria disponible todavía.") {
    return "📭 Sin memoria acumulada todavía.\nCompleta check-ins diarios en Autopilot → Daily Learning para generar patrones.";
  }
  const lines = [
    "*Memoria Jarvis · Comprimida*",
    "",
    mem.memorySummary,
    "",
    `_Fuentes: health ${mem.sources && mem.sources.health ? "✅" : "⚠️"} · portfolio ✅ · ${mem.sources ? mem.sources.dailyLearning : 0}d histórico · ${mem.sources && mem.sources.patterns ? "patrones ✅" : "patrones ⏳"}_`,
    `_~${mem.tokenEstimate || "?"} tokens_`
  ];
  return lines.join("\n");
}

async function cmdDaily(ctx) {
  if (!ctx.dashboardOnline) return "⚠️ Dashboard offline.";
  const snap = ctx.daily && ctx.daily.snapshot;
  if (!snap) {
    return "📭 Sin snapshot del día todavía.\nGenera uno desde el panel Autopilot → Daily Learning → Generar aprendizaje.";
  }
  const l  = snap.learning || {};
  const ci = snap.checkin  || {};
  const m  = snap.market   || {};
  const lines = [
    `*Daily Learning · ${snap.date || "hoy"}*`,
    `Capacidad trading: *${safeStr(l.tradingCapacity)}*`,
    `Recomendación:     *${safeStr(l.riskRecommendation)}*`
  ];
  if (ci.focus != null) lines.push(`Foco declarado:    ${ci.focus}/10`);
  if (ci.mood  != null) lines.push(`Mood:              ${ci.mood}/10`);
  const habits = [];
  if (ci.workout)          habits.push("workout ✅");
  if (ci.sauna)            habits.push("sauna ✅");
  if (ci.cannabis)         habits.push("cannabis ⚠️");
  if (ci.alcohol)          habits.push("alcohol ⚠️");
  if (habits.length)       lines.push(`Hábitos:           ${habits.join(", ")}`);
  if (m.portfolioMXN)      lines.push(`\nPortafolio hoy:  $${Number(m.portfolioMXN).toLocaleString("es-MX")} MXN (${(m.gainPct >= 0 ? "+" : "") + Number(m.gainPct || 0).toFixed(1)}%)`);
  if (l.nextDaySuggestions && l.nextDaySuggestions.length) {
    lines.push(`\n💡 *Para mañana:*`);
    l.nextDaySuggestions.slice(0, 3).forEach(s => lines.push(`• ${s}`));
  }
  if (ci.tradingWins)      lines.push(`\n✅ Wins: ${ci.tradingWins}`);
  if (ci.tradingMistakes)  lines.push(`⚠️ Errores: ${ci.tradingMistakes}`);
  lines.push("\n_No es consejo médico ni financiero._");
  return lines.join("\n");
}

function cmdHelp() {
  return `*Jarvis · Cordelius OS*
Copiloto personal de Pedro.

*Comandos:*
/status — estado del sistema Cordelius
/health — WHOOP readiness y modo operativo
/portfolio — resumen del portafolio
/memory — memoria Jarvis comprimida
/daily — daily learning de hoy
/help — esta lista

O escríbeme cualquier pregunta sobre:
• Tu portafolio (costos, ganancias, riesgo)
• Salud y readiness (WHOOP)
• Decisiones educativas de inversión
• Estado del sistema

_Sistema educativo — sin trading real. No asesoría financiera ni médica._`;
}

// ── Telegram API ───────────────────────────────────────────────────────────────
function telegramPost(method, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${TELEGRAM_TOKEN}/${method}`,
      method:   "POST",
      headers:  {
        "content-type":   "application/json",
        "content-length": Buffer.byteLength(payload)
      },
      timeout: 15000
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function sendMessage(chatId, text, parseMode = "Markdown") {
  // Telegram max message length: 4096 chars
  const safeText = String(text || "").slice(0, 4096);
  return telegramPost("sendMessage", {
    chat_id:    chatId,
    text:       safeText,
    parse_mode: parseMode
  }).catch(() => null);
}

function getUpdates(offset) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${TELEGRAM_TOKEN}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}&allowed_updates=%5B%22message%22%5D`,
      method:   "GET",
      timeout:  (POLL_TIMEOUT_S + 10) * 1000
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Message router ────────────────────────────────────────────────────────────
async function handleUpdate(update) {
  const msg = update && update.message;
  if (!msg || !msg.text) return;

  const chatId   = msg.chat.id;
  const rawText  = msg.text.trim();
  const cmdToken = rawText.split(/\s+/)[0].toLowerCase().replace(/@[^\s]*$/, "");

  // /start and /help never need Cordelius context
  if (cmdToken === "/start" || cmdToken === "/help") {
    return sendMessage(chatId, cmdHelp());
  }

  // Fetch Cordelius context (parallel, 5s timeout per source)
  const ctx = await buildTelegramJarvisContext();

  let reply = "";

  if      (cmdToken === "/status")    reply = await cmdStatus(ctx);
  else if (cmdToken === "/health")    reply = await cmdHealth(ctx);
  else if (cmdToken === "/portfolio") reply = await cmdPortfolio(ctx);
  else if (cmdToken === "/memory")    reply = await cmdMemory(ctx);
  else if (cmdToken === "/daily")     reply = await cmdDaily(ctx);
  else {
    // Free-form message → route through Jarvis+Claude with full Cordelius context
    const systemPrompt = buildSystemPrompt(ctx);
    const aiReply = await callClaude(systemPrompt, rawText);
    if (aiReply) {
      reply = aiReply;
    } else if (!ctx.dashboardOnline) {
      reply = "⚠️ Cordelius offline y ANTHROPIC\\_API\\_KEY no disponible.\nVerifica que `dashboard.js` esté corriendo: `bash scripts/health_check.sh`";
    } else {
      // Dashboard online but no API key — give a local context reply
      const p = ctx.context && ctx.context.context && ctx.context.context.portfolio;
      if (p && !p.error) {
        reply = `Cordelius activo.\nPortafolio: $${Number(p.totalMXN || 0).toLocaleString("es-MX")} MXN (${(p.gainPct >= 0 ? "+" : "") + p.gainPct}%).\nCripto: ${p.cryptoPct}%. Régimen: ${p.regime}.\nUsa /help para ver comandos disponibles.`;
      } else {
        reply = "Cordelius activo. Usa /help para ver comandos disponibles.";
      }
    }
  }

  if (reply) {
    // Try Markdown first; fall back to plain text if Telegram rejects it
    const result = await sendMessage(chatId, reply, "Markdown");
    if (result && !result.ok) {
      await sendMessage(chatId, reply.replace(/[*_`\[\]]/g, ""), "");
    }
  }
}

// ── Main polling loop ─────────────────────────────────────────────────────────
async function pollLoop() {
  let offset = 0;
  let retries = 0;
  console.log("[Jarvis Bot] Escuchando mensajes de Telegram...");

  while (true) {
    try {
      const result = await getUpdates(offset);
      retries = 0;

      if (result && result.ok && Array.isArray(result.result)) {
        for (const update of result.result) {
          if (typeof update.update_id === "number") {
            if (update.update_id >= offset) offset = update.update_id + 1;
          }
          // Handle each update asynchronously — don't block the poll loop
          handleUpdate(update).catch(e => {
            console.error("[Jarvis Bot] handleUpdate error:", e.message);
          });
        }
      } else if (result && !result.ok) {
        console.error("[Jarvis Bot] Telegram API error:", result.description || JSON.stringify(result));
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch(e) {
      retries++;
      const wait = Math.min(retries * 3000, 30000);
      console.error(`[Jarvis Bot] Poll error (retry ${retries}):`, e.message);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

pollLoop();
