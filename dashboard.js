const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const QUIVER_API_KEY = process.env.QUIVER_API_KEY || "";
const PAC_API_KEY = process.env.PAC_API_KEY || null;
const QUIVER_CACHE_MS = 2 * 60 * 60 * 1000;
// WHOOP vars — read at runtime, never logged
const WHOOP_CONFIGURED = !!(process.env.WHOOP_CLIENT_ID && process.env.WHOOP_CLIENT_SECRET);
// Alpaca — always paper unless explicitly disabled
const ALPACA_PAPER = process.env.ALPACA_PAPER !== "false";
const ALPACA_CONFIGURED = !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);

const SERVER_STARTED_AT = Date.now();
const GIT_COMMIT = (() => {
  try { return require("child_process").execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch (e) { return "unknown"; }
})();

const BOT_FILE = "bot_state.json";
const HISTORY_FILE = "portfolio_history.json";
const CHAT_FILE = "alfredo_chat_history.json";
const SETTINGS_FILE = "cordelius_settings.json";
const INTEL_FILE = "cordelius_intel.json";
const JOURNAL_FILE = "cordelius_journal.json";

const HEALTH_SNAPSHOT_FILE = "data/health_snapshots.json";
const HEALTH_BEHAVIOR_FILE = "data/health_behaviors.json";
const PORTFOLIO_SNAPSHOT_FILE = "data/portfolio_snapshots.json";
const TRADING_DECISION_FILE = "data/trading_decisions.json";
const AUTOPILOT_MEMORY_FILE = "data/autopilot_memory.json";
const CORDELIUS_PROGRESS_FILE = "data/cordelius_progress.json";
const OPPORTUNITY_ENGINE_FILE = "data/opportunity_engine.json";
const OPPORTUNITY_HISTORY_FILE = "data/opportunity_history.json";
const STOCK_RESEARCH_CACHE_FILE = "data/stock_research_cache.json";
const RESEARCH_QUEUE_FILE = "data/research_queue.json";

const POSITION_LEDGER_FILE = "data/position_ledger.json";
const CHANGE_LEDGER_FILE   = "data/change_ledger.json";
const ALERTS_FILE          = "data/cordelius_alerts.json";

const WHOOP_TOKEN_FILE = "whoop_tokens.json";
const WHOOP_CACHE_MS = 5 * 60 * 1000;


function ensureDataDir() {
  try { fs.mkdirSync("data", { recursive: true }); } catch (e) {}
}
function ensureParentDir(file) {
  const dir = String(file || "").split("/").slice(0, -1).join("/");
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }
}
function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJSON(file, data) {
  try {
    ensureParentDir(file);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {}
}
function appendSnapshot(file, entry, limit = 500) {
  const current = loadJSON(file, []);
  const rows = Array.isArray(current) ? current : [];
  rows.push(entry);
  const next = rows.slice(-limit);
  saveJSON(file, next);
  return next;
}

function lastArrayItems(arr, n = 5) {
  return Array.isArray(arr) ? arr.slice(-n).reverse() : [];
}
function uniqueStrings(values) {
  return [...new Set((values || []).map(v => String(v || "").trim().toUpperCase()).filter(Boolean))];
}
function normalizeTickerSymbol(symbol) {
  return String(symbol || "").toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 12);
}
function deterministicTickerScore(symbol, salt = 0) {
  const seed = seedFor(normalizeTickerSymbol(symbol) || "MARKET") + salt;
  return Math.max(1, Math.min(99, Math.round(45 + ((seed % 37) - 12) + ((seed % 11) * 1.5))));
}
ensureDataDir();
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function money(n, currency = "MXN") {
  const x = Number(n || 0);
  if (currency === "USD") return "USD " + x.toFixed(2);
  if (currency === "CRYPTO") return x.toFixed(8);
  var _d = Math.abs(x) >= 1 ? 2 : (Math.abs(x) >= 0.01 ? 4 : 8); return "$" + x.toLocaleString("es-MX", { minimumFractionDigits: _d, maximumFractionDigits: _d }) + " MXN";
}
function pct(n) { const x = Number(n || 0); return (x >= 0 ? "+" : "") + x.toFixed(2) + "%"; }
function nowMX() { return new Date().toLocaleString("es-MX"); }

let settings = loadJSON(SETTINGS_FILE, {
  thinkingEnabled: true, autoRefreshSeconds: 60, themeMode: "neural",

  appName: "Cordelius", assistantName: "Jarvis"

});
const CORDA_APP_NAME = "Cordelius";
const CORDA_APP_SUBTITLE = "Personal intelligence OS";

let quotes = {};
let news = [];
let chatHistory = loadJSON(CHAT_FILE, []);
let portfolioHistory = loadJSON(HISTORY_FILE, []);
let intelItems = loadJSON(INTEL_FILE, []);
let journalEntries = loadJSON(JOURNAL_FILE, []);
let whoopTokens = loadJSON(WHOOP_TOKEN_FILE, null);
let whoopCache = { profile: null, cycle: null, recovery: null, sleep: null, lastFetch: 0, connected: false };
// Warm start: reuse the last persisted WHOOP reading until a live refresh succeeds,
// but only if it is recent (< 6h) — never present stale data as current.
{
  const _wc = loadJSON("whoop_today_cache.json", null);
  if (_wc && typeof _wc === "object" && !Array.isArray(_wc) && _wc.lastFetch && Date.now() - _wc.lastFetch < 6 * 3600 * 1000) {
    whoopCache = { ...whoopCache, ..._wc, lastFetch: 0 };
  }
}
let quiverData = { congressional: [], insider: [], contracts: [], lastFetch: 0, configured: false, error: null };
let quiverDataFull = { congressional: [], insider: [], contracts: [] };

const FX_USD_MXN = Number(process.env.USD_MXN) || 18.50;

const PORTFOLIO = [
  { source: "GBM", category: "Acciones SIC", symbol: "AAPL", display: "AAPL *", name: "Apple Computer Inc.", units: 1, currency: "MXN", valueManual: 5450.00, costManual: 2640.01, brokerGainPct: 106.44, logo: "AA", color: "#0f172a", liveTicker: "AAPL", type: "stock" },
  { source: "GBM", category: "Acciones Mexico", symbol: "BBVA", display: "BBVA *", name: "Banco Bilbao Vizcaya", units: 11, currency: "MXN", valueManual: 4400.00, costManual: 1811.70, brokerGainPct: 142.87, logo: "BB", color: "#0069aa", liveTicker: "BBVA.MX", type: "stock_mx" },
  { source: "Plata", category: "Acciones USA", symbol: "MSFT", display: "MSFT", name: "Microsoft", units: 0.12, currency: "USD", valueManual: 52.07, costManual: 49.88, brokerGainPct: 4.39, logo: "MS", color: "#64748b", liveTicker: "MSFT", type: "stock" },
  { source: "Plata", category: "Acciones USA", symbol: "GEV", display: "GEV", name: "GE Vernova Inc.", units: 0.023, currency: "USD", valueManual: 22.10, costManual: 24.95, brokerGainPct: -11.40, logo: "GE", color: "#14532d", liveTicker: "GEV", type: "stock" },
  { source: "Plata", category: "Acciones USA", symbol: "IREN", display: "IREN", name: "IREN Limited", units: 0.17, currency: "USD", valueManual: 11.58, costManual: 8.56, brokerGainPct: 35.21, logo: "IR", color: "#64748b", liveTicker: "IREN", type: "stock" },
  { source: "Plata", category: "Acciones USA", symbol: "PLTR", display: "PLTR", name: "Palantir Technologies", units: 0.016, currency: "USD", valueManual: 2.41, costManual: 2.03, brokerGainPct: 18.93, logo: "PL", color: "#111827", liveTicker: "PLTR", type: "stock" },
  { source: "Plata", category: "Acciones USA", symbol: "AEP", display: "AEP", name: "American Electric Power", units: 0.0086, currency: "USD", valueManual: 1.08, costManual: 1.00, brokerGainPct: 8.09, logo: "AE", color: "#b91c1c", liveTicker: "AEP", type: "stock" },
  { source: "Plata", category: "Acciones USA", symbol: "UNH", display: "UNH", name: "UnitedHealth", units: 0.0027, currency: "USD", valueManual: 1.02, costManual: 1.00, brokerGainPct: 2.04, logo: "UH", color: "#1e3a8a", liveTicker: "UNH", type: "stock" },
  { source: "Plata", category: "Acciones USA", symbol: "SSYS", display: "SSYS", name: "Stratasys Inc.", units: 0.094, currency: "USD", valueManual: 0.9889, costManual: 1.00, brokerGainPct: -1.10, logo: "ST", color: "#0f3b5c", liveTicker: "SSYS", type: "stock" },
  { source: "Plata", category: "Acciones USA", symbol: "PATH", display: "PATH", name: "UiPath Inc.", units: 0.058, currency: "USD", valueManual: 0.6937, costManual: 1.00, brokerGainPct: -30.63, logo: "Ui", color: "#ea580c", liveTicker: "PATH", type: "stock" },
  { source: "Plata", category: "ETFs", symbol: "COPX", display: "COPX", name: "Global X Copper Miners ETF", units: 0.22, currency: "USD", valueManual: 20.26, costManual: 19.99, brokerGainPct: 1.33, logo: "Cu", color: "#f97316", liveTicker: "COPX", type: "etf" },
  { source: "Plata", category: "Accion regalo", symbol: "NFLX", display: "NFLX", name: "Netflix", units: 0.059, currency: "USD", valueManual: 4.93, costManual: 5.00, brokerGainPct: -1.28, logo: "N", color: "#991b1b", liveTicker: "NFLX", type: "stock" },
  { source: "Bitso", category: "Cripto", symbol: "XRP", display: "XRP", name: "Ripple", units: 985, currency: "MXN", valueManual: 21108.94, costManual: 25182.00, brokerGainPct: -16.20, logo: "X", color: "#334155", liveTicker: "XRP", type: "crypto" },
  { source: "Bitso", category: "Cripto", symbol: "BTC", display: "BTC", name: "Bitcoin", units: 0.01409337, currency: "MXN", valueManual: 16598.04, costManual: 10855.00, brokerGainPct: 52.90, logo: "B", color: "#f59e0b", liveTicker: "BTC", type: "crypto" },
  { source: "Bitso", category: "Cripto", symbol: "ETH", display: "ETH", name: "Ether", units: 0.17944736, currency: "MXN", valueManual: 5969.68, costManual: 4606.00, brokerGainPct: 29.60, logo: "E", color: "#818cf8", liveTicker: "ETH", type: "crypto" },
  { source: "Bitso", category: "Cripto", symbol: "BCH", display: "BCH", name: "Bitcoin Cash", units: 0.08984445, currency: "MXN", valueManual: 444.82, costManual: 430.00, brokerGainPct: 3.40, logo: "BC", color: "#10b981", liveTicker: "BCH", type: "crypto" },
  { source: "Bitso", category: "Cripto", symbol: "MANA", display: "MANA", name: "Decentraland", units: 269.4500848, currency: "MXN", valueManual: 372.65, costManual: 360.00, brokerGainPct: 3.51, logo: "MA", color: "#fb7185", liveTicker: "MANA", type: "crypto" },
  { source: "Bitso", category: "Cripto", symbol: "SHIB", display: "SHIB", name: "Shiba Inu", units: 261349.4653, currency: "MXN", valueManual: 23.99, costManual: 25.00, brokerGainPct: -4.04, logo: "SH", color: "#f97316", liveTicker: "SHIB", type: "crypto" }
];

const TV_SYMBOL = {
  AAPL: "NASDAQ:AAPL", BBVA: "BMV:BBVA", MSFT: "NASDAQ:MSFT", GEV: "NYSE:GEV", IREN: "NASDAQ:IREN",
  PLTR: "NASDAQ:PLTR", AEP: "NASDAQ:AEP", UNH: "NYSE:UNH", SSYS: "NASDAQ:SSYS", PATH: "NYSE:PATH",
  COPX: "AMEX:COPX", NFLX: "NASDAQ:NFLX",
  BTC: "BITSTAMP:BTCUSD", ETH: "BITSTAMP:ETHUSD", BCH: "COINBASE:BCHUSD",
  XRP: "BINANCE:XRPUSDT", MANA: "BINANCE:MANAUSDT", SHIB: "BINANCE:SHIBUSDT"
};

const MARKET_WATCHLIST = ["NVDA","TSLA","AMD","META","GOOGL","AMZN","AAPL","MSFT","PLTR","NFLX","SMCI","COIN","MSTR","SOFI","HOOD","RIVN","NIO","BABA","UNH","LLY","AVGO","QQQ","SPY"];

let bot = loadJSON(BOT_FILE, {
  initialCapital: 1000, cash: 1000, positions: {}, history: [], equityHistory: [], thoughts: [],
  running: true, totalRealizedPnl: 0, maxDrawdown: 0, tradesCount: 0, lastTick: null
});

function apiGet(url) {
  return new Promise(resolve => {
    // CoinGecko (y otros con Cloudflare) responden 403 sin User-Agent.
    const req = https.get(url, { headers: { "User-Agent": "Cordelius/1.0 (personal dashboard)", Accept: "application/json" } }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

function apiGetAuth(url, token) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const opts = { hostname: parsed.hostname, port: 443, path: parsed.pathname + parsed.search, method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" } };
      const req = https.request(opts, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.setTimeout(12000, () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

function apiPost(url, bodyStr, extraHeaders = {}) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const opts = { hostname: parsed.hostname, port: 443, path: parsed.pathname, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(bodyStr), ...extraHeaders } };
      const req = https.request(opts, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.setTimeout(12000, () => { req.destroy(); resolve(null); });
      req.write(bodyStr);
      req.end();
    } catch { resolve(null); }
  });
}

// ── WHOOP OAuth + API ─────────────────────────────────────────────────────────
const WHOOP_API_BASE = "https://api.prod.whoop.com";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

// Non-secret WHOOP health reason for diagnostics: token_missing, token_expired_refresh_failed,
// api_unavailable, no_today_reading, ok
let whoopStatusReason = whoopTokens && whoopTokens.access_token ? "pending_first_fetch" : "token_missing";

// Tokens saved by older flows have savedAt+expires_in instead of expires_at.
function whoopTokenExpiryMs() {
  if (!whoopTokens) return 0;
  if (whoopTokens.expires_at) return whoopTokens.expires_at;
  if (whoopTokens.savedAt && whoopTokens.expires_in) {
    const base = Date.parse(whoopTokens.savedAt);
    if (Number.isFinite(base)) return base + whoopTokens.expires_in * 1000;
  }
  return 0;
}

async function refreshWhoopToken() {
  if (!whoopTokens || !whoopTokens.refresh_token) return false;
  const cid = process.env.WHOOP_CLIENT_ID || "";
  const csec = process.env.WHOOP_CLIENT_SECRET || "";
  if (!cid || !csec) return false;
  try {
    const body = [
      "grant_type=refresh_token",
      "refresh_token=" + encodeURIComponent(whoopTokens.refresh_token),
      "client_id=" + encodeURIComponent(cid),
      "client_secret=" + encodeURIComponent(csec),
      "scope=" + encodeURIComponent("offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout")
    ].join("&");
    const result = await apiPost(WHOOP_TOKEN_URL, body);
    if (result && result.access_token) {
      whoopTokens = { ...whoopTokens, ...result, expires_at: Date.now() + (result.expires_in || 3600) * 1000 };
      saveJSON(WHOOP_TOKEN_FILE, whoopTokens);
      return true;
    }
  } catch (e) { console.log("WHOOP refresh error:", e.message); }
  return false;
}

// WHOOP rotates refresh tokens (single-use): concurrent refreshes race and all but
// the first fail. Share one in-flight refresh across parallel fetchWhoopAPI calls.
let whoopRefreshInFlight = null;
function refreshWhoopTokenOnce() {
  if (!whoopRefreshInFlight) {
    whoopRefreshInFlight = refreshWhoopToken().finally(() => { whoopRefreshInFlight = null; });
  }
  return whoopRefreshInFlight;
}

async function fetchWhoopAPI(path) {
  if (!whoopTokens || !whoopTokens.access_token) { whoopStatusReason = "token_missing"; return null; }
  const expiry = whoopTokenExpiryMs();
  if (expiry && Date.now() > expiry - 60000) {
    const ok = await refreshWhoopTokenOnce();
    if (!ok) { whoopStatusReason = "token_expired_refresh_failed"; return null; }
  }
  return apiGetAuth(WHOOP_API_BASE + path, whoopTokens.access_token);
}

async function refreshWhoopCache() {
  if (!whoopTokens || !whoopTokens.access_token) {
    whoopCache.connected = false;
    return;
  }

  if (Date.now() - whoopCache.lastFetch < WHOOP_CACHE_MS) return;

  try {
    const [profile, cycle, recovery, sleep] = await Promise.all([
      fetchWhoopAPI("/developer/v2/user/profile/basic"),
      fetchWhoopAPI("/developer/v2/cycle?limit=1"),
      fetchWhoopAPI("/developer/v2/recovery?limit=1"),
      fetchWhoopAPI("/developer/v2/activity/sleep?limit=1")
    ]);

    whoopCache.profile = profile;
    whoopCache.cycle = cycle;
    whoopCache.recovery = recovery;
    whoopCache.sleep = sleep;
    whoopCache.connected = !!(
      (cycle && cycle.records && cycle.records.length) ||
      (recovery && recovery.records && recovery.records.length) ||
      (sleep && sleep.records && sleep.records.length)
    );
    if (whoopCache.connected) whoopStatusReason = "ok";
    else if (!profile && !cycle && !recovery && !sleep) {
      if (whoopStatusReason !== "token_expired_refresh_failed" && whoopStatusReason !== "token_missing") whoopStatusReason = "api_unavailable";
    } else whoopStatusReason = "no_today_reading";
    whoopCache.lastFetch = Date.now();

    saveJSON("whoop_today_cache.json", {
      lastFetch: whoopCache.lastFetch,
      connected: whoopCache.connected,
      profile,
      cycle,
      recovery,
      sleep
    });
  } catch (e) {
    console.log("WHOOP refresh error:", e.message);
    whoopCache.connected = false;
  }
}

function assetLiveValue(a) {
  if (a.type === "crypto") {
    const cq = cryptoQuotes[a.symbol];
    if (cq && Number.isFinite(cq.priceMXN) && cq.priceMXN > 0) return cq.priceMXN * a.units; // MXN live (Bitso/CoinGecko)
    return a.valueManual;
  }
  if (a.source === "GBM" || a.source === "Bitso" || a.currency === "MXN") return a.valueManual;
  const q = quotes[a.symbol]; if (q && Number.isFinite(q.value)) return q.value; return a.valueManual;
}
function assetValueMXN(a) { const v = assetLiveValue(a); return a.currency === "USD" ? v * FX_USD_MXN : v; }
function assetCostMXN(a) { const c = a.costManual || 0; return a.currency === "USD" ? c * FX_USD_MXN : c; }
function assetGainPct(a) {
  if (Number.isFinite(a.brokerGainPct)) return a.brokerGainPct;
  const c = assetCostMXN(a), v = assetValueMXN(a);
  return c ? ((v - c) / c) * 100 : 0;
}
function assetRisk(a) {
  if (a.type === "crypto") return "ALTO";
  if (["TSLA", "NVDA", "PLTR", "IREN", "PATH", "SSYS"].includes(a.symbol)) return "MEDIO/ALTO";
  if (a.type === "etf") return "MEDIO";
  return "MEDIO";
}

// ---- INDICADORES SIMULADOS DETERMINISTAS ----
function seedFor(sym) { return sym.split("").reduce((s, c) => s + c.charCodeAt(0), 0); }
function indicators(a) {
  const q = quotes[a.symbol] || {};
  const day = Number(q.day || 0);
  const seed = seedFor(a.symbol);
  const gain = assetGainPct(a);
  let rsi = 50 + day * 4 + (gain / 12) + ((seed % 11) - 5);
  rsi = Math.max(8, Math.min(92, rsi));
  const macd = +(day * 0.6 + ((seed % 7) - 3) * 0.2).toFixed(2);
  const momentum = +(day * 1.4 + (gain / 25)).toFixed(2);
  const volatility = a.type === "crypto" ? "ALTA" : (Math.abs(day) > 2 ? "ALTA" : Math.abs(day) > 0.8 ? "MEDIA" : "BAJA");
  const trend = momentum > 1 ? "ALCISTA" : momentum < -1 ? "BAJISTA" : "LATERAL";
  return { rsi: Math.round(rsi), macd, momentum, volatility, trend };
}

function assetScore(a) {
  const q = quotes[a.symbol] || {};
  const day = Number(q.day || 0);
  const gain = assetGainPct(a);
  const ind = indicators(a);
  let score = 50;
  score += Math.max(-12, Math.min(12, day * 3));
  score += Math.max(-18, Math.min(18, gain / 8));
  score += Math.max(-8, Math.min(8, (ind.rsi - 50) / 6));
  if (assetRisk(a) === "ALTO") score -= 6;
  if (assetRisk(a) === "MEDIO/ALTO") score -= 3;
  if (a.type === "etf") score += 3;
  return Math.max(1, Math.min(99, Math.round(score)));
}

function alfredoAction(a) {
  const score = assetScore(a);
  const gain = assetGainPct(a);
  const ind = indicators(a);
  let action = "MANTENER", color = "#ffd166", reasons = [];
  if (gain > 100 && ind.momentum > 1) { action = "TOMAR GANANCIA PARCIAL"; color = "#3b9dff"; reasons = ["Ganancia acumulada de " + gain.toFixed(0) + "%", "Momentum aun positivo", "Asegurar parte reduce riesgo"]; }
  else if (score >= 68) { action = "MANTENER / MOMENTUM"; color = "#00ff99"; reasons = ["Score alto " + score + "/100", "Tendencia " + ind.trend.toLowerCase(), "RSI en " + ind.rsi]; }
  else if (score <= 35) { action = "VIGILAR / NO PROMEDIAR"; color = "#ff4d6d"; reasons = ["Score debil " + score + "/100", "Tendencia " + ind.trend.toLowerCase(), "Esperar confirmacion antes de actuar"]; }
  else if (ind.momentum < -3 && score > 45) { action = "BUY DIP PEQUENO"; color = "#3b9dff"; reasons = ["Caida fuerte pero score decente", "Posible rebote", "Tamano pequeno y con stop"]; }
  else { action = "MANTENER"; color = "#ffd166"; reasons = ["Sin catalizador claro", "Tendencia " + ind.trend.toLowerCase(), "Paciencia"]; }
  return { action, color, reasons, score };
}

function assetSignal(a) { return alfredoAction(a).action; }

function tradeZones(a) {
  const q = quotes[a.symbol] || {};
  const price = Number(q.price || (assetLiveValue(a) / Math.max(a.units, 1e-8)));
  const atrLike = Math.max(price * 0.035, price * Math.abs(Number(q.day || 1)) / 100);
  return { price, buy: price - atrLike * 1.2, sell: price + atrLike * 1.8, stop: price - atrLike * 2.4 };
}

function portfolioValue() {
  const assets = PORTFOLIO.map(a => {
    const valueMXN = assetValueMXN(a);
    const costMXN = assetCostMXN(a);
    const gainMXN = valueMXN - costMXN;
    const gainPct = costMXN ? (gainMXN / costMXN) * 100 : assetGainPct(a);
    const q = quotes[a.symbol] || {};
    const cq = a.type === "crypto" ? cryptoQuotes[a.symbol] : null;
    const tech = assetTechnical(a);
    const simInd = indicators(a); // heurístico seeded (legacy)
    const quoteSource = assetQuoteSource(a);
    // `ind` (legacy UI) usa valores reales cuando existen; si no, el simulado de siempre.
    const ind = tech
      ? { rsi: tech.rsi, macd: +tech.macd.macd.toFixed(2), momentum: tech.momentum, volatility: tech.volatility, trend: tech.trend }
      : simInd;
    const indicatorsFull = tech
      ? { rsi: tech.rsi, macd: tech.macd.macd, signal: tech.macd.signal, histogram: tech.macd.histogram, momentum: tech.momentum, trend: tech.trend, volatility: tech.volatility, source: tech.source, status: "LIVE" }
      : { rsi: simInd.rsi, macd: simInd.macd, signal: null, histogram: null, momentum: simInd.momentum, trend: simInd.trend, volatility: simInd.volatility, source: "heuristic-seed", status: "SIMULATED" };
    return { ...a, liveValue: assetLiveValue(a), valueMXN, costMXN, gainMXN, gainPct, day: cq ? cq.day : Number(q.day || 0), score: assetScore(a), risk: assetRisk(a), signal: assetSignal(a), zones: tradeZones(a), quoteSource, priceQuoteStatus: quoteSource === "manual" ? "MANUAL" : "LIVE", indicatorStatus: indicatorsFull.status, indicatorSource: indicatorsFull.source, ind, indicators: indicatorsFull };
  });
  const totalValueMXN = assets.reduce((s, a) => s + a.valueMXN, 0);
  const totalCostMXN = assets.reduce((s, a) => s + a.costMXN, 0);
  const totalGainMXN = totalValueMXN - totalCostMXN;
  const totalGainPct = totalCostMXN ? (totalGainMXN / totalCostMXN) * 100 : 0;
  return { assets, totalValueMXN, totalCostMXN, totalGainMXN, totalGainPct };
}

function marketRegime() {
  const arr = Object.values(quotes).filter(q => q.ok);
  const avg = arr.length ? arr.reduce((s, q) => s + Number(q.day || 0), 0) / arr.length : 0;
  if (avg > 1.2) return { label: "RISK-ON", avg, color: "#00ff99", detail: "Compradores dominan, cuidado con FOMO." };
  if (avg < -1.2) return { label: "RISK-OFF", avg, color: "#ff4d6d", detail: "Mercado defensivo; reduce impulsos." };
  return { label: "NEUTRAL", avg, color: "#ffd166", detail: "Sin direccion clara; conviene paciencia." };
}

function savePortfolioPoint() {
  const pv = portfolioValue();
  portfolioHistory.push({ t: Date.now(), total: pv.totalValueMXN, pnl: pv.totalGainPct });
  // Retención multi-día: antes el cap de 600 puntos/minuto borraba todo lo
  // anterior a ~10h. Ahora: resolución por minuto las últimas 24h, 1 punto
  // por hora para lo más viejo. Se conserva el rango completo de fechas.
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const old = portfolioHistory.filter(p => p.t < dayAgo);
  const recent = portfolioHistory.filter(p => p.t >= dayAgo);
  const hourly = [];
  let lastHour = null;
  for (const p of old) {
    const hr = Math.floor(p.t / 3600000);
    if (hr !== lastHour) { hourly.push(p); lastHour = hr; }
  }
  portfolioHistory = hourly.concat(recent).slice(-2000);
  saveJSON(HISTORY_FILE, portfolioHistory);
}

// ── ANTI-REPETICIÓN / HISTORIA REAL ──
// Reduce series con puntos casi idénticos: 1 representativo por bucket
// temporal, y solo si el valor cambió lo suficiente vs el último mostrado.
function dedupeTimeline(points, { bucketMs = 6 * 3600 * 1000, minDeltaPct = 0.4, max = 3, key = "total" } = {}) {
  const out = [];
  let lastBucket = null, lastVal = null;
  for (const p of points) {
    if (!p || !Number.isFinite(p.t)) continue;
    const bucket = Math.floor(p.t / bucketMs);
    const v = Number(p[key]);
    const changed = lastVal === null || Math.abs((v - lastVal) / (lastVal || 1)) * 100 >= minDeltaPct;
    if (bucket !== lastBucket && (changed || out.length === 0)) {
      out.push(p); lastBucket = bucket; lastVal = v;
    }
  }
  // siempre incluir el último punto si difiere del último mostrado
  const last = points[points.length - 1];
  if (last && out[out.length - 1] !== last && lastVal !== null && Math.abs((Number(last[key]) - lastVal) / (lastVal || 1)) * 100 >= minDeltaPct) out.push(last);
  return out.slice(-max);
}

// Historia de equity multi-día: ancla diaria desde data/portfolio_snapshots.json
// (summary.equity, último de cada día) + intradía de hoy desde portfolioHistory.
// No inventa fechas: si solo hay un día, lo dice (mode: "limited").
function buildDailyEquityHistory() {
  const points = [];
  const snaps = loadJSON(PORTFOLIO_SNAPSHOT_FILE, []);
  const byDay = {};
  for (const s of (Array.isArray(snaps) ? snaps : [])) {
    const ts = Date.parse(s.timestamp || (s.summary && s.summary.timestamp) || "");
    const eq = s.summary && Number(s.summary.equity);
    if (!Number.isFinite(ts) || !Number.isFinite(eq)) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (!byDay[day] || ts > byDay[day].t) byDay[day] = { t: ts, total: eq, pnl: Number(s.summary.pnl) || 0 };
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [day, p] of Object.entries(byDay)) if (day !== today) points.push(p);
  // intradía de hoy: 1 punto por hora + el último
  let lastHour = null;
  for (const p of portfolioHistory) {
    const hr = Math.floor(p.t / 3600000);
    if (hr !== lastHour) { points.push(p); lastHour = hr; }
  }
  const lastLive = portfolioHistory[portfolioHistory.length - 1];
  if (lastLive && points[points.length - 1] !== lastLive) points.push(lastLive);
  points.sort((a, b) => a.t - b.t);
  const days = new Set(points.map(p => new Date(p.t).toISOString().slice(0, 10)));
  return {
    points,
    rangeDays: days.size,
    mode: days.size >= 2 ? "real" : "limited",
    firstDate: points.length ? new Date(points[0].t).toISOString().slice(0, 10) : null,
    lastDate: points.length ? new Date(points[points.length - 1].t).toISOString().slice(0, 10) : null
  };
}

// ---- CHART SVG — ejes visibles, tooltips, tabla de datos ----
function spark(data, opts = {}) {
  const key = opts.key || "total";
  const color = opts.color || "#3b9dff";
  const height = opts.height || 260;
  const showTable = opts.showTable !== false; // default true for big charts
  let rawData = (data || []).map(x => typeof x === "number" ? { v: x, t: null } : { v: Number(x[key]), t: x.t || null }).filter(d => Number.isFinite(d.v));
  if (rawData.length < 2) {
    return `<div class="chart-wrap" style="min-height:${height}px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,.03);border:1px solid rgba(120,160,210,.1);border-radius:14px;gap:8px;padding:20px">
      <div style="font-size:32px">📊</div>
      <div style="color:var(--muted);font-size:13px;text-align:center">Sin historial suficiente<br><small>Los datos aparecerán después del primer refresh automático</small></div>
    </div>`;
  }
  const vals = rawData.map(d => d.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const padTop = 28, padBottom = 40, padLeft = 72, plotH = height - padTop - padBottom;
  const plotW = 940;
  const gid = "g" + Math.floor(Math.random() * 9999999);
  const xy = rawData.map((d, i) => ({
    x: padLeft + (i / Math.max(1, rawData.length - 1)) * plotW,
    y: padTop + (1 - ((d.v - min) / range)) * plotH,
    v: d.v, t: d.t
  }));
  const pts = xy.map(p => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ");
  const area = padLeft + "," + (height - padBottom) + " " + pts + " " + (padLeft + plotW) + "," + (height - padBottom);
  const last = vals[vals.length - 1], first = vals[0];
  const delta = first ? ((last - first) / Math.abs(first)) * 100 : 0;
  const fmtV = v => v >= 10000 ? "$" + (v / 1000).toFixed(1) + "k" : v >= 100 ? v.toFixed(0) : v.toFixed(2);

  // Y-axis: 5 horizontal gridlines with labels
  const yTicks = [];
  for (let i = 0; i <= 4; i++) {
    const v = min + (i / 4) * range;
    const y = padTop + (1 - (i / 4)) * plotH;
    yTicks.push(`<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${padLeft + plotW}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.07)"/>`);
    yTicks.push(`<text x="${padLeft - 5}" y="${(y + 5).toFixed(1)}" fill="#9fb3c8" font-size="15" text-anchor="end">${fmtV(v)}</text>`);
  }

  // X-axis: up to 7 labels. Si el rango es intradía (<36h) mostrar hora;
  // multi-día mostrar fecha — evita "jun 11, jun 11, jun 11…" repetido.
  const tsAll = rawData.filter(d => d.t != null).map(d => d.t);
  const spanMs = tsAll.length ? Math.max(...tsAll) - Math.min(...tsAll) : 0;
  const intraday = spanMs > 0 && spanMs < 36 * 3600 * 1000;
  const fmtT = t => intraday
    ? new Date(t).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    : new Date(t).toLocaleDateString("es-MX", { month: "short", day: "numeric" });
  const xTicks = [];
  const xStep = Math.ceil(rawData.length / 6);
  rawData.forEach((d, i) => {
    if (i % xStep !== 0 && i !== rawData.length - 1) return;
    const p = xy[i];
    const label = d.t ? fmtT(d.t) : String(i + 1);
    xTicks.push(`<text x="${p.x.toFixed(1)}" y="${height - 6}" fill="#9fb3c8" font-size="13" text-anchor="middle">${label}</text>`);
  });

  // Dots with SVG <title> tooltips
  const dots = xy.map((p, i) => {
    if (i !== 0 && i !== rawData.length - 1 && i % Math.ceil(rawData.length / 8) !== 0) return "";
    const tooltip = (p.t ? (intraday ? new Date(p.t).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : new Date(p.t).toLocaleDateString("es-MX")) + " · " : "") + fmtV(p.v).replace("$", "$");
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${color}" stroke="#02040a" stroke-width="2"><title>${tooltip}</title></circle>`;
  }).join("");

  // Recent values table (last 6 points)
  let tableHtml = "";
  if (showTable && rawData.some(d => d.t != null) && rawData.length >= 3) {
    const recent = rawData.slice(-6);
    const rows = recent.map(d => {
      const dateStr = d.t ? (intraday
        ? new Date(d.t).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) + " hoy"
        : new Date(d.t).toLocaleDateString("es-MX", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })) : "-";
      return `<tr><td style="color:var(--muted);font-size:11px;padding:4px 8px">${dateStr}</td><td style="font-weight:700;text-align:right;padding:4px 8px">${fmtV(d.v)}</td></tr>`;
    }).join("");
    tableHtml = `<div style="overflow-x:auto;margin-top:6px"><table style="width:auto;font-size:12px;border-collapse:collapse"><tbody>${rows}</tbody></table></div>`;
  }

  return `<div class="chart-wrap">
<svg viewBox="0 0 ${padLeft + plotW + 20} ${height}" class="chart" style="overflow:visible">
  <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0%" stop-color="${color}" stop-opacity=".32"/>
    <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
  </linearGradient></defs>
  <line x1="${padLeft}" y1="${height - padBottom}" x2="${padLeft + plotW}" y2="${height - padBottom}" stroke="rgba(255,255,255,.18)"/>
  <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" stroke="rgba(255,255,255,.18)"/>
  ${yTicks.join("")}
  ${xTicks.join("")}
  <text x="${padLeft + plotW / 2}" y="22" fill="${delta >= 0 ? "#00ff99" : "#ff4d6d"}" font-size="17" text-anchor="middle" font-weight="bold">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%</text>
  <polygon points="${area}" fill="url(#${gid})"/>
  <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
</svg>${tableHtml}</div>`;
}

function miniSpark(symbol, color = "#3b9dff") {
  const seed = seedFor(symbol);
  const vals = []; let v = 50 + (seed % 25);
  for (let i = 0; i < 20; i++) { v += Math.sin((i + seed) / 2) * 2 + ((seed % 7) - 3) * 0.18; vals.push(v); }
  return spark(vals, { color, height: 115, showTable: false });
}

// ---- QUOTES REALES — Finnhub /quote para tickers USD ----
// El boot y el interval ya invocaban refreshQuotes(); la función no existía y los
// precios quedaban congelados en valueManual + pseudo-quotes seeded.
let quotesLastFetch = 0;
let quotesLastError = null;
async function refreshQuotes() {
  if (!FINNHUB_API_KEY) { quotesLastError = "no_api_key"; return; }
  const targets = PORTFOLIO.filter(a => a.currency === "USD" && a.liveTicker && (a.type === "stock" || a.type === "etf"));
  let okCount = 0;
  for (const a of targets) {
    const q = await apiGet(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(a.liveTicker)}&token=${FINNHUB_API_KEY}`);
    if (q && Number.isFinite(q.c) && q.c > 0) {
      quotes[a.symbol] = { price: q.c, value: q.c * a.units, day: Number.isFinite(q.dp) ? q.dp : 0, ok: true, source: "finnhub", t: Date.now() };
      okCount++;
    }
  }
  if (okCount > 0) { quotesLastFetch = Date.now(); quotesLastError = null; }
  else quotesLastError = "api_unavailable";
}
function quotesFreshness() {
  if (!FINNHUB_API_KEY) return "SIMULATED";
  if (!quotesLastFetch) return "FALLBACK";
  return Date.now() - quotesLastFetch > 30 * 60 * 1000 ? "STALE" : "LIVE";
}

// ---- CRYPTO QUOTES REALES — Bitso público (pares MXN, sin API key) con
// fallback CoinGecko para libros que Bitso no tiene (p.ej. SHIB). Si todo
// falla, el activo conserva valueManual y badge FALLBACK; nunca crashea. ----
let cryptoQuotes = {};            // por símbolo: { priceMXN, day, source, t }
let cryptoQuotesLastFetch = 0;
let cryptoQuotesError = null;
const BITSO_BOOKS = { BTC: "btc_mxn", ETH: "eth_mxn", XRP: "xrp_mxn", BCH: "bch_mxn", MANA: "mana_mxn" };
const COINGECKO_IDS = { BTC: "bitcoin", ETH: "ethereum", XRP: "ripple", BCH: "bitcoin-cash", MANA: "decentraland", SHIB: "shiba-inu" };

async function refreshCryptoQuotes() {
  const symbols = PORTFOLIO.filter(a => a.type === "crypto").map(a => a.symbol);
  let okCount = 0;
  const missing = [];
  for (const sym of symbols) {
    const book = BITSO_BOOKS[sym];
    if (!book) { missing.push(sym); continue; }
    const r = await apiGet(`https://api.bitso.com/v3/ticker/?book=${book}`);
    const p = r && r.success && r.payload ? r.payload : null;
    const last = p ? Number(p.last) : NaN;
    if (Number.isFinite(last) && last > 0) {
      const ch = Number(p.change_24); // Bitso reporta cambio absoluto en MXN
      const day = Number.isFinite(ch) && last - ch !== 0 ? (ch / (last - ch)) * 100 : 0;
      cryptoQuotes[sym] = { priceMXN: last, day: +day.toFixed(2), source: "bitso", t: Date.now() };
      okCount++;
    } else missing.push(sym);
  }
  if (missing.length) {
    const ids = missing.map(s => COINGECKO_IDS[s]).filter(Boolean).join(",");
    if (ids) {
      const cg = await apiGet(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=mxn&include_24hr_change=true`);
      for (const sym of missing) {
        const row = cg && cg[COINGECKO_IDS[sym]];
        if (row && Number.isFinite(row.mxn) && row.mxn > 0) {
          cryptoQuotes[sym] = { priceMXN: row.mxn, day: Number.isFinite(row.mxn_24h_change) ? +row.mxn_24h_change.toFixed(2) : 0, source: "coingecko", t: Date.now() };
          okCount++;
        }
      }
    }
  }
  if (okCount > 0) { cryptoQuotesLastFetch = Date.now(); cryptoQuotesError = null; }
  else cryptoQuotesError = "api_unavailable";
}
function cryptoFreshness() {
  if (!cryptoQuotesLastFetch) return "FALLBACK";
  return Date.now() - cryptoQuotesLastFetch > 30 * 60 * 1000 ? "STALE" : "LIVE";
}
// ---- TECHNICAL INDICATORS REALES — series de cierres diarios ----
// Acciones: Finnhub candle si la key tiene acceso (free tier suele dar 403)
// con fallback a Yahoo chart v8 (público). Cripto: CoinGecko market_chart.
// Sin serie suficiente: NO se inventa; el activo queda SIMULATED/FALLBACK.
let technicalIndicators = {};   // sym → { rsi, macd:{macd,signal,histogram}, momentum, trend, volatility, source, closes, t }
let technicalLastFetch = 0;
let technicalLastError = null;
let finnhubCandlesBlocked = false;
const TECH_TTL_MS = 2 * 3600 * 1000; // velas diarias: refrescar cada 2h basta

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
function computeIndicatorsFromCloses(closes) {
  const c = (closes || []).filter(v => Number.isFinite(v) && v > 0);
  if (c.length < 35) return null; // serie insuficiente: no inventar
  // RSI(14) Wilder
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let avgG = gain / 14, avgL = loss / 14;
  for (let i = 15; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    avgG = (avgG * 13 + Math.max(d, 0)) / 14;
    avgL = (avgL * 13 + Math.max(-d, 0)) / 14;
  }
  const rsi = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  // MACD(12,26,9)
  const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26);
  const macdLine = c.map((_, i) => e12[i] - e26[i]);
  const sigLine = emaSeries(macdLine.slice(25), 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = sigLine[sigLine.length - 1];
  const histogram = macd - signal;
  // Momentum 10 períodos (%)
  const momentum = c.length > 11 ? ((c[c.length - 1] / c[c.length - 11]) - 1) * 100 : 0;
  // Volatilidad: stdev de retornos diarios (últimos 20)
  const rets = [];
  for (let i = Math.max(1, c.length - 20); i < c.length; i++) rets.push(c[i] / c[i - 1] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const stdev = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) * 100;
  const volatility = stdev > 3 ? "ALTA" : stdev > 1.2 ? "MEDIA" : "BAJA";
  // Tendencia: histograma MACD + precio vs SMA20
  const sma20 = c.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const last = c[c.length - 1];
  const trend = histogram > 0 && last > sma20 ? "ALCISTA" : histogram < 0 && last < sma20 ? "BAJISTA" : "LATERAL";
  return {
    rsi: Math.round(rsi),
    macd: { macd: +macd.toFixed(4), signal: +signal.toFixed(4), histogram: +histogram.toFixed(4) },
    momentum: +momentum.toFixed(2),
    trend, volatility,
    closes: c.length
  };
}

async function fetchDailyCloses(a) {
  if (a.type === "crypto") {
    const id = COINGECKO_IDS[a.symbol];
    if (!id) return null;
    const r = await apiGet(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=mxn&days=60&interval=daily`);
    const prices = r && Array.isArray(r.prices) ? r.prices.map(p => Number(p[1])) : null;
    return prices && prices.length >= 35 ? { closes: prices, source: "coingecko" } : null;
  }
  const ticker = a.liveTicker || a.symbol;
  if (FINNHUB_API_KEY && !finnhubCandlesBlocked) {
    const to = Math.floor(Date.now() / 1000), from = to - 86400 * 100;
    const r = await apiGet(`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`);
    if (r && r.s === "ok" && Array.isArray(r.c) && r.c.length >= 35) return { closes: r.c, source: "finnhub" };
    if (r && r.error) finnhubCandlesBlocked = true; // free tier sin acceso: no insistir
  }
  const y = await apiGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`);
  const res = y && y.chart && y.chart.result && y.chart.result[0];
  const closes = res && res.indicators && res.indicators.quote && res.indicators.quote[0] ? (res.indicators.quote[0].close || []).filter(v => Number.isFinite(v)) : null;
  return closes && closes.length >= 35 ? { closes, source: "yahoo" } : null;
}

let technicalLastGapRetry = 0;
async function refreshTechnicalIndicators(force) {
  const now = Date.now();
  const fullDue = force || !technicalLastFetch || now - technicalLastFetch >= TECH_TTL_MS;
  // Entre refresques completos, solo reintentar huecos (máx 1 pasada cada 5 min).
  const targets = fullDue ? PORTFOLIO : PORTFOLIO.filter(a => !assetTechnical(a));
  if (!targets.length) return;
  if (!fullDue && now - technicalLastGapRetry < 5 * 60 * 1000) return;
  if (!fullDue) technicalLastGapRetry = now;
  let ok = 0, fail = 0;
  for (const a of targets) {
    try {
      const serie = await fetchDailyCloses(a);
      const ind = serie ? computeIndicatorsFromCloses(serie.closes) : null;
      if (ind) { technicalIndicators[a.symbol] = { ...ind, source: serie.source, t: Date.now() }; ok++; }
      else fail++;
    } catch (e) { fail++; }
    // CoinGecko free tolera ~5-6 req/min: espaciar las llamadas cripto.
    if (a.type === "crypto") await new Promise(r => setTimeout(r, 7000));
  }
  if (ok > 0) {
    if (fullDue) technicalLastFetch = Date.now();
    technicalLastError = fail ? `${fail}_sin_serie` : null;
  } else if (fullDue) technicalLastError = "no_series_available";
}

function assetTechnical(a) {
  const t = technicalIndicators[a.symbol];
  return t && Date.now() - t.t < 24 * 3600 * 1000 ? t : null; // >24h: ya no es confiable
}
function indicatorsFreshness() {
  const live = PORTFOLIO.filter(a => assetTechnical(a)).length;
  if (live === PORTFOLIO.length && live > 0) return "LIVE";
  if (live > 0) return "MIXED";
  return technicalLastError ? "FALLBACK" : "SIMULATED";
}
function indicatorCounts() {
  const live = PORTFOLIO.filter(a => assetTechnical(a)).length;
  return { live, simulated: PORTFOLIO.length - live };
}

// Fuente real con la que se valuó cada activo (para badges y conteos honestos).
function assetQuoteSource(a) {
  if (a.type === "crypto") { const cq = cryptoQuotes[a.symbol]; return cq && Number.isFinite(cq.priceMXN) ? cq.source : "manual"; }
  if (a.source === "GBM" || a.currency === "MXN") return "manual";
  const q = quotes[a.symbol];
  return q && q.source === "finnhub" && Number.isFinite(q.value) ? "finnhub" : "manual";
}

async function fetchNews() {
  let out = [];
  if (FINNHUB_API_KEY) {
    const general = await apiGet(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`);
    if (Array.isArray(general)) out = out.concat(general.slice(0, 12));
    for (const s of ["AAPL", "MSFT", "NVDA", "TSLA", "PLTR", "NFLX", "GEV"]) {
      const d = new Date(); const to = d.toISOString().slice(0, 10);
      d.setDate(d.getDate() - 5); const from = d.toISOString().slice(0, 10);
      const company = await apiGet(`https://finnhub.io/api/v1/company-news?symbol=${s}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`);
      if (Array.isArray(company)) out = out.concat(company.slice(0, 3).map(x => ({ ...x, symbol: s })));
    }
  }
  if (!out.length) {
    out = [
      { headline: "Mercado atento a tasas, inflacion y tecnologia AI", source: "Cordelius Local", summary: "Modo local educativo: no hay API de noticias activa o no respondio.", url: "#", image: "", datetime: Date.now() / 1000 },
      { headline: "Cripto corrige mientras acciones de AI mantienen atencion", source: "Cordelius Local", summary: "BTC, XRP y ETH suelen reaccionar fuerte a cambios de liquidez global.", url: "#", image: "", datetime: Date.now() / 1000 }
    ];
  }
  news = out.slice(0, 30).map(n => ({ ...n, classification: classifyNews(n), impacted: impactedAssets(n) }));
}

// ---- QUIVER QUANT — datos institucionales (F3a.1) ----
async function fetchQuiverData() {
  if (!QUIVER_API_KEY) { quiverData.configured = false; return; }
  if (Date.now() - quiverData.lastFetch < QUIVER_CACHE_MS) return;
  quiverData.configured = true;
  quiverData.error = null;

  function quiverGet(path) {
    return new Promise(resolve => {
      const r = https.request({
        hostname: "api.quiverquant.com", path, method: "GET",
        headers: { "Authorization": "Token " + QUIVER_API_KEY, "Accept": "application/json" },
        timeout: 12000
      }, res => {
        if (res.statusCode === 429) { quiverData.error = "Rate limit (429)"; return resolve(null); }
        if (res.statusCode === 401) { quiverData.error = "API key invalida (401)"; return resolve(null); }
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      r.on("error", () => resolve(null));
      r.on("timeout", () => { r.destroy(); resolve(null); });
      r.end();
    });
  }

  try {
    const [cong, ins, gov] = await Promise.allSettled([
      quiverGet("/beta/live/congresstrading"),
      quiverGet("/beta/live/insiders"),
      quiverGet("/beta/live/govcontracts")
    ]);

    const ts = Date.now();
    function filterByPortfolio(arr, tickerField) {
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(x => PORTFOLIO.some(a => a.symbol === (x[tickerField] || "").toUpperCase()))
        .map(x => ({
          ...x,
          symbol: (x[tickerField] || "").toUpperCase(),
          inPortfolio: true,
          daysAgo: x.Date ? Math.floor((ts - new Date(x.Date).getTime()) / 86400000) : null
        }))
        .slice(0, 50);
    }

    quiverData.congressional = filterByPortfolio(cong.status === "fulfilled" ? cong.value : null, "Ticker");
    quiverData.insider = filterByPortfolio(ins.status === "fulfilled" ? ins.value : null, "Ticker");
    quiverData.contracts = filterByPortfolio(gov.status === "fulfilled" ? gov.value : null, "Ticker");
    // Save full unfiltered data for external radar (capped at 300/dataset for memory)
    function normalizeFull(arr, tickerField) {
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, 300).map(x => ({
        ...x, symbol: (x[tickerField] || "").toUpperCase(),
        daysAgo: x.Date ? Math.floor((ts - new Date(x.Date).getTime()) / 86400000) : null
      })).filter(x => x.symbol);
    }
    quiverDataFull.congressional = normalizeFull(cong.status === "fulfilled" ? cong.value : null, "Ticker");
    quiverDataFull.insider = normalizeFull(ins.status === "fulfilled" ? ins.value : null, "Ticker");
    quiverDataFull.contracts = normalizeFull(gov.status === "fulfilled" ? gov.value : null, "Ticker");
    quiverData.lastFetch = ts;
    console.log("Quiver OK:", quiverData.congressional.length, "congreso,", quiverData.insider.length, "insiders,", quiverData.contracts.length, "contratos (full:", quiverDataFull.congressional.length, "cong)");
  } catch (e) {
    quiverData.error = e.message;
    console.log("Quiver error:", e.message);
  }
}

// ---- SCAN DIARIO — lógica pura (reutilizada por /api/daily-scan y renderDailyScanCard) ----
function computeDailyScan() {
  const pv = portfolioValue();
  const reg = marketRegime();
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  const totalMXN = pv.totalValueMXN || 1;

  const bitsoMXN = pv.assets.filter(a => a.source === "Bitso").reduce((s, a) => s + a.valueMXN, 0);
  const plataMXN = pv.assets.filter(a => a.source === "Plata").reduce((s, a) => s + a.valueMXN, 0);
  const gbmMXN   = pv.assets.filter(a => a.source === "GBM").reduce((s, a) => s + a.valueMXN, 0);
  const bitsoPct = (bitsoMXN / totalMXN) * 100;

  const portfolioSummary = {
    totalMXN: +pv.totalValueMXN.toFixed(2), gainPct: +pv.totalGainPct.toFixed(2),
    gainMXN: +pv.totalGainMXN.toFixed(2), assets: pv.assets.length,
    regime: reg.label, regimeDetail: reg.detail,
    concentration: {
      bitso_pct: +bitsoPct.toFixed(1),
      plata_pct: +(plataMXN / totalMXN * 100).toFixed(1),
      gbm_pct:   +(gbmMXN   / totalMXN * 100).toFixed(1),
      alert: bitsoPct > 45
    }
  };

  const allQuiverMatches = [
    ...quiverData.congressional.map(x => ({ ...x, dataset: "congressional" })),
    ...quiverData.insider.map(x => ({ ...x, dataset: "insider" })),
    ...quiverData.contracts.map(x => ({ ...x, dataset: "contracts" }))
  ];

  const quiverByTicker = {};
  for (const m of allQuiverMatches) {
    const sym = m.symbol || "";
    if (!sym) continue;
    if (!quiverByTicker[sym]) quiverByTicker[sym] = { congressional: 0, insider: 0, contracts: 0, total: 0, recentDays: null };
    quiverByTicker[sym][m.dataset] = (quiverByTicker[sym][m.dataset] || 0) + 1;
    quiverByTicker[sym].total++;
    if (m.daysAgo != null && (quiverByTicker[sym].recentDays === null || m.daysAgo < quiverByTicker[sym].recentDays)) {
      quiverByTicker[sym].recentDays = m.daysAgo;
    }
  }
  const topQuiverTickers = Object.entries(quiverByTicker)
    .sort((a, b) => b[1].total - a[1].total).slice(0, 10)
    .map(([sym, data]) => ({ symbol: sym, ...data }));

  const quiverSummary = {
    configured: quiverData.configured, total: allQuiverMatches.length,
    congressional: quiverData.congressional.length, insider: quiverData.insider.length,
    contracts: quiverData.contracts.length, topTickers: topQuiverTickers,
    lastFetch: quiverData.lastFetch
  };

  const cryptoSyms  = pv.assets.filter(a => a.type === "crypto").map(a => a.symbol);
  const techSyms    = ["MSFT","AAPL","PLTR","IREN","SSYS","PATH","NFLX"];
  const energySyms  = ["GEV","AEP","COPX"];
  const healthSyms  = ["UNH"];
  const techMatches   = allQuiverMatches.filter(x => techSyms.includes(x.symbol)).length;
  const energyMatches = allQuiverMatches.filter(x => energySyms.includes(x.symbol)).length;
  const healthMatches = allQuiverMatches.filter(x => healthSyms.includes(x.symbol)).length;

  const intelAffected = [...new Set(intelItems.flatMap(x => x.affected || []))];
  const intelPositive = intelItems.filter(x => x.mood === "POSITIVO").length;
  const intelNegative = intelItems.filter(x => x.mood === "NEGATIVO").length;
  const intelHotTickers = intelAffected
    .map(sym => ({
      symbol: sym,
      count: intelItems.filter(x => (x.affected || []).includes(sym)).length,
      pos: intelItems.filter(x => (x.affected || []).includes(sym) && x.mood === "POSITIVO").length,
      neg: intelItems.filter(x => (x.affected || []).includes(sym) && x.mood === "NEGATIVO").length,
      inPortfolio: !!pv.assets.find(a => a.symbol === sym)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const marketThemes = [];
  if (techMatches > 3)   marketThemes.push({ theme: "Tech / AI Infrastructure",   strength: techMatches > 12   ? "FUERTE" : "MODERADO",   quiverSignals: techMatches,   tickers: techSyms.filter(s => pv.assets.find(a => a.symbol === s)) });
  if (energyMatches > 1) marketThemes.push({ theme: "Energia / Grid / Cobre",      strength: energyMatches > 6  ? "FUERTE" : "MODERADO",   quiverSignals: energyMatches, tickers: energySyms });
  if (healthMatches > 0) marketThemes.push({ theme: "Healthcare / Regulacion",     strength: healthMatches > 4  ? "FUERTE" : "BAJO",       quiverSignals: healthMatches, tickers: healthSyms });
  if (intelItems.length) marketThemes.push({ theme: "Cordelius Intelligence Manual", strength: intelNegative > intelPositive ? "DEFENSIVO" : "ACTIVO", quiverSignals: 0, intelSignals: intelItems.length, tickers: intelHotTickers.map(x => x.symbol), hotTickers: intelHotTickers });
  if (bitsoPct > 40)     marketThemes.push({ theme: "Cripto concentrado",          strength: "ALTO RIESGO",    quiverSignals: 0,            tickers: cryptoSyms, alert: true });
  if (!marketThemes.length) marketThemes.push({ theme: "Sin temas dominantes",     strength: "NEUTRAL",        quiverSignals: 0,            tickers: [] });

  const tickerHighlights = ranked.map(a => {
    const qm = allQuiverMatches.filter(x => x.symbol === a.symbol);
    return { symbol: a.symbol, score: a.score, signal: a.signal, gainPct: +a.gainPct.toFixed(2), risk: a.risk,
      quiverMatches: qm.length, quiverDatasets: [...new Set(qm.map(x => x.dataset))],
      ind: { rsi: a.ind.rsi, trend: a.ind.trend, momentum: +a.ind.momentum } };
  });

  const riskAlerts = [];
  if (bitsoPct > 45) riskAlerts.push({ level: "ALTO", type: "CONCENTRACION", message: "Cripto/Bitso " + bitsoPct.toFixed(0) + "% del portafolio — riesgo alto", tickers: cryptoSyms });
  for (const a of pv.assets) {
    if (a.gainPct < -15 && a.risk === "ALTO") riskAlerts.push({ level: "ALTO", type: "DRAWDOWN", message: a.symbol + " perdida " + a.gainPct.toFixed(1) + "% con riesgo alto", tickers: [a.symbol] });
    if (a.score < 30) riskAlerts.push({ level: "CRITICO", type: "SCORE_CRITICO", message: a.symbol + " score " + a.score + "/100 — revisar", tickers: [a.symbol] });
    if (a.gainPct > 80 && a.ind.momentum > 0) riskAlerts.push({ level: "OPORTUNIDAD", type: "TOMA_GANANCIA", message: a.symbol + " +" + a.gainPct.toFixed(0) + "% acumulado — posible toma parcial educativa", tickers: [a.symbol] });
  }
  const insiderSales = quiverData.insider.filter(x => (x.TransactionType || x.transaction || "").toLowerCase().includes("sale"));
  if (insiderSales.length > 0) riskAlerts.push({ level: "ATENCION", type: "INSIDER_SALE", message: insiderSales.length + " ventas de insiders en tus activos (Quiver)", tickers: [...new Set(insiderSales.map(x => x.symbol))] });

  const educationalActions = [];
  for (const a of pv.assets.filter(a => a.score < 40 || a.gainPct < -12).slice(0, 3)) {
    educationalActions.push({ priority: "VIGILAR", symbol: a.symbol, action: "Revisar tesis: " + a.signal + " · ganancia " + a.gainPct.toFixed(1) + "%", score: a.score, gainPct: +a.gainPct.toFixed(2) });
  }
  for (const a of pv.assets.filter(a => a.gainPct > 50 && a.score > 55).slice(0, 2)) {
    educationalActions.push({ priority: "CONSIDERAR", symbol: a.symbol, action: "Ganancia +" + a.gainPct.toFixed(0) + "% — evaluar toma parcial educativa", score: a.score, gainPct: +a.gainPct.toFixed(2) });
  }
  if (bitsoPct > 45) educationalActions.push({ priority: "RIESGO", symbol: "PORTAFOLIO", action: "Bitso " + bitsoPct.toFixed(0) + "% — concentracion alta; considerar rebalanceo gradual", score: null, gainPct: null });
  if (!educationalActions.length) educationalActions.push({ priority: "OK", symbol: "PORTAFOLIO", action: "Sin alertas criticas. Regimen " + reg.label + ". Mantener y monitorear.", score: null, gainPct: null });

  const summaryLines = [];
  if (bitsoPct > 60) summaryLines.push("Concentracion cripto muy alta (" + bitsoPct.toFixed(0) + "%). Bitso domina el portafolio — revisa exposicion.");
  else if (bitsoPct > 45) summaryLines.push("Cripto/Bitso sobre 45% (" + bitsoPct.toFixed(0) + "%) — vigilar correlacion en caidas.");
  if (allQuiverMatches.length > 0) summaryLines.push(allQuiverMatches.length + " senales institucionales en tus activos (Quiver: congreso, insiders, contratos).");
  if (intelItems.length > 0) summaryLines.push("Intel manual: " + intelItems.length + " items (" + intelPositive + " positivos, " + intelNegative + " negativos) cruzados contra tus tickers.");
  const topAsset = ranked[0], bottomAsset = ranked[ranked.length - 1];
  summaryLines.push("Mejor posicion: " + topAsset.symbol + " (score " + topAsset.score + "/100, " + (topAsset.gainPct >= 0 ? "+" : "") + topAsset.gainPct.toFixed(0) + "%).");
  summaryLines.push("Activo a vigilar: " + bottomAsset.symbol + " (score " + bottomAsset.score + "/100, " + bottomAsset.gainPct.toFixed(1) + "%).");
  summaryLines.push("Regimen: " + reg.label + ". " + reg.detail);
  summaryLines.push("EDUCATIVO: no es asesoria financiera.");
  const educationalSummary = summaryLines.join(" ");
  const intelPositiveCount = intelItems.filter(x => x.mood === "POSITIVO").length;
  const intelNegativeCount = intelItems.filter(x => x.mood === "NEGATIVO").length;
  const affectedTickers = uniqueStrings(intelItems.flatMap(x => x.affected || []));
  const hotTickers = uniqueStrings([
    ...topQuiverTickers.map(x => x.symbol),
    ...riskAlerts.flatMap(x => x.tickers || []),
    ...educationalActions.map(x => x.symbol),
    ...affectedTickers
  ]).slice(0, 15);
  const manualMarketTheme = {
    title: "Cordelius Intelligence Manual",
    positiveCount: intelPositiveCount,
    negativeCount: intelNegativeCount,
    affectedTickers,
    hotTickers,
    note: intelItems.length ? "Tema de mercado derivado de intel manual local." : "Sin intel manual; pendiente de proveedor/noticias."
  };

  return {
    ok: true, ts: Date.now(), date: new Date().toLocaleDateString("es-MX"),
    portfolioSummary, quiverSummary, marketThemes, tickerHighlights,
    riskAlerts: riskAlerts.slice(0, 10),
    educationalActions: educationalActions.slice(0, 6),
    educationalSummary,
    affectedTickers,
    hotTickers,
    intelPositiveCount,
    intelNegativeCount,
    positiveCount: intelPositiveCount,
    negativeCount: intelNegativeCount,
    manualMarketTheme,
    rawMatchesLimited: allQuiverMatches.slice(0, 20),

    intel: {
      count: intelItems.length,
      positive: intelPositiveCount,
      negative: intelNegativeCount,
      positiveCount: intelPositiveCount,
      negativeCount: intelNegativeCount,
      affectedTickers,
      hotTickers,
      recent: intelItems.slice(0, 5).map(x => ({ mood: x.mood, affected: x.affected, tags: x.tags, time: x.time, snippet: String(x.text || "").slice(0, 180) }))
    }

  };
}

function classifyExternalTicker(symbol) {
  const aiSemis    = ["NVDA","AMD","AVGO","SMCI","INTC","TSM","QCOM","MU"];
  const megaCap    = ["AAPL","MSFT","GOOGL","AMZN","META","NFLX"];
  const cryptoPx   = ["COIN","MSTR","HOOD","SOFI"];
  const evChina    = ["TSLA","RIVN","NIO","BABA"];
  const healthcare = ["UNH","LLY","JNJ","PFE"];
  const etfs       = ["QQQ","SPY","IWM","GLD","TLT","XLK"];
  if (aiSemis.includes(symbol))    return { sector: "AI / Semiconductores",   color: "#818cf8", emoji: "⚡" };
  if (megaCap.includes(symbol))    return { sector: "Mega Cap Tech",           color: "#3b9dff", emoji: "🌐" };
  if (cryptoPx.includes(symbol))   return { sector: "Crypto Proxy",            color: "#f59e0b", emoji: "₿"  };
  if (evChina.includes(symbol))    return { sector: "EV / China Tech",         color: "#10b981", emoji: "🚗" };
  if (healthcare.includes(symbol)) return { sector: "Healthcare / Defensivo",  color: "#f472b6", emoji: "🏥" };
  if (etfs.includes(symbol))       return { sector: "ETF / Mercado amplio",    color: "#94a3b8", emoji: "📊" };
  return                                  { sector: "Otros",                   color: "#9fb3c8", emoji: "◆"  };
}

function computePortfolioIntelligence() {
  const pv = portfolioValue();
  const reg = marketRegime();
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  const totalMXN = pv.totalValueMXN || 1;
  const bySource = {};
  for (const a of pv.assets) {
    if (!bySource[a.source]) bySource[a.source] = { assets: [], totalValue: 0, totalCost: 0 };
    bySource[a.source].assets.push(a);
    bySource[a.source].totalValue += a.valueMXN;
    bySource[a.source].totalCost += a.costMXN;
  }
  const accountSummaries = Object.entries(bySource).map(([src, d]) => ({
    source: src,
    totalValue: +d.totalValue.toFixed(2),
    totalCost:  +d.totalCost.toFixed(2),
    gain:       +(d.totalValue - d.totalCost).toFixed(2),
    gainPct:    d.totalCost > 0 ? +((d.totalValue - d.totalCost) / d.totalCost * 100).toFixed(2) : 0,
    pct:        +(d.totalValue / totalMXN * 100).toFixed(1),
    assets:     d.assets.length
  }));
  const cryptoMXN  = pv.assets.filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0);
  const criptoPct  = cryptoMXN / totalMXN * 100;
  const riskAssets = ranked.filter(a => a.score < 35 || a.gainPct < -12 || a.risk === "ALTO");
  const oppAssets  = ranked.filter(a => a.gainPct > 50 && a.score > 55);
  const buyDip     = ranked.filter(a => a.signal && (a.signal.includes("BUY") || a.signal.includes("MOMENTUM")) && a.score > 45);
  return {
    ok: true, ts: Date.now(),
    totalValueMXN: +pv.totalValueMXN.toFixed(2), totalCostMXN: +pv.totalCostMXN.toFixed(2),
    totalGainMXN: +pv.totalGainMXN.toFixed(2), totalGainPct: +pv.totalGainPct.toFixed(2),
    regime: reg.label, assetCount: pv.assets.length, accountSummaries,
    concentration: { criptoPct: +criptoPct.toFixed(1), alert: criptoPct > 45 },
    best:  ranked[0] ? { symbol: ranked[0].symbol, score: ranked[0].score, gainPct: +ranked[0].gainPct.toFixed(2), signal: ranked[0].signal } : null,
    worst: ranked[ranked.length-1] ? { symbol: ranked[ranked.length-1].symbol, score: ranked[ranked.length-1].score, gainPct: +ranked[ranked.length-1].gainPct.toFixed(2), signal: ranked[ranked.length-1].signal } : null,
    riskAssets: riskAssets.slice(0,5).map(a => ({ symbol: a.symbol, score: a.score, gainPct: +a.gainPct.toFixed(2), risk: a.risk })),
    oppAssets:  oppAssets.slice(0,3).map(a => ({ symbol: a.symbol, score: a.score, gainPct: +a.gainPct.toFixed(2) })),
    buyDip:     buyDip.slice(0,3).map(a => ({ symbol: a.symbol, score: a.score, signal: a.signal })),
    quiverInPortfolio: quiverData.congressional.length + quiverData.insider.length + quiverData.contracts.length,
    intelItems: intelItems.length
  };
}

function computeExternalMarketIntelligence() {
  const portSyms = new Set(PORTFOLIO.map(a => a.symbol));
  const pv = portfolioValue();
  const classified = MARKET_WATCHLIST.map(sym => {
    const cls = classifyExternalTicker(sym);
    const inPort = portSyms.has(sym);
    const portAsset = inPort ? pv.assets.find(a => a.symbol === sym) : null;
    const src = quiverDataFull.congressional.length > 0 ? quiverDataFull.congressional : quiverData.congressional;
    const srcI = quiverDataFull.insider.length > 0 ? quiverDataFull.insider : quiverData.insider;
    const srcC = quiverDataFull.contracts.length > 0 ? quiverDataFull.contracts : quiverData.contracts;
    const qSig  = [...src.filter(x=>(x.symbol||"").toUpperCase()===sym), ...srcI.filter(x=>(x.symbol||"").toUpperCase()===sym), ...srcC.filter(x=>(x.symbol||"").toUpperCase()===sym)].length;
    const qBuys = src.filter(x=>(x.symbol||"").toUpperCase()===sym && /buy|purchase/.test((x.Transaction||x.transaction||"").toLowerCase())).length;
    const qSale = src.filter(x=>(x.symbol||"").toUpperCase()===sym && /sale|sell/.test((x.Transaction||x.transaction||"").toLowerCase())).length;
    return { symbol: sym, sector: cls.sector, sectorColor: cls.color, sectorEmoji: cls.emoji, inPortfolio: inPort,
      score: portAsset ? portAsset.score : null, signal: portAsset ? portAsset.signal : null,
      gainPct: portAsset ? +portAsset.gainPct.toFixed(2) : null,
      quiverSignals: qSig, quiverBuys: qBuys, quiverSales: qSale };
  });
  const bySector = {};
  for (const t of classified) {
    if (!bySector[t.sector]) bySector[t.sector] = { sector: t.sector, color: t.sectorColor, emoji: t.sectorEmoji, tickers: [] };
    bySector[t.sector].tickers.push(t);
  }
  const sectors = Object.values(bySector).map(s => ({
    ...s, hotCount: s.tickers.filter(t => t.quiverSignals > 0).length,
    totalQuiver: s.tickers.reduce((sum, t) => sum + t.quiverSignals, 0)
  })).sort((a, b) => b.totalQuiver - a.totalQuiver);
  const externalHot = classified.filter(t => !t.inPortfolio && (t.quiverSignals > 0 || (t.score != null && t.score > 60)))
    .sort((a, b) => (b.quiverSignals + (b.score||0)/10) - (a.quiverSignals + (a.score||0)/10));
  return {
    ok: true, ts: Date.now(), watchlistCount: MARKET_WATCHLIST.length,
    classified, sectors, externalHot: externalHot.slice(0,10),
    externalAll: classified.filter(t => !t.inPortfolio),
    portfolioOverlap: classified.filter(t => t.inPortfolio),
    educationalNote: "EDUCATIVO: radar de vigilancia. No implica recomendación de compra o venta."
  };
}

function computeQuiverIntelligence() {
  const portSyms = new Set(PORTFOLIO.map(a => a.symbol));
  if (!quiverData.configured) {
    return {
      ok: true, ts: Date.now(), configured: false,
      message: "Agrega QUIVER_API_KEY en .env para activar datos institucionales.",
      pendingFeatures: ["Compras del Congreso USA","Ventas del Congreso USA","Insider trading en tus activos","Contratos gubernamentales","Políticos más activos","Tickers más movidos institucionalmente"],
      watchlistNote: "El radar de mercado funciona sin Quiver — solo sin datos institucionales."
    };
  }
  const congAll = quiverDataFull.congressional.length > 0 ? quiverDataFull.congressional : quiverData.congressional;
  const insAll  = quiverDataFull.insider.length > 0 ? quiverDataFull.insider : quiverData.insider;
  const conAll  = quiverDataFull.contracts.length > 0 ? quiverDataFull.contracts : quiverData.contracts;
  const congBuys  = congAll.filter(x => /buy|purchase/.test((x.Transaction||x.transaction||"").toLowerCase()));
  const congSales = congAll.filter(x => /sale|sell/.test((x.Transaction||x.transaction||"").toLowerCase()));
  const insBuys   = insAll.filter(x => /buy|purchase/.test((x.TransactionType||x.transaction||"").toLowerCase()));
  const insSales  = insAll.filter(x => /sale|sell/.test((x.TransactionType||x.transaction||"").toLowerCase()));
  const politMap = {};
  for (const m of congAll) {
    const who = m.Representative || m.Politician || m.Name || "";
    const sym = (m.symbol || m.Ticker || "").toUpperCase();
    if (!who) continue;
    if (!politMap[who]) politMap[who] = { name: who, party: m.Party||"", trades:0, buys:0, sales:0, tickers: new Set() };
    politMap[who].trades++;
    if (/buy|purchase/.test((m.Transaction||"").toLowerCase())) politMap[who].buys++;
    else if (/sale|sell/.test((m.Transaction||"").toLowerCase())) politMap[who].sales++;
    if (sym) politMap[who].tickers.add(sym);
  }
  const activePoliticians = Object.values(politMap)
    .map(p => ({ name:p.name, party:p.party, trades:p.trades, buys:p.buys, sales:p.sales, tickers:[...p.tickers], portfolioTickers:[...p.tickers].filter(s=>portSyms.has(s)) }))
    .sort((a,b) => b.trades - a.trades).slice(0, 8);
  const allTrades = [
    ...congAll.map(x => ({ symbol:(x.symbol||x.Ticker||"").toUpperCase(), dataset:"Congreso", transaction:x.Transaction||x.transaction||"", who:x.Representative||x.Name||"", party:x.Party||"", amount:x.Amount||x.amount||x.Value||"", date:x.Date||"", inPortfolio:portSyms.has((x.symbol||x.Ticker||"").toUpperCase()) })),
    ...insAll.map(x  => ({ symbol:(x.symbol||x.Ticker||"").toUpperCase(), dataset:"Insider",   transaction:x.TransactionType||x.transaction||"", who:x.Name||x.Insider||"", party:"", amount:x.Amount||x.Value||"", date:x.Date||"", inPortfolio:portSyms.has((x.symbol||x.Ticker||"").toUpperCase()) })),
    ...conAll.map(x  => ({ symbol:(x.symbol||x.Ticker||"").toUpperCase(), dataset:"Contrato",  transaction:"CONTRACT", who:x.Agency||x.Customer||"", party:"", amount:x.Amount||x.Value||"", date:x.Date||"", inPortfolio:portSyms.has((x.symbol||x.Ticker||"").toUpperCase()) }))
  ].sort((a,b) => (b.date>a.date?1:b.date<a.date?-1:0)).slice(0, 30);
  const tickAct = {};
  for (const t of allTrades) {
    if (!t.symbol) continue;
    if (!tickAct[t.symbol]) tickAct[t.symbol] = { symbol:t.symbol, total:0, buys:0, sales:0, contracts:0, inPortfolio:portSyms.has(t.symbol) };
    tickAct[t.symbol].total++;
    if (/buy|purchase/.test(t.transaction.toLowerCase())) tickAct[t.symbol].buys++;
    else if (/sale|sell/.test(t.transaction.toLowerCase())) tickAct[t.symbol].sales++;
    else if (t.dataset==="Contrato") tickAct[t.symbol].contracts++;
  }
  const topTickers = Object.values(tickAct).sort((a,b) => b.total-a.total).slice(0, 15);
  return {
    ok: true, ts: Date.now(), configured: true,
    congressional: { total: congAll.length, portfolio: congAll.filter(x=>portSyms.has((x.symbol||x.Ticker||"").toUpperCase())).length, external: congAll.filter(x=>!portSyms.has((x.symbol||x.Ticker||"").toUpperCase())).length, buys: congBuys.length, sales: congSales.length },
    insider:       { total: insAll.length,  portfolio: insAll.filter(x=>portSyms.has((x.symbol||x.Ticker||"").toUpperCase())).length,  external: insAll.filter(x=>!portSyms.has((x.symbol||x.Ticker||"").toUpperCase())).length,  buys: insBuys.length, sales: insSales.length },
    contracts:     { total: conAll.length,  portfolio: conAll.filter(x=>portSyms.has((x.symbol||x.Ticker||"").toUpperCase())).length,  external: conAll.filter(x=>!portSyms.has((x.symbol||x.Ticker||"").toUpperCase())).length },
    activePoliticians, latestTrades: allTrades.slice(0, 20), topTickers,
    educationalNote: "Datos educativos. Retraso típico hasta 45 días. No implica acción de inversión."
  };
}

function computeSectorThemes() {
  const pv = portfolioValue();
  const total = pv.totalValueMXN || 1;
  const portSectors = {};
  const SECTOR_MAP = { AAPL:"Tech/AI", MSFT:"Tech/AI", PLTR:"Tech/AI", IREN:"Tech/AI", SSYS:"Tech/AI", PATH:"Tech/AI", NFLX:"Tech/AI", GEV:"Energía/Grid", AEP:"Energía/Grid", COPX:"Energía/Grid", UNH:"Healthcare", BBVA:"Banca MXN" };
  for (const a of pv.assets) {
    const sector = a.type === "crypto" ? "Cripto" : (SECTOR_MAP[a.symbol] || "Otros");
    if (!portSectors[sector]) portSectors[sector] = { sector, value: 0, assets: [] };
    portSectors[sector].value += a.valueMXN;
    portSectors[sector].assets.push(a.symbol);
  }
  const portfolioSectors = Object.values(portSectors).map(s => ({ ...s, pct: +(s.value / total * 100).toFixed(1) })).sort((a,b) => b.value-a.value);
  const emi = computeExternalMarketIntelligence();
  return {
    ok: true, ts: Date.now(), portfolioSectors,
    externalSectors: emi.sectors,
    hotSectors: emi.sectors.filter(s => s.totalQuiver > 0),
    educationalNote: "EDUCATIVO: clasificación por sector para análisis de concentración."
  };
}

function computeDailyNewsletter() {
  const pi  = computePortfolioIntelligence();
  const emi = computeExternalMarketIntelligence();
  const qi  = computeQuiverIntelligence();
  const scan = computeDailyScan();
  const reg = marketRegime();
  const today = new Date().toLocaleDateString("es-MX", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const lines = [];
  lines.push(`Patrimonio: ${money(pi.totalValueMXN)} · rendimiento global ${pct(pi.totalGainPct)}.`);
  if (pi.concentration.alert) lines.push(`⚠ Cripto ${pi.concentration.criptoPct}% del portafolio — concentración alta.`);
  if (pi.best) lines.push(`Mejor activo: ${pi.best.symbol} (${pi.best.score}/100 · ${pct(pi.best.gainPct)}). Débil: ${pi.worst ? pi.worst.symbol + " (" + pi.worst.score + "/100)" : "—"}.`);
  if (scan.riskAlerts.length > 0) lines.push(`Alertas: ${scan.riskAlerts.slice(0,2).map(a => a.message).join("; ")}.`);
  if (emi.externalHot.length > 0) lines.push(`Externos calientes: ${emi.externalHot.slice(0,4).map(t => t.symbol).join(", ")}.`);
  if (qi.configured && qi.congressional && qi.congressional.total > 0) lines.push(`Quiver: ${qi.congressional.buys} compras / ${qi.congressional.sales} ventas del congreso.`);
  else if (!qi.configured) lines.push("Quiver: pendiente de API key.");
  if (intelItems.length > 0) lines.push(`Intel manual: ${intelItems.length} items · ${intelItems.filter(x=>x.mood==="POSITIVO").length}+ / ${intelItems.filter(x=>x.mood==="NEGATIVO").length}−.`);
  const opportunityState = getOpportunityState();
  if (opportunityState.topOpportunities && opportunityState.topOpportunities.length) lines.push(`Opportunity Engine: investigar ${opportunityState.topOpportunities.slice(0,3).map(x => x.symbol + " " + x.score + "/100").join(", ")} · educativo.`);
  lines.push(`Régimen: ${reg.label}. ${reg.detail}`);
  lines.push("EDUCATIVO — no es asesoría financiera.");
  return {
    ok: true, ts: Date.now(), date: today, greeting: "Cordelius OS · " + today, lines,
    fullSummary: lines.join(" "),
    portfolio: pi,
    external: { hotCount: emi.externalHot.length, topSectors: emi.sectors.slice(0,3).map(s => s.sector) },
    quiver: qi.configured ? { congressional: qi.congressional, insider: qi.insider } : { configured: false },
    scan: { riskAlerts: scan.riskAlerts.length, actions: scan.educationalActions.length }
  };
}

function computeQuiverTrending() {
  // Use full unfiltered data if available, else fall back to portfolio-filtered data
  const srcCong = quiverDataFull.congressional.length > 0 ? quiverDataFull.congressional : quiverData.congressional;
  const srcIns  = quiverDataFull.insider.length > 0 ? quiverDataFull.insider : quiverData.insider;
  const srcCon  = quiverDataFull.contracts.length > 0 ? quiverDataFull.contracts : quiverData.contracts;
  const all = [
    ...srcCong.map(x => ({ ...x, _ds: "congressional" })),
    ...srcIns.map(x => ({ ...x, _ds: "insider" })),
    ...srcCon.map(x => ({ ...x, _ds: "contracts" }))
  ];
  const byTicker = {};
  for (const m of all) {
    const sym = (m.symbol || m.Ticker || "").toUpperCase();
    if (!sym) continue;
    if (!byTicker[sym]) byTicker[sym] = { symbol: sym, total: 0, buys: 0, sales: 0, others: 0, amount: 0, politicians: new Set(), latestDate: null };
    byTicker[sym].total++;
    const tx = (m.Transaction || m.TransactionType || m.transaction || "").toLowerCase();
    if (/buy|purchase|bought/.test(tx)) byTicker[sym].buys++;
    else if (/sale|sell|sold/.test(tx)) byTicker[sym].sales++;
    else byTicker[sym].others++;
    const amt = parseFloat(m.Amount || m.amount || m.Value || 0) || 0;
    byTicker[sym].amount += amt;
    const who = m.Representative || m.Name || m.name || m.Politician || "";
    if (who) byTicker[sym].politicians.add(who);
    if (m.Date && (!byTicker[sym].latestDate || m.Date > byTicker[sym].latestDate)) byTicker[sym].latestDate = m.Date;
  }

  const tickers = Object.values(byTicker).map(t => ({
    symbol: t.symbol,
    total: t.total, buys: t.buys, sales: t.sales, others: t.others,
    totalAmount: +t.amount.toFixed(2),
    politicianCount: t.politicians.size,
    latestDate: t.latestDate,
    inPortfolio: PORTFOLIO.some(a => a.symbol === t.symbol)
  })).sort((a, b) => b.total - a.total);

  const politicianMap = {};
  for (const m of quiverData.congressional) {
    const who = m.Representative || m.Politician || m.Name || "";
    if (!who) continue;
    if (!politicianMap[who]) politicianMap[who] = { name: who, party: m.Party || "", trades: 0, tickers: new Set() };
    politicianMap[who].trades++;
    const sym = (m.symbol || m.Ticker || "").toUpperCase();
    if (sym) politicianMap[who].tickers.add(sym);
  }
  const mostActivePoliticians = Object.values(politicianMap)
    .map(p => ({ name: p.name, party: p.party, trades: p.trades, tickers: [...p.tickers] }))
    .sort((a, b) => b.trades - a.trades).slice(0, 10);

  const latestTrades = all.slice().sort((a, b) => {
    const da = a.Date || ""; const db = b.Date || "";
    return da < db ? 1 : da > db ? -1 : 0;
  }).slice(0, 20).map(m => ({
    symbol: (m.symbol || m.Ticker || "").toUpperCase(),
    dataset: m._ds,
    transaction: m.Transaction || m.TransactionType || m.transaction || "",
    who: m.Representative || m.Name || m.name || m.Politician || "",
    party: m.Party || "",
    amount: m.Amount || m.amount || m.Value || "",
    date: m.Date || ""
  }));

  return {
    ok: true, ts: Date.now(),
    configured: quiverData.configured,
    quiverCount: all.length,
    topTickers: tickers.slice(0, 20),
    topBuys: tickers.filter(t => t.buys > 0).sort((a, b) => b.buys - a.buys).slice(0, 10),
    topSales: tickers.filter(t => t.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, 10),
    topByAmount: tickers.filter(t => t.totalAmount > 0).sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 10),
    mostActivePoliticians,
    latestTrades
  };
}

function computeMarketRadar() {
  const pv = portfolioValue();
  const portfolioSymbols = new Set(PORTFOLIO.map(a => a.symbol));
  const quiverTickers = new Set([
    ...quiverData.congressional.map(x => (x.symbol || x.Ticker || "").toUpperCase()),
    ...quiverData.insider.map(x => (x.symbol || x.Ticker || "").toUpperCase()),
    ...quiverData.contracts.map(x => (x.symbol || x.Ticker || "").toUpperCase())
  ].filter(Boolean));

  const watchlist = MARKET_WATCHLIST.map(sym => {
    const inPort = portfolioSymbols.has(sym);
    const portAsset = inPort ? pv.assets.find(a => a.symbol === sym) : null;
    const qCount = [
      ...quiverData.congressional.filter(x => (x.symbol || x.Ticker || "").toUpperCase() === sym),
      ...quiverData.insider.filter(x => (x.symbol || x.Ticker || "").toUpperCase() === sym),
      ...quiverData.contracts.filter(x => (x.symbol || x.Ticker || "").toUpperCase() === sym)
    ].length;
    return {
      symbol: sym,
      inPortfolio: inPort,
      score: portAsset ? portAsset.score : null,
      signal: portAsset ? portAsset.signal : null,
      gainPct: portAsset ? +portAsset.gainPct.toFixed(2) : null,
      quiverSignals: qCount,
      inQuiver: quiverTickers.has(sym)
    };
  });

  const hotTickers = watchlist.filter(t => t.quiverSignals > 0 || (t.score != null && t.score > 65))
    .sort((a, b) => (b.quiverSignals + (b.score || 0) / 10) - (a.quiverSignals + (a.score || 0) / 10));

  const portfolioOverlap = watchlist.filter(t => t.inPortfolio);

  const summaryLines = [];
  summaryLines.push(`Radar de ${MARKET_WATCHLIST.length} activos del mercado.`);
  if (hotTickers.length > 0) summaryLines.push(`${hotTickers.length} activo(s) con señales Quiver o score alto: ${hotTickers.slice(0, 5).map(t => t.symbol).join(", ")}.`);
  summaryLines.push(`${portfolioOverlap.length} activos del radar están en tu portafolio.`);
  summaryLines.push("EDUCATIVO: no es asesoría de inversión.");

  return {
    ok: true, ts: Date.now(),
    watchlist,
    hotTickers: hotTickers.slice(0, 10),
    internetMentionsProxy: hotTickers.slice(0, 8).map(t => ({ symbol: t.symbol, score: t.quiverSignals * 2 + (t.score || 0) })),
    quiverTrending: hotTickers.filter(t => t.quiverSignals > 0).slice(0, 10),
    portfolioOverlap,
    educationalSummary: summaryLines.join(" ")
  };
}


function getResearchCache() {
  const cache = loadJSON(STOCK_RESEARCH_CACHE_FILE, {});
  return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
}
function cacheStockResearch(research) {
  if (!research || !research.symbol) return research;
  const cache = getResearchCache();
  cache[research.symbol] = { ...research, cachedAt: Date.now() };
  saveJSON(STOCK_RESEARCH_CACHE_FILE, cache);
  return cache[research.symbol];
}
function getResearchQueue() {
  return uniqueStrings(loadJSON(RESEARCH_QUEUE_FILE, []));
}
function saveResearchQueue(queue) {
  const next = uniqueStrings(queue).slice(0, 50);
  saveJSON(RESEARCH_QUEUE_FILE, next);
  return next;
}
function addResearchQueueSymbol(symbol) {
  const sym = normalizeTickerSymbol(symbol);
  if (!sym) return getResearchQueue();
  return saveResearchQueue([...getResearchQueue(), sym]);
}
function removeResearchQueueSymbol(symbol) {
  const sym = normalizeTickerSymbol(symbol);
  return saveResearchQueue(getResearchQueue().filter(x => x !== sym));
}
function stockPseudoAsset(symbol) {
  const sym = normalizeTickerSymbol(symbol);
  const portfolioAsset = PORTFOLIO.find(a => a.symbol === sym);
  if (portfolioAsset) return portfolioAsset;
  const seed = seedFor(sym || "MARKET");
  const day = ((seed % 21) - 10) / 5;
  const price = 40 + (seed % 420);
  quotes[sym] = quotes[sym] || { price, value: price, day, ok: true, source: "watchlist/research" };
  return { source: "Watchlist", category: "Opportunity", symbol: sym, display: sym, name: sym, units: 1, currency: "USD", valueManual: price, costManual: price * (0.92 + ((seed % 17) / 100)), brokerGainPct: ((seed % 39) - 14), logo: sym.slice(0, 2), color: "#3b9dff", liveTicker: sym, type: sym === "QQQ" || sym === "SPY" ? "etf" : "stock" };
}
function buildTickerOpportunity(symbol) {
  const sym = normalizeTickerSymbol(symbol);
  const asset = stockPseudoAsset(sym);
  const ind = indicators(asset);
  const radar = computeMarketRadar();
  const radarHit = (radar.watchlist || []).find(t => t.symbol === sym) || {};
  const quiver = Number(radarHit.quiverSignals || 0);
  const inPortfolio = PORTFOLIO.some(a => a.symbol === sym);
  const baseScore = inPortfolio ? assetScore(asset) : deterministicTickerScore(sym, 7);
  const momentumScore = Math.max(0, Math.min(100, 50 + Number(ind.momentum || 0) * 7));
  const rsiScore = Math.max(0, Math.min(100, 100 - Math.abs(Number(ind.rsi || 50) - 52) * 1.6));
  const quiverScore = Math.min(25, quiver * 5);
  const opportunityScore = Math.max(1, Math.min(99, Math.round(baseScore * 0.52 + momentumScore * 0.22 + rsiScore * 0.16 + quiverScore + (MARKET_WATCHLIST.includes(sym) ? 3 : 0))));
  const riskScore = Math.max(1, Math.min(99, Math.round((assetRisk(asset) === "ALTO" ? 70 : assetRisk(asset) === "MEDIO/ALTO" ? 58 : 42) + Math.max(0, Number(ind.rsi || 50) - 70) + Math.max(0, -Number(ind.momentum || 0) * 6))));
  const reason = [
    inPortfolio ? "ya está en portafolio" : "candidato externo",
    `trend ${ind.trend}`,
    `RSI ${ind.rsi}`,
    quiver ? `Quiver x${quiver}` : "sin señal Quiver reciente"
  ].join(" · ");
  return {
    symbol: sym,
    score: opportunityScore,
    riskScore,
    inPortfolio,
    signal: opportunityScore >= 72 ? "INVESTIGAR PRIORIDAD" : opportunityScore >= 60 ? "WATCHLIST" : "OBSERVAR",
    reason,
    indicators: ind,
    quiverSignals: quiver,
    educationalNote: "Contexto educativo; no es recomendación de compra/venta."
  };
}
function buildOpportunityEngine() {
  const scan = computeDailyScan();
  const radar = computeMarketRadar();
  const symbols = uniqueStrings([
    ...MARKET_WATCHLIST,
    ...PORTFOLIO.map(a => a.symbol),
    ...((radar.hotTickers || []).map(t => t.symbol)),
    ...((scan.hotTickers || []).map(t => t.symbol)),
    ...getResearchQueue()
  ]);
  const candidates = symbols.map(buildTickerOpportunity).sort((a, b) => b.score - a.score);
  const risks = candidates.slice().sort((a, b) => b.riskScore - a.riskScore).slice(0, 10);
  const queue = getResearchQueue();
  const state = {
    ok: true,
    ts: Date.now(),
    generatedAt: nowMX(),
    topOpportunities: candidates.slice(0, 10),
    topRisks: risks,
    researchQueue: queue,
    watchlistCandidates: candidates.filter(x => !x.inPortfolio).slice(0, 12),
    affectedTickers: scan.affectedTickers || scan.impactedTickers || [],
    hotTickers: (radar.hotTickers || []).slice(0, 10),
    disclaimer: "Educational only. No financial advice. No trading execution."
  };
  saveJSON(OPPORTUNITY_ENGINE_FILE, state);
  appendSnapshot(OPPORTUNITY_HISTORY_FILE, { ts: state.ts, topOpportunities: state.topOpportunities.slice(0, 5), topRisks: state.topRisks.slice(0, 5), queueSize: queue.length }, 250);
  return state;
}
function getOpportunityState() {
  const state = loadJSON(OPPORTUNITY_ENGINE_FILE, null);
  if (state && state.ok && state.ts && Date.now() - state.ts < 6 * 60 * 60 * 1000) return state;
  return buildOpportunityEngine();
}
function researchStock(symbol) {
  const sym = normalizeTickerSymbol(symbol);
  if (!sym) return { ok: false, error: "missing_symbol", educationalNote: "Envía un ticker como NVDA o TSLA." };
  const cached = getResearchCache()[sym];
  if (cached && cached.cachedAt && Date.now() - cached.cachedAt < 12 * 60 * 60 * 1000) return { ...cached, cacheHit: true };
  const opp = buildTickerOpportunity(sym);
  const asset = stockPseudoAsset(sym);
  const relatedNews = news.filter(n => String(n.related || n.symbol || "").toUpperCase().includes(sym) || String(n.headline || n.summary || "").toUpperCase().includes(sym)).slice(0, 5);
  const intel = intelItems.filter(i => (i.affected || []).includes(sym) || String(i.text || "").toUpperCase().includes(sym)).slice(0, 5);
  const quiver = computeQuiverTrending();
  const quiverHits = (quiver.topTickers || []).filter(t => t.symbol === sym).slice(0, 3);
  const thesis = opp.score >= 72 ? "Prioridad de investigación: momentum/score fuertes; validar valuación, noticias y riesgo antes de cualquier decisión." : opp.score >= 58 ? "Candidato de watchlist: revisar catalizadores y timing; no perseguir movimiento." : "Observación: señal incompleta; esperar más datos o contexto.";
  const risks = [];
  if (opp.riskScore >= 65) risks.push("Riesgo elevado por volatilidad, RSI o concentración temática.");
  if (!relatedNews.length) risks.push("Sin proveedor/noticias recientes en cache local; validar fuera de Cordelius.");
  if (!quiverHits.length) risks.push("Sin confirmación Quiver reciente en cache local.");
  const research = {
    ok: true,
    symbol: sym,
    ts: Date.now(),
    generatedAt: nowMX(),
    score: opp.score,
    riskScore: opp.riskScore,
    signal: opp.signal,
    thesis,
    indicators: opp.indicators,
    priceContext: { source: (quotes[sym] && quotes[sym].source) || "local", price: quotes[sym] ? quotes[sym].price : null, day: quotes[sym] ? quotes[sym].day : null },
    relatedNews: relatedNews.map(n => ({ source: n.source || "news", headline: n.headline || n.summary || "Noticia", date: n.datetime ? new Date(Number(n.datetime) * 1000).toISOString().slice(0, 10) : null, url: n.url || null })),
    manualIntel: intel.map(i => ({ mood: i.mood, affected: i.affected || [], text: String(i.text || "").slice(0, 220), time: i.time || null })),
    quiver: quiverHits,
    risks,
    nextResearchSteps: ["Revisar reporte trimestral y guía", "Comparar valuación contra peers", "Validar catalizadores con fecha", "Definir hipótesis paper-trading solamente"],
    educationalNote: "Investigación educativa. No es recomendación financiera ni orden de compra/venta."
  };
  return cacheStockResearch(research);
}
function runResearchQueue() {
  const queue = getResearchQueue();
  const results = queue.map(sym => researchStock(sym));
  return { ok: true, ts: Date.now(), count: results.length, queue, results, educationalNote: "Research queue ejecutada en modo educativo; sin trading real." };
}
function buildJarvisContext() {
  const h = computeHealthReadiness();
  const pv = portfolioValue();
  const opp = getOpportunityState();
  return {
    ok: true,
    ts: Date.now(),
    health: { operatingMode: h.operatingMode, recovery: h.recovery, sleep: h.sleep, strain: h.strain },
    portfolio: { totalMXN: pv.totalValueMXN, gainPct: pv.totalGainPct, assets: pv.assets.length },
    opportunities: opp.topOpportunities.slice(0, 5),
    risks: opp.topRisks.slice(0, 5),
    researchQueue: getResearchQueue(),
    recentResearch: Object.values(getResearchCache()).sort((a, b) => (b.cachedAt || b.ts || 0) - (a.cachedAt || a.ts || 0)).slice(0, 5),
    disclaimer: "Jarvis solo entrega contexto educativo. No ejecuta trades."
  };
}
function buildMemorySummary() {
  const ctx = buildJarvisContext();
  const top = ctx.opportunities[0];
  const queue = ctx.researchQueue;
  return {
    ok: true,
    ts: Date.now(),
    summary: top ? `Oportunidad principal para investigar: ${top.symbol} (${top.score}/100). Queue: ${queue.length ? queue.join(", ") : "vacía"}.` : "Sin oportunidades nuevas todavía.",
    opportunity: top || null,
    queue,
    context: ctx,
    educationalNote: "Memoria local educativa; no asesoría financiera."
  };
}

// ════════════════════════════════════════════════════════════════
// COMMAND CENTER LAYER — Automations · Jarvis Brain · Today Feed
// Solo lectura + alertas educativas. Nunca ejecuta órdenes reales.
// ════════════════════════════════════════════════════════════════
const AUTOMATION_EVENTS_FILE = "data/automation_events.json";

function cryptoConcentrationPct(pv) {
  if (!pv.totalValueMXN) return 0;
  return pv.assets.filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0) / pv.totalValueMXN * 100;
}

// Motor de reglas local: evalúa condiciones y devuelve eventos sugeridos.
// "suggestedMode" es una sugerencia educativa — no cambia nada por sí solo.
function evaluateAutomationRules() {
  const h = computeHealthReadiness();
  const pv = portfolioValue();
  const jd = computeJournalData();
  const criptoPct = cryptoConcentrationPct(pv);
  const bigNews = news.filter(n => n.classification && /alto|high/i.test(n.classification.impact || "")).slice(0, 3);
  const lastMood = (journalEntries[0] && journalEntries[0].mood) || null;
  const rules = [
    {
      id: "health_low_defensive",
      name: "Salud baja → modo defensivo",
      fired: h.recovery !== null && h.recovery < 50,
      severity: "WARNING",
      suggestedMode: "DEFENSIVO",
      message: h.recovery !== null ? `Recovery ${h.recovery}% (<50%). Sugerencia educativa: modo defensivo, decisiones simples, sin riesgo nuevo.` : ""
    },
    {
      id: "crypto_concentration",
      name: "Concentración cripto alta",
      fired: criptoPct > 60,
      severity: criptoPct > 75 ? "CRITICAL" : "WARNING",
      suggestedMode: null,
      message: `Cripto es ${criptoPct.toFixed(1)}% del portafolio (umbral 60%). Revisar diversificación. No es consejo financiero.`
    },
    {
      id: "big_market_news",
      name: "Noticia de mercado relevante",
      fired: bigNews.length > 0,
      severity: "INFO",
      suggestedMode: null,
      message: bigNews.length ? `Noticias de impacto alto: ${bigNews.map(n => n.headline).join(" · ").slice(0, 220)}` : ""
    },
    {
      id: "recovery_mode",
      name: "Journal negativo + sueño bajo → recovery mode",
      fired: lastMood === "negativo" && h.sleep !== null && h.sleep < 60,
      severity: "WARNING",
      suggestedMode: "RECOVERY",
      message: h.sleep !== null ? `Último mood negativo y sleep ${h.sleep}% (<60%). Sugerencia: recovery mode — descanso, sin decisiones grandes hoy.` : ""
    }
  ];
  const fired = rules.filter(r => r.fired).map(r => ({
    id: r.id, name: r.name, severity: r.severity, suggestedMode: r.suggestedMode,
    message: r.message, date: todayKey(), ts: Date.now()
  }));
  return { rules, fired, criptoPct };
}

// Persiste eventos disparados (1 por regla por día, append-only con cap).
function recordAutomationEvents(fired) {
  if (!fired.length) return loadJSON(AUTOMATION_EVENTS_FILE, []);
  const events = loadJSON(AUTOMATION_EVENTS_FILE, []);
  let changed = false;
  for (const ev of fired) {
    if (!events.some(e => e.id === ev.id && e.date === ev.date)) { events.push(ev); changed = true; }
  }
  const capped = events.slice(-200);
  if (changed) saveJSON(AUTOMATION_EVENTS_FILE, capped);
  return capped;
}

function getAutomationState() {
  const { rules, fired, criptoPct } = evaluateAutomationRules();
  const events = recordAutomationEvents(fired);
  return {
    ok: true, ts: Date.now(),
    defensiveMode: !!settings.defensiveMode,
    rules: rules.map(r => ({ id: r.id, name: r.name, fired: !!r.fired, severity: r.severity, suggestedMode: r.suggestedMode, message: r.fired ? r.message : null })),
    firedToday: events.filter(e => e.date === todayKey()),
    history: events.slice(-30).reverse(),
    criptoPct: +criptoPct.toFixed(1),
    educationalNote: "Reglas locales educativas. Nunca ejecutan compras ni órdenes reales."
  };
}

// Readiness 0-100 por dominio, con heurísticas transparentes.
function computeDomainReadiness(h, pv, jd, automation) {
  const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
  const health = h.recovery !== null && h.sleep !== null ? clamp(h.recovery * 0.6 + h.sleep * 0.4)
    : h.recovery !== null ? clamp(h.recovery) : null;
  let trading = 60;
  if (health !== null) trading += (health - 60) * 0.4;
  trading -= automation.firedToday.filter(e => e.severity !== "INFO").length * 12;
  if (settings.defensiveMode) trading -= 20;
  const study = h.sleep !== null ? clamp(h.sleep * 0.7 + (h.recovery || h.sleep) * 0.3) : null;
  const social = h.strain !== null ? clamp(95 - Math.max(0, h.strain - 8) * 6 + (h.recovery ? (h.recovery - 50) / 5 : 0)) : null;
  return {
    health: { score: health, status: h.configured ? "LIVE" : "FALLBACK" },
    trading: { score: clamp(trading), status: "HEURISTIC" },
    study: { score: study, status: study === null ? "FALLBACK" : "HEURISTIC" },
    social: { score: social, status: social === null ? "FALLBACK" : "HEURISTIC" }
  };
}

function computeJarvisBrain() {
  const h = computeHealthReadiness();
  const pv = portfolioValue();
  const reg = marketRegime();
  const jd = computeJournalData();
  const opp = getOpportunityState();
  const automation = getAutomationState();
  const alerts = loadAlerts().filter(a => !a.acknowledged).slice(-5);
  const quickNotes = loadJSON("data/jarvis_quick_notes.json", []);
  const readiness = computeDomainReadiness(h, pv, jd, automation);
  const mode = settings.defensiveMode ? "DEFENSIVO (manual)" : (h.operatingMode || "NORMAL");

  const warnings = [];
  for (const e of automation.firedToday) warnings.push({ severity: e.severity, text: e.message, source: "automation" });
  for (const a of alerts.slice(0, 3)) warnings.push({ severity: a.severity || "WARNING", text: a.title, source: "alerts" });

  const nextActions = [];
  if (settings.defensiveMode) nextActions.push("Modo defensivo activo: hoy solo observar, nada de riesgo nuevo.");
  if (h.recovery !== null && h.recovery < 50) nextActions.push("Prioriza descanso: recovery bajo. Mueve lo no urgente a mañana.");
  if (automation.criptoPct > 60) nextActions.push(`Revisar concentración cripto (${automation.criptoPct}%) — educativo.`);
  if (jd.count === 0 || !journalEntries.some(e => (e.date || "").slice(0, 10) === todayKey())) nextActions.push("Registrar nota del día en Journal (2 min).");
  const topOpp = (opp.topOpportunities || [])[0];
  if (topOpp) nextActions.push(`Leer research de ${topOpp.symbol} (${topOpp.score}/100) — paper only.`);
  const rsiExtremes = pv.assets.filter(x => x.indicatorStatus === "LIVE" && (x.ind.rsi >= 70 || x.ind.rsi <= 30)).slice(0, 3);
  if (rsiExtremes.length) nextActions.push(`RSI extremo (real, educativo): ${rsiExtremes.map(x => `${x.symbol} ${x.ind.rsi}`).join(", ")} — solo contexto técnico, no es consejo financiero.`);
  if (!nextActions.length) nextActions.push("Todo en orden: revisa el Today Feed y sigue con tu día.");

  const topFocus = warnings.find(w => w.severity === "CRITICAL")?.text
    || warnings.find(w => w.severity === "WARNING")?.text
    || (topOpp ? `Oportunidad educativa: ${topOpp.symbol} ${topOpp.score}/100` : "Mantener rutina: salud y journal al día.");

  return {
    ok: true, ts: Date.now(),
    state: {
      mode,
      summary: `Patrimonio ${money(pv.totalValueMXN)} (${pct(pv.totalGainPct)}) · Mercado ${reg.label} · Recovery ${h.recovery !== null ? h.recovery + "%" : "—"} · Sleep ${h.sleep !== null ? h.sleep + "%" : "—"}`,
      dataStatus: {
        whoop: h.configured ? "LIVE" : "FALLBACK",
        quotes: quotesFreshness(),
        cryptoQuotes: cryptoFreshness(),
        news: FINNHUB_API_KEY ? "LIVE" : "FALLBACK",
        mxAssets: "MANUAL",
        indicators: indicatorsFreshness()
      }
    },
    topFocus,
    warnings: warnings.slice(0, 6),
    nextActions: nextActions.slice(0, 5),
    readiness,
    memory: {
      journalEntries: jd.count,
      topMood: jd.topMood,
      quickNotes: Array.isArray(quickNotes) ? quickNotes.length : 0,
      summary: buildMemorySummary().summary
    },
    educationalNote: "Resumen educativo. No es asesoría financiera ni médica."
  };
}

// Today Feed: timeline unificado de eventos del día (y ayer como contexto).
let feedDedupeStats = { candidates: 0, shown: 0 };
function buildTodayFeed() {
  const items = [];
  const push = (ts, type, title, detail, status) => {
    if (!ts || !Number.isFinite(ts)) return;
    items.push({ ts, type, title: String(title).slice(0, 160), detail: detail ? String(detail).slice(0, 240) : null, status: status || "LIVE" });
  };
  const cutoff = Date.now() - 36 * 3600 * 1000;

  const h = computeHealthReadiness();
  if (h.configured && whoopCache.lastFetch) {
    push(whoopCache.lastFetch, "health", `WHOOP · Recovery ${h.recovery !== null ? h.recovery + "%" : "—"} · Sleep ${h.sleep !== null ? h.sleep + "%" : "—"}`,
      h.strain !== null ? `Strain ${h.strain.toFixed ? h.strain.toFixed(1) : h.strain} · HRV ${h.hrv || "—"} ms` : null, "LIVE");
  }

  // Snapshots deduplicados: máx 3 representativos (1 por bloque de 6h y solo
  // si el total cambió ≥0.4%) en vez de 6 casi idénticos del mismo minuto.
  const snapCandidates = portfolioHistory.slice(-360);
  const snapShown = dedupeTimeline(snapCandidates, { bucketMs: 6 * 3600 * 1000, minDeltaPct: 0.4, max: 3 });
  feedDedupeStats = { candidates: snapCandidates.length, shown: snapShown.length };
  for (const p of snapShown) push(p.t, "portfolio", `Snapshot portafolio: ${money(p.total)}`, `P&L global ${pct(p.pnl)}`, "LIVE");

  for (const e of journalEntries.slice(0, 5)) {
    const ts = e.ts || Date.parse(e.date || "") || null;
    push(ts, "journal", `Journal · ${e.mood || "nota"}`, (e.text || e.note || "").slice(0, 200), "LIVE");
  }

  for (const n of news.slice(0, 6)) push((n.datetime || 0) * 1000, "news", n.headline, n.source, FINNHUB_API_KEY ? "LIVE" : "FALLBACK");

  for (const d of loadJSON(TRADING_DECISION_FILE, []).slice(-5)) {
    const ts = d.ts || Date.parse(d.timestamp || d.date || "") || null;
    push(ts, "decision", `Decisión (paper): ${d.title || d.action || d.type || "registro"}`, d.summary || d.message || null, "SIMULATED");
  }

  for (const ev of loadJSON(AUTOMATION_EVENTS_FILE, []).slice(-8)) push(ev.ts, "automation", `Regla: ${ev.name}`, ev.message, "LIVE");

  for (const a of loadAlerts().slice(-5)) {
    const ts = Date.parse(a.timestamp || "") || null;
    push(ts, "alert", a.title, null, ts && Date.now() - ts > 24 * 3600 * 1000 ? "STALE" : "LIVE");
  }

  for (const t of (bot.thoughts || []).slice(-4)) {
    const ts = t.ts || t.t || null;
    push(ts, "autopilot", `Bot paper: ${(t.text || t.msg || "").slice(0, 120)}`, null, "SIMULATED");
  }

  const feed = items.filter(i => i.ts >= cutoff).sort((a, b) => b.ts - a.ts).slice(0, 40);
  return { ok: true, ts: Date.now(), count: feed.length, items: feed, note: "Eventos de las últimas 36h. Badges indican origen del dato." };
}


function buildDecisionRecords() {
  const stored = loadJSON(TRADING_DECISION_FILE, []);
  const rows = Array.isArray(stored) ? stored.slice(-80) : [];
  const botRows = Array.isArray(bot.history) ? bot.history.slice(-40).map(x => ({ ...x, source: "paper_bot" })) : [];
  const currentIdea = computeTradeIdea();
  return [
    ...rows,
    ...botRows,
    { timestamp: nowMX(), ts: Date.now(), source: "current_trade_idea", tradeIdea: currentIdea, operatingMode: computeHealthReadiness().operatingMode }
  ].slice(-120);
}
function buildDecisionPatterns() {
  const decisions = buildDecisionRecords();
  const symbols = {};
  decisions.forEach(d => {
    const sym = (d.symbol || (d.tradeIdea && d.tradeIdea.symbol) || "PORTFOLIO").toString().toUpperCase();
    symbols[sym] = (symbols[sym] || 0) + 1;
  });
  const topSymbols = Object.entries(symbols).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([symbol, count]) => ({ symbol, count }));
  const ideaTypes = {};
  decisions.forEach(d => {
    const t = (d.type || (d.tradeIdea && d.tradeIdea.type) || "OBSERVE").toString().toUpperCase();
    ideaTypes[t] = (ideaTypes[t] || 0) + 1;
  });
  return { ok: true, ts: Date.now(), count: decisions.length, topSymbols, ideaTypes, educationalNote: "Patrones educativos; no automatizan trading." };
}
function buildDecisionPlaybook() {
  const h = computeHealthReadiness();
  const opp = getOpportunityState();
  return {
    ok: true,
    ts: Date.now(),
    rules: [
      "Nunca ejecutar compra/venta desde Cordelius; paper/research only.",
      "Si WHOOP/Health OS está en DEFENSIVO, reducir impulsividad y tamaño de hipótesis paper.",
      "Toda oportunidad necesita tesis, riesgo, catalizador y fecha antes de simular.",
      "Si research cache no tiene noticias/proveedor, validar fuera de Cordelius.",
      "Usar Opportunity Engine como lista de investigación, no como señal financiera."
    ],
    currentMode: h.operatingMode,
    topOpportunity: (opp.topOpportunities || [])[0] || null,
    educationalNote: "Playbook personal educativo. No es asesoría financiera."
  };
}
function buildProjectStatus() {
  const opp = getOpportunityState();
  const h = computeHealthReadiness();
  return {
    ok: true,
    ts: Date.now(),
    app: CORDA_APP_NAME,
    phase: "Cordelius OS unified · Phase 5B reconciled",
    modules: {
      healthOS: true,
      whoop: WHOOP_CONFIGURED,
      marketBrain: true,
      dailyIntelligence: true,
      executiveLayer: true,
      projectMemory: true,
      decisionIntelligence: true,
      opportunityEngine: !!opp.ok,
      telegramJarvis: true
    },
    branding: { homeTitle: "Cordelius", assistant: "Jarvis", legacyAlias: "Alfredo" },
    healthMode: h.operatingMode,
    topOpportunity: (opp.topOpportunities || [])[0] || null,
    educationalNote: "Estado del proyecto local; no contiene secretos."
  };
}
function buildProjectMemory() {
  const memory = loadJSON("data/project_memory.json", []);
  const rows = Array.isArray(memory) ? memory : [];
  const latestBuild = {
    ts: Date.now(),
    time: nowMX(),
    title: "Phase 5B Opportunity Engine reconciled",
    summary: "Jarvis/Executive/Project Memory preserved with Opportunity Engine APIs and UI.",
    modules: ["Health OS", "Market Brain", "Executive Layer", "Decision Intelligence", "Opportunity Engine", "Telegram Jarvis"]
  };
  const combined = rows.length ? rows.slice(-20) : [latestBuild];
  return { ok: true, ts: Date.now(), buildLog: combined, latest: combined[combined.length - 1] || latestBuild, status: buildProjectStatus(), educationalNote: "Memoria de proyecto local." };
}
function buildExecutiveScore() {
  const h = computeHealthReadiness();
  const pv = portfolioValue();
  const opp = getOpportunityState();
  const top = (opp.topOpportunities || [])[0];
  const healthScore = h.recovery != null ? Number(h.recovery) : 60;
  const portfolioScore = Math.max(0, Math.min(100, 50 + Number(pv.totalGainPct || 0)));
  const opportunityScore = top ? Number(top.score || 0) : 50;
  const riskPenalty = top ? Math.max(0, Number(top.riskScore || 0) - 55) : 0;
  const score = Math.max(1, Math.min(99, Math.round(healthScore * 0.25 + portfolioScore * 0.30 + opportunityScore * 0.30 + 15 - riskPenalty * 0.2)));
  return { ok: true, ts: Date.now(), score, components: { healthScore, portfolioScore, opportunityScore, riskPenalty }, operatingMode: h.operatingMode, educationalNote: "Score ejecutivo educativo; no es señal financiera." };
}
function buildExecutiveBriefing() {
  const pv = portfolioValue();
  const h = computeHealthReadiness();
  const reg = marketRegime();
  const daily = computeDailyScan();
  const opp = getOpportunityState();
  const memory = buildMemorySummary();
  const score = buildExecutiveScore();
  const top = (opp.topOpportunities || [])[0];
  return {
    ok: true,
    ts: Date.now(),
    title: "Cordelius Executive Briefing",
    assistant: "Jarvis",
    score,
    portfolio: { totalMXN: pv.totalValueMXN, gainPct: pv.totalGainPct, assets: pv.assets.length },
    health: { operatingMode: h.operatingMode, recovery: h.recovery, sleep: h.sleep, strain: h.strain },
    market: { regime: reg.label, detail: reg.detail, dailyIntelligence: { affectedTickers: daily.affectedTickers, hotTickers: daily.hotTickers, positiveCount: daily.intelPositiveCount, negativeCount: daily.intelNegativeCount } },
    opportunityEngine: { topOpportunity: top || null, topOpportunities: (opp.topOpportunities || []).slice(0, 5), topRisks: (opp.topRisks || []).slice(0, 5), researchQueue: opp.researchQueue || [] },
    memory,
    nextActions: [
      top ? `Investigar ${top.symbol} (${top.score}/100), solo educativo.` : "Recolectar más datos para oportunidades.",
      "Revisar Health OS antes de cualquier simulación.",
      "Actualizar Project Memory / Decision Intelligence después de decisiones importantes."
    ],
    disclaimer: "Educativo. No es asesoría financiera ni médica. No ejecuta trades."
  };
}

function computeIntelligence() {
  const pv = portfolioValue();
  const radar = computeMarketRadar();
  const trending = computeQuiverTrending();

  const topics = intelItems.slice(0, 10).map(x => ({
    text: String(x.text || "").slice(0, 200),
    mood: x.mood,
    affected: x.affected || [],
    time: x.time
  }));

  const impactedTickers = [...new Set(intelItems.flatMap(x => x.affected || []))].map(sym => {
    const asset = pv.assets.find(a => a.symbol === sym);
    const intelCount = intelItems.filter(x => (x.affected || []).includes(sym)).length;
    const moods = intelItems.filter(x => (x.affected || []).includes(sym)).map(x => x.mood);
    const sentiment = moods.filter(m => m === "POSITIVO").length > moods.filter(m => m === "NEGATIVO").length ? "POSITIVO" : "NEGATIVO";
    return { symbol: sym, intelCount, sentiment, score: asset ? asset.score : null, inPortfolio: !!asset };
  }).sort((a, b) => b.intelCount - a.intelCount);

  const portfolioImpacts = pv.assets.map(a => {
    const myIntel = intelItems.filter(x => (x.affected || []).includes(a.symbol));
    return {
      symbol: a.symbol, score: a.score, signal: a.signal, gainPct: +a.gainPct.toFixed(2),
      intelCount: myIntel.length,
      intelMoods: myIntel.map(x => x.mood),
      quiverSignals: trending.topTickers.find(t => t.symbol === a.symbol)?.total || 0
    };
  }).filter(x => x.intelCount > 0 || x.quiverSignals > 0);

  const summaryLines = [`${intelItems.length} items de inteligencia manual.`];
  if (trending.quiverCount > 0) summaryLines.push(`${trending.quiverCount} registros Quiver: congreso, insiders, contratos.`);
  if (impactedTickers.length > 0) summaryLines.push(`Tickers más mencionados: ${impactedTickers.slice(0, 4).map(t => t.symbol).join(", ")}.`);
  summaryLines.push("EDUCATIVO.");

  return {
    ok: true, ts: Date.now(),
    topics,
    impactedTickers: impactedTickers.slice(0, 15),
    politicalTrading: trending.latestTrades.slice(0, 10),
    marketRadar: radar.hotTickers.slice(0, 10),
    portfolioImpacts,
    educationalSummary: summaryLines.join(" ")
  };
}

function classifyNews(n) {
  const text = `${n.headline || ""} ${n.summary || ""} ${n.source || ""}`.toLowerCase();
  let type = "MERCADO";
  if (/fed|rate|rates|inflation|cpi|jobs|gdp|treasury|yields|employment/.test(text)) type = "MACRO";
  if (/ai|chip|semiconductor|earnings|revenue|cloud|software|data center/.test(text)) type = "TECH/EMPRESA";
  if (/war|iran|israel|russia|china|tariff|sanction|election|congress/.test(text)) type = "POLITICA/RIESGO";
  if (/bitcoin|crypto|ethereum|xrp|coinbase|blockchain/.test(text)) type = "CRIPTO";
  let bias = "CENTRO/NEUTRAL";
  if (/tax cut|deregulation|oil|business|profit|wall street/.test(text)) bias = "DERECHA/MERCADO";
  if (/climate|inequality|labor|union|regulation|consumer protection/.test(text)) bias = "IZQUIERDA/REGULACION";
  let region = "OCCIDENTAL";
  if (/china|japan|korea|asia|taiwan|hong kong|india/.test(text)) region = "ASIA/ORIENTAL";
  if (/mexico|peso|banxico|latam|brazil/.test(text)) region = "LATAM";
  let impact = "NEUTRAL", impactColor = "#ffd166";
  if (/beat|surge|rally|record|growth|gains|soar|up |higher/.test(text)) { impact = "POSITIVO"; impactColor = "#00ff99"; }
  if (/miss|fall|drop|cut|loss|down |lower|crash|fear|selloff/.test(text)) { impact = "NEGATIVO"; impactColor = "#ff4d6d"; }
  const confidence = 55 + (seedFor(text.slice(0, 12)) % 35);
  return { type, bias, region, impact, impactColor, confidence };
}

function impactedAssets(n) {
  const text = `${n.headline || ""} ${n.summary || ""} ${n.symbol || ""}`.toLowerCase();
  const hits = new Set();
  for (const a of PORTFOLIO) {
    if (text.includes(a.symbol.toLowerCase()) || text.includes(a.name.toLowerCase().split(" ")[0])) hits.add(a.symbol);
  }
  if (/ai|chip|semiconductor|nvidia|data center|cloud/.test(text)) ["MSFT", "PLTR", "IREN"].forEach(x => hits.add(x));
  if (/apple|iphone|ios/.test(text)) hits.add("AAPL");
  if (/microsoft|copilot|openai|cloud/.test(text)) hits.add("MSFT");
  if (/ge vernova|energy|grid|power|electricity/.test(text)) ["GEV", "AEP", "IREN"].forEach(x => hits.add(x));
  if (/bitcoin|crypto|coinbase|blockchain/.test(text)) ["BTC", "ETH", "XRP"].forEach(x => hits.add(x));
  if (/copper|mining|commodity|commodities/.test(text)) hits.add("COPX");
  if (/health|medicare|drug|hospital/.test(text)) hits.add("UNH");
  if (/bank|rates|interest|peso|mexico/.test(text)) hits.add("BBVA");
  if (/war|iran|israel|oil|sanction|geopolitical/.test(text)) ["BTC", "AAPL", "MSFT", "COPX"].forEach(x => hits.add(x));
  if (/streaming|netflix|media/.test(text)) hits.add("NFLX");
  return Array.from(hits).slice(0, 8);
}

function botValue() {
  let v = bot.cash || 0;
  const pv = portfolioValue();
  for (const [sym, pos] of Object.entries(bot.positions || {})) {
    const asset = pv.assets.find(a => a.symbol === sym);
    if (!asset) continue;
    const priceMXN = asset.valueMXN / Math.max(asset.units, 1e-8);
    v += pos.units * priceMXN;
  }
  return v;
}

function addThought(text, level = "info") {
  bot.thoughts = bot.thoughts || [];
  bot.thoughts.unshift({ text, level, time: nowMX() });
  bot.thoughts = bot.thoughts.slice(0, 40);
}

function generateLiveThought(pv, reg) {
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  const top = ranked[0], bottom = ranked[ranked.length - 1];
  const totalMXN = pv.totalValueMXN || 1;
  const cryptoPct = (pv.assets.filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0) / totalMXN * 100).toFixed(0);
  const losers = pv.assets.filter(a => a.gainPct < -10);
  const winners = pv.assets.filter(a => a.gainPct > 50);
  const highScore = pv.assets.filter(a => a.score >= 70);
  const qCount = quiverData.congressional.length + quiverData.insider.length + quiverData.contracts.length;

  const pool = [
    { text: `Portafolio ${money(pv.totalValueMXN)} · rendimiento ${pct(pv.totalGainPct)} · regimen ${reg.label}.`, level: "scan" },
    { text: `Mejor score hoy: ${top.symbol} (${top.score}/100) · RSI ${top.ind.rsi} · señal ${top.signal}.`, level: "scan" },
    { text: `Activo mas debil: ${bottom.symbol} (score ${bottom.score}/100, ${pct(bottom.gainPct)}) · tendencia ${bottom.ind.trend.toLowerCase()}.`, level: "risk" },
    { text: `Cripto representa ${cryptoPct}% del portafolio · ${cryptoPct > 45 ? "RIESGO ALTO — concentracion elevada" : "dentro de rango aceptable"}.`, level: cryptoPct > 45 ? "risk" : "scan" },
    { text: `Regimen ${reg.label}: ${reg.detail} · promedio ${pct(reg.avg)}.`, level: "scan" },
    losers.length ? { text: `${losers.length} activo(s) en drawdown mayor -10%: ${losers.map(a => a.symbol).join(", ")}.`, level: "risk" } : null,
    winners.length ? { text: `${winners.map(a => a.symbol).join(", ")} acumula(n) +50% o mas · evaluar toma parcial educativa.`, level: "sell" } : null,
    highScore.length ? { text: `Señales positivas: ${highScore.map(a => a.symbol + " " + a.score + "/100").join(", ")}.`, level: "buy" } : null,
    qCount > 0 ? { text: `Quiver: ${qCount} registros institucionales en activos del portafolio · congreso, insiders, contratos.`, level: "scan" } : null,
    { text: `Momentum dominante del portafolio: ${reg.avg >= 0 ? "positivo" : "negativo"} · ${pv.assets.filter(a => a.ind.momentum > 0).length}/${pv.assets.length} activos con momentum alcista.`, level: reg.avg >= 0 ? "buy" : "risk" },
    { text: `${pv.assets.filter(a => a.signal.includes("BUY")).length} señales BUY activas · ${pv.assets.filter(a => a.signal.includes("TOMAR")).length} señales de toma de ganancia.`, level: "scan" },
    intelItems.length > 0 ? { text: `${intelItems.length} items en Cordelius Intelligence · ${intelItems.filter(x => x.mood === "POSITIVO").length} positivos, ${intelItems.filter(x => x.mood === "NEGATIVO").length} negativos.`, level: "scan" } : null,
  ].filter(Boolean);

  const pick = pool[Math.floor(Math.random() * pool.length)];
  addThought(pick.text, pick.level);
}

function botTick() {
  if (!bot.running) { addThought("Bot pausado: monitoreo visual activo, sin compras simuladas.", "warn"); saveJSON(BOT_FILE, bot); return; }
  const pv = portfolioValue();
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  generateLiveThought(pv, marketRegime());

  for (const a of ranked.slice(0, 5)) {
    const priceMXN = a.valueMXN / Math.max(a.units, 1e-8);
    if (!bot.positions[a.symbol] && bot.cash > 70 && (a.signal.includes("BUY DIP") || a.signal.includes("MOMENTUM"))) {
      const spend = Math.min(bot.cash * 0.12, 120);
      const units = spend / priceMXN;
      bot.cash -= spend;
      bot.positions[a.symbol] = { units, avgMXN: priceMXN, sl: priceMXN * 0.92, tp: priceMXN * 1.14 };
      bot.tradesCount++;
      bot.history.unshift({ type: "BUY", symbol: a.symbol, units, priceMXN, value: spend, pnl: 0, reason: `${a.signal}; score ${a.score}; riesgo ${a.risk}`, time: nowMX() });
      addThought(`COMPRA simulada en ${a.symbol}: score ${a.score}, señal ${a.signal}. Tamano pequeno con stop.`, "buy");
      break;
    }
  }
  for (const [sym, pos] of Object.entries(bot.positions || {})) {
    const a = pv.assets.find(x => x.symbol === sym);
    if (!a) continue;
    const priceMXN = a.valueMXN / Math.max(a.units, 1e-8);
    const pnl = (priceMXN - pos.avgMXN) * pos.units;
    const sellNow = priceMXN <= pos.sl || priceMXN >= pos.tp || a.signal.includes("TOMAR GANANCIA");
    if (sellNow) {
      const value = pos.units * priceMXN;
      bot.cash += value; bot.totalRealizedPnl += pnl; bot.tradesCount++;
      bot.history.unshift({ type: "SELL", symbol: sym, units: pos.units, priceMXN, value, pnl, reason: priceMXN <= pos.sl ? "Stop loss simulado" : priceMXN >= pos.tp ? "Take profit simulado" : "Senal Jarvis", time: nowMX() });
      delete bot.positions[sym];
      addThought(`VENTA simulada en ${sym}: ${pnl >= 0 ? "asegurando ganancia" : "cortando riesgo"} (${money(pnl)}).`, pnl >= 0 ? "sell" : "risk");
    }
  }
  const eq = botValue();
  bot.equityHistory.push({ t: Date.now(), v: eq });
  // Retención multi-día (antes el cap de 500 minutos borraba todo lo >8h):
  // minuto a minuto las últimas 24h, 1 punto/hora para lo anterior.
  {
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const old = bot.equityHistory.filter(p => p.t < dayAgo);
    const recent = bot.equityHistory.filter(p => p.t >= dayAgo);
    const hourly = []; let lastHr = null;
    for (const p of old) { const hr = Math.floor(p.t / 3600000); if (hr !== lastHr) { hourly.push(p); lastHr = hr; } }
    bot.equityHistory = hourly.concat(recent).slice(-2000);
  }
  const peak = Math.max(...bot.equityHistory.map(x => x.v), bot.initialCapital);
  bot.maxDrawdown = Math.max(bot.maxDrawdown || 0, peak ? ((peak - eq) / peak) * 100 : 0);
  bot.lastTick = new Date().toISOString();
  bot.history = (bot.history || []).slice(0, 100);
  saveJSON(BOT_FILE, bot);
}


async function askClaude(question, localReply, pv, reg, botEq, botPnl) {
  if (!settings.thinkingEnabled || !ANTHROPIC_API_KEY) return "";

  const assetsContext = (pv.assets || []).map(a => ({
    symbol: a.symbol,
    broker: a.source,
    category: a.category,
    name: a.name,
    units: a.units,
    currency: a.currency,
    originalCost: a.costManual,
    currentValueManual: a.valueManual,
    currentLiveValue: a.liveValue,
    valueMXN: a.valueMXN,
    costMXN: a.costMXN,
    gainMXN: a.gainMXN,
    gainPct: a.gainPct,
    dayPct: a.day,
    score: a.score,
    risk: a.risk,
    signal: a.signal,
    buyZone: a.zones && a.zones.buy,
    sellZone: a.zones && a.zones.sell,
    stopZone: a.zones && a.zones.stop,
    quoteSource: a.quoteSource
  }));

  const intelContext = (typeof intelItems !== "undefined" && Array.isArray(intelItems))
    ? intelItems.slice(0, 5).map(x => ({
        mood: x.mood,
        affected: x.affected,
        tags: x.tags,
        time: x.time,
        text: String(x.text || "").slice(0, 900)
      }))
    : [];

  const botContext = {
    equityMXN: botEq,
    pnlMXN: botPnl,
    running: bot.running,
    cashMXN: bot.cash,
    tradesCount: bot.tradesCount,
    maxDrawdown: bot.maxDrawdown,
    positions: bot.positions,
    lastHistory: (bot.history || []).slice(0, 8)
  };

  const prompt = `

Eres Jarvis AI dentro de Cordelius. Responde en español mexicano, claro, directo y útil.

No eres asesor financiero. Da análisis educativo, no órdenes definitivas.
Usa SIEMPRE los costos originales y valores reales del portafolio cuando hables de rendimiento.

PREGUNTA DEL USUARIO:
${question}

RESPUESTA LOCAL BASE:
${localReply}

RESUMEN PORTAFOLIO:
- Patrimonio total MXN: ${pv.totalValueMXN}
- Costo total MXN: ${pv.totalCostMXN}
- Ganancia total MXN: ${pv.totalGainMXN}
- Ganancia total %: ${pv.totalGainPct}
- Régimen mercado: ${reg.label} / ${reg.detail}
- Tipo cambio usado USD/MXN: ${FX_USD_MXN}

ACTIVOS CON COSTO ORIGINAL, VALOR ACTUAL Y RIESGO:
${JSON.stringify(assetsContext, null, 2)}

INTEL MANUAL PEGADA EN CORDelius:
${JSON.stringify(intelContext, null, 2)}

BOT FICTICIO:
${JSON.stringify(botContext, null, 2)}

REGLAS DE RESPUESTA:
1. Si mencionas Apple/AAPL, recuerda que costo original fue aprox. 2640 MXN y valor manual aprox. 5450 MXN.
2. Distingue broker: GBM, Plata, Bitso.
3. Para activos en USD, explica si estás hablando en USD o equivalente MXN.
4. Si el usuario pregunta comprar/vender, responde con escenarios: mantener, tomar ganancia parcial, esperar, reducir riesgo.
5. Prioriza riesgo de concentración: Bitso/cripto es gran parte del portafolio.
6. No inventes precios de mercado si no vienen en el contexto.
7. Termina con una acción práctica concreta para revisar dentro del dashboard.
`;

  const payload = JSON.stringify({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 900,
    temperature: 0.35,
    system: "Eres Jarvis AI, copiloto educativo de trading y portafolio. No das asesoría financiera; ayudas a entender riesgo, costos, exposición y escenarios.",
    messages: [{ role: "user", content: prompt }]
  });

  return await new Promise(resolve => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-length": Buffer.byteLength(payload)
      },
      timeout: 25000
    }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const txt = j && j.content && j.content[0] && j.content[0].text;
          if (txt) return resolve(txt);
          console.log("Claude sin texto:", data.slice(0, 500));
          return resolve("");
        } catch (e) {
          console.log("Claude parse error:", e.message);
          return resolve("");
        }
      });
    });

    req.on("timeout", () => {
      console.log("Claude timeout");
      req.destroy();
      resolve("");
    });

    req.on("error", e => {
      console.log("Claude error:", e.message);
      resolve("");
    });

    req.write(payload);
    req.end();
  });
}

async function alfredoReply(question) {
  const q = question.toLowerCase();
  const pv = portfolioValue();
  const reg = marketRegime();
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  const best = ranked[0], worst = ranked[ranked.length - 1];
  const botEq = botValue(), botPnl = botEq - bot.initialCapital;
  let reply = "";
  const qCount = quiverData.congressional.length + quiverData.insider.length + quiverData.contracts.length;

  // Detect specific portfolio ticker mentioned in question
  const mentionedAsset = pv.assets.find(a =>
    q.includes(a.symbol.toLowerCase()) ||
    (a.name && a.name.toLowerCase().split(" ").some(w => w.length > 3 && q.includes(w.toLowerCase())))
  );

  const isAboutCost = q.includes("cuanto") || q.includes("cuánto") || q.includes("cuanta") ||
    q.includes("cuánta") || q.includes("promedio") || q.includes("invert") ||
    q.includes("costo") || q.includes("comi") || q.includes("compré") || q.includes("compre");

  if (isAboutCost && mentionedAsset) {
    const a = mentionedAsset;
    const units = a.units || 0;
    const avgBuyMXN = units > 0 ? a.costMXN / units : 0;
    const avgBuyUSD = (a.currency === "USD" && units > 0) ? (a.costManual / units) : null;
    const curPriceMXN = units > 0 ? a.valueMXN / units : 0;
    const curPriceUSD = (a.currency === "USD" && units > 0) ? (a.liveValue / units) : null;
    const unitsStr = a.type === "crypto" ? Number(units).toFixed(units < 1 ? 8 : 4) + " " + a.symbol : units + " acciones";
    const avgStr = a.currency === "USD" && avgBuyUSD != null ? money(avgBuyUSD, "USD") + " (≈ " + money(avgBuyMXN) + ")" : money(avgBuyMXN);
    const curStr = a.currency === "USD" && curPriceUSD != null ? money(curPriceUSD, "USD") + " (≈ " + money(curPriceMXN) + ")" : money(curPriceMXN);
    reply = `${a.display} — ${a.name} (${a.source}):
• Cantidad: ${unitsStr}
• Costo original: ${money(a.costMXN)}
• Promedio de compra: ${avgStr} por unidad
• Precio actual: ${curStr} por unidad
• Valor actual: ${money(a.valueMXN)}
• Ganancia: ${money(a.gainMXN)} (${pct(a.gainPct)})
• Riesgo: ${a.risk} · Score: ${a.score}/100
EDUCATIVO — no es asesoría financiera.`;
  } else if (isAboutCost && !mentionedAsset) {
    // General "promedio de compra" for top assets by value
    const top = pv.assets.slice().sort((a, b) => b.valueMXN - a.valueMXN).slice(0, 6);
    reply = `Resumen de costos (mayor valor primero):\n` + top.map(a => {
      const u = a.units || 0;
      const avg = u > 0 ? money(a.costMXN / u) : "n/d";
      return `• ${a.symbol}: costo ${money(a.costMXN)} · promedio ${avg}/u · ahora ${money(a.valueMXN)} (${pct(a.gainPct)})`;
    }).join("\n") + "\nEDUCATIVO — no asesoría financiera.";
  } else if (q.includes("riesgo")) {
    const high = pv.assets.filter(a => a.risk === "ALTO" || a.risk === "MEDIO/ALTO");
    const cryptoPct = (pv.assets.filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0) / (pv.totalValueMXN || 1) * 100).toFixed(0);
    reply = `Tu riesgo principal esta en ${high.map(a => a.symbol).join(", ")}. Cripto ${cryptoPct}% del portafolio. Regimen ${reg.label}. Los de mayor riesgo pueden moverse fuerte en ambas direcciones.`;
  } else if (q.includes("vender") || q.includes("vendo") || q.includes("que vendo")) {
    const losers = ranked.filter(a => a.gainPct < -10 || a.score < 35).slice(0, 3);
    reply = `Para revisar primero: ${losers.length ? losers.map(a => `${a.symbol} (score ${a.score}, ${pct(a.gainPct)})`).join(", ") : worst.symbol + " (score " + worst.score + ")"}. Evaluar tesis, no venta automatica.`;
  } else if (q.includes("comprar") || q.includes("compro")) {
    const ideas = ranked.filter(a => a.signal.includes("BUY") || a.signal.includes("MOMENTUM")).slice(0, 4);
    reply = ideas.length ? `Ideas educativas: ${ideas.map(a => `${a.symbol} (${a.signal})`).join(", ")}. Confirmaria con tendencia y tamano pequeno.` : "No veo compra clara. Mercado " + reg.label + ": mejor paciencia.";
  } else if (q.includes("research queue") || q.includes("cola de research") || q.includes("cola de investigación") || q.includes("que hay en research queue") || q.includes("qué hay en research queue")) {
    const queue = getResearchQueue();
    const memory = buildMemorySummary();
    reply = queue.length
      ? `Research Queue: ${queue.join(", ")}. ${memory.summary} Puedes pedir "Analiza NVDA" o ejecutar el queue desde Autopilot. EDUCATIVO — no es señal de trading.`
      : `Research Queue vacía. ${memory.summary} Puedo sugerir una acción para investigar con el Opportunity Engine. EDUCATIVO.`;
  } else if (q.includes("qué acción debería investigar") || q.includes("que accion deberia investigar") || q.includes("acción debería investigar") || q.includes("accion deberia investigar") || q.includes("oportunidad nueva") || q.includes("oportunidad viste")) {
    const opp = getOpportunityState();
    const top = (opp.topOpportunities || [])[0];
    reply = top
      ? `Opportunity Engine: investigaría primero ${top.symbol} (${top.score}/100). Motivo: ${top.reason}. Riesgo: ${top.riskScore}/100. No es compra/venta; solo prioridad de investigación educativa.`
      : "No veo una oportunidad nueva con datos suficientes. Mantengo watchlist en observación educativa.";
  } else if (q.includes("analiza ") || q.includes("analizar ") || q.includes("research ")) {
    const symbols = uniqueStrings([...(q.match(/\b[A-Z]{2,5}\b/g) || []), ...(question.match(/\b[A-Z]{2,5}\b/g) || [])]);
    const sym = symbols.find(x => MARKET_WATCHLIST.includes(x) || PORTFOLIO.some(a => a.symbol === x)) || symbols[0];
    if (sym) {
      const r = researchStock(sym);
      reply = r.ok ? `Research ${r.symbol}: score ${r.score}/100 · riesgo ${r.riskScore}/100 · ${r.signal}. Tesis: ${r.thesis} Riesgos: ${(r.risks || []).slice(0,2).join(" ") || "sin riesgos destacados en cache"}. EDUCATIVO — no es recomendación financiera.` : `No pude analizar ${sym}. ${r.educationalNote || "Ticker inválido."}`;
    } else {
      const opp = getOpportunityState();
      const top = (opp.topOpportunities || [])[0];
      reply = top ? `¿Quieres que analice ${top.symbol}? Es la primera oportunidad del engine (${top.score}/100).` : "Dime un ticker, por ejemplo: Analiza NVDA.";
    }
  } else if (q.includes("vigilar") || q.includes("analiza") || q.includes("que harias") || q.includes("hoy")) {
    const scan = computeDailyScan();
    const alerts = scan.riskAlerts.slice(0, 3).map(a => a.message).join("; ");
    const actions = scan.educationalActions.slice(0, 2).map(a => `${a.priority}: ${a.symbol} — ${a.action}`).join(". ");
    const radar = computeMarketRadar();
    const extHot = radar.hotTickers.filter(t => !t.inPortfolio).slice(0, 3).map(t => t.symbol).join(", ");
    reply = `Scan portafolio: ${alerts || "sin alertas criticas"}. Acciones: ${actions || "mantener y monitorear"}.${extHot ? " Externos a vigilar: " + extHot + " (watchlist IA)." : ""}`;
  } else if (q.includes("externo") || q.includes("stocks externos") || q.includes("afuera") || q.includes("watchlist")) {
    const radar = computeMarketRadar();
    const ext = radar.hotTickers.filter(t => !t.inPortfolio).slice(0, 6);
    const trend = computeQuiverTrending();
    const extQ = trend.topTickers.filter(t => !PORTFOLIO.some(a => a.symbol === t.symbol)).slice(0, 4);
    if (ext.length || extQ.length) {
      const extList = ext.map(t => `${t.symbol}${t.quiverSignals > 0 ? " (Q×" + t.quiverSignals + ")" : ""}`).join(", ");
      const qList = extQ.map(t => `${t.symbol} (${t.buys}C/${t.sales}V)`).join(", ");
      reply = `Radar IA: ${extList || "sin señales"}. ${qList ? "Quiver externos: " + qList + "." : ""} No estan en tu portafolio — solo vigilancia educativa.`;
    } else {
      reply = `Watchlist: ${MARKET_WATCHLIST.slice(0, 8).join(", ")}. Con QUIVER_API_KEY verias cuales compran/venden politicos. EDUCATIVO.`;
    }
  } else if (q.includes("quiver") || q.includes("politico") || q.includes("congreso") || q.includes("insider") || q.includes("senador") || q.includes("diputado")) {
    if (qCount > 0) {
      const top = [...quiverData.congressional, ...quiverData.insider].slice(0, 3).map(m => `${(m.symbol || m.Ticker || "").toUpperCase()} (${m.Representative || m.Name || "politico"})`).join(", ");
      const trend = computeQuiverTrending();
      const topPols = trend.mostActivePoliticians.slice(0, 2).map(p => `${p.name} (${p.trades} trades)`).join(", ");
      reply = `Quiver: ${qCount} registros en tus activos. Recientes: ${top}.${topPols ? " Más activos: " + topPols + "." : ""} Datos educativos, retraso hasta 45 dias.`;
    } else {
      reply = "Sin datos Quiver activos. Agrega QUIVER_API_KEY en .env para ver trading politico e insider en tus acciones USA.";
    }
  } else if (q.includes("radar") || q.includes("mercado")) {
    const radar = computeMarketRadar();
    const hot = radar.hotTickers.slice(0, 4).map(t => t.symbol).join(", ");
    reply = `Market Radar: ${MARKET_WATCHLIST.length} tickers monitoreados. Mas activos ahora: ${hot || "sin señales destacadas"}. ${radar.portfolioOverlap.length} de tu portafolio en el radar.`;
  } else if (q.includes("intel") || q.includes("inteligencia") || q.includes("grok")) {
    const positivos = intelItems.filter(x => x.mood === "POSITIVO").length;
    const negativos = intelItems.filter(x => x.mood === "NEGATIVO").length;
    reply = `Cordelius Intelligence: ${intelItems.length} items. ${positivos} positivos, ${negativos} negativos. Tickers cubiertos: ${[...new Set(intelItems.flatMap(x => x.affected || []))].slice(0, 6).join(", ") || "sin items aun"}.`;
  } else if (q.includes("noticia")) {
    reply = `Hay ${news.length} noticias cargadas. Las cruzo contra tus activos para mostrar impacto probable por ticker.`;
  } else if (q.includes("bot")) {
    reply = `El bot ficticio tiene equity ${money(botEq)}, P&L ${money(botPnl)} y ${bot.tradesCount} operaciones. Laboratorio, no piloto automatico real.`;
  } else if (q.includes("daily brief") || q.includes("newsletter") || q.includes("pasó hoy") || q.includes("paso hoy") || q.includes("resumen")) {
    const nl = computeDailyNewsletter();
    reply = nl.lines.join("\n");
  } else if (q.includes("stocks calientes") || q.includes("caliente") || q.includes("qué hay afuera") || q.includes("que hay afuera")) {
    const emi = computeExternalMarketIntelligence();
    const hot = emi.externalHot.slice(0, 6);
    reply = hot.length
      ? `Stocks externos calientes: ${hot.map(t => `${t.symbol} (sector: ${t.sector}${t.quiverSignals > 0 ? ", Q×" + t.quiverSignals : ""})`).join(", ")}. EDUCATIVO — solo vigilancia.`
      : `Watchlist: ${MARKET_WATCHLIST.slice(0, 10).join(", ")}. Sin señales Quiver activas. Agrega QUIVER_API_KEY para ver datos institucionales.`;
  } else if (q.includes("sectores") || q.includes("sector")) {
    const st = computeSectorThemes();
    const portStr = st.portfolioSectors.map(s => `${s.sector} ${s.pct}%`).join(", ");
    const hotExt = st.hotSectors.slice(0, 3).map(s => s.sector).join(", ");
    reply = `Tu portafolio por sector: ${portStr}. Externos activos en Quiver: ${hotExt || "sin señales"}. EDUCATIVO.`;
  } else if (q.includes("congreso") || q.includes("insiders") || q.includes("qué dice quiver") || q.includes("que dice quiver")) {
    const qi = computeQuiverIntelligence();
    if (!qi.configured) {
      reply = "Sin datos Quiver. Agrega QUIVER_API_KEY en .env para ver: compras/ventas del Congreso USA, insider trading, contratos gubernamentales.";
    } else {
      const topPol = qi.activePoliticians[0];
      reply = `Quiver ON — Congreso: ${qi.congressional.buys} compras / ${qi.congressional.sales} ventas. Insider: ${qi.insider.buys} compras / ${qi.insider.sales} ventas. Contratos: ${qi.contracts.total}.${topPol ? " Más activo: " + topPol.name + " (" + topPol.trades + " trades)." : ""} Datos educativos, retraso típico 45 días.`;
    }
  } else if (q.includes("mis activos vs externos") || q.includes("portafolio vs") || q.includes("comparar")) {
    const pi = computePortfolioIntelligence();
    const emi = computeExternalMarketIntelligence();
    reply = `Mi portafolio: ${pi.assetCount} activos, ${money(pi.totalValueMXN)}, rendimiento ${pct(pi.totalGainPct)}. Externos vigilados: ${emi.externalAll.length} tickers externos en ${emi.sectors.length} sectores. ${emi.externalHot.length > 0 ? "Calientes: " + emi.externalHot.slice(0,4).map(t=>t.symbol).join(", ") + "." : ""} EDUCATIVO.`;
  } else if (q.includes("paper trading") || q.includes("alpaca") || q.includes("simulacion") || q.includes("simulación")) {
    const idea = computeTradeIdea();
    reply = idea.hasIdea
      ? `Paper Mode — ${idea.type}: ${idea.symbol} — ${idea.reason}. Confianza: ${idea.confidence}. Falta para operar real: ${idea.missingData}. Alpaca: pendiente de conexión. NO hay trading real.`
      : "Paper Mode activo. Sin idea de trade destacada ahora. Bot simulado: equity " + money(botEq) + ", P&L " + money(botPnl) + ". Alpaca: pendiente. NO hay trading real.";
  } else if (q.includes("morning report") || q.includes("reporte diario") || q.includes("reporte mañana") || q.includes("reporte manana")) {
    const nl = computeDailyNewsletter();
    const idea = computeTradeIdea();
    reply = `Morning Report — ${nl.date}. ${nl.lines.slice(0,3).join(" ")} ${idea.hasIdea ? "Idea: " + idea.type + " " + idea.symbol + " — " + idea.reason + "." : "Sin idea de trade destacada."} Endpoint: GET /api/morning-report`;
  } else if (q.includes("automatiz") || q.includes("autopilot") || q.includes("auto pilot")) {
    reply = `Automatización Cordelius — Scripts disponibles: health_check.sh (verifica /health), restart_safe.sh (reinicio seguro), morning_report.sh (guarda JSON en reports/), final_check.sh (valida antes de push). Usa bash scripts/health_check.sh desde ~/corde-bot. Cloud: conceptualmente listo para migrar a VPS/Railway. NO hay trading real ni órdenes automáticas.`;
  } else if (q.includes("estado del sistema") || q.includes("system status") || (q.includes("health") && !q.includes("healthcare"))) {
    reply = `Sistema Cordelius — Servidor: ONLINE (si ves esto). Paper Mode: ON. Real Trading: OFF. Alpaca: PENDIENTE. Quiver: ${quiverData.configured ? "ON" : "pendiente API key"}. Bot ficticio: equity ${money(botEq)}, P&L ${money(botPnl)}. Revisa /health para JSON completo.`;
  } else if (q.includes("cloud") || q.includes("nube") || q.includes("migrar") || q.includes("vps") || q.includes("servidor")) {
    reply = `Cloud / Migración — Cordelius puede migrar a VPS (Railway, Render, Fly.io) o servidor propio. Scripts de automatización ya preparados en scripts/. Requeriría: .env en variables de entorno del host, PM2 o systemd para proceso, HTTPS con reverse proxy. Sin Alpaca real no hay riesgo financiero. Actualmente: Termux/Android.`;
  } else if (q.includes("termux") || q.includes("android") || q.includes("watchdog")) {
    reply = `Termux — Cordelius corre en Termux (Android). Scripts: ./start.sh, ./stop.sh, ./watchdog.sh (reinicio automático si cae). Para inicio automático al boot: Termux:Boot (app separada) + script en ~/.termux/boot/. Sin Termux:Boot, iniciar manualmente tras reiniciar Android.`;
  } else if (q.includes("paper status") || q.includes("estado paper") || q.includes("bot status")) {
    const idea = computeTradeIdea();
    const m = botMetrics();
    reply = `Paper Status — Bot ficticio: ${bot.running ? "ACTIVO" : "PAUSADO"}. Equity: ${money(botEq)}. P&L: ${money(botPnl)}. Trades: ${m.totalTrades}. Ratio: ${m.winRatio}%. Trade idea: ${idea.hasIdea ? idea.type + " " + idea.symbol : "sin señal"}. Alpaca: PENDIENTE. NO hay dinero real.`;
  } else if (q.includes("salud") || q.includes("whoop") || q.includes("readiness") || q.includes("cómo estoy") || q.includes("como estoy")) {
    const h = computeHealthReadiness();
    reply = `Health Readiness — WHOOP: ${h.configured ? "detectado" : "pendiente de conexión"}. Recovery: ${h.recovery !== null ? h.recovery + "%" : "sin datos"}. Sleep: ${h.sleep !== null ? h.sleep + "%" : "sin datos"}. HRV: ${h.hrv !== null ? h.hrv + " ms" : "sin datos"}. Modo operativo: ${h.operatingMode}. Sugerencia: ${h.suggestion}. ${h.message} NO es consejo médico. El objetivo es evitar decisiones impulsivas cuando el estado físico esté bajo.`;
  } else if (q.includes("modo operativo") || q.includes("debo operar") || q.includes("puedo operar")) {
    const h = computeHealthReadiness();
    const idea = computeTradeIdea();
    reply = `Modo operativo: ${h.operatingMode}. ${h.configured ? "" : "Sin datos de WHOOP — usando modo neutral. "}${h.suggestion}. Trade idea: ${idea.hasIdea ? idea.type + " en " + idea.symbol + " (confianza " + idea.confidence + ")" : "sin señal destacada"}. RECORDATORIO: no es asesoría financiera ni consejo médico. Usar solo como contexto personal educativo.`;
  } else if (q.includes("morning report con salud") || q.includes("reporte con salud") || q.includes("reporte completo")) {
    const nl = computeDailyNewsletter();
    const h = computeHealthReadiness();
    const idea = computeTradeIdea();
    reply = `Morning Report — ${nl.date}. ${nl.lines.slice(0, 2).join(" ")} Estado personal: WHOOP ${h.configured ? "ON" : "pendiente"}, modo ${h.operatingMode}, ${h.suggestion}. Trade idea: ${idea.hasIdea ? idea.type + " " + idea.symbol : "sin señal"}. NO es asesoría financiera ni consejo médico.`;
  } else if (q.includes("diario") || q.includes("journal") || q.includes("debería escribir") || q.includes("deberia escribir")) {
    const jd = computeJournalData();
    const prompts = ["¿Cómo dormí?","¿Qué me preocupa?","¿Qué quiero lograr hoy?","¿Qué aprendí?","¿Cómo estuvo mi energía?"];
    reply = `Cordelius Journal — ${jd.count} entradas registradas. Mood frecuente: ${jd.topMood || "sin datos"}. ${jd.summary} Prompts sugeridos para hoy: ${prompts.slice(0,3).join(" / ")}. Ve al módulo Journal (◎) para escribir.`;
  } else if (q.includes("resume mi diario") || q.includes("cómo me he sentido") || q.includes("como me he sentido") || q.includes("patrones ves")) {
    const jd = computeJournalData();
    if (jd.count === 0) {
      reply = "Aún no hay entradas en el diario. Empieza escribiendo en el módulo ◎ Journal. Unos minutos al día de reflexión ayudan a tomar mejores decisiones.";
    } else {
      const recent = jd.recent.slice(0,3).map(e => `${e.date}: ${(e.text||"").slice(0,60)}`).join("; ");
      reply = `Resumen de tu diario: ${jd.count} entradas. Mood predominante: ${jd.topMood || "variado"}. Recientes: ${recent}. ${jd.summary} Analiza patrones: ¿hay correlación entre tu energía y tus decisiones?`;
    }
  } else if (q.includes("qué módulo") || q.includes("que modulo") || q.includes("módulo revisar") || q.includes("modulo revisar") || q.includes("qué abrir") || q.includes("que abrir")) {
    const h = computeHealthReadiness();
    const jd = computeJournalData();
    const idea = computeTradeIdea();
    const suggestions = [];
    if (idea.hasIdea) suggestions.push(`◈ Trading — hay señal: ${idea.type} en ${idea.symbol}`);
    if (!h.configured) suggestions.push("◉ Health — conecta WHOOP para readiness");
    if (jd.count === 0) suggestions.push("◎ Journal — empieza tu diario hoy");
    if (news.length > 0) suggestions.push(`◆ Intelligence — ${news.length} noticias nuevas`);
    reply = suggestions.length > 0
      ? `Módulos a revisar hoy: ${suggestions.join("; ")}. Usa los botones del menú superior para navegar.`
      : `Todo en orden. Revisa ◈ Trading para portafolio y ◆ Intelligence para noticias. Modo: ${h.operatingMode}.`;
  } else if (q.includes("resumen de mi día") || q.includes("resumen del día") || q.includes("resumen del dia") || q.includes("cómo va mi día") || q.includes("como va mi dia")) {
    const h = computeHealthReadiness();
    const jd = computeJournalData();
    const idea = computeTradeIdea();
    const nl = computeDailyNewsletter();
    reply = `Resumen del día — ${nl.date}. Portafolio: ${money(pv.totalValueMXN)} (${pct(pv.totalGainPct)}). Estado físico: modo ${h.operatingMode}${h.configured ? "" : " (sin WHOOP)"}. Diario: ${jd.count} entradas${jd.topMood ? ", mood " + jd.topMood : ""}. ${idea.hasIdea ? "Idea paper: " + idea.type + " " + idea.symbol + "." : "Sin idea paper activa."} NO es asesoría financiera.`;
  } else {
    reply = `Cordelius activo. Portafolio ${money(pv.totalValueMXN)}, rendimiento ${pct(pv.totalGainPct)}, regimen ${reg.label}. Mejor score: ${best.symbol} (${best.score}/100); mas debil: ${worst.symbol} (${worst.score}/100).`;
  }
  const ai = await askClaude(question, reply, pv, reg, botEq, botPnl);
  if (ai) reply = ai;
  chatHistory.unshift({ question, reply, time: nowMX() });
  chatHistory = chatHistory.slice(0, 60);
  saveJSON(CHAT_FILE, chatHistory);
  addThought(`Jarvis respondio: "${question.slice(0, 50)}..."`, "ai");
  saveJSON(BOT_FILE, bot);
  return reply;
}

function md(text = "") { return esc(text).replace(/\n/g, "<br>").replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/#{1,4}\s?/g, ""); }
function logoHtml(a) { return `<div class="asset-logo" style="background:${esc(a.color)}">${esc(a.logo)}</div>`; }

function brainHtml() {
  const thoughts = (bot.thoughts || []).slice(0, 9);
  const pv = portfolioValue();
  const cripto = pv.assets.filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0);
  const criptoPct = pv.totalValueMXN > 0 ? (cripto / pv.totalValueMXN * 100) : 0;
  const hasHighRisk = pv.assets.some(a => a.score < 35 || a.risk === "ALTO");
  const idea = computeTradeIdea();
  const jd = computeJournalData();
  const nodes = [
    { label: pct(pv.totalGainPct)+" port",                    delay: 0,    color: pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d" },
    { label: hasHighRisk ? "Risk ⚠" : "Risk ✓",               delay: 0.3,  color: hasHighRisk ? "#ff4d6d" : "#00ff99" },
    { label: "Quiver "+(quiverData.configured ? "✓" : "—"),   delay: 0.7,  color: quiverData.configured ? "#00ff99" : "#9fb3c8" },
    { label: "Congress",                                        delay: 1.1 },
    { label: "Insiders",                                        delay: 0.5 },
    { label: "News "+news.length,                              delay: 0.9,  color: news.length > 0 ? "#3b9dff" : "#9fb3c8" },
    { label: "Health "+(WHOOP_CONFIGURED?"✓":"—"),             delay: 0.2,  color: WHOOP_CONFIGURED ? "#f472b6" : "#9fb3c8" },
    { label: "MSFT",                                            delay: 0.6 },
    { label: "AI",                                              delay: 1.4,  color: "#818cf8" },
    { label: "PLTR",                                            delay: 0.8 },
    { label: idea.hasIdea ? idea.symbol+" "+idea.type.split("_")[0] : "Paper —", delay: 1.2, color: idea.hasIdea ? "#ffd35c" : "#9fb3c8" },
    { label: "Journal "+jd.count,                              delay: 0.4,  color: jd.count > 0 ? "#818cf8" : "#9fb3c8" },
    { label: "BTC",                                             delay: 1.0 },
    { label: "Cripto "+criptoPct.toFixed(0)+"%",               delay: 0.15, color: criptoPct > 45 ? "#ff4d6d" : "#f59e0b" },
    { label: "AAPL",                                            delay: 0.55 },
    { label: "XRP",                                             delay: 0.95 },
    { label: "Sleep —",                                         delay: 1.3,  color: "#9fb3c8" },
    { label: "Recovery —",                                      delay: 0.65, color: "#9fb3c8" },
    { label: "Mood "+(jd.topMood||"—"),                        delay: 1.0,  color: "#818cf8" },
    { label: "Macro",                                           delay: 0.35 },
  ];
  const positions = [
    "left:2%;top:8%",   "left:17%;top:3%",  "left:34%;top:11%", "left:52%;top:3%",
    "left:69%;top:11%", "left:84%;top:4%",  "left:6%;top:38%",  "left:23%;top:31%",
    "left:41%;top:40%", "left:58%;top:32%", "left:75%;top:40%", "left:87%;top:30%",
    "left:2%;top:67%",  "left:19%;top:62%", "left:38%;top:70%", "left:56%;top:63%",
    "left:72%;top:70%", "left:86%;top:61%", "left:10%;top:84%", "left:46%;top:88%",
  ];
  return `<details class="brain-card" style="cursor:pointer">
    <summary style="list-style:none;display:flex;align-items:center;justify-content:space-between;padding:14px 20px;user-select:none">
      <div>
        <div class="brain-title" style="font-size:16px">Mapa vivo del sistema</div>
        <div class="brain-sub">Vista visual de conexiones entre portafolio, riesgo, cripto, noticias y health.</div>
      </div>
      <span class="btn" style="font-size:12px;padding:5px 12px">Expandir ▾</span>
    </summary>
    <div class="brain-left">

      <div class="brain-title">Cerebro Jarvis AI</div>
      <div class="brain-sub" style="margin:8px 16px 4px">Red neuronal viva: datos → análisis → señales → decisiones</div>

      <div class="brain" style="min-height:380px">
        ${nodes.map((n, i) => `<span class="brain-node" style="${positions[i]};${n.color ? "color:"+n.color+";border-color:"+n.color+"44" : ""}">${esc(n.label)}<i class="pulse" style="animation-delay:${n.delay}s"></i></span>`).join("")}
        <svg viewBox="0 0 700 380" class="brain-lines" preserveAspectRatio="none">
          <path d="M50 55 C130 25 220 120 280 60 S440 25 530 75"/>
          <path d="M50 55 C100 155 180 195 280 185"/>
          <path d="M50 55 C80 275 165 295 320 305"/>
          <path d="M140 28 C205 95 260 155 310 182"/>
          <path d="M280 60 C340 100 380 155 425 182"/>
          <path d="M400 28 C445 78 445 165 430 182"/>
          <path d="M530 75 C595 125 625 158 608 182"/>
          <path d="M80 195 C165 245 245 295 320 305"/>
          <path d="M185 178 C240 235 282 285 320 305"/>
          <path d="M310 182 C350 245 352 285 320 305"/>
          <path d="M430 182 C445 238 422 278 430 305"/>
          <path d="M608 182 C625 238 562 288 525 305"/>
          <path d="M80 195 C125 238 162 258 185 178" style="stroke:#3b9dff;stroke-dasharray:8 18;opacity:.5"/>
          <path d="M430 182 C485 198 545 198 608 182" style="stroke:#ffd35c;stroke-dasharray:6 20;opacity:.5"/>
          <path d="M50 278 C140 305 245 325 320 305"/>
          <path d="M320 305 C400 308 462 308 525 305"/>
          <path d="M525 305 C585 318 632 278 652 255"/>
          <path d="M165 268 C220 290 278 305 320 305"/>
          <path d="M455 305 C500 295 550 275 575 258"/>
        </svg>
      </div>
    </div>
    <div class="brain-feed">
      <div class="feed-title">Pensamientos en vivo</div>
      ${thoughts.length ? thoughts.map(t => `<div class="thought ${esc(t.level)}"><b>${esc(t.level.toUpperCase())}</b> ${esc(t.text)}<small>${esc(t.time)}</small></div>`).join("") : `<div class="thought scan">Esperando señales del mercado...</div>`}
    </div>
  </details>`;
}

function renderPortfolioRows(assets) {
  return assets.map(a => {
    const z = a.zones; const act = alfredoAction(a); const ind = a.ind;
    const units = a.units || 0;
    // Per-unit prices
    const avgBuyMXN = units > 0 ? a.costMXN / units : 0;
    const avgBuyUSD = (a.currency === "USD" && units > 0) ? (a.costManual / units) : null;
    const curPriceMXN = units > 0 ? a.valueMXN / units : 0;
    const curPriceUSD = (a.currency === "USD" && units > 0) ? (a.liveValue / units) : null;
    const avgLabel = a.currency === "USD"
      ? (avgBuyUSD != null ? money(avgBuyUSD, "USD") + " (≈ " + money(avgBuyMXN) + ")" : "no disponible")
      : (avgBuyMXN > 0 ? money(avgBuyMXN) : "no disponible");
    const curLabel = a.currency === "USD"
      ? (curPriceUSD != null ? money(curPriceUSD, "USD") + " (≈ " + money(curPriceMXN) + ")" : "-")
      : money(curPriceMXN);
    const isCrypto = a.type === "crypto";
    const unitsLabel = isCrypto ? Number(units).toFixed(units < 1 ? 8 : 4) + " " + a.symbol : units + " accs";
    return `<details class="asset-row">
      <summary>
        <div class="asset-main">${logoHtml(a)}<div><b>${esc(a.display)}</b><span>${esc(a.name)}</span><em>${esc(a.source)} · ${esc(a.category)} · ${unitsLabel}</em></div></div>
        <div class="asset-money">
          <b>${a.currency === "USD" ? money(a.liveValue, "USD") : money(a.liveValue, "MXN")}</b>
          ${a.currency === "USD" ? `<div class="muted" style="font-size:12px">≈ ${money(a.valueMXN)}</div>` : ""}
          <span class="${a.gainPct >= 0 ? "green" : "red"}">${pct(a.gainPct)} · ${money(a.gainMXN)}</span>
        </div>
      </summary>
      <div class="asset-detail">
        <div class="detail-chart">${miniSpark(a.symbol, a.gainPct >= 0 ? "#00ff99" : "#ff4d6d")}</div>
        <div class="detail-grid" style="margin-bottom:14px">
          <div><span>Broker / origen</span><b>${esc(a.source)}</b></div>
          <div><span>Cantidad</span><b>${unitsLabel}</b></div>
          <div><span>Costo original</span><b>${money(a.costMXN)}</b></div>
          <div><span>Valor actual</span><b>${money(a.valueMXN)}</b></div>
          <div><span>Ganancia MXN</span><b class="${a.gainMXN >= 0 ? "green" : "red"}">${money(a.gainMXN)}</b></div>
          <div><span>Ganancia %</span><b class="${a.gainPct >= 0 ? "green" : "red"}">${pct(a.gainPct)}</b></div>
          <div><span>Promedio compra</span><b>${avgLabel}</b></div>
          <div><span>Precio actual</span><b>${curLabel}</b></div>
          <div><span>Cambio del día</span><b class="muted">N/D — sin feed en tiempo real</b></div>
          <div><span>Última actualización</span><b class="muted">${esc(a.quoteSource === "live" ? "Live feed" : "Local: " + nowMX())}</b></div>
        </div>
        <div class="ind-row">
          <div class="ind"><span>RSI</span><b class="${ind.rsi > 70 ? "red" : ind.rsi < 30 ? "green" : ""}">${ind.rsi}</b></div>
          <div class="ind"><span>MACD</span><b class="${ind.macd >= 0 ? "green" : "red"}">${ind.macd}</b></div>
          <div class="ind"><span>Momentum</span><b class="${ind.momentum >= 0 ? "green" : "red"}">${ind.momentum}</b></div>
          <div class="ind"><span>Tendencia</span><b>${ind.trend}</b></div>
          <div class="ind"><span>Volatilidad</span><b>${ind.volatility}</b></div>
          <div class="ind"><span>Score IA</span><b>${a.score}/100</b></div>
          <div class="ind"><span>Riesgo</span><b class="${a.risk === "ALTO" ? "red" : a.risk === "BAJO" ? "green" : "yellow"}">${a.risk}</b></div>
          <div class="ind"><span>Señal</span><b style="font-size:12px">${esc(a.signal)}</b></div>
        </div>
        <div class="alfredo-score" style="border-color:${act.color}55">
          <div class="as-head"><b style="color:${act.color}">${act.action}</b><span class="muted">Score ${act.score}/100</span></div>
          <ul>${act.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
        </div>
        <div style="background:rgba(59,157,255,.05);border:1px solid rgba(59,157,255,.15);border-radius:14px;padding:12px 16px;margin-bottom:12px">
          <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#3b9dff;margin-bottom:6px">¿Por qué vigilarlo?</div>
          <div style="font-size:13px;color:#c8d8f0">
            ${a.risk === "ALTO" ? `⚠ Riesgo alto — score ${a.score}/100. ` : ""}
            ${a.gainPct < -15 ? `Caída de ${pct(a.gainPct)} desde costo. ` : a.gainPct > 50 ? `Ganancia de ${pct(a.gainPct)} — evaluar toma parcial. ` : ""}
            ${a.type === "crypto" ? "Activo cripto: volatilidad elevada. " : ""}
            ${a.signal.includes("BUY") ? "Señal educativa de entrada detectada. " : a.signal.includes("VIGILAR") ? "Señal de vigilancia activa. " : ""}
            ${a.score >= 65 ? "Score sólido — mantener y monitorear." : a.score < 35 ? "Score bajo — no promediar sin revisar la tesis." : "Score neutro — monitoreo regular recomendado."}
          </div>
        </div>
        <div class="detail-grid">
          <div><span>Zona compra</span><b>${a.currency === "USD" ? money(z.buy, "USD") : money(z.buy)}</b></div>
          <div><span>Zona venta</span><b>${a.currency === "USD" ? money(z.sell, "USD") : money(z.sell)}</b></div>
          <div><span>Stop educativo</span><b>${a.currency === "USD" ? money(z.stop, "USD") : money(z.stop)}</b></div>
          <div><span>Fuente precio</span><b>${esc(a.quoteSource)}</b></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <a class="tv-link" target="_blank" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(TV_SYMBOL[a.symbol] || a.symbol)}">Ver en TradingView ↗</a>
          <button onclick="setJarvisQ('analiza ${a.symbol}')" class="btn" style="font-size:12px;padding:7px 14px;color:#818cf8;border-color:rgba(129,140,248,.3)">Preguntar a Alfredo</button>
        </div>
      </div>
    </details>`;
  }).join("");
}


function intelMatchWord(text, word) {
  return new RegExp("(^|[\\s,;:.!?¿¡\"'(\\[{])(" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")($|[\\s,;:.!?¿¡\"')\\]}])", "i").test(text);
}

function intelHash(text) {
  const s = String(text).trim().slice(0, 300);
  return s.split("").reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0).toString(36).replace("-", "n");
}

function analyzeIntelText(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();

  const affected = PORTFOLIO
    .filter(a => lower.includes(String(a.symbol).toLowerCase()) || lower.includes(String(a.name || "").toLowerCase()))
    .map(a => a.symbol);

  const positiveWords = ["bullish", "sube", "subir", "compra", "buy", "crecimiento", "artificial intelligence", "inteligencia artificial", "contrato", "earnings", "beneficio", "aprobado"];
  const negativeWords = ["bearish", "baja", "cae", "caida", "venta", "sell", "riesgo", "demanda", "regulacion", "hack", "multa", "recesion"];

  const pos = positiveWords.filter(w => intelMatchWord(lower, w)).length;
  const neg = negativeWords.filter(w => intelMatchWord(lower, w)).length;

  let mood = "NEUTRAL";
  if (pos > neg) mood = "POSITIVO";
  if (neg > pos) mood = "NEGATIVO";

  const tags = [];
  if (lower.includes("china") || lower.includes("asia")) tags.push("Asia/China");
  if (/\bai\b/.test(lower) || intelMatchWord(lower, "ia") || lower.includes("chips") || lower.includes("inteligencia artificial")) tags.push("IA/Tech");
  if (lower.includes("cobre") || lower.includes("copper")) tags.push("Cobre");
  if (lower.includes("crypto") || lower.includes("bitcoin") || lower.includes("btc")) tags.push("Cripto");
  if (lower.includes("congreso") || lower.includes("senado") || lower.includes("regulacion")) tags.push("Politica/Regulacion");

  return {
    text: raw.slice(0, 3000),
    hash: intelHash(raw),
    affected,
    mood,
    tags,
    time: nowMX()
  };
}

function renderIntelPanel() {
  const items = intelItems || [];
  const count = items.length;
  const posCount = items.filter(x => x.mood === "POSITIVO").length;
  const negCount = items.filter(x => x.mood === "NEGATIVO").length;
  const neuCount = items.filter(x => x.mood === "NEUTRAL").length;

  const rows = items.slice(0, 20).map(function(x) {
    const moodClass = x.mood === "POSITIVO" ? "green" : (x.mood === "NEGATIVO" ? "red" : "yellow");
    const moodKey = x.mood === "POSITIVO" ? "POS" : (x.mood === "NEGATIVO" ? "NEG" : "NEU");
    const affected = (x.affected && x.affected.length) ? x.affected.join(", ") : "Sin activo directo";
    const tags = (x.tags && x.tags.length) ? x.tags.join(" · ") : "General";
    const hashVal = x.hash ? esc(x.hash) : "";

    return '<div class="news-card intel-item" data-mood="' + moodKey + '">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
      + '<div><b class="' + moodClass + '">' + esc(x.mood) + '</b><div class="muted" style="font-size:12px">' + esc(x.time) + '</div></div>'
      + (hashVal ? '<form method="POST" action="/intel/delete" style="margin:0" onsubmit="event.preventDefault();cordeliusFormPost(this,\'/#intel\')">'
        + '<input type="hidden" name="id" value="' + hashVal + '">'
        + '<button type="submit" style="background:rgba(255,77,109,.15);border:1px solid rgba(255,77,109,.35);color:#ff4d6d;border-radius:8px;padding:3px 10px;cursor:pointer;font-size:12px" title="Borrar este analisis">&#x2715;</button>'
        + '</form>' : '')
      + '</div>'
      + '<div><div><b>Activos afectados:</b> ' + esc(affected) + '</div>'
      + '<div class="muted">' + esc(tags) + '</div>'
      + '<p style="white-space:pre-wrap">' + esc(x.text).slice(0, 700) + '</p></div>'
      + '</div>';
  }).join("") || '<div class="msg muted">Todavia no hay analisis pegado. Pega texto de Grok, X o noticias.</div>';

  const clearBtn = count > 0
    ? '<form method="POST" action="/intel/clear" onsubmit="event.preventDefault();if(confirm(\'Borrar todos los analisis Intel? Esta accion no se puede deshacer.\'))cordeliusFormPost(this,\'/#intel\')" style="margin:0">'
      + '<button type="submit" style="background:rgba(255,77,109,.12);border:1px solid rgba(255,77,109,.3);color:#ff4d6d;border-radius:8px;padding:5px 14px;cursor:pointer;font-size:13px">Limpiar todo</button>'
      + '</form>'
    : '';

  const filterBar = '<div id="intel-filter-bar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">'
    + '<button class="intel-chip" onclick="intelFilter(this,\'ALL\')" style="background:rgba(59,157,255,.2);border:1px solid rgba(59,157,255,.5);color:#3b9dff;border-radius:20px;padding:5px 16px;cursor:pointer;font-size:13px;font-weight:bold">Todos <b>' + count + '</b></button>'
    + '<button class="intel-chip" onclick="intelFilter(this,\'POS\')" style="background:rgba(0,255,153,.08);border:1px solid rgba(0,255,153,.3);color:#00ff99;border-radius:20px;padding:5px 16px;cursor:pointer;font-size:13px">POSITIVO <b>' + posCount + '</b></button>'
    + '<button class="intel-chip" onclick="intelFilter(this,\'NEG\')" style="background:rgba(255,77,109,.08);border:1px solid rgba(255,77,109,.3);color:#ff4d6d;border-radius:20px;padding:5px 16px;cursor:pointer;font-size:13px">NEGATIVO <b>' + negCount + '</b></button>'
    + '<button class="intel-chip" onclick="intelFilter(this,\'NEU\')" style="background:rgba(255,209,102,.08);border:1px solid rgba(255,209,102,.3);color:#ffd166;border-radius:20px;padding:5px 16px;cursor:pointer;font-size:13px">NEUTRAL <b>' + neuCount + '</b></button>'
    + '<div style="margin-left:auto">' + clearBtn + '</div>'
    + '</div>'
    + '<script>function intelFilter(btn,type){'
    + 'document.querySelectorAll(".intel-item").forEach(function(el){'
    + 'el.style.display=(type==="ALL"||el.dataset.mood===type)?"":"none";});'
    + 'document.querySelectorAll(".intel-chip").forEach(function(b){'
    + 'b.style.fontWeight=b===btn?"bold":"normal";'
    + 'b.style.opacity=b===btn?"1":"0.65";});}'
    + '</script>';

  return '<div class="panel">'
    + '<form method="POST" action="/intel" onsubmit="event.preventDefault();cordeliusFormPost(this,\'/#intel\')">'
    + '<textarea name="intel" style="width:100%;min-height:150px;border-radius:18px;background:#07111f;color:#e5f2ff;border:1px solid rgba(120,160,210,.25);padding:14px;font-size:15px" placeholder="Pega aqui analisis de Grok, X, noticias, China, IA, cripto, cobre, politica, etc..."></textarea>'
    + '<div style="margin-top:12px"><button class="btn">Guardar analisis</button></div>'
    + '</form>'
    + '<p class="muted">Modo manual: pega texto externo y Cordelius lo cruza contra tus activos. No opera dinero real.</p>'
    + '</div>'
    + '<div class="panel">' + filterBar + rows
    + (items.length > 20 ? '<div class="muted" style="text-align:center;padding:10px 0;font-size:13px">Mostrando 20 de ' + items.length + ' analisis &mdash; borra los mas antiguos para ver los recientes arriba.</div>' : '')
    + '</div>'
    + renderIntelByAsset();
}

function renderIntelByAsset() {
  const items = intelItems || [];
  if (!items.length) return "";

  const byAsset = {};
  for (const item of items) {
    for (const sym of (item.affected || [])) {
      if (!byAsset[sym]) byAsset[sym] = [];
      byAsset[sym].push(item);
    }
  }

  const symbols = Object.keys(byAsset)
    .filter(sym => PORTFOLIO.some(a => a.symbol === sym))
    .sort();

  if (!symbols.length) return "";

  const cards = symbols.map(function(sym) {
    const asset = PORTFOLIO.find(a => a.symbol === sym);
    const symItems = byAsset[sym];
    const pos = symItems.filter(x => x.mood === "POSITIVO").length;
    const neg = symItems.filter(x => x.mood === "NEGATIVO").length;
    const neu = symItems.filter(x => x.mood === "NEUTRAL").length;
    const net = pos > neg ? "POSITIVO" : neg > pos ? "NEGATIVO" : "NEUTRAL";
    const netClass = net === "POSITIVO" ? "green" : net === "NEGATIVO" ? "red" : "yellow";
    const logo = asset ? '<div class="asset-logo" style="background:' + esc(asset.color) + ';width:30px;height:30px;min-width:30px;font-size:11px;border-radius:8px;display:flex;align-items:center;justify-content:center">' + esc(asset.logo) + '</div>' : "";
    const snippets = symItems.slice(0, 2).map(function(x) {
      return '<div class="muted" style="font-size:12px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.06)">'
        + esc(x.time) + ' &mdash; ' + esc(x.text.slice(0, 110)) + (x.text.length > 110 ? '&hellip;' : '')
        + '</div>';
    }).join("");

    return '<div class="news-card" style="padding:14px 16px">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">'
      + logo
      + '<b style="font-size:15px">' + esc(sym) + '</b>'
      + '<span class="' + netClass + '" style="font-size:12px;font-weight:bold">' + esc(net) + '</span>'
      + '<span class="muted" style="font-size:12px">' + symItems.length + ' menci' + (symItems.length === 1 ? "on" : "ones") + '</span>'
      + '<span style="font-size:11px;margin-left:4px;opacity:.7">'
      + (pos ? '<span style="color:#00ff99">+' + pos + '</span> ' : '')
      + (neg ? '<span style="color:#ff4d6d">-' + neg + '</span> ' : '')
      + (neu ? '<span style="color:#ffd166">=' + neu + '</span>' : '')
      + '</span>'
      + '</div>'
      + snippets
      + '</div>';
  }).join("");

  return '<h3 style="margin:24px 0 10px;font-size:16px;color:#9fb3c8">Intel relacionado con mis activos</h3>'
    + '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">'
    + cards
    + '</div>';
}

function renderExternalRadar() {
  const pv = portfolioValue();
  const trending = computeQuiverTrending();
  const radar = computeMarketRadar();
  const portfolioSymbols = new Set(PORTFOLIO.map(a => a.symbol));

  // Merge external tickers from quiver trending + radar watchlist
  const extQuiver = trending.topTickers.filter(t => !portfolioSymbols.has(t.symbol)).slice(0, 8);
  const extRadar = radar.watchlist.filter(t => !t.inPortfolio && (t.quiverSignals > 0 || MARKET_WATCHLIST.includes(t.symbol))).slice(0, 8);

  const merged = new Map();
  extQuiver.forEach(t => merged.set(t.symbol, { symbol: t.symbol, quiverTotal: t.total, buys: t.buys, sales: t.sales, politicianCount: t.politicianCount, latestDate: t.latestDate, fromRadar: false }));
  extRadar.forEach(t => {
    const e = merged.get(t.symbol) || { symbol: t.symbol, quiverTotal: 0, buys: 0, sales: 0, politicianCount: 0, latestDate: null, fromRadar: true };
    e.fromRadar = true;
    e.quiverTotal = e.quiverTotal || t.quiverSignals;
    merged.set(t.symbol, e);
  });

  const items = [...merged.values()].sort((a, b) => b.quiverTotal - a.quiverTotal).slice(0, 10);

  if (!items.length) {
    // No Quiver data — show MARKET_WATCHLIST with portfolio status as chip grid
    const chips = MARKET_WATCHLIST.map(sym => {
      const inPort = PORTFOLIO.some(a => a.symbol === sym);
      const portAsset = inPort ? pv.assets.find(a => a.symbol === sym) : null;
      const color = inPort ? "#3b9dff" : "#64748b";
      return '<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid ' + color + '55;border-radius:8px;padding:4px 10px;font-size:12px;margin:3px;background:' + color + '0a">'
        + '<b>' + esc(sym) + '</b>'
        + (inPort ? '<span style="color:#3b9dff;font-size:10px;margin-left:2px">●</span>' : '')
        + (portAsset ? '<span style="color:' + (portAsset.gainPct >= 0 ? "#00ff99" : "#ff4d6d") + ';font-size:10px"> ' + (portAsset.gainPct >= 0 ? "+" : "") + portAsset.gainPct.toFixed(0) + '%</span>' : '')
        + '</span>';
    }).join("");
    return '<div class="panel" style="max-width:1280px;margin:0 auto 8px">'
      + '<div class="label" style="margin-bottom:10px">Watchlist — azul = en mi portafolio</div>'
      + '<div style="margin-bottom:12px">' + chips + '</div>'
      + '<div class="muted" style="font-size:12px">Con <b>QUIVER_API_KEY</b> en .env verás cuáles compran/venden políticos del Congreso y cuáles están más calientes. Actualmente: solo watchlist de radar IA.</div>'
      + '</div>';
  }

  function externalSignal(t) {
    if (t.buys > 0 && t.buys > t.sales * 1.2) return { label: "Bullish", color: "#00ff99", reason: t.buys + " compras políticas" + (t.politicianCount > 1 ? " · " + t.politicianCount + " políticos" : "") };
    if (t.sales > 0 && t.sales > t.buys * 1.2) return { label: "Risk/Venta", color: "#ff4d6d", reason: t.sales + " ventas políticas" + (t.politicianCount > 1 ? " · " + t.politicianCount + " políticos" : "") };
    if (t.quiverTotal >= 3) return { label: "Watch", color: "#ffd35c", reason: t.quiverTotal + " registros Quiver · compras y ventas mixtas" };
    if (t.fromRadar) return { label: "Radar IA", color: "#3b9dff", reason: "en watchlist IA · sin posición propia" };
    return { label: "Neutral", color: "#9fb3c8", reason: "datos limitados" };
  }

  const rows = items.map(t => {
    const sig = externalSignal(t);
    const dateStr = t.latestDate ? new Date(t.latestDate).toLocaleDateString("es-MX", { month: "short", day: "numeric" }) : "";
    return '<tr>'
      + '<td><b>' + esc(t.symbol) + '</b></td>'
      + '<td style="color:' + sig.color + ';font-weight:800">' + esc(sig.label) + '</td>'
      + '<td>' + t.quiverTotal + '</td>'
      + '<td><span style="color:#00ff99">' + (t.buys || 0) + ' C</span> · <span style="color:#ff4d6d">' + (t.sales || 0) + ' V</span></td>'
      + '<td class="muted" style="font-size:12px">' + esc(sig.reason) + '</td>'
      + '<td class="muted" style="font-size:12px">' + dateStr + '</td>'
      + '</tr>';
  }).join("");

  // Also show top politicians
  const politRows = trending.mostActivePoliticians.slice(0, 5).map(p =>
    '<tr><td><b>' + esc(p.name) + '</b></td><td class="muted">' + esc(p.party) + '</td><td>' + p.trades + '</td><td style="font-size:12px;color:var(--muted)">' + p.tickers.slice(0, 5).join(", ") + '</td></tr>'
  ).join("");

  return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;max-width:1280px;margin:0 auto 8px">'
    + '<div class="panel"><div class="label" style="margin-bottom:10px">Stocks externos calientes · Quiver + Radar</div>'
    + '<div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Señal</th><th>Total</th><th>C/V</th><th>Razón</th><th>Fecha</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="muted" style="font-size:12px;margin-top:8px">Educativo · NO en tu portafolio · solo vigilancia · datos Quiver con retraso hasta 45d</div></div>'
    + (politRows ? '<div class="panel"><div class="label" style="margin-bottom:10px">Políticos más activos (Congreso)</div>'
      + '<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Partido</th><th>Trades</th><th>Tickers</th></tr></thead><tbody>' + politRows + '</tbody></table></div>'
      + '<div class="muted" style="font-size:12px;margin-top:8px">Fuente: Quiver Quant · datos educativos · retraso hasta 45 días</div></div>' : '')
    + '</div>';
}

function renderQuiverPanel() {
  if (!quiverData.configured) {
    return '<div class="quiver-box">'
      + '<div class="quiver-item"><div class="label">Estado</div><div class="big yellow">PENDIENTE</div><p class="muted">Agrega QUIVER_API_KEY en .env para conectar datos de congreso, insiders y contratos.</p></div>'
      + '<div class="quiver-item"><div class="label">Activos cubiertos</div><p>MSFT, AAPL, PLTR, UNH, AEP, GEV, COPX, NFLX — acciones USA rastreadas por Quiver.</p></div>'
      + '<div class="quiver-item"><div class="label">No cubiertos</div><p>BBVA (MX), XRP, BTC, ETH y cripto no aparecen en datos de Quiver.</p></div>'
      + '</div>';
  }
  if (quiverData.error) {
    return '<div class="panel"><div class="muted">Quiver error: ' + esc(quiverData.error) + '</div></div>';
  }
  const _qRows = (quiverData.congressional || []).length + (quiverData.insider || []).length + (quiverData.contracts || []).length;
  if (_qRows === 0) {
    return '<div class="panel" style="border-color:rgba(255,211,92,.2)"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
      + statusBadge("LIVE")
      + '<b style="font-size:14px">Quiver conectado, sin filas hoy</b>'
      + '<span class="muted" style="font-size:12px">La API respondió pero congreso/insiders/contratos vienen vacíos para tus tickers. Se muestra "—" en vez de inventar datos.</span>'
      + '</div></div>';
  }

  const allM = [
    ...quiverData.congressional.map(x => ({ ...x, _ds: "congressional" })),
    ...quiverData.insider.map(x => ({ ...x, _ds: "insider" })),
    ...quiverData.contracts.map(x => ({ ...x, _ds: "contracts" }))
  ].sort((a, b) => (a.daysAgo == null ? 999 : a.daysAgo) - (b.daysAgo == null ? 999 : b.daysAgo));

  const tickers = [...new Set(allM.map(x => x.symbol))];

  const tickerChips = tickers.slice(0, 12).map(sym => {
    const asset = PORTFOLIO.find(a => a.symbol === sym);
    const bg = asset ? asset.color : "#1e293b";
    const cnt = allM.filter(x => x.symbol === sym).length;
    return '<span style="display:inline-flex;align-items:center;gap:5px;background:' + esc(bg) + '44;border:1px solid ' + esc(bg) + '88;border-radius:10px;padding:4px 10px;font-size:12px;margin:3px">'
      + (asset ? '<span style="background:' + esc(asset.color) + ';border-radius:5px;padding:1px 5px;font-size:10px;font-weight:900">' + esc(asset.logo) + '</span>' : '')
      + '<b>' + esc(sym) + '</b> <span class="muted">×' + cnt + '</span></span>';
  }).join("");

  const recentRows = allM.slice(0, 12).map(m => {
    const txRaw = (m.Transaction || m.TransactionType || m.transaction || "").toLowerCase();
    const isBuy  = /buy|purchase|bought/.test(txRaw);
    const isSell = /sale|sell|sold/.test(txRaw);
    const txColor = isBuy ? "#00ff99" : isSell ? "#ff4d6d" : "#ffd166";
    const txLabel = isBuy ? "COMPRA" : isSell ? "VENTA" : "OTRO";
    const who  = esc(m.Representative || m.Name || m.name || m.Politician || "Desconocido");
    const party = m.Party ? " (" + esc(m.Party.slice(0, 1)) + ")" : "";
    const amount = m.Amount || m.amount || m.Value || "";
    const ds = m._ds === "congressional" ? "Congreso" : m._ds === "insider" ? "Insider" : "Contrato";
    const days = m.daysAgo != null ? m.daysAgo + "d" : "";
    return '<tr>'
      + '<td><b>' + esc(m.symbol) + '</b></td>'
      + '<td style="color:' + txColor + ';font-weight:800">' + txLabel + '</td>'
      + '<td>' + who + party + '</td>'
      + '<td class="muted" style="font-size:12px">' + ds + '</td>'
      + '<td class="muted" style="font-size:12px">' + esc(String(amount).slice(0, 20)) + '</td>'
      + '<td class="muted" style="font-size:12px">' + days + '</td>'
      + '</tr>';
  }).join("");

  const cacheAge = quiverData.lastFetch ? Math.floor((Date.now() - quiverData.lastFetch) / 60000) : null;

  return '<div class="panel">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">'
    + '<div><span class="label" style="font-size:13px">' + allM.length + ' matches · ' + tickers.length + ' tickers · ' + quiverData.congressional.length + ' congreso · ' + quiverData.insider.length + ' insiders · ' + quiverData.contracts.length + ' contratos</span></div>'
    + (cacheAge != null ? '<span class="muted" style="font-size:12px">Cache: hace ' + cacheAge + ' min</span>' : '')
    + '</div>'
    + '<div style="margin-bottom:14px">' + tickerChips + '</div>'
    + '<div class="table-wrap"><table>'
    + '<thead><tr><th>Activo</th><th>Tipo</th><th>Quien</th><th>Dataset</th><th>Monto</th><th>Dias</th></tr></thead>'
    + '<tbody>' + (recentRows || '<tr><td colspan="6" class="muted">Sin datos recientes</td></tr>') + '</tbody>'
    + '</table></div>'
    + '<div class="muted" style="font-size:12px;margin-top:10px">Datos educativos. Retraso típico Quiver: hasta 45 días. No implica señal de compra/venta.</div>'
    + '</div>';
}

function renderDailyScanCard() {
  try {
    const scan = computeDailyScan();
    const ps = scan.portfolioSummary;
    const qs = scan.quiverSummary;
    const alerts  = scan.riskAlerts.slice(0, 3);
    const actions = scan.educationalActions.slice(0, 3);
    const themes  = scan.marketThemes.slice(0, 4);

    const riskLevel = alerts.some(a => a.level === "CRITICO") ? "CRITICO"
      : alerts.some(a => a.level === "ALTO")    ? "ALTO"
      : alerts.some(a => a.level === "ATENCION") ? "ATENCION" : "NORMAL";
    const riskColor = (riskLevel === "CRITICO" || riskLevel === "ALTO") ? "#ff4d6d"
      : riskLevel === "ATENCION" ? "#ffd166" : "#00ff99";

    const alertRows = alerts.map(a => {
      const lc = (a.level === "CRITICO" || a.level === "ALTO") ? "#ff4d6d" : a.level === "ATENCION" ? "#ffd166" : "#00ff99";
      return '<div style="border-left:3px solid ' + lc + ';padding:8px 12px;margin:6px 0;background:rgba(255,255,255,.03);border-radius:0 10px 10px 0">'
        + '<b style="color:' + lc + ';font-size:12px">' + esc(a.level) + '</b> ' + esc(a.message) + '</div>';
    }).join("") || '<div class="muted" style="font-size:13px">Sin alertas criticas.</div>';

    const actionRows = actions.map(a => {
      const pc = a.priority === "RIESGO" ? "#ff4d6d" : a.priority === "VIGILAR" ? "#ffd166" : a.priority === "CONSIDERAR" ? "#3b9dff" : "#00ff99";
      return '<div style="border-left:3px solid ' + pc + ';padding:8px 12px;margin:6px 0;background:rgba(255,255,255,.03);border-radius:0 10px 10px 0">'
        + '<b style="color:' + pc + ';font-size:12px">' + esc(a.priority) + '</b> <b>' + esc(a.symbol) + '</b> — <span class="muted">' + esc(a.action) + '</span></div>';
    }).join("") || '<div class="muted" style="font-size:13px">Sin acciones pendientes.</div>';

    const themeChips = themes.map(t => {
      const tc = t.alert ? "#ff4d6d" : t.strength === "FUERTE" ? "#00ff99" : t.strength === "MODERADO" ? "#3b9dff" : "#ffd166";
      return '<span style="display:inline-block;padding:5px 12px;border-radius:999px;border:1px solid ' + tc + '44;background:' + tc + '18;color:' + tc + ';font-size:12px;font-weight:700;margin:3px">'
        + esc(t.theme) + ' <small style="opacity:.8">' + esc(t.strength) + (t.quiverSignals ? ' · ' + t.quiverSignals + ' señales' : '') + '</small></span>';
    }).join("");

    const topTickers = (qs.topTickers || []).slice(0, 5).map(t =>
      '<span style="background:rgba(59,157,255,.15);border:1px solid rgba(59,157,255,.3);border-radius:8px;padding:3px 9px;font-size:12px;margin:2px;display:inline-block">'
      + esc(t.symbol) + ' <b>×' + t.total + '</b></span>'
    ).join("") || '<span class="muted" style="font-size:13px">Sin datos Quiver aun (agrega QUIVER_API_KEY en .env)</span>';

    return '<div class="panel" style="border-color:rgba(59,157,255,.35)">'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">'
      + '<div>'
      + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">'
      + '<div style="font-size:22px;font-weight:900;background:linear-gradient(90deg,#00ff99,#3b9dff);-webkit-background-clip:text;-webkit-text-fill-color:transparent">SCAN DIARIO</div>'
      + '<div style="padding:4px 12px;border-radius:999px;border:1px solid ' + riskColor + '55;background:' + riskColor + '18;color:' + riskColor + ';font-size:12px;font-weight:800">' + esc(riskLevel) + '</div>'
      + '<div class="muted" style="font-size:12px">' + esc(scan.date) + ' · ' + esc(ps.regime) + '</div>'
      + '</div>'
      + '<div class="label" style="margin-bottom:8px">Temas de mercado detectados</div>'
      + '<div style="margin-bottom:14px">' + (themeChips || '<span class="muted">Sin datos suficientes</span>') + '</div>'
      + '<div class="label" style="margin-bottom:8px">Señales Quiver en tu portafolio</div>'
      + '<div style="margin-bottom:6px">' + topTickers + '</div>'
      + '<div class="muted" style="font-size:12px;margin-top:6px">' + qs.total + ' matches totales · ' + qs.congressional + ' congreso · ' + qs.insider + ' insiders · ' + qs.contracts + ' contratos</div>'
      + '</div>'
      + '<div>'
      + '<div class="label" style="margin-bottom:8px">Top alertas</div>'
      + alertRows
      + '<div class="label" style="margin:14px 0 8px">Acciones educativas</div>'
      + actionRows
      + '</div>'
      + '</div>'
      + '<div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(120,160,210,.1);display:flex;gap:18px;flex-wrap:wrap;align-items:center">'
      + '<div><span class="label">Patrimonio</span> <b class="' + (ps.gainPct >= 0 ? 'green' : 'red') + '">' + money(ps.totalMXN) + '</b> <span class="muted">' + pct(ps.gainPct) + '</span></div>'
      + '<div><span class="label">Bitso/Cripto</span> <b class="' + (ps.concentration.alert ? 'red' : 'green') + '">' + ps.concentration.bitso_pct + '%</b>'
        + (ps.concentration.alert ? '<span style="color:#ff4d6d;font-size:11px;margin-left:4px">⚠ ALTO</span>' : '') + '</div>'
      + '<div><span class="label">Intel cargado</span> <b>' + scan.intel.count + '</b></div>'
      + '<a href="/api/daily-scan" target="_blank" style="color:#9fb3c8;font-size:12px;text-decoration:none;margin-left:auto">Ver JSON →</a>'
      + '</div>'
      + (scan.educationalSummary ? '<div style="margin-top:12px;padding:12px 14px;border-radius:14px;background:rgba(59,157,255,.06);border:1px solid rgba(59,157,255,.15);color:#c7dff7;font-size:13px;line-height:1.6">'
        + '<b style="color:#3b9dff;font-size:11px;letter-spacing:.08em">RESUMEN EDUCATIVO</b><br>' + esc(scan.educationalSummary) + '</div>' : '')
      + (function() {
        // External stocks watchlist section inside scan card
        const radar = computeMarketRadar();
        const extItems = MARKET_WATCHLIST.slice(0, 15).map(sym => {
          const inPort = PORTFOLIO.some(a => a.symbol === sym);
          const portA = inPort ? portfolioValue().assets.find(a => a.symbol === sym) : null;
          const qSig = radar.watchlist.find(t => t.symbol === sym);
          return {
            symbol: sym, inPortfolio: inPort,
            gainPct: portA ? portA.gainPct : null,
            score: portA ? portA.score : null,
            signal: portA ? portA.signal : null,
            quiverSignals: qSig ? qSig.quiverSignals : 0
          };
        });
        const chips = extItems.map(t => {
          const c = t.inPortfolio ? "#3b9dff" : t.quiverSignals > 0 ? "#00ff99" : "#64748b";
          return '<span style="display:inline-flex;align-items:center;gap:3px;border:1px solid '+ c +'44;border-radius:8px;padding:3px 9px;font-size:11px;margin:2px;background:'+ c +'0a">'
            + '<b>' + esc(t.symbol) + '</b>'
            + (t.inPortfolio ? '<span style="color:#3b9dff;font-size:9px"> ●PORT</span>' : '')
            + (t.quiverSignals > 0 ? '<span style="color:#00ff99;font-size:9px"> Q' + t.quiverSignals + '</span>' : '')
            + (t.gainPct != null ? '<span style="color:' + (t.gainPct >= 0 ? "#00ff99" : "#ff4d6d") + ';font-size:9px"> ' + (t.gainPct >= 0 ? "+" : "") + t.gainPct.toFixed(0) + '%</span>' : '')
            + '</span>';
        }).join('');
        return '<div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(120,160,210,.1)">'
          + '<div class="label" style="margin-bottom:8px">Externos a vigilar · azul=en portafolio · verde=señal Quiver</div>'
          + '<div>' + chips + '</div>'
          + '<div class="muted" style="font-size:11px;margin-top:6px">EDUCATIVO — ninguno de estos es recomendación de compra/venta. Solo vigilancia informada.</div>'
          + '</div>';
      })()
      + '</div>';
  } catch (e) {
    return '<div class="panel"><div class="muted">Scan diario no disponible: ' + esc(String(e.message || "error")) + '</div></div>';
  }
}

function renderNews() {
  if (!news.length) return `<div class="muted">Cargando noticias...</div>`;
  const portfolioSymbols = new Set(PORTFOLIO.map(a => a.symbol));
  function newsCard(n, openByDefault) {
    const c = n.classification;
    const impacted = n.impacted && n.impacted.length ? n.impacted : ["Mercado"];
    const dateStr = n.datetime ? new Date(n.datetime * 1000).toLocaleDateString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

    const impactColor = c.impactColor || "#3b9dff";
    const img = n.image ? `<img style="width:100%;max-height:180px;object-fit:cover;border-radius:12px;margin-bottom:12px" src="${esc(n.image)}" alt="">` : "";
    return `<details class="news-item"${openByDefault ? " open" : ""}>
      <summary>
        <span style="flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:${impactColor};flex-shrink:0"></span>
        <span style="flex:1;font-size:14px;font-weight:700;color:#dbeafe;line-height:1.35">${esc(n.headline || "Sin título")}</span>
        ${n.source ? `<span style="flex:0 0 auto;font-size:10px;color:#9fb3c8;white-space:nowrap">${esc(n.source)}</span>` : ""}
        ${dateStr ? `<span style="flex:0 0 auto;font-size:10px;color:#9fb3c8;white-space:nowrap">${esc(dateStr)}</span>` : ""}
        <span class="ni-caret">▾</span>
      </summary>
      <div style="padding:0 16px 14px">
        ${img}
        <div class="chips"><span>${esc(c.type)}</span><span style="background:${impactColor}22;border-color:${impactColor}55;color:${impactColor}">${esc(c.impact)} · ${c.confidence}%</span><span>${esc(c.region)}</span></div>
        <p style="color:#cbd5e1;font-size:14px;margin:8px 0;line-height:1.6">${esc((n.summary || "").slice(0, 300))}</p>
        <div class="impact"><b>Activos:</b>${impacted.map(x => `<span style="${portfolioSymbols.has(x) ? "background:rgba(0,255,153,.12);border-color:rgba(0,255,153,.3);color:#00ff99" : ""}">${esc(x)}</span>`).join("")}</div>
        <div class="why">Lectura Jarvis: puede mover sentimiento, liquidez o sector. No ejecutar sin análisis propio.</div>
        <a target="_blank" href="${esc(n.url || "#")}" style="font-size:13px;color:#3b9dff">Leer fuente ↗</a>
      </div>
    </details>`;

  }
  const portfolioNews = news.filter(n => n.impacted && n.impacted.some(t => portfolioSymbols.has(t)));
  const externalNews = news.filter(n => !portfolioNews.includes(n));
  let html = "";
  if (portfolioNews.length) {
    html += `<div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#00ff99;margin:8px 0 10px;max-width:1280px">Impactan tu portafolio (${portfolioNews.length})</div>`;
    html += portfolioNews.map((n, i) => newsCard(n, i < 3)).join("");
  }
  if (externalNews.length) {
    html += `<div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#9fb3c8;margin:${portfolioNews.length ? "20px" : "8px"} 0 10px;max-width:1280px">Mercado general (${externalNews.length})</div>`;
    html += externalNews.map((n, i) => newsCard(n, i < 2 && !portfolioNews.length)).join("");
  }
  return html || `<div class="muted">Sin noticias disponibles.</div>`;
}


function botMetrics() {
  const positions = bot.positions || {};
  const history = bot.history || [];
  const sells = history.filter(h => h.type === "SELL");
  const wins = sells.filter(h => Number(h.pnl || 0) > 0);
  const losses = sells.filter(h => Number(h.pnl || 0) < 0);

  let openValueMXN = 0;
  let openCostMXN = 0;

  for (const [sym, p] of Object.entries(positions)) {
    const a = PORTFOLIO.find(x => x.symbol === sym);
    const units = Number(p.units || 0);
    const avg = Number(p.avgMXN || 0);
    const priceMXN = a ? assetValueMXN(a) / Math.max(a.units, 1e-8) : avg;
    openValueMXN += units * priceMXN;
    openCostMXN += units * avg;
  }

  const cashMXN = Number(bot.cash || 0);
  const equityMXN = cashMXN + openValueMXN;
  const initialMXN = Number(bot.initialCapital || 1000);
  const unrealizedPnlMXN = openValueMXN - openCostMXN;
  const realizedPnlMXN = Number(bot.totalRealizedPnl || sells.reduce((s,h)=>s+Number(h.pnl||0),0));
  const totalPnlMXN = equityMXN - initialMXN;
  const closedTrades = sells.length;
  const winRate = closedTrades ? (wins.length / closedTrades) * 100 : 0;
  const grossWin = wins.reduce((s,h)=>s+Number(h.pnl||0),0);
  const grossLoss = Math.abs(losses.reduce((s,h)=>s+Number(h.pnl||0),0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const openExposurePct = equityMXN ? (openValueMXN / equityMXN) * 100 : 0;
  const maxDD = Number(bot.maxDrawdown || 0);

  let riskLabel = "CONTROLADO";
  if (maxDD > 5 || openExposurePct > 60) riskLabel = "ALTO";
  else if (maxDD > 2 || openExposurePct > 35) riskLabel = "MEDIO";

  return {
    cashMXN, openValueMXN, equityMXN, initialMXN,
    unrealizedPnlMXN, realizedPnlMXN, totalPnlMXN,
    closedTrades, wins: wins.length, losses: losses.length,
    winRate, profitFactor, openExposurePct, maxDD, riskLabel
  };
}

function renderBotMetricCards() {
  const m = botMetrics();
  const pnlClass = m.totalPnlMXN >= 0 ? "green" : "red";
  const unrealClass = m.unrealizedPnlMXN >= 0 ? "green" : "red";
  const realClass = m.realizedPnlMXN >= 0 ? "green" : "red";
  const pfText = !Number.isFinite(m.profitFactor) ? "∞" : m.profitFactor.toFixed(2);
  const wrText = m.closedTrades ? m.winRate.toFixed(0) + "%" : "n/a";
  const riskClass = m.riskLabel === "ALTO" ? "red" : (m.riskLabel === "MEDIO" ? "yellow" : "green");

  return ''
    + '<div class="card"><div class="label">Equity simulado</div><div class="big '+pnlClass+' glow">'+money(m.equityMXN)+'</div><div class="muted">Cash '+money(m.cashMXN)+' · Abierto '+money(m.openValueMXN)+'</div></div>'
    + '<div class="card"><div class="label">P&L total simulado</div><div class="big '+pnlClass+'">'+money(m.totalPnlMXN)+'</div><div class="muted">Desde capital inicial '+money(m.initialMXN)+'</div></div>'
    + '<div class="card"><div class="label">P&L realizado</div><div class="big '+realClass+'">'+money(m.realizedPnlMXN)+'</div><div class="muted">Cerradas '+m.closedTrades+' · Ganadas '+m.wins+' · Perdidas '+m.losses+'</div></div>'
    + '<div class="card"><div class="label">P&L no realizado</div><div class="big '+unrealClass+'">'+money(m.unrealizedPnlMXN)+'</div><div class="muted">Posiciones abiertas</div></div>'
    + '<div class="card"><div class="label">Win rate</div><div class="big">'+wrText+'</div><div class="muted">Profit factor '+pfText+'</div></div>'
    + '<div class="card"><div class="label">Riesgo del bot</div><div class="big '+riskClass+'">'+m.riskLabel+'</div><div class="muted">DD max '+m.maxDD.toFixed(1)+'% · Exposición '+m.openExposurePct.toFixed(0)+'%</div></div>';
}

function renderBotTables() {
  const pv = portfolioValue();
  const posRows = Object.entries(bot.positions || {}).map(([sym, p]) => {
    const a = pv.assets.find(x => x.symbol === sym);
    const priceMXN = a ? a.valueMXN / Math.max(a.units, 1e-8) : p.avgMXN;
    const val = p.units * priceMXN; const pnl = (priceMXN - p.avgMXN) * p.units;
    return `<tr><td>${esc(sym)}</td><td>${Number(p.units).toFixed(6)}</td><td>${money(p.avgMXN)}</td><td>${money(priceMXN)}</td><td>${money(val)}</td><td class="${pnl >= 0 ? "green" : "red"}">${money(pnl)}</td><td>${money(p.sl)}</td><td>${money(p.tp)}</td></tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">Sin posiciones abiertas.</td></tr>`;
  const histRows = (bot.history || []).slice(0, 30).map(h => `<tr><td>${esc(h.type)}</td><td>${esc(h.symbol)}</td><td>${Number(h.units || 0).toFixed(6)}</td><td>${money(h.priceMXN)}</td><td>${money(h.value)}</td><td class="${Number(h.pnl || 0) >= 0 ? "green" : "red"}">${money(h.pnl)}</td><td>${esc(h.time)}</td><td>${esc(h.reason)}</td></tr>`).join("") || `<tr><td colspan="8" class="muted">Sin bitacora todavia.</td></tr>`;
  return { posRows, histRows };
}

function renderQuiverIntelligencePanel() {
  const qi = computeQuiverIntelligence();
  const trending = computeQuiverTrending();
  if (!qi.configured) {
    return `<div class="panel" style="max-width:1280px;margin:0 auto 14px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:16px">
        <div>
          <div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c">QUIVER INTELLIGENCE — PENDIENTE</div>
          <div style="color:#9fb3c8;font-size:13px;margin-top:2px">${esc(qi.message)}</div>
        </div>
        <span style="border:1px solid rgba(255,211,92,.3);border-radius:99px;padding:4px 14px;font-size:12px;font-weight:900;color:#ffd35c">SIN API KEY</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px">
        ${qi.pendingFeatures.map(f => `<div style="border:1px solid rgba(120,160,210,.1);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)"><div style="font-size:12px;color:#9fb3c8">🔒 ${esc(f)}</div></div>`).join("")}
      </div>
      <div style="border:1px solid rgba(59,157,255,.15);border-radius:14px;padding:12px;background:rgba(59,157,255,.04)">
        <div style="font-size:12px;color:#9fb3c8">📡 ${esc(qi.watchlistNote)}</div>
      </div>
    </div>`;
  }
  const portSyms = new Set(PORTFOLIO.map(a => a.symbol));
  function txColor(tx) { return /buy|purchase/.test((tx||"").toLowerCase()) ? "#00ff99" : /sale|sell/.test((tx||"").toLowerCase()) ? "#ff4d6d" : "#ffd35c"; }
  function txLabel(tx) { return /buy|purchase/.test((tx||"").toLowerCase()) ? "COMPRA" : /sale|sell/.test((tx||"").toLowerCase()) ? "VENTA" : ((tx||"OTRO").toUpperCase().slice(0,8)); }
  const latestRows = qi.latestTrades.slice(0,12).map(t =>
    `<tr style="opacity:${t.inPortfolio ? 1 : 0.7}">
      <td><b style="color:${t.inPortfolio ? "#3b9dff" : "#eaf6ff"}">${esc(t.symbol)}</b>${t.inPortfolio ? ' <span style="font-size:10px;color:#3b9dff">PORT</span>' : ''}</td>
      <td style="font-size:11px;color:#9fb3c8">${esc(t.dataset)}</td>
      <td style="color:${txColor(t.transaction)};font-weight:800;font-size:12px">${txLabel(t.transaction)}</td>
      <td style="font-size:12px">${esc(t.who || "—")}</td>
      <td style="font-size:11px;color:#9fb3c8">${esc(t.date || "—")}</td>
      <td style="font-size:12px;color:#ffd35c">${esc(String(t.amount || "—").slice(0,12))}</td>
    </tr>`).join("");
  const polRows = qi.activePoliticians.slice(0,6).map(p =>
    `<div style="border:1px solid rgba(120,160,210,.1);border-radius:14px;padding:12px;background:rgba(255,255,255,.02)">
      <div style="font-weight:900;font-size:13px">${esc(p.name)}</div>
      <div style="font-size:11px;color:#9fb3c8;margin-top:2px">${esc(p.party)} · ${p.trades} trades · ${p.buys}🟢 ${p.sales}🔴</div>
      ${p.portfolioTickers.length ? `<div style="margin-top:4px;font-size:11px;color:#3b9dff">En tu portafolio: ${p.portfolioTickers.join(", ")}</div>` : ""}
    </div>`).join("");
  const statCards = [
    { label: "Congreso Compras", value: qi.congressional.buys, color: "#00ff99" },
    { label: "Congreso Ventas",  value: qi.congressional.sales, color: "#ff4d6d" },
    { label: "Insider Compras",  value: qi.insider.buys, color: "#00ff99" },
    { label: "Insider Ventas",   value: qi.insider.sales, color: "#ff4d6d" },
    { label: "En mi portafolio", value: qi.congressional.portfolio + qi.insider.portfolio, color: "#3b9dff" },
    { label: "Externos",         value: qi.congressional.external + qi.insider.external, color: "#9fb3c8" },
  ];
  return `<div style="max-width:1280px;margin:0 auto 14px">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:16px">
      ${statCards.map(c => `<div style="border:1px solid ${c.color}22;border-radius:14px;padding:12px;background:${c.color}08;text-align:center">
        <div style="font-size:22px;font-weight:900;color:${c.color}">${c.value}</div>
        <div style="font-size:10px;color:#9fb3c8;text-transform:uppercase;margin-top:2px">${esc(c.label)}</div>
      </div>`).join("")}
    </div>
    ${polRows ? `<div style="margin-bottom:14px"><div style="font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:10px">Políticos más activos</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">${polRows}</div></div>` : ""}
    <div class="panel" style="padding:14px">
      <div style="font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:10px">Operaciones recientes (Congreso · Insider · Contratos)</div>
      ${latestRows ? `<div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Fuente</th><th>Tipo</th><th>Quién</th><th>Fecha</th><th>Monto</th></tr></thead><tbody>${latestRows}</tbody></table></div>` : '<div class="muted">Sin operaciones recientes.</div>'}
      <div style="margin-top:10px;font-size:11px;color:#5a7a9a">${esc(qi.educationalNote)}</div>
    </div>
  </div>`;
}

function renderExternalRadarBySector() {
  const emi = computeExternalMarketIntelligence();
  const portSyms = new Set(PORTFOLIO.map(a => a.symbol));
  const sectorBlocks = emi.sectors.map(s => {
    const chips = s.tickers.map(t => {
      const hot = t.quiverSignals > 0;
      const port = t.inPortfolio;
      const bg = port ? "rgba(59,157,255,.12)" : hot ? "rgba(0,255,153,.06)" : "transparent";
      const border = port ? "rgba(59,157,255,.4)" : hot ? "rgba(0,255,153,.35)" : "rgba(120,160,210,.15)";
      const label = port ? "PORT" : hot ? "Q×" + t.quiverSignals : "";
      return `<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid ${border};border-radius:8px;padding:4px 10px;font-size:12px;margin:2px 2px;background:${bg}">
        <b>${esc(t.symbol)}</b>
        ${label ? `<span style="font-size:10px;color:${port?"#3b9dff":"#00ff99"}">${esc(label)}</span>` : ""}
        ${t.gainPct != null ? `<span style="font-size:10px;color:${t.gainPct>=0?"#00ff99":"#ff4d6d"}">${pct(t.gainPct)}</span>` : ""}
      </span>`;
    }).join("");
    return `<div style="border:1px solid ${s.color}18;border-radius:18px;padding:14px 16px;background:${s.color}06">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:16px">${s.emoji}</span>
        <span style="font-size:13px;font-weight:900;color:${s.color}">${esc(s.sector)}</span>
        ${s.totalQuiver > 0 ? `<span style="border:1px solid ${s.color}44;border-radius:99px;padding:2px 8px;font-size:11px;color:${s.color};margin-left:auto">Q×${s.totalQuiver}</span>` : ""}
      </div>
      <div>${chips}</div>
    </div>`;
  }).join("");
  return `<div style="max-width:1280px;margin:0 auto 14px">
    <div style="font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:12px">Radar por sector · azul=en portafolio · verde=señal Quiver · (${emi.watchlistCount} tickers)</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">${sectorBlocks}</div>
    <div style="margin-top:12px;font-size:11px;color:#4a6a8a">${esc(emi.educationalNote)}</div>
  </div>`;
}

function renderDailyBrief() {
  const nl = computeDailyNewsletter();
  const pi = nl.portfolio;
  const gainColor = pi.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d";
  const metrics = [
    { label: "Patrimonio", value: money(pi.totalValueMXN), sub: `${pct(pi.totalGainPct)} · ${money(pi.totalGainMXN)}`, subColor: gainColor },
    { label: "Mejor activo", value: pi.best ? pi.best.symbol : "—", sub: pi.best ? `${pi.best.signal} · ${pi.best.score}/100` : "—", subColor: "#9fb3c8", valueColor: "#00ff99" },
    { label: "Más débil",   value: pi.worst ? pi.worst.symbol : "—", sub: pi.worst ? `${pct(pi.worst.gainPct)} · score ${pi.worst.score}` : "—", subColor: "#9fb3c8", valueColor: "#ff4d6d" },
    { label: "Vigilar hoy", value: pi.riskAssets.length ? pi.riskAssets.slice(0,2).map(a=>a.symbol).join(", ") : "OK", sub: pi.riskAssets.length ? `${pi.riskAssets.length} en zona de riesgo` : "Sin alertas críticas", subColor: pi.riskAssets.length ? "#ff4d6d" : "#00ff99", valueColor: pi.riskAssets.length ? "#ffd35c" : "#00ff99" },
    { label: "Externos calientes", value: nl.external.hotCount > 0 ? String(nl.external.hotCount) + " tickers" : "—", sub: nl.external.topSectors.slice(0,2).join(", ") || "Sin señales Quiver", subColor: "#9fb3c8", valueColor: "#3b9dff" },
    { label: "Quiver", value: nl.quiver.configured === false ? "PENDIENTE" : (nl.quiver.congressional ? nl.quiver.congressional.buys + "C/" + nl.quiver.congressional.sales + "V" : "—"), sub: nl.quiver.configured === false ? "Agrega QUIVER_API_KEY" : "Congreso · Insiders", subColor: "#9fb3c8", valueColor: nl.quiver.configured === false ? "#ffd35c" : "#00ff99" },
  ];
  return `<div style="max-width:1280px;margin:16px auto 4px;border:1px solid rgba(120,160,210,.18);border-radius:28px;overflow:hidden;background:linear-gradient(135deg,rgba(7,16,30,.92),rgba(2,4,10,.97));box-shadow:0 8px 48px rgba(0,0,0,.45)">
    <div style="background:linear-gradient(90deg,rgba(0,255,153,.1),rgba(59,157,255,.1),rgba(255,211,92,.08));padding:13px 24px;border-bottom:1px solid rgba(120,160,210,.1);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#9fb3c8">CORDELIUS DAILY BRIEF</span>
        <div style="font-size:13px;color:#4a6a8a;margin-top:2px">${esc(nl.date)}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="border:1px solid rgba(59,157,255,.3);border-radius:99px;padding:4px 12px;font-size:12px;font-weight:800;color:${pi.regime === "ALCISTA" ? "#00ff99" : pi.regime === "BAJISTA" ? "#ff4d6d" : "#ffd35c"}">${esc(pi.regime)}</span>
        <span style="border:1px solid rgba(120,160,210,.2);border-radius:99px;padding:4px 12px;font-size:12px;color:#9fb3c8">Cripto ${pi.concentration.criptoPct}%${pi.concentration.alert ? " ⚠" : ""}</span>
        <span style="border:1px solid rgba(120,160,210,.2);border-radius:99px;padding:4px 12px;font-size:12px;color:#9fb3c8">${pi.assetCount} activos</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      ${metrics.map((m, i) => `<div style="padding:15px 18px;${i < metrics.length-1 ? "border-right:1px solid rgba(120,160,210,.07)" : ""}">
        <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#9fb3c8;margin-bottom:4px">${esc(m.label)}</div>
        <div style="font-size:18px;font-weight:900;color:${m.valueColor || "#eaf6ff"}">${esc(String(m.value))}</div>
        <div style="font-size:11px;color:${m.subColor || "#9fb3c8"};margin-top:2px">${esc(m.sub)}</div>
      </div>`).join("")}
    </div>
    <div style="padding:10px 24px;background:rgba(0,0,0,.22);border-top:1px solid rgba(120,160,210,.07)">
      <div style="font-size:12px;color:#5a7a9a;font-style:italic;margin-bottom:6px">Buenos días Pedro — esto es lo importante hoy:</div>
      <div style="display:flex;flex-direction:column;gap:3px">${nl.lines.slice(0,-1).map(l => `<div style="font-size:12px;color:#9fb3c8">· ${esc(l)}</div>`).join("")}</div>
    </div>
  </div>`;
}

function renderAccountSummary(source, assets) {
  if (!assets.length) return "";
  const totalValue = assets.reduce((s, a) => s + a.valueMXN, 0);
  const totalCost = assets.reduce((s, a) => s + a.costMXN, 0);
  const totalGain = totalValue - totalCost;
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost * 100) : 0;
  const sorted = assets.slice().sort((a, b) => b.score - a.score);
  const topAsset = sorted[0], weakAsset = sorted[sorted.length - 1];
  const hasRisk = assets.some(a => a.risk === "ALTO");
  const gainColor = totalGainPct >= 0 ? "#00ff99" : "#ff4d6d";
  const colors = { GBM: "#3b9dff", Plata: "#00ff99", Bitso: "#f59e0b" };
  const color = colors[source] || "#9fb3c8";
  return `<div style="border:1px solid ${color}22;border-radius:18px;padding:14px 20px;margin-bottom:10px;background:linear-gradient(135deg,${color}07,rgba(0,0,0,0));display:grid;grid-template-columns:80px 1fr auto auto auto;gap:14px;align-items:center">
    <div style="font-size:16px;font-weight:900;color:${color}">${esc(source)}</div>
    <div>
      <div style="font-size:20px;font-weight:900">${money(totalValue)}</div>
      <div style="font-size:12px;color:${gainColor}">${pct(totalGainPct)} · ${money(totalGain)}</div>
    </div>
    <div style="text-align:center"><div style="font-size:10px;color:#9fb3c8;text-transform:uppercase;margin-bottom:2px">Mejor</div><div style="font-weight:900;color:#00ff99">${esc(topAsset.symbol)}</div><div style="font-size:11px;color:#9fb3c8">${topAsset.score}/100</div></div>
    <div style="text-align:center"><div style="font-size:10px;color:#9fb3c8;text-transform:uppercase;margin-bottom:2px">Débil</div><div style="font-weight:900;color:#ff4d6d">${esc(weakAsset.symbol)}</div><div style="font-size:11px;color:#9fb3c8">${weakAsset.score}/100</div></div>
    <div style="text-align:right"><div style="font-size:10px;color:#9fb3c8;text-transform:uppercase;margin-bottom:2px">Riesgo</div><div style="font-weight:900;color:${hasRisk ? "#ff4d6d" : "#00ff99"}">${hasRisk ? "ALTO" : "OK"}</div></div>
  </div>`;
}

function computeTradeIdea() {
  const pv = portfolioValue();
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  const tp = ranked.find(a => a.gainPct > 80 && a.score > 55);
  if (tp) return { hasIdea: true, type: "TAKE_PROFIT", symbol: tp.symbol, action: "TOMA GANANCIA PARCIAL (hipotético)", reason: `+${tp.gainPct.toFixed(0)}% ganancia acumulada`, score: tp.score, risk: tp.risk, confidence: "MODERADA", source: "portfolio", missingData: "Confirmación tendencia sectorial + volumen real", timestamp: nowMX() };
  const rd = ranked.find(a => a.score < 30 && a.gainPct < -15);
  if (rd) return { hasIdea: true, type: "REDUCE_RISK", symbol: rd.symbol, action: "REDUCIR RIESGO (hipotético)", reason: `Score ${rd.score}/100 · caída ${pct(rd.gainPct)} · riesgo ${rd.risk}`, score: rd.score, risk: rd.risk, confidence: "ALTA", source: "portfolio", missingData: "Tesis de recuperación documentada", timestamp: nowMX() };
  const bd = ranked.find(a => a.signal && a.signal.includes("BUY") && a.gainPct < -3 && a.score > 45);
  if (bd) return { hasIdea: true, type: "BUY_DIP", symbol: bd.symbol, action: "BUY DIP (hipotético)", reason: `Score ${bd.score}/100 · caída ${pct(bd.gainPct)} · señal ${bd.signal}`, score: bd.score, risk: bd.risk, confidence: "BAJA", source: "portfolio", missingData: "Volumen real + confirmación Quiver", timestamp: nowMX() };
  const wt = ranked.find(a => a.gainPct > 20 && a.score > 60);
  if (wt) return { hasIdea: true, type: "WATCH", symbol: wt.symbol, action: "MANTENER Y VIGILAR", reason: `Score ${wt.score}/100 · ganancia ${pct(wt.gainPct)} · ${wt.signal}`, score: wt.score, risk: wt.risk, confidence: "NEUTRAL", source: "portfolio", missingData: "N/A — posición sólida", timestamp: nowMX() };
  return { hasIdea: false, type: "NO_TRADE", symbol: null, action: "SIN SEÑAL", reason: "Sin señales destacadas ahora", score: null, risk: null, confidence: "N/A", source: null, missingData: "N/A", timestamp: nowMX() };
}

function computeTradingSummary() {
  const pv = portfolioValue();
  const ranked = pv.assets.slice().sort((a, b) => b.gainPct - a.gainPct);
  const mxn = pv.assets.filter(a => a.currency === "MXN").reduce((sum, a) => sum + a.valueMXN, 0);
  const usd = pv.assets.filter(a => a.currency === "USD").reduce((sum, a) => sum + a.valueMXN, 0);
  const crypto = pv.assets.filter(a => a.currency === "CRYPTO" || a.type === "crypto").reduce((sum, a) => sum + a.valueMXN, 0);
  return {
    ok: true,
    ts: Date.now(),
    app: "Cordelius Trading",
    equityTotalMXN: pv.totalValueMXN,
    pnlTotalMXN: pv.totalGainMXN,
    pnlTotalPct: pv.totalGainPct,
    exposureByCurrency: { MXN: mxn, USD: usd, CRYPTO: crypto },
    topWinner: ranked[0] || null,
    topLoser: ranked[ranked.length - 1] || null,
    riskMode: marketRegime().label,
    educationalNote: "Contexto educativo; paper trading only. No es recomendación financiera."
  };
}

function computeOperatingMode(recovery) {
  if (recovery === null || recovery === undefined) return "NORMAL";
  if (recovery < 33) return "CONSERVADOR";
  if (recovery >= 67) return "NORMAL";
  return "NEUTRAL";
}



// === Cordelius Autopilot Database Memory ===
const AUTOPILOT_FS = require("fs");
const AUTOPILOT_PATH = require("path");

const AUTOPILOT_DATA_DIR = AUTOPILOT_PATH.join(__dirname, "data");
const HEALTH_SNAPSHOTS_FILE = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "health_snapshots.json");
const PORTFOLIO_SNAPSHOTS_FILE = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "portfolio_snapshots.json");
const TRADING_DECISIONS_FILE = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "trading_decisions.json");
function ensureAutopilotDataDir() {
  if (!AUTOPILOT_FS.existsSync(AUTOPILOT_DATA_DIR)) {
    AUTOPILOT_FS.mkdirSync(AUTOPILOT_DATA_DIR, { recursive: true });
  }
}

function readJSONSafe(file, fallback) {
  try {
    ensureAutopilotDataDir();
    if (!AUTOPILOT_FS.existsSync(file)) {
      writeJSONAtomic(file, fallback);
      return fallback;
    }
    return JSON.parse(AUTOPILOT_FS.readFileSync(file, "utf8"));
  } catch (e) {
    console.log("readJSONSafe error:", file, e.message);
    return fallback;
  }
}

function writeJSONAtomic(file, data) {
  ensureAutopilotDataDir();
  const tmp = file + ".tmp";
  const body = JSON.stringify(data, null, 2);
  try {
    AUTOPILOT_FS.writeFileSync(tmp, body);
    AUTOPILOT_FS.renameSync(tmp, file);
  } catch (e) {
    console.log("writeJSONAtomic fallback:", file, e.message);
    AUTOPILOT_FS.writeFileSync(file, body);
  }
}

function appendAutopilotSnapshot(arr, item, maxLen, file) {
  const next = Array.isArray(arr) ? arr.slice() : [];
  next.unshift(item);
  const trimmed = next.slice(0, maxLen || 200);
  writeJSONAtomic(file, trimmed);
  return trimmed;
}

function computeTradingSummaryWithHealth() {
  const pv = portfolioValue();
  const h = computeHealthReadiness ? computeHealthReadiness() : {};
  const assets = Array.isArray(pv.assets) ? pv.assets : [];

  const total = Number(pv.totalValueMXN || 0);
  const cost = Number(pv.totalCostMXN || 0);
  const gain = Number(pv.totalGainMXN || 0);
  const gainPct = Number(pv.totalGainPct || 0);

  const exposure = {
    MXN: +total.toFixed(2),
    USD: +assets.filter(a => a.source === "GBM" || a.currency === "USD").reduce((sum,a)=>sum+Number(a.valueMXN||0),0).toFixed(2),
    CRYPTO: +assets.filter(a => a.type === "crypto" || a.source === "Bitso").reduce((sum,a)=>sum+Number(a.valueMXN||0),0).toFixed(2)
  };

  const ranked = assets
    .map(a => ({
      symbol: a.symbol,
      name: a.name,
      valueMXN: Number(a.valueMXN || 0),
      gainMXN: Number((a.valueMXN || 0) - (a.costMXN || 0)),
      gainPct: a.costMXN ? Number((((a.valueMXN || 0) - (a.costMXN || 0)) / a.costMXN * 100).toFixed(2)) : 0
    }))
    .sort((a,b) => b.gainPct - a.gainPct);

  return {
    timestamp: new Date().toISOString(),
    equity: +total.toFixed(2),
    pnl: +gainPct.toFixed(2),
    cost: +cost.toFixed(2),
    gainMXN: +gain.toFixed(2),
    exposure,
    topWinner: ranked[0] || null,
    topLoser: ranked[ranked.length - 1] || null,
    riskMode: h.operatingMode || h.mode || "NEUTRAL",
    health: {
      recovery: h.recovery ?? null,
      sleep: h.sleep ?? null,
      hrv: h.hrv ?? null,
      strain: h.strain ?? null,
      restingHeartRate: h.restingHeartRate ?? null,
      operatingMode: h.operatingMode || h.mode || "NEUTRAL"
    },
    note: "Resumen real generado desde portfolioValue(). No es consejo financiero."
  };
}

function getAutopilotDatabaseState() {
  const healthSnapshots = readJSONSafe(HEALTH_SNAPSHOTS_FILE, []);
  const portfolioSnapshots = readJSONSafe(PORTFOLIO_SNAPSHOTS_FILE, []);
  const tradingDecisions = readJSONSafe(TRADING_DECISIONS_FILE, []);
  const memory = readJSONSafe(AUTOPILOT_MEMORY_FILE, {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: []
  });
  const progress = readJSONSafe(CORDELIUS_PROGRESS_FILE, {
    level: 1,
    xp: 0,
    streak: 0,
    snapshots: 0,
    lastSnapshotAt: null,
    updatedAt: new Date().toISOString()
  });

  let health = {};
  try {
    health = typeof computeHealthReadiness === "function" ? computeHealthReadiness() : {};
  } catch (e) {
    health = {};
  }

  const tradingSummary = computeTradingSummaryWithHealth();

  return {
    ok: true,
    stores: {
      healthSnapshots,
      portfolioSnapshots,
      tradingDecisions,
      memory,
      progress
    },
    counts: {
      health: healthSnapshots.length,
      portfolio: portfolioSnapshots.length,
      tradingDecisions: tradingDecisions.length,
      memoryNotes: Array.isArray(memory.notes) ? memory.notes.length : 0
    },
    latest: {
      health: healthSnapshots[0] || null,
      portfolio: portfolioSnapshots[0] || null,
      tradingDecision: tradingDecisions[0] || null
    },
    tradingSummary,
    health
  };
}

function saveAutopilotSnapshot() {
  const now = new Date().toISOString();

  let health = {};
  try {
    health = typeof computeHealthReadiness === "function" ? computeHealthReadiness() : {};
  } catch (e) {
    health = {};
  }

  const tradingSummary = computeTradingSummaryWithHealth();

  const healthSnapshots = readJSONSafe(HEALTH_SNAPSHOTS_FILE, []);
  const portfolioSnapshots = readJSONSafe(PORTFOLIO_SNAPSHOTS_FILE, []);
  const tradingDecisions = readJSONSafe(TRADING_DECISIONS_FILE, []);
  const progress = readJSONSafe(CORDELIUS_PROGRESS_FILE, {
    level: 1,
    xp: 0,
    streak: 0,
    snapshots: 0,
    lastSnapshotAt: null,
    updatedAt: now
  });

  const healthEntry = {
    timestamp: now,
    source: "whoop_live",
    recovery: health.recovery ?? null,
    sleep: health.sleep ?? null,
    hrv: health.hrv ?? null,
    strain: health.strain ?? null,
    restingHeartRate: health.restingHeartRate ?? null,
    operatingMode: health.operatingMode ?? health.mode ?? null
  };

  const portfolioEntry = {
    timestamp: now,
    summary: tradingSummary
  };

  const decisionEntry = {
    timestamp: now,
    mode: tradingSummary.riskMode,
    idea: null,
    rule: tradingSummary.riskMode === "DEFENSIVO"
      ? "Reducir riesgo y evitar decisiones impulsivas."
      : tradingSummary.riskMode === "ÓPTIMO"
        ? "Permitir análisis profundo con control de riesgo."
        : "Operar normal/moderado con confirmación."
  };

  const nextHealth = appendAutopilotSnapshot(healthSnapshots, healthEntry, 200, HEALTH_SNAPSHOTS_FILE);
  const nextPortfolio = appendAutopilotSnapshot(portfolioSnapshots, portfolioEntry, 200, PORTFOLIO_SNAPSHOTS_FILE);
  const nextDecisions = appendAutopilotSnapshot(tradingDecisions, decisionEntry, 200, TRADING_DECISIONS_FILE);

  const nextProgress = {
    ...progress,
    snapshots: (progress.snapshots || 0) + 1,
    xp: (progress.xp || 0) + 10,
    level: Math.max(1, Math.floor(((progress.xp || 0) + 10) / 100) + 1),
    streak: (progress.streak || 0) + 1,
    lastSnapshotAt: now,
    updatedAt: now
  };

  writeJSONAtomic(CORDELIUS_PROGRESS_FILE, nextProgress);

  return {
    ok: true,
    savedAt: now,
    health: healthEntry,
    portfolio: portfolioEntry,
    tradingDecision: decisionEntry,
    progress: nextProgress,
    counts: {
      health: nextHealth.length,
      portfolio: nextPortfolio.length,
      tradingDecisions: nextDecisions.length
    }
  };
}

function sendAutopilotJSON(res, obj, statusCode = 200) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function computeHealthReadiness() {
  const cycleRec = whoopCache.cycle && whoopCache.cycle.records && whoopCache.cycle.records[0]
    ? whoopCache.cycle.records[0]
    : null;

  const recoveryRec = whoopCache.recovery && whoopCache.recovery.records && whoopCache.recovery.records[0]
    ? whoopCache.recovery.records[0]
    : null;

  const sleepRec = whoopCache.sleep && whoopCache.sleep.records && whoopCache.sleep.records[0]
    ? whoopCache.sleep.records[0]
    : null;

  const cycleScore = cycleRec && cycleRec.score ? cycleRec.score : {};
  const recoveryScore = recoveryRec && recoveryRec.score ? recoveryRec.score : {};
  const sleepScore = sleepRec && sleepRec.score ? sleepRec.score : {};

  const recovery = recoveryScore.recovery_score != null ? Math.round(recoveryScore.recovery_score) : null;
  const sleep = sleepScore.sleep_performance_percentage != null ? Math.round(sleepScore.sleep_performance_percentage) : null;
  const strain = cycleScore.strain != null ? cycleScore.strain : null;
  const hrv = recoveryScore.hrv_rmssd_milli != null ? recoveryScore.hrv_rmssd_milli : null;
  const restingHeartRate = recoveryScore.resting_heart_rate != null ? Math.round(recoveryScore.resting_heart_rate) : null;
  const averageHeartRate = cycleScore.average_heart_rate != null ? Math.round(cycleScore.average_heart_rate) : null;
  const maxHeartRate = cycleScore.max_heart_rate != null ? Math.round(cycleScore.max_heart_rate) : null;

  const connected = !!(whoopTokens && whoopTokens.access_token && (recovery != null || sleep != null || strain != null || hrv != null));

  let operatingMode = "NORMAL";
  let suggestion = "usa modo neutral";

  if (connected) {
    if (recovery != null && recovery < 40) {
      operatingMode = "DEFENSIVO";
      suggestion = "baja agresividad, evita decisiones impulsivas y prioriza recuperación";
    } else if (recovery != null && recovery < 65) {
      operatingMode = "NEUTRAL";
      suggestion = "modo moderado — evita decisiones impulsivas";
    } else if (recovery != null && recovery >= 80 && strain != null && strain < 10) {
      operatingMode = "ÓPTIMO";
      suggestion = "buen día para enfoque profundo y decisiones con calma";
    } else {
      operatingMode = "NORMAL";
      suggestion = "operación normal con control de riesgo";
    }
  }

  return {
    ok: true,
    configured: WHOOP_CONFIGURED,
    connected,
    source: connected ? "whoop_live" : WHOOP_CONFIGURED ? "whoop_tokens_missing" : "not_configured",
    recovery,
    sleep,
    strain,
    hrv,
    restingHeartRate,
    averageHeartRate,
    maxHeartRate,
    operatingMode,
    mode: operatingMode,
    suggestion,
    message: connected
      ? `WHOOP conectado. Recovery: ${recovery ?? "—"}%. Sleep: ${sleep ?? "—"}%. Strain: ${strain != null ? strain.toFixed(1) : "—"}.`
      : WHOOP_CONFIGURED
        ? "WHOOP configurado — tokens pendientes o cache sin datos."
        : "Conecta WHOOP para ajustar decisiones según sueño, recuperación y carga fisiológica.",
    educationalNote: "No es consejo médico ni financiero."
  };
}

function computeAutoJournal() {
  const h = computeHealthReadiness();
  const pv = portfolioValue();
  const idea = computeTradeIdea();
  const cyc = whoopCache.cycle;
  const dateStr = new Date().toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const kilojoule = cyc && cyc.score && cyc.score.kilojoule != null ? cyc.score.kilojoule : null;
  const scoreState = cyc && cyc.score && cyc.score.state ? cyc.score.state : null;

  let moodEstimated = "neutral";
  if (h.recovery !== null) {
    moodEstimated = h.recovery >= 67 ? "positivo" : h.recovery >= 34 ? "neutral" : "low-strain";
  } else if (h.strain !== null) {
    moodEstimated = h.strain > 15 ? "caution" : "neutral";
  }

  let bodyState = "sin datos biométricos";
  if (h.connected) {
    if (h.recovery !== null) {
      bodyState = h.recovery >= 67 ? "cuerpo óptimo — recovery alto"
        : h.recovery >= 34 ? "cuerpo moderado — en recuperación"
        : "cuerpo bajo — priorizar descanso";
    } else if (h.strain !== null) {
      bodyState = h.strain > 15 ? "cuerpo cargado — strain elevado"
        : h.strain > 8 ? "cuerpo activo — strain moderado"
        : "cuerpo descansado — strain bajo";
    }
  }

  const tradingModeSuggestion = h.recovery !== null
    ? (h.recovery >= 67 ? "NORMAL — condiciones óptimas para analizar" : h.recovery >= 34 ? "MODERADO — evitar posiciones nuevas grandes" : "DEFENSIVO — solo monitorear, no entrar")
    : "NEUTRAL — sin datos biométricos, proceder con cautela";

  const alfredoAdvice = `Portafolio ${money(pv.totalValueMXN)} (${pct(pv.totalGainPct)}). ` +
    (idea.hasIdea ? `Idea paper: ${idea.type} en ${idea.symbol}. ` : "") +
    `Modo operativo: ${h.operatingMode}. ${h.suggestion}. NO es consejo médico ni financiero.`;

  return {
    ok: true,
    source: h.connected ? "WHOOP + Cordelius" : "local_only",
    date: dateStr,
    moodEstimated,
    bodyState,
    operatingMode: h.operatingMode,
    mode: h.operatingMode,
    tradingModeSuggestion,
    alfredoNote: alfredoAdvice,
    alfredoAdvice,
    // Top-level biometrics (used by renderJournalModule)
    strain: h.strain,
    averageHeartRate: h.averageHeartRate,
    maxHeartRate: h.maxHeartRate,
    recovery: h.recovery,
    sleep: h.sleep,
    hrv: h.hrv,
    restingHeartRate: h.restingHeartRate,
    portfolioSnapshot: { totalMXN: pv.totalValueMXN, gainPct: pv.totalGainPct },
    whoop: {
      connected: h.connected,
      strain: h.strain,
      averageHeartRate: h.averageHeartRate,
      maxHeartRate: h.maxHeartRate,
      kilojoule,
      scoreState,
      recovery: h.recovery,
      sleep: h.sleep,
      hrv: h.hrv,
      restingHeartRate: h.restingHeartRate,
      mode: h.operatingMode,
      alfredoAdvice
    },
    educationalNote: "Generado automáticamente. No es consejo médico ni financiero."
  };
}


function healthValue(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp(n, min = 0, max = 100) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function computeReadinessStatus(score) {
  if (score >= 85) return "EXCELENTE";
  if (score >= 70) return "BUENO";
  if (score >= 55) return "MEDIO";
  if (score >= 40) return "BAJO";
  return "CRÍTICO";
}
function computeHealthScores(whoop = {}) {
  const recovery = healthValue(whoop.recovery, 50);
  const sleep = healthValue(whoop.sleep, 50);
  const strain = healthValue(whoop.strain, 0);
  const hrv = healthValue(whoop.hrv, 70);
  const rhr = healthValue(whoop.restingHeartRate, 58);
  const recoveryComponent = clamp(recovery);
  const sleepComponent = clamp(sleep);
  const hrvComponent = clamp((hrv / 160) * 100);
  const nervousSystem = clamp((hrvComponent * 0.65) + ((70 - Math.min(rhr, 70)) / 30 * 35));
  const strainPenalty = clamp(strain * 4, 0, 45);
  const healthScore = clamp((recoveryComponent * 0.34) + (sleepComponent * 0.28) + (hrvComponent * 0.2) + (nervousSystem * 0.18) - strainPenalty * 0.35);
  const energy = clamp((sleepComponent * 0.4) + (recoveryComponent * 0.35) + Math.max(0, 100 - strain * 5) * 0.25);
  const focus = clamp((healthScore * 0.45) + (nervousSystem * 0.35) + (sleepComponent * 0.2));
  const mentalClarity = clamp((focus * 0.65) + (recoveryComponent * 0.2) + (sleepComponent * 0.15));
  const overtradingRisk = clamp((100 - healthScore) * 0.55 + Math.max(0, strain - 8) * 8 + Math.max(0, 60 - recovery) * 0.35);
  const stressLoad = clamp((100 - nervousSystem) * 0.45 + strain * 4 + Math.max(0, 60 - sleep) * 0.25);
  const recoveryPriority = clamp((100 - recoveryComponent) * 0.55 + strain * 4 + Math.max(0, 60 - sleepComponent) * 0.2);
  const deepWork = clamp((focus * 0.7) + (energy * 0.3) - (overtradingRisk > 70 ? 12 : 0));
  const tradingCapacity = clamp((healthScore * 0.55) + (focus * 0.25) + (energy * 0.2) - (overtradingRisk > 65 ? 18 : 0));
  return {
    healthScore: Math.round(healthScore), readiness: Math.round((recoveryComponent + sleepComponent + hrvComponent) / 3), status: computeReadinessStatus(healthScore),
    mentalClarity: Math.round(mentalClarity), energy: Math.round(energy), nervousSystem: Math.round(nervousSystem), overtradingRisk: Math.round(overtradingRisk), stressLoad: Math.round(stressLoad), recoveryPriority: Math.round(recoveryPriority),
    physicalEnergy: Math.round(energy), mentalEnergy: Math.round(mentalClarity), focusCapacity: Math.round(focus), deepWorkCapacity: Math.round(deepWork), tradingCapacity: Math.round(tradingCapacity),
    radar: { recovery: Math.round(recoveryComponent), sleep: Math.round(sleepComponent), hrv: Math.round(hrvComponent), nervousSystem: Math.round(nervousSystem), energy: Math.round(energy), focus: Math.round(focus) }
  };
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function healthSnapshotRecord(whoop = {}) {
  const scores = computeHealthScores(whoop);
  return { date: todayKey(), ts: Date.now(), recovery: whoop.recovery ?? null, sleep: whoop.sleep ?? null, strain: whoop.strain ?? null, hrv: whoop.hrv ?? null, restingHeartRate: whoop.restingHeartRate ?? null, averageHeartRate: whoop.averageHeartRate ?? null, maxHeartRate: whoop.maxHeartRate ?? null, operatingMode: whoop.operatingMode || whoop.mode || "NORMAL", connected: !!whoop.connected, scores };
}
function upsertHealthSnapshot(record) {
  const history = loadJSON(HEALTH_SNAPSHOT_FILE, []);
  const filtered = Array.isArray(history) ? history.filter(x => x && x.date !== record.date) : [];
  filtered.push(record); filtered.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const next = filtered.slice(-120); saveJSON(HEALTH_SNAPSHOT_FILE, next); return next;
}
function loadHealthBehaviors() { const data = loadJSON(HEALTH_BEHAVIOR_FILE, {}); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; }
function saveHealthBehaviors(data) { saveJSON(HEALTH_BEHAVIOR_FILE, data || {}); }
function getTodayHealthBehaviors() { const all = loadHealthBehaviors(); return all[todayKey()] || {}; }
function computeHealthCorrelations(history, behaviorsByDate) {
  const rows = Array.isArray(history) ? history.filter(x => x && x.date) : [];
  const notReady = rows.length < 3;
  const metric = (behavior, field) => {
    const withBehavior = rows.filter(x => behaviorsByDate[x.date] && behaviorsByDate[x.date][behavior] && typeof x[field] === "number").map(x => x[field]);
    const withoutBehavior = rows.filter(x => !(behaviorsByDate[x.date] && behaviorsByDate[x.date][behavior]) && typeof x[field] === "number").map(x => x[field]);
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const a = avg(withBehavior), b = avg(withoutBehavior);
    return a === null || b === null ? null : Number((a - b).toFixed(1));
  };
  return { ready: !notReady, message: notReady ? "Recolectando datos. Se activará con 3+ días de snapshots." : "Correlaciones educativas activas con snapshots locales.", items: [
    { label: "Sauna vs Recovery", value: notReady ? null : metric("sauna", "recovery") }, { label: "Cannabis vs Sleep", value: notReady ? null : metric("cannabis", "sleep") }, { label: "Cannabis vs HRV", value: notReady ? null : metric("cannabis", "hrv") }, { label: "Stress vs Recovery", value: notReady ? null : metric("stress", "recovery") }, { label: "Training vs Sleep", value: notReady ? null : metric("training", "sleep") }
  ] };
}
function buildHealthInsight(whoop, scores, fresh = whoop.connected === true) {
  const recovery = whoop.recovery ?? "—", sleep = whoop.sleep ?? "—", strain = whoop.strain ?? "—", hrv = whoop.hrv ?? "—";
  const noData = [whoop.recovery, whoop.sleep, whoop.strain, whoop.hrv].every(v => v == null);
  if (noData) return `Sin lectura WHOOP disponible hoy (tokens pendientes o cache vacío). No se muestran números inventados; conecta WHOOP para ver recovery, sleep, HRV y strain reales. Educativo. No es asesoría médica ni financiera.`;
  const recDate = whoop.date || (whoop.timestamp ? String(whoop.timestamp).slice(0, 10) : null);
  const lead = fresh ? "Hoy tu lectura WHOOP-first marca" : `Última lectura WHOOP registrada${recDate ? ` (${recDate})` : ""} — no es de hoy — marca`;
  const social = Math.round(clamp((scores.energy * 0.45) + (scores.mentalClarity * 0.35) + (100 - scores.stressLoad) * 0.2));
  return `${lead} recovery ${recovery}%, sleep ${sleep}%, HRV ${hrv} ms y strain ${strain}. El Health Score está en ${scores.healthScore}/100 (${scores.status}) con modo ${whoop.operatingMode || whoop.mode || "NORMAL"}. Esto sugiere energía física ${scores.physicalEnergy}/100, claridad mental ${scores.mentalClarity}/100 y sistema nervioso ${scores.nervousSystem}/100. Qué hacer: prioriza decisiones simples, bloques de trabajo claros y recuperación si el score baja. Qué evitar: sobreoperar, perseguir movimientos, estudiar sin pausas o cargar más estrés si el overtrading risk está alto (${scores.overtradingRisk}/100). Capacidad educativa de trading: ${scores.tradingCapacity}/100; capacidad de estudio profundo: ${scores.deepWorkCapacity}/100; capacidad social estimada: ${social}/100. Riesgo de burnout: ${scores.stressLoad >= 70 || scores.recoveryPriority >= 70 ? "elevado" : "controlado"}. Educativo. No es asesoría médica ni financiera.`;
}

function saveJournalEntry(entry) {
  journalEntries.unshift(entry);
  journalEntries = journalEntries.slice(0, 300);
  saveJSON(JOURNAL_FILE, journalEntries);
}

function computeJournalData() {
  const recent = journalEntries.slice(0, 7);
  const moodCounts = {};
  journalEntries.slice(0, 30).forEach(e => { moodCounts[e.mood || "neutral"] = (moodCounts[e.mood || "neutral"] || 0) + 1; });
  const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0];
  return {
    ok: true,
    count: journalEntries.length,
    recent,
    topMood: topMood ? topMood[0] : null,
    summary: journalEntries.length === 0 ? "Sin entradas todavía. Empieza a escribir en Journal." : `${journalEntries.length} entradas. Mood frecuente: ${topMood ? topMood[0] : "variado"}.`
  };
}

function renderTradingAIStatus() {
  return `<div style="max-width:1280px;margin:0 auto 8px;border:1px solid rgba(255,211,92,.18);border-radius:24px;padding:18px 22px;background:linear-gradient(135deg,rgba(255,211,92,.04),rgba(59,157,255,.04))">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      <div>
        <div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c">TRADING AI · PAPER MODE ${statusBadge("SIMULATED")}</div>
        <div style="color:#9fb3c8;font-size:13px;margin-top:2px">Simulación educativa — sin dinero real — Alpaca pendiente de conexión</div>
      </div>
      <div style="display:flex;gap:8px">
        <span style="border:1px solid rgba(255,211,92,.3);border-radius:99px;padding:4px 13px;font-size:12px;font-weight:900;color:#ffd35c">PAPER ONLY</span>
        <span style="border:1px solid rgba(120,160,210,.15);border-radius:99px;padding:4px 13px;font-size:12px;color:#9fb3c8">Alpaca: pendiente</span>
      </div>
    </div>
    <div class="grid" style="margin:0;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">${renderBotMetricCards()}</div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(120,160,210,.07);display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <a class="btn" href="/bot/start" style="font-size:13px;padding:7px 14px">▶ Start</a>
      <a class="btn" href="/bot/pause" style="font-size:13px;padding:7px 14px">⏸ Pause</a>
      <a class="btn" href="/bot/reset" style="font-size:13px;padding:7px 14px">↺ Reset</a>
      <span class="muted" style="font-size:12px">PAPER TRADING / SIMULACIÓN — NO USA DINERO REAL</span>
    </div>
  </div>`;
}

function renderPaperTradingPanel() {
  const idea = computeTradeIdea();
  const bt = renderBotTables();
  const trades = bot.history || [];
  const buys = trades.filter(t => t.type === "BUY");
  const sells = trades.filter(t => t.type === "SELL");
  const symbols = [...new Set(trades.map(t => t.symbol))];
  const realizedPnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const eq = bot.equityHistory || [];
  const eqSpanH = eq.length > 1 ? (eq[eq.length - 1].t - eq[0].t) / 3600000 : 0;
  const opsSummary = trades.length
    ? `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;border:1px solid rgba(0,255,153,.14);border-radius:14px;padding:11px 16px;margin-bottom:12px;background:rgba(0,0,0,.18)">
        ${statusBadge("SIMULATED")}
        <span style="font-size:13px;color:#dbeafe"><b>${trades.length}</b> operaciones paper</span>
        <span style="font-size:12px;color:#00ff99">${buys.length} BUY</span>
        <span style="font-size:12px;color:#ff4d6d">${sells.length} SELL</span>
        <span style="font-size:12px;color:#9fb3c8">Símbolos: ${symbols.map(esc).join(", ")}</span>
        <span style="font-size:12px;color:${realizedPnl >= 0 ? "#00ff99" : "#ff4d6d"}">P&L realizado (sim): ${money(realizedPnl)}</span>
        <span style="font-size:11px;color:#5a6674">${esc(trades[trades.length - 1] ? trades[trades.length - 1].time : "")} → ${esc(trades[0] ? trades[0].time : "")}</span>
      </div>`
    : `<div class="muted" style="border:1px solid rgba(120,160,210,.12);border-radius:14px;padding:11px 16px;margin-bottom:12px;font-size:13px">Sin operaciones paper registradas todavía. Las decisiones disponibles aparecen abajo y en Autopilot.</div>`;
  return `<div style="max-width:1280px;margin:0 auto 16px">
    ${opsSummary}
    ${idea.hasIdea ? `<div style="border:1px solid rgba(0,255,153,.18);border-radius:18px;padding:14px 20px;margin-bottom:14px;background:rgba(0,255,153,.03)">
      <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#00ff99;margin-bottom:8px">Idea de paper trade (hipotético — no ejecutar)</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <b style="font-size:20px">${esc(idea.symbol)}</b>
        <span style="color:#00ff99;font-weight:700">${esc(idea.action)}</span>
        <span class="muted" style="font-size:13px">${esc(idea.reason)}</span>
      </div>
    </div>` : ""}
    ${spark(bot.equityHistory, { key: "v", color: "#00ff99", height: 220 })}
    <div style="font-size:11px;color:${eqSpanH >= 36 ? "#9fb3c8" : "#ffd35c"};margin-top:4px">${eqSpanH >= 36 ? `Equity simulado · rango ${(eqSpanH / 24).toFixed(1)} días (timestamps reales)` : `Equity simulado intradía (~${eqSpanH.toFixed(1)}h) — historial limitado, se extiende solo. La bitácora de abajo sí cruza días.`}</div>
    <h2 style="font-size:18px;margin:16px 0 8px">Posiciones simuladas</h2>
    <div class="panel table-wrap"><table><thead><tr><th>Activo</th><th>Unidades</th><th>Avg</th><th>Precio</th><th>Valor</th><th>P&L</th><th>SL</th><th>TP</th></tr></thead><tbody>${bt.posRows}</tbody></table></div>
    <h2 style="font-size:18px;margin:16px 0 8px">Bitácora del bot</h2>
    <div class="panel table-wrap"><table><thead><tr><th>Tipo</th><th>Activo</th><th>Unidades</th><th>Precio</th><th>Valor</th><th>P&L</th><th>Hora</th><th>Razón</th></tr></thead><tbody>${bt.histRows}</tbody></table></div>
  </div>`;
}

function renderMorningReport() {
  const nl = computeDailyNewsletter();
  const idea = computeTradeIdea();
  const h = computeHealthReadiness();
  const lines = nl.lines.slice(0, 3);
  const ideaHtml = idea.hasIdea
    ? `<div style="margin-top:10px;padding:9px 13px;background:rgba(0,255,153,.06);border:1px solid rgba(0,255,153,.15);border-radius:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#00ff99">IDEA PAPER</span>
        <b style="font-size:13px">${esc(idea.symbol)}</b>
        <span style="color:#00ff99;font-weight:700;font-size:13px">${esc(idea.type)}</span>
        <span class="muted" style="font-size:12px">${esc(idea.reason)}</span>
      </div>`
    : `<div style="margin-top:10px;padding:7px 12px;background:rgba(120,160,210,.05);border-radius:8px;color:#9fb3c8;font-size:12px">Sin idea de trade destacada hoy.</div>`;
  const healthHtml = `<div style="margin-top:10px;padding:9px 13px;background:rgba(244,114,182,.05);border:1px solid rgba(244,114,182,.15);border-radius:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#f472b6">ESTADO PERSONAL</span>
    <span style="color:#ffd35c;font-weight:700;font-size:13px">${esc(h.operatingMode)}</span>
    <span class="muted" style="font-size:12px">${esc(h.suggestion)}</span>
    <span style="background:${h.configured ? "rgba(0,255,153,.12)" : "rgba(255,211,92,.10)"};color:${h.configured ? "#00ff99" : "#ffd35c"};border-radius:99px;padding:2px 9px;font-size:11px;font-weight:700">WHOOP ${h.configured ? "ON" : "PENDIENTE"}</span>
  </div>`;
  return `<div style="max-width:1280px;margin:0 auto 12px">
    <div class="panel" style="border:1px solid rgba(59,157,255,.18);background:rgba(59,157,255,.04);padding:16px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <div>
          <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#3b9dff">Morning Report — ${esc(nl.date)}</div>
          <div style="font-size:14px;color:#dbeafe;font-weight:600;margin-top:3px">${esc(nl.greeting)}</div>
        </div>
        <a href="/api/morning-report" target="_blank" style="font-size:11px;color:#3b9dff;text-decoration:none;border:1px solid rgba(59,157,255,.25);border-radius:99px;padding:4px 11px">JSON</a>
      </div>
      <ul style="margin:0;padding-left:16px;list-style:disc">
        ${lines.map(l => `<li style="margin-bottom:5px;color:#c8d8f0;font-size:13px">${esc(l)}</li>`).join("")}
      </ul>
      ${ideaHtml}
      ${healthHtml}
    </div>
  </div>`;
}

function lastItems(file, limit = 5) {
  const rows = loadJSON(file, []);
  return Array.isArray(rows) ? rows.slice(-limit).reverse() : [];
}
function summarizeAutopilotProgress(days) {
  const cutoff = Date.now() - days * 86400000;
  const health = loadJSON(HEALTH_SNAPSHOT_FILE, []).filter(x => x && (x.ts || Date.parse(x.date || 0)) >= cutoff);
  const portfolio = loadJSON(PORTFOLIO_SNAPSHOT_FILE, []).filter(x => x && (x.ts || Date.parse(x.date || 0)) >= cutoff);
  const decisions = loadJSON(TRADING_DECISION_FILE, []).filter(x => x && (x.ts || Date.parse(x.date || 0)) >= cutoff);
  const avg = (arr, field) => {
    const nums = arr.map(x => x && x[field]).filter(v => typeof v === "number" && Number.isFinite(v));
    return nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)) : null;
  };
  const firstPortfolio = portfolio.length ? portfolio[0] : null;
  const lastPortfolio = portfolio.length ? portfolio[portfolio.length - 1] : null;
  const firstEquity = firstPortfolio && typeof firstPortfolio.equityTotalMXN === "number" ? firstPortfolio.equityTotalMXN : null;
  const lastEquity = lastPortfolio && typeof lastPortfolio.equityTotalMXN === "number" ? lastPortfolio.equityTotalMXN : null;
  return {
    days,
    enoughData: health.length >= 3 || portfolio.length >= 3 || decisions.length >= 3,
    counts: { health: health.length, portfolio: portfolio.length, decisions: decisions.length },
    health: {
      avgRecovery: avg(health, "recovery"),
      avgSleep: avg(health, "sleep"),
      avgStrain: avg(health, "strain"),
      avgHrv: avg(health, "hrv")
    },
    portfolio: {
      firstEquityMXN: firstEquity,
      lastEquityMXN: lastEquity,
      equityDeltaMXN: firstEquity !== null && lastEquity !== null ? Number((lastEquity - firstEquity).toFixed(2)) : null
    },
    learningStatus: health.length + portfolio.length + decisions.length >= 3 ? "learning" : "collecting"
  };
}
function computeAutopilotProgress() {
  const progress = { ok:true, ts:Date.now(), sevenDays:summarizeAutopilotProgress(7), thirtyDays:summarizeAutopilotProgress(30) };
  saveJSON(CORDELIUS_PROGRESS_FILE, progress);
  return progress;
}
function buildAutopilotDatabaseSummary() {
  const health = loadJSON(HEALTH_SNAPSHOT_FILE, []);
  const portfolio = loadJSON(PORTFOLIO_SNAPSHOT_FILE, []);
  const decisions = loadJSON(TRADING_DECISION_FILE, []);
  const memory = loadJSON(AUTOPILOT_MEMORY_FILE, []);
  const progress = loadJSON(CORDELIUS_PROGRESS_FILE, null) || computeAutopilotProgress();
  const last = memory.length ? memory[memory.length - 1] : null;
  const latestHealthSnapshot = health.length ? health[health.length - 1] : null;
  const latestPortfolioSnapshot = portfolio.length ? portfolio[portfolio.length - 1] : null;
  const latestTradingDecision = decisions.length ? decisions[decisions.length - 1] : null;
  const latestAutopilotMemory = last || null;
  return {
    ok: true,
    ts: Date.now(),
    lastUpdated: last ? last.timestamp : null,
    counts: { health: health.length, portfolio: portfolio.length, decisions: decisions.length, memory: memory.length },
    latestHealthSnapshot,
    latestPortfolioSnapshot,
    latestTradingDecision,
    latestAutopilotMemory,
    latest: {
      health: lastItems(HEALTH_SNAPSHOT_FILE, 5),
      portfolio: lastItems(PORTFOLIO_SNAPSHOT_FILE, 5),
      decisions: lastItems(TRADING_DECISION_FILE, 5),
      memory: lastItems(AUTOPILOT_MEMORY_FILE, 3)
    },
    progress,
    educationalNote: "Cordelius empieza a aprender de tu salud, portafolio y decisiones. Contexto educativo, no señal financiera ni médica."
  };
}
function localJson(pathname) {
  return new Promise(resolve => {
    http.get("http://127.0.0.1:" + PORT + pathname, rr => {
      let raw = "";
      rr.on("data", c => raw += c);
      rr.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok:false, parseError:true }); } });
    }).on("error", e => resolve({ ok:false, error:e.message }));
  });
}
async function createAutopilotSnapshot() {
  const whoop = await localJson("/api/whoop/today");
  const healthReadiness = computeHealthReadiness();
  const portfolio = portfolioValue();
  const tradeIdea = computeTradeIdea();
  const tradingSummary = computeTradingSummary();
  const operatingMode = (whoop && (whoop.operatingMode || whoop.mode)) || healthReadiness.operatingMode || "NORMAL";
  const timestamp = new Date().toISOString();
  const alfredoAdvice = (whoop && (whoop.alfredoAdvice || whoop.suggestion || whoop.message)) || healthReadiness.message || "Cordelius guardó snapshot local.";
  const snapshot = { ok:true, timestamp, ts:Date.now(), whoop, healthReadiness, portfolio, tradeIdea, tradingSummary, operatingMode, alfredoAdvice };
  appendSnapshot(HEALTH_SNAPSHOT_FILE, { timestamp, ts:snapshot.ts, ...(whoop || {}), healthReadiness, operatingMode }, 500);
  appendSnapshot(PORTFOLIO_SNAPSHOT_FILE, { timestamp, ts:snapshot.ts, equityTotalMXN: portfolio.totalValueMXN, pnlTotalMXN: portfolio.totalGainMXN, pnlTotalPct: portfolio.totalGainPct, assetCount: portfolio.assets.length, topAssets: portfolio.assets.slice().sort((a,b)=>b.valueMXN-a.valueMXN).slice(0,8) }, 500);
  appendSnapshot(TRADING_DECISION_FILE, { timestamp, ts:snapshot.ts, tradeIdea, operatingMode, alfredoAdvice }, 500);
  appendSnapshot(AUTOPILOT_MEMORY_FILE, snapshot, 500);
  snapshot.progress = computeAutopilotProgress();
  return snapshot;
}
function renderAutopilotDatabasePanel() {
  return `<div class="panel" style="border:1px solid rgba(0,255,153,.16);background:rgba(0,255,153,.035);margin-top:14px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div><div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#00ff99">Cordelius Database</div><div class="muted" style="font-size:12px;margin-top:4px">Operating Memory · snapshots locales ignorados por Git</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" onclick="saveAutopilotSnapshot()">Guardar snapshot ahora</button><button class="btn" onclick="renderAutopilotProgress()">Ver progreso</button></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:12px">
      <div class="card" style="padding:12px"><div class="label">Health logs</div><div id="autopilot-db-health" class="big">—</div></div>
      <div class="card" style="padding:12px"><div class="label">Portfolio logs</div><div id="autopilot-db-portfolio" class="big">—</div></div>
      <div class="card" style="padding:12px"><div class="label">Trading decisions</div><div id="autopilot-db-trading" class="big">—</div></div>
      <div class="card" style="padding:12px"><div class="label">Last snapshot</div><div id="autopilot-db-last" style="font-size:13px;font-weight:900;color:#dbeafe">—</div></div>
      <div class="card" style="padding:12px"><div class="label">Learning status</div><div id="autopilot-db-learning" style="font-size:18px;font-weight:950;color:#00ff99">—</div></div>
    </div>
    <div id="autopilot-db-progress" class="muted" style="font-size:13px;line-height:1.6">Cordelius empieza a aprender de tu salud, portafolio y decisiones.</div>
  </div>`;
}

function renderOpportunityEnginePanel() {
  const state = getOpportunityState();
  const oppRows = (state.topOpportunities || []).slice(0, 3).map(x => `<div style="border-top:1px solid rgba(120,160,210,.08);padding:8px 0"><b style="color:#eaf6ff">${esc(x.symbol)}</b> <span style="color:#00ff99;font-weight:900">${x.score}/100</span><div class="muted" style="font-size:11px">${esc(x.signal)} · ${esc(x.reason)}</div></div>`).join("") || `<div class="muted">Sin oportunidades todavía.</div>`;
  const riskRows = (state.topRisks || []).slice(0, 3).map(x => `<div style="border-top:1px solid rgba(120,160,210,.08);padding:8px 0"><b style="color:#eaf6ff">${esc(x.symbol)}</b> <span style="color:#ff4d6d;font-weight:900">riesgo ${x.riskScore}/100</span><div class="muted" style="font-size:11px">${esc(x.reason)}</div></div>`).join("") || `<div class="muted">Sin riesgos nuevos.</div>`;
  const queue = getResearchQueue();
  const queueHtml = queue.length ? queue.slice(0, 8).map(s => `<span style="display:inline-flex;border:1px solid rgba(59,157,255,.24);border-radius:999px;padding:4px 9px;margin:2px;color:#9bd3ff;font-size:11px;font-weight:900">${esc(s)}</span>`).join("") : `<span class="muted">Queue vacía</span>`;
  const watchHtml = (state.watchlistCandidates || []).slice(0, 6).map(x => `<span style="display:inline-flex;border:1px solid rgba(0,255,153,.18);border-radius:999px;padding:4px 9px;margin:2px;color:#00ff99;font-size:11px;font-weight:900">${esc(x.symbol)} ${x.score}</span>`).join("") || `<span class="muted">Sin candidatos</span>`;
  return `<div class="panel" style="border:1px solid rgba(59,157,255,.16);background:rgba(59,157,255,.035);margin-top:14px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div><div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#3b9dff">Cordelius Opportunity Engine</div><div class="muted" style="font-size:12px;margin-top:4px">Discovery + stock research educativo · sin ejecución ni órdenes.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="opportunity-research-symbol" placeholder="NVDA" style="max-width:110px;border:1px solid rgba(120,160,210,.18);background:rgba(0,0,0,.24);color:#eaf6ff;border-radius:12px;padding:10px;font-weight:900;text-transform:uppercase"><button class="btn" onclick="analyzeOpportunitySymbol()">Analyze Stock</button><button class="btn" onclick="runOpportunityEngine()">Run Opportunities</button></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px">
      <div class="card" style="padding:14px"><div class="label">Top 3 Opportunities</div><div id="opportunity-top-list">${oppRows}</div></div>
      <div class="card" style="padding:14px"><div class="label">Top 3 Risks</div><div id="opportunity-risk-list">${riskRows}</div></div>
      <div class="card" style="padding:14px"><div class="label">Research Queue</div><div id="opportunity-queue-list" style="margin-top:8px">${queueHtml}</div><div class="label" style="margin-top:12px">Watchlist Candidates</div><div id="opportunity-watchlist-list" style="margin-top:8px">${watchHtml}</div></div>
    </div>
    <div id="opportunity-research-result" class="muted" style="font-size:13px;line-height:1.55;margin-top:12px">${esc(state.disclaimer || "Educational only. No financial advice.")}</div>
  </div>`;
}

function loadAlerts() {
  return loadJSON(ALERTS_FILE, []);
}
function saveAlerts(arr) {
  saveJSON(ALERTS_FILE, arr.slice(-50));
}
function alertId() {
  return "alert_" + Math.random().toString(36).slice(2, 8) + "_" + Math.random().toString(36).slice(2, 6);
}
function buildAlerts(pv, h) {
  const candidates = [];
  const today = todayKey();
  const ts = Date.now();
  const mk = (type, severity, title, message, source, dedupeKey) =>
    ({ id: alertId(), timestamp: new Date(ts).toISOString(), date: today,
       type, severity, title, message, source, dedupeKey, sentToTelegram: false, acknowledged: false });
  const cryptoAssets = (pv.assets || []).filter(a => a.type === "crypto");
  const cryptoPct = pv.totalValueMXN > 0 ? cryptoAssets.reduce((s, a) => s + a.valueMXN, 0) / pv.totalValueMXN * 100 : 0;
  if (cryptoPct > 70) candidates.push(mk("CONCENTRACION", "WARNING",
    `Concentración cripto elevada: ${cryptoPct.toFixed(1)}%`,
    `Tu exposición cripto (${cryptoPct.toFixed(1)}%) supera el 70%. Alta volatilidad — considera revisar diversificación. (No consejo financiero.)`,
    "portfolio", "port_crypto_conc"));
  for (const a of (pv.assets || [])) {
    if (a.score < 30) candidates.push(mk("SCORE_CRITICO", "CRITICAL",
      `${a.symbol} score crítico: ${a.score}/100`,
      `${esc(a.name || a.symbol)} tiene score ${a.score}/100. Evalúa tu tesis de inversión. (No consejo financiero.)`,
      "portfolio", `score_critico_${a.symbol}`));
    if (a.gainPct < -15 && a.risk === "ALTO") candidates.push(mk("DRAWDOWN", "WARNING",
      `${a.symbol} en caída: ${a.gainPct.toFixed(1)}%`,
      `${esc(a.name || a.symbol)} tiene pérdida de ${a.gainPct.toFixed(1)}% (score ${a.score}/100). Evalúa tu tesis. (No consejo financiero.)`,
      "portfolio", `drawdown_${a.symbol}`));
    if (a.gainPct > 80 && a.ind && a.ind.momentum > 0) candidates.push(mk("TOMA_GANANCIA", "OPPORTUNITY",
      `${a.symbol} ganancia: +${a.gainPct.toFixed(1)}%`,
      `${esc(a.name || a.symbol)} con +${a.gainPct.toFixed(1)}% (score ${a.score}/100). Considera evaluar take-profit parcial. (No consejo financiero.)`,
      "portfolio", `takegain_${a.symbol}`));
  }
  if (h.connected && h.recovery !== null && h.recovery < 50) {
    candidates.push(mk("HEALTH_LOW", "INFO",
      `Capacidad de trading BAJA hoy`,
      `Recovery ${h.recovery}%, modo ${h.operatingMode}. Portafolio ${money(pv.totalValueMXN)} (${pct(pv.totalGainPct)}). Modo defensivo recomendado. Educativo — no consejo financiero ni médico.`,
      "health", "health_low_trading"));
    const riskyAsset = (pv.assets || []).find(a => Math.abs(a.gainPct) > 15 || a.score < 40);
    if (riskyAsset) candidates.push(mk("HEALTH_CROSSOVER", "WARNING",
      `Recovery bajo + posición volátil: ${riskyAsset.symbol}`,
      `Recovery ${h.recovery}% (bajo) y ${riskyAsset.symbol} con variación notable (${riskyAsset.gainPct.toFixed(1)}%). Modo defensivo educativo.`,
      "crossover", "health_crossover"));
  }
  return candidates;
}
function checkAlertsDryRun() {
  const pv = portfolioValue();
  const h = computeHealthReadiness();
  const existing = loadAlerts();
  const todayExisting = existing.filter(a => a.date === todayKey());
  const candidates = buildAlerts(pv, h);
  const newAlerts = candidates.filter(c => !todayExisting.find(e => e.dedupeKey === c.dedupeKey));
  if (!newAlerts.length) return { ok: true, generated: 0, total: existing.length, message: "Sin alertas nuevas para hoy." };
  const merged = [...existing, ...newAlerts].slice(-50);
  saveAlerts(merged);
  return { ok: true, generated: newAlerts.length, total: merged.length, newAlerts, message: `${newAlerts.length} alerta(s) nueva(s) generadas.` };
}
function renderAlertsPanel() {
  const alerts = loadAlerts();
  const active = alerts.filter(a => !a.acknowledged);
  const sevColor = { CRITICAL: "#ff4d6d", WARNING: "#ffd35c", OPPORTUNITY: "#00ff99", INFO: "#3b9dff" };
  const fmtTs = ts => { try { return new Date(ts).toLocaleString("es-MX", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch(e) { return "—"; } };
  const rows = active.slice(0, 10).map(a => {
    const color = sevColor[a.severity] || "#9fb3c8";
    return `<div style="border:1px solid ${color}28;border-radius:14px;padding:13px 16px;background:${color}06;margin-bottom:8px;display:flex;gap:12px;align-items:flex-start">
      <span style="width:8px;height:8px;border-radius:50%;background:${color};flex:0 0 auto;margin-top:4px"></span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
          <div style="font-size:13px;font-weight:700;color:${color}">${esc(a.title)}</div>
          <span style="font-size:10px;font-weight:900;border:1px solid ${color}44;border-radius:99px;padding:2px 8px;color:${color};white-space:nowrap">${esc(a.severity)}</span>
        </div>
        <div style="font-size:12px;color:#9fb3c8;margin-top:4px">${esc(a.message)}</div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <span style="font-size:10px;color:#5a6674">${esc(fmtTs(a.timestamp))}</span>
          <span style="font-size:10px;color:#5a6674;border:1px solid rgba(120,160,210,.1);border-radius:6px;padding:1px 6px">${esc(a.type)}</span>
          <form method="POST" action="/alerts/dismiss" onsubmit="event.preventDefault();secureFetch('/alerts/dismiss',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id='+encodeURIComponent('${esc(a.id)}')}).then(()=>location.reload())" style="margin:0">
            <button type="submit" style="background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);color:#9fb3c8;border-radius:8px;padding:2px 9px;cursor:pointer;font-size:11px">Dismiss</button>
          </form>
        </div>
      </div>
    </div>`;
  }).join("");
  return `<div style="max-width:1280px;margin:16px auto 0">
    <div class="panel" style="border:1px solid rgba(255,211,92,.18);background:rgba(255,211,92,.03);padding:18px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        <div>
          <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c">ALERTS · Bitácora de eventos</div>
          <div style="font-size:12px;color:#9fb3c8;margin-top:3px">${active.length} activas · ${alerts.length} total · <code style="font-size:10px;color:#3b9dff">GET /api/alerts</code></div>
        </div>
        <button onclick="secureFetch('/api/alerts/dry-run',{method:'POST'}).then(()=>location.reload())" class="btn" style="font-size:12px;padding:7px 14px">Evaluar alertas</button>
      </div>
      ${active.length ? rows : '<div class="muted" style="font-size:12px">Sin alertas activas. Usa "Evaluar alertas" para generar.</div>'}
      <div style="margin-top:10px;font-size:11px;color:#5a6674">Educativo. No es consejo financiero ni médico. Telegram: pendiente Slice E.</div>
    </div>
  </div>`;
}

function renderLedgerPanel() {
  const positions = loadJSON(POSITION_LEDGER_FILE, []);
  const changes   = loadJSON(CHANGE_LEDGER_FILE, []);
  const latest    = positions.length ? positions[positions.length - 1] : null;
  const latestChg = changes.length  ? changes[changes.length - 1]      : null;
  const combined  = [
    ...positions.map(e => ({ ...e, _src: "position" })),
    ...changes.map(e =>   ({ ...e, _src: "change" }))
  ].sort((a, b) => b.ts - a.ts).slice(0, 10);
  const fmtTs = ts => { try { return new Date(ts).toLocaleString("es-MX", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch(e) { return "—"; } };
  const latestRow = latest
    ? `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:6px">
        <b style="color:#00ff99">${money(latest.totalValueMXN)}</b>
        <span class="${latest.totalGainPct >= 0 ? "green" : "red"}">${pct(latest.totalGainPct)}</span>
        <span style="font-size:11px;color:#9fb3c8">${esc(fmtTs(latest.ts))}</span>
      </div>`
    : '<div class="muted" style="font-size:12px;margin-top:6px">Sin snapshots todavía.</div>';
  const latestChgRow = latestChg
    ? `<div style="font-size:12px;color:#9fb3c8;margin-top:6px">${esc(latestChg.summary || latestChg.note || latestChg.type || "—")} · ${esc(fmtTs(latestChg.ts))}</div>`
    : '<div class="muted" style="font-size:12px;margin-top:6px">Sin eventos todavía.</div>';
  const activityRows = combined.map(e => {
    const isPos = e._src === "position";
    const dot   = isPos ? "#3b9dff" : "#818cf8";
    const title = isPos ? "Portfolio snapshot" : (e.type === "manual_note" ? "Nota manual" : e.type === "snapshot_saved" ? "Snapshot guardado" : esc(e.type || "evento"));
    const detail = isPos
      ? `${money(e.totalValueMXN)} · ${pct(e.totalGainPct)}`
      : esc(e.summary || e.note || "—");
    return `<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid rgba(120,160,210,.06)">
      <span style="width:7px;height:7px;border-radius:50%;background:${dot};margin-top:4px;flex:0 0 auto"></span>
      <div>
        <div style="font-size:12px;font-weight:700;color:${dot}">${title}</div>
        <div style="font-size:11px;color:#9fb3c8">${detail}</div>
        <div style="font-size:10px;color:#5a6674">${esc(fmtTs(e.ts))}</div>
      </div>
    </div>`;
  }).join("");
  return `<div style="max-width:1280px;margin:16px auto 0">
    <div class="panel" style="border:1px solid rgba(59,157,255,.18);background:rgba(59,157,255,.03);padding:18px 20px">
      <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#3b9dff;margin-bottom:12px">POSITION LEDGER · Bitácora de portafolio</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px">
        <div style="background:rgba(59,157,255,.06);border:1px solid rgba(59,157,255,.15);border-radius:12px;padding:12px 14px">
          <div class="label">Snapshots</div>
          <div class="big" style="font-size:26px;color:#3b9dff">${positions.length}</div>
          <div class="muted" style="font-size:11px">posiciones</div>
        </div>
        <div style="background:rgba(129,140,248,.06);border:1px solid rgba(129,140,248,.15);border-radius:12px;padding:12px 14px">
          <div class="label">Eventos</div>
          <div class="big" style="font-size:26px;color:#818cf8">${changes.length}</div>
          <div class="muted" style="font-size:11px">change ledger</div>
        </div>
        <div style="background:rgba(0,255,153,.04);border:1px solid rgba(0,255,153,.12);border-radius:12px;padding:12px 14px">
          <div class="label">Último snapshot</div>
          ${latestRow}
        </div>
        <div style="background:rgba(129,140,248,.04);border:1px solid rgba(129,140,248,.12);border-radius:12px;padding:12px 14px">
          <div class="label">Último evento</div>
          ${latestChgRow}
        </div>
      </div>
      ${combined.length ? `<div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#9fb3c8;margin-bottom:8px">Actividad reciente · ${combined.length} entradas</div><div>${activityRows}</div>` : '<div class="muted" style="font-size:12px">Sin actividad registrada.</div>'}
      <div style="margin-top:10px;font-size:11px;color:#5a6674">Solo lectura · <code style="color:#3b9dff;font-size:10px">GET /api/ledger</code></div>
    </div>
  </div>`;
}

function renderAutopilotPanel() {
  const statusCards = [
    { label: "SERVIDOR",     value: "ON",       sub: "Cordelius OS",      bg: "rgba(0,255,153,.07)",    border: "rgba(0,255,153,.18)",    color: "#00ff99" },
    { label: "CLOUDFLARE",   value: "MANUAL",   sub: "bash tunnel.sh",    bg: "rgba(255,211,92,.07)",   border: "rgba(255,211,92,.18)",   color: "#ffd35c" },
    { label: "PAPER MODE",   value: "ON",       sub: "Sin dinero real",   bg: "rgba(0,255,153,.07)",    border: "rgba(0,255,153,.18)",    color: "#00ff99" },
    { label: "REAL TRADING", value: "OFF",      sub: "Desactivado",       bg: "rgba(255,77,109,.07)",   border: "rgba(255,77,109,.18)",   color: "#ff4d6d" },
    { label: "QUIVER",       value: quiverData.configured ? "ON" : "—",  sub: quiverData.configured ? "Datos en vivo" : "Agrega API key", bg: quiverData.configured ? "rgba(0,255,153,.07)" : "rgba(255,211,92,.07)", border: quiverData.configured ? "rgba(0,255,153,.18)" : "rgba(255,211,92,.18)", color: quiverData.configured ? "#00ff99" : "#ffd35c" },
    { label: "ALPACA",       value: "NO CONECTADO", sub: "Nunca órdenes reales", bg: "rgba(129,140,248,.07)",  border: "rgba(129,140,248,.18)",  color: "#818cf8" },
    { label: "WHOOP",        value: WHOOP_CONFIGURED ? "DETECTADO" : "PENDIENTE", sub: WHOOP_CONFIGURED ? "API key lista" : "Conecta para readiness", bg: WHOOP_CONFIGURED ? "rgba(0,255,153,.07)" : "rgba(244,114,182,.07)", border: WHOOP_CONFIGURED ? "rgba(0,255,153,.18)" : "rgba(244,114,182,.18)", color: WHOOP_CONFIGURED ? "#00ff99" : "#f472b6" },
  ];
  const _apReal = (function(){
    const decisions = loadJSON(TRADING_DECISION_FILE, []);
    const lastDec = decisions[decisions.length - 1];
    const snaps = loadJSON(PORTFOLIO_SNAPSHOT_FILE, []);
    const lastSnap = Array.isArray(snaps) && snaps.length ? snaps[snaps.length - 1] : null;
    const mem = loadJSON("data/autopilot_memory.json", null);
    const memEntries = Array.isArray(mem) ? mem.length : mem && typeof mem === "object" ? Object.keys(mem).length : 0;
    const opp = getOpportunityState();
    return `<div style="border:1px solid rgba(120,160,210,.12);border-radius:14px;padding:13px 16px;margin-bottom:14px;background:rgba(0,0,0,.18)">
      <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#818cf8;margin-bottom:8px">Estado real — qué hace y qué no</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;font-size:12px;color:#c8d8f0">
        <div><b style="color:#3b9dff">Observa:</b> ${PORTFOLIO.length} activos del portafolio, ${MARKET_WATCHLIST.length} tickers de watchlist, ${(opp.topOpportunities || []).length} oportunidades scoring.</div>
        <div><b style="color:#00ff99">Última decisión:</b> ${lastDec ? esc((lastDec.title || lastDec.action || lastDec.type || "registro") + " · " + (lastDec.timestamp || lastDec.date || "")) : "ninguna registrada"} ${statusBadge("SIMULATED")}</div>
        <div><b style="color:#ffd35c">Último snapshot:</b> ${lastSnap ? esc(new Date(lastSnap.timestamp).toLocaleString("es-MX")) : "—"} · memoria: ${memEntries} entradas</div>
        <div><b style="color:#ff4d6d">NO puede:</b> ejecutar órdenes reales, tocar dinero, conectarse a exchanges, modificar .env/tokens. Todo es paper/educativo.</div>
      </div>
    </div>`;
  })();
  return `<div style="max-width:1280px;margin:0 auto 16px">
    <div class="panel" style="border:1px solid rgba(129,140,248,.18);background:rgba(129,140,248,.04)">
      <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#818cf8;margin-bottom:12px">Autopilot — Estado del sistema</div>
      ${_apReal}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px">
        ${statusCards.map(c => `<div style="background:${c.bg};border:1px solid ${c.border};border-radius:12px;padding:10px 12px;text-align:center">
          <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:${c.color};margin-bottom:3px">${c.label}</div>
          <div style="font-size:16px;font-weight:900;color:${c.color}">${c.value}</div>
          <div class="muted" style="font-size:10px;margin-top:2px">${c.sub}</div>
        </div>`).join("")}
      </div>
      ${renderAutopilotDatabasePanel()}
      ${renderOpportunityEnginePanel()}
      <div style="border-top:1px solid rgba(120,160,210,.08);padding-top:10px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:#9fb3c8;margin-bottom:8px">SCRIPTS</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${["health_check.sh","restart_safe.sh","morning_report.sh","final_check.sh"].map(s =>
            `<span style="border:1px solid rgba(129,140,248,.22);border-radius:99px;padding:3px 10px;font-size:11px;font-family:monospace;color:#818cf8">bash scripts/${esc(s)}</span>`
          ).join("")}
        </div>
        <div class="muted" style="font-size:11px;margin-top:8px">Próximo: Termux:Boot — ver AUTOMATION.md</div>
      </div>
    </div>
    <!-- PAC — Personal Autopilot Connection scaffold -->
    <div style="margin-top:12px;padding:16px 18px;background:rgba(255,211,92,.03);border:1px solid rgba(255,211,92,.12);border-radius:16px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;flex-wrap:wrap">
        <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c">PAC · Personal Autopilot Connection</div>
        <span style="border-radius:99px;padding:2px 10px;font-size:10px;font-weight:900;background:rgba(255,211,92,.1);color:#ffd35c">${PAC_API_KEY ? "CONECTADO" : "PENDIENTE"}</span>
      </div>
      <div style="font-size:12px;color:#9fb3c8">${PAC_API_KEY ? '<span style="color:#00ff99;font-weight:900">● PAC conectado · listo para ejecución paper</span>' : 'Agrega <code style="color:#ffd35c;background:rgba(0,0,0,.3);padding:1px 6px;border-radius:5px">PAC_API_KEY</code> en .env para activar. Infraestructura de endpoints lista.'}</div>
    </div>
  </div>`;
}

function renderWhoopNotConnected() {
  const h = computeHealthReadiness();
  if (h.connected) {
    // WHOOP is live — show status card with real data
    const recColor = h.recovery !== null ? (h.recovery >= 67 ? "#00ff99" : h.recovery >= 34 ? "#ffd35c" : "#ff4d6d") : "#9fb3c8";
    return `<div style="max-width:1280px;margin:0 auto 12px">
      <div style="border:1px solid rgba(0,255,153,.2);background:rgba(0,255,153,.05);border-radius:20px;padding:16px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="font-size:28px">◉</div>
        <div style="flex:1;min-width:200px">
          <div style="font-size:12px;font-weight:900;color:#00ff99;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">WHOOP CONECTADO</div>
          ${h.profile ? `<div style="font-size:13px;color:#9fb3c8">Usuario: ${esc(h.profile.first_name || "")} ${esc(h.profile.last_name || "")}</div>` : ""}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${h.strain !== null ? `<div style="text-align:center"><div style="font-size:22px;font-weight:900;color:#eaf6ff">${h.strain.toFixed(1)}</div><div class="muted" style="font-size:10px">Strain</div></div>` : ""}
          ${h.averageHeartRate !== null ? `<div style="text-align:center"><div style="font-size:22px;font-weight:900;color:#f472b6">${h.averageHeartRate}</div><div class="muted" style="font-size:10px">Avg HR</div></div>` : ""}
          ${h.maxHeartRate !== null ? `<div style="text-align:center"><div style="font-size:22px;font-weight:900;color:#ff4d6d">${h.maxHeartRate}</div><div class="muted" style="font-size:10px">Max HR</div></div>` : ""}
          ${h.recovery !== null ? `<div style="text-align:center"><div style="font-size:22px;font-weight:900;color:${recColor}">${h.recovery}%</div><div class="muted" style="font-size:10px">Recovery</div></div>` : ""}
          ${h.hrv !== null ? `<div style="text-align:center"><div style="font-size:22px;font-weight:900;color:#818cf8">${h.hrv.toFixed(1)}</div><div class="muted" style="font-size:10px">HRV ms</div></div>` : ""}
        </div>
        <div style="width:100%;font-size:12px;color:#9fb3c8;padding-top:6px;border-top:1px solid rgba(0,255,153,.1)">
          Modo: <b style="color:#00ff99">${esc(h.operatingMode)}</b> · ${esc(h.suggestion)}
        </div>
      </div>
    </div>`;
  }
  // Not connected — show setup instructions
  const vars = { clientId: !!process.env.WHOOP_CLIENT_ID, clientSecret: !!process.env.WHOOP_CLIENT_SECRET, redirectUri: !!process.env.WHOOP_REDIRECT_URI };
  const hasVars = vars.clientId && vars.clientSecret;
  return `<div style="max-width:1280px;margin:0 auto 12px">
    <div style="border:1px solid rgba(244,114,182,.25);background:rgba(244,114,182,.06);border-radius:20px;padding:18px 22px;display:flex;align-items:flex-start;gap:16px">
      <div style="font-size:28px;margin-top:2px">◉</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:900;color:#f472b6;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">WHOOP no conectado</div>
        ${hasVars
          ? `<div style="font-size:14px;color:#eaf6ff;margin-bottom:8px">Env vars detectadas — necesitas completar el flujo OAuth para obtener tokens.</div><div style="font-size:12px;color:#9fb3c8">Visita <code style="background:rgba(0,0,0,.3);padding:2px 7px;border-radius:6px">/whoop/auth</code> para iniciar la autorización.</div>`
          : `<div style="font-size:14px;color:#eaf6ff;margin-bottom:8px">Sin datos de recuperación, sueño, HRV o strain.</div>
             <div style="font-size:12px;color:#9fb3c8;margin-bottom:10px">Agrega en <code style="background:rgba(0,0,0,.3);padding:2px 7px;border-radius:6px">.env</code>:</div>
             <div style="display:flex;flex-wrap:wrap;gap:6px">
               <code style="background:rgba(0,0,0,.3);color:#ffd35c;padding:4px 10px;border-radius:8px;font-size:12px">WHOOP_CLIENT_ID=YOUR_CLIENT_ID</code>
               <code style="background:rgba(0,0,0,.3);color:#ffd35c;padding:4px 10px;border-radius:8px;font-size:12px">WHOOP_CLIENT_SECRET=YOUR_CLIENT_SECRET</code>
               <code style="background:rgba(0,0,0,.3);color:#ffd35c;padding:4px 10px;border-radius:8px;font-size:12px">WHOOP_REDIRECT_URI=http://localhost:3000/whoop/callback</code>
             </div>`}
      </div>
    </div>
  </div>`;
}

function renderHealthReadinessPanel() {
  const h = computeHealthReadiness();
  const cyc = whoopCache.cycle;
  const scoreState = cyc && cyc.score && cyc.score.state ? cyc.score.state : null;
  const kilojoule = cyc && cyc.score && cyc.score.kilojoule != null ? cyc.score.kilojoule : null;

  const recColor = h.recovery !== null ? (h.recovery >= 67 ? "#00ff99" : h.recovery >= 34 ? "#ffd35c" : "#ff4d6d") : "#9fb3c8";
  const slpColor = h.sleep !== null ? (h.sleep >= 70 ? "#00ff99" : h.sleep >= 50 ? "#ffd35c" : "#ff4d6d") : "#9fb3c8";
  const strColor = h.strain !== null ? (h.strain > 15 ? "#ff4d6d" : h.strain > 8 ? "#ffd35c" : "#00ff99") : "#9fb3c8";
  const hrvColor = h.hrv !== null ? (h.hrv >= 50 ? "#00ff99" : h.hrv >= 30 ? "#ffd35c" : "#ff4d6d") : "#9fb3c8";
  const stateColor = scoreState === "SCORED" ? "#00ff99" : scoreState ? "#ffd35c" : "#9fb3c8";

  // id attr for each metric so JS can update live
  const metrics = [

    { id: "hr-recovery", label: "Recovery",   value: h.recovery !== null ? h.recovery + "%" : "—",                       color: recColor },
    { id: "hr-sleep",    label: "Sleep",       value: h.sleep !== null ? h.sleep + "%" : "—",                             color: slpColor },
    { id: "hr-strain",   label: "Strain",      value: h.strain !== null ? h.strain.toFixed(1) : "—",                      color: strColor },
    { id: "hr-avghr",    label: "Avg HR",      value: h.averageHeartRate !== null ? h.averageHeartRate + " bpm" : "—",    color: "#f472b6" },
    { id: "hr-maxhr",    label: "Max HR",      value: h.maxHeartRate !== null ? h.maxHeartRate + " bpm" : "—",            color: "#ff4d6d" },
    { id: "hr-hrv",      label: "HRV",         value: h.hrv !== null ? h.hrv.toFixed(1) + " ms" : "—",                   color: hrvColor },
    { id: "hr-rhr",      label: "Resting HR",  value: h.restingHeartRate !== null ? h.restingHeartRate + " bpm" : "—",   color: "#9fb3c8" },
    { id: "hr-kj",       label: "Kilojoule",   value: kilojoule !== null ? kilojoule.toFixed(0) + " kJ" : "—",           color: "#9fb3c8" },
    { id: "hr-state",    label: "Estado",      value: scoreState || "—",                                                   color: stateColor },
    { id: "hr-mode",     label: "Modo",        value: h.operatingMode,                                                     color: "#ffd35c" },
  ];

  const badgeBg    = h.connected ? "rgba(0,255,153,.15)" : h.configured ? "rgba(255,211,92,.12)" : "rgba(120,160,210,.08)";
  const badgeColor = h.connected ? "#00ff99" : h.configured ? "#ffd35c" : "#9fb3c8";
  const badgeLabel = h.connected ? "● WHOOP LIVE" : h.configured ? "WHOOP DETECTADO" : "SIN DATOS";

  const pv = portfolioValue();
  const idea = computeTradeIdea();
  const jarvisAdvice = `Portafolio ${money(pv.totalValueMXN)} (${pct(pv.totalGainPct)}). ` +
    (idea.hasIdea ? `Idea paper: ${idea.type} en ${idea.symbol}. ` : "") +
    `Modo: ${h.operatingMode}. ${h.suggestion}.`;

  return `<div style="max-width:1280px;margin:0 auto 12px">
    <div class="panel" style="border:1px solid rgba(244,114,182,.18);background:rgba(244,114,182,.04);padding:16px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div>
          <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#f472b6">Health · Patrones personales</div>
          <div class="muted" style="font-size:12px;margin-top:2px">Sueño · Recovery · Energía · Hábitos · no consejo médico</div>
        </div>
        <span id="hr-badge" style="border-radius:99px;padding:4px 13px;font-size:12px;font-weight:900;background:${badgeBg};color:${badgeColor}">${badgeLabel}</span>

      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        ${metrics.map(m =>
          `<div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:10px;padding:8px 12px;min-width:80px">
            <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">${esc(m.label)}</div>

            <div id="${m.id}" style="font-size:${m.id === "hr-state" ? "13px" : "16px"};font-weight:900;color:${esc(m.color)}">${esc(m.value)}</div>
          </div>`
        ).join("")}
      </div>
      <div style="padding:10px 14px;background:rgba(244,114,182,.06);border:1px solid rgba(244,114,182,.12);border-radius:10px;font-size:13px;color:#f9a8d4">
        <b id="hr-mode-footer" style="color:#ffd35c">${esc(h.operatingMode)}</b> · <span id="hr-suggestion">${esc(h.suggestion)}</span>
        <div style="margin-top:5px;font-size:12px;color:#9fb3c8"><span id="hr-advice">${esc(jarvisAdvice)}</span> <span style="opacity:.6">· No es consejo financiero.</span></div>

      </div>
      <div class="muted" style="font-size:11px;margin-top:8px">${esc(h.educationalNote)}</div>
    </div>
  </div>`;
}


function renderPortfolioSnapshot(pv, reg) {
  const best = pv.assets.slice().sort((a, b) => b.score - a.score)[0];
  const cripto = pv.assets.filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0);
  const criptoPct = pv.totalValueMXN > 0 ? (cripto / pv.totalValueMXN * 100) : 0;
  const gainColor = pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d";
  return `<div style="background:var(--panel);border:1px solid rgba(59,157,255,.2);border-radius:20px;padding:16px 20px">
    <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#3b9dff;margin-bottom:8px">Portfolio Snapshot</div>
    <div style="font-size:28px;font-weight:900;color:${gainColor};line-height:1">${money(pv.totalValueMXN)}</div>
    <div style="font-size:13px;color:${gainColor};margin:4px 0 10px">${pct(pv.totalGainPct)} · ${money(pv.totalGainMXN)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <span style="background:rgba(255,211,92,.1);border:1px solid rgba(255,211,92,.2);border-radius:99px;padding:3px 10px;font-size:11px;color:#ffd35c">${esc(reg.label)}</span>
      <span style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:99px;padding:3px 10px;font-size:11px;color:#9fb3c8">Cripto ${criptoPct.toFixed(0)}%</span>
      ${best ? `<span style="background:rgba(0,255,153,.08);border:1px solid rgba(0,255,153,.2);border-radius:99px;padding:3px 10px;font-size:11px;color:#00ff99">Top: ${esc(best.symbol)} ${best.score}/100</span>` : ""}
      <span style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:99px;padding:3px 10px;font-size:11px;color:#9fb3c8">${pv.assets.length} activos</span>
    </div>
  </div>`;
}

function renderExecutiveHub(pv, reg) {
  const h = computeHealthReadiness();
  const idea = computeTradeIdea();
  const nl = computeDailyNewsletter();
  const opp = getOpportunityState();
  const topOpp = (opp.topOpportunities || [])[0];
  const modules = [
    { label: "PORTAFOLIO",    value: money(pv.totalValueMXN), sub: pct(pv.totalGainPct), color: pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d", href: "#portfolio" },
    { label: "MERCADO",       value: esc(reg.label),           sub: pct(reg.avg),         color: reg.color,  href: "#vigilar" },
    { label: "PAPER TRADE",   value: idea.hasIdea ? esc(idea.type) : "SIN SEÑAL", sub: idea.hasIdea ? esc(idea.symbol || "") : "", color: idea.hasIdea ? "#00ff99" : "#9fb3c8", href: "#bot" },
    { label: "HEALTH",        value: h.configured ? "WHOOP ON" : "SIN DATOS",    sub: esc(h.operatingMode), color: h.configured ? "#00ff99" : "#9fb3c8", href: "#health" },
    { label: "QUIVER",        value: quiverData.configured ? "LIVE" : "PENDIENTE", sub: quiverData.configured ? "Datos institucionales" : "Agrega API key", color: quiverData.configured ? "#00ff99" : "#ffd35c", href: "#quiver" },
    { label: "OPPORTUNITY",   value: topOpp ? esc(topOpp.symbol) : "WATCH", sub: topOpp ? topOpp.score + "/100" : "research", color: topOpp ? "#3b9dff" : "#9fb3c8", href: "#autopilot" },
  ];
  return `<div style="max-width:1280px;margin:0 auto 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
    ${modules.map(m => `<a href="${m.href}" style="text-decoration:none">
      <div style="background:var(--panel);border:1px solid rgba(120,160,210,.14);border-radius:16px;padding:14px 16px;transition:.2s" onmouseover="this.style.borderColor='${m.color}40'" onmouseout="this.style.borderColor='rgba(120,160,210,.14)'">
        <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:6px">${m.label}</div>
        <div style="font-size:17px;font-weight:900;color:${m.color};line-height:1.1">${m.value}</div>
        <div style="font-size:11px;color:#9fb3c8;margin-top:4px">${m.sub}</div>
      </div>
    </a>`).join("")}
  </div>`;
}

function alfredoDailyContext(h, pv, reg) {
  const mode = h.operatingMode || "NORMAL";
  const recovery = h.recovery;
  const sleep = h.sleep;
  const strain = h.strain;
  const bbva = (pv.assets || []).find(a => a.symbol === "BBVA");
  let oneLiner = "Cordelius listo: revisa salud, portafolio y contexto antes de decidir.";
  let question = "¿Quieres que Jarvis conecte salud, BBVA y noticias antes de revisar el día?";
  if (strain !== null && strain >= 10) {
    oneLiner = "Veo strain alto: modo defensivo y decisiones más simples.";
    question = "Veo strain alto; ¿quieres que hoy Jarvis limite el paper trading a observación?";
  } else if (recovery !== null && recovery >= 75 && sleep !== null && sleep >= 80) {
    oneLiner = "Buen estado físico: analiza con calma, sin forzar acciones.";
    question = "Buen recovery y sleep; ¿quieres revisar ideas educativas sin ejecutar nada?";
  } else if (bbva) {
    oneLiner = "BBVA sigue como ancla del panel; conviene revisar score y contexto.";
    question = "BBVA está en tu radar; ¿quieres revisar noticias antes de decidir?";
  } else if (reg && reg.label) {
    question = `Mercado en ${reg.label}; ¿quieres ver el resumen de riesgo antes de entrar a trading?`;
  }
  const nextActions = [
    { mod: "trading", label: "Revisar Cordelius Trading" },
    { mod: "journal", label: "Registrar nota rápida" },
    { mod: "health", label: "Ver Cordelius Health" }
  ];
  return { mode, oneLiner, question, nextActions };
}

// ── Badges honestos de origen de dato ──
const BADGE_META = {
  LIVE:      { color: "#00ff99", title: "Dato en vivo de API real" },
  FALLBACK:  { color: "#ffd35c", title: "Sin API activa; valor local o ausente" },
  STALE:     { color: "#fb923c", title: "Dato real pero viejo" },
  SIMULATED: { color: "#a78bfa", title: "Simulado/determinista, no real" },
  MANUAL:    { color: "#3b9dff", title: "Capturado a mano" },
  HEURISTIC: { color: "#9fb3c8", title: "Calculado con reglas locales" },
  MIXED:     { color: "#67e8f9", title: "Parte real, parte simulado — ver detalle por activo" }
};
function statusBadge(status) {
  const m = BADGE_META[status] || BADGE_META.HEURISTIC;
  return `<span title="${esc(m.title)}" style="display:inline-block;border-radius:99px;padding:2px 8px;font-size:9px;font-weight:900;letter-spacing:.08em;color:${m.color};background:${m.color}14;border:1px solid ${m.color}33;vertical-align:middle">${esc(status)}</span>`;
}

// Sección colapsable con estado persistido en localStorage (clave data-clps).
function collapsibleSection(id, title, summaryHtml, contentHtml, defaultOpen = false) {
  return `<details class="clps" data-clps="${esc(id)}" ${defaultOpen ? "open" : ""} style="max-width:1280px;margin:0 auto 12px">
    <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 20px;background:var(--panel);border:1px solid rgba(120,160,210,.14);border-radius:18px;user-select:none">
      <span style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><b style="font-size:15px">${title}</b>${summaryHtml || ""}</span>
      <span class="clps-caret" style="font-size:11px;opacity:.55;transition:.2s">▼</span>
    </summary>
    <div style="padding-top:10px">${contentHtml}</div>
  </details>`;
}

// Header neural: red de nodos SVG animada + estado del sistema en vivo.
// Sin imágenes externas; todo inline. Premium/minimal/oscuro.
function renderNeuralHeader() {
  const h = computeHealthReadiness();
  const nodes = [
    [78, 34], [34, 70], [120, 62], [76, 100], [168, 32], [196, 78], [152, 104], [228, 52], [212, 110]
  ];
  const links = [[0,1],[0,2],[1,3],[2,3],[2,4],[4,5],[5,6],[3,6],[0,4],[4,7],[5,7],[5,8],[7,8],[6,8]];
  const linkColor = i => i % 3 === 0 ? "0,255,153" : i % 3 === 1 ? "59,157,255" : "255,211,92";
  const svg = `<svg width="248" height="128" viewBox="0 0 248 128" fill="none" style="flex:0 0 auto;filter:drop-shadow(0 0 14px rgba(0,255,153,.18))">
    ${links.map(([a, b], i) => {
      const [x1, y1] = nodes[a], [x2, y2] = nodes[b];
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(${linkColor(i)},.4)" stroke-width="1" stroke-dasharray="4 7" style="animation:dash ${2.2 + (i % 5) * .6}s linear infinite"/>
      <circle r="2.2" fill="rgb(${linkColor(i)})" opacity=".95"><animateMotion dur="${2.6 + (i % 4) * .9}s" repeatCount="indefinite" path="M${x1},${y1} L${x2},${y2}"/></circle>`;
    }).join("")}
    ${nodes.map(([x, y], i) => `<g>
      <circle cx="${x}" cy="${y}" r="${i === 0 ? 7 : 4.5}" fill="rgba(${linkColor(i)},.16)" stroke="rgb(${linkColor(i)})" stroke-width="1.1"><animate attributeName="r" values="${i === 0 ? "7;9;7" : "4.5;6;4.5"}" dur="${2.4 + (i % 3)}s" repeatCount="indefinite"/></circle>
      <circle cx="${x}" cy="${y}" r="1.8" fill="rgb(${linkColor(i)})"/>
    </g>`).join("")}
  </svg>`;
  const pills = [
    { label: "SECURITY", on: true },
    { label: "SESSION", on: !!CORDELIUS_ACCESS_KEY },
    { label: "WHOOP", badge: h.configured ? "LIVE" : "FALLBACK" },
    { label: "QUOTES", badge: quotesFreshness() },
    { label: "CRYPTO", badge: cryptoFreshness() },
    { label: "INDICATORS", badge: indicatorsFreshness() }
  ];
  return `<div class="panel" style="max-width:1280px;margin:8px auto 14px;padding:16px 24px;display:flex;gap:24px;align-items:center;flex-wrap:wrap;border:1px solid rgba(0,255,153,.18);background:linear-gradient(120deg,rgba(0,255,153,.06),rgba(59,157,255,.05) 55%,rgba(255,211,92,.04));position:relative;overflow:hidden">
    <div style="position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,transparent 0%,rgba(0,255,153,.04) 50%,transparent 100%);background-size:100% 220%;animation:nscan 7s linear infinite"></div>
    ${svg}
    <div style="flex:1;min-width:250px;position:relative">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <div style="font-size:24px;font-weight:900;background:linear-gradient(90deg,#00ff99,#9bd3ff,#ffd35c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:.06em;text-shadow:0 0 28px rgba(0,255,153,.15)">CORDELIUS · NEURAL OS</div>
        <span style="display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:900;letter-spacing:.14em;color:#00ff99"><span class="status-dot"></span>SISTEMA VIVO</span>
      </div>
      <div style="font-size:11px;color:#9fb3c8;margin:5px 0 11px;letter-spacing:.04em">datos → análisis → señales → decisiones · pensamiento en tiempo real · <span style="color:#5a6674">educativo — no asesoría financiera ni médica</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${pills.map(p => p.badge
          ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:900;letter-spacing:.08em;color:#9fb3c8;border:1px solid rgba(120,160,210,.12);border-radius:99px;padding:3px 9px;background:rgba(0,0,0,.2)">${esc(p.label)} ${statusBadge(p.badge)}</span>`
          : `<span style="display:inline-flex;align-items:center;gap:5px;border-radius:99px;padding:4px 11px;font-size:9px;font-weight:900;letter-spacing:.08em;background:${p.on ? "rgba(0,255,153,.1)" : "rgba(255,211,92,.1)"};color:${p.on ? "#00ff99" : "#ffd35c"};border:1px solid ${p.on ? "rgba(0,255,153,.3)" : "rgba(255,211,92,.3)"}">${esc(p.label)} ${p.on ? "ON" : "OFF"}</span>`).join("")}
      </div>
    </div>
  </div>`;
}

// Action Center: ÚNICO lugar para preguntas, next actions, alerts y
// automations. Los demás módulos referencian aquí en vez de duplicar.
function renderActionCenter() {
  const b = computeJarvisBrain();
  const h = computeHealthReadiness();
  const pv = portfolioValue();
  const reg = marketRegime();
  const ctx = alfredoDailyContext(h, pv, reg);
  const automation = getAutomationState();
  const alerts = loadAlerts().filter(a => !a.acknowledged).slice(-3).reverse();
  const notes = loadJSON("data/jarvis_quick_notes.json", []);
  const sevColor = s => s === "CRITICAL" ? "#ff4d6d" : s === "WARNING" ? "#ffd35c" : "#3b9dff";
  const alertRow = (icon, color, text, tag) => `<div style="display:flex;gap:8px;align-items:start;border-left:3px solid ${color};padding:5px 9px;background:rgba(0,0,0,.18);border-radius:0 9px 9px 0;margin-bottom:5px">
    <span style="color:${color};font-weight:900;font-size:12px">${icon}</span>
    <div style="flex:1"><div style="font-size:12px;color:#dbeafe;line-height:1.3">${esc(text)}</div>${tag ? `<div style="font-size:9px;color:#5a6674;text-transform:uppercase;letter-spacing:.08em;margin-top:1px">${esc(tag)}</div>` : ""}</div>
  </div>`;
  return `<div class="panel" id="action-center" style="max-width:1280px;margin:0 auto 16px;padding:16px 22px;border:1px solid rgba(255,211,92,.2);background:rgba(255,211,92,.03)">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      <div style="font-size:12px;font-weight:900;letter-spacing:.2em;text-transform:uppercase;color:#ffd35c">◈ Action Center</div>
      <div style="font-size:10px;color:#5a6674">único inbox de preguntas y acciones · <span class="cmdk-kbd">⌘K</span> para actuar · notas: ${Array.isArray(notes) ? notes.length : 0}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:10px">
      <div class="ac-block">
        <div class="ac-title" style="color:#ffd35c">⌾ Pregunta actual</div>
        <div style="font-size:14px;font-weight:800;color:#fff;line-height:1.35">${esc(ctx.question)}</div>
      </div>
      <div class="ac-block">
        <div class="ac-title" style="color:#3b9dff">→ Next actions</div>
        <ol style="margin:0;padding-left:16px">${b.nextActions.slice(0, 4).map(a => `<li style="font-size:12px;color:#c8d8f0;margin-bottom:4px;line-height:1.35">${esc(a)}</li>`).join("")}</ol>
      </div>
      <div class="ac-block">
        <div class="ac-title" style="color:#ff4d6d">! Alerts (${alerts.length})</div>
        ${alerts.length ? alerts.map(a => alertRow("!", sevColor(a.severity || "WARNING"), a.title, Date.parse(a.timestamp || "") < Date.now() - 24 * 3600 * 1000 ? "vieja · detalle en Autopilot" : "activa")).join("") : `<div class="muted" style="font-size:12px">— Sin alertas activas.</div>`}
      </div>
      <div class="ac-block">
        <div class="ac-title" style="color:#fb923c">⚙ Automations hoy (${automation.firedToday.length})</div>
        ${automation.firedToday.length ? automation.firedToday.map(e => alertRow("⚙", sevColor(e.severity), e.message, e.suggestedMode ? "sugiere " + e.suggestedMode : null)).join("") : `<div class="muted" style="font-size:12px">— Ninguna regla disparada hoy.</div>`}
      </div>
    </div>
  </div>`;
}

function renderJarvisBrainPanel() {
  const b = computeJarvisBrain();
  const h = computeHealthReadiness();
  const pv = portfolioValue();
  const reg = marketRegime();
  const modeColor = settings.defensiveMode ? "#ff4d6d" : "#00ff99";
  // Live Signals: solo señales reales (indicadores LIVE), compactas.
  const liveAssets = pv.assets.filter(a => a.indicatorStatus === "LIVE");
  const extremes = liveAssets.filter(a => a.ind.rsi >= 70 || a.ind.rsi <= 30)
    .sort((a, c) => Math.abs(c.ind.rsi - 50) - Math.abs(a.ind.rsi - 50)).slice(0, 4);
  const bears = liveAssets.filter(a => a.ind.trend === "BAJISTA").length;
  const bulls = liveAssets.filter(a => a.ind.trend === "ALCISTA").length;
  const criptoPct = cryptoConcentrationPct(pv);
  const signals = [
    `<span class="brain-chip" style="border-color:${reg.color}40;color:${reg.color}">◈ ${esc(reg.label)} <span style="color:#5a6674;font-size:10px">${pct(reg.avg)}</span></span>`,
    `<span class="brain-chip">↑${bulls} <span style="color:#5a6674">alcistas</span> · ↓${bears} <span style="color:#5a6674">bajistas</span> <span style="color:#5a6674;font-size:10px">(${liveAssets.length} reales)</span></span>`,
    `<span class="brain-chip" style="${criptoPct > 60 ? "border-color:rgba(255,77,109,.35);color:#ff8aa0" : ""}">cripto ${criptoPct.toFixed(0)}%</span>`,
    ...extremes.map(a => `<span class="brain-chip" style="border-color:${a.ind.rsi <= 30 ? "rgba(0,255,153,.3)" : "rgba(255,77,109,.3)"}"><b>${esc(a.symbol)}</b> RSI ${a.ind.rsi} <span style="color:#5a6674;font-size:10px">${a.ind.rsi <= 30 ? "sobreventa" : "sobrecompra"}</span></span>`)
  ];
  const lastDec = (() => { const d = loadJSON(TRADING_DECISION_FILE, []); return d[d.length - 1] || null; })();
  const lastTrade = (bot.history || [])[0] || null;
  const ready = (label, r) => `<div style="text-align:center;border:1px solid rgba(120,160,210,.12);border-radius:14px;padding:9px 6px;background:rgba(255,255,255,.03)">
      <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8">${esc(label)}</div>
      <div style="font-size:23px;font-weight:900;color:${r.score === null ? "#5a6674" : r.score >= 70 ? "#00ff99" : r.score >= 45 ? "#ffd35c" : "#ff4d6d"};margin:3px 0 2px">${r.score === null ? "—" : r.score}</div>
      ${statusBadge(r.status)}
    </div>`;
  return `<div class="panel" id="jarvis-brain" style="max-width:1280px;margin:0 auto 16px;padding:20px 24px;border:1px solid rgba(0,255,153,.2);background:linear-gradient(135deg,rgba(0,255,153,.06),rgba(59,157,255,.04) 70%);box-shadow:0 16px 50px rgba(0,0,0,.3),0 0 40px rgba(0,255,153,.05)">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      <div style="font-size:12px;font-weight:900;letter-spacing:.2em;text-transform:uppercase;color:#00ff99">⚡ Cordelius Brain</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${Object.entries(b.state.dataStatus).map(([k, v]) => `<span style="font-size:8px;color:#5a6674">${esc(k)}</span>${statusBadge(v)}`).join(" ")}</div>
    </div>
    <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(230px,.6fr);gap:18px">
      <div>
        <div style="font-size:9px;font-weight:900;letter-spacing:.13em;text-transform:uppercase;color:#9fb3c8;margin-bottom:7px">Estado</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">
          <span class="brain-chip" style="border-color:${modeColor}40;color:${modeColor};font-weight:900">${esc(b.state.mode)}</span>
          <span class="brain-chip"><b>${money(pv.totalValueMXN)}</b> <span style="color:${pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d"};font-size:11px">${pct(pv.totalGainPct)}</span></span>
          <span class="brain-chip">R <b style="color:#f472b6">${h.recovery !== null ? h.recovery + "%" : "—"}</b> · S <b style="color:#f472b6">${h.sleep !== null ? h.sleep + "%" : "—"}</b></span>
        </div>
        <div style="font-size:9px;font-weight:900;letter-spacing:.13em;text-transform:uppercase;color:#ffd35c;margin-bottom:6px">Top Focus</div>
        <div style="font-size:19px;font-weight:900;color:#fff;line-height:1.3;margin-bottom:14px">${esc(b.topFocus)}</div>
        <div style="font-size:9px;font-weight:900;letter-spacing:.13em;text-transform:uppercase;color:#3b9dff;margin-bottom:7px">Live Signals</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">${signals.join("")}</div>
        <div style="font-size:9px;font-weight:900;letter-spacing:.13em;text-transform:uppercase;color:#a78bfa;margin-bottom:6px">Decisions</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
          ${lastTrade ? `<span class="brain-chip">${statusBadge("SIMULATED")} <b style="color:${lastTrade.type === "BUY" ? "#00ff99" : "#ff4d6d"}">${esc(lastTrade.type)}</b> ${esc(lastTrade.symbol)} <span style="color:#5a6674;font-size:10px">${esc(lastTrade.time || "")}</span></span>` : `<span class="brain-chip" style="color:#5a6674">sin trades paper recientes</span>`}
          ${lastDec ? `<span class="brain-chip"><span style="color:#5a6674;font-size:10px">decisión:</span> ${esc(String(lastDec.title || lastDec.action || lastDec.type || "registro").slice(0, 50))}</span>` : ""}
          <span style="font-size:11px;color:#5a6674">${b.warnings.length} aviso(s) → <a href="#action-center" style="color:#ffd35c;text-decoration:none;font-weight:900">Action Center</a></span>
        </div>
      </div>
      <div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px">
          ${ready("Health", b.readiness.health)}${ready("Trading", b.readiness.trading)}${ready("Study", b.readiness.study)}${ready("Social", b.readiness.social)}
        </div>
        <div style="border:1px solid rgba(120,160,210,.12);border-radius:14px;padding:10px 12px;background:rgba(255,255,255,.03)">
          <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:5px">Memoria</div>
          <div style="font-size:12px;color:#c8d8f0;line-height:1.4">${esc(b.memory.summary)}</div>
          <div style="font-size:10px;color:#5a6674;margin-top:5px">Journal ${b.memory.journalEntries} · notas ${b.memory.quickNotes} · mood ${esc(b.memory.topMood || "—")}</div>
        </div>
        ${settings.defensiveMode ? `<div style="margin-top:8px;border:1px solid rgba(255,77,109,.3);border-radius:12px;padding:8px 10px;font-size:11px;font-weight:900;color:#ff4d6d;background:rgba(255,77,109,.07)">MODO DEFENSIVO ACTIVO (manual · educativo)</div>` : ""}
      </div>
    </div>
  </div>`;
}

function renderTodayFeed() {
  const feed = buildTodayFeed();
  const typeMeta = {
    health: { icon: "◉", color: "#f472b6" }, portfolio: { icon: "◈", color: "#3b9dff" },
    journal: { icon: "◇", color: "#818cf8" }, news: { icon: "◆", color: "#00ff99" },
    decision: { icon: "✓", color: "#ffd35c" }, automation: { icon: "⚙", color: "#fb923c" },
    alert: { icon: "!", color: "#ff4d6d" }, autopilot: { icon: "⊕", color: "#a78bfa" }
  };
  const fmtTime = ts => new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  const fmtDay = ts => new Date(ts).toDateString() === new Date().toDateString() ? "hoy" : "ayer";
  return `<div class="panel" id="today-feed" style="max-width:1280px;margin:0 auto 16px;padding:18px 22px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#3b9dff">◷ Today Feed</div>
      <div style="font-size:11px;color:#5a6674">${feed.count} eventos · 36h</div>
    </div>
    ${feed.count === 0 ? `<div class="muted" style="font-size:13px">— Sin eventos registrados aún. Los eventos aparecen conforme llegan datos reales.</div>` : `
    <div style="display:flex;flex-direction:column;gap:0;max-height:420px;overflow-y:auto">
      ${feed.items.map(i => { const m = typeMeta[i.type] || { icon: "·", color: "#9fb3c8" }; return `
      <div style="display:grid;grid-template-columns:54px 26px 1fr auto;gap:8px;align-items:start;padding:8px 4px;border-bottom:1px solid rgba(120,160,210,.07)">
        <div style="font-size:11px;color:#5a6674;padding-top:2px">${fmtTime(i.ts)}<div style="font-size:9px">${fmtDay(i.ts)}</div></div>
        <div style="color:${m.color};font-weight:900;text-align:center">${m.icon}</div>
        <div><div style="font-size:13px;font-weight:700;color:#dbeafe;line-height:1.3">${esc(i.title)}</div>
        ${i.detail ? `<div style="font-size:11px;color:#9fb3c8;margin-top:2px">${esc(i.detail)}</div>` : ""}</div>
        <div style="padding-top:2px">${statusBadge(i.status)}</div>
      </div>`; }).join("")}
    </div>`}
  </div>`;
}

function renderAutomationsPanel() {
  const st = getAutomationState();
  return `<div class="panel" id="automations-panel" style="max-width:1280px;margin:0 auto 16px;padding:18px 22px;border-color:rgba(251,146,60,.18)">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#fb923c">⚙ Automations · Reglas locales</div>
      <div style="font-size:10px;color:#5a6674">Solo alertas educativas — nunca órdenes reales</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px">
      ${st.rules.map(r => `<div style="border:1px solid ${r.fired ? "rgba(251,146,60,.35)" : "rgba(120,160,210,.1)"};border-radius:14px;padding:12px 14px;background:${r.fired ? "rgba(251,146,60,.06)" : "rgba(255,255,255,.025)"}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:5px">
          <div style="font-size:12px;font-weight:900;color:${r.fired ? "#fb923c" : "#9fb3c8"}">${esc(r.name)}</div>
          <span style="font-size:9px;font-weight:900;border-radius:99px;padding:2px 8px;background:${r.fired ? "rgba(251,146,60,.15)" : "rgba(120,160,210,.08)"};color:${r.fired ? "#fb923c" : "#5a6674"}">${r.fired ? "ACTIVA" : "OK"}</span>
        </div>
        ${r.fired && r.message ? `<div style="font-size:11px;color:#c8d8f0;line-height:1.4">${esc(r.message)}</div>` : `<div style="font-size:11px;color:#5a6674">Condición no cumplida hoy.</div>`}
        ${r.suggestedMode ? `<div style="font-size:10px;color:#9fb3c8;margin-top:5px">Sugiere: <b>${esc(r.suggestedMode)}</b></div>` : ""}
      </div>`).join("")}
    </div>
  </div>`;
}

function renderHomePortal(pv, reg) {
  const h = computeHealthReadiness();
  const jd = computeJournalData();
  const nl = computeDailyNewsletter();
  const ctx = alfredoDailyContext(h, pv, reg);
  const bbva = (pv.assets || []).find(a => a.symbol === "BBVA");
  const modules = [
    { id: "trading", label: "Cordelius Trading", emoji: "◈", color: "#3b9dff", sub: `${money(pv.totalValueMXN)} · ${pct(pv.totalGainPct)}`, desc: "Portafolio · BBVA · riesgo · paper" },
    { id: "health", label: "Cordelius Health", emoji: "◉", color: "#f472b6", sub: `${h.operatingMode || "NORMAL"} · WHOOP ${h.configured ? "OK" : "—"}`, desc: "Recovery · Sleep · Strain · HRV" },
    { id: "journal", label: "Cordelius Journal", emoji: "◎", color: "#818cf8", sub: `${jd.count} entradas`, desc: "Diario · memoria · correlaciones" },
    { id: "intelligence", label: "Cordelius Intelligence", emoji: "◆", color: "#00ff99", sub: `${news.length} noticias · ${intelItems.length} intel`, desc: "Noticias · Quiver · contexto" },
    { id: "alfredo", label: "Jarvis", emoji: "AI", color: "#ffd35c", sub: "Jarvis personal", desc: "Preguntas · acciones · memoria" }
  ];
  const cards = [
    { label: "Portfolio", value: money(pv.totalValueMXN), sub: pct(pv.totalGainPct), color: pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d" },
    { label: "Daily P&L", value: money(pv.totalGainMXN), sub: "global", color: pv.totalGainMXN >= 0 ? "#00ff99" : "#ff4d6d" },
    { label: "BBVA", value: bbva ? `${bbva.score}/100` : "—", sub: bbva ? pct(bbva.gainPct) : "sin dato", color: "#3b9dff" },
    { label: "Recovery", value: h.recovery !== null ? h.recovery + "%" : "—", sub: "WHOOP", color: "#f472b6", id: "home-recovery" },
    { label: "Sleep", value: h.sleep !== null ? h.sleep + "%" : "—", sub: "WHOOP", color: "#f472b6", id: "home-sleep" },
    { label: "Strain", value: h.strain !== null ? String(h.strain) : "—", sub: "today", color: "#ffd35c", id: "home-strain" },
    { label: "HRV", value: h.hrv !== null ? h.hrv + " ms" : "—", sub: "recovery", color: "#00ff99", id: "home-hrv" },
    { label: "Journal", value: jd.count ? String(jd.count) : "—", sub: jd.topMood || "sin mood", color: "#818cf8" }
  ];

  const greetHour = new Date().getHours();
  const greet = greetHour < 12 ? "Buenos días" : greetHour < 19 ? "Buenas tardes" : "Buenas noches";
  const days = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const dayName = days[new Date().getDay()];
  const modeColor = {"ÓPTIMO":"#818cf8","NORMAL":"#00ff99","CONSERVADOR":"#ffd35c","BAJO":"#ffd35c","DEFENSIVO":"#ff4d6d"}[h.operatingMode] || "#9fb3c8";
  return `<div style="max-width:1280px;margin:0 auto">
    <div style="padding:28px 0 14px;display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:10px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#9fb3c8;margin-bottom:4px">CORDELIUS PERSONAL OS · ${esc(dayName.toUpperCase())}</div>
        <div style="font-size:32px;font-weight:900;background:linear-gradient(90deg,#ffd35c,#fff,#3b9dff);-webkit-background-clip:text;-webkit-text-fill-color:transparent">${greet}, Pedro</div>
        <div style="color:#9fb3c8;font-size:13px;margin-top:4px">${esc(nl.date)} · ${esc(nowMX())}</div>
      </div>
      <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
        <span style="border-radius:99px;padding:4px 12px;font-size:11px;font-weight:900;background:rgba(0,255,153,.1);color:#00ff99;border:1px solid rgba(0,255,153,.2)">Servidor ON</span>
        <span style="border-radius:99px;padding:4px 12px;font-size:11px;font-weight:900;background:rgba(255,77,109,.08);color:#ff4d6d;border:1px solid rgba(255,77,109,.2)">Real Trading OFF</span>
        <span style="border-radius:99px;padding:4px 12px;font-size:11px;font-weight:900;background:${modeColor}12;color:${modeColor};border:1px solid ${modeColor}25">${esc(h.operatingMode)}</span>
      </div>
    </div>

    <!-- Quick stats strip -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:20px">
      <div style="background:rgba(59,157,255,.06);border:1px solid rgba(59,157,255,.15);border-radius:16px;padding:14px 16px;cursor:pointer" onclick="showMod('trading')">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#3b9dff;margin-bottom:4px">Portafolio</div>
        <div style="font-size:20px;font-weight:900;color:#eaf6ff">${esc(money(pv.totalValueMXN))}</div>
        <div style="font-size:12px;color:${pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d"};margin-top:2px">${esc(pct(pv.totalGainPct))}</div>
      </div>
      <div style="background:rgba(244,114,182,.05);border:1px solid rgba(244,114,182,.14);border-radius:16px;padding:14px 16px;cursor:pointer" onclick="showMod('health')">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#f472b6;margin-bottom:4px">Health</div>
        <div style="font-size:16px;font-weight:900;color:${modeColor}">${esc(h.operatingMode)}</div>
        <div style="font-size:11px;color:#9fb3c8;margin-top:2px">${h.configured ? (h.recovery !== null ? "R " + h.recovery + "% · " : "") + "WHOOP" : "Sin WHOOP"}</div>
      </div>
      <div style="background:rgba(0,255,153,.04);border:1px solid rgba(0,255,153,.11);border-radius:16px;padding:14px 16px;cursor:pointer" onclick="showMod('intelligence')">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#00ff99;margin-bottom:4px">Intelligence</div>
        <div style="font-size:20px;font-weight:900;color:#00ff99">${news.length}</div>
        <div style="font-size:11px;color:#9fb3c8;margin-top:2px">Intel: ${intelItems.length}</div>
      </div>
      <div style="background:rgba(167,139,250,.05);border:1px solid rgba(167,139,250,.13);border-radius:16px;padding:14px 16px;cursor:pointer" onclick="showMod('autopilot')">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#a78bfa;margin-bottom:4px">Autopilot</div>
        <div style="font-size:20px;font-weight:900;color:#a78bfa">ON</div>
        <div style="font-size:11px;color:#9fb3c8;margin-top:2px">Paper · ${quiverData.configured ? "Quiver ON" : "Quiver —"}</div>
      </div>
    </div>

    <!-- 5 Module cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px">
      ${modules.map(m => `<div onclick="showMod('${m.id}')" style="cursor:pointer;background:var(--panel);border:1px solid ${m.color}28;border-radius:22px;padding:20px 22px;transition:.2s;position:relative;overflow:hidden" onmouseover="this.style.borderColor='${m.color}70'" onmouseout="this.style.borderColor='${m.color}28'">
        <div style="position:absolute;top:0;right:0;width:80px;height:80px;background:radial-gradient(circle,${m.color}12,transparent 70%);border-radius:50%"></div>
        <div style="font-size:24px;margin-bottom:10px;color:${m.color}">${m.emoji}</div>
        <div style="font-size:13px;font-weight:900;color:${m.color};letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">${esc(m.label)}</div>
        <div style="font-size:22px;font-weight:900;color:#eaf6ff;margin-bottom:6px;line-height:1.1">${esc(m.sub)}</div>
        <div style="font-size:11px;color:#9fb3c8;margin-bottom:12px">${esc(m.desc)}</div>
        <div style="display:inline-flex;align-items:center;gap:6px;border:1px solid ${m.color}40;border-radius:99px;padding:5px 12px;font-size:12px;font-weight:900;color:${m.color}">Entrar →</div>
      </div>`).join("")}
    </div>

    <!-- Mini daily brief -->
    <div style="margin-bottom:16px">
      <div class="panel" style="border:1px solid rgba(59,157,255,.18);background:rgba(59,157,255,.04);padding:16px 20px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#3b9dff;margin-bottom:8px">Daily Brief</div>
        <div style="font-size:15px;font-weight:700;color:#dbeafe;margin-bottom:10px">${esc(nl.greeting)}</div>
        <ul style="margin:0;padding-left:16px;list-style:disc">
          ${nl.lines.slice(0, 3).map(l => `<li style="font-size:13px;color:#c8d8f0;margin-bottom:4px">${esc(l)}</li>`).join("")}
        </ul>

      </div>
    </div>

    ${renderTodayFeed()}

    <div style="font-size:11px;color:#5a6674;margin-bottom:16px">Métricas en vivo → <a href="#jarvis-brain" style="color:#00ff99;text-decoration:none;font-weight:900">Brain ↑</a> · preguntas y acciones → <a href="#action-center" style="color:#ffd35c;text-decoration:none;font-weight:900">Action Center ↑</a> — un solo lugar, sin repetición.</div>
  </div>`;
}

function renderJournalModule() {
  const jd = computeJournalData();
  const aj = computeAutoJournal();
  const h = computeHealthReadiness();
  const moodColors = { positivo:"#00ff99", negativo:"#ff4d6d", neutral:"#ffd35c", reflexivo:"#818cf8", ansioso:"#f59e0b", motivado:"#3b9dff", "low-strain":"#f472b6", caution:"#ff4d6d" };
  const moodOpts = ["positivo","neutral","negativo","reflexivo","motivado","ansioso"];
  const entriesHtml = jd.recent.length ? jd.recent.map(e => {
    const mc = moodColors[e.mood] || "#9fb3c8";
    return `<div style="border:1px solid rgba(120,160,210,.12);background:rgba(255,255,255,.03);border-radius:16px;padding:14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${mc}">${esc(e.mood||"neutral")}</span>
        ${e.energy ? `<span style="font-size:11px;color:#9fb3c8">Energía: ${"▪".repeat(e.energy)}${"·".repeat(5-(e.energy||0))}</span>` : ""}
        <span class="muted" style="font-size:11px;margin-left:auto">${esc(e.date||"")}</span>
      </div>
      <div style="color:#dbeafe;font-size:14px;line-height:1.6">${esc((e.text||"").slice(0,300))}${(e.text||"").length > 300 ? "…" : ""}</div>
      ${e.tags && e.tags.length ? `<div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap">${e.tags.map(t=>`<span style="font-size:11px;background:rgba(129,140,248,.12);color:#818cf8;border-radius:99px;padding:2px 9px">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("") : `<div class="muted" style="padding:20px 0;text-align:center">Sin notas manuales todavía — el journal automático está activo arriba.</div>`;

  const autoColor = moodColors[aj.moodEstimated] || "#ffd35c";

  return `<div style="max-width:1280px;margin:0 auto">
    <div style="padding:20px 0 14px">
      <div style="font-size:10px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#818cf8;margin-bottom:4px">Cordelius Journal</div>
      <div style="font-size:26px;font-weight:900;color:#eaf6ff">Journal automático</div>
      <div class="muted" style="font-size:13px;margin-top:3px">Basado en WHOOP + snapshots locales · privado · no enviado a terceros</div>
    </div>


    <div id="journal-auto-preview" class="panel" style="border:1px solid rgba(129,140,248,.18);background:rgba(129,140,248,.035);padding:16px 18px;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div>
          <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#818cf8">Auto Journal · /api/journal/auto</div>
          <div class="muted" style="font-size:12px;margin-top:2px">Bitácora diaria generada con WHOOP, mercado y Jarvis.</div>
        </div>
        <span id="journal-auto-source" style="font-size:11px;color:#9fb3c8;border:1px solid rgba(129,140,248,.2);border-radius:999px;padding:4px 10px">cargando</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin-bottom:12px">
        <div class="card" style="padding:12px"><div class="label">Mood</div><div id="journal-auto-mood" class="big" style="font-size:20px;color:#818cf8">—</div></div>
        <div class="card" style="padding:12px"><div class="label">Body state</div><div id="journal-auto-body" class="big" style="font-size:20px;color:#f472b6">—</div></div>
        <div class="card" style="padding:12px"><div class="label">Trading mode</div><div id="journal-auto-trading-mode" class="big" style="font-size:20px;color:#ffd35c">—</div></div>
        <div class="card" style="padding:12px"><div class="label">WHOOP summary</div><div id="journal-auto-whoop" class="big" style="font-size:20px;color:#00ff99">—</div></div>
      </div>
      <div id="journal-auto-note" style="border:1px solid rgba(129,140,248,.12);border-radius:12px;background:rgba(0,0,0,.18);padding:10px 12px;color:#dbeafe;font-size:13px">Cargando bitácora automática...</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px">
      <!-- Write form -->
      <div class="panel" style="border:1px solid rgba(129,140,248,.2);background:rgba(129,140,248,.04);padding:18px 20px">
        <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#818cf8;margin-bottom:12px">Nueva entrada</div>
        <form method="POST" action="/api/journal" onsubmit="event.preventDefault();cordeliusFormPost(this,'/')">
          <textarea name="text" rows="5" placeholder="¿Cómo te sientes hoy? ¿Qué pasó? ¿Qué aprendiste?" style="width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:12px;padding:12px;color:#eaf6ff;font-size:14px;resize:vertical;font-family:inherit"></textarea>
          <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap">
            <select name="mood" style="background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px">
              ${moodOpts.map(m => `<option value="${m}">${m}</option>`).join("")}
            </select>
            <select name="energy" style="background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px">
              <option value="">Energía</option>
              ${[1,2,3,4,5].map(n => `<option value="${n}">${n}/5</option>`).join("")}
            </select>
            <input name="tags" placeholder="tags: trading, salud..." style="flex:1;background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px">
          </div>
          <button type="submit" class="btn" style="background:rgba(129,140,248,.15);border-color:rgba(129,140,248,.3);color:#818cf8;font-size:14px;padding:10px 20px;width:100%">Guardar entrada</button>
        </form>
      </div>

      <!-- Stats -->
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="panel" style="padding:14px 18px">
          <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:8px">Resumen</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div style="text-align:center"><div style="font-size:26px;font-weight:900;color:#818cf8">${jd.count}</div><div class="muted" style="font-size:11px">entradas</div></div>
            <div style="text-align:center"><div style="font-size:26px;font-weight:900;color:${moodColors[jd.topMood]||"#9fb3c8"}">${jd.topMood||"—"}</div><div class="muted" style="font-size:11px">mood frecuente</div></div>
          </div>
        </div>
        <div class="panel" style="padding:14px 18px;flex:1">
          <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:8px">Pregunta a Jarvis</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${["resume mi diario","cómo me he sentido","qué patrones ves"].map(q =>
              `<button onclick="setJarvisQ('${q}')" class="btn" style="font-size:12px;padding:6px 12px;text-align:left;color:#818cf8;border-color:rgba(129,140,248,.25)">${q}</button>`
            ).join("")}
          </div>
        </div>

      </div>
    </div>

    <div class="panel" style="padding:14px 18px;margin-bottom:18px;border:1px solid rgba(129,140,248,.15);background:rgba(129,140,248,.04)">
      <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#818cf8;margin-bottom:6px">Nota Alfredo</div>
      <div style="font-size:13px;color:#c8d8f0;line-height:1.6">${esc(aj.alfredoNote)}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        ${["resumen de mi día","cómo me he sentido","resume mi diario"].map(q =>
          `<button onclick="setJarvisQ('${q}')" class="btn" style="font-size:12px;padding:6px 12px;color:#818cf8;border-color:rgba(129,140,248,.25)">${q}</button>`
        ).join("")}
      </div>
    </div>

    <!-- NOTA MANUAL OPCIONAL -->
    <details style="margin-bottom:18px">
      <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:12px 18px;background:rgba(129,140,248,.06);border:1px solid rgba(129,140,248,.15);border-radius:16px;user-select:none">
        <span style="font-size:13px;font-weight:700;color:#818cf8">◎ Nota manual opcional</span>
        <span class="muted" style="font-size:12px">${jd.count} entradas guardadas ▾</span>
      </summary>
      <div style="padding:16px 0">
        <div class="panel" style="padding:18px 20px;border:1px solid rgba(129,140,248,.2);background:rgba(129,140,248,.04)">
          <form method="POST" action="/api/journal" onsubmit="event.preventDefault();cordeliusFormPost(this,'/')">
            <textarea name="text" rows="4" placeholder="¿Algo extra que quieras anotar hoy?" style="width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:12px;padding:12px;color:#eaf6ff;font-size:14px;resize:vertical;font-family:inherit"></textarea>
            <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap">
              <select name="mood" style="background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px">
                ${moodOpts.map(m => `<option value="${m}">${m}</option>`).join("")}
              </select>
              <select name="energy" style="background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px">
                <option value="">Energía</option>
                ${[1,2,3,4,5].map(n => `<option value="${n}">${n}/5</option>`).join("")}
              </select>
              <input name="tags" placeholder="tags..." style="flex:1;background:rgba(0,0,0,.3);border:1px solid rgba(129,140,248,.2);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px">
            </div>
            <button type="submit" class="btn" style="background:rgba(129,140,248,.15);border-color:rgba(129,140,248,.3);color:#818cf8;font-size:14px;padding:10px 20px">Guardar</button>
          </form>
        </div>
        <div style="margin-top:14px">
          <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:10px">Entradas recientes</div>
          ${entriesHtml}
        </div>
        <div class="muted" style="font-size:11px;margin-top:8px;text-align:center">Guardado en ${esc(JOURNAL_FILE)} · solo en este dispositivo</div>
      </div>
    </details>

    <div class="muted" style="font-size:11px">Fuente: ${esc(aj.source)} · ${esc(aj.educationalNote)}</div>
  </div>`;
}

function renderSignalCenter(pv, reg) {
  const assets = pv.assets;
  const cripto = assets.filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0);
  const criptoPct = pv.totalValueMXN > 0 ? (cripto / pv.totalValueMXN * 100) : 0;
  const ranked = assets.slice().sort((a, b) => b.score - a.score);
  const external = computeExternalMarketIntelligence();
  const scan = computeDailyScan();

  // Assign priority
  const withPriority = assets.map(a => {
    const isHighRisk = a.score < 35 || a.risk === "ALTO" || a.gainPct < -20;
    const isCryptoConc = a.type === "crypto" && criptoPct > 50;
    const priority = (isHighRisk || isCryptoConc) ? "ALTA" :
      (a.score >= 35 && a.score <= 60) ? "MEDIA" : "BAJA";
    const qCount = quiverData.congressional.filter(x => x.symbol === a.symbol).length
                 + quiverData.insider.filter(x => x.symbol === a.symbol).length;
    const bullish = a.score >= 65 && a.ind.momentum >= 0;
    const bearish = a.score < 35 || (a.gainPct < -15 && a.risk === "ALTO");
    const sigLabel = bullish ? "Bullish" : bearish ? "Risk/Vigilar" : "Neutral";
    const eduAction = a.gainPct > 80 && a.score > 55 ? "Tomar ganancia parcial (hipotético)" :
      a.score < 30 ? "No promediar — revisar tesis" :
      a.signal.includes("BUY") ? "Vigilar entrada educativa" : "Mantener y monitorear";
    const motivo = a.risk === "ALTO" ? "Riesgo alto" :
      a.gainPct < -20 ? "Caída fuerte" :
      a.score >= 65 ? "Score sólido" :
      a.type === "crypto" ? "Cripto volatil" : "Score neutro";
    return { ...a, priority, sigLabel, eduAction, motivo, qCount };
  }).sort((a, b) => {
    const p = { ALTA: 0, MEDIA: 1, BAJA: 2 };
    return (p[a.priority] - p[b.priority]) || b.score - a.score;
  });

  const alertAsset = withPriority.find(a => a.priority === "ALTA") || withPriority[0];
  const bestOpp = ranked[0];
  const prioColor = { ALTA: "#ff4d6d", MEDIA: "#ffd35c", BAJA: "#00ff99" };

  const hotExternal = external.hot ? external.hot.slice(0, 3).map(t => `${t.symbol} (${t.sector})`).join(", ") : "—";
  const scanAlerts = scan.alerts ? scan.alerts.slice(0, 3) : [];

  const rows = withPriority.map(a => `<tr>
    <td><b>${esc(a.symbol)}</b>${a.qCount > 0 ? `<span style="color:#00ff99;font-size:10px;margin-left:4px">Q${a.qCount}</span>` : ""}</td>
    <td class="muted" style="font-size:12px">${esc(a.source)}</td>
    <td><b>${a.score}</b>/100</td>
    <td><b class="${a.risk === "ALTO" ? "red" : a.risk === "BAJO" ? "green" : "yellow"}">${esc(a.risk)}</b></td>
    <td style="font-size:12px;color:${a.sigLabel === "Bullish" ? "#00ff99" : a.sigLabel === "Risk/Vigilar" ? "#ff4d6d" : "#ffd35c"}">${esc(a.sigLabel)}</td>
    <td class="muted" style="font-size:12px">${esc(a.motivo)}</td>
    <td class="muted" style="font-size:11px">${esc(a.eduAction)}</td>
    <td><span style="background:${prioColor[a.priority]}22;color:${prioColor[a.priority]};border-radius:99px;padding:3px 9px;font-size:11px;font-weight:900">${esc(a.priority)}</span></td>
  </tr>`).join("");

  return `<div style="max-width:1280px;margin:0 auto 8px">
    <h2>Centro de Señales Alfredo</h2>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <div class="card" style="padding:12px 18px;flex:1;min-width:200px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#ff4d6d;margin-bottom:4px">Vigilar primero</div>
        <div style="font-size:18px;font-weight:900;color:#eaf6ff">${esc(alertAsset ? alertAsset.symbol : "—")}</div>
        <div class="muted" style="font-size:11px">${alertAsset ? esc(alertAsset.motivo) + " · score " + alertAsset.score : "—"}</div>
      </div>
      <div class="card" style="padding:12px 18px;flex:1;min-width:200px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#00ff99;margin-bottom:4px">Mejor oportunidad educativa</div>
        <div style="font-size:18px;font-weight:900;color:#eaf6ff">${esc(bestOpp ? bestOpp.symbol : "—")}</div>
        <div class="muted" style="font-size:11px">${bestOpp ? "Score " + bestOpp.score + " · " + esc(bestOpp.signal) : "—"}</div>
      </div>
      <div class="card" style="padding:12px 18px;flex:1;min-width:180px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#f59e0b;margin-bottom:4px">Concentración cripto</div>
        <div style="font-size:18px;font-weight:900;color:${criptoPct > 45 ? "#ff4d6d" : "#ffd35c"}">${criptoPct.toFixed(1)}%</div>
        <div class="muted" style="font-size:11px">${criptoPct > 50 ? "⚠ Concentración alta" : criptoPct > 35 ? "Revisar balance" : "Bajo control"}</div>
      </div>
      <div class="card" style="padding:12px 18px;flex:1;min-width:160px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:${reg.color};margin-bottom:4px">Régimen</div>
        <div style="font-size:18px;font-weight:900;color:${reg.color}">${esc(reg.label)}</div>
        <div class="muted" style="font-size:11px">${pct(reg.avg)} promedio</div>
      </div>
    </div>
    ${scanAlerts.length ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${scanAlerts.map(al => `<span style="background:rgba(255,77,109,.1);color:#ff4d6d;border:1px solid rgba(255,77,109,.25);border-radius:99px;padding:4px 12px;font-size:12px;font-weight:700">⚑ ${esc(al)}</span>`).join("")}</div>` : ""}
    ${hotExternal !== "—" ? `<div style="margin-bottom:12px;font-size:12px;color:#9fb3c8">Externos calientes: <b style="color:#3b9dff">${esc(hotExternal)}</b></div>` : ""}
    <div class="table-wrap panel" style="padding:0">
      <table>
        <thead><tr><th>Activo</th><th>Broker</th><th>Score</th><th>Riesgo</th><th>Señal</th><th>Motivo</th><th>Acción educativa</th><th>Prioridad</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="muted" style="font-size:11px;margin-top:8px;text-align:right">Educativo · no es asesoría financiera · Q = señal Quiver</div>
  </div>`;
}

function renderStockResearch() {
  const watchChips = ["AAPL","NVDA","MSFT","META","GOOGL","PLTR","XRP","BTC","AMZN","TSLA"];
  return `<div class="panel" style="max-width:1280px;margin:0 auto 12px;padding:20px 24px;border:1px solid rgba(59,157,255,.14)">
    <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#3b9dff;margin-bottom:10px">Stock Research · Análisis de tickers</div>
    <div style="font-size:13px;color:#9fb3c8;margin-bottom:14px">Investiga cualquier ticker — perfil, señales Quiver, noticias y tesis educativa. Powered by Alfredo AI.</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <input id="research-ticker" type="text" placeholder="Ej: AAPL, NVDA, META…" autocomplete="off" autocapitalize="characters"
        style="flex:1;min-width:160px;border:1px solid rgba(59,157,255,.3);border-radius:12px;padding:11px 16px;color:#fff;background:rgba(59,157,255,.05);font-size:15px;font-family:inherit"
        onkeydown="if(event.key==='Enter')researchTicker()">
      <button onclick="researchTicker()" class="btn" style="border-color:rgba(59,157,255,.4);color:#3b9dff;font-size:14px;padding:11px 22px">Investigar →</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
      ${watchChips.map(t => `<button onclick="document.getElementById('research-ticker').value='${t}';researchTicker()" style="border:1px solid rgba(120,160,210,.18);background:rgba(255,255,255,.04);color:#9fb3c8;border-radius:9px;padding:4px 11px;font-size:12px;cursor:pointer;font-weight:700;font-family:inherit">${esc(t)}</button>`).join("")}
    </div>
    <div id="research-result"></div>
  </div>`;
}


function renderCordeliusIntelligenceFeedPreview() {
  const now = Date.now();
  const liveNews = news.slice(0, 4).map(n => {
    const publishedMs = n.datetime ? Number(n.datetime) * 1000 : now;
    return {
      ticker: (n.related || n.symbol || "MARKET").toString().toUpperCase(),
      source: n.source || "news",
      publishedDate: new Date(publishedMs).toISOString().slice(0, 10),
      type: "news",
      sentiment: "uncertain",
      summary: (n.summary || n.headline || "Noticia sin resumen").toString().slice(0, 130),
      delayBadge: Math.max(0, Math.round((now - publishedMs) / 86400000)) <= 7 ? "1-7d" : "stale"
    };
  });
  const manual = intelItems.slice(0, 2).map(i => ({
    ticker: (i.symbols && i.symbols[0]) || "CONTEXT",
    source: "manual",
    publishedDate: (i.date || nowMX()).toString().slice(0, 10),
    type: "health/context",
    sentiment: "uncertain",
    summary: i.summary || i.text || "Contexto manual pendiente de resumen.",
    delayBadge: "local"
  }));
  const items = liveNews.concat(manual).slice(0, 5);
  const rows = items.length ? items.map(x => `<div style="display:grid;grid-template-columns:86px 92px 1fr 70px;gap:8px;align-items:center;border-top:1px solid rgba(120,160,210,.08);padding:9px 0">
      <div style="font-weight:900;color:#eaf6ff;font-size:12px">${esc(x.ticker)}</div>
      <div class="muted" style="font-size:11px">${esc(x.publishedDate)}</div>
      <div style="min-width:0"><div style="font-size:12px;color:#dbeafe;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.summary)}</div><div class="muted" style="font-size:10px">${esc(x.source)} · ${esc(x.type)} · ${esc(x.sentiment)}</div></div>
      <div style="text-align:right"><span style="border:1px solid rgba(0,255,153,.2);border-radius:999px;padding:3px 7px;color:#00ff99;font-size:10px">${esc(x.delayBadge)}</span></div>
    </div>`).join("") : `<div class="muted" style="padding:14px 0">Pendiente de proveedor de noticias. No se inventan noticias reales.</div>`;
  return `<div class="panel" style="max-width:1280px;margin:0 auto 14px;border:1px solid rgba(0,255,153,.14);background:rgba(0,255,153,.035);padding:16px 18px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <div>
        <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#00ff99">Cordelius Intelligence Feed</div>
        <div class="muted" style="font-size:12px;margin-top:2px">Mercado · insiders · noticias · salud/contexto, siempre con fecha visible.</div>
      </div>
      <span style="font-size:11px;color:#9fb3c8;border:1px solid rgba(0,255,153,.18);border-radius:999px;padding:4px 10px">educativo · no señal</span>
    </div>
    <div id="intelligence-feed-list">${rows}</div>
    <div class="muted" style="font-size:11px;margin-top:10px">Si no hay proveedor activo, se muestran placeholders honestos y contexto local.</div>
  </div>`;
}


function renderHealthOSPanel() {
  const h = computeHealthReadiness();
  return `<section class="health-os-shell">
    <style>
      .health-os-shell{max-width:1440px;margin:0 auto 28px;padding:22px;border-radius:34px;background:radial-gradient(circle at 16% 0%,rgba(244,114,182,.22),transparent 35%),radial-gradient(circle at 88% 12%,rgba(59,157,255,.2),transparent 34%),linear-gradient(135deg,rgba(4,10,22,.96),rgba(9,17,32,.9));border:1px solid rgba(244,114,182,.18);box-shadow:0 24px 80px rgba(0,0,0,.42)}
      .health-os-hero{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:18px;margin-bottom:18px}.health-os-card{border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.055);backdrop-filter:blur(16px);border-radius:26px;padding:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
      .health-os-title{font-size:42px;font-weight:950;letter-spacing:-.05em;line-height:.95;margin:0;color:#fff}.health-os-sub{color:#f9a8d4;font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin-bottom:10px}.health-os-badge{display:inline-flex;border:1px solid rgba(0,255,153,.25);background:rgba(0,255,153,.09);color:#00ff99;border-radius:999px;padding:5px 11px;font-size:11px;font-weight:950;letter-spacing:.08em}.health-os-badge.fallback{border-color:rgba(255,211,92,.35);background:rgba(255,211,92,.09);color:#ffd35c}.health-os-reconnect{display:inline-flex;border:1px solid rgba(255,211,92,.3);background:rgba(255,211,92,.06);color:#ffd35c;border-radius:999px;padding:5px 11px;font-size:11px;font-weight:900;text-decoration:none;letter-spacing:.05em}
      .health-os-metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px;margin-top:18px}.health-os-metric{border:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.18);border-radius:18px;padding:13px}.health-os-label{font-size:10px;text-transform:uppercase;letter-spacing:.13em;color:#9fb3c8;font-weight:900}.health-os-value{font-size:26px;font-weight:950;color:#fff;margin-top:4px}.health-os-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.health-os-span-4{grid-column:span 4}.health-os-span-6{grid-column:span 6}.health-os-span-8{grid-column:span 8}.health-os-span-12{grid-column:span 12}.health-os-donut-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.health-os-donut{min-height:220px;display:grid;place-items:center;text-align:center}.health-os-ai{font-size:15px;line-height:1.75;color:#eaf6ff}.health-os-chip{border:1px solid rgba(244,114,182,.24);background:rgba(244,114,182,.08);color:#f9a8d4;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:900;cursor:pointer}.health-os-chip.active{background:rgba(0,255,153,.13);border-color:rgba(0,255,153,.35);color:#00ff99}.health-os-mini-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.health-os-risk{border-left:3px solid #ffd35c;padding-left:12px;color:#dbeafe;line-height:1.55}.health-os-disclaimer{color:#9fb3c8;font-size:12px;text-align:center;margin-top:16px}.health-os-history-row{display:grid;grid-template-columns:110px 1fr 80px;gap:8px;align-items:center;margin:9px 0}.health-os-trend{height:42px;border-radius:12px;background:rgba(0,0,0,.18);overflow:hidden}
      @media(max-width:900px){.health-os-shell{padding:14px;border-radius:24px}.health-os-hero{grid-template-columns:1fr}.health-os-title{font-size:34px}.health-os-grid{display:block}.health-os-card{margin-bottom:12px}.health-os-donut-row{grid-template-columns:1fr}.health-os-value{font-size:22px}}
    </style>
    <div class="health-os-hero"><div class="health-os-card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap"><div><div class="health-os-sub">Cordelius Health</div><h2 class="health-os-title">WHOOP-first readiness</h2><div class="muted" style="margin-top:10px">Última actualización: <span id="health-os-updated">—</span></div></div><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span id="health-os-whoop-badge" class="health-os-badge${h.connected ? "" : " fallback"}">${h.connected ? "WHOOP LIVE" : "WHOOP FALLBACK"}</span><a id="health-os-reconnect" class="health-os-reconnect" href="/whoop/auth" style="display:${h.connected ? "none" : "inline-flex"}">Reconectar WHOOP ↗</a></div></div><div class="health-os-metric-grid"><div class="health-os-metric"><div class="health-os-label">Recovery</div><div id="health-os-recovery" class="health-os-value">—</div></div><div class="health-os-metric"><div class="health-os-label">Sleep</div><div id="health-os-sleep" class="health-os-value">—</div></div><div class="health-os-metric"><div class="health-os-label">Strain</div><div id="health-os-strain" class="health-os-value">—</div></div><div class="health-os-metric"><div class="health-os-label">HRV</div><div id="health-os-hrv" class="health-os-value">—</div></div><div class="health-os-metric"><div class="health-os-label">RHR</div><div id="health-os-rhr" class="health-os-value">—</div></div><div class="health-os-metric"><div class="health-os-label">Readiness</div><div id="health-os-readiness" class="health-os-value">—</div></div><div class="health-os-metric"><div class="health-os-label">Modo</div><div id="health-os-mode" class="health-os-value">${esc(h.operatingMode || "NORMAL")}</div></div></div></div><div class="health-os-card" id="health-os-score-card"><div class="health-os-label">Health Score</div><div id="health-os-score" style="font-size:64px;font-weight:950;color:#f472b6;line-height:1">—</div><div id="health-os-status" style="font-size:18px;font-weight:950;color:#fff">—</div><div class="muted" style="margin-top:10px">Estado: EXCELENTE / BUENO / MEDIO / BAJO / CRÍTICO</div></div></div>
    <div class="health-os-grid"><div class="health-os-card health-os-span-8"><div class="health-os-sub">Main Grid</div><div class="health-os-donut-row"><div id="health-os-donut-recovery" class="health-os-donut"></div><div id="health-os-donut-sleep" class="health-os-donut"></div><div id="health-os-donut-strain" class="health-os-donut"></div></div></div><div class="health-os-card health-os-span-4"><div class="health-os-sub">Radar</div><div id="health-os-radar"></div></div><div class="health-os-card health-os-span-6"><div class="health-os-sub">Health Intelligence Scores</div><div id="health-os-score-list" class="health-os-mini-grid"></div></div><div class="health-os-card health-os-span-6"><div class="health-os-sub">Energy Engine</div><div class="health-os-mini-grid"><div><div class="health-os-label">Physical Energy</div><div id="health-os-energy-physical" class="health-os-value">—</div></div><div><div class="health-os-label">Mental Energy</div><div id="health-os-energy-mental" class="health-os-value">—</div></div><div><div class="health-os-label">Focus Capacity</div><div id="health-os-energy-focus" class="health-os-value">—</div></div><div><div class="health-os-label">Deep Work</div><div id="health-os-energy-deepwork" class="health-os-value">—</div></div><div><div class="health-os-label">Trading Capacity</div><div id="health-os-energy-trading" class="health-os-value">—</div></div></div></div><div class="health-os-card health-os-span-12"><div class="health-os-sub">Jarvis Health AI</div><div id="health-os-ai" class="health-os-ai">Cargando lectura health OS...</div></div><div class="health-os-card health-os-span-6"><div class="health-os-sub">WHOOP History</div><div id="health-os-history">Cargando tendencias...</div></div><div class="health-os-card health-os-span-6"><div class="health-os-sub">Correlation Engine</div><div id="health-os-correlations">Recolectando datos. Se activará con 3+ días de snapshots.</div></div><div class="health-os-card health-os-span-6"><div class="health-os-sub">Behavior Tracker</div><div id="health-os-behaviors" style="display:flex;gap:8px;flex-wrap:wrap"></div></div><div class="health-os-card health-os-span-6"><div class="health-os-sub">Trading Integration</div><div id="health-os-trading-risk" class="health-os-risk">Recovery &lt; 50 ⇒ DEFENSIVE / reducir riesgo educativo. Recovery &gt; 80 ⇒ NORMAL. Strain alto ⇒ bajar agresividad. Overtrading Risk alto ⇒ no operar impulsivo.</div></div></div>
    <div class="health-os-disclaimer">Educativo. No es asesoría médica ni financiera.</div>
  </section>`;
}

function renderJarvisCommandCenter(pv) {
  const h = computeHealthReadiness();
  const opp = getOpportunityState();
  const queue = loadJSON(RESEARCH_QUEUE_FILE, []);
  const activeAlerts = loadAlerts().filter(a => !a.acknowledged);
  const recovPct = h.recovery !== null ? h.recovery : null;
  const healthColor = recovPct === null ? "#9fb3c8" : recovPct >= 75 ? "#00ff99" : recovPct >= 50 ? "#ffd35c" : "#ff4d6d";
  const healthVal = h.connected ? (recovPct !== null ? `${recovPct}%` : "—") : "OFFLINE";
  const tradingColor = pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d";
  const topOpp = (opp.topOpportunities || [])[0];
  const oppColor = topOpp ? "#00ff99" : "#9fb3c8";
  const alertColor = activeAlerts.length === 0 ? "#00ff99" : activeAlerts.some(a => a.severity === "CRITICAL") ? "#ff4d6d" : "#ffd35c";
  const tile = (label, value, sub, color, mod) =>
    `<div onclick="showMod('${mod}')" style="cursor:pointer;background:${color}08;border:1px solid ${color}22;border-radius:18px;padding:16px;transition:.2s" onmouseover="this.style.borderColor='${color}55'" onmouseout="this.style.borderColor='${color}22'">
      <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:${color};margin-bottom:6px">${esc(label)}</div>
      <div style="font-size:18px;font-weight:900;color:#eaf6ff;line-height:1.1">${esc(value)}</div>
      <div style="font-size:11px;color:#9fb3c8;margin-top:4px">${esc(sub)}</div>
    </div>`;
  return `<div style="max-width:1280px;margin:0 auto 16px">
    <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c;margin-bottom:10px">Command Center · Estado del sistema</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px">
      ${tile("Health", healthVal, h.operatingMode || "NORMAL", healthColor, "health")}
      ${tile("Trading", money(pv.totalValueMXN), pct(pv.totalGainPct), tradingColor, "trading")}
      ${tile("Research", queue.length > 0 ? queue[0] : "Cola vacía", `${queue.length} en cola`, queue.length > 0 ? "#ffd35c" : "#9fb3c8", "autopilot")}
      ${tile("Oportunidades", topOpp ? `${topOpp.symbol} ${topOpp.score}/100` : "Sin opp.", topOpp ? (topOpp.signal || "—") : "Ejecutar engine", oppColor, "autopilot")}
      ${tile("Alertas", activeAlerts.length === 0 ? "Todo OK" : `${activeAlerts.length} activas`, activeAlerts.length > 0 ? esc(activeAlerts[0].title.length > 28 ? activeAlerts[0].title.slice(0,28)+"…" : activeAlerts[0].title) : "Sin alertas", alertColor, "autopilot")}
    </div>
  </div>`;
}
function renderJarvisTopPriorities(pv) {
  const activeAlerts = loadAlerts().filter(a => !a.acknowledged);
  const h = computeHealthReadiness();
  const opp = getOpportunityState();
  const items = [];
  const crit = activeAlerts.find(a => a.severity === "CRITICAL");
  if (crit) items.push({ label: "Alerta crítica", detail: crit.title, color: "#ff4d6d", mod: "autopilot" });
  if (h.recovery !== null && h.recovery < 50) items.push({ label: "Modo defensivo HOY", detail: `Recovery ${h.recovery}% — evita decisiones de alto impacto. Educativo.`, color: "#ffd35c", mod: "health" });
  const sorted = (pv.assets || []).slice().sort((a, b) => a.score - b.score);
  const worst = sorted[0];
  if (worst && worst.score < 45) items.push({ label: `Revisar ${worst.symbol}`, detail: `Score ${worst.score}/100 · ${pct(worst.gainPct)} · riesgo ${worst.risk}`, color: "#ff4d6d", mod: "trading" });
  const topOpp = (opp.topOpportunities || [])[0];
  if (topOpp && topOpp.score >= 60) items.push({ label: `Investigar ${topOpp.symbol}`, detail: `Score ${topOpp.score}/100 · ${topOpp.signal || "—"} · educativo`, color: "#00ff99", mod: "autopilot" });
  const cryptoPct = pv.totalValueMXN > 0 ? (pv.assets || []).filter(a => a.type === "crypto").reduce((s, a) => s + a.valueMXN, 0) / pv.totalValueMXN * 100 : 0;
  if (cryptoPct > 70) items.push({ label: "Concentración cripto alta", detail: `${cryptoPct.toFixed(1)}% en cripto — diversificación. Educativo.`, color: "#ffd35c", mod: "trading" });
  const warn = activeAlerts.find(a => a.severity === "WARNING" && (!crit || a.id !== crit.id));
  if (warn) items.push({ label: "Aviso activo", detail: warn.title, color: "#ffd35c", mod: "autopilot" });
  const top3 = items.slice(0, 3);
  if (!top3.length) return `<div style="max-width:1280px;margin:0 auto 16px;padding:14px 18px;background:rgba(0,255,153,.04);border:1px solid rgba(0,255,153,.14);border-radius:18px"><div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#00ff99;margin-bottom:6px">Top Prioridades Hoy</div><div style="color:#9fb3c8;font-size:13px">Sistema en buen estado. Sin prioridades urgentes hoy. (Educativo)</div></div>`;
  return `<div style="max-width:1280px;margin:0 auto 16px;padding:16px 20px;background:rgba(255,211,92,.03);border:1px solid rgba(255,211,92,.15);border-radius:18px">
    <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#ffd35c;margin-bottom:4px">Top Prioridades Hoy</div>
    ${top3.map((item, i) => `<div onclick="showMod('${item.mod}')" style="cursor:pointer;display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:${i > 0 ? "1px solid rgba(120,160,210,.08)" : "none"}"><span style="min-width:22px;height:22px;border-radius:50%;background:${item.color}18;border:1px solid ${item.color}44;display:grid;place-items:center;font-size:11px;font-weight:900;color:${item.color};flex-shrink:0">${i + 1}</span><div><div style="font-size:13px;font-weight:700;color:#eaf6ff">${esc(item.label)}</div><div style="font-size:11px;color:#9fb3c8;margin-top:2px">${esc(item.detail)}</div></div></div>`).join("")}
    <div style="font-size:11px;color:#5a6674;margin-top:8px">Educativo — no es consejo financiero ni médico.</div>
  </div>`;
}
function renderJarvisChangelog(pv) {
  if (portfolioHistory.length < 2) return `<div style="max-width:1280px;margin:0 auto 16px;padding:14px 18px;background:rgba(59,157,255,.04);border:1px solid rgba(59,157,255,.12);border-radius:18px"><div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#3b9dff;margin-bottom:4px">Qué Cambió</div><div style="color:#9fb3c8;font-size:13px">Recolectando historial. Visible con 2+ snapshots.</div></div>`;
  const prev = portfolioHistory[portfolioHistory.length - 2];
  const curr = portfolioHistory[portfolioHistory.length - 1];
  const prevVal = prev.total || 1;
  const currVal = curr.total || pv.totalValueMXN || 0;
  const deltaMXN = currVal - prevVal;
  const deltaPct = prevVal !== 0 ? (deltaMXN / prevVal) * 100 : 0;
  const deltaColor = deltaMXN >= 0 ? "#00ff99" : "#ff4d6d";
  const sign = deltaMXN >= 0 ? "+" : "";
  const todayAlerts = loadAlerts().filter(a => a.date === todayKey());
  const tsLabel = curr.t ? new Date(curr.t).toLocaleString("es-MX", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  return `<div style="max-width:1280px;margin:0 auto 16px;padding:16px 20px;background:rgba(59,157,255,.03);border:1px solid rgba(59,157,255,.12);border-radius:18px">
    <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#3b9dff;margin-bottom:10px">Qué Cambió · vs snapshot anterior</div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-end">
      <div><div style="font-size:11px;color:#9fb3c8">Portafolio ahora</div><div style="font-size:22px;font-weight:900;color:#eaf6ff">${money(currVal)}</div></div>
      <div><div style="font-size:11px;color:#9fb3c8">Cambio</div><div style="font-size:22px;font-weight:900;color:${deltaColor}">${sign}${money(Math.abs(deltaMXN))} (${sign}${deltaPct.toFixed(2)}%)</div></div>
      <div><div style="font-size:11px;color:#9fb3c8">Alertas hoy</div><div style="font-size:22px;font-weight:900;color:${todayAlerts.length > 0 ? "#ffd35c" : "#00ff99"}">${todayAlerts.length}</div></div>
    </div>
    <div style="font-size:10px;color:#5a6674;margin-top:8px">Snapshot: ${tsLabel} · ${portfolioHistory.length} puntos históricos</div>
  </div>`;
}

function render() {
  const pv = portfolioValue();
  const reg = marketRegime();
  const assets = pv.assets;
  const ranked = assets.slice().sort((a, b) => b.score - a.score);
  const best = ranked[0], worst = ranked[ranked.length - 1];
  const botEq = botValue(), botPnl = botEq - bot.initialCapital;
  const grouped = {};
  for (const a of assets) { const key = `${a.source} · ${a.category}`; grouped[key] = grouped[key] || []; grouped[key].push(a); }
  const chatHtml = chatHistory.map(c => `<div class="msg"><b>Tu:</b> ${esc(c.question)}<br><b>Jarvis AI:</b><div>${md(c.reply)}</div><small>${esc(c.time)}</small></div>`).join("");
  const botTables = renderBotTables();
  const topTV = TV_SYMBOL.BBVA || "BMV:BBVA";
  const whoopLive = computeHealthReadiness().connected;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(CORDA_APP_NAME)}</title>
<style>
:root{--bg:#02040a;--panel:rgba(7,16,30,.72);--line:rgba(120,160,210,.16);--muted:#9fb3c8;--green:#00ff99;--red:#ff4d6d;--blue:#3b9dff;--gold:#ffd35c;--text:#eaf6ff}
html{scroll-behavior:smooth}
*{box-sizing:border-box}
body{margin:0;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#02040a;padding:0 18px 120px;overflow-x:hidden}
.sidebar{display:none;position:fixed;left:0;top:0;width:196px;height:100vh;background:rgba(3,8,18,.96);border-right:1px solid rgba(120,160,210,.13);padding:22px 12px;flex-direction:column;gap:4px;overflow-y:auto;z-index:40;backdrop-filter:blur(20px)}
.sidebar-brand{padding:0 4px 16px;border-bottom:1px solid rgba(120,160,210,.1);margin-bottom:8px;text-align:center}
.sidebar-btn{display:block;width:100%;text-align:left;border-radius:12px;padding:10px 13px;font-size:13px;font-weight:700;cursor:pointer;border:1px solid transparent;background:transparent;color:var(--muted);transition:.18s}
.sidebar-btn:hover,.sidebar-btn.nav-active{background:rgba(59,157,255,.1);border-color:rgba(59,157,255,.25);color:var(--text)}
.sidebar-btn[data-mod="alfredo"].nav-active{background:rgba(255,211,92,.1);border-color:rgba(255,211,92,.3);color:#ffd35c}
@media(min-width:900px){.sidebar{display:flex}body{padding-left:210px}.app-nav{display:none!important}}
body:before{content:"";position:fixed;inset:0;z-index:-4;background:radial-gradient(circle at 16% 12%,rgba(0,255,153,.18),transparent 30%),radial-gradient(circle at 84% 10%,rgba(59,157,255,.20),transparent 32%),radial-gradient(circle at 50% 100%,rgba(255,211,92,.10),transparent 34%),linear-gradient(135deg,#02040a,#06101f 52%,#02040a)}
body:after{content:"";position:fixed;inset:0;z-index:-3;background-image:linear-gradient(rgba(120,160,210,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(120,160,210,.05) 1px,transparent 1px);background-size:36px 36px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.9),rgba(0,0,0,.08))}
.particles{position:fixed;inset:0;z-index:-2;overflow:hidden;pointer-events:none}
.particles i{position:absolute;width:2px;height:2px;background:#3b9dff;border-radius:50%;opacity:.5;animation:rise linear infinite}
@keyframes rise{0%{transform:translateY(100vh);opacity:0}10%{opacity:.6}100%{transform:translateY(-10vh);opacity:0}}
a{color:#9bd3ff}
header{max-width:1280px;margin:auto;padding:30px 0 14px;position:sticky;top:0;z-index:20;background:linear-gradient(#02040af2,#02040ab0);backdrop-filter:blur(18px)}
.logo-wrap{display:flex;align-items:center;gap:20px}
.app-icon{width:84px;height:84px;border-radius:28px;position:relative;background:linear-gradient(135deg,#00ff99,#3b9dff,#ffd35c);display:grid;place-items:center;box-shadow:0 0 50px rgba(59,157,255,.5);font-size:38px;animation:glowpulse 3.5s ease-in-out infinite}
@keyframes glowpulse{0%,100%{box-shadow:0 0 40px rgba(59,157,255,.4)}50%{box-shadow:0 0 70px rgba(0,255,153,.6)}}
.app-icon:before{content:"";position:absolute;inset:11px;border-radius:20px;border:1px solid rgba(255,255,255,.5)}
h1{font-size:48px;margin:0;letter-spacing:.5px;background:linear-gradient(90deg,#ffd35c,#fff,#3b9dff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-shadow:0 0 30px rgba(255,211,92,.2)}
.subtitle{color:var(--muted);font-size:15px;margin-top:4px}
nav{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;overflow-x:auto;-webkit-overflow-scrolling:touch}
nav a,.btn{border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--text);text-decoration:none;border-radius:14px;padding:11px 16px;font-weight:700;cursor:pointer;transition:.2s}
.btn:hover,nav a:hover{background:rgba(59,157,255,.14);border-color:#3b9dff}
.grid{max-width:1280px;margin:16px auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px}
.card,.panel,.msg,.asset-row,.news-card,.brain-card{background:var(--panel);border:1px solid var(--line);border-radius:24px;box-shadow:0 16px 50px rgba(0,0,0,.3);backdrop-filter:blur(16px)}
.card{padding:20px;transition:.25s}.card:hover{transform:translateY(-2px);border-color:rgba(59,157,255,.4)}
.label{color:var(--muted);font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.big{font-size:34px;font-weight:900;line-height:1.05}
.glow{text-shadow:0 0 22px currentColor}
.green{color:var(--green)}.red{color:var(--red)}.yellow{color:var(--gold)}.blue{color:var(--blue)}.muted{color:var(--muted)}
h2{max-width:1280px;margin:34px auto 14px;font-size:26px;background:linear-gradient(90deg,#fff,#9bd3ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.chart-wrap{width:100%;overflow:hidden;border-radius:20px}.chart{width:100%;height:260px}
.tv-embed{max-width:1280px;margin:16px auto;height:480px;border-radius:24px;overflow:hidden;border:1px solid var(--line)}
.brain-card{max-width:1280px;margin:16px auto;padding:22px;display:grid;grid-template-columns:1.05fr .95fr;gap:18px}
.brain-title{font-size:28px;font-weight:900;background:linear-gradient(90deg,#ffd35c,#3b9dff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.brain-sub{color:var(--muted);margin:6px 0 12px}
.brain{position:relative;min-height:320px;border-radius:26px;background:radial-gradient(circle at 50% 50%,rgba(59,157,255,.20),transparent 36%),radial-gradient(circle at 28% 34%,rgba(0,255,153,.16),transparent 28%),rgba(0,0,0,.25);overflow:hidden;border:1px solid rgba(120,160,210,.12)}
.brain-lines{position:absolute;inset:0;width:100%;height:100%}
.brain-lines path{fill:none;stroke:#00ff99;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:12 12;animation:dash 3s linear infinite;opacity:.75;filter:drop-shadow(0 0 8px #00ff99)}
@keyframes dash{to{stroke-dashoffset:-90}}
.brain-node{position:absolute;display:grid;place-items:center;min-width:52px;height:32px;padding:0 9px;border-radius:999px;font-weight:900;font-size:11px;border:1px solid rgba(120,160,210,.22);background:rgba(8,18,36,.92);box-shadow:0 0 18px rgba(59,157,255,.28);z-index:3}
.brain-node .pulse{position:absolute;inset:-4px;border-radius:999px;border:1px solid rgba(0,255,153,.4);animation:ping 2.4s ease-out infinite}
@keyframes ping{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.6);opacity:0}}
.brain-feed{display:flex;flex-direction:column;gap:10px}.feed-title{font-size:22px;font-weight:900}
.thought{border:1px solid rgba(120,160,210,.1);background:rgba(255,255,255,.04);padding:12px;border-radius:14px;color:#dbeafe;animation:fade .5s ease}
.thought small{display:block;color:var(--muted);margin-top:5px}.thought b{color:#9bd3ff}
.thought.buy{border-color:rgba(0,255,153,.3)}.thought.sell{border-color:rgba(59,157,255,.3)}.thought.risk{border-color:rgba(255,77,109,.35)}.thought.warn{border-color:rgba(255,211,92,.35)}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.panel{max-width:1280px;margin:auto;padding:18px}
.toolbar{max-width:1280px;margin:16px auto;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.switch{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:999px;padding:10px 14px;background:rgba(255,255,255,.05)}
.dot{width:14px;height:14px;border-radius:50%;background:${settings.thinkingEnabled ? "#00ff99" : "#ff4d6d"};box-shadow:0 0 14px currentColor}
.chatbox{display:flex;gap:10px;margin-top:14px}
.chatbox input{flex:1;border:1px solid rgba(120,160,210,.2);border-radius:14px;padding:15px;color:#fff;background:#071323;font-size:16px}
details.chat-details summary{cursor:pointer;font-size:18px;font-weight:900;padding:14px}
.msg{padding:16px;margin-top:12px}.msg small{display:block;color:var(--muted);margin-top:8px}
.asset-row{max-width:1280px;margin:12px auto;overflow:hidden}
.asset-row summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:16px}
.asset-row summary::-webkit-details-marker{display:none}
.asset-main{display:flex;gap:14px;align-items:center}.asset-main b{font-size:22px}.asset-main span{display:block;color:#d8e5f5}.asset-main em{display:block;color:var(--muted);font-style:normal;margin-top:3px;font-size:13px}
.asset-logo{width:56px;height:56px;border-radius:18px;display:grid;place-items:center;color:#fff;font-weight:900;border:1px solid rgba(255,255,255,.18);flex:0 0 auto}
.asset-money{text-align:right}.asset-money b{display:block;font-size:21px}.asset-money span{font-weight:800}
.asset-detail{border-top:1px solid rgba(120,160,210,.1);padding:16px}
.ind-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:12px 0}
.ind{border:1px solid rgba(120,160,210,.12);background:rgba(255,255,255,.03);border-radius:14px;padding:10px;text-align:center}
.ind span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase}.ind b{font-size:18px}
.alfredo-score{border:1px solid;border-radius:16px;padding:14px;margin:12px 0;background:rgba(255,255,255,.03)}
.as-head{display:flex;justify-content:space-between;align-items:center;font-size:16px}
.alfredo-score ul{margin:8px 0 0;padding-left:18px;color:#cbd5e1}.alfredo-score li{margin:3px 0}
.detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:12px}
.detail-grid div{border:1px solid rgba(120,160,210,.1);background:rgba(255,255,255,.03);border-radius:16px;padding:12px}
.detail-grid span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase}.detail-grid b{font-size:16px}
.tv-link{display:inline-block;margin-top:10px}
.ranking{max-width:1280px;margin:auto;display:grid;gap:12px}
.rank{display:grid;grid-template-columns:220px 1fr 110px;gap:14px;align-items:center;padding:14px;border-radius:18px;border:1px solid rgba(120,160,210,.1);background:rgba(255,255,255,.035)}
.bar{height:12px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}.bar span{display:block;height:100%;background:linear-gradient(90deg,#00ff99,#3b9dff,#ffd35c)}
.news-card{max-width:1280px;margin:14px auto;overflow:hidden;display:grid;grid-template-columns:240px 1fr}
.news-img{width:100%;height:100%;min-height:180px;object-fit:cover;background:linear-gradient(135deg,rgba(0,255,153,.16),rgba(59,157,255,.18))}
.news-img.placeholder{display:grid;place-items:center;font-size:32px;font-weight:900;color:#8ecbff}
.news-body{padding:16px}.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.chips span,.impact span{display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(59,157,255,.12);border:1px solid rgba(59,157,255,.25);font-size:12px;font-weight:800}
.news-body h3{font-size:21px;margin:8px 0}.news-body p{color:#cbd5e1}
.impact{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:10px 0}
.why{color:#9fb3c8;border-left:3px solid var(--blue);padding-left:10px;margin:10px 0}
table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid rgba(120,160,210,.08);text-align:left;white-space:nowrap}
th{color:var(--muted);font-size:12px;text-transform:uppercase}.table-wrap{overflow:auto}
.quiver-box{max-width:1280px;margin:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.quiver-item{border:1px solid rgba(120,160,210,.1);background:rgba(255,255,255,.04);padding:16px;border-radius:18px}
.float{position:fixed;right:20px;bottom:20px;width:68px;height:68px;border-radius:22px;display:grid;place-items:center;text-decoration:none;font-size:30px;background:linear-gradient(135deg,#00ff99,#3b9dff);box-shadow:0 0 36px rgba(0,255,153,.55);z-index:30;border:none;cursor:pointer}
.disclaimer{max-width:1280px;margin:34px auto 0;color:#5a6674;font-size:12px;text-align:center;padding:16px;border-top:1px solid rgba(120,160,210,.08)}
@media(max-width:820px){h1{font-size:34px}.brain-card{grid-template-columns:1fr}.news-card{grid-template-columns:1fr}.asset-row summary{grid-template-columns:1fr}.asset-money{text-align:left}.rank{grid-template-columns:1fr}.chatbox{flex-direction:column}.tv-embed{height:380px}}
.mod{display:block !important;visibility:visible !important;opacity:1 !important;min-height:120px;position:relative;z-index:2;margin:48px 0 24px;padding-top:16px;border-top:2px solid rgba(59,157,255,.22);scroll-margin-top:14px}
.mod::before{content:attr(data-title);display:block;max-width:1280px;margin:0 auto 14px;padding:9px 16px;font-size:12px;font-weight:900;letter-spacing:.22em;text-transform:uppercase;color:#9bd3ff;background:linear-gradient(90deg,rgba(59,157,255,.16),transparent 70%);border-left:3px solid #3b9dff;border-radius:8px}
#mod-home{margin-top:18px;border-top:none}
.nav-mod{border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--text);border-radius:14px;padding:10px 16px;font-weight:700;cursor:pointer;transition:.2s;font-size:14px;font-family:inherit;white-space:nowrap}
.nav-mod:hover,.nav-mod.nav-active{background:rgba(59,157,255,.14);border-color:#3b9dff;color:#3b9dff}
.status-dot{display:inline-block;width:7px;height:7px;border-radius:99px;background:#00ff99;box-shadow:0 0 12px rgba(0,255,153,.7);margin-right:5px}
@media(max-width:820px){.panel{border-radius:18px}.card{border-radius:16px}}
#alfredo-panel{position:fixed;right:20px;bottom:96px;width:min(400px,calc(100vw - 40px));z-index:99;max-height:72vh;overflow-y:auto;border-radius:24px;display:none}
.brain-float{position:fixed;right:20px;bottom:20px;width:72px;height:72px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:radial-gradient(circle,rgba(0,255,153,.12),rgba(59,157,255,.06));border:1px solid rgba(0,255,153,.3);box-shadow:0 0 28px rgba(0,255,153,.35),0 0 56px rgba(0,255,153,.12);z-index:30;cursor:pointer;animation:brainpulse 3.2s ease-in-out infinite;backdrop-filter:blur(14px)}
.brain-float:hover{box-shadow:0 0 48px rgba(0,255,153,.55),0 0 80px rgba(59,157,255,.25);border-color:rgba(0,255,153,.6)}
.brain-float-label{font-size:7px;font-weight:900;letter-spacing:.14em;color:rgba(0,255,153,.75);text-transform:uppercase;line-height:1}
.brain-ring-o{transform-origin:19px 19px;animation:bspin 8s linear infinite}
.brain-ring-m{transform-origin:19px 19px;animation:bspin 5s linear infinite reverse}
@keyframes brainpulse{0%,100%{box-shadow:0 0 28px rgba(0,255,153,.35),0 0 56px rgba(0,255,153,.12)}50%{box-shadow:0 0 48px rgba(0,255,153,.55),0 0 80px rgba(0,255,153,.2)}}
@keyframes bspin{to{transform:rotate(360deg)}}
.range-btn{border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--muted);border-radius:10px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;transition:.18s;font-family:inherit}
.range-btn:hover,.range-btn.rb-active{background:rgba(59,157,255,.16);border-color:rgba(59,157,255,.5);color:#3b9dff}
.news-item{max-width:1280px;margin:8px auto;border:1px solid rgba(120,160,210,.1);border-radius:18px;background:var(--panel);backdrop-filter:blur(16px);overflow:hidden}
.news-item summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:13px 16px;user-select:none}
.news-item summary::-webkit-details-marker{display:none}
.news-item[open]{border-color:rgba(59,157,255,.25)}
.news-item .ni-caret{transition:.2s;flex:0 0 auto;opacity:.5;font-size:11px}
.news-item[open] .ni-caret{transform:rotate(180deg)}
#research-result{animation:fade .3s ease}
#cmdk-overlay{position:fixed;inset:0;z-index:200;display:none;background:rgba(2,4,10,.62);backdrop-filter:blur(7px)}
#cmdk{width:min(640px,calc(100vw - 32px));margin:9vh auto 0;background:rgba(7,16,30,.97);border:1px solid rgba(0,255,153,.25);border-radius:20px;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 60px rgba(0,255,153,.1);overflow:hidden;animation:fade .18s ease}
#cmdk-input{width:100%;background:transparent;border:none;outline:none;color:#eaf6ff;font-size:17px;padding:18px 20px;border-bottom:1px solid rgba(120,160,210,.12);font-family:inherit}
#cmdk-list{max-height:44vh;overflow-y:auto;padding:8px}
.cmdk-item{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 14px;border-radius:12px;cursor:pointer;font-size:14px;color:#c8d8f0}
.cmdk-item.sel{background:rgba(0,255,153,.1);color:#fff;border-left:2px solid #00ff99}
.cmdk-hint{color:#5a6674;font-size:11px;white-space:nowrap}
#cmdk-result{padding:14px 18px;border-top:1px solid rgba(120,160,210,.12);font-size:13px;color:#c8d8f0;max-height:32vh;overflow-y:auto;display:none;line-height:1.5}
#cmdk-result b{color:#00ff99}
.cmdk-kbd{border:1px solid rgba(120,160,210,.25);border-radius:6px;padding:1px 6px;font-size:10px;color:#9fb3c8;background:rgba(0,0,0,.3)}
.cmdk-open-btn{cursor:pointer;font-family:inherit}
details.clps summary::-webkit-details-marker{display:none}
details.clps[open] .clps-caret{transform:rotate(180deg)}
details.clps[open] > summary{border-color:rgba(59,157,255,.3)}
@keyframes nscan{0%{background-position:0 -120%}100%{background-position:0 120%}}
.brain-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(120,160,210,.14);border-radius:10px;padding:5px 11px;font-size:12px;background:rgba(0,0,0,.22);color:#dbeafe;white-space:nowrap}
.brain-chip b{font-size:13px}
.ac-block{border:1px solid rgba(120,160,210,.1);border-radius:14px;padding:11px 14px;background:rgba(0,0,0,.16)}
.ac-title{font-size:9px;font-weight:900;letter-spacing:.13em;text-transform:uppercase;margin-bottom:7px}
</style></head><body>
<aside class="sidebar">
  <div class="sidebar-brand">
    <div style="font-size:28px;margin-bottom:4px">◎</div>
    <div style="font-size:10px;font-weight:900;letter-spacing:.14em;color:#ffd35c">CORDELIUS</div>
    <div style="font-size:9px;color:#5a6674;margin-top:2px">Personal OS</div>
  </div>
  <button data-mod="alfredo" class="sidebar-btn nav-mod" onclick="showMod('alfredo')" style="color:#ffd35c;border-color:rgba(255,211,92,.2);background:rgba(255,211,92,.07)">⚡ Jarvis</button>
  <button data-mod="home" class="sidebar-btn nav-mod" onclick="showMod('home')">◻ Home</button>
  <button data-mod="trading" class="sidebar-btn nav-mod" onclick="showMod('trading')">◈ Trading</button>
  <button data-mod="health" class="sidebar-btn nav-mod" onclick="showMod('health')">◉ Health</button>
  <button data-mod="journal" class="sidebar-btn nav-mod" onclick="showMod('journal')">◇ Journal</button>
  <button data-mod="intelligence" class="sidebar-btn nav-mod" onclick="showMod('intelligence')">◎ Intelligence</button>
  <button data-mod="autopilot" class="sidebar-btn nav-mod" onclick="showMod('autopilot')">⊕ Autopilot</button>
</aside>
<div class="particles">${Array.from({ length: 18 }).map((_, i) => `<i style="left:${(i * 5.5 + 3) % 100}%;animation-duration:${9 + (i % 7)}s;animation-delay:${(i % 9)}s"></i>`).join("")}</div>

<button class="brain-float" onclick="toggleJarvis()" title="Jarvis AI — Cordelius">
  <svg width="38" height="38" viewBox="0 0 38 38" fill="none">
    <circle cx="19" cy="19" r="17" stroke="rgba(0,255,153,.35)" stroke-width="1" stroke-dasharray="6 3" class="brain-ring-o"/>
    <circle cx="19" cy="19" r="11" stroke="rgba(59,157,255,.5)" stroke-width="1.2" stroke-dasharray="4 4" class="brain-ring-m"/>
    <circle cx="19" cy="19" r="6" fill="rgba(0,255,153,.15)" stroke="rgba(0,255,153,.8)" stroke-width="1.2"/>
    <circle cx="19" cy="19" r="2.5" fill="#00ff99"/>
    <line x1="19" y1="1" x2="19" y2="8" stroke="rgba(0,255,153,.5)" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="19" y1="30" x2="19" y2="37" stroke="rgba(0,255,153,.5)" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="1" y1="19" x2="8" y2="19" stroke="rgba(59,157,255,.5)" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="30" y1="19" x2="37" y2="19" stroke="rgba(59,157,255,.5)" stroke-width="1.2" stroke-linecap="round"/>
  </svg>
  <div class="brain-float-label">Jarvis</div>
</button>

<div id="alfredo-panel" class="panel">
  <div style="padding:16px 20px 20px">
    <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#3b9dff;margin-bottom:12px">Jarvis AI · Educativo</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      ${["Qué vigilar hoy","Morning report","Modo operativo","Resumen de mi día","Qué módulo revisar","Resume mi diario"].map(q =>
        `<button onclick="setJarvisQ('${q}')" class="btn" style="font-size:12px;padding:7px 12px;border-color:rgba(59,157,255,.3)">${esc(q)}</button>`
      ).join("")}
    </div>
    <form class="chatbox" method="POST" action="/ask" onsubmit="event.preventDefault();cordeliusFormPost(this,'/')"><input name="q" placeholder="Pregúntale a Jarvis..." autocomplete="off"><button class="btn">Preguntar</button></form>
    <div style="max-height:300px;overflow-y:auto;margin-top:12px">
      ${chatHtml || '<div class="msg muted">Sin preguntas todavia.</div>'}
    </div>
  </div>
</div>

<header>
  <div class="logo-wrap">
    <div class="app-icon"><svg width="44" height="44" viewBox="0 0 44 44" fill="none"><polygon points="22,4 40,34 4,34" stroke="rgba(255,255,255,.9)" stroke-width="2.2" fill="none"/><line x1="22" y1="4" x2="22" y2="34" stroke="rgba(255,255,255,.6)" stroke-width="1.2"/><circle cx="22" cy="22" r="4" fill="rgba(255,255,255,.95)"/></svg></div>

    <div><h1 id="brand-title">Cordelius</h1><div id="module-subtitle" class="subtitle">Personal OS · Trading · Health · Intelligence · Autopilot</div></div>

  </div>
  <nav class="app-nav" style="display:flex;flex-wrap:wrap;gap:6px">
    <button data-mod="alfredo" class="nav-mod" onclick="showMod('alfredo')" style="border-color:rgba(255,211,92,.4);background:rgba(255,211,92,.07)">⚡ Jarvis</button>
    <button data-mod="home" class="nav-mod" onclick="showMod('home')">Home</button>
    <button data-mod="trading" class="nav-mod" onclick="showMod('trading')">Trading</button>
    <button data-mod="health" class="nav-mod" onclick="showMod('health')">Health</button>
    <button data-mod="journal" class="nav-mod" onclick="showMod('journal')">Journal</button>
    <button data-mod="intelligence" class="nav-mod" onclick="showMod('intelligence')">Intelligence</button>
    <button data-mod="autopilot" class="nav-mod" onclick="showMod('autopilot')">Autopilot</button>
  </nav>
</header>

<div class="toolbar">
  <button class="switch cmdk-open-btn" onclick="openCmdk()" style="border-color:rgba(0,255,153,.3);background:rgba(0,255,153,.06)"><b style="color:#00ff99">⌘K</b>&nbsp;Ask Jarvis · Command</button>
  <a class="switch" href="/toggle-thinking"><span class="dot"></span>Thinking Mode: <b>${settings.thinkingEnabled ? "ON" : "OFF"}</b></a>
  <span class="switch">Refresh: <b>${settings.autoRefreshSeconds}s</b></span>
  <span class="switch">Finnhub: <b class="${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</b></span>
  <span class="switch"><span class="status-dot"></span>Server OK</span>
  <span class="switch">WHOOP: ${statusBadge(whoopLive ? "LIVE" : WHOOP_CONFIGURED ? "STALE" : "FALLBACK")}</span>
  <span class="switch">Precios USD: ${statusBadge(quotesFreshness())}</span>
  <span class="switch">Noticias: ${statusBadge(FINNHUB_API_KEY ? "LIVE" : "FALLBACK")}</span>
  <span class="switch">Journal: <b class="green">OK</b></span>
</div>

${renderNeuralHeader()}
${renderJarvisBrainPanel()}
${renderActionCenter()}

<!-- ── MOD: HOME ─────────────────────────────────────────── -->
<div id="mod-home" class="mod" data-title="Módulo · Home">
${renderHomePortal(pv, reg)}
</div>

<!-- ── MOD: TRADING ──────────────────────────────────────── -->
<div id="mod-trading" class="mod" data-title="Módulo · Trading">
<h2>Cordelius Trading</h2>
<div style="max-width:1280px;margin:0 auto 10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px;color:#5a6674">
  <span>Acciones USD ${statusBadge(quotesFreshness())}</span>
  <span>Cripto Bitso/CoinGecko ${statusBadge(cryptoFreshness())}</span>
  <span>México/GBM ${statusBadge("MANUAL")}</span>
  <span>Indicadores ${statusBadge(indicatorsFreshness())}${indicatorsFreshness() === "MIXED" ? `<span style="font-size:9px;color:#67e8f9"> ${indicatorCounts().live}/${PORTFOLIO.length} reales</span>` : ""}</span>
  <span>Scores ${statusBadge("SIMULATED")}</span>
  <span>Paper trading ${statusBadge("SIMULATED")}</span>
</div>
<div style="max-width:1280px;margin:0 auto 8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
  ${(function(){var A=pv.assets||[];var tot=pv.totalValueMXN||1;var gbm=A.filter(function(a){return a.source==="GBM";}).reduce(function(s,a){return s+a.valueMXN;},0);var plata=A.filter(function(a){return a.source==="Plata";}).reduce(function(s,a){return s+a.valueMXN;},0);var bitso=A.filter(function(a){return a.source==="Bitso";}).reduce(function(s,a){return s+a.valueMXN;},0);var cripto=A.filter(function(a){return a.type==="crypto";}).reduce(function(s,a){return s+a.valueMXN;},0);var cp=cripto/tot*100;function pp(x){return (x/tot*100).toFixed(1)+"%";}return `<div class="card" style="padding:14px 16px"><div class="label">Patrimonio</div><div class="big green glow" style="font-size:26px">${money(pv.totalValueMXN)}</div><div class="${pv.totalGainPct >= 0 ? "green" : "red"}" style="font-size:13px">${pct(pv.totalGainPct)} · ${money(pv.totalGainMXN)}</div></div><div class="card" style="padding:14px 16px"><div class="label">Tipo de cambio</div><div class="big" style="font-size:26px">$${FX_USD_MXN.toFixed(2)}</div><div class="muted" style="font-size:11px">USD/MXN · ${nowMX()}</div></div><div class="card" style="padding:14px 16px"><div class="label">Exposición</div><div style="font-size:13px">GBM ${pp(gbm)}</div><div style="font-size:13px">Plata ${pp(plata)}</div><div style="font-size:13px">Bitso ${pp(bitso)}</div></div>`;})()}
  <div class="card" style="padding:14px 16px"><div class="label">Régimen ${statusBadge(quotesFreshness() === "LIVE" ? "LIVE" : "SIMULATED")}</div><div class="big" style="color:${reg.color};font-size:22px">${esc(reg.label)}</div><div class="muted" style="font-size:11px">${pct(reg.avg)}</div></div>
  <div class="card" style="padding:14px 16px"><div class="label">Top score</div><div class="big green" style="font-size:22px">${esc(best.symbol)}</div><div class="muted" style="font-size:11px">${best.score}/100</div></div>
  <div class="card" style="padding:14px 16px"><div class="label">Vigilar</div><div class="big red" style="font-size:22px">${esc(worst.symbol)}</div><div class="muted" style="font-size:11px">${worst.score}/100</div></div>
</div>


<a id="chart"></a>
<div style="max-width:1280px;margin:28px auto 8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
  <h2 style="margin:0;font-size:22px;background:linear-gradient(90deg,#fff,#9bd3ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Gráficas — historial del portafolio</h2>
  <div style="display:flex;gap:6px">
    <button class="range-btn rb-active" data-days="1" onclick="redrawPortChart(1)">1D</button>
    <button class="range-btn" data-days="7" onclick="redrawPortChart(7)">7D</button>
    <button class="range-btn" data-days="30" onclick="redrawPortChart(30)">30D</button>
    <button class="range-btn" data-days="0" onclick="redrawPortChart(0)">Todo</button>
  </div>
</div>
<div class="panel" style="max-width:1280px;margin:0 auto 8px">
  ${(function(){
    const hist = buildDailyEquityHistory();
    const note = hist.mode === "real"
      ? `Historial real: ${esc(hist.firstDate || "")} → ${esc(hist.lastDate || "")} · ${hist.rangeDays} días (anclas diarias de snapshots + intradía de hoy)`
      : `Historial limitado: solo ${esc(hist.lastDate || "hoy")} — se irá extendiendo conforme se acumulen snapshots diarios. No se inventan fechas.`;
    return `<div id="port-chart-area">${spark(hist.points, { key: "total", color: "#3b9dff", height: 300 })}</div>
    <div style="font-size:11px;color:${hist.mode === "real" ? "#9fb3c8" : "#ffd35c"};margin-top:4px">${note}</div>`;
  })()}
  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;align-items:center">
    <span class="muted" id="port-chart-info" style="font-size:12px">${portfolioHistory.length} snapshots intradía</span>
    <span class="muted" style="font-size:11px">Actualizado: ${esc(nowMX())}</span>
    ${portfolioHistory.length >= 7 ? `<span style="font-size:11px;color:#00ff99">7D ✓</span>` : ""}
    ${portfolioHistory.length >= 30 ? `<span style="font-size:11px;color:#00ff99">30D ✓</span>` : ""}
  </div>
</div>
<script>window._portHistory=${JSON.stringify(portfolioHistory.slice(-600))};</script>
<div class="panel" style="max-width:1280px;margin:0 auto 8px;padding:14px 18px">
  <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#3b9dff;margin-bottom:6px">Gráficas por activo</div>
  <div style="font-size:13px;color:#9fb3c8">Abre cada activo del portafolio para ver minigrafica, precio, señales y enlace a TradingView.</div>
</div>

<div style="max-width:1280px;margin:18px auto 8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
  <div>
    <h2 style="margin:0;font-size:20px;background:linear-gradient(90deg,#fff,#9bd3ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent">BBVA — Gráfica BMV</h2>
    <div style="font-size:12px;color:#9fb3c8;margin-top:2px">Símbolo: <code style="color:#3b9dff">${esc(topTV)}</code> · TradingView</div>
  </div>
  <a class="btn" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(topTV)}" target="_blank" rel="noopener" style="font-size:12px;padding:8px 14px">Abrir en TradingView ↗</a>
</div>
<div class="panel" style="max-width:1280px;margin:0 auto 14px;padding:0;overflow:hidden">
  <details>
    <summary style="list-style:none;cursor:pointer;padding:14px 18px;background:rgba(59,157,255,.06);user-select:none;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:13px;font-weight:700">Mostrar gráfica interactiva BBVA (BMV)</span>
      <span class="btn" style="font-size:12px;padding:5px 12px">Cargar ▾</span>
    </summary>
    <div class="tv-embed" id="bbva-chart-container" style="height:460px">
      <iframe id="bbva-tv-frame" src="" style="width:100%;height:100%;border:none" allowtransparency="true" scrolling="no"></iframe>
    </div>
  </details>
</div>
<script>
(function(){
  var _bbvaEl = document.querySelector('#bbva-chart-container');
  var det = _bbvaEl ? _bbvaEl.closest('details') : null;
  if (det) det.addEventListener('toggle', function(){
    if (det.open) {
      var fr = document.getElementById('bbva-tv-frame');
      if (fr && !fr.src) fr.src = 'https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(topTV)}&interval=D&theme=dark&style=1&locale=es&timezone=America%2FMexico_City&hide_top_toolbar=0&hide_side_toolbar=1&allow_symbol_change=0';
    }
  });
})();
</script>


<a id="brain"></a><h2>Jarvis Score · Cordelius Brain</h2>${brainHtml()}

<a id="alfredo-inline"></a><h2>Jarvis — Copiloto educativo</h2>
<div class="panel" style="padding:0"><details class="chat-details">
  <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:16px 20px;background:rgba(59,157,255,.07);border-radius:24px;user-select:none">
    <span style="display:flex;align-items:center;gap:12px">
      <span style="width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg,#3b9dff,#00ff99);display:grid;place-items:center;font-size:18px;font-weight:900">AI</span>
      <span><b>Jarvis AI</b> <span class="muted" style="font-size:13px">· preguntas sobre tu portafolio · educativo</span></span>
    </span>
    <span class="btn" style="font-size:13px;padding:6px 14px">Abrir chat ▾</span>
  </summary>
  <div style="padding:16px 20px 20px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      ${["Qué vigilar hoy","Morning report con salud","Modo operativo hoy","Analiza mi portafolio","Stocks externos calientes","Congreso e insiders"].map(q =>
        `<button onclick="document.querySelector('[name=q]').value='${q}'" class="btn" style="font-size:12px;padding:7px 12px;border-color:rgba(59,157,255,.3)">${esc(q)}</button>`
      ).join("")}
    </div>
    <form class="chatbox" method="POST" action="/ask" onsubmit="event.preventDefault();cordeliusFormPost(this,'/')"><input name="q" placeholder="Pregúntale a Jarvis..." autocomplete="off"><button class="btn">Preguntar</button></form>
    <div style="max-height:480px;overflow-y:auto;margin-top:12px">
      ${chatHtml || '<div class="msg muted">Sin preguntas todavia.</div>'}
    </div>
  </div>
</details></div>

<a id="portfolio"></a>${collapsibleSection("portfolio-tables", "◈ Portafolio real por cuenta",
  `<span style="font-size:11px;color:#9fb3c8">${assets.length} activos · GBM / Plata / Bitso</span>${statusBadge(quotesFreshness() === "LIVE" || cryptoFreshness() === "LIVE" ? "LIVE" : "MANUAL")}`,
  (function(){
    const bySource = {};
    for (const a of assets) { bySource[a.source] = bySource[a.source] || []; bySource[a.source].push(a); }
    return Object.entries(bySource).map(([src, list]) =>
      renderAccountSummary(src, list)
      + `<h2 style="font-size:18px;margin:6px 0 8px;color:#9fb3c8">${esc(src)} · ${[...new Set(list.map(a => a.category))].join(", ")}</h2>`
      + renderPortfolioRows(list)
    ).join("");
  })(), true)}


${renderSignalCenter(pv, reg)}


<a id="news"></a>${collapsibleSection("news", "◆ Market News",
  `<span style="font-size:11px;color:#9fb3c8">${news.length} noticias · ${news.filter(n => n.impacted && n.impacted.length).length} con activos impactados</span>${statusBadge(FINNHUB_API_KEY ? "LIVE" : "FALLBACK")}`,
  renderNews(), false)}

<a id="bot"></a><h2>Trading AI — Paper Mode · Laboratorio ficticio</h2>
${renderTradingAIStatus()}
${renderPaperTradingPanel()}

</div>
<!-- ── MOD: HEALTH ────────────────────────────────────────── -->
<div id="mod-health" class="mod" data-title="Módulo · Health">
${renderHealthOSPanel()}
</div>
<!-- ── MOD: JOURNAL ───────────────────────────────────────── -->
<div id="mod-journal" class="mod" data-title="Módulo · Journal">
<h2>Cordelius Journal</h2>
${renderJournalModule()}
</div>
<!-- ── MOD: INTELLIGENCE ─────────────────────────────────── -->
<div id="mod-intelligence" class="mod" data-title="Módulo · Intelligence">

<h2>Cordelius Intelligence</h2>
${collapsibleSection("intel-feed", "◆ Intelligence Feed",
  `<span style="font-size:11px;color:#9fb3c8">noticias + intel + quiver combinados</span>`,
  renderCordeliusIntelligenceFeedPreview(), true)}
${renderStockResearch()}

${renderDailyBrief()}

<a id="quiver"></a>${collapsibleSection("quiver", "◇ Quiver · Institucional",
  (function(){
    const c = (quiverData.congressional || []).length, i = (quiverData.insider || []).length, k = (quiverData.contracts || []).length;
    return `<span style="font-size:11px;color:#9fb3c8">Congreso ${c} · Insiders ${i} · Contratos ${k} · Watchlist ${MARKET_WATCHLIST.length}</span>${statusBadge(QUIVER_API_KEY && quiverData.configured ? (c + i + k > 0 ? "LIVE" : "LIVE") : "FALLBACK")}${QUIVER_API_KEY && quiverData.configured && c + i + k === 0 ? '<span style="font-size:10px;color:#ffd35c">sin filas hoy</span>' : ""}`;
  })(),
  renderQuiverIntelligencePanel(), false)}

<a id="intel"></a>${collapsibleSection("intel", "◎ Cordelius Intelligence · Intel manual",
  `<span style="font-size:11px;color:#9fb3c8">${intelItems.length} items</span>`,
  renderIntelPanel(), false)}

<details style="max-width:1280px;margin:0 auto 8px"><summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:rgba(0,255,153,.05);border:1px solid rgba(0,255,153,.12);border-radius:20px;user-select:none"><span style="font-size:14px;font-weight:900;color:#00ff99">◆ Radar político · Intel manual</span><span class="btn" style="font-size:12px;padding:5px 12px">Ver detalle ▾</span></summary>
<div>
<a id="intelligence"></a><h2 style="display:none">Cordelius Intelligence</h2>
${(function(){
  const intel = computeIntelligence();
  const trending = computeQuiverTrending();
  const topTickerChips = intel.impactedTickers.slice(0,8).map(t =>
    '<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(0,255,153,.3);border-radius:10px;padding:4px 10px;font-size:12px;margin:3px;background:rgba(0,255,153,.06)">'
    + '<b>' + esc(t.symbol) + '</b> '
    + '<span style="color:' + (t.sentiment==="POSITIVO"?"#00ff99":"#ff4d6d") + '">' + esc(t.sentiment) + '</span>'
    + ' ×' + t.intelCount + '</span>'
  ).join("");
  const politRows = intel.politicalTrading.slice(0,8).map(m => {
    const tx = (m.transaction||"").toLowerCase();
    const txColor = /buy|purchase/.test(tx) ? "#00ff99" : /sale|sell/.test(tx) ? "#ff4d6d" : "#ffd166";
    return '<tr><td><b>' + esc(m.symbol) + '</b></td><td style="color:' + txColor + ';font-weight:800">' + esc(m.transaction||"").toUpperCase().slice(0,8) + '</td><td>' + esc(m.who) + (m.party?" ("+esc(m.party)+")":"") + '</td><td class="muted" style="font-size:12px">' + esc(m.date||"") + '</td></tr>';
  }).join("");
  const topIntelHtml = intel.topics.slice(0,3).map(t =>
    '<div style="border:1px solid rgba(120,160,210,.1);background:rgba(255,255,255,.03);border-radius:14px;padding:14px;margin-bottom:10px">'
    + '<span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:900;background:' + (t.mood==="POSITIVO"?"rgba(0,255,153,.2)":t.mood==="NEGATIVO"?"rgba(255,77,109,.2)":"rgba(255,211,92,.15)") + ';color:' + (t.mood==="POSITIVO"?"#00ff99":t.mood==="NEGATIVO"?"#ff4d6d":"#ffd35c") + ';margin-bottom:8px">' + esc(t.mood) + '</span> '
    + (t.affected.length ? '<span class="muted" style="font-size:12px">' + t.affected.join(", ") + '</span>' : "")
    + '<div style="color:#dbeafe;margin-top:6px;font-size:14px">' + esc(t.text) + '</div>'
    + '<small class="muted">' + esc(t.time||"") + '</small></div>'
  ).join("");
  return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;max-width:1280px;margin:0 auto 8px">'
    + '<div class="panel"><div class="label" style="margin-bottom:8px">Intel manual · tickers impactados</div>'
    + (topTickerChips ? '<div style="margin-bottom:12px">' + topTickerChips + '</div>' : '<div class="muted">Sin intel manual todavía.</div>')
    + topIntelHtml
    + '<a href="#intel" class="btn" style="display:inline-block;margin-top:8px;font-size:13px">Ver todo Intel ↓</a></div>'
    + '<div class="panel"><div class="label" style="margin-bottom:8px">Trading político (Quiver · congreso)</div>'
    + (trending.configured && politRows
      ? '<div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Tipo</th><th>Quien</th><th>Fecha</th></tr></thead><tbody>' + politRows + '</tbody></table></div>'
      : '<div class="muted">Sin datos Quiver — agrega QUIVER_API_KEY en .env.</div>')
    + '<div class="muted" style="font-size:12px;margin-top:8px">Educativo. Retraso típico hasta 45 días.</div></div>'
    + '</div>';
})()}

<a id="radar"></a><h2>Trading AI — Market Radar</h2>
${(function(){
  const radar = computeMarketRadar();
  const hot = radar.hotTickers.slice(0,10);
  const chips = MARKET_WATCHLIST.map(sym => {
    const t = radar.watchlist.find(x => x.symbol === sym);
    const active = t && (t.quiverSignals > 0 || (t.score != null && t.score > 60));
    return '<span style="display:inline-flex;align-items:center;gap:3px;border:1px solid '+(active?"rgba(0,255,153,.5)":"rgba(120,160,210,.15)")+';border-radius:8px;padding:4px 9px;font-size:12px;margin:2px;background:'+(t&&t.inPortfolio?"rgba(59,157,255,.1)":active?"rgba(0,255,153,.06)":"transparent")+'">'
      + '<b>' + esc(sym) + '</b>'
      + (t && t.inPortfolio ? ' <span style="color:#3b9dff;font-size:10px">●</span>' : '')
      + (t && t.quiverSignals > 0 ? ' <span style="color:#00ff99;font-size:10px">Q'+t.quiverSignals+'</span>' : '')
      + '</span>';
  }).join("");
  const hotRows = hot.map(t =>
    '<tr><td><b>' + esc(t.symbol) + '</b>' + (t.inPortfolio?' <span style="color:#3b9dff;font-size:11px">PORT</span>':'') + '</td>'
    + '<td>' + (t.score!=null?t.score+"/100":"-") + '</td>'
    + '<td style="color:' + (t.quiverSignals>0?"#00ff99":"var(--muted)") + '">' + (t.quiverSignals||"-") + '</td>'
    + '<td style="font-size:12px;color:var(--muted)">' + esc(t.signal||"-") + '</td></tr>'
  ).join("");
  return '<div class="panel" style="max-width:1280px;margin:0 auto 8px"><div class="label" style="margin-bottom:10px">Watchlist · azul = en portafolio · verde = señal Quiver</div>'
    + '<div style="margin-bottom:14px">' + chips + '</div>'
    + (hot.length ? '<div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Score</th><th>Quiver</th><th>Señal</th></tr></thead><tbody>' + hotRows + '</tbody></table></div>' : '<div class="muted">Sin señales activas en watchlist.</div>')
    + '<div class="muted" style="font-size:12px;margin-top:8px">' + esc(radar.educationalSummary) + '</div></div>';
})()}

</div></details>
</div>
<!-- ── MOD: ALFREDO ─────────────────────────────────────── -->
<div id="mod-alfredo" class="mod" data-title="Módulo · Jarvis">
<h2>Jarvis — Command Center</h2>
${renderJarvisCommandCenter(pv)}
${renderJarvisTopPriorities(pv)}
${renderJarvisChangelog(pv)}
<div class="panel" style="max-width:960px;margin:0 auto 12px;padding:18px 20px;border-color:rgba(255,211,92,.18);background:rgba(255,211,92,.04)">
  <div style="font-size:10px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c;margin-bottom:8px">Context Engine</div>
  <div id="alfredo-context-line" style="font-size:18px;font-weight:800;color:#fff;margin-bottom:8px">Conecto salud, trading, journal e inteligencia sin inventar datos.</div>
  <div id="alfredo-context-question" class="muted" style="font-size:14px">¿Qué módulo quieres revisar primero?</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
    <button class="btn" onclick="showMod('trading')">Cordelius Trading</button>
    <button class="btn" onclick="showMod('health')">Cordelius Health</button>
    <button class="btn" onclick="showMod('journal')">Cordelius Journal</button>
  </div>
</div>
${renderMorningReport()}
</div>
<!-- ── MOD: AUTOPILOT ─────────────────────────────────────── -->
<div id="mod-autopilot" class="mod" data-title="Módulo · Autopilot">

<h2>Cordelius Autopilot — Estado del sistema · Automatización</h2>

<section id="autopilot-db-panel" style="margin:22px 0;padding:22px;border-radius:28px;background:radial-gradient(circle at 0% 0%,rgba(0,255,170,.18),transparent 34%),linear-gradient(135deg,rgba(5,11,24,.96),rgba(8,18,35,.88));border:1px solid rgba(0,255,170,.22);box-shadow:0 20px 70px rgba(0,0,0,.42)">
  <div style="display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-bottom:18px">
    <div>
      <div style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#00ffaa;font-weight:900">Cordelius Database</div>
      <h2 style="margin:6px 0 4px;font-size:32px;color:#f5f8ff">Operating Memory</h2>
      <p style="margin:0;color:#aab6c8">Memoria real de Health, portfolio y decisiones. Cordelius ya está guardando progreso.</p>
    </div>
    <button id="adm-save-btn" style="padding:12px 16px;border-radius:16px;border:1px solid rgba(0,255,170,.35);background:rgba(0,255,170,.12);color:#00ffaa;font-weight:900">
      Guardar snapshot
    </button>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:14px">
    <div class="adm-card"><b>Health Logs</b><strong id="adm-health">—</strong><span>Snapshots WHOOP</span></div>
    <div class="adm-card"><b>Portfolio Logs</b><strong id="adm-portfolio">—</strong><span>Snapshots portafolio</span></div>
    <div class="adm-card"><b>Trading Decisions</b><strong id="adm-decisions">—</strong><span>Decisiones guardadas</span></div>
    <div class="adm-card"><b>XP</b><strong id="adm-xp">—</strong><span id="adm-level">Nivel —</span></div>
    <div class="adm-card"><b>Streak</b><strong id="adm-streak">—</strong><span>Racha memoria</span></div>
  </div>

  <div style="margin-top:16px;padding:18px;border-radius:22px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#dce7f7;line-height:1.55">
    <b>Último estado WHOOP:</b>
    <span id="adm-health-latest">Cargando...</span>
    <br><br>
    <b>Regla actual:</b>
    <span id="adm-rule">Cargando...</span>
  </div>
</section>

<style>
  .adm-card{padding:18px;border-radius:22px;background:rgba(10,18,35,.72);border:1px solid rgba(0,255,170,.18);box-shadow:0 12px 34px rgba(0,0,0,.25)}
  .adm-card b{display:block;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#8aa0b8}
  .adm-card strong{display:block;font-size:30px;font-weight:900;color:#00ffaa;margin-top:8px}
  .adm-card span{display:block;font-size:12px;color:#aab6c8;margin-top:6px}
</style>

<script>
(function(){
  function setText(id, value){
    var el = document.getElementById(id);
    if (el) el.textContent = value == null ? "—" : String(value);
  }

  async function loadAutopilotMemoryPanel(){
    try {
      var r = await fetch("/api/autopilot/progress", { cache: "no-store" });
      var d = await r.json();
      if (!d || !d.ok) return;

      var progress = d.progress || {};
      var counts = d.counts || {};
      var latest = d.latest || {};
      var health = latest.health || {};
      var decision = latest.tradingDecision || {};

      setText("adm-health", counts.health || 0);
      setText("adm-portfolio", counts.portfolio || 0);
      setText("adm-decisions", counts.tradingDecisions || 0);
      setText("adm-xp", progress.xp || 0);
      setText("adm-level", "Nivel " + (progress.level || 1));
      setText("adm-streak", (progress.streak || 0) + "d");

      var healthText =
        "Recovery " + (health.recovery ?? "—") +
        " · Sleep " + (health.sleep ?? "—") +
        " · HRV " + (health.hrv ? Number(health.hrv).toFixed(1) : "—") +
        " · Strain " + (health.strain ? Number(health.strain).toFixed(1) : "—") +
        " · Modo " + (health.operatingMode || "—");

      setText("adm-health-latest", healthText);
      setText("adm-rule", decision.rule || "Sin regla guardada todavía.");
    } catch(e) {
      console.error("Autopilot Memory Panel error", e);
    }
  }

  var btn = document.getElementById("adm-save-btn");
  if (btn) {
    btn.addEventListener("click", async function(){
      btn.textContent = "Guardando...";
      await secureFetch("/api/autopilot/snapshot", { method: "POST" });
      btn.textContent = "Guardado ✅";
      await loadAutopilotMemoryPanel();
      setTimeout(function(){ btn.textContent = "Guardar snapshot"; }, 1200);
    });
  }

  window.loadAutopilotMemoryPanel = loadAutopilotMemoryPanel;
  setTimeout(loadAutopilotMemoryPanel, 500);
  setInterval(loadAutopilotMemoryPanel, 60000);
})();
</script>


${renderAutomationsPanel()}

${renderAutopilotPanel()}

${collapsibleSection("ledger", "◇ Position Ledger", `<span style="font-size:11px;color:#9fb3c8">historial de posiciones</span>${statusBadge("SIMULATED")}`, renderLedgerPanel(), false)}

${collapsibleSection("alerts-detail", "! Alertas · historial completo", `<span style="font-size:11px;color:#9fb3c8">las activas se resumen en Action Center ↑</span>`, renderAlertsPanel(), false)}

<details class="clps" data-clps="system" style="max-width:1280px;margin:0 auto 12px">
<summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 20px;background:var(--panel);border:1px solid rgba(120,160,210,.14);border-radius:18px;user-select:none"><span style="display:flex;align-items:center;gap:10px"><b style="font-size:15px">⚙ System · acceso y servicios</b></span><span class="clps-caret" style="font-size:11px;opacity:.55;transition:.2s">▼</span></summary>
<div class="grid">
  <div class="card"><div class="label">App</div><div class="big green">${esc(CORDA_APP_NAME)}</div></div>
  <div class="card"><div class="label">Jarvis AI</div><div class="big ${settings.thinkingEnabled ? "green" : "yellow"}">${settings.thinkingEnabled ? "THINKING" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Finnhub</div><div class="big ${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Quiver</div><div class="big ${QUIVER_API_KEY ? "green" : "yellow"}">${QUIVER_API_KEY ? "OK" : "PENDIENTE"}</div></div>
  <div class="card"><div class="label">WHOOP</div><div class="big ${WHOOP_CONFIGURED ? "green" : "yellow"}">${WHOOP_CONFIGURED ? "ON" : "PENDIENTE"}</div></div>
  <div class="card"><div class="label">Journal</div><div class="big" style="color:#818cf8">${journalEntries.length} entradas</div></div>
  <div class="card" style="grid-column:span 2">
    <div class="label">Access Key (X-Cordelius-Key)</div>
    <div style="font-size:11px;color:#5a6674;margin-top:2px">Necesaria para acciones de escritura vía túnel público. Se guarda solo en esta sesión del navegador.</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
      <input id="corde-admin-token-input" type="password" placeholder="Token de sesión" style="background:rgba(0,0,0,.3);border:1px solid rgba(120,160,210,.25);border-radius:10px;padding:6px 10px;color:#eaf6ff;font-size:13px;width:200px">
      <button onclick="saveAdminToken()" class="btn" style="font-size:12px;padding:5px 12px">Guardar</button>
      <button onclick="clearAdminToken()" class="btn" style="font-size:12px;padding:5px 12px;border-color:rgba(255,77,109,.3);color:#ff4d6d">Limpiar</button>
      <span id="corde-admin-token-status" style="font-size:12px;color:#9fb3c8">No configurado</span>
      <a href="/logout" style="font-size:12px;color:#ff4d6d;text-decoration:none;border:1px solid rgba(255,77,109,.25);border-radius:10px;padding:5px 12px">Cerrar sesión</a>
    </div>
  </div>
</div>
</details>
</div>


<div class="disclaimer">Cordelius es un sistema personal educativo. No es asesoría financiera ni médica. Paper trading only; no se conecta a ningún exchange real.</div>
<div id="_corde_debug" data-commit="${GIT_COMMIT}" style="position:fixed;bottom:8px;right:8px;z-index:99999;background:rgba(0,0,0,.85);color:#00ff99;font-size:10px;padding:5px 9px;border-radius:8px;font-family:monospace;pointer-events:none;border:1px solid rgba(0,255,153,.3)">STACKED · ${GIT_COMMIT}</div>

<!-- ── COMMAND PALETTE (⌘K) ── -->
<div id="cmdk-overlay" onclick="if(event.target===this)closeCmdk()">
  <div id="cmdk">
    <input id="cmdk-input" placeholder="Escribe un comando o pregunta… (Esc cierra)" autocomplete="off">
    <div id="cmdk-list"></div>
    <div id="cmdk-result"></div>
    <div style="display:flex;justify-content:space-between;padding:8px 16px;border-top:1px solid rgba(120,160,210,.08)">
      <span style="font-size:10px;color:#5a6674"><span class="cmdk-kbd">↑↓</span> navegar · <span class="cmdk-kbd">↵</span> ejecutar</span>
      <span style="font-size:10px;color:#5a6674">Cordelius Command Center · educativo</span>
    </div>
  </div>
</div>
<script>
(function(){
  var DEFENSIVE = ${settings.defensiveMode ? "true" : "false"};
  var noteMode = false;
  var sel = 0;
  var ov, inp, list, result;

  function fmtLines(title, lines){ return '<b>'+title+'</b><br>'+lines.map(function(l){return '· '+esc2(l);}).join('<br>'); }
  function esc2(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function showResult(html){ result.style.display='block'; result.innerHTML=html; }
  function getJSON(url, cb){ fetch(url).then(function(r){return r.json();}).then(cb).catch(function(e){ showResult('Error: '+esc2(e.message)); }); }
  function secHeaders(extra){ try { return (typeof authHeaders==='function') ? authHeaders(extra) : (extra||{}); } catch(e){ return extra||{}; } }
  function blockedMsg(status, d){ showResult('<b style="color:#ff4d6d">Acción bloqueada ('+status+')</b><br>'+esc2((d&&d.reason)||'Mutación protegida por el Security Gate.')+'<br><span style="color:#5a6674">Guarda tu access key en System → Admin Token y reintenta.</span>'); }
  function mutate(url, opts, cb){
    var o = opts||{}; o.headers = secHeaders(o.headers||{});
    fetch(url, o).then(function(r){
      if(r.status===401||r.status===403){ r.json().then(function(d){ blockedMsg(r.status, d); }).catch(function(){ blockedMsg(r.status, null); }); return null; }
      return r.json();
    }).then(function(d){ if(d && cb) cb(d); }).catch(function(e){ showResult('Error: '+esc2(e.message)); });
  }

  var ACTIONS = [
    { label:'Brief de hoy', hint:'resumen ejecutivo', run:function(){ showResult('Cargando…'); getJSON('/api/daily-brief', function(d){ showResult(fmtLines(d.greeting||'Brief', d.lines||[])); }); } },
    { label:'Qué hago ahora', hint:'next best actions', run:function(){ showResult('Pensando…'); getJSON('/api/jarvis/brain', function(b){ showResult(fmtLines('Next best actions', b.nextActions||[]) + '<br><br><b>Focus:</b> '+esc2(b.topFocus)); }); } },
    { label:'Ver riesgo', hint:'warnings y concentración', run:function(){ showResult('Analizando…'); getJSON('/api/jarvis/brain', function(b){ var w=(b.warnings||[]).map(function(x){return '['+x.severity+'] '+x.text;}); showResult(fmtLines('Riesgo actual', w.length?w:['Sin warnings activos'])); }); } },
    { label:'Health check', hint:'WHOOP readiness', run:function(){ showResult('Cargando…'); getJSON('/api/health-readiness', function(h){ showResult(fmtLines('Health ('+esc2(h.source||'')+')', ['Recovery: '+(h.recovery!=null?h.recovery+'%':'—'),'Sleep: '+(h.sleep!=null?h.sleep+'%':'—'),'Strain: '+(h.strain!=null?(+h.strain).toFixed(1):'—'),'HRV: '+(h.hrv!=null?Math.round(h.hrv)+' ms':'—'),'Modo: '+esc2(h.operatingMode||'—')])); }); } },
    { label:'Explicar portafolio', hint:'abre Jarvis con la pregunta', run:function(){ closeCmdk(); try{ if(document.getElementById('alfredo-panel').style.display!=='block') toggleJarvis(); setJarvisQ('Explica mi portafolio: composición, riesgo y qué vigilar (educativo)'); }catch(e){} } },
    { label:'Registrar nota', hint:'guarda en Journal', run:function(){ noteMode=true; result.style.display='none'; inp.value=''; inp.placeholder='Escribe tu nota y presiona Enter… (Esc cancela)'; list.innerHTML='<div style="padding:12px 14px;font-size:12px;color:#9fb3c8">Modo nota: lo que escribas se guarda en Journal como entrada rápida.</div>'; } },
    { label:'Modo defensivo '+(DEFENSIVE?'OFF':'ON'), hint:'etiqueta educativa, sin órdenes', run:function(){ showResult('Cambiando…'); mutate('/api/mode/defensive',{method:'POST'},function(d){ DEFENSIVE=d.defensiveMode; showResult('<b>Modo defensivo: '+(d.defensiveMode?'ACTIVADO':'DESACTIVADO')+'</b><br>'+esc2(d.note)+'<br><span style="color:#5a6674">El Home lo reflejará al recargar.</span>'); }); } },
    { label:'Ver automations', hint:'reglas locales', run:function(){ showResult('Cargando…'); getJSON('/api/automations', function(a){ var f=(a.firedToday||[]).map(function(e){return '['+e.severity+'] '+e.name+': '+e.message;}); showResult(fmtLines('Reglas activas hoy', f.length?f:['Ninguna regla disparada hoy'])+'<br><span style="color:#5a6674">Cripto: '+a.criptoPct+'% del portafolio</span>'); }); } },
    { label:'Memoria de Jarvis', hint:'resumen de memoria', run:function(){ showResult('Cargando…'); getJSON('/api/jarvis/memory', function(m){ showResult('<b>Memoria</b><br>'+esc2(m.summary)); }); } },
    { label:'Ir a Jarvis', hint:'módulo', run:function(){ closeCmdk(); showMod('alfredo'); } },
    { label:'Ir a Home', hint:'módulo', run:function(){ closeCmdk(); showMod('home'); } },
    { label:'Ir a Trading', hint:'módulo', run:function(){ closeCmdk(); showMod('trading'); } },
    { label:'Ir a Health', hint:'módulo', run:function(){ closeCmdk(); showMod('health'); } },
    { label:'Ir a Journal', hint:'módulo', run:function(){ closeCmdk(); showMod('journal'); } },
    { label:'Ir a Intelligence', hint:'módulo', run:function(){ closeCmdk(); showMod('intelligence'); } },
    { label:'Ir a Autopilot', hint:'módulo', run:function(){ closeCmdk(); showMod('autopilot'); } }
  ];

  function filtered(){
    var q = (inp.value||'').toLowerCase().trim();
    if(!q) return ACTIONS;
    return ACTIONS.filter(function(a){ return (a.label+' '+a.hint).toLowerCase().indexOf(q) !== -1; });
  }
  function renderList(){
    if(noteMode) return;
    var items = filtered();
    if(sel >= items.length) sel = Math.max(0, items.length-1);
    list.innerHTML = items.length ? items.map(function(a,i){
      return '<div class="cmdk-item'+(i===sel?' sel':'')+'" data-i="'+i+'"><span>'+esc2(a.label)+'</span><span class="cmdk-hint">'+esc2(a.hint)+'</span></div>';
    }).join('') : '<div style="padding:12px 14px;font-size:13px;color:#5a6674">Sin comandos. Prueba "brief", "riesgo", "nota"…</div>';
    Array.prototype.forEach.call(list.children, function(el){
      el.onclick = function(){ var i = +el.getAttribute('data-i'); if(!isNaN(i)){ sel=i; runSel(); } };
    });
  }
  function runSel(){ var items = filtered(); if(items[sel]) items[sel].run(); }
  function saveNote(){
    var text = (inp.value||'').trim();
    if(!text) return;
    showResult('Guardando…');
    fetch('/api/journal', { method:'POST', headers:secHeaders({'Content-Type':'application/x-www-form-urlencoded'}), body:'text='+encodeURIComponent(text)+'&mood=neutral', redirect:'manual' })
      .then(function(r){
        if(r && (r.status===401||r.status===403)){ blockedMsg(r.status, null); return; }
        noteMode=false; inp.value=''; inp.placeholder='Escribe un comando o pregunta… (Esc cierra)'; renderList(); showResult('<b>Nota guardada en Journal ✓</b><br>'+esc2(text));
      })
      .catch(function(e){ showResult('Error guardando: '+esc2(e.message)); });
  }

  window.openCmdk = function(){
    ov.style.display='block'; sel=0; noteMode=false;
    inp.value=''; inp.placeholder='Escribe un comando o pregunta… (Esc cierra)';
    result.style.display='none'; renderList();
    setTimeout(function(){ inp.focus(); }, 30);
  };
  window.closeCmdk = function(){ ov.style.display='none'; noteMode=false; };
  window.cmdkOpen = function(){ return ov && ov.style.display==='block'; };

  document.addEventListener('DOMContentLoaded', init);
  if(document.readyState !== 'loading') init();
  function init(){
    if(ov) return;
    ov = document.getElementById('cmdk-overlay');
    inp = document.getElementById('cmdk-input');
    list = document.getElementById('cmdk-list');
    result = document.getElementById('cmdk-result');
    inp.addEventListener('input', function(){ sel=0; renderList(); });
    inp.addEventListener('keydown', function(e){
      if(e.key==='Escape'){ e.preventDefault(); noteMode ? window.openCmdk() : closeCmdk(); return; }
      if(noteMode){ if(e.key==='Enter'){ e.preventDefault(); saveNote(); } return; }
      if(e.key==='ArrowDown'){ e.preventDefault(); sel=Math.min(sel+1, filtered().length-1); renderList(); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); sel=Math.max(sel-1, 0); renderList(); }
      else if(e.key==='Enter'){ e.preventDefault(); runSel(); }
    });
    document.addEventListener('keydown', function(e){
      if((e.metaKey||e.ctrlKey) && (e.key==='k'||e.key==='K')){ e.preventDefault(); window.cmdkOpen() ? closeCmdk() : openCmdk(); }
      else if(e.key==='Escape' && window.cmdkOpen()) closeCmdk();
    });
  }

  // Secciones colapsables: recordar abierto/cerrado en localStorage.
  function initClps(){
    try {
      document.querySelectorAll('details.clps').forEach(function(d){
        var k = 'corde_clps_' + d.getAttribute('data-clps');
        var saved = localStorage.getItem(k);
        if (saved === '1') d.setAttribute('open',''); else if (saved === '0') d.removeAttribute('open');
        d.addEventListener('toggle', function(){ try { localStorage.setItem(k, d.open ? '1' : '0'); } catch(e){} });
      });
    } catch(e){}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initClps); else initClps();

  // Auto-reload inteligente: sustituye al meta-refresh. No recarga si el
  // palette o el chat de Jarvis están abiertos, o si estás escribiendo.
  var REFRESH_S = ${Math.max(15, Number(settings.autoRefreshSeconds) || 60)};
  setInterval(function(){
    try {
      var jar = document.getElementById('alfredo-panel');
      var typing = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if(!window.cmdkOpen() && !(jar && jar.style.display==='block') && !typing) location.reload();
    } catch(e){}
  }, REFRESH_S * 1000);
})();
</script>
</body>
<script>
var _CORDE_MODS = ['home','trading','health','journal','intelligence','alfredo','autopilot'];
function validModName(name) {
  return _CORDE_MODS.indexOf(name) !== -1;
}
// STACKED MODE: all modules are always visible, stacked vertically.
// showMod never hides anything — nav buttons only scroll to the chosen module.
function showMod(name) {
  if (!validModName(name)) name = 'alfredo';
  var selected = document.getElementById('mod-' + name);

  // Nav active state
  try {
    document.querySelectorAll('.nav-mod').forEach(function(b) { b.classList.remove('nav-active'); });
    document.querySelectorAll('[data-mod="' + name + '"]').forEach(function(b) { b.classList.add('nav-active'); });
  } catch(e) {}

  // Hash + persistence
  try {
    if (window.location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  } catch(e) {}
  try { localStorage.setItem('corde_mod', name); } catch(e) {}

  // Scroll the selected module into view
  try {
    if (selected) selected.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) {
    try { if (selected) selected.scrollIntoView(); } catch(e2) {}
  }

  // Debug label
  try {
    var _lbl = document.getElementById('_corde_debug');
    if (_lbl) _lbl.textContent = 'STACKED · ' + (_lbl.getAttribute('data-commit') || '') + ' · ' + (window.location.hash || '#' + name);
  } catch(e) {}

  // Module-specific data loaders
  try { if (name === 'health') loadHealthOS(); } catch(e) {}
  try { if (name === 'journal') loadJournalAuto(); } catch(e) {}
  try { if (name === 'intelligence') loadIntelligenceFeed(); } catch(e) {}
  try { if (name === 'alfredo') loadJarvisContext(); } catch(e) {}
  try { if (name === 'autopilot') { loadAutopilotDatabase(); loadOpportunityEngine(); } } catch(e) {}
}
window.showMod = showMod;

// Scroll-spy: keep the nav button of the module in view highlighted while scrolling.
(function() {
  var ticking = false;
  function currentModInView() {
    var probe = window.innerHeight * 0.33;
    var mods = document.querySelectorAll('.mod');
    var cur = null;
    for (var i = 0; i < mods.length; i++) {
      if (mods[i].getBoundingClientRect().top <= probe) cur = mods[i].id.replace('mod-', '');
    }
    return cur || (mods[0] ? mods[0].id.replace('mod-', '') : null);
  }
  function syncNav() {
    ticking = false;
    try {
      var name = currentModInView();
      if (!name) return;
      document.querySelectorAll('.nav-mod').forEach(function(b) { b.classList.remove('nav-active'); });
      document.querySelectorAll('[data-mod="' + name + '"]').forEach(function(b) { b.classList.add('nav-active'); });
    } catch (e) {}
  }
  window.addEventListener('scroll', function() {
    if (ticking) return;
    ticking = true;
    if (window.requestAnimationFrame) requestAnimationFrame(syncNav); else setTimeout(syncNav, 120);
  }, { passive: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncNav); else syncNav();
})();

function healthSet(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
}
function healthMetric(value, suffix) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && !Number.isFinite(value)) return '—';
  var text = typeof value === 'number' && Math.round(value * 10) !== value * 10 ? value.toFixed(1) : String(value);
  return suffix ? text + suffix : text;
}
function applyWhoopToday(d) {
  if (!d || typeof d !== 'object') return;
  healthSet('health-recovery', healthMetric(d.recovery, '%'));
  healthSet('health-sleep', healthMetric(d.sleep, '%'));
  healthSet('health-strain', healthMetric(d.strain, ''));
  healthSet('health-avg-hr', healthMetric(d.averageHeartRate, ' bpm'));
  healthSet('health-max-hr', healthMetric(d.maxHeartRate, ' bpm'));
  healthSet('health-hrv', healthMetric(d.hrv, ' ms'));
  healthSet('health-resting-hr', healthMetric(d.restingHeartRate, ' bpm'));
  healthSet('health-operating-mode', d.operatingMode || d.mode || 'NORMAL');
  healthSet('home-recovery', healthMetric(d.recovery, '%'));
  healthSet('home-sleep', healthMetric(d.sleep, '%'));
  healthSet('home-strain', healthMetric(d.strain, ''));
  healthSet('home-hrv', healthMetric(d.hrv, ' ms'));
  healthSet('home-operating-mode', d.operatingMode || d.mode || 'NORMAL');

  var homeLine = document.getElementById('home-alfredo-line');
  if (homeLine) homeLine.textContent = d.alfredoAdvice || d.suggestion || 'Cordelius listo: revisa salud, portafolio y contexto antes de decidir.';
  var homeQuestion = document.getElementById('home-alfredo-question');
  if (homeQuestion) {
    if (d.strain != null && d.strain >= 10) homeQuestion.textContent = 'Veo strain alto; ¿quieres que Jarvis limite el paper trading a observación?';
    else if (d.recovery != null && d.sleep != null && d.recovery >= 75 && d.sleep >= 80) homeQuestion.textContent = 'Buen recovery y sleep; ¿quieres revisar ideas educativas sin ejecutar nada?';
    else homeQuestion.textContent = '¿Quieres que Jarvis conecte salud, BBVA y noticias antes de revisar el día?';
  }
  var contextLine = document.getElementById('alfredo-context-line');
  if (contextLine) contextLine.textContent = d.alfredoAdvice || 'Jarvis no tiene datos WHOOP completos todavía.';
  var contextQuestion = document.getElementById('alfredo-context-question');
  if (contextQuestion) contextQuestion.textContent = homeQuestion ? homeQuestion.textContent : '¿Qué módulo quieres revisar primero?';

  var badge = document.getElementById('health-whoop-badge');
  if (badge) {
    var connected = d.connected === true;
    badge.textContent = connected ? 'WHOOP DETECTADO' : 'WHOOP PENDIENTE';
    badge.style.background = connected ? 'rgba(0,255,153,.15)' : 'rgba(255,211,92,.12)';
    badge.style.color = connected ? '#00ff99' : '#ffd35c';
  }

  var advice = document.getElementById('health-advice');
  if (advice) {
    advice.textContent = d.alfredoAdvice || d.suggestion || d.message || 'Esperando datos de WHOOP.';
  }
}
async function loadWhoopToday() {
  var panel = document.getElementById('health-readiness-panel');
  if (!panel || panel.dataset.loading === '1') return;
  panel.dataset.loading = '1';
  try {
    var response = await fetch('/api/whoop/today', { cache: 'no-store' });
    if (!response.ok) throw new Error('WHOOP HTTP ' + response.status);
    applyWhoopToday(await response.json());
  } catch (e) {
    var advice = document.getElementById('health-advice');
    if (advice) advice.textContent = 'No se pudo refrescar WHOOP en el panel. Revisa /api/whoop/today.';
  } finally {
    panel.dataset.loading = '0';
  }
}

function applyJournalAuto(d) {
  if (!d || typeof d !== 'object') return;
  healthSet('journal-auto-source', d.source || 'WHOOP + Cordelius');
  healthSet('journal-auto-mood', d.moodEstimated || d.mood || '—');
  healthSet('journal-auto-body', d.bodyState || '—');
  healthSet('journal-auto-trading-mode', d.tradingModeSuggestion || d.operatingMode || '—');
  var recovery = d.recovery != null ? d.recovery + '%' : '—';
  var sleep = d.sleep != null ? d.sleep + '%' : '—';
  var strain = d.strain != null ? d.strain : '—';
  healthSet('journal-auto-whoop', 'R ' + recovery + ' · S ' + sleep + ' · Strain ' + strain);
  healthSet('journal-auto-note', d.alfredoNote || d.alfredoAdvice || d.summary || 'Bitácora automática lista.');
}
async function loadJournalAuto() {
  if (!document.getElementById('journal-auto-preview')) return;
  try {
    var response = await fetch('/api/journal/auto', { cache: 'no-store' });
    if (!response.ok) throw new Error('Journal HTTP ' + response.status);
    applyJournalAuto(await response.json());
  } catch (e) {
    healthSet('journal-auto-note', 'No se pudo cargar /api/journal/auto en la UI.');
  }
}
function applyJarvisContext(d) {
  if (!d || typeof d !== 'object') return;
  healthSet('alfredo-context-line', d.alfredoOneLiner || d.oneLiner || 'Jarvis listo.');
  healthSet('alfredo-context-question', d.alfredoQuestion || d.question || '¿Qué módulo quieres revisar primero?');
}
async function loadJarvisContext() {
  if (!document.getElementById('alfredo-context-line')) return;
  try {
    var response = await fetch('/api/alfredo/context', { cache: 'no-store' });
    if (!response.ok) throw new Error('Jarvis HTTP ' + response.status);
    applyJarvisContext(await response.json());
  } catch (e) {}
}
function clientEsc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
    return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch];
  });
}
function applyIntelligenceFeed(d) {
  var list = document.getElementById('intelligence-feed-list');
  if (!list || !d || !Array.isArray(d.items)) return;
  if (!d.items.length) {
    list.innerHTML = '<div class="muted" style="padding:14px 0">Pendiente de proveedor de noticias. No se inventan noticias reales.</div>';
    return;
  }
  list.innerHTML = d.items.slice(0, 5).map(function(x) {
    var date = x.publishedDate || x.eventDate || 'sin fecha';
    var badge = x.delayBadge || (x.delayDays == null ? 'unknown' : x.delayDays <= 0 ? 'LIVE' : x.delayDays <= 7 ? '1-7d' : x.delayDays <= 30 ? '8-30d' : 'stale');
    return '<div style="display:grid;grid-template-columns:86px 92px 1fr 70px;gap:8px;align-items:center;border-top:1px solid rgba(120,160,210,.08);padding:9px 0">'
      + '<div style="font-weight:900;color:#eaf6ff;font-size:12px">' + clientEsc(x.ticker || 'MARKET') + '</div>'
      + '<div class="muted" style="font-size:11px">' + clientEsc(date) + '</div>'
      + '<div style="min-width:0"><div style="font-size:12px;color:#dbeafe;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + clientEsc(x.summary || 'Contexto pendiente') + '</div><div class="muted" style="font-size:10px">' + clientEsc(x.source || 'source') + ' · ' + clientEsc(x.type || 'news') + ' · ' + clientEsc(x.sentiment || 'uncertain') + '</div></div>'
      + '<div style="text-align:right"><span style="border:1px solid rgba(0,255,153,.2);border-radius:999px;padding:3px 7px;color:#00ff99;font-size:10px">' + clientEsc(badge) + '</span></div>'
      + '</div>';
  }).join('');
}
async function loadIntelligenceFeed() {
  if (!document.getElementById('intelligence-feed-list')) return;
  try {
    var response = await fetch('/api/intelligence/feed', { cache: 'no-store' });
    if (!response.ok) throw new Error('Intel HTTP ' + response.status);
    applyIntelligenceFeed(await response.json());
  } catch (e) {}
}

function escapeHtml(value) { return clientEsc(value); }
function fmtPct(value) { return value === null || value === undefined || value === '' ? '—' : Math.round(Number(value)) + '%'; }
function fmtNum(value, suffix) { return value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? '—' : (Math.round(Number(value) * 10) / 10) + (suffix || ''); }
function scoreColor(value) { var n = Number(value || 0); return n >= 80 ? '#00ff99' : n >= 65 ? '#9be15d' : n >= 50 ? '#ffd35c' : n >= 35 ? '#fb7185' : '#ff4d6d'; }
function renderDonut(label, value, suffix) { var n = Math.max(0, Math.min(100, Number(value || 0))); var color = scoreColor(n); return '<div><div style="width:168px;height:168px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(' + color + ' ' + (n * 3.6) + 'deg, rgba(255,255,255,.08) 0deg);box-shadow:0 0 38px ' + color + '22"><div style="width:118px;height:118px;border-radius:50%;display:grid;place-items:center;background:#06101f;border:1px solid rgba(255,255,255,.08)"><div><div style="font-size:34px;font-weight:950;color:' + color + '">' + (value == null ? '—' : Math.round(Number(value))) + (suffix || '') + '</div><div class="health-os-label">' + escapeHtml(label) + '</div></div></div></div></div>'; }
function renderRadarSvg(data) { var labels = ['recovery','sleep','hrv','nervousSystem','energy','focus']; var names = ['Recovery','Sleep','HRV','Nervous','Energy','Focus']; var cx = 150, cy = 135, r = 96; var pts = labels.map(function(k, i) { var a = -Math.PI / 2 + i * Math.PI * 2 / labels.length; var v = Math.max(0, Math.min(100, Number((data || {})[k] || 0))) / 100; return [cx + Math.cos(a) * r * v, cy + Math.sin(a) * r * v]; }); var grid = [25,50,75,100].map(function(p) { var rr = r * p / 100; return '<polygon points="' + labels.map(function(_, i) { var a = -Math.PI / 2 + i * Math.PI * 2 / labels.length; return (cx + Math.cos(a) * rr) + ',' + (cy + Math.sin(a) * rr); }).join(' ') + '" fill="none" stroke="rgba(255,255,255,.08)"/>'; }).join(''); var axes = labels.map(function(_, i) { var a = -Math.PI / 2 + i * Math.PI * 2 / labels.length; return '<line x1="'+cx+'" y1="'+cy+'" x2="'+(cx+Math.cos(a)*r)+'" y2="'+(cy+Math.sin(a)*r)+'" stroke="rgba(255,255,255,.08)"/><text x="'+(cx+Math.cos(a)*(r+28))+'" y="'+(cy+Math.sin(a)*(r+28))+'" fill="#9fb3c8" font-size="11" text-anchor="middle">'+names[i]+'</text>'; }).join(''); return '<svg viewBox="0 0 300 280" width="100%" height="280">' + grid + axes + '<polygon points="' + pts.map(function(p){return p[0]+','+p[1];}).join(' ') + '" fill="rgba(244,114,182,.24)" stroke="#f472b6" stroke-width="3"/></svg>'; }
function renderSparklineSvg(values, color) { var nums = (values || []).filter(function(v){ return typeof v === 'number' && Number.isFinite(v); }); if (nums.length < 2) return '<div class="muted" style="padding:12px">Recolectando datos.</div>'; var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums), span = max - min || 1; var pts = nums.map(function(v, i){ return (i * 180 / (nums.length - 1)) + ',' + (34 - ((v - min) / span * 28)); }).join(' '); return '<svg viewBox="0 0 180 42" width="100%" height="42"><polyline points="'+pts+'" fill="none" stroke="'+(color||'#00ff99')+'" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function renderHealthScoreCard(label, value) { return '<div class="health-os-metric"><div class="health-os-label">'+escapeHtml(label)+'</div><div class="health-os-value" style="color:'+scoreColor(value)+'">'+fmtNum(value, '')+'</div></div>'; }
function renderBehaviorChips(behaviors) { var items = [['sauna','Sauna'],['cannabis','Cannabis'],['training','Training'],['stress','High Stress'],['lateCaffeine','Late Caffeine'],['alcohol','Alcohol']]; return items.map(function(x){ var on = behaviors && behaviors[x[0]]; return '<button class="health-os-chip '+(on?'active':'')+'" data-health-behavior="'+escapeHtml(x[0])+'" onclick="toggleHealthBehavior(this.dataset.healthBehavior)">'+escapeHtml(x[1])+'</button>'; }).join(''); }
async function toggleHealthBehavior(key) { try { var response = await secureFetch('/api/health/behavior', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ behavior:key }) }); if (response.ok) await loadHealthOS(); } catch(e) {} }
function applyHealthOS(snapshot, insights, behaviors) { var latest = (snapshot && snapshot.latest) || {}; var scores = latest.scores || (snapshot && snapshot.scores) || {}; healthSet('health-os-updated', latest.ts ? new Date(latest.ts).toLocaleString('es-MX') : 'sin dato'); healthSet('health-os-recovery', fmtPct(latest.recovery)); healthSet('health-os-sleep', fmtPct(latest.sleep)); healthSet('health-os-strain', fmtNum(latest.strain, '')); healthSet('health-os-hrv', fmtNum(latest.hrv, ' ms')); healthSet('health-os-rhr', fmtNum(latest.restingHeartRate, ' bpm')); healthSet('health-os-readiness', fmtPct(scores.readiness)); healthSet('health-os-score', fmtNum(scores.healthScore, '')); healthSet('health-os-status', scores.status || '—'); healthSet('health-os-mode', latest.operatingMode || 'NORMAL'); var badge = document.getElementById('health-os-whoop-badge'); if (badge) { badge.textContent = latest.connected ? 'WHOOP LIVE' : 'WHOOP FALLBACK'; badge.classList.toggle('fallback', !latest.connected); } var reconnect = document.getElementById('health-os-reconnect'); if (reconnect) reconnect.style.display = latest.connected ? 'none' : 'inline-flex'; var scoreEl = document.getElementById('health-os-score'); if (scoreEl) scoreEl.style.color = scoreColor(scores.healthScore); var d1 = document.getElementById('health-os-donut-recovery'); if (d1) d1.innerHTML = renderDonut('Recovery', latest.recovery, '%'); var d2 = document.getElementById('health-os-donut-sleep'); if (d2) d2.innerHTML = renderDonut('Sleep', latest.sleep, '%'); var d3 = document.getElementById('health-os-donut-strain'); if (d3) d3.innerHTML = renderDonut('Strain', Math.min(100, Number(latest.strain || 0) * 5), ''); var radar = document.getElementById('health-os-radar'); if (radar) radar.innerHTML = renderRadarSvg(scores.radar || {}); var scoreList = document.getElementById('health-os-score-list'); if (scoreList) scoreList.innerHTML = [['Mental Clarity', scores.mentalClarity], ['Energy', scores.energy], ['Nervous System', scores.nervousSystem], ['Overtrading Risk', 100 - (scores.overtradingRisk || 0)], ['Stress Load', 100 - (scores.stressLoad || 0)], ['Recovery Priority', 100 - (scores.recoveryPriority || 0)]].map(function(x){ return renderHealthScoreCard(x[0], x[1]); }).join(''); healthSet('health-os-energy-physical', fmtNum(scores.physicalEnergy, '')); healthSet('health-os-energy-mental', fmtNum(scores.mentalEnergy, '')); healthSet('health-os-energy-focus', fmtNum(scores.focusCapacity, '')); healthSet('health-os-energy-deepwork', fmtNum(scores.deepWorkCapacity, '')); healthSet('health-os-energy-trading', fmtNum(scores.tradingCapacity, '')); healthSet('health-os-ai', (insights && insights.alfredoHealthAI) || (snapshot && snapshot.alfredoHealthAI) || 'Sin insight todavía.'); var history = document.getElementById('health-os-history'); if (history) { var h = (snapshot && snapshot.history) || []; var row = function(label, field, color) { var vals = h.map(function(x){ return x[field]; }); var last = vals.filter(function(v){return typeof v === 'number';}).slice(-1)[0]; return '<div class="health-os-history-row"><b>'+label+'</b><div class="health-os-trend">'+renderSparklineSvg(vals.slice(-30), color)+'</div><span>'+fmtNum(last, field === 'strain' ? '' : (field === 'hrv' ? ' ms' : '%'))+'</span></div>'; }; history.innerHTML = row('Recovery 7d / 30d','recovery','#f472b6') + row('Sleep 7d / 30d','sleep','#818cf8') + row('HRV 7d / 30d','hrv','#00ff99') + row('Strain 7d / 30d','strain','#ffd35c'); } var corr = document.getElementById('health-os-correlations'); if (corr) { var c = (snapshot && snapshot.correlations) || {}; corr.innerHTML = c.ready ? (c.items || []).map(function(i){ return '<div class="health-os-risk"><b>'+escapeHtml(i.label)+'</b><br><span class="muted">Delta: '+(i.value == null ? 'insuficiente' : i.value)+'</span></div>'; }).join('') : '<div class="muted">Recolectando datos. Se activará con 3+ días de snapshots.</div>'; } var beh = document.getElementById('health-os-behaviors'); if (beh) beh.innerHTML = renderBehaviorChips((behaviors && behaviors.behaviors) || {}); var risk = document.getElementById('health-os-trading-risk'); if (risk) risk.innerHTML = 'Recovery &lt; 50 ⇒ DEFENSIVE / reducir riesgo educativo.<br>Recovery &gt; 80 ⇒ NORMAL.<br>Strain alto ⇒ bajar agresividad.<br>Overtrading Risk actual: <b style="color:'+scoreColor(100 - (scores.overtradingRisk || 0))+'">'+fmtNum(scores.overtradingRisk, '')+'</b>. No operar impulsivo.'; }
async function loadHealthOS() { if (!document.getElementById('health-os-score')) return; try { var responses = await Promise.all([fetch('/api/health/snapshot', { cache:'no-store' }), fetch('/api/health/insights', { cache:'no-store' }), fetch('/api/health/behaviors/today', { cache:'no-store' })]); var snapshot = responses[0].ok ? await responses[0].json() : null; var insights = responses[1].ok ? await responses[1].json() : null; var behaviors = responses[2].ok ? await responses[2].json() : null; if (!snapshot || !snapshot.ok) { var fallback = await fetch('/api/whoop/today', { cache:'no-store' }); var whoop = fallback.ok ? await fallback.json() : {}; snapshot = { ok:true, latest: whoop, scores: {}, history: [] }; } applyHealthOS(snapshot, insights, behaviors); } catch(e) { healthSet('health-os-ai', 'No se pudo cargar Health OS. Revisa /api/health/snapshot.'); } }

function autopilotSet(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
}
function applyAutopilotDatabase(d) {
  if (!d || !d.ok) return;
  var counts = d.counts || {};
  autopilotSet('autopilot-db-health', counts.health || 0);
  autopilotSet('autopilot-db-portfolio', counts.portfolio || 0);
  autopilotSet('autopilot-db-trading', counts.decisions || 0);
  autopilotSet('autopilot-db-last', d.lastUpdated ? new Date(d.lastUpdated).toLocaleString('es-MX') : 'Sin snapshots');
  var p7 = d.progress && d.progress.sevenDays;
  autopilotSet('autopilot-db-learning', p7 && p7.enoughData ? 'LEARNING' : 'COLLECTING');
  var box = document.getElementById('autopilot-db-progress');
  if (box) box.textContent = d.educationalNote || 'Cordelius empieza a aprender de tu salud, portafolio y decisiones.';
}
async function loadAutopilotDatabase() {
  if (!document.getElementById('autopilot-db-health')) return;
  try {
    var response = await fetch('/api/autopilot/database', { cache:'no-store' });
    if (!response.ok) throw new Error('database HTTP ' + response.status);
    applyAutopilotDatabase(await response.json());
  } catch(e) {
    autopilotSet('autopilot-db-learning', 'ERROR');
  }
}
async function saveAutopilotSnapshot() {
  var box = document.getElementById('autopilot-db-progress');
  if (box) box.textContent = 'Guardando snapshot local...';
  try {
    var response = await secureFetch('/api/autopilot/snapshot', { method:'POST', cache:'no-store' });
    var data = response.ok ? await response.json() : null;
    if (box) box.textContent = data && data.ok ? 'Snapshot guardado. Operating mode: ' + (data.operatingMode || 'NORMAL') : 'No se pudo guardar snapshot.';
    await loadAutopilotDatabase();
  } catch(e) {
    if (box) box.textContent = 'Error guardando snapshot.';
  }
}
async function renderAutopilotProgress() {
  var box = document.getElementById('autopilot-db-progress');
  if (!box) return;
  try {
    var response = await fetch('/api/autopilot/progress', { cache:'no-store' });
    var d = response.ok ? await response.json() : null;
    if (!d || !d.ok) throw new Error('progress error');
    var p7 = d.sevenDays || {}, p30 = d.thirtyDays || {};
    box.innerHTML = '7d: ' + (p7.enoughData ? 'learning' : 'recolectando') + ' · health ' + ((p7.counts && p7.counts.health) || 0) + ' · portfolio ' + ((p7.counts && p7.counts.portfolio) || 0) + ' · decisions ' + ((p7.counts && p7.counts.decisions) || 0) + '<br>30d: ' + (p30.enoughData ? 'learning' : 'recolectando') + ' · health ' + ((p30.counts && p30.counts.health) || 0) + ' · portfolio ' + ((p30.counts && p30.counts.portfolio) || 0) + ' · decisions ' + ((p30.counts && p30.counts.decisions) || 0);
  } catch(e) {
    box.textContent = 'No se pudo calcular progreso todavía.';
  }
}

function renderOpportunityLists(d) {
  if (!d || !d.ok) return;
  var top = document.getElementById('opportunity-top-list');
  if (top) top.innerHTML = (d.topOpportunities || []).slice(0,3).map(function(x){ return '<div style="border-top:1px solid rgba(120,160,210,.08);padding:8px 0"><b style="color:#eaf6ff">'+clientEsc(x.symbol)+'</b> <span style="color:#00ff99;font-weight:900">'+clientEsc(x.score)+'/100</span><div class="muted" style="font-size:11px">'+clientEsc(x.signal || '')+' · '+clientEsc(x.reason || '')+'</div></div>'; }).join('') || '<div class="muted">Sin oportunidades todavía.</div>';
  var risks = document.getElementById('opportunity-risk-list');
  if (risks) risks.innerHTML = (d.topRisks || []).slice(0,3).map(function(x){ return '<div style="border-top:1px solid rgba(120,160,210,.08);padding:8px 0"><b style="color:#eaf6ff">'+clientEsc(x.symbol)+'</b> <span style="color:#ff4d6d;font-weight:900">riesgo '+clientEsc(x.riskScore)+'/100</span><div class="muted" style="font-size:11px">'+clientEsc(x.reason || '')+'</div></div>'; }).join('') || '<div class="muted">Sin riesgos nuevos.</div>';
  var queue = document.getElementById('opportunity-queue-list');
  if (queue) queue.innerHTML = (d.researchQueue || []).length ? d.researchQueue.slice(0,8).map(function(s){ return '<span style="display:inline-flex;border:1px solid rgba(59,157,255,.24);border-radius:999px;padding:4px 9px;margin:2px;color:#9bd3ff;font-size:11px;font-weight:900">'+clientEsc(s)+'</span>'; }).join('') : '<span class="muted">Queue vacía</span>';
  var watch = document.getElementById('opportunity-watchlist-list');
  if (watch) watch.innerHTML = (d.watchlistCandidates || []).slice(0,6).map(function(x){ return '<span style="display:inline-flex;border:1px solid rgba(0,255,153,.18);border-radius:999px;padding:4px 9px;margin:2px;color:#00ff99;font-size:11px;font-weight:900">'+clientEsc(x.symbol)+' '+clientEsc(x.score)+'</span>'; }).join('') || '<span class="muted">Sin candidatos</span>';
}
async function loadOpportunityEngine() {
  if (!document.getElementById('opportunity-top-list')) return;
  try { var r = await fetch('/api/opportunities', { cache:'no-store' }); if (r.ok) renderOpportunityLists(await r.json()); } catch(e) {}
}
async function runOpportunityEngine() {
  var box = document.getElementById('opportunity-research-result');
  if (box) box.textContent = 'Ejecutando Opportunity Engine...';
  try { var r = await secureFetch('/api/opportunities/run', { method:'POST', cache:'no-store' }); var d = r.ok ? await r.json() : null; if (d) renderOpportunityLists(d); if (box) box.textContent = d && d.ok ? 'Engine actualizado: '+((d.topOpportunities||[])[0] ? (d.topOpportunities[0].symbol + ' ' + d.topOpportunities[0].score + '/100') : 'sin oportunidades') : 'No se pudo ejecutar.'; } catch(e) { if (box) box.textContent = 'Error ejecutando opportunities.'; }
}
async function analyzeOpportunitySymbol() {
  var input = document.getElementById('opportunity-research-symbol');
  var box = document.getElementById('opportunity-research-result');
  var symbol = input && input.value ? input.value.trim().toUpperCase() : 'NVDA';
  if (box) box.textContent = 'Analizando '+symbol+'...';
  try { var r = await fetch('/api/research/stock?symbol=' + encodeURIComponent(symbol), { cache:'no-store' }); var d = r.ok ? await r.json() : null; if (box) box.innerHTML = d && d.ok ? '<b>'+clientEsc(d.symbol)+'</b> · score '+clientEsc(d.score)+'/100 · riesgo '+clientEsc(d.riskScore)+'/100 · '+clientEsc(d.signal)+'<br>'+clientEsc(d.thesis)+'<br><span class="muted">'+clientEsc(d.educationalNote)+'</span>' : 'No se pudo analizar el ticker.'; await loadOpportunityEngine(); } catch(e) { if (box) box.textContent = 'Error analizando ticker.'; }
}

function toggleJarvis() {

  var p = document.getElementById('alfredo-panel');
  if (p) p.style.display = (p.style.display === 'none' || p.style.display === '') ? 'block' : 'none';
}
function setJarvisQ(q) {
  var inp = document.querySelector('#alfredo-panel [name=q]');
  if (inp) { inp.value = q; }
  var p = document.getElementById('alfredo-panel');
  if (p) p.style.display = 'block';
}
// ---- Portfolio chart range selector ----
function redrawPortChart(days) {
  document.querySelectorAll('.range-btn').forEach(function(b) {
    b.classList.remove('rb-active');
    if (Number(b.dataset.days) === days) b.classList.add('rb-active');
  });
  var all = window._portHistory || [];
  var cutoff = days === 0 ? 0 : Date.now() - days * 86400000;
  var data = days === 0 ? all : all.filter(function(d) { return d.t >= cutoff; });
  var area = document.getElementById('port-chart-area');
  var info = document.getElementById('port-chart-info');
  if (!area) return;
  if (data.length < 2) {
    area.innerHTML = '<div style="min-height:240px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px">Sin datos suficientes para este período (' + (days===0?'Todo':days+'D') + ')</div>';
    if (info) info.textContent = '0 snapshots en rango';
    return;
  }
  var vals = data.map(function(d) { return d.total; });
  var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
  var rng = mx - mn || 1;
  var pH = 280, pW = 940, padT = 28, padB = 40, padL = 72, plotH = pH - padT - padB;
  var gid = 'pg' + Date.now();
  var color = '#3b9dff';
  var xy = data.map(function(d, i) {
    return { x: padL + (i / Math.max(1, data.length - 1)) * pW, y: padT + (1 - ((d.total - mn) / rng)) * plotH, t: d.t, v: d.total };
  });
  var pts = xy.map(function(p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
  var areaPts = padL + ',' + (pH - padB) + ' ' + pts + ' ' + (padL + pW) + ',' + (pH - padB);
  var delta = vals[0] ? ((vals[vals.length-1] - vals[0]) / Math.abs(vals[0]) * 100) : 0;
  function fv(v) { return v >= 10000 ? '$' + (v/1000).toFixed(1) + 'k' : v.toFixed(0); }
  var yT = ''; for (var i = 0; i <= 4; i++) { var v = mn + (i/4)*rng; var y = padT + (1 - i/4)*plotH; yT += '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(padL+pW)+'" y2="'+y.toFixed(1)+'" stroke="rgba(255,255,255,.07)"/>'; yT += '<text x="'+(padL-5)+'" y="'+(y+5).toFixed(1)+'" fill="#9fb3c8" font-size="15" text-anchor="end">'+fv(v)+'</text>'; }
  var xStep = Math.ceil(data.length / 6); var xT = '';
  data.forEach(function(d, i) { if (i % xStep !== 0 && i !== data.length-1) return; var p = xy[i]; var lbl = new Date(d.t).toLocaleDateString('es-MX',{month:'short',day:'numeric'}); xT += '<text x="'+p.x.toFixed(1)+'" y="'+(pH-6)+'" fill="#9fb3c8" font-size="13" text-anchor="middle">'+lbl+'</text>'; });
  var svg = '<svg viewBox="0 0 '+(padL+pW+20)+' '+pH+'" style="width:100%;overflow:visible">'
    + '<defs><linearGradient id="'+gid+'" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity=".32"/><stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>'
    + '<line x1="'+padL+'" y1="'+(pH-padB)+'" x2="'+(padL+pW)+'" y2="'+(pH-padB)+'" stroke="rgba(255,255,255,.18)"/>'
    + '<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(pH-padB)+'" stroke="rgba(255,255,255,.18)"/>'
    + yT + xT
    + '<text x="'+(padL+pW/2)+'" y="22" fill="'+(delta>=0?'#00ff99':'#ff4d6d')+'" font-size="17" text-anchor="middle" font-weight="bold">'+(delta>=0?'+':'')+delta.toFixed(2)+'%</text>'
    + '<polygon points="'+areaPts+'" fill="url(#'+gid+')"/>'
    + '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
  area.innerHTML = svg;
  if (info) info.textContent = data.length + ' snapshots · ' + new Date(data[data.length-1].t).toLocaleString('es-MX');
}

// ---- Stock ticker research ----
async function researchTicker() {
  var input = document.getElementById('research-ticker');
  var result = document.getElementById('research-result');
  var ticker = input ? input.value.toUpperCase().replace(/[^A-Z0-9.]/g,'').slice(0,10) : '';
  if (!ticker || !result) return;
  result.innerHTML = '<div style="color:#9fb3c8;padding:10px 0;font-size:13px">Investigando <b style="color:#3b9dff">' + ticker + '</b>…</div>';
  try {
    var r = await fetch('/research', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'ticker='+encodeURIComponent(ticker) });
    var d = await r.json();
    if (d.ok) {
      result.innerHTML = '<div style="background:rgba(59,157,255,.05);border:1px solid rgba(59,157,255,.15);border-radius:16px;padding:18px 20px;margin-top:6px">'
        + '<div style="font-size:10px;font-weight:900;letter-spacing:.14em;color:#3b9dff;margin-bottom:10px">ANÁLISIS · ' + d.ticker + '</div>'
        + '<div style="font-size:14px;color:#dbeafe;line-height:1.75">'
        + String(d.reply || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').split(String.fromCharCode(10)).join('<br>').replace(/\\*\\*(.*?)\\*\\*/g,'<b>$1</b>')
        + '</div></div>';
    } else {
      result.innerHTML = '<div style="color:#ff4d6d;font-size:13px;padding:8px 0">Error: ' + (d.error||'desconocido') + '</div>';
    }
  } catch(e) {
    result.innerHTML = '<div style="color:#ff4d6d;font-size:13px;padding:8px 0">Error de conexión.</div>';
  }
}

function _cordeliusInit() {
  // STACKED MODE: every module is already visible; load all data sources up front.
  try { loadHealthOS(); } catch(e) {}
  try { loadJournalAuto(); } catch(e) {}
  try { loadJarvisContext(); } catch(e) {}
  try { loadIntelligenceFeed(); } catch(e) {}
  try { loadAutopilotDatabase(); } catch(e) {}
  try { loadOpportunityEngine(); } catch(e) {}
  try {
    var _lbl = document.getElementById('_corde_debug');
    if (_lbl) _lbl.textContent = 'STACKED · ' + (_lbl.getAttribute('data-commit') || '') + ' · ' + (window.location.hash || '#home');
  } catch(e) {}
  // Only scroll when the URL carries an explicit module hash
  var hashMod = (window.location.hash || '').replace('#', '').split('?')[0];
  if (validModName(hashMod)) showMod(hashMod);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _cordeliusInit);
} else {
  _cordeliusInit();
}
window.addEventListener('hashchange', function() {
  var hashMod = (window.location.hash || '').replace('#', '').split('?')[0];
  showMod(validModName(hashMod) ? hashMod : 'alfredo');
});
function getAdminToken(){try{return sessionStorage.getItem('corde_admin_token')||'';}catch(e){return '';}}
function saveAdminToken(){var v=(document.getElementById('corde-admin-token-input')||{}).value||'';try{sessionStorage.setItem('corde_admin_token',v);}catch(e){}var st=document.getElementById('corde-admin-token-status');if(st){st.textContent=v?'Configurado (sesión)':'No configurado';st.style.color=v?'#4ade80':'';}};
function clearAdminToken(){try{sessionStorage.removeItem('corde_admin_token');}catch(e){}var st=document.getElementById('corde-admin-token-status');if(st){st.textContent='No configurado';st.style.color='';}}
function authHeaders(extra){var t=(typeof window!=='undefined'&&window.CORDELIUS_ACCESS_KEY)||getAdminToken();var h=Object.assign({},extra||{});if(t){h['X-Admin-Token']=t;h['X-Cordelius-Key']=t;}return h;}
async function secureFetch(url,opts){var o=Object.assign({},opts||{});o.headers=authHeaders(o.headers||{});return fetch(url,o);}
async function cordeliusMutate(url){await secureFetch(url,{method:'GET'});location.reload();}
async function cordeliusFormPost(form,redirect){var p=new URLSearchParams(new FormData(form));await secureFetch(form.action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:p.toString()});location.href=redirect||'/';}
(function(){function _ai(){var t=getAdminToken();var st=document.getElementById('corde-admin-token-status');if(st&&t){st.textContent='Configurado (sesión)';st.style.color='#4ade80';}}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',_ai);}else{_ai();}})();
</script>
</html>`;
}

async function handleAsk(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    const q = new URLSearchParams(body).get("q") || "";
    if (q.trim()) await alfredoReply(q.trim());
    res.writeHead(302, { Location: "/" }); res.end();
  });
}


async function handleIntel(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    const text = new URLSearchParams(body).get("intel") || "";
    if (text.trim()) {
      const item = analyzeIntelText(text.trim());
      const isDup = intelItems.some(x => x.hash && x.hash === item.hash);
      if (!isDup) {
        intelItems.unshift(item);
        intelItems = intelItems.slice(0, 30);
        saveJSON(INTEL_FILE, intelItems);
        addThought("Nuevo analisis manual agregado a Cordelius Intelligence.", "scan");
      }
    }
    res.writeHead(302, { Location: "/#intel" });
    res.end();
  });
}

function handleIntelDelete(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const id = new URLSearchParams(body).get("id") || "";
    if (id) {
      intelItems = intelItems.filter(x => x.hash !== id);
      saveJSON(INTEL_FILE, intelItems);
    }
    res.writeHead(302, { Location: "/#intel" });
    res.end();
  });
}

function handleIntelClear(req, res) {
  intelItems = [];
  saveJSON(INTEL_FILE, intelItems);
  addThought("Intel limpiado: todos los analisis borrados.", "warn");
  res.writeHead(302, { Location: "/#intel" });
  res.end();
}

function handleJournal(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const p = new URLSearchParams(body);
    const text = (p.get("text") || "").trim();
    if (text) {
      const entry = {
        id: Date.now(),
        date: nowMX(),
        text,
        mood: p.get("mood") || "neutral",
        energy: parseInt(p.get("energy") || "0") || null,
        tags: (p.get("tags") || "").split(",").map(t => t.trim()).filter(Boolean)
      };
      saveJournalEntry(entry);
    }
    res.writeHead(302, { Location: "/" }); res.end();
  });
}


function handleHealthBehavior(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    let behavior = "";
    try { const parsed = JSON.parse(body || "{}"); behavior = parsed.behavior || ""; }
    catch(e) { behavior = new URLSearchParams(body).get("behavior") || ""; }
    const allowed = new Set(["sauna", "cannabis", "training", "stress", "lateCaffeine", "alcohol"]);
    if (!allowed.has(behavior)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok:false, error:"invalid_behavior" })); }
    const all = loadHealthBehaviors(); const key = todayKey(); all[key] = all[key] || {}; all[key][behavior] = !all[key][behavior]; saveHealthBehaviors(all);
    res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok:true, date:key, behaviors: all[key] }));
  });
}

async function handleAlertDismiss(req, res) {
  const body = await readRequestBody(req);
  const payload = parseBodyPayload(body);
  const id = String(payload.id || "").trim();
  if (!id) return sendJSON(res, { ok: false, error: "id requerido" }, 400);
  const alerts = loadAlerts();
  const idx = alerts.findIndex(a => a.id === id);
  if (idx === -1) return sendJSON(res, { ok: false, error: "not found" }, 404);
  alerts[idx].acknowledged = true;
  saveAlerts(alerts);
  return sendJSON(res, { ok: true, id });
}

function readRequestBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}
function parseBodyPayload(body) {
  try { return JSON.parse(body || "{}"); } catch(e) {}
  const params = new URLSearchParams(body || "");
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}
function sendJSON(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  return res.end(JSON.stringify(data));
}

// ════════════════════════════════════════════════════════════════
// SECURITY GATE — permisos centralizados por endpoint
// El dashboard se expone vía Cloudflare Quick Tunnel; cualquier request
// del túnel llega como loopback pero trae headers cf-* / x-forwarded-for.
// Niveles:
//   publicRead      → siempre permitido (shell UI, health, OAuth, diagnósticos)
//   privateRead     → GET con datos personales; clasificado y auditado.
//                     Hoy NO se bloquea porque "/" server-renderiza los mismos
//                     datos; bloquearlo sería teatro de seguridad (ver audit).
//   mutateLocal     → toggles locales de bajo riesgo
//   mutateProtected → POST que escriben datos
//   dangerous       → borrado/reset masivo
// Mutaciones (mutateLocal/mutateProtected/dangerous) desde el túnel exigen
// X-Cordelius-Key == process.env.CORDELIUS_ACCESS_KEY. Sin key configurada,
// toda mutación pública se bloquea. El valor de la key jamás se imprime.
// ════════════════════════════════════════════════════════════════
const CORDELIUS_ACCESS_KEY = process.env.CORDELIUS_ACCESS_KEY || "";

const ENDPOINT_PERMISSIONS = {
  "/": "privateRead",            // dashboard HTML: público requiere sesión (login wall)
  "/login": "publicRead",
  "/logout": "publicRead",
  "/health": "publicRead",
  "/healthz": "publicRead",
  "/api/ui-diagnostics": "publicRead",
  "/api/security/audit": "publicRead",
  "/whoop/auth": "publicRead",
  "/whoop/callback": "publicRead",
  "/api/whoop/callback": "publicRead",

  "/api/status": "privateRead",
  "/api/portfolio": "privateRead",
  "/api/intel": "privateRead",
  "/api/quiver": "privateRead",
  "/api/quiver/matches": "privateRead",
  "/api/quiver/trending": "privateRead",
  "/api/executive": "privateRead",
  "/api/executive/score": "privateRead",
  "/api/project/status": "privateRead",
  "/api/project/memory": "privateRead",
  "/api/decisions": "privateRead",
  "/api/decisions/patterns": "privateRead",
  "/api/decisions/playbook": "privateRead",
  "/api/opportunities": "privateRead",
  "/api/research/queue": "privateRead",
  "/api/watchlist/opportunities": "privateRead",
  "/api/jarvis/memory": "privateRead",
  "/api/jarvis/brain": "privateRead",
  "/api/feed/today": "privateRead",
  "/api/automations": "privateRead",
  "/api/ledger": "privateRead",
  "/api/alerts": "privateRead",
  "/api/daily-scan": "privateRead",
  "/api/market-radar": "privateRead",
  "/api/intelligence": "privateRead",
  "/api/intelligence/feed": "privateRead",
  "/api/daily-brief": "privateRead",
  "/api/market-intelligence": "privateRead",
  "/api/external-radar": "privateRead",
  "/api/paper/status": "privateRead",
  "/api/morning-report": "privateRead",
  "/api/whoop/status": "privateRead",
  "/api/whoop/profile": "privateRead",
  "/api/whoop/cycle": "privateRead",
  "/api/whoop/today": "privateRead",
  "/api/autopilot/database": "privateRead",
  "/api/autopilot/progress": "privateRead",
  "/api/journal/auto": "privateRead",
  "/api/journal/status": "privateRead",
  "/api/journal": "privateRead",            // GET lee; el POST se reclasifica abajo
  "/api/health-readiness": "privateRead",
  "/api/health/behaviors/today": "privateRead",
  "/api/health/snapshot": "privateRead",
  "/api/health/insights": "privateRead",
  "/api/trading/summary": "privateRead",
  "/api/alfredo/context": "privateRead",
  "/api/os-status": "privateRead",
  "/api/research/stock": "privateRead",     // GET lee cache; el POST se reclasifica abajo

  "/toggle-thinking": "mutateLocal",
  "/bot/start": "mutateLocal",
  "/bot/pause": "mutateLocal",

  "/ask": "mutateProtected",
  "/research": "mutateProtected",
  "/intel": "mutateProtected",
  "/intel/delete": "mutateProtected",
  "/api/health/behavior": "mutateProtected",
  "/alerts/dismiss": "mutateProtected",
  "/api/opportunities/run": "mutateProtected",
  "/api/research/queue/add": "mutateProtected",
  "/api/research/queue/remove": "mutateProtected",
  "/api/research/queue/run": "mutateProtected",
  "/api/mode/defensive": "mutateProtected",
  "/api/alerts/dry-run": "mutateProtected",
  "/api/autopilot/snapshot": "mutateProtected",

  "/intel/clear": "dangerous",
  "/bot/reset": "dangerous"
};
const MUTATION_LEVELS = ["mutateLocal", "mutateProtected", "dangerous"];

const securityStats = { publicRequestSeen: false, blockedMutations: 0, blockedReads: 0, publicMutationsAllowed: 0, lastBlockedPath: null, lastBlockedAt: null };

function endpointPermission(req, path) {
  let level = ENDPOINT_PERMISSIONS[path];
  if (path === "/login" || path === "/logout") return "publicRead"; // auth: el POST /login ES el login
  // Rutas dual GET/POST: el POST escribe aunque el GET solo lea.
  if (req.method !== "GET" && req.method !== "HEAD" && !MUTATION_LEVELS.includes(level)) level = "mutateProtected";
  if (!level) level = "privateRead"; // GET desconocido: clasificar conservador
  return level;
}

function requestIsPublic(req) {
  const h = req.headers || {};
  if (h["cf-connecting-ip"] || h["cf-ray"] || h["x-forwarded-for"] || h["x-real-ip"]) return true;
  const addr = (req.socket && req.socket.remoteAddress) || "";
  return !(addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");
}

function accessKeyValid(req) {
  if (!CORDELIUS_ACCESS_KEY) return false;
  const provided = String(req.headers["x-cordelius-key"] || req.headers["x-admin-token"] || "");
  if (!provided) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(CORDELIUS_ACCESS_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── SESSION GATE — login wall con cookie HttpOnly firmada (12h) ──
const SESSION_COOKIE = "cordelius_session";
const SESSION_TTL_MS = 12 * 3600 * 1000;

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
// Secreto derivado de la access key (las sesiones sobreviven reinicios;
// si la key cambia, todas las sesiones se invalidan). Nunca se loguea.
function sessionSecret() {
  return crypto.createHash("sha256").update("cordelius-session-v1:" + CORDELIUS_ACCESS_KEY).digest();
}
function makeSessionToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = crypto.createHmac("sha256", sessionSecret()).update("v1." + exp).digest("hex");
  return "v1." + exp + "." + sig;
}
function sessionTokenValid(tok) {
  if (!CORDELIUS_ACCESS_KEY || !tok) return false;
  const p = String(tok).split(".");
  if (p.length !== 3 || p[0] !== "v1") return false;
  const exp = Number(p[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = crypto.createHmac("sha256", sessionSecret()).update("v1." + exp).digest("hex");
  const a = Buffer.from(p[2]), b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hasValidSession(req) {
  return sessionTokenValid(parseCookies(req)[SESSION_COOKIE]);
}
// Autenticado para acceso público: header X-Cordelius-Key válido o cookie de sesión.
function publicAuthed(req) {
  return accessKeyValid(req) || hasValidSession(req);
}

// Rate limit naive para POST /login: 15 intentos fallidos / 10 min (por proceso).
const loginFailTimes = [];
function loginRateLimited() {
  const now = Date.now();
  while (loginFailTimes.length && now - loginFailTimes[0] > 10 * 60 * 1000) loginFailTimes.shift();
  return loginFailTimes.length >= 15;
}

function renderLoginWall(opts = {}) {
  const locked = !CORDELIUS_ACCESS_KEY;
  const body = locked
    ? `<div class="lw-msg">🔒 Private dashboard locked.<br><span>Configura <b>CORDELIUS_ACCESS_KEY</b> localmente en el servidor para habilitar el acceso remoto.</span></div>`
    : `<form method="POST" action="/login" autocomplete="off">
        <input type="password" name="key" placeholder="Access key" autofocus autocomplete="current-password">
        <button type="submit">Entrar</button>
        ${opts.error ? `<div class="lw-err">${esc(opts.error)}</div>` : ""}
      </form>`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cordelius · Acceso</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#eaf6ff;background:radial-gradient(circle at 20% 15%,rgba(0,255,153,.12),transparent 32%),radial-gradient(circle at 80% 12%,rgba(59,157,255,.14),transparent 34%),#02040a}
.lw{width:min(380px,calc(100vw - 40px));background:rgba(7,16,30,.92);border:1px solid rgba(0,255,153,.22);border-radius:24px;padding:34px 30px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 50px rgba(0,255,153,.07)}
.lw-logo{font-size:34px;margin-bottom:8px}
h1{font-size:20px;margin:0 0 4px;background:linear-gradient(90deg,#ffd35c,#fff,#3b9dff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.lw-sub{color:#9fb3c8;font-size:12px;margin-bottom:22px}
input{width:100%;box-sizing:border-box;background:rgba(0,0,0,.35);border:1px solid rgba(120,160,210,.25);border-radius:12px;padding:13px 14px;color:#eaf6ff;font-size:15px;margin-bottom:12px;outline:none}
input:focus{border-color:rgba(0,255,153,.5)}
button{width:100%;border:1px solid rgba(0,255,153,.4);background:rgba(0,255,153,.1);color:#00ff99;border-radius:12px;padding:12px;font-size:15px;font-weight:900;cursor:pointer}
button:hover{background:rgba(0,255,153,.18)}
.lw-err{color:#ff4d6d;font-size:12px;margin-top:10px}
.lw-msg{font-size:15px;line-height:1.6}.lw-msg span{font-size:12px;color:#9fb3c8}
.lw-foot{margin-top:18px;font-size:10px;color:#5a6674}
</style></head><body><div class="lw">
<div class="lw-logo">◎</div><h1>Cordelius</h1><div class="lw-sub">Personal OS · acceso privado</div>
${body}
<div class="lw-foot">Sesión de 12h · cookie HttpOnly · educativo, no asesoría</div>
</div></body></html>`;
}

function sendLoginWall(res, opts = {}, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(renderLoginWall(opts));
}

function handleLogin(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    if (!CORDELIUS_ACCESS_KEY) return sendLoginWall(res, {}, 200);
    if (loginRateLimited()) return sendLoginWall(res, { error: "Demasiados intentos. Espera unos minutos." }, 429);
    const key = new URLSearchParams(body).get("key") || "";
    const a = crypto.createHash("sha256").update(key).digest();
    const b = crypto.createHash("sha256").update(CORDELIUS_ACCESS_KEY).digest();
    if (!key || !crypto.timingSafeEqual(a, b)) {
      loginFailTimes.push(Date.now());
      securityStats.blockedMutations++;
      return sendLoginWall(res, { error: "Access key incorrecta." }, 401);
    }
    res.writeHead(302, {
      "Set-Cookie": `${SESSION_COOKIE}=${makeSessionToken()}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax; Secure`,
      Location: "/"
    });
    res.end();
  });
}

function handleLogout(req, res) {
  res.writeHead(302, {
    "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`,
    Location: "/login"
  });
  res.end();
}

// Devuelve true si el request puede continuar; si no, responde (login wall o JSON) y devuelve false.
function enforceEndpointPermission(req, res, path) {
  const level = endpointPermission(req, path);
  const isPublic = requestIsPublic(req);
  if (isPublic) securityStats.publicRequestSeen = true;

  if (level === "publicRead") return true;
  if (!isPublic) return true; // localhost: todo permitido sin login

  const authed = publicAuthed(req);

  if (level === "privateRead") {
    if (authed) return true;
    securityStats.blockedReads++;
    if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
      sendLoginWall(res, {}, 200); // login wall en vez del dashboard
      return false;
    }
    sendJSON(res, { ok: false, error: "unauthorized", reason: "Endpoint privado: requiere sesión (cookie " + SESSION_COOKIE + ") o header X-Cordelius-Key.", howTo: CORDELIUS_ACCESS_KEY ? "Inicia sesión en /login con tu access key." : "El servidor no tiene CORDELIUS_ACCESS_KEY configurada; el acceso remoto privado está deshabilitado." }, 401);
    return false;
  }

  // Mutaciones desde público
  if (!CORDELIUS_ACCESS_KEY) {
    securityStats.blockedMutations++;
    securityStats.lastBlockedPath = path; securityStats.lastBlockedAt = Date.now();
    sendJSON(res, { ok: false, error: "mutation_blocked", reason: "CORDELIUS_ACCESS_KEY no está configurada en el servidor; las mutaciones públicas están bloqueadas por seguridad.", howTo: "Define CORDELIUS_ACCESS_KEY en el entorno del servidor (manual, nunca via Claude) y reinicia." }, 403);
    return false;
  }
  if (!authed) {
    securityStats.blockedMutations++;
    securityStats.lastBlockedPath = path; securityStats.lastBlockedAt = Date.now();
    sendJSON(res, { ok: false, error: "unauthorized", reason: "Mutación vía túnel público sin sesión ni X-Cordelius-Key válido.", howTo: "Inicia sesión en /login, o guarda tu access key en System → Access Key." }, 401);
    return false;
  }
  securityStats.publicMutationsAllowed++;
  return true;
}

function buildSecurityAudit() {
  const byLevel = { publicRead: [], privateRead: [], mutateLocal: [], mutateProtected: [], dangerous: [] };
  for (const [p, lvl] of Object.entries(ENDPOINT_PERMISSIONS)) (byLevel[lvl] || byLevel.privateRead).push(p);
  const writes = byLevel.mutateLocal.length + byLevel.mutateProtected.length + byLevel.dangerous.length;
  return {
    ok: true, ts: Date.now(),
    securityLayer: true,
    sessionGate: true,
    dashboardProtected: true,
    privateReadProtected: true,
    sessionCookieName: SESSION_COOKIE,
    sessionTTLHours: SESSION_TTL_MS / 3600000,
    accessKeyConfigured: !!CORDELIUS_ACCESS_KEY,
    publicTunnelRisk: securityStats.publicRequestSeen,
    totals: {
      classified: Object.keys(ENDPOINT_PERMISSIONS).length,
      publicRead: byLevel.publicRead.length,
      privateRead: byLevel.privateRead.length,
      writes,
      protectedMutationEndpoints: writes, // toda mutación pública pasa por el gate
      unprotectedMutationEndpoints: 0
    },
    endpoints: byLevel,
    enforcement: {
      dashboard: "'/' desde público sin sesión → login wall (nunca el dashboard). Localhost entra directo.",
      privateRead: "Desde público requiere sesión (cookie HttpOnly firmada, 12h) o X-Cordelius-Key; sin auth → 401 JSON.",
      mutations: CORDELIUS_ACCESS_KEY
        ? "Públicas requieren sesión válida o X-Cordelius-Key; localhost libre."
        : "BLOQUEADAS en público (no hay CORDELIUS_ACCESS_KEY); localhost libre.",
      session: "Cookie " + SESSION_COOKIE + " = v1.<exp>.<HMAC-SHA256> derivada de la access key; HttpOnly, SameSite=Lax, Secure, 12h. Login con rate limit (15 fallos/10min).",
      unknownPaths: "GET desconocido → privateRead; método con escritura desconocido → mutateProtected (gate aplica)."
    },
    riskNotes: [
      securityStats.publicRequestSeen ? "Se han observado requests con headers de proxy/túnel: el servidor ES alcanzable públicamente." : "Aún no se observan requests públicos desde el arranque.",
      !CORDELIUS_ACCESS_KEY ? "CORDELIUS_ACCESS_KEY no configurada: acceso remoto privado deshabilitado y mutaciones públicas bloqueadas (modo más restrictivo)." : "Access key configurada (valor nunca expuesto).",
      "La sesión autoriza también mutaciones: CSRF mitigado con SameSite=Lax, no eliminado. No abras el dashboard desde enlaces de terceros.",
      "La URL del Quick Tunnel sigue siendo alcanzable; el login wall protege el contenido, no oculta el servicio.",
      "Trading real: no existe ninguna ruta que ejecute órdenes; todo es paper/educativo."
    ],
    stats: { blockedMutations: securityStats.blockedMutations, blockedReads: securityStats.blockedReads, publicMutationsAllowed: securityStats.publicMutationsAllowed, lastBlockedPath: securityStats.lastBlockedPath, lastBlockedAt: securityStats.lastBlockedAt ? new Date(securityStats.lastBlockedAt).toISOString() : null }
  };
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (!enforceEndpointPermission(req, res, path)) return;
  if (path === "/api/security/audit") return sendJSON(res, buildSecurityAudit());
  if (path === "/login" && req.method === "POST") return handleLogin(req, res);
  if (path === "/login") return requestIsPublic(req) && !publicAuthed(req) ? sendLoginWall(res) : (res.writeHead(302, { Location: "/" }), res.end());
  if (path === "/logout") return handleLogout(req, res);
  if (req.method === "POST" && path === "/ask") return handleAsk(req, res);
  if (req.method === "POST" && path === "/intel") return handleIntel(req, res);
  if (req.method === "POST" && path === "/intel/delete") return handleIntelDelete(req, res);
  if (req.method === "POST" && path === "/intel/clear") return handleIntelClear(req, res);
  if (req.method === "POST" && path === "/api/journal") return handleJournal(req, res);
  if (req.method === "POST" && path === "/api/health/behavior") return handleHealthBehavior(req, res);
  if (req.method === "POST" && path === "/alerts/dismiss") return handleAlertDismiss(req, res);
  if (path === "/toggle-thinking") {
    settings.thinkingEnabled = !settings.thinkingEnabled;
    settings.autoRefreshSeconds = settings.thinkingEnabled ? 60 : 120;
    saveJSON(SETTINGS_FILE, settings);
    res.writeHead(302, { Location: "/#alfredo" }); return res.end();
  }
  if (path === "/bot/start") { bot.running = true; addThought("Bot ficticio encendido.", "scan"); saveJSON(BOT_FILE, bot); res.writeHead(302, { Location: "/#bot" }); return res.end(); }
  if (path === "/bot/pause") { bot.running = false; addThought("Bot ficticio pausado.", "warn"); saveJSON(BOT_FILE, bot); res.writeHead(302, { Location: "/#bot" }); return res.end(); }
  if (path === "/bot/reset") {
    bot = { initialCapital: 1000, cash: 1000, positions: {}, history: [], equityHistory: [], thoughts: [], running: true, totalRealizedPnl: 0, maxDrawdown: 0, tradesCount: 0, lastTick: null };
    addThought("Bot reiniciado desde cero.", "scan"); saveJSON(BOT_FILE, bot);
    res.writeHead(302, { Location: "/#bot" }); return res.end();
  }
  if (path === "/health" || path === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()), service: CORDA_APP_NAME }));
  }
  if (path === "/api/status") {
    const pv = portfolioValue();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()),
      portfolio: { totalMXN: pv.totalValueMXN, gainPct: pv.totalGainPct, assets: pv.assets.length },
      bot: { running: bot.running, cash: bot.cash, trades: bot.tradesCount },
      intel: { count: intelItems.length },
      quiver: { configured: quiverData.configured, congressional: quiverData.congressional.length, insider: quiverData.insider.length, contracts: quiverData.contracts.length },
      settings: { thinkingEnabled: settings.thinkingEnabled, theme: settings.themeMode }
    }));
  }
  if (path === "/api/portfolio") {
    const pv = portfolioValue();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), ...pv }));
  }
  if (path === "/api/intel") {
    const intelSummary = {
      total: intelItems.length,
      positivo: intelItems.filter(x => x.mood === "POSITIVO").length,
      negativo: intelItems.filter(x => x.mood === "NEGATIVO").length,
      neutral: intelItems.filter(x => x.mood === "NEUTRAL").length,
      byAsset: intelItems.reduce((acc, x) => {
        (x.affected || []).forEach(sym => { acc[sym] = (acc[sym] || 0) + 1; });
        return acc;
      }, {})
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), count: intelItems.length, summary: intelSummary, items: intelItems }));
  }
  if (path === "/api/quiver") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, configured: quiverData.configured, error: quiverData.error || null,
      summary: {
        congressional: quiverData.congressional.length,
        insider: quiverData.insider.length,
        contracts: quiverData.contracts.length,
        lastFetch: quiverData.lastFetch,
        cacheAgeMinutes: quiverData.lastFetch ? Math.floor((Date.now() - quiverData.lastFetch) / 60000) : null
      },
      congressional: quiverData.congressional,
      insider: quiverData.insider,
      contracts: quiverData.contracts
    }));
  }
  if (path === "/api/quiver/matches") {
    const allMatches = [
      ...quiverData.congressional.map(x => ({ ...x, dataset: "congressional" })),
      ...quiverData.insider.map(x => ({ ...x, dataset: "insider" })),
      ...quiverData.contracts.map(x => ({ ...x, dataset: "contracts" }))
    ].sort((a, b) => (a.daysAgo == null ? 999 : a.daysAgo) - (b.daysAgo == null ? 999 : b.daysAgo));
    const tickers = [...new Set(allMatches.map(x => x.symbol))];
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, ts: Date.now(),
      configured: quiverData.configured,
      quiverCount: quiverData.congressional.length + quiverData.insider.length + quiverData.contracts.length,
      matchCount: allMatches.length,
      tickers,
      matches: allMatches
    }));
  }
  if (path === "/api/executive") {
    return sendJSON(res, buildExecutiveBriefing());
  }
  if (path === "/api/executive/score") {
    return sendJSON(res, buildExecutiveScore());
  }
  if (path === "/api/project/status") {
    return sendJSON(res, buildProjectStatus());
  }
  if (path === "/api/project/memory") {
    return sendJSON(res, buildProjectMemory());
  }
  if (path === "/api/decisions") {
    return sendJSON(res, { ok: true, ts: Date.now(), decisions: buildDecisionRecords(), educationalNote: "Decision Intelligence educativa; no trading real." });
  }
  if (path === "/api/decisions/patterns") {
    return sendJSON(res, buildDecisionPatterns());
  }
  if (path === "/api/decisions/playbook") {
    return sendJSON(res, buildDecisionPlaybook());
  }
  if (path === "/api/opportunities") {
    return sendJSON(res, getOpportunityState());
  }
  if (req.method === "POST" && path === "/api/opportunities/run") {
    return sendJSON(res, buildOpportunityEngine());
  }
  if (path === "/api/research/stock" && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    return sendJSON(res, researchStock(url.searchParams.get("symbol") || ""));
  }
  if (path === "/api/research/stock" && req.method === "POST") {
    const payload = parseBodyPayload(await readRequestBody(req));
    return sendJSON(res, researchStock(payload.symbol || payload.ticker || ""));
  }
  if (path === "/api/research/queue" && req.method === "GET") {
    const queue = getResearchQueue();
    return sendJSON(res, { ok: true, ts: Date.now(), queue, count: queue.length, research: Object.values(getResearchCache()).sort((a, b) => (b.cachedAt || b.ts || 0) - (a.cachedAt || a.ts || 0)).slice(0, 10), educationalNote: "Research queue local educativa." });
  }
  if (path === "/api/research/queue/add" && req.method === "POST") {
    const payload = parseBodyPayload(await readRequestBody(req));
    const queue = addResearchQueueSymbol(payload.symbol || payload.ticker || "");
    return sendJSON(res, { ok: true, ts: Date.now(), queue, count: queue.length });
  }
  if (path === "/api/research/queue/remove" && req.method === "POST") {
    const payload = parseBodyPayload(await readRequestBody(req));
    const queue = removeResearchQueueSymbol(payload.symbol || payload.ticker || "");
    return sendJSON(res, { ok: true, ts: Date.now(), queue, count: queue.length });
  }
  if (path === "/api/research/queue/run" && req.method === "POST") {
    return sendJSON(res, runResearchQueue());
  }
  if (path === "/api/watchlist/opportunities") {
    const state = getOpportunityState();
    return sendJSON(res, { ok: true, ts: Date.now(), candidates: state.watchlistCandidates, topOpportunities: state.topOpportunities, hotTickers: state.hotTickers, educationalNote: "Watchlist educativa; no señal de trading." });
  }
  if (path === "/api/jarvis/memory") {
    return sendJSON(res, buildMemorySummary());
  }
  if (path === "/api/jarvis/brain") {
    return sendJSON(res, computeJarvisBrain());
  }
  if (path === "/api/feed/today") {
    return sendJSON(res, buildTodayFeed());
  }
  if (path === "/api/automations") {
    return sendJSON(res, getAutomationState());
  }
  if (req.method === "POST" && path === "/api/mode/defensive") {
    settings.defensiveMode = !settings.defensiveMode;
    saveJSON(SETTINGS_FILE, settings);
    return sendJSON(res, { ok: true, defensiveMode: settings.defensiveMode, note: "Modo defensivo es una etiqueta educativa local; no ejecuta órdenes." });
  }
  if (path === "/api/ledger") {
    const positions = loadJSON(POSITION_LEDGER_FILE, []);
    const changes   = loadJSON(CHANGE_LEDGER_FILE, []);
    return sendJSON(res, { ok: true, ts: Date.now(), positionCount: positions.length, changeCount: changes.length, positions, changes });
  }
  if (path === "/api/alerts") {
    const alerts = loadAlerts();
    const active = alerts.filter(a => !a.acknowledged);
    return sendJSON(res, { ok: true, ts: Date.now(), total: alerts.length, active: active.length, alerts });
  }
  if (path === "/api/ui-diagnostics") {
    const hr = (() => { try { return computeHealthReadiness(); } catch (e) { return { configured: WHOOP_CONFIGURED, connected: false }; } })();
    const journalCount = (() => { try { return computeJournalData().count; } catch (e) { return null; } })();
    return sendJSON(res, { ok: true, ts: Date.now(),
      gitCommit: GIT_COMMIT,
      mode: "stacked",
      stackedMode: true,
      modules: ["home","trading","health","journal","intelligence","alfredo","autopilot"],
      cssStrategy: "stacked fallback — all modules visible",
      uptimeSeconds: Math.round((Date.now() - SERVER_STARTED_AT) / 1000),
      dataSources: {
        whoop: hr.connected ? "OK" : (WHOOP_CONFIGURED ? "FALLBACK" : "PENDIENTE"),
        whoopReason: hr.connected ? "ok" : whoopStatusReason,
        whoopTokenExpiresAt: whoopTokenExpiryMs() ? new Date(whoopTokenExpiryMs()).toISOString() : null,
        whoopReconnect: hr.connected ? null : "visit /whoop/auth to re-authorize",
        market: FINNHUB_API_KEY ? "OK" : "FALLBACK",
        quotes: quotesFreshness(),
        quotesLastFetch: quotesLastFetch ? new Date(quotesLastFetch).toISOString() : null,
        quotesError: quotesLastError,
        cryptoQuotes: cryptoFreshness(),
        cryptoQuotesLastFetch: cryptoQuotesLastFetch ? new Date(cryptoQuotesLastFetch).toISOString() : null,
        cryptoQuotesError: cryptoQuotesError,
        technicalIndicators: indicatorsFreshness(),
        technicalIndicatorsLastFetch: technicalLastFetch ? new Date(technicalLastFetch).toISOString() : null,
        technicalIndicatorsError: technicalLastError,
        liveIndicatorsCount: indicatorCounts().live,
        simulatedIndicatorsCount: indicatorCounts().simulated,
        ...(() => { try { const pv = portfolioValue(); let live = 0; for (const a of pv.assets) if (a.quoteSource !== "manual") live++; return { liveAssetsCount: live, manualAssetsCount: pv.assets.length - live }; } catch (e) { return { liveAssetsCount: null, manualAssetsCount: null }; } })(),
        quiver: QUIVER_API_KEY ? "OK" : "PENDIENTE",
        journal: journalCount !== null ? "OK" : "ERROR",
        journalEntries: journalCount,
        portfolioHistoryPoints: Array.isArray(portfolioHistory) ? portfolioHistory.length : 0
      },
      security: (() => { try { const a = buildSecurityAudit(); return {
        securityLayer: true,
        sessionGate: true,
        dashboardProtected: a.dashboardProtected,
        privateReadProtected: a.privateReadProtected,
        sessionCookieName: a.sessionCookieName,
        publicTunnelRisk: a.publicTunnelRisk,
        accessKeyConfigured: a.accessKeyConfigured,
        protectedMutationEndpoints: a.totals.protectedMutationEndpoints,
        unprotectedMutationEndpoints: a.totals.unprotectedMutationEndpoints,
        blockedMutations: a.stats.blockedMutations,
        blockedReads: a.stats.blockedReads
      }; } catch (e) { return { securityLayer: false, error: e.message }; } })(),
      uxRecovery: (() => { try {
        const hist = buildDailyEquityHistory();
        buildTodayFeed(); // refresca feedDedupeStats
        const warnings = [];
        if (hist.mode === "limited") warnings.push("Historial de equity limitado a un solo día; las anclas diarias crecerán con los snapshots.");
        const eq = bot.equityHistory || [];
        if (eq.length > 1 && eq[eq.length - 1].t - eq[0].t < 36 * 3600 * 1000) warnings.push("Equity del bot paper aún intradía (<36h).");
        return {
          dedupeLayer: true,
          chartsHistoryMode: hist.mode,
          chartDateRange: { from: hist.firstDate, to: hist.lastDate, days: hist.rangeDays },
          actionCenter: true,
          collapsibleSections: true,
          paperModeTimeline: (bot.history || []).length ? "real" : "limited",
          repeatedSnapshotsReduced: Math.max(0, feedDedupeStats.candidates - feedDedupeStats.shown),
          feedSnapshotsShown: feedDedupeStats.shown,
          warnings
        };
      } catch (e) { return { dedupeLayer: false, error: e.message }; } })(),
      commandCenter: {
        commandPalette: true,
        jarvisBrain: true,
        todayFeed: true,
        actionCenter: true,
        neuralHeader: true,
        visualPolish: "v2",
        automations: (() => { try { const a = getAutomationState(); return { rules: a.rules.length, firedToday: a.firedToday.length, defensiveMode: a.defensiveMode }; } catch (e) { return { error: e.message }; } })(),
        endpoints: ["/api/jarvis/brain", "/api/feed/today", "/api/automations", "POST /api/mode/defensive"]
      },
      note: "Tabs only scroll; no modules are hidden."
    });
  }
  if (req.method === "POST" && path === "/api/alerts/dry-run") {
    return sendJSON(res, checkAlertsDryRun());
  }
  if (path === "/api/daily-scan") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeDailyScan()));
  }
  if (path === "/api/quiver/trending") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeQuiverTrending()));
  }
  if (path === "/api/market-radar") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeMarketRadar()));
  }
  if (path === "/api/intelligence") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeIntelligence()));
  }
  if (path === "/api/daily-brief") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeDailyNewsletter()));
  }
  if (path === "/api/market-intelligence") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const pi = computePortfolioIntelligence();
    const emi = computeExternalMarketIntelligence();
    const qi = computeQuiverIntelligence();
    const st = computeSectorThemes();
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), portfolio: pi, external: emi, quiver: qi, sectors: st }));
  }
  if (path === "/api/external-radar") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeExternalMarketIntelligence()));
  }
  if (path === "/api/paper/status") {
    const idea = computeTradeIdea();
    const m = botMetrics();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), paperMode: true, realTrading: false, alpacaConnected: false, alpacaStatus: "PENDIENTE", idea, botMetrics: m, disclaimer: "PAPER TRADING / SIMULACION — NO USA DINERO REAL" }));
  }
  if (path === "/api/morning-report") {
    const nl = computeDailyNewsletter();
    const pv = portfolioValue();
    const idea = computeTradeIdea();
    const qi = computeQuiverIntelligence();
    const h = computeHealthReadiness();
    const m = botMetrics();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      date: nl.date,
      greeting: nl.greeting,
      summary: nl.fullSummary,
      newsletterLines: nl.lines,
      portfolio: {
        totalValueMXN: pv.totalValueMXN,
        totalCostMXN: pv.totalCostMXN,
        totalGainMXN: pv.totalGainMXN,
        totalGainPct: pv.totalGainPct,
        assetCount: pv.assets.length
      },
      tradeIdea: idea,
      healthReadiness: h,
      operatingMode: h.operatingMode,
      quiver: { configured: qi.configured },
      paperMode: { active: true, realTrading: false, alpacaConnected: false, botMetrics: m },
      autopilot: {
        serverOnline: true,
        paperMode: true,
        realTrading: false,
        whoop: WHOOP_CONFIGURED,
        quiver: quiverData.configured,
        alpaca: false
      },
      nextActions: [
        h.configured ? "Revisar recovery score en WHOOP" : "Conectar WHOOP para readiness",
        idea.hasIdea ? `Evaluar idea paper: ${idea.type} en ${idea.symbol}` : "Sin trade idea activa hoy",
        quiverData.configured ? "Revisar actividad Quiver" : "Agregar QUIVER_API_KEY para datos institucionales"
      ],
      automation: {
        scripts: ["health_check.sh", "restart_safe.sh", "morning_report.sh", "final_check.sh"],
        reportsDir: "reports/",
        cloudReady: true,
        disclaimer: "PAPER TRADING / EDUCATIVO — SIN ORDENES REALES"
      }
    }));
  }

  if (path === "/whoop/auth") {
    const clientId = process.env.WHOOP_CLIENT_ID || "";
    const redirectUri = process.env.WHOOP_REDIRECT_URI || "";
    if (!clientId || !redirectUri) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Faltan WHOOP_CLIENT_ID o WHOOP_REDIRECT_URI en .env");
    }

    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const scope = "offline read:profile read:cycles read:recovery read:sleep read:workout";

    const authUrl = "https://api.prod.whoop.com/oauth/oauth2/auth"
      + "?response_type=code"
      + "&client_id=" + encodeURIComponent(clientId)
      + "&redirect_uri=" + encodeURIComponent(redirectUri)
      + "&scope=" + encodeURIComponent(scope)
      + "&state=" + encodeURIComponent(state);

    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  if (path === "/api/whoop/callback") {
    const qs = new URL(req.url, "http://localhost").search || "";
    res.writeHead(302, { Location: "/whoop/callback" + qs });
    return res.end();
  }

  if (path === "/whoop/callback") {
    const code = new URL(req.url, "http://localhost").searchParams.get("code");
    const err = new URL(req.url, "http://localhost").searchParams.get("error");

    if (err) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("WHOOP OAuth error: " + err);
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Falta code en callback WHOOP.");
    }

    try {
      const body = [
        "grant_type=authorization_code",
        "code=" + encodeURIComponent(code),
        "client_id=" + encodeURIComponent(process.env.WHOOP_CLIENT_ID || ""),
        "client_secret=" + encodeURIComponent(process.env.WHOOP_CLIENT_SECRET || ""),
        "redirect_uri=" + encodeURIComponent(process.env.WHOOP_REDIRECT_URI || "")
      ].join("&");

      const tokenResult = await apiPost(WHOOP_TOKEN_URL, body);

      if (!tokenResult || !tokenResult.access_token) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("WHOOP no regresó access_token.");
      }

      whoopTokens = {
        ...tokenResult,
        expires_at: Date.now() + (tokenResult.expires_in || 3600) * 1000
      };

      saveJSON(WHOOP_TOKEN_FILE, whoopTokens);

      whoopCache.lastFetch = 0;
      await refreshWhoopCache();

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>WHOOP conectado</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial;background:#02040a;color:#eaf6ff;padding:28px">
<h1>WHOOP conectado ✅</h1>
<p>Tokens guardados en el servidor. Ya puedes volver a Cordelius Health.</p>
<p><a href="/#health" style="color:#00ff99">Abrir Health OS</a></p>
</body></html>`);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Error intercambiando code por token WHOOP: " + (e && e.message ? e.message : String(e)));
    }
  }

  if (path === "/api/whoop/status") {
    const h = computeHealthReadiness();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      configured: WHOOP_CONFIGURED,
      connected: h.connected,
      tokensPresent: !!(whoopTokens && whoopTokens.access_token),
      tokenExpiresAt: whoopTokenExpiryMs() ? new Date(whoopTokenExpiryMs()).toISOString() : null,
      tokenExpired: whoopTokenExpiryMs() ? Date.now() > whoopTokenExpiryMs() : null,
      statusReason: h.connected ? "ok" : whoopStatusReason,
      reconnect: h.connected ? null : "Open /whoop/auth in a browser to re-authorize WHOOP (requires WHOOP_REDIRECT_URI in .env to match the app settings).",
      source: h.source,
      reason: h.connected
        ? "WHOOP connected and data available"
        : WHOOP_CONFIGURED
          ? (whoopTokens && whoopTokens.access_token ? "Token present — awaiting cache refresh" : "Env vars set but tokens missing — complete OAuth flow")
          : "WHOOP env vars missing (WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET)",
      vars: {
        clientId: !!process.env.WHOOP_CLIENT_ID,
        clientSecret: !!process.env.WHOOP_CLIENT_SECRET,
        redirectUri: !!process.env.WHOOP_REDIRECT_URI
      },
      cacheAge: whoopCache.lastFetch ? Math.floor((Date.now() - whoopCache.lastFetch) / 1000) + "s" : null
    }));
  }
  if (path === "/api/whoop/profile") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!whoopCache.connected) return res.end(JSON.stringify({ ok: false, connected: false, reason: "WHOOP not connected" }));
    return res.end(JSON.stringify({ ok: true, connected: true, profile: whoopCache.profile }));
  }
  if (path === "/api/whoop/cycle") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!whoopCache.connected) return res.end(JSON.stringify({ ok: false, connected: false, reason: "WHOOP not connected" }));
    return res.end(JSON.stringify({ ok: true, connected: true, cycle: whoopCache.cycle }));
  }

  // === Autopilot Database Memory API ===
  if (path === "/api/autopilot/database" && req.method === "GET") {
    try {
      return sendAutopilotJSON(res, getAutopilotDatabaseState());
    } catch (e) {
      return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  if (path === "/api/autopilot/snapshot" && req.method === "POST") {
    try {
      return sendAutopilotJSON(res, saveAutopilotSnapshot());
    } catch (e) {
      return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  if (path === "/api/autopilot/progress" && req.method === "GET") {
    try {
      const state = getAutopilotDatabaseState();
      return sendAutopilotJSON(res, {
        ok: true,
        progress: state.stores.progress,
        counts: state.counts,
        latest: state.latest,
        tradingSummary: state.tradingSummary
      });
    } catch (e) {
      return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
    }
  }

if (path === "/api/whoop/today") {
    await refreshWhoopCache(); // rate-limited internally (WHOOP_CACHE_MS)
    const h = computeHealthReadiness();
    const _cyc = whoopCache.cycle;
    const _kj = _cyc && _cyc.score && _cyc.score.kilojoule != null ? _cyc.score.kilojoule : null;
    const _ss = _cyc && _cyc.score && _cyc.score.state ? _cyc.score.state : null;
    const _pv = portfolioValue();
    const _idea = computeTradeIdea();
    const _alfredo = `Portafolio ${money(_pv.totalValueMXN)} (${pct(_pv.totalGainPct)}). ` +
      (_idea.hasIdea ? `Idea paper: ${_idea.type} en ${_idea.symbol}. ` : "") +
      `Modo: ${h.operatingMode}. ${h.suggestion}. NO es consejo médico.`;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      connected: h.connected,
      date: new Date().toLocaleDateString("es-MX"),
      strain: h.strain,
      averageHeartRate: h.averageHeartRate,
      maxHeartRate: h.maxHeartRate,
      kilojoule: _kj,
      scoreState: _ss,
      recovery: h.recovery,
      sleep: h.sleep,
      hrv: h.hrv,
      restingHeartRate: h.restingHeartRate,
      operatingMode: h.operatingMode,
      mode: h.operatingMode,
      suggestion: h.suggestion,
      alfredoAdvice: _alfredo,
      message: h.message
    }));
  }
  if (path === "/api/journal/auto") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeAutoJournal()));
  }
  if (path === "/api/health-readiness") {
    const h = computeHealthReadiness();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: h.ok,
      configured: h.configured,
      source: h.source,
      recovery: h.recovery,
      sleep: h.sleep,
      strain: h.strain,
      hrv: h.hrv,
      restingHeartRate: h.restingHeartRate,
      operatingMode: h.operatingMode,
      educationalNote: h.educationalNote
    }));
  }
  if (path === "/api/journal/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      configured: false,
      storage: journalEntries.length > 0 ? "active" : "empty",
      count: journalEntries.length,
      topMood: computeJournalData().topMood,
      prompts: ["¿Cómo dormí?","¿Qué me preocupa?","¿Qué quiero lograr hoy?","¿Qué aprendí?","¿Cómo estuvo mi energía?"]
    }));
  }
  if (path === "/api/journal") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeJournalData()));
  }

  if (path === "/api/whoop/status") {
    const tokenFile = "whoop_tokens.json";
    let tokenInfo = { exists: false, savedAt: null, tokenType: null, hasAccessToken: false, hasRefreshToken: false };
    if (fs.existsSync(tokenFile)) {
      try {
        const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
        tokenInfo = {
          exists: true,
          savedAt: tokens.savedAt || null,
          tokenType: tokens.token_type || null,
          hasAccessToken: !!tokens.access_token,
          hasRefreshToken: !!tokens.refresh_token
        };
      } catch (e) {
        tokenInfo = { exists: true, parseError: true, savedAt: null, tokenType: null, hasAccessToken: false, hasRefreshToken: false };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      configured: WHOOP_CONFIGURED,
      tokenFile: tokenInfo,
      cloudReady: true,
      message: tokenInfo.exists ? "WHOOP token file detected. No secrets returned." : "WHOOP token file not found. Configure OAuth tokens locally or as deploy secret storage."
    }));
  }
  if (path === "/api/whoop/today") {
    try {
      const https = require("https");
      const fs = require("fs");

      const tokenFile = "whoop_tokens.json";

      const emptyWhoop = (message, extra) => ({
        ok: true,
        connected: false,
        date: new Date().toLocaleDateString("es-MX"),
        strain: null,
        averageHeartRate: null,
        maxHeartRate: null,
        kilojoule: null,
        scoreState: null,
        recovery: null,
        sleep: null,
        hrv: null,
        restingHeartRate: null,
        operatingMode: "NORMAL",
        mode: "NORMAL",
        suggestion: "usa modo neutral",
        alfredoAdvice: message,
        message,
        ...(extra || {})
      });

      if (!fs.existsSync(tokenFile)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(emptyWhoop(
          "WHOOP configurado — tokens pendientes de autorización OAuth. NO es consejo médico."
        )));
      }

      const readTokens = () => JSON.parse(fs.readFileSync(tokenFile, "utf8"));

      const refreshTokens = (oldTokens) => new Promise((resolve) => {
        if (!oldTokens.refresh_token) {
          return resolve({ ok:false, error:"no_refresh_token" });
        }

        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: oldTokens.refresh_token,
          client_id: process.env.WHOOP_CLIENT_ID || "",
          client_secret: process.env.WHOOP_CLIENT_SECRET || ""
        }).toString();

        const options = {
          hostname: "api.prod.whoop.com",
          path: "/oauth/oauth2/token",
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
            "Accept": "application/json"
          }
        };

        const req2 = https.request(options, (rr) => {
          let raw = "";
          rr.on("data", c => raw += c);
          rr.on("end", () => {
            let parsed;
            try { parsed = JSON.parse(raw); } catch(e) { parsed = { raw }; }

            const success = rr.statusCode >= 200 && rr.statusCode < 300 && parsed.access_token;

            if (success) {
              const newTokens = {
                savedAt: new Date().toISOString(),
                token_type: parsed.token_type || oldTokens.token_type || null,
                expires_in: parsed.expires_in || null,
                scope: parsed.scope || oldTokens.scope || null,
                access_token: parsed.access_token,
                refresh_token: parsed.refresh_token || oldTokens.refresh_token || null
              };

              fs.writeFileSync(tokenFile, JSON.stringify(newTokens, null, 2));
              return resolve({ ok:true, tokens:newTokens, statusCode:rr.statusCode });
            }

            return resolve({ ok:false, statusCode:rr.statusCode, error:parsed });
          });
        });

        req2.on("error", e => resolve({ ok:false, error:e.message }));
        req2.write(body);
        req2.end();
      });

      const fetchWhoopPath = (tokens, whoopPath) => new Promise((resolve) => {
        const options = {
          hostname: "api.prod.whoop.com",
          path: whoopPath,
          method: "GET",
          headers: {
            "Authorization": "Bearer " + tokens.access_token,
            "Accept": "application/json"
          }
        };

        const r = https.request(options, (rr) => {
          let raw = "";
          rr.on("data", c => raw += c);
          rr.on("end", () => {
            let data;
            try { data = JSON.parse(raw); } catch(e) { data = null; }
            resolve({ statusCode: rr.statusCode, data });
          });
        });

        r.on("error", e => resolve({ statusCode:500, data:null, error:e.message }));
        r.end();
      });

      const latestRecord = (payload) => payload && Array.isArray(payload.records) && payload.records.length ? payload.records[0] : null;
      const numeric = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

      let tokens = readTokens();
      let result = await fetchWhoopPath(tokens, "/developer/v1/cycle?limit=1");

      let refreshed = false;

      if (result.statusCode === 401) {
        const refresh = await refreshTokens(tokens);

        if (refresh.ok) {
          refreshed = true;
          tokens = refresh.tokens;
          result = await fetchWhoopPath(tokens, "/developer/v1/cycle?limit=1");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(emptyWhoop(
            "WHOOP token expirado y refresh falló. Reautoriza con /api/whoop/connect.",
            {
              whoopRawStatusCode: 401,
              refreshAttempted: true,
              refreshOk: false,
              refreshStatusCode: refresh.statusCode || null,
              refreshError: refresh.error ? "refresh_failed" : null
            }
          )));
        }
      }

      const apiOk = result.statusCode >= 200 && result.statusCode < 300;
      const data = result.data || {};
      const cycle = latestRecord(data);
      const score = cycle && cycle.score ? cycle.score : {};

      let recoveryResult = { statusCode: null, data: null };
      let sleepResult = { statusCode: null, data: null };
      if (apiOk) {
        [recoveryResult, sleepResult] = await Promise.all([
          fetchWhoopPath(tokens, "/developer/v2/recovery?limit=1"),
          fetchWhoopPath(tokens, "/developer/v2/activity/sleep?limit=1")
        ]);
      }

      const recoveryRecord = latestRecord(recoveryResult.data);
      const recoveryScore = recoveryRecord && recoveryRecord.score ? recoveryRecord.score : {};
      const sleepRecord = latestRecord(sleepResult.data);
      const sleepScore = sleepRecord && sleepRecord.score ? sleepRecord.score : {};

      const strain = numeric(score.strain);
      const averageHeartRate = numeric(score.average_heart_rate);
      const maxHeartRate = numeric(score.max_heart_rate);
      const kilojoule = numeric(score.kilojoule);
      const scoreState = cycle ? cycle.score_state || null : null;
      const recovery = numeric(recoveryScore.recovery_score);
      const hrv = numeric(recoveryScore.hrv_rmssd_milli);
      const restingHeartRate = numeric(recoveryScore.resting_heart_rate);
      const sleep = numeric(sleepScore.sleep_performance_percentage);

      let operatingMode = "NORMAL";
      let suggestion = "usa modo neutral";

      if (strain !== null && strain >= 10) {
        operatingMode = "DEFENSIVO";
        suggestion = "baja riesgo y evita sobreoperar";
      } else if (strain !== null && strain < 3) {
        operatingMode = "LOW_STRAIN";
        suggestion = "buen momento para análisis tranquilo, sin forzar trades";
      }

      const advice = apiOk
        ? `WHOOP conectado. Recovery ${recovery ?? "—"}%, Sleep ${sleep ?? "—"}%, HRV ${hrv ?? "—"} ms, RHR ${restingHeartRate ?? "—"} bpm, Strain ${strain ?? "—"}, HR promedio ${averageHeartRate ?? "—"}, HR máxima ${maxHeartRate ?? "—"}. Modo: ${operatingMode}. ${suggestion}. NO es consejo médico.`
        : "WHOOP token presente, pero la API no respondió correctamente. Reautoriza si persiste.";

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        connected: apiOk,
        date: new Date().toLocaleDateString("es-MX"),
        strain,
        averageHeartRate,
        maxHeartRate,
        kilojoule,
        scoreState,
        recovery,
        sleep,
        hrv,
        restingHeartRate,
        operatingMode,
        mode: operatingMode,
        suggestion,
        alfredoAdvice: advice,
        message: apiOk ? "WHOOP conectado desde whoop_tokens.json." : "WHOOP token presente, pero API falló.",
        whoopRawStatusCode: result.statusCode,
        recoveryStatusCode: recoveryResult.statusCode,
        sleepStatusCode: sleepResult.statusCode,
        refreshed
      }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        connected: false,
        error: "whoop_today_crash",
        message: e.message,
        strain: null,
        averageHeartRate: null,
        maxHeartRate: null,
        kilojoule: null,
        scoreState: null,
        recovery: null,
        sleep: null,
        hrv: null,
        restingHeartRate: null,
        operatingMode: "NORMAL",
        mode: "NORMAL",
        suggestion: "usa modo neutral",
        alfredoAdvice: "Crash leyendo WHOOP. NO es consejo médico."
      }));
    }
  }



  if (path === "/api/health/behaviors/today") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok:true, date: todayKey(), behaviors: getTodayHealthBehaviors() }));
  }
  if (path === "/api/health/snapshot") {
    try {
      const getJson = (url) => new Promise((resolve) => { http.get(url, (rr) => { let raw = ""; rr.on("data", c => raw += c); rr.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok:false }); } }); }).on("error", () => resolve({ ok:false })); });
      const whoop = await getJson("http://127.0.0.1:" + PORT + "/api/whoop/today");
      const latest = healthSnapshotRecord(whoop || {}); const history = upsertHealthSnapshot(latest); const behaviors = loadHealthBehaviors(); const correlations = computeHealthCorrelations(history, behaviors); const insight = buildHealthInsight(whoop || {}, latest.scores);
      res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok:true, ts: Date.now(), latest, scores: latest.scores, history, correlations, alfredoHealthAI: insight }));
    } catch(e) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok:false, error:"health_snapshot_crash", message:e.message })); }
  }
  if (path === "/api/health/insights") {
    try {
      const history = loadJSON(HEALTH_SNAPSHOT_FILE, []);
      const byTime = (Array.isArray(history) ? history.slice() : []).sort((a, b) =>
        (a.ts || (a.timestamp ? Date.parse(a.timestamp) : 0)) - (b.ts || (b.timestamp ? Date.parse(b.timestamp) : 0)));
      const latest = byTime.length ? byTime[byTime.length - 1] : healthSnapshotRecord({});
      const recDate = latest.date || (latest.timestamp ? String(latest.timestamp).slice(0, 10) : "");
      const ai = buildHealthInsight(latest, latest.scores || computeHealthScores(latest), recDate === todayKey());
      res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok:true, ts: Date.now(), alfredoHealthAI: ai, scores: latest.scores || computeHealthScores(latest), educationalNote:"Educativo. No es asesoría médica ni financiera." }));
    } catch(e) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok:false, error:"health_insights_crash", message:e.message })); }
  }

  if (path === "/api/journal/auto") {
    try {
      const http = require("http");

      const getJson = (url) => new Promise((resolve, reject) => {
        http.get(url, (rr) => {
          let raw = "";
          rr.on("data", c => raw += c);
          rr.on("end", () => {
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              resolve({ ok:false, raw });
            }
          });
        }).on("error", reject);
      });

      const whoop = await getJson("http://127.0.0.1:" + PORT + "/api/whoop/today");

      const strain = whoop && typeof whoop.strain === "number" ? whoop.strain : null;
      const averageHeartRate = whoop && typeof whoop.averageHeartRate === "number" ? whoop.averageHeartRate : null;
      const maxHeartRate = whoop && typeof whoop.maxHeartRate === "number" ? whoop.maxHeartRate : null;
      const kilojoule = whoop && typeof whoop.kilojoule === "number" ? whoop.kilojoule : null;
      const scoreState = whoop ? whoop.scoreState || null : null;
      const recovery = whoop && typeof whoop.recovery === "number" ? whoop.recovery : null;
      const sleep = whoop && typeof whoop.sleep === "number" ? whoop.sleep : null;
      const hrv = whoop && typeof whoop.hrv === "number" ? whoop.hrv : null;
      const restingHeartRate = whoop && typeof whoop.restingHeartRate === "number" ? whoop.restingHeartRate : null;
      const pvAuto = portfolioValue();
      const regAuto = marketRegime();
      const ctxAuto = alfredoDailyContext({ recovery, sleep, hrv, restingHeartRate, strain, operatingMode: whoop ? whoop.operatingMode || whoop.mode || "NORMAL" : "NORMAL" }, pvAuto, regAuto);

      let bodyState = "sin datos biométricos";
      let moodEstimated = "neutral";
      let tradingModeSuggestion = "NEUTRAL — sin datos biométricos, proceder con cautela";
      let operatingMode = "NORMAL";

      if (whoop && whoop.connected) {
        operatingMode = whoop.operatingMode || whoop.mode || "NORMAL";

        if (strain !== null && strain >= 10) {
          bodyState = "carga física alta";
          moodEstimated = "posible cansancio";
          tradingModeSuggestion = "DEFENSIVO — baja riesgo, evita sobreoperar y prioriza decisiones simples";
        } else if (strain !== null && strain < 3) {
          bodyState = "carga física baja";
          moodEstimated = "tranquilo";
          tradingModeSuggestion = "ANÁLISIS — buen momento para revisar mercado sin forzar trades";
        } else {
          bodyState = "estado físico estable";
          moodEstimated = "neutral";
          tradingModeSuggestion = "NORMAL — puedes analizar con calma y confirmar señales";
        }
      }

      const alfredoNote = whoop && whoop.connected
        ? `WHOOP conectado: recovery ${recovery ?? "—"}%, sleep ${sleep ?? "—"}%, HRV ${hrv ?? "—"} ms, RHR ${restingHeartRate ?? "—"} bpm, strain ${strain ?? "—"}, HR promedio ${averageHeartRate ?? "—"}, HR máxima ${maxHeartRate ?? "—"}. Modo operativo: ${operatingMode}. ${tradingModeSuggestion}. NO es consejo médico ni financiero.`
        : "Sin datos biométricos activos. Proceder con cautela. NO es consejo médico ni financiero.";

      const journal = {
        ok: true,
        source: whoop && whoop.connected ? "WHOOP + Cordelius" : "local_only",
        date: new Date().toLocaleDateString("es-MX", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric"
        }),
        moodEstimated,
        bodyState,
        operatingMode,
        mode: operatingMode,
        tradingModeSuggestion,
        alfredoNote,
        alfredoAdvice: alfredoNote,
        strain,
        averageHeartRate,
        maxHeartRate,
        recovery,
        sleep,
        hrv,
        restingHeartRate,
        alfredoQuestion: ctxAuto.question,
        trading: {
          equityMXN: pvAuto.totalValueMXN,
          pnlMXN: pvAuto.totalGainMXN,
          pnlPct: pvAuto.totalGainPct,
          riskMode: operatingMode,
          marketRegime: regAuto.label
        },
        whoop: {
          connected: !!(whoop && whoop.connected),
          strain,
          averageHeartRate,
          maxHeartRate,
          kilojoule,
          scoreState,
          recovery,
          sleep,
          hrv,
          restingHeartRate,
          operatingMode,
          mode: operatingMode,
          alfredoAdvice: whoop ? whoop.alfredoAdvice || null : null
        },
        educationalNote: "Generado automáticamente. No es consejo médico ni financiero."
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(journal));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: false,
        error: "auto_journal_crash",
        message: e.message
      }));
    }
  }


  if (path === "/api/trading/summary") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeTradingSummary()));
  }
  if (path === "/api/intelligence/feed") {
    const now = Date.now();
    const items = [];
    news.slice(0, 25).forEach(n => {
      const publishedMs = n.datetime ? Number(n.datetime) * 1000 : now;
      items.push({
        ticker: (n.related || n.symbol || "MARKET").toString().toUpperCase(),
        source: n.source || "news",
        publishedDate: new Date(publishedMs).toISOString().slice(0, 10),
        eventDate: null,
        delayDays: Math.max(0, Math.round((now - publishedMs) / 86400000)),
        type: "news",
        sentiment: "uncertain",
        confidence: 50,
        link: n.url || "#",
        summary: (n.summary || n.headline || "Noticia sin resumen").toString().slice(0, 180),
        educationalImpact: "Contexto educativo, no señal de trading."
      });
    });
    (computeQuiverIntelligence().latestTrades || []).slice(0, 25).forEach(t => {
      const eventDate = t.date || null;
      const eventMs = eventDate ? Date.parse(eventDate) : NaN;
      const delayDays = Number.isFinite(eventMs) ? Math.max(0, Math.round((now - eventMs) / 86400000)) : null;
      items.push({
        ticker: t.symbol || "—",
        source: t.dataset || "Quiver/public disclosure",
        publishedDate: null,
        eventDate,
        delayDays,
        delayBadge: delayDays === null ? "unknown" : delayDays <= 0 ? "LIVE" : delayDays <= 7 ? "1-7d" : delayDays <= 30 ? "8-30d" : "stale",
        type: t.dataset === "Insider" ? "insider" : t.dataset === "Congreso" ? "congressional" : "political",
        sentiment: /buy|purchase/i.test(t.transaction || "") ? "bullish" : /sale|sell/i.test(t.transaction || "") ? "bearish" : "neutral",
        confidence: delayDays === null ? 45 : delayDays <= 7 ? 68 : delayDays <= 30 ? 55 : 40,
        link: null,
        summary: `${t.transaction || "Actividad"} ${t.symbol || ""} reportado por ${t.who || "fuente pública"}`.trim(),
        educationalImpact: "Revisar retraso y contexto; no perseguir trades."
      });
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), items, disclaimer: "Contexto educativo, no señal de trading." }));
  }
  if (path === "/api/alfredo/context") {
    const h = computeHealthReadiness();
    const pv2 = portfolioValue();
    const reg2 = marketRegime();
    const ctx = alfredoDailyContext(h, pv2, reg2);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      alfredoMode: ctx.mode,
      alfredoOneLiner: ctx.oneLiner,
      alfredoQuestion: ctx.question,
      alfredoNextActions: ctx.nextActions,
      alfredoRiskWarning: "No es consejo financiero ni médico. Si no tengo un dato, no lo invento.",
      alfredoMemorySuggestion: journalEntries.length ? "Revisar patrones de journal antes de decidir." : "Guardar una nota rápida para crear memoria local."
    }));
  }

  if (path === "/api/autopilot/database") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(buildAutopilotDatabaseSummary()));
  }
  if (path === "/api/autopilot/progress") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(computeAutopilotProgress()));
  }
  if (req.method === "POST" && path === "/api/autopilot/snapshot") {
    try {
      const snapshot = await createAutopilotSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(snapshot));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok:false, error:"autopilot_snapshot_crash", message:e.message }));
    }
  }


  if (path === "/api/os-status") {
    const h = computeHealthReadiness();
    const jd = computeJournalData();
    const pv2 = portfolioValue();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      uptime: Math.floor(process.uptime()),
      modules: {
        trading: { active: true, portfolioMXN: pv2.totalValueMXN, gainPct: pv2.totalGainPct, quiver: quiverData.configured },
        health: { active: true, configured: h.configured, operatingMode: h.operatingMode, whoop: WHOOP_CONFIGURED },
        journal: { active: true, entries: jd.count, topMood: jd.topMood },
        intelligence: { active: true, news: news.length, intel: intelItems.length, quiver: quiverData.configured },
        autopilot: { active: true, paperMode: true, realTrading: false, alpaca: ALPACA_CONFIGURED }
      },
      systemFlags: {
        serverOnline: true,
        paperModeOnly: true,
        realTradingOff: true,
        alpacaPaperOnly: ALPACA_PAPER
      }
    }));
  }
  if (req.method === "POST" && path === "/research") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      const ticker = ((new URLSearchParams(body).get("ticker") || "").toUpperCase().replace(/[^A-Z0-9.]/g, "")).slice(0, 10);
      if (!ticker) { res.writeHead(400, {"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:false,error:"ticker requerido"})); }
      const pv = portfolioValue();
      const portAsset = (pv.assets || []).find(a => a.symbol === ticker);
      const cong = (quiverData.congress || []).filter(r => r.Ticker === ticker).slice(0, 3);
      const ins = (quiverData.insiders || []).filter(r => r.Ticker === ticker).slice(0, 3);
      const relatedNews = news.filter(n => n.impacted && n.impacted.includes(ticker)).slice(0, 3);
      const context = [
        `TICKER: ${ticker}`,
        portAsset
          ? `EN PORTAFOLIO: Sí — ${portAsset.units} unidades, valor ${money(portAsset.valueMXN)}, ganancia ${pct(portAsset.gainPct)}, score ${portAsset.score}/100, señal: ${portAsset.signal}`
          : `EN PORTAFOLIO: No — ticker externo`,
        `QUIVER Congreso: ${cong.length ? cong.map(r => `${r.Date||""} ${r.Representative||""} ${r.Transaction||""}`).join("; ") : "sin datos"}`,
        `QUIVER Insiders: ${ins.length ? ins.map(r => `${r.Date||""} ${r.InsiderTitle||""} ${r.Transaction||""}`).join("; ") : "sin datos"}`,
        `NOTICIAS: ${relatedNews.length ? relatedNews.map(n => n.headline).join("; ") : "sin noticias recientes"}`
      ].join("\n");
      const q = `Investiga el ticker ${ticker}. Dame: (1) breve descripción del negocio y sector, (2) señales Quiver si las hay, (3) noticias relevantes, (4) tesis educativa de inversión, (5) riesgos principales. Contexto:\n${context}\nMáximo 4 párrafos concisos. Recuerda: análisis educativo, no consejo financiero.`;
      try {
        const reply = await alfredoReply(q);
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true, ticker, reply}));
      } catch(e) {
        res.writeHead(500, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:false, error:e.message}));
      }
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(render());
});

async function boot() {
  // CORDELIUS_BOOT_LISTEN_FIRST_FIX
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`${CORDA_APP_NAME} listo en http://localhost:${PORT}`);
  });

  setTimeout(async () => {
    try {
      await Promise.race([
        refreshQuotes(),
        new Promise(resolve => setTimeout(resolve, 8000))
      ]);
    } catch (e) {
      console.log("refreshQuotes background omitido:", e.message);
    }

    try {
      await Promise.race([
        refreshCryptoQuotes(),
        new Promise(resolve => setTimeout(resolve, 8000))
      ]);
    } catch (e) {
      console.log("refreshCryptoQuotes background omitido:", e.message);
    }

    try {
      await Promise.race([
        refreshTechnicalIndicators(),
        new Promise(resolve => setTimeout(resolve, 25000))
      ]);
    } catch (e) {
      console.log("refreshTechnicalIndicators background omitido:", e.message);
    }

    try {
      await Promise.race([
        fetchNews(),
        new Promise(resolve => setTimeout(resolve, 8000))
      ]);
    } catch (e) {
      console.log("fetchNews background omitido:", e.message);
    }

    try { savePortfolioPoint(); } catch (e) { console.log("savePortfolioPoint omitido:", e.message); }
    try { botTick(); } catch (e) { console.log("botTick omitido:", e.message); }

    try {
      await Promise.race([
        fetchQuiverData(),
        new Promise(resolve => setTimeout(resolve, 10000))
      ]);
    } catch (e) { console.log("fetchQuiverData boot omitido:", e.message); }

    try {
      await Promise.race([
        refreshWhoopCache(),
        new Promise(resolve => setTimeout(resolve, 10000))
      ]);
    } catch (e) { console.log("refreshWhoopCache boot omitido:", e.message); }

    setInterval(async () => {
      try { await Promise.race([refreshWhoopCache(), new Promise(r => setTimeout(r, 10000))]); } catch (e) {}
    }, WHOOP_CACHE_MS);

    setInterval(async () => {
      try {
        await Promise.race([
          refreshQuotes(),
          new Promise(resolve => setTimeout(resolve, 8000))
        ]);
      } catch (e) {
        console.log("refreshQuotes interval omitido:", e.message);
      }

      try {
        await Promise.race([
          refreshCryptoQuotes(),
          new Promise(resolve => setTimeout(resolve, 8000))
        ]);
      } catch (e) {
        console.log("refreshCryptoQuotes interval omitido:", e.message);
      }

      try { refreshTechnicalIndicators(); } catch (e) {} // TTL interno de 2h; no martillea APIs

      try { savePortfolioPoint(); } catch (e) {}
      try { botTick(); } catch (e) {}
    }, settings.autoRefreshSeconds * 1000);

    setInterval(async () => {
      try {
        await Promise.race([
          fetchNews(),
          new Promise(resolve => setTimeout(resolve, 8000))
        ]);
      } catch (e) {
        console.log("fetchNews interval omitido:", e.message);
      }
    }, 1000 * 60 * 12);

    setInterval(async () => {
      try {
        await Promise.race([
          fetchQuiverData(),
          new Promise(resolve => setTimeout(resolve, 10000))
        ]);
      } catch (e) {}
    }, QUIVER_CACHE_MS);
  }, 500);
}
boot();

/* CORDELIUS_P1_APPLIED */

/* CORDELIUS_P1C_SEGURO_APPLIED */

/* CORDELIUS_P2_INTEL_APPLIED */

/* CORDELIUS_CLAUDE_SMART_APPLIED */

/* CORDELIUS_F3A1_APPLIED */
