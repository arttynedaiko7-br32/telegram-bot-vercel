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
const CHUNK_SIZE = 4000;
const MAX_HISTORY = 50;
const MAX_DOC_CONTEXT = 6000;

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
Ты инженерный AI-ассистент.
Отвечай строго по предоставленному контексту.
Если информации в документе нет — прямо скажи об этом.
Без догадок и выдумок.
`;

/* ================= MEMORY ================= */
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      history: [],
      documentChunks: [],
      documentName: '',
      lastDocQuestion: null
    });
  }
  return chats.get(chatId);
}

/* ================= UTILS ================= */
function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function findRelevantChunks(chunks, query, limit = 3) {
  const words = query
    .toLowerCase()
    .split(/[\s\-_,.]+/)
    .filter(w => w.length > 3);

  if (!words.length) return [];

  return chunks
    .map(chunk => {
      const score = words.reduce(
        (acc, w) => acc + (chunk.toLowerCase().includes(w) ? 1 : 0),
        0
      );
      return { chunk, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.chunk);
}

function normalizeHistory(history) {
  return history.slice(-MAX_HISTORY);
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
  ctx.reply('Загрузи DOCX файл и задавай вопросы по нему.');
});

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('Контекст очищен.');
});

/* ================= DOCUMENT (DOCX ONLY) ================= */
bot.on('document', async ctx => {
  const chat = getChat(ctx.chat.id);
  const file = ctx.message.document;

  if (!/\.docx$/i.test(file.file_name || '')) {
    return ctx.reply('Поддерживаются только файлы DOCX.');
  }

  await ctx.reply('Файл получен, обрабатываю…');

  try {
    const buffer = await downloadTelegramFile(ctx, file.file_id);
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value || '';

    if (!text.trim()) {
      return ctx.reply('Не удалось извлечь текст из файла.');
    }

    chat.documentName = file.file_name;
    chat.documentChunks = chunkText(text);
    chat.lastDocQuestion = null;

    ctx.reply(
      `Готово ✅\nФайл: ${file.file_name}\nЧанков: ${chat.documentChunks.length}`
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

  /* ===== DOCUMENT CONTEXT ===== */
  if (chat.documentChunks.length) {
    const docQuery = chat.lastDocQuestion
      ? `${chat.lastDocQuestion} ${question}`
      : question;

    const relevantChunks = findRelevantChunks(
      chat.documentChunks,
      docQuery
    );

    if (relevantChunks.length) {
      let docContext = relevantChunks.join('\n\n');

      if (docContext.length > MAX_DOC_CONTEXT) {
        docContext = docContext.slice(0, MAX_DOC_CONTEXT);
      }

      messages.push({
        role: 'user',
        content: `
Фрагменты документа "${chat.documentName}":

${docContext}
`
      });
    }

    chat.lastDocQuestion = question;
  }

  /* ===== DIALOG HISTORY ===== */
  const history = normalizeHistory(chat.history);
  messages.push(...history);

  messages.push({ role: 'user', content: question });

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
