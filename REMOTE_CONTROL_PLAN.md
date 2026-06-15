# REMOTE_CONTROL_PLAN.md — Cordelius Remote Control Architecture

> Documentación de diseño. No implementar hasta aprobación explícita.
> Branch: `jarvis-ui-overhaul` | Referencia: CODEMAP.md

---

## 1. Objetivo

Permitir que Pedro controle Cordelius desde iPhone/iPad de forma segura,
sin exponer shell libre, sin comandos peligrosos y sin depender de Cloudflare.

Todo control remoto es **solo de lectura o de ciclo de vida seguro**.
Ningún comando puede crear órdenes reales, exponer secretos o ejecutar código arbitrario.

---

## 2. Arquitectura

```
iPhone/iPad
  ├─ Telegram → bot.js → comandos whitelisted → Cordelius Agent
  └─ Web privada (Tailscale URL) → dashboard.js (autenticado)

Galaxy Tab S6 / Termux
  └─ Cordelius Agent
        ├─ bot.js         — Telegram handler (comandos seguros)
        ├─ dashboard.js   — Web dashboard (puerto 3000)
        └─ scripts/       — whitelist de scripts aprobados

Acceso de red:
  Principal:  Tailscale VPN → 100.x.x.x:3000 (autenticado, cifrado)
  Opcional:   Cloudflare Tunnel → dominio público (solo temporal/debug)
  Prohibido:  puerto 3000 expuesto directo a internet sin auth
```

### Capas de seguridad

```
Capa 1: Red        — Tailscale (solo dispositivos autorizados)
Capa 2: Auth       — CORDELIUS_ACCESS_KEY (cookie + header X-Cordelius-Key)
Capa 3: Comandos   — whitelist estricta, sin /run ni shell libre
Capa 4: Audit      — buildSecurityAudit() verifica invariantes antes de ejecutar
```

---

## 3. Comandos permitidos (whitelist)

Todos los comandos remotos pasan por validación con `CORDELIUS_ACCESS_KEY` antes de ejecutarse.

| Comando | Acción | Tipo | Riesgo |
|---|---|---|---|
| `/status` | Llama `GET /api/status` + brain summary | read | ninguno |
| `/check` | Llama `GET /api/security/audit` + health | read | ninguno |
| `/paper-status` | Llama `GET /api/paper/status` | read | ninguno |
| `/logs` | Últimas 30 líneas de `corde.log` (no más) | read | bajo |
| `/restart` | Ejecuta `scripts/cordelius-restart.sh` (tmux kill-session + tmux new) + verifica `/healthz` | lifecycle | medio |
| `/pull` | `git pull origin jarvis-ui-overhaul --ff-only` | lifecycle | medio |
| `/cloudflare` | Muestra estado del tunnel (no lo enciende sin confirmar) | read | bajo |
| `/paper-pause` | `POST /api/paper/pause` (pausa engine) | mutate | bajo |
| `/paper-resume` | `POST /api/paper/resume` (reanuda engine) | mutate | bajo |

### Flujo de validación de comando

```
Telegram mensaje → bot.js
  └─ ¿es comando de la whitelist? → NO → rechazar, responder "comando no permitido"
  └─ SÍ → validar CORDELIUS_ACCESS_KEY del usuario
       └─ falla → responder "no autorizado"
       └─ ok → ejecutar acción específica del handler
                └─ loguear en corde.log: timestamp + comando + resultado
```

---

## 4. Comandos prohibidos

```
/run          — shell libre: PROHIBIDO
/exec         — ejecución arbitraria: PROHIBIDO
/eval         — eval de código: PROHIBIDO
/rm           — eliminar archivos: PROHIBIDO
/git push     — push desde remoto: PROHIBIDO
/npm          — instalación de paquetes: PROHIBIDO
/curl <url>   — fetch arbitrario: PROHIBIDO
```

El agente **nunca** debe exponer un endpoint `POST /run`, `POST /exec` ni ninguna
variante que permita ejecutar código o comandos no previstos en la whitelist.

