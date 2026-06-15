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
| `priceAtAdd` | number \| null | Precio al momento de agregar (MXN para crypto). `null` si `marketDataStatus` es `"stale"` o `"unavailable"`. **Nunca inventar.** |
| `priceTarget` | number \| null | Nivel de precio objetivo (referencial, no orden); `null` si no hay precio de referencia |
| `stopLevel` | number \| null | Nivel de invalidación de precio; `null` si no hay precio de referencia |
| `marketDataStatus` | enum | `"fresh"` / `"stale"` / `"unavailable"` — alineado con RESEARCH_INTAKE_PIPELINE schema |
| `marketDataNote` | string? | Opcional — explicación en texto libre si `marketDataStatus` ≠ `"fresh"` |
| `priceAgeSeconds` | number \| null | Segundos desde la última actualización de precio; `null` si unavailable |
| `scores` | object | Ver §5 |
| `triggers` | string[] | Triggers activados (histórico) |
| `notes` | string | Notas de Pedro o Jarvis |

> ⚠️ `priceAtAdd = null` **no impide** WATCHLIST pasivo — equity/ETF sin precio fresco es válido.
> `priceAtAdd = null` **sí impide** PAPER_ONLY / PAPER_BUY hasta tener precio fresco.
> Para crypto PAPER_ONLY: `priceAgeSeconds` debe ser ≤ 120 (hard gate — PAPER_TRADING_SPEC §6).

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

**A) BLOCKED solo para transiciones de ejecución (PAPER_ONLY, PAPER_BUY, APPROVAL_REQUIRED):**
```
[ ] jarvisMode = DEFENSIVO o tradingPermission = NO_TRADING
[ ] recovery < 45 (healthContext)
[ ] precio crypto stale (priceAgeSeconds > 120) al intentar PAPER_ONLY / PAPER_BUY
[ ] evento binario en ≤ 7 días sin revisión manual cuando se solicita ejecución
```

> Items pasivos (WATCHLIST / RESEARCH_MORE) **no se bloquean** por estas condiciones.
> Reciben nota "not actionable while Jarvis is DEFENSIVO / recovery low" y siguen
> monitoreables. BLOCKED solo ocurre si se intenta una transición de ejecución/paper.

**B) BLOCKED para todos los modos (incluyendo watchlist/research pasiva e ingesta):**
```
[ ] Cualquier invariante de security audit falla:
     dashboardProtected !== true | privateReadProtected !== true
     accessKeyConfigured !== true | unprotectedMutationEndpoints > 0
     → Bloquea también la ingesta/creación automática de nuevos research items
       y watchlist items. El pipeline automatizado se detiene completamente.
       "Security audit failure blocks research intake processing,
        not just execution transitions."
       Pedro puede conservar el texto como nota manual fuera del pipeline,
       pero el pipeline no puede ingestar/procesar/almacenar análisis externos.
[ ] Schema del item corrupto o inválido — no puede procesarse de forma segura
[ ] Datos críticos ambiguos que podrían causar ejecución insegura
```

