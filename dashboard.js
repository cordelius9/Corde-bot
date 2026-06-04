const http = require("http");
const https = require("https");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const QUIVER_API_KEY = process.env.QUIVER_API_KEY || "";
const QUIVER_CACHE_MS = 2 * 60 * 60 * 1000;

const BOT_FILE = "bot_state.json";
const HISTORY_FILE = "portfolio_history.json";
const CHAT_FILE = "alfredo_chat_history.json";
const SETTINGS_FILE = "cordelius_settings.json";
const INTEL_FILE = "cordelius_intel.json";

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
  appName: "Cordelius Trading", assistantName: "Alfredo AI"
});

let quotes = {};
let news = [];
let chatHistory = loadJSON(CHAT_FILE, []);
let portfolioHistory = loadJSON(HISTORY_FILE, []);
let intelItems = loadJSON(INTEL_FILE, []);
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
  COPX: "AMEX:COPX", NFLX: "NASDAQ:NFLX", XRP: "BINANCE:XRPUSDT", BTC: "BINANCE:BTCUSDT",
  ETH: "BINANCE:ETHUSDT", BCH: "BINANCE:BCHUSDT", MANA: "BINANCE:MANAUSDT", SHIB: "BINANCE:SHIBUSDT"
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

async function refreshQuotes() {
  for (const a of PORTFOLIO) {
    if (a.type === "crypto") {
      const drift = ((Math.random() - 0.5) * 1.8);
      quotes[a.symbol] = { price: a.valueManual / Math.max(a.units, 1e-8), value: a.valueManual * (1 + drift / 100), day: drift, ok: true, source: "manual/bitso" };
      continue;
    }
    if (a.source === "GBM" || a.type === "stock_mx") {
      const drift = ((Math.random() - 0.45) * 1.2);
      quotes[a.symbol] = { price: a.valueManual / Math.max(a.units, 1e-8), value: a.valueManual * (1 + drift / 100), day: drift, ok: true, source: "manual/gbm" };
      continue;
    }
    if (FINNHUB_API_KEY && a.liveTicker) {
      const j = await apiGet(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(a.liveTicker)}&token=${FINNHUB_API_KEY}`);
      if (j && Number(j.c)) {
        quotes[a.symbol] = { price: Number(j.c), value: Number(j.c) * a.units, day: Number(j.dp || 0), ok: true, source: "finnhub" };
        continue;
      }
    }
    const drift = ((Math.random() - 0.45) * 1.2);
    quotes[a.symbol] = { price: a.valueManual / Math.max(a.units, 1e-8), value: a.valueManual * (1 + drift / 100), day: drift, ok: true, source: "manual/plata" };
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

  const marketThemes = [];
  if (techMatches > 3)   marketThemes.push({ theme: "Tech / AI Infrastructure",   strength: techMatches > 12   ? "FUERTE" : "MODERADO",   quiverSignals: techMatches,   tickers: techSyms.filter(s => pv.assets.find(a => a.symbol === s)) });
  if (energyMatches > 1) marketThemes.push({ theme: "Energia / Grid / Cobre",      strength: energyMatches > 6  ? "FUERTE" : "MODERADO",   quiverSignals: energyMatches, tickers: energySyms });
  if (healthMatches > 0) marketThemes.push({ theme: "Healthcare / Regulacion",     strength: healthMatches > 4  ? "FUERTE" : "BAJO",       quiverSignals: healthMatches, tickers: healthSyms });
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
    intel: { count: intelItems.length, recent: intelItems.slice(0, 3).map(x => ({ mood: x.mood, affected: x.affected, time: x.time, snippet: String(x.text || "").slice(0, 150) })) }
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
Eres Alfredo AI dentro de Cordelius Trading. Responde en español mexicano, claro, directo y útil.
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
  } else {
    reply = `Cordelius activo. Portafolio ${money(pv.totalValueMXN)}, rendimiento ${pct(pv.totalGainPct)}, regimen ${reg.label}. Mejor score: ${best.symbol} (${best.score}/100); mas debil: ${worst.symbol} (${worst.score}/100).`;
  }
  const ai = await askClaude(question, reply, pv, reg, botEq, botPnl);
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
  const nodes = [
    { label: pct(pv.totalGainPct)+" port",                    delay: 0,    color: pv.totalGainPct >= 0 ? "#00ff99" : "#ff4d6d" },
    { label: hasHighRisk ? "Risk ⚠" : "Risk ✓",               delay: 0.3,  color: hasHighRisk ? "#ff4d6d" : "#00ff99" },
    { label: "Quiver "+(quiverData.configured ? "✓" : "—"),   delay: 0.7,  color: quiverData.configured ? "#00ff99" : "#9fb3c8" },
    { label: "Congress",                                        delay: 1.1 },
    { label: "Insiders",                                        delay: 0.5 },
    { label: "News "+news.length,                              delay: 0.9,  color: news.length > 0 ? "#3b9dff" : "#9fb3c8" },
    { label: "BBVA",                                            delay: 0.2 },
    { label: "MSFT",                                            delay: 0.6 },
    { label: "AI",                                              delay: 1.4,  color: "#818cf8" },
    { label: "PLTR",                                            delay: 0.8 },
    { label: idea.hasIdea ? idea.symbol+" "+idea.type.split("_")[0] : "Paper —", delay: 1.2, color: idea.hasIdea ? "#ffd35c" : "#9fb3c8" },
    { label: "Scan",                                            delay: 0.4 },
    { label: "BTC",                                             delay: 1.0 },
    { label: "Cripto "+criptoPct.toFixed(0)+"%",               delay: 0.15, color: criptoPct > 45 ? "#ff4d6d" : "#f59e0b" },
    { label: "AAPL",                                            delay: 0.55 },
    { label: "Macro",                                           delay: 0.95 },
  ];
  const positions = [
    "left:4%;top:10%",  "left:20%;top:4%",  "left:38%;top:13%", "left:56%;top:4%",
    "left:73%;top:13%", "left:86%;top:5%",  "left:8%;top:42%",  "left:26%;top:35%",
    "left:44%;top:44%", "left:61%;top:36%", "left:78%;top:44%", "left:88%;top:34%",
    "left:4%;top:74%",  "left:23%;top:68%", "left:45%;top:76%", "left:66%;top:70%",
  ];
  return `<div class="brain-card">
    <div class="brain-left">
      <div class="brain-title">Cerebro Alfredo AI</div>
      <div class="brain-sub">Red neuronal viva: datos → análisis → señales → decisiones</div>
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
  </div>`;
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
          <div><span>Cantidad</span><b>${unitsLabel}</b></div>
          <div><span>Costo original</span><b>${money(a.costMXN)}</b></div>
          <div><span>Valor actual</span><b>${money(a.valueMXN)}</b></div>
          <div><span>Ganancia MXN</span><b class="${a.gainMXN >= 0 ? "green" : "red"}">${money(a.gainMXN)}</b></div>
          <div><span>Promedio compra</span><b>${avgLabel}</b></div>
          <div><span>Precio actual</span><b>${curLabel}</b></div>
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
        <div class="detail-grid">
          <div><span>Zona compra</span><b>${a.currency === "USD" ? money(z.buy, "USD") : money(z.buy)}</b></div>
          <div><span>Zona venta</span><b>${a.currency === "USD" ? money(z.sell, "USD") : money(z.sell)}</b></div>
          <div><span>Stop educativo</span><b>${a.currency === "USD" ? money(z.stop, "USD") : money(z.stop)}</b></div>
          <div><span>Fuente precio</span><b>${esc(a.quoteSource)}</b></div>
        </div>
        <a class="tv-link" target="_blank" href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(TV_SYMBOL[a.symbol] || a.symbol)}">Abrir TradingView de ${esc(a.symbol)}</a>
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
  function newsCard(n) {
    const c = n.classification;
    const img = n.image ? `<img class="news-img" src="${esc(n.image)}" alt="">` : `<div class="news-img placeholder">NEWS</div>`;
    const impacted = n.impacted && n.impacted.length ? n.impacted : ["Mercado"];
    const dateStr = n.datetime ? new Date(n.datetime * 1000).toLocaleDateString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="news-card">${img}<div class="news-body">
      <div class="chips"><span>${esc(c.type)}</span><span style="background:${c.impactColor}22;border-color:${c.impactColor}55;color:${c.impactColor}">${esc(c.impact)} · ${c.confidence}%</span><span>${esc(c.region)}</span><span>${esc(n.source || "Fuente")}</span>${dateStr ? `<span style="color:#9fb3c8">${esc(dateStr)}</span>` : ""}</div>
      <h3>${esc(n.headline || "Sin titulo")}</h3>
      <p>${esc((n.summary || "").slice(0, 240))}</p>
      <div class="impact"><b>Activos impactados:</b>${impacted.map(x => `<span style="${portfolioSymbols.has(x) ? "background:rgba(0,255,153,.12);border-color:rgba(0,255,153,.3);color:#00ff99" : ""}">${esc(x)}</span>`).join("")}</div>
      <div class="why">Lectura Alfredo: puede mover sentimiento, liquidez o sector. No ejecutar sin análisis propio.</div>
      <a target="_blank" href="${esc(n.url || "#")}">Abrir fuente ↗</a>
    </div></div>`;
  }
  const portfolioNews = news.filter(n => n.impacted && n.impacted.some(t => portfolioSymbols.has(t)));
  const externalNews = news.filter(n => !portfolioNews.includes(n));
  let html = "";
  if (portfolioNews.length) {
    html += `<div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#00ff99;margin:8px 0 12px;max-width:1280px">Impactan tu portafolio (${portfolioNews.length})</div>`;
    html += portfolioNews.map(newsCard).join("");
  }
  if (externalNews.length) {
    html += `<div style="font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#9fb3c8;margin:${portfolioNews.length ? "24px" : "8px"} 0 12px;max-width:1280px">Mercado general (${externalNews.length})</div>`;
    html += externalNews.map(newsCard).join("");
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
  const lines = nl.lines.slice(0, 4);
  const ideaHtml = idea.hasIdea
    ? `<div style="margin-top:12px;padding:10px 14px;background:rgba(0,255,153,.06);border:1px solid rgba(0,255,153,.18);border-radius:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <span style="font-size:10px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#00ff99">IDEA PAPER</span>
        <b>${esc(idea.symbol)}</b>
        <span style="color:#00ff99;font-weight:700">${esc(idea.type)}</span>
        <span class="muted" style="font-size:12px">${esc(idea.reason)}</span>
        <span style="font-size:11px;color:#9fb3c8">confianza: ${esc(idea.confidence)}</span>
      </div>`
    : `<div style="margin-top:12px;padding:8px 14px;background:rgba(120,160,210,.05);border-radius:10px;color:#9fb3c8;font-size:13px">Sin idea de trade destacada hoy.</div>`;
  return `<div style="max-width:1280px;margin:0 auto 16px">
    <div class="panel" style="border:1px solid rgba(59,157,255,.18);background:rgba(59,157,255,.04)">
      <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#3b9dff;margin-bottom:10px">Morning Report — ${esc(nl.date)}</div>
      <div style="font-size:15px;color:#dbeafe;font-weight:600;margin-bottom:12px">${esc(nl.greeting)}</div>
      <ul style="margin:0;padding-left:18px;list-style:disc">
        ${lines.map(l => `<li style="margin-bottom:6px;color:#c8d8f0;font-size:13px">${esc(l)}</li>`).join("")}
      </ul>
      ${ideaHtml}
      <div style="margin-top:14px;padding-top:10px;border-top:1px solid rgba(120,160,210,.08);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <a href="/api/morning-report" target="_blank" style="font-size:12px;color:#3b9dff;text-decoration:none;border:1px solid rgba(59,157,255,.25);border-radius:99px;padding:5px 12px">API JSON</a>
        <span class="muted" style="font-size:11px">Generado: ${esc(nowMX())}</span>
        <span class="muted" style="font-size:11px">• bash scripts/morning_report.sh para guardar en reports/</span>
      </div>
    </div>
  </div>`;
}

function renderAutopilotPanel() {
  const isOnline = true;
  const paperActive = true;
  return `<div style="max-width:1280px;margin:0 auto 16px">
    <div class="panel" style="border:1px solid rgba(129,140,248,.18);background:rgba(129,140,248,.04)">
      <div style="font-size:10px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#818cf8;margin-bottom:12px">Autopilot — Estado del sistema</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px">
        <div style="background:rgba(0,255,153,.07);border:1px solid rgba(0,255,153,.18);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:900;letter-spacing:.1em;color:#00ff99;margin-bottom:4px">SERVIDOR</div>
          <div style="font-size:18px;font-weight:900;color:#00ff99">ON</div>
          <div class="muted" style="font-size:11px">Cordelius OS</div>
        </div>
        <div style="background:rgba(255,211,92,.07);border:1px solid rgba(255,211,92,.18);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:900;letter-spacing:.1em;color:#ffd35c;margin-bottom:4px">CLOUDFLARE</div>
          <div style="font-size:18px;font-weight:900;color:#ffd35c">MANUAL</div>
          <div class="muted" style="font-size:11px">bash tunnel.sh</div>
        </div>
        <div style="background:rgba(0,255,153,.07);border:1px solid rgba(0,255,153,.18);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:900;letter-spacing:.1em;color:#00ff99;margin-bottom:4px">PAPER MODE</div>
          <div style="font-size:18px;font-weight:900;color:#00ff99">ON</div>
          <div class="muted" style="font-size:11px">Sin dinero real</div>
        </div>
        <div style="background:rgba(255,77,109,.07);border:1px solid rgba(255,77,109,.18);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:900;letter-spacing:.1em;color:#ff4d6d;margin-bottom:4px">REAL TRADING</div>
          <div style="font-size:18px;font-weight:900;color:#ff4d6d">OFF</div>
          <div class="muted" style="font-size:11px">No conectado</div>
        </div>
        <div style="background:${quiverData.configured ? "rgba(0,255,153,.07)" : "rgba(255,211,92,.07)"};border:1px solid ${quiverData.configured ? "rgba(0,255,153,.18)" : "rgba(255,211,92,.18)"};border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:900;letter-spacing:.1em;color:${quiverData.configured ? "#00ff99" : "#ffd35c"};margin-bottom:4px">QUIVER</div>
          <div style="font-size:18px;font-weight:900;color:${quiverData.configured ? "#00ff99" : "#ffd35c"}">${quiverData.configured ? "ON" : "—"}</div>
          <div class="muted" style="font-size:11px">${quiverData.configured ? "Datos en vivo" : "Agrega API key"}</div>
        </div>
        <div style="background:rgba(129,140,248,.07);border:1px solid rgba(129,140,248,.18);border-radius:12px;padding:12px;text-align:center">
          <div style="font-size:10px;font-weight:900;letter-spacing:.1em;color:#818cf8;margin-bottom:4px">ALPACA</div>
          <div style="font-size:18px;font-weight:900;color:#818cf8">PENDIENTE</div>
          <div class="muted" style="font-size:11px">Paper solo (F3)</div>
        </div>
      </div>
      <div style="border-top:1px solid rgba(120,160,210,.08);padding-top:10px">
        <div style="font-size:10px;font-weight:900;letter-spacing:.1em;color:#9fb3c8;margin-bottom:8px">SCRIPTS DE AUTOMATIZACIÓN</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${["health_check.sh","restart_safe.sh","morning_report.sh","final_check.sh"].map(s =>
            `<span style="border:1px solid rgba(129,140,248,.25);border-radius:99px;padding:4px 12px;font-size:12px;font-family:monospace;color:#818cf8">bash scripts/${esc(s)}</span>`
          ).join("")}
        </div>
        <div class="muted" style="font-size:11px;margin-top:8px">Próximo paso: Termux:Boot para inicio automático — ver AUTOMATION.md</div>
      </div>
    </div>
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
  const chatHtml = chatHistory.map(c => `<div class="msg"><b>Tu:</b> ${esc(c.question)}<br><b>Alfredo AI:</b><div>${md(c.reply)}</div><small>${esc(c.time)}</small></div>`).join("");
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
.float{position:fixed;right:20px;bottom:20px;width:68px;height:68px;border-radius:22px;display:grid;place-items:center;text-decoration:none;font-size:30px;background:linear-gradient(135deg,#00ff99,#3b9dff);box-shadow:0 0 36px rgba(0,255,153,.55);z-index:30}
.disclaimer{max-width:1280px;margin:34px auto 0;color:#5a6674;font-size:12px;text-align:center;padding:16px;border-top:1px solid rgba(120,160,210,.08)}
@media(max-width:820px){h1{font-size:34px}.brain-card{grid-template-columns:1fr}.news-card{grid-template-columns:1fr}.asset-row summary{grid-template-columns:1fr}.asset-money{text-align:left}.rank{grid-template-columns:1fr}.chatbox{flex-direction:column}.tv-embed{height:380px}}
</style></head><body>
<div class="particles">${Array.from({ length: 18 }).map((_, i) => `<i style="left:${(i * 5.5 + 3) % 100}%;animation-duration:${9 + (i % 7)}s;animation-delay:${(i % 9)}s"></i>`).join("")}</div>
<a class="float" href="#alfredo">AI</a>

<header>
  <div class="logo-wrap">
    <div class="app-icon"><svg width="44" height="44" viewBox="0 0 44 44" fill="none"><polygon points="22,4 40,34 4,34" stroke="rgba(255,255,255,.9)" stroke-width="2.2" fill="none"/><line x1="22" y1="4" x2="22" y2="34" stroke="rgba(255,255,255,.6)" stroke-width="1.2"/><circle cx="22" cy="22" r="4" fill="rgba(255,255,255,.95)"/></svg></div>
    <div><h1>${esc(settings.appName)}</h1><div class="subtitle">CORDΞLIUS · Trading · Intelligence · Law · Alfredo AI</div></div>
  </div>
  <nav>
    <a href="#home">Inicio</a><a href="#vigilar">Vigilar hoy</a><a href="#scan">Scan Diario</a><a href="#intelligence">Intelligence</a><a href="#radar">Trading AI</a><a href="#portfolio">Portafolio</a><a href="#quiver">Quiver</a><a href="#chart">Graficas</a><a href="#alfredo">Alfredo AI</a><a href="#modulos">Law / Help</a><a href="#system">Sistema</a>
  </nav>
</header>

<div class="toolbar">
  <a class="switch" href="/toggle-thinking"><span class="dot"></span>Thinking Mode: <b>${settings.thinkingEnabled ? "ON" : "OFF"}</b></a>
  <span class="switch">Refresh: <b>${settings.autoRefreshSeconds}s</b></span>
  <span class="switch">Finnhub: <b class="${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</b></span>
  <span class="switch">Claude: <b class="${ANTHROPIC_API_KEY ? "green" : "yellow"}">${ANTHROPIC_API_KEY ? "OK" : "SIN KEY"}</b></span>
</div>

<a id="home"></a>
${renderDailyBrief()}
${renderMorningReport()}
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-bottom:8px">
  <a href="#portfolio" style="text-decoration:none"><div class="card" style="border-color:rgba(59,157,255,.35);background:linear-gradient(135deg,rgba(59,157,255,.08),rgba(0,0,0,0))"><div class="label">Trading</div><div class="big blue" style="font-size:26px">Portafolio</div><div class="muted">Activos · Scan Diario · Quiver · Bot ficticio</div></div></a>
  <a href="#intelligence" style="text-decoration:none"><div class="card" style="border-color:rgba(0,255,153,.35);background:linear-gradient(135deg,rgba(0,255,153,.08),rgba(0,0,0,0))"><div class="label">Intelligence</div><div class="big green" style="font-size:26px">Radar</div><div class="muted">Intel manual · Trading político · Market Radar</div></div></a>
  <a href="#modulos" style="text-decoration:none"><div class="card" style="border-color:rgba(255,211,92,.35);background:linear-gradient(135deg,rgba(255,211,92,.08),rgba(0,0,0,0))"><div class="label">Law</div><div class="big yellow" style="font-size:26px">Cordelius Law</div><div class="muted">Cuaderno jurídico · casos · apuntes (próximo)</div></div></a>
  <a href="#alfredo" style="text-decoration:none"><div class="card" style="border-color:rgba(129,140,248,.35);background:linear-gradient(135deg,rgba(129,140,248,.08),rgba(0,0,0,0))"><div class="label">Alfredo AI</div><div class="big" style="font-size:26px;color:#818cf8">Asistente</div><div class="muted">Preguntas · análisis educativo · chat</div></div></a>
</div>

<div class="grid">
  ${(function(){var A=pv.assets||[];var tot=pv.totalValueMXN||1;var gbm=A.filter(function(a){return a.source==="GBM";}).reduce(function(s,a){return s+a.valueMXN;},0);var plata=A.filter(function(a){return a.source==="Plata";}).reduce(function(s,a){return s+a.valueMXN;},0);var bitso=A.filter(function(a){return a.source==="Bitso";}).reduce(function(s,a){return s+a.valueMXN;},0);var cripto=A.filter(function(a){return a.type==="crypto";}).reduce(function(s,a){return s+a.valueMXN;},0);var cp=cripto/tot*100;var estado=cp>45?"AGRESIVO":(cp<20?"DEFENSIVO":"NEUTRAL");var ec=estado==="AGRESIVO"?"#ff4d6d":(estado==="DEFENSIVO"?"#00ff99":"#ffd35c");function pp(x){return (x/tot*100).toFixed(1)+"%";}return `<div class="card"><div class="label">Estado general</div><div class="big" style="color:${ec}">${estado}</div><div class="muted">Cripto ${cp.toFixed(0)}% · educativo, no asesoria</div></div><div class="card"><div class="label">Exposicion por plataforma</div><div>GBM ${pp(gbm)}</div><div>Plata ${pp(plata)}</div><div>Bitso ${pp(bitso)}</div></div><div class="card"><div class="label">Exposicion por divisa</div><div>USD ${pp(plata)}</div><div>MXN ${pp(gbm+bitso)}</div><div>Cripto ${pp(bitso)}</div></div><div class="card"><div class="label">Tipo de cambio</div><div class="big">$${FX_USD_MXN.toFixed(2)}</div><div class="muted">USD a MXN · .env USD_MXN o fallback · ${nowMX()}</div></div>`;})()}<div class="card"><div class="label">Patrimonio total estimado</div><div class="big green glow">${money(pv.totalValueMXN)}</div><div class="${pv.totalGainPct >= 0 ? "green" : "red"}">${pct(pv.totalGainPct)} · ${money(pv.totalGainMXN)}</div></div>
  <div class="card"><div class="label">Regimen</div><div class="big" style="color:${reg.color}">${esc(reg.label)}</div><div class="muted">${pct(reg.avg)} · ${esc(reg.detail)}</div></div>
  <div class="card"><div class="label">Mejor score</div><div class="big green">${esc(best.symbol)}</div><div>${esc(best.signal)} · ${best.score}/100</div></div>
  <div class="card"><div class="label">Mas debil</div><div class="big red">${esc(worst.symbol)}</div><div>${esc(worst.signal)} · ${worst.score}/100</div></div>
</div>

<a id="chart"></a><h2>Graficas — portafolio + TradingView</h2>
<div class="panel">${spark(portfolioHistory, { key: "total", color: "#3b9dff", height: 300 })}<div class="muted">Eje, max, min, area y variacion. Se guarda en ${esc(HISTORY_FILE)}.</div></div>
<h2>Chart profesional (${esc(best.symbol)}) — TradingView</h2>
<div class="tv-embed"><iframe src="https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(topTV)}&interval=D&theme=dark&style=1&hidesidetoolbar=0&saveimage=0&studies=RSI@tv-basicstudies,MACD@tv-basicstudies" style="width:100%;height:100%;border:0"></iframe></div>

<a id="brain"></a><h2>Cerebro vivo de Cordelius</h2>${brainHtml()}

<a id="alfredo"></a><h2>Alfredo AI — asistente educativo</h2>
<div class="panel" style="padding:0"><details class="chat-details">
  <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:16px 20px;background:rgba(59,157,255,.07);border-radius:24px;user-select:none">
    <span style="display:flex;align-items:center;gap:12px">
      <span style="width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg,#3b9dff,#00ff99);display:grid;place-items:center;font-size:18px;font-weight:900">AI</span>
      <span><b>Alfredo AI</b> <span class="muted" style="font-size:13px">· preguntas sobre tu portafolio · educativo</span></span>
    </span>
    <span class="btn" style="font-size:13px;padding:6px 14px">Abrir chat ▾</span>
  </summary>
  <div style="padding:16px 20px 20px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      ${["Qué vigilar hoy","Analiza mi portafolio","Stocks externos calientes","Congreso e insiders","Cuánto BTC tengo","Promedio de compra por activo"].map(q =>
        `<button onclick="document.querySelector('[name=q]').value='${q}'" class="btn" style="font-size:12px;padding:7px 12px;border-color:rgba(59,157,255,.3)">${esc(q)}</button>`
      ).join("")}
    </div>
    <form class="chatbox" method="POST" action="/ask"><input name="q" placeholder="Pregúntale a Alfredo..." autocomplete="off"><button class="btn">Preguntar</button></form>
    <div style="max-height:480px;overflow-y:auto;margin-top:12px">
      ${chatHtml || '<div class="msg muted">Sin preguntas todavia.</div>'}
    </div>
  </div>
</details></div>

<a id="portfolio"></a><h2>Portafolio real por cuenta</h2>
${(function(){
  const bySource = {};
  for (const a of assets) { bySource[a.source] = bySource[a.source] || []; bySource[a.source].push(a); }
  return Object.entries(bySource).map(([src, list]) =>
    renderAccountSummary(src, list)
    + `<h2 style="font-size:18px;margin:6px 0 8px;color:#9fb3c8">${esc(src)} · ${[...new Set(list.map(a => a.category))].join(", ")}</h2>`
    + renderPortfolioRows(list)
  ).join("");
})()}

<h2>Ranking Alfredo — score · riesgo · señal educativa</h2>
<div class="ranking">${ranked.map((a, i) => {
  const qCount = quiverData.congressional.filter(x => x.symbol === a.symbol).length + quiverData.insider.filter(x => x.symbol === a.symbol).length;
  const bullish = a.score >= 65 && a.ind.momentum >= 0;
  const bearish = a.score < 35 || (a.gainPct < -15 && a.risk === "ALTO");
  const sigLabel = bullish ? "Bullish" : bearish ? "Risk/Vigilar" : "Neutral";
  const sigColor = bullish ? "#00ff99" : bearish ? "#ff4d6d" : "#ffd35c";
  const eduAction = a.gainPct > 80 && a.score > 55 ? "Tomar ganancia parcial (hipotético)" :
    a.score < 30 ? "No promediar — revisar tesis" :
    a.signal.includes("BUY") ? "Vigilar entrada educativa" : "Mantener y monitorear";
  return `<div class="rank" style="grid-template-columns:auto 1fr auto">
    <div><b>${i + 1}. ${esc(a.symbol)}</b><div class="muted" style="font-size:12px">${esc(a.source)} · ${esc(a.risk)}</div>${qCount > 0 ? `<div style="color:#00ff99;font-size:11px">Q×${qCount}</div>` : ""}</div>
    <div>
      <div class="bar"><span style="width:${a.score}%"></span></div>
      <div style="display:flex;gap:8px;margin-top:5px;flex-wrap:wrap">
        <span style="color:${sigColor};font-size:12px;font-weight:700">${sigLabel}</span>
        <span class="muted" style="font-size:12px">${esc(a.signal)}</span>
      </div>
      <div class="muted" style="font-size:11px;margin-top:3px">Compra ${a.currency === "USD" ? money(a.zones.buy, "USD") : money(a.zones.buy)} · ${esc(eduAction)}</div>
    </div>
    <div style="text-align:right"><b style="font-size:20px">${a.score}/100</b><div class="${a.gainPct >= 0 ? "green" : "red"}" style="font-size:13px">${pct(a.gainPct)}</div></div>
  </div>`;
}).join("")}</div>

<a id="news"></a><h2>Noticias inteligentes + activos impactados</h2>${renderNews()}

<a id="bot"></a><h2>Trading AI — Paper Mode · Laboratorio ficticio</h2>
${renderTradingAIStatus()}
${renderPaperTradingPanel()}

<a id="vigilar"></a><h2>Radar Externo — Stocks calientes por sector</h2>
${renderExternalRadarBySector()}

<a id="quiver"></a><h2>Quiver — Congreso · Insiders · Contratos · Políticos <span style="background:${QUIVER_API_KEY && quiverData.configured ? '#00ff99' : '#ffd166'};color:#000;border-radius:99px;padding:2px 10px;font-size:12px;font-weight:900;vertical-align:middle;margin-left:8px">${QUIVER_API_KEY && quiverData.configured ? 'LIVE' : 'PENDIENTE'}</span></h2>
${renderQuiverIntelligencePanel()}

<a id="scan"></a><h2>Scan Diario — portafolio + Quiver + señales</h2>${renderDailyScanCard()}

<a id="intel"></a><h2>Cordelius Intelligence — Grok / X manual${intelItems.length ? ' <span style="background:#3b9dff;color:#fff;border-radius:99px;padding:2px 11px;font-size:13px;vertical-align:middle;margin-left:6px">' + intelItems.length + '</span>' : ''}</h2>${renderIntelPanel()}

<a id="intelligence"></a><h2>Cordelius Intelligence — Radar político · Intel manual</h2>
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

<a id="autopilot"></a><h2>Autopilot — Estado del sistema · Automatización</h2>
${renderAutopilotPanel()}

<a id="modulos"></a><h2>Modulos Cordelius (proximamente)</h2><div class="grid"><div class="card"><div class="label">Cordelius Health</div><div class="big" style="color:#818cf8">Proximamente</div><div class="muted">WHOOP API: sueno, HRV, recuperacion, habitos (pendiente)</div></div><div class="card"><div class="label">Cordelius Law</div><div class="big" style="color:#ffd35c">Proximamente</div><div class="muted">Cuaderno juridico, apuntes, casos (pendiente)</div></div><div class="card"><div class="label">Cordelius Intelligence</div><div class="big" style="color:#3b9dff">Grok / X manual</div><div class="muted">Pegar analisis de X o Grok (pendiente P2)</div></div><div class="card"><div class="label">Asia / China Tech</div><div class="big" style="color:#00ff99">Radar</div><div class="muted">Chips, cobre, IA, energia (pendiente, sin fuente)</div></div><div class="card"><div class="label">Alpaca</div><div class="big" style="color:#ffd35c">Pendiente</div><div class="muted">Solo paper trading futuro, sin ordenes reales</div></div></div><a id="system"></a><h2>Sistema</h2>
<div class="grid">
  <div class="card"><div class="label">App</div><div class="big green">${esc(settings.appName)}</div></div>
  <div class="card"><div class="label">Alfredo AI</div><div class="big ${settings.thinkingEnabled ? "green" : "yellow"}">${settings.thinkingEnabled ? "THINKING" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Finnhub</div><div class="big ${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Quiver</div><div class="big ${QUIVER_API_KEY ? "green" : "yellow"}">${QUIVER_API_KEY ? "OK" : "PENDIENTE"}</div></div>
</div>

<div class="disclaimer">Cordelius Trading es educativo. No es asesoria financiera. El bot es 100% ficticio (paper trading) y no se conecta a ningun exchange real.</div>
</body></html>`;
}

async function handleAsk(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    const q = new URLSearchParams(body).get("q") || "";
    if (q.trim()) await alfredoReply(q.trim());
    res.writeHead(302, { Location: "/#alfredo" }); res.end();
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

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (req.method === "POST" && path === "/ask") return handleAsk(req, res);
  if (req.method === "POST" && path === "/intel") return handleIntel(req, res);
  if (req.method === "POST" && path === "/intel/delete") return handleIntelDelete(req, res);
  if (req.method === "POST" && path === "/intel/clear") return handleIntelClear(req, res);
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
      quiver: { configured: qi.configured },
      paperMode: { active: true, realTrading: false, alpacaConnected: false, botMetrics: m },
      automation: {
        scripts: ["health_check.sh", "restart_safe.sh", "morning_report.sh", "final_check.sh"],
        reportsDir: "reports/",
        cloudReady: true,
        disclaimer: "PAPER TRADING / EDUCATIVO — SIN ORDENES REALES"
      }
    }));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(render());
});

async function boot() {
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
  }, 500);
}
boot();

/* CORDELIUS_P1_APPLIED */

/* CORDELIUS_P1C_SEGURO_APPLIED */

/* CORDELIUS_P2_INTEL_APPLIED */

/* CORDELIUS_CLAUDE_SMART_APPLIED */

/* CORDELIUS_F3A1_APPLIED */
