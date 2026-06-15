# RESEARCH_INTAKE_PIPELINE.md — Flujo de Ingesta de Análisis Externos

> Solo documentación/diseño. No implementar sin aprobación explícita.
> Branch: `jarvis-ui-overhaul` | Referencias: CODEMAP.md, PAPER_TRADING_SPEC.md, TRADING_AUTOPILOT_PLAN.md

---

## 1. Objetivo general

Permitir que Pedro pegue o suba cualquier análisis externo — de Grok, ChatGPT, noticias, tweets, PDFs o notas propias — y que Cordelius lo convierta en un research item estructurado, verificado y clasificado.

El sistema **nunca** convierte un análisis externo directamente en una orden. Todo pasa por:

1. Extracción estructurada y detección de sesgos.
2. Cruce con datos frescos (precio, técnico, noticias).
3. Validación contra contexto Jarvis y security audit.
4. Clasificación en un estado (REJECT → BUY_CANDIDATE).
5. Revisión manual de Pedro antes de cualquier acción.

---

## 2. Flujo de ingesta

```
Pedro pega análisis externo
          │
          ▼
  [Etapa 1] Identificación de fuente y ticker
    - ¿Fuente conocida? (Grok / ChatGPT / noticia / tweet / PDF / nota)
    - ¿Ticker explícito? Si no → preguntar a Pedro, NO inventar
    - ¿Empresa ambigua? → marcar como RESEARCH_MORE, pedir aclaración
          │
          ▼
  [Etapa 2] Resumen de tesis por Jarvis
    - Extraer: tesis principal, catalizadores, riesgos explícitos
    - Detectar: hype / sesgo / predicciones sin respaldo
    - Separar: hechos verificables vs. opiniones vs. predicciones
    - Marcar riesgos omitidos con ⚠️
          │
          ▼
  [Etapa 3] Cruce con precio fresco
    - cryptoQuotes[sym].priceMXN (BTC/ETH/XRP) — verificar freshness via .t
    - quotes[ticker] para activos en portafolio
    - Precio faltante/stale — routing contextual:
         Research/watchlist pasiva (sin intento de ejecución):
           → marketDataStatus = "unavailable" o "stale"
           → estado = RESEARCH_MORE o WATCHLIST
           → nextAction = "obtener precio fresco antes de cualquier ejecución"
           "Missing or stale price blocks execution transitions, not research intake."
           "A research item may be saved and monitored without fresh price,
            but it cannot become PAPER_BUY (research state) or trigger PAPER_ONLY
            (linked watchlist state) until price freshness rules pass."
         Intento de PAPER_BUY (research item) o PAPER_ONLY (linked watchlist item) para BTC/ETH/XRP:
           → precio stale o priceAgeSeconds > 120 → BLOCKED
          │
          ▼
  [Etapa 4] Cruce con indicadores técnicos
    - RSI (sobrevendido / sobrecomprado)
    - Tendencia (soporte, resistencia)
    - Volumen (confirma movimiento)
    - Link TradingView generado para revisión visual manual
          │
          ▼
  [Etapa 5] Cruce con news/riesgo
    - ¿Hay noticias recientes negativas sobre el ticker?
    - ¿Earnings o evento binario en los próximos 7 días?
    - ¿Sanción regulatoria / demanda pendiente?
          │
          ▼
  [Etapa 6] Validación de contexto
    - buildSecurityAudit() → si cualquier invariante falla → BLOCKED completo del pipeline:
         dashboardProtected !== true
         privateReadProtected !== true
         accessKeyConfigured !== true
         audit.totals.unprotectedMutationEndpoints > 0
      Si cualquiera falla: el pipeline automatizado se detiene completamente.
        No procesar análisis externo, no clasificar, no crear research item automático,
        no crear watchlist item, no transicionar el research item a PAPER_BUY /
        BUY_CANDIDATE; no transicionar el linked watchlist item a PAPER_ONLY /
        APPROVAL_REQUIRED.
        "Security audit failure blocks research intake processing,
         not just execution transitions."
        Pedro puede conservar el texto como nota manual fuera del pipeline, pero
        el pipeline automatizado no puede ingestar/procesar/almacenar análisis
        externos mientras fallen invariantes de seguridad requeridas.
        "Manual notes may exist outside the automated research pipeline, but
         the pipeline must not ingest/process/store external analysis while
         required security invariants fail."
    - computeJarvisBrain() → jarvisMode DEFENSIVO/NO_TRADING → BLOCKED para ejecución
      (Research/watchlist intake puede continuar marcado como "not actionable")
    - computeHealthReadiness() → recovery < 45 → BLOCKED para ejecución
    - ¿Activo soportado para el modo de ejecución solicitado?
         Research/watchlist intake: acepta cualquier ticker válido y verificable
         Paper trading whitelist (BTC/ETH/XRP): aplica SOLO al intentar PAPER_BUY (research) o PAPER_ONLY (linked watchlist item)
         Equity/ETF no soportado para paper → WATCHLIST / RESEARCH_MORE (no BLOCKED)
          │
          ▼
  [Etapa 7] Clasificación de estado
    REJECT / WATCHLIST / RESEARCH_MORE / PAPER_BUY / BUY_CANDIDATE / BLOCKED
          │
          ▼
  [Etapa 8] Notificación Telegram + acción de Pedro
    - Resumen enviado a Telegram
    - Pedro responde: /watchlist /paper /reject /research_more
    - Real buy: siempre deshabilitado hasta Fase 4
```

