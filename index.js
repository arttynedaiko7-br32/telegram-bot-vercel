import "dotenv/config";
import { Telegraf } from "telegraf";
import Groq from "groq-sdk";
import axios from 'axios'; 
import pdfParse from 'pdf-parse';  
import { tools } from "./tools.js";
import { readGoogleSheet } from "./googleSheetsRead.js";

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
const MAX_HISTORY = 5; // Максимальное количество сообщений в истории
const botMessages = new Map(); // Сохранение ID сообщений, отправленных ботом

// ---------- CONTEXT PDF ----------
let pdfText = "";
let conversationHistory = [];


const SYSTEM_PROMPT =
  `Ты — интеллектуальный помощник инженера, готовый оказать содействие в решении аналитических, 
   математических, физических, химических,
   электротехнических и инженерных задач, 
   а также в написании кода. Твои ответы должны быть четкими и понятными.`;

// ОБРАБОТКА ПОЛУЧЕНИЯ ДОКУМЕНТА
bot.on('document', async (ctx) => {
  const fileId = ctx.message.document.file_id;
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    // Скачиваем файл с использованием axios
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    // Извлекаем текст из PDF
    const text = await extractTextFromPDF(buffer);
    if (text) {
      pdfText = text;
      orderStatus = StatusContext.PDF
      ctx.reply('Файл успешно обработан! Задавайте ваши вопросы.');
    } else {
      ctx.reply('Не удалось извлечь текст из файла. Попробуйте снова.');
    }
  } catch (error) {
    ctx.reply('Произошла ошибка при скачивании файла. Попробуйте позже.');
  }
});


// Функция для извлечения текста из PDF
async function extractTextFromPDF(fileBuffer) {
  try {
    const data = await pdfParse(fileBuffer);
    return data.text; // возвращает весь текст из PDF
  } catch (error) {
    return null;
  }
}


