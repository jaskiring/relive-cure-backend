#!/usr/bin/env node
/**
 * M4 overnight — download pending call recordings from shared Google Drive,
 * transcribe with Gemini (free tier), write back to Supabase + Lore.
 *
 * Uses the SAME Google service account as Railway (same folder).
 *
 * Usage:
 *   cd relive-cure-backend
 *   export GEMINI_API_KEY=...
 *   export SUPABASE_URL=...
 *   export SUPABASE_SERVICE_ROLE_KEY=...
 *   export GOOGLE_SERVICE_ACCOUNT_JSON='...'
 *   export GOOGLE_DRIVE_FOLDER_ID=...
 *   export CRM_API_KEY=...
 *   export BACKEND_URL=https://relive-cure-backend-production.up.railway.app
 *   node server/scripts/transcribe-calls.mjs
 *
 * Cron (2:30am after social screenshots):
 *   30 2 * * * cd .../relive-cure-backend && ... node server/scripts/transcribe-calls.mjs >> ~/ReliveCure/logs/transcribe.log 2>&1
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { downloadFromDrive, isDriveConfigured } from '../google-drive.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const BACKEND = (process.env.BACKEND_URL || 'https://relive-cure-backend-production.up.railway.app').replace(/\/$/, '');
const CRM_KEY = process.env.CRM_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function transcribeAudio(buffer, mime = 'audio/mp4') {
  const b64 = buffer.toString('base64');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'Transcribe this phone call recording. Speakers may use Hindi, English, or Hinglish. Output plain transcript text only. Label lines as Rep: and Customer: if you can distinguish voices.' },
          { inline_data: { mime_type: mime, data: b64 } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function patchTranscript(callId, transcript, phone) {
  if (CRM_KEY) {
    const r = await fetch(`${BACKEND}/api/calls/${callId}/transcript`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-crm-key': CRM_KEY },
      body: JSON.stringify({ transcript }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'patch failed');
    return;
  }
  const { error } = await supabase.from('call_recordings').update({
    transcript,
    transcript_status: 'done',
    updated_at: new Date().toISOString(),
  }).eq('id', callId);
  if (error) throw error;
  if (phone && process.env.LEAD_EVENTS_ENABLED !== 'false') {
    await supabase.from('lead_events').insert({
      phone,
      ts: new Date().toISOString(),
      event_type: 'call_transcribed',
      source: 'lore_engine',
      payload: { transcript: transcript.slice(0, 500), call_id: callId },
    }).catch(() => {});
  }
}

async function downloadAudio(row) {
  const id = row.drive_file_id;
  if (!id) throw new Error('no drive_file_id');
  // Real Google Drive file IDs don't contain slashes
  if (isDriveConfigured() && !id.includes('/')) {
    return downloadFromDrive(id);
  }
  // Fallback: Supabase storage path rep/...
  const { data, error } = await supabase.storage.from('call-recordings').download(id);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

async function main() {
  if (!GEMINI_KEY) { console.error('Set GEMINI_API_KEY'); process.exit(1); }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const { data: rows, error } = await supabase
    .from('call_recordings')
    .select('id, phone, drive_file_id, duration_sec, rep_name')
    .eq('transcript_status', 'pending')
    .not('drive_file_id', 'is', null)
    .gte('duration_sec', 10)
    .order('call_started_at', { ascending: true })
    .limit(30);

  if (error) { console.error(error.message); process.exit(1); }
  if (!rows?.length) { console.log('[TRANSCRIBE] Nothing pending'); return; }

  console.log(`[TRANSCRIBE] ${rows.length} recording(s)`);
  for (const row of rows) {
    try {
      console.log(`[TRANSCRIBE] ${row.id} · ${row.rep_name || '?'} · ${row.phone} · ${row.duration_sec}s`);
      const buf = await downloadAudio(row);
      const text = await transcribeAudio(buf);
      if (!text) throw new Error('empty transcript');
      await patchTranscript(row.id, text, row.phone);
      console.log(`[TRANSCRIBE] ✓ ${text.slice(0, 80)}…`);
    } catch (e) {
      console.error(`[TRANSCRIBE] ✗ ${row.id}:`, e.message);
      await supabase.from('call_recordings').update({
        transcript_status: 'failed',
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
    }
  }
  console.log('[TRANSCRIBE] Done');
}

main();
