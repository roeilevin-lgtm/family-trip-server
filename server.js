/**
 * Family Trip Planner - Production Backend Server (Final v4)
 * תומך בסנכרון מול Google Sheets, שאיבת מפות KML וסריקת קבצים אוטומטית מהדרייב.
 */

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { PassThrough } = require('stream');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(cors());

// הרחבת מגבלת הגודל לקבלת קבצי Base64 כבדים (PDF/תמונות)
app.use(express.json({ limit: '50mb' }));

/**
 * פונקציית עזר להתחברות מאובטחת לשירותי גוגל
 */
const getGoogleAuth = () => {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly'
    ]
  });
};

/**
 * שליפת נקודות עניין מקובץ KML בדרייב
 */
const getMapLocationsFromDrive = async (drive) => {
    try {
        const res = await drive.files.list({
            q: `name contains '.kml' and trashed = false`,
            fields: 'files(id, name, createdTime)',
            orderBy: 'createdTime desc',
        });

        if (!res.data.files || res.data.files.length === 0) return [];

        const fileRes = await drive.files.get(
            { fileId: res.data.files[0].id, alt: 'media' },
            { responseType: 'text' }
        );
        
        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(fileRes.data);

        const extractPlacemarks = (obj) => {
            let places = [];
            if (!obj) return places;
            if (Array.isArray(obj)) {
                obj.forEach(item => places = places.concat(extractPlacemarks(item)));
            } else if (typeof obj === 'object') {
                if (obj.Placemark) {
                    const pArr = Array.isArray(obj.Placemark) ? obj.Placemark : [obj.Placemark];
                    pArr.forEach(p => {
                        if (p.name && p.Point && p.Point.coordinates) {
                            const coords = p.Point.coordinates.trim().split(',');
                            places.push({ name: p.name, lat: coords[1], lng: coords[0] });
                        }
                    });
                }
                Object.keys(obj).forEach(k => {
                    if (k !== 'Placemark') places = places.concat(extractPlacemarks(obj[k]));
                });
            }
            return places;
        };

        return extractPlacemarks(jsonObj.kml?.Document);
    } catch (error) {
        console.error("KML Extraction Error:", error);
        return [];
    }
};

/**
 * סריקת תיקיית הדרייב לזיהוי קבצים שהועלו ידנית
 */
const getFilesFromDriveFolder = async (drive, folderId) => {
    if (!folderId) return [];
    try {
        const res = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
            fields: 'files(id, name, mimeType)',
        });
        return (res.data.files || []).map(f => ({
            id: f.id,
            name: f.name,
            url: `https://drive.google.com/uc?export=view&id=${f.id}`,
            type: f.mimeType
        }));
    } catch (e) {
        console.error("Drive Folder Scan Error:", e);
        return [];
    }
};

/**
 * --- PULL ENDPOINT (GET) ---
 */
app.get('/api/sync', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const folderId = process.env.DRIVE_FOLDER_ID;

    const [tripRes, packingRes, vaultRes, mapLocs, driveFiles] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'TripData!A2:H' }).catch(() => ({ data: { values: [] } })),
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'PackingData!A2:C' }).catch(() => ({ data: { values: [] } })),
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'VaultData!A2:D' }).catch(() => ({ data: { values: [] } })),
        getMapLocationsFromDrive(drive),
        getFilesFromDriveFolder(drive, folderId)
    ]);

    const activities = {};
    (tripRes.data.values || []).forEach(row => {
      if (!row[1]) return;
      if (!activities[row[1]]) activities[row[1]] = [];
      activities[row[1]].push({
          id: row[0], time: row[2], title: row[3], location: row[4], 
          type: row[5], duration: row[6], completed: row[7] === 'TRUE'
      });
    });

    const packingList = (packingRes.data.values || []).map(row => ({
        id: row[0], text: row[1], checked: row[2] === 'TRUE'
    }));

    // מיזוג קבצים מהאקסל וקבצים פיזיים מהדרייב למניעת כפילויות
    const sheetFiles = (vaultRes.data.values || []).map(row => ({
        id: row[0], name: row[1], url: row[2], type: row[3]
    }));
    
    const allVault = [...sheetFiles];
    driveFiles.forEach(df => {
        if (!allVault.find(sf => sf.id === df.id)) allVault.push(df);
    });

    res.json({ success: true, activities, packingList, vaultFiles: allVault, mapLocations: mapLocs });

  } catch (error) {
    console.error("Sync Pull Error:", error);
    res.status(500).json({ success: false });
  }
});

/**
 * --- PUSH ENDPOINT (POST) ---
 */
app.post('/api/sync', async (req, res) => {
  try {
    const { activities, packingList, vaultFiles } = req.body;
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const folderId = process.env.DRIVE_FOLDER_ID;

    // 1. נתוני לו"ז
    const tripRows = [['ID', 'Date', 'Time', 'Title', 'Location', 'Type', 'Duration', 'Completed']];
    if (activities) {
        Object.entries(activities).forEach(([date, acts]) => {
            acts.forEach(a => tripRows.push([a.id, date, a.time, a.title, a.location, a.type, a.duration, a.completed ? 'TRUE' : 'FALSE']));
        });
    }

    // 2. נתוני אריזה
    const packingRows = [['ID', 'Text', 'Checked']];
    if (packingList) {
        packingList.forEach(p => packingRows.push([p.id, p.text, p.checked ? 'TRUE' : 'FALSE']));
    }

    // 3. קבצי כספת (העלאה לדרייב אם מדובר ב-Base64 חדש)
    const vaultRows = [['ID', 'Name', 'URL', 'Type']];
    if (vaultFiles) {
        for (const file of vaultFiles) {
            let fileUrl = file.url;
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
                    
                    await drive.permissions.create({
                        fileId: driveRes.data.id,
                        requestBody: { role: 'reader', type: 'anyone' }
                    });
                    fileUrl = `https://drive.google.com/uc?export=view&id=${driveRes.data.id}`;
                } catch (e) { console.error("Drive upload failed:", e); }
            }
            vaultRows.push([file.id, file.name, fileUrl || '', file.type || 'image']);
        }
    }

    // עדכון הגיליון
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'TripData' });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'TripData!A1', valueInputOption: 'RAW', requestBody: { values: tripRows } });
    
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'PackingData' });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'PackingData!A1', valueInputOption: 'RAW', requestBody: { values: packingRows } });

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'VaultData' });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'VaultData!A1', valueInputOption: 'RAW', requestBody: { values: vaultRows } });

    res.json({ success: true });
  } catch (error) {
    console.error("Sync Push Error:", error);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🤖 Server live on port ${PORT}`));
