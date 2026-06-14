# CODEMAP.md v1 — Cordelius Personal OS

> **Propósito:** Referencia rápida de arquitectura para agentes AI (Claude, GPT, Codex).
> Permite entender el proyecto sin releer `dashboard.js` completo cada sesión.
>
> **Generado:** 2026-06-14 | Branch: `jarvis-ui-overhaul` | Commit base: `b0cffa7`
> **Marcas:** 🔲 = pendiente de verificar en repo | ✅ = confirmado | ⚠️ = invariante de seguridad

---

## 1. Resumen de arquitectura

```
[Galaxy Tab S6 / Termux]
       │
       ├─ node start-with-env.js
       │     └─ dashboard.js  ← app principal (puerto 3000)
       │           ├─ http.createServer()  (sin framework)
       │           ├─ PORTFOLIO[] — 18 activos en memoria
       │           ├─ whoopCache  — in-memory (no en disco directamente)
       │           ├─ quotes{}    — in-memory, FinnHub/manual
       │           └─ news[]      — in-memory, fetch periódico
       │
       ├─ node trading_ai.js   (puerto 3001, simulador ficticio)
       └─ node bot.js          (Telegram, Claude Haiku)

[APIs externas — solo lectura o OAuth]
  FinnHub → quotes
  WHOOP   → whoopCache (OAuth, tokens en whoop_tokens.json — NUNCA en git)
  QuiverQuant → congressional/insider data (QUIVER_API_KEY)
  Anthropic → Alfredo AI / Jarvis (ANTHROPIC_API_KEY)
  CoinGecko → precios cripto (Bitso)
```

**Principios de diseño:**
- Zero npm — solo módulos nativos: `http`, `https`, `fs`, `path`, `child_process`
- Un solo proceso principal, un solo archivo de ~10 k líneas
- Sin base de datos: JSON files en disco + variables en memoria
- Sin framework frontend: HTML generado por `render()` en Node.js
- Educativo/simulado — ningún broker real recibe órdenes

---

## 2. Módulos principales (frontend)

Los módulos son divs con clase `.mod`. Control por `showMod(name)`.

```
CSS:   .mod { display: none }
       .mod.active-mod { display: block }
JS:    showMod(name)  — persiste en localStorage.corde_mod y URL hash
Boot:  lee hash o corde_mod al cargar página
```

| Módulo | Función render | Función(es) de datos | Notas |
|---|---|---|---|
| `home` | `renderHomePortal(pv, reg)` | `portfolioValue()`, `computeDailyNewsletter()` | Panel resumen ejecutivo |
| `trading` | `renderSignalCenter(pv, reg)` | `portfolioValue()`, `computeTradeIdea()`, `alfredoAction()` | Señales y scores por activo |
| `health` | `renderHealthOSPanel()` → `renderHealthReadinessPanel()` | `computeHealthReadiness()` | WHOOP + checkins + behavioral rules |
| `journal` | `renderJournalModule()` | `computeJournalData()`, `computeAutoJournal()` | Diario personal + auto-journal |
| `intelligence` | `renderDailyScanCard()`, `renderExternalRadar()`, `renderQuiverPanel()` | `computeDailyScan()`, `computeExternalMarketIntelligence()`, `computeQuiverIntelligence()` | Radar de mercado |
| `jarvis` | `renderJarvisPrivatePanel()`, `renderExecutivePanel()` | `buildJarvisPrivateSummary()`, `buildExecutiveBriefing()` | OS regulatorio personal |
| `autopilot` | `renderAutopilotPanel()` | `getAutopilotDatabaseState()`, `computeAutopilotLearning()` | Decisiones + aprendizaje |
| `doctor` | `renderCordeliusDoctor()` 🔲 | `buildSecurityAudit()` 🔲, `computeJarvisBrain()` 🔲 | Diagnóstico del sistema |

> 🔲 `renderCordeliusDoctor`, `buildSecurityAudit`, `computeJarvisBrain` y `buildTodayFeed`
> existen en la versión `b0cffa7` del tablet pero no están confirmados en esta copia.
> Verificar con `grep -n "renderCordeliusDoctor\|buildSecurityAudit\|computeJarvisBrain\|buildTodayFeed" dashboard.js`

---

## 3. Mapa de endpoints

