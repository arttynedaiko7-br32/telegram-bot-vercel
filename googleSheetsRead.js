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
  if (!spreadsheetId) {
    throw new Error("spreadsheetId is required");
  }

  // 1️⃣ Всегда определяем лист ДИНАМИЧЕСКИ
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title"
  });

  const targetSheetName = meta?.data?.sheets?.[0]?.properties?.title;

  if (!targetSheetName) {
    throw new Error("Не удалось определить лист таблицы");
  }

  // 2️⃣ Читаем ВЕСЬ лист без ограничения диапазона
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: targetSheetName // ← КЛЮЧЕВОЕ ИЗМЕНЕНИЕ
  });

  return {
    sheetName: targetSheetName,
    rowCount: res?.data?.values?.length || 0,
    values: (res?.data?.values || []).slice(0, MAX_ROWS)
  };
}