import { Telegraf } from 'telegraf';
import axios from 'axios';
import pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import mammoth from 'mammoth';
import Groq from 'groq-sdk';
import XLSX from 'xlsx';
import JSZip from 'jszip';

// ================= ENV =================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!GROQ_API_KEY || !TELEGRAM_TOKEN) {
  console.error('Missing ENV variables');
  process.exit(1);
}

// ================= DEBUG =================
const DEBUG = true;
function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });
const bot = new Telegraf(TELEGRAM_TOKEN);

// ================= CONFIG =================
const MAX_HISTORY = 20;
const CHUNK_SIZE = 8000;        // символов
const SUMMARY_TOKENS = 300;
const SYSTEM_PROMPT = 'Ты — интеллектуальный помощник. Работай с большими документами эффективно.';

// ================= MEMORY =================
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    debug('Init chat memory', chatId);
    chats.set(chatId, { history: [], chunks: [], summaries: [] });
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

async function extractPdfChunks(uint8, pagesPerChunk = 5) {
  debug('extractPdfChunks:start', { bytes: uint8.length, pagesPerChunk });
  const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
  debug('PDF loaded', { pages: pdf.numPages });

  const chunks = [];
  let buffer = '';
  let pageCounter = 0;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(' ');

    buffer += pageText + '\n';
    pageCounter++;

    debug('PDF page read', { page: i, length: pageText.length });

    if (pageCounter === pagesPerChunk) {
      chunks.push(buffer);
      debug('PDF chunk created', { index: chunks.length, length: buffer.length });
      buffer = '';
      pageCounter = 0;
    }
  }

  if (buffer.trim()) {
    chunks.push(buffer);
    debug('PDF last chunk', { index: chunks.length, length: buffer.length });
  }

  debug('extractPdfChunks:done', { chunks: chunks.length });
  return chunks;
}

async function summarizeChunk(text) {
  debug('summarizeChunk:start', { length: text.length });
  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'Сожми текст до ключевых тезисов.' },
      { role: 'user', content: text }
    ],
    max_tokens: SUMMARY_TOKENS,
    temperature: 0.2
  });

  const result = res.choices[0].message.content;
  debug('summarizeChunk:done', { resultLength: result.length });
  return result;
}

async function hierarchicalSummary(chunks, ctx) {
  debug('hierarchicalSummary:start', { chunks: chunks.length });
  const summaries = [];
  let i = 1;

  for (const chunk of chunks) {
    ctx.reply(`⏳ Обработка части ${i}/${chunks.length}`);
    debug('hierarchicalSummary:chunk', { index: i, length: chunk.length });
    summaries.push(await summarizeChunk(chunk));
    i++;
  }

  debug('hierarchicalSummary:first-level-done', { summaries: summaries.length });
  const final = await summarizeChunk(summaries.join('\n'));
  debug('hierarchicalSummary:final-done', { length: final.length });

  return { summaries, final };
}

function findRelevant(chunks, query) {
  debug('findRelevant:start', { query, chunks: chunks.length });
  const found = chunks.filter(c => c.toLowerCase().includes(query.toLowerCase()));
  debug('findRelevant:done', { matched: found.length });
  return found.slice(0, 3).join('\n');
}

// ================= START =================
bot.start(ctx => {
  ctx.reply('📄 Отправь большой файл (PDF/DOCX/XLSX/PPTX).\n\nКоманды:\n/summary — краткое резюме\n/ask вопрос — вопрос по документу');
});

// ================= DOCUMENT =================
bot.on('document', async (ctx) => {
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
    ctx.reply('📥 Файл получен, начинаю обработку...');

    if (/\.pdf$/i.test(name)) {
      chat.chunks = await extractPdfChunks(uint8);
    }
    else if (/\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer: Buffer.from(uint8) });
      chat.chunks = chunkText(r.value || '');
    }
    else if (/\.xlsx$/i.test(name)) {
      const wb = XLSX.read(uint8, { type: 'array' });
      const text = wb.SheetNames.map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s])).join('\n');
      chat.chunks = chunkText(text);
    }
    else if (/\.pptx$/i.test(name)) {
      const zip = await JSZip.loadAsync(uint8);
      let text = '';
      for (const f of Object.keys(zip.files).filter(f => f.includes('slide'))) {
        const xml = await zip.files[f].async('string');
        (xml.match(/<a:t>(.*?)<\/a:t>/g) || []).forEach(t => {
          text += t.replace(/<[^>]+>/g, '') + ' ';
        });
      }
      chat.chunks = chunkText(text);
    }
    else {
      return ctx.reply('❌ Формат не поддерживается');
    }

    debug('Document processed', { chunks: chat.chunks.length });
    ctx.reply(`✅ Файл разобран. Частей: ${chat.chunks.length}\nИспользуй /summary или /ask`);
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Ошибка обработки файла');
  }
});

// ================= SUMMARY =================
bot.command('summary', async (ctx) => {
  const chat = getChat(ctx.chat.id);
  if (!chat.chunks.length) return ctx.reply('Нет загруженного документа');

  ctx.reply('🧠 Создаю резюме документа...');
  const { summaries, final } = await hierarchicalSummary(chat.chunks, ctx);
  chat.summaries = summaries;

  ctx.reply('📌 Итоговое резюме:\n\n' + final);
});

// ================= ASK =================
bot.command('ask', async (ctx) => {
  const chat = getChat(ctx.chat.id);
  if (!chat.chunks.length) return ctx.reply('Нет загруженного документа');

  const query = ctx.message.text.replace('/ask', '').trim();
  if (!query) return ctx.reply('Напиши вопрос после /ask');

  const relevant = findRelevant(chat.chunks, query);
  if (!relevant) return ctx.reply('Ничего не найдено');

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Контекст:\n${relevant}\n\nВопрос: ${query}` }
    ],
    max_tokens: 400
  });

  ctx.reply(res.choices[0].message.content);
});

// ================= WEBHOOK =================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
}