---

## 3. Fuentes permitidas

| Fuente | Código | Tratamiento especial |
|---|---|---|
| Grok analysis | `grok` | Detectar sesgo bullish, extraer catalizadores vs. predicciones |
| ChatGPT analysis | `chatgpt` | Ídem; adicionalmente verificar que no sea alucinación de precios |
| Noticia (texto) | `news` | Extraer fecha; noticias > 7 días marcadas como `STALE` |
| Tweet / post | `tweet` | Nivel de confianza bajo por default; requiere tesis explícita |
| PDF / reporte | `pdf` | Extraer sección clave; marcar si es reporte institucional |
| Nota manual de Pedro | `manual` | Mayor confianza; Pedro es la fuente primaria |

> ⚠️ Ninguna fuente externa convierte automáticamente un análisis en acción de trading.
> La fuente es metadato de trazabilidad, no de autoridad.

---

## 4. Campos del research item

```json
{
  "id": "ri_20260615_001",
  "timestamp": "2026-06-15T01:00:00Z",
  "source": "grok",
  "rawInputSummary": "Análisis de Grok sobre BTC: ciclo alcista iniciado por ETF inflows...",
  "ticker": "BTC",
  "companyName": "Bitcoin",
  "assetType": "crypto",
  "exchange": "CRYPTO",
  "thesis": "Acumulación institucional via ETFs podría impulsar precio sobre ATH en 60-90 días",
  "catalysts": [
    "Aprobación de ETF spot en nuevos mercados",
    "Halving completado, reducción de oferta activa"
  ],
  "risks": [
    "Regulación adversa en EE.UU.",
    "Liquidación de ballenas",
    "Corrección macro en risk-off"
  ],
  "timeHorizon": "60-90 días",
  "confidence": 68,
  "riskLevel": "medium",
  "marketDataStatus": "fresh",
  "technicalStatus": "neutral",
  "jarvisMode": "MODERADO",
  "healthContext": "recovery: 72, sleep: 80",
  "securityAuditStatus": "pass",
  "status": "WATCHLIST",
  "nextAction": "Esperar precio bajo soporte $60k para considerar paper trade"
}
```

