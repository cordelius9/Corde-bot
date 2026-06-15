# PAPER_TRADING_SPEC.md — Especificación de Paper Trading

> Documentación de diseño. No implementar hasta aprobación explícita.
> Branch: `jarvis-ui-overhaul` | Referencia: CODEMAP.md, TRADING_AUTOPILOT_PLAN.md

---

## 1. Objetivo

Simular operaciones de trading con datos reales de mercado pero **sin dinero real**.
El sistema debe comportarse exactamente igual que lo haría con dinero real,
incluyendo todas las restricciones, validaciones y condiciones de bloqueo.

**Propósito:** aprender, calibrar señales y demostrar rendimiento antes de arriesgar capital.

---

## 2. Principios

- Ningún paper trade envía órdenes a ningún broker.
- El ledger de paper trades es solo un archivo JSON local (`data/paper_ledger.json`).
- Un paper trade mal señalado no cuesta dinero, pero **se registra y se analiza**.
- Si el sistema no puede ejecutar un paper trade de forma segura, no ejecuta ninguno.
- La confianza en el sistema se gana con resultados documentados, no con claims.

---

## 3. Estructura de un paper trade

Cada trade se registra como un objeto JSON con los siguientes campos:

```json
{
  "id":                "pt_20260615_001",
  "timestamp":         "2026-06-15T09:00:00Z",
  "asset":             "BTC",
  "action":            "BUY",
  "entryPrice":        67420.00,
  "exitPrice":         null,
  "size":              0.01,
  "sizeMXN":           13484.00,
  "confidence":        78,
  "risk":              "LOW",
  "reason":            "RSI oversold + recovery 82% + ÓPTIMO mode + congressional buy signal",
  "signalInputs": {
    "rsi":             28,
    "macd":            "bullish_cross",
    "momentum":        "positive",
    "quiverSignal":    "congressional_buy",
    "priceAgeSeconds": 45
  },
  "jarvisMode":        "ÓPTIMO",
  "healthState": {
    "recovery":        82,
    "sleep":           91,
    "strain":          6.2,
    "hrv":             68
  },
  "securityAuditStatus": {
    "dashboardProtected":         true,
    "privateReadProtected":       true,
    "accessKeyConfigured":        true,
    "unprotectedMutationEndpoints": 0
  },
  "outcome24h":        null,
  "outcome7d":         null,
  "lesson":            null,
  "status":            "OPEN"
}
```

### Descripción de campos

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | string | `pt_YYYYMMDD_NNN` — único por día |
| `timestamp` | ISO 8601 | Momento exacto de la señal |
| `asset` | string | Ticker (solo whitelist) |
| `action` | enum | `BUY` / `SELL` / `HOLD` |
| `entryPrice` | number | Precio al momento de la señal (debe ser fresco) |
| `exitPrice` | number\|null | Precio al cerrar (null si sigue abierto) |
| `size` | number | Unidades del activo |
| `sizeMXN` | number | Equivalente en MXN al momento de entrada |
| `confidence` | 0-100 | Score de confianza de la señal |
| `risk` | enum | `LOW` / `MEDIUM` / `HIGH` |
| `reason` | string | Justificación en lenguaje natural (≤200 chars) |
| `signalInputs` | object | Indicadores técnicos y externos usados |
| `jarvisMode` | string | Modo operativo Jarvis al momento de la señal |
| `healthState` | object | Datos WHOOP al momento de la señal |
| `securityAuditStatus` | object | Snapshot de buildSecurityAudit() |
| `outcome24h` | number\|null | PnL % a las 24 horas |
| `outcome7d` | number\|null | PnL % a los 7 días |
| `lesson` | string\|null | Nota de aprendizaje (rellenada después) |
| `status` | enum | `OPEN` / `CLOSED` / `CANCELLED` |

---

## 4. Whitelist de activos

Solo estos activos pueden ser objeto de paper trades en la fase inicial:

```
BTC   — Bitcoin
ETH   — Ethereum
XRP   — Ripple
```

Agregar activos requiere:
1. Que estén en el portafolio de Cordelius o en la watchlist.
2. Que tengan precio fresco disponible (FinnHub o CoinGecko).
3. Aprobación explícita de Pedro antes de agregar al código.

---

## 5. Límites duros (no negociables)

```
máximo 1 paper trade activo al día
máximo 2% del portafolio simulado por trade
nada de leverage
nada de memecoins
nada de activos fuera de la whitelist
tamaño mínimo: equivalente a $10 USD (solo para que el cálculo tenga sentido)
tamaño máximo: 2% del portafolio simulado (aprox. $200-500 MXN según portafolio)
```

---

## 6. Condiciones de bloqueo — NO operar si:

El sistema debe verificar **todas** las siguientes condiciones antes de generar una señal.
Si cualquiera falla, el trade se cancela y se registra la razón.

| Condición | Verificación | Fuente |
|---|---|---|
| Security audit falla | `unprotectedMutationEndpoints === 0` y `dashboardProtected === true` | `buildSecurityAudit()` |
| Precio no fresco | `priceAgeSeconds > 120` (más de 2 minutos) | `quotes[asset].timestamp` |
| Jarvis en modo DEFENSIVO | `jarvisMode === "DEFENSIVO"` | `computeJarvisBrain()` |
| Trading bloqueado | `tradingPermission === "NO_TRADING"` | `data/jarvis_action_plan.json` |
| Recovery bajo | `healthState.recovery < 45` | `computeHealthReadiness()` |
| Sleep bajo | `healthState.sleep < 60` | `computeHealthReadiness()` |
| Activo no en whitelist | `!PAPER_WHITELIST.includes(asset)` | constante local |
| Ya hay un trade abierto hoy | `openTradesToday >= 1` | `data/paper_ledger.json` |
| Confianza baja | `confidence < 65` | señal calculada |

