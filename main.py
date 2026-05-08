import asyncio
import httpx
import os
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command

# Загружаем переменные из .env
load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
OWNER_ID = int(os.getenv("OWNER_ID", "0"))
YANDEX_API_KEY = os.getenv("YANDEX_API_KEY")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID")

# Системный промпт
SYSTEM_PROMPT = """
Ты — дружелюбный ассистент, который общается от лица владельца аккаунта Александра.
Отвечай на вопросы собеседника, поддерживай беседу, шути.
Стиль общения: вежливый, с легким юмором, не слишком официальный.
Если вопрос сложный и требует личного участия владельца — честно скажи,
что передашь информацию, как только он появится в сети.
Отвечай ТОЛЬКО на русском языке.
"""

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Режим автоответчика
is_away = False

# История диалогов
conversation_history = {}


@dp.message(Command("away"))
async def activate_away_mode(message: types.Message):
    """Включает/выключает режим 'отошел'"""
    global is_away

    if message.from_user.id != OWNER_ID:
        return

    is_away = not is_away

    if is_away:
        await message.answer("🤖 Я в сети и буду отвечать за тебя.")
    else:
        await message.answer("🏠 Ты снова в сети. Я замолкаю.")


@dp.message(Command("reset"))
async def reset_history(message: types.Message):
    """Сбрасывает историю диалогов"""
    global conversation_history

    if message.from_user.id != OWNER_ID:
        return

    conversation_history = {}
    await message.answer("🧹 История всех диалогов сброшена.")


@dp.business_message(F.text)
async def intelligent_business_reply(business_message: types.BusinessMessage):
    """Отвечает на личные сообщения через YandexGPT, когда владелец отошел"""
    global conversation_history

    # Игнорируем сообщения от владельца
    if business_message.from_user.id == OWNER_ID:
        return

    # Если режим выключен — молчим
    if not is_away:
        return

    user_id = business_message.from_user.id

    # Инициализируем историю для нового пользователя
    if user_id not in conversation_history:
        conversation_history[user_id] = [{"role": "system", "text": SYSTEM_PROMPT}]

    # Добавляем сообщение пользователя
    conversation_history[user_id].append(
        {"role": "user", "text": business_message.text}
    )

    # Показываем "набирает сообщение"
    await bot.send_chat_action(chat_id=business_message.chat.id, action="typing")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
                headers={
                    "Authorization": f"Api-Key {YANDEX_API_KEY}",
                    "x-folder-id": YANDEX_FOLDER_ID,
                },
                json={
                    "modelUri": f"gpt://{YANDEX_FOLDER_ID}/yandexgpt/latest",
                    "completionOptions": {
                        "temperature": 0.7,
                        "maxTokens": 1000,
                    },
                    "messages": conversation_history[user_id],
                },
            )

        result = response.json()
        ai_answer = result["result"]["alternatives"][0]["message"]["text"]

        conversation_history[user_id].append({"role": "assistant", "text": ai_answer})
        await business_message.answer(ai_answer)

    except Exception as e:
        print(f"❌ Ошибка: {e}")
        if "response" in locals():
            print(f"📩 Тело ответа: {response.text}")
        await business_message.answer(
            "Извините, я временно не могу ответить. "
            "Владелец обязательно с вами свяжется позже."
        )


@dp.message(F.text)
async def fallback_reply(message: types.Message):
    """На обычные сообщения не отвечаем (заглушка)"""
    return


async def main():
    print("🚀 Бот запущен...")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
