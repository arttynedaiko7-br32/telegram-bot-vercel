import { Telegraf } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- ВЕРНАЯ версия pdfjs-dist: 3.11.174 ---
import pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

// Подключаем библиотеку Groq
import Groq from 'groq-sdk';

// ---------- ENV ----------
// Получаем API ключи из переменных окружения Vercel
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!GROQ_API_KEY) {
  console.error('Ошибка: переменная окружения GROQ_API_KEY не задана.');
  process.exit(1);
}
if (!TELEGRAM_TOKEN) {
  console.error('Ошибка: переменная окружения TELEGRAM_TOKEN не задана.');
  process.exit(1);
}

// Инициализация Groq с вашим API ключом
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ---------- INIT ----------
const bot = new Telegraf(TELEGRAM_TOKEN);

// ---------- MEMORY ----------
const memory = new Map();
const MAX_HISTORY = 20;
const MAX_TEXT_CHARS = 7000;

const SYSTEM_PROMPT = 'Ты — интеллектуальный помощник. Запоминай контекст диалога. Отвечай чётко и по делу.';

// ---------- TMP DIR ----------
const tmpDir = path.join(os.tmpdir(), 'tg_ai_files');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

// --------------------------------------------------
// START / HELP
// --------------------------------------------------
bot.start((ctx) => {
  console.log('Бот запущен. Приветственное сообщение отправлено.');
  ctx.reply(
    `👋 Привет, ${ctx.from.first_name || 'друг'}!

Я AI-ассистент с памятью.

Команды:
/help — список команд
/reset — очистить память
/clear — очистить историю

Можешь отправлять файлы (txt, md, csv, json, pdf, docx).`
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    '📌 Доступные команды:\n' +
      '/start — запуск\n' +
      '/help — список команд\n' +
      '/reset — сбросить память\n' +
      '/clear — очистить историю чата\n'
  );
});

bot.command('clear', async (ctx) => {
  const chatId = ctx.chat.id;
  const lastMessageId = ctx.message.message_id;

  memory.delete(chatId);

  const batch = [];
  for (let i = lastMessageId; i > 0; i--) {
    batch.push(
      ctx.telegram.deleteMessage(chatId, i).catch(() => {})
    );

    if (batch.length >= 30) {
      await Promise.all(batch);
      batch.length = 0;
    }
  }

  await Promise.all(batch);
});

// ======================================================
// ОБРАБОТКА ДОКУМЕНТОВ
// ======================================================
bot.on('document', async (ctx) => {
  const chatId = ctx.chat.id;

  try {
    const doc = ctx.message.document;
    if (!doc) return ctx.reply('Нет документа в сообщении.');

    const fileId = doc.file_id;
    const fileName = doc.file_name || 'file';
    const fileUrl = await ctx.telegram.getFileLink(fileId);

    const safeName = fileName.replace(/[/\\?%*:|"<>]/g, '_');
    const filePath = path.join(tmpDir, safeName);

    // Скачиваем файл (ПРЕОБРАЗУЕМ СРАЗУ В Uint8Array)
    const resp = await axios.get(fileUrl.href, {
      responseType: 'arraybuffer',
      timeout: 120000,
    });

    const uint8 = new Uint8Array(resp.data); // ← КЛЮЧЕВОЙ МОМЕНТ

    // Сохраняем временно (не обязательно, но пусть будет)
    fs.writeFileSync(filePath, Buffer.from(uint8));

    let text = '';

    // TEXT / MD / CSV
    if (/\.(txt|md|csv)$/i.test(fileName)) {
      text = Buffer.from(uint8).toString('utf8');
    }

    // JSON
    else if (/\.json$/i.test(fileName)) {
      try {
        text = JSON.stringify(JSON.parse(Buffer.from(uint8).toString('utf8')), null, 2);
      } catch {
        text = Buffer.from(uint8).toString('utf8');
      }
    }

    // PDF
    else if (/\.pdf$/i.test(fileName)) {
      text = await extractPdfText(uint8);
    }

    // DOCX
    else if (/\.docx$/i.test(fileName)) {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(uint8) });
      text = result.value || '';
    }

    // UNSUPPORTED
    else {
      try { fs.unlinkSync(filePath); } catch {}
      return ctx.reply(
        '❌ Этот формат файла не поддерживается (поддерживаются: txt, md, csv, json, pdf, docx).'
      );
    }

    // Ограничение длины
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + '\n...(обрезано)';
    }

    // Добавляем в контекст
    if (!memory.has(chatId)) memory.set(chatId, []);
    memory.get(chatId).push({
      role: 'user',
      content: `📄 Файл ${fileName} загружен:\n${text}`,
    });

    try { fs.unlinkSync(filePath); } catch {}

    ctx.reply('📄 Файл загружен и добавлен в контекст!');
  } catch (err) {
    console.error('Ошибка обработки файла:', err);
    ctx.reply('❌ Ошибка при обработке файла.');
  }
});

// ======================================================
// ОБРАБОТКА ТЕКСТА
// ======================================================
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const msg = ctx.message.text;

  if (!memory.has(chatId)) memory.set(chatId, []);

  memory.get(chatId).push({ role: 'user', content: msg });

  // Ограничиваем историю
  if (memory.get(chatId).length > MAX_HISTORY) {
    memory.set(chatId, memory.get(chatId).slice(-MAX_HISTORY));
  }

  try { await ctx.sendChatAction('typing'); } catch {}

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...memory.get(chatId),
      ],
      temperature: 0.2,
      max_tokens: 800,
    });

    const answer = response?.choices?.[0]?.message?.content;

    if (answer) {
      memory.get(chatId).push({ role: 'assistant', content: answer });
    }

    ctx.reply(answer || 'Модель вернула пустой ответ.');
  } catch (err) {
    console.error('Ошибка Groq:', err);
    ctx.reply('❌ Ошибка при запросе к модели.');
  }
});

// --------------------------------------------------
// Webhook Handler (Vercel)
// --------------------------------------------------

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const update = req.body;
    if (update) {
      bot.handleUpdate(update);
      res.status(200).send('OK');
    } else {
      res.status(400).send('Invalid request');
    }
  } else {
    res.status(405).send('Method Not Allowed');
  }
}

