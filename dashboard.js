const http = require("http");
const https = require("https");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const QUIVER_API_KEY = process.env.QUIVER_API_KEY || "";
let quiverCache = { data: null, ts: 0, TTL_MS: 2 * 60 * 60 * 1000 };

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

// ---- CHART SVG TIPO TRADINGVIEW (con eje, max, min, area) ----
function spark(data, opts = {}) {
  const key = opts.key || "total";
  const color = opts.color || "#3b9dff";
  const height = opts.height || 260;
  let vals = (data || []).map(x => typeof x === "number" ? x : Number(x[key])).filter(Number.isFinite);
  if (vals.length < 2) vals = [0, 1, 0.7, 1.4, 1.1, 1.8, 1.55];
  const min = Math.min(...vals), max = Math.max(...vals);
  const padTop = 28, padBottom = 34, plotH = height - padTop - padBottom;
  const gid = "g" + Math.floor(Math.random() * 999999);
  const xy = vals.map((v, i) => {
    const x = 56 + (i / Math.max(1, vals.length - 1)) * 900;
    const y = padTop + (1 - ((v - min) / (max - min || 1))) * plotH;
    return [x, y];
  });
  const pts = xy.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = "56," + (height - padBottom) + " " + pts + " 956," + (height - padBottom);
  const last = vals[vals.length - 1], first = vals[0];
  const delta = first ? ((last - first) / Math.abs(first)) * 100 : 0;
  const dots = xy.map((p, i) => {
    if (i !== vals.length - 1 && i !== 0 && i % Math.ceil(vals.length / 6) !== 0) return "";
    return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5" fill="${color}"/>`;
  }).join("");
  return `<div class="chart-wrap"><svg viewBox="0 0 1020 ${height}" class="chart">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".35"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <line x1="56" y1="${height - padBottom}" x2="956" y2="${height - padBottom}" stroke="rgba(255,255,255,.16)"/>
    <line x1="56" y1="${padTop}" x2="56" y2="${height - padBottom}" stroke="rgba(255,255,255,.16)"/>
    <text x="58" y="22" fill="#9fb3c8" font-size="20">Max ${max.toFixed(2)}</text>
    <text x="58" y="${height - 8}" fill="#9fb3c8" font-size="20">Min ${min.toFixed(2)}</text>
    <text x="780" y="24" fill="${delta >= 0 ? "#00ff99" : "#ff4d6d"}" font-size="22">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%</text>
    <polygon points="${area}" fill="url(#${gid})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}</svg></div>`;
}

