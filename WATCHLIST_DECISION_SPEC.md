# WATCHLIST_DECISION_SPEC.md — Especificación de Decisión de Watchlist

> Solo documentación/diseño. No implementar sin aprobación explícita.
> Branch: `jarvis-ui-overhaul` | Referencias: RESEARCH_INTAKE_PIPELINE.md, PAPER_TRADING_SPEC.md

---

## 1. Estructura de watchlist item

```json
{
  "id": "wl_20260615_001",
  "researchItemId": "ri_20260615_001",
  "ticker": "BTC",
  "companyName": "Bitcoin",
  "assetType": "crypto",
  "exchange": "CRYPTO",
  "addedAt": "2026-06-15T01:30:00Z",
  "updatedAt": "2026-06-15T06:00:00Z",
  "status": "ACTIVE",
  "entryReason": "Tesis ETF inflow + RSI sobrevendido en soporte $60k",
  "invalidationReason": "Cierre semanal bajo $55k o noticia regulatoria adversa",
  "priceAtAdd": 67420,
  "priceTarget": 75000,
  "stopLevel": 55000,
  "scores": {
    "thesisScore": 72,
    "technicalScore": 60,
    "riskScore": 55,
    "freshnessScore": 95,
    "jarvisContextScore": 70,
    "finalDecisionScore": 68
  },
  "triggers": [],
  "notes": "Revisar en TradingView si RSI 1D baja de 35"
}
```

---

## 2. Campos del watchlist item

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | string | ID único: `wl_YYYYMMDD_NNN` |
| `researchItemId` | string | Referencia al research item origen |
| `ticker` | string | Símbolo confirmado |
| `addedAt` | ISO8601 | Timestamp de entrada a watchlist |
| `updatedAt` | ISO8601 | Última actualización |
| `status` | enum | Ver §3 |
| `entryReason` | string | Razón concreta para estar en watchlist |
| `invalidationReason` | string | Condición que lo saca de watchlist (obligatorio) |
| `priceAtAdd` | number | Precio al momento de agregar (MXN para crypto) |
| `priceTarget` | number | Nivel de precio objetivo (referencial, no orden) |
| `stopLevel` | number | Nivel de invalidación de precio |
| `scores` | object | Ver §4 |
| `triggers` | string[] | Triggers activados (histórico) |
| `notes` | string | Notas de Pedro o Jarvis |

---

## 3. Estados de watchlist

| Estado | Significado | Transición siguiente |
|---|---|---|
| `ACTIVE` | Item en monitoreo activo | → cualquier estado según trigger |
| `WAITING_FOR_PRICE` | Tesis válida pero precio aún no en nivel de entrada | → ACTIVE cuando precio llegue |
| `WAITING_FOR_CONFIRMATION` | Señal técnica detectada, espera confirmación adicional (volumen, cierre) | → PAPER_ONLY, APPROVAL_REQUIRED o BLOCKED |
| `PAPER_ONLY` | Candidato para paper trade; todas las condiciones pasan | → paper trade si Pedro aprueba; → BLOCKED si condición falla |
| `APPROVAL_REQUIRED` | Candidato para real buy (solo Fase 4+); requiere aprobación explícita | → real buy solo con aprobación manual; → BLOCKED si condición falla |
| `BLOCKED` | Condición crítica impide avanzar — ver §3a | → ACTIVE cuando se resuelve; → ARCHIVED si se descarta |
| `REJECTED` | Pedro rechazó o condición de invalidación se activó | → ARCHIVED |
| `ARCHIVED` | Item histórico; no genera alertas | terminal |

> `BLOCKED` **no significa "empresa mala"** ni "análisis inválido". Significa que una
> condición externa crítica impide la acción en este momento. Cuando la condición se
> resuelve, el item vuelve a ACTIVE para re-evaluación.

### §3a — Condiciones para estado BLOCKED

Un item de watchlist pasa a `BLOCKED` si se cumple **cualquiera** de las siguientes:

