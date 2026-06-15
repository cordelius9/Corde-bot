# SAFE_SCRIPTS_SPEC.md — Especificación de Scripts Seguros de Cordelius

> Solo especificación — los scripts NO existen todavía. No implementar sin revisión.
> Branch: `jarvis-ui-overhaul` | Referencias: TABLET_SERVER_RUNBOOK.md, REMOTE_CONTROL_PLAN.md

---

## Principios generales

- Todos los scripts van en `scripts/` dentro del repo.
- Ninguno acepta argumentos de usuario (sin interpolación de input externo).
- Ninguno hace `eval`, `bash -c <variable>`, ni pipe a shell libre.
- Ninguno imprime contenido de `.env`, tokens, ni `data/*.json`.
- Todos tienen timeout implícito de 30 segundos.
- Todos reportan éxito o error con código de salida claro (`exit 0` / `exit 1`).
- El restart siempre verifica `/healthz` después — nunca confirma éxito sin verificar.
- Nunca iniciar un segundo proceso si el puerto 3000 ya está ocupado.

---

## 1. `cordelius-start`

**Objetivo:** Arrancar el servidor Cordelius si no está corriendo.

**Comando aproximado:**
```bash
#!/bin/bash
# Verificar que no haya proceso en el puerto 3000
if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "INFO: servidor ya está corriendo en puerto 3000. No se inicia segundo proceso."
  exit 0
fi

cd ~/corde-bot
node --check dashboard.js || { echo "ERROR: dashboard.js no pasa node --check"; exit 1; }

nohup node start-with-env.js > corde.log 2>&1 &
sleep 4

if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "OK: servidor arrancó correctamente"
  exit 0
else
  echo "ERROR: servidor no responde en /healthz después del arranque"
  exit 1
fi
```

**Riesgos:**
- Si se ejecuta dos veces, podría arrancar un segundo proceso. La verificación previa con `/healthz` evita esto.
- Si `node --check` pasa pero el código tiene errores de runtime, el servidor arranca y muere. Los logs capturan esto.

**Validaciones:**
1. ¿Puerto 3000 libre? Si no → salir sin iniciar.
2. ¿`node --check dashboard.js` pasa? Si no → salir con error.
3. ¿`/healthz` responde tras 4 segundos? Si no → reportar error.

**Output esperado:**
```
OK: servidor arrancó correctamente
```
o
```
INFO: servidor ya está corriendo en puerto 3000. No se inicia segundo proceso.
```

**Qué nunca debe imprimir:**
- Contenido de `.env`
- Tokens o API keys (de los logs de arranque)
- Stack traces completos (solo mensaje de error)
- Rutas absolutas de archivos sensibles

**Archivos que nunca debe tocar:**
`.env`, `whoop_tokens.json`, `data/*.json`, `.claude/`

---

## 2. `cordelius-stop`

**Objetivo:** Detener el servidor de forma limpia.

**Comando aproximado:**
```bash
#!/bin/bash
if ! curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "INFO: servidor no estaba corriendo"
  exit 0
fi

pkill -f "node start-with-env.js"
sleep 2

if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "ERROR: el proceso no se detuvo — verificar manualmente"
  exit 1
else
  echo "OK: servidor detenido"
  exit 0
fi
```

**Riesgos:**
- `pkill -f` puede matar otros procesos que coincidan con el patrón. El patrón `"node start-with-env.js"` es suficientemente específico para este proyecto.
- Si hay múltiples procesos node, los mata a todos. Es el comportamiento deseado para evitar servidores huérfanos.

**Validaciones:**
1. Verificar que el servidor estaba corriendo antes de intentar parar.
2. Verificar con `/healthz` que el proceso terminó.

**Output esperado:**
```
OK: servidor detenido
```

**Qué nunca debe imprimir:** ídem §1.

**Archivos que nunca debe tocar:** ídem §1.

---

## 3. `cordelius-restart`

**Objetivo:** Reiniciar el servidor de forma segura, evitando doble proceso.