### Descripción de campos

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | string | ID único: `ri_YYYYMMDD_NNN` |
| `timestamp` | ISO8601 | Cuándo se ingresó |
| `source` | enum | Ver §3 |
| `rawInputSummary` | string | Resumen del texto original (sin secretos) |
| `ticker` | string | Símbolo confirmado por Pedro (no inferido) |
| `companyName` | string | Nombre completo |
| `assetType` | enum | `crypto` / `stock` / `etf` |
| `exchange` | string | NASDAQ / NYSE / CRYPTO / etc. |
| `thesis` | string | Tesis resumida en ≤ 2 oraciones |
| `catalysts` | string[] | Catalizadores identificados explícitamente |
| `risks` | string[] | Riesgos explícitos + omisiones detectadas |
| `timeHorizon` | string | Horizonte declarado o inferido |
| `confidence` | 0-100 | Score de confianza en la tesis |
| `riskLevel` | enum | `low` / `medium` / `high` / `extreme` |
| `marketDataStatus` | enum | `fresh` / `stale` / `unavailable` |
| `marketDataNote` | string? | Opcional — explicación en texto libre si `marketDataStatus` ≠ `fresh` |
| `classifiedClaims` | array? | Opcional — descomposición detallada: `[{ type, text }]` donde type ∈ `FACT / OPINION / PREDICTION / OMITTED_RISK / CATALYST` |
| `technicalStatus` | enum | `bullish` / `neutral` / `bearish` / `unknown` |
| `jarvisMode` | string | Modo Jarvis al momento de la ingesta |
| `healthContext` | string | Recovery/sleep de Pedro al momento |
| `securityAuditStatus` | enum | `pass` / `fail` |
| `status` | enum | Ver §6 |
| `nextAction` | string | Acción sugerida o requerida |

---

## 5. Reglas anti-alucinación

```
✗  No inventar ticker si el análisis no lo menciona explícitamente
     → Si el ticker es ambiguo: preguntar a Pedro, marcar como RESEARCH_MORE
✗  No inferir precio actual de texto externo
     → Precio siempre de cryptoQuotes[sym].priceMXN o quotes[ticker]
     → marketDataStatus siempre enum exacto: "fresh" | "stale" | "unavailable"
     → Sin precio fresco en crypto intentando PAPER_BUY / PAPER_ONLY: BLOCKED
        "Missing fresh price blocks execution, not research intake."
     → Sin precio en equity/ETF: marketDataStatus = "unavailable"
        → estado: RESEARCH_MORE o WATCHLIST (no BLOCKED)
        "No fresh price for equity/ETF means not actionable for execution,
         but still eligible for research/watchlist."
✗  No convertir tesis en buy sin validación
     → Una tesis buena sola no alcanza para PAPER_BUY ni BUY_CANDIDATE
✗  No asumir que el análisis externo es correcto
     → Siempre separar: hechos verificables / opiniones / predicciones
✗  No omitir riesgos detectados aunque no estén en el análisis original
     → Agregar ⚠️ a riesgos omitidos identificados por Jarvis
✗  No ejecutar acción si confidence < 60 sin nota explícita
     → Si confidence < 60: status mínimo WATCHLIST, no PAPER_BUY
✗  No aceptar empresa/ticker de nombre ambiguo sin confirmación
     → Ejemplo: "Meta" → ¿META (Platforms)? ¿otro? → pedir confirmación
```

---

## 6. Estados

| Estado | Significado | Próximo paso |
|---|---|---|
| `REJECT` | Análisis débil, ticker inválido, riesgo extremo o sesgo evidente sin sustancia | Archivar, log de razón |
| `WATCHLIST` | Tesis válida pero sin señal de entrada inmediata; **o** activo válido pero fuera de paper-trading whitelist (ej. AAPL, AMD, SPY) | Monitorear según WATCHLIST_DECISION_SPEC |
| `RESEARCH_MORE` | Falta información para clasificar: ticker ambiguo, horizonte indefinido, precio equity no disponible | Pedro aporta más datos |
| `PAPER_BUY` | Todas las condiciones pasan **y** activo está en paper-trading whitelist; candidato para paper trade | Engine de paper trading (PAPER_TRADING_SPEC.md §6) |
| `BUY_CANDIDATE` | Solo alcanzable tras cumplir la checklist completa Fase 3→4 de TRADING_AUTOPILOT_PLAN.md — ver §6a. ">30 winning paper trades is not sufficient by itself." | Aprobación explícita de Pedro (Fase 4+) |
| `BLOCKED` | Condición crítica sistémica falla (security audit, Jarvis DEFENSIVO durante ejecución, precio crypto stale en PAPER_ONLY, riesgo extremo) — ver §7 | No procesar hasta resolver bloqueo |

### §6a — Gates completos para BUY_CANDIDATE

