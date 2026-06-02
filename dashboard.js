const http = require("http");

let capital = 100000;
let btc = 105000;
let eth = 5200;
let pnl = 0;

setInterval(() => {
  btc += (Math.random() - 0.5) * 500;
  eth += (Math.random() - 0.5) * 20;
  pnl += (Math.random() - 0.5) * 100;

  capital = 100000 + pnl;
}, 1000);

const server = http.createServer((req, res) => {

  res.writeHead(200, {
    "Content-Type": "text/html"
  });

  res.end(`
  <html>
  <head>

  <meta http-equiv="refresh" content="1">

  <title>CORDE AI TRADING</title>

  <style>

  body{
    background:#0b0f14;
    color:white;
    font-family:Arial;
    padding:20px;
  }

  .card{
    background:#1a1f29;
    padding:20px;
    border-radius:15px;
    margin-bottom:15px;
  }

  h1{
    color:#00ff99;
  }

  .green{
    color:#00ff99;
  }

  </style>

  </head>

  <body>

  <h1>🚀 CORDE AI TRADING</h1>

  <div class="card">
    <h2>Capital</h2>
    <p>$${capital.toFixed(2)}</p>
  </div>

  <div class="card">
    <h2>BTC/USD</h2>
    <p>$${btc.toFixed(2)}</p>
  </div>

  <div class="card">
    <h2>ETH/USD</h2>
    <p>$${eth.toFixed(2)}</p>
  </div>

  <div class="card">
    <h2>P&L Diario</h2>
    <p class="green">$${pnl.toFixed(2)}</p>
  </div>

  <div class="card">
    <h2>Operaciones</h2>
    <p>3 abiertas</p>
  </div>

  </body>
  </html>
  `);

});

server.listen(3000, () => {
  console.log("Dashboard PRO listo en puerto 3000");
});
