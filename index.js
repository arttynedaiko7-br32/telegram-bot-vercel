import "dotenv/config";
import { Telegraf } from "telegraf";
import Groq from "groq-sdk";
import axios from 'axios'; 
import pdfParse from 'pdf-parse';  

const StatusContext = Object.freeze({
  TEXT: 0,
  PDF:1
});
let orderStatus = StatusContext.TEXT;

// ---------- ENV ----------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!GROQ_API_KEY) {
  console.error("Ошибка: переменная окружения GROQ_API_KEY не задана.");
  process.exit(1);
}
if (!TELEGRAM_TOKEN) {
  console.error("Ошибка: переменная окружения TELEGRAM_TOKEN не задана.");
  process.exit(1);
}

// Инициализация Groq с вашим API ключом
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Инициализация бота
const bot = new Telegraf(TELEGRAM_TOKEN);


// ---------- MEMORY ----------
const memory = new Map();
const MAX_HISTORY = 20; // Максимальное количество сообщений в истории
const botMessages = new Map(); // Сохранение ID сообщений, отправленных ботом

// ---------- CONTEXT PDF ----------
let pdfText = "";
let conversationHistory = [];


const SYSTEM_PROMPT =
  "Ты — интеллектуальный ассистент девушка. Запоминай контекст диалога. Отвечай чётко и по делу.";

// ОБРАБОТКА ПОЛУЧЕНИЯ ДОКУМЕНТА
bot.on('document', async (ctx) => {
  const fileId = ctx.message.document.file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);

  // Скачиваем PDF
  const response = await fetch(fileLink);
  const buffer = await response.buffer();

  // Извлекаем текст из PDF
  const text = await extractTextFromPDF(buffer);
  if (text) {
    pdfText = text;
    ctx.reply('Файл успешно обработан! Задавайте ваши вопросы.');
  } else {
    ctx.reply('Не удалось извлечь текст из файла. Попробуйте снова.');
  }
});

// Функция для извлечения текста из PDF
async function extractTextFromPDF(fileBuffer) {
  try {
    const data = await pdfParse(fileBuffer);
    return data.text; // возвращает весь текст из PDF
  } catch (error) {
    console.error('Ошибка при парсинге PDF:', error);
    return null;
  }
}

// Функция для поиска подходящей части текста
function getRelevantTextForQuestion(question) {
  const textChunks = pdfText.split('\n\n'); // Разделяем текст на абзацы
  let relevantText = '';

  // Поиск подходящего абзаца, который соответствует вопросу
  textChunks.forEach(chunk => {
    if (chunk.toLowerCase().includes(question.toLowerCase())) {
      relevantText += chunk + '\n\n'; // Добавляем в ответ
    }
  });

  return relevantText || 'Извините, я не нашел подходящей информации.';
}

// --------------------------------------------------
// START / HELP
// --------------------------------------------------
bot.start((ctx) => {
  console.log("Бот запущен. Приветственное сообщение отправлено.");
  ctx.reply(
`👋 Привет, ${ctx.from.first_name || "друг"}!

Команды:
/help — список команд
/reset — очистить память
/clear — очистить историю чата

Задавай вопросы, и я постараюсь помочь!`
  ).catch(err => console.error("Ошибка при отправке приветственного сообщения:", err));
});

bot.command("help", (ctx) => {
  console.log("Команда /help вызвана");
  ctx.reply(
    "📌 Доступные команды:\n" +
      "/start — запуск\n" +
      "/help — список команд\n" +
      "/reset — сбросить память\n" +
      "/clear — очистить историю чата\n"
  );
});
/////


// --------------------------------------------------
// СБРОС ПАМЯТИ
// --------------------------------------------------
bot.command("reset", (ctx) => {
  const chatId = ctx.chat.id;
  memory.delete(chatId);
  pdfText = "";  // Очищаем текст PDF
  conversationHistory = [];  // Очищаем историю сообщений
  ctx.reply("Контекст был сброшен!");
});

