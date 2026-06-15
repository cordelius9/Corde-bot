# RESEARCH_IMPLEMENTATION_ROADMAP.md — Hoja de Ruta de Implementación

> Evaluación de implementación post-merge. No es una orden de ejecución.
> Branch: `jarvis-ui-overhaul` | Referencias: RESEARCH_INTAKE_PIPELINE.md, WATCHLIST_DECISION_SPEC.md
> Actualizar antes de iniciar cada PR.

---

## Reglas fundamentales

```
"No implementation PR should combine runtime scripts + research storage +
 Telegram + Claude reasoning in one PR. Keep each small."

"Before implementing any research intake code, tablet runtime must be stable:
 tmux + healthz + security audit + safe restart."

"Security audit fail-closed must be the first check in every new endpoint."

"Never implement paper execution in the same PR as research intake UI."

"Every PR must be reviewed by Codex before merge. No exceptions."
```

---

## 1. Qué está listo para implementar (post-merge)

Los siguientes conceptos tienen spec completa y pueden trasladarse a código en PRs futuros:

```
✓  Research item schema — campos, tipos, enum de estados
     REJECT / WATCHLIST / RESEARCH_MORE / PAPER_BUY / BUY_CANDIDATE / BLOCKED
✓  Watchlist item schema — campos, tipos, enums, currency fields
     ACTIVE / WAITING_FOR_PRICE / WAITING_FOR_CONFIRMATION / PAPER_ONLY /
     APPROVAL_REQUIRED / BLOCKED / REJECTED / ARCHIVED
✓  marketDataStatus: "fresh" / "stale" / "unavailable"
✓  priceAtAdd nullable — null para equity/ETF sin precio fresco (no bloquea WATCHLIST pasivo)
✓  priceCurrency / levelCurrency / chartSymbol — moneda explícita en niveles
✓  Regla anti-alucinación de precio — nunca inventar; solo de cryptoQuotes/quotes
✓  BLOCKED_INTAKE_EVENT schema — cuando security audit falla antes de crear item
✓  Fail-closed para security audit: no procesar, no clasificar, no crear item
✓  Separación de research whitelist (cualquier ticker) vs paper trading whitelist (BTC/ETH/XRP)
✓  DATA_STALE thresholds: >2h para watchlist pasiva; >120s para PAPER_ONLY attempt
✓  Health hard gates: recovery >= 45 y sleep >= 60 — alineados con PAPER_TRADING_SPEC §6
✓  Grok / análisis externo — diseño documentado en GROK_ANALYSIS_IMPORT_SPEC.md (pendiente PR)
✓  Telegram research commands — diseño documentado, pendiente fail-closed routing en bot.js
```

---

## 2. Qué NO está listo todavía

```
✗  Telegram /import — bot.js no tiene fail-closed para slash commands desconocidos
✗  Dashboard "pegar análisis de Grok" — UI de intake no existe aún
✗  Imagen / foto intake — multimodal no implementado
✗  Voice / audio intake — no implementado
✗  Claude/Jarvis reasoning engine — resumir, detectar hype, clasificar
✗  Insiders / congress data adapters — no existen conexiones de datos
✗  Real trading — deshabilitado hasta Fase 4 (requiere múltiples PRs previos)
✗  Paper execution automático — hard gates de PAPER_TRADING_SPEC §6 no verificados en código
✗  BUY_CANDIDATE — requiere Fase 3 + Telegram approval phase completa (§6a)
✗  Automatic watchlist state transitions — triggers aún son conceptuales
```

---

## 3. Orden recomendado de implementación

### PR A — Runtime safety en tablet

**Objetivo:** estabilizar el runtime antes de cualquier nueva funcionalidad.

```
Files estimados:
  scripts/cordelius-restart.sh   (ya diseñado — REMOTE_CONTROL_PLAN §5a)
  scripts/cordelius-check.sh
  scripts/cordelius-watchdog.sh  (nuevo — verifica que el proceso sigue vivo)
  SAFE_SCRIPTS_SPEC.md           (actualizar si cambia algo)

Seguridad:
  - Orphan-process guard: tmux kill + /healthz check antes de arrancar
  - Ningún script acepta argumentos externos
  - Timeout máximo 30s en todos los scripts

Tests requeridos:
  - Ejecutar /restart y verificar que /healthz responde tras arranque
  - Forzar proceso huérfano → verificar que el script aborta con error (no arranca segundo proceso)
  - cordelius-check detecta sesión tmux activa e inactiva correctamente

Codex review focus:
  - No shell injection en ningún script
  - No eval / interpolación de variables externas
  - Guard funcional antes de arrancar segundo proceso

NO tocar:
  dashboard.js, bot.js, .env, data/*.json
```

