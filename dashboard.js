const http = require("http");
const https = require("https");
const fs = require("fs");

const API_KEY = process.env.FINNHUB_API_KEY || "";
const PORT = 3000;
const ANTHROPIC_API_KEY =
process.env.ANTHROPIC_API_KEY || "";
const BOT_FILE = "bot_state.json";
const HISTORY_FILE = "portfolio_history.json";
const CHAT_FILE = "ai_chat_history.json";

const portfolio = [
  { symbol: "MSFT", name: "Microsoft", shares: 0.12, costValue: 53.03, thesis: "Cloud + IA, posición core de bajo riesgo.", risk: "BAJO" },
  { symbol: "GEV", name: "GE Vernova", shares: 0.023, costValue: 21.72, thesis: "Energía, electrificación y demanda eléctrica por IA.", risk: "MEDIO" },
  { symbol: "IREN", name: "IREN", shares: 0.17, costValue: 11.13, thesis: "Minería Bitcoin + data centers, alta beta.", risk: "ALTO" },
  { symbol: "PLTR", name: "Palantir", shares: 0.016, costValue: 2.49, thesis: "Software IA, gobierno y empresas.", risk: "ALTO" },
  { symbol: "AEP", name: "American Electric Power", shares: 0.0086, costValue: 1.06, thesis: "Utility defensiva, energía eléctrica.", risk: "BAJO" },
  { symbol: "UNH", name: "UnitedHealth", shares: 0.0027, costValue: 1.02, thesis: "Salud defensiva, flujo estable.", risk: "BAJO" },
  { symbol: "SSYS", name: "Stratasys", shares: 0.094, costValue: 0.995, thesis: "Impresión 3D, posición especulativa.", risk: "ALTO" },
  { symbol: "PATH", name: "UiPath", shares: 0.058, costValue: 0.744, thesis: "Automatización RPA e IA empresarial.", risk: "ALTO" },
  { symbol: "COPX", name: "Global X Copper Miners ETF", shares: 0.22, costValue: 19.57, thesis: "Cobre, electrificación y commodities.", risk: "MEDIO" }
];

const WATCHLIST = ["MSFT","GEV","IREN","PLTR","AEP","UNH","SSYS","PATH","COPX","SPY","QQQ","NVDA","TSLA","AMD","META","GOOGL","AMZN"];

const TV = {
  MSFT:"NASDAQ:MSFT", GEV:"NYSE:GEV", IREN:"NASDAQ:IREN", PLTR:"NASDAQ:PLTR",
  AEP:"NASDAQ:AEP", UNH:"NYSE:UNH", SSYS:"NASDAQ:SSYS", PATH:"NYSE:PATH",
  COPX:"AMEX:COPX", SPY:"AMEX:SPY", QQQ:"NASDAQ:QQQ", NVDA:"NASDAQ:NVDA",
  TSLA:"NASDAQ:TSLA", AMD:"NASDAQ:AMD", META:"NASDAQ:META", GOOGL:"NASDAQ:GOOGL", AMZN:"NASDAQ:AMZN"
};

let quotes = {};
let news = [];
let portfolioHistory = loadJSON(HISTORY_FILE, []);
let chatHistory = loadJSON(CHAT_FILE, []);
let lastUpdate = "Cargando...";
let apiStatus = API_KEY ? "ONLINE" : "SIN API";
let validQuotes = 0;

let bot = loadJSON(BOT_FILE, {
  initialCapital: 1000,
  cash: 1000,
  positions: {},
  history: [],
  equityHistory: [],
  startDate: new Date().toISOString(),
  lastTick: null,
  running: true,
  totalRealizedPnl: 0,
  maxDrawdown: 0,
  tradesCount: 0,
  cooldown: {}
});

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch(e) {}
  return fallback;
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url) {
  return new Promise(resolve => {
    https.get(url, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    }).on("error", () => resolve(""));
  });
}

async function getQuote(symbol) {
  if (!API_KEY) return;
  const raw = await httpsGet("https://finnhub.io/api/v1/quote?symbol=" + symbol + "&token=" + API_KEY);
  try {
    const d = JSON.parse(raw);
    if (d && typeof d.c === "number" && d.c > 0) {
      quotes[symbol] = {
        price: d.c || 0,
        percent: d.dp || 0,
        change: d.d || 0,
        high: d.h || 0,
        low: d.l || 0,
        open: d.o || 0,
        prev: d.pc || 0
      };
    }
  } catch(e) {}
}