**Comando aproximado:**
```bash
#!/bin/bash
# Preferido: usar tmux si la sesión "cordelius" existe
if tmux has-session -t cordelius 2>/dev/null; then
  tmux send-keys -t cordelius "pkill -f 'node start-with-env.js'; sleep 2; nohup node start-with-env.js > corde.log 2>&1 &" Enter
  sleep 6
else
  # Fallback: directo sin tmux
  pkill -f "node start-with-env.js" 2>/dev/null || true
  sleep 2
  cd ~/corde-bot
  node --check dashboard.js || { echo "ERROR: node --check falló — restart abortado"; exit 1; }
  nohup node start-with-env.js > corde.log 2>&1 &
  sleep 4
fi

# Verificar resultado — nunca confirmar éxito sin verificar
if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "OK: servidor reiniciado y respondiendo en /healthz"
  exit 0
else
  echo "ERROR: servidor no responde en /healthz después del restart"
  exit 1
fi
```

**Riesgos:**
- tmux `send-keys` puede fallar si la sesión está en un estado inesperado. El fallback directo cubre este caso.
- Si el código tiene error de sintaxis post-pull, `node --check` lo captura antes de arrancar.
- Ventana de downtime de ~4-6 segundos durante el restart.

**Validaciones:**
1. `node --check dashboard.js` (en el path de fallback directo).
2. `/healthz` post-restart.
3. Nunca iniciar si `/healthz` ya responde (no necesita restart).

**Output esperado:**
```
OK: servidor reiniciado y respondiendo en /healthz
```
o
```
ERROR: servidor no responde en /healthz después del restart
```

**Qué nunca debe imprimir:** ídem §1. En particular, no imprimir la salida completa de corde.log.

**Archivos que nunca debe tocar:** ídem §1.

---

## 4. `cordelius-check`

**Objetivo:** Verificar estado completo del servidor: proceso, health y security audit.

**Comando aproximado:**
```bash
#!/bin/bash
ERRORS=0

# 1. ¿Proceso corriendo?
if ps aux | grep -q "[n]ode start-with-env.js"; then
  echo "✓ Proceso: corriendo"
else
  echo "✗ Proceso: no encontrado"
  ERRORS=$((ERRORS + 1))
fi

# 2. /healthz
if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "✓ /healthz: OK"
else
  echo "✗ /healthz: no responde"
  ERRORS=$((ERRORS + 1))
fi

# 3. Security audit — verificar invariantes clave
AUDIT=$(curl -sf http://127.0.0.1:3000/api/security/audit 2>/dev/null)
if [ -z "$AUDIT" ]; then
  echo "✗ /api/security/audit: no responde"
  ERRORS=$((ERRORS + 1))
else
  UNPROTECTED=$(echo "$AUDIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totals',{}).get('unprotectedMutationEndpoints',999))" 2>/dev/null)
  DASHBOARD=$(echo "$AUDIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('dashboardProtected','false'))" 2>/dev/null)

  if [ "$UNPROTECTED" = "0" ]; then
    echo "✓ unprotectedMutationEndpoints: 0"
  else
    echo "✗ unprotectedMutationEndpoints: $UNPROTECTED — REVISAR"
    ERRORS=$((ERRORS + 1))
  fi

  if [ "$DASHBOARD" = "True" ] || [ "$DASHBOARD" = "true" ]; then
    echo "✓ dashboardProtected: true"
  else
    echo "✗ dashboardProtected: $DASHBOARD — REVISAR"
    ERRORS=$((ERRORS + 1))
  fi
fi

# 4. Tailscale
if tailscale status > /dev/null 2>&1; then
  echo "✓ Tailscale: activo"
else
  echo "⚠ Tailscale: no disponible o no instalado"
fi

echo "---"
if [ "$ERRORS" -eq 0 ]; then
  echo "OK: servidor sano"
  exit 0
else
  echo "ERRORES: $ERRORS problema(s) encontrado(s)"
  exit 1
fi
```

**Riesgos:**
- Si `python3` no está disponible, el parsing de JSON falla. El script debe manejarlo con fallback.
- `audit.totals.unprotectedMutationEndpoints` debe usar el path correcto (no `audit.unprotectedMutationEndpoints`).

