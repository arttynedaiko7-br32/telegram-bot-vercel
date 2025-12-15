import { Telegraf } from 'telegraf';
import axios from 'axios';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import Groq from 'groq-sdk';
import XLSX from 'xlsx';
import JSZip from 'jszip';

/* ================= ENV ================= */
const { GROQ_API_KEY, TELEGRAM_TOKEN } = process.env;

if (!GROQ_API_KEY || !TELEGRAM_TOKEN) {
  throw new Error('Missing environment variables');
}

/* ================= INIT ================= */
const bot = new Telegraf(TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: GROQ_API_KEY });

/* ================= CONFIG ================= */
const CHUNK_SIZE = 6000;
const MAX_HISTORY = 50;
const MAX_DOC_CONTEXT = 4000;

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
Ты инженерный AI-ассистент.

Если пользователь загрузил документ:
- считай его основным источником истины
- отвечай ТОЛЬКО на основе документа, если вопрос о нём
- если вопрос общий (например "о чём файл?") — дай краткое резюме документа
- если информации недостаточно — прямо скажи об этом

Отвечай чётко, по делу, без выдумок.
`;

/* ================= MEMORY ================= */
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      history: [],
      chunks: [],
      documentName: '',
      searchStep: 0
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

function findRelevant(chunks, query) {
  const words = query
    .toLowerCase()
    .split(/[\s\-_,.]+/)
    .filter(w => w.length > 3);

  if (!words.length) return '';

  return chunks
    .filter(chunk => {
      const c = chunk.toLowerCase();
      return words.some(w => c.includes(w));
    })
    .slice(0, 3)
    .join('\n');
}

function isOverviewQuestion(text) {
  return /о чем|про что|что за файл|кратко|суть|описание/i.test(text);
}

/* ================= ITERATIVE SEARCH ================= */
function getIterativeDocContext(chat) {
  const chunks = chat.chunks;
  const n = chunks.length;
  const STEP = 2;

  if (!n) return null;

  if (chat.searchStep === 0) {
    chat.searchStep++;
    return [
      chunks[0],
      chunks[Math.floor(n / 2)],
      chunks[n - 1]
    ].filter(Boolean).join('\n');
  }

  const step = chat.searchStep - 1;
  const left = step * STEP;
  const right = n - STEP - step * STEP;

  chat.searchStep++;

  if (left >= right) return null;

  return [
    ...chunks.slice(left, left + STEP),
    ...chunks.slice(right, right + STEP)
  ].filter(Boolean).join('\n');
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

/* ================= PDF ================= */
async function extractPdfText(buffer) {
  try {
    const data = await pdf(buffer, { pagerender: null });

    if (!data.text || !data.text.trim()) {
      return '[PDF не содержит извлекаемый текст (возможно, это скан)]';
    }

    return data.text.trim();
  } catch (e) {
    console.error('PDF parse error:', e);
    throw new Error('Не удалось обработать PDF');
  }
}

/* ================= COMMANDS ================= */
bot.start(ctx => {
  ctx.reply('Инженерный AI-ассистент. Задай вопрос или загрузи файл.');
});

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('Контекст очищен.');
});

/* ================= DOCUMENT ================= */
bot.on('document', async ctx => {
  const chat = getChat(ctx.chat.id);
  const file = ctx.message.document;

  await ctx.reply('Файл получен, обрабатываю…');

  try {
    const buffer = await downloadTelegramFile(ctx, file.file_id);
    const name = file.file_name || '';
    let text = '';

    if (/\.pdf$/i.test(name)) {
      text = await extractPdfText(buffer);
    } else if (/\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer });
      text = r.value || '';
    } else if (/\.xlsx$/i.test(name)) {
      const wb = XLSX.read(buffer, { type: 'array' });
      text = wb.SheetNames
        .map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s]))
        .join('\n');
    } else if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) {
      text = buffer.toString('utf8');
    } else if (/\.pptx$/i.test(name)) {
      const zip = await JSZip.loadAsync(buffer);
      for (const f of Object.keys(zip.files).filter(f => f.includes('slide'))) {
        const xml = await zip.files[f].async('string');
        (xml.match(/<a:t>(.*?)<\/a:t>/g) || []).forEach(t => {
          text += t.replace(/<[^>]+>/g, '') + ' ';
        });
      }
    } else {
      return ctx.reply('Формат файла не поддерживается.');
    }

    if (!text.trim()) {
      return ctx.reply('Не удалось извлечь текст из файла.');
    }

    chat.documentName = name;
    chat.chunks = chunkText(text);
    chat.searchStep = 0;

    ctx.reply(`Готово ✅\nФайл: ${name}\nЧастей: ${chat.chunks.length}`);
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

  chat.searchStep = 0;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  // 📄 Документ как КОНТЕКСТ
  if (chat.chunks.length) {
    let docContext;

    if (isOverviewQuestion(question)) {
      docContext = chat.chunks.slice(0, 5).join('\n');
    } else {
      docContext =
        findRelevant(chat.chunks, question) ||
        getIterativeDocContext(chat) ||
        chat.chunks.slice(0, 3).join('\n');
    }

    if (docContext.length > MAX_DOC_CONTEXT) {
      docContext =
        docContext.slice(0, MAX_DOC_CONTEXT) +
        '\n\n[Документ обрезан для контекста]';
    }

    messages.push({
      role: 'user',
      content: `
Ниже приведён фрагмент документа "${chat.documentName}".
Используй этот текст ТОЛЬКО как источник данных для ответа.

=== НАЧАЛО ДОКУМЕНТА ===
${docContext}
=== КОНЕЦ ДОКУМЕНТА ===
`
    });
  }

  // 🗣 История БЕЗ текущего вопроса
  messages.push(
    ...chat.history.slice(-5)
  );

  // 🧠 Текущий вопрос — ОДИН РАЗ
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

    // 💾 сохраняем историю ПОСЛЕ успешного ответа
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
