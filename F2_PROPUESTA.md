# Cordelius Trading — Propuesta F2 / F3

**Generado:** 2026-06-04  
**Base analizada:** `dashboard.js` (1086 líneas), `bot.js`, `trading_ai.js`, `.gitignore`  
**Rama activa:** `claude/cordelius-trading-refactor-P8gFi`

---

## 1. DIAGNÓSTICO DE ARQUITECTURA

### 1.1 Vista general

```
┌─────────────────────────────────────────────────────────┐
│                   dashboard.js (Node HTTP)               │
│                                                         │
│  PORTFOLIO[]  →  portfolioValue()  →  render() HTML     │
│                      ↓                                   │
│  refreshQuotes()  →  quotes{}  (Finnhub / manual-drift)  │
│                      ↓                                   │
│  indicators()     →  rsi, macd, momentum, trend          │
│  alfredoAction()  →  señal de acción educativa           │
│  askClaude()      →  Claude API (Anthropic)              │
│  botTick()        →  bot ficticio (paper trading)        │
│  handleIntel()    →  intelItems[] → cordelius_intel.json │
└─────────────────────────────────────────────────────────┘

┌─────────────────┐   ┌──────────────────┐
│   bot.js        │   │  trading_ai.js   │
│  Telegram Bot   │   │  Simulador port  │
│  Claude Haiku   │   │  3001 (Finnhub)  │
└─────────────────┘   └──────────────────┘
```

### 1.2 Lo que funciona bien

| Componente | Estado |
|---|---|
| Servidor HTTP + routing | Estable, funciona en Termux |
| Claude AI (Alfredo) | Integrado, prompt con contexto rico |
| Intel manual | Funcional con análisis de mood/tags |
| Bot ficticio | Paper trading con métricas completas |
| Endpoints F1: `/health`, `/api/*` | Recién agregados, funcionando |
| Variables de entorno | Correctamente cargadas desde `.env` |
| `.env` protegido | Nunca en git ✓ |

---

## 2. BUGS DETECTADOS

### BUG-01 — Severidad: MEDIA
**`analyzeIntelText()` detecta "ia" con falsos positivos**

```javascript
// dashboard.js línea 641
const positiveWords = ["bullish", "sube", "subir", "compra", "buy", 
                       "crecimiento", "ai", "ia", ...];
```

El match es `lower.includes("ia")`. Palabras como *"seria"*, *"confianza"*, *"via"*, *"hacia"*, *"habia"*, *"diaria"* todas activan el flag POSITIVO. En textos largos en español esto corrompe el análisis de mood.

**Fix propuesto:**
```javascript
// Reemplazar includes() simple por word-boundary regex
const matchWord = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(text);
const pos = positiveWords.filter(w => matchWord(lower, w)).length;
const neg = negativeWords.filter(w => matchWord(lower, w)).length;
```

---

### BUG-02 — Severidad: MEDIA
**`handleIntel()` no deduplica — duplica en doble-submit**

```javascript
// dashboard.js línea 994
intelItems.unshift(analyzeIntelText(text.trim())); // sin check de dup
```

Si el usuario hace submit y luego recarga, el formulario POST no se vuelve a enviar, pero si hay un bug de red o el usuario hace doble click, el mismo texto se guarda dos veces. Además no hay forma de borrar entradas desde la UI.

**Fix propuesto:**
```javascript
function hashText(text) {
  return text.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0).toString(36);
}

// En handleIntel():
const newHash = hashText(text.trim().slice(0, 200));
const isDup = intelItems.some(x => x.hash === newHash);
if (!isDup) {
  const item = analyzeIntelText(text.trim());
  item.hash = newHash;  // agregar hash al objeto
  intelItems.unshift(item);
}
```

---

### BUG-03 — Severidad: MEDIA
**`assetGainPct()` ignora cotizaciones live para el % de ganancia**

```javascript
// dashboard.js línea 120
function assetGainPct(a) {
  if (Number.isFinite(a.brokerGainPct)) return a.brokerGainPct; // ← SIEMPRE retorna esto
  // ...el cálculo live nunca se ejecuta porque todos tienen brokerGainPct
}
```

Todos los 18 activos tienen `brokerGainPct` definido. Aunque Finnhub traiga un precio nuevo para MSFT, el % de ganancia mostrado seguirá siendo el hardcodeado `-1.28%` para NFLX, etc. El valor en MXN sí se actualiza via `assetValueMXN()`, pero el % mostrado no.

**Fix propuesto:** Condicionar el uso de `brokerGainPct` solo cuando la fuente es manual/gbm/bitso, no cuando hay quote live de Finnhub.

```javascript
function assetGainPct(a) {
  const q = quotes[a.symbol];
  if (q && q.source === "finnhub" && Number.isFinite(q.value)) {
    const c = assetCostMXN(a), v = assetValueMXN(a);
    return c ? ((v - c) / c) * 100 : 0;
  }
  if (Number.isFinite(a.brokerGainPct)) return a.brokerGainPct;
  const c = assetCostMXN(a), v = assetValueMXN(a);
  return c ? ((v - c) / c) * 100 : 0;
}
```