`BUY_CANDIDATE` no puede asignarse solo por conteo de paper trades ganadores ni por éxito en paper trading. Requiere que se cumplan **todos** los gates de la checklist Fase 3→4 definida en `TRADING_AUTOPILOT_PLAN.md §14`, separados en dos bloques:

**A) Paper trading maturity gates (Fase 2 → Fase 3):**
```
[ ] ≥ 30 paper trades ejecutados con historial documentado
[ ] Win rate ≥ 55% verificado en el periodo de evaluación
[ ] Expected value > 0 (positivo) en el periodo de evaluación
[ ] ≥ 60 días de operación sin crashes ni errores de sistema
[ ] 0 señales alucinadas detectadas en revisión manual
[ ] Kill switch probado y verificado funcional
[ ] Security audit completo OK (todos los invariantes: dashboardProtected,
    privateReadProtected, accessKeyConfigured, unprotectedMutationEndpoints = 0)
```

**B) Human approval / Telegram approval phase gates (Fase 3 → Fase 4):**
```
[ ] Pedro aprueba ≥ 80% de las señales generadas (señales de calidad demostrada)
[ ] Win rate en trades aprobados por Pedro ≥ 60%
[ ] Pedro nunca tuvo que usar kill switch por error del sistema durante la fase de aprobación
[ ] Flujo de aprobación Telegram/manual probado y verificado funcional
[ ] Pedro decide explícitamente avanzar a Fase 4 (aprobación directa, no implícita)
[ ] Real trading sigue deshabilitado hasta que Pedro apruebe Fase 4
```

"Paper trading success alone cannot create BUY_CANDIDATE. The Telegram/manual approval phase must also prove safe."

Si no se cumplen **todos** los gates de A y B, el estado máximo permitido del research item es:
`PAPER_BUY`, `WATCHLIST` o `RESEARCH_MORE` — **nunca `BUY_CANDIDATE`**.
"If any BUY_CANDIDATE gate is missing, the research item maximum status is PAPER_BUY,
 WATCHLIST, or RESEARCH_MORE; never BUY_CANDIDATE."

El linked watchlist item puede estar en `PAPER_ONLY` o `WAITING_FOR_CONFIRMATION`
(según WATCHLIST_DECISION_SPEC), pero el research item debe permanecer dentro del enum
de research: REJECT / WATCHLIST / RESEARCH_MORE / PAPER_BUY / BUY_CANDIDATE / BLOCKED.
"The linked watchlist item may separately be PAPER_ONLY or WAITING_FOR_CONFIRMATION
 under WATCHLIST_DECISION_SPEC, but the research item itself must remain within the
 research enum."

> ⚠️ `BUY_CANDIDATE` es un estado documental futuro. No habilita trading real.
> Real trading solo es posible en Fase 4+ con aprobación explícita de Pedro según
> TRADING_AUTOPILOT_PLAN.md. Cualquier transición a Fase 4 requiere PR separado.

### Distinción: research whitelist ≠ paper trading whitelist

```
Research whitelist:       Cualquier activo con ticker válido confirmado
                          BTC, ETH, XRP, AAPL, AMD, SPY, MSFT...
                          → puede entrar a WATCHLIST o RESEARCH_MORE

Paper trading whitelist:  Solo BTC / ETH / XRP (limitado por el motor actual)
                          → únicos activos que pueden avanzar a PAPER_BUY

Ruta explícita para equities / ETFs:
  Si el análisis es válido pero el activo NO está en la paper trading whitelist:
  → clasificar como WATCHLIST o RESEARCH_MORE — NUNCA como BLOCKED por esa razón
  → el análisis tiene valor; el motor simplemente no soporta ese activo todavía
  → cuando el motor soporte equities, re-evaluar el item

Estados permitidos por tipo de activo:

  Crypto en whitelist (BTC / ETH / XRP):
    WATCHLIST, RESEARCH_MORE, PAPER_BUY, BUY_CANDIDATE, REJECT, BLOCKED

  Equity / ETF (AAPL, AMD, SPY, etc.):
    WATCHLIST, RESEARCH_MORE, REJECT, BLOCKED (solo por condición sistémica)
    ✗ NO PAPER_BUY hasta que el motor soporte equities
    ✗ NO BUY_CANDIDATE automático — requiere Fase 4+ y aprobación manual de Pedro
```

