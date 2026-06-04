require("dotenv").config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require("@anthropic-ai/sdk");

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const bot = new TelegramBot(token, { polling: true });

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || ""
});

console.log("Bot iniciado...");

bot.on('message', async (msg) => {

  try {

    if (!msg.text) return;

    const userText = msg.text;

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL_BOT || "claude-haiku-4-5-20251001",
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
