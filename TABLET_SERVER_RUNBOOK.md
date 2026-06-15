# TABLET_SERVER_RUNBOOK.md — Galaxy Tab S6 como Servidor Cordelius

> Runbook operativo. Solo documentación — no implementar scripts todavía.
> Branch: `jarvis-ui-overhaul` | Referencias: CODEMAP.md, REMOTE_CONTROL_PLAN.md

---

## 1. Arquitectura

```
Galaxy Tab S6 (servidor)
  └─ Android 12 / Termux
        └─ tmux  (sesión persistente: "cordelius")
              ├─ node start-with-env.js   → puerto 3000
              └─ cloudflared              → tunnel opcional

Red:
  Principal:  Tailscale VPN
              Tab S6 ←→ iPhone/iPad (misma Tailnet)
              URL: http://100.x.x.x:3000

  Opcional:   Cloudflare Quick Tunnel
              Solo para debug o acceso desde red desconocida
              Nunca dejar activo permanentemente

Clientes:
  iPhone / iPad → Safari / Telegram → Cordelius dashboard
```

### Por qué tmux

tmux mantiene el proceso Node.js vivo aunque la sesión SSH/Termius se cierre.
Sin tmux, cerrar la terminal mata el servidor.

```
tmux new-session -s cordelius     ← crear sesión
tmux attach -t cordelius          ← volver a la sesión
Ctrl+B, D                         ← salir SIN matar la sesión
```

---

## 2. Setup Android — una sola vez

Estos ajustes evitan que Android mate Termux o Tailscale en segundo plano.

### Batería y procesos

```
Ajustes → Batería → Optimización de batería
  → Buscar "Termux" → Seleccionar "No optimizar"
  → Buscar "Tailscale" → Seleccionar "No optimizar"

Ajustes → Batería → Modo de ahorro de energía
  → Desactivar (o excluir Termux y Tailscale)

Ajustes → Aplicaciones → Termux → Batería
  → Actividad en segundo plano: Permitir siempre
```

### WiFi estable

```
Ajustes → Conexiones → WiFi → Avanzado
  → Cambiar a datos móviles cuando sea necesario: OFF
  → Activar WiFi automáticamente: OFF (mantener en el red de casa)

En red conocida:
  → Propiedades de red → IP estática (opcional pero recomendado)
  → Reservar IP en el router para la MAC de la tablet
```

### Pantalla y bloqueo

```
Ajustes → Pantalla → Tiempo de espera de pantalla → 10 minutos o más
Ajustes → Pantalla → Modo de reposo → Nunca (si está cargando)
Ajustes → Pantalla de bloqueo → Bloqueo automático → 30 minutos
```

> ⚠️ Android puede seguir matando procesos en segundo plano aunque se configuró "No optimizar".
> Si el servidor muere solo, revisar: Ajustes → Batería → Uso de batería → Termux → Forzar detención reciente.

---

## 3. Cargador y hardware

```
✓  Cargador conectado siempre que el servidor esté activo
✓  Cable USB-C original Samsung (o equivalente certificado)
✓  Batería ≥ 20% antes de desconectar (por si hay corte de luz)
✓  WiFi estable (5 GHz preferido para baja latencia)
✗  No usar la tablet intensivamente mientras corre el servidor
✗  No instalar actualizaciones de sistema mientras el servidor está activo
```

---

## 4. Acceso por Tailscale

### Setup (una vez por dispositivo)

```bash
# En Termux (tablet):
pkg install tailscale
tailscale up
# → Abre link en navegador de la tablet para autenticar con tu cuenta Tailscale

# En iPhone/iPad:
# → Instalar Tailscale desde App Store
# → Login con la misma cuenta
# → Aprobar el dispositivo en admin.tailscale.com si se pide
```

### Verificar conectividad

```bash
# En Termux:
tailscale ip -4           # → muestra tu IP Tailscale, ej: 100.x.x.x
tailscale status          # → muestra dispositivos conectados

# Desde iPhone/iPad (Safari):
# → abrir http://100.x.x.x:3000
# → debe aparecer el login wall de Cordelius
```