```
[ ] security audit falla (audit.totals.unprotectedMutationEndpoints > 0)
[ ] precio crypto stale (priceAgeSeconds > 120) al intentar transicionar a PAPER_ONLY
[ ] jarvisMode = DEFENSIVO o tradingPermission = NO_TRADING
[ ] evento binario crítico en ≤ 7 días sin revisión manual (earnings, FDA, etc.)
[ ] datos ambiguos críticos que impiden calcular riesgo o invalidación
[ ] recovery < 45 (healthContext — Jarvis en modo DEFENSIVO/DESCANSO)
```

**No es condición de BLOCKED:**
```
✗  Activo equity/ETF no soportado por paper trading → WAITING_FOR_CONFIRMATION (no BLOCKED)
   "Unsupported for paper execution ≠ BLOCKED. It remains watchlist/review-only
    unless a critical safety condition exists."
✗  Precio equity no disponible en Cordelius → RESEARCH_MORE (esperado para equities)
✗  Score bajo → REJECTED o ACTIVE, no BLOCKED
```

El bloqueo se resuelve cuando la condición que lo causó desaparece.
Pedro puede desbloquear manualmente con `/watchlist TICKER` tras revisar.

### Diagrama de transiciones

```
                    ┌─────────────────┐
                    │  WAITING_FOR_   │
              ┌────►│     PRICE       │
              │     └────────┬────────┘
              │              │ precio llega a nivel
              │              ▼
        ┌─────┴────┐    ┌──────────────┐
Pedro   │          │    │  WAITING_FOR │
agrega ►│  ACTIVE  │───►│ CONFIRMATION │
        │          │    └──────┬───────┘
        └──────┬───┘           │ confirmado
               │               ▼
               │      ┌──────────────┐
               │      │  PAPER_ONLY  │──► paper trade (con aprobación)
               │      └──────┬───────┘
               │             │
               │      ┌──────▼───────────┐
               │      │APPROVAL_REQUIRED │──► real buy (Fase 4+, aprobación manual)
               │      └──────────────────┘
               │
               │   condición crítica en cualquier estado activo
               │             │
               │             ▼
               │      ┌────────────┐   bloqueo resuelto
               └─────►│  BLOCKED   │──────────────────────► ACTIVE
                       └─────┬──────┘
                             │ descartado
                             ▼
                    ┌──────────┐   ┌──────────┐
                    │ REJECTED │──►│ ARCHIVED │
                    └──────────┘   └──────────┘
```

---

## 4. Triggers

Un trigger es una condición que cambia el estado del watchlist item o genera alerta a Pedro.

| Trigger | Condición | Alerta |
|---|---|---|
| `PRICE_LEVEL` | Precio cruza soporte o resistencia documentada | ✓ Telegram |
| `RSI_OVERSOLD_BOUNCE` | RSI 1D baja de 35 y empieza a rebotar | ✓ Telegram |
| `MOMENTUM_IMPROVE` | Cambio de tendencia en 4H de bajista a lateral/alcista | ✓ Telegram |
| `POSITIVE_NEWS` | Noticia positiva sobre el ticker en news feed | ✓ Telegram |
| `NEGATIVE_NEWS` | Noticia negativa o riesgo nuevo identificado | ✓ Telegram (urgente) |
| `EARNINGS_APPROACHING` | Earnings en ≤ 7 días | ⚠️ Telegram (alerta de riesgo) |
| `JARVIS_MODE_CHANGE` | Jarvis cambia de DEFENSIVO a MODERADO u ÓPTIMO | ✓ Telegram |
| `INVALIDATION_HIT` | Precio cierra bajo `stopLevel` | → REJECTED automático |
| `DATA_STALE` | Precio crypto no actualizado en > 2 horas | → BLOCKED (si activo en paper whitelist); ⚠️ Telegram |
| `CRITICAL_CONDITION` | Jarvis DEFENSIVO, security audit falla, recovery < 45 | → BLOCKED; ⚠️ Telegram (urgente) |

