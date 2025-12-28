import { google } from "googleapis";

const MAX_ROWS = 500;
const rawCredentials = process.env.GOOGLE_CREDENTIALS?.trim();
if (!rawCredentials) throw new Error("GOOGLE_CREDENTIALS не задана");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(rawCredentials),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
});

const sheets = google.sheets({ version: "v4", auth });

export async function readGoogleSheet({ spreadsheetId, sheetName }) {
  let targetSheetName = sheetName;

  // 1️⃣ Если имя листа не передано — получаем первый лист
  if (!targetSheetName) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title"
    });

    targetSheetName = meta.data.sheets?.[0]?.properties?.title;

    if (!targetSheetName) {
      throw new Error("Не удалось определить лист таблицы");
    }
  }

  // 2️⃣ Читаем значения листа
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: targetSheetName
  });

  return {
    values: (res.data.values || []).slice(0, MAX_ROWS)
  };
}
