import { Telegraf } from 'telegraf';
import axios from 'axios';
import pdfjs from 'pdfjs-dist/legacy/build/pdf.js';
import mammoth from 'mammoth';
import Groq from 'groq-sdk';
import XLSX from 'xlsx';
import JSZip from 'jszip';

/* ================= ENV ================= */
const { GROQ_API_KEY, TELEGRAM_TOKEN } = process.env;

if (!GROQ_API_KEY || !TELEGRAM_TOKEN) {
  throw new Error('Missing ENV variables');
}

/* ================= INIT ================= */
const bot = new Telegraf(TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: GROQ_API_KEY });

/* ================= CONFIG ================= */
const CHUNK_SIZE = 6000;
const MAX_HISTORY = 50;

const SYSTEM_PROMPT = `
Ты инженерный AI-ассистент.
Помогаешь с кодом и техническими задачами.
Если есть документ — используй его как основной источник знаний.
Отвечай чётко и по делу.
`;

/* ================= MEMORY ================= */
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      history: [],
      chunks: [],
      documentText: '',
      documentName: ''
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

function findRelevant(chunks, query) {
  const q = query.toLowerCase();
  const matches = chunks.filter(c => c.toLowerCase().includes(q));
  return matches.slice(0, 3).join('\n');
}

/* ================= FILE DOWNLOAD ================= */
async function downloadTelegramFile(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

  const resp = await axios.get(url, { responseType: 'arraybuffer' });

  if (resp.status !== 200 || !resp.data) {
    throw new Error('Failed to download file');
  }

  return Buffer.from(resp.data);
}

/* ================= PDF ================= */
async function extractPdfText(uint8) {
  const pdf = await pdfjs.getDocument({ data: uint8 }).promise;
  let text = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }

  return text;
}

/* ================= COMMANDS ================= */
bot.start(ctx => {
  ctx.reply('Инженерный AI-ассистент. Задай вопрос или загрузи файл.');
});

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('Контекст и загруженные документы очищены.');
});

/* ================= DOCUMENT HANDLER ================= */
bot.on('document', async ctx => {
  const chat = getChat(ctx.chat.id);
  const file = ctx.message.document;

  await ctx.reply('Файл получен, обрабатываю…');

  try {
    const buffer = await downloadTelegramFile(ctx, file.file_id);
    const uint8 = new Uint8Array(buffer);
    const name = file.file_name || '';

    let text = '';

    if (/\.pdf$/i.test(name)) {
      text = await extractPdfText(uint8);

    } else if (/\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer });
      text = r.value || '';

    } else if (/\.xlsx$/i.test(name)) {
      const wb = XLSX.read(uint8, { type: 'array' });
      text = wb.SheetNames
        .map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s]))
        .join('\n');

    } else if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) {
      text = buffer.toString('utf8');

    } else if (/\.pptx$/i.test(name)) {
      const zip = await JSZip.loadAsync(uint8);
      for (const f of Object.keys(zip.files).filter(f => f.includes('slide'))) {
        const xml = await zip.files[f].async('string');
        (xml.match(/<a:t>(.*?)<\/a:t>/g) || [])
          .forEach(t => {
            text += t.replace(/<[^>]+>/g, '') + ' ';
          });
      }

    } else {
      return ctx.reply('Формат файла не поддерживается.');
    }

    if (!text.trim()) {
      return ctx.reply('Не удалось извлечь текст из файла.');
    }

    chat.documentText = text;
    chat.documentName = name;
    chat.chunks = chunkText(text);

    ctx.reply(`Готово ✅\nФайл: ${name}\nЧастей: ${chat.chunks.length}`);
  } catch (e) {
    console.error('Document error:', e);
    ctx.reply('Ошибка обработки файла.');
  }
});

/* ================= TEXT HANDLER ================= */
bot.on('text', async ctx => {
  const chat = getChat(ctx.chat.id);
  const question = ctx.message.text.trim();
  if (!question) return;

  if (!chat.chunks.length) {
    return ctx.reply(
      'Мне не был предоставлен файл. Пожалуйста, загрузите документ.'
    );
  }

  chat.history.push({ role: 'user', content: question });
  if (chat.history.length > MAX_HISTORY) {
    chat.history.splice(0, chat.history.length - MAX_HISTORY);
  }

  let documentContext = findRelevant(chat.chunks, question);

  // если релевантных чанков нет — даём начало документа
  if (!documentContext) {
    documentContext = chat.chunks.slice(0, 2).join('\n');
  }

  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'system',
        content:
          `Ниже приведён текст загруженного документа "${chat.documentName}".
Используй его как основной источник информации:\n\n${documentContext}`
      },
      ...chat.history
    ];

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 500
    });

    const answer = res.choices[0].message.content;

    chat.history.push({ role: 'assistant', content: answer });
    if (chat.history.length > MAX_HISTORY) {
      chat.history.splice(0, chat.history.length - MAX_HISTORY);
    }

    ctx.reply(answer);
  } catch (e) {
    console.error('LLM error:', e);
    ctx.reply('Ошибка генерации ответа.');
  }
});

/* ================= VERCEL WEBHOOK ================= */
bot.on('text', async ctx => {
  const chat = getChat(ctx.chat.id);
  const question = ctx.message.text.trim();
  if (!question) return;

  chat.history.push({ role: 'user', content: question });
  if (chat.history.length > MAX_HISTORY) {
    chat.history.splice(0, chat.history.length - MAX_HISTORY);
  }

  let messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  // 📄 Документ есть → добавляем контекст
  if (chat.chunks.length) {
    let documentContext = findRelevant(chat.chunks, question);

    if (!documentContext) {
      documentContext = chat.chunks.slice(0, 2).join('\n');
    }

    messages.push({
      role: 'system',
      content:
        `Ниже приведён текст загруженного документа "${chat.documentName}".
Используй его ТОЛЬКО если это релевантно вопросу:\n\n${documentContext}`
    });
  }

  messages.push(...chat.history);

  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 500
    });

    const answer = res.choices[0].message.content;

    chat.history.push({ role: 'assistant', content: answer });
    if (chat.history.length > MAX_HISTORY) {
      chat.history.splice(0, chat.history.length - MAX_HISTORY);
    }

    ctx.reply(answer);
  } catch (e) {
    console.error('LLM error:', e);
    ctx.reply('Ошибка генерации ответа.');
  }
});

