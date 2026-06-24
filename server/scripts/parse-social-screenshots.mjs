#!/usr/bin/env node
/**
 * Overnight IG/FB screenshot parser — runs on M4, uses free Gemini.
 *
 * Setup:
 *   mkdir -p ~/ReliveCure/social-inbox/processed
 *   GEMINI_API_KEY=... CRM_API_KEY=... node parse-social-screenshots.mjs
 *
 * Cron (2am daily):
 *   0 2 * * * cd .../relive-cure-backend && GEMINI_API_KEY=... CRM_API_KEY=... node server/scripts/parse-social-screenshots.mjs >> ~/ReliveCure/logs/social-parse.log 2>&1
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';

const INBOX = process.env.SOCIAL_INBOX_DIR || path.join(os.homedir(), 'ReliveCure', 'social-inbox');
const PROCESSED = path.join(INBOX, 'processed');
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const CRM_KEY = process.env.CRM_API_KEY;
const BACKEND = (process.env.BACKEND_URL || 'https://relive-cure-backend-production.up.railway.app').replace(/\/$/, '');

const PROMPT = `You parse Instagram/Facebook notification screenshots for a LASIK clinic CRM.
Return ONLY valid JSON array (no markdown). Each item:
{"platform":"instagram"|"facebook","username":"handle without @","raw_text":"comment or DM text","post_hint":"reel/post hint if visible","confidence":0-1}
If nothing useful, return [].`;

async function parseImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mime, data: b64 } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
    }),
  });
  const j = await res.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn('[PARSE] bad JSON from Gemini for', path.basename(filePath));
    return [];
  }
}

async function postLead(item, screenshotPath) {
  const res = await fetch(`${BACKEND}/api/organic-leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-crm-key': CRM_KEY },
    body: JSON.stringify({
      platform: item.platform || 'instagram',
      username: item.username,
      raw_text: item.raw_text,
      post_hint: item.post_hint,
      screenshot_path: screenshotPath,
      parsed_at: new Date().toISOString(),
      metadata: { confidence: item.confidence },
    }),
  });
  const j = await res.json();
  if (!j.success) throw new Error(j.error || 'post failed');
  return j.lead;
}

async function main() {
  if (!GEMINI_KEY) { console.error('Set GEMINI_API_KEY'); process.exit(1); }
  if (!CRM_KEY) { console.error('Set CRM_API_KEY'); process.exit(1); }
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(PROCESSED, { recursive: true });

  const files = fs.readdirSync(INBOX).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
  if (!files.length) {
    console.log('[PARSE] No screenshots in', INBOX);
    return;
  }

  let total = 0;
  for (const f of files) {
    const fp = path.join(INBOX, f);
    console.log('[PARSE]', f);
    try {
      const items = await parseImage(fp);
      for (const item of items) {
        if (!item.username && !item.raw_text) continue;
        if (item.confidence != null && item.confidence < 0.4) continue;
        await postLead(item, fp);
        total++;
        console.log('[PARSE] +', item.username || item.raw_text?.slice(0, 40));
      }
      fs.renameSync(fp, path.join(PROCESSED, `${Date.now()}_${f}`));
    } catch (e) {
      console.error('[PARSE] failed', f, e.message);
    }
  }
  console.log(`[PARSE] Done — ${total} organic leads created`);
}

main();