// Функция для поиска подходящей части текста
function getRelevantTextForQuestion(question) {
  
  const generalQuestions = ["коротко о сожержимом?","расскажи про содержимое?","о чем файл?", "что в файле?", "кратко о файле?"];
  const textChunks = pdfText.split('\n\n'); // Разделяем текст на абзацы
  let relevantText = '';
  //Приводим вопрос к нижнему регистру для простоты проверки
  const questionLower = question.toLowerCase();

  if (generalQuestions.some(q => questionLower.includes(q))) {
    // Если это общий вопрос, просто возвращаем первые несколько абзацев
    const overview = textChunks.slice(0, 3).join('\n\n'); // Берем первые 3 абзаца
    return `Краткий обзор файла: \n\n${overview || 'Текст файла слишком короткий для анализа.'}`;
  }

  // Поиск подходящего абзаца, который может содержать ключевые слова или фразы из вопроса
  textChunks.forEach(chunk => {
    // Используем регулярные выражения для поиска ключевых фраз
    const regex = new RegExp(questionLower.split(' ').join('|'), 'i');  // Ищем все слова из вопроса
    if (regex.test(chunk.toLowerCase())) {
      relevantText += chunk + '\n\n'; // Добавляем в ответ
    }
  });

  // Если релевантный текст не найден, можно использовать другой способ (например, первые несколько абзацев)
  if (!relevantText) {
    relevantText = pdfText.slice(0, 1000);  // Берем первые 1000 символов текста как fallback
    return `Не удалось найти подходящий текст. Вот часть содержимого файла: \n\n${relevantText}`;
  }

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
/table <ссылка на таблицу> <промт пользователя> - для чтения и анализа гугл таблиц
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
  orderStatus = StatusContext.TEXT
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
/*
  // Очищаем память
  if (memory.has(chatId)) {
    memory.delete(chatId);
    console.log(`История чата для ${chatId} очищена.`);
  }*/
  conversationHistory = [];
  ctx.reply("История чата и сообщения удалены!");
});
// Функция для получения ответа от модели в контексте простого общения
async function getAnswerFromModelText(ctx,question)
{
  const chatId = ctx.chat.id;
  const msg = question;
  
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
      max_tokens: 1000,
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
    ctx.reply("⏳ Временное ограничение API. Попробуйте через несколько минут.");
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
      max_tokens: 1000,
    });
    // Добавляем ответ в историю для сохранения контекста
    const answer = response.choices[0].message.content;
    conversationHistory.push({ role: 'assistant', content: answer });
    return answer;
  } catch (error) {
    console.error('Ошибка при запросе к llama-3.3-70b-versatile:', error);
    return 'Извините, произошла ошибка при обработке вашего запроса.';
  }
}
// --------------------------------------------------
// ЗАПРОС К ГУГЛ ТАБЛИЦЕ
// --------------------------------------------------
async function askGroq(messages, tools) {
  try {
    // 1️⃣ Первый вызов модели с tools
    let response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.0,
      max_tokens: 1024
    });

    console.log(
  'MODEL MESSAGE:',
  JSON.stringify(response.choices[0].message, null, 2)
);


    const message = response.choices[0].message;

    // 🔥 ВАЖНО: tool_calls (массив), а не tool_call
    if (message.tool_calls && message.tool_calls.length > 0) {

      for (const toolCall of message.tool_calls) {
        const toolResult = await handleToolCall(toolCall);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id, // 🔥 ОБЯЗАТЕЛЬНО
          content: JSON.stringify(toolResult.result, null, 2)
        });
      }

      // 2️⃣ Второй вызов модели БЕЗ tools
      response = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages,
        temperature: 0.0,
        max_tokens: 1024
      });
    }

    return response;

  } catch (err) {
    console.error('askGroq error:', err);
    return { error: { message: err.message, status: err.status || 500 } };
  }
}
/*
// --------------------------------------------------
// ОБРАБОТКА ТЕКСТА (вопросы к модели)
// --------------------------------------------------
bot.on("text", async (ctx) => {
  
    //orderStatus = (pdfText.trim() === "") ? StatusContext.TEXT : StatusContext.PDF;

  switch (orderStatus) {
    case StatusContext.TEXT:
      const userQuestion = ctx.message.text;  
      await getAnswerFromModelText(ctx,userQuestion);
      break;
    case StatusContext.PDF:
      if (!pdfText.trim()) {
           console.log('Ошибка: нет текста из PDF');
           return 'Не удалось извлечь текст из PDF. Попробуйте другой файл.';
         }
      const question = ctx.message.text;
      const answer = await getAnswerFromModelPDF(question);
      ctx.reply(answer);
    break
    default:
      break;
  }
  
});*/
bot.command("table", async (ctx) => {
  try {
 
     const text = ctx.message.text;
    const entities = ctx.message.entities || [];

    console.log('TEXT:', text);
    console.log('ENTITIES:', entities);

    // 1️⃣ Ищем URL, который Telegram уже распарсил
    const urlEntity = entities.find(e => e.type === 'url');

    if (!urlEntity) {
      return ctx.reply(
        '❌ Формат команды:\n/table <ссылка на Google Sheets> <что нужно сделать>'
      );
    }

    // 2️⃣ Достаём ПОЛНЫЙ URL
    const sheetUrl = text.substring(
      urlEntity.offset,
      urlEntity.offset + urlEntity.length
    );

    // 3️⃣ Извлекаем spreadsheetId
    const idMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) {
      return ctx.reply('❌ Не удалось извлечь ID таблицы');
    }

    const spreadsheetId = idMatch[1];

    // 4️⃣ Достаём пользовательский промт (всё, кроме /table и ссылки)
    const userPrompt =
      text
        .replace('/table', '')
        .replace(sheetUrl, '')
        .trim() || 'Проанализируй данные';

    //const spreadsheetId = idMatch[1];

    console.log("SHEET URL:", sheetUrl);
    console.log("SPREADSHEET ID:", spreadsheetId);
    console.log("PROMPT:", userPrompt);
/*
    // 3️⃣ Читаем таблицу
    const data = await readGoogleSheet({ spreadsheetId });

    console.log("RAW DATA:", data.values);
console.log("Первые 5 строк:", data.values.slice(0, 5));


    if (!data?.values) {
      await ctx.reply("❌ Не удалось прочитать данные из таблицы");
      return;
    }
*//*
    const messages = [
      {
        role: "system",
        content:
          "You are a data analyst. Use ONLY the provided spreadsheet data. Do not invent missing values."
      },
      {
        role: "user",
        content: `
User request:
${userPrompt}

Spreadsheet data:
${JSON.stringify(data.values, null, 2)}
`
      }
    ];*/
/*
const messages = [
{ role: 'system', content: 'You are a data analyst. Use ONLY the provided spreadsheet data.' },
{ role: 'user', content: userPrompt }
];*/
const messages = [
      {
        role: 'system',
        content: `
Ты — аналитик данных.
Если для ответа нужны данные таблицы — ОБЯЗАТЕЛЬНО используй инструмент read_google_sheet.
Не придумывай данные.
`
      },
      {
        role: 'user',
        content: `User request: ${userPrompt}\nSpreadsheet URL: ${sheetUrl}`
      }
    ];
  const response = await askGroq(messages,tools);
const content = response.choices[0].message.content;


if (!content) return ctx.reply('⏳ Ошибка: пустой результат');


ctx.reply(`📊 Анализ таблицы:\n${content}`);


} catch (err) {
console.error('TABLE COMMAND ERROR:', err);
ctx.reply('❌ Ошибка обработки команды');
}

    /*
if (!response) {
  console.error("❌ askGroq вернул undefined или null");
  await ctx.reply("⏳ Ошибка: нет ответа от askGroq");
  return;
}

if (response.error) {
  console.error("❌ Ошибка от groq API:", response.error);
  await ctx.reply(`⏳ Ошибка при анализе таблицы: ${response.error.message}`);
  return;
}

if (!response.choices?.[0]?.message?.content) {
  console.warn("⚠️ Ответ пришёл, но content пустой:", response);
  await ctx.reply("⏳ Ошибка при анализе таблицы: пустой результат");
  return;
}

console.log("✅ Успешный ответ:", response.choices[0].message.content);

    // 4️⃣ Можно вернуть ссылку пользователю
    await ctx.reply(
      `📊 Анализ таблицы:\n${sheetUrl}\n\n${response.choices[0].message.content}`
    );

  } catch (err) {
    console.error("TABLE COMMAND ERROR:", err);
    await ctx.reply("❌ Ошибка обработки команды");
  }*/
});

// --------------------------------------------------
// Функция callback tool
// --------------------------------------------------
async function handleToolCall(toolCall) {
  const toolName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments || "{}");

  switch (toolName) {
    case "read_google_sheet": {
      const result = await readGoogleSheet(
        args.spreadsheetId,
        args.sheetName
      );

      return {
        tool_name: toolName,
        result
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}




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
