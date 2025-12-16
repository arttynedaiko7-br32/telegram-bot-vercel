import { Telegraf } from 'telegraf';
import Groq from 'groq-sdk';

/* ========= ENV ========= */
const { GROQ_API_KEY, TELEGRAM_TOKEN } = process.env;
if (!GROQ_API_KEY || !TELEGRAM_TOKEN) {
  throw new Error('Missing environment variables');
}

/* ========= INIT ========= */
const bot = new Telegraf(TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: GROQ_API_KEY });

/* ========= CONFIG ========= */
const CONFIG = {
  MAX_HISTORY: 50,
  PROMPT_HISTORY_LIMIT: 10,
  MAX_QUESTION_LENGTH: 3000,
  MODEL: 'mixtral-8x7b-32768',
  MAX_TOKENS: 500
};

const SYSTEM_PROMPT = `
Ты инженерный AI-ассистент.
Помогаешь решать инженерные, математические задачи и писать код.
Отвечай четко, без догадок и выдумок.
`.trim();

/* ========= MEMORY ========= */
const chats = new Map();

const getChat = chatId => {
  if (!chats.has(chatId)) chats.set(chatId, { history: [] });
  return chats.get(chatId);
};

/* ========= COMMANDS ========= */
bot.start(ctx => ctx.reply('Привет! Я инженерный AI-ассистент 👋'));

bot.command('reset', ctx => {
  chats.delete(ctx.chat.id);
  ctx.reply('Контекст диалога очищен.');
});

/* ========= TEXT HANDLER ========= */
bot.on('text', async ctx => {
  const question = ctx.message.text?.trim();
  if (!question) return;

  if (question.length > CONFIG.MAX_QUESTION_LENGTH) {
    return ctx.reply('Сообщение слишком длинное.');
  }

  const chat = getChat(ctx.chat.id);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...chat.history.slice(-CONFIG.PROMPT_HISTORY_LIMIT),
    { role: 'user', content: question }
  ];

  try {
    const { choices } = await groq.chat.completions.create({
      model: CONFIG.MODEL,
      messages,
      max_tokens: CONFIG.MAX_TOKENS
    });

    const answer = choices?.[0]?.message?.content;
    if (!answer) throw new Error('Empty model response');

    chat.history.push(
      { role: 'user', content: question },
      { role: 'assistant', content: answer }
    );

    chat.history.splice(
      0,
      Math.max(0, chat.history.length - CONFIG.MAX_HISTORY)
    );

    ctx.reply(answer);

  } catch (err) {
    console.error('GROQ ERROR:', err?.message || err);
    ctx.reply('Ошибка генерации ответа.');
  }
});

/* ========= VERCEL HANDLER ========= */
export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
      return res.status(200).end();
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).send('Internal error');
  }
}
