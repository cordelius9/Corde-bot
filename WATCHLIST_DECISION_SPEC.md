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
| `WAITING_FOR_CONFIRMATION` | Señal técnica detectada, espera confirmación adicional (volumen, cierre) | → PAPER_ONLY o APPROVAL_REQUIRED |
| `PAPER_ONLY` | Candidato para paper trade; todas las condiciones pasan | → paper trade si Pedro aprueba |
| `APPROVAL_REQUIRED` | Candidato para real buy (solo Fase 4+); requiere aprobación explícita | → real buy solo con aprobación manual |
| `REJECTED` | Pedro rechazó o condición de invalidación se activó | → ARCHIVED |
| `ARCHIVED` | Item histórico; no genera alertas | terminal |

### Diagrama de transiciones

```
                    ┌─────────────────┐
                    │  WAITING_FOR_   │
              ┌────►│     PRICE       │
              │     └────────┬────────┘
              │              │ precio llega a nivel
              │              ▼
        ┌─────┴────┐    ┌──────────┐
Pedro   │          │    │          │
agrega ►│  ACTIVE  │───►│ WAITING_ │
        │          │    │   FOR_   │
        └──────────┘    │CONFIRM.  │
              │         └────┬─────┘
              │ trigger      │ confirmado
              │ directo      ▼
              │     ┌──────────────┐
              └────►│  PAPER_ONLY  │──► paper trade (con aprobación)
                    └──────────────┘
                    ┌──────────────────┐
                    │APPROVAL_REQUIRED │──► real buy (Fase 4+, aprobación manual)
                    └──────────────────┘
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
| `DATA_STALE` | Precio no actualizado en > 2 horas | ⚠️ Telegram (advertencia) |

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

freshnessScore   = frescura del dato de precio (0-100)
                   - precio < 5 min: 100
                   - precio 5-30 min: 80
                   - precio 30-120 min: 50
                   - precio > 2 horas: 0 → BLOCKED

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
finalDecisionScore >= 75  → PAPER_ONLY (si activo en whitelist)
finalDecisionScore 60-74  → WAITING_FOR_CONFIRMATION
finalDecisionScore 40-59  → ACTIVE (monitoreo sin acción)
finalDecisionScore < 40   → REJECTED
cualquier componente = 0  → BLOCKED (sin importar el score final)
```

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
