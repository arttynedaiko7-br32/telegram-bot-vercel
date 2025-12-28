import { google } from "googleapis";

const MAX_ROWS = 500;

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
});

const sheets = google.sheets({ version: "v4", auth });

export async function readGoogleSheet({ spreadsheetId, sheetName }) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName || undefined
  });

  return {
    values: (res.data.values || []).slice(0, MAX_ROWS) // защита от перегруза
  };
}