async function fetchNews() {
  if (!API_KEY) return;
  const today = new Date();
  const from = new Date(today.getTime() - 5 * 86400000).toISOString().slice(0,10);
  const to = today.toISOString().slice(0,10);
  const syms = ["MSFT","PLTR","IREN","GEV"];
  let all = [];

  for (const s of syms) {
    const raw = await httpsGet("https://finnhub.io/api/v1/company-news?symbol=" + s + "&from=" + from + "&to=" + to + "&token=" + API_KEY);
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.slice(0, 3).forEach(n => all.push({
          symbol: s,
          headline: n.headline || "",
          source: n.source || "Fuente",
          url: n.url || "#",
          summary: (n.summary || "").slice(0, 170)
        }));
      }
    } catch(e) {}
    await sleep(400);
  }

  if (all.length) news = all.slice(0, 12);
}

async function updateMarket() {
  if (!API_KEY) {
    apiStatus = "SIN API";
    lastUpdate = new Date().toLocaleTimeString("es-MX");
    return;
  }

  let ok = 0;
  for (const s of WATCHLIST) {
    await getQuote(s);
    if (quotes[s] && quotes[s].price > 0) ok++;
    await sleep(300);
  }

  validQuotes = ok;
  apiStatus = ok > 5 ? "ONLINE" : "DEGRADADO";
  lastUpdate = new Date().toLocaleTimeString("es-MX");

  const pv = portfolioValue();
  if (pv.totalValue > 0) {
    portfolioHistory.push({ time: new Date().toISOString(), value: +pv.totalValue.toFixed(2) });
    if (portfolioHistory.length > 240) portfolioHistory = portfolioHistory.slice(-240);
    saveJSON(HISTORY_FILE, portfolioHistory);
  }

  runBotTick();
}

let newsCounter = 0;
setInterval(() => {
  updateMarket();
  newsCounter++;
  if (newsCounter % 5 === 0) fetchNews();
}, 60000);

updateMarket();
fetchNews();

function riskColor(r) {
  if (r === "BAJO") return "#00ff99";
  if (r === "MEDIO") return "#ffd93b";
  return "#ff4d6d";
}

function signalColor(s) {
  if (["MOMENTUM","TAKE PROFIT"].includes(s)) return "#00ff99";
  if (["BUY DIP","ACUMULAR"].includes(s)) return "#3b9dff";
  if (["VIGILAR","ESPERAR"].includes(s)) return "#ffd93b";
  if (["ALTO RIESGO","STOP LOSS","REDUCIR"].includes(s)) return "#ff4d6d";
  return "#9ca3af";
}

function signalFor(asset) {
  const q = quotes[asset.symbol] || { price:0, percent:0 };
  const value = q.price * asset.shares;
  const gain = value - asset.costValue;
  const gainPct = asset.costValue > 0 ? (gain / asset.costValue) * 100 : 0;
  const p = q.percent || 0;

  let signal = "MANTENER";
  let reason = "Movimiento normal. No hay señal extrema.";
  let conf = 50;

  if (!q.price) { signal = "ESPERAR"; reason = "Sin datos de precio todavía."; conf = 20; }
  else if (asset.risk === "ALTO" && Math.abs(p) > 6) { signal = "ALTO RIESGO"; reason = "Movimiento fuerte en activo volátil."; conf = 70; }
  else if (gainPct > 25 && p > 2) { signal = "TAKE PROFIT"; reason = "Ganancia alta acumulada y momentum positivo."; conf = 76; }
  else if (p >= 4) { signal = "MOMENTUM"; reason = "Impulso fuerte durante el día."; conf = 68; }
  else if (p <= -6) { signal = "BUY DIP"; reason = "Caída fuerte; posible oportunidad si la tesis sigue intacta."; conf = 64; }
  else if (p <= -2) { signal = "VIGILAR"; reason = "Baja relevante. Esperar confirmación."; conf = 55; }
  else if (asset.risk === "BAJO") { signal = "MANTENER"; reason = "Posición defensiva estable."; conf = 58; }

  return { signal, reason, conf, value, gain, gainPct, percent:p };
}

function scoreFor(asset) {
  const q = quotes[asset.symbol] || { percent:0 };
  const sig = signalFor(asset);
  let s = 50;
  s += Math.max(-25, Math.min(25, q.percent * 3));
  if (asset.risk === "BAJO") s += 8;
  if (asset.risk === "ALTO") s -= 8;
  if (sig.gainPct > 0) s += Math.min(15, sig.gainPct / 2);
  return Math.max(0, Math.min(100, Math.round(s)));
}

