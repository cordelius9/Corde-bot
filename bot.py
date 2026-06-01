import time, math, json, urllib.request
from datetime import datetime

ASSETS = ["MSFT","GEV","IREN","COPX","PLTR","MU","SPY","QQQ","BTC-USD","ETH-USD","XRP-USD"]
SCAN_INTERVAL = 60
INITIAL_CAPITAL = 100000
REGIME_ALLOC = {"CRASH":0.10,"BEAR":0.40,"NEUTRAL":0.60,"BULL":0.95,"EUPHORIA":0.95}
portfolio = {"cash": INITIAL_CAPITAL, "positions": {}, "equity": INITIAL_CAPITAL}
peak_equity = INITIAL_CAPITAL
circuit_breaker = False

def fetch_yahoo(ticker):
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=6mo"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
        result = data["chart"]["result"][0]
        closes = [c for c in result["indicators"]["quote"][0]["close"] if c]
        return closes
    except Exception as e:
        print(f"  ⚠ {ticker}: {e}")
        return None

def rsi(closes, p=14):
    if len(closes) < p+1: return 50
    gains = losses = 0
    for i in range(-p, 0):
        d = closes[i] - closes[i-1]
        if d > 0: gains += d
        else: losses -= d
    if losses == 0: return 100
    return round(100 - 100/(1 + gains/losses), 1)

def ma(closes, p):
    if len(closes) < p: return None
    return sum(closes[-p:])/p

def regime(closes):
    if len(closes) < 20: return "NEUTRAL", 50
    rets = [(closes[i]-closes[i-1])/closes[i-1] for i in range(1,len(closes))]
    r = rets[-20:]
    mean = sum(r)/len(r)
    vol = math.sqrt(sum((x-mean)**2 for x in r)/len(r))
    am, av = mean*252, vol*math.sqrt(252)
    if am < -0.30 or av > 0.60: reg = "CRASH"
    elif am < 0 or av > 0.35: reg = "BEAR"
    elif am < 0.10: reg = "NEUTRAL"
    elif av > 0.35: reg = "EUPHORIA"
    else: reg = "BULL"
    return reg, min(99, int(60 + abs(am)*80))

def signal(rsi_v, price, ma50, ma200, reg):
    s = 0
    if rsi_v < 28: s += 3
    elif rsi_v < 38: s += 1
    elif rsi_v > 72: s -= 3
    elif rsi_v > 62: s -= 1
    if ma50 and ma200:
        if price > ma50 > ma200: s += 2
        elif price > ma50: s += 1
        elif price < ma50 < ma200: s -= 2
        elif price < ma50: s -= 1
    if reg in ("BULL","EUPHORIA"): s += 1
    if reg == "CRASH": s -= 2
    if s >= 4: return "STRONG_BUY"
    if s >= 2: return "BUY"
    if s <= -3: return "STRONG_SELL"
    if s <= -1: return "SELL"
    return "NEUTRAL"

def run():
    global portfolio, peak_equity, circuit_breaker
    print("="*50)
    print(" CORDE TRADING BOT — PAPER MODE")
    print(f" {len(ASSETS)} assets | interval: {SCAN_INTERVAL}s")
    print("="*50)
    while True:
        now = datetime.now().strftime("%H:%M:%S")
        print(f"\n[{now}] SCAN ──────────────────")
        spy = fetch_yahoo("SPY")
        mreg, mconf = regime(spy) if spy else ("NEUTRAL", 50)
        alloc = REGIME_ALLOC[mreg]
        print(f"  REGIME: {mreg} ({mconf}%) | ALLOC: {alloc:.0%}")
        print(f"  EQUITY: ${portfolio['equity']:,.2f} | CASH: ${portfolio['cash']:,.2f}")
        peak_equity = max(peak_equity, portfolio["equity"])
        dd = (peak_equity - portfolio["equity"]) / peak_equity
        if dd > 0.05:
            circuit_breaker = True
            print(f"  🚨 CIRCUIT BREAKER: {dd:.1%} drawdown")
        if circuit_breaker:
            print("  Bot detenido. Reinicia para resetear.")
            time.sleep(SCAN_INTERVAL)
            continue
        for tk in ASSETS:
            closes = fetch_yahoo(tk)
            if not closes or len(closes) < 3: continue
            price = closes[-1]
            chg = (price - closes[-2]) / closes[-2] * 100
            r = rsi(closes)
            m50 = ma(closes, 50)
            m200 = ma(closes, 200)
            sig = signal(r, price, m50, m200, mreg)
            holding = tk in portfolio["positions"]
            pf = f"${price:>10,.2f}" if price > 10 else f"${price:>10,.4f}"
            print(f"  {tk:<8} {pf} {chg:+.1f}% | RSI={r:>4.0f} | {sig:<12} | {'HOLD' if holding else 'FLAT'}")
            if sig in ("STRONG_BUY","BUY") and not holding and mreg != "CRASH":
                size = 1.0 if sig == "STRONG_BUY" else 0.6
                spend = min(portfolio["equity"]*alloc*size*(1/len(ASSETS))*2, portfolio["cash"]*0.9)
                if spend >= 1:
                    qty = spend / price
                    portfolio["cash"] -= spend
                    portfolio["positions"][tk] = {"qty": qty, "avg": price}
                    print(f"    ✅ BUY {qty:.4f} {tk} @ ${price:.2f} | spent=${spend:.2f}")
            elif holding:
                pos = portfolio["positions"][tk]
                pnl_pct = (price - pos["avg"]) / pos["avg"]
                if sig in ("SELL","STRONG_SELL") or pnl_pct < -0.07:
                    proceeds = pos["qty"] * price
                    pnl = (price - pos["avg"]) * pos["qty"]
                    portfolio["cash"] += proceeds
                    del portfolio["positions"][tk]
                    print(f"    🔴 SELL {tk} | P&L: {'+' if pnl>=0 else ''}${pnl:.2f}")
        pos_val = 0
        for tk, pos in list(portfolio["positions"].items()):
            c = fetch_yahoo(tk)
            if c: pos_val += pos["qty"] * c[-1]
        portfolio["equity"] = portfolio["cash"] + pos_val
        pnl_total = portfolio["equity"] - INITIAL_CAPITAL
        print(f"\n  P&L: {'+' if pnl_total>=0 else ''}${pnl_total:,.2f} | Posiciones: {len(portfolio['positions'])}")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Próximo scan en {SCAN_INTERVAL}s")
        time.sleep(SCAN_INTERVAL)

if __name__ == "__main__":
    run()