> ⚠️ **Invariante:** `unprotectedMutationEndpoints: 0` — todo POST/mutación requiere auth o acceso local.

### publicRead — sin autenticación
```
GET  /health                    — health check JSON básico
GET  /api/paper/status          — estado del simulador de paper trading
GET  /api/whoop/status          — conexión WHOOP (sin datos personales)
```

### privateRead — requieren auth 🔲 (verificar esquema exacto de auth en repo)
```
GET  /api/status                — estado completo JSON
GET  /api/portfolio             — portafolio completo JSON
GET  /api/intel                 — items Intel con resumen mood/ticker
GET  /api/quiver                — datos Quiver Quant
GET  /api/quiver/matches        — tickers del portafolio con datos Quiver
GET  /api/quiver/trending       — tickers trending en Quiver
GET  /api/daily-scan            — scan diario completo
GET  /api/market-radar          — radar de mercado externo
GET  /api/intelligence          — inteligencia consolidada
GET  /api/daily-brief           — brief biologico/trading del día
GET  /api/market-intelligence   — inteligencia de mercado externa
GET  /api/external-radar        — radar externo por sector
GET  /api/morning-report        — reporte matutino
GET  /api/whoop/profile         — perfil WHOOP
GET  /api/whoop/cycle           — ciclo WHOOP actual
GET  /api/whoop/today           — datos WHOOP del día
GET  /api/health-readiness      — readiness numérico
GET  /api/journal/auto          — auto-journal
GET  /api/journal/status        — estado journal
GET  /api/journal               — entries del journal
GET  /api/os-status             — estado del OS completo
GET  /api/daily/today           — checkin y datos del día
GET  /api/daily/learning        — aprendizaje diario
GET  /api/jarvis/context        — contexto Jarvis completo
GET  /api/jarvis/memory         — memoria consolidada Jarvis
GET  /api/jarvis/private-memory — memoria privada Jarvis (regulación personal)
GET  /api/jarvis/brain          — 🔲 fused context endpoint (patch b0cffa7)
GET  /api/portfolio/editable    — portafolio editable runtime
GET  /api/alerts                — alertas activas
GET  /api/intelligence/today    — inteligencia de hoy
GET  /api/executive             — briefing ejecutivo
GET  /api/executive/history     — historial ejecutivo
GET  /api/executive/score       — score ejecutivo
GET  /api/project/status        — estado del proyecto
GET  /api/project/memory        — memoria del proyecto
GET  /api/project/log           — build log
GET  /api/project/roadmap       — roadmap
GET  /api/market/brain          — market brain (scan)
GET  /api/market/watchlist      — watchlist extendida
GET  /api/decisions             — decisiones registradas
GET  /api/decisions/patterns    — patrones de decisiones
GET  /api/decisions/playbook    — playbook personal
GET  /api/autopilot/database    — base de datos autopilot
GET  /api/autopilot/progress    — progreso autopilot
GET  /api/autopilot/decisions   — decisiones autopilot
```

### mutateProtected — ≥18 endpoints, todos requieren auth ⚠️
```
POST /api/portfolio/update      — actualiza precio/costo de activo
POST /api/portfolio/add         — agrega activo al portafolio
POST /api/portfolio/remove      — elimina activo
POST /api/daily/checkin         — guarda checkin del día
POST /api/daily/snapshot        — snapshot de aprendizaje diario
POST /api/alerts/check          — ejecuta check de alertas
POST /api/alerts/ack            — acknowledges alerta
POST /api/executive/run         — corre briefing ejecutivo AI
POST /api/market/brain/run      — ejecuta market brain scan
POST /api/market/watchlist/add  — agrega ticker a watchlist
POST /api/market/watchlist/remove — elimina ticker
POST /api/decisions/add         — registra nueva decisión
POST /api/decisions/outcome     — registra resultado de decisión
POST /api/autopilot/snapshot    — snapshot autopilot
POST /api/autopilot/decision    — nueva decisión autopilot
POST /api/autopilot/decision/outcome — resultado decisión autopilot
POST /api/jarvis/check-in       — check-in Jarvis (estado fisiológico)
POST /api/project/log           — agrega entrada al build log
POST /research                  — investiga ticker con AI
```