---

### BUG-04 — Severidad: BAJA
**`bot.js` usa `CLAUDE_API_KEY` en vez de `ANTHROPIC_API_KEY`**

```javascript
// bot.js línea 9
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
```

El dashboard usa `ANTHROPIC_API_KEY`. Si el usuario solo define `ANTHROPIC_API_KEY` en `.env`, el bot de Telegram falla silenciosamente con `undefined` como API key. Los errores de Anthropic por key inválida generan una excepción que está atrapada, pero el bot responderá siempre "Error procesando mensaje."

**Fix propuesto:**
```javascript
// bot.js línea 9
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || ""
});
```

---

### BUG-05 — Severidad: BAJA
**`bot.js` usa modelo sin sufijo de fecha**

```javascript
// bot.js línea 23
model: "claude-haiku-4-5",  // sin fecha: puede no resolver correctamente
```

Según CLAUDE.md el modelo correcto es `claude-haiku-4-5-20251001`.

**Fix propuesto:**
```javascript
model: process.env.CLAUDE_MODEL_BOT || "claude-haiku-4-5-20251001",
```

---

### BUG-06 — Severidad: BAJA
**`refreshQuotes()` aplica drift aleatorio en GBM/Bitso en cada ciclo**

```javascript
// dashboard.js línea 95
const drift = ((Math.random() - 0.5) * 1.8); // ±0.9% aleatorio cada 60s
quotes[a.symbol] = { ..., value: a.valueManual * (1 + drift / 100), day: drift };
```

El `day` (% cambio del día) se regenera aleatoriamente en cada refresh. Esto significa que el mismo activo puede mostrar +0.8% hoy y -0.7% dentro de 60 segundos sin razón real. El `trend` e indicadores calculados sobre `day` fluctúan artificialmente, haciendo que el score y la señal de Alfredo cambien sin fundamento.

**Impacto educativo:** Confunde al usuario porque las señales parecen cambiar solas.

**Fix propuesto:** Calcular un drift base seeded por el día del año, no random puro:
```javascript
function stableDrift(symbol) {
  const dayOfYear = Math.floor(Date.now() / 86400000);
  const seed = seedFor(symbol) + dayOfYear;
  return ((seed % 180) - 90) / 100; // ±0.9% estable por día
}
```

---

### BUG-07 — Severidad: BAJA
**`handleAsk()` hace 302 redirect, no retorna el reply al cliente**

```javascript
// dashboard.js línea 982
if (q.trim()) await alfredoReply(q.trim());
res.writeHead(302, { Location: "/#alfredo" }); res.end(); // ← solo redirect
```

Si alguien consume `/ask` como API (fetch, curl), solo recibe un redirect 302. El reply de Claude nunca llega como respuesta HTTP directa. Funciona en el browser porque el formulario HTML hace el redirect y recarga la página donde está el chatHistory. Pero bloquea integración con Telegram o apps externas.

**Fix propuesto:** Detectar si el request viene como API (Accept: application/json) y responder JSON:
```javascript
async function handleAsk(req, res) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    const q = new URLSearchParams(body).get("q") || "";
    const wantsJson = (req.headers["accept"] || "").includes("application/json");
    if (q.trim()) {
      const reply = await alfredoReply(q.trim());
      if (wantsJson) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, question: q, reply }));
      }
    }
    res.writeHead(302, { Location: "/#alfredo" }); res.end();
  });
}
```

---

### BUG-08 — Severidad: COSMÉTICA
**`.gitignore` tiene 99 líneas con muchas entradas duplicadas y basura**

Las entradas `insertar`, `reemplazar`, `5` aparecen 3 veces cada una. El bloque completo se repite 4+ veces. No es un bug funcional pero dificulta mantenimiento.

---

## 3. MEJORAS PARA INTEL PANEL (F2a)

### Estado actual

```javascript
// Limitaciones actuales del panel Intel
renderIntelPanel(): {
  - Muestra máximo 10 ítems (slice(0, 10))
  - Sin filtros de mood
  - Sin filtros por ticker
  - Sin botón de borrar
  - Sin contador visible en UI
  - Sin deduplicación
  - Sin búsqueda de texto
  - Sin hash de ítems
}
```

### Mejoras propuestas — detalle de implementación

#### 3.1 Counter badge en el título

```javascript
// En render() donde aparece el título de Intel
`<h2>Cordelius Intelligence — Grok / X manual 
  <span class="badge">${intelItems.length}</span>
</h2>`
```

CSS:
```css
.badge { background: #3b9dff; color: #fff; border-radius: 99px; 
         padding: 2px 10px; font-size: 13px; margin-left: 8px; }
```

---

#### 3.2 Filtros de mood (client-side, sin backend)

Implementación: chips HTML + JS inline que filtran los divs por clase.

