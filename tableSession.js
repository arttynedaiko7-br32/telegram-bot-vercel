import { tools } from "./tools.js";
import { handleToolCall } from "./handleToolCall.js";
import { SessionMode } from "./index.js"
/*
Session structure:
{
step: 'WAIT_SHEET_URL' | 'CHAT',
spreadsheetId: string,
sheetUrl: string,
messages: [] // LLM context
}
*/

// --------------------------------------------------
// TABLE SESSION (обработка STATE SESSION)
// --------------------------------------------------
export async function tableSession(session,ctx,groq)
{
 const text = ctx.message.text;

  if (session) {

    // ---- STEP 1: waiting for sheet url ----
    if (session.mode === SessionMode.TABLE_BEGIN) {
      const entities = ctx.message.entities || [];

      const urlEntity = entities.find(e => e.type === 'url');
      if (!urlEntity) {
        return ctx.reply('❌ Пришлите ссылку на Google Sheets');
      }

      const sheetUrl = text.substring(
        urlEntity.offset,
        urlEntity.offset + urlEntity.length
      );

      const idMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (!idMatch) {
        return ctx.reply('❌ Не удалось извлечь ID таблицы');
      }

      session.spreadsheetId = idMatch[1];
      session.sheetUrl = sheetUrl;
      session.mode = SessionMode.TABLE_CHAT;

      session.messages.push({
        role: 'system',
        content: `Ты — аналитик данных, работающий с одной Google таблицей.

        Если для ответа нужны данные из таблицы — используй инструмент read_google_sheet.
        Если данные не нужны — отвечай без инструментов.

        Используй ТОЛЬКО данные из этой таблицы.
        Не придумывай значения и не запрашивай другие таблицы.

        Учитывай предыдущие сообщения.
        Если информации недостаточно — задай уточняющий вопрос.`
      });

      const isTableUrlSystem = (m) =>
      m.role === 'system' && m.content.startsWith('Spreadsheet URL:');

      if (session.messages.length > 4) {
      const indexToRemove = session.messages.findIndex(
      m => !isTableUrlSystem(m)
  );

  if (indexToRemove !== -1) {
    session.messages.splice(indexToRemove, 1);
  }
}

      session.messages.push({
        role: 'system',
        content: `Spreadsheet URL: ${sheetUrl}`
      });

      return ctx.reply('✅ Таблица подключена. Задайте вопрос по данным.');
    }

    // ---- STEP 2: chat with table ----
    if (session.mode === SessionMode.TABLE_CHAT) {
      session.messages.push({
        role: 'user',
        content: text
      });

      try {
        const response = await askGroq(session.messages, tools, groq);
        const message = response?.choices?.[0]?.message;

        if (!message?.content) {
          return ctx.reply('❌ Модель вернула пустой ответ');
        }
          if (session.messages.length > 4) {
              session.messages = session.messages.slice(-12);
          }
        session.messages.push({
          role: 'assistant',
          content: message.content
        });

        return ctx.reply(`📊 ${message.content}`);
      } catch (err) {
        console.error(err);
        return ctx.reply('❌ Ошибка анализа таблицы');
      }
    }
  }

}//end session

// --------------------------------------------------
// ЗАПРОС К ГУГЛ ТАБЛИЦЕ
// --------------------------------------------------
async function askGroq(messages, tools, groq) {
  try {
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
    const toolCall = message.tool_calls?.[0];


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

    if (!response?.choices) {
  throw new Error("LLM response has no choices");
}

    return response;

  } catch (err) {
    console.error('askGroq error:', err);
    return { error: { message: err.message, status: err.status || 500 } };
  }
}