### mutateLocal — state interno sin datos financieros
```
GET  /toggle-thinking           — alterna modo thinking de Claude
GET  /bot/start                 — enciende bot ficticio
GET  /bot/pause                 — pausa bot ficticio
GET  /bot/reset                 — reinicia bot ficticio
POST /ask                       — pregunta a Alfredo AI
POST /intel                     — agrega item Intel (con dedup)
POST /intel/delete              — elimina item Intel por hash
POST /intel/clear               — elimina todos los items Intel
POST /api/journal               — guarda entrada en journal
```

### dangerous — OAuth / tokens reales ⚠️
```
GET  /whoop/auth                — inicia flujo OAuth WHOOP → redirect externo
GET  /whoop/callback            — recibe code OAuth, guarda tokens
GET  /api/whoop/callback        — alias interno del callback
```
> ⚠️ Estas rutas manejan `whoop_tokens.json`. No modificar sin revisión de seguridad.

---

## 4. Funciones core y dependencias

### Árbol de dependencias crítico

```
computeJarvisBrain() 🔲
  ├─ buildJarvisPrivateSummary()
  │     └─ computeJarvisOperatingMode(whoopData, checkIn)
  │           └─ computeHealthReadiness()  ← IN-MEMORY whoopCache (no desde archivo)
  ├─ portfolioValue()
  │     └─ assetLiveValue(a) → quotes{} / a.valueManual
  ├─ getOpportunityState() 🔲 / computeDailyScan()
  ├─ loadJSON("data/jarvis_daily_brief.json")  ← fuente de verdad de estado
  └─ loadJSON("data/jarvis_action_plan.json")  ← fuente de verdad de trading

renderHomePortal(pv, reg)
  ├─ computeDailyNewsletter()
  │     └─ computeIntelligence() → news[], Quiver, external radar
  └─ portfolioValue()

buildSecurityAudit() 🔲
  └─ [mapeo dinámico de ROUTE_ACCESS / publicRead / privateRead / mutateProtected]
```

### Funciones de datos y mercado

| Función | Propósito | Datos de entrada |
|---|---|---|
| `portfolioValue()` | Totales MXN/USD, ganancias, riesgo del portafolio | `PORTFOLIO[]`, `quotes{}`, `FX_USD_MXN` |
| `assetLiveValue(a)` | Precio actual de un activo | `quotes[a.symbol]` o `a.valueManual` |
| `assetScore(a)` | Score 0-100 por activo | `indicators(a)`, `alfredoAction(a)` |
| `alfredoAction(a)` | Señal: MANTENER/BUY DIP/VIGILAR/etc | `indicators(a)` |
| `indicators(a)` | RSI, MACD, momentum, volatilidad (deterministicos) | `seedFor(a.symbol)` + precio |
| `marketRegime()` | Régimen global: BULL/BEAR/NEUTRAL | `portfolioValue()`, `news[]` |
| `computeTradeIdea()` | Idea de trade top para el día | `computeDailyScan()` |

### Funciones de salud (WHOOP)

| Función | Propósito | Fuente |
|---|---|---|
| `computeHealthReadiness()` | Scores numéricos: recovery, sleep, strain, hrv | `whoopCache` IN-MEMORY |
| `refreshWhoopCache()` | Actualiza `whoopCache` desde API WHOOP | `fetchWhoopAPI()` → API |
| `computeJarvisOperatingMode(w, c)` | ÓPTIMO/MODERADO/DEFENSIVO/DESCANSO | `computeHealthReadiness()` |
| `renderHealthReadinessPanel()` | Panel visual de readiness | `computeHealthReadiness()` |

> ⚠️ **CRÍTICO:** `whoopCache` es in-memory. El archivo `whoop_today_cache.json` guarda
> objetos API crudos `{records:[...]}`, NO números. Siempre usar `computeHealthReadiness()`
> para obtener valores numéricos. No leer `whoop_today_cache.json` directamente para scores.

### Funciones de inteligencia

| Función | Propósito |
|---|---|
| `computeDailyScan()` | Scan diario: scores, señales, oportunidades |
| `computeExternalMarketIntelligence()` | Análisis de tickers externos (no en portafolio) |
| `computeQuiverIntelligence()` | Datos congressional + insider (QuiverQuant) |
| `computeIntelligence()` | Consolidado: portfolio + external + Quiver + news |
| `computeDailyNewsletter()` | Newsletter diaria con bullets de acción |
| `computeMarketRadar()` | Radar de mercado multi-sector |
| `computeSectorThemes()` | Temas de mercado por sector |
| `classifyNews(n)` | mood, tickers afectados, tags de noticia |