> Ningún trigger ejecuta un trade automáticamente. Solo cambian el estado del item
> y envían una notificación a Pedro para que decida.

---

## 5. Scoring

### Fórmulas

```
thesisScore      = calidad y sustancia de la tesis (0-100)
                   - Fuente confiable: +20
                   - Catalizadores verificables: +20 c/u (max 40)
                   - Riesgos identificados: +10 c/u (max 20)
                   - Horizonte claro: +10
                   - Sesgo/hype detectado: -20

technicalScore   = señal técnica actual (0-100)
                   - RSI 1D < 35 (sobrevendido): +30
                   - Precio en soporte: +25
                   - Tendencia 1D alcista: +20
                   - Volumen confirma: +15
                   - MA50D cruzada: +10

riskScore        = (100 - nivel de riesgo) (0-100)
                   - riskLevel "low": 80
                   - riskLevel "medium": 60
                   - riskLevel "high": 35
                   - riskLevel "extreme": 0 → BLOCKED

freshnessScore   = frescura del dato de precio (0-100) — scoring general de watchlist
                   - precio ≤ 2 min (≤ 120s): 100
                   - precio 2-5 min: 80
                   - precio 5-30 min: 50
                   - precio 30 min - 2 horas: 20
                   - precio > 2 horas (crypto): 0 → BLOCKED

⚠️ HARD GATE para PAPER_ONLY — crypto (BTC / ETH / XRP):
  priceAgeSeconds <= 120 es condición necesaria e irremplazable.
  Un freshnessScore alto NO es suficiente para entrar a PAPER_ONLY.
  Si priceAgeSeconds > 120 al momento de la evaluación:
    → NO transicionar a PAPER_ONLY
    → mantener en WAITING_FOR_PRICE hasta que llegue precio fresco
  (Alineado con PAPER_TRADING_SPEC.md §6: bloqueo duro si priceAgeSeconds > 120)

jarvisContextScore = contexto de Jarvis y salud (0-100)
                   - jarvisMode ÓPTIMO: 100
                   - jarvisMode MODERADO: 70
                   - jarvisMode REGULACIÓN: 40
                   - jarvisMode DEFENSIVO/NO_TRADING: 0 → BLOCKED
                   - recovery >= 75: +10 (bonus)
                   - recovery < 45: 0 → BLOCKED

finalDecisionScore = promedio ponderado:
  (thesisScore * 0.30)
  + (technicalScore * 0.25)
  + (riskScore * 0.20)
  + (freshnessScore * 0.15)
  + (jarvisContextScore * 0.10)
```

### Umbrales de estado según finalDecisionScore

```
finalDecisionScore >= 75  → PAPER_ONLY (solo si activo en paper-trading whitelist
                             Y priceAgeSeconds <= 120 para crypto)
                             Si activo es equity/ETF → WAITING_FOR_CONFIRMATION
finalDecisionScore 60-74  → WAITING_FOR_CONFIRMATION
finalDecisionScore 40-59  → ACTIVE (monitoreo sin acción)
finalDecisionScore < 40   → REJECTED
cualquier componente = 0  → estado BLOCKED (ver §3a para condiciones exactas)
```

> Para crypto PAPER_ONLY: finalDecisionScore >= 75 es condición necesaria pero no
> suficiente. También se requiere priceAgeSeconds <= 120 (hard gate — PAPER_TRADING_SPEC §6).
> Un equity con score >= 75 queda en WAITING_FOR_CONFIRMATION — no BLOCKED — hasta
> que el motor soporte su tipo de activo.

---

## 6. Reglas

