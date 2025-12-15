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
Если есть документ — используй его как контекст.
Отвечай чётко и по делу.
`;

/* ================= MEMORY ================= */
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, { history: [], chunks: [] });
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
  return chunks
    .filter(c => c.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 3)
    .join('\n');
}

/* ================= PDF ================= */
async function extractPdfChunks(uint8) {
  const pdf = await pdfjs.getDocument({ data: uint8 }).promise;
  let text = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }

  return chunkText(text);
}

/* ================= COMMANDS ================= */
bot.start(ctx => {
  ctx.reply('Инженерный AI-ассистент. Задай вопрос или загрузи файл.');
});

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('Контекст и память очищены.');
});

/* ================= DOCUMENT ================= */
bot.on('document', async ctx => {
  const chat = getChat(ctx.chat.id);
  chat.chunks = [];

  await ctx.reply('Файл получен, обрабатываю…');

  try {
    const file = ctx.message.document;
    const link = await ctx.telegram.getFileLink(file.file_id);
    const resp = await axios.get(link.href, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(resp.data);
    const uint8 = new Uint8Array(resp.data);
    const name = file.file_name || '';

    if (/\.pdf$/i.test(name)) {
      chat.chunks = await extractPdfChunks(uint8);
    }
    else if (/\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer });
      chat.chunks = chunkText(r.value || '');
    }
    else if (/\.xlsx$/i.test(name)) {
      const wb = XLSX.read(uint8, { type: 'array' });
      const text = wb.SheetNames
        .map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s]))
        .join('\n');
      chat.chunks = chunkText(text);
    }
    else if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) {
      chat.chunks = chunkText(buffer.toString('utf8'));
    }
    else if (/\.pptx$/i.test(name)) {
      const zip = await JSZip.loadAsync(uint8);
      let text = '';
      for (const f of Object.keys(zip.files).filter(f => f.includes('slide'))) {
        const xml = await zip.files[f].async('string');
        (xml.match(/<a:t>(.*?)<\/a:t>/g) || [])
          .forEach(t => text += t.replace(/<[^>]+>/g, '') + ' ');
      }
      chat.chunks = chunkText(text);
    }
    else {
      return ctx.reply('Формат файла не поддерживается.');
    }

    ctx.reply(`Готово. Загружено частей: ${chat.chunks.length}`);
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

  chat.history.push({ role: 'user', content: question });
  if (chat.history.length > MAX_HISTORY) {
    chat.history.splice(0, chat.history.length - MAX_HISTORY);
  }

  const context = chat.chunks.length
    ? `Контекст документа:\n${findRelevant(chat.chunks, question)}`
    : '';

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...chat.history,
      ...(context ? [{ role: 'user', content: context }] : [])
    ],
    max_tokens: 500
  });

  const answer = res.choices[0].message.content;

  chat.history.push({ role: 'assistant', content: answer });
  if (chat.history.length > MAX_HISTORY) {
    chat.history.splice(0, chat.history.length - MAX_HISTORY);
  }

  ctx.reply(answer);
});

/* ================= VERCEL WEBHOOK ================= */
export default async function handler(req, res) {
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body, res);
    return res.status(200).end();
  }
  res.status(200).send('OK');
}
