import { Bot, webhookCallback, Context } from "grammy";

export interface Env {
  BOT_TOKEN: string;
  OWNER_ID: string;
  AI_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
}

// --- Глобальное состояние (живёт в пределах изолята) ---
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

// --- Ленивая инициализация бота (один раз на изолят) ---
let bot: Bot | null = null;
let handler: ((req: Request) => Promise<Response>) | null = null;
let cachedOwnerId = 0;

function getBot(env: Env): Bot {
  if (bot) return bot;

  cachedOwnerId = parseInt(env.OWNER_ID, 10);
  console.log("INIT BOT: ownerId =", cachedOwnerId);

  bot = new Bot(env.BOT_TOKEN);

  // --- Команды ---
  bot.command("away", async (ctx: Context) => {
    console.log("AWAY handler hit: from.id =", ctx.from?.id, "ownerId =", cachedOwnerId);
    if (ctx.from?.id !== cachedOwnerId) return;
    isAway = !isAway;
    await ctx.reply(
      isAway ? "🤖 Я в сети и буду отвечать за тебя." : "🏠 Ты снова в сети. Я замолкаю."
    );
  });

  bot.command("reset", async (ctx: Context) => {
    console.log("RESET handler hit: from.id =", ctx.from?.id);
    if (ctx.from?.id !== cachedOwnerId) return;
    for (const key in conversationHistory) delete conversationHistory[key];
    await ctx.reply("🧹 История всех диалогов сброшена.");
  });

  // --- Business сообщения (автоответчик) ---
  bot.on("business_message:text", async (ctx: Context) => {
    const msg = ctx.businessMessage;
    if (!msg || !msg.text) return;
    if (msg.from.id === cachedOwnerId) return; // Игнорируем владельца
    if (!isAway) return; // Режим выключен

    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!conversationHistory[userId]) {
      conversationHistory[userId] = [{ role: "system", content: SYSTEM_PROMPT }];
    }

    conversationHistory[userId].push({ role: "user", content: msg.text });

    await ctx.api.sendChatAction(chatId, "typing");

    try {
      const response = await fetch(`${env.AI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AI_API_KEY}`,
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

      const data = (await response.json()) as any;
      const aiAnswer = data.choices[0].message.content;

      conversationHistory[userId].push({ role: "assistant", content: aiAnswer });
      await ctx.reply(aiAnswer);
    } catch (e) {
      console.error("Ошибка при ответе:", e);
      await ctx.reply(
        "Извините, я временно не могу ответить. Владелец обязательно с вами свяжется позже."
      );
    }
  });

  // Ловим любые сообщения для отладки (можно убрать после проверки)
  bot.on("message", async (ctx: Context) => {
    console.log("ANY message:", ctx.message?.text, "chat.type =", ctx.chat?.type);
  });

  return bot;
}

function getHandler(env: Env) {
  if (handler) return handler;
  const b = getBot(env);
  // "cloudflare-mod" — адаптер для формата ES Modules (export default { fetch })
  handler = webhookCallback(b, "cloudflare-mod");
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // GET (например, открытие в браузере) не должен падать в JSON.parse
    if (request.method !== "POST") {
      return new Response("Bot is running.", { status: 200 });
    }

    try {
      const h = getHandler(env);
      return await h(request);
    } catch (e) {
      console.error("GLOBAL ERROR:", e);
      return new Response("Error: " + (e as Error).message, { status: 500 });
    }
  },
};