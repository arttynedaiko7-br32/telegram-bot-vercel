import "dotenv/config";
import { Telegraf } from "telegraf";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import Groq from "groq-sdk";

// ---------- ENV ----------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!GROQ_API_KEY) {
  console.error("Ошибка: переменная окружения GROQ_API_KEY не задана.");
  process.exit(1);
}
if (!TELEGRAM_TOKEN) {
  console.error("Ошибка: переменная окружения TELEGRAM_TOKEN не задана.");
  process.exit(1);
}

// Инициализация Groq с вашим API ключом
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Инициализация бота
const bot = new Telegraf(TELEGRAM_TOKEN);

// ---------- MEMORY ----------
const memory = new Map();
const MAX_HISTORY = 50; // Максимальное количество сообщений в истории

const SYSTEM_PROMPT =
  "Ты — интеллектуальный ассистент девушка. Запоминай контекст диалога. Отвечай чётко и по делу.";

// ---------- TMP DIR ----------
const tmpDir = path.join(os.tmpdir(), "tg_ai_files");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

// --------------------------------------------------
// START / HELP
// --------------------------------------------------
bot.start((ctx) => {
  console.log("Бот запущен. Приветственное сообщение отправлено.");
  ctx.reply(
    `👋 Привет, ${ctx.from.first_name || "друг"}!

Я бот с памятью.

Команды:
/help — список команд
/reset — очистить память
/clear — очистить историю чата

Можешь отправлять файлы (txt, md, csv, json, pdf, docx).
Задавай вопросы, и я постараюсь помочь!`
  ).catch(err => console.error("Ошибка при отправке приветственного сообщения:", err));
});

bot.command("help", (ctx) => {
  console.log("Команда /help вызвана");
  ctx.reply(
    "📌 Доступные команды:\n" +
      "/start — запуск\n" +
      "/help — список команд\n" +
      "/reset — сбросить память\n" +
      "/clear — очистить историю чата\n"
  );
});

bot.command("clear", async (ctx) => {
  console.log("Команда /clear вызвана");
  const chatId = ctx.chat.id;
  memory.delete(chatId);
  ctx.reply("История чата очищена!");
});

// --------------------------------------------------
// ОБРАБОТКА ТЕКСТА (вопросы к модели)
// --------------------------------------------------
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const msg = ctx.message.text;

  if (!memory.has(chatId)) {
    console.log(`Создание новой истории для чата: ${chatId}`);
    memory.set(chatId, []);
  }

  // Добавляем новое сообщение пользователя в память
  memory.get(chatId).push({ role: "user", content: msg });

  // Если количество сообщений в памяти превышает MAX_HISTORY, удаляем старые записи
  if (memory.get(chatId).length > MAX_HISTORY) {
    console.log(`Память переполнена для чата ${chatId}. Удаляем старые сообщения.`);
    memory.get(chatId).shift(); // Удаляем самое старое сообщение
  }

  try {
    // Запрос к модели
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...memory.get(chatId),
      ],
      temperature: 0.7,
      max_tokens: 200,
    });

    console.log("Ответ от модели:", response);
    const answer = response?.choices?.[0]?.message?.content;

    // Добавляем ответ модели в память
    if (answer) {
      memory.get(chatId).push({ role: "assistant", content: answer });
    }

    // Отправляем ответ пользователю
    ctx.reply(answer || "Модель вернула пустой ответ.");
  } catch (err) {
    console.error("Ошибка при запросе к модели:", err);
    ctx.reply("❌ Ошибка при запросе к модели.");
  }
});

// --------------------------------------------------
// СБРОС ПАМЯТИ
// --------------------------------------------------
bot.command("reset", (ctx) => {
  const chatId = ctx.chat.id;
  memory.delete(chatId);
  ctx.reply("Память очищена!");
});

// --------------------------------------------------
// ВЕРСЕЛЬ WEBHOOK (обработка webhook в коде)
// --------------------------------------------------
export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const update = req.body;
      console.log("Обработка обновления webhook:", update);
      await bot.handleUpdate(update);  // Обработка webhook
      return res.status(200).end();
    } catch (err) {
      console.error("Ошибка в обработке webhook:", err);
      return res.status(500).send("Internal Server Error");
    }
  }

  return res.status(200).send("OK");
}
