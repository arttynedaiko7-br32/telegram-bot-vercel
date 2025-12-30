// --------------------------------------------------
// Функция callback tool
// --------------------------------------------------
import { readGoogleSheet } from "./googleSheetsRead.js";

export async function handleToolCall(toolCall) {
  const toolName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments || "{}");

  switch (toolName) {
    case "read_google_sheet": {
      const result = await readGoogleSheet({
        spreadsheetId: args.spreadsheetId
      });

      return {
        tool_name: toolName,
        result
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}