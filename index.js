import "dotenv/config";
import { Telegraf } from "telegraf";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import Groq from "groq-sdk";

// --- ВЕРНАЯ версия pdfjs-dist: 3.11.174 ---
import pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

// ---------- ENV ----------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!GROQ_API_KEY) {
  console.error("Ошибка: переменная окружения GROQ_API_KEY не задана.");
  process.exit(1);
}
if (!TELEGRAM_TOKEN) {
  console.error("Ошибка: переменная окружения TELEGRAM_TOKEN не задана.");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("Ошибка: переменная окружения WEBHOOK_URL не задана.");
  process.exit(1);
}

// Инициализация Groq с вашим API ключом
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ---------- INIT ----------
const bot = new Telegraf(TELEGRAM_TOKEN);

// ---------- MEMORY ----------
const memory = new Map();
const MAX_HISTORY = 50;
const MAX_TEXT_CHARS = 10000;

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

Я AI-ассистент с памятью.

Команды:
/help — список команд
/reset — очистить память
/clear — очистить историю

Можешь отправлять файлы (txt, md, csv, json, pdf, docx).`
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📌 Доступные команды:\n" +
      "/start — запуск\n" +
      "/help — список команд\n" +
      "/reset — сбросить память\n" +
      "/clear — очистить историю чата\n"
  );
});

bot.command("clear", async (ctx) => {
  const chatId = ctx.chat.id;
  memory.delete(chatId);
  ctx.reply("История чата очищена!");
});

// ======================================================
// ОБРАБОТКА ДОКУМЕНТОВ
// ======================================================
bot.on("document", async (ctx) => {
  const chatId = ctx.chat.id;
  try {
    const doc = ctx.message.document;
    if (!doc) return ctx.reply("Нет документа в сообщении.");

    const fileId = doc.file_id;
    const fileName = doc.file_name || "file";
    const fileUrl = await ctx.telegram.getFileLink(fileId);

    const safeName = fileName.replace(/[/\\?%*:|"<>]/g, "_");
    const filePath = path.join(tmpDir, safeName);

    const resp = await axios.get(fileUrl.href, {
      responseType: "arraybuffer",
      timeout: 120000,
    });

    const uint8 = new Uint8Array(resp.data);
    fs.writeFileSync(filePath, Buffer.from(uint8));

    let text = "";

    if (/\.(txt|md|csv)$/i.test(fileName)) {
      text = Buffer.from(uint8).toString("utf8");
    } else if (/\.json$/i.test(fileName)) {
      text = JSON.stringify(JSON.parse(Buffer.from(uint8).toString("utf8")), null, 2);
    } else if (/\.pdf$/i.test(fileName)) {
      text = await extractPdfText(uint8);
    } else if (/\.docx$/i.test(fileName)) {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(uint8) });
      text = result.value || "";
    } else {
      try { fs.unlinkSync(filePath); } catch {}
      return ctx.reply("❌ Этот формат файла не поддерживается.");
    }

    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + "\n...(обрезано)";
    }

    if (!memory.has(chatId)) memory.set(chatId, []);
    memory.get(chatId).push({
      role: "user",
      content: `📄 Файл ${fileName} загружен:\n${text}`,
    });

    try { fs.unlinkSync(filePath); } catch {}

    ctx.reply("📄 Файл загружен и добавлен в контекст!");
  } catch (err) {
    console.error("Ошибка обработки файла:", err);
    ctx.reply("❌ Ошибка при обработке файла.");
  }
});

// ======================================================
// ОБРАБОТКА ТЕКСТА
// ======================================================
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const msg = ctx.message.text;

  if (!memory.has(chatId)) memory.set(chatId, []);
  memory.get(chatId).push({ role: "user", content: msg });

  if (memory.get(chatId).length > MAX_HISTORY) {
    memory.set(chatId, memory.get(chatId).slice(-MAX_HISTORY));
  }

  try { await ctx.sendChatAction("typing"); } catch {}

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...memory.get(chatId),
      ],
      temperature: 0.2,
      max_tokens: 800,
    });

    const answer = response?.choices?.[0]?.message?.content;

    if (answer) {
      memory.get(chatId).push({ role: "assistant", content: answer });
    }

    ctx.reply(answer || "Модель вернула пустой ответ.");
  } catch (err) {
    console.error("Ошибка Groq:", err);
    ctx.reply("❌ Ошибка при запросе к модели.");
  }
});

// --------------------------------------------------
// ВЕРСЕЛЬ WEBHOOK
// --------------------------------------------------
export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const update = req.body;
      await bot.handleUpdate(update);
      return res.status(200).end();
    } catch (err) {
      console.error("Ошибка в обработке webhook:", err);
      return res.status(500).send("Internal Server Error");
    }
  }

  return res.status(200).send("OK");
}

// Настройка webhook
bot.telegram.setWebhook(WEBHOOK_URL);