### Funciones de Jarvis / Executive OS

| Función | Propósito |
|---|---|
| `buildJarvisPrivateSummary()` | Resumen estado fisiológico + reglas + modo operativo |
| `buildJarvisContext()` | Contexto completo para prompt de Claude |
| `buildExecutiveBriefing()` | Briefing ejecutivo AI (Claude) |
| `buildMemorySummary()` | Resumen de memoria del proyecto |
| `computeJarvisOperatingMode(w,c)` | Modo: ÓPTIMO / MODERADO / DEFENSIVO / DESCANSO |
| `readPrivateJarvisMemory()` | Lee perfil privado, reglas, preguntas diarias |
| `saveJarvisCheckIn(data)` | Persiste check-in fisiológico |
| `getDecisionIntelligence()` | Patrones + playbook + inteligencia decisional |

### Funciones de Autopilot

| Función | Propósito |
|---|---|
| `getAutopilotDatabaseState()` | Estado completo: snapshots, decisiones, patterns |
| `computeAutopilotLearning()` | Learning desde historial de decisiones |
| `computeCordeliusPatterns()` | Patrones de comportamiento detectados |
| `analyzeDecisionPatterns()` | Análisis estadístico de decisiones pasadas |
| `buildPersonalPlaybook(patterns)` | Genera playbook desde patterns |
| `computeExecutiveScore(sources)` | Score ejecutivo multi-factor |

### Funciones de sistema

| Función | Propósito |
|---|---|
| `loadJSON(file, fallback)` | Lectura segura de JSON (retorna fallback si falla) |
| `saveJSON(file, data)` | Escritura JSON simple |
| `readJSONSafe(file, fallback)` | Lectura atómica más robusta |
| `writeJSONAtomic(file, data)` | Escritura atómica (data/) |
| `ensureDataDir()` | Crea `data/` si no existe |
| `render()` | Genera HTML completo del dashboard |
| `boot()` | Arranca server + intervals + refreshes |
| `intelHash(text)` | Fingerprint determinístico para dedup |
| `intelMatchWord(text, word)` | Regex word-boundary (evita falsos positivos) |
| `analyzeIntelText(text)` | Clasifica texto: mood, tickers, tags, hash |

### Estado de las 4 funciones solicitadas en issue #11

| Función | Estado en repo remoto | Verificar en tablet (b0cffa7) |
|---|---|---|
| `buildSecurityAudit` | 🔲 No encontrada en copia remota | `grep -n "buildSecurityAudit" dashboard.js` |
| `buildTodayFeed` | 🔲 No encontrada en copia remota | `grep -n "buildTodayFeed" dashboard.js` |
| `getAutomationState` | 🔲 No encontrada (posible alias de `getAutopilotDatabaseState`) | `grep -n "getAutomationState\|AutomationState" dashboard.js` |
| `computeJarvisBrain` | 🔲 Agregada por `apply-brain-patch.js`, no en base | `grep -n "computeJarvisBrain" dashboard.js` |

---

## 5. Archivos de datos

> ⚠️ **Todos en `.gitignore`. NUNCA commitear.**

### Root — cargados en boot, gestionados en memoria
```
bot_state.json              ← estado bot ficticio (posiciones, P&L, thoughts)
portfolio_history.json      ← historial de valuaciones (array de puntos)
alfredo_chat_history.json   ← historial de chat con Alfredo AI
cordelius_settings.json     ← configuración usuario (autoRefresh, thinking, etc.)
cordelius_intel.json        ← items de Intel manual (dedup por hash)
cordelius_journal.json      ← entradas del diario personal
whoop_today_cache.json      ← cache raw WHOOP API (objetos, NO números) ⚠️
```
> ⚠️ `whoop_tokens.json` — NUNCA leer, NUNCA mencionar contenido, NUNCA commitear.

