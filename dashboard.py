from flask import Flask, render_template_string
import json, os

app = Flask(__name__)

HTML = """
<!doctype html>
<html>
<head>
  <meta http-equiv="refresh" content="5">
  <title>Corde Bot Dashboard</title>
  <style>
    body { background:#080808; color:white; font-family:Arial; padding:25px; }
    .card { background:#151515; padding:20px; border-radius:14px; margin-bottom:18px; }
    .green { color:#00ff88; }
    .red { color:#ff4d4d; }
    table { width:100%; border-collapse:collapse; }
    td, th { padding:10px; border-bottom:1px solid #333; text-align:left; }
  </style>
</head>
<body>
  <h1>📈 CORDE TRADING BOT</h1>
  <div class="card">
    <h2>Equity: <span class="green">${{ equity }}</span></h2>
    <h2>Cash: ${{ cash }}</h2>
    <h2>P&L: <span class="{{ color }}">${{ pnl }}</span></h2>
    <p>Regime: {{ regime }} | Positions: {{ positions }}</p>
  </div>

  <div class="card">
    <h2>Assets</h2>
    <table>
      <tr><th>Asset</th><th>Price</th><th>RSI</th><th>Signal</th><th>Status</th></tr>
      {% for a in assets %}
      <tr>
        <td>{{ a.symbol }}</td>
        <td>${{ a.price }}</td>
        <td>{{ a.rsi }}</td>
        <td>{{ a.signal }}</td>
        <td>{{ a.status }}</td>
      </tr>
      {% endfor %}
    </table>
  </div>
</body>
</html>
"""

@app.route("/")
def home():
    data = {
        "equity": "100,000.00",
        "cash": "51,636.36",
        "pnl": "0.00",
        "regime": "BULL",
        "positions": 4,
        "assets": []
    }

    if os.path.exists("state.json"):
        with open("state.json") as f:
            data.update(json.load(f))

    pnl_num = float(str(data.get("pnl", "0")).replace(",", ""))
    color = "green" if pnl_num >= 0 else "red"

    return render_template_string(HTML, **data, color=color)

app.run(host="0.0.0.0", port=5000)
