# DEPLOY.md — Cordelius OS: Guía de deploy en cloud

Cordelius corre con `node dashboard.js` — sin framework, sin build step.
Todo lo que necesitas: Node 18+, las variables de entorno del `.env.example`, y un `Procfile`.

---

## Opciones de plataforma

### Render (recomendado para empezar)

1. Crear cuenta en [render.com](https://render.com)
2. New → Web Service → conectar repo GitHub (`cordelius9/Corde-bot`)
3. Configurar:
   - **Build Command**: `npm install`
   - **Start Command**: `node dashboard.js`
   - **Plan**: Free (sleep automático después de 15 min inactivo)
4. En Environment → agregar todas las variables de `.env.example` con tus valores
5. Deploy automático en cada push a `main`

**Limitación free**: el servidor duerme si no hay requests. Usar UptimeRobot para hacer ping cada 5 min.

---

### Railway

1. Crear cuenta en [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Railway detecta el `Procfile` automáticamente (`web: node dashboard.js`)
4. Variables de entorno: Settings → Variables → agregar las de `.env.example`
5. Deploy: automático en cada push

**Free tier**: $5 de crédito mensual — suficiente para un servidor liviano.

---

### Fly.io

1. Instalar CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Crear app: `fly launch` (en la raíz del repo)
4. Configurar secretos:
   ```bash
   fly secrets set ANTHROPIC_API_KEY=sk-ant-...
   fly secrets set TELEGRAM_BOT_TOKEN=...
   # (repetir para cada variable)
   ```
5. Deploy: `fly deploy`

**Ventaja**: más control, HTTPS automático, sin sleep.

---

### VPS propio (Hetzner, DigitalOcean, Linode)

```bash
# 1. Clonar repo en el servidor
git clone https://github.com/cordelius9/Corde-bot.git
cd Corde-bot
npm install

# 2. Configurar variables de entorno
cp .env.example .env
nano .env  # poner valores reales

# 3. Mantener el proceso vivo con PM2
npm install -g pm2
pm2 start dashboard.js --name cordelius
pm2 save
pm2 startup  # genera comando para systemd

# 4. Reverse proxy con Nginx (opcional, para HTTPS)
# Apunta el dominio al VPS y configura Certbot
```

---

## Cloudflare Tunnel (acceso público desde Termux)

Si quieres exponer el servidor local en Android sin VPS:

```bash
# Instalar cloudflared en Termux
pkg install cloudflared

# Exponer el servidor (genera URL pública temporal)
./tunnel.sh

# Para URL permanente (requiere cuenta Cloudflare):
cloudflared tunnel create cordelius
cloudflared tunnel route dns cordelius tudominio.com
cloudflared tunnel run cordelius
```

---

## Variables de entorno en producción

Nunca subir `.env` al repo. En cada plataforma:

| Plataforma | Cómo agregar variables |
|---|---|
| Render | Dashboard → Service → Environment |
| Railway | Dashboard → Project → Variables |
| Fly.io | `fly secrets set CLAVE=valor` |
| VPS | Archivo `.env` en el servidor (en `.gitignore`) |

Variables mínimas para arrancar en cloud:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
USD_MXN=18.50
```

Variables opcionales pero recomendadas:

```
TELEGRAM_BOT_TOKEN=...
FINNHUB_API_KEY=...
QUIVER_API_KEY=...
CLAUDE_MODEL=claude-sonnet-4-6
```

---

## Qué NO cambia al migrar

- `dashboard.js` — sin dependencias de Termux
- API keys — solo cambia dónde están las env vars
- Paper Mode — sigue siendo educativo, sin trading real
- Alpaca — sigue pendiente hasta activación explícita por el usuario
- Journal — los datos (`cordelius_journal.json`) son locales al servidor; en cloud se perderían al reiniciar (pendiente: storage persistente)

---

## Seguridad en producción

- HTTPS obligatorio (Render/Railway/Fly.io lo dan gratis)
- No exponer puerto sin reverse proxy en VPS
- Rotar API keys si se expone la URL públicamente
- `cordelius_journal.json` y otros runtime files nunca en git

---

## Estado de deploy

| Plataforma | Estado |
|---|---|
| Termux (Android) | ✅ Funcional — producción actual |
| Cloudflare Tunnel | ✅ Disponible (`./tunnel.sh`) |
| Render | 🔲 Listo para deploy — solo falta agregar env vars |
| Railway | 🔲 Listo para deploy |
| Fly.io | 🔲 Listo para deploy |
| VPS propio | 🔲 Listo para deploy |
