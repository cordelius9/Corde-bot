# TRADING_AUTOPILOT_PLAN.md — Plan de Automatización de Trading

> Documentación de diseño. No implementar hasta aprobación explícita por fase.
> Branch: `jarvis-ui-overhaul` | Referencia: CODEMAP.md, PAPER_TRADING_SPEC.md

---

## 1. Visión general

Cordelius evoluciona de dashboard de monitoreo a sistema de trading asistido,
en fases incrementales con revisión manual en cada transición.

**Principio fundamental:** cada fase debe demostrar estabilidad antes de avanzar a la siguiente.
No hay fechas fijas. El avance lo decide Pedro basado en métricas reales.

```
Fase 1 → Fase 2 → Fase 3 → Fase 4 → Fase 5
scan     paper    Telegram  real-min  real-full
(actual) (design) (design)  (futuro)  (futuro)
         ↑
    Próximo paso
```

---

## 2. Fase 1 — Market Scanner + Señales (ACTUAL)

**Estado:** Activo. Base para todas las fases siguientes.

**Qué hace:**
- `computeDailyScan()` analiza el portafolio y genera scores por activo.
- `computeExternalMarketIntelligence()` analiza tickers externos.
- `computeIntelligence()` consolida señales de portfolio + Quiver + noticias.
- `alfredoAction(a)` genera recomendación por activo: MANTENER / BUY DIP / VIGILAR / etc.
- `computeJarvisBrain()` fusiona contexto: salud + portfolio + oportunidades.

**Lo que NO hace en Fase 1:**
- No ejecuta ninguna acción de trading, ni simulada ni real.
- No guarda en ledger.
- No envía Telegram automático con señales (solo responde a `/daily`, `/action`).

**Salida de Fase 1:** señales visibles en dashboard + Telegram bajo pedido.

---

## 3. Fase 2 — Paper Trading Automático (PRÓXIMO PASO)

**Estado:** En diseño. Ver `PAPER_TRADING_SPEC.md` para spec completa.

**Qué agrega:**
- Engine que evalúa señales de Fase 1 contra condiciones de bloqueo.
- Si todo pasa, genera un paper trade y lo guarda en `data/paper_ledger.json`.
- Máximo 1 paper trade al día, máximo 2% del portafolio simulado.
- Evaluación automática de outcome a 24h y 7d.
- Endpoints: `GET /api/paper/status`, `GET /api/paper/ledger`.
- Telegram: `/paper-status`, `/paper-pause`, `/paper-resume`.

**Condiciones de bloqueo** (resumen — ver PAPER_TRADING_SPEC.md §6):
```
security audit con fallos → NO
precio no fresco → NO
Jarvis DEFENSIVO → NO
tradingPermission = NO_TRADING → NO
recovery < 45% → NO
activo fuera de whitelist → NO
ya hay un trade abierto hoy → NO
confianza < 65 → NO
```

**Criterios para avanzar a Fase 3:**
```
≥ 30 paper trades ejecutados
win rate ≥ 55%
expected value > 0
≥ 60 días de operación sin crashes
0 señales alucinadas en revisión manual
kill switch probado
Pedro aprueba explícitamente
```

---

## 4. Fase 3 — Telegram Approvals (FUTURO)

**Estado:** Diseño conceptual. No implementar hasta completar Fase 2.

**Qué agrega:**
- Antes de ejecutar un paper trade, el sistema envía a Telegram:
  ```
  📊 Señal detectada: BUY BTC
  Precio: $67,420 | Confianza: 78/100 | Modo: ÓPTIMO
  Recovery: 82% | Razón: RSI oversold + congressional buy
  
  ¿Aprobar paper trade? → [✅ Sí] [❌ No] [⏸ Pausar engine]
  ```
- Pedro aprueba o rechaza en ≤ 15 minutos.
- Si no hay respuesta, el trade se cancela (nunca se ejecuta solo en Fase 3).
- Cada rechazo manual se registra con razón (para aprendizaje).

**Objetivo de Fase 3:** calibrar intuición de Pedro vs señales del sistema.
Si Pedro rechaza correctamente señales malas → el sistema aprende qué ajustar.

