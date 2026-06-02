const http = require("http");

const API_KEY = process.env.FINNHUB_API_KEY;

const portfolio = [
  { symbol: "MSFT", name: "Microsoft", shares: 0.12, costValue: 53.03, thesis: "IA, nube, software empresarial." },
  { symbol: "GEV", name: "GE Vernova", shares: 0.023, costValue: 21.72, thesis: "Energía, electrificación, infraestructura." },
  { symbol: "IREN", name: "IREN", shares: 0.17, costValue: 11.13, thesis: "Bitcoin mining / data centers, alto riesgo." },
  { symbol: "PLTR", name: "Palantir", shares: 0.016, costValue: 2.49, thesis: "IA, datos, gobierno y empresas." },
  { symbol: "AEP", name: "American Electric Power", shares: 0.0086, costValue: 1.06, thesis: "Utility defensiva, energía eléctrica." },
  { symbol: "UNH", name: "UnitedHealth", shares: 0.0027, costValue: 1.02, thesis: "Salud, defensiva, largo plazo." },
  { symbol: "SSYS", name: "Stratasys", shares: 0.094, costValue: 0.995, thesis: "Impresión 3D, especulativa." },
  { symbol: "PATH", name: "UiPath", shares: 0.058, costValue: 0.744, thesis: "Automatización e IA empresarial." },
  { symbol: "COPX", name: "Global X Copper Miners ETF", shares: 0.22, costValue: 19.57, thesis: "Cobre, electrificación, commodities." }
];

let quotes = {};
let news = {};
let history = [];
let lastUpdate = "Cargando...";

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function todayISO(offsetDays = 0){
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0,10);
}

async function getQuote(symbol){
  try{
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEY}`);
    const d = await r.json();
    quotes[symbol] = { price: d.c || 0, percent: d.dp || 0, change: d.d || 0, high: d.h || 0, low: d.l || 0 };
  }catch(e){
    console.log("Error quote", symbol, e.message);
  }
}

async function getNews(symbol){
  try{
    const from = todayISO(-7);
    const to = todayISO(0);
    const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${API_KEY}`);
    const d = await r.json();
    news[symbol] = Array.isArray(d) ? d.slice(0,3) : [];
  }catch(e){
    news[symbol] = [];
  }
}

function getAssetData(asset){
  const q = quotes[asset.symbol] || { price:0, percent:0, change:0 };
  const value = q.price * asset.shares;
  const gain = value - asset.costValue;
  const gainPercent = asset.costValue > 0 ? (gain / asset.costValue) * 100 : 0;
  const score = q.percent * 2 + gainPercent * 0.5;
  const risk = ["IREN","PLTR","SSYS","PATH"].includes(asset.symbol) ? "ALTO" :
               ["GEV","COPX"].includes(asset.symbol) ? "MEDIO" : "BAJO";

  let signal = "HOLD";
  if(q.percent >= 8) signal = "TAKE PROFIT / NO FOMO";
  else if(q.percent >= 4) signal = "MOMENTUM";
  else if(q.percent <= -5) signal = "BUY DIP / WATCH";
  else if(gainPercent <= -8) signal = "REVISAR RIESGO";
  else if(q.percent > 1) signal = "HOLD POSITIVO";
  else if(q.percent < -1) signal = "WATCH";

  return { ...asset, q, value, gain, gainPercent, score, risk, signal };
}

function dailyMove(a){
  if(a.signal.includes("TAKE")) return "Considera tomar ganancia parcial si ya subió mucho.";
  if(a.signal.includes("BUY DIP")) return "Posible entrada pequeña, pero confirma que no sea caída por noticia fuerte.";
  if(a.signal.includes("MOMENTUM")) return "Tiene fuerza; vigilar para no comprar demasiado tarde.";
  if(a.signal.includes("RIESGO")) return "No aumentar hasta revisar pérdida y tesis.";
  return "Mantener y monitorear.";
}

async function update(){
  for(const a of portfolio){
    await getQuote(a.symbol);
    await sleep(400);
  }

  for(const a of portfolio){
    await getNews(a.symbol);
    await sleep(300);
  }

  lastUpdate = new Date().toLocaleTimeString();

  const total = portfolio.reduce((s,a)=>{
    const q = quotes[a.symbol] || { price:0 };
    return s + q.price * a.shares;
  },0);

  if(total > 0){
    history.push({ time:lastUpdate, value:Number(total.toFixed(2)) });
    if(history.length > 40) history.shift();
  }
}

setInterval(update, 60000);
update();

