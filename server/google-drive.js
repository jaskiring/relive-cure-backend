/**
 * Google Drive upload for call recordings — one shared clinic folder.
 *
 * Env (Railway + M4 script):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — full service account JSON string (or base64)
 *   GOOGLE_DRIVE_FOLDER_ID       — folder ID where all recordings land
 *
 * Setup: create folder in clinic Google account → share with service account email (Editor).
 */
let _drive = null;

function parseServiceAccountJson() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function isDriveConfigured() {
  return !!(parseServiceAccountJson() && process.env.GOOGLE_DRIVE_FOLDER_ID);
}

async function getDriveClient() {
  if (_drive) return _drive;
  const creds = parseServiceAccountJson();
  if (!creds) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing or invalid');
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

/**
 * Upload recording buffer to shared Drive folder.
 * @returns {{ fileId: string, webUrl: string }}
 */
export async function uploadRecordingToDrive({ buffer, filename, mimeType = 'audio/mp4' }) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID not set');
  const drive = await getDriveClient();
  const { data } = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: { mimeType, body: Buffer.from(buffer) },
    fields: 'id, webViewLink, webContentLink',
  });
  return {
    fileId: data.id,
    webUrl: data.webViewLink || data.webContentLink || `https://drive.google.com/file/d/${data.id}/view`,
  };
}

/** Download file bytes from Drive (M4 transcription script). */
export async function downloadFromDrive(fileId) {
  const drive = await getDriveClient();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

export function driveStorageMode() {
  return isDriveConfigured() ? 'drive' : 'supabase';
}