bot.command("clear", async (ctx) => {
  const chatId = ctx.chat.id;

  // Удаление всех сообщений, отправленных ботом в этом чате
  if (botMessages.has(chatId)) {
    const messageIds = botMessages.get(chatId);
    for (const messageId of messageIds) {
      try {
        await ctx.telegram.deleteMessage(chatId, messageId);
        console.log(`Удалено сообщение с ID: ${messageId}`);
      } catch (err) {
        console.error("Ошибка при удалении сообщения:", err);
      }
    }
    // Очищаем сохранённые ID сообщений
    botMessages.delete(chatId);
  }

  // Очищаем память
  if (memory.has(chatId)) {
    memory.delete(chatId);
    console.log(`История чата для ${chatId} очищена.`);
  }
  conversationHistory = [];
  ctx.reply("История чата и сообщения удалены!");
});
// Функция для получения ответа от модели в контексте простого общения
async function getAnswerFromModelText(question)
{
  const chatId = ctx.chat.id;
  const msg = ctx.message.text;
  
  if (!memory.has(chatId)) {
    console.log(`Создание новой истории для чата: ${chatId}`);
    memory.set(chatId, []);
  }

  // Добавляем новое сообщение пользователя в память
  memory.get(chatId).push({ role: "user", content: msg });

  // Если количество сообщений в памяти превышает MAX_HISTORY, удаляем старые записи
  if (memory.get(chatId).length > MAX_HISTORY) {
    console.log(`Память переполнена для чата ${chatId}. Удаляем старые сообщения.`);
    memory.get(chatId).shift(); // Удаляем самое старое сообщение
  }

  try {
    // Запрос к модели
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...memory.get(chatId),
      ],
      temperature: 0.3,
      max_tokens: 200,
    });

    console.log("Ответ от модели:", response);
    const answer = response?.choices?.[0]?.message?.content;

    // Добавляем ответ модели в память
    if (answer) {
      memory.get(chatId).push({ role: "assistant", content: answer });
    }

    // Отправляем ответ пользователю и сохраняем ID сообщения
    const sentMessage = await ctx.reply(answer || "Модель вернула пустой ответ.");
    
    // Сохраняем ID сообщения, чтобы удалить его позже при /clear
    if (!botMessages.has(chatId)) {
      botMessages.set(chatId, []);
    }
    botMessages.get(chatId).push(sentMessage.message_id);

  } catch (err) {
    console.error("Ошибка при запросе к модели:", err);
    ctx.reply("❌ Ошибка при запросе к модели.");
  }
}

// Функция для получения ответа от модели
async function getAnswerFromModelPDF(question) {
  try {
    const relevantText = getRelevantTextForQuestion(question);

    // Добавляем вопрос и релевантный текст в историю беседы
    conversationHistory.push({ role: 'user', content: question });

    // Передаем контекст и релевантный текст в модель
    const response =await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
          { role: 'system', content: 'Ты ассистент, который помогает отвечать на вопросы по содержимому PDF.' },
          { role: 'user', content: question },
          { role: 'assistant', content: relevantText },  // Передаем только релевантный текст
          ...conversationHistory,  // История сообщений
      ],
      temperature: 0.3,
      max_tokens: 2048,
    });

    // Добавляем ответ в историю для сохранения контекста
    const answer = response.choices[0].message.content;
    conversationHistory.push({ role: 'assistant', content: answer });
    return answer;
  } catch (error) {
    console.error('Ошибка при запросе к OpenAI:', error);
    return 'Извините, произошла ошибка при обработке вашего запроса.';
  }
}

// --------------------------------------------------
// ОБРАБОТКА ТЕКСТА (вопросы к модели)
// --------------------------------------------------
bot.on("text", async (ctx) => {
  
  if (!pdfText) {
    ctx.reply('Пожалуйста, отправьте PDF файл для обработки.');//проверка
    return;
  }

  orderStatus = (pdfText == 0 ) ? StatusContext.TEXT : StatusContext.PDF
  
  switch (orderStatus) {
    case StatusContext.TEXT:
      //ctx.message.text;
      await getAnswerFromModelText();
      break;
    case StatusContext.PDF:
      const question = ctx.message.text;
      const answer = await getAnswerFromModel(question);
      ctx.reply(answer);
    break
    default:
      break;
  }
  
});

// --------------------------------------------------
// ВЕРСЕЛЬ WEBHOOK (обработка webhook в коде)
// --------------------------------------------------
export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const update = req.body;
      console.log("Обработка обновления webhook:", update);
      await bot.handleUpdate(update);  // Обработка webhook
      return res.status(200).end();
    } catch (err) {
      console.error("Ошибка в обработке webhook:", err);
      return res.status(500).send("Internal Server Error");
    }
  }

  return res.status(200).send("OK");
}