**Validaciones:** `/healthz`, `audit.totals.unprotectedMutationEndpoints === 0`, `dashboardProtected === true`.

**Output esperado:**
```
✓ Proceso: corriendo
✓ /healthz: OK
✓ unprotectedMutationEndpoints: 0
✓ dashboardProtected: true
✓ Tailscale: activo
---
OK: servidor sano
```

**Qué nunca debe imprimir:**
- Contenido de `.env`, tokens, API keys
- Stack traces de dashboard.js
- Rutas internas del sistema
- Respuesta completa del audit (solo los campos relevantes)

**Archivos que nunca debe tocar:** ídem §1.

---

## 5. `cordelius-safe-cycle`

**Objetivo:** Ciclo completo seguro: pull → check sintaxis → restart → verify. Para usar después de un `git pull`.

**Comando aproximado:**
```bash
#!/bin/bash
cd ~/corde-bot

echo "1/4: git pull..."
git pull origin jarvis-ui-overhaul --ff-only || { echo "ERROR: git pull falló"; exit 1; }

echo "2/4: node --check..."
node --check dashboard.js || { echo "ERROR: node --check falló — abortando restart"; exit 1; }

echo "3/4: restart..."
bash scripts/cordelius-restart || { echo "ERROR: restart falló"; exit 1; }

echo "4/4: check completo..."
bash scripts/cordelius-check

echo "---"
echo "Ciclo seguro completado."
```

**Riesgos:**
- Si el pull trae código roto, `node --check` lo detecta y el restart no ocurre.
- `--ff-only` evita merges accidentales: solo avanza si es fast-forward.
- Si el restart falla, el servidor puede quedar abajo. Los logs capturan la causa.

**Validaciones:**
1. `git pull --ff-only` exitoso.
2. `node --check dashboard.js` exitoso.
3. `cordelius-restart` exitoso (`/healthz` responde).
4. `cordelius-check` pasa todos los puntos.

**Output esperado:**
```
1/4: git pull...
Already up to date.
2/4: node --check...
3/4: restart...
OK: servidor reiniciado y respondiendo en /healthz
4/4: check completo...
✓ Proceso: corriendo
✓ /healthz: OK
✓ unprotectedMutationEndpoints: 0
✓ dashboardProtected: true
✓ Tailscale: activo
---
OK: servidor sano
---
Ciclo seguro completado.
```

**Qué nunca debe imprimir:** ídem §1.

**Archivos que nunca debe tocar:** ídem §1.

---

## 6. `cordelius-cloudflare`

**Objetivo:** Iniciar Cloudflare Quick Tunnel de forma temporal y controlada. Solo para debug o acceso desde red desconocida.

**Comando aproximado:**
```bash
#!/bin/bash
# Verificar que el security audit pasa antes de exponer a internet
AUDIT=$(curl -sf http://127.0.0.1:3000/api/security/audit 2>/dev/null)
DASHBOARD=$(echo "$AUDIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('dashboardProtected','false'))" 2>/dev/null)

if [ "$DASHBOARD" != "True" ] && [ "$DASHBOARD" != "true" ]; then
  echo "ERROR: dashboardProtected no es true — NO se expone Cloudflare"
  exit 1
fi

echo "⚠ Iniciando Cloudflare Quick Tunnel — TEMPORAL"
echo "⚠ Apagar con Ctrl+C cuando termines"
echo "⚠ El tunnel deja de ser válido al cerrar este proceso"
echo "---"

cloudflared tunnel --url http://localhost:3000
# El proceso bloquea hasta Ctrl+C
# La URL pública aparece en stdout de cloudflared
```

**Riesgos:**
- Expone el dashboard a internet público mientras está activo.
- Si el login wall falla, cualquiera puede acceder.
- El script verifica `dashboardProtected: true` antes de iniciar.

**Validaciones:**
1. `dashboardProtected: true` antes de iniciar.
2. Informar claramente que es temporal.
3. No almacenar la URL del tunnel en ningún archivo.

**Output esperado:**
```
⚠ Iniciando Cloudflare Quick Tunnel — TEMPORAL
⚠ Apagar con Ctrl+C cuando termines
⚠ El tunnel deja de ser válido al cerrar este proceso
---
[salida de cloudflared con la URL pública]
```

