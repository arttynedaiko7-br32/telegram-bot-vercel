import { Telegraf } from 'telegraf';
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
const MAX_HISTORY = 50;            // сколько сообщений храним
const PROMPT_HISTORY_LIMIT = 10;   // сколько отправляем в модель
const MAX_QUESTION_LENGTH = 3000;

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
Ты инженерный AI-ассистент.
Помогаешь решать инженерные, математические задачи, разбираться в коде и писать его.
Формулируй ответ четко и понятно, на поставленные вопросы отвечай
без догадок и выдумок.
`;

/* ================= MEMORY ================= */
const chats = new Map();

function getChat(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      history: []
    });
  }
  return chats.get(chatId);
}

/* ================= COMMANDS ================= */
bot.start(ctx => {
  ctx.reply('Привет! Я инженерный AI-ассистент, готов помочь 👋');
});

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('Контекст диалога очищен.');
});

/* ================= TEXT ================= */
bot.on('text', async ctx => {
  const chat = getChat(ctx.chat.id);
  const question = ctx.message.text?.trim();

  if (!question) return;

  if (question.length > MAX_QUESTION_LENGTH) {
    return ctx.reply('Сообщение слишком длинное.');
  }

  /* ===== BUILD PROMPT ===== */
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...chat.history.slice(-PROMPT_HISTORY_LIMIT),
    { role: 'user', content: question }
  ].filter(m => m.content && m.content.trim().length > 0);

  /* ===== DEBUG ===== */
  console.log(
    'PROMPT DEBUG:',
    messages.map(m => ({ role: m.role, length: m.content.length }))
  );

  try {
    const res = await groq.chat.completions.create({
      model: 'mixtral-8x7b-32768', // стабильная модель
      messages,
      max_tokens: 500
    });

    const answer = res?.choices?.[0]?.message?.content;

    if (!answer) {
      throw new Error('Empty response from model');
    }

    /* ===== SAVE HISTORY ===== */
    chat.history.push({ role: 'user', content: question });
    chat.history.push({ role: 'assistant', content: answer });

    if (chat.history.length > MAX_HISTORY) {
      chat.history.splice(0, chat.history.length - MAX_HISTORY);
    }

    ctx.reply(answer);

  } catch (e) {
    console.error(
      'GROQ ERROR FULL:',
      e?.response?.data || e?.message || e
    );
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