```html
<div class="intel-filters">
  <button onclick="filterIntel('ALL')"   class="chip active">Todos</button>
  <button onclick="filterIntel('POS')"   class="chip pos">POSITIVO</button>
  <button onclick="filterIntel('NEG')"   class="chip neg">NEGATIVO</button>
  <button onclick="filterIntel('NEU')"   class="chip neu">NEUTRAL</button>
</div>
```

```javascript
function filterIntel(type) {
  document.querySelectorAll('.intel-item').forEach(el => {
    el.style.display = 
      (type === 'ALL' || el.dataset.mood === type) ? '' : 'none';
  });
  document.querySelectorAll('.intel-filters .chip')
    .forEach(b => b.classList.toggle('active', b.textContent === type || type === 'ALL'));
}
```

Cada card debe tener `data-mood="POS"` (o NEG/NEU) en su div.

---

#### 3.3 Filtro por ticker afectado

```html
<select id="intel-ticker" onchange="filterByTicker(this.value)">
  <option value="">Todos los tickers</option>
  <!-- generado desde intelItems.flatMap(x=>x.affected) deduplicado -->
</select>
```

En `renderIntelPanel()`, generar el `<select>` con los tickers únicos encontrados en todos los ítems:
```javascript
const allTickers = [...new Set(intelItems.flatMap(x => x.affected || []))].sort();
const tickerOptions = ["", ...allTickers].map(t => 
  `<option value="${esc(t)}">${t || "Todos los tickers"}</option>`
).join("");
```

---

#### 3.4 Borrar ítem individual

**Nuevo endpoint:** `POST /intel/delete`  
Body: `id=<hash_del_item>`

```javascript
// Agregar en el router (server)
if (req.method === "POST" && req.url === "/intel/delete") {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const id = new URLSearchParams(body).get("id") || "";
    intelItems = intelItems.filter(x => x.hash !== id);
    saveJSON(INTEL_FILE, intelItems);
    res.writeHead(302, { Location: "/#intel" }); res.end();
  });
  return;
}
```

En cada card de Intel:
```html
<form method="POST" action="/intel/delete" style="display:inline">
  <input type="hidden" name="id" value="${esc(x.hash)}">
  <button type="submit" class="btn-delete" title="Borrar">✕</button>
</form>
```

**Nuevo endpoint:** `POST /intel/clear` (borrar todos):
```javascript
if (req.method === "POST" && req.url === "/intel/clear") {
  intelItems = [];
  saveJSON(INTEL_FILE, intelItems);
  res.writeHead(302, { Location: "/#intel" }); res.end();
  return;
}
```

---

#### 3.5 Deduplicación con hash

```javascript
// Agregar en analyzeIntelText()
function hashText(text) {
  return String(text).split("").reduce(
    (h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0
  ).toString(36).replace("-", "n");
}

// En handleIntel() antes de unshift:
const newHash = hashText(text.trim().slice(0, 300));
if (intelItems.some(x => x.hash === newHash)) {
  res.writeHead(302, { Location: "/#intel" }); res.end(); return;
}
const item = analyzeIntelText(text.trim());
item.hash = newHash;
intelItems.unshift(item);
```

---

#### 3.6 Búsqueda de texto (client-side)

```html
<input type="text" id="intel-search" placeholder="Buscar en Intel..." 
       oninput="searchIntel(this.value)"
       style="width:100%;padding:10px;background:#07111f;color:#e5f2ff;
              border:1px solid rgba(120,160,210,.25);border-radius:12px;margin-bottom:12px">
```

```javascript
function searchIntel(q) {
  const lower = q.toLowerCase();
  document.querySelectorAll('.intel-item').forEach(el => {
    el.style.display = (!q || el.textContent.toLowerCase().includes(lower)) ? '' : 'none';
  });
}
```

---

#### 3.7 Resumen de impacto Intel por ticker

Nuevo bloque visual que muestra qué tickers tienen más mención en Intel:

```javascript
function renderIntelSummary(items) {
  const counts = {};
  items.forEach(x => (x.affected || []).forEach(t => counts[t] = (counts[t]||0)+1));
  const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 8);
  if (!sorted.length) return "";
  return `<div class="intel-tickers">` +
    sorted.map(([t, n]) => `<span class="chip">${esc(t)} <b>${n}</b></span>`).join("") +
    `</div>`;
}
```

---

## 4. INTEGRACIÓN QUIVER QUANTITATIVE

### 4.1 Contexto

`QUIVER_API_KEY` ya está en el código (`dashboard.js` línea 8 y 970). El UI ya muestra "PENDIENTE" cuando no hay clave. La integración solo requiere conectar el endpoint.

Quiver Quant tiene endpoints gratuitos y de pago. Los gratuitos relevantes:

| Endpoint | Datos | URL |
|---|---|---|
| Congressional Trading | Compras/ventas de congresistas USA | `/beta/live/congresstrading` |
| Insider Trading | Transacciones de insiders (Form 4) | `/beta/live/insiders` |
| Government Contracts | Contratos federales por empresa | `/beta/live/govcontracts` |
| Lobbying | Actividad de lobby por empresa | `/beta/live/lobbying` |