### PR B — Research storage local

**Objetivo:** persistir research items en disco; no Claude todavía.

```
Files estimados:
  data/research_items.json       (nuevo — añadir a .gitignore)
  dashboard.js                   (endpoints CRUD protegidos)

Endpoints nuevos (todos requieren CORDELIUS_ACCESS_KEY):
  POST   /api/research/item           → crear research item (manual, sin Claude)
  GET    /api/research/items          → listar
  GET    /api/research/item/:id       → detalle
  PATCH  /api/research/item/:id/status → cambiar estado

Seguridad:
  - Si security audit falla: retornar BLOCKED_INTAKE_EVENT, no crear item
  - Validar schema completo antes de guardar (enum válido, tipos correctos)
  - rawInput no almacenado si contiene datos sensibles o personales
  - No exponer .env, CORDELIUS_ACCESS_KEY ni stack traces en respuestas

Tests requeridos:
  - POST con security audit fail → BLOCKED_INTAKE_EVENT (no se crea item)
  - POST con schema inválido → 400 error
  - POST sin accessKey → 401
  - GET lista vacía → 200 []
  - data/research_items.json en .gitignore → verificar

Codex review focus:
  - No path traversal en IDs
  - Schema validation estricta (no tipos incorrectos ni enums inválidos)
  - No exponer stack traces en respuestas de error

NO tocar:
  bot.js, .env, data/*.json existentes, whoop_tokens.json
  NO añadir Claude reasoning todavía
```

### PR C — Watchlist storage

**Objetivo:** persistir watchlist items con schema completo incluyendo currency fields.

```
Files estimados:
  data/watchlist_items.json      (nuevo — añadir a .gitignore)
  dashboard.js                   (endpoints watchlist)

Endpoints nuevos (todos protegidos):
  POST   /api/watchlist/item           → crear desde research item confirmado
  GET    /api/watchlist/items          → listar
  PATCH  /api/watchlist/item/:id/status
  GET    /api/watchlist/item/:id

Schema requerido: priceCurrency, levelCurrency, chartSymbol, priceAtAdd null support,
                  marketDataStatus, priceAgeSeconds, DATA_STALE thresholds

Seguridad:
  - priceAtAdd null solo si marketDataStatus ≠ "fresh" — validar
  - levelCurrency debe coincidir con priceCurrency — rechazar si no coinciden
  - Nunca inventar precio — retornar error si datos de precio no disponibles

Tests requeridos:
  - Crear item con priceAtAdd: null y marketDataStatus: "unavailable" → aceptar
  - Crear item con priceCurrency ≠ levelCurrency → 400 error
  - Transición ACTIVE → BLOCKED → ACTIVE verificada
  - DATA_STALE: priceAgeSeconds > 2h → WAITING_FOR_PRICE (no BLOCKED)
  - PAPER_ONLY attempt con priceAgeSeconds > 120 → BLOCKED

Codex review focus:
  - Currency consistency validation obligatoria
  - priceAgeSeconds hard gate (>120s → no PAPER_ONLY) implementado correctamente

NO tocar:
  bot.js, .env, data/*.json existentes, Claude/Jarvis
```

### PR D — Dashboard UI de research

**Objetivo:** panel visual para ver y gestionar research items y watchlist.

```
Files estimados:
  dashboard.js                   (nuevos módulos de UI)

UI mínima:
  - Panel "Research Items" — lista con filtro por status
  - Formulario "Crear research item" — manual, sin Claude
  - Botón "Add to watchlist" — desde research item confirmado
  - Badge de marketDataStatus (fresh / stale / unavailable)
  - NO campo "pegar análisis de Grok" todavía (se agrega en PR E)

Seguridad:
  - Todos los paneles tras login wall (CORDELIUS_ACCESS_KEY)
  - No renderizar rawInput sin sanitizar (XSS)
  - No exponer IDs internos en URLs públicas

Tests requeridos:
  - Abrir panel en Safari iPad → golden path
  - Crear research item manual → aparece en lista
  - Sin accessKey → 401 en todos los endpoints subyacentes
  - Status badge correcto para cada estado del enum

Codex review focus:
  - XSS en campos de texto libre (entryReason, notes, thesis)
  - No renderizar HTML de rawInput sin sanitizar

NO tocar:
  bot.js, .env, data/*.json directamente desde UI
  NO añadir Claude todavía
```