Si se bloquea un trade, se debe loguear:
```json
{
  "timestamp": "...",
  "asset": "BTC",
  "action": "BUY",
  "blocked": true,
  "reason": "DEFENSIVO mode active — recovery 38%"
}
```

---

## 7. Reglas de entrada

Una señal de BUY se genera solo cuando **todas** se cumplen:

```
confidence >= 65
asset en whitelist
precio fresco (< 2 minutos)
jarvisMode != "DEFENSIVO"
tradingPermission != "NO_TRADING"
healthState.recovery >= 45
sin trades abiertos hoy
securityAudit sin fallos
```

Señales técnicas que contribuyen al score de confianza:
```
RSI < 35          → +15 pts
MACD bullish cross → +15 pts
Momentum positivo → +10 pts
Quiver buy signal → +20 pts
Jarvis ÓPTIMO     → +15 pts
Recovery >= 75    → +10 pts
Precio en zona de soporte → +15 pts (PENDIENTE DE VERIFICAR — requiere lógica de soporte)
```

---

## 8. Reglas de salida

Un trade OPEN se cierra cuando:

```
A. Take profit: precio >= entryPrice * 1.05  (+5%)
B. Stop loss:   precio <= entryPrice * 0.97  (-3%)
C. Timeout:     7 días sin cierre → cerrar al precio actual
D. Manual:      Pedro cierra vía Telegram /paper-close <id>
E. Override:    modo DEFENSIVO activado → cerrar todos los trades abiertos
```

Al cerrar, actualizar el registro con:
- `exitPrice`
- `outcome24h` (si aplica)
- `outcome7d` (si aplica)
- `status: "CLOSED"`
- `lesson` (puede rellenarse después)

---

## 9. Cálculo de PnL

```
PnL % = ((exitPrice - entryPrice) / entryPrice) * 100

PnL MXN = (exitPrice - entryPrice) * size * FX_USD_MXN  (si es cripto en USD)
         = (exitPrice - entryPrice) * size               (si es MXN directo)

Win rate = trades ganadores / trades cerrados * 100

Expected value = (win_rate * avg_win) - ((1 - win_rate) * avg_loss)
```

---

## 10. Evaluación 24h / 7d

El sistema debe verificar el precio del activo a las 24h y 7d del trade para rellenar los campos automáticamente. Esto se hace **sin abrir ni cerrar el trade** — es solo evaluación informativa.

```javascript
// Pseudocódigo
async function evaluatePaperTrade(trade) {
  const ageHours = (Date.now() - new Date(trade.timestamp)) / 3600000;
  const currentPrice = quotes[trade.asset]?.value;
  if (!currentPrice) return;

  if (ageHours >= 24 && trade.outcome24h === null) {
    trade.outcome24h = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
  }
  if (ageHours >= 168 && trade.outcome7d === null) {
    trade.outcome7d = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
  }
}
```

---

## 11. Cómo evitar señales alucinadas

El sistema de señales debe ser **determinístico y auditable**. Reglas:

1. **Nunca usar AI para decidir si operar.** Claude puede explicar, no decidir.
2. **Toda señal tiene un score numérico.** Si no se puede calcular, no se opera.
3. **El precio debe venir de FinnHub o CoinGecko**, con timestamp verificable.
4. **Cada entrada del ledger incluye `signalInputs`** — todos los valores usados.
5. **No hay señal sin precio fresco.** Si `quotes[asset]` tiene más de 2 minutos, bloqueado.
6. **Si `computeHealthReadiness()` falla**, bloquear toda señal hasta que se recupere.
7. **Si `buildSecurityAudit()` reporta fallos**, bloquear toda señal.

---

## 12. Persistencia y auditoría

```
data/paper_ledger.json     — todos los paper trades (nunca borrar)
data/paper_signals.json    — señales generadas (incluyendo las bloqueadas)
data/paper_stats.json      — estadísticas: win rate, avg PnL, total trades
```

> ⚠️ Estos archivos son de `data/` y **nunca deben commitearse a git**.

Endpoint de consulta (a implementar):
```
GET /api/paper/status      — trades abiertos + stats
GET /api/paper/ledger      — historial completo (privateRead)
GET /api/paper/signals     — señales generadas (privateRead)
```

---

## 13. Criterios para pasar de paper a real

Paper trading se considera exitoso cuando:

```
≥ 30 paper trades ejecutados
win rate ≥ 55% en los últimos 30 trades
expected value > 0 (positivo)
≥ 60 días de operación continua sin crashes del sistema
0 señales alucinadas detectadas en revisión manual
modo DEFENSIVO nunca ignorado
kill switch probado al menos 1 vez
Pedro aprobó manualmente la transición
```

**Todos los criterios deben cumplirse. No hay atajos.**

---

*PAPER_TRADING_SPEC.md | 2026-06-15 | Solo documentación — no implementar sin revisión*
