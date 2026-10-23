import { Bot, webhookCallback, Context } from "grammy";

export interface Env {
  BOT_TOKEN: string;
  OWNER_ID: string;
  AI_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
}

let isAway = false;
const conversationHistory: Record<number, Array<{ role: string; content: string }>> = {};

const SYSTEM_PROMPT = `
Ты — дружелюбный ассистент, который общается от лица владельца аккаунта Александра.
Отвечай на вопросы собеседника, поддерживай беседу, шути.
Стиль общения: вежливый, с легким юмором, не слишком официальный.
Если вопрос сложный и требует личного участия владельца — честно скажи,
что передашь информацию, как только он появится в сети.
Отвечай ТОЛЬКО на русском языке.
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Инициализируем бота внутри fetch, чтобы иметь доступ к env
    const bot = new Bot(env.BOT_TOKEN);

    const ownerId = parseInt(env.OWNER_ID, 10);

    // --- Команды ---
    bot.command("away", async (ctx) => {
      if (ctx.from?.id !== ownerId) return;
      isAway = !isAway;
      await ctx.reply(isAway ? "🤖 Я в сети и буду отвечать за тебя." : "🏠 Ты снова в сети. Я замолкаю.");
    });

    bot.command("reset", async (ctx) => {
      if (ctx.from?.id !== ownerId) return;
      for (const key in conversationHistory) delete conversationHistory[key];
      await ctx.reply("🧹 История всех диалогов сброшена.");
    });

    // --- Business сообщения (автоответчик) ---
    bot.on("business_message:text", async (ctx) => {
      const msg = ctx.businessMessage;
      if (!msg || !msg.text) return;
      if (msg.from.id === ownerId) return; // Игнорируем владельца
      if (!isAway) return; // Режим выключен

      const userId = msg.from.id;
      const chatId = msg.chat.id;

      // Инициализация истории
      if (!conversationHistory[userId]) {
        conversationHistory[userId] = [{ role: "system", content: SYSTEM_PROMPT }];
      }

      conversationHistory[userId].push({ role: "user", content: msg.text });

      // Показываем "печатает..."
      await ctx.api.sendChatAction(chatId, "typing");

      try {
        const response = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.AI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: env.AI_MODEL,
            messages: conversationHistory[userId],
            temperature: 0.7,
            max_tokens: 1000,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error("AI API Error:", errText);
          throw new Error("AI request failed");
        }

        const data = await response.json() as any;
        const aiAnswer = data.choices[0].message.content;

        conversationHistory[userId].push({ role: "assistant", content: aiAnswer });
        await ctx.reply(aiAnswer);

      } catch (e) {
        console.error("Ошибка при ответе:", e);
        await ctx.reply("Извините, я временно не могу ответить. Владелец обязательно с вами свяжется позже.");
      }
    });

    // Все остальные текстовые сообщения игнорируем
    // (опционально можно добавить fallback)

    // Возвращаем обработчик webhook
    const handler = webhookCallback(bot, "cloudflare-mod");
    return await handler(request);
  },
};