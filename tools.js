export const tools = [
  {
    type: "function",
    function: {
      name: "read_google_sheet",
      description: "Read all available data from a Google Sheet dynamically",
      parameters: {
        type: "object",
        properties: {
          spreadsheetId: {
            type: "string",
            description: "Google Sheets document ID"
          },
          sheetName: {
            type: "string",
            description: "Optional sheet name"
          }
        },
        required: ["spreadsheetId"]
      }
    }
  }
];