**Criterios para avanzar a Fase 4:**
```
Pedro aprueba ≥ 80% de las señales generadas (señales de calidad)
Pedro nunca tuvo que usar kill switch por error del sistema
Win rate en trades aprobados ≥ 60%
Pedro decide explícitamente avanzar
```

---

## 5. Fase 4 — Real Trading Mínimo con Aprobación Manual (FUTURO)

**Estado:** Concepto. Meses/años en el futuro. No diseñar en detalle hasta Fase 3 completa.

**Principios:**
- Solo activos de la whitelist, mismos límites de Fase 2 pero con dinero real.
- **Cada trade requiere aprobación manual de Pedro vía Telegram.**
- El sistema propone, Pedro decide. Nunca al revés.
- API keys de broker: sin permisos de retiro, solo trading, guardadas en `.env`, nunca en GitHub.
- Límite máximo inicial: 1% del portafolio real por trade.
- Si el broker no ofrece API sin permisos de retiro: no se usa.

**Lo que NO hace Fase 4:**
- No ejecuta trades automáticamente sin aprobación.
- No usa leverage.
- No opera fuera de horario de mercado sin confirmación.
- No opera si modo DEFENSIVO está activo.

---

## 6. Fase 5 — Real Trading con Límites Duros (FUTURO LEJANO)

**Estado:** Concepto a muy largo plazo. No implementar sin haber completado Fase 4 con éxito.

**Condiciones mínimas para siquiera planear Fase 5:**
```
≥ 6 meses de Fase 4 con resultados positivos documentados
win rate real ≥ 60% en ≥ 50 trades
ningún error de sistema que causara pérdida no autorizada
Pedro entiende completamente cada pieza del sistema
revisión de seguridad independiente del código de trading
```

**Límites duros permanentes (nunca negociables):**
```
máximo 3% del portafolio real por trade
máximo 2 trades reales por semana
nada de leverage en ninguna circunstancia
nada de memecoins
kill switch siempre disponible
modo DEFENSIVO siempre prioridad absoluta
```

---

## 7. Kill Switch

El kill switch detiene **toda actividad de trading** (paper y real) inmediatamente.

### Niveles del kill switch

```
Nivel 1 — Paper pause:
  Telegram: /paper-pause
  API: POST /api/paper/pause
  Efecto: pausa engine de paper trading, no cierra trades abiertos

Nivel 2 — Modo DEFENSIVO:
  Telegram: /check → si ve señal de riesgo
  API: POST /api/mode/defensive
  Dashboard: panel Home muestra DEFENSIVO en rojo
  Efecto: bloquea toda señal nueva, cierra todos los paper trades abiertos

Nivel 3 — Apagado total:
  Telegram: /restart (reinicia sin trading habilitado si DEFENSIVO está activo)
  Tablet: pkill -f "node start-with-env.js"
  Efecto: apaga todo el sistema

Nivel 4 — Desconexión de red:
  Tailscale: desconectar tablet de Tailnet
  Efecto: dashboard inaccesible remotamente (máxima seguridad)
```

### Activación automática del kill switch (modo DEFENSIVO)

El sistema debe activar DEFENSIVO automáticamente si:

```
security audit falla (audit.totals.unprotectedMutationEndpoints > 0)
recovery < 35% durante más de 2 horas
3 paper trades perdedores consecutivos en la misma semana
error del sistema que no puede resolverse en 5 minutos
```

---

## 8. Modo NO_TRADING

`tradingPermission = "NO_TRADING"` en `data/jarvis_action_plan.json` bloquea
**absolutamente toda actividad de trading** en todos los niveles.

Condiciones que activan NO_TRADING:
```
Jarvis mode = DEFENSIVO (recovery < 40%, sleep < 55%)
Jarvis mode = DESCANSO
security audit con fallos
kill switch activado manualmente
```

En modo NO_TRADING:
- No se generan señales de paper trading.
- Los trades paper abiertos se cierran al precio actual.
- El dashboard muestra banner visible: `🔴 NO TRADING — Modo DEFENSIVO activo`.
- Telegram responde a `/paper-status` con `NO_TRADING activo`.

---

## 9. Relación con Jarvis Brain

`computeJarvisBrain()` es la fuente de contexto fusionado para toda decisión de trading.

