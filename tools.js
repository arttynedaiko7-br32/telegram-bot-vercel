export const tools = [
  {
    type: "function",
    function: {
      name: "read_google_sheet",
      description: "Получает данные из Google Sheets по spreadsheetId",
      parameters: {
        type: "object",
        properties: {
          spreadsheetId: {
            type: "string",
            description: "ID Google Spreadsheet (часть URL между /d/ и /edit)"
          }
        },
        required: ["spreadsheetId"]
      }
    }
  }
];