---

## 5. Whitelist de scripts permitidos

Solo los siguientes scripts pueden ser invocados por comandos remotos.
Todos deben existir físicamente en el repo y ser revisados antes de habilitar.

```
scripts/cordelius-restart.sh  — restart seguro (ver §5a para lógica completa)
scripts/pull.sh          — git pull --ff-only (nunca merge, nunca force)
scripts/status.sh        — curl /api/status + /api/security/audit
scripts/logs.sh          — tail -n 30 corde.log (solo lectura, máximo 30 líneas)
scripts/cloudflare.sh    — cloudflared tunnel info (solo lectura)
```

### §5a — Lógica de `cordelius-restart.sh`

```bash
#!/bin/bash
# scripts/cordelius-restart.sh — restart seguro de Cordelius
# No acepta argumentos. No expone shell. Timeout: 30s.

# Detener sesión tmux existente (si hay)
tmux kill-session -t cordelius 2>/dev/null || true
sleep 2

# Guardia: verificar que el proceso viejo realmente terminó.
# Si /healthz sigue respondiendo, el proceso quedó huérfano fuera de tmux —
# arrancar un segundo proceso sería incorrecto y peligroso.
if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "ERROR: old server still running outside tmux; manual cleanup required"
  echo "Diagnóstico: ps aux | grep 'node dashboard.js' | grep -v grep"
  echo "Intervención manual (no default): pkill -f 'node dashboard.js'"
  exit 1
fi

# Puerto libre — arrancar en nueva sesión tmux con env cargado
TERMUX_HOME=/data/data/com.termux/files/home
tmux new -d -s cordelius "cd ${TERMUX_HOME}/corde-bot && set -a && . ./.env && set +a && APP_DIR=\"\$(pwd)\" node dashboard.js"

# Verificar arranque — nunca confirmar éxito sin verificar
sleep 4
if curl -sf http://127.0.0.1:3000/healthz > /dev/null 2>&1; then
  echo "OK: Cordelius arrancó correctamente"
else
  echo "ERROR: /healthz no responde tras restart"
  exit 1
fi
```

> ⚠️ El script **nunca** arranca un segundo proceso si el puerto 3000 sigue ocupado.
> Si `tmux kill-session` no bastó (proceso huérfano fuera de tmux), el script aborta
> con error y sugiere diagnóstico manual — no fuerza un arranque ciego.
> Siempre verifica `/healthz` después del restart. Si falla, el comando `/restart`
> responde en Telegram con error — no confirma éxito silenciosamente.

Reglas de los scripts:
- Ninguno acepta argumentos del usuario.
- Ninguno hace `eval`, interpolación de variables externas ni pipe a bash.
- Todos tienen timeout máximo de 30 segundos.
- Si el script falla, responde con código de error, no con stack trace.

---

## 6. Validación con CORDELIUS_ACCESS_KEY

```javascript
// Pseudocódigo — no implementar directo, revisar con Pedro
function isAuthorizedTelegramUser(telegramUserId) {
  const allowed = (process.env.TELEGRAM_ALLOWED_IDS || "").split(",");
  return allowed.includes(String(telegramUserId));
}

function validateCommandAuth(ctx) {
  if (!isAuthorizedTelegramUser(ctx.from.id)) {
    ctx.reply("⛔ No autorizado.");
    return false;
  }
  return true;
}
```

- `TELEGRAM_ALLOWED_IDS` — lista de IDs de Telegram permitidos, en `.env`, nunca en código.
- `CORDELIUS_ACCESS_KEY` — usada en el dashboard web, no en Telegram directamente.
- Los IDs de Telegram y la access key son independientes: ambas capas activas al mismo tiempo.

---

## 7. Tailscale — acceso principal

```
Configuración objetivo:
  - Cordelius en Galaxy Tab S6 con Tailscale instalado
  - iPhone/iPad de Pedro en la misma Tailnet
  - URL de acceso: http://100.x.x.x:3000  (IP Tailscale de la tablet)
  - Auth: CORDELIUS_ACCESS_KEY (login wall en dashboard)

Ventajas:
  - Sin exposición a internet público
  - Sin necesidad de Cloudflare para uso diario
  - Latencia baja (LAN virtual)
  - No requiere dominio ni certificado
```