---

## 7. Reglas para BLOCKED

Un research item se marca `BLOCKED` si se cumple **cualquiera** de las siguientes condiciones críticas sistémicas:

```
[ ] Cualquier invariante de security audit falla:
     - dashboardProtected !== true
     - privateReadProtected !== true
     - accessKeyConfigured !== true
     - audit.totals.unprotectedMutationEndpoints > 0
     → Si cualquiera falla: BLOCKED completo para el pipeline automatizado.
       No procesar análisis externo, no clasificar, no crear research item,
       no crear watchlist item, no transicionar el research item a PAPER_BUY /
       BUY_CANDIDATE; no transicionar el linked watchlist item a PAPER_ONLY /
       APPROVAL_REQUIRED.
       "Security audit failure blocks research intake processing,
        not just execution transitions."
       Pedro puede conservar el texto como nota manual fuera del pipeline.
       "Manual notes may exist outside the automated research pipeline, but
        the pipeline must not ingest/process/store external analysis while
        required security invariants fail."

[ ] Precio crypto stale al intentar PAPER_BUY (research item) o PAPER_ONLY (linked watchlist item)
    (priceAgeSeconds > 120)
     → Para equities/ETFs sin precio: RESEARCH_MORE (no BLOCKED)

[ ] jarvisMode = DEFENSIVO o tradingPermission = NO_TRADING al intentar ejecución/paper
     → Para research/watchlist-only: estado "not actionable" en WATCHLIST, no BLOCKED

[ ] riskLevel = "extreme" sin revisión explícita de Pedro

[ ] Earnings o evento binario en los próximos 7 días sin revisión manual,
    si se intenta PAPER_BUY / PAPER_ONLY

[ ] healthContext: recovery < 45 al intentar ejecución/paper

[ ] Análisis completamente ininteligible con intento de ejecución:
    ticker no identificable, sin tesis mínima, y Pedro solicitó paper
```

**No son condición de BLOCKED:**
```
✗  Activo equity/ETF fuera de paper whitelist → WATCHLIST o RESEARCH_MORE
✗  Precio equity no disponible en tiempo real → RESEARCH_MORE
✗  Análisis ambiguo sin intento de ejecución → RESEARCH_MORE
✗  Confidence < 60 → WATCHLIST mínimo
✗  Score bajo (thesis, technical, risk) → REJECTED, RESEARCH_MORE o ACTIVE
   "Low score ≠ BLOCKED. Low score → REJECTED, RESEARCH_MORE, or ACTIVE."
```

Un item `BLOCKED` **no puede convertirse en `PAPER_BUY` ni `BUY_CANDIDATE`** sin que el bloqueo se resuelva y el item se re-evalúe.

---

## 8. Integración con TradingView

El sistema genera links de TradingView para revisión visual manual. TradingView **nunca** ejecuta órdenes; es solo una referencia de confirmación técnica.

### Links generados

```
https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT
https://www.tradingview.com/chart/?symbol=NASDAQ:AAPL
https://www.tradingview.com/chart/?symbol=NASDAQ:AMD
```

### Niveles a revisar manualmente

```
[ ] Soporte más cercano al precio actual
[ ] Resistencia inmediata
[ ] Tendencia en 1D y 4H
[ ] Volumen: ¿confirma la tesis?
[ ] RSI en 1D: ¿sobrevendido / sobrecomprado?
[ ] Media móvil 50D: ¿precio sobre o bajo?
```

> Pedro revisa estos niveles manualmente en TradingView antes de aprobar
> cualquier watchlist item que avance a `PAPER_BUY` o `BUY_CANDIDATE`.
> El sistema incluye el link en el resumen de Telegram para acceso rápido.

---

## 9. Integración con Telegram

### Resumen enviado por Cordelius