### data/ — escritura atómica, creados en runtime
```
health_snapshots.json           ← snapshots de readiness a lo largo del tiempo
portfolio_snapshots.json        ← snapshots del portafolio a lo largo del tiempo
trading_decisions.json          ← decisiones de trading registradas
autopilot_memory.json           ← memoria consolidada del autopilot
cordelius_progress.json         ← progreso del proyecto (hitos)
decision_outcomes.json          ← resultados de decisiones pasadas
daily_learning.json             ← aprendizaje diario generado por AI
market_daily_snapshots.json     ← snapshots diarios de mercado
user_daily_checkins.json        ← checkins diarios del usuario
cordelius_patterns.json         ← patrones de comportamiento detectados
daily_intelligence_summary.json ← resumen de inteligencia del día
cordelius_alerts.json           ← alertas activas (F3b)
cordelius_portfolio.json        ← portafolio editable runtime (F3c)
market_brain.json               ← último scan del market brain
market_brain_history.json       ← historial de scans
market_watchlist.json           ← watchlist extendida
project_memory.json             ← memoria del proyecto (build history)
build_log.json                  ← log de desarrollo
cordelius_roadmap.json          ← roadmap con progreso
executive_briefing.json         ← último briefing ejecutivo
executive_briefing_history.json ← historial de briefings
decision_journal.json           ← journal de decisiones
decision_patterns.json          ← patrones analizados de decisiones
personal_playbook.json          ← playbook generado desde patterns
jarvis_private_profile.json     ← perfil privado (regulación personal)
jarvis_health_rules.json        ← reglas de salud personalizadas
jarvis_daily_questions.json     ← preguntas diarias de Jarvis
jarvis_risk_rules.json          ← reglas de riesgo personalizadas
jarvis_checkins.json            ← histórico de check-ins Jarvis
jarvis_daily_brief.json         ← brief del día (fuente de verdad de biologicalState)
jarvis_action_plan.json         ← plan de acción (fuente de verdad de tradingPermission)
```

### Memoria in-memory (no persisten entre reinicios)
```
whoopCache      ← datos WHOOP numéricos (extraídos de la API por refreshWhoopCache)
quotes{}        ← precios de mercado (actualizados por refreshQuotes)
news[]          ← noticias recientes (actualizadas por fetchNews)
intelItems[]    ← items Intel (cargados desde cordelius_intel.json al boot)
chatHistory[]   ← historial chat (cargado desde alfredo_chat_history.json)
bot{}           ← estado bot (cargado desde bot_state.json)
```

---

## 6. Security invariants

> ⚠️ Estos invariantes NUNCA deben romperse. `buildSecurityAudit()` los verifica dinámicamente.

```
dashboardProtected:         true   — login wall en GET /
privateReadProtected:       true   — API reads requieren auth
accessKeyConfigured:        true   — CORDE_ACCESS_KEY en .env
protectedMutationEndpoints: ≥ 18  — todo POST que muta estado
unprotectedMutationEndpoints: 0   — cero mutaciones sin auth
```

### Variables de entorno requeridas (sin valores, solo nombres)
```
ANTHROPIC_API_KEY     — Claude AI (Alfredo + Jarvis)
TELEGRAM_BOT_TOKEN    — bot.js Telegram
FINNHUB_API_KEY       — cotizaciones en vivo
USD_MXN               — tipo de cambio manual (default 18.50)
PORT                  — puerto HTTP (default 3000)
CLAUDE_MODEL          — modelo dashboard (default claude-sonnet-4-6)
CLAUDE_MODEL_BOT      — modelo bot.js (default claude-haiku-4-5-20251001)
QUIVER_API_KEY        — Quiver Quant (F3a, pendiente)
TELEGRAM_CHAT_ID      — alertas push (F3b, pendiente)
CORDE_ACCESS_KEY      — login wall dashboard
WHOOP_CLIENT_ID       — OAuth WHOOP
WHOOP_CLIENT_SECRET   — OAuth WHOOP
```
> Todos via `process.env.VAR || "default_seguro"`. Nunca hardcodeados.

### Modelos Claude correctos
```javascript
// dashboard.js
process.env.CLAUDE_MODEL || "claude-sonnet-4-6"

// bot.js
process.env.CLAUDE_MODEL_BOT || "claude-haiku-4-5-20251001"
```
Modelos obsoletos — reemplazar si se encuentran:
- `claude-3-5-haiku-20241022` → `claude-haiku-4-5-20251001`
- `claude-3-5-sonnet-20241022` → `claude-sonnet-4-6`
- `claude-sonnet-4-5` → `claude-sonnet-4-6`
- `claude-haiku-4-5` (sin sufijo de fecha) → `claude-haiku-4-5-20251001`