### Pasos de setup (no automatizados — manual)

```bash
# En tablet (Termux):
pkg install tailscale
tailscale up

# En iPhone/iPad:
# Instalar Tailscale → unirse a la misma cuenta
# Abrir http://100.x.x.x:3000 en Safari

# Verificar conectividad:
# curl http://100.x.x.x:3000/health
```

---

## 8. Cloudflare — solo opcional / temporal

Cloudflare Tunnel expone el dashboard a internet público. Usar solo para:
- demos puntuales
- debug desde red desconocida
- acceso cuando Tailscale no está disponible

**Nunca dejar Cloudflare activo de forma permanente sin confirmar que el login wall funciona.**

```bash
# Verificar antes de activar Cloudflare:
curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool
# Debe mostrar: dashboardProtected: true, accessKeyConfigured: true

# Apagar Cloudflare cuando no se necesite:
pkill cloudflared
```

---

## 9. Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Telegram comprometido | Baja | Alto | TELEGRAM_ALLOWED_IDS limita a IDs explícitos |
| CORDELIUS_ACCESS_KEY filtrada | Baja | Alto | Solo en .env, nunca en git, rotar si se sospecha |
| Cloudflare expone dashboard | Media | Alto | Login wall obligatorio, Cloudflare off por defecto |
| /run implementado accidentalmente | Media | Crítico | Code review de todo nuevo endpoint; security audit |
| Tailscale desconectado en tablet | Media | Medio | Fallback a Cloudflare temporal con confirmación manual |
| Restart falla y deja server down | Media | Medio | /status verifica estado; alert en Telegram si no responde |
| `git pull` trae código roto | Baja | Alto | `--ff-only`; `node --check` post-pull antes de restart |

---

## 10. Kill switch remoto

El kill switch para **todos** los modos de trading (paper y real):

```
Opción A — Telegram:
  /paper-pause → pausa paper trading inmediatamente

Opción B — Dashboard web:
  POST /api/mode/defensive → activa modo DEFENSIVO (no trading)

Opción C — Tablet directo:
  tmux kill-session -t cordelius 2>/dev/null || true   ← apaga todo

Opción D — Tailscale:
  Desconectar tablet de Tailnet → dashboard inaccesible remotamente
```

El modo `DEFENSIVO` debe:
- Bloquear toda señal nueva de trading (paper y real).
- Loguear el cambio con timestamp.
- Persistir entre reinicios (guardar en `data/` o en `cordelius_settings.json`).
- Ser visible en el Home panel del dashboard.

---

## 11. Qué NO debe poder hacer el bot

```
✗ Ejecutar comandos shell arbitrarios
✗ Leer o enviar .env, whoop_tokens.json ni data/*.json
✗ Hacer git push
✗ Instalar paquetes npm
✗ Crear órdenes reales en brokers
✗ Desactivar el login wall
✗ Modificar CORDELIUS_ACCESS_KEY
✗ Acceder a archivos fuera de ~/corde-bot/
✗ Exponer stack traces o paths internos en respuestas Telegram
✗ Responder a usuarios no en TELEGRAM_ALLOWED_IDS
```

---

## 12. Pendientes antes de implementar

- [ ] Definir `TELEGRAM_ALLOWED_IDS` (IDs reales de Pedro, en .env)
- [ ] Instalar Tailscale en tablet y iPhone
- [ ] Verificar que `node --check dashboard.js` pasa post-pull antes de restart automático
- [ ] Revisar que `/api/paper/pause` y `/api/paper/resume` existen o definir su spec
- [ ] Revisar bot.js para confirmar que no tiene `/run` ni handlers sin whitelist

---

*REMOTE_CONTROL_PLAN.md | 2026-06-15 | Solo documentación — no implementar sin revisión*