function portfolioValue() {
  let totalValue = 0;
  let totalCost = 0;

  const assets = portfolio.map(a => {
    const sig = signalFor(a);
    const score = scoreFor(a);
    totalValue += sig.value;
    totalCost += a.costValue;
    return { ...a, ...sig, score };
  });

  const totalGain = totalValue - totalCost;
  const totalGainPct = totalCost ? (totalGain / totalCost) * 100 : 0;

  return { assets, totalValue, totalCost, totalGain, totalGainPct };
}

function marketRegime() {
  let sum = 0, n = 0;
  portfolio.forEach(a => {
    const q = quotes[a.symbol];
    if (q && q.price) { sum += q.percent; n++; }
  });
  const avg = n ? sum / n : 0;
  if (avg > 1) return { label:"ALCISTA", color:"#00ff99", avg };
  if (avg < -1) return { label:"BAJISTA", color:"#ff4d6d", avg };
  return { label:"NEUTRAL", color:"#ffd93b", avg };
}

function botValue() {
  let posVal = 0;
  for (const sym in bot.positions) {
    const q = quotes[sym];
    if (q) posVal += q.price * bot.positions[sym].shares;
  }
  return bot.cash + posVal;
}

function runBotTick() {
  bot.lastTick = new Date().toISOString();
  if (!bot.running) { saveJSON(BOT_FILE, bot); return; }

  const now = Date.now();
  const nowStr = new Date().toLocaleString("es-MX");
  const cooldown = 30 * 60 * 1000;

  for (const a of portfolio) {
    const q = quotes[a.symbol];
    if (!q || q.price <= 0) continue;

    const sig = signalFor(a);
    const pos = bot.positions[a.symbol];
    const last = bot.cooldown[a.symbol] || 0;
    if (now - last < cooldown) continue;

    if (pos) {
      const cur = q.price * pos.shares;
      const cost = pos.avgCost * pos.shares;
      const pnl = cur - cost;
      const pnlPct = cost ? (pnl / cost) * 100 : 0;

      if (pnlPct <= -12) {
        bot.cash += cur;
        bot.totalRealizedPnl += pnl;
        bot.tradesCount++;
        bot.history.unshift({ type:"STOP LOSS", symbol:a.symbol, shares:+pos.shares.toFixed(4), price:+q.price.toFixed(2), value:+cur.toFixed(2), pnl:+pnl.toFixed(2), reason:"Corte automático por pérdida mayor a 12%.", time:nowStr });
        delete bot.positions[a.symbol];
        bot.cooldown[a.symbol] = now;
        continue;
      }

      if (sig.signal === "TAKE PROFIT" || pnlPct >= 20) {
        bot.cash += cur;
        bot.totalRealizedPnl += pnl;
        bot.tradesCount++;
        bot.history.unshift({ type:"VENTA", symbol:a.symbol, shares:+pos.shares.toFixed(4), price:+q.price.toFixed(2), value:+cur.toFixed(2), pnl:+pnl.toFixed(2), reason:"Toma de ganancia simulada.", time:nowStr });
        delete bot.positions[a.symbol];
        bot.cooldown[a.symbol] = now;
        continue;
      }
    }

    if (!pos && (sig.signal === "BUY DIP" || sig.signal === "MOMENTUM") && bot.cash > 250) {
      const equity = botValue();
      const max = a.risk === "ALTO" ? equity * 0.08 : equity * 0.15;
      const spend = Math.min(max, 150, bot.cash - 200);
      if (spend > 20) {
        const shares = spend / q.price;
        bot.cash -= spend;
        bot.tradesCount++;
        bot.positions[a.symbol] = {
          shares,
          avgCost: q.price,
          stopLoss: +(q.price * 0.88).toFixed(2),
          takeProfit: +(q.price * 1.2).toFixed(2)
        };
        bot.history.unshift({ type:"COMPRA", symbol:a.symbol, shares:+shares.toFixed(4), price:+q.price.toFixed(2), value:+spend.toFixed(2), pnl:null, reason:sig.reason, time:nowStr });
        bot.cooldown[a.symbol] = now;
      }
    }
  }

  const eq = botValue();
  bot.equityHistory.push({ time:new Date().toISOString(), value:+eq.toFixed(2) });
  if (bot.equityHistory.length > 240) bot.equityHistory = bot.equityHistory.slice(-240);

  const peak = Math.max(bot.initialCapital, ...bot.equityHistory.map(x => x.value));
  const dd = peak ? ((peak - eq) / peak) * 100 : 0;
  if (dd > bot.maxDrawdown) bot.maxDrawdown = +dd.toFixed(2);

  if (bot.history.length > 80) bot.history = bot.history.slice(0,80);
  saveJSON(BOT_FILE, bot);
}