---

## 7. Flujo de runtime en Termux

### Ciclo de desarrollo seguro
```bash
# 1. Pull de la rama de trabajo (NO main)
git -C ~/corde-bot pull origin jarvis-ui-overhaul

# 2. Backup antes de editar dashboard.js
cp dashboard.js dashboard_backup_$(date +%Y%m%d_%H%M%S).js

# 3. Aplicar patch / editar

# 4. Verificar sintaxis ANTES de reiniciar
node --check dashboard.js

# 5. Reiniciar proceso
pkill -f "node start-with-env.js" 2>/dev/null || true
nohup node start-with-env.js > corde.log 2>&1 &
sleep 4

# 6. Health check
curl -s http://127.0.0.1:3000/health | python3 -m json.tool

# 7. Security audit (verifica invariantes)
curl -s http://127.0.0.1:3000/api/doctor | python3 -m json.tool \
  | grep -E "protected|mutation|configured|invariant"

# 8. HTML smoke check
curl -s http://127.0.0.1:3000/ | grep -c "cordelius\|jarvis\|home"

# 9. Solo si todo pasa: commit
git add dashboard.js
git commit -m "feat/fix: descripción concisa"
git push origin jarvis-ui-overhaul
```

### Procesos en Termux
```bash
# Ver procesos activos
ps aux | grep node

# Ver log en vivo
tail -f ~/corde-bot/corde.log

# Verificar puerto
curl -s http://127.0.0.1:3000/health
```

### Intervalos de refresco (boot)
```
refreshQuotes()        — cotizaciones FinnHub + crypto
refreshWhoopCache()    — WHOOP API (5 min cache: WHOOP_CACHE_MS)
fetchNews()            — noticias
fetchQuiverData()      — Quiver Quant (30 min cache)
savePortfolioPoint()   — snapshot periódico del portafolio
botTick()             — tick del bot ficticio
```

---

## 8. Reglas de trabajo para futuros agentes

### Flujo obligatorio para editar dashboard.js
1. **Backup** → `cp dashboard.js dashboard_backup_$(date +%Y%m%d_%H%M%S).js`
2. **Patch** → editar o aplicar script de patch
3. **Syntax check** → `node --check dashboard.js` — si falla, restaurar backup
4. **Restart** → `pkill` + `nohup node start-with-env.js`
5. **Curl tests** → `/health` + endpoint relevante
6. **Commit** — solo después de confirmación visual del usuario

### Reglas de datos y seguridad
- NUNCA leer `whoop_tokens.json` ni exponer su contenido
- NUNCA commitear `.env`, `whoop_tokens.json`, `data/*.json`, `*.log`, backups
- NUNCA hardcodear API keys — siempre `process.env.VAR || "default"`
- NUNCA crear órdenes reales — todo es simulado/educativo
- No modificar rutas OAuth (`/whoop/auth`, `/whoop/callback`) sin revisión explícita

### Reglas de arquitectura
- Cambios incrementales — no reescribir secciones enteras
- Usar anchors de texto en patch scripts, no números de línea (cambian con cada commit)
- Al leer WHOOP: usar `computeHealthReadiness()` (in-memory), no `loadJSON("whoop_today_cache.json")`
- Estado del día: confiar en `jarvis_daily_brief.json` → `biologicalState` primero, fallback a `jp.operatingMode`
- Trading permission: confiar en `jarvis_action_plan.json` → `tradingPermission` primero

### Reglas de frontend (NO tocar sin permiso explícito)
- `showMod(name)` — navegación entre módulos
- `renderHomePortal(pv, reg)` — home module
- `<meta http-equiv="refresh">` — fue eliminada intencionalmente (Android hash-drop bug)
- Nav HTML, divs de módulos, body/head scripts — congelados

### Patrones de patch script seguros
```javascript
// Verificar que el anchor existe antes de modificar
if (!src.includes(OLD_ANCHOR)) {
  console.error("ERROR: anchor not found");
  process.exit(1);
}
// Verificar que el patch no está ya aplicado
if (src.includes(NEW_MARKER)) {
  console.log("SKIP: ya aplicado");
  process.exit(0);
}
// Backup + apply + node --check + restore on failure
```