Base URL: `https://api.quiverquant.com`

### 4.2 Función `fetchQuiverData()` propuesta

```javascript
let quiverData = { congressional: [], insider: [], contracts: [], lastFetch: 0 };

async function fetchQuiverData() {
  if (!QUIVER_API_KEY) return;
  const stale = Date.now() - quiverData.lastFetch > 1000 * 60 * 30; // 30 min
  if (!stale) return;

  const headers = { "Authorization": `Token ${QUIVER_API_KEY}`, "Accept": "application/json" };

  async function quiverGet(path) {
    return new Promise(resolve => {
      const opts = {
        hostname: "api.quiverquant.com",
        path,
        headers,
        timeout: 12000
      };
      const req = https.get(opts, res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
  }

  const [cong, insider, contracts] = await Promise.all([
    quiverGet("/beta/live/congresstrading"),
    quiverGet("/beta/live/insiders"),
    quiverGet("/beta/live/govcontracts")
  ]);

  const portfolioSymbols = new Set(PORTFOLIO.map(a => a.symbol));

  // Filtrar solo lo relevante para el portafolio
  if (Array.isArray(cong)) {
    quiverData.congressional = cong
      .filter(x => portfolioSymbols.has((x.Ticker || "").toUpperCase()))
      .slice(0, 20)
      .map(x => ({
        ticker: x.Ticker,
        name: x.Representative,
        party: x.Party,
        type: x.Transaction,
        amount: x.Amount,
        date: x.Date
      }));
  }

  if (Array.isArray(insider)) {
    quiverData.insider = insider
      .filter(x => portfolioSymbols.has((x.Ticker || "").toUpperCase()))
      .slice(0, 20)
      .map(x => ({
        ticker: x.Ticker,
        name: x.Name,
        role: x.Relationship,
        type: x.Transaction,
        shares: x.Shares,
        value: x.Value,
        date: x.TransactionDate
      }));
  }

  if (Array.isArray(contracts)) {
    quiverData.contracts = contracts
      .filter(x => portfolioSymbols.has((x.Ticker || "").toUpperCase()))
      .slice(0, 20)
      .map(x => ({
        ticker: x.Ticker,
        agency: x.Agency,
        amount: x.Amount,
        date: x.Date
      }));
  }

  quiverData.lastFetch = Date.now();
  console.log(`Quiver: ${quiverData.congressional.length} congressional, ${quiverData.insider.length} insider`);
}
```

### 4.3 Renderizado del panel Quiver

```javascript
function renderQuiverPanel() {
  if (!QUIVER_API_KEY) {
    return `<div class="panel muted">
      Configura QUIVER_API_KEY en .env para ver datos institucionales.
      <a href="https://www.quiverquant.com/api/" target="_blank">Obtener clave gratuita</a>
    </div>`;
  }

  const congRows = quiverData.congressional.length
    ? quiverData.congressional.map(x => `
        <tr>
          <td><b>${esc(x.ticker)}</b></td>
          <td>${esc(x.name)}</td>
          <td class="${x.type === "Purchase" ? "green" : "red"}">${esc(x.type)}</td>
          <td>${esc(x.amount)}</td>
          <td class="muted">${esc(x.date)}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="muted">Sin datos para tus tickers recientes.</td></tr>`;

  const insiderRows = quiverData.insider.length
    ? quiverData.insider.map(x => `
        <tr>
          <td><b>${esc(x.ticker)}</b></td>
          <td>${esc(x.name)}</td>
          <td class="muted">${esc(x.role)}</td>
          <td class="${x.type === "P" || x.type === "Purchase" ? "green" : "red"}">${esc(x.type)}</td>
          <td>${esc(x.value ? "$" + Number(x.value).toLocaleString() : x.shares)}</td>
          <td class="muted">${esc(x.date)}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="muted">Sin datos insider recientes.</td></tr>`;

  return `
    <div class="panel">
      <h3>Congressional Trading</h3>
      <p class="muted">Compras/ventas recientes de congresistas en tus activos</p>
      <table>
        <tr><th>Ticker</th><th>Congresista</th><th>Tipo</th><th>Monto</th><th>Fecha</th></tr>
        ${congRows}
      </table>
    </div>
    <div class="panel">
      <h3>Insider Trading</h3>
      <p class="muted">Transacciones Form 4 de directivos e insiders</p>
      <table>
        <tr><th>Ticker</th><th>Insider</th><th>Rol</th><th>Tipo</th><th>Valor</th><th>Fecha</th></tr>
        ${insiderRows}
      </table>
    </div>`;
}
```

### 4.4 Contexto Quiver para Alfredo AI

Incluir en `askClaude()` dentro del prompt:

```javascript
const quiverContext = QUIVER_API_KEY ? {
  congressionalRecent: quiverData.congressional.slice(0, 5),
  insiderRecent: quiverData.insider.slice(0, 5),
  contractsRecent: quiverData.contracts.slice(0, 3)
} : { note: "QUIVER_API_KEY no configurada" };
```

Agregar al prompt de Alfredo:
```
DATOS INSTITUCIONALES (Quiver Quant):
${JSON.stringify(quiverContext, null, 2)}

8. Si hay compras de congresistas o insiders en un activo, mencionarlo como señal adicional
   (no determinística, solo informativa).
```

---

## 5. SISTEMA DE ALERTAS ALFREDO AI

### 5.1 Tipos de alertas propuestos

| Tipo | Condición | Prioridad |
|---|---|---|
| Drawdown cripto | XRP/ETH/BTC cae >5% en el día | ALTA |
| Score crítico | Cualquier activo baja a score ≤25/100 | ALTA |
| Concentración | Cripto/Bitso > 50% del portafolio | MEDIA |
| Señal BUY DIP | Activo con score>55 cae >3% en el día | MEDIA |
| Toma de ganancia | Activo con >100% ganancia y momentum>2 | MEDIA |
| Intel negativo | Nuevo ítem Intel con mood NEGATIVO que afecta tus activos | MEDIA |
| Congressional buy | Quiver detecta compra de congresista en tu ticker | BAJA |

### 5.2 Motor de alertas

```javascript
// Estado de alertas (en memoria + persistido en JSON)
const ALERTS_FILE = "cordelius_alerts.json";
let activeAlerts = loadJSON(ALERTS_FILE, []);

function checkAlerts() {
  const pv = portfolioValue();
  const reg = marketRegime();
  const now = Date.now();
  const newAlerts = [];

  for (const a of pv.assets) {
    // Drawdown diario fuerte en cripto
    if (a.type === "crypto" && a.day < -5) {
      newAlerts.push({
        id: `dd-${a.symbol}-${Math.floor(now/3600000)}`,
        type: "DRAWDOWN_CRIPTO",
        level: "ALTA",
        symbol: a.symbol,
        text: `${a.symbol} cayó ${a.day.toFixed(1)}% hoy. Cripto volátil: revisar si cambia tesis.`,
        ts: now
      });
    }

    // Score crítico
    if (a.score <= 25) {
      newAlerts.push({
        id: `sc-${a.symbol}-${Math.floor(now/3600000)}`,
        type: "SCORE_CRITICO",
        level: "ALTA",
        symbol: a.symbol,
        text: `${a.symbol} tiene score ${a.score}/100. Señal: ${a.signal}. Vigilar antes de promediar.`,
        ts: now
      });
    }

    // Oportunidad BUY DIP
    if (a.score >= 55 && a.day <= -3) {
      newAlerts.push({
        id: `dip-${a.symbol}-${Math.floor(now/3600000)}`,
        type: "BUY_DIP_OPORT",
        level: "MEDIA",
        symbol: a.symbol,
        text: `${a.symbol} bajó ${a.day.toFixed(1)}% con score ${a.score}/100. Posible dip educativo.`,
        ts: now
      });
    }

    // Toma de ganancia
    if (a.gainPct >= 100 && a.ind.momentum > 2) {
      newAlerts.push({
        id: `tp-${a.symbol}-${Math.floor(now/86400000)}`,
        type: "TOMA_GANANCIA",
        level: "MEDIA",
        symbol: a.symbol,
        text: `${a.symbol} lleva +${a.gainPct.toFixed(0)}% de ganancia con momentum positivo. Considerar toma parcial.`,
        ts: now
      });
    }
  }

  // Concentración cripto
  const cryptoValue = pv.assets.filter(a => a.type === "crypto")
    .reduce((s, a) => s + a.valueMXN, 0);
  const cryptoPct = pv.totalValueMXN ? (cryptoValue / pv.totalValueMXN) * 100 : 0;
  if (cryptoPct > 50) {
    newAlerts.push({
      id: `conc-cripto-${Math.floor(now/86400000)}`,
      type: "CONCENTRACION",
      level: "MEDIA",
      symbol: "BITSO",
      text: `Cripto representa ${cryptoPct.toFixed(0)}% del portafolio. Alta concentración: riesgo elevado.`,
      ts: now
    });
  }

  // Deduplicar por id y agregar
  const existingIds = new Set(activeAlerts.map(x => x.id));
  const filtered = newAlerts.filter(a => !existingIds.has(a.id));
  if (filtered.length) {
    activeAlerts = [...filtered, ...activeAlerts].slice(0, 50);
    saveJSON(ALERTS_FILE, activeAlerts);
    filtered.forEach(a => addThought(`ALERTA ${a.level}: ${a.text}`, a.level === "ALTA" ? "risk" : "warn"));
  }
}

// Llamar en el interval de refreshQuotes:
// try { checkAlerts(); } catch(e) {}
```

### 5.3 Panel de alertas en UI