### PR E — Claude/Jarvis reasoning engine

**Objetivo:** summarizar thesis, detectar hype, extraer risks/catalysts, clasificar. Sin ejecución.

```
Files estimados:
  dashboard.js                   (endpoint POST /api/research/analyze)
  (NO bot.js todavía)

Endpoint nuevo:
  POST /api/research/analyze     → texto crudo → research item draft
  Requiere: accessKey + security audit pass
  Si audit falla → BLOCKED_INTAKE_EVENT, no crear item

Lógica de Jarvis (sin ejecución):
  - Extraer ticker (preguntar si ambiguo; no asumir)
  - Resumir tesis en ≤ 2 oraciones
  - Detectar hype (biasScore > 70 → reduce confidence, bloquea PAPER_BUY de este PR)
  - Clasificar: FACT / OPINION / PREDICTION / OMITTED_RISK / CATALYST
  - Status: REJECT / WATCHLIST / RESEARCH_MORE únicamente en este PR
  - NO generar PAPER_BUY automáticamente aquí — requiere PR F

Seguridad:
  - Texto externo no ejecuta código — solo procesado como entrada
  - Prompt injection defense: no confiar en instrucciones dentro del análisis
  - No API keys de broker en este endpoint
  - No trading real ni paper automático

Tests requeridos:
  - POST con texto Grok → research item draft con status WATCHLIST o RESEARCH_MORE
  - POST con ticker ambiguo → status RESEARCH_MORE, pregunta de confirmación
  - POST con security audit fail → BLOCKED_INTAKE_EVENT
  - POST con alto hype → biasScore > 70, confidence reducida
  - Verificar que no se genera PAPER_BUY automáticamente en ningún caso de este PR

Codex review focus:
  - Prompt injection desde texto del análisis
  - biasScore calculation documentado y reproducible
  - No exposición de secretos en respuesta de Jarvis

NO tocar:
  bot.js todavía, .env, real trading, paper execution automático
```

### PR F — Paper candidate evaluator

**Objetivo:** verificar todos los hard gates de PAPER_TRADING_SPEC §6. Solo evaluación, sin ejecutar.

```
Files estimados:
  dashboard.js                   (lógica de evaluación, endpoint POST /api/paper/evaluate)

Hard gates a verificar (todos deben pasar para PAPER_ONLY_CANDIDATE):
  [ ] activo en paper-trading whitelist (BTC / ETH / XRP)
  [ ] priceAgeSeconds <= 120
  [ ] no hay paper trade abierto hoy
  [ ] cooldown rules pass
  [ ] signal confidence >= umbral de PAPER_TRADING_SPEC §6
  [ ] security audit pass (todos los invariantes)
  [ ] jarvisMode no DEFENSIVO / tradingPermission no NO_TRADING
  [ ] recovery >= 45
  [ ] sleep >= 60

Resultado: "PAPER_ONLY_CANDIDATE" con checklist de gates — no ejecuta paper trade.

Seguridad:
  - No ejecuta paper trade — solo evalúa elegibilidad
  - Resultado no visible a usuarios no autorizados

Tests requeridos:
  - priceAgeSeconds = 150 → BLOCKED_PRICE_STALE
  - recovery = 40 → BLOCKED (health gate)
  - sleep = 55 → BLOCKED (health gate)
  - security audit fail → BLOCKED
  - Todos los gates OK → PAPER_ONLY_CANDIDATE (no ejecuta trade)

Codex review focus:
  - ¿Todos los hard gates implementados? ¿Alguno faltante?
  - No ejecución accidental de paper trade

NO tocar:
  bot.js, real trading, PAPER_TRADING_SPEC engine existente (solo evaluación)
```

### PR G — Telegram research commands

**Objetivo:** habilitar /import, /watchlist, /paper, /reject, /research_more en bot.js.