### URL de acceso

```
http://100.x.x.x:3000          ← dashboard completo
http://100.x.x.x:3000/health   ← health check (sin auth)
http://100.x.x.x:3000/healthz  ← health check alternativo
```

---

## 5. Cloudflare Quick Tunnel — solo temporal

Solo usar cuando Tailscale no está disponible (red desconocida, demo, debug).

```bash
# Iniciar tunnel temporal (NO permanente):
cloudflared tunnel --url http://localhost:3000

# → Imprime una URL pública tipo: https://xxxx.trycloudflare.com
# → Válida solo hasta que se cierre el proceso

# Antes de activar, verificar security audit:
curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool
# Debe mostrar: dashboardProtected: true, accessKeyConfigured: true

# Apagar cuando termines:
Ctrl+C  (en la ventana tmux donde corre cloudflared)
```

> ⚠️ Nunca dejar Cloudflare activo de forma permanente.
> El login wall debe estar activo antes de exponer a internet público.

---

## 6. Comandos manuales base

Todos se ejecutan dentro de la sesión tmux o en Termux directo.

```bash
# Ir al repo
cd ~/corde-bot

# Verificar rama
git branch --show-current
# Debe mostrar: jarvis-ui-overhaul

# Actualizar código
git checkout jarvis-ui-overhaul
git pull origin jarvis-ui-overhaul --ff-only

# Verificar sintaxis antes de arrancar
node --check dashboard.js
# Debe completar sin errores

# Ver o crear sesión tmux
tmux ls                           # listar sesiones existentes
tmux new-session -s cordelius     # nueva sesión (si no existe)
tmux attach -t cordelius          # volver a sesión existente

# Arrancar servidor (dentro de tmux)
nohup node start-with-env.js > corde.log 2>&1 &

# Verificar health
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool

# Security audit
curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool
```

---

## 7. Proceso de arranque diario

```
1. Conectar cargador
2. Abrir Termius (o Termux directamente)
3. tmux attach -t cordelius
   ├─ Si existe: verificar que node corre (ps aux | grep node)
   └─ Si no existe: tmux new-session -s cordelius

4. cd ~/corde-bot
5. git pull origin jarvis-ui-overhaul --ff-only
6. node --check dashboard.js          ← solo si hubo cambios
7. [Si hay cambios]: restart seguro (ver §8)

8. Verificar servidor sano:
   curl -s http://127.0.0.1:3000/healthz
   curl -s http://127.0.0.1:3000/api/security/audit | python3 -m json.tool

9. Desde iPhone/iPad:
   → abrir http://100.x.x.x:3000
   → verificar que el dashboard carga y los módulos responden

10. Ctrl+B, D  → salir de tmux sin matar el servidor
```

---

## 8. Proceso de arranque del servidor (dentro de tmux)

```bash
# Verificar si ya está corriendo (evitar doble proceso):
curl -sf http://127.0.0.1:3000/healthz && echo "YA CORRE" || echo "NO CORRE"

# Si no corre:
cd ~/corde-bot
node --check dashboard.js          # verificar sintaxis primero
nohup node start-with-env.js > corde.log 2>&1 &
sleep 4
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool

# Si ya corre y necesitas reiniciar:
pkill -f "node start-with-env.js"
sleep 2
# → verificar que el puerto quedó libre:
curl -sf http://127.0.0.1:3000/healthz && echo "PUERTO OCUPADO" || echo "LIBRE"
# → luego arrancar de nuevo
nohup node start-with-env.js > corde.log 2>&1 &
sleep 4
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool
```

> ⚠️ Nunca iniciar un segundo proceso si el puerto 3000 ya está ocupado.
> Siempre verificar con `/healthz` antes y después de cualquier restart.

---

## 9. Proceso de recuperación

### El servidor no responde

