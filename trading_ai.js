const http = require("http");

const API_KEY = process.env.FINNHUB_API_KEY;
const PORT = 3001;

const portfolio = [
  { symbol:"MSFT", name:"Microsoft", shares:0.12, costValue:53.03 },
  { symbol:"GEV", name:"GE Vernova", shares:0.023, costValue:21.72 },
  { symbol:"IREN", name:"IREN", shares:0.17, costValue:11.13 },
  { symbol:"PLTR", name:"Palantir", shares:0.016, costValue:2.49 },
  { symbol:"AEP", name:"American Electric Power", shares:0.0086, costValue:1.06 },
  { symbol:"UNH", name:"UnitedHealth", shares:0.0027, costValue:1.02 },
  { symbol:"SSYS", name:"Stratasys", shares:0.094, costValue:0.995 },
  { symbol:"PATH", name:"UiPath", shares:0.058, costValue:0.744 },
  { symbol:"COPX", name:"Global X Copper Miners ETF", shares:0.22, costValue:19.57 }
];

let cash = 1000;
let positions = {};
let trades = [];
let quotes = {};
let lastUpdate = "Cargando...";

portfolio.forEach(a => positions[a.symbol] = 0);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function quote(symbol){
  try{
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEY}`);
    const d = await r.json();
    quotes[symbol] = { price:d.c || 0, change:d.dp || 0 };
  }catch(e){ console.log("Error", symbol); }
}

function decide(symbol){
  const q = quotes[symbol] || { price:0, change:0 };
  if(!q.price) return "WAIT";
  if(q.change <= -3) return "BUY";
  if(q.change >= 4 && positions[symbol] > 0) return "SELL";
  if(q.change >= 1) return "HOLD";
  return "WATCH";
}

async function runBot(){
  for(const a of portfolio){
    await quote(a.symbol);
    await sleep(400);

    const q = quotes[a.symbol];
    if(!q || !q.price) continue;

    const action = decide(a.symbol);

    if(action === "BUY" && cash >= 25){
      const amount = 25;
      const shares = amount / q.price;
      positions[a.symbol] += shares;
      cash -= amount;
      trades.unshift(`🟢 BUY ${a.symbol} $${amount.toFixed(2)} @ $${q.price.toFixed(2)}`);
    }

    if(action === "SELL" && positions[a.symbol] > 0){
      const shares = positions[a.symbol] * 0.5;
      const value = shares * q.price;
      positions[a.symbol] -= shares;
      cash += value;
      trades.unshift(`🔴 SELL ${a.symbol} $${value.toFixed(2)} @ $${q.price.toFixed(2)}`);
    }
  }

  if(trades.length > 25) trades = trades.slice(0,25);
  lastUpdate = new Date().toLocaleTimeString();
}

setInterval(runBot, 30000);
runBot();

const server = http.createServer((req,res)=>{
  let equity = cash;

  const rows = portfolio.map(a=>{
    const q = quotes[a.symbol] || { price:0, change:0 };
    const value = positions[a.symbol] * q.price;
    equity += value;
    const action = decide(a.symbol);

    return `
      <tr>
        <td><b>${a.symbol}</b><br><span>${a.name}</span></td>
        <td>$${q.price.toFixed(2)}</td>
        <td class="${q.change>=0?'green':'red'}">${q.change.toFixed(2)}%</td>
        <td>${positions[a.symbol].toFixed(5)}</td>
        <td>$${value.toFixed(2)}</td>
        <td>${action}</td>
      </tr>
    `;
  }).join("");

  res.writeHead(200,{ "Content-Type":"text/html; charset=utf-8" });

  res.end(`
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Trading AI Automático Ficticio</title>
<style>
body{margin:0;background:#05080d;color:white;font-family:Arial;padding:18px;}
h1{color:#63ff9f;}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.card{background:#151b26;border:1px solid #273142;border-radius:16px;padding:18px;margin-bottom:16px;}
.big{font-size:28px;font-weight:bold;}
.green{color:#63ff9f}.red{color:#ff5f7e}.blue{color:#6aa8ff}
table{width:100%;border-collapse:collapse;}
th,td{padding:12px;border-bottom:1px solid #303642;text-align:left;}
th{color:#63ff9f}
span{color:#9aa4b2;font-size:13px}
li{margin-bottom:10px}
@media(max-width:900px){.grid{grid-template-columns:1fr}table{font-size:12px}}
</style>
</head>
<body>

<h1>🤖 Trading AI Automático Ficticio</h1>

<div class="grid">
  <div class="card"><h3>Cash simulado</h3><p class="big">$${cash.toFixed(2)}</p></div>
  <div class="card"><h3>Equity simulada</h3><p class="big green">$${equity.toFixed(2)}</p></div>
  <div class="card"><h3>Estado</h3><p class="big blue">BOT ON</p></div>
</div>

<div class="card">
  <h2>Acciones que el bot está operando</h2>
  <table>
    <tr><th>Activo</th><th>Precio</th><th>Día</th><th>Shares Bot</th><th>Valor</th><th>Acción</th></tr>
    ${rows}
  </table>
</div>

<div class="card">
  <h2>Bitácora de movimientos ficticios</h2>
  <ul>${trades.length ? trades.map(t=>`<li>${t}</li>`).join("") : "<li>Esperando señales...</li>"}</ul>
</div>

<div class="card">
  <p>Update: ${lastUpdate} | Modo: simulación ficticia, no compra ni vende dinero real.</p>
</div>

</body>
</html>
`);
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log(`Trading AI ficticio listo en http://localhost:${PORT}`);
});
