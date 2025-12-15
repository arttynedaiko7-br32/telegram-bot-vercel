import { Telegraf } from 'telegraf';
import axios from 'axios';
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
const MAX_HISTORY = 50;
const MAX_DOC_LENGTH = 8000;

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
Ты инженерный AI-ассистент.

Если пользователь загрузил документ:
- используй его как основной источник
- не выдумывай факты
- если информации нет — прямо скажи об этом

Отвечай чётко и по делу.
`;

/* ================= MEMORY ================= */
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      history: [],
      documentText: '',
      documentName: ''
    });
  }
  return chats.get(chatId);
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

    if (/\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer });
      text = r.value || '';

    } else if (/\.xlsx$/i.test(name)) {
      const wb = XLSX.read(buffer, { type: 'array' });
      text = wb.SheetNames
        .map(s => XLSX.utils.sheet_to_csv(wb.Sheets[s]))
        .join('\n');

    } else if (/\.csv$|\.txt$/i.test(name)) {
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

    // ограничиваем размер документа
    if (text.length > MAX_DOC_LENGTH) {
      text = text.slice(0, MAX_DOC_LENGTH) + '\n\n[Документ обрезан]';
    }

    chat.documentName = name;
    chat.documentText = text;

    ctx.reply(`Готово ✅\nФайл: ${name}`);
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  if (chat.documentText) {
    messages.push({
      role: 'user',
      content: `
Ниже приведён текст документа "${chat.documentName}".
Используй его как источник информации.

=== ДОКУМЕНТ ===
${chat.documentText}
=== КОНЕЦ ДОКУМЕНТА ===
`
    });
  }

  messages.push(
    ...chat.history.slice(-6),
    { role: 'user', content: question }
  );

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
