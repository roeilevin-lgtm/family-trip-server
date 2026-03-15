const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { PassThrough } = require('stream');
const { XMLParser } = require('fast-xml-parser');
const { OAuth2Client } = require('google-auth-library');

const app = express();

// 1. אבטחת CORS מוקשחת (בסביבת פרודקשן יש להזין את דומיין האפליקציה בלבד)
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*';
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '50mb' }));

// 2. הגנת Rate Limiting פנימית נגד התקפות DoS
const rateLimit = new Map();
app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, { count: 1, reset: now + 60000 });
    } else {
        const data = rateLimit.get(ip);
        if (now > data.reset) { data.count = 1; data.reset = now + 60000; }
        else {
            data.count++;
            if (data.count > 100) return res.status(429).json({ error: 'Too many requests' });
        }
    }
    next();
});

// 3. מנגנון אימות (Google OAuth + Robot Bypass)
const oauthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
const ROBOT_TOKEN = process.env.ROBOT_TOKEN || 'family-trip-robot-secret'; // אסימון קשיח לרובוט

app.use('/api/', async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized: Missing Token' });
    const token = authHeader.split(' ')[1];

    // מעקף מורשה למשתמש הרובוט (Playwright)
    if (token === ROBOT_TOKEN) {
        req.user = { email: 'robot@system.local', name: 'Automation Robot', role: 'robot' };
        return next();
    }

    try {
        const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        
        // הרשאות לפי Whitelist של המשפחה
        if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(payload.email.toLowerCase())) {
            console.warn(`Security Event: Blocked unauthorized email access attempt - ${payload.email}`);
            return res.status(403).json({ error: 'Forbidden: User not authorized in family group.' });
        }
        req.user = payload;
        next();
    } catch (e) {
        console.error('Invalid token attempt:', e.message);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
});

const getGoogleAuth = () => {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/calendar.readonly']
  });
};

const getMapLocationsFromDrive = async (drive) => {
    try {
        const res = await drive.files.list({ q: `name contains '.kml' and trashed = false`, fields: 'files(id, name)', orderBy: 'createdTime desc' });
        if (!res.data.files?.length) return [];
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

// --- GET: Google Calendar ---
app.get('/api/calendar', async (req, res) => {
    try {
        const { calendarId, date } = req.query;
        if (!calendarId || !date) return res.status(400).json({ error: 'Missing parameters' });
        
        const auth = getGoogleAuth();
        const calendar = google.calendar({ version: 'v3', auth });
        const startOfDay = new Date(date); startOfDay.setHours(0,0,0,0);
        const endOfDay = new Date(date); endOfDay.setHours(23,59,59,999);
        
        const response = await calendar.events.list({ calendarId, timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString(), singleEvents: true, orderBy: 'startTime', timeZone: 'Asia/Jerusalem' });
        const events = (response.data.items || []).map(item => {
            let timeStr = '08:00'; let durationStr = '60';
            if (item.start?.dateTime) {
                const d = new Date(item.start.dateTime);
                timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                if (item.end?.dateTime) durationStr = String(Math.round((new Date(item.end.dateTime).getTime() - d.getTime()) / 60000));
            } else if (item.start?.date) { timeStr = '09:00'; durationStr = '120'; }
            return { id: item.id, title: item.summary || 'אירוע יומן', time: timeStr, duration: durationStr, location: item.location || '' };
        });
        res.json({ success: true, events });
    } catch (error) { 
        console.error("Calendar Sync Error:", error);
        res.status(500).json({ success: false, error: 'Internal Error' }); // מיסוך שגיאות
    }
});

// --- GET: Pull Data ---
app.get('/api/sync', async (req, res) => {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;

    const [tripRes, packingRes, vaultRes, mapLocs] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'TripData!A2:H' }).catch(() => ({ data: { values: [] } })),
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'PackingData!A2:D' }).catch(() => ({ data: { values: [] } })),
        sheets.spreadsheets.values.get({ spreadsheetId, range: 'VaultData!A2:E' }).catch(() => ({ data: { values: [] } })),
        getMapLocationsFromDrive(drive)
    ]);

    const activities = {};
    (tripRes.data.values || []).forEach(r => {
      if (!r[1]) return;
      if (!activities[r[1]]) activities[r[1]] = [];
      activities[r[1]].push({ id: r[0], time: r[2], title: r[3], location: r[4], type: r[5], duration: r[6], completed: r[7] === 'TRUE' });
    });

    const vaultFiles = (vaultRes.data.values || []).map(r => ({ id: r[0], name: r[1], url: r[2], type: r[3], pinnedToWallet: r[4] === 'TRUE' }));
    const packingList = (packingRes.data.values || []).map(r => ({ id: r[0], text: r[1], checked: r[2] === 'TRUE', owner: r[3] || '' }));

    res.json({ success: true, activities, packingList, vaultFiles, mapLocations: mapLocs });
  } catch (error) { 
      console.error("Sync Pull Error:", error);
      res.status(500).json({ success: false, error: 'Internal Error' }); 
  }
});

