import { Telegraf } from 'telegraf';
import axios from 'axios';
import mammoth from 'mammoth';
import Groq from 'groq-sdk';

/* ================= ENV ================= */
const { GROQ_API_KEY, TELEGRAM_TOKEN } = process.env;

if (!GROQ_API_KEY || !TELEGRAM_TOKEN) {
  throw new Error('Missing environment variables');
}

/* ================= INIT ================= */
const bot = new Telegraf(TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: GROQ_API_KEY });

/* ================= CONFIG ================= */
const MAX_HISTORY = 50;
const CHUNK_SIZE = 1200;          // размер одного чанка
const MAX_CHUNKS_IN_PROMPT = 3;   // максимум чанков за раз

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
Ты инженерный AI-ассистент.
Отвечай чётко, по делу, без выдумок.
`;

/* ================= MEMORY ================= */
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      history: [],
      documentChunks: [],
      documentName: ''
    });
  }
  return chats.get(chatId);
}

/* ================= HELPERS ================= */
function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function findRelevantChunks(chunks, query) {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3);

  if (!words.length) return [];

  return chunks.filter(chunk => {
    const lc = chunk.toLowerCase();
    return words.some(w => lc.includes(w));
  });
}

function pickChunks(chunks, question) {
  if (!chunks.length) return [];

  const relevant = findRelevantChunks(chunks, question);

  if (relevant.length) {
    return relevant.slice(0, MAX_CHUNKS_IN_PROMPT);
  }

  // fallback: начало + середина + конец
  const middle = Math.floor(chunks.length / 2);

  return [
    chunks[0],
    chunks[middle],
    chunks[chunks.length - 1]
  ]
    .filter(Boolean)
    .slice(0, MAX_CHUNKS_IN_PROMPT);
}

function normalizeHistory(history) {
  const clean = [];
  for (const msg of history) {
    if (!clean.length || clean[clean.length - 1].role !== msg.role) {
      clean.push(msg);
    }
  }
  return clean;
}

/* ================= FILE DOWNLOAD ================= */
async function downloadTelegramFile(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
  const resp = await axios.get(url, { responseType: 'arraybuffer' });

  if (resp.status !== 200) {
    throw new Error('File download failed');
  }

  return Buffer.from(resp.data);
}

/* ================= COMMANDS ================= */
bot.start(ctx => {
  ctx.reply('Инженерный AI-ассистент. Задай вопрос или загрузи DOCX файл.');
});

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('Контекст очищен.');
});

/* ================= DOCUMENT (DOCX ONLY) ================= */
bot.on('document', async ctx => {
  const chat = getChat(ctx.chat.id);
  const file = ctx.message.document;

  await ctx.reply('Файл получен, обрабатываю…');

  try {
    const name = file.file_name || '';

    if (!/\.docx$/i.test(name)) {
      return ctx.reply('Поддерживаются только файлы .docx');
    }

    const buffer = await downloadTelegramFile(ctx, file.file_id);
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value || '';

    if (!text.trim()) {
      return ctx.reply('Не удалось извлечь текст из файла.');
    }

    chat.documentName = name;
    chat.documentChunks = chunkText(text);
    chat.history = [];

    ctx.reply(
      `Готово ✅\nФайл: ${name}\nЧанков: ${chat.documentChunks.length}`
    );
  } catch (e) {
    console.error('Document error:', e);
    ctx.reply('Ошибка обработки файла.');
  }
});

/* ================= TEXT ================= */
bot.on('text', async ctx => {
  const chat = getChat(ctx.chat.id);
  const question = ctx.message.text.trim();
  if (!question) return;

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // 👉 добавляем ТОЛЬКО нужные чанки
  if (chat.documentChunks.length) {
    const chunksForPrompt = pickChunks(
      chat.documentChunks,
      question
    );

    for (const chunk of chunksForPrompt) {
      messages.push({
        role: 'user',
        content: chunk
      });
    }
  }

  messages.push(
    ...normalizeHistory(chat.history).slice(-MAX_HISTORY)
  );

  messages.push({
    role: 'user',
    content: question
  });

  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 500
    });

    const answer = res.choices[0].message.content;

    chat.history.push({ role: 'user', content: question });
    chat.history.push({ role: 'assistant', content: answer });

    if (chat.history.length > MAX_HISTORY) {
      chat.history.splice(0, chat.history.length - MAX_HISTORY);
    }

    ctx.reply(answer);
  } catch (e) {
    console.error('LLM error FULL:', e?.response?.data || e);
    ctx.reply('Ошибка генерации ответа.');
  }
});

/* ================= VERCEL HANDLER ================= */
export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      res.status(200).end();
    } else {
      res.status(200).send('OK');
    }
  } catch (e) {
    console.error('Handler error:', e);
    res.status(500).send('Internal error');
  }
}
