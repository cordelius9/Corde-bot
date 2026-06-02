const http = require("http");
const https = require("https");

const API_KEY = process.env.FINNHUB_API_KEY;

const portfolio = [
  { symbol: "MSFT", shares: 0.12, costValue: 53.03 },
  { symbol: "GEV", shares: 0.023, costValue: 21.72 },
  { symbol: "IREN", shares: 0.17, costValue: 11.13 },
  { symbol: "PLTR", shares: 0.016, costValue: 2.49 },
  { symbol: "AEP", shares: 0.0086, costValue: 1.06 },
  { symbol: "UNH", shares: 0.0027, costValue: 1.02 },
  { symbol: "SSYS", shares: 0.094, costValue: 0.995 },
  { symbol: "PATH", shares: 0.058, costValue: 0.744 },
  { symbol: "COPX", shares: 0.22, costValue: 19.57 }
];

let quotes = {};
let lastUpdate = "Cargando...";

function getQuote(symbol) {
  return new Promise((resolve) => {
    const url = "https://finnhub.io/api/v1/quote?symbol=" + symbol + "&token=" + API_KEY;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const d = JSON.parse(data);
          quotes[symbol] = { price: d.c || 0, percent: d.dp || 0 };
        } catch(e) {
          console.log("Parse error", symbol);
        }
        resolve();
      });
    }).on("error", (e) => {
      console.log("Error", symbol, e.message);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function update() {
  for (const a of portfolio) {
    await getQuote(a.symbol);
    await sleep(500);
  }
  lastUpdate = new Date().toLocaleTimeString();
}

setInterval(update, 60000);
update();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  let tv = 0, tc = 0;
  const rows = portfolio.map(a => {
    const q = quotes[a.symbol] || { price: 0, percent: 0 };
    const v = q.price * a.shares;
    const g = v - a.costValue;
    tv += v;
    tc += a.costValue;
    const gc = g >= 0 ? "#00ff99" : "#ff4d6d";
    const pc = q.percent >= 0 ? "#00ff99" : "#ff4d6d";
    return "<tr><td><b>" + a.symbol + "</b></td><td>$" + q.price.toFixed(2) + "</td><td>$" + v.toFixed(2) + "</td><td style='color:" + gc + "'>$" + g.toFixed(2) + "</td><td style='color:" + pc + "'>" + q.percent.toFixed(2) + "%</td></tr>";
  }).join("");

  const tg = tv - tc;
  const tgp = tc > 0 ? (tg / tc * 100) : 0;
  const gc = tg >= 0 ? "#00ff99" : "#ff4d6d";

  res.end("<!DOCTYPE html><html><head><meta http-equiv='refresh' content='60'><title>CORDE AI</title><style>body{background:#0b0f14;color:white;font-family:Arial;padding:20px}h1{color:#00ff99}.card{background:#1a1f29;padding:20px;border-radius:15px;margin-bottom:15px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:15px}.big{font-size:24px;font-weight:bold}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #333;text-align:left}th{color:#00ff99}</style></head><body><h1>CORDE AI PORTFOLIO</h1><div class='grid'><div class='card'><p>Valor total</p><p class='big'>$" + tv.toFixed(2) + "</p></div><div class='card'><p>P&L total</p><p class='big' style='color:" + gc + "'>$" + tg.toFixed(2) + " (" + tgp.toFixed(1) + "%)</p></div></div><div class='card'><table><tr><th>Activo</th><th>Precio</th><th>Valor</th><th>Ganancia</th><th>Dia</th></tr>" + rows + "</table></div><div class='card'><p>Update: " + lastUpdate + " | API: Finnhub</p></div></body></html>");
});

server.listen(3000, () => console.log("CORDE AI listo en http://localhost:3000"));
