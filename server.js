/**
 * Family Trip Planner - Production Backend Server (v3)
 * תומך בסנכרון מלא: לו"ז, רשימות אריזה, והעלאת קבצים אוטומטית ל-Google Drive.
 */

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { PassThrough } = require('stream');

const app = express();
app.use(cors());
// הרחבת מגבלת הגודל כדי לאפשר קבלת קבצי תמונה ב-Base64 (דרכונים וכו')
app.use(express.json({ limit: '50mb' }));

// פונקציית עזר ליצירת חיבור מאומת לגוגל (Sheets + Drive)
const getGoogleAuth = () => {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
        '[https://www.googleapis.com/auth/spreadsheets](https://www.googleapis.com/auth/spreadsheets)',
        '[https://www.googleapis.com/auth/drive.file](https://www.googleapis.com/auth/drive.file)'
    ]
  });
};

// פונקציית תשתית: מוודאת שהלשוניות קיימות באקסל ויוצרת אותן אם חסר
const ensureSheetsExist = async (sheets, spreadsheetId) => {
    try {
        const doc = await sheets.spreadsheets.get({ spreadsheetId });
        const existingTitles = doc.data.sheets.map(s => s.properties.title);
        const requiredTitles = ['TripData', 'PackingData', 'VaultData'];
        const requests = [];

        for (const title of requiredTitles) {
            if (!existingTitles.includes(title)) {
                requests.push({ addSheet: { properties: { title } } });
            }
        }

        if (requests.length > 0) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests }
            });
            console.log("🤖 Created missing tabs in Google Sheets.");
        }
    } catch (e) {
        console.error("Error checking sheets existence:", e);
    }
};

// --- PULL (GET) Endpoint ---
app.get('/api/sync', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    await ensureSheetsExist(sheets, spreadsheetId);

    // משיכת נתונים מכל הלשוניות במקביל
    const [tripRes, packingRes, vaultRes] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'TripData!A2:H' }).catch(() => ({ data: { values: [] } })),
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'PackingData!A2:C' }).catch(() => ({ data: { values: [] } })),
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'VaultData!A2:D' }).catch(() => ({ data: { values: [] } }))
    ]);

    const activities = {};
    (tripRes.data.values || []).forEach(row => {
      const [id, date, time, title, location, type, duration, completed] = row;
      if (!date) return;
      if (!activities[date]) activities[date] = [];
      activities[date].push({ id, time, title, location, type, duration, completed: completed === 'TRUE' });
    });

    const packingList = (packingRes.data.values || []).map(row => ({
        id: row[0], text: row[1], checked: row[2] === 'TRUE'
    }));

    const vaultFiles = (vaultRes.data.values || []).map(row => ({
        id: row[0], name: row[1], url: row[2], type: row[3]
    }));

    res.json({ success: true, activities, packingList, vaultFiles });

  } catch (error) {
    console.error("Pull Error:", error);
    res.status(500).json({ success: false, error: 'Failed to pull data.' });
  }
});

// --- PUSH (POST) Endpoint ---
app.post('/api/sync', async (req, res) => {
  try {
    const { activities, packingList, vaultFiles } = req.body;
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const folderId = process.env.DRIVE_FOLDER_ID; // מוגדר במשתני הסביבה ב-Render

    await ensureSheetsExist(sheets, spreadsheetId);

    // 1. הכנת נתוני לו"ז
    const tripRows = [['ID', 'Date', 'Time', 'Title', 'Location', 'Type', 'Duration', 'Completed']];
    if (activities) {
        for (const [date, acts] of Object.entries(activities)) {
            acts.forEach(a => tripRows.push([a.id, date, a.time, a.title, a.location, a.type, a.duration, a.completed ? 'TRUE' : 'FALSE']));
        }
    }

    // 2. הכנת נתוני אריזה
    const packingRows = [['ID', 'Text', 'Checked']];
    if (packingList) {
        packingList.forEach(p => packingRows.push([p.id, p.text, p.checked ? 'TRUE' : 'FALSE']));
    }

    // 3. טיפול בקבצי כספת (העלאה לדרייב אם צריך)
    const vaultRows = [['ID', 'Name', 'URL', 'Type']];
    if (vaultFiles) {
        for (const file of vaultFiles) {
            let fileUrl = file.url;
            
            // אם הקובץ מכיל דאטה בייס64, סימן שזה קובץ חדש שיש להעלות לדרייב
            if (file.data && file.data.startsWith('data:') && folderId) {
                try {
                    const mimeType = file.data.substring(file.data.indexOf(":") + 1, file.data.indexOf(";"));
                    const base64Str = file.data.split(',')[1];
                    const bufferStream = new PassThrough();
                    bufferStream.end(Buffer.from(base64Str, 'base64'));

                    const driveRes = await drive.files.create({
                        resource: { name: file.name, parents: [folderId] },
                        media: { mimeType, body: bufferStream },
                        fields: 'id'
                    });
                    
                    // מתן הרשאת קריאה ציבורית (כדי שהאפליקציה תוכל להציג את התמונה מכל טלפון)
                    await drive.permissions.create({
                        fileId: driveRes.data.id,
                        requestBody: { role: 'reader', type: 'anyone' }
                    });

                    // יצירת לינק ישיר להורדה/תצוגה שמתאים ל-img tag
                    fileUrl = `https://drive.google.com/uc?export=view&id=${driveRes.data.id}`;
                } catch (e) {
                    console.error("Drive upload failed for file:", file.name, e);
                }
            }
            vaultRows.push([file.id, file.name, fileUrl || '', file.type || 'image']);
        }
    }

    // 4. כתיבת כל הנתונים במרוכז לאקסל
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'TripData' });
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'PackingData' });
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'VaultData' });
    
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'TripData!A1', valueInputOption: 'RAW', requestBody: { values: tripRows } });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'PackingData!A1', valueInputOption: 'RAW', requestBody: { values: packingRows } });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'VaultData!A1', valueInputOption: 'RAW', requestBody: { values: vaultRows } });

    res.json({ success: true, message: 'All systems perfectly synced!' });

  } catch (error) {
    console.error("Push Error:", error);
    res.status(500).json({ success: false, error: 'Failed to push data.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🤖 Server listening on port ${PORT}`));