```javascript
function renderAlertsPanel() {
  const unread = activeAlerts.filter(a => !a.read);
  if (!unread.length) return `<div class="muted">Sin alertas activas.</div>`;

  return unread.map(a => {
    const levelClass = a.level === "ALTA" ? "red" : "yellow";
    return `<div class="alert-card ${levelClass}">
      <div class="alert-head">
        <b class="${levelClass}">${esc(a.level)}</b>
        <span class="chip">${esc(a.symbol)}</span>
        <span class="muted">${new Date(a.ts).toLocaleTimeString("es-MX")}</span>
        <form method="POST" action="/alerts/dismiss" style="display:inline">
          <input type="hidden" name="id" value="${esc(a.id)}">
          <button type="submit" class="btn-xs">Entendido</button>
        </form>
      </div>
      <p>${esc(a.text)}</p>
    </div>`;
  }).join("");
}
```

### 5.4 Notificación vía Telegram (F3)

Cuando se detecta una alerta nivel ALTA, enviar mensaje al bot de Telegram:

```javascript
async function notifyTelegram(alert) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID; // nuevo env var
  if (!token || !chatId) return;

  const text = `🚨 *Cordelius Alerta* — ${alert.level}\n\n${alert.text}\n\n_Solo educativo, no es orden de compra/venta._`;
  
  await apiGet(
    `https://api.telegram.org/bot${token}/sendMessage?` +
    `chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}&parse_mode=Markdown`
  );
}
```

Nueva variable de entorno requerida: `TELEGRAM_CHAT_ID` (ID numérico del chat donde llegar las alertas).

---

## 6. MEJORAS ALFREDO AI

### 6.1 Patrones de conversación faltantes

La función `alfredoReply()` reconoce: `riesgo`, `vender`, `comprar`, `noticia`, `bot`. Faltan:

```javascript
// Patrones nuevos a agregar en alfredoReply():
else if (q.includes("cuanto tengo") || q.includes("cuánto tengo") || q.includes("valor")) {
  reply = `Tu portafolio vale ${money(pv.totalValueMXN)} con ${pct(pv.totalGainPct)} de rendimiento total. Costo original: ${money(pv.totalCostMXN)}. Ganancia: ${money(pv.totalGainMXN)}.`;
}
else if (q.includes("resumen") || q.includes("estado")) {
  reply = `Resumen: ${pv.assets.length} activos en GBM, Plata y Bitso. Régimen ${reg.label}. Top: ${best.symbol} (${pct(best.gainPct)}). Peor: ${worst.symbol} (${pct(worst.gainPct)}). ${intelItems.length} Intel manual activos.`;
}
else if (q.includes("cripto") || q.includes("bitso")) {
  const crypto = pv.assets.filter(a => a.source === "Bitso");
  const cryptoVal = crypto.reduce((s,a)=>s+a.valueMXN,0);
  const cryptoPct = pv.totalValueMXN ? ((cryptoVal/pv.totalValueMXN)*100).toFixed(1) : 0;
  reply = `Cripto Bitso vale ${money(cryptoVal)} (${cryptoPct}% del portafolio). ${crypto.map(a=>`${a.symbol}: ${pct(a.gainPct)}`).join(", ")}. Alta concentración: el riesgo cripto es el más relevante del portafolio.`;
}
else if (q.includes("gbm")) {
  const gbm = pv.assets.filter(a => a.source === "GBM");
  reply = `GBM: ${gbm.map(a=>`${a.symbol} ${pct(a.gainPct)}`).join(", ")}. ${money(gbm.reduce((s,a)=>s+a.valueMXN,0))} total en GBM.`;
}
else if (q.includes("plata")) {
  const plata = pv.assets.filter(a => a.source === "Plata");
  reply = `Plata (USD): ${plata.map(a=>`${a.symbol} ${pct(a.gainPct)}`).join(", ")}. Equivalente: ${money(plata.reduce((s,a)=>s+a.valueMXN,0))}.`;
}
else if (q.includes("mejor") || q.includes("ganando")) {
  const top3 = ranked.slice(0,3);
  reply = `Mejores activos: ${top3.map(a=>`${a.symbol} (${pct(a.gainPct)}, score ${a.score})`).join(", ")}.`;
}
else if (q.includes("peor") || q.includes("perdiendo")) {
  const bot3 = ranked.slice(-3).reverse();
  reply = `Activos más débiles: ${bot3.map(a=>`${a.symbol} (${pct(a.gainPct)}, score ${a.score})`).join(", ")}.`;
}
```

### 6.2 Guardrail educativo explícito en prompt

Agregar al inicio del prompt de `askClaude()`:

```javascript
const EDUCATIONAL_DISCLAIMER = `
IMPORTANTE: Este es un sistema EDUCATIVO. Nunca des órdenes de compra o venta específicas.
Si la pregunta implica una decisión de inversión, responde SIEMPRE con escenarios:
  • Escenario conservador: mantener posición actual
  • Escenario moderado: ajuste parcial o vigilar
  • Escenario agresivo: reducir/aumentar con stops claros
No uses palabras como "deberías comprar X" o "vende Y ahora". 
Usa "si tu tesis sigue vigente", "considera vigilar", "un escenario posible es".
`;
```

### 6.3 Detección de preguntas sin datos suficientes

```javascript
// Agregar al inicio de alfredoReply()
const noQuotes = Object.values(quotes).filter(q => q.source === "finnhub").length === 0;
if (noQuotes && (q.includes("precio") || q.includes("hoy") || q.includes("ahora"))) {
  reply = "No tengo precios de mercado en vivo ahora (sin API Finnhub activa). Los valores mostrados son manuales. Para preguntas de precio actual, configura FINNHUB_API_KEY en .env.";
}
```

---

## 7. LIMPIEZA .gitignore (F2d)

El `.gitignore` tiene 99 líneas con bloques idénticos repetidos 4 veces. La versión limpia es:

```gitignore
# Secrets
.env
*.env
*API_KEY*

