const http = require("http");

const API_KEY = process.env.FINNHUB_API_KEY;

const portfolio = [
  { symbol: "MSFT", name: "Microsoft", shares: 0.12, costValue: 53.03 },
  { symbol: "GEV", name: "GE Vernova", shares: 0.023, costValue: 21.72 },
  { symbol: "IREN", name: "IREN", shares: 0.17, costValue: 11.13 },
  { symbol: "PLTR", name: "Palantir", shares: 0.016, costValue: 2.49 },
  { symbol: "AEP", name: "American Electric Power", shares: 0.0086, costValue: 1.06 },
  { symbol: "UNH", name: "UnitedHealth", shares: 0.0027, costValue: 1.02 },
  { symbol: "SSYS", name: "Stratasys", shares: 0.094, costValue: 0.995 },
  { symbol: "PATH", name: "UiPath", shares: 0.058, costValue: 0.744 },
  { symbol: "COPX", name: "Global X Copper Miners ETF", shares: 0.22, costValue: 19.57 }
];

let quotes = {};
let lastUpdate = "Cargando...";
let portfolioHistory = [];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getQuote(symbol) {
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEY}`);
    const data = await res.json();

    quotes[symbol] = {
      price: data.c || 0,
      percent: data.dp || 0
    };
  } catch (error) {
    console.log("Error con", symbol, error.message);
  }
}

async function updateMarket() {
  for (const asset of portfolio) {
    await getQuote(asset.symbol);
    await sleep(500);
  }

  lastUpdate = new Date().toLocaleTimeString();

  const totalValue = portfolio.reduce((sum, asset) => {
    const q = quotes[asset.symbol] || { price: 0 };
    return sum + q.price * asset.shares;
  }, 0);

  if (totalValue > 0) {
    portfolioHistory.push({
      time: lastUpdate,
      value: Number(totalValue.toFixed(2))
    });

    if (portfolioHistory.length > 30) {
      portfolioHistory.shift();
    }
  }
}

setInterval(updateMarket, 30000);
updateMarket();

function getAlerts(totalGainPercent) {
  let alerts = [];

  for (const asset of portfolio) {
    const q = quotes[asset.symbol] || { percent: 0 };

    if (q.percent >= 5) {
      alerts.push(`🚀 ${asset.symbol}: Momentum fuerte, sube ${q.percent.toFixed(2)}%`);
    }

    if (q.percent <= -5) {
      alerts.push(`⚠️ ${asset.symbol}: Caída fuerte, revisar entrada o riesgo`);
    }
  }

  if (totalGainPercent >= 10) {
    alerts.push(`💰 Portafolio: Buen rendimiento total, arriba de 10%`);
  }

  if (alerts.length === 0) {
    alerts.push("✅ Sin alertas fuertes por ahora. Mercado estable.");
  }

  return alerts;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  let totalValue = 0;
  let totalCost = 0;

  const rows = portfolio.map(asset => {
    const q = quotes[asset.symbol] || { price: 0, percent: 0 };
    const value = q.price * asset.shares;
    const gain = value - asset.costValue;

    totalValue += value;
    totalCost += asset.costValue;

    return `
      <tr>
        <td><b>${asset.symbol}</b><br><span>${asset.name}</span></td>
        <td>$${q.price.toFixed(2)}</td>
        <td>$${value.toFixed(2)}</td>
        <td style="color:${gain >= 0 ? "#00ff99" : "#ff4d6d"}">$${gain.toFixed(2)}</td>
        <td style="color:${q.percent >= 0 ? "#00ff99" : "#ff4d6d"}">${q.percent.toFixed(2)}%</td>
      </tr>
    `;
  }).join("");

  const totalGain = totalValue - totalCost;
  const totalGainPercent = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
  const alerts = getAlerts(totalGainPercent);

  const chartLabels = JSON.stringify(portfolioHistory.map(x => x.time));
  const chartValues = JSON.stringify(portfolioHistory.map(x => x.value));

  res.end(`
  <html>
  <head>
    <meta http-equiv="refresh" content="15">
    <title>CORDE AI</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
      body{background:#0b0f14;color:white;font-family:Arial;padding:20px;}
      h1{color:#00ff99;}
      .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;}
      .card{background:#1a1f29;padding:20px;border-radius:15px;margin-bottom:15px;}
      .big{font-size:28px;font-weight:bold;}
      .green{color:#00ff99;}
      .red{color:#ff4d6d;}
      table{width:100%;border-collapse:collapse;}
      th,td{padding:12px;text-align:left;border-bottom:1px solid #333;}
      th{color:#00ff99;}
      span{color:#9ca3af;font-size:13px;}
      li{margin-bottom:10px;}
      @media(max-width:900px){.grid{grid-template-columns:1fr;}table{font-size:12px;}}
    </style>
  </head>

  <body>
    <h1>🚀 CORDE AI PORTFOLIO</h1>

    <div class="grid">
      <div class="card"><h3>Valor actual</h3><p class="big">$${totalValue.toFixed(2)}</p></div>
      <div class="card"><h3>Costo base</h3><p class="big">$${totalCost.toFixed(2)}</p></div>
      <div class="card"><h3>P&L total</h3><p class="big ${totalGain >= 0 ? "green" : "red"}">$${totalGain.toFixed(2)}</p></div>
      <div class="card"><h3>Rendimiento</h3><p class="big ${totalGainPercent >= 0 ? "green" : "red"}">${totalGainPercent.toFixed(2)}%</p></div>
    </div>

    <div class="card">
      <h2>Gráfica del portafolio</h2>
      <canvas id="portfolioChart"></canvas>
    </div>

    <div class="card">
      <h2>Alertas CORDE AI</h2>
      <ul>${alerts.map(a => `<li>${a}</li>`).join("")}</ul>
    </div>

    <div class="card">
      <h2>Mi portafolio real</h2>
      <table>
        <tr><th>Activo</th><th>Precio</th><th>Valor</th><th>Ganancia</th><th>Día</th></tr>
        ${rows}
      </table>
    </div>

    <div class="card">
      <p>Update: ${lastUpdate} | API: Finnhub | Modo: análisis / paper trading</p>
    </div>

    <script>
      new Chart(document.getElementById("portfolioChart"), {
        type: "line",
        data: {
          labels: ${chartLabels},
          datasets: [{
            label: "Valor del portafolio",
            data: ${chartValues},
            borderWidth: 2,
            tension: 0.35
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: "white" } } },
          scales: {
            x: { ticks: { color: "white" } },
            y: { ticks: { color: "white" } }
          }
        }
      });
    </script>
  </body>
  </html>
  `);
});

server.listen(3000, () => {
  console.log("CORDE AI con gráficas y alertas listo en http://localhost:3000");
});
