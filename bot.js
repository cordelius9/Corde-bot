require("dotenv").config();
const http = require("http");
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require("@anthropic-ai/sdk");

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const bot = token ? new TelegramBot(token, { polling: true }) : null;
const DASHBOARD_PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

function localGet(path) {
  return new Promise(resolve => {
    const req = http.get({ hostname: "127.0.0.1", port: DASHBOARD_PORT, path, timeout: 8000 }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function fmtOpportunity(x) {
  if (!x) return "sin datos";
  return `${x.symbol}: ${x.score}/100 · riesgo ${x.riskScore}/100 · ${x.signal}`;
}

console.log(bot ? "Bot iniciado..." : "Bot Telegram sin token; comandos desactivados.");

if (bot) bot.onText(/\/opportunities/i, async (msg) => {
  const data = await localGet("/api/opportunities");
  const items = data && data.topOpportunities ? data.topOpportunities.slice(0, 5) : [];
  const text = items.length
    ? "Cordelius Opportunity Engine (educativo):\n" + items.map(fmtOpportunity).join("\n")
    : "Sin oportunidades disponibles todavía. Revisa el dashboard.";
  bot.sendMessage(msg.chat.id, text + "\nNo es asesoría financiera.");
});

if (bot) bot.onText(/\/research\s+([A-Za-z0-9.]+)/i, async (msg, match) => {
  const symbol = String(match && match[1] || "").toUpperCase();
  const data = await localGet(`/api/research/stock?symbol=${encodeURIComponent(symbol)}`);
  const text = data && data.ok
    ? `Research ${data.symbol}: ${data.score}/100 · riesgo ${data.riskScore}/100 · ${data.signal}\n${data.thesis}\nNo es asesoría financiera.`
    : `No pude investigar ${symbol}.`;
  bot.sendMessage(msg.chat.id, text);
});

if (bot) bot.onText(/\/queue/i, async (msg) => {
  const data = await localGet("/api/research/queue");
  const queue = data && data.queue ? data.queue : [];
  bot.sendMessage(msg.chat.id, queue.length ? `Research Queue: ${queue.join(", ")}\nEducativo; sin ejecución.` : "Research Queue vacía.");
});

if (bot) bot.on('message', async (msg) => {

  try {

    if (!msg.text) return;

    const userText = msg.text;
    if (/^\/(opportunities|research|queue)\b/i.test(userText)) return;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: userText
        }
      ]
    });

    const reply = response.content[0].text;

    bot.sendMessage(msg.chat.id, reply);

  } catch (error) {
    console.error("ERROR:", error);
    bot.sendMessage(msg.chat.id, "Error procesando mensaje.");
  }

});