**No es condición de BLOCKED:**
```
✗  Activo equity/ETF no soportado para paper → WAITING_FOR_CONFIRMATION
   "Unsupported for paper execution ≠ BLOCKED. It remains watchlist/review-only
    unless a critical safety condition exists."
✗  Precio equity no disponible → RESEARCH_MORE
✗  Score bajo → REJECTED, RESEARCH_MORE o ACTIVE según umbrales
✗  BTC/ETH/XRP con precio stale en watchlist pasiva → WAITING_FOR_PRICE (no BLOCKED)
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
| `DATA_STALE` | Precio crypto no actualizado en > 2 horas | Watchlist pasiva → WAITING_FOR_PRICE + ⚠️ Telegram ("price feed stale; monitoring paused"); Intento PAPER_ONLY/PAPER_BUY → BLOCKED |
| `JARVIS_DEFENSIVE` | jarvisMode pasa a DEFENSIVO o recovery < 45 | Watchlist pasiva → nota "not actionable now" + ⚠️ Telegram; Intento de ejecución → BLOCKED |
| `SECURITY_AUDIT_FAIL` | Cualquier invariante de security audit falla | → BLOCKED en todos los modos + ⚠️ Telegram urgente |

> Ningún trigger ejecuta un trade automáticamente. Solo cambian el estado del item
> y envían una notificación a Pedro para que decida.
>
> "WAITING_FOR_PRICE is used for idle monitoring with stale data; BLOCKED is used
>  only when an execution/paper transition is attempted with stale crypto price."

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
                   - precio > 2 horas: 0
                     → crypto PAPER_ONLY attempt: BLOCKED
                     → equity research/watchlist: RESEARCH_MORE o WATCHLIST (no BLOCKED)

⚠️ HARD GATE para PAPER_ONLY — crypto (BTC / ETH / XRP):
  priceAgeSeconds <= 120 es condición necesaria e irremplazable.
  Un freshnessScore alto NO es suficiente para entrar a PAPER_ONLY.

  Si priceAgeSeconds > 120 al intentar transición a PAPER_ONLY:
    → estado: BLOCKED (razón: "crypto paper price stale")
    → NO transicionar a PAPER_ONLY
    → se resuelve automáticamente cuando priceAgeSeconds <= 120
  (Alineado con PAPER_TRADING_SPEC.md §6: bloqueo duro si priceAgeSeconds > 120)

  Distinción:
    WAITING_FOR_PRICE — item en watchlist/research, aún no intenta ejecución;
                        precio en nivel de entrada no alcanzado todavía.
    BLOCKED           — intento activo de transición a PAPER_ONLY con precio stale.
                        "WAITING_FOR_PRICE is pre-execution; BLOCKED is used when a
                         PAPER_ONLY transition is attempted with stale crypto price."

jarvisContextScore = contexto de Jarvis y salud (0-100)
                   - jarvisMode ÓPTIMO: 100
                   - jarvisMode MODERADO: 70
                   - jarvisMode REGULACIÓN: 40
                   - jarvisMode DEFENSIVO/NO_TRADING: 0
                     → paper/execution attempt: BLOCKED
                     → research/watchlist: WATCHLIST o RESEARCH_MORE ("not actionable")
                   - recovery >= 75: +10 (bonus)
                   - recovery < 45: 0
                     → paper/execution attempt: BLOCKED
                     → research/watchlist: nota "not actionable now", no BLOCKED

finalDecisionScore = promedio ponderado:
  (thesisScore * 0.30)
  + (technicalScore * 0.25)
  + (riskScore * 0.20)
  + (freshnessScore * 0.15)
  + (jarvisContextScore * 0.10)
```

### Umbrales de estado según finalDecisionScore

```
finalDecisionScore >= 75  → PAPER_ONLY candidate — requiere verificación de todos los
                             hard gates de PAPER_TRADING_SPEC §6 antes de asignar PAPER_ONLY.
                             "Score is necessary but not sufficient for PAPER_ONLY."
                             PAPER_ONLY solo se asigna si ADEMÁS pasan todos los siguientes:
                               - activo en paper-trading whitelist (BTC / ETH / XRP)
                               - priceAgeSeconds <= 120 (crypto hard gate)
                               - no hay paper trade abierto hoy (cooldown / open-trade gate)
                               - signal confidence >= umbral de PAPER_TRADING_SPEC §6
                               - security audit invariants pass
                               - jarvisMode / tradingPermission permite paper
                               - riesgo y demás reglas de PAPER_TRADING_SPEC §6 pass
                             Si el score pasa pero un hard gate falla:
                               precio stale en intento PAPER_ONLY  → BLOCKED
                               cooldown / paper trade abierto hoy  → WAITING_FOR_CONFIRMATION
                               security audit falla                → BLOCKED
                               Jarvis DEFENSIVO / NO_TRADING       → BLOCKED
                               baja confianza / señal débil        → WAITING_FOR_CONFIRMATION
                             Si activo es equity/ETF               → WAITING_FOR_CONFIRMATION
finalDecisionScore 60-74  → WAITING_FOR_CONFIRMATION
finalDecisionScore 40-59  → ACTIVE (monitoreo sin acción)
finalDecisionScore < 40   → REJECTED
```

**Score bajo ≠ BLOCKED. Routing por score bajo:**
```
thesisScore = 0       → REJECTED o RESEARCH_MORE (análisis sin sustancia)
technicalScore = 0    → afecta finalDecisionScore; resultado según umbrales arriba
riskScore = 0         → riskLevel "extreme" → BLOCKED (condición de seguridad explícita)
freshnessScore = 0    → depende de contexto (ver freshnessScore arriba)
jarvisContextScore = 0→ depende de contexto (ver jarvisContextScore arriba)

BLOCKED solo se asigna por condiciones críticas de §3a, nunca por score bajo.
"Low score ≠ BLOCKED. Low score → REJECTED, RESEARCH_MORE, or ACTIVE."
```

> Para crypto PAPER_ONLY: finalDecisionScore >= 75 es condición necesaria pero no
> suficiente. Se requiere además que todos los hard gates de PAPER_TRADING_SPEC §6
> pasen: priceAgeSeconds <= 120, no open trade hoy, cooldown OK, security audit OK,
> Jarvis/tradingPermission permite paper, y demás reglas de riesgo.
> "Score is necessary but not sufficient for PAPER_ONLY."
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
  "marketDataStatus": "fresh",
  "marketDataNote": null,
  "priceAgeSeconds": 45,
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