```bash
# 1. Verificar si el proceso existe
ps aux | grep node

# 2. Si existe pero no responde:
pkill -f "node start-with-env.js"
sleep 3
nohup node start-with-env.js > corde.log 2>&1 &
sleep 4
curl -s http://127.0.0.1:3000/healthz

# 3. Si no responde después del restart, ver logs:
tail -30 corde.log
```

### tmux no existe (Android mató la sesión)

```bash
# Verificar si el proceso Node sigue vivo de todas formas:
curl -sf http://127.0.0.1:3000/healthz && echo "SERVER OK"

# Recrear sesión tmux y adjuntar el proceso existente:
# (si node sigue corriendo, no reiniciar — solo rehacer tmux)
tmux new-session -s cordelius

# Si node murió también:
tmux new-session -s cordelius
cd ~/corde-bot
nohup node start-with-env.js > corde.log 2>&1 &
```

### Tailscale desconectado

```bash
tailscale status    # verificar estado
tailscale up        # reconectar si está abajo
# Si pide re-autenticación: seguir el link que imprime
```

### git pull trae código roto

```bash
# Si node --check falla después de un pull:
git log --oneline -3         # ver qué commits llegaron
git diff HEAD~1 dashboard.js # ver qué cambió
git reset --hard HEAD~1      # revertir si el pull rompió algo
                             # (solo si es seguro — no perder trabajo local)
# O restaurar backup:
ls dashboard_backup_*.js     # ver backups disponibles
cp dashboard_backup_YYYYMMDD_HHMMSS.js dashboard.js
node --check dashboard.js
```

---

## 10. Checklist de "servidor sano"

Verificar antes de dejarlo corriendo sin supervisión:

```
[ ] Cargador conectado
[ ] Tailscale activo: tailscale status → tablet en la lista
[ ] Proceso corriendo: ps aux | grep node → muestra start-with-env.js
[ ] Health OK: curl -s http://127.0.0.1:3000/healthz → {"ok":true}
[ ] Security OK: /api/security/audit → unprotectedMutationEndpoints: 0
[ ] Sin Cloudflare activo (a menos que sea intencional y temporal)
[ ] tmux tiene sesión "cordelius": tmux ls
[ ] Última confirmación desde iPhone/iPad: dashboard carga en http://100.x.x.x:3000
```

---

## 11. Qué NO hacer

```
✗  Cerrar Termux sin usar tmux primero (mata el servidor)
✗  Activar ahorro de batería mientras el servidor corre
✗  Dejar Cloudflare activo de forma permanente
✗  Actualizar Android mientras el servidor está activo
✗  Arrancar node sin node --check primero (puede arrancar código roto)
✗  Iniciar un segundo proceso node si el puerto 3000 ya está ocupado
✗  Hacer git push desde la tablet (repositorio de producción, usar solo pull)
✗  Ejecutar comandos en la sesión tmux del servidor desde acceso remoto no verificado
✗  Dejar la pantalla encendida permanentemente (consume batería innecesariamente)
✗  Conectar la tablet a redes WiFi desconocidas mientras el servidor está activo
```

---

## 12. Referencias cruzadas

| Documento | Uso |
|---|---|
| `CODEMAP.md` | Arquitectura completa de dashboard.js, endpoints, funciones |
| `REMOTE_CONTROL_PLAN.md` | Comandos remotos via Telegram, whitelist, kill switch |
| `SAFE_SCRIPTS_SPEC.md` | Especificación de scripts a crear (cordelius-start, etc.) |
| `HOME_ACTIVATION_CHECKLIST.md` | Checklist rápida para cuando llegas a casa |
| `PAPER_TRADING_SPEC.md` | Spec de paper trading (Fase 2 del autopilot) |
| `TRADING_AUTOPILOT_PLAN.md` | Roadmap completo de automatización |

---

*TABLET_SERVER_RUNBOOK.md | 2026-06-15 | Solo documentación — scripts reales en SAFE_SCRIPTS_SPEC.md*
