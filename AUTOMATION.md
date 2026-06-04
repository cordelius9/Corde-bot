# AUTOMATION.md — Cordelius OS: Guía de Automatización

Guía operativa para mantener Cordelius corriendo solo en Termux y prepararlo para migrar a cloud.

---

## Scripts disponibles (`scripts/`)

| Script | Uso | Descripción |
|---|---|---|
| `health_check.sh` | `bash scripts/health_check.sh` | Verifica `/health`, muestra estado, tail de log si hay error |
| `restart_safe.sh` | `bash scripts/restart_safe.sh` | stop → start → sleep 4 → verifica `/health` |
| `morning_report.sh` | `bash scripts/morning_report.sh` | Consulta 4 endpoints y guarda JSON en `reports/` |
| `final_check.sh` | `bash scripts/final_check.sh` | git status, sintaxis, health, endpoints, secrets — antes de push |

Todos deben ejecutarse desde la raíz del proyecto (`~/corde-bot`):

```bash
cd ~/corde-bot
bash scripts/health_check.sh
```

---

## Morning Report

El script `morning_report.sh` consulta:
- `GET /health`
- `GET /api/morning-report`
- `GET /api/portfolio`
- `GET /api/intel`

Guarda el resultado combinado en:
```
reports/morning_report_YYYY-MM-DD_HHMMSS.json
```

El endpoint `/api/morning-report` devuelve:
- Daily brief + saludo personalizado
- Resumen de portafolio (valor, ganancia, activos)
- Idea de paper trade (educativa, sin ejecución real)
- Estado Quiver y Paper Mode
- Lista de scripts de automatización

Los archivos en `reports/` están en `.gitignore` — no se suben al repo.

---

## Reinicio seguro

```bash
bash scripts/restart_safe.sh
```

Equivale a:
```bash
./stop.sh
./start.sh
sleep 4
curl -s http://127.0.0.1:3000/health
```

---

## Validar antes de push

Siempre correr antes de `git push`:

```bash
bash scripts/final_check.sh
```

Verifica:
1. `git status --short` — sin archivos sensibles sin ignorar
2. `node --check dashboard.js` — sin errores de sintaxis
3. `/health` — servidor responde
4. Endpoints clave: `/api/portfolio`, `/api/intel`, `/api/daily-brief`, `/api/morning-report`, `/api/paper/status`
5. Secrets en diff — busca patrones de API keys
6. Último link de Cloudflare (si existe)

---

## Termux: inicio automático al boot de Android

Para que Cordelius inicie automáticamente cuando enciende el Android:

1. Instalar **Termux:Boot** desde F-Droid (misma fuente que Termux)
2. Crear el script de boot:

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start_cordelius.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd ~/corde-bot
./watchdog.sh &
EOF
chmod +x ~/.termux/boot/start_cordelius.sh
```

3. Abrir Termux:Boot al menos una vez para activarlo.

Sin Termux:Boot: iniciar manualmente con `bash scripts/restart_safe.sh` o `./start.sh` cada vez.

---

## Watchdog

El script `watchdog.sh` reinicia el proceso si cae:

```bash
./watchdog.sh &
```

Logs en `watchdog.log`. Solo útil si el Android no mata el proceso de Termux.

---

## Migración a cloud (conceptual)

Cordelius está listo para migrar a un servidor VPS o PaaS. No requiere cambios de código.

### Opciones recomendadas (sin costo o bajo costo):

| Plataforma | Notas |
|---|---|
| **Railway** | Free tier generoso, deploy desde GitHub, env vars en UI |
| **Render** | Free tier con sleep automático, fácil setup |
| **Fly.io** | Más control, requiere Dockerfile |
| **VPS propio** | Full control, más barato a largo plazo |

### Pasos generales:

1. Clonar repo en el servidor
2. Configurar variables de entorno (`.env` nunca en repo)
3. Instalar PM2 o usar systemd para mantener el proceso vivo:
   ```bash
   npm install -g pm2
   pm2 start dashboard.js --name cordelius
   pm2 save && pm2 startup
   ```
4. Configurar reverse proxy (Nginx/Caddy) con HTTPS
5. Usar dominio propio o el subdominio de la plataforma

### Qué NO cambia al migrar:

- `dashboard.js` — sin dependencias de Termux
- API keys — solo se cambia dónde están las env vars
- Paper Mode — sigue siendo educativo, sin trading real
- Alpaca — sigue pendiente hasta activación explícita

---

## Seguridad

- **NUNCA** hardcodear API keys en código
- **NUNCA** subir `.env` al repo
- **NUNCA** activar trading real sin revisión explícita
- Alpaca permanece en PAPER ONLY hasta decisión consciente
- `final_check.sh` busca secrets en el diff antes del push
- Los archivos `reports/` están en `.gitignore` — pueden contener datos de portafolio

---

## Estado de automatización

| Función | Estado |
|---|---|
| `health_check.sh` | ✅ Disponible |
| `restart_safe.sh` | ✅ Disponible |
| `morning_report.sh` | ✅ Disponible |
| `final_check.sh` | ✅ Disponible |
| `/api/morning-report` | ✅ Disponible |
| Termux:Boot | 🔲 Manual — ver instrucciones arriba |
| Cloud deploy | 🔲 Conceptual — listo para ejecutar |
| Alertas push Telegram | 🔲 Pendiente (F3b) |
| Portfolio editable en runtime | 🔲 Pendiente (F3c) |