---

## 9. Backlog técnico seguro

### Issues abiertos

| ID | Descripción | Estado |
|---|---|---|
| F3a | Quiver Quant live — endpoints congressional/insider/govcontracts | 🔲 PENDIENTE |
| F3b | Alertas push Telegram — TELEGRAM_CHAT_ID + notifyTelegram() | 🔲 PENDIENTE |
| F3c | Portfolio editable runtime — POST /portfolio/update ya existe | 🔲 PARCIAL |
| B1 | NaN en Recovery — fix-brain-patch.js (usa computeHealthReadiness) | 🔲 Aplicar en tablet |
| B2 | State mismatch brain vs daily-brief — fix-brain-patch.js | 🔲 Aplicar en tablet |
| #11 | CODEMAP workflow + knowledge graph evaluation | 🔄 EN PROGRESO |

### Evaluación pendiente (issue #11)
```
Herramientas a evaluar:
  - MCP knowledge graph (ej. memory-server de Anthropic)
  - Graphify / codebase-memory
  - Context7 para docs de librerías
  - CLAUDE.md + CODEMAP.md (enfoque actual — Markdown estático)

Criterios de evaluación:
  - ¿Funciona en Termux sin npm extra?
  - ¿Sobrevive reinicios de contexto?
  - ¿Claude/GPT/Codex pueden consumirlo sin setup?
  - ¿Agrega overhead de mantenimiento?
```

### Deuda técnica observada
- `dashboard.js` ~10k líneas — candidato a split modular a largo plazo (no urgente)
- Backups `.js` en raíz acumulándose — agregar limpieza periódica
- `WHOOP_CACHE_MS` = 5 min — podría ser config via env var

---

## 10. Qué NO tocar

### Funciones congeladas (no modificar sin permiso explícito)
```
showMod(name)              — navegación frontend
renderHomePortal(pv, reg)  — home module
render()                   — generador HTML principal
boot()                     — secuencia de arranque
```

### Rutas congeladas
```
/whoop/auth                — OAuth WHOOP (tokens reales)
/whoop/callback            — OAuth WHOOP (tokens reales)
/api/whoop/callback        — alias OAuth
```

### Archivos congelados en git
```
.env                       — NUNCA en git
whoop_tokens.json          — NUNCA en git, NUNCA leer
data/*.json                — NUNCA en git
*.log                      — NUNCA en git
dashboard_backup_*.js      — NUNCA en git (ya en .gitignore)
```

### Ramas protegidas
```
main                       — NUNCA pushear directamente
                           — Solo via PR revisado
```

### Invariantes que no deben bajar
```
protectedMutationEndpoints: ≥ 18   — nunca eliminar auth de un endpoint POST
unprotectedMutationEndpoints: 0    — cero mutaciones sin auth
dashboardProtected: true            — login wall siempre activo
```

### Branches a no mergear
```
jarvis-private-memory      — UI rota, navegación de módulos rota
                           — Endpoints funcionan pero no mergear
```

---

## Apéndice: comandos de diagnóstico rápido

```bash
# Estado general
curl -s http://127.0.0.1:3000/health | python3 -m json.tool

# Verificar security invariants
curl -s http://127.0.0.1:3000/api/doctor | python3 -m json.tool

# Brain endpoint (post-patch)
curl -s http://127.0.0.1:3000/api/jarvis/brain | python3 -m json.tool | head -30

# Verificar funciones clave en dashboard.js
grep -n "buildSecurityAudit\|computeJarvisBrain\|buildTodayFeed\|getAutomationState" dashboard.js

# Verificar modelos Claude (no deben ser obsoletos)
grep -n "claude-3-5\|claude-sonnet-4-5\b\|claude-haiku-4-5\b" dashboard.js bot.js

# Contar endpoints mutateProtected
grep -c "method.*POST" dashboard.js

# Ver rama actual y último commit
git log --oneline -3
```

---

*CODEMAP.md v1 — borrador estructural basado en arquitectura conocida.*
*Partes marcadas 🔲 requieren verificación en `dashboard.js` del tablet (commit `b0cffa7`).*
*Actualizar después de cada Mega-feature o cambio arquitectural significativo.*