# Logs
*.log
corde.log
cloudflared.log
corde-supervisor.log
watchdog.log

# Runtime state (creado en ejecución)
bot_state.json
portfolio_history.json
cordelius_settings.json
ai_chat_history.json
alfredo_chat_history.json
cordelius_intel.json
cordelius_alerts.json

# Backups y parches locales
dashboard_backup_*.js
dashboard_FINAL_*.js
dashboard_OK_*.js
dashboard_broken_*.js
patch_*.js
local_backups/

# Dependencias
node_modules/

# Directorios de runtime
backups/
runtime/
```

De 99 líneas a 33 líneas. Sin entradas basura.

---

## 8. ROADMAP PRIORIZADO

### F2a — Intel Panel mejorado (ALTA PRIORIDAD)

**Estimación:** 80-120 líneas de cambios en `dashboard.js`  
**Archivos:** `dashboard.js` únicamente  
**Riesgo:** BAJO — solo lógica de display y 2 endpoints nuevos

| # | Mejora | Líneas estimadas |
|---|---|---|
| F2a-1 | Hash + deduplicación | ~15 líneas en `handleIntel()` y `analyzeIntelText()` |
| F2a-2 | Endpoint DELETE `/intel/delete` | ~12 líneas en router |
| F2a-3 | Endpoint CLEAR `/intel/clear` | ~8 líneas en router |
| F2a-4 | Counter badge en título | ~3 líneas en `render()` |
| F2a-5 | Filtros mood (client-side JS) | ~25 líneas HTML/CSS/JS inline |
| F2a-6 | Filtro por ticker | ~20 líneas |
| F2a-7 | Búsqueda texto | ~12 líneas |
| F2a-8 | Fix BUG-01 (word boundary "ia") | ~8 líneas en `analyzeIntelText()` |

---

### F2b — Fix bugs seguros (ALTA PRIORIDAD)

**Estimación:** 15-30 líneas de cambios  
**Archivos:** `bot.js` (BUG-04, BUG-05), `dashboard.js` (BUG-03, BUG-06)  
**Riesgo:** BAJO — fixes quirúrgicos

| # | Fix | Archivo |
|---|---|---|
| F2b-1 | `bot.js`: CLAUDE_API_KEY → ANTHROPIC_API_KEY | `bot.js` |
| F2b-2 | `bot.js`: modelo con fecha completa | `bot.js` |
| F2b-3 | `assetGainPct()`: respetar live quotes Finnhub | `dashboard.js` |
| F2b-4 | `analyzeIntelText()`: word boundary regex | `dashboard.js` |

---

### F2c — Alfredo AI mejorado (MEDIA PRIORIDAD)

**Estimación:** 60-80 líneas en `dashboard.js`  
**Archivos:** `dashboard.js`  
**Riesgo:** BAJO — solo funciones `alfredoReply()` y prompt de `askClaude()`

| # | Mejora | Efecto |
|---|---|---|
| F2c-1 | 8 patrones nuevos de conversación | Mejora UX para preguntas comunes |
| F2c-2 | Guardrail educativo explícito en prompt | Respuestas más consistentemente educativas |
| F2c-3 | Detección "sin datos Finnhub" | Honestidad sobre fuentes de precio |
| F2c-4 | `handleAsk()` JSON mode para API | Permite consumo por Telegram/scripts |

---

### F2d — Limpieza .gitignore (BAJA PRIORIDAD)

**Estimación:** Reescribir `.gitignore` (99 → 33 líneas)  
**Archivos:** `.gitignore`  
**Riesgo:** MUY BAJO — no afecta código

---

### F3a — Quiver Quant (MEDIA PRIORIDAD)

**Pre-requisito:** Tener `QUIVER_API_KEY`  
**Estimación:** 150-200 líneas nuevas en `dashboard.js`  
**Archivos:** `dashboard.js`, `.env.example`

| # | Componente |
|---|---|
| F3a-1 | `fetchQuiverData()` con rate limiting (30 min cache) |
| F3a-2 | Panel Congressional Trading en UI |
| F3a-3 | Panel Insider Trading en UI |
| F3a-4 | Contexto Quiver en prompt de Alfredo |
| F3a-5 | Endpoint `/api/quiver` |

---

### F3b — Sistema de Alertas (MEDIA-ALTA PRIORIDAD)

**Estimación:** 120-150 líneas nuevas  
**Archivos:** `dashboard.js`, `.env.example` (nueva var `TELEGRAM_CHAT_ID`)  
**Depende de:** F2c (Alfredo mejorado)

| # | Componente |
|---|---|
| F3b-1 | `checkAlerts()` con 5 tipos de alertas |
| F3b-2 | Panel de alertas en UI |
| F3b-3 | Endpoint `POST /alerts/dismiss` |
| F3b-4 | Notificación Telegram para alertas ALTAS |
| F3b-5 | Resumen diario a las 9am |

---

### F3c — Portafolio editable en runtime (BAJA PRIORIDAD)

**Estimación:** 100 líneas  
**Motivación:** Hoy, actualizar `valueManual` de un activo requiere editar `dashboard.js` directamente.

```javascript
// POST /portfolio/update
// Body: symbol=AAPL&valueManual=5800&costManual=2640
```

Persistir en `cordelius_portfolio.json` y cargar al inicio.  
Separar datos del portafolio del código.

---

## 9. ESTIMACIÓN DE IMPACTO

| Fase | Esfuerzo | Impacto UX | Impacto Estabilidad | Impacto Educativo |
|---|---|---|---|---|
| F2a (Intel) | 2-3 horas | ALTO ★★★★ | MEDIO ★★★ | MEDIO ★★★ |
| F2b (Bugs) | 30 min | BAJO ★ | ALTO ★★★★ | BAJO ★ |
| F2c (Alfredo) | 1-2 horas | ALTO ★★★★ | BAJO ★ | ALTO ★★★★★ |
| F2d (.gitignore) | 15 min | NINGUNO | BAJO ★ | NINGUNO |
| F3a (Quiver) | 3-4 horas | ALTO ★★★★ | MEDIO ★★★ | ALTO ★★★★ |
| F3b (Alertas) | 3-4 horas | ALTO ★★★★ | BAJO ★ | ALTO ★★★★ |
| F3c (Portfolio edit) | 2-3 horas | MEDIO ★★★ | MEDIO ★★★ | BAJO ★ |

---

## 10. ARCHIVOS QUE SE TOCARÍAN Y POR QUÉ

| Archivo | Fases | Razón |
|---|---|---|
| `dashboard.js` | F2a, F2b, F2c, F3a, F3b, F3c | Toda la lógica del dashboard vive aquí |
| `bot.js` | F2b | Fix env var CLAUDE_API_KEY y modelo |
| `.gitignore` | F2d | Limpiar duplicados y entradas basura |
| `.env.example` | F3a, F3b | Documentar QUIVER_API_KEY, TELEGRAM_CHAT_ID |
| `CLAUDE.md` | Después de F3 | Actualizar issues conocidos y endpoints nuevos |

**Archivos que NO se tocan:**
- `trading_ai.js` — funciona, no requiere cambios en esta fase
- `dashboard.py` / `bot.py` — fuera del scope Node.js principal
- `start.sh`, `stop.sh`, `status.sh` — estables

---

## 11. RIESGOS

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Dashboard.js rompe sintaxis en patch grande | MEDIA | ALTO | `node --check` antes de cada restart + backup |
| Quiver API rate limit (plan free = 50 req/día) | ALTA | MEDIO | Cache 30 min, solo fetch en boot y cada N horas |
| Drift aleatorio (BUG-06) genera confusión en Alfredo | ALTA | MEDIO | Fix con drift seeded por día (F2b) |
| Intel duplicados llenan el archivo JSON | MEDIA | BAJO | Hash dedup (F2a-1) |
| Alertas Telegram spam si el bot está abajo y reinicia | MEDIA | BAJO | Persistir alertas ya enviadas con flag `notified` |
| Bot.js con key incorrecta — falla silencioso | ALTA | BAJO | Fix F2b-1 + log explícito de error de key |

---

## 12. ORDEN DE EJECUCIÓN RECOMENDADO

```
1. F2b (15-30 min)  → Bugs críticos sin riesgo de romper nada
2. F2d (15 min)     → .gitignore limpio, no toca código
3. F2a (2-3 horas)  → Intel panel completo
4. F2c (1-2 horas)  → Alfredo AI mejorado
5. F3b (3-4 horas)  → Alertas (depende de F2c en producción)
6. F3a (3-4 horas)  → Quiver (solo si tienes la API key)
7. F3c (2-3 horas)  → Portfolio editable (feature avanzada)
```

---

*Reporte generado por análisis estático del repo. No se ejecutó el dashboard ni se tocó ningún archivo de producción.*