function activeTime() {
  const start = new Date(bot.startDate).getTime();
  const diff = Date.now() - start;
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return d + "d " + h + "h " + m + "m";
}

async function alfredReply(question) {
  const q = question.toLowerCase();
  const pv = portfolioValue();
  const reg = marketRegime();
  const ranked = pv.assets.slice().sort((a,b) => b.score - a.score);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const botEq = botValue();
  const botPnl = botEq - bot.initialCapital;

  let reply = "";

  if (q.includes("riesgo")) {
    const high = pv.assets.filter(a => a.risk === "ALTO");
    reply = "Pedro, el riesgo principal está en " + high.map(a => a.symbol).join(", ") + ". Son posiciones pequeñas, pero tienen más volatilidad. Yo mantendría exposición controlada y evitaría aumentar si el mercado está en modo bajista.";
  } else if (q.includes("comprar") || q.includes("compra")) {
    const dips = pv.assets.filter(a => a.signal === "BUY DIP" || a.signal === "MOMENTUM");
    reply = dips.length ? "Veo posibles entradas simuladas en: " + dips.map(a => a.symbol).join(", ") + ". No lo tomaría como compra real automática; primero revisaría noticia, volumen y TradingView." : "No veo una compra clara ahorita. Mi lectura es esperar confirmación.";
  } else if (q.includes("vender") || q.includes("ganancia")) {
    const sells = pv.assets.filter(a => a.signal === "TAKE PROFIT");
    reply = sells.length ? "Consideraría asegurar ganancias parcialmente en: " + sells.map(a => a.symbol).join(", ") + ". No cerraría todo sin revisar tendencia." : "No hay señal fuerte de venta total. Mantendría y vigilaría.";
  } else if (q.includes("bot")) {
    reply = "El bot ficticio lleva " + bot.tradesCount + " operaciones, equity simulado de $" + botEq.toFixed(2) + " y P&L de " + (botPnl >= 0 ? "+" : "") + "$" + botPnl.toFixed(2) + ". Sigue siendo simulación, no dinero real.";
  } else {
    reply = "Análisis Alfred AI: el portafolio está en régimen " + reg.label + ", con rendimiento real de " + (pv.totalGainPct >= 0 ? "+" : "") + pv.totalGainPct.toFixed(2) + "%. El activo más fuerte por score es " + best.symbol + " y el más débil es " + worst.symbol + ". Mi sugerencia educativa: mantener disciplina, revisar noticias y no sobreoperar.";
  }

  chatHistory.unshift({ question, reply, time:new Date().toLocaleString("es-MX") });
  if (chatHistory.length > 40) chatHistory = chatHistory.slice(0,40);
  saveJSON(CHAT_FILE, chatHistory);
  return reply;
}

