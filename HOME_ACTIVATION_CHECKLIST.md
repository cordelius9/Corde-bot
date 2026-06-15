# HOME_ACTIVATION_CHECKLIST.md — Lista de Activación en Casa

> Checklist rápida para cuando llegas a casa y quieres activar el servidor.
> Más detalle en TABLET_SERVER_RUNBOOK.md.

---

## Antes de empezar

- [ ] Galaxy Tab S6 encendida
- [ ] Cargador conectado
- [ ] WiFi de casa activo y estable

---

## Paso 1 — Arrancar la tablet como servidor

- [ ] Prender Galaxy Tab S6
- [ ] Conectar cargador (obligatorio para uso continuo)
- [ ] Verificar que no está en modo ahorro de batería
- [ ] Verificar WiFi conectado a la red de casa

---

## Paso 2 — Prender Tailscale

- [ ] Abrir Tailscale en la tablet
- [ ] Verificar que el toggle está activo (verde)
- [ ] Anotar la IP Tailscale de la tablet: `tailscale ip -4` en Termux
  - IP Tailscale tablet: `100.___.___.___` *(anotar aquí al configurar)*
- [ ] Verificar desde iPhone/iPad que la tablet aparece en la lista de Tailscale

---

## Paso 3 — Entrar a Termux (directo o via Termius)

- [ ] Abrir Termux en la tablet (o Termius desde iPhone/iPad si Tailscale ya está activo)
- [ ] Verificar que tmux está disponible: `tmux ls`
  - Si hay sesión "cordelius" → `tmux attach -t cordelius`
  - Si no hay sesión → `tmux new-session -s cordelius`

---

## Paso 4 — Actualizar código

```bash
cd ~/corde-bot
git branch --show-current          # debe decir: jarvis-ui-overhaul
git pull origin jarvis-ui-overhaul --ff-only
```

- [ ] `git branch` muestra `jarvis-ui-overhaul`
- [ ] `git pull` completó sin errores
- [ ] Si hubo cambios: `node --check dashboard.js` no reporta errores

---

## Paso 5 — Verificar CODEMAP y documentación

- [ ] Revisar `CODEMAP.md` si hay dudas sobre la arquitectura
- [ ] Revisar `SAFE_SCRIPTS_SPEC.md` si vas a crear scripts hoy
- [ ] Revisar `TABLET_SERVER_RUNBOOK.md` si hay algo fuera de lo normal

*(Solo necesario si hay cambios importantes o es la primera vez)*

---

## Paso 6 — Correr health y security checks

```bash
# ¿El servidor ya está corriendo?
curl -sf http://127.0.0.1:3000/healthz && echo "OK" || echo "NO CORRE"

# Si no corre, arrancar:
TERMUX_HOME=/data/data/com.termux/files/home
tmux new -d -s cordelius "cd ${TERMUX_HOME}/corde-bot && set -a && . ./.env && set +a && APP_DIR=\"\$(pwd)\" node dashboard.js"
sleep 4
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool

# Security audit:
curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool
```

- [ ] `/healthz` responde `{"ok":true}` o similar
- [ ] Security audit muestra `unprotectedMutationEndpoints: 0`
- [ ] Security audit muestra `dashboardProtected: true`

---

## Paso 7 — Crear scripts reales (solo si aprobaste SAFE_SCRIPTS_SPEC.md)

> Solo ejecutar este paso si ya revisaste `SAFE_SCRIPTS_SPEC.md` y decidiste crear los scripts.

- [ ] Revisar `SAFE_SCRIPTS_SPEC.md` completo
- [ ] Crear `scripts/` en el repo si no existe
- [ ] Implementar scripts uno por uno, empezando por `cordelius-check`
- [ ] Probar `cordelius-check` manualmente antes de cualquier otro
- [ ] Solo después: `cordelius-restart`, `cordelius-start`, `cordelius-stop`
- [ ] Watchdog y Cloudflare script al final, después de probar los anteriores

---

## Paso 8 — Probar acceso desde iPhone/iPad

- [ ] Abrir Safari en iPhone o iPad
- [ ] Ir a `http://100.x.x.x:3000` (IP Tailscale de la tablet)
- [ ] El login wall aparece (si CORDELIUS_ACCESS_KEY está configurada)
- [ ] Ingresar y verificar que el dashboard carga
- [ ] Navegar a al menos 2 módulos (ej: Home y Health)
- [ ] Verificar que Telegram bot responde: `/check` o `/status`

---

## Paso 9 — Dejar tmux corriendo

```bash
# Dentro de tmux, salir SIN matar el servidor:
Ctrl+B, D     ← detach (el servidor sigue corriendo)

# NO usar:
exit          ← mata la sesión tmux y el servidor
Ctrl+C        ← mata el proceso node directamente
```

- [ ] `Ctrl+B, D` usado para salir (no `exit`)
- [ ] Verificar desde iPhone que el dashboard sigue respondiendo tras salir de Termux

---

## Verificación final rápida

Desde iPhone/iPad, estos checks deben pasar:

| Check | URL | Esperado |
|---|---|---|
| Health | `http://100.x.x.x:3000/health` | `{"ok":true}` |
| Dashboard | `http://100.x.x.x:3000/` | Login wall o dashboard |
| Telegram | Bot → `/check` | Estado OK |

---

## Si algo falla

Ver `TABLET_SERVER_RUNBOOK.md §9 — Proceso de recuperación`.

---

*HOME_ACTIVATION_CHECKLIST.md | 2026-06-15 | Checklist operativa — actualizar tras cada cambio de setup*