const server = http.createServer((req,res)=>{
  res.writeHead(200,{ "Content-Type":"text/html; charset=utf-8" });

  const data = portfolio.map(getAssetData);
  const totalValue = data.reduce((s,a)=>s+a.value,0);
  const totalCost = data.reduce((s,a)=>s+a.costValue,0);
  const totalGain = totalValue - totalCost;
  const totalGainPercent = totalCost ? (totalGain/totalCost)*100 : 0;

  const ranking = [...data].sort((a,b)=>b.score-a.score);

  const alerts = [];
  ranking.forEach(a=>{
    if(a.q.percent >= 5) alerts.push(`🚀 ${a.symbol}: momentum fuerte, sube ${a.q.percent.toFixed(2)}%`);
    if(a.q.percent <= -5) alerts.push(`⚠️ ${a.symbol}: caída fuerte, revisar noticia/riesgo`);
  });
  if(alerts.length === 0) alerts.push("✅ Sin alertas fuertes. Mercado estable.");

  const rows = data.map(a=>`
    <tr onclick="document.getElementById('${a.symbol}').scrollIntoView({behavior:'smooth'})">
      <td><b>${a.symbol}</b><br><span>${a.name}</span></td>
      <td>$${a.q.price.toFixed(2)}</td>
      <td>$${a.value.toFixed(2)}</td>
      <td class="${a.gain>=0?'green':'red'}">$${a.gain.toFixed(2)}</td>
      <td class="${a.q.percent>=0?'green':'red'}">${a.q.percent.toFixed(2)}%</td>
      <td>${a.signal}</td>
      <td>${a.risk}</td>
    </tr>
  `).join("");

  const rankingHTML = ranking.map((a,i)=>`
    <div class="rank">
      <b>#${i+1} ${a.symbol}</b>
      <span>${a.signal}</span>
      <p>${dailyMove(a)}</p>
    </div>
  `).join("");

  const detailHTML = data.map(a=>{
    const n = news[a.symbol] || [];
    return `
      <div class="card" id="${a.symbol}">
        <h2>${a.symbol} — ${a.name}</h2>
        <p><b>Señal:</b> ${a.signal}</p>
        <p><b>Movimiento diario:</b> ${a.q.percent.toFixed(2)}%</p>
        <p><b>Ganancia total:</b> $${a.gain.toFixed(2)} (${a.gainPercent.toFixed(2)}%)</p>
        <p><b>Riesgo:</b> ${a.risk}</p>
        <p><b>Tesis:</b> ${a.thesis}</p>
        <p><b>Recomendación diaria:</b> ${dailyMove(a)}</p>
        <h3>Noticias recientes</h3>
        <ul>
          ${
            n.length
            ? n.map(x=>`<li><a href="${x.url}" target="_blank">${x.headline}</a><br><span>${x.source || "News"}</span></li>`).join("")
            : "<li>Sin noticias recientes cargadas.</li>"
          }
        </ul>
      </div>
    `;
  }).join("");

  res.end(`
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>CORDE AI PRO</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body{margin:0;background:#070b10;color:#f4f7fb;font-family:Arial;padding:18px;}
h1{color:#63ff9f;letter-spacing:2px;}
.nav{display:flex;gap:18px;position:sticky;top:0;background:#070b10;padding:12px 0;z-index:5;}
.nav a{color:#6aa8ff;text-decoration:none;font-weight:bold;}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
.card{background:#171c26;border:1px solid #252b38;border-radius:16px;padding:18px;margin-bottom:16px;}
.big{font-size:28px;font-weight:bold;}
.green{color:#63ff9f}.red{color:#ff5f7e}.blue{color:#6aa8ff}
table{width:100%;border-collapse:collapse;}
th,td{padding:12px;border-bottom:1px solid #303642;text-align:left;}
th{color:#63ff9f}
tr{cursor:pointer}
span{color:#9aa4b2;font-size:13px}
.rank{background:#0e131c;border:1px solid #293142;border-radius:12px;padding:12px;margin:10px 0}
.rank span{float:right;color:#6aa8ff}
a{color:#6aa8ff}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}table{font-size:12px}.big{font-size:22px}}
</style>
</head>
<body>

<h1>🚀 CORDE AI PRO</h1>

<div class="nav">
  <a href="#dashboard">DASHBOARD</a>
  <a href="#ranking">RANKING</a>
  <a href="#portfolio">PORTFOLIO</a>
  <a href="#details">DETAILS</a>
</div>

<div id="dashboard" class="grid">
  <div class="card"><h3>Equity</h3><p class="big">$${totalValue.toFixed(2)}</p></div>
  <div class="card"><h3>Costo</h3><p class="big">$${totalCost.toFixed(2)}</p></div>
  <div class="card"><h3>P&L</h3><p class="big ${totalGain>=0?'green':'red'}">$${totalGain.toFixed(2)}</p></div>
  <div class="card"><h3>Return</h3><p class="big ${totalGainPercent>=0?'green':'red'}">${totalGainPercent.toFixed(2)}%</p></div>
</div>

<div class="card">
  <h2>Market Regime</h2>
  <p class="big blue">${totalGainPercent > 5 ? "BULL" : totalGainPercent < -5 ? "BEAR" : "NEUTRAL"}</p>
  <p>Confidence: ${Math.min(95, Math.abs(totalGainPercent*10)+50).toFixed(0)}% | Strategy: MODERATE | Mode: Paper / Analysis</p>
</div>

<div class="card">
  <h2>Gráfica del portafolio</h2>
  <canvas id="chart"></canvas>
</div>

<div class="card">
  <h2>Alertas CORDE AI</h2>
  <ul>${alerts.map(a=>`<li>${a}</li>`).join("")}</ul>
</div>

<div id="ranking" class="card">
  <h2>Ranking automático</h2>
  ${rankingHTML}
</div>

<div id="portfolio" class="card">
  <h2>Mi portafolio real</h2>
  <table>
    <tr><th>Activo</th><th>Precio</th><th>Valor</th><th>Ganancia</th><th>Día</th><th>Señal</th><th>Riesgo</th></tr>
    ${rows}
  </table>
</div>

<div id="details">
  ${detailHTML}
</div>

<div class="card">
  <p>Update: ${lastUpdate} | API: Finnhub | Local: http://127.0.0.1:3000</p>
</div>

<script>
new Chart(document.getElementById("chart"),{
  type:"line",
  data:{
    labels:${JSON.stringify(history.map(x=>x.time))},
    datasets:[{
      label:"Equity",
      data:${JSON.stringify(history.map(x=>x.value))},
      borderWidth:2,
      tension:.35
    }]
  },
  options:{
    responsive:true,
    plugins:{legend:{labels:{color:"white"}}},
    scales:{
      x:{ticks:{color:"white"}},
      y:{ticks:{color:"white"}}
    }
  }
});
</script>

</body>
</html>
`);
});

server.listen(3000, "0.0.0.0", ()=>{
  console.log("CORDE AI PRO listo en http://localhost:3000");
});