function spark(data, color) {
  if (!data || data.length < 2) return "<div class='muted'>Recolectando datos...</div>";
  const arr = data.map(x => typeof x === "number" ? x : x.value);
  const min = Math.min(...arr), max = Math.max(...arr), range = max - min || 1;
  const pts = arr.map((v,i) => {
    const x = (i / (arr.length - 1)) * 100;
    const y = 40 - ((v - min) / range) * 40;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="spark"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4"/></svg>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#03060b;color:#eaf6ff;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;padding:0 16px 60px;overflow-x:hidden}
body:before{content:"";position:fixed;inset:0;background:
radial-gradient(circle at 20% 10%,rgba(0,255,153,.15),transparent 30%),
radial-gradient(circle at 80% 15%,rgba(59,157,255,.14),transparent 35%),
linear-gradient(180deg,#03060b,#07111c);z-index:-2}
body:after{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:34px 34px;z-index:-1}
.header{position:sticky;top:0;z-index:100;background:rgba(3,6,11,.72);backdrop-filter:blur(18px);border-bottom:1px solid rgba(0,255,153,.18);padding:16px 0;margin-bottom:24px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.logo{font-size:25px;font-weight:900;letter-spacing:2px;background:linear-gradient(90deg,#00ff99,#3b9dff,#ffffff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-shadow:0 0 30px rgba(0,255,153,.6)}
.sub{color:#7da4bd;font-size:12px;letter-spacing:1px;text-transform:uppercase}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.nav a{color:#9db7c9;text-decoration:none;padding:8px 13px;border:1px solid rgba(59,157,255,.18);border-radius:12px;background:rgba(7,17,28,.55);font-weight:700;font-size:12px;transition:.25s}
.nav a:hover{color:#00ff99;border-color:#00ff99;box-shadow:0 0 18px rgba(0,255,153,.25)}
.pill{display:inline-block;padding:5px 11px;border-radius:999px;font-size:11px;font-weight:900;letter-spacing:.4px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
.card{position:relative;background:linear-gradient(145deg,rgba(9,20,32,.9),rgba(4,9,16,.9));border:1px solid rgba(59,157,255,.18);border-radius:20px;padding:18px;box-shadow:0 0 26px rgba(0,0,0,.35);animation:fade .55s ease;overflow:hidden}
.card:before{content:"";position:absolute;inset:0;border-radius:20px;background:linear-gradient(120deg,rgba(0,255,153,.08),transparent,rgba(59,157,255,.08));pointer-events:none}
.card:hover{border-color:rgba(0,255,153,.55);box-shadow:0 0 35px rgba(0,255,153,.12);transform:translateY(-2px)}
@keyframes fade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.label{color:#7da4bd;font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:7px}
.big{font-size:27px;font-weight:900}
.green{color:#00ff99}.red{color:#ff4d6d}.yellow{color:#ffd93b}.blue{color:#3b9dff}.muted{color:#7da4bd}
.glow{text-shadow:0 0 22px currentColor}
h2{margin:28px 0 14px;font-size:18px;letter-spacing:.5px}
h2:before{content:"";display:inline-block;width:6px;height:20px;background:linear-gradient(#00ff99,#3b9dff);border-radius:6px;margin-right:10px;vertical-align:middle;box-shadow:0 0 15px #00ff99}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 10px;border-bottom:1px solid rgba(125,164,189,.12);text-align:left;font-size:13px}
th{color:#7da4bd;font-size:11px;text-transform:uppercase;letter-spacing:.6px}
tbody tr:hover{background:rgba(59,157,255,.07)}
.badge{padding:4px 9px;border-radius:8px;font-size:10px;font-weight:900}
.brief{line-height:1.65;font-size:14px;color:#dceeff}
.rank{padding:14px;border-radius:15px;background:rgba(7,17,28,.65);border:1px solid rgba(59,157,255,.15);margin-bottom:10px}
.bar{height:7px;background:rgba(125,164,189,.12);border-radius:999px;margin-top:8px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,#00ff99,#3b9dff);box-shadow:0 0 12px #00ff99}
.spark{width:100%;height:92px;filter:drop-shadow(0 0 8px currentColor)}
.btn{background:linear-gradient(145deg,#0b1d2d,#07111c);color:#eaf6ff;border:1px solid rgba(0,255,153,.35);padding:10px 18px;border-radius:12px;font-weight:900;cursor:pointer}
.btn:hover{box-shadow:0 0 18px rgba(0,255,153,.35);color:#00ff99}
.chatbox{display:flex;gap:8px;margin-top:12px}
.chatbox input{flex:1;background:#05101b;border:1px solid rgba(59,157,255,.25);border-radius:12px;color:white;padding:13px;font-size:14px}
.chatmsg{padding:12px;border-radius:14px;background:rgba(7,17,28,.75);border:1px solid rgba(59,157,255,.15);margin-bottom:10px}
.news{padding:13px;border-radius:14px;background:rgba(7,17,28,.65);border:1px solid rgba(59,157,255,.15);margin-bottom:10px}
.tv{height:430px;border-radius:20px;overflow:hidden;border:1px solid rgba(0,255,153,.25)}
.warning{border:1px solid #ffd93b;color:#ffd93b;background:rgba(255,217,59,.08);padding:12px;border-radius:14px;text-align:center;font-weight:800;margin-bottom:18px}
@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}.tv{height:330px}.big{font-size:22px}}
`;

function render() {
  const pv = portfolioValue();
  const reg = marketRegime();
  const best = pv.assets.slice().sort((a,b) => b.percent - a.percent)[0];
  const worst = pv.assets.slice().sort((a,b) => a.percent - b.percent)[0];

  const botEq = botValue();
  const botPnl = botEq - bot.initialCapital;
  const botPnlPct = (botPnl / bot.initialCapital) * 100;

  const rows = pv.assets.map(a => {
    const c = signalColor(a.signal);
    const tv = TV[a.symbol] || ("NASDAQ:" + a.symbol);
    return `<tr>
      <td><b>${a.symbol}</b><br><span class="muted">${a.name}</span></td>
      <td>$${(quotes[a.symbol]?.price || 0).toFixed(2)}</td>
      <td class="${a.percent>=0?'green':'red'}">${a.percent>=0?'+':''}${a.percent.toFixed(2)}%</td>
      <td>$${a.value.toFixed(2)}</td>
      <td class="${a.gain>=0?'green':'red'}">${a.gain>=0?'+':''}$${a.gain.toFixed(2)}</td>
      <td><span class="badge" style="background:${riskColor(a.risk)}22;color:${riskColor(a.risk)}">${a.risk}</span></td>
      <td>${a.score}</td>
      <td><span class="pill" style="background:${c}22;color:${c}">${a.signal}</span></td>
      <td><a class="blue" href="https://www.tradingview.com/chart/?symbol=${tv}" target="_blank">TV</a></td>
    </tr>`;
  }).join("");

  const rankHtml = pv.assets.slice().sort((a,b)=>b.score-a.score).map((a,i)=>{
    const c = signalColor(a.signal);
    return `<div class="rank">
      <div style="display:flex;justify-content:space-between;gap:10px">
        <b>#${i+1} ${a.symbol}</b>
        <span class="pill" style="background:${c}22;color:${c}">${a.signal}</span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">${a.reason}</div>
      <div class="bar"><div class="fill" style="width:${a.score}%"></div></div>
    </div>`;
  }).join("");

  let posRows = "";
  for (const sym in bot.positions) {
    const p = bot.positions[sym];
    const q = quotes[sym] || { price:0 };
    const val = p.shares * q.price;
    const cost = p.shares * p.avgCost;
    const pnl = val - cost;
    posRows += `<tr>
      <td><b>${sym}</b></td><td>${p.shares.toFixed(4)}</td><td>$${p.avgCost.toFixed(2)}</td><td>$${q.price.toFixed(2)}</td>
      <td>$${val.toFixed(2)}</td><td class="${pnl>=0?'green':'red'}">${pnl>=0?'+':''}$${pnl.toFixed(2)}</td>
      <td class="red">$${p.stopLoss}</td><td class="green">$${p.takeProfit}</td>
    </tr>`;
  }
  if (!posRows) posRows = `<tr><td colspan="8" class="muted">Sin posiciones abiertas.</td></tr>`;

  const histRows = bot.history.length ? bot.history.map(h => `
    <tr>
      <td><span class="pill">${h.type}</span></td><td><b>${h.symbol}</b></td><td>${h.shares}</td><td>$${h.price}</td><td>$${h.value}</td>
      <td>${h.pnl === null ? "-" : `<span class="${h.pnl>=0?'green':'red'}">${h.pnl>=0?'+':''}$${h.pnl}</span>`}</td>
      <td class="muted">${h.time}</td><td class="muted">${h.reason}</td>
    </tr>`).join("") : `<tr><td colspan="8" class="muted">Aún sin operaciones.</td></tr>`;

  const newsHtml = news.length ? news.map(n => `
    <a href="${n.url}" target="_blank"><div class="news">
      <div style="display:flex;justify-content:space-between;gap:10px"><b>${n.headline}</b><span class="pill blue">${n.symbol}</span></div>
      <div class="muted" style="font-size:12px;margin-top:6px">${n.source} · ${n.summary}</div>
    </div></a>`).join("") : `<div class="muted">Sin noticias cargadas todavía.</div>`;

  const chatHtml = chatHistory.length ? chatHistory.slice(0,8).map(c => `
    <div class="chatmsg">
      <div class="blue"><b>Tú:</b> ${c.question}</div>
      <div style="margin-top:6px"><b class="green">Alfred AI:</b> ${c.reply}</div>
      <div class="muted" style="font-size:11px;margin-top:5px">${c.time}</div>
    </div>`).join("") : `<div class="muted">Pregúntale algo a Alfred AI.</div>`;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>ALFRED AI</title><style>${CSS}</style></head><body>

<div class="header">
  <div class="top">
    <div>
      <div class="logo">ALFRED AI</div>
      <div class="sub">Corde Intelligence System · Stark Mode</div>
    </div>
    <div>
      <span class="pill" style="background:${apiStatus==='ONLINE'?'#00ff9922':'#ff4d6d22'};color:${apiStatus==='ONLINE'?'#00ff99':'#ff4d6d'}">API ${apiStatus}</span>
      <span class="pill" style="background:#3b9dff22;color:#3b9dff">Update ${lastUpdate}</span>
    </div>
  </div>
  <div class="nav">
    <a href="#dashboard">Dashboard</a><a href="#alfred">Alfred AI</a><a href="#portfolio">Portafolio</a><a href="#bot">Bot</a><a href="#tradingview">TradingView</a><a href="#news">Noticias</a><a href="#system">Sistema</a>
  </div>
</div>

${!API_KEY ? `<div class="warning">Falta FINNHUB_API_KEY. La app abre, pero los precios saldrán en cero.</div>` : ""}

<a id="dashboard"></a>
<div class="grid">
  <div class="card"><div class="label">Equity real</div><div class="big green glow">$${pv.totalValue.toFixed(2)}</div></div>
  <div class="card"><div class="label">Costo base</div><div class="big">$${pv.totalCost.toFixed(2)}</div></div>
  <div class="card"><div class="label">P&L real</div><div class="big ${pv.totalGain>=0?'green':'red'} glow">${pv.totalGain>=0?'+':''}$${pv.totalGain.toFixed(2)}</div></div>
  <div class="card"><div class="label">Rendimiento</div><div class="big ${pv.totalGainPct>=0?'green':'red'}">${pv.totalGainPct>=0?'+':''}${pv.totalGainPct.toFixed(2)}%</div></div>
</div>

<div class="grid">
  <div class="card"><div class="label">Régimen de mercado</div><div class="big" style="color:${reg.color}">${reg.label}</div><div class="muted">${reg.avg>=0?'+':''}${reg.avg.toFixed(2)}% promedio</div></div>
  <div class="card"><div class="label">Mejor activo</div><div class="big green">${best?.symbol || "-"}</div><div class="muted">${best ? best.percent.toFixed(2) + "%" : ""}</div></div>
  <div class="card"><div class="label">Peor activo</div><div class="big red">${worst?.symbol || "-"}</div><div class="muted">${worst ? worst.percent.toFixed(2) + "%" : ""}</div></div>
  <div class="card"><div class="label">Quotes válidas</div><div class="big blue">${validQuotes}/${WATCHLIST.length}</div></div>
</div>

<div class="card"><div class="label">Histórico de equity real</div>${spark(portfolioHistory, "#3b9dff")}</div>

<a id="alfred"></a>
<h2>Alfred AI — Asistente interno</h2>
<div class="card">
  <div class="brief">${alfredReplyPreview()}</div>
  <form class="chatbox" method="POST" action="/ask">
    <input name="q" placeholder="Pregúntale a Alfred: ¿qué compro?, ¿qué riesgo tengo?, ¿cómo va el bot?" autocomplete="off">
    <button class="btn">Preguntar</button>
  </form>
</div>
<div style="margin-top:12px">${chatHtml}</div>

<a id="portfolio"></a>
<h2>Portafolio real</h2>
<div class="card" style="overflow-x:auto;padding:8px">
<table><thead><tr><th>Activo</th><th>Precio</th><th>Día</th><th>Valor</th><th>Ganancia</th><th>Riesgo</th><th>Score</th><th>Señal</th><th>TV</th></tr></thead><tbody>${rows}</tbody></table>
</div>

<h2>Ranking Alfred</h2>
${rankHtml}

<a id="bot"></a>
<h2>Trading AI ficticio</h2>
<div class="warning">Simulación solamente. No compra ni vende dinero real.</div>
<div class="grid">
  <div class="card"><div class="label">Capital inicial</div><div class="big">$${bot.initialCapital.toFixed(2)}</div></div>
  <div class="card"><div class="label">Equity simulado</div><div class="big ${botPnl>=0?'green':'red'} glow">$${botEq.toFixed(2)}</div></div>
  <div class="card"><div class="label">Cash</div><div class="big">$${bot.cash.toFixed(2)}</div></div>
  <div class="card"><div class="label">P&L simulado</div><div class="big ${botPnl>=0?'green':'red'}">${botPnl>=0?'+':''}$${botPnl.toFixed(2)} (${botPnlPct>=0?'+':''}${botPnlPct.toFixed(1)}%)</div></div>
</div>

<div class="grid">
  <div class="card"><div class="label">Estado</div><div class="big ${bot.running?'green':'yellow'}">${bot.running?'ACTIVO':'PAUSADO'}</div></div>
  <div class="card"><div class="label">Tiempo activo</div><div class="big blue">${activeTime()}</div></div>
  <div class="card"><div class="label">Operaciones</div><div class="big">${bot.tradesCount}</div></div>
  <div class="card"><div class="label">Drawdown máx</div><div class="big yellow">${bot.maxDrawdown.toFixed(1)}%</div></div>
</div>

<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
  <div class="muted">Inicio: ${new Date(bot.startDate).toLocaleString("es-MX")} · Último tick: ${bot.lastTick ? new Date(bot.lastTick).toLocaleTimeString("es-MX") : "-"}</div>
  <div><a href="/bot/start"><button class="btn">Start</button></a> <a href="/bot/pause"><button class="btn">Pause</button></a> <a href="/bot/reset"><button class="btn">Reset</button></a></div>
</div>

<div class="card" style="margin-top:14px"><div class="label">Equity simulada</div>${spark(bot.equityHistory, "#00ff99")}</div>

<h2>Posiciones del bot</h2>
<div class="card" style="overflow-x:auto;padding:8px">
<table><thead><tr><th>Activo</th><th>Shares</th><th>Avg</th><th>Precio</th><th>Valor</th><th>P&L</th><th>SL</th><th>TP</th></tr></thead><tbody>${posRows}</tbody></table>
</div>

<h2>Bitácora del bot</h2>
<div class="card" style="overflow-x:auto;padding:8px">
<table><thead><tr><th>Tipo</th><th>Activo</th><th>Shares</th><th>Precio</th><th>Valor</th><th>P&L</th><th>Hora</th><th>Razón</th></tr></thead><tbody>${histRows}</tbody></table>
</div>

<a id="tradingview"></a>
<h2>TradingView</h2>
<div class="tv">
<iframe src="https://s.tradingview.com/widgetembed/?symbol=NASDAQ:MSFT&interval=D&theme=dark&style=1&hidesidetoolbar=1&saveimage=0" style="border:0;width:100%;height:100%"></iframe>
</div>

<a id="news"></a>
<h2>Noticias inteligentes</h2>
${newsHtml}

<a id="system"></a>
<h2>Sistema</h2>
<div class="grid">
  <div class="card"><div class="label">Node</div><div class="big green">RUNNING</div></div>
  <div class="card"><div class="label">Persistencia bot</div><div class="big green">OK</div></div>
  <div class="card"><div class="label">Historial gráfica</div><div class="big green">OK</div></div>
  <div class="card"><div class="label">X / Grok / Quiver</div><div class="big yellow">READY</div></div>
</div>

<div class="muted" style="text-align:center;margin-top:30px;font-size:12px">
Alfred AI es educativo. No es asesoría financiera. El bot es ficticio y no se conecta a exchanges reales.
</div>

</body></html>`;
}

function alfredReplyPreview() {
  const pv = portfolioValue();
  const reg = marketRegime();
  const ranked = pv.assets.slice().sort((a,b)=>b.score-a.score);
  const best = ranked[0];
  return `Buenos días, Pedro. Alfred está en línea. Régimen actual: <b style="color:${reg.color}">${reg.label}</b>. Equity real: <b class="green">$${pv.totalValue.toFixed(2)}</b>. Rendimiento: <b class="${pv.totalGainPct>=0?'green':'red'}">${pv.totalGainPct>=0?'+':''}${pv.totalGainPct.toFixed(2)}%</b>. El activo con mejor score ahora es <b>${best?.symbol || "-"}</b>.`;
}

function handleAsk(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const params = new URLSearchParams(body);
    const q = params.get("q") || "";
    if (q.trim()) alfredReply(q.trim());
    res.writeHead(302, { Location: "/#alfred" });
    res.end();
  });
}

const server = http.createServer((req,res) => {
  if (req.method === "POST" && req.url === "/ask") return handleAsk(req,res);

  if (req.url === "/bot/start") {
    bot.running = true; saveJSON(BOT_FILE, bot);
    res.writeHead(302, { Location:"/#bot" }); return res.end();
  }

  if (req.url === "/bot/pause") {
    bot.running = false; saveJSON(BOT_FILE, bot);
    res.writeHead(302, { Location:"/#bot" }); return res.end();
  }

  if (req.url === "/bot/reset") {
    bot = {
      initialCapital:1000, cash:1000, positions:{}, history:[], equityHistory:[],
      startDate:new Date().toISOString(), lastTick:null, running:true,
      totalRealizedPnl:0, maxDrawdown:0, tradesCount:0, cooldown:{}
    };
    saveJSON(BOT_FILE, bot);
    res.writeHead(302, { Location:"/#bot" }); return res.end();
  }

  res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
  res.end(render());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("ALFRED AI listo en http://localhost:" + PORT);
});
