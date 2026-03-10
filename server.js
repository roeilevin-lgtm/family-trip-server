/**
 * Family Trip Planner - Backend Server
 * תפקיד הקובץ: לקבל את הנתונים מהטלפונים ולשמור אותם בצורה בטוחה ב-Google Sheets.
 */

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

// בדיקת שפיות - לראות שהשרת עובד
app.get('/', (req, res) => {
  res.send('Family Trip Robot is Awake! 🤖');
});

// נתיב הסנכרון
app.post('/api/sync', async (req, res) => {
  try {
    const { activities } = req.body;
    
    // 1. קריאת משתני הסביבה מ-Render
    // משתמשים ב-JSON.parse כי הסוד נשמר כטקסט
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // 2. התחברות ל-Google Sheets עם תעודת הזהות של הרובוט
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 3. הכנת הנתונים לצורה שטבלה מבינה (שורות ועמודות)
    const rows = [['ID', 'Date', 'Time', 'Title', 'Location', 'Type', 'Duration', 'Completed']];
    
    if (activities) {
        for (const [date, acts] of Object.entries(activities)) {
            acts.forEach(act => {
                rows.push([
                    act.id || '',
                    date || '',
                    act.time || '',
                    act.title || '',
                    act.location || '',
                    act.type || '',
                    act.duration || '',
                    act.completed ? 'TRUE' : 'FALSE'
                ]);
            });
        }
    }

    // 4. ניקוי הגיליון הישן וכתיבת המידע החדש
    await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: 'TripData'
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'TripData!A1',
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });

    res.json({ success: true, message: 'Data perfectly synced to Google Sheets!' });

  } catch (error) {
    console.error("Sync Error:", error);
    res.status(500).json({ success: false, error: 'Failed to sync with Google Sheets.' });
  }
});

// הגדרת הפורט שעליו השרת ירוץ
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🤖 Server listening on port ${PORT}`);
});
