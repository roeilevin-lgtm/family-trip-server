const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { PassThrough } = require('stream');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const getGoogleAuth = () => {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/calendar.readonly' // נוספה הרשאת קריאה ליומן
    ]
  });
};

const getMapLocationsFromDrive = async (drive) => {
    try {
        const res = await drive.files.list({
            q: `name contains '.kml' and trashed = false`,
            fields: 'files(id, name, createdTime)',
            orderBy: 'createdTime desc',
        });
        if (!res.data.files || res.data.files.length === 0) return [];
        const fileRes = await drive.files.get({ fileId: res.data.files[0].id, alt: 'media' }, { responseType: 'text' });
        const jsonObj = new XMLParser({ ignoreAttributes: false }).parse(fileRes.data);
        const extract = (obj) => {
            let p = []; if (!obj) return p;
            if (Array.isArray(obj)) obj.forEach(i => p = p.concat(extract(i)));
            else if (typeof obj === 'object') {
                if (obj.Placemark) {
                    const arr = Array.isArray(obj.Placemark) ? obj.Placemark : [obj.Placemark];
                    arr.forEach(x => { if (x.Point) p.push({ name: x.name, lat: x.Point.coordinates.split(',')[1], lng: x.Point.coordinates.split(',')[0] }); });
                }
                Object.keys(obj).forEach(k => { if (k !== 'Placemark') p = p.concat(extract(obj[k])); });
            }
            return p;
        };
        return extract(jsonObj.kml?.Document);
    } catch (e) { return []; }
};

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
    } catch (e) { return []; }
};

// --- נקודת קצה חדשה: משיכת אירועים מ-Google Calendar ---
app.get('/api/calendar', async (req, res) => {
    try {
        const { calendarId, date } = req.query; // date is expected as "YYYY-MM-DD"
        if (!calendarId || !date) return res.status(400).json({ error: 'Missing parameters' });

        const auth = getGoogleAuth();
        const calendar = google.calendar({ version: 'v3', auth });

        // הגדרת חלון זמן של 24 שעות לאותו תאריך
        const startOfDay = new Date(date);
        const endOfDay = new Date(date);
        endOfDay.setDate(endOfDay.getDate() + 1);

        const response = await calendar.events.list({
            calendarId: calendarId,
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            timeZone: 'Asia/Jerusalem'
        });

        const events = (response.data.items || []).map(item => {
            let timeStr = '08:00';
            let durationStr = '60';

            if (item.start && item.start.dateTime) {
                const d = new Date(item.start.dateTime);
                timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                
                if (item.end && item.end.dateTime) {
                    const startMs = d.getTime();
                    const endMs = new Date(item.end.dateTime).getTime();
                    durationStr = String(Math.round((endMs - startMs) / 60000));
                }
            } else if (item.start && item.start.date) {
                // All-day event
                timeStr = '09:00';
                durationStr = '120';
            }

            return {
                title: item.summary || 'אירוע יומן',
                time: timeStr,
                duration: durationStr,
                location: item.location || ''
            };
        });

        res.json({ success: true, events });
    } catch (error) {
        console.error("Calendar Sync Error:", error);
        res.status(500).json({ success: false, error: 'Failed to fetch calendar events' });
    }
});

// --- PULL ENDPOINT (Existing) ---
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
    (tripRes.data.values || []).forEach(r => {
      if (!r[1]) return;
      if (!activities[r[1]]) activities[r[1]] = [];
      activities[r[1]].push({ id: r[0], time: r[2], title: r[3], location: r[4], type: r[5], duration: r[6], completed: r[7] === 'TRUE' });
    });

    const sheetFiles = (vaultRes.data.values || []).map(r => ({ id: r[0], name: r[1], url: r[2], type: r[3] }));
    const allVault = [...sheetFiles];
    driveFiles.forEach(df => { if (!allVault.find(sf => sf.id === df.id)) allVault.push(df); });

    res.json({ success: true, activities, packingList: (packingRes.data.values || []).map(r => ({ id: r[0], text: r[1], checked: r[2] === 'TRUE' })), vaultFiles: allVault, mapLocations: mapLocs });
  } catch (error) { res.status(500).json({ success: false }); }
});

// --- PUSH ENDPOINT (Existing) ---
app.post('/api/sync', async (req, res) => {
  try {
    const { activities, packingList, vaultFiles } = req.body;
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const folderId = process.env.DRIVE_FOLDER_ID;

    const tripRows = [['ID', 'Date', 'Time', 'Title', 'Location', 'Type', 'Duration', 'Completed']];
    if (activities) Object.entries(activities).forEach(([d, acts]) => acts.forEach(a => tripRows.push([a.id, d, a.time, a.title, a.location, a.type, a.duration, a.completed ? 'TRUE' : 'FALSE'])));
    
    const vaultRows = [['ID', 'Name', 'URL', 'Type']];
    if (vaultFiles) {
        for (const f of vaultFiles) {
            let url = f.url;
            if (f.data?.startsWith('data:') && folderId) {
                const driveRes = await drive.files.create({
                    resource: { name: f.name, parents: [folderId] },
                    media: { mimeType: f.data.split(':')[1].split(';')[0], body: Buffer.from(f.data.split(',')[1], 'base64') },
                    fields: 'id'
                });
                await drive.permissions.create({ fileId: driveRes.data.id, requestBody: { role: 'reader', type: 'anyone' } });
                url = `https://drive.google.com/uc?export=view&id=${driveRes.data.id}`;
            }
            vaultRows.push([f.id, f.name, url || '', f.type || 'image']);
        }
    }

    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'TripData' });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'TripData!A1', valueInputOption: 'RAW', requestBody: { values: tripRows } });
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'VaultData' });
    await sheets.spreadsheets.values.update({ spreadsheetId, range: 'VaultData!A1', valueInputOption: 'RAW', requestBody: { values: vaultRows } });
    
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.listen(process.env.PORT || 10000);
