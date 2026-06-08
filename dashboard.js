const http = require("http");
const https = require("https");
const fs = require("fs");

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
// Telegram alerts — read at runtime, never logged
const TG_TOKEN_CONFIGURED = !!(process.env.TELEGRAM_BOT_TOKEN);
const TG_CHAT_CONFIGURED  = !!(process.env.TELEGRAM_CHAT_ID);

const BOT_FILE = "bot_state.json";
const HISTORY_FILE = "portfolio_history.json";
const CHAT_FILE = "alfredo_chat_history.json";
const SETTINGS_FILE = "cordelius_settings.json";
const INTEL_FILE = "cordelius_intel.json";
const JOURNAL_FILE = "cordelius_journal.json";
const WHOOP_TOKEN_FILE = "whoop_tokens.json";
const WHOOP_CACHE_MS = 5 * 60 * 1000;

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
}
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
  appName: "Cordelius", assistantName: "Alfredo AI"
});

let quotes = {};
let news = [];
let chatHistory = loadJSON(CHAT_FILE, []);
let portfolioHistory = loadJSON(HISTORY_FILE, []);
let intelItems = loadJSON(INTEL_FILE, []);
let journalEntries = loadJSON(JOURNAL_FILE, []);
let whoopTokens = loadJSON(WHOOP_TOKEN_FILE, null);
let whoopCache = { profile: null, cycle: null, recovery: null, lastFetch: 0, connected: false };
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
    const req = https.get(url, res => {
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

async function fetchWhoopAPI(path) {
  if (!whoopTokens || !whoopTokens.access_token) return null;
  if (whoopTokens.expires_at && Date.now() > whoopTokens.expires_at - 60000) {
    const ok = await refreshWhoopToken();
    if (!ok) return null;
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

function assetLiveValue(a) { if (a.source === "GBM" || a.source === "Bitso" || a.currency === "MXN") return a.valueManual; const q = quotes[a.symbol]; if (q && Number.isFinite(q.value)) return q.value; return a.valueManual; }
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
    return { ...a, liveValue: assetLiveValue(a), valueMXN, costMXN, gainMXN, gainPct, day: Number(q.day || 0), score: assetScore(a), risk: assetRisk(a), signal: assetSignal(a), zones: tradeZones(a), quoteSource: q.source || "manual", ind: indicators(a) };
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
  if (portfolioHistory.length > 600) portfolioHistory = portfolioHistory.slice(-600);
  saveJSON(HISTORY_FILE, portfolioHistory);
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

  // X-axis: up to 7 date labels
  const xTicks = [];
  const xStep = Math.ceil(rawData.length / 6);
  rawData.forEach((d, i) => {
    if (i % xStep !== 0 && i !== rawData.length - 1) return;
    const p = xy[i];
    const label = d.t ? new Date(d.t).toLocaleDateString("es-MX", { month: "short", day: "numeric" }) : String(i + 1);
    xTicks.push(`<text x="${p.x.toFixed(1)}" y="${height - 6}" fill="#9fb3c8" font-size="13" text-anchor="middle">${label}</text>`);
  });

  // Dots with SVG <title> tooltips
  const dots = xy.map((p, i) => {
    if (i !== 0 && i !== rawData.length - 1 && i % Math.ceil(rawData.length / 8) !== 0) return "";
    const tooltip = (p.t ? new Date(p.t).toLocaleDateString("es-MX") + " · " : "") + fmtV(p.v).replace("$", "$");
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${color}" stroke="#02040a" stroke-width="2"><title>${tooltip}</title></circle>`;
  }).join("");

  // Recent values table (last 6 points)
  let tableHtml = "";
  if (showTable && rawData.some(d => d.t != null) && rawData.length >= 3) {
    const recent = rawData.slice(-6);
    const rows = recent.map(d => {
      const dateStr = d.t ? new Date(d.t).toLocaleDateString("es-MX", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
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

  return {
    ok: true, ts: Date.now(), date: new Date().toLocaleDateString("es-MX"),
    portfolioSummary, quiverSummary, marketThemes, tickerHighlights,
    riskAlerts: riskAlerts.slice(0, 10),
    educationalActions: educationalActions.slice(0, 6),
    educationalSummary,
    rawMatchesLimited: allQuiverMatches.slice(0, 20),
    intel: {
      count: intelItems.length,
      positive: intelPositive,
      negative: intelNegative,
      affectedTickers: intelAffected,
      hotTickers: intelHotTickers,
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
      bot.history.unshift({ type: "SELL", symbol: sym, units: pos.units, priceMXN, value, pnl, reason: priceMXN <= pos.sl ? "Stop loss simulado" : priceMXN >= pos.tp ? "Take profit simulado" : "Senal Alfredo", time: nowMX() });
      delete bot.positions[sym];
      addThought(`VENTA simulada en ${sym}: ${pnl >= 0 ? "asegurando ganancia" : "cortando riesgo"} (${money(pnl)}).`, pnl >= 0 ? "sell" : "risk");
    }
  }
  const eq = botValue();
  bot.equityHistory.push({ t: Date.now(), v: eq });
  bot.equityHistory = bot.equityHistory.slice(-500);
  const peak = Math.max(...bot.equityHistory.map(x => x.v), bot.initialCapital);
  bot.maxDrawdown = Math.max(bot.maxDrawdown || 0, peak ? ((peak - eq) / peak) * 100 : 0);
  bot.lastTick = new Date().toISOString();
  bot.history = (bot.history || []).slice(0, 100);
  saveJSON(BOT_FILE, bot);
}


async function askClaude(question, localReply, pv, reg, botEq, botPnl, jarvisMemory = "") {
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
Eres Alfredo AI dentro de Cordelius OS. Responde en español mexicano, claro, directo y útil.
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

MEMORIA PERSONAL DE CORDELIUS (historial comprimido — úsala para dar respuestas más personalizadas):
${jarvisMemory || "Sin memoria disponible todavía."}

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
    system: "Eres Alfredo AI, copiloto educativo de trading y portafolio. No das asesoría financiera; ayudas a entender riesgo, costos, exposición y escenarios.",
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
  let jarvisMemory = "";
  try { jarvisMemory = buildMemorySummary(); } catch(e) { jarvisMemory = ""; }
  const ai = await askClaude(question, reply, pv, reg, botEq, botPnl, jarvisMemory);
  if (ai) reply = ai;
  chatHistory.unshift({ question, reply, time: nowMX() });
  chatHistory = chatHistory.slice(0, 60);
  saveJSON(CHAT_FILE, chatHistory);
  addThought(`Alfredo respondio: "${question.slice(0, 50)}..."`, "ai");
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

        <!-- Positions summary strip -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:14px">
          <div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">Broker</div>
            <div style="font-size:14px;font-weight:900;color:#eaf6ff">${esc(a.source)}</div>
          </div>
          <div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">Unidades</div>
            <div style="font-size:14px;font-weight:900;color:#eaf6ff">${unitsLabel}</div>
          </div>
          <div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">Costo original</div>
            <div style="font-size:14px;font-weight:900;color:#eaf6ff">${money(a.costMXN)}</div>
          </div>
          <div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">Valor actual</div>
            <div style="font-size:14px;font-weight:900;color:#eaf6ff">${money(a.valueMXN)}</div>
          </div>
          <div style="background:rgba(${a.gainMXN >= 0 ? "0,255,153" : "255,77,109"},.06);border:1px solid rgba(${a.gainMXN >= 0 ? "0,255,153" : "255,77,109"},.18);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">P&amp;L</div>
            <div style="font-size:14px;font-weight:900;color:${a.gainMXN >= 0 ? "#00ff99" : "#ff4d6d"}">${money(a.gainMXN)} (${pct(a.gainPct)})</div>
          </div>
          <div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">Precio actual</div>
            <div style="font-size:14px;font-weight:900;color:#eaf6ff">${curLabel}</div>
          </div>
          <div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">Precio compra</div>
            <div style="font-size:14px;font-weight:900;color:#eaf6ff">${avgLabel}</div>
          </div>
          <div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.12);border-radius:12px;padding:10px 12px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">Fuente precio</div>
            <div style="font-size:13px;font-weight:700;color:#eaf6ff">${esc(a.quoteSource === "live" ? "LIVE" : "Manual")}</div>
          </div>
        </div>

        <!-- Technical Indicators -->
        <div style="background:rgba(59,157,255,.04);border:1px solid rgba(59,157,255,.14);border-radius:16px;padding:14px 16px;margin-bottom:12px">
          <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#3b9dff;margin-bottom:10px">Indicadores técnicos</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">
            ${[
              { label: "RSI",       val: ind.rsi,        color: ind.rsi > 70 ? "#ff4d6d" : ind.rsi < 30 ? "#00ff99" : "#ffd35c", note: ind.rsi > 70 ? "Sobrecomprado" : ind.rsi < 30 ? "Sobrevendido" : "Neutro" },
              { label: "MACD",      val: ind.macd.toFixed(2), color: ind.macd >= 0 ? "#00ff99" : "#ff4d6d", note: ind.macd >= 0 ? "Positivo" : "Negativo" },
              { label: "Momentum",  val: ind.momentum.toFixed(1), color: ind.momentum >= 0 ? "#00ff99" : "#ff4d6d", note: ind.momentum > 5 ? "Fuerte" : ind.momentum < -5 ? "Débil" : "Moderado" },
              { label: "Tendencia", val: ind.trend,       color: ind.trend === "ALCISTA" ? "#00ff99" : ind.trend === "BAJISTA" ? "#ff4d6d" : "#ffd35c", note: "" },
              { label: "Volatilidad",val: ind.volatility,  color: ind.volatility === "ALTA" ? "#ff4d6d" : ind.volatility === "BAJA" ? "#00ff99" : "#ffd35c", note: "" },
              { label: "Volumen",   val: ind.volatility === "ALTA" ? "ALTO" : ind.volatility === "BAJA" ? "BAJO" : "MEDIO", color: "#9fb3c8", note: "" },
              { label: "Score IA",  val: a.score + "/100", color: a.score >= 65 ? "#00ff99" : a.score >= 40 ? "#ffd35c" : "#ff4d6d", note: a.score >= 65 ? "Sólido" : a.score >= 40 ? "Moderado" : "Débil" },
              { label: "Riesgo",    val: a.risk,          color: a.risk === "ALTO" ? "#ff4d6d" : a.risk === "BAJO" ? "#00ff99" : "#ffd35c", note: "" },
            ].map(item => `<div style="background:rgba(0,0,0,.25);border:1px solid ${item.color}28;border-radius:10px;padding:8px 10px;text-align:center">
              <div style="font-size:9px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#9fb3c8;margin-bottom:3px">${item.label}</div>
              <div style="font-size:16px;font-weight:950;color:${item.color}">${esc(String(item.val))}</div>
              ${item.note ? `<div style="font-size:10px;color:${item.color}88;margin-top:2px">${esc(item.note)}</div>` : ""}
            </div>`).join("")}
          </div>
        </div>

        <!-- Alfredo Score + Signal -->
        <div class="alfredo-score" style="border-color:${act.color}55;margin-bottom:12px">
          <div class="as-head"><b style="color:${act.color}">${act.action}</b><span class="muted">Score ${act.score}/100</span></div>
          <ul>${act.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
        </div>

        <!-- Tesis / Riesgos / Catalizadores -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:12px">
          <div style="background:rgba(0,255,153,.04);border:1px solid rgba(0,255,153,.14);border-radius:14px;padding:12px 14px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#00ff99;margin-bottom:7px">Tesis</div>
            <div style="font-size:13px;color:#c8d8f0;line-height:1.55">
              ${a.gainPct > 20 ? `Posición en ganancia (${pct(a.gainPct)}) — la tesis de entrada se confirmó parcialmente. ` : ""}
              ${a.gainPct < -10 ? `Posición en pérdida (${pct(a.gainPct)}) — revisar si la tesis original sigue vigente. ` : ""}
              ${a.type === "crypto" ? "Activo cripto: alta volatilidad, bajo en fundamentales clásicos. " : ""}
              ${a.score >= 65 ? "Score sólido — mantener posición actual." : a.score >= 40 ? "Score moderado — vigilar catalizadores." : "Score bajo — no promediar sin revisar."}
            </div>
          </div>
          <div style="background:rgba(255,77,109,.04);border:1px solid rgba(255,77,109,.14);border-radius:14px;padding:12px 14px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#ff4d6d;margin-bottom:7px">Riesgos</div>
            <div style="font-size:13px;color:#c8d8f0;line-height:1.55">
              ${a.risk === "ALTO" ? "Riesgo alto: posición concentrada o volátil. " : ""}
              ${isCrypto ? "Riesgo regulatorio y de liquidez en cripto. " : ""}
              ${ind.rsi > 70 ? "RSI sobrecomprado — posible corrección a corto plazo. " : ""}
              ${ind.trend === "BAJISTA" ? "Tendencia bajista activa — esperar señal de reversión. " : ""}
              ${a.gainPct < -20 ? `Caída mayor al 20% — evaluar salida defensiva. ` : ""}
              ${a.risk !== "ALTO" && !isCrypto && ind.rsi <= 70 ? "Perfil de riesgo moderado." : ""}
            </div>
          </div>
          <div style="background:rgba(255,211,92,.04);border:1px solid rgba(255,211,92,.14);border-radius:14px;padding:12px 14px">
            <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#ffd35c;margin-bottom:7px">Catalizadores</div>
            <div style="font-size:13px;color:#c8d8f0;line-height:1.55">
              ${a.signal.includes("BUY") ? "Señal educativa de compra activa. " : ""}
              ${ind.rsi < 35 ? "RSI bajo — posible zona de acumulación. " : ""}
              ${ind.macd > 0 && ind.momentum > 0 ? "MACD y momentum positivos: momento técnico favorable. " : ""}
              ${a.gainPct > 50 ? "Ganancia acumulada alta: evaluar toma parcial de utilidades. " : ""}
              ${a.signal.includes("VIGILAR") ? "Señal de vigilancia: monitorear en próximas sesiones. " : ""}
              ${!a.signal.includes("BUY") && ind.rsi >= 35 ? "Sin catalizadores técnicos claros en este momento." : ""}
            </div>
          </div>
        </div>

        <!-- Zones + Links -->
        <div class="detail-grid" style="margin-bottom:10px">
          <div><span>Zona compra</span><b>${a.currency === "USD" ? money(z.buy, "USD") : money(z.buy)}</b></div>
          <div><span>Zona venta</span><b>${a.currency === "USD" ? money(z.sell, "USD") : money(z.sell)}</b></div>
          <div><span>Stop educativo</span><b>${a.currency === "USD" ? money(z.stop, "USD") : money(z.stop)}</b></div>
          <div><span>Señal Alfredo</span><b style="font-size:12px">${esc(a.signal)}</b></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <a class="tv-link" target="_blank" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(TV_SYMBOL[a.symbol] || a.symbol)}">Ver en TradingView ↗</a>
          <button onclick="setJarvisQ('analiza ${a.symbol} en mi portafolio')" class="btn" style="font-size:12px;padding:7px 14px;color:#3b9dff;border-color:rgba(59,157,255,.3)">Consultar Jarvis</button>
          <button onclick="openDecisionModal && openDecisionModal()" class="btn" style="font-size:12px;padding:7px 14px;color:#00c8ff;border-color:rgba(0,200,255,.3)">Guardar decisión</button>
          <button onclick="openPortfolioEdit('${esc(a.symbol)}')" class="btn" style="font-size:12px;padding:7px 14px;color:#ffd35c;border-color:rgba(255,211,92,.3)">Editar posición</button>
          <button onclick="removePortfolioAsset('${esc(a.symbol)}')" class="btn" style="font-size:12px;padding:7px 14px;color:#ff4d6d;border-color:rgba(255,77,109,.3)">Eliminar</button>
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
      + (hashVal ? '<form method="POST" action="/intel/delete" style="margin:0">'
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
    ? '<form method="POST" action="/intel/clear" onsubmit="return confirm(\'Borrar todos los analisis Intel? Esta accion no se puede deshacer.\')" style="margin:0">'
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
    + '<form method="POST" action="/intel">'
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
      + '<button onclick="saveAutopilotDecisionFromScan()" style="margin-left:8px;padding:5px 14px;border-radius:8px;border:1px solid rgba(0,200,255,.35);background:rgba(0,200,255,.08);color:#00c8ff;font-size:12px;font-weight:700;cursor:pointer" id="scan-save-btn">Guardar en Autopilot Memory</button>'
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
    const portfolioHits = impacted.filter(x => portfolioSymbols.has(x));
    const dateStr = n.datetime ? new Date(n.datetime * 1000).toLocaleDateString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    const impactColor = c.impactColor || "#3b9dff";
    const isPositive  = c.impact === "POSITIVO";
    const isNegative  = c.impact === "NEGATIVO";
    const riskLabel   = isNegative ? "RIESGO" : isPositive ? "OPORTUNIDAD" : "NEUTRAL";
    const riskColor   = isNegative ? "#ff4d6d" : isPositive ? "#00ff99" : "#ffd35c";
    const img = n.image ? `<img style="width:100%;max-height:160px;object-fit:cover;border-radius:12px;margin-bottom:10px" src="${esc(n.image)}" alt="">` : "";
    const alfredoMini = portfolioHits.length > 0
      ? `${riskLabel} · ${portfolioHits.join(", ")} → ${isNegative ? "Vigilar exposición" : isPositive ? "Revisar catalizador" : "Monitorear"}`
      : `${esc(c.type)} · ${esc(c.region)} · Mercado general`;
    return `<details class="news-item"${openByDefault ? " open" : ""}>
      <summary>
        <span style="flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:${impactColor};flex-shrink:0"></span>
        <span style="flex:1;font-size:14px;font-weight:700;color:#dbeafe;line-height:1.35">${esc(n.headline || "Sin título")}</span>
        ${portfolioHits.length ? `<span style="flex:0 0 auto;border-radius:99px;padding:2px 8px;background:${riskColor}22;border:1px solid ${riskColor}44;color:${riskColor};font-size:10px;font-weight:900;white-space:nowrap">${esc(riskLabel)}</span>` : ""}
        ${n.source ? `<span style="flex:0 0 auto;font-size:10px;color:#9fb3c8;white-space:nowrap">${esc(n.source)}</span>` : ""}
        ${dateStr ? `<span style="flex:0 0 auto;font-size:10px;color:#9fb3c8;white-space:nowrap">${esc(dateStr)}</span>` : ""}
        <span class="ni-caret">▾</span>
      </summary>
      <div style="padding:0 16px 14px">
        ${img}
        <div class="chips">
          <span>${esc(c.type)}</span>
          <span style="background:${impactColor}22;border-color:${impactColor}55;color:${impactColor}">${esc(c.impact)} · ${c.confidence}%</span>
          <span>${esc(c.region)}</span>
          ${portfolioHits.length ? `<span style="background:${riskColor}18;border-color:${riskColor}44;color:${riskColor};font-weight:900">${esc(riskLabel)}</span>` : ""}
        </div>
        <p style="color:#cbd5e1;font-size:14px;margin:8px 0;line-height:1.6">${esc((n.summary || "").slice(0, 300))}</p>
        ${portfolioHits.length ? `
        <div style="padding:8px 12px;border-radius:10px;background:${riskColor}0d;border:1px solid ${riskColor}30;margin:8px 0">
          <div style="font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:${riskColor};margin-bottom:4px">Impacto en tu portafolio</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${portfolioHits.map(x => `<span style="background:${riskColor}18;border:1px solid ${riskColor}40;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:900;color:${riskColor}">${esc(x)}</span>`).join("")}</div>
        </div>` : ""}
        <div class="impact"><b>Activos:</b>${impacted.map(x => `<span style="${portfolioSymbols.has(x) ? "background:rgba(0,255,153,.12);border-color:rgba(0,255,153,.3);color:#00ff99" : ""}">${esc(x)}</span>`).join("")}</div>
        <div class="why" style="border-left-color:${riskColor}">Alfredo: ${esc(alfredoMini)}. No ejecutar sin análisis propio.</div>
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
const AUTOPILOT_MEMORY_FILE = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "autopilot_memory.json");
const CORDELIUS_PROGRESS_FILE = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "cordelius_progress.json");
const DECISION_OUTCOMES_FILE  = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "decision_outcomes.json");
const DAILY_LEARNING_FILE     = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "daily_learning.json");
const MARKET_DAILY_FILE       = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "market_daily_snapshots.json");
const USER_CHECKINS_FILE      = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "user_daily_checkins.json");
const CORDELIUS_PATTERNS_FILE     = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "cordelius_patterns.json");
const DAILY_INTELLIGENCE_FILE     = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "daily_intelligence_summary.json");
const CORDELIUS_ALERTS_FILE       = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "cordelius_alerts.json");
const PORTFOLIO_STORE_FILE        = AUTOPILOT_PATH.join(AUTOPILOT_DATA_DIR, "cordelius_portfolio.json");

function ensureDataDir() {
  if (!AUTOPILOT_FS.existsSync(AUTOPILOT_DATA_DIR)) {
    AUTOPILOT_FS.mkdirSync(AUTOPILOT_DATA_DIR, { recursive: true });
  }
}