```
📋 Nuevo research item — BTC
Fuente: Grok | Estado: WATCHLIST
Tesis: Acumulación institucional via ETFs podría impulsar precio en 60-90d
Confianza: 68/100 | Riesgo: MEDIUM
Precio actual: $67,420 MXN (fresco)
Técnico: neutral | Jarvis: MODERADO
⚠️ Riesgo omitido en análisis original: liquidez de mercado en corrección

📊 TradingView: https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT

¿Qué hacemos?
/watchlist BTC → agregar a watchlist
/paper BTC    → marcar como candidato paper (si reglas pasan)
/reject BTC   → rechazar y archivar
/research_more BTC → pedir más información
```

### Comandos de research — futuros, no habilitados todavía

> ⚠️ Los comandos siguientes son **conceptuales** para el módulo de research intake.
> **No están en la whitelist activa de Telegram** (REMOTE_CONTROL_PLAN.md §3).
> **No están habilitados.** El comportamiento actual de bot.js no debe considerarse
> un mecanismo de seguridad para rechazarlos: slash commands desconocidos pueden
> reenviarse al handler genérico de LLM en vez de rechazarse.
> "These commands are conceptual and not enabled. The current bot behavior must
>  not be relied on as a safety boundary."
>
> Antes de habilitar cualquier comando de research intake en Telegram, bot.js debe
> implementar fail-closed para slash commands desconocidos: cualquier mensaje que
> comience con `/` y no esté en la whitelist activa debe rechazarse explícitamente
> y **NO** reenviarse al handler genérico de LLM.
> "Before enabling research intake via Telegram, bot.js must fail-closed for
>  unknown slash commands: any message starting with / that is not in the active
>  whitelist must be rejected and must not be forwarded to the generic LLM handler."
>
> Habilitar cualquiera de estos comandos requiere: PR separado + revisión de seguridad
> + actualización de whitelist en REMOTE_CONTROL_PLAN.md + fail-closed slash routing.
> "These commands are conceptual for the research intake module and must not be
>  accepted by Telegram until explicitly added to the central whitelist in
>  REMOTE_CONTROL_PLAN.md."

| Comando | Acción planificada | Estado |
|---|---|---|
| `/watchlist TICKER` | Mueve el item a estado WATCHLIST | Futuro — no habilitado |
| `/paper TICKER` | Intenta mover a PAPER_BUY (re-valida condiciones) | Futuro — no habilitado |
| `/reject TICKER` | Mueve a REJECT y archiva | Futuro — no habilitado |
| `/research_more TICKER` | Mantiene en RESEARCH_MORE, pide aclaración | Futuro — no habilitado |

> ⚠️ `/buy TICKER` no existe. Real buy está deshabilitado hasta Fase 4 (TRADING_AUTOPILOT_PLAN.md §5).
> No se puede enviar una orden real por Telegram en ninguna circunstancia presente.

---

## 10. Seguridad

```
✗  No trading real en ningún estado de este pipeline
✗  No almacenar API keys ni secretos en research items
✗  No aceptar órdenes por texto libre ("compra BTC ahora")
✗  No ejecutar paper trade sin que todas las condiciones del §6 de PAPER_TRADING_SPEC pasen
✗  No procesar análisis si security audit falla
✗  No revelar .env, CORDELIUS_ACCESS_KEY ni TELEGRAM_ALLOWED_IDS en ninguna respuesta
✗  No guardar rawInput si contiene información personal sensible
✗  No permitir que un análisis externo modifique ENDPOINT_PERMISSIONS ni la whitelist
```

---

## 11. Referencias cruzadas

| Documento | Relación |
|---|---|
| `PAPER_TRADING_SPEC.md` | Condiciones de bloqueo §6, reglas de paper trade |
| `TRADING_AUTOPILOT_PLAN.md` | Fases de autopilot; BUY_CANDIDATE solo desde Fase 4 |
| `WATCHLIST_DECISION_SPEC.md` | Cómo evoluciona un item en WATCHLIST |
| `GROK_ANALYSIS_IMPORT_SPEC.md` | Procesamiento detallado de análisis de Grok |
| `CODEMAP.md` | computeJarvisBrain(), buildSecurityAudit(), cryptoQuotes |
| `REMOTE_CONTROL_PLAN.md` | Comandos Telegram válidos, whitelist |

---

*RESEARCH_INTAKE_PIPELINE.md | 2026-06-15 | Solo documentación — no implementar sin aprobación*