function miniSpark(symbol, color = "#3b9dff") {
  const seed = seedFor(symbol);
  const vals = []; let v = 50 + (seed % 25);
  for (let i = 0; i < 20; i++) { v += Math.sin((i + seed) / 2) * 2 + ((seed % 7) - 3) * 0.18; vals.push(v); }
  return spark(vals, { color, height: 115 });
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

// Pensamientos institucionales mas ricos
function institutionalThoughts(pv, reg) {
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  const top = ranked[0], bottom = ranked[ranked.length - 1];
  const lines = [
    `Escaneando ${pv.assets.length} activos en GBM, Plata y Bitso.`,
    `Regimen ${reg.label} (${pct(reg.avg)}): ${reg.detail}`,
    `Mayor score: ${top.symbol} (${top.score}/100), RSI ${top.ind.rsi}, tendencia ${top.ind.trend.toLowerCase()}.`,
    `Mas debil: ${bottom.symbol} (${bottom.score}/100), momentum ${bottom.ind.momentum}.`,
    `Probabilidad alcista estimada ${top.symbol}: ${Math.min(85, top.score + 8)}%.`,
    `Revisando flujo institucional y volatilidad relativa.`,
    `Calculando score de confianza por sector (tech, energia, cripto).`
  ];
  const pick = lines[Math.floor(Math.random() * lines.length)];
  addThought(pick, "scan");
}

function botTick() {
  if (!bot.running) { addThought("Bot pausado: monitoreo visual activo, sin compras simuladas.", "warn"); saveJSON(BOT_FILE, bot); return; }
  const pv = portfolioValue();
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  institutionalThoughts(pv, marketRegime());

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

DAILY SCAN (resumen automatico de hoy):
${(function(){try{const qcM=quiverCache.data?matchQuiverToPortfolio(quiverCache.data):{count:0,tickers:[],grouped:{}};const s=buildScanData(pv,qcM);return JSON.stringify({topRisk:s.topRisk,topOpportunity:s.topOpportunity,concentrationRisk:s.concentrationRisk,cryptoExposurePct:+s.bitsoPct.toFixed(1),regime:s.reg.label,actionChecklist:s.actionChecklist,riskAlerts:s.riskAlerts.slice(0,4).map(a=>({level:a.level,symbol:a.symbol,title:a.title,educationalAction:a.educationalAction})),quiverMatches:qcM.count},null,2);}catch(e){return "no disponible";}})()}

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
  if (q.includes("riesgo")) {
    const high = pv.assets.filter(a => a.risk === "ALTO" || a.risk === "MEDIO/ALTO");
    reply = `Tu riesgo principal esta en ${high.map(a => a.symbol).join(", ")}. El regimen esta ${reg.label}. No es que esten mal, son los que mas pueden moverse fuerte.`;
  } else if (q.includes("vender")) {
    reply = `Primero revisaria ${worst.symbol}: score ${worst.score}, senal ${worst.signal}, rendimiento ${pct(worst.gainPct)}. No es vender automatico, es vigilarlo mas.`;
  } else if (q.includes("comprar") || q.includes("compro")) {
    const ideas = ranked.filter(a => a.signal.includes("BUY") || a.signal.includes("MOMENTUM")).slice(0, 4);
    reply = ideas.length ? `Ideas educativas: ${ideas.map(a => `${a.symbol} (${a.signal})`).join(", ")}. Confirmaria con tendencia, noticia y tamano pequeno.` : "No veo compra clara ahorita. Mercado neutral: mejor paciencia que forzar entrada.";
  } else if (q.includes("noticia")) {
    reply = `Hay ${news.length} noticias cargadas. Las cruzo contra tus activos para mostrar impacto probable por ticker.`;
  } else if (q.includes("bot")) {
    reply = `El bot ficticio tiene equity ${money(botEq)}, P&L ${money(botPnl)} y ${bot.tradesCount} operaciones. Laboratorio, no piloto automatico real.`;
  } else if (q.includes("vigilar") || q.includes("daily scan") || q.includes("analiza portafolio") || q.includes("analizar portafolio") || q.includes("que harias") || q.includes("qué harías")) {
    const qcM = quiverCache.data ? matchQuiverToPortfolio(quiverCache.data) : { count: 0, tickers: [] };
    const s = buildScanData(pv, qcM);
    const topR = s.topRisk ? s.topRisk.symbol + " (score " + s.topRisk.score + ")" : "sin alerta critica";
    const topO = s.topOpportunity ? s.topOpportunity.symbol + " (score " + s.topOpportunity.score + ")" : "ninguna destacada";
    reply = `Scan diario: mayor riesgo hoy → ${topR}. Mejor oportunidad → ${topO}. Cripto: ${s.bitsoPct.toFixed(0)}% (${s.concentrationRisk}). Regimen: ${s.reg.label}. ${s.actionChecklist[0] || ""}`;
  } else {
    reply = `Cordelius activo. Portafolio ${money(pv.totalValueMXN)}, rendimiento ${pct(pv.totalGainPct)}, regimen ${reg.label}. Mejor score: ${best.symbol}; mas debil: ${worst.symbol}.`;
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
  const nodes = ["AAPL", "BBVA", "BTC", "ETH", "MSFT", "IREN", "PLTR", "COPX", "RISK", "NEWS", "AI", "BOT"];
  return `<div class="brain-card">
    <div class="brain-left">
      <div class="brain-title">Cerebro Alfredo AI</div>
      <div class="brain-sub">Red neuronal viva: noticias → portafolio → riesgo → decision</div>
      <div class="brain">
        ${nodes.map((n, i) => `<span class="brain-node n${i}">${n}<i class="pulse"></i></span>`).join("")}
        <svg viewBox="0 0 600 300" class="brain-lines" preserveAspectRatio="none">
          <path d="M80 80 C160 30 240 120 320 70 S500 60 540 150"/>
          <path d="M70 210 C150 130 260 250 350 180 S470 130 550 220"/>
          <path d="M110 150 C200 80 300 210 420 90"/>
          <path d="M150 250 C250 160 350 280 520 120"/>
          <path d="M60 120 C180 170 280 40 520 190"/>
        </svg>
      </div>
    </div>
    <div class="brain-feed">
      <div class="feed-title">Pensamientos en vivo</div>
      ${thoughts.length ? thoughts.map(t => `<div class="thought ${esc(t.level)}"><b>${esc(t.level.toUpperCase())}</b> ${esc(t.text)}<small>${esc(t.time)}</small></div>`).join("") : `<div class="thought scan">Esperando senales del mercado...</div>`}
    </div>
  </div>`;
}

function renderPortfolioRows(assets) {
  return assets.map(a => {
    const z = a.zones; const act = alfredoAction(a); const ind = a.ind;
    return `<details class="asset-row">
      <summary>
        <div class="asset-main">${logoHtml(a)}<div><b>${esc(a.display)}</b><span>${esc(a.name)}</span><em>${esc(a.source)} · ${esc(a.category)} · ${a.units} u</em></div></div>
        <div class="asset-money"><b>${a.currency === "USD" ? money(a.liveValue, "USD") : money(a.liveValue, "MXN")}</b>${a.currency === "USD" ? `<div class="muted" style="font-size:12px">~ ${money(a.valueMXN)}</div>` : ""}<span class="${a.gainPct >= 0 ? "green" : "red"}">${pct(a.gainPct)} · ${money(a.gainMXN)}</span></div>
      </summary>
      <div class="asset-detail">
        <div class="detail-chart">${miniSpark(a.symbol, a.gainPct >= 0 ? "#00ff99" : "#ff4d6d")}</div>
        <div class="ind-row">
          <div class="ind"><span>RSI</span><b class="${ind.rsi > 70 ? "red" : ind.rsi < 30 ? "green" : ""}">${ind.rsi}</b></div>
          <div class="ind"><span>MACD</span><b class="${ind.macd >= 0 ? "green" : "red"}">${ind.macd}</b></div>
          <div class="ind"><span>Momentum</span><b class="${ind.momentum >= 0 ? "green" : "red"}">${ind.momentum}</b></div>
          <div class="ind"><span>Tendencia</span><b>${ind.trend}</b></div>
          <div class="ind"><span>Volatilidad</span><b>${ind.volatility}</b></div>
          <div class="ind"><span>Score IA</span><b>${a.score}/100</b></div>
        </div>
        <div class="alfredo-score" style="border-color:${act.color}55">
          <div class="as-head"><b style="color:${act.color}">${act.action}</b><span class="muted">Alfredo Score ${act.score}/100</span></div>
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


function analyzeIntelText(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();

  const affected = PORTFOLIO
    .filter(a => lower.includes(String(a.symbol).toLowerCase()) || lower.includes(String(a.name || "").toLowerCase()))
    .map(a => a.symbol);

  const positiveWords = ["bullish", "sube", "subir", "compra", "buy", "crecimiento", "ai", "ia", "contrato", "earnings", "beneficio", "aprobado"];
  const negativeWords = ["bearish", "baja", "cae", "caida", "venta", "sell", "riesgo", "demanda", "regulacion", "hack", "multa", "recesion"];

  const pos = positiveWords.filter(w => lower.includes(w)).length;
  const neg = negativeWords.filter(w => lower.includes(w)).length;

  let mood = "NEUTRAL";
  if (pos > neg) mood = "POSITIVO";
  if (neg > pos) mood = "NEGATIVO";

  const tags = [];
  if (lower.includes("china") || lower.includes("asia")) tags.push("Asia/China");
  if (lower.includes("ai") || lower.includes("ia") || lower.includes("chips")) tags.push("IA/Tech");
  if (lower.includes("cobre") || lower.includes("copper")) tags.push("Cobre");
  if (lower.includes("crypto") || lower.includes("bitcoin") || lower.includes("btc")) tags.push("Cripto");
  if (lower.includes("congreso") || lower.includes("senado") || lower.includes("regulacion")) tags.push("Politica/Regulacion");

  return {
    text: raw.slice(0, 3000),
    affected,
    mood,
    tags,
    time: nowMX()
  };
}

function renderQuiverPanel() {
  try {
    if (!QUIVER_API_KEY) {
      return '<div class="quiver-box">'
        + '<div class="quiver-item"><div class="label">Estado</div><div class="big yellow">PENDIENTE</div><p class="muted">Agrega QUIVER_API_KEY en .env para datos del Congreso.</p></div>'
        + '<div class="quiver-item"><div class="label">Uso pensado</div><p>Compras de politicos, contratos, lobbying — cruzado contra tus activos.</p></div>'
        + '<div class="quiver-item"><div class="label">Activos sensibles</div><p>MSFT, AAPL, UNH, AEP, GEV, COPX, PLTR reaccionan a regulacion publica.</p></div>'
        + '</div>';
    }
    const qd = quiverCache.data;
    if (!qd) {
      return '<div class="panel"><div class="muted" style="padding:18px">Datos Quiver cargando... Refresca en unos segundos o espera el siguiente ciclo de actualizacion.</div></div>';
    }
    const matches = matchQuiverToPortfolio(qd);
    if (!matches.count) {
      return '<div class="panel"><div class="muted" style="padding:18px">Quiver configurado (' + (qd.count || 0) + ' registros congresistas) pero sin coincidencias con tu portafolio actual.</div></div>';
    }
    const topGroups = Object.values(matches.grouped || {}).sort((a, b) => b.count - a.count).slice(0, 6);
    const summaryHtml = topGroups.map(g =>
      '<div style="display:inline-flex;align-items:center;gap:6px;margin:4px;padding:5px 12px;border-radius:12px;border:1px solid rgba(59,157,255,.25);background:rgba(59,157,255,.08)">'
      + '<b style="color:#3b9dff">' + esc(g.ticker) + '</b>'
      + '<span class="muted" style="font-size:12px">×' + g.count + '</span>'
      + (g.buys ? ' <span style="color:#00ff99;font-size:11px;background:rgba(0,255,153,.1);padding:1px 6px;border-radius:999px">+' + g.buys + '</span>' : '')
      + (g.sales ? ' <span style="color:#ff4d6d;font-size:11px;background:rgba(255,77,109,.1);padding:1px 6px;border-radius:999px">−' + g.sales + '</span>' : '')
      + '</div>'
    ).join("");
    const rows = matches.items.slice(0, 40).map(m => {
      const tt = (m.transaction || "").toLowerCase();
      const isB = tt.includes("buy") || tt.includes("purchase");
      const isS = tt.includes("sale") || tt.includes("sell");
      const txColor = isB ? "#00ff99" : isS ? "#ff4d6d" : "#ffd35c";
      const txLabel = isB ? "COMPRA" : isS ? "VENTA" : "OTRO";
      return '<tr>'
        + '<td><b style="color:#3b9dff">' + esc(m.ticker) + '</b></td>'
        + '<td><span style="color:' + txColor + ';font-weight:800;font-size:12px">' + esc(txLabel) + '</span></td>'
        + '<td class="muted" style="font-size:13px;max-width:180px;overflow:hidden;text-overflow:ellipsis">' + esc(m.politician || "—") + '</td>'
        + '<td class="muted" style="font-size:13px">' + esc(String(m.amount || "—")) + '</td>'
        + '<td class="muted" style="font-size:12px">' + esc(String(m.date || "—").slice(0, 10)) + '</td>'
        + '</tr>';
    }).join("");
    return '<div class="panel" style="padding:18px">'
      + '<div style="margin-bottom:12px">' + summaryHtml + '</div>'
      + '<div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Tipo</th><th>Politico</th><th>Monto/Rango</th><th>Fecha</th></tr></thead><tbody>'
      + rows + '</tbody></table></div>'
      + '<div class="muted" style="font-size:12px;margin-top:8px">' + matches.count + ' coincidencias de ' + (qd.count || 0) + ' registros · Congressional Trading · <a href="/api/quiver/matches" target="_blank" style="color:#9fb3c8">JSON →</a></div>'
      + '</div>';
  } catch (e) {
    return '<div class="panel"><div class="muted">Quiver no disponible: ' + esc(String(e.message || "error")) + '</div></div>';
  }
}

function renderWatchTodayCard() {
  try {
    const qcMatches = quiverCache.data ? matchQuiverToPortfolio(quiverCache.data) : { count: 0, tickers: [], grouped: {} };
    const s = buildScanData(null, qcMatches);
    const riskColor = s.concentrationRisk === "MUY ALTO" || (s.topRisk && s.topRisk.score < 30) ? "#ff4d6d"
      : s.concentrationRisk === "ALTO" ? "#ffd166" : "#00ff99";
    const topRiskHtml = s.topRisk
      ? '<b style="color:#ff4d6d">' + esc(s.topRisk.symbol) + '</b> <span class="muted" style="font-size:13px">' + esc(s.topRisk.signal) + ' · score ' + s.topRisk.score + ' · ' + (s.topRisk.gainPct >= 0 ? "+" : "") + s.topRisk.gainPct + '%</span>'
      : '<span class="muted">Sin alerta critica</span>';
    const topOppHtml = s.topOpportunity
      ? '<b style="color:#00ff99">' + esc(s.topOpportunity.symbol) + '</b> <span class="muted" style="font-size:13px">' + esc(s.topOpportunity.signal) + ' · score ' + s.topOpportunity.score + '</span>'
      : '<span class="muted">Sin oportunidad destacada</span>';
    const checklistHtml = s.actionChecklist.slice(0, 5).map(item =>
      '<li style="margin:5px 0;color:#c7dff7;font-size:14px">' + esc(item) + '</li>'
    ).join("");
    const quiverChips = (qcMatches.tickers || []).slice(0, 6).map(t =>
      '<span style="background:rgba(59,157,255,.12);border:1px solid rgba(59,157,255,.25);border-radius:8px;padding:3px 10px;font-size:12px;margin:2px;display:inline-block">' + esc(t) + '</span>'
    ).join("") || '<span class="muted" style="font-size:12px">Sin datos Quiver aun</span>';
    return '<div class="panel" style="border-color:rgba(255,211,92,.35);background:rgba(255,211,92,.03)">'
      + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">'
      + '<div style="font-size:22px;font-weight:900;color:#ffd35c">Que debo vigilar hoy</div>'
      + '<div style="padding:3px 12px;border-radius:999px;border:1px solid ' + riskColor + '55;background:' + riskColor + '18;color:' + riskColor + ';font-size:12px;font-weight:800">Cripto: ' + esc(s.concentrationRisk) + ' · ' + s.bitsoPct.toFixed(0) + '%</div>'
      + '<div class="muted" style="font-size:12px">Regimen: ' + esc(s.reg.label) + ' · ' + new Date().toLocaleDateString("es-MX") + '</div>'
      + '<a href="/api/daily-scan" target="_blank" style="color:#9fb3c8;font-size:12px;text-decoration:none;margin-left:auto">JSON →</a>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:14px">'
      + '<div style="border:1px solid rgba(255,77,109,.2);border-radius:16px;padding:14px;background:rgba(255,77,109,.04)">'
      + '<div class="label" style="margin-bottom:8px;color:#ff4d6d">Mayor riesgo</div>' + topRiskHtml + '</div>'
      + '<div style="border:1px solid rgba(0,255,153,.2);border-radius:16px;padding:14px;background:rgba(0,255,153,.04)">'
      + '<div class="label" style="margin-bottom:8px;color:#00ff99">Mejor oportunidad</div>' + topOppHtml + '</div>'
      + '<div style="border:1px solid rgba(59,157,255,.2);border-radius:16px;padding:14px;background:rgba(59,157,255,.04)">'
      + '<div class="label" style="margin-bottom:8px;color:#3b9dff">Senales Quiver</div>' + quiverChips
      + (qcMatches.count ? '<div class="muted" style="font-size:11px;margin-top:5px">' + qcMatches.count + ' coincidencias politicas</div>' : '')
      + '</div>'
      + '</div>'
      + '<div class="label" style="margin-bottom:8px">Checklist educativo de hoy</div>'
      + '<ul style="padding-left:18px;margin:0">' + checklistHtml + '</ul>'
      + '</div>';
  } catch (e) {
    return '<div class="panel"><div class="muted">Vigilar hoy no disponible: ' + esc(String(e.message || "error")) + '</div></div>';
  }
}

function renderDailyScanCard() {
  try {
    const qcMatches = quiverCache.data ? matchQuiverToPortfolio(quiverCache.data) : { count: 0, tickers: [], grouped: {} };
    const s = buildScanData(null, qcMatches);
    const alerts = s.riskAlerts.slice(0, 3);
    const riskLevel = alerts.some(a => a.level === "CRITICO") ? "CRITICO"
      : alerts.some(a => a.level === "ALTO") ? "ALTO"
      : alerts.some(a => a.level === "ATENCION") ? "ATENCION" : "NORMAL";
    const riskColor = (riskLevel === "CRITICO" || riskLevel === "ALTO") ? "#ff4d6d"
      : riskLevel === "ATENCION" ? "#ffd166" : "#00ff99";
    const alertRows = alerts.map(a => {
      const lc = (a.level === "CRITICO" || a.level === "ALTO") ? "#ff4d6d" : a.level === "ATENCION" ? "#ffd166" : "#00ff99";
      return '<div style="border-left:3px solid ' + lc + ';padding:8px 12px;margin:6px 0;background:rgba(255,255,255,.03);border-radius:0 10px 10px 0">'
        + '<b style="color:' + lc + ';font-size:12px">' + esc(a.level) + '</b> <b style="font-size:13px">' + esc(a.title || a.symbol) + '</b>'
        + (a.reason ? '<div class="muted" style="font-size:12px;margin-top:2px">' + esc(a.reason) + '</div>' : '')
        + (a.educationalAction ? '<div style="color:#9bd3ff;font-size:12px;margin-top:1px">' + esc(a.educationalAction) + '</div>' : '')
        + '</div>';
    }).join("") || '<div class="muted" style="font-size:13px">Sin alertas criticas.</div>';
    const topGroups = Object.values(qcMatches.grouped || {}).sort((a, b) => b.count - a.count).slice(0, 5);
    const quiverHtml = topGroups.length ? topGroups.map(g =>
      '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(120,160,210,.08)">'
      + '<span style="font-weight:800;color:#3b9dff;min-width:52px">' + esc(g.ticker) + '</span>'
      + '<span class="muted" style="font-size:12px">×' + g.count + '</span>'
      + (g.buys ? ' <span style="color:#00ff99;font-size:11px">+' + g.buys + '</span>' : '')
      + (g.sales ? ' <span style="color:#ff4d6d;font-size:11px">−' + g.sales + '</span>' : '')
      + '</div>'
    ).join("") : '<span class="muted" style="font-size:13px">Sin coincidencias Quiver</span>';
    return '<div class="panel" style="border-color:rgba(59,157,255,.35)">'
      + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">'
      + '<div style="font-size:22px;font-weight:900;background:linear-gradient(90deg,#00ff99,#3b9dff);-webkit-background-clip:text;-webkit-text-fill-color:transparent">SCAN DIARIO</div>'
      + '<div style="padding:4px 12px;border-radius:999px;border:1px solid ' + riskColor + '55;background:' + riskColor + '18;color:' + riskColor + ';font-size:12px;font-weight:800">' + esc(riskLevel) + '</div>'
      + '<div class="muted" style="font-size:12px">' + new Date().toLocaleDateString("es-MX") + ' · ' + esc(s.reg.label) + '</div>'
      + '<a href="/api/daily-scan" target="_blank" style="color:#9fb3c8;font-size:12px;text-decoration:none;margin-left:auto">Ver JSON</a>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">'
      + '<div><div class="label" style="margin-bottom:8px">Top alertas</div>' + alertRows + '</div>'
      + '<div><div class="label" style="margin-bottom:8px">Quiver en portafolio</div>' + quiverHtml
      + '<div class="muted" style="font-size:12px;margin-top:6px">'
      + qcMatches.count + ' total · '
      + (s.biggestWinner ? 'mayor ganancia: ' + esc(s.biggestWinner.symbol) + ' (' + (s.biggestWinner.gainPct >= 0 ? '+' : '') + s.biggestWinner.gainPct + '%)' : '')
      + (s.weakestTechnical ? ' · RSI mas bajo: ' + esc(s.weakestTechnical.symbol) + ' (' + s.weakestTechnical.rsi + ')' : '')
      + '</div></div>'
      + '</div>'
      + '<div style="margin-top:14px;padding:12px 14px;border-radius:14px;background:rgba(59,157,255,.06);border:1px solid rgba(59,157,255,.15);color:#c7dff7;font-size:13px;line-height:1.6">'
      + '<b style="color:#3b9dff;font-size:11px;letter-spacing:.08em">RESUMEN EDUCATIVO</b><br>'
      + esc(s.educationalSummary)
      + '</div>'
      + '</div>';
  } catch (e) {
    return '<div class="panel"><div class="muted">Scan diario no disponible: ' + esc(String(e.message || "error")) + '</div></div>';
  }
}

function renderIntelPanel() {
  const rows = (intelItems || []).slice(0, 10).map(function(x) {
    const moodClass = x.mood === "POSITIVO" ? "green" : (x.mood === "NEGATIVO" ? "red" : "yellow");
    const affected = (x.affected && x.affected.length) ? x.affected.join(", ") : "Sin activo directo";
    const tags = (x.tags && x.tags.length) ? x.tags.join(" · ") : "General";

    return '<div class="news-card">'
      + '<div><b class="' + moodClass + '">' + esc(x.mood) + '</b><div class="muted">' + esc(x.time) + '</div></div>'
      + '<div><div><b>Activos afectados:</b> ' + esc(affected) + '</div>'
      + '<div class="muted">' + esc(tags) + '</div>'
      + '<p>' + esc(x.text).slice(0, 700) + '</p></div>'
      + '</div>';
  }).join("") || '<div class="msg muted">Todavia no hay analisis pegado. Pega texto de Grok, X o noticias.</div>';

  return '<div class="panel">'
    + '<form method="POST" action="/intel">'
    + '<textarea name="intel" style="width:100%;min-height:150px;border-radius:18px;background:#07111f;color:#e5f2ff;border:1px solid rgba(120,160,210,.25);padding:14px;font-size:15px" placeholder="Pega aqui analisis de Grok, X, noticias, China, IA, cripto, cobre, politica, etc..."></textarea>'
    + '<div style="margin-top:12px"><button class="btn">Guardar analisis</button></div>'
    + '</form>'
    + '<p class="muted">Modo manual: pega texto externo y Cordelius lo cruza contra tus activos. No opera dinero real.</p>'
    + '</div>'
    + '<div class="panel">' + rows + '</div>';
}

function renderNews() {
  if (!news.length) return `<div class="muted">Cargando noticias...</div>`;
  return news.map(n => {
    const c = n.classification;
    const img = n.image ? `<img class="news-img" src="${esc(n.image)}" alt="">` : `<div class="news-img placeholder">NEWS</div>`;
    const impacted = n.impacted && n.impacted.length ? n.impacted : ["Mercado"];
    return `<div class="news-card">${img}<div class="news-body">
      <div class="chips"><span>${esc(c.type)}</span><span style="background:${c.impactColor}22;border-color:${c.impactColor}55;color:${c.impactColor}">${esc(c.impact)} · ${c.confidence}%</span><span>${esc(c.region)}</span><span>${esc(n.source || "Fuente")}</span></div>
      <h3>${esc(n.headline || "Sin titulo")}</h3>
      <p>${esc((n.summary || "").slice(0, 240))}</p>
      <div class="impact"><b>Activos posiblemente impactados:</b>${impacted.map(x => `<span>${esc(x)}</span>`).join("")}</div>
      <div class="why">Lectura Alfredo: puede mover sentimiento, liquidez o sector. No es comprar/vender automatico; sirve para saber que vigilar.</div>
      <a target="_blank" href="${esc(n.url || "#")}">Abrir fuente</a>
    </div></div>`;
  }).join("");
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
nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
nav a,.btn{border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--text);text-decoration:none;border-radius:14px;padding:11px 16px;font-weight:700;cursor:pointer;transition:.2s}
.btn:hover,nav a:hover{background:rgba(59,157,255,.14);border-color:#3b9dff}
.grid{max-width:1280px;margin:16px auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
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
.brain-node{position:absolute;display:grid;place-items:center;min-width:56px;height:36px;padding:0 10px;border-radius:999px;font-weight:900;font-size:13px;border:1px solid rgba(120,160,210,.22);background:rgba(8,18,36,.9);box-shadow:0 0 22px rgba(59,157,255,.3);z-index:3}
.brain-node .pulse{position:absolute;inset:-4px;border-radius:999px;border:1px solid rgba(0,255,153,.4);animation:ping 2.4s ease-out infinite}
@keyframes ping{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.6);opacity:0}}
.n0{left:9%;top:16%}.n1{left:25%;top:8%}.n2{left:44%;top:20%}.n3{left:68%;top:11%}.n4{left:12%;top:52%}.n5{left:34%;top:44%}.n6{left:55%;top:52%}.n7{left:76%;top:45%}.n8{left:18%;top:78%}.n9{left:44%;top:76%}.n10{left:65%;top:74%}.n11{left:82%;top:72%}
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
    <div class="app-icon">A</div>
    <div><h1>${esc(settings.appName)}</h1><div class="subtitle">Alfredo AI · portafolio real · noticias inteligentes · cerebro de trading simulado</div></div>
  </div>
  <nav>
    <a href="#watchtoday">Vigilar hoy</a><a href="#scan">Scan Diario</a><a href="#portfolio">Portafolio</a>
    <a href="#quiver">Quiver</a><a href="#chart">Grafica</a><a href="#alfredo">Alfredo AI</a><a href="#system">Sistema</a>
  </nav>
</header>

<div class="toolbar">
  <a class="switch" href="/toggle-thinking"><span class="dot"></span>Thinking Mode: <b>${settings.thinkingEnabled ? "ON" : "OFF"}</b></a>
  <span class="switch">Refresh: <b>${settings.autoRefreshSeconds}s</b></span>
  <span class="switch">Finnhub: <b class="${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</b></span>
  <span class="switch">Claude: <b class="${ANTHROPIC_API_KEY ? "green" : "yellow"}">${ANTHROPIC_API_KEY ? "OK" : "SIN KEY"}</b></span>
</div>

<div class="grid">
  ${(function(){var A=pv.assets||[];var tot=pv.totalValueMXN||1;var gbm=A.filter(function(a){return a.source==="GBM";}).reduce(function(s,a){return s+a.valueMXN;},0);var plata=A.filter(function(a){return a.source==="Plata";}).reduce(function(s,a){return s+a.valueMXN;},0);var bitso=A.filter(function(a){return a.source==="Bitso";}).reduce(function(s,a){return s+a.valueMXN;},0);var cripto=A.filter(function(a){return a.type==="crypto";}).reduce(function(s,a){return s+a.valueMXN;},0);var cp=cripto/tot*100;var estado=cp>45?"AGRESIVO":(cp<20?"DEFENSIVO":"NEUTRAL");var ec=estado==="AGRESIVO"?"#ff4d6d":(estado==="DEFENSIVO"?"#00ff99":"#ffd35c");function pp(x){return (x/tot*100).toFixed(1)+"%";}return `<div class="card"><div class="label">Estado general</div><div class="big" style="color:${ec}">${estado}</div><div class="muted">Cripto ${cp.toFixed(0)}% · educativo, no asesoria</div></div><div class="card"><div class="label">Exposicion por plataforma</div><div>GBM ${pp(gbm)}</div><div>Plata ${pp(plata)}</div><div>Bitso ${pp(bitso)}</div></div><div class="card"><div class="label">Exposicion por divisa</div><div>USD ${pp(plata)}</div><div>MXN ${pp(gbm+bitso)}</div><div>Cripto ${pp(bitso)}</div></div><div class="card"><div class="label">Tipo de cambio</div><div class="big">$${FX_USD_MXN.toFixed(2)}</div><div class="muted">USD a MXN · .env USD_MXN o fallback · ${nowMX()}</div></div>`;})()}<div class="card"><div class="label">Patrimonio total estimado</div><div class="big green glow">${money(pv.totalValueMXN)}</div><div class="${pv.totalGainPct >= 0 ? "green" : "red"}">${pct(pv.totalGainPct)} · ${money(pv.totalGainMXN)}</div></div>
  <div class="card"><div class="label">Regimen</div><div class="big" style="color:${reg.color}">${esc(reg.label)}</div><div class="muted">${pct(reg.avg)} · ${esc(reg.detail)}</div></div>
  <div class="card"><div class="label">Mejor score</div><div class="big green">${esc(best.symbol)}</div><div>${esc(best.signal)} · ${best.score}/100</div></div>
  <div class="card"><div class="label">Mas debil</div><div class="big red">${esc(worst.symbol)}</div><div>${esc(worst.signal)} · ${worst.score}/100</div></div>
</div>

<a id="watchtoday"></a><h2>Que debo vigilar hoy</h2>${renderWatchTodayCard()}

<a id="scan"></a><h2>Scan Diario — portafolio + Quiver + senales</h2>${renderDailyScanCard()}

<a id="portfolio"></a><h2>Portafolio real por cuenta</h2>
${Object.entries(grouped).map(([k, list]) => `<h2 style="font-size:21px;margin-top:22px">${esc(k)}</h2>${renderPortfolioRows(list)}`).join("")}

<h2>Ranking Alfredo con zonas educativas</h2>
<div class="ranking">${ranked.map((a, i) => `<div class="rank"><div><b>${i + 1}. ${esc(a.symbol)}</b><div class="muted">${esc(a.source)} · ${esc(a.risk)} · ${esc(a.signal)}</div></div><div><div class="bar"><span style="width:${a.score}%"></span></div><div class="muted">Compra ${a.currency === "USD" ? money(a.zones.buy, "USD") : money(a.zones.buy)} · Venta ${a.currency === "USD" ? money(a.zones.sell, "USD") : money(a.zones.sell)}</div></div><div><b>${a.score}/100</b></div></div>`).join("")}</div>

<a id="news"></a><h2>Noticias inteligentes + activos impactados</h2>${renderNews()}

<a id="quiver"></a><h2>Quiver — Congreso · Insiders · Contratos <span style="background:${QUIVER_API_KEY ? '#00ff99' : '#ffd166'};color:#000;border-radius:99px;padding:2px 10px;font-size:12px;font-weight:900;vertical-align:middle;margin-left:8px">${QUIVER_API_KEY ? 'LIVE' : 'PENDIENTE'}</span></h2>
${renderQuiverPanel()}

<a id="chart"></a><h2>Grafica avanzada del portafolio</h2>
<div class="panel">${spark(portfolioHistory, { key: "total", color: "#3b9dff", height: 300 })}<div class="muted">Eje, max, min, area y variacion. Se guarda en ${esc(HISTORY_FILE)}.</div></div>
<h2>Chart profesional (${esc(best.symbol)}) — TradingView</h2>
<div class="tv-embed"><iframe src="https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(topTV)}&interval=D&theme=dark&style=1&hidesidetoolbar=0&saveimage=0&studies=RSI@tv-basicstudies,MACD@tv-basicstudies" style="width:100%;height:100%;border:0"></iframe></div>

<a id="brain"></a><h2>Cerebro vivo de Cordelius</h2>${brainHtml()}

<a id="alfredo"></a><h2>Alfredo AI — asistente interno</h2>
<div class="panel"><details class="chat-details" open>
  <summary>Mostrar / esconder chat de Alfredo AI</summary>
  <div class="muted">Apaga Thinking Mode arriba para no gastar Claude. Si esta OFF, responde en modo local.</div>
  <form class="chatbox" method="POST" action="/ask"><input name="q" placeholder="Preguntale a Alfredo: riesgo, vender, comprar, noticias, bot, vigilar hoy, analiza portafolio..." autocomplete="off"><button class="btn">Preguntar</button></form>
  ${chatHtml || '<div class="msg muted">Sin preguntas todavia.</div>'}
</details></div>

<a id="bot"></a><h2>Trading AI ficticio — laboratorio</h2>
<div class="grid">
  ${renderBotMetricCards()}
</div>
<div class="panel">
  <a class="btn" href="/bot/start">Start</a> <a class="btn" href="/bot/pause">Pause</a> <a class="btn" href="/bot/reset">Reset</a>
  <p class="muted">PAPER TRADING / SIMULACION — NO USA DINERO REAL. Simula tendencia, score, riesgo, tamano y salida.</p>
  ${spark(bot.equityHistory, { key: "v", color: "#00ff99", height: 240 })}
</div>
<h2>Posiciones simuladas</h2>
<div class="panel table-wrap"><table><thead><tr><th>Activo</th><th>Unidades</th><th>Avg</th><th>Precio</th><th>Valor</th><th>P&L</th><th>SL</th><th>TP</th></tr></thead><tbody>${botTables.posRows}</tbody></table></div>
<h2>Bitacora del bot</h2>
<div class="panel table-wrap"><table><thead><tr><th>Tipo</th><th>Activo</th><th>Unidades</th><th>Precio</th><th>Valor</th><th>P&L</th><th>Hora</th><th>Razon</th></tr></thead><tbody>${botTables.histRows}</tbody></table></div>

<a id="intel"></a><h2>Cordelius Intelligence — Grok / X manual</h2>${renderIntelPanel()}

<a id="modulos"></a><h2>Modulos Cordelius (proximamente)</h2><div class="grid"><div class="card"><div class="label">Cordelius Health</div><div class="big" style="color:#818cf8">Proximamente</div><div class="muted">WHOOP API: sueno, HRV, recuperacion, habitos (pendiente)</div></div><div class="card"><div class="label">Cordelius Law</div><div class="big" style="color:#ffd35c">Proximamente</div><div class="muted">Cuaderno juridico, apuntes, casos (pendiente)</div></div><div class="card"><div class="label">Cordelius Intelligence</div><div class="big" style="color:#3b9dff">Grok / X manual</div><div class="muted">Pegar analisis de X o Grok (pendiente P2)</div></div><div class="card"><div class="label">Asia / China Tech</div><div class="big" style="color:#00ff99">Radar</div><div class="muted">Chips, cobre, IA, energia (pendiente, sin fuente)</div></div><div class="card"><div class="label">Alpaca</div><div class="big" style="color:#ffd35c">Pendiente</div><div class="muted">Solo paper trading futuro, sin ordenes reales</div></div></div><a id="system"></a><h2>Sistema</h2>
<div class="grid">
  <div class="card"><div class="label">App</div><div class="big green">${esc(settings.appName)}</div></div>
  <div class="card"><div class="label">Alfredo AI</div><div class="big ${settings.thinkingEnabled ? "green" : "yellow"}">${settings.thinkingEnabled ? "THINKING" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Finnhub</div><div class="big ${FINNHUB_API_KEY ? "green" : "yellow"}">${FINNHUB_API_KEY ? "OK" : "LOCAL"}</div></div>
  <div class="card"><div class="label">Quiver</div><div class="big ${QUIVER_API_KEY ? "green" : "yellow"}">${QUIVER_API_KEY ? "OK" : "PENDIENTE"}</div></div>
</div>

<div class="disclaimer">Cordelius Trading es educativo. No es asesoria financiera. El bot es 100% ficticio (paper trading) y no se conecta a ningun exchange real.</div>

<div id="quiver-live-card" style="
  position:fixed;
  right:16px;
  bottom:16px;
  z-index:9999;
  max-width:360px;
  padding:14px;
  border:1px solid rgba(0,255,153,.25);
  border-radius:18px;
  background:rgba(2,4,10,.88);
  backdrop-filter:blur(12px);
  box-shadow:0 0 30px rgba(0,255,153,.12);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
">
  <div style="font-size:12px;color:#9fb3c8;margin-bottom:4px;">QUiVER x PORTAFOLIO</div>
  <div id="quiver-live-title" style="font-size:20px;font-weight:800;color:#00ff99;">Cargando...</div>
  <div id="quiver-live-body" style="font-size:13px;color:#eaf6ff;margin-top:8px;line-height:1.35;"></div>
</div>

<script>
(async function(){
  try {
    const r = await fetch('/api/quiver/matches');
    const j = await r.json();

    const title = document.getElementById('quiver-live-title');
    const body = document.getElementById('quiver-live-body');

    const count = j.portfolioMatches?.count || 0;
    const tickers = j.portfolioMatches?.tickers || [];

    title.textContent = count + ' matches políticos';
    body.innerHTML =
      '<b>Quiver:</b> ' + (j.quiverCount || 0) + ' registros<br>' +
      '<b>Tickers:</b> ' + (tickers.length ? tickers.slice(0,8).join(', ') : 'Sin matches') + '<br>' +
      '<span style="color:#9fb3c8">Cruce real contra tu portafolio.</span>';
  } catch(e) {
    document.getElementById('quiver-live-title').textContent = 'Quiver error';
    document.getElementById('quiver-live-body').textContent = e.message;
  }
})();
</script>

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
      intelItems.unshift(analyzeIntelText(text.trim()));
      intelItems = intelItems.slice(0, 30);
      saveJSON(INTEL_FILE, intelItems);
      addThought("Nuevo analisis manual agregado a Cordelius Intelligence.", "scan");
    }
    res.writeHead(302, { Location: "/#intel" });
    res.end();
  });
}


// Quiver real fetcher: intenta leer datos de Quiver usando QUIVER_API_KEY.
async function fetchQuiverDataReal() {
  if (!QUIVER_API_KEY) {
    return {
      ok: true,
      configured: false,
      count: 0,
      items: [],
      message: "QUIVER_API_KEY not configured"
    };
  }
  if (quiverCache.data && (Date.now() - quiverCache.ts < quiverCache.TTL_MS)) {
    return quiverCache.data;
  }

  const url = "https://api.quiverquant.com/beta/live/congresstrading";

  try {
    const r = await fetch(url, {
      headers: {
        "X-API-KEY": QUIVER_API_KEY,
        "Accept": "application/json",
        "User-Agent": "Cordelius-Trading/1.0"
      }
    });

    const text = await r.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        configured: true,
        count: 0,
        items: [],
        source: url,
        status: r.status,
        message: "Quiver returned non-JSON response",
        error: text.slice(0, 300)
      };
    }

    const arr = Array.isArray(data)
      ? data
      : data && Array.isArray(data.data)
        ? data.data
        : [];

    const normalized = arr.slice(0, 1000).map((x, i) => {
      const ticker =
        x.Ticker || x.ticker || x.Symbol || x.symbol || x.Stock || x.stock || "";

      const politician =
        x.Representative || x.representative ||
        x.Senator || x.senator ||
        x.Name || x.name ||
        x.Politician || x.politician || "";

      const transaction =
        x.Transaction || x.transaction ||
        x.Type || x.type ||
        x.Action || x.action || "";

      const amount =
        x.Amount || x.amount ||
        x.Range || x.range ||
        x.Value || x.value || "";

      const date =
        x.TransactionDate || x.transactionDate ||
        x.Date || x.date ||
        x.ReportDate || x.reportDate || "";

      return {
        id: i + 1,
        ticker,
        politician,
        transaction,
        amount,
        date,
        raw: x
      };
    });

    const result = {
      ok: true,
      configured: true,
      ts: Date.now(),
      source: url,
      authMode: "X-API-KEY",
      status: r.status,
      count: normalized.length,
      items: normalized,
      message: normalized.length ? "Quiver congressional trading loaded" : "Quiver responded but returned 0 rows"
    };
    quiverCache.data = result;
    quiverCache.ts = Date.now();
    return result;
  } catch (e) {
    return {
      ok: false,
      configured: true,
      count: 0,
      items: [],
      source: url,
      message: "Quiver fetch failed",
      error: e.message
    };
  }
}



function matchQuiverToPortfolio(quiverPayload) {
  const myPortfolio =
    (typeof portfolio !== "undefined" && Array.isArray(portfolio)) ? portfolio :
    (typeof PORTFOLIO !== "undefined" && Array.isArray(PORTFOLIO)) ? PORTFOLIO :
    (typeof ASSETS !== "undefined" && Array.isArray(ASSETS)) ? ASSETS :
    (typeof assets !== "undefined" && Array.isArray(assets)) ? assets :
    [];

  const items = Array.isArray(quiverPayload?.items) ? quiverPayload.items : [];
  const myTickers = new Set(myPortfolio.map(a => String(a.symbol || "").toUpperCase()));

  const matches = items
    .filter(x => myTickers.has(String(x.ticker || "").toUpperCase()))
    .map(x => {
      const ticker = String(x.ticker || "").toUpperCase();
      const asset = myPortfolio.find(a => String(a.symbol || "").toUpperCase() === ticker);
      return {
        ticker,
        assetName: asset?.name || "",
        source: asset?.source || "",
        category: asset?.category || "",
        politician: x.politician || x.raw?.Representative || x.Representative || "",
        transaction: x.transaction || x.raw?.Transaction || x.Transaction || "",
        amount: x.amount || x.raw?.Amount || x.Amount || x.raw?.Range || x.Range || "",
        date: x.date || x.raw?.TransactionDate || x.TransactionDate || "",
        raw: x.raw || x
      };
    });

  const tickers = [...new Set(matches.map(x => x.ticker))];

  const grouped = {};
  for (const m of matches) {
    if (!grouped[m.ticker]) grouped[m.ticker] = { ticker: m.ticker, count: 0, buys: 0, sales: 0, others: 0, latestDate: null, totalReportedMin: 0, items: [] };
    grouped[m.ticker].count++;
    const tt = (m.transaction || "").toLowerCase();
    if (tt.includes("buy") || tt.includes("purchase")) grouped[m.ticker].buys++;
    else if (tt.includes("sale") || tt.includes("sell")) grouped[m.ticker].sales++;
    else grouped[m.ticker].others++;
    if (m.date && (!grouped[m.ticker].latestDate || m.date > grouped[m.ticker].latestDate)) grouped[m.ticker].latestDate = m.date;
    const amt = parseFloat(String(m.amount || "").replace(/[^0-9.]/g, "")) || 0;
    grouped[m.ticker].totalReportedMin += amt;
    grouped[m.ticker].items.push(m);
  }

  return {
    count: matches.length,
    tickers,
    items: matches.slice(0, 50),
    grouped
  };
}


function buildScanData(pvData, matchesData) {
  const pv = pvData || portfolioValue();
  const reg = marketRegime();
  const ranked = pv.assets.slice().sort((a, b) => b.score - a.score);
  const totalMXN = pv.totalValueMXN || 1;
  const bitsoPct = pv.assets.filter(a => a.source === "Bitso").reduce((s, a) => s + a.valueMXN, 0) / totalMXN * 100;
  const cryptoSyms = pv.assets.filter(a => a.type === "crypto" || a.source === "Bitso").map(a => a.symbol);
  const matches = matchesData || { count: 0, tickers: [], items: [], grouped: {} };

  const biggestWinner = pv.assets.reduce((p, c) => c.gainPct > p.gainPct ? c : p, pv.assets[0]);
  const biggestLoser  = pv.assets.reduce((p, c) => c.gainPct < p.gainPct ? c : p, pv.assets[0]);
  const weakestTechnical = pv.assets.slice().sort((a, b) => a.ind.rsi - b.ind.rsi)[0];
  const topOpportunityAsset = pv.assets.filter(a => a.score > 50 && a.gainPct < 20).sort((a, b) => b.score - a.score)[0] || ranked[0];
  const topRiskAsset = pv.assets.filter(a => a.risk === "ALTO" || a.score < 40).sort((a, b) => a.score - b.score)[0] || ranked[ranked.length - 1];
  const concentrationRisk = bitsoPct > 60 ? "MUY ALTO" : bitsoPct > 45 ? "ALTO" : bitsoPct > 30 ? "MEDIO" : "NORMAL";

  const riskAlerts = [];
  if (bitsoPct > 45) riskAlerts.push({ level: "ALTO", type: "CONCENTRACION", symbol: "PORTAFOLIO",
    title: "Concentracion cripto alta",
    reason: "Cripto/Bitso " + bitsoPct.toFixed(0) + "% del portafolio. Alta correlacion en caidas.",
    educationalAction: "Considera diversificar gradualmente hacia GBM o instrumentos de deuda." });
  for (const a of pv.assets) {
    if (a.gainPct < -15 && a.risk === "ALTO") riskAlerts.push({ level: "ALTO", type: "DRAWDOWN", symbol: a.symbol,
      title: a.symbol + " en drawdown con riesgo alto",
      reason: "Perdida " + a.gainPct.toFixed(1) + "% — activo de riesgo ALTO.",
      educationalAction: "Revisar tesis. Considerar stop educativo si cae otro 5%." });
    if (a.score < 30) riskAlerts.push({ level: "CRITICO", type: "SCORE_CRITICO", symbol: a.symbol,
      title: a.symbol + " score critico (" + a.score + "/100)",
      reason: "Senales tecnicas debiles: " + a.signal,
      educationalAction: "No promediar a la baja. Esperar confirmacion." });
    if (a.gainPct > 80 && a.ind.momentum > 0) riskAlerts.push({ level: "OPORTUNIDAD", type: "TOMA_GANANCIA", symbol: a.symbol,
      title: a.symbol + " +" + a.gainPct.toFixed(0) + "% — posible toma parcial",
      reason: "Ganancia alta con momentum positivo.",
      educationalAction: "Evaluar venta parcial del 20-30%. Protege capital ganado." });
  }

  const actionChecklist = [];
  if (riskAlerts.some(r => r.level === "CRITICO")) actionChecklist.push("Revisa activos con score critico hoy");
  if (bitsoPct > 45) actionChecklist.push("Evalua rebalanceo cripto — concentracion " + bitsoPct.toFixed(0) + "%");
  if (matches.count > 0) actionChecklist.push("Revisa " + matches.count + " coincidencias Quiver en tu portafolio");
  if (biggestWinner && biggestWinner.gainPct > 60) actionChecklist.push("Considera toma parcial en " + biggestWinner.symbol + " (+" + biggestWinner.gainPct.toFixed(0) + "%)");
  if (weakestTechnical && weakestTechnical.ind.rsi < 35) actionChecklist.push(weakestTechnical.symbol + " con RSI bajo (" + weakestTechnical.ind.rsi + ") — posible rebote");
  if (!actionChecklist.length) actionChecklist.push("Sin alertas criticas hoy. Mantener y monitorear regimen " + reg.label + ".");

  const educationalSummary = [
    bitsoPct > 60 ? "Concentracion cripto muy alta (" + bitsoPct.toFixed(0) + "%). Bitso domina — revisa exposicion." :
    bitsoPct > 45 ? "Cripto/Bitso sobre 45% (" + bitsoPct.toFixed(0) + "%) — vigilar correlacion en caidas." : null,
    matches.count > 0 ? matches.count + " coincidencias Quiver en tu portafolio (congreso)." : null,
    "Mejor: " + ranked[0].symbol + " (score " + ranked[0].score + "/100, " + (ranked[0].gainPct >= 0 ? "+" : "") + ranked[0].gainPct.toFixed(0) + "%).",
    "A vigilar: " + ranked[ranked.length - 1].symbol + " (score " + ranked[ranked.length - 1].score + "/100).",
    "Regimen: " + reg.label + ". " + reg.detail,
    "EDUCATIVO: no es asesoria financiera."
  ].filter(Boolean).join(" ");

  return {
    pv, reg, ranked, bitsoPct, cryptoSyms, concentrationRisk,
    topRisk: topRiskAsset ? { symbol: topRiskAsset.symbol, score: topRiskAsset.score, risk: topRiskAsset.risk, gainPct: +topRiskAsset.gainPct.toFixed(2), signal: topRiskAsset.signal } : null,
    topOpportunity: topOpportunityAsset ? { symbol: topOpportunityAsset.symbol, score: topOpportunityAsset.score, gainPct: +topOpportunityAsset.gainPct.toFixed(2), signal: topOpportunityAsset.signal } : null,
    weakestTechnical: weakestTechnical ? { symbol: weakestTechnical.symbol, rsi: weakestTechnical.ind.rsi, score: weakestTechnical.score } : null,
    biggestWinner: biggestWinner ? { symbol: biggestWinner.symbol, gainPct: +biggestWinner.gainPct.toFixed(2) } : null,
    biggestLoser: biggestLoser ? { symbol: biggestLoser.symbol, gainPct: +biggestLoser.gainPct.toFixed(2) } : null,
    riskAlerts: riskAlerts.slice(0, 8),
    actionChecklist,
    educationalSummary,
    quiverMatches: matches
  };
}

async function computeDailyScanSafe() {
  let quiver = { count: 0, items: [] };
  let matches = { count: 0, tickers: [], items: [], grouped: {} };
  try {
    quiver = await fetchQuiverDataReal();
    matches = matchQuiverToPortfolio(quiver);
  } catch (e) {
    matches = { count: 0, tickers: [], items: [], grouped: {}, error: e.message };
  }
  const pv = portfolioValue();
  const s = buildScanData(pv, matches);
  return {
    ok: true,
    date: new Date().toLocaleDateString("es-MX"),
    ts: Date.now(),
    portfolioValue: +pv.totalValueMXN.toFixed(2),
    portfolioCost: +pv.totalCostMXN.toFixed(2),
    portfolioGainPct: +pv.totalGainPct.toFixed(2),
    assets: pv.assets.length,
    regime: s.reg.label,
    topRisk: s.topRisk,
    topOpportunity: s.topOpportunity,
    weakestTechnical: s.weakestTechnical,
    biggestWinner: s.biggestWinner,
    biggestLoser: s.biggestLoser,
    concentrationRisk: s.concentrationRisk,
    cryptoExposurePct: +s.bitsoPct.toFixed(1),
    quiverMatches: {
      count: matches.count,
      tickers: matches.tickers,
      items: matches.items.slice(0, 30),
      grouped: matches.grouped
    },
    riskAlerts: s.riskAlerts,
    actionChecklist: s.actionChecklist,
    educationalSummary: s.educationalSummary,
    quiverConfigured: !!QUIVER_API_KEY,
    quiverCount: quiver.count || 0
  };
}

const server = http.createServer(async (req, res) => {
  req.originalUrl = req.url;
  req.url = (req.url || "").split("?")[0];
  const reqPath = req.url;

  

  if (req.url === "/api/daily-scan") {
    try {
      const payload = await computeDailyScanSafe();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (req.method === "POST" && req.url === "/ask") return handleAsk(req, res);
  if (req.method === "POST" && req.url === "/intel") return handleIntel(req, res);
  if (req.url === "/toggle-thinking") {
    settings.thinkingEnabled = !settings.thinkingEnabled;
    settings.autoRefreshSeconds = settings.thinkingEnabled ? 60 : 120;
    saveJSON(SETTINGS_FILE, settings);
    res.writeHead(302, { Location: "/#alfredo" }); return res.end();
  }
  if (req.url === "/bot/start") { bot.running = true; addThought("Bot ficticio encendido.", "scan"); saveJSON(BOT_FILE, bot); res.writeHead(302, { Location: "/#bot" }); return res.end(); }
  if (req.url === "/bot/pause") { bot.running = false; addThought("Bot ficticio pausado.", "warn"); saveJSON(BOT_FILE, bot); res.writeHead(302, { Location: "/#bot" }); return res.end(); }
  if (req.url === "/bot/reset") {
    bot = { initialCapital: 1000, cash: 1000, positions: {}, history: [], equityHistory: [], thoughts: [], running: true, totalRealizedPnl: 0, maxDrawdown: 0, tradesCount: 0, lastTick: null };
    addThought("Bot reiniciado desde cero.", "scan"); saveJSON(BOT_FILE, bot);
    res.writeHead(302, { Location: "/#bot" }); return res.end();
  }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()) }));
  }
  if (req.url === "/api/status") {
    const pv = portfolioValue();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true, ts: Date.now(), uptime: Math.floor(process.uptime()),
      portfolio: { totalMXN: pv.totalValueMXN, gainPct: pv.totalGainPct, assets: pv.assets.length },
      bot: { running: bot.running, cash: bot.cash, trades: bot.tradesCount },
      intel: { count: intelItems.length },
      settings: { thinkingEnabled: settings.thinkingEnabled, theme: settings.themeMode }
    }));
  }
  if (req.url === "/api/portfolio") {
    const pv = portfolioValue();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), ...pv }));
  }

  if (req.url === "/api/quiver") {
    const payload = await fetchQuiverDataReal();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(payload));
  }

  if (req.url === "/api/quiver/matches") {
    const quiver = await fetchQuiverDataReal();
    const matches = matchQuiverToPortfolio(quiver);
    const payload = {
      ok: true,
      ts: Date.now(),
      quiverConfigured: !!QUIVER_API_KEY,
      quiverCount: quiver.count || 0,
      portfolioMatches: {
        count: matches.count,
        tickers: matches.tickers,
        items: matches.items,
        grouped: matches.grouped
      }
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(payload));
  }

  if (req.url === "/api/intel") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: Date.now(), count: intelItems.length, items: intelItems }));
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
  }, 500);
}
boot();

/* CORDELIUS_P1_APPLIED */

/* CORDELIUS_P1C_SEGURO_APPLIED */

/* CORDELIUS_P2_INTEL_APPLIED */

/* CORDELIUS_CLAUDE_SMART_APPLIED */