```
✗  No real trading desde watchlist en Fases 1-3
✓  Paper trade permitido desde PAPER_ONLY si todas las condiciones de PAPER_TRADING_SPEC §6 pasan
✓  BUY_CANDIDATE / APPROVAL_REQUIRED solo en Fase 4+ y con aprobación manual de Pedro
✓  Cada item debe tener entryReason y invalidationReason definidos al agregar
✓  Si invalidationReason se activa: status → REJECTED automáticamente
✓  Items sin actualización de precio > 24h → status → WAITING_FOR_PRICE
✓  Pedro puede archivar manualmente cualquier item en cualquier momento
✓  Watchlist tiene máximo 10 items ACTIVE simultáneos (para mantener foco)

Reglas para BLOCKED:
✓  BLOCKED no es estado terminal — se resuelve cuando la condición que lo causó desaparece
✓  Cualquier estado ACTIVE puede transicionar a BLOCKED por condición crítica
✓  BLOCKED → ACTIVE: automático cuando se resuelve la condición (security audit pasa,
   Jarvis sale de DEFENSIVO, precio fresco disponible, etc.)
✓  BLOCKED → ARCHIVED: si Pedro decide descartar el item bloqueado
✓  Un item BLOCKED sigue visible en watchlist (no se archiva automáticamente)
✓  Equity/ETF con score >= 75 pero no soportado por paper trading → WAITING_FOR_CONFIRMATION
   (no BLOCKED — el análisis es válido; "unsupported for paper execution ≠ BLOCKED")
✓  Equity/ETF sigue monitoreable en watchlist indefinidamente sin requerir soporte de paper
```

---

## 7. Ejemplo — BTC (datos ficticios, solo ilustración)

> ⚠️ Los datos siguientes son ficticios y solo sirven para ilustrar el formato.
> No representan precios, scores ni recomendaciones reales.

```json
{
  "id": "wl_20260615_001",
  "researchItemId": "ri_20260615_001",
  "ticker": "BTC",
  "companyName": "Bitcoin",
  "assetType": "crypto",
  "exchange": "CRYPTO",
  "addedAt": "2026-06-15T01:30:00Z",
  "updatedAt": "2026-06-15T08:00:00Z",
  "status": "WAITING_FOR_CONFIRMATION",
  "entryReason": "ETF inflows acelerando + RSI 1D en 38 (cerca de sobrevendido) + soporte histórico $60k",
  "invalidationReason": "Cierre semanal bajo $55,000 MXN o noticia regulatoria adversa de SEC",
  "priceAtAdd": 67420,
  "priceTarget": 75000,
  "stopLevel": 55000,
  "scores": {
    "thesisScore": 72,
    "technicalScore": 65,
    "riskScore": 60,
    "freshnessScore": 95,
    "jarvisContextScore": 70,
    "finalDecisionScore": 71
  },
  "triggers": [],
  "notes": "Esperar confirmación de cierre diario sobre $68k antes de considerar paper trade"
}
```

**Ejemplo de trigger activado:**

```
Trigger: RSI_OVERSOLD_BOUNCE
Condición: RSI 1D bajó a 33.2 y rebotó a 36 con volumen +15%
Alerta Telegram:
  ⚡ Trigger: RSI_OVERSOLD_BOUNCE — BTC
  RSI 1D: 36 (rebote desde 33.2)
  Precio: $66,800 MXN (fresco)
  Estado actual: WAITING_FOR_CONFIRMATION → evaluar PAPER_ONLY
  
  Revisa: https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT
  
  /paper BTC  → marcar para paper trade
  /watchlist BTC → mantener en watchlist
  /reject BTC → rechazar
```

---

## 8. Referencias cruzadas

| Documento | Relación |
|---|---|
| `RESEARCH_INTAKE_PIPELINE.md` | Todo item de watchlist viene de un research item |
| `PAPER_TRADING_SPEC.md` | Condiciones para avanzar a paper trade |
| `TRADING_AUTOPILOT_PLAN.md` | APPROVAL_REQUIRED solo Fase 4+ |
| `REMOTE_CONTROL_PLAN.md` | Comandos Telegram que cambian estados |
| `CODEMAP.md` | computeJarvisBrain(), buildSecurityAudit() |

---

*WATCHLIST_DECISION_SPEC.md | 2026-06-15 | Solo documentación — no implementar sin aprobación*