function readJSONSafe(file, fallback) {
  try {
    ensureDataDir();
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
  ensureDataDir();
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

function appendSnapshot(arr, item, maxLen, file) {
  const next = Array.isArray(arr) ? arr.slice() : [];
  next.unshift(item);
  const trimmed = next.slice(0, maxLen || 200);
  writeJSONAtomic(file, trimmed);
  return trimmed;
}

// ── Runtime Portfolio Store ────────────────────────────────────────────────────
// Reads data/cordelius_portfolio.json and merges overrides into the live PORTFOLIO[]
// array (mutating it in place). All existing code that reads PORTFOLIO continues
// to work unchanged. Called synchronously at boot before server.listen().

function loadPortfolioStore() {
  try {
    ensureDataDir();
    const stored = readJSONSafe(PORTFOLIO_STORE_FILE, null);

    if (!Array.isArray(stored) || stored.length === 0) {
      // First run — snapshot current hardcoded state to file
      writeJSONAtomic(PORTFOLIO_STORE_FILE, PORTFOLIO.map(a => ({ ...a })));
      console.log("[PortfolioStore] Initialized from PORTFOLIO[] (" + PORTFOLIO.length + " assets)");
      return;
    }

    // Build lookup by symbol
    const bySymbol = {};
    for (const s of stored) { if (s && s.symbol) bySymbol[s.symbol] = s; }

    // Merge stored values into live array (mutable fields only for existing; full push for new)
    for (const sym of Object.keys(bySymbol)) {
      const s   = bySymbol[sym];
      const idx = PORTFOLIO.findIndex(a => a.symbol === sym);
      if (idx >= 0) {
        if (s.units        != null) PORTFOLIO[idx].units        = Number(s.units)       || PORTFOLIO[idx].units;
        if (s.valueManual  != null) PORTFOLIO[idx].valueManual  = Number(s.valueManual) || PORTFOLIO[idx].valueManual;
        if (s.costManual   != null) PORTFOLIO[idx].costManual   = Number(s.costManual)  || PORTFOLIO[idx].costManual;
        if (s.currency)             PORTFOLIO[idx].currency     = s.currency;
        if (s.source)               PORTFOLIO[idx].source       = s.source;
      } else {
        // Runtime-added asset — push to live array
        const sym2 = String(s.symbol).toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 10);
        PORTFOLIO.push({
          source:       String(s.source       || "Manual").slice(0, 20),
          category:     String(s.category     || "Manual").slice(0, 30),
          symbol:       sym2,
          display:      String(s.display      || sym2).slice(0, 15),
          name:         String(s.name         || sym2).slice(0, 60),
          units:        Number(s.units)       || 0,
          currency:     ["MXN","USD"].includes(s.currency) ? s.currency : "MXN",
          valueManual:  Number(s.valueManual) || 0,
          costManual:   Number(s.costManual)  || 0,
          brokerGainPct:Number(s.brokerGainPct)||0,
          logo:         String(s.logo || sym2.slice(0, 2)).slice(0, 4).toUpperCase(),
          color:        /^#[0-9a-fA-F]{3,6}$/.test(s.color || "") ? s.color : "#334155",
          liveTicker:   String(s.liveTicker || sym2).slice(0, 20),
          type:         ["stock","stock_mx","crypto","etf"].includes(s.type) ? s.type : "stock"
        });
      }
    }

    // If hardcoded entries are missing from the file, write a full snapshot
    const needsWrite = PORTFOLIO.some(a => !bySymbol[a.symbol]);
    if (needsWrite) writeJSONAtomic(PORTFOLIO_STORE_FILE, PORTFOLIO.map(a => ({ ...a })));

    console.log("[PortfolioStore] Loaded: " + PORTFOLIO.length + " assets");
  } catch(e) {
    console.log("[PortfolioStore] loadPortfolioStore error:", e.message);
  }
}

function savePortfolioStore() {
  writeJSONAtomic(PORTFOLIO_STORE_FILE, PORTFOLIO.map(a => ({ ...a })));
}

// ── Daily Learning Engine — server functions ────────────────────────────────
function todayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function computeMarketContext() {
  try {
    const pv = portfolioValue();
    const assets = Array.isArray(pv.assets) ? pv.assets : [];
    const total  = Number(pv.totalValueMXN || 0);
    let topWinner = null, topWinnerGain = -Infinity;
    let topLoser  = null, topLoserGain  =  Infinity;
    for (const a of assets) {
      const g = Number(a.gainPct || 0);
      if (g > topWinnerGain) { topWinnerGain = g; topWinner = a.symbol; }
      if (g < topLoserGain)  { topLoserGain  = g; topLoser  = a.symbol; }
    }
    const cryptoVal = assets.filter(a => a.type === "crypto").reduce((s, a) => s + (a.valueMXN || 0), 0);
    let riskMode = "NORMAL";
    try { const reg = marketRegime ? marketRegime() : null; if (reg) riskMode = reg.label || "NORMAL"; } catch(e) {}
    let newsSummary = "unavailable";
    try { if (Array.isArray(news) && news.length) newsSummary = `${news.length} artículos`; } catch(e) {}
    let intelSummary = "unavailable";
    try {
      if (Array.isArray(intelItems) && intelItems.length) {
        const pos = intelItems.filter(x => x.mood === "POSITIVO").length;
        const neg = intelItems.filter(x => x.mood === "NEGATIVO").length;
        intelSummary = `${intelItems.length} items (${pos}+ ${neg}-)`;
      }
    } catch(e) {}
    return {
      available: true,
      portfolioMXN: pv.totalValueMXN,
      portfolioUSD: total > 0 ? parseFloat((total / FX_USD_MXN).toFixed(2)) : null,
      gainPct:  pv.totalGainPct,
      gainMXN:  pv.totalGainMXN,
      topWinner,
      topWinnerGain: topWinnerGain === -Infinity ? null : parseFloat(topWinnerGain.toFixed(2)),
      topLoser,
      topLoserGain:  topLoserGain  ===  Infinity ? null : parseFloat(topLoserGain.toFixed(2)),
      cryptoExposurePct: total > 0 ? parseFloat((cryptoVal / total * 100).toFixed(2)) : 0,
      assetCount: assets.length,
      riskMode, newsSummary, intelSummary
    };
  } catch(e) {
    return { available: false, error: e.message };
  }
}

function computeDailyLearningSnapshot() {
  const dateKey = todayDateKey();
  const history = readJSONSafe(DAILY_LEARNING_FILE, {});

  // WHOOP = source of truth for physiological metrics
  let whoopData = { source: "unavailable" };
  try {
    const h = computeHealthReadiness();
    whoopData = {
      recovery: h.recovery, sleep: h.sleep, hrv: h.hrv,
      restingHeartRate: h.restingHeartRate, strain: h.strain,
      averageHeartRate: h.averageHeartRate, maxHeartRate: h.maxHeartRate,
      sleepEfficiency: h.sleepEfficiency ?? null, sleepConsistency: h.sleepConsistency ?? null,
      sleepDebt: h.sleepDebt ?? null, respiratoryRate: h.respiratoryRate ?? null,
      healthScore: h.healthScore ?? null, energyScore: h.energyScore ?? null,
      deepWorkScore: h.deepWorkScore ?? null, nervousSystemScore: h.nervousSystemScore ?? null,
      stressLoadScore: h.stressLoadScore ?? null, operatingMode: h.operatingMode, source: h.source
    };
  } catch(e) { whoopData.error = e.message; }

  const market  = computeMarketContext();
  const checkins = readJSONSafe(USER_CHECKINS_FILE, {});
  const checkin  = checkins[dateKey] || {};

  // Derive learning output
  const rec   = Number(whoopData.recovery || 0);
  const slp   = Number(whoopData.sleep    || 0);
  const mode  = whoopData.operatingMode   || "NORMAL";
  const focus = Number(checkin.focus      || 5);

  let tradingCapacity = "MEDIA";
  if (rec >= 70 && slp >= 70 && focus >= 7) tradingCapacity = "ALTA";
  else if (rec < 50 || slp < 50 || focus <= 3) tradingCapacity = "BAJA";

  let riskRecommendation = "NORMAL";
  if (mode === "DEFENSIVO" || rec < 50) riskRecommendation = "REDUCIR_RIESGO";
  else if (mode === "ÓPTIMO" && rec >= 70 && slp >= 70) riskRecommendation = "NORMAL_PLUS";

  const portStr = market.available
    ? `${money(market.portfolioMXN)} (${pct(market.gainPct)})`
    : "no disponible";
  const healthMarketSummary = `Recovery ${rec}%, sueño ${slp}%, modo ${mode}. Portafolio ${portStr}. Capacidad: ${tradingCapacity}. Riesgo: ${riskRecommendation}. Educativo — no consejo financiero ni médico.`;

  const nextDaySuggestions = [];
  if (rec < 50) nextDaySuggestions.push("Recovery baja — evitar decisiones de alto riesgo mañana.");
  if (slp < 60) nextDaySuggestions.push("Sueño deficiente — prioriza descanso esta noche.");
  if (checkin.cannabis) nextDaySuggestions.push("Cannabis activo — verifica impacto en recovery mañana.");
  if (market.available && (market.cryptoExposurePct || 0) > 40)
    nextDaySuggestions.push("Concentración cripto elevada — revisa diversificación.");
  if (!nextDaySuggestions.length) nextDaySuggestions.push("Condiciones normales — sigue tu plan habitual.");

  const snapshot = {
    date: dateKey, ts: Date.now(),
    whoop: whoopData, checkin, market,
    learning: { tradingCapacity, riskRecommendation, healthMarketSummary, nextDaySuggestions }
  };

  // Upsert today — no duplicates per day
  history[dateKey] = snapshot;
  const keys = Object.keys(history).sort();
  while (keys.length > 365) delete history[keys.shift()];
  writeJSONAtomic(DAILY_LEARNING_FILE, history);

  // Market daily snapshots (separate array for charting)
  const marketSnaps = readJSONSafe(MARKET_DAILY_FILE, []);
  const mIdx   = marketSnaps.findIndex(s => s && s.date === dateKey);
  const mEntry = { date: dateKey, ts: Date.now(), ...market };
  if (mIdx >= 0) marketSnaps[mIdx] = mEntry;
  else { marketSnaps.unshift(mEntry); while (marketSnaps.length > 365) marketSnaps.pop(); }
  writeJSONAtomic(MARKET_DAILY_FILE, marketSnaps);

  return snapshot;
}

function computeCordeliusPatterns() {
  const history = readJSONSafe(DAILY_LEARNING_FILE, {});
  const records = Object.values(history).filter(r => r && r.whoop);
  if (records.length < 3) {
    return { available: false, message: "Necesitas al menos 3 días de datos para detectar patrones.", sampleCount: records.length };
  }
  function avgOf(arr) {
    const nums = arr.filter(n => n != null && !isNaN(Number(n))).map(Number);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  const withC   = records.filter(r => r.checkin && r.checkin.cannabis === true);
  const noC     = records.filter(r => r.checkin && r.checkin.cannabis === false);
  const withS   = records.filter(r => r.checkin && r.checkin.sauna   === true);
  const noS     = records.filter(r => r.checkin && r.checkin.sauna   === false);
  const hiRec   = records.filter(r => (r.whoop.recovery || 0) >= 70);
  const loRec   = records.filter(r => (r.whoop.recovery || 0) <  50);
  const goodSlp = records.filter(r => (r.whoop.sleep    || 0) >= 70);
  const badSlp  = records.filter(r => (r.whoop.sleep    || 0) <  60);

  const sorted = records.slice().sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0];
  let nextDayRec = "Datos insuficientes.";
  if (latest) {
    const r = latest.whoop.recovery || 0, s = latest.whoop.sleep || 0, m = latest.whoop.operatingMode || "";
    if (r >= 70 && s >= 70) nextDayRec = "Condiciones óptimas. Puedes asumir riesgo normal mañana.";
    else if (r < 50 || s < 60) nextDayRec = "Recovery/sueño bajo. Mañana prefiere posiciones conservadoras y evita cambios grandes.";
    else nextDayRec = "Condiciones moderadas. Sigue tu plan habitual con cautela normal.";
    if (m === "DEFENSIVO") nextDayRec += " Modo DEFENSIVO — prioriza capital preservation.";
  }

  const focusRecs = records.filter(r => r.checkin && r.checkin.focus != null);
  const best = focusRecs.length
    ? focusRecs.reduce((b, r) => (Number(r.checkin.focus || 0) > Number(b.checkin.focus || 0) ? r : b), focusRecs[0])
    : null;

  const rCanC  = avgOf(withC.map(r => r.whoop.recovery));
  const rNoC   = avgOf(noC.map(r  => r.whoop.recovery));
  const sCanS  = avgOf(withS.map(r => r.whoop.sleep));
  const sNoS   = avgOf(noS.map(r  => r.whoop.sleep));
  const pHiR   = avgOf(hiRec.map(r => r.market && r.market.gainPct));
  const pLoR   = avgOf(loRec.map(r => r.market && r.market.gainPct));
  const fGoodS = avgOf(goodSlp.map(r => r.checkin && r.checkin.focus));
  const fBadS  = avgOf(badSlp.map(r  => r.checkin && r.checkin.focus));

  const patterns = {
    available: true,
    sampleCount: records.length,
    generatedAt: new Date().toISOString(),
    cannabis:       { withAvgRecovery: rCanC  != null ? Math.round(rCanC)  : null, withoutAvgRecovery: rNoC  != null ? Math.round(rNoC)  : null, sampleWith: withC.length, sampleWithout: noC.length },
    sauna:          { withAvgSleep:    sCanS  != null ? Math.round(sCanS)  : null, withoutAvgSleep:    sNoS  != null ? Math.round(sNoS)  : null, sampleWith: withS.length, sampleWithout: noS.length },
    recoveryVsPnl:  { highRecoveryAvgPnl: pHiR != null ? parseFloat(pHiR.toFixed(2)) : null, lowRecoveryAvgPnl:  pLoR != null ? parseFloat(pLoR.toFixed(2)) : null, sampleHigh: hiRec.length, sampleLow: loRec.length },
    sleepVsFocus:   { goodSleepAvgFocus:  fGoodS != null ? parseFloat(fGoodS.toFixed(1)) : null, badSleepAvgFocus:   fBadS  != null ? parseFloat(fBadS.toFixed(1))  : null, sampleGood: goodSlp.length, sampleBad: badSlp.length },
    bestCondition:  best ? { date: best.date, recovery: best.whoop.recovery, sleep: best.whoop.sleep, focus: best.checkin.focus, mode: best.whoop.operatingMode, cannabis: best.checkin.cannabis, sauna: best.checkin.sauna } : null,
    nextDayRecommendation: nextDayRec
  };
  writeJSONAtomic(CORDELIUS_PATTERNS_FILE, patterns);
  return patterns;
}

// ── Daily Intelligence Summary ─────────────────────────────────────────────────
// Generates and persists a flat compressed summary per day for Jarvis memory.
function generateDailyIntelligenceSummary(snap) {
  try {
    const dateKey = (snap && snap.date) ? snap.date : todayDateKey();
    const w = (snap && snap.whoop)    || {};
    const l = (snap && snap.learning) || {};
    const m = (snap && snap.market)   || {};

    const entry = {
      date:              dateKey,
      ts:                Date.now(),
      recovery:          w.recovery         != null ? w.recovery         : null,
      sleep:             w.sleep            != null ? w.sleep            : null,
      hrv:               w.hrv              != null ? w.hrv              : null,
      operatingMode:     w.operatingMode    || "NORMAL",
      tradingCapacity:   l.tradingCapacity  || "MEDIA",
      riskMode:          l.riskRecommendation || "NORMAL",
      marketRegime:      m.riskMode         || "NORMAL",
      portfolioMXN:      m.portfolioMXN     != null ? m.portfolioMXN  : null,
      gainPct:           m.gainPct          != null ? m.gainPct        : null,
      cryptoExposurePct: m.cryptoExposurePct != null ? m.cryptoExposurePct : null,
      topWinner:         m.topWinner        || null,
      topLoser:          m.topLoser         || null,
      summary: [
        "DATE: "             + dateKey,
        "RECOVERY: "         + (w.recovery         != null ? w.recovery         : "—"),
        "TRADING CAPACITY: " + (l.tradingCapacity   || "—"),
        "MARKET REGIME: "    + (m.riskMode          || "—"),
        "TOP WINNER: "       + (m.topWinner         || "—"),
        "TOP LOSER: "        + (m.topLoser          || "—"),
        "RISK MODE: "        + (l.riskRecommendation || "—")
      ].join("\n")
    };

    const summaries = readJSONSafe(DAILY_INTELLIGENCE_FILE, []);
    const idx = Array.isArray(summaries) ? summaries.findIndex(s => s && s.date === dateKey) : -1;
    if (idx >= 0) {
      summaries[idx] = entry;
    } else {
      summaries.unshift(entry);
      while (summaries.length > 365) summaries.pop();
    }
    writeJSONAtomic(DAILY_INTELLIGENCE_FILE, summaries);
    return entry;
  } catch(e) {
    console.log("[DailyIntel] generateDailyIntelligenceSummary error:", e.message);
    return null;
  }
}

// ── Autonomous Daily Snapshot Engine ───────────────────────────────────────────
// Runs every minute. If the date changed since the last auto-snapshot, generates
// a fresh snapshot, updates the intelligence summary, and re-runs the pattern engine.
let _lastAutoSnapshotDate = null;

function runAutoDailySnapshot() {
  try {
    const today = todayDateKey();
    if (_lastAutoSnapshotDate === today) return; // already ran for this calendar day
    _lastAutoSnapshotDate = today;
    console.log("[AutoSnapshot] New day detected — generating snapshot for " + today);

    const snap = computeDailyLearningSnapshot();
    generateDailyIntelligenceSummary(snap);

    try { computeCordeliusPatterns(); } catch(e) {
      console.log("[AutoSnapshot] patterns error:", e.message);
    }
    try { checkAlerts(); } catch(e) {
      console.log("[AutoSnapshot] checkAlerts error:", e.message);
    }

    const cap  = snap && snap.learning && snap.learning.tradingCapacity      ? snap.learning.tradingCapacity      : "—";
    const risk = snap && snap.learning && snap.learning.riskRecommendation   ? snap.learning.riskRecommendation   : "—";
    console.log("[AutoSnapshot] Done — capacity: " + cap + " | risk: " + risk);
  } catch(e) {
    console.log("[AutoSnapshot] Error:", e.message);
    _lastAutoSnapshotDate = null; // allow retry next minute
  }
}

// ── Cordelius Alerts Engine ────────────────────────────────────────────────────

let _alertDailyCount = { date: "", count: 0 };
const ALERTS_MAX_PER_DAY = 10;

function notifyTelegramAlert(alert) {
  const token  = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID   || "";
  if (!token || !chatId) return;
  const emoji = { INFO: "ℹ️", WARNING: "⚠️", CRITICAL: "🔴", OPPORTUNITY: "💡" }[alert.severity] || "•";
  const title   = (alert.title   || "").replace(/[*_`[\]]/g, "");
  const message = (alert.message || "").replace(/[*_`[\]]/g, "");
  const text = (emoji + " *Cordelius Alert*\n\n*" + title + "*\n" + message + "\n\n_" + alert.date + " · " + alert.type + "_").slice(0, 4096);
  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" });
  const req = https.request({
    hostname: "api.telegram.org",
    path:     "/bot" + token + "/sendMessage",
    method:   "POST",
    headers:  { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    timeout:  10000
  }, (res) => {
    let d = "";
    res.on("data", c => d += c);
    res.on("end", () => {
      try { const j = JSON.parse(d); if (!j.ok) console.log("[Alerts] TG error:", j.description || j.error_code); } catch(e) {}
    });
  });
  req.on("error",   (e) => console.log("[Alerts] TG request error:", e.message));
  req.on("timeout", ()  => { req.destroy(); console.log("[Alerts] TG timeout"); });
  req.write(payload);
  req.end();
}

function checkAlerts() {
  try {
    const today = todayDateKey();
    if (_alertDailyCount.date !== today) _alertDailyCount = { date: today, count: 0 };

    const existing  = readJSONSafe(CORDELIUS_ALERTS_FILE, []);
    const todayKeys = new Set(
      existing.filter(a => a && a.date === today).map(a => a.dedupeKey)
    );
    const newAlerts = [];

    function maybeAlert(dedupeKey, type, severity, title, message, source) {
      if (severity !== "CRITICAL" && todayKeys.has(dedupeKey)) return;
      if (severity !== "CRITICAL" && _alertDailyCount.count >= ALERTS_MAX_PER_DAY) return;
      const id = "alert_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
      newAlerts.push({ id, timestamp: new Date().toISOString(), date: today, type, severity, title, message, source, dedupeKey, sentToTelegram: false, acknowledged: false });
      todayKeys.add(dedupeKey);
      _alertDailyCount.count++;
    }

    // A — Health (live)
    let h = null;
    try { h = computeHealthReadiness(); } catch(e) {}
    if (h) {
      const rec = h.recovery != null ? Number(h.recovery) : null;
      const slp = h.sleep    != null ? Number(h.sleep)    : null;
      const hrv = h.hrv      != null ? Number(h.hrv)      : null;
      if (rec !== null) {
        if (rec < 25)
          maybeAlert("health_rec_critical", "HEALTH", "CRITICAL",
            "Recovery crítica: " + rec + "%",
            "Tu recovery WHOOP es " + rec + "% — nivel crítico. Evita decisiones de riesgo alto hoy. (Educativo — no consejo médico.)", "whoop");
        else if (rec < 40)
          maybeAlert("health_rec_warning", "HEALTH", "WARNING",
            "Recovery baja: " + rec + "%",
            "Recovery en " + rec + "% (umbral 40%). Considera reducir riesgo hoy. (Educativo — no consejo médico.)", "whoop");
      }
      if (slp !== null && slp < 50)
        maybeAlert("health_slp_warning", "HEALTH", "WARNING",
          "Sueño deficiente: " + slp + "%",
          "Eficiencia de sueño en " + slp + "%. Puede afectar capacidad de análisis. Prioriza descanso. (No consejo médico.)", "whoop");
      if (hrv !== null) {
        try {
          const dlHist = readJSONSafe(DAILY_LEARNING_FILE, {});
          const recDays = Object.keys(dlHist).sort().slice(-5).map(k => dlHist[k]);
          const prevHrvs = recDays.slice(0, -1).map(d => d && d.whoop && d.whoop.hrv != null ? Number(d.whoop.hrv) : null).filter(v => v !== null);
          if (prevHrvs.length >= 2) {
            const avg = prevHrvs.reduce((s, v) => s + v, 0) / prevHrvs.length;
            if (hrv < avg * 0.70)
              maybeAlert("health_hrv_drop", "HEALTH", "WARNING",
                "HRV caída: " + hrv.toFixed(1) + " ms (prom " + avg.toFixed(1) + " ms)",
                "HRV de hoy (" + hrv.toFixed(1) + " ms) está >30% por debajo del promedio reciente (" + avg.toFixed(1) + " ms). Señal de estrés acumulado. (No consejo médico.)", "whoop");
          }
        } catch(e) {}
      }
    }

    // B — Trading capacity (from saved daily learning)
    try {
      const dlHist    = readJSONSafe(DAILY_LEARNING_FILE, {});
      const todaySnap = dlHist[today];
      if (todaySnap && todaySnap.learning) {
        const l = todaySnap.learning;
        const m = todaySnap.market || {};
        if (l.tradingCapacity === "BAJA")
          maybeAlert("capacity_low", "CAPACITY", "WARNING",
            "Capacidad de trading BAJA hoy",
            (l.healthMarketSummary || "Sistema detecta capacidad BAJA.") + " Evita decisiones de alto impacto. (Educativo — no consejo financiero.)", "daily_learning");
        if (l.tradingCapacity === "ALTA" && !["RISK_OFF","BEARISH","DEFENSIVO","REDUCIR_RIESGO"].includes(m.riskMode || ""))
          maybeAlert("capacity_high_opp", "CAPACITY", "OPPORTUNITY",
            "Condiciones óptimas para análisis — capacidad ALTA",
            (l.nextDaySuggestions && l.nextDaySuggestions[0] ? l.nextDaySuggestions[0] : "Recovery y sueño óptimos.") + " Buen momento para revisar portafolio. (No consejo financiero.)", "daily_learning");
      }
    } catch(e) {}

    // C — Portfolio
    try {
      const pv     = portfolioValue();
      const assets = pv.assets || [];
      const total  = pv.totalValueMXN || 0;
      const cVal   = assets.filter(a => a.type === "crypto").reduce((s, a) => s + (a.valueMXN || 0), 0);
      const cPct   = total > 0 ? cVal / total * 100 : 0;
      if (cPct > 70)
        maybeAlert("port_crypto_conc", "PORTFOLIO", "WARNING",
          "Concentración cripto elevada: " + cPct.toFixed(1) + "%",
          "Tu exposición cripto (" + cPct.toFixed(1) + "%) supera el 70%. Alta volatilidad — considera revisar diversificación. (No consejo financiero.)", "portfolio");
      const gainPct = Number(pv.totalGainPct || 0);
      if (gainPct >= 20)
        maybeAlert("port_gain_20pct", "PORTFOLIO", "OPPORTUNITY",
          "Ganancia total " + (gainPct >= 0 ? "+" : "") + gainPct.toFixed(1) + "% — evaluar take-profit",
          "Tu portafolio acumula " + gainPct.toFixed(1) + "% de ganancia total. Educativamente, revisa posiciones sobrecompradas y take-profit parcial. (No consejo financiero.)", "portfolio");
      const sorted   = assets.slice().sort((a, b) => (a.gainPct || 0) - (b.gainPct || 0));
      const topLoser = sorted[0];
      if (topLoser && (topLoser.gainPct || 0) < -10)
        maybeAlert("port_loser_" + (topLoser.symbol || "X"), "PORTFOLIO", "WARNING",
          (topLoser.symbol || "—") + " en caída: " + (topLoser.gainPct >= 0 ? "+" : "") + (topLoser.gainPct || 0).toFixed(1) + "%",
          (topLoser.name || topLoser.symbol || "Activo") + " tiene pérdida de " + (topLoser.gainPct || 0).toFixed(1) + "% (score " + (topLoser.score || "—") + "/100). Evalúa tu tesis. (No consejo financiero.)", "portfolio");
      const topWinner = sorted[sorted.length - 1];
      if (topWinner && (topWinner.gainPct || 0) > 30)
        maybeAlert("port_winner_" + (topWinner.symbol || "X"), "PORTFOLIO", "OPPORTUNITY",
          (topWinner.symbol || "—") + " ganancia: +" + (topWinner.gainPct || 0).toFixed(1) + "%",
          (topWinner.name || topWinner.symbol || "Activo") + " con +" + (topWinner.gainPct || 0).toFixed(1) + "% (score " + (topWinner.score || "—") + "/100). Considera evaluar take-profit parcial. (No consejo financiero.)", "portfolio");
    } catch(e) {}

    // D — Market regime (from saved daily learning)
    try {
      const dlHist    = readJSONSafe(DAILY_LEARNING_FILE, {});
      const todaySnap = dlHist[today];
      if (todaySnap && todaySnap.market) {
        const rm = todaySnap.market.riskMode || "";
        if (["DEFENSIVO","REDUCIR_RIESGO"].includes(rm))
          maybeAlert("mkt_defensive_" + rm, "MARKET", "WARNING",
            "Régimen defensivo detectado: " + rm,
            "El sistema detecta condiciones defensivas (" + rm + "). Considera reducir exposición a activos volátiles. (Educativo — no consejo financiero.)", "market");
        if (["RISK_OFF","BEARISH"].includes(rm))
          maybeAlert("mkt_risk_off", "MARKET", "WARNING",
            "Mercado en modo RISK_OFF / BEARISH",
            "Señales bajistas detectadas (" + rm + "). Revisa posiciones defensivas. (Educativo — no consejo financiero.)", "market");
      }
    } catch(e) {}

    // E — Pattern detection (once per sample-count tier)
    try {
      const patterns = readJSONSafe(CORDELIUS_PATTERNS_FILE, { available: false });
      if (patterns.available && patterns.sampleCount >= 3) {
        const tier = Math.floor(patterns.sampleCount / 7);
        maybeAlert("patterns_tier_" + tier, "LEARNING", "INFO",
          "Nuevos patrones detectados — " + patterns.sampleCount + " días de datos",
          (patterns.nextDayRecommendation || "Jarvis ha detectado patrones de comportamiento. Revisa Autopilot → Daily Learning."), "patterns");
      }
    } catch(e) {}

    if (newAlerts.length === 0) return { newCount: 0 };

    // Telegram delivery
    for (const alert of newAlerts) {
      if (TG_TOKEN_CONFIGURED && TG_CHAT_CONFIGURED) {
        notifyTelegramAlert(alert);
        alert.sentToTelegram = true;
      }
    }

    const allAlerts = [...newAlerts, ...existing].slice(0, 500);
    writeJSONAtomic(CORDELIUS_ALERTS_FILE, allAlerts);
    console.log("[Alerts] " + newAlerts.length + " new: " + newAlerts.map(a => a.severity + "/" + a.type).join(", "));
    return { newCount: newAlerts.length, alerts: newAlerts };
  } catch(e) {
    console.log("[Alerts] checkAlerts error:", e.message);
    return { newCount: 0, error: e.message };
  }
}

// ============================================================
// JARVIS MEMORY ENGINE — buildJarvisContext / buildMemorySummary
// Reads and compresses all persistent memory for Claude injection
// ============================================================

function buildJarvisContext() {
  const ctx = { generatedAt: new Date().toISOString() };

  // 1. Current WHOOP / health state
  try {
    const h = computeHealthReadiness();
    ctx.health = {
      recovery:          h.recovery,
      sleep:             h.sleep,
      hrv:               h.hrv !== null ? Number(h.hrv).toFixed(1) : null,
      strain:            h.strain !== null ? Number(h.strain).toFixed(1) : null,
      restingHR:         h.restingHeartRate,
      operatingMode:     h.operatingMode,
      source:            h.source,
      connected:         !!h.connected,
      healthScore:       h.healthScore,
      energyScore:       h.energyScore,
      deepWorkScore:     h.deepWorkScore,
      nervousSystemScore:h.nervousSystemScore,
      stressLoadScore:   h.stressLoadScore,
      suggestion:        h.suggestion
    };
  } catch(e) {
    ctx.health = { error: e.message };
  }

  // 2. Portfolio summary (compressed — no individual asset details, those are in askClaude already)
  try {
    const pv = portfolioValue();
    const assets = pv.assets || [];
    const cryptoVal = assets.filter(a => a.type === "crypto").reduce((s, a) => s + (a.valueMXN || 0), 0);
    const sorted = assets.slice().sort((a, b) => (b.gainPct || 0) - (a.gainPct || 0));
    ctx.portfolio = {
      totalMXN:    parseFloat((pv.totalValueMXN || 0).toFixed(0)),
      gainPct:     parseFloat((pv.totalGainPct  || 0).toFixed(2)),
      gainMXN:     parseFloat((pv.totalGainMXN  || 0).toFixed(0)),
      cryptoPct:   pv.totalValueMXN > 0 ? parseFloat((cryptoVal / pv.totalValueMXN * 100).toFixed(1)) : 0,
      regime:      (function(){ try { return marketRegime().label; } catch(e){ return "—"; } })(),
      topWinner:   sorted[0] ? { sym: sorted[0].symbol, pct: parseFloat((sorted[0].gainPct||0).toFixed(1)), score: sorted[0].score } : null,
      topLoser:    sorted[sorted.length-1] ? { sym: sorted[sorted.length-1].symbol, pct: parseFloat((sorted[sorted.length-1].gainPct||0).toFixed(1)), score: sorted[sorted.length-1].score } : null
    };
  } catch(e) {
    ctx.portfolio = { error: e.message };
  }

  // 3. Daily learning — last 7 days compressed
  try {
    const hist   = readJSONSafe(DAILY_LEARNING_FILE, {});
    const keys   = Object.keys(hist).sort().slice(-7);
    ctx.dailyLearning = keys.map(k => {
      const r = hist[k] || {};
      const w = r.whoop   || {};
      const c = r.checkin || {};
      const m = r.market  || {};
      const l = r.learning || {};
      return {
        date:     k,
        mode:     w.operatingMode || null,
        recovery: w.recovery      || null,
        sleep:    w.sleep         || null,
        capacity: l.tradingCapacity       || null,
        risk:     l.riskRecommendation    || null,
        focus:    c.focus   != null ? c.focus   : null,
        mood:     c.mood    != null ? c.mood    : null,
        cannabis: c.cannabis != null ? c.cannabis : null,
        sauna:    c.sauna    != null ? c.sauna    : null,
        workout:  c.workout  != null ? c.workout  : null,
        portGain: m.gainPct  != null ? parseFloat(m.gainPct.toFixed(1)) : null,
        checkinDone: !!c.updatedAt
      };
    });
  } catch(e) {
    ctx.dailyLearning = [];
  }

  // 4. Recent trading decisions — last 5, newest first
  try {
    const decisions = readJSONSafe(TRADING_DECISIONS_FILE, []);
    const structured = decisions.filter(d => d && d.id).slice(-10).reverse().slice(0, 5);
    ctx.recentDecisions = structured.map(d => ({
      date:       (d.timestamp || "").slice(0, 10),
      sym:        d.symbol || "—",
      action:     d.action || "—",
      conviction: d.conviction || null,
      outcome:    d.outcomeStatus || "PENDING",
      reason:     (d.reason || "").slice(0, 80)
    }));
  } catch(e) {
    ctx.recentDecisions = [];
  }

  // 5. Detected behavior patterns (if available)
  try {
    const patterns = readJSONSafe(CORDELIUS_PATTERNS_FILE, {});
    if (patterns.available) {
      ctx.patterns = {
        available:       true,
        cannabisRecovery:patterns.cannabisVsRecovery   || null,
        saunaRecovery:   patterns.saunaVsRecovery      || null,
        recoveryVsPnl:   patterns.recoveryVsPnl        || null,
        sleepVsFocus:    patterns.sleepVsFocus         || null,
        bestCondition:   patterns.bestCondition ? {
          date:     patterns.bestCondition.date,
          recovery: patterns.bestCondition.recovery,
          sleep:    patterns.bestCondition.sleep,
          focus:    patterns.bestCondition.focus,
          cannabis: patterns.bestCondition.cannabis,
          sauna:    patterns.bestCondition.sauna
        } : null,
        nextDayRec: patterns.nextDayRecommendation || null
      };
    } else {
      ctx.patterns = { available: false, msg: patterns.message || "Insuficiente datos" };
    }
  } catch(e) {
    ctx.patterns = { available: false };
  }

  // 6. Autopilot progress + learning summary
  try {
    const progress = readJSONSafe(CORDELIUS_PROGRESS_FILE, {});
    ctx.autopilot = {
      level:     progress.level    || 1,
      xp:        progress.xp       || 0,
      streak:    progress.streak   || 0,
      snapshots: progress.snapshots|| 0
    };
    const learning = computeAutopilotLearning();
    ctx.autopilotLearning = {
      total:            learning.totalDecisions,
      reviewed:         learning.reviewedDecisions,
      pending:          learning.pendingDecisions,
      learningSummary:  (learning.learningSummary || "").slice(0, 220),
      bestPatterns:     (learning.bestPatterns    || []).slice(0, 2).map(p => ({
        sym: p.symbol, action: p.action, conviction: p.conviction
      })),
      repeatedMistakes: (learning.repeatedMistakes || []).slice(0, 2).map(m => ({
        sym: m.symbol, action: m.action, count: m.count
      }))
    };
  } catch(e) {
    ctx.autopilot = {};
    ctx.autopilotLearning = { learningSummary: "" };
  }

  return ctx;
}

function buildMemorySummary() {
  // Compressed Spanish-language bullet points — ~400 tokens max
  // Used for injecting into Claude prompt
  try {
    const ctx = buildJarvisContext();
    const lines = [];

    // Health
    const h = ctx.health || {};
    if (!h.error) {
      if (h.recovery !== null && h.recovery !== undefined) {
        lines.push(`SALUD HOY: Recovery ${h.recovery}%, sueño ${h.sleep != null ? h.sleep + '%' : '—'}, HRV ${h.hrv || '—'} ms, modo ${h.operatingMode}. Sugerencia: ${h.suggestion || '—'}.`);
        if (h.deepWorkScore != null) lines.push(`SCORES: energía ${h.energyScore}/100, trabajo profundo ${h.deepWorkScore}/100, sistema nervioso ${h.nervousSystemScore}/100.`);
      } else {
        lines.push(`SALUD: WHOOP sin datos directos. Fuente: ${h.source || 'no configurado'}. Modo derivado: ${h.operatingMode}.`);
      }
    }

    // Daily learning trend
    const dl = ctx.dailyLearning || [];
    if (dl.length > 0) {
      const today = dl[dl.length - 1];
      lines.push(`CAPACIDAD TRADING HOY: ${today.capacity || '—'} · Riesgo: ${today.risk || '—'} · Foco ${today.focus != null ? today.focus + '/10' : '—'} · Check-in: ${today.checkinDone ? 'Sí' : 'No'}.`);
      if (dl.length >= 3) {
        const withRec = dl.filter(d => d.recovery !== null && d.recovery !== undefined);
        if (withRec.length >= 2) {
          const avgRec = (withRec.reduce((s, d) => s + d.recovery, 0) / withRec.length).toFixed(0);
          lines.push(`TENDENCIA (${dl.length}d): Recovery promedio ${avgRec}%. Días con cannabis: ${dl.filter(d => d.cannabis).length}. Días con workout: ${dl.filter(d => d.workout).length}. Días con sauna: ${dl.filter(d => d.sauna).length}.`);
        }
      }
    }

    // Portfolio
    const p = ctx.portfolio || {};
    if (!p.error) {
      lines.push(`PORTAFOLIO: $${Number(p.totalMXN || 0).toLocaleString('es-MX')} MXN · Ganancia ${p.gainPct >= 0 ? '+' : ''}${p.gainPct}% · Cripto ${p.cryptoPct}% · Régimen ${p.regime}.`);
      if (p.topWinner) lines.push(`ACTIVOS: Mejor ${p.topWinner.sym} (${p.topWinner.pct >= 0 ? '+' : ''}${p.topWinner.pct}%, score ${p.topWinner.score}). Más débil: ${p.topLoser ? p.topLoser.sym + ' (' + p.topLoser.pct + '%, score ' + p.topLoser.score + ')' : '—'}.`);
    }

    // Trading decisions
    const dec = ctx.recentDecisions || [];
    if (dec.length > 0) {
      lines.push(`DECISIONES RECIENTES: ${dec.slice(0, 3).map(d => `${d.date} ${d.action} ${d.sym} [${d.outcome}${d.conviction ? ', cv' + d.conviction : ''}]`).join(' | ')}.`);
    }

    // Patterns
    const pat = ctx.patterns || {};
    if (pat.available) {
      if (pat.nextDayRec) lines.push(`PATRÓN APRENDIDO: ${pat.nextDayRec}`);
      const rv = pat.recoveryVsPnl;
      if (rv && rv.highRecoveryAvgPnl != null && rv.sampleHigh >= 2) {
        lines.push(`CORRELACIÓN: Recovery alta (≥70%) → PnL prom. ${rv.highRecoveryAvgPnl}% (${rv.sampleHigh}d). Recovery baja (<50%) → PnL prom. ${rv.lowRecoveryAvgPnl}% (${rv.sampleLow}d).`);
      }
      const sf = pat.sleepVsFocus;
      if (sf && sf.goodSleepAvgFocus != null && sf.sampleGood >= 2) {
        lines.push(`SUEÑO VS FOCO: Buen sueño → foco ${sf.goodSleepAvgFocus}/10 (${sf.sampleGood}d). Mal sueño → foco ${sf.badSleepAvgFocus}/10 (${sf.sampleBad}d).`);
      }
    } else if (pat.msg) {
      lines.push(`PATRONES: ${pat.msg}`);
    }

    // Autopilot learning
    const al = ctx.autopilotLearning || {};
    if (al.total > 0) {
      lines.push(`AUTOPILOT: Nivel ${(ctx.autopilot || {}).level || 1} · ${al.total} decisiones · ${al.reviewed} revisadas. ${al.learningSummary}`);
      if (al.repeatedMistakes && al.repeatedMistakes.length > 0) {
        lines.push(`ERROR REPETIDO: ${al.repeatedMistakes.map(m => m.sym + ' ' + m.action + ' ×' + m.count).join(', ')}.`);
      }
      if (al.bestPatterns && al.bestPatterns.length > 0) {
        lines.push(`MEJOR PATRÓN: ${al.bestPatterns.map(p => p.action + ' en ' + p.sym + ' (cv ' + p.conviction + ')').join(', ')}.`);
      }
    }

    if (lines.length === 0) return "Sin memoria disponible todavía.";
    return lines.join("\n");
  } catch(e) {
    return "Error al construir memoria: " + e.message;
  }
}

function computeTradingSummary() {
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

  const tradingSummary = computeTradingSummary();

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

  const tradingSummary = computeTradingSummary();

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

  const nextHealth = appendSnapshot(healthSnapshots, healthEntry, 200, HEALTH_SNAPSHOTS_FILE);
  const nextPortfolio = appendSnapshot(portfolioSnapshots, portfolioEntry, 200, PORTFOLIO_SNAPSHOTS_FILE);
  const nextDecisions = appendSnapshot(tradingDecisions, decisionEntry, 200, TRADING_DECISIONS_FILE);

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

function computeAutopilotLearning() {
  const decisions = readJSONSafe(TRADING_DECISIONS_FILE, []);
  const outcomes  = readJSONSafe(DECISION_OUTCOMES_FILE, []);

  // Only consider structured decision-log entries (have an id field)
  const decisionLog = decisions.filter(d => d && d.id);
  const total    = decisionLog.length;
  const pending  = decisionLog.filter(d => d.outcomeStatus === "PENDING").length;
  const reviewed = decisionLog.filter(d => d.outcomeStatus && d.outcomeStatus !== "PENDING").length;

  // Action stats
  const actionStats = {};
  for (const d of decisionLog) {
    const a = d.action || "UNKNOWN";
    if (!actionStats[a]) actionStats[a] = { count: 0, reviewed: 0, win: 0 };
    actionStats[a].count++;
    if (d.outcomeStatus && d.outcomeStatus !== "PENDING") {
      actionStats[a].reviewed++;
      if (d.outcomeStatus === "WIN") actionStats[a].win++;
    }
  }

  // Most watched tickers
  const tickerMap = {};
  for (const d of decisionLog) {
    const sym = d.symbol || "—";
    tickerMap[sym] = (tickerMap[sym] || 0) + 1;
  }
  const mostWatchedTickers = Object.entries(tickerMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([symbol, count]) => ({ symbol, count }));

  // Best patterns (high conviction + WIN)
  const bestPatterns = decisionLog
    .filter(d => d.outcomeStatus === "WIN" && (d.conviction || 0) >= 7)
    .slice(0, 3)
    .map(d => ({ symbol: d.symbol, action: d.action, conviction: d.conviction, reason: d.reason }));

  // Risk patterns (LOSS + high conviction, showing overconfidence)
  const riskPatterns = decisionLog
    .filter(d => d.outcomeStatus === "LOSS" && (d.conviction || 0) >= 7)
    .slice(0, 3)
    .map(d => ({ symbol: d.symbol, action: d.action, conviction: d.conviction, reason: d.reason }));

  // Repeated mistakes (same symbol + same action + LOSS)
  const mistakeMap = {};
  for (const d of decisionLog.filter(d => d.outcomeStatus === "LOSS")) {
    const key = (d.symbol || "—") + ":" + (d.action || "?");
    mistakeMap[key] = (mistakeMap[key] || 0) + 1;
  }
  const repeatedMistakes = Object.entries(mistakeMap)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => { const [symbol, action] = key.split(":"); return { symbol, action, count }; });

  // Learning summary in Spanish
  let learningSummary = "";
  if (total === 0) {
    learningSummary = "Aún no hay decisiones registradas. Comienza a guardar decisiones para activar el aprendizaje.";
  } else if (reviewed === 0) {
    learningSummary = `${total} decisión(es) registrada(s) pero ninguna revisada todavía. Marca resultados para generar aprendizaje.`;
  } else {
    const winRate = Object.values(actionStats).reduce((a, s) => a + s.win, 0);
    const totalRev = reviewed;
    const pct = totalRev > 0 ? Math.round(winRate / totalRev * 100) : 0;
    learningSummary = `${total} decisiones · ${reviewed} revisadas · ${pct}% aciertos. `;
    if (repeatedMistakes.length > 0) {
      learningSummary += `Error repetido detectado en ${repeatedMistakes[0].symbol}. `;
    }
    if (bestPatterns.length > 0) {
      learningSummary += `Mejor patrón: ${bestPatterns[0].action} en ${bestPatterns[0].symbol}.`;
    }
  }

  return {
    totalDecisions: total,
    pendingDecisions: pending,
    reviewedDecisions: reviewed,
    actionStats,
    mostWatchedTickers,
    bestPatterns,
    riskPatterns,
    repeatedMistakes,
    learningSummary
  };
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

  const cycleScore    = cycleRec    && cycleRec.score    ? cycleRec.score    : {};
  const recoveryScore = recoveryRec && recoveryRec.score ? recoveryRec.score : {};
  const sleepScore    = sleepRec    && sleepRec.score    ? sleepRec.score    : {};
  const stageSummary  = sleepScore.stage_summary        ? sleepScore.stage_summary : {};
  const sleepNeeded   = sleepScore.sleep_needed         ? sleepScore.sleep_needed  : {};

  // Core metrics
  const recovery       = recoveryScore.recovery_score               != null ? Math.round(recoveryScore.recovery_score)               : null;
  const sleep          = sleepScore.sleep_performance_percentage     != null ? Math.round(sleepScore.sleep_performance_percentage)     : null;
  const strain         = cycleScore.strain                           != null ? cycleScore.strain                                       : null;
  const hrv            = recoveryScore.hrv_rmssd_milli               != null ? recoveryScore.hrv_rmssd_milli                           : null;
  const restingHeartRate  = recoveryScore.resting_heart_rate         != null ? Math.round(recoveryScore.resting_heart_rate)            : null;
  const averageHeartRate  = cycleScore.average_heart_rate            != null ? Math.round(cycleScore.average_heart_rate)               : null;
  const maxHeartRate      = cycleScore.max_heart_rate                != null ? Math.round(cycleScore.max_heart_rate)                   : null;

  // Extended sleep metrics
  const respiratoryRate   = sleepScore.respiratory_rate              != null ? Number(sleepScore.respiratory_rate).toFixed(1)          : null;
  const sleepEfficiency   = sleepScore.sleep_efficiency_percentage   != null ? Math.round(sleepScore.sleep_efficiency_percentage)      : null;
  const sleepConsistency  = sleepScore.sleep_consistency_percentage  != null ? Math.round(sleepScore.sleep_consistency_percentage)     : null;

  // Sleep stages (ms → minutes)
  function msToMin(ms) { return ms != null ? Math.round(ms / 60000) : null; }
  const remMins   = msToMin(stageSummary.total_rem_sleep_time_milli);
  const deepMins  = msToMin(stageSummary.total_slow_wave_sleep_time_milli);
  const lightMins = msToMin(stageSummary.total_light_sleep_time_milli);
  const awakeMins = msToMin(stageSummary.total_awake_time_milli);

  // Sleep duration from record timestamps
  let sleepDurationMins = null;
  if (sleepRec && sleepRec.start && sleepRec.end) {
    const dur = new Date(sleepRec.end) - new Date(sleepRec.start);
    if (dur > 0) sleepDurationMins = Math.round(dur / 60000);
  } else if (remMins != null && deepMins != null && lightMins != null) {
    sleepDurationMins = (remMins || 0) + (deepMins || 0) + (lightMins || 0) + (awakeMins || 0);
  }

  // Sleep debt/need (ms → hours, rounded to 1 decimal)
  function msToHrs(ms) { return ms != null ? Math.round(ms / 360000) / 10 : null; }
  const sleepNeedBaseline  = msToHrs(sleepNeeded.baseline_milli);
  const sleepDebt          = (() => {
    const needMs = sleepNeeded.baseline_milli;
    const actualMs = sleepDurationMins != null ? sleepDurationMins * 60000 : null;
    if (needMs != null && actualMs != null) return Math.round((needMs - actualMs) / 360000) / 10;
    return null;
  })();

  const connected = !!(whoopTokens && whoopTokens.access_token && (recovery != null || sleep != null || strain != null || hrv != null));

  // Derived scores (0-100)
  const strainPct = strain != null ? Math.min(100, (strain / 21) * 100) : 50;
  const hrvScore  = hrv    != null ? Math.min(100, (hrv / 160) * 100)   : 50;
  const rhrScore  = restingHeartRate ? Math.max(0, Math.min(100, 100 - Math.max(0, restingHeartRate - 38) * 2)) : 70;
  const rec0 = recovery ?? 50, slp0 = sleep ?? 50;

  const healthScore       = Math.round(rec0 * 0.34 + slp0 * 0.24 + hrvScore * 0.18 + rhrScore * 0.12 + (100 - strainPct) * 0.12);
  const energyScore       = Math.round(rec0 * 0.40 + slp0 * 0.35 + (100 - strainPct) * 0.25);
  const deepWorkScore     = Math.round(slp0 * 0.40 + hrvScore * 0.35 + (100 - strainPct) * 0.25);
  const nervousSystemScore= Math.round(hrvScore * 0.55 + (100 - strainPct) * 0.25 + rhrScore * 0.20);
  const stressLoadScore   = Math.round(100 - nervousSystemScore * 0.6 - (100 - strainPct) * 0.4);

  // Operating mode
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

  // 7-day trend from snapshots
  let recoveryTrend = null, sleepTrend = null, fatigueTrend = null;
  try {
    const snaps = readJSONSafe(HEALTH_SNAPSHOTS_FILE, []).slice(0, 7).filter(s => s && s.recovery != null);
    if (snaps.length >= 3) {
      const avgRec = snaps.slice(0, 3).reduce((s, x) => s + (x.recovery || 0), 0) / 3;
      const avgRecOld = snaps.slice(-3).reduce((s, x) => s + (x.recovery || 0), 0) / 3;
      recoveryTrend = avgRec > avgRecOld + 5 ? "SUBIENDO" : avgRec < avgRecOld - 5 ? "BAJANDO" : "ESTABLE";
      const slpSnaps = snaps.filter(s => s.sleep != null);
      if (slpSnaps.length >= 3) {
        const avgSlp = slpSnaps.slice(0, 2).reduce((s, x) => s + (x.sleep || 0), 0) / 2;
        const avgSlpOld = slpSnaps.slice(-2).reduce((s, x) => s + (x.sleep || 0), 0) / 2;
        sleepTrend = avgSlp > avgSlpOld + 5 ? "MEJORANDO" : avgSlp < avgSlpOld - 5 ? "EMPEORANDO" : "ESTABLE";
      }
      fatigueTrend = recoveryTrend === "BAJANDO" ? "ACUMULANDO" : recoveryTrend === "SUBIENDO" ? "DISMINUYENDO" : "ESTABLE";
    }
  } catch(e) {}

  return {
    ok: true,
    configured: WHOOP_CONFIGURED,
    connected,
    source: connected ? "whoop_live" : WHOOP_CONFIGURED ? "whoop_tokens_missing" : "not_configured",
    // Core
    recovery, sleep, strain, hrv,
    restingHeartRate, averageHeartRate, maxHeartRate,
    // Extended sleep
    respiratoryRate, sleepEfficiency, sleepConsistency,
    remMins, deepMins, lightMins, awakeMins,
    sleepDurationMins, sleepNeedBaseline, sleepDebt,
    // Derived scores
    healthScore, energyScore, deepWorkScore, nervousSystemScore, stressLoadScore,
    // Trends
    recoveryTrend, sleepTrend, fatigueTrend,
    // Legacy
    operatingMode, mode: operatingMode, suggestion,
    message: connected
      ? `WHOOP conectado. Recovery: ${recovery ?? "—"}%. Sleep: ${sleep ?? "—"}%. HRV: ${hrv != null ? hrv.toFixed(1) : "—"} ms. Strain: ${strain != null ? strain.toFixed(1) : "—"}.`
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
        <div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c">TRADING AI · PAPER MODE</div>
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
  return `<div style="max-width:1280px;margin:0 auto 16px">
    ${idea.hasIdea ? `<div style="border:1px solid rgba(0,255,153,.18);border-radius:18px;padding:14px 20px;margin-bottom:14px;background:rgba(0,255,153,.03)">
      <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#00ff99;margin-bottom:8px">Idea de paper trade (hipotético — no ejecutar)</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
        <b style="font-size:20px">${esc(idea.symbol)}</b>
        <span style="color:#00ff99;font-weight:700">${esc(idea.action)}</span>
        <span class="muted" style="font-size:13px">${esc(idea.reason)}</span>
      </div>
    </div>` : ""}
    ${spark(bot.equityHistory, { key: "v", color: "#00ff99", height: 220 })}
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

function renderDailyLearningPanel() {
  const dateKey = todayDateKey();
  const history = readJSONSafe(DAILY_LEARNING_FILE, {});
  const today   = history[dateKey] || null;
  const patterns = readJSONSafe(CORDELIUS_PATTERNS_FILE, { available: false });
  const h = computeHealthReadiness();
  const mkt = computeMarketContext();

  const recColor = h.recovery != null ? (h.recovery >= 70 ? "#00ff99" : h.recovery < 50 ? "#ff4d6d" : "#ffd35c") : "#9fb3c8";
  const slpColor = h.sleep    != null ? (h.sleep    >= 70 ? "#00ff99" : h.sleep    < 50 ? "#ff4d6d" : "#ffd35c") : "#9fb3c8";
  const pnlColor = mkt.available && mkt.gainPct != null ? (mkt.gainPct >= 0 ? "#00ff99" : "#ff4d6d") : "#9fb3c8";

  const todayCheckin = today ? today.checkin : {};
  const todayLearning = today ? today.learning : {};

  function boolChip(id, label, val) {
    const isYes = val === true;
    const isNo  = val === false;
    return `<div style="display:flex;align-items:center;gap:5px">
      <span style="font-size:11px;color:#5a7a94;min-width:52px">${label}</span>
      <button id="${id}-yes" onclick="dlToggleBool('${id}',true)" style="padding:3px 10px;border-radius:8px;border:1px solid rgba(0,255,153,${isYes?'.55':'.18'});background:rgba(0,255,153,${isYes?'.15':'.04'});color:${isYes?'#00ff99':'#5a7a94'};font-size:11px;font-weight:${isYes?'900':'600'};cursor:pointer;font-family:inherit">Si</button>
      <button id="${id}-no"  onclick="dlToggleBool('${id}',false)" style="padding:3px 10px;border-radius:8px;border:1px solid rgba(255,77,109,${isNo?'.55':'.18'});background:rgba(255,77,109,${isNo?'.12':'.04'});color:${isNo?'#ff4d6d':'#5a7a94'};font-size:11px;font-weight:${isNo?'900':'600'};cursor:pointer;font-family:inherit">No</button>
    </div>`;
  }

  function patternCard(icon, title, bodyHtml, borderColor) {
    return `<div style="background:rgba(0,0,0,.2);border:1px solid ${borderColor}22;border-radius:14px;padding:14px 16px">
      <div style="font-size:8px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:${borderColor};margin-bottom:8px">${icon} ${title}</div>
      <div style="font-size:13px;color:#c0d4ea;line-height:1.6">${bodyHtml}</div>
    </div>`;
  }

  let cannabisPat = "Sin datos suficientes (min. 3 días).";
  if (patterns.available && patterns.cannabis) {
    const c = patterns.cannabis;
    if (c.sampleWith > 0 && c.sampleWithout > 0) {
      const diff = (c.withAvgRecovery || 0) - (c.withoutAvgRecovery || 0);
      const sign = diff >= 0 ? "+" : "";
      cannabisPat = `Con cannabis: recovery ${c.withAvgRecovery ?? "—"}% (${c.sampleWith}d) vs sin cannabis: ${c.withoutAvgRecovery ?? "—"}% (${c.sampleWithout}d). Diferencia: <b style="color:${diff >= 0 ? "#00ff99" : "#ff4d6d"}">${sign}${diff.toFixed(1)}%</b>`;
    } else {
      cannabisPat = `Datos: con (${c.sampleWith}d) / sin (${c.sampleWithout}d). Necesitas más variación para detectar patrón.`;
    }
  }

  let saunaPat = "Sin datos suficientes (min. 3 días).";
  if (patterns.available && patterns.sauna) {
    const s = patterns.sauna;
    if (s.sampleWith > 0 && s.sampleWithout > 0) {
      const diff = (s.withAvgSleep || 0) - (s.withoutAvgSleep || 0);
      const sign = diff >= 0 ? "+" : "";
      saunaPat = `Con sauna: sueño ${s.withAvgSleep ?? "—"}% (${s.sampleWith}d) vs sin sauna: ${s.withoutAvgSleep ?? "—"}% (${s.sampleWithout}d). Diferencia: <b style="color:${diff >= 0 ? "#00ff99" : "#ff4d6d"}">${sign}${diff.toFixed(1)}%</b>`;
    } else {
      saunaPat = `Datos: con (${s.sampleWith}d) / sin (${s.sampleWithout}d). Necesitas más variación para detectar patrón.`;
    }
  }

  let bestPat = "Sin datos de check-in suficientes.";
  if (patterns.available && patterns.bestCondition) {
    const b = patterns.bestCondition;
    bestPat = `${esc(b.date)}: recovery ${b.recovery ?? "—"}%, sueño ${b.sleep ?? "—"}%, focus ${b.focus ?? "—"}/10, modo ${esc(b.mode || "—")}${b.sauna ? " · sauna Si" : ""}${b.cannabis ? " · cannabis Si" : ""}.`;
  } else if (patterns.available && patterns.recoveryVsPnl) {
    const r = patterns.recoveryVsPnl;
    if (r.sampleHigh > 0 || r.sampleLow > 0) {
      bestPat = `Recovery alto (≥70%): PnL promedio ${r.highRecoveryAvgPnl ?? "—"}% (${r.sampleHigh}d). Recovery bajo (<50%): PnL promedio ${r.lowRecoveryAvgPnl ?? "—"}% (${r.sampleLow}d).`;
    }
  }

  const tomorrowRec = patterns.available && patterns.nextDayRecommendation
    ? esc(patterns.nextDayRecommendation)
    : (today && today.learning && today.learning.nextDaySuggestions && today.learning.nextDaySuggestions.length
        ? esc(today.learning.nextDaySuggestions[0])
        : "Genera el aprendizaje para ver la recomendación.");

  return `
  <div style="max-width:1280px;margin:12px auto 0;padding:20px 22px;background:rgba(129,140,248,.03);border:1px solid rgba(129,140,248,.14);border-radius:20px" id="dle-panel">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px">
      <div>
        <div style="font-size:9px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#818cf8;margin-bottom:3px">Daily Learning Engine</div>
        <div style="font-size:12px;color:#3d5068">${esc(dateKey)} · ${history ? Object.keys(history).length : 0} días de historial · Educativo</div>
      </div>
      <div style="display:flex;gap:7px;align-items:center">
        <button onclick="generateDailyLearning()" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(129,140,248,.35);background:rgba(129,140,248,.08);color:#818cf8;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Generar aprendizaje</button>
        <a href="/api/daily/today" target="_blank" style="font-size:11px;color:#3d5068;text-decoration:none">JSON →</a>
      </div>
    </div>

    <!-- WHOOP strip -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;margin-bottom:14px">
      ${[
        { label: "Recovery", val: h.recovery != null ? h.recovery + "%" : "—", color: recColor },
        { label: "Sleep",    val: h.sleep    != null ? h.sleep    + "%" : "—", color: slpColor },
        { label: "HRV",      val: h.hrv      != null ? h.hrv.toFixed(1) + " ms" : "—", color: "#818cf8" },
        { label: "Strain",   val: h.strain   != null ? h.strain.toFixed(1) : "—",      color: "#9fb3c8" },
        { label: "Modo",     val: esc(h.operatingMode || "—"), color: h.operatingMode === "ÓPTIMO" ? "#00ff99" : h.operatingMode === "DEFENSIVO" ? "#ff4d6d" : "#ffd35c" },
        { label: "Capacidad",val: esc(todayLearning.tradingCapacity || "—"), color: todayLearning.tradingCapacity === "ALTA" ? "#00ff99" : todayLearning.tradingCapacity === "BAJA" ? "#ff4d6d" : "#ffd35c" }
      ].map(c => `<div style="background:rgba(0,0,0,.2);border:1px solid rgba(120,160,210,.08);border-radius:12px;padding:10px 12px;text-align:center">
        <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:#2e4258;margin-bottom:3px">${c.label}</div>
        <div style="font-size:16px;font-weight:900;color:${c.color}">${c.val}</div>
      </div>`).join("")}
    </div>

    <!-- Market strip -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px">
      ${mkt.available ? [
        { label: "Portafolio",   val: money(mkt.portfolioMXN),                      color: "#c0d4ea" },
        { label: "PnL",          val: (mkt.gainPct >= 0 ? "+" : "") + pct(mkt.gainPct), color: pnlColor },
        { label: "Ganador",      val: mkt.topWinner ? `${esc(mkt.topWinner)} +${mkt.topWinnerGain?.toFixed(1)}%` : "—", color: "#00ff99" },
        { label: "Riesgo",       val: esc(mkt.riskMode || "—"), color: mkt.riskMode === "BAJISTA" ? "#ff4d6d" : "#ffd35c" },
        { label: "Cripto exp.",  val: (mkt.cryptoExposurePct || 0).toFixed(0) + "%", color: (mkt.cryptoExposurePct || 0) > 40 ? "#ff4d6d" : "#9fb3c8" }
      ].map(c => `<div style="background:rgba(0,0,0,.15);border:1px solid rgba(120,160,210,.07);border-radius:12px;padding:10px 12px;text-align:center">
        <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:#2e4258;margin-bottom:3px">${c.label}</div>
        <div style="font-size:14px;font-weight:900;color:${c.color}">${c.val}</div>
      </div>`).join("") : `<div style="color:#3d5068;font-size:12px;padding:8px">Mercado no disponible</div>`}
    </div>

    <!-- Check-in form -->
    <div style="border-top:1px solid rgba(120,160,210,.07);padding-top:14px;margin-bottom:16px">
      <div style="font-size:8px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#2e4258;margin-bottom:10px">Check-in diario · Solo lo que WHOOP no sabe</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
        ${boolChip("dle-cannabis", "Cannabis",  todayCheckin.cannabis)}
        ${boolChip("dle-sauna",    "Sauna",     todayCheckin.sauna)}
        ${boolChip("dle-workout",  "Workout",   todayCheckin.workout)}
        ${boolChip("dle-alcohol",  "Alcohol",   todayCheckin.alcohol)}
        ${boolChip("dle-caffeine", "Cafeína",   todayCheckin.caffeine)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:12px">
        ${[
          { id: "dle-mood",   label: "Mood",   val: todayCheckin.mood   ?? 5 },
          { id: "dle-stress", label: "Stress", val: todayCheckin.stress ?? 5 },
          { id: "dle-focus",  label: "Focus",  val: todayCheckin.focus  ?? 5 }
        ].map(s => `<div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:#5a7a94;min-width:44px">${s.label}</span>
          <input type="range" id="${s.id}" min="1" max="10" value="${s.val}" oninput="document.getElementById('${s.id}-v').textContent=this.value" style="flex:1;accent-color:#818cf8">
          <span id="${s.id}-v" style="font-size:13px;font-weight:900;color:#c0d4ea;min-width:18px;text-align:right">${s.val}</span>
          <span style="font-size:10px;color:#3d5068">/10</span>
        </div>`).join("")}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <input id="dle-notes" value="${esc(todayCheckin.notes || "")}" placeholder="Notas del día (opcional)…" style="flex:1;min-width:200px;background:rgba(255,255,255,.04);border:1px solid rgba(120,160,210,.15);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px;outline:none;font-family:inherit">
        <input id="dle-tw" value="${esc(todayCheckin.tradingWins || "")}" placeholder="Wins de trading (ej. 'vendí XRP a tiempo')" style="flex:1;min-width:200px;background:rgba(255,255,255,.04);border:1px solid rgba(120,160,210,.15);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px;outline:none;font-family:inherit">
        <input id="dle-tm" value="${esc(todayCheckin.tradingMistakes || "")}" placeholder="Errores de trading (para aprender)" style="flex:1;min-width:200px;background:rgba(255,255,255,.04);border:1px solid rgba(120,160,210,.15);border-radius:10px;padding:8px 12px;color:#eaf6ff;font-size:13px;outline:none;font-family:inherit">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button onclick="saveDailyCheckin()" id="dle-save-btn" style="padding:8px 18px;border-radius:10px;border:1px solid rgba(0,255,153,.35);background:rgba(0,255,153,.08);color:#00ff99;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Guardar día</button>
        <button onclick="generateDailyLearning()" id="dle-gen-btn" style="padding:8px 18px;border-radius:10px;border:1px solid rgba(129,140,248,.35);background:rgba(129,140,248,.08);color:#818cf8;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Generar aprendizaje</button>
        <span id="dle-status" style="font-size:12px;color:#3d5068"></span>
      </div>
    </div>

    <!-- Pattern cards -->
    <div style="border-top:1px solid rgba(120,160,210,.07);padding-top:14px">
      <div style="font-size:8px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#2e4258;margin-bottom:10px">Patrones detectados · ${Object.values(history).filter(r => r && r.whoop).length} días analizados</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        ${patternCard("◉", "Qué mejora mi Recovery", cannabisPat, "#818cf8")}
        ${patternCard("◎", "Qué mejora mi Sueño",    saunaPat,    "#f472b6")}
        ${patternCard("◈", "Mejor condición para operar", bestPat, "#3b9dff")}
        ${patternCard("◇", "Regla sugerida mañana",  tomorrowRec, "#ffd35c")}
      </div>
      <div style="margin-top:8px;font-size:11px;color:#2e3f52">Educativo — no es consejo financiero ni médico. Solo correlaciones de tus propios datos.</div>
    </div>
  </div>`;
}

function renderAlertsPanel() {
  const alerts  = readJSONSafe(CORDELIUS_ALERTS_FILE, []);
  const unread  = alerts.filter(a => a && !a.acknowledged).length;
  const latest  = alerts.slice(0, 5);
  const SC = { INFO: "#3b9dff", WARNING: "#ffd35c", CRITICAL: "#ff4d6d", OPPORTUNITY: "#00ff99" };
  const SE = { INFO: "ℹ",      WARNING: "⚠",       CRITICAL: "●",        OPPORTUNITY: "★" };
  const rows = latest.length ? latest.map(a => {
    const sc  = SC[a.severity] || "#9fb3c8";
    const em  = SE[a.severity] || "•";
    const msg = (a.message || "").slice(0, 160) + ((a.message || "").length > 160 ? "…" : "");
    let ts = a.date || "";
    try { ts = new Date(a.timestamp).toLocaleString("es-MX", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch(e) {}
    const ackBtn = !a.acknowledged
      ? `<button onclick="ackAlert('${esc(a.id)}')" style="padding:2px 10px;border-radius:6px;border:1px solid rgba(120,160,210,.2);background:transparent;color:#9fb3c8;font-size:10px;cursor:pointer">Marcar revisado</button>`
      : `<span style="font-size:10px;color:#3a4a5a">✓ Revisado</span>`;
    return `<div style="padding:10px 12px;border-radius:12px;background:${a.acknowledged?"rgba(0,0,0,.1)":"rgba(0,0,0,.25)"};border:1px solid ${sc}${a.acknowledged?"20":"35"};margin-bottom:6px;opacity:${a.acknowledged?".5":"1"}">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <span style="font-size:10px;font-weight:900;color:${sc};background:${sc}18;border:1px solid ${sc}30;border-radius:6px;padding:2px 7px;white-space:nowrap">${em} ${esc(a.severity)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:#eaf6ff;margin-bottom:3px">${esc(a.title)}</div>
          <div style="font-size:11px;color:#9fb3c8;line-height:1.45">${esc(msg)}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:5px;flex-wrap:wrap">
            <span style="font-size:10px;color:#3a4a5a">${esc(ts)}</span>
            ${a.sentToTelegram ? '<span style="font-size:10px;color:#00c8ff">· Telegram ✓</span>' : ""}
            ${ackBtn}
          </div>
        </div>
      </div>
    </div>`;
  }).join("") : `<div style="font-size:12px;color:#3a4a5a;padding:10px 0">Sin alertas recientes. Pulsa "Evaluar ahora" para verificar condiciones.</div>`;
  return `<div id="alerts-panel" style="margin-top:12px;padding:20px 22px;background:rgba(255,77,109,.03);border:1px solid rgba(255,77,109,.18);border-radius:20px">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:10px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ff6b8a">Cordelius Alerts</div>
          ${unread > 0 ? `<span style="background:#ff4d6d;color:#fff;font-size:10px;font-weight:900;border-radius:99px;padding:1px 8px">${unread}</span>` : ""}
          ${TG_CHAT_CONFIGURED ? '<span style="font-size:10px;color:#00c8ff;border:1px solid rgba(0,200,255,.25);border-radius:99px;padding:1px 8px">Telegram ✓</span>' : '<span style="font-size:10px;color:#3a4a5a;border:1px solid rgba(120,160,210,.12);border-radius:99px;padding:1px 8px">Telegram — agrega TELEGRAM_CHAT_ID</span>'}
        </div>
        <div style="font-size:11px;color:#3a4a5a;margin-top:3px">Alertas proactivas — salud, portafolio, mercado, aprendizaje. Máx ${ALERTS_MAX_PER_DAY}/día.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="runAlertCheck()" id="alert-check-btn" style="padding:8px 14px;border-radius:10px;border:1px solid rgba(255,77,109,.35);background:rgba(255,77,109,.1);color:#ff6b8a;font-size:12px;font-weight:700;cursor:pointer">Evaluar ahora</button>
        <a href="/api/alerts" target="_blank" style="padding:8px 14px;border-radius:10px;border:1px solid rgba(120,160,210,.2);background:transparent;color:#9fb3c8;font-size:12px;font-weight:700;cursor:pointer;text-decoration:none">Ver JSON →</a>
      </div>
    </div>
    <div id="alerts-list">${rows}</div>
  </div>`;
}

function renderAutopilotPanel() {
  const statusCards = [
    { label: "SERVIDOR",     value: "ON",       sub: "Cordelius OS",      bg: "rgba(0,255,153,.07)",    border: "rgba(0,255,153,.18)",    color: "#00ff99" },
    { label: "CLOUDFLARE",   value: "MANUAL",   sub: "bash tunnel.sh",    bg: "rgba(255,211,92,.07)",   border: "rgba(255,211,92,.18)",   color: "#ffd35c" },
    { label: "PAPER MODE",   value: "ON",       sub: "Sin dinero real",   bg: "rgba(0,255,153,.07)",    border: "rgba(0,255,153,.18)",    color: "#00ff99" },
    { label: "REAL TRADING", value: "OFF",      sub: "Desactivado",       bg: "rgba(255,77,109,.07)",   border: "rgba(255,77,109,.18)",   color: "#ff4d6d" },
    { label: "QUIVER",       value: quiverData.configured ? "ON" : "—",  sub: quiverData.configured ? "Datos en vivo" : "Agrega API key", bg: quiverData.configured ? "rgba(0,255,153,.07)" : "rgba(255,211,92,.07)", border: quiverData.configured ? "rgba(0,255,153,.18)" : "rgba(255,211,92,.18)", color: quiverData.configured ? "#00ff99" : "#ffd35c" },
    { label: "ALPACA",       value: "PENDIENTE",sub: "Paper solo (F3)",   bg: "rgba(129,140,248,.07)",  border: "rgba(129,140,248,.18)",  color: "#818cf8" },
    { label: "WHOOP",        value: WHOOP_CONFIGURED ? "DETECTADO" : "PENDIENTE", sub: WHOOP_CONFIGURED ? "API key lista" : "Conecta para readiness", bg: WHOOP_CONFIGURED ? "rgba(0,255,153,.07)" : "rgba(244,114,182,.07)", border: WHOOP_CONFIGURED ? "rgba(0,255,153,.18)" : "rgba(244,114,182,.18)", color: WHOOP_CONFIGURED ? "#00ff99" : "#f472b6" },
  ];
  return `<div style="max-width:1280px;margin:0 auto 16px">
    <div class="panel" style="border:1px solid rgba(129,140,248,.18);background:rgba(129,140,248,.04)">
      <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#818cf8;margin-bottom:12px">Autopilot — Estado del sistema</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px">
        ${statusCards.map(c => `<div style="background:${c.bg};border:1px solid ${c.border};border-radius:12px;padding:10px 12px;text-align:center">
          <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:${c.color};margin-bottom:3px">${c.label}</div>
          <div style="font-size:16px;font-weight:900;color:${c.color}">${c.value}</div>
          <div class="muted" style="font-size:10px;margin-top:2px">${c.sub}</div>
        </div>`).join("")}
      </div>
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

    <!-- Decision Log · Trading Memory -->
    <div style="margin-top:12px;padding:20px 22px;background:rgba(0,200,255,.03);border:1px solid rgba(0,200,255,.18);border-radius:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <div>
          <div style="font-size:10px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#00c8ff">Decision Log · Trading Memory</div>
          <div class="muted" style="font-size:11px;margin-top:3px">Registro persistente de decisiones educativas y aprendizaje del portafolio</div>
        </div>
        <a href="/api/autopilot/decisions" target="_blank" style="font-size:11px;color:#9fb3c8;text-decoration:none">Ver JSON →</a>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px">
        <div style="background:rgba(0,0,0,.2);border:1px solid rgba(0,200,255,.15);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:#9fb3c8;margin-bottom:4px">TOTAL</div>
          <div id="dl-total" style="font-size:26px;font-weight:900;color:#00c8ff">—</div>
          <div class="muted" style="font-size:10px">decisiones</div>
        </div>
        <div style="background:rgba(0,0,0,.2);border:1px solid rgba(255,211,92,.15);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:#9fb3c8;margin-bottom:4px">PENDIENTES</div>
          <div id="dl-pending" style="font-size:26px;font-weight:900;color:#ffd35c">—</div>
          <div class="muted" style="font-size:10px">sin revisar</div>
        </div>
        <div style="background:rgba(0,0,0,.2);border:1px solid rgba(0,255,153,.15);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:#9fb3c8;margin-bottom:4px">TICKER TOP</div>
          <div id="dl-ticker" style="font-size:18px;font-weight:900;color:#00ff99">—</div>
          <div class="muted" style="font-size:10px">más vigilado</div>
        </div>
        <div style="background:rgba(0,0,0,.2);border:1px solid rgba(129,140,248,.15);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:9px;font-weight:900;letter-spacing:.1em;color:#9fb3c8;margin-bottom:4px">ÚLTIMA</div>
          <div id="dl-last-action" style="font-size:14px;font-weight:900;color:#818cf8">—</div>
          <div id="dl-last-sym" class="muted" style="font-size:11px">—</div>
        </div>
      </div>

      <div id="dl-summary" style="padding:10px 14px;border-radius:12px;background:rgba(0,200,255,.05);border:1px solid rgba(0,200,255,.12);font-size:13px;color:#c7dff7;line-height:1.55;margin-bottom:14px">Cargando resumen de aprendizaje...</div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <button onclick="openDecisionModal()" style="padding:8px 16px;border-radius:10px;border:1px solid rgba(0,200,255,.35);background:rgba(0,200,255,.1);color:#00c8ff;font-size:12px;font-weight:700;cursor:pointer">+ Guardar decisión</button>
        <button onclick="markLatestDecision('WATCH')" style="padding:8px 16px;border-radius:10px;border:1px solid rgba(255,211,92,.35);background:rgba(255,211,92,.08);color:#ffd35c;font-size:12px;font-weight:700;cursor:pointer">Marcar WATCH</button>
        <button onclick="markLatestDecision('NO_ACTION')" style="padding:8px 16px;border-radius:10px;border:1px solid rgba(129,140,248,.35);background:rgba(129,140,248,.08);color:#818cf8;font-size:12px;font-weight:700;cursor:pointer">Marcar NO ACTION</button>
        <button onclick="loadAutopilotDecisions()" style="padding:8px 16px;border-radius:10px;border:1px solid rgba(120,160,210,.2);background:rgba(0,0,0,.15);color:#9fb3c8;font-size:12px;font-weight:700;cursor:pointer">Actualizar</button>
      </div>

      <div id="dl-list" style="max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
        <div class="muted" style="font-size:12px;padding:10px">Cargando decisiones...</div>
      </div>
    </div>

    <!-- Decision Modal -->
    <div id="dl-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;align-items:center;justify-content:center">
      <div style="background:#0a1220;border:1px solid rgba(0,200,255,.3);border-radius:22px;padding:28px 32px;width:90%;max-width:480px;box-shadow:0 30px 80px rgba(0,0,0,.6)">
        <div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#00c8ff;margin-bottom:14px">Nueva Decisión Educativa</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <input id="dl-inp-symbol" placeholder="Ticker (ej. AAPL, XRP)" style="background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none">
          <select id="dl-inp-action" style="background:#0a1220;border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none">
            <option value="WATCH">WATCH — vigilar</option>
            <option value="BUY_DIP">BUY DIP — posible entrada en baja</option>
            <option value="REDUCE">REDUCE — reducir exposición</option>
            <option value="HOLD">HOLD — mantener</option>
            <option value="NO_ACTION">NO ACTION — sin cambio</option>
            <option value="INVESTIGATE">INVESTIGATE — investigar más</option>
          </select>
          <div style="display:flex;align-items:center;gap:10px">
            <label style="font-size:12px;color:#9fb3c8;white-space:nowrap">Convicción:</label>
            <input id="dl-inp-conviction" type="range" min="1" max="10" value="5" style="flex:1" oninput="document.getElementById('dl-conv-val').textContent=this.value">
            <span id="dl-conv-val" style="font-size:14px;font-weight:900;color:#00c8ff;min-width:20px">5</span>
          </div>
          <textarea id="dl-inp-reason" placeholder="Razón o contexto (opcional)" rows="3" style="background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:13px;outline:none;resize:vertical"></textarea>
        </div>
        <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
          <button onclick="document.getElementById('dl-modal').style.display='none'" style="padding:10px 20px;border-radius:10px;border:1px solid rgba(120,160,210,.2);background:transparent;color:#9fb3c8;font-size:13px;cursor:pointer">Cancelar</button>
          <button onclick="submitDecisionModal()" style="padding:10px 20px;border-radius:10px;border:none;background:linear-gradient(90deg,#00c8ff,#3b9dff);color:#000;font-size:13px;font-weight:900;cursor:pointer">Guardar</button>
        </div>
      </div>
    </div>
    ${renderDailyLearningPanel()}
    ${renderAlertsPanel()}
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
  const alfredoAdvice = `Portafolio ${money(pv.totalValueMXN)} (${pct(pv.totalGainPct)}). ` +
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
        <div style="margin-top:5px;font-size:12px;color:#9fb3c8"><span id="hr-advice">${esc(alfredoAdvice)}</span> <span style="opacity:.6">· No es consejo financiero.</span></div>
      </div>
      <div class="muted" style="font-size:11px;margin-top:8px">${esc(h.educationalNote)}</div>
    </div>
  </div>`;
}


function renderHealthOSPanel() {
  const h = computeHealthReadiness();

  function clamp(n, min, max) { n = Number(n); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0; }
  function fmt(v, suffix) {
    if (v === null || v === undefined || v === "") return "—";
    if (typeof v === "number") { const o = Math.abs(v) % 1 ? v.toFixed(1) : String(v); return esc(o + (suffix || "")); }
    return esc(String(v) + (suffix || ""));
  }
  function fmtMin(mins) {
    if (mins == null) return "—";
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function trendArrow(t) {
    if (!t) return "";
    if (t === "SUBIENDO" || t === "MEJORANDO" || t === "DISMINUYENDO") return ' <span style="color:#00ff99">↑</span>';
    if (t === "BAJANDO" || t === "EMPEORANDO" || t === "ACUMULANDO")  return ' <span style="color:#ff4d6d">↓</span>';
    return ' <span style="color:#ffd35c">→</span>';
  }

  const recovery  = clamp(h.recovery,  0, 100);
  const sleep     = clamp(h.sleep,     0, 100);
  const strainPct = clamp((Number(h.strain || 0) / 21) * 100, 0, 100);
  const hrvScore  = clamp((Number(h.hrv    || 0) / 160) * 100, 0, 100);

  const hs = h.healthScore     ?? Math.round(recovery * 0.34 + sleep * 0.24 + hrvScore * 0.18 + (100 - strainPct) * 0.28);
  const es = h.energyScore     ?? Math.round(recovery * 0.40 + sleep * 0.35 + (100 - strainPct) * 0.25);
  const dw = h.deepWorkScore   ?? Math.round(sleep * 0.40 + hrvScore * 0.35 + (100 - strainPct) * 0.25);
  const ns = h.nervousSystemScore ?? Math.round(hrvScore * 0.6 + (100 - strainPct) * 0.4);

  const status = hs >= 85 ? "EXCELENTE" : hs >= 70 ? "BUENO" : hs >= 55 ? "MEDIO" : hs >= 40 ? "BAJO" : "CRÍTICO";
  const statusColor = hs >= 70 ? "#00ff99" : hs >= 55 ? "#ffd35c" : "#ff4d6d";
  const badgeLabel  = h.connected ? "WHOOP LIVE" : h.configured ? "WHOOP DETECTADO" : "WHOOP PENDIENTE";
  const badgeBg     = h.connected ? "rgba(0,255,153,.12)" : h.configured ? "rgba(255,211,92,.12)" : "rgba(120,160,210,.08)";
  const badgeColor  = h.connected ? "#00ff99" : h.configured ? "#ffd35c" : "#9fb3c8";
  const mode        = h.operatingMode || "NORMAL";

  function donut(label, value, raw, color) {
    const v = clamp(value, 0, 100);
    return `<div class="health-os-card health-os-donut-card">
      <div class="health-os-donut" style="background:conic-gradient(${color} ${v}%, rgba(120,160,210,.13) 0)">
        <div class="health-os-donut-inner">
          <div class="health-os-donut-value">${esc(raw)}</div>
          <div class="health-os-donut-label">${esc(label)}</div>
        </div>
      </div>
    </div>`;
  }

  function scoreBar(label, score, color) {
    const pct = clamp(score, 0, 100);
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;margin-bottom:3px">
        <span style="font-size:11px;font-weight:700;color:#9fb3c8;text-transform:uppercase;letter-spacing:.08em">${esc(label)}</span>
        <b style="font-size:13px;font-weight:900;color:${color}">${pct}</b>
      </div>
      <div style="height:5px;border-radius:99px;background:rgba(120,160,210,.12);overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:99px;transition:.4s"></div>
      </div>
    </div>`;
  }

  const aiText = `Sistema en modo ${mode}. Recovery ${h.recovery ?? "—"}% · Sleep ${h.sleep ?? "—"}% · HRV ${h.hrv != null ? Number(h.hrv).toFixed(1) + " ms" : "—"} · Strain ${h.strain != null ? Number(h.strain).toFixed(1) : "—"}. Health Score ${hs}/100 — ${status}. ${h.suggestion}. ${h.connected ? `RHR ${h.restingHeartRate ?? "—"} bpm. ` : ""}Educativo — no es consejo médico.`;

  return `<section id="health-os-shell" class="health-os-shell">
    <style>
      .health-os-shell{max-width:1440px;margin:0 auto 28px;padding:22px 26px;border-radius:34px;background:radial-gradient(circle at 16% 0%,rgba(244,114,182,.22),transparent 35%),radial-gradient(circle at 88% 12%,rgba(59,157,255,.20),transparent 34%),linear-gradient(135deg,rgba(4,10,22,.96),rgba(9,17,32,.9));border:1px solid rgba(244,114,182,.18);box-shadow:0 24px 80px rgba(0,0,0,.42)}
      .health-os-hero{display:grid;grid-template-columns:1.3fr .7fr;gap:18px;margin-bottom:18px}
      .health-os-title{font-size:44px;font-weight:950;letter-spacing:-.04em;background:linear-gradient(90deg,#f9a8d4,#3b9dff,#00ff99);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:6px 0}
      .health-os-kicker{font-size:11px;font-weight:950;letter-spacing:.18em;text-transform:uppercase;color:#f472b6}
      .health-os-sub{color:#9fb3c8;font-size:13px;line-height:1.6}
      .health-os-badge{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:6px 13px;font-size:12px;font-weight:900}
      .health-os-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:14px}
      .health-os-card{border:1px solid rgba(120,160,210,.14);background:rgba(255,255,255,.042);border-radius:22px;padding:16px 18px;box-shadow:inset 0 1px rgba(255,255,255,.04),0 8px 24px rgba(0,0,0,.18);backdrop-filter:blur(12px)}
      .health-os-label{font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:6px}
      .health-os-value{font-size:30px;font-weight:950;color:#eaf6ff;line-height:1}
      .health-os-small{font-size:12px;color:#9fb3c8;margin-top:5px;line-height:1.6}
      .health-os-donut-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:14px}
      .health-os-donut-card{display:flex;align-items:center;justify-content:center;min-height:210px}
      .health-os-donut{width:168px;height:168px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 40px rgba(0,0,0,.35)}
      .health-os-donut-inner{width:118px;height:118px;border-radius:50%;background:rgba(4,10,22,.96);display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.08)}
      .health-os-donut-value{font-size:26px;font-weight:950;color:#eaf6ff}
      .health-os-donut-label{font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#9fb3c8;margin-top:4px}
      .health-os-wide{grid-column:1/-1}
      .health-os-ai{font-size:14px;color:#dbeafe;line-height:1.75}
      .health-os-chip{display:inline-flex;border-radius:999px;padding:6px 11px;margin:4px;background:rgba(244,114,182,.08);border:1px solid rgba(244,114,182,.18);color:#f9a8d4;font-size:12px;font-weight:800;cursor:pointer;transition:.18s}
      .health-os-chip:hover{background:rgba(244,114,182,.18)}
      .health-os-stage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-top:8px}
      .health-os-stage-pill{border-radius:12px;padding:8px 10px;text-align:center}
      @media(max-width:900px){.health-os-shell{padding:14px;border-radius:24px}.health-os-hero{grid-template-columns:1fr}.health-os-title{font-size:32px}.health-os-donut-row{grid-template-columns:repeat(2,1fr)}.health-os-value{font-size:24px}}
    </style>

    <!-- HERO -->
    <div class="health-os-hero">
      <div class="health-os-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
          <div>
            <div class="health-os-kicker">Cordelius Health OS 2.0</div>
            <div class="health-os-title">Biological OS</div>
            <div class="health-os-sub">WHOOP-first · Sueño · Recovery · HRV · Energía · Sistema nervioso · No es consejo médico.</div>
          </div>
          <span id="health-os-whoop-badge" class="health-os-badge" style="background:${badgeBg};border:1px solid ${badgeColor}40;color:${badgeColor}">● ${esc(badgeLabel)}</span>
        </div>
        <!-- Trend row -->
        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
          <span style="font-size:11px;color:#9fb3c8">Recovery 7d:${trendArrow(h.recoveryTrend)}<b style="color:#eaf6ff"> ${esc(h.recoveryTrend || "—")}</b></span>
          <span style="font-size:11px;color:#9fb3c8">Sueño 7d:${trendArrow(h.sleepTrend)}<b style="color:#eaf6ff"> ${esc(h.sleepTrend || "—")}</b></span>
          <span style="font-size:11px;color:#9fb3c8">Fatiga:${trendArrow(h.fatigueTrend === "DISMINUYENDO" ? "SUBIENDO" : h.fatigueTrend === "ACUMULANDO" ? "BAJANDO" : "")}<b style="color:#eaf6ff"> ${esc(h.fatigueTrend || "—")}</b></span>
        </div>
      </div>
      <div class="health-os-card" style="display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:6px">
        <div class="health-os-label">Health Score</div>
        <div id="health-os-score" style="font-size:56px;font-weight:950;color:${statusColor};line-height:1">${hs}</div>
        <div id="health-os-status" style="font-size:13px;font-weight:900;color:${statusColor}">${status}</div>
        <div style="font-size:11px;color:#9fb3c8">Modo: <b id="health-os-mode" style="color:#ffd35c">${esc(mode)}</b></div>
      </div>
    </div>

    <!-- CORE DONUTS -->
    <div class="health-os-donut-row">
      ${donut("Recovery",  recovery,  h.recovery != null  ? h.recovery  + "%" : "—", "#00ff99")}
      ${donut("Sleep",     sleep,     h.sleep    != null  ? h.sleep     + "%" : "—", "#3b9dff")}
      ${donut("Strain",    strainPct, h.strain   != null  ? Number(h.strain).toFixed(1)  : "—", "#f472b6")}
      ${donut("HRV Score", clamp(hrvScore, 0, 100), h.hrv != null ? Number(h.hrv).toFixed(1) + " ms" : "—", "#818cf8")}
    </div>

    <!-- CORE METRICS -->
    <div class="health-os-grid" style="margin-bottom:14px">
      <div class="health-os-card"><div class="health-os-label">Recovery</div><div id="health-os-recovery" class="health-os-value" style="color:#00ff99">${fmt(h.recovery, "%")}</div><div class="health-os-small">Capacidad de carga del día${trendArrow(h.recoveryTrend)}</div></div>
      <div class="health-os-card"><div class="health-os-label">Sleep Performance</div><div id="health-os-sleep" class="health-os-value" style="color:#3b9dff">${fmt(h.sleep, "%")}</div><div class="health-os-small">Base de recuperación mental${trendArrow(h.sleepTrend)}</div></div>
      <div class="health-os-card"><div class="health-os-label">HRV</div><div id="health-os-hrv" class="health-os-value" style="color:#818cf8">${fmt(h.hrv, " ms")}</div><div class="health-os-small">Sistema nervioso autónomo</div></div>
      <div class="health-os-card"><div class="health-os-label">Resting HR</div><div id="health-os-rhr" class="health-os-value">${fmt(h.restingHeartRate, " bpm")}</div><div class="health-os-small">Carga fisiológica base</div></div>
      <div class="health-os-card"><div class="health-os-label">Strain</div><div id="health-os-strain" class="health-os-value" style="color:#f472b6">${fmt(h.strain != null ? Number(h.strain).toFixed(1) : null, "")}</div><div class="health-os-small">Carga acumulada del ciclo</div></div>
      <div class="health-os-card"><div class="health-os-label">Freq. Respiratoria</div><div id="health-os-rr" class="health-os-value" style="font-size:22px">${fmt(h.respiratoryRate, " rpm")}</div><div class="health-os-small">Indicador ANS nocturno</div></div>
    </div>

    <!-- SLEEP STAGES -->
    <div class="health-os-card health-os-wide" style="margin-bottom:14px">
      <div class="health-os-label">Arquitectura del sueño</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:10px">
        <div class="health-os-stage-pill" style="background:rgba(129,140,248,.1);border:1px solid rgba(129,140,248,.2)">
          <div style="font-size:11px;font-weight:900;letter-spacing:.1em;color:#818cf8;margin-bottom:4px">REM</div>
          <div style="font-size:20px;font-weight:950;color:#eaf6ff">${esc(fmtMin(h.remMins))}</div>
        </div>
        <div class="health-os-stage-pill" style="background:rgba(59,157,255,.1);border:1px solid rgba(59,157,255,.2)">
          <div style="font-size:11px;font-weight:900;letter-spacing:.1em;color:#3b9dff;margin-bottom:4px">DEEP</div>
          <div style="font-size:20px;font-weight:950;color:#eaf6ff">${esc(fmtMin(h.deepMins))}</div>
        </div>
        <div class="health-os-stage-pill" style="background:rgba(120,160,210,.08);border:1px solid rgba(120,160,210,.15)">
          <div style="font-size:11px;font-weight:900;letter-spacing:.1em;color:#9fb3c8;margin-bottom:4px">LIGHT</div>
          <div style="font-size:20px;font-weight:950;color:#eaf6ff">${esc(fmtMin(h.lightMins))}</div>
        </div>
        <div class="health-os-stage-pill" style="background:rgba(255,211,92,.07);border:1px solid rgba(255,211,92,.15)">
          <div style="font-size:11px;font-weight:900;letter-spacing:.1em;color:#ffd35c;margin-bottom:4px">TOTAL</div>
          <div style="font-size:20px;font-weight:950;color:#eaf6ff">${esc(fmtMin(h.sleepDurationMins))}</div>
        </div>
        <div class="health-os-stage-pill" style="background:rgba(0,255,153,.07);border:1px solid rgba(0,255,153,.15)">
          <div style="font-size:11px;font-weight:900;letter-spacing:.1em;color:#00ff99;margin-bottom:4px">EFICIENCIA</div>
          <div style="font-size:20px;font-weight:950;color:#eaf6ff">${fmt(h.sleepEfficiency, "%")}</div>
        </div>
        <div class="health-os-stage-pill" style="background:rgba(244,114,182,.07);border:1px solid rgba(244,114,182,.15)">
          <div style="font-size:11px;font-weight:900;letter-spacing:.1em;color:#f472b6;margin-bottom:4px">DEUDA</div>
          <div style="font-size:20px;font-weight:950;color:${h.sleepDebt != null && h.sleepDebt > 0.5 ? '#ff4d6d' : '#eaf6ff'}">${h.sleepDebt != null ? (h.sleepDebt > 0 ? '+' : '') + h.sleepDebt + 'h' : '—'}</div>
        </div>
      </div>
    </div>

    <!-- DERIVED SCORES -->
    <div class="health-os-grid" style="margin-bottom:14px">
      <div class="health-os-card">
        <div class="health-os-label">Scores derivados</div>
        ${scoreBar("Energy Score",        clamp(es, 0, 100), es >= 70 ? "#00ff99" : es >= 50 ? "#ffd35c" : "#ff4d6d")}
        ${scoreBar("Deep Work Score",     clamp(dw, 0, 100), dw >= 70 ? "#3b9dff" : dw >= 50 ? "#ffd35c" : "#ff4d6d")}
        ${scoreBar("Nervous System",      clamp(ns, 0, 100), ns >= 70 ? "#818cf8" : ns >= 50 ? "#ffd35c" : "#ff4d6d")}
        ${scoreBar("Stress Load",         clamp(h.stressLoadScore ?? 50, 0, 100), "#f472b6")}
      </div>

      <div class="health-os-card">
        <div class="health-os-label">Energy Engine</div>
        <div class="health-os-small">Physical Energy: <b id="health-os-energy-physical" style="color:#00ff99">${Math.round((recovery + sleep) / 2)}</b>/100</div>
        <div class="health-os-small">Mental Energy: <b id="health-os-energy-mental" style="color:#3b9dff">${Math.round((sleep + hrvScore) / 2)}</b>/100</div>
        <div class="health-os-small">Focus Capacity: <b id="health-os-energy-focus" style="color:#818cf8">${Math.round((sleep + recovery + hrvScore) / 3)}</b>/100</div>
        <div class="health-os-small">Deep Work: <b id="health-os-energy-deepwork" style="color:#ffd35c">${dw}</b>/100</div>
        <div class="health-os-small">Trading Capacity: <b id="health-os-energy-trading" style="color:#f472b6">${Math.round((recovery + hrvScore + (100 - strainPct)) / 3)}</b>/100</div>
      </div>

      <div class="health-os-card">
        <div class="health-os-label">Behavior Tracker</div>
        <div id="health-os-behaviors">
          <button class="health-os-chip" onclick="toggleHealthBehavior && toggleHealthBehavior('sauna')">Sauna</button>
          <button class="health-os-chip" onclick="toggleHealthBehavior && toggleHealthBehavior('cannabis')">Cannabis</button>
          <button class="health-os-chip" onclick="toggleHealthBehavior && toggleHealthBehavior('training')">Training</button>
          <button class="health-os-chip" onclick="toggleHealthBehavior && toggleHealthBehavior('stress')">High Stress</button>
          <button class="health-os-chip" onclick="toggleHealthBehavior && toggleHealthBehavior('alcohol')">Alcohol</button>
          <button class="health-os-chip" onclick="toggleHealthBehavior && toggleHealthBehavior('meditation')">Meditación</button>
        </div>
        <div class="health-os-small" style="margin-top:8px">Opcional. Ayuda a detectar correlaciones.</div>
      </div>

      <div class="health-os-card">
        <div class="health-os-label">Correlation Engine</div>
        <div id="health-os-correlations" class="health-os-small">Recolectando snapshots. Se activa con más días de datos para detectar patrones sueño→decisión.</div>
      </div>

      <div class="health-os-card health-os-wide">
        <div class="health-os-label">Alfredo Health AI</div>
        <div id="health-os-ai" class="health-os-ai">${esc(aiText)}</div>
      </div>

      <div class="health-os-card health-os-wide">
        <div class="health-os-label">Integración Trading</div>
        <div id="health-os-trading-risk" class="health-os-small">
          Recovery &lt; 50% → modo <b style="color:#ff4d6d">DEFENSIVO</b> · Recovery 50–79% → <b style="color:#ffd35c">NEUTRAL</b> · Recovery ≥ 80% + Strain bajo → <b style="color:#00ff99">ÓPTIMO</b>
          <br>Strain alto (&gt;16) → reducir agresividad · HRV bajo → evitar sobreoperar · Deuda de sueño alta → no tomar posiciones impulsivas.
          <br>Educativo. No es asesoría médica ni financiera.
        </div>
      </div>
    </div>
  </section>`;
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
  const modules = [
    { label: "PORTAFOLIO",    value: money(pv.totalValueMXN), sub: pct(pv.totalGainPct), color: pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d", href: "#portfolio" },
    { label: "MERCADO",       value: esc(reg.label),           sub: pct(reg.avg),         color: reg.color,  href: "#vigilar" },
    { label: "PAPER TRADE",   value: idea.hasIdea ? esc(idea.type) : "SIN SEÑAL", sub: idea.hasIdea ? esc(idea.symbol || "") : "", color: idea.hasIdea ? "#00ff99" : "#9fb3c8", href: "#bot" },
    { label: "HEALTH",        value: h.configured ? "WHOOP ON" : "SIN DATOS",    sub: esc(h.operatingMode), color: h.configured ? "#00ff99" : "#9fb3c8", href: "#health" },
    { label: "QUIVER",        value: quiverData.configured ? "LIVE" : "PENDIENTE", sub: quiverData.configured ? "Datos institucionales" : "Agrega API key", color: quiverData.configured ? "#00ff99" : "#ffd35c", href: "#quiver" },
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

function renderHomePortal(pv, reg) {
  const h = computeHealthReadiness();
  const jd = computeJournalData();
  const idea = computeTradeIdea();
  const nl = computeDailyNewsletter();
  const modules = [
    { id: "trading",      label: "Cordelius Trading",       emoji: "◈", color: "#3b9dff", sub: `${money(pv.totalValueMXN)} · ${pct(pv.totalGainPct)}`, badge: pv.totalGainPct >= 0 ? "↑" : "↓", badgeColor: pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d", desc: "Portafolio · Paper Trade · Quiver · Market Radar" },
    { id: "health",       label: "Cordelius Health",        emoji: "◉", color: "#f472b6", sub: `WHOOP ${h.configured ? "ON" : "pendiente"} · ${h.operatingMode}`, badge: h.configured ? "ON" : "—", badgeColor: h.configured ? "#00ff99" : "#9fb3c8", desc: "Recovery · Sleep · Strain · HRV · Readiness" },
    { id: "journal",      label: "Cordelius Journal",       emoji: "◎", color: "#818cf8", sub: `${jd.count} entradas · ${jd.topMood ? "mood: " + jd.topMood : "sin entradas"}`, badge: jd.count > 0 ? String(jd.count) : "+", badgeColor: "#818cf8", desc: "Diario personal · Mood · Ideas · Reflexiones" },
    { id: "intelligence", label: "Cordelius Intelligence",  emoji: "◆", color: "#00ff99", sub: `${news.length} noticias · Intel: ${intelItems.length}`, badge: news.length > 0 ? String(news.length) : "—", badgeColor: "#3b9dff", desc: "Noticias · Quiver · Congreso · Sectores · Radar" },
    { id: "autopilot",    label: "Cordelius Autopilot",     emoji: "◇", color: "#ffd35c", sub: `Servidor ON · Paper Mode · ${quiverData.configured ? "Quiver ON" : "Quiver —"}`, badge: "ON", badgeColor: "#00ff99", desc: "Scripts · Cloud · Estado sistema · Automatización" },
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
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px">
          <span style="color:#9fb3c8;font-size:13px">${esc(nl.date)}</span>
          <span id="home-live-clock" style="font-size:16px;font-weight:900;color:#eaf6ff;font-variant-numeric:tabular-nums;letter-spacing:.06em">${esc(nowMX())}</span>
        </div>
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
        <div style="display:inline-flex;align-items:center;gap:6px;border:1px solid ${m.color}40;border-radius:99px;padding:5px 12px;font-size:12px;font-weight:900;color:${m.badgeColor}">${esc(m.badge)} Entrar →</div>
      </div>`).join("")}
    </div>

    <!-- Mini daily brief -->
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:16px">
      <div class="panel" style="border:1px solid rgba(59,157,255,.18);background:rgba(59,157,255,.04);padding:16px 20px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#3b9dff;margin-bottom:8px">Daily Brief</div>
        <div style="font-size:15px;font-weight:700;color:#dbeafe;margin-bottom:10px">${esc(nl.greeting)}</div>
        <ul style="margin:0;padding-left:16px;list-style:disc">
          ${nl.lines.slice(0, 3).map(l => `<li style="font-size:13px;color:#c8d8f0;margin-bottom:4px">${esc(l)}</li>`).join("")}
        </ul>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="panel" style="padding:12px 16px;flex:1">
          <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:6px">Trade Idea</div>
          ${idea.hasIdea
            ? `<div style="font-size:15px;font-weight:900;color:#ffd35c">${esc(idea.type)}</div><div style="font-size:13px;color:#9fb3c8">${esc(idea.symbol)} · ${esc(idea.reason.slice(0,50))}</div>`
            : `<div style="font-size:14px;color:#9fb3c8">Sin señal activa</div>`}
        </div>
        <div class="panel" style="padding:12px 16px;flex:1">
          <div style="font-size:9px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#9fb3c8;margin-bottom:6px">Estado</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;font-weight:900;background:rgba(0,255,153,.1);color:#00ff99;border-radius:99px;padding:3px 9px">Servidor ON</span>
            <span style="font-size:11px;font-weight:900;background:rgba(255,77,109,.1);color:#ff4d6d;border-radius:99px;padding:3px 9px">Real Trading OFF</span>
            <span style="font-size:11px;font-weight:900;background:rgba(0,255,153,.1);color:#00ff99;border-radius:99px;padding:3px 9px">Paper ON</span>
          </div>
        </div>
      </div>
    </div>
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

    <!-- AUTO JOURNAL — protagonista -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:18px">
      <div class="panel" style="padding:16px 20px;border:1px solid ${autoColor}30;background:${autoColor}08">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:${autoColor};margin-bottom:6px">Mood estimado</div>
        <div style="font-size:26px;font-weight:900;color:${autoColor}">${esc(aj.moodEstimated)}</div>
        <div class="muted" style="font-size:11px">${esc(aj.date)}</div>
      </div>
      <div class="panel" style="padding:16px 20px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#f472b6;margin-bottom:6px">WHOOP · Strain</div>
        <div style="font-size:26px;font-weight:900;color:#eaf6ff">${aj.strain !== null ? aj.strain.toFixed(1) : "—"}</div>
        <div class="muted" style="font-size:11px">Avg HR: ${aj.averageHeartRate !== null ? aj.averageHeartRate + " bpm" : "—"} · Max: ${aj.maxHeartRate !== null ? aj.maxHeartRate + " bpm" : "—"}</div>
      </div>
      <div class="panel" style="padding:16px 20px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#3b9dff;margin-bottom:6px">Recovery</div>
        <div style="font-size:26px;font-weight:900;color:${aj.recovery !== null ? (aj.recovery >= 67 ? "#00ff99" : aj.recovery >= 34 ? "#ffd35c" : "#ff4d6d") : "#9fb3c8"}">${aj.recovery !== null ? aj.recovery + "%" : "—"}</div>
        <div class="muted" style="font-size:11px">HRV: ${aj.hrv !== null ? aj.hrv.toFixed(1) + " ms" : "—"} · RHR: ${aj.restingHeartRate !== null ? aj.restingHeartRate + " bpm" : "—"}</div>
      </div>
      <div class="panel" style="padding:16px 20px">
        <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#ffd35c;margin-bottom:6px">Modo trading</div>
        <div style="font-size:14px;font-weight:900;color:#ffd35c;line-height:1.3">${esc(aj.tradingModeSuggestion.split("—")[0])}</div>
        <div class="muted" style="font-size:11px">${esc((aj.tradingModeSuggestion.split("—")[1] || "").trim())}</div>
      </div>
    </div>

    <div class="panel" style="padding:14px 18px;margin-bottom:18px;border:1px solid rgba(129,140,248,.15);background:rgba(129,140,248,.04)">
      <div style="font-size:9px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#818cf8;margin-bottom:6px">Nota Alfredo</div>
      <div style="font-size:13px;color:#c8d8f0;line-height:1.6">${esc(aj.alfredoNote)}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        ${["resumen de mi día","cómo me he sentido","resume mi diario"].map(q =>
          `<button onclick="setJarvisQ('${q}')" class="btn" style="font-size:12px;padding:6px 12px;color:#3b9dff;border-color:rgba(59,157,255,.25)">${q}</button>`
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
          <form method="POST" action="/api/journal">
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
    <div style="font-size:13px;color:#9fb3c8;margin-bottom:14px">Investiga cualquier ticker — perfil, señales Quiver, noticias y tesis educativa. Powered by Jarvis.</div>
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

function render() {
  const pv = portfolioValue();
  const reg = marketRegime();
  const assets = pv.assets;
  const ranked = assets.slice().sort((a, b) => b.score - a.score);
  const best = ranked[0], worst = ranked[ranked.length - 1];
  const botEq = botValue(), botPnl = botEq - bot.initialCapital;
  const grouped = {};
  for (const a of assets) { const key = `${a.source} · ${a.category}`; grouped[key] = grouped[key] || []; grouped[key].push(a); }
  const chatHtml = chatHistory.map(c => `<div class="msg"><b>Tu:</b> ${esc(c.question)}<br><b>Jarvis:</b><div>${md(c.reply)}</div><small>${esc(c.time)}</small></div>`).join("");
  const botTables = renderBotTables();
  const topTV = TV_SYMBOL[best.symbol] || "NASDAQ:MSFT";

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${settings.autoRefreshSeconds}">
<title>${esc(settings.appName)}</title>
<style>
:root{--bg:#02040a;--panel:rgba(7,16,30,.72);--line:rgba(120,160,210,.16);--muted:#9fb3c8;--green:#00ff99;--red:#ff4d6d;--blue:#3b9dff;--gold:#ffd35c;--text:#eaf6ff}
*{box-sizing:border-box}
body{margin:0;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#02040a;padding:0 18px 120px;overflow-x:hidden}
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
.disclaimer{max-width:1280px;margin:34px auto 0;color:#5a6674;font-size:12px;text-align:center;padding:16px;border-top:1px solid rgba(120,160,210,.08)}
@media(max-width:820px){h1{font-size:34px}.brain-card{grid-template-columns:1fr}.news-card{grid-template-columns:1fr}.asset-row summary{grid-template-columns:1fr}.asset-money{text-align:left}.rank{grid-template-columns:1fr}.chatbox{flex-direction:column}.tv-embed{height:380px}}
.mod{display:none}.mod.active-mod{display:block}
.nav-mod{border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--text);border-radius:14px;padding:10px 16px;font-weight:700;cursor:pointer;transition:.2s;font-size:14px;font-family:inherit;white-space:nowrap}
.nav-mod:hover,.nav-mod.nav-active{background:rgba(59,157,255,.14);border-color:#3b9dff;color:#3b9dff}
/* ── Jarvis OS panel ── */
#jarvis-panel{position:fixed;top:0;right:0;width:min(460px,100vw);height:100vh;z-index:500;background:rgba(2,4,10,.97);border-left:1px solid rgba(59,157,255,.18);backdrop-filter:blur(32px);transform:translateX(100%);transition:transform .38s cubic-bezier(.22,.84,.44,.96);overflow-y:auto;display:flex;flex-direction:column}
#jarvis-panel.jv-open{transform:translateX(0)}
#jv-overlay{position:fixed;inset:0;z-index:499;background:rgba(2,4,10,.4);backdrop-filter:blur(3px);display:none;cursor:pointer}
#jv-overlay.jv-open{display:block}
.jv-btn{display:flex;align-items:center;gap:7px;background:transparent;border:1px solid rgba(59,157,255,.22);border-radius:14px;padding:8px 14px;cursor:pointer;color:#9fb3c8;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.06em;transition:.2s;white-space:nowrap}
.jv-btn:hover{background:rgba(59,157,255,.08);border-color:rgba(59,157,255,.45);color:#3b9dff}
.jv-btn.jv-active{background:rgba(0,255,153,.07);border-color:rgba(0,255,153,.4);color:#00ff99;box-shadow:0 0 14px rgba(0,255,153,.12)}
.jv-head{padding:20px 22px 14px;border-bottom:1px solid rgba(120,160,210,.1);display:flex;align-items:flex-start;justify-content:space-between;flex-shrink:0;background:rgba(0,0,0,.15)}
.jv-head-label{font-size:7px;font-weight:900;letter-spacing:.24em;text-transform:uppercase;color:#2e4258;margin-bottom:5px}
.jv-mode-badge{font-size:14px;font-weight:900}
.jv-close{background:transparent;border:none;color:#2e4258;font-size:22px;cursor:pointer;padding:2px 8px;border-radius:8px;line-height:1;transition:.15s;font-family:inherit}
.jv-close:hover{color:#eaf6ff;background:rgba(255,255,255,.06)}
.jv-thought-wrap{padding:14px 22px 12px;border-bottom:1px solid rgba(120,160,210,.07);flex-shrink:0}
.jv-thought-tag{display:inline-block;font-size:7px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;color:#00ff99;border:1px solid rgba(0,255,153,.2);border-radius:6px;padding:2px 7px;margin-bottom:7px;background:rgba(0,255,153,.04)}
.jv-thought-text{font-size:13px;color:#c8d8f0;line-height:1.7;min-height:42px;transition:opacity .35s}
.jv-section{padding:12px 22px;border-bottom:1px solid rgba(120,160,210,.06)}
.jv-section-hd{font-size:7px;font-weight:900;letter-spacing:.2em;text-transform:uppercase;color:#2e3f52;margin-bottom:9px}
.jv-row{display:flex;align-items:center;justify-content:space-between;padding:2px 0}
.jv-key{font-size:12px;color:#445f74}
.jv-val{font-size:13px;font-weight:700;color:#c0d4ea;text-align:right}
/* ── Neural node animations ── */
.jv-n0{transform-box:fill-box;transform-origin:center;animation:jv-core-p 2.4s ease-in-out infinite}
.jv-n1{animation:jv-np 3s .0s ease-in-out infinite}
.jv-n2{animation:jv-np 3s .4s ease-in-out infinite}
.jv-n3{animation:jv-np 3s .8s ease-in-out infinite}
.jv-n4{animation:jv-np 3s 1.2s ease-in-out infinite}
.jv-n5{animation:jv-np 3s 1.6s ease-in-out infinite}
.jv-cn0{animation:jv-conn-p 2.8s .0s ease-in-out infinite}
.jv-cn1{animation:jv-conn-p 2.8s .4s ease-in-out infinite}
.jv-cn2{animation:jv-conn-p 2.8s .8s ease-in-out infinite}
.jv-cn3{animation:jv-conn-p 2.8s 1.2s ease-in-out infinite}
.jv-cn4{animation:jv-conn-p 2.8s 1.6s ease-in-out infinite}
@keyframes jv-np{0%,100%{opacity:.15}50%{opacity:.85}}
@keyframes jv-core-p{0%,100%{opacity:.85;transform:scale(1)}50%{opacity:1;transform:scale(1.35)}}
@keyframes jv-conn-p{0%{opacity:.06}50%{opacity:.5}100%{opacity:.06}}
.range-btn{border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--muted);border-radius:10px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;transition:.18s;font-family:inherit}
.range-btn:hover,.range-btn.rb-active{background:rgba(59,157,255,.16);border-color:rgba(59,157,255,.5);color:#3b9dff}
.news-item{max-width:1280px;margin:8px auto;border:1px solid rgba(120,160,210,.1);border-radius:18px;background:var(--panel);backdrop-filter:blur(16px);overflow:hidden}
.news-item summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:13px 16px;user-select:none}
.news-item summary::-webkit-details-marker{display:none}
.news-item[open]{border-color:rgba(59,157,255,.25)}
.news-item .ni-caret{transition:.2s;flex:0 0 auto;opacity:.5;font-size:11px}
.news-item[open] .ni-caret{transform:rotate(180deg)}
#research-result{animation:fade .3s ease}
</style></head><body>
<div class="particles">${Array.from({ length: 18 }).map((_, i) => `<i style="left:${(i * 5.5 + 3) % 100}%;animation-duration:${9 + (i % 7)}s;animation-delay:${(i % 9)}s"></i>`).join("")}</div>
${(function(){
  const hb = computeHealthReadiness();
  const bc = hb.operatingMode === "ÓPTIMO" ? "#00ff99" : hb.operatingMode === "DEFENSIVO" ? "#ff4d6d" : hb.operatingMode === "NEUTRAL" ? "#ffd35c" : "#3b9dff";
  const modeColor = bc;
  return `
<div id="jv-overlay" onclick="toggleJarvis()"></div>
<div id="jarvis-panel">
  <div class="jv-head">
    <div>
      <div class="jv-head-label">JARVIS &middot; CORDELIUS OS</div>
      <div id="jv-mode-badge" class="jv-mode-badge" style="color:${modeColor}">${esc(hb.operatingMode || "CARGANDO")}</div>
    </div>
    <button class="jv-close" onclick="toggleJarvis()">&#x2715;</button>
  </div>

  <div class="jv-thought-wrap">
    <div class="jv-thought-tag">JARVIS</div>
    <div id="jv-thought" class="jv-thought-text">Analizando sistema&hellip;</div>
  </div>

  <div class="jv-section">
    <div class="jv-section-hd">Health &middot; WHOOP</div>
    <div class="jv-row"><span class="jv-key">Recovery</span><b id="jv-h-recovery" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Sleep</span><b id="jv-h-sleep" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">HRV</span><b id="jv-h-hrv" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Strain</span><b id="jv-h-strain" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Modo operativo</span><b id="jv-h-mode" class="jv-val" style="color:${modeColor}">${esc(hb.operatingMode || "—")}</b></div>
  </div>

  <div class="jv-section">
    <div class="jv-section-hd">Trading &middot; Portafolio</div>
    <div class="jv-row"><span class="jv-key">Valor total</span><b id="jv-t-value" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">PnL</span><b id="jv-t-pnl" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Mayor ganador</span><b id="jv-t-winner" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Mayor riesgo</span><b id="jv-t-loser" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Concentraci&oacute;n</span><b id="jv-t-risk" class="jv-val">—</b></div>
  </div>

  <div class="jv-section">
    <div class="jv-section-hd">Intelligence &middot; Radar</div>
    <div class="jv-row"><span class="jv-key">Noticias activas</span><b id="jv-i-count" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Balance de se&ntilde;ales</span><b id="jv-i-topics" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Riesgos detectados</span><b id="jv-i-risks" class="jv-val">—</b></div>
  </div>

  <div class="jv-section">
    <div class="jv-section-hd">Autopilot &middot; Memoria</div>
    <div class="jv-row"><span class="jv-key">XP total</span><b id="jv-a-xp" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Nivel</span><b id="jv-a-level" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Decisiones</span><b id="jv-a-decisions" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">&Uacute;ltima acci&oacute;n</span><b id="jv-a-last" class="jv-val">—</b></div>
  </div>

  <div class="jv-section">
    <div class="jv-section-hd">Daily Learning &middot; Hoy</div>
    <div class="jv-row"><span class="jv-key">Capacidad trading</span><b id="jv-d-capacity" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Recomendaci&oacute;n riesgo</span><b id="jv-d-risk" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Foco</span><b id="jv-d-focus" class="jv-val">—</b></div>
    <div class="jv-row"><span class="jv-key">Estado</span><b id="jv-d-status" class="jv-val">—</b></div>
  </div>

  <div class="jv-section" style="flex:1;border-bottom:none;padding-bottom:24px">
    <div class="jv-section-hd" style="margin-bottom:10px">Chat &middot; Consultar</div>
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">
      ${["Qué vigilar hoy","Morning report","Modo operativo","Analiza mi portafolio","Resumen de hoy"].map(q =>
        `<button onclick="setJarvisQ('${q}')" class="btn" style="font-size:11px;padding:5px 10px;border-color:rgba(59,157,255,.2)">${esc(q)}</button>`
      ).join("")}
    </div>
    <form class="chatbox" method="POST" action="/ask">
      <input name="q" id="jv-chat-input" placeholder="Consulta a Jarvis&hellip;" autocomplete="off">
      <button class="btn" type="submit">Enviar</button>
    </form>
    <div style="max-height:240px;overflow-y:auto;margin-top:12px">
      ${chatHtml || '<div class="msg muted">Sin historial todav&iacute;a.</div>'}
    </div>
  </div>
</div>`;
})()}

<header>
  <div class="logo-wrap">
    <div class="app-icon"><svg width="44" height="44" viewBox="0 0 44 44" fill="none"><polygon points="22,4 40,34 4,34" stroke="rgba(255,255,255,.9)" stroke-width="2.2" fill="none"/><line x1="22" y1="4" x2="22" y2="34" stroke="rgba(255,255,255,.6)" stroke-width="1.2"/><circle cx="22" cy="22" r="4" fill="rgba(255,255,255,.95)"/></svg></div>
    <div><h1 id="brand-title">Cordelius</h1><div id="module-subtitle" class="subtitle">Personal OS · Trading · Health · Intelligence · Autopilot</div></div>
  </div>
  <nav style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
    <button data-mod="home" class="nav-mod" onclick="showMod('home')">Inicio</button>
    <button data-mod="trading" class="nav-mod" onclick="showMod('trading')">◈ Trading</button>
    <button data-mod="health" class="nav-mod" onclick="showMod('health')">◉ Health</button>
    <button data-mod="journal" class="nav-mod" onclick="showMod('journal')">◎ Journal</button>
    <button data-mod="intelligence" class="nav-mod" onclick="showMod('intelligence')">◆ Intelligence</button>
    <button data-mod="autopilot" class="nav-mod" onclick="showMod('autopilot')">◇ Autopilot</button>
    <span style="width:1px;height:22px;background:rgba(120,160,210,.14);display:inline-block;margin:0 2px"></span>
    ${(function(){
      const hb = computeHealthReadiness();
      const bc = hb.operatingMode === "ÓPTIMO" ? "#00ff99" : hb.operatingMode === "DEFENSIVO" ? "#ff4d6d" : hb.operatingMode === "NEUTRAL" ? "#ffd35c" : "#3b9dff";
      return `<button id="jv-btn" class="jv-btn" onclick="toggleJarvis()" title="Jarvis &middot; Cordelius OS &middot; ${esc(hb.operatingMode)}" style="border-color:${bc}35;color:${bc}bb">
  <svg width="36" height="28" viewBox="0 0 44 34" fill="none">
    <line x1="22" y1="17" x2="22" y2="3" stroke="${bc}" stroke-width="1.2" class="jv-cn0"/>
    <line x1="22" y1="17" x2="40" y2="17" stroke="${bc}" stroke-width="1.2" class="jv-cn1"/>
    <line x1="22" y1="17" x2="35" y2="29" stroke="${bc}" stroke-width="1.2" class="jv-cn2"/>
    <line x1="22" y1="17" x2="9" y2="29" stroke="${bc}" stroke-width="1.2" class="jv-cn3"/>
    <line x1="22" y1="17" x2="4" y2="17" stroke="${bc}" stroke-width="1.2" class="jv-cn4"/>
    <line x1="22" y1="3" x2="40" y2="17" stroke="rgba(59,157,255,.28)" stroke-width=".7"/>
    <line x1="40" y1="17" x2="35" y2="29" stroke="rgba(59,157,255,.28)" stroke-width=".7"/>
    <line x1="35" y1="29" x2="9" y2="29" stroke="rgba(59,157,255,.28)" stroke-width=".7"/>
    <line x1="9" y1="29" x2="4" y2="17" stroke="rgba(59,157,255,.28)" stroke-width=".7"/>
    <line x1="4" y1="17" x2="22" y2="3" stroke="rgba(59,157,255,.28)" stroke-width=".7"/>
    <circle cx="22" cy="3" r="2.2" fill="${bc}" class="jv-n1"/>
    <circle cx="40" cy="17" r="2.2" fill="${bc}" class="jv-n2"/>
    <circle cx="35" cy="29" r="2.2" fill="${bc}" class="jv-n3"/>
    <circle cx="9" cy="29" r="2.2" fill="${bc}" class="jv-n4"/>
    <circle cx="4" cy="17" r="2.2" fill="${bc}" class="jv-n5"/>
    <circle cx="22" cy="17" r="5.5" fill="${bc}" opacity=".1"/>
    <circle cx="22" cy="17" r="3.5" fill="${bc}" class="jv-n0"/>
  </svg>
  <span style="font-size:11px;font-weight:900;letter-spacing:.04em">Jarvis</span>
</button>`;
    })()}
  </nav>
</header>

<div class="toolbar">
  <a class="switch" href="/toggle-thinking"><span class="dot"></span>Thinking Mode: <b>${settings.thinkingEnabled ? "ON" : "OFF"}</b></a>
  <span class="switch">Refresh: <b>${settings.autoRefreshSeconds}s</b></span>
  <span class="switch">Finnhub: <b class="${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</b></span>
  <span class="switch">Claude: <b class="${ANTHROPIC_API_KEY ? "green" : "yellow"}">${ANTHROPIC_API_KEY ? "OK" : "SIN KEY"}</b></span>
</div>

<!-- ── MOD: HOME ─────────────────────────────────────────── -->
<div id="mod-home" class="mod active-mod">
${renderHomePortal(pv, reg)}
</div>

<!-- ── MOD: TRADING ──────────────────────────────────────── -->
<div id="mod-trading" class="mod">
<div style="max-width:1280px;margin:0 auto 8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
  ${(function(){var A=pv.assets||[];var tot=pv.totalValueMXN||1;var gbm=A.filter(function(a){return a.source==="GBM";}).reduce(function(s,a){return s+a.valueMXN;},0);var plata=A.filter(function(a){return a.source==="Plata";}).reduce(function(s,a){return s+a.valueMXN;},0);var bitso=A.filter(function(a){return a.source==="Bitso";}).reduce(function(s,a){return s+a.valueMXN;},0);var cripto=A.filter(function(a){return a.type==="crypto";}).reduce(function(s,a){return s+a.valueMXN;},0);var cp=cripto/tot*100;function pp(x){return (x/tot*100).toFixed(1)+"%";}return `<div class="card" style="padding:14px 16px"><div class="label">Patrimonio</div><div class="big green glow" style="font-size:26px">${money(pv.totalValueMXN)}</div><div class="${pv.totalGainPct >= 0 ? "green" : "red"}" style="font-size:13px">${pct(pv.totalGainPct)} · ${money(pv.totalGainMXN)}</div></div><div class="card" style="padding:14px 16px"><div class="label">Tipo de cambio</div><div class="big" style="font-size:26px">$${FX_USD_MXN.toFixed(2)}</div><div class="muted" style="font-size:11px">USD/MXN · ${nowMX()}</div></div><div class="card" style="padding:14px 16px"><div class="label">Exposición</div><div style="font-size:13px">GBM ${pp(gbm)}</div><div style="font-size:13px">Plata ${pp(plata)}</div><div style="font-size:13px">Bitso ${pp(bitso)}</div></div>`;})()}
  <div class="card" style="padding:14px 16px"><div class="label">Régimen</div><div class="big" style="color:${reg.color};font-size:22px">${esc(reg.label)}</div><div class="muted" style="font-size:11px">${pct(reg.avg)}</div></div>
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
  <div id="port-chart-area">${spark(portfolioHistory, { key: "total", color: "#3b9dff", height: 300 })}</div>
  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;align-items:center">
    <span class="muted" id="port-chart-info" style="font-size:12px">${portfolioHistory.length} snapshots</span>
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

<a id="brain"></a><h2>Cerebro vivo de Cordelius</h2>${brainHtml()}

<a id="portfolio"></a>
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin:0 0 6px">
  <h2 style="margin:0">Portafolio real por cuenta</h2>
  <div style="display:flex;gap:6px;flex-wrap:wrap">
    <button onclick="openPortfolioAdd()" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(0,255,153,.35);background:rgba(0,255,153,.1);color:#00ff99;font-size:12px;font-weight:700;cursor:pointer">+ Agregar activo</button>
    <a href="/api/portfolio/editable" target="_blank" style="padding:7px 14px;border-radius:10px;border:1px solid rgba(120,160,210,.2);background:transparent;color:#9fb3c8;font-size:12px;font-weight:700;text-decoration:none">Ver JSON →</a>
  </div>
</div>

<!-- Portfolio Edit Modal -->
<div id="port-edit-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;align-items:center;justify-content:center">
  <div style="background:#0a1220;border:1px solid rgba(255,211,92,.3);border-radius:22px;padding:28px 32px;width:90%;max-width:440px;box-shadow:0 30px 80px rgba(0,0,0,.6)">
    <div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#ffd35c;margin-bottom:6px">Editar posición</div>
    <div id="pe-sym-label" style="font-size:16px;font-weight:900;color:#eaf6ff;margin-bottom:16px">—</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">UNIDADES / CANTIDAD</div>
          <input id="pe-units" type="number" step="any" min="0" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box">
        </div>
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">MONEDA</div>
          <select id="pe-currency" style="width:100%;background:#0a1220;border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none">
            <option value="MXN">MXN</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </div>
      <div>
        <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">VALOR ACTUAL (en moneda)</div>
        <input id="pe-value" type="number" step="any" min="0" placeholder="Valor actual del total de posición" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box">
      </div>
      <div>
        <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">COSTO ORIGINAL (en moneda)</div>
        <input id="pe-cost" type="number" step="any" min="0" placeholder="Costo total de compra" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box">
      </div>
    </div>
    <div style="font-size:11px;color:#3a4a5a;margin-top:10px">Cambio guardado al instante en data/cordelius_portfolio.json · educativo — no consejo financiero.</div>
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
      <button onclick="document.getElementById('port-edit-modal').style.display='none'" style="padding:10px 20px;border-radius:10px;border:1px solid rgba(120,160,210,.2);background:transparent;color:#9fb3c8;font-size:13px;cursor:pointer">Cancelar</button>
      <button onclick="submitPortfolioEdit()" style="padding:10px 20px;border-radius:10px;border:none;background:linear-gradient(90deg,#ffd35c,#f59e0b);color:#000;font-size:13px;font-weight:900;cursor:pointer">Guardar</button>
    </div>
  </div>
</div>

<!-- Portfolio Add Modal -->
<div id="port-add-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;align-items:center;justify-content:center;overflow-y:auto">
  <div style="background:#0a1220;border:1px solid rgba(0,255,153,.3);border-radius:22px;padding:28px 32px;width:90%;max-width:480px;box-shadow:0 30px 80px rgba(0,0,0,.6);margin:20px auto">
    <div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#00ff99;margin-bottom:16px">Agregar activo al portafolio</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">SÍMBOLO *</div>
          <input id="pa-sym" placeholder="ej. TSLA, SOL" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(0,255,153,.25);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box;font-weight:900">
        </div>
        <div style="flex:2">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">NOMBRE</div>
          <input id="pa-name" placeholder="ej. Tesla Inc." style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box">
        </div>
      </div>
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">UNIDADES *</div>
          <input id="pa-units" type="number" step="any" min="0" placeholder="0" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box">
        </div>
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">MONEDA</div>
          <select id="pa-currency" style="width:100%;background:#0a1220;border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none">
            <option value="MXN">MXN</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">VALOR ACTUAL</div>
          <input id="pa-value" type="number" step="any" min="0" placeholder="0.00" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box">
        </div>
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">COSTO ORIGINAL</div>
          <input id="pa-cost" type="number" step="any" min="0" placeholder="0.00" style="width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none;box-sizing:border-box">
        </div>
      </div>
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">BROKER / FUENTE</div>
          <select id="pa-source" style="width:100%;background:#0a1220;border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none">
            <option value="GBM">GBM</option>
            <option value="Plata">Plata</option>
            <option value="Bitso">Bitso</option>
            <option value="Manual">Manual</option>
          </select>
        </div>
        <div style="flex:1">
          <div style="font-size:10px;color:#9fb3c8;margin-bottom:4px;letter-spacing:.08em">TIPO</div>
          <select id="pa-type" style="width:100%;background:#0a1220;border:1px solid rgba(120,160,210,.2);border-radius:10px;padding:10px 14px;color:#eaf6ff;font-size:14px;outline:none">
            <option value="stock">Stock (USA)</option>
            <option value="stock_mx">Stock México</option>
            <option value="crypto">Cripto</option>
            <option value="etf">ETF</option>
          </select>
        </div>
      </div>
    </div>
    <div style="font-size:11px;color:#3a4a5a;margin-top:10px">Sistema educativo — sin órdenes reales. No es consejo financiero.</div>
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
      <button onclick="document.getElementById('port-add-modal').style.display='none'" style="padding:10px 20px;border-radius:10px;border:1px solid rgba(120,160,210,.2);background:transparent;color:#9fb3c8;font-size:13px;cursor:pointer">Cancelar</button>
      <button onclick="submitPortfolioAdd()" style="padding:10px 20px;border-radius:10px;border:none;background:linear-gradient(90deg,#00ff99,#00c8ff);color:#000;font-size:13px;font-weight:900;cursor:pointer">Agregar</button>
    </div>
  </div>
</div>

${(function(){
  const bySource = {};
  for (const a of assets) { bySource[a.source] = bySource[a.source] || []; bySource[a.source].push(a); }
  return Object.entries(bySource).map(([src, list]) =>
    renderAccountSummary(src, list)
    + `<h2 style="font-size:18px;margin:6px 0 8px;color:#9fb3c8">${esc(src)} · ${[...new Set(list.map(a => a.category))].join(", ")}</h2>`
    + renderPortfolioRows(list)
  ).join("");
})()}

${renderSignalCenter(pv, reg)}

<a id="news"></a><h2>Noticias inteligentes + activos impactados</h2>${renderNews()}

<a id="bot"></a><h2>Trading AI — Paper Mode · Laboratorio ficticio</h2>
${renderTradingAIStatus()}
${renderPaperTradingPanel()}

</div>
<!-- ── MOD: HEALTH ────────────────────────────────────────── -->
<div id="mod-health" class="mod">
${renderHealthOSPanel()}
</div>
<!-- ── MOD: JOURNAL ───────────────────────────────────────── -->
<div id="mod-journal" class="mod">
${renderJournalModule()}
</div>
<!-- ── MOD: INTELLIGENCE ─────────────────────────────────── -->
<div id="mod-intelligence" class="mod">
${renderStockResearch()}
${renderDailyBrief()}
${renderMorningReport()}

<a id="quiver"></a><h2>Quiver — Congreso · Insiders · Contratos · Políticos <span style="background:${QUIVER_API_KEY && quiverData.configured ? '#00ff99' : '#ffd166'};color:#000;border-radius:99px;padding:2px 10px;font-size:12px;font-weight:900;vertical-align:middle;margin-left:8px">${QUIVER_API_KEY && quiverData.configured ? 'LIVE' : 'PENDIENTE'}</span></h2>
${renderQuiverIntelligencePanel()}

<a id="intel"></a><h2>Cordelius Intelligence — Grok / X manual${intelItems.length ? ' <span style="background:#3b9dff;color:#fff;border-radius:99px;padding:2px 11px;font-size:13px;vertical-align:middle;margin-left:6px">' + intelItems.length + '</span>' : ''}</h2>${renderIntelPanel()}

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
<!-- ── MOD: AUTOPILOT ─────────────────────────────────────── -->
<div id="mod-autopilot" class="mod">
<h2>Autopilot — Estado del sistema · Automatización</h2>

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
      await fetch("/api/autopilot/snapshot", { method: "POST" });
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

${renderAutopilotPanel()}

<h2>Sistema</h2>
<div class="grid">
  <div class="card"><div class="label">App</div><div class="big green">${esc(settings.appName)}</div></div>
  <div class="card"><div class="label">Alfredo AI</div><div class="big ${settings.thinkingEnabled ? "green" : "yellow"}">${settings.thinkingEnabled ? "THINKING" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Finnhub</div><div class="big ${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Quiver</div><div class="big ${QUIVER_API_KEY ? "green" : "yellow"}">${QUIVER_API_KEY ? "OK" : "PENDIENTE"}</div></div>
  <div class="card"><div class="label">WHOOP</div><div class="big ${WHOOP_CONFIGURED ? "green" : "yellow"}">${WHOOP_CONFIGURED ? "ON" : "PENDIENTE"}</div></div>
  <div class="card"><div class="label">Journal</div><div class="big" style="color:#818cf8">${journalEntries.length} entradas</div></div>
</div>
</div>

<div class="disclaimer">Cordelius OS es educativo. No es asesoria financiera. El bot de trading es 100% ficticio (paper trading) y no se conecta a ningun exchange real. WHOOP pendiente de conexion. Alpaca PAPER ONLY.</div>









<script id="health-os-live-loader-final">
(function(){
  function set(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = (v === null || v === undefined || v === "") ? "—" : String(v);
  }

  function n(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : null;
  }

  async function loadHealthOSFinal() {
    try {
      var r = await fetch("/api/whoop/today", { cache: "no-store" });
      if (!r.ok) return;
      var d = await r.json();

      var recovery = n(d.recovery);
      var sleep = n(d.sleep);
      var strain = n(d.strain);
      var hrv = n(d.hrv);
      var rhr = n(d.restingHeartRate);

      set("health-os-recovery", recovery != null ? recovery + "%" : "—");
      set("health-os-sleep", sleep != null ? sleep + "%" : "—");
      set("health-os-strain", strain != null ? strain.toFixed(1) : "—");
      set("health-os-hrv", hrv != null ? hrv.toFixed(1) + " ms" : "—");
      set("health-os-rhr", rhr != null ? Math.round(rhr) + " bpm" : "—");

      var rec = recovery || 0;
      var slp = sleep || 0;
      var hrvScore = hrv != null ? Math.max(0, Math.min(100, hrv / 160 * 100)) : 0;
      var rhrScore = rhr != null ? Math.max(0, Math.min(100, 100 - Math.max(0, rhr - 38) * 2)) : 70;
      var strainPct = strain != null ? Math.max(0, Math.min(100, strain / 21 * 100)) : 0;

      var score = Math.round(rec * .34 + slp * .24 + hrvScore * .18 + rhrScore * .12 + (100 - strainPct) * .12);
      var status = score >= 85 ? "EXCELENTE" : score >= 70 ? "BUENO" : score >= 55 ? "MEDIO" : score >= 40 ? "BAJO" : "CRÍTICO";

      set("health-os-score", score);
      set("health-os-status", status);
      set("health-os-readiness", status);
      set("health-os-mode", d.operatingMode || d.mode || "NORMAL");

      set("health-os-energy-physical", Math.round((rec + slp) / 2));
      set("health-os-energy-mental", Math.round((slp + hrvScore) / 2));
      set("health-os-energy-focus", Math.round((slp + rec + hrvScore) / 3));
      set("health-os-energy-deepwork", Math.round((slp + hrvScore + (100 - strainPct)) / 3));
      set("health-os-energy-trading", Math.round((rec + hrvScore + (100 - strainPct)) / 3));

      var badge = document.getElementById("health-os-whoop-badge");
      if (badge) badge.textContent = d.connected ? "● WHOOP LIVE" : "WHOOP PENDIENTE";

      var ai = document.getElementById("health-os-ai");
      if (ai && d.alfredoAdvice) ai.textContent = d.alfredoAdvice;

      console.log("Health OS final loaded", d);
    } catch(e) {
      console.error("Health OS final loader failed", e);
    }
  }

  window.loadHealthOS = loadHealthOSFinal;
  window.loadHealthOSFinal = loadHealthOSFinal;

  document.addEventListener("DOMContentLoaded", function(){
    setTimeout(loadHealthOSFinal, 300);
    setTimeout(loadHealthOSFinal, 1300);
  });

  setTimeout(loadHealthOSFinal, 300);
  setTimeout(loadHealthOSFinal, 1300);
  setInterval(loadHealthOSFinal, 60000);
})();
</script>

</body>
<script>
var _VALID_MODS = ['home','trading','health','journal','intelligence','autopilot'];

function validModName(name) {
  var n = String(name || 'home').split('?')[0].replace('#','').toLowerCase().trim();
  return _VALID_MODS.indexOf(n) === -1 ? 'home' : n;
}

function getCordeliusModuleTitle(mod) {
  const titles = {
    home: "Cordelius",
    trading: "Cordelius Trading",
    health: "Cordelius Health",
    journal: "Cordelius Journal",
    intelligence: "Cordelius Intelligence",
    autopilot: "Cordelius Autopilot"
  };
  return titles[mod] || "Cordelius";
}

function updateCordeliusBranding(mod) {
  const title = getCordeliusModuleTitle(mod);
  document.title = title;
  const brand = document.getElementById("brand-title");
  if (brand) brand.textContent = title;
  const subtitle = document.getElementById("module-subtitle");
  if (subtitle) {
    subtitle.textContent = mod === "home"
      ? "Personal OS · Trading · Health · Intelligence · Autopilot"
      : "Módulo activo dentro de Cordelius";
  }
}

function showMod(name) {
  var n = validModName(name);
  updateCordeliusBranding(n);
  document.querySelectorAll('.mod').forEach(function(m){ m.classList.remove('active-mod'); });
  document.querySelectorAll('.nav-mod').forEach(function(b){ b.classList.remove('nav-active'); });
  var mod = document.getElementById('mod-' + n);
  if (!mod) {
    n = 'home';
    mod = document.getElementById('mod-home');
    updateCordeliusBranding(n);
  }
  if (mod) mod.classList.add('active-mod');
  var btn = document.querySelector('[data-mod="' + n + '"]');
  if (btn) btn.classList.add('nav-active');
  try { localStorage.setItem('corde_mod', n); } catch(e) {}
  try {
    if (window.location.hash !== '#' + n) history.replaceState(null, '', '#' + n);
  } catch(e) {}
  if (n === 'health' && typeof loadHealthOS === 'function') loadHealthOS();
  if (n === 'journal' && typeof loadJournal === 'function') loadJournal();
  if (n === 'intelligence' && typeof loadIntelligence === 'function') loadIntelligence();
  if (n === 'autopilot' && typeof loadAutopilotDecisions === 'function') loadAutopilotDecisions();
}
}

function healthOSSet(id, value) {
  var el = document.getElementById(id);
  if (el) el.textContent = value == null || value === '' ? '—' : String(value);
}

function healthOSFmt(n, d) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(d == null ? 0 : d);
}

async function toggleHealthBehavior(key) {
  try {
    await fetch('/api/health/behavior', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ behavior:key })
    });
    await loadHealthOS();
  } catch(e) {
    console.warn('toggleHealthBehavior failed', e);
  }
}

async function loadHealthOS() {
  if (!document.getElementById('health-os-shell')) return;

  try {
    var insights = {};
    var whoop = {};

    try {
      var ir = await fetch('/api/health/insights', { cache:'no-store' });
      if (ir.ok) insights = await ir.json();
    } catch(e) {}

    try {
      var wr = await fetch('/api/whoop/today', { cache:'no-store' });
      if (wr.ok) whoop = await wr.json();
    } catch(e) {}

    var m = insights.metrics || {};
    var recovery = m.recovery ?? whoop.recovery;
    var sleep = m.sleep ?? whoop.sleep;
    var strain = m.strain ?? whoop.strain;
    var hrv = m.hrv_ms ?? whoop.hrv;
    var rhr = m.resting_hr_bpm ?? whoop.restingHeartRate;

    healthOSSet('health-os-recovery', recovery != null ? recovery + '%' : '—');
    healthOSSet('health-os-sleep', sleep != null ? sleep + '%' : '—');
    healthOSSet('health-os-strain', strain != null ? healthOSFmt(strain, 1) : '—');
    healthOSSet('health-os-hrv', hrv != null ? healthOSFmt(hrv, 1) + ' ms' : '—');
    healthOSSet('health-os-rhr', rhr != null ? rhr + ' bpm' : '—');

    var rec = Number(recovery || 0);
    var slp = Number(sleep || 0);
    var hrvScore = Math.max(0, Math.min(100, Number(hrv || 0) / 160 * 100));
    var strainPct = Math.max(0, Math.min(100, Number(strain || 0) / 21 * 100));
    var score = Math.round(rec * .34 + slp * .24 + hrvScore * .18 + (100 - strainPct) * .24);
    var status = score >= 85 ? 'EXCELENTE' : score >= 70 ? 'BUENO' : score >= 55 ? 'MEDIO' : score >= 40 ? 'BAJO' : 'CRÍTICO';
    var mode = insights.readiness || whoop.mode || whoop.operatingMode || (rec < 50 ? 'DEFENSIVO' : 'NORMAL');

    healthOSSet('health-os-score', score);
    healthOSSet('health-os-status', status);
    healthOSSet('health-os-readiness', status);
    healthOSSet('health-os-mode', mode);

    healthOSSet('health-os-energy-physical', Math.round((rec + slp) / 2));
    healthOSSet('health-os-energy-mental', Math.round((slp + hrvScore) / 2));
    healthOSSet('health-os-energy-focus', Math.round((slp + rec + hrvScore) / 3));
    healthOSSet('health-os-energy-deepwork', Math.round((slp + hrvScore + (100 - strainPct)) / 3));
    healthOSSet('health-os-energy-trading', Math.round((rec + hrvScore + (100 - strainPct)) / 3));

    var ai = document.getElementById('health-os-ai');
    if (ai && (insights.aiBrief || whoop.alfredoAdvice)) {
      ai.textContent = insights.aiBrief || whoop.alfredoAdvice;
    }

    var badge = document.getElementById('health-os-whoop-badge');
    if (badge) badge.textContent = whoop.connected ? '● WHOOP LIVE' : 'WHOOP DETECTADO';

  } catch(e) {
    healthOSSet('health-os-ai', 'No se pudo cargar Health OS. Revisa /api/health/insights y /api/whoop/today.');
    console.error('loadHealthOS failed', e);
  }
}

// ── Jarvis OS ──────────────────────────────────────────────────────────────

window.jarvis = {
  _data: { health: {}, trading: {}, intel: {}, autopilot: {} },
  _open: false,
  _thoughtTimer: null,
  toggle: function() { toggleJarvis(); },
  open:   function() { if (!this._open) toggleJarvis(); },
  close:  function() { if (this._open) toggleJarvis(); },
  read:   function(mod) { return this._data[mod] || {}; },
  ask:    function(q) { setJarvisQ(q); this.open(); },
  refresh: function() { return loadJarvisData(); }
};

function toggleJarvis() {
  var panel   = document.getElementById('jarvis-panel');
  var overlay = document.getElementById('jv-overlay');
  var btn     = document.getElementById('jv-btn');
  if (!panel) return;
  var isOpen = panel.classList.contains('jv-open');
  if (isOpen) {
    panel.classList.remove('jv-open');
    if (overlay) overlay.classList.remove('jv-open');
    if (btn) btn.classList.remove('jv-active');
    if (window.jarvis) {
      window.jarvis._open = false;
      if (window.jarvis._thoughtTimer) { clearInterval(window.jarvis._thoughtTimer); window.jarvis._thoughtTimer = null; }
    }
  } else {
    panel.classList.add('jv-open');
    if (overlay) overlay.classList.add('jv-open');
    if (btn) btn.classList.add('jv-active');
    if (window.jarvis) window.jarvis._open = true;
    loadJarvisData();
    if (window.jarvis) {
      if (window.jarvis._thoughtTimer) clearInterval(window.jarvis._thoughtTimer);
      window.jarvis._thoughtTimer = setInterval(function() {
        if (window.jarvis._data && Object.keys(window.jarvis._data.health).length > 0) {
          jarvisUpdateThought(window.jarvis._data);
        }
      }, 9000);
    }
  }
}

function setJarvisQ(q) {
  var inp = document.getElementById('jv-chat-input');
  if (!inp) inp = document.querySelector('#jarvis-panel [name=q]');
  if (inp) inp.value = q;
  if (window.jarvis) window.jarvis.open();
}

// backward-compat aliases (other code may still call these)
function setAlfredoQ(q) { setJarvisQ(q); }
function toggleAlfredo() { toggleJarvis(); }

async function loadJarvisData() {
  try {
    var results = await Promise.allSettled([
      fetch('/api/whoop/today',          { cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : {}; }),
      fetch('/api/portfolio',            { cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : {}; }),
      fetch('/api/intel',                { cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : {}; }),
      fetch('/api/autopilot/decisions',  { cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : {}; }),
      fetch('/api/daily/today',          { cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : {}; })
    ]);
    var health  = results[0].status === 'fulfilled' ? results[0].value : {};
    var trading = results[1].status === 'fulfilled' ? results[1].value : {};
    var intel   = results[2].status === 'fulfilled' ? results[2].value : {};
    var ap      = results[3].status === 'fulfilled' ? results[3].value : {};
    var daily   = results[4].status === 'fulfilled' ? results[4].value : {};
    if (window.jarvis) window.jarvis._data = { health: health, trading: trading, intel: intel, autopilot: ap };

    function jvset(id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = (val == null || val === '') ? '—' : String(val);
    }
    function jvcolor(id, text, col) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = text == null ? '—' : String(text);
      if (col) el.style.color = col;
    }

    // — Health —
    var rec  = health.recovery;
    var slp  = health.sleep;
    var hrv  = health.hrv;
    var str  = health.strain;
    var mode = health.mode || health.operatingMode || '—';
    jvcolor('jv-h-recovery', rec  != null ? rec + '%'                   : null, rec  != null ? (rec >= 70 ? '#00ff99' : rec < 50 ? '#ff4d6d' : '#ffd35c') : null);
    jvcolor('jv-h-sleep',    slp  != null ? slp + '%'                   : null, slp  != null ? (slp >= 70 ? '#00ff99' : slp < 50 ? '#ff4d6d' : '#ffd35c') : null);
    jvset('jv-h-hrv',    hrv  != null ? Number(hrv).toFixed(1) + ' ms' : null);
    jvset('jv-h-strain', str  != null ? Number(str).toFixed(1)          : null);
    var modeColor = mode === 'ÓPTIMO' ? '#00ff99' : mode === 'DEFENSIVO' ? '#ff4d6d' : mode === 'NEUTRAL' ? '#ffd35c' : '#9fb3c8';
    jvcolor('jv-h-mode', mode, modeColor);
    var badge = document.getElementById('jv-mode-badge');
    if (badge) { badge.textContent = mode; badge.style.color = modeColor; }
    var jvBtn = document.getElementById('jv-btn');
    if (jvBtn) { jvBtn.style.borderColor = modeColor + '40'; jvBtn.style.color = modeColor + 'cc'; }

    // — Trading —
    var assets   = trading.assets || [];
    var totalMXN = trading.totalMXN || trading.totalValueMXN;
    var gainPct  = trading.gainPct  || trading.totalGainPct;
    jvset('jv-t-value', totalMXN != null ? '$' + Number(totalMXN).toLocaleString('es-MX', { maximumFractionDigits: 0 }) : null);
    if (gainPct != null) {
      jvcolor('jv-t-pnl', (gainPct >= 0 ? '+' : '') + Number(gainPct).toFixed(2) + '%', gainPct >= 0 ? '#00ff99' : '#ff4d6d');
    }
    if (assets.length > 0) {
      var sorted = assets.slice().sort(function(a, b){ return (b.gainPct || b.pctChange || 0) - (a.gainPct || a.pctChange || 0); });
      var winner = sorted[0]; var loser = sorted[sorted.length - 1];
      if (winner) jvcolor('jv-t-winner', winner.symbol + ' +' + Number(winner.gainPct || winner.pctChange || 0).toFixed(1) + '%', '#00ff99');
      if (loser)  jvcolor('jv-t-loser',  loser.symbol + ' ' + (Number(loser.gainPct || loser.pctChange || 0) >= 0 ? '+' : '') + Number(loser.gainPct || loser.pctChange || 0).toFixed(1) + '%', (loser.gainPct || 0) < 0 ? '#ff4d6d' : '#ffd35c');
      var total    = totalMXN || 1;
      var cryptoV  = assets.filter(function(a){ return a.type === 'crypto'; }).reduce(function(s, a){ return s + (a.valueMXN || 0); }, 0);
      var cryptoPct = (cryptoV / total * 100);
      jvcolor('jv-t-risk',
        cryptoPct > 40 ? 'Cripto ' + cryptoPct.toFixed(0) + '% — ALTO' : cryptoPct > 25 ? 'Cripto ' + cryptoPct.toFixed(0) + '% — MEDIO' : 'Diversificado',
        cryptoPct > 40 ? '#ff4d6d' : cryptoPct > 25 ? '#ffd35c' : '#00ff99');
    }

    // — Intelligence —
    var isum = intel.summary || {};
    jvset('jv-i-count', intel.count != null ? intel.count + ' artículos' : null);
    var moods = [];
    if (isum.positivo > 0) moods.push(isum.positivo + ' pos');
    if (isum.negativo > 0) moods.push(isum.negativo + ' neg');
    if (isum.neutral  > 0) moods.push(isum.neutral  + ' neu');
    jvset('jv-i-topics', moods.length ? moods.join(' · ') : (intel.count > 0 ? 'Sin clasificar' : 'Sin noticias'));
    jvcolor('jv-i-risks', isum.negativo > 0 ? isum.negativo + ' señales negativas' : 'Sin riesgos detectados', isum.negativo > 0 ? '#ff4d6d' : '#00ff99');

    // — Autopilot —
    var apL = ap.learning || {};
    var xp  = apL.totalXP != null ? apL.totalXP : (ap.count || 0) * 5;
    jvset('jv-a-xp',        xp + ' XP');
    jvset('jv-a-level',     'Nivel ' + (Math.floor(xp / 50) + 1));
    jvset('jv-a-decisions', ap.count != null ? ap.count + ' decisiones' : null);
    var latest = (ap.latest || [])[0];
    jvset('jv-a-last', latest ? (latest.action + ' · ' + (latest.symbol || '—')) : 'Sin decisiones');

    // — Daily Learning —
    var snap = daily.snapshot || {};
    var cap  = snap.tradingCapacity || null;
    var risk = snap.riskRecommendation || null;
    var ci   = snap.checkin || {};
    var capColor  = cap === 'ALTA' ? '#00ff99' : cap === 'MEDIA' ? '#ffd35c' : cap === 'BAJA' ? '#ff4d6d' : '#9fb3c8';
    var riskColor = risk === 'NORMAL_PLUS' ? '#00ff99' : risk === 'REDUCIR_RIESGO' ? '#ff4d6d' : '#9fb3c8';
    jvcolor('jv-d-capacity', cap || '—', capColor);
    jvcolor('jv-d-risk',     risk || '—', riskColor);
    jvset('jv-d-focus', ci.focus != null ? ci.focus + '/10' : null);
    jvcolor('jv-d-status', ci.updatedAt ? '✓ Check-in hoy' : 'Sin check-in hoy', ci.updatedAt ? '#00ff99' : '#ffd35c');

    jarvisUpdateThought({ health: health, trading: trading, intel: intel, autopilot: ap, daily: snap });
  } catch(e) {
    console.warn('loadJarvisData error', e);
  }
}

function jarvisUpdateThought(data) {
  var thoughts = [];
  var h  = data.health   || {};
  var t  = data.trading  || {};
  var i  = data.intel    || {};
  var ap = data.autopilot || {};
  var rec  = Number(h.recovery || 0);
  var slp  = Number(h.sleep    || 0);
  var mode = h.mode || h.operatingMode || '';
  var assets = t.assets || [];
  var gainPct = t.gainPct || t.totalGainPct;

  if (rec > 0 && rec < 50)  thoughts.push('Recuperación baja (' + rec + '%). Considera reducir exposición a riesgo hoy.');
  if (rec >= 80)             thoughts.push('Recuperación óptima (' + rec + '%). Sistema en capacidad máxima de análisis.');
  if (slp > 0 && slp < 60)  thoughts.push('Calidad de sueño reducida (' + slp + '%). La toma de decisiones puede verse afectada.');
  if (mode === 'ÓPTIMO')    thoughts.push('Modo ÓPTIMO activo. Condiciones ideales para análisis profundo.');
  if (mode === 'DEFENSIVO') thoughts.push('Modo DEFENSIVO. Sistema recomienda cautela en todas las operaciones.');

  if (assets.length > 0) {
    var sorted = assets.slice().sort(function(a, b){ return (b.gainPct || 0) - (a.gainPct || 0); });
    if (sorted[0] && sorted[0].symbol) thoughts.push(sorted[0].symbol + ' está mostrando el mejor desempeño relativo en portafolio.');
    var total    = t.totalMXN || t.totalValueMXN || 1;
    var cryptoPct = assets.filter(function(a){ return a.type === 'crypto'; }).reduce(function(s, a){ return s + (a.valueMXN || 0); }, 0) / total * 100;
    if (cryptoPct > 40) thoughts.push('Concentración en cripto al ' + cryptoPct.toFixed(0) + '%. Riesgo elevado de volatilidad.');
  }
  if (gainPct != null && gainPct > 20) thoughts.push('Portafolio con ganancia del ' + Number(gainPct).toFixed(1) + '%. Posición sólida.');
  if (gainPct != null && gainPct < -5) thoughts.push('Portafolio en zona negativa (' + Number(gainPct).toFixed(1) + '%). Revisar exposición.');

  var neg = (i.summary || {}).negativo || 0;
  if (neg >= 3) thoughts.push(neg + ' señales negativas en Intelligence. Revisar radar de noticias.');

  if (!(ap.latest && ap.latest.length)) thoughts.push('Autopilot sin decisiones registradas. Documenta tu proceso de trading.');

  // Memory-based thoughts from daily learning + patterns (server-side data via daily snapshot)
  var dl = data.daily || {};
  var dlCap = dl.tradingCapacity || null;
  var dlRisk = dl.riskRecommendation || null;
  if (dlCap === 'BAJA')  thoughts.push('Capacidad de trading BAJA hoy según datos fisiológicos. Considera reducir exposición.');
  if (dlCap === 'ALTA')  thoughts.push('Capacidad de trading ALTA. Condiciones óptimas para análisis y decisiones.');
  if (dlRisk === 'REDUCIR_RIESGO') thoughts.push('Memoria: recomendación de riesgo reducido activa. Evitar nuevas posiciones arriesgadas.');

  if (!thoughts.length) thoughts.push('Sistema operativo. Sin alertas activas. Monitoreo continuo en curso.');

  var el = document.getElementById('jv-thought');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(function() {
    el.textContent = thoughts[Math.floor(Math.random() * thoughts.length)];
    el.style.opacity = '1';
  }, 200);
}
// ---- Daily Learning Engine ----
var _dlBoolState = {};

function dlToggleBool(id, val) {
  _dlBoolState[id] = val;
  var yesBtn = document.getElementById(id + '-yes');
  var noBtn  = document.getElementById(id + '-no');
  if (!yesBtn || !noBtn) return;
  if (val) {
    yesBtn.style.background = 'rgba(0,255,153,.15)'; yesBtn.style.borderColor = 'rgba(0,255,153,.55)'; yesBtn.style.color = '#00ff99'; yesBtn.style.fontWeight = '900';
    noBtn.style.background  = 'rgba(255,77,109,.04)'; noBtn.style.borderColor  = 'rgba(255,77,109,.18)'; noBtn.style.color  = '#5a7a94'; noBtn.style.fontWeight = '600';
  } else {
    noBtn.style.background  = 'rgba(255,77,109,.12)'; noBtn.style.borderColor  = 'rgba(255,77,109,.55)'; noBtn.style.color  = '#ff4d6d'; noBtn.style.fontWeight = '900';
    yesBtn.style.background = 'rgba(0,255,153,.04)'; yesBtn.style.borderColor = 'rgba(0,255,153,.18)'; yesBtn.style.color = '#5a7a94'; yesBtn.style.fontWeight = '600';
  }
}

async function saveDailyCheckin() {
  var btn = document.getElementById('dle-save-btn');
  var st  = document.getElementById('dle-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  function gv(id) { var el = document.getElementById(id); return el ? el.value : null; }
  var payload = {
    mood:           Number(gv('dle-mood')   || 5),
    stress:         Number(gv('dle-stress') || 5),
    focus:          Number(gv('dle-focus')  || 5),
    energy:         Number(gv('dle-energy') || 5),
    notes:          gv('dle-notes')         || '',
    tradingMistakes:gv('dle-mistakes')      || '',
    tradingWins:    gv('dle-wins')          || '',
    marketFeeling:  gv('dle-feeling')       || '',
    cannabis: _dlBoolState['dle-cannabis'] !== undefined ? _dlBoolState['dle-cannabis'] : false,
    sauna:    _dlBoolState['dle-sauna']    !== undefined ? _dlBoolState['dle-sauna']    : false,
    workout:  _dlBoolState['dle-workout']  !== undefined ? _dlBoolState['dle-workout']  : false,
    alcohol:  _dlBoolState['dle-alcohol']  !== undefined ? _dlBoolState['dle-alcohol']  : false,
    caffeine: _dlBoolState['dle-caffeine'] !== undefined ? _dlBoolState['dle-caffeine'] : false
  };
  try {
    var r = await fetch('/api/daily/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    var d = await r.json();
    if (st) { st.textContent = d.ok ? '✓ Día guardado' : 'Error: ' + (d.error || '?'); st.style.color = d.ok ? '#00ff99' : '#ff4d6d'; }
  } catch(e) {
    if (st) { st.textContent = 'Error de red'; st.style.color = '#ff4d6d'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar día'; }
  }
}

async function generateDailyLearning() {
  var btn = document.getElementById('dle-gen-btn');
  var st  = document.getElementById('dle-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Generando...'; }
  try {
    var r = await fetch('/api/daily/snapshot', { method: 'POST' });
    var d = await r.json();
    if (st) { st.textContent = d.ok ? '✓ Aprendizaje generado' : 'Error: ' + (d.error || '?'); st.style.color = d.ok ? '#818cf8' : '#ff4d6d'; }
    if (d.ok) setTimeout(function() { window.location.reload(); }, 1200);
  } catch(e) {
    if (st) { st.textContent = 'Error de red'; st.style.color = '#ff4d6d'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generar aprendizaje'; }
  }
}

async function loadDailyLearning() {
  try {
    var r = await fetch('/api/daily/today', { cache: 'no-store' });
    if (!r.ok) return;
    var d = await r.json();
    var snap = d.snapshot || {};
    function jvdset(id, val, col) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = (val == null || val === '') ? '—' : String(val);
      if (col) el.style.color = col;
    }
    var cap = snap.tradingCapacity || '—';
    var capColor = cap === 'ALTA' ? '#00ff99' : cap === 'MEDIA' ? '#ffd35c' : cap === 'BAJA' ? '#ff4d6d' : '#9fb3c8';
    jvdset('jv-d-capacity', cap, capColor);
    var risk = snap.riskRecommendation || '—';
    var riskColor = risk === 'NORMAL_PLUS' ? '#00ff99' : risk === 'NORMAL' ? '#9fb3c8' : '#ff4d6d';
    jvdset('jv-d-risk', risk, riskColor);
    var ci = snap.checkin || {};
    jvdset('jv-d-focus', ci.focus != null ? ci.focus + '/10' : (snap.healthReadiness ? snap.healthReadiness.sleep + '% sueño' : '—'));
    var hasCheckin = ci.updatedAt ? '✓ Check-in hoy' : 'Sin check-in';
    jvdset('jv-d-status', hasCheckin, ci.updatedAt ? '#00ff99' : '#ffd35c');
  } catch(e) {}
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
        + String(d.reply || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').split(String.fromCharCode(10)).join('<br>').replace(/\*\*(.*?)\*\*/g,'<b>$1</b>')
        + '</div></div>';
    } else {
      result.innerHTML = '<div style="color:#ff4d6d;font-size:13px;padding:8px 0">Error: ' + (d.error||'desconocido') + '</div>';
    }
  } catch(e) {
    result.innerHTML = '<div style="color:#ff4d6d;font-size:13px;padding:8px 0">Error de conexión.</div>';
  }
}

// ---- Autopilot Decision Log ----
var _dlDecisions = [];

async function loadAutopilotDecisions() {
  try {
    var r = await fetch('/api/autopilot/decisions', { cache: 'no-store' });
    if (!r.ok) return;
    var d = await r.json();
    _dlDecisions = d.latest || [];
    renderAutopilotLearning(d);
  } catch(e) {
    console.warn('loadAutopilotDecisions failed', e);
  }
}

function renderAutopilotLearning(d) {
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v == null ? '—' : String(v); }

  var learning = d.learning || {};
  var latest = (d.latest || [])[0] || null;
  var top = (learning.mostWatchedTickers || [])[0];

  set('dl-total', d.count || 0);
  set('dl-pending', (d.pending || []).length);
  set('dl-ticker', top ? top.symbol : '—');
  set('dl-last-action', latest ? latest.action : '—');
  set('dl-last-sym', latest ? (latest.symbol + ' · ' + new Date(latest.timestamp).toLocaleDateString('es-MX')) : '—');

  var sumEl = document.getElementById('dl-summary');
  if (sumEl) sumEl.textContent = learning.learningSummary || 'Sin datos de aprendizaje todavía.';

  var listEl = document.getElementById('dl-list');
  if (!listEl) return;
  if (!d.latest || !d.latest.length) {
    listEl.innerHTML = '<div style="color:#9fb3c8;font-size:12px;padding:10px">No hay decisiones registradas aún. Usa el botón para guardar.</div>';
    return;
  }

  var actionColors = { WATCH: '#ffd35c', BUY_DIP: '#00ff99', REDUCE: '#ff4d6d', HOLD: '#818cf8', NO_ACTION: '#9fb3c8', INVESTIGATE: '#3b9dff' };
  var outcomeColors = { PENDING: '#ffd35c', WIN: '#00ff99', LOSS: '#ff4d6d', NEUTRAL: '#9fb3c8', NO_ACTION: '#818cf8', WATCH: '#3b9dff' };

  listEl.innerHTML = d.latest.map(function(dec) {
    var ac = actionColors[dec.action] || '#9fb3c8';
    var oc = outcomeColors[dec.outcomeStatus] || '#9fb3c8';
    var dateStr = dec.timestamp ? new Date(dec.timestamp).toLocaleDateString('es-MX', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(120,160,210,.1);flex-wrap:wrap">'
      + '<span style="font-size:11px;font-weight:900;color:' + ac + ';min-width:90px">' + (dec.action || '—') + '</span>'
      + '<span style="font-size:13px;font-weight:700;color:#eaf6ff;min-width:60px">' + (dec.symbol || '—') + '</span>'
      + '<span style="flex:1;font-size:11px;color:#9fb3c8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (dec.reason || '') + '">' + ((dec.reason || '').slice(0, 60) || '—') + '</span>'
      + '<span style="font-size:10px;padding:2px 8px;border-radius:99px;background:' + oc + '22;color:' + oc + ';white-space:nowrap">' + (dec.outcomeStatus || 'PENDING') + '</span>'
      + '<span style="font-size:10px;color:#64748b;white-space:nowrap">' + dateStr + '</span>'
      + (dec.outcomeStatus === 'PENDING' && dec.id
        ? '<button onclick="markDecisionOutcome(\'' + dec.id + '\',\'WIN\')" style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid rgba(0,255,153,.3);background:rgba(0,255,153,.08);color:#00ff99;cursor:pointer">WIN</button>'
          + '<button onclick="markDecisionOutcome(\'' + dec.id + '\',\'LOSS\')" style="font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid rgba(255,77,109,.3);background:rgba(255,77,109,.08);color:#ff4d6d;cursor:pointer">LOSS</button>'
        : '')
      + '</div>';
  }).join('');
}

function openDecisionModal() {
  var m = document.getElementById('dl-modal');
  if (m) { m.style.display = 'flex'; }
}

async function submitDecisionModal() {
  var sym = (document.getElementById('dl-inp-symbol') || {}).value || '';
  var action = (document.getElementById('dl-inp-action') || {}).value || 'WATCH';
  var conviction = (document.getElementById('dl-inp-conviction') || {}).value || '5';
  var reason = (document.getElementById('dl-inp-reason') || {}).value || '';
  if (!sym) { alert('Ingresa un ticker'); return; }
  try {
    var r = await fetch('/api/autopilot/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, action: action, conviction: parseInt(conviction), reason: reason, source: 'manual' })
    });
    var d = await r.json();
    if (d.ok) {
      var m = document.getElementById('dl-modal');
      if (m) m.style.display = 'none';
      var si = document.getElementById('dl-inp-symbol'); if (si) si.value = '';
      var ri = document.getElementById('dl-inp-reason'); if (ri) ri.value = '';
      await loadAutopilotDecisions();
    } else {
      alert('Error: ' + (d.error || 'desconocido'));
    }
  } catch(e) {
    alert('Error de conexión al guardar decisión.');
  }
}

async function markLatestDecision(outcome) {
  var dec = _dlDecisions[0];
  if (!dec || !dec.id) { alert('No hay decisión reciente para marcar.'); return; }
  await markDecisionOutcome(dec.id, outcome);
}

async function markDecisionOutcome(decisionId, outcome) {
  try {
    var r = await fetch('/api/autopilot/decision/outcome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionId: decisionId, outcome: outcome })
    });
    var d = await r.json();
    if (d.ok) await loadAutopilotDecisions();
    else alert('Error al marcar: ' + (d.error || 'desconocido'));
  } catch(e) {
    alert('Error de conexión al marcar resultado.');
  }
}

async function saveAutopilotDecisionFromScan() {
  var btn = document.getElementById('scan-save-btn');
  if (btn) btn.textContent = 'Guardando...';
  try {
    var r = await fetch('/api/autopilot/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'PORTFOLIO', action: 'WATCH', conviction: 5, reason: 'Scan diario guardado en memoria Autopilot.', source: 'daily_scan' })
    });
    var d = await r.json();
    if (btn) btn.textContent = d.ok ? 'Guardado ✅' : 'Error ✗';
    setTimeout(function() { if (btn) btn.textContent = 'Guardar en Autopilot Memory'; }, 1500);
    if (d.ok) await loadAutopilotDecisions();
  } catch(e) {
    if (btn) btn.textContent = 'Error ✗';
    setTimeout(function() { if (btn) btn.textContent = 'Guardar en Autopilot Memory'; }, 1500);
  }
}

// ---- Live clock ----
(function() {
  function tickClock() {
    var el = document.getElementById('home-live-clock');
    if (!el) return;
    var now = new Date();
    var hh = now.getHours().toString().padStart(2, '0');
    var mm = now.getMinutes().toString().padStart(2, '0');
    var ss = now.getSeconds().toString().padStart(2, '0');
    el.textContent = hh + ':' + mm + ':' + ss;
  }
  setInterval(tickClock, 1000);
  tickClock();
})();

document.addEventListener('DOMContentLoaded', function() {
  var saved = '';
  try { saved = localStorage.getItem('corde_mod') || ''; } catch(e) {}
  var hashMod = (window.location.hash || '').replace('#', '');
  showMod(hashMod || saved || 'home');
  // Live-update Health Readiness panel from /api/whoop/today
  (function whoopHealthLive() {
    function set(id, val) { var el = document.getElementById(id); if (el && val != null) el.textContent = val; }
    function fmt1(n) { return n != null ? (typeof n === 'number' ? n.toFixed(1) : n) : null; }
    function poll() {
      fetch('/api/whoop/today').then(function(r){return r.json();}).then(function(d){
        set('hr-recovery',  d.recovery     != null ? d.recovery + '%'              : '—');
        set('hr-sleep',     d.sleep        != null ? d.sleep + '%'                 : '—');
        set('hr-strain',    d.strain       != null ? fmt1(d.strain)                : '—');
        set('hr-avghr',     d.averageHeartRate != null ? d.averageHeartRate + ' bpm' : '—');
        set('hr-maxhr',     d.maxHeartRate != null ? d.maxHeartRate + ' bpm'       : '—');
        set('hr-hrv',       d.hrv          != null ? fmt1(d.hrv) + ' ms'           : '—');
        set('hr-rhr',       d.restingHeartRate != null ? d.restingHeartRate + ' bpm' : '—');
        set('hr-kj',        d.kilojoule    != null ? Math.round(d.kilojoule) + ' kJ' : '—');
        set('hr-state',     d.scoreState   || '—');
        set('hr-mode',      d.mode         || d.operatingMode || 'NORMAL');
        set('hr-mode-footer', d.mode       || d.operatingMode || 'NORMAL');
        set('hr-suggestion',  d.suggestion || '');
        if (d.alfredoAdvice) set('hr-advice', d.alfredoAdvice);
        var badge = document.getElementById('hr-badge');
        if (badge) {
          badge.textContent = d.connected ? '● WHOOP LIVE' : (d.configured !== false ? 'WHOOP DETECTADO' : 'SIN DATOS');
          badge.style.color = d.connected ? '#00ff99' : '#ffd35c';
          badge.style.background = d.connected ? 'rgba(0,255,153,.15)' : 'rgba(255,211,92,.12)';
        }
      }).catch(function(){});
    }
    poll();
    setInterval(poll, 60000);
  })();
});

// ---- Portfolio Runtime Editor ----
var _portEditSym = '';

function openPortfolioEdit(symbol) {
  _portEditSym = symbol;
  fetch('/api/portfolio/editable').then(function(r){ return r.json(); }).then(function(d) {
    var asset = (d.assets || []).find(function(a){ return a.symbol === symbol; });
    if (!asset) return;
    document.getElementById('pe-sym-label').textContent = asset.symbol + (asset.name ? ' — ' + asset.name : '');
    document.getElementById('pe-units').value    = asset.units        || 0;
    document.getElementById('pe-value').value    = asset.valueManual  || 0;
    document.getElementById('pe-cost').value     = asset.costManual   || 0;
    document.getElementById('pe-currency').value = asset.currency     || 'MXN';
    document.getElementById('port-edit-modal').style.display = 'flex';
  }).catch(function(e){ console.warn('openPortfolioEdit fetch error', e); });
}

async function submitPortfolioEdit() {
  if (!_portEditSym) return;
  var btn = document.querySelector('#port-edit-modal button[onclick="submitPortfolioEdit()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    var r = await fetch('/api/portfolio/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol:       _portEditSym,
        qty:          parseFloat(document.getElementById('pe-units').value)  || 0,
        costBasis:    parseFloat(document.getElementById('pe-cost').value)   || 0,
        valueManual:  parseFloat(document.getElementById('pe-value').value)  || 0,
        currency:     document.getElementById('pe-currency').value || 'MXN'
      })
    });
    var d = await r.json();
    if (d.ok) {
      document.getElementById('port-edit-modal').style.display = 'none';
      window.location.reload();
    } else {
      alert('Error: ' + (d.error || 'desconocido'));
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
  } catch(e) {
    alert('Error de conexión');
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
  }
}

function openPortfolioAdd() {
  ['pa-sym','pa-name','pa-units','pa-value','pa-cost'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.value = '';
  });
  var src = document.getElementById('pa-source'); if (src) src.value = 'Manual';
  var typ = document.getElementById('pa-type');   if (typ) typ.value = 'stock';
  var cur = document.getElementById('pa-currency');if(cur) cur.value = 'MXN';
  document.getElementById('port-add-modal').style.display = 'flex';
}

async function submitPortfolioAdd() {
  var sym = (document.getElementById('pa-sym').value || '').toUpperCase().trim();
  if (!sym) { alert('Símbolo requerido'); return; }
  var btn = document.querySelector('#port-add-modal button[onclick="submitPortfolioAdd()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Agregando...'; }
  try {
    var r = await fetch('/api/portfolio/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol:      sym,
        name:        document.getElementById('pa-name').value     || sym,
        qty:         parseFloat(document.getElementById('pa-units').value)  || 0,
        costBasis:   parseFloat(document.getElementById('pa-cost').value)   || 0,
        valueManual: parseFloat(document.getElementById('pa-value').value)  || 0,
        currency:    document.getElementById('pa-currency').value || 'MXN',
        source:      document.getElementById('pa-source').value   || 'Manual',
        type:        document.getElementById('pa-type').value     || 'stock'
      })
    });
    var d = await r.json();
    if (d.ok) {
      document.getElementById('port-add-modal').style.display = 'none';
      window.location.reload();
    } else {
      alert('Error: ' + (d.error || 'desconocido'));
      if (btn) { btn.disabled = false; btn.textContent = 'Agregar'; }
    }
  } catch(e) {
    alert('Error de conexión');
    if (btn) { btn.disabled = false; btn.textContent = 'Agregar'; }
  }
}

async function removePortfolioAsset(symbol) {
  if (!confirm('¿Eliminar ' + symbol + ' del portafolio?\n\nEsta acción persiste en disco. Se puede re-agregar con "+ Agregar activo". No es asesoría financiera.')) return;
  try {
    var r = await fetch('/api/portfolio/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: symbol })
    });
    var d = await r.json();
    if (d.ok) { window.location.reload(); }
    else { alert('Error al eliminar: ' + (d.error || 'desconocido')); }
  } catch(e) { alert('Error de conexión'); }
}

// ---- Cordelius Alerts (client) ----
async function runAlertCheck() {
  var btn = document.getElementById('alert-check-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Evaluando...'; }
  try {
    var r = await fetch('/api/alerts/check', { method: 'POST' });
    if (r.ok) {
      var d = await r.json();
      if (d.newCount > 0) {
        window.location.reload();
      } else {
        if (btn) {
          btn.disabled = false; btn.textContent = 'Sin alertas nuevas';
          setTimeout(function() { btn.textContent = 'Evaluar ahora'; }, 3000);
        }
      }
    }
  } catch(e) {
    if (btn) {
      btn.disabled = false; btn.textContent = 'Error — reintentar';
      setTimeout(function() { btn.textContent = 'Evaluar ahora'; }, 3000);
    }
  }
}

async function ackAlert(alertId) {
  try {
    var r = await fetch('/api/alerts/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: alertId })
    });
    if (r.ok) {
      // Find and fade the row
      var allBtns = document.querySelectorAll('[onclick]');
      for (var i = 0; i < allBtns.length; i++) {
        var attr = allBtns[i].getAttribute('onclick') || '';
        if (attr.indexOf(alertId) !== -1) {
          var row = allBtns[i].closest('div[style*="margin-bottom:6px"]');
          if (row) { row.style.opacity = '0.4'; row.style.transition = 'opacity .3s'; }
          allBtns[i].textContent = '✓ Revisado';
          allBtns[i].disabled = true;
          break;
        }
      }
    }
  } catch(e) {}
}
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

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (req.method === "POST" && path === "/ask") return handleAsk(req, res);
  if (req.method === "POST" && path === "/intel") return handleIntel(req, res);
  if (req.method === "POST" && path === "/intel/delete") return handleIntelDelete(req, res);
  if (req.method === "POST" && path === "/intel/clear") return handleIntelClear(req, res);
  if (req.method === "POST" && path === "/api/journal") return handleJournal(req, res);
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
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()) }));
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

  if (path === "/api/autopilot/decisions" && req.method === "GET") {
    try {
      const decisions = readJSONSafe(TRADING_DECISIONS_FILE, []);
      const decisionLog = decisions.filter(d => d && d.id);
      const learning = computeAutopilotLearning();
      return sendAutopilotJSON(res, {
        ok: true,
        count: decisionLog.length,
        latest: decisionLog.slice(0, 20),
        pending: decisionLog.filter(d => d.outcomeStatus === "PENDING"),
        actionStats: learning.actionStats,
        learningSummary: learning.learningSummary,
        learning
      });
    } catch (e) {
      return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  if (path === "/api/autopilot/decision" && req.method === "POST") {
    try {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const input = body ? JSON.parse(body) : {};
          if (!input.action) return sendAutopilotJSON(res, { ok: false, error: "action requerido" }, 400);

          const now = new Date().toISOString();
          const id = "dec_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);

          let healthSnap = null;
          try { healthSnap = typeof computeHealthReadiness === "function" ? computeHealthReadiness() : null; } catch(e) {}

          let pv = null;
          try { pv = portfolioValue(); } catch(e) {}

          let scan = null;
          try { scan = computeDailyScan(); } catch(e) {}

          let regime = null;
          try { regime = marketRegime ? marketRegime() : null; } catch(e) {}

          const intel = readJSONSafe(AUTOPILOT_PATH.join(__dirname, "cordelius_intel.json"), []);

          const decision = {
            id,
            timestamp: now,
            source: input.source || "manual",
            symbol: (input.symbol || "—").toUpperCase(),
            action: (input.action || "WATCH").toUpperCase(),
            conviction: Math.max(1, Math.min(10, parseInt(input.conviction) || 5)),
            reason: (input.reason || "").slice(0, 500),
            educationalNote: (input.educationalNote || "No es consejo financiero.").slice(0, 300),
            portfolioSummary: pv ? { totalMXN: pv.totalValueMXN, gainPct: pv.totalGainPct } : null,
            dailyScan: scan ? { riskLevel: scan.riskAlerts && scan.riskAlerts.some(a => a.level === "CRITICO") ? "CRITICO" : "NORMAL", regime: scan.portfolioSummary ? scan.portfolioSummary.regime : null } : null,
            intel: { count: Array.isArray(intel) ? intel.length : 0 },
            health: healthSnap ? { recovery: healthSnap.recovery, sleep: healthSnap.sleep, hrv: healthSnap.hrv, operatingMode: healthSnap.operatingMode } : null,
            regime: regime ? { label: regime.label } : null,
            xpAwarded: 5,
            outcomeStatus: "PENDING"
          };

          const decisions = readJSONSafe(TRADING_DECISIONS_FILE, []);
          const next = appendSnapshot(decisions, decision, 300, TRADING_DECISIONS_FILE);

          // Update autopilot memory summary
          const memory = readJSONSafe(AUTOPILOT_MEMORY_FILE, { createdAt: now, updatedAt: now, notes: [], lastDecision: null });
          memory.updatedAt = now;
          memory.lastDecision = { id, symbol: decision.symbol, action: decision.action, timestamp: now };
          if (!Array.isArray(memory.notes)) memory.notes = [];
          writeJSONAtomic(AUTOPILOT_MEMORY_FILE, memory);

          // Award XP
          const progress = readJSONSafe(CORDELIUS_PROGRESS_FILE, { level: 1, xp: 0, streak: 0, snapshots: 0, lastSnapshotAt: null, updatedAt: now });
          const nextXp = (progress.xp || 0) + 5;
          writeJSONAtomic(CORDELIUS_PROGRESS_FILE, { ...progress, xp: nextXp, level: Math.max(1, Math.floor(nextXp / 100) + 1), updatedAt: now });

          return sendAutopilotJSON(res, { ok: true, decision, totalDecisions: next.filter(d => d && d.id).length, xpAwarded: 5 });
        } catch(e) {
          return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
        }
      });
    } catch (e) {
      return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  if (path === "/api/autopilot/decision/outcome" && req.method === "POST") {
    try {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const input = body ? JSON.parse(body) : {};
          if (!input.decisionId) return sendAutopilotJSON(res, { ok: false, error: "decisionId requerido" }, 400);
          if (!input.outcome) return sendAutopilotJSON(res, { ok: false, error: "outcome requerido (WIN/LOSS/NEUTRAL/NO_ACTION)" }, 400);

          const now = new Date().toISOString();
          const validOutcomes = ["WIN", "LOSS", "NEUTRAL", "NO_ACTION", "WATCH"];
          const outcome = validOutcomes.includes((input.outcome || "").toUpperCase()) ? input.outcome.toUpperCase() : "NEUTRAL";

          const outcomeEntry = {
            id: "out_" + Date.now(),
            decisionId: input.decisionId,
            outcome,
            notes: (input.notes || "").slice(0, 500),
            result: input.result != null ? parseFloat(input.result) : null,
            timestamp: now
          };

          const outcomes = readJSONSafe(DECISION_OUTCOMES_FILE, []);
          const nextOutcomes = appendSnapshot(outcomes, outcomeEntry, 300, DECISION_OUTCOMES_FILE);

          // Mark original decision
          const decisions = readJSONSafe(TRADING_DECISIONS_FILE, []);
          const updatedDecisions = decisions.map(d => {
            if (d && d.id === input.decisionId) return { ...d, outcomeStatus: outcome, outcomeAt: now };
            return d;
          });
          writeJSONAtomic(TRADING_DECISIONS_FILE, updatedDecisions);

          // Bonus XP for reviewing
          const progress = readJSONSafe(CORDELIUS_PROGRESS_FILE, { level: 1, xp: 0, streak: 0, snapshots: 0, lastSnapshotAt: null, updatedAt: now });
          const xpBonus = outcome === "WIN" ? 15 : outcome === "LOSS" ? 10 : 8;
          const nextXp = (progress.xp || 0) + xpBonus;
          writeJSONAtomic(CORDELIUS_PROGRESS_FILE, { ...progress, xp: nextXp, level: Math.max(1, Math.floor(nextXp / 100) + 1), updatedAt: now });

          const learning = computeAutopilotLearning();
          return sendAutopilotJSON(res, { ok: true, outcomeEntry, xpAwarded: xpBonus, totalOutcomes: nextOutcomes.length, learning });
        } catch(e) {
          return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
        }
      });
    } catch (e) {
      return sendAutopilotJSON(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

if (path === "/api/whoop/today") {
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

  // ---- Daily Learning API ----
  if (path === "/api/daily/today" && req.method === "GET") {
    try {
      const snap = computeDailyLearningSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, snapshot: snap }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (path === "/api/daily/checkin" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const input = body ? JSON.parse(body) : {};
        const dateKey = todayDateKey();
        const checkins = readJSONSafe(USER_CHECKINS_FILE, {});
        const existing = checkins[dateKey] || {};
        const allowedBools = ["cannabis", "sauna", "workout", "alcohol", "caffeine"];
        const allowedNums  = ["mood", "stress", "focus", "energy"];
        const allowedStrs  = ["notes", "tradingMistakes", "tradingWins", "marketFeeling"];
        const merged = { ...existing };
        allowedBools.forEach(k => { if (input[k] !== undefined) merged[k] = !!input[k]; });
        allowedNums.forEach(k  => { if (input[k] !== undefined) { const v = Number(input[k]); if (!isNaN(v)) merged[k] = Math.max(1, Math.min(10, v)); } });
        allowedStrs.forEach(k  => { if (input[k] !== undefined) merged[k] = String(input[k]).slice(0, 1000); });
        merged.updatedAt = new Date().toISOString();
        checkins[dateKey] = merged;
        const keys = Object.keys(checkins).sort();
        if (keys.length > 365) keys.slice(0, keys.length - 365).forEach(k => delete checkins[k]);
        writeJSONAtomic(USER_CHECKINS_FILE, checkins);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, dateKey, checkin: merged }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (path === "/api/daily/snapshot" && req.method === "POST") {
    try {
      const snap = computeDailyLearningSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, snapshot: snap }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (path === "/api/daily/learning" && req.method === "GET") {
    try {
      const patterns = computeCordeliusPatterns();
      const history  = readJSONSafe(DAILY_LEARNING_FILE, {});
      const keys     = Object.keys(history).sort();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, recordCount: keys.length, patterns, latest: keys.length ? history[keys[keys.length - 1]] : null }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ---- Jarvis Memory Endpoints ----
  if (path === "/api/jarvis/context" && req.method === "GET") {
    try {
      const ctx = buildJarvisContext();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, context: ctx }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (path === "/api/jarvis/memory" && req.method === "GET") {
    try {
      const summary = buildMemorySummary();
      const ctx     = buildJarvisContext();
      const tokenEstimate = Math.ceil(summary.length / 4);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        memorySummary: summary,
        tokenEstimate,
        sources: {
          health:          ctx.health && !ctx.health.error,
          portfolio:       ctx.portfolio && !ctx.portfolio.error,
          dailyLearning:   (ctx.dailyLearning || []).length,
          recentDecisions: (ctx.recentDecisions || []).length,
          patterns:        (ctx.patterns || {}).available || false,
          autopilotLevel:  (ctx.autopilot || {}).level || 1
        }
      }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ---- Runtime Portfolio Editor API ----
  if (path === "/api/portfolio/editable" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, count: PORTFOLIO.length, assets: PORTFOLIO.map(a => ({ ...a })) }));
  }

  if (path === "/api/portfolio/update" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const input = body ? JSON.parse(body) : {};
        if (!input.symbol) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "symbol requerido" })); }
        const sym = String(input.symbol).toUpperCase();
        const idx = PORTFOLIO.findIndex(a => a.symbol === sym);
        if (idx < 0) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Activo no encontrado: " + sym })); }
        if (input.qty        != null) PORTFOLIO[idx].units        = Number(input.qty)        || PORTFOLIO[idx].units;
        if (input.costBasis  != null) PORTFOLIO[idx].costManual   = Number(input.costBasis)  || PORTFOLIO[idx].costManual;
        if (input.valueManual!= null) PORTFOLIO[idx].valueManual  = Number(input.valueManual)|| PORTFOLIO[idx].valueManual;
        if (input.currency)           PORTFOLIO[idx].currency     = ["MXN","USD"].includes(input.currency) ? input.currency : PORTFOLIO[idx].currency;
        savePortfolioStore();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, symbol: sym, updated: { ...PORTFOLIO[idx] } }));
      } catch(e) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  if (path === "/api/portfolio/add" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const input = body ? JSON.parse(body) : {};
        if (!input.symbol) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "symbol requerido" })); }
        const sym = String(input.symbol).toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 10);
        if (!sym) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "symbol inválido" })); }
        if (PORTFOLIO.some(a => a.symbol === sym)) { res.writeHead(409, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Activo ya existe: " + sym + ". Usa /api/portfolio/update para modificar." })); }
        const newAsset = {
          source:       String(input.source       || "Manual").slice(0, 20),
          category:     String(input.category     || "Manual").slice(0, 30),
          symbol:       sym,
          display:      String(input.display      || sym).slice(0, 15),
          name:         String(input.name         || sym).slice(0, 60),
          units:        Number(input.qty)         || 0,
          currency:     ["MXN","USD"].includes(input.currency) ? input.currency : "MXN",
          valueManual:  Number(input.valueManual) || 0,
          costManual:   Number(input.costBasis)   || 0,
          brokerGainPct:0,
          logo:         String(input.logo || sym.slice(0, 2)).slice(0, 4).toUpperCase(),
          color:        /^#[0-9a-fA-F]{3,6}$/.test(input.color || "") ? input.color : "#334155",
          liveTicker:   String(input.liveTicker || sym).slice(0, 20),
          type:         ["stock","stock_mx","crypto","etf"].includes(input.type) ? input.type : "stock"
        };
        PORTFOLIO.push(newAsset);
        savePortfolioStore();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, symbol: sym, asset: newAsset, totalAssets: PORTFOLIO.length }));
      } catch(e) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  if (path === "/api/portfolio/remove" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const input = body ? JSON.parse(body) : {};
        if (!input.symbol) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "symbol requerido" })); }
        const sym = String(input.symbol).toUpperCase();
        const idx = PORTFOLIO.findIndex(a => a.symbol === sym);
        if (idx < 0) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Activo no encontrado: " + sym })); }
        const removed = PORTFOLIO.splice(idx, 1)[0];
        savePortfolioStore();
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, removed: removed.symbol, totalAssets: PORTFOLIO.length }));
      } catch(e) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // ---- Cordelius Alerts API ----
  if (path === "/api/alerts" && req.method === "GET") {
    try {
      const allAlerts = readJSONSafe(CORDELIUS_ALERTS_FILE, []);
      const unread    = allAlerts.filter(a => a && !a.acknowledged).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, count: allAlerts.length, unread, alerts: allAlerts.slice(0, 50) }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (path === "/api/alerts/check" && req.method === "POST") {
    try {
      const result = checkAlerts();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, newCount: result.newCount || 0, error: result.error || null }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (path === "/api/alerts/ack" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const input = body ? JSON.parse(body) : {};
        if (!input.id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "id requerido" }));
        }
        const alerts  = readJSONSafe(CORDELIUS_ALERTS_FILE, []);
        let   found   = false;
        const updated = alerts.map(a => {
          if (a && a.id === input.id) { found = true; return { ...a, acknowledged: true, acknowledgedAt: new Date().toISOString() }; }
          return a;
        });
        if (found) writeJSONAtomic(CORDELIUS_ALERTS_FILE, updated);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, found }));
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ---- Autonomous Daily Intelligence API ----
  if (path === "/api/intelligence/today" && req.method === "GET") {
    try {
      const summaries = readJSONSafe(DAILY_INTELLIGENCE_FILE, []);
      const today     = todayDateKey();
      const entry     = (Array.isArray(summaries) ? summaries.find(s => s && s.date === today) : null)
                        || (Array.isArray(summaries) && summaries.length ? summaries[0] : null);
      if (!entry) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          ok: true, available: false,
          date: today,
          message: "Sin resumen todavía. Se genera automáticamente al primer ciclo del día (≤1 min tras arranque)."
        }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok:             true,
        available:      true,
        date:           entry.date,
        recovery:       entry.recovery,
        tradingCapacity:entry.tradingCapacity,
        marketRegime:   entry.marketRegime,
        portfolioValue: entry.portfolioMXN,
        gainPct:        entry.gainPct,
        topWinner:      entry.topWinner,
        topLoser:       entry.topLoser,
        riskMode:       entry.riskMode,
        summary:        entry.summary
      }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(render());
});

async function boot() {
  // Load persistent portfolio store before serving any requests
  try { loadPortfolioStore(); } catch(e) { console.log("loadPortfolioStore omitido:", e.message); }

  // CORDELIUS_BOOT_LISTEN_FIRST_FIX
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`${settings.appName} listo en http://localhost:${PORT}`);
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

    // Autonomous daily snapshot — check every minute, fires once per calendar day
    try { runAutoDailySnapshot(); } catch(e) { console.log("runAutoDailySnapshot boot omitido:", e.message); }
    setInterval(() => { try { runAutoDailySnapshot(); } catch(e) {} }, 60000);

    // Proactive alerts — every 5 minutes (dedup prevents spam)
    try { checkAlerts(); } catch(e) { console.log("checkAlerts boot omitido:", e.message); }
    setInterval(() => { try { checkAlerts(); } catch(e) {} }, 5 * 60 * 1000);

  }, 500);
}
boot();

/* CORDELIUS_P1_APPLIED */

/* CORDELIUS_P1C_SEGURO_APPLIED */

/* CORDELIUS_P2_INTEL_APPLIED */

/* CORDELIUS_CLAUDE_SMART_APPLIED */

/* CORDELIUS_F3A1_APPLIED */