**Qué nunca debe imprimir:** tokens de autenticación de Cloudflare, CORDELIUS_ACCESS_KEY, contenido de `.env`.

**Archivos que nunca debe tocar:** ídem §1.

---

## 7. `cordelius-watchdog`

**Objetivo:** Proceso en segundo plano que verifica periódicamente que el servidor está vivo y lo reinicia si no responde. Solo para cuando la tablet corre desatendida por horas.

**Comando aproximado:**
```bash
#!/bin/bash
# Ejecutar dentro de tmux en una ventana separada
# tmux new-window -t cordelius: -n "watchdog"

INTERVAL=60  # verificar cada 60 segundos
FAILURES=0
MAX_FAILURES=2  # reiniciar después de 2 fallos consecutivos

echo "Watchdog iniciado. Verificando cada ${INTERVAL}s..."

while true; do
  if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
    FAILURES=0
    # silencioso en éxito — no spamear el log
  else
    FAILURES=$((FAILURES + 1))
    echo "[$(date)] WARN: /healthz no responde (fallo $FAILURES/$MAX_FAILURES)"

    if [ "$FAILURES" -ge "$MAX_FAILURES" ]; then
      echo "[$(date)] Reiniciando servidor..."
      bash scripts/cordelius-restart
      FAILURES=0
    fi
  fi
  sleep $INTERVAL
done
```

**Riesgos:**
- Si el servidor está en un crash loop, el watchdog puede reiniciarlo infinitamente.
  Mitigación: limitar a MAX_FAILURES=2 y agregar backoff (pendiente).
- El watchdog no debe reemplazar el monitoreo manual — es solo un safety net.
- Si `cordelius-restart` también falla, el watchdog loguea el error y espera el siguiente ciclo.

**Validaciones:**
1. Solo verifica `/healthz` — no el audit completo (demasiado frecuente).
2. Espera 2 fallos consecutivos antes de reiniciar (evita reiniciar por hiccup momentáneo).
3. Loguea cada acción con timestamp.

**Output esperado (en log de watchdog):**
```
Watchdog iniciado. Verificando cada 60s...
[2026-06-15 08:30:00] WARN: /healthz no responde (fallo 1/2)
[2026-06-15 08:31:00] WARN: /healthz no responde (fallo 2/2)
[2026-06-15 08:31:00] Reiniciando servidor...
OK: servidor reiniciado y respondiendo en /healthz
```

**Qué nunca debe imprimir:** ídem §1.

**Archivos que nunca debe tocar:** ídem §1. El watchdog solo ejecuta `cordelius-restart` — no toca código ni datos.

---

## Resumen de scripts

| Script | Propósito | Invocado por | Riesgo |
|---|---|---|---|
| `cordelius-start` | Arrancar si no está corriendo | Manual / bot Telegram `/restart` | Bajo |
| `cordelius-stop` | Detener limpiamente | Manual / kill switch | Bajo |
| `cordelius-restart` | Reiniciar con verificación | Manual / bot / watchdog | Medio |
| `cordelius-check` | Diagnóstico completo | Manual / bot `/check` | Ninguno |
| `cordelius-safe-cycle` | Pull + check + restart | Manual post-deploy | Medio |
| `cordelius-cloudflare` | Tunnel temporal | Manual únicamente | Alto (expone a internet) |
| `cordelius-watchdog` | Auto-restart si cae | tmux ventana separada | Medio |

---

## Antes de crear los scripts reales

- [ ] Pedro revisa esta spec y la aprueba
- [ ] Verificar que `cloudflared` está instalado en Termux (`which cloudflared`)
- [ ] Verificar que `tmux` está instalado (`which tmux`)
- [ ] Verificar que `python3` está disponible para parsing de JSON
- [ ] Probar `cordelius-check` manualmente antes de activar el watchdog
- [ ] Probar `cordelius-restart` una vez antes de usarlo desde Telegram

---

*SAFE_SCRIPTS_SPEC.md | 2026-06-15 | Especificación únicamente — no implementar sin revisión y aprobación*
