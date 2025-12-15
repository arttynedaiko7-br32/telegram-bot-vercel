import { Telegraf } from 'telegraf';
import axios from 'axios';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import mammoth from 'mammoth';
import Groq from 'groq-sdk';
import XLSX from 'xlsx';
import JSZip from 'jszip';

// ================= PDFJS FIX (Node/Vercel) =================
pdfjsLib.GlobalWorkerOptions.workerSrc = null;

// ================= ENV =================
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? '';

// ================= DEBUG =================
const DEBUG = true;
function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });
const bot = new Telegraf(TELEGRAM_TOKEN);

// ================= CONFIG =================
const CHUNK_SIZE = 8000;
const SUMMARY_TOKENS = 300;
const MAX_HISTORY = 20; // диалоговая память

const SYSTEM_PROMPT = `
Ты — инженерный AI-ассистент.

Твоя задача:
— помогать решать инженерные и технические задачи
— писать, анализировать и исправлять код
— объяснять архитектуру, алгоритмы и логику решений
— разбирать ошибки и логи

Учитывай контекст диалога.
Файлы используй только как дополнительный контекст.
Отвечай чётко и по делу.
`.trim();

// ================= MEMORY =================
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    debug('Init chat memory', chatId);
    chats.set(chatId, {
      chunks: [],
      summaries: [],
      history: [] // диалоговая память
    });
  }
  return chats.get(chatId);
}

// ================= UTILS =================
function chunkText(text, size = CHUNK_SIZE) {
  debug('chunkText:start', { length: text.length, size });
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  debug('chunkText:done', { chunks: chunks.length });
  return chunks;
}

// ================= PDF =================
async function extractPdfChunks(uint8, pagesPerChunk = 5) {
  debug('extractPdfChunks:start', { bytes: uint8.length });

  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    disableWorker: true,
    useSystemFonts: true
  });

  const pdf = await loadingTask.promise;
  debug('PDF loaded', { pages: pdf.numPages });

  const chunks = [];
  let buffer = '';
  let counter = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const pageText = content.items.map(it => it.str).join(' ');
    buffer += pageText + '\n';
    counter++;

    debug(`PDF page ${i}`, { length: pageText.length });

    if (counter === pagesPerChunk) {
      chunks.push(buffer);
      debug('PDF chunk created', { index: chunks.length, length: buffer.length });
      buffer = '';
      counter = 0;
    }
  }

  if (buffer.trim()) {
    chunks.push(buffer);
    debug('PDF last chunk', { index: chunks.length, length: buffer.length });
  }

  debug('extractPdfChunks:done', { chunks: chunks.length });
  return chunks;
}

// ================= COMMANDS =================
bot.start(ctx => {
  ctx.reply('Инженерный AI-ассистент для решения технических задач и написания кода.');
});

bot.command('help', ctx => {
  ctx.reply(`Доступные команды:\n\n/start — информация о боте\n/help — список команд\n/reset — очистить память и контекст\n/clear — очистить историю чата\n\nМожно задавать вопросы по инженерии и коду. Файлы используются как контекст.`);
});

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('🧹 Контекст и память очищены.');
});

bot.command('clear', async ctx => {
  const chatId = ctx.chat.id;
  const lastMessageId = ctx.message.message_id;

  for (let i = lastMessageId; i > 0; i--) {
    try {
      await ctx.telegram.deleteMessage(chatId, i);
    } catch {
      break;
    }
  }
});

// ================= DOCUMENT =================
bot.on('document', async ctx => {
  const chat = getChat(ctx.chat.id);
  chat.chunks = [];
  chat.summaries = [];

  try {
    const doc = ctx.message.document;
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const resp = await axios.get(link.href, { responseType: 'arraybuffer' });
    const uint8 = new Uint8Array(resp.data);
    const name = doc.file_name || '';

    debug('Document received', { name, size: uint8.length });
    ctx.reply('Файл получен, обрабатываю...');

    if (/\.pdf$/i.test(name)) {
      chat.chunks = await extractPdfChunks(uint8);
    } else if (/\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer: Buffer.from(uint8) });
      chat.chunks = chunkText(r.value || '');
    } else if (/\.xlsx$/i.test(name)) {
      const wb = XLSX.read(uint8, { type: 'array' });
      const text = wb.SheetNames.map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n');
      chat.chunks = chunkText(text);
    } else if (/\.pptx$/i.test(name)) {
      const zip = await JSZip.loadAsync(uint8);
      let text = '';
      for (const f of Object.keys(zip.files).filter(f => f.includes('slide'))) {
        const xml = await zip.files[f].async('string');
        (xml.match(/<a:t>(.*?)<\/a:t>/g) || []).forEach(t => {
          text += t.replace(/<[^>]+>/g, '') + ' ';
        });
      }
      chat.chunks = chunkText(text);
    } else {
      return ctx.reply('Формат файла не поддерживается');
    }

    chat.history.push({ role: 'user', content: `Загружен файл ${name}` });
    if (chat.history.length > MAX_HISTORY) chat.history.shift();

    debug('Document processed', { chunks: chat.chunks.length });
    ctx.reply(`Готово. Частей: ${chat.chunks.length}`);
  } catch (e) {
    console.error(e);
    ctx.reply('Ошибка обработки файла');
  }
});

// ================= ASK =================
bot.command('ask', async ctx => {
  const chat = getChat(ctx.chat.id);
  if (!chat.chunks.length) return ctx.reply('Нет загруженного контекста');

  const query = ctx.message.text.replace('/ask', '').trim();
  if (!query) return ctx.reply('Напиши вопрос после /ask');

  chat.history.push({ role: 'user', content: query });
  if (chat.history.length > MAX_HISTORY) chat.history.shift();

  const context = findRelevant(chat.chunks, query);
  if (!context) return ctx.reply('Ничего не найдено');

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...chat.history,
      { role: 'user', content: `Контекст документа:\n${context}` }
    ],
    max_tokens: 400
  });

  const answer = res.choices[0].message.content;
  chat.history.push({ role: 'assistant', content: answer });
  if (chat.history.length > MAX_HISTORY) chat.history.shift();

  ctx.reply(answer);
});


// ================= WEBHOOK =================
export default async function handler(req, res) {
  try {
    if (!GROQ_API_KEY || !TELEGRAM_TOKEN) {
      console.error('Missing ENV variables');
      return res.status(500).json({
        error: 'Server misconfiguration'
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');

  } catch (err) {
    console.error('Handler crash:', err);
    return res.status(500).send('Internal Server Error');
  }
}