```
computeJarvisBrain()
  ├─ jarvisMode          → si DEFENSIVO/DESCANSO → NO_TRADING
  ├─ tradingPermission   → si NO_TRADING → bloquear
  ├─ healthState.recovery→ si < 45 → bloquear señales
  ├─ portfolioValue      → para calcular 2% máximo por trade
  └─ topOpportunity      → activo candidato para la señal del día
```

El paper trading engine **nunca** decide por su cuenta qué activo comprar.
Siempre parte de la señal de `computeJarvisBrain().topOpportunity`.

---

## 10. Relación con Health / WHOOP

La salud de Pedro es una entrada directa al sistema de trading.

```
computeHealthReadiness() → {recovery, sleep, strain, hrv}

recovery >= 75  → ÓPTIMO   → señales permitidas, confianza +10 pts
recovery 60-74  → MODERADO → señales permitidas con restricciones
recovery 45-59  → REGULACIÓN → señales solo de alta confianza (>80)
recovery < 45   → DEFENSIVO/DESCANSO → NO_TRADING obligatorio
```

**Rationale:** si Pedro no está en condiciones de revisar una decisión,
el sistema no debe generar señales que requieran su atención.

El sistema **nunca opera en auto si Pedro está en DESCANSO.**

---

## 11. Relación con Security Audit

`buildSecurityAudit()` es la primera verificación antes de cualquier señal.

```
Si buildSecurityAudit() retorna:
  audit.totals.unprotectedMutationEndpoints > 0  → BLOQUEAR TODO
  dashboardProtected = false        → BLOQUEAR TODO
  accessKeyConfigured = false       → BLOQUEAR TODO
  privateReadProtected = false      → BLOQUEAR TODO
```

Un sistema con invariantes de seguridad rotos **no puede operar**, aunque sea paper.
Esto es no negociable.

---

## 12. Reglas de riesgo permanentes

Estas reglas aplican en todas las fases, sin excepción:

```
✗  Nada de órdenes a brokers reales en Fase 1, 2 o 3
✗  Nada de leverage en ninguna fase
✗  Nada de memecoins en ninguna fase
✗  Nada de activos fuera de whitelist sin aprobación explícita de Pedro
✗  Nada de trading si security audit falla
✗  Nada de trading si DEFENSIVO o NO_TRADING activo
✗  API keys en .env únicamente — nunca en código, nunca en GitHub
✗  API keys deben ser sin permisos de retiro (cuando existan en Fase 4+)
✗  Nada de señales basadas en output de AI sin verificación numérica
✗  Nada de trading automático sin aprobación manual hasta Fase 5
✗  Nada de trading real hasta ≥ 30 paper trades con resultados positivos
```

---

## 13. API keys futuras — política de seguridad

Para Fases 4 y 5, cuando se necesiten API keys de broker:

```
Permisos mínimos: solo trading (sin retiro, sin transferencia)
Almacenamiento: .env en tablet, nunca en GitHub
Rotación: cada 90 días o inmediatamente si se sospecha compromiso
Variables de entorno:
  BROKER_API_KEY      (sin valor en código)
  BROKER_API_SECRET   (sin valor en código)
  BROKER_NAME         (nombre del broker)
Acceso: solo desde Termux en la tablet
Auditoría: toda llamada al broker se loguea en data/broker_audit.json
```

El código que llame a la API del broker debe ser:
- Revisado por Pedro línea a línea antes de activar.
- Probado en modo sandbox del broker antes de ir a producción.
- Auditado para confirmar que no hay path de retiro.

---

## 14. Resumen de avance por fase

| Fase | Descripción | Estado | Condición para avanzar |
|---|---|---|---|
| 1 | Market scanner + señales | ✅ Activo | — |
| 2 | Paper trading automático | 📐 En diseño | Pedro aprueba spec + 60 días de Fase 1 estable |
| 3 | Telegram approvals | 📋 Concepto | ≥30 paper trades, win rate ≥55%, Pedro aprueba |
| 4 | Real trading mínimo manual | 📋 Concepto | Fase 3 ≥80% aprobaciones correctas, Pedro decide |
| 5 | Real trading con límites duros | 📋 Concepto lejano | ≥6 meses Fase 4, revisión de seguridad independiente |

---

*TRADING_AUTOPILOT_PLAN.md | 2026-06-15 | Solo documentación — no implementar sin revisión por fase*