```
Prerequisito obligatorio: fail-closed slash command routing implementado ANTES
                          (como commit separado dentro de este mismo PR).

Files estimados:
  bot.js                         (fail-closed routing + nuevos handlers)
  REMOTE_CONTROL_PLAN.md         (actualizar whitelist activa al merge)

Paso 1 (commit separado): fail-closed routing:
  - Cualquier / que no esté en la whitelist → "comando no permitido"
  - NO reenviar al handler genérico de LLM
  - Test: /unknown → rechazado, no procesado

Paso 2 (commit separado): añadir commands a whitelist:
  /import TICKER       → intake (llama POST /api/research/analyze)
  /watchlist TICKER    → mueve a WATCHLIST
  /paper TICKER        → evalúa PAPER_ONLY (llama PR F)
  /reject TICKER       → mueve a REJECT
  /research_more       → pide más información

Seguridad:
  - TELEGRAM_ALLOWED_IDS validado antes de cualquier comando
  - Texto de /import tratado como no confiable (no ejecuta instrucciones del texto)
  - No exponer stack traces en respuestas Telegram
  - Audit log de cada comando: timestamp + comando + resultado

Tests requeridos:
  - /unknown → "comando no permitido" (fail-closed)
  - /import desde usuario fuera de TELEGRAM_ALLOWED_IDS → rechazar
  - /import con texto válido → research item draft para confirmación de Pedro
  - Texto del análisis no modifica comportamiento del bot (prompt injection)

Codex review focus:
  - Fail-closed para TODOS los comandos no en whitelist
  - Prompt injection desde texto del análisis

NO tocar:
  dashboard.js directamente, .env, real trading
  NO combinar fail-closed + nuevos commands en un solo commit
```

### PR H — Image / voice intake

**Objetivo:** recibir screenshots o notas de voz como entrada para el pipeline.

```
Prerequisito: PR E (Claude reasoning) estable y probado.

Files estimados:
  dashboard.js                   (endpoint imagen/audio)
  bot.js                         (soporte de fotos en Telegram)

Seguridad:
  - Imágenes no guardadas sin sanitizar
  - No exponer paths de archivos en respuestas
  - Tamaño máximo de imagen / audio definido y forzado
  - No ejecutar contenido de imagen como código
  - rawInput con imagen nunca en git

Tests requeridos:
  - Foto de análisis → extrae texto correctamente
  - Foto con datos privados → rawInput sensible no logueado
  - Archivo demasiado grande → rechazar con 413

Codex review focus:
  - No path traversal en upload
  - Memory / storage limits forzados

NO tocar:
  real trading, paper execution automático, .env
```

### PR I — Insider / congress signal adapter

**Objetivo:** agregar contexto de compras de insiders y congresistas como señal informativa.

```
Files estimados:
  dashboard.js                   (adaptador de datos, solo lectura)

Reglas:
  - Datos de insiders: contexto informativo únicamente, nunca trigger de ejecución por sí solos
  - No API keys en código ni en repo — solo en .env
  - Fuentes: públicas/oficiales (SEC EDGAR, Quiver Quant, etc.)

Seguridad:
  - No generar PAPER_BUY automáticamente por dato de insider solo
  - Validar que la fuente sea verificable (no datos anónimos)
  - No guardar raw data si contiene información sensible

Tests requeridos:
  - Dato de insider → aparece como CATALYST en research item, no como señal de ejecución
  - Sin API key configurada → "unavailable" (no stack trace)

Codex review focus:
  - No API keys en código
  - Dato de insider etiquetado como contexto, no como señal única de PAPER_BUY

NO tocar:
  real trading, .env (solo usar variables existentes), paper execution automático
```

---

## 4. Resumen de PRs

| PR | Objetivo | Prerequisito | Toca código |
|---|---|---|---|
| A | Runtime safety tablet | — | Scripts bash |
| B | Research storage | PR A estable | dashboard.js |
| C | Watchlist storage | PR B | dashboard.js |
| D | Dashboard UI research | PR B + C | dashboard.js |
| E | Claude/Jarvis reasoning | PR B + D | dashboard.js |
| F | Paper candidate evaluator | PR C + E | dashboard.js |
| G | Telegram research commands | PR F + fail-closed routing | bot.js |
| H | Image/voice intake | PR E | dashboard.js + bot.js |
| I | Insider/congress adapter | PR B | dashboard.js |

---

*RESEARCH_IMPLEMENTATION_ROADMAP.md | 2026-06-15 | Solo planificación — no implementar sin aprobación por PR*