// --- POST: Push Data & Manage Cloud State ---
app.post('/api/sync', async (req, res) => {
  try {
    const { activities, packingList, vaultFiles } = req.body;
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const folderId = process.env.DRIVE_FOLDER_ID;

    // --- א. מניעת דליפת אחסון בדרייב (Orphan Cleanup) ---
    if (vaultFiles && folderId) {
        try {
            const currentVault = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'VaultData!A2:C' }).catch(() => ({ data: { values: [] } }));
            const currentDriveIds = (currentVault.data.values || []).map(r => r[2]?.match(/id=([a-zA-Z0-9_-]+)/)?.[1]).filter(Boolean);
            const incomingDriveIds = vaultFiles.map(f => f.url?.match(/id=([a-zA-Z0-9_-]+)/)?.[1]).filter(Boolean);
            
            const orphanedIds = currentDriveIds.filter(id => !incomingDriveIds.includes(id));
            for (const id of orphanedIds) {
                await drive.files.delete({ fileId: id }).catch(e => console.warn(`Failed to delete orphaned file ${id}`));
            }
        } catch (e) { console.error('Error during cleanup:', e); }
    }

    // --- ב. מיפוי נתונים לאקסל ---
    const tripRows = [['ID', 'Date', 'Time', 'Title', 'Location', 'Type', 'Duration', 'Completed']];
    if (activities) Object.entries(activities).forEach(([d, acts]) => acts.forEach(a => tripRows.push([a.id, d, a.time, a.title, a.location, a.type, a.duration, a.completed ? 'TRUE' : 'FALSE'])));
    
    const packingRows = [['ID', 'Text', 'Checked', 'Owner']];
    if (packingList) packingList.forEach(p => packingRows.push([p.id, p.text, p.checked ? 'TRUE' : 'FALSE', p.owner || '']));

    const vaultRows = [['ID', 'Name', 'URL', 'Type', 'Pinned']];
    if (vaultFiles) {
        for (const f of vaultFiles) {
            let url = f.url;
            if (f.data?.startsWith('data:') && folderId) {
                const mimeType = f.data.substring(f.data.indexOf(":") + 1, f.data.indexOf(";"));
                const base64Str = f.data.split(',')[1];
                const bufferStream = new PassThrough(); bufferStream.end(Buffer.from(base64Str, 'base64'));
                
                const driveRes = await drive.files.create({
                    resource: { name: f.name, parents: [folderId] },
                    media: { mimeType, body: bufferStream },
                    fields: 'id'
                });
                
                // הוסרה ההרשאה הפומבית. הקובץ פרטי למשפחה בלבד.
                url = `https://drive.google.com/uc?export=view&id=${driveRes.data.id}`;
            }
            vaultRows.push([f.id, f.name, url || '', f.type || 'image', f.pinnedToWallet ? 'TRUE' : 'FALSE']);
        }
    }

    // --- ג. כתיבה ל-Sheets בצורה יעילה בבקשה בודדת ---
    await sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: ['TripData!A2:H', 'PackingData!A2:D', 'VaultData!A2:E'] }
    });

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'RAW',
            data: [
                { range: 'TripData!A1', values: tripRows },
                { range: 'PackingData!A1', values: packingRows },
                { range: 'VaultData!A1', values: vaultRows }
            ]
        }
    });
    
    res.json({ success: true });
  } catch (e) { 
      console.error("Sync Push Error:", e);
      res.status(500).json({ success: false, error: 'Internal Error' }); 
  }
});

app.listen(process.env.PORT || 10000, () => console.log('Secure Backend Running'));
