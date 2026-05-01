// ─── STEP 1: Polyfill fetch BEFORE any other import that uses it ─────────────
import fetch from 'node-fetch';
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
    console.log('[BOOT] node-fetch polyfill applied');
} else {
    // Override anyway to be safe — Render native fetch can silently fail
    globalThis.fetch = fetch;
    console.log('[BOOT] node-fetch override applied (replacing native fetch)');
}

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ingestLead } from '../src/lib/ingestion.js';
import { processQueue } from './crm-automation.js';
import { supabaseAdmin } from './supabase-admin.js';

// ─── STEP 2: Startup env diagnostics ─────────────────────────────────────────
const REQUIRED_ENV = ["BOT_SECRET", "CRM_API_KEY", "WEBHOOK_VERIFY_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
}

console.log('═══════════════════════════════════════');
console.log('[BOOT] ✅ Server starting...');
console.log('[BOOT] CRM_API_KEY SET:', !!process.env.CRM_API_KEY);
console.log('[BOOT] BOT_SECRET SET:', !!process.env.BOT_SECRET);
console.log('[BOOT] WEBHOOK_VERIFY_TOKEN SET:', !!process.env.WEBHOOK_VERIFY_TOKEN);
console.log('[BOOT] NODE_VERSION:', process.version);
console.log('═══════════════════════════════════════');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_SECRET = process.env.BOT_SECRET;
const CRM_API_KEY = process.env.CRM_API_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

app.use(cors());
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', node: process.version, ts: new Date().toISOString(), uptime: process.uptime() });
});

// ─── STEP 4: Debug DB connection endpoint ─────────────────────────────────────
app.get('/test-db', async (req, res) => {
    console.log('[TEST-DB] Testing Supabase connection...');
    console.log('[TEST-DB] SUPABASE_URL:', process.env.SUPABASE_URL || 'MISSING');
    console.log('[TEST-DB] KEY LENGTH:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length || 'MISSING');
    try {
        const { data, error } = await supabaseAdmin
            .from('leads_surgery')
            .select('id, phone_number, contact_name, created_at')
            .limit(1);

        if (error) {
            console.error('[TEST-DB] ❌ DB ERROR:', error);
            return res.status(500).json({ success: false, error: error.message, details: error });
        }

        console.log('[TEST-DB] ✅ Connected! Row count probe: ok. Sample:', JSON.stringify(data));
        return res.json({ success: true, message: 'Supabase connected', sample: data });

    } catch (err) {
        console.error('[TEST-DB] ❌ FETCH/NETWORK ERROR:', err.message, err.cause || '');
        return res.status(500).json({ success: false, error: err.message, cause: String(err.cause || '') });
    }
});

// ─── Dashboard Auth Endpoint ──────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    // We are reading VITE_ADMIN_USERNAME and VITE_ADMIN_PASSWORD from process.env
    const validUsername = process.env.VITE_ADMIN_USERNAME || 'admin';
    const validPassword = process.env.VITE_ADMIN_PASSWORD || 'admin123';

    if (username === validUsername && password === validPassword) {
        res.json({ success: true, token: CRM_API_KEY });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

// ─── Export Refrens cookies from the current Puppeteer session ────────────────
app.get('/api/export-refrens-cookies', async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const { getBrowserCookies } = await import('./crm-automation.js');
        const cookies = await getBrowserCookies();
        res.json({ cookies });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── CRM Push ─────────────────────────────────────────────────────────────────
app.post('/api/push-to-crm-form', async (req, res) => {

    const crmKey = req.headers['x-crm-key'];
    console.log("RECEIVED x-crm-key:", crmKey);

    if (crmKey !== CRM_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid x-crm-key' });
    }

    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
        return res.status(400).json({ status: 'error', message: 'No leads provided' });
    }

    // ── Task 3: Idempotency Guard ─────────────────────────────────────────────
    const pendingLeads = leads.filter(l => !l.pushed_to_crm);
    const alreadyPushedCount = leads.length - pendingLeads.length;

    if (pendingLeads.length === 0) {
        return res.json({
            status: 'success',
            message: 'All selected leads have already been pushed to CRM.',
            processed: 0,
            already_pushed: alreadyPushedCount
        });
    }

    if (pendingLeads.length > 20) {
        return res.status(400).json({
            status: "error",
            message: "Too many new leads selected. Please filter smaller batches (Max 20)."
        });
    }

    console.log(`[CRM] Processing ${pendingLeads.length} lead(s) | Skipped ${alreadyPushedCount} already pushed`);

    try {
        const results = await processQueue(pendingLeads);

        const successfulLeads = results.filter(r => r.success).map(r => r.id);
        const failedLeads     = results.filter(r => !r.success);

        if (successfulLeads.length > 0) {
            const { error: updateError } = await supabaseAdmin
                .from('leads_surgery')
                .update({ pushed_to_crm: true, status: 'PUSHED_TO_CRM' })
                .in('id', successfulLeads);

            if (updateError) {
                console.error('[CRM] Failed to update Supabase after CRM push:', updateError);
            } else {
                console.log(`[DB] Marked ${successfulLeads.length} lead(s) as pushed_to_crm=true`);
            }
        }

        res.json({
            status: 'success',
            processed: results.length,
            success_count: successfulLeads.length,
            failed_count: failedLeads.length,
            failed_leads: failedLeads
        });
    } catch (error) {
        console.error('[CRM ERROR]', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ─── Lead Ingestion ───────────────────────────────────────────────────────────
app.post('/api/ingest-lead', async (req, res) => {
    const botKey = req.headers['x-bot-key'];
    console.log("🔐 RECEIVED KEY:", botKey);

    if (botKey !== BOT_SECRET) {
        console.warn(`[API] 🔐 Unauthorized access attempt from IP: ${req.ip}`);
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    try {
        console.log("[API] Incoming request body:", JSON.stringify(req.body, null, 2));
        const payload = req.body;

        if (!payload.phone_number) {
            return res.status(400).json({ status: 'error', message: 'Missing phone_number' });
        }

        if (payload.phone_number.length > 20) {
            return res.status(400).json({ status: 'error', message: 'Invalid phone number format' });
        }

        console.log(`[API] Ingesting | phone=${payload.phone_number} | trigger=${payload.ingestion_trigger || 'unknown'}`);
        console.log("[DB INSERT]", payload);
        
        const { data, action } = await ingestLead(supabaseAdmin, payload);

        console.log(`[DB] ${action.toUpperCase()} | id=${data.id} | phone=${payload.phone_number}`);

        res.json({ status: 'success', action, lead_id: data.id });
    } catch (error) {
        console.error('[API] ❌ Ingestion error:', error.message);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

// ─── Check Lead (returning user) ──────────────────────────────────────────────
app.get('/api/check-lead/:phone', async (req, res) => {
    const botKey = req.headers['x-bot-key'];

    if (botKey !== BOT_SECRET) {
        console.warn(`[API] 🔐 Unauthorized access attempt from IP: ${req.ip}`);
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    const { phone } = req.params;
    try {
        const { data, error } = await supabaseAdmin
            .from('leads_surgery')
            .select('id, contact_name, status, lead_stage, interest_cost, interest_recovery, concern_pain, concern_safety, urgency_level')
            .eq('phone_number', phone)
            .maybeSingle();

        if (error) throw error;
        
        res.json({ status: 'success', exists: !!data, lead: data });
    } catch (error) {
        console.error('[API] ❌ Check-lead error:', error.message);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ─── Delete Lead ──────────────────────────────────────────────────────────────
app.delete('/api/leads/:id', async (req, res) => {
  const apiKey = req.headers['x-crm-key'];
  if (apiKey !== CRM_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from('leads_surgery')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Deduplication store (in-memory, per process) ────────────────────────────
const processedMessageIds = new Set();

// ─── Safe WhatsApp send ───────────────────────────────────────────────────────
async function sendWhatsAppReply(phone, reply) {
    const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to: phone,
        text: { body: reply }
    };

    let rawText = '';
    try {
        console.log('[WA SEND] Sending reply to', phone);
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        rawText = await res.text();

        if (res.status === 429) {
            console.warn('[WA SEND] ⚠️ Rate limited (429) — skipping retry');
            return;
        }

        // Only parse as JSON if it looks like JSON
        if (rawText.trim().startsWith('{') || rawText.trim().startsWith('[')) {
            const data = JSON.parse(rawText);
            console.log('[WA SEND] ✅ Success:', JSON.stringify(data));
        } else {
            console.warn('[WA SEND] ⚠️ Non-JSON response (status', res.status, '):', rawText.substring(0, 200));
        }
    } catch (err) {
        console.error('[WA SEND] ❌ Error:', err.message);
        console.error('[WA SEND] Raw response was:', rawText.substring(0, 300));
    }
}

// ─── CRM push to Railway ──────────────────────────────────────────────────────
async function pushLeadToCRM(lead) {
    const CRM_URL = 'https://relive-cure-backend-production.up.railway.app/api/push-to-crm-form';
    const key     = process.env.CRM_API_KEY || 'relive_crm_secure_key_2026';

    try {
        console.log('[CRM PUSH] Sending lead to Railway CRM:', lead.phone_number);
        const res = await fetch(CRM_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-crm-key': key
            },
            body: JSON.stringify({ leads: [lead] })
        });

        const rawText = await res.text();
        if (rawText.trim().startsWith('{') || rawText.trim().startsWith('[')) {
            const data = JSON.parse(rawText);
            console.log('[CRM PUSH] ✅ Success:', JSON.stringify(data));
        } else {
            console.warn('[CRM PUSH] ⚠️ Non-JSON response (status', res.status, '):', rawText.substring(0, 200));
        }
    } catch (err) {
        console.error('[CRM PUSH] ❌ Failed (non-fatal):', err.message);
        // Never crash the webhook — CRM push failure is non-fatal
    }
}

// ─── WhatsApp Webhook Verification ───────────────────────────────────────────
app.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('[WEBHOOK] ✅ Verification successful');
        return res.status(200).send(challenge);
    }

    console.warn('[WEBHOOK] ❌ Verification failed');
    return res.sendStatus(403);
});

// ─── WhatsApp Incoming Messages ───────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    // Acknowledge Meta immediately — must respond <5s or Meta retries
    res.sendStatus(200);

    try {
        const entry   = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value   = changes?.value;
        const message = value?.messages?.[0];

        // Ignore status updates (delivered, read receipts)
        if (!message) {
            console.log('[WEBHOOK] No message in payload — likely a status update, skipping.');
            return;
        }

        // ── Deduplication ──────────────────────────────────────────────────────
        const msgId = message.id;
        if (processedMessageIds.has(msgId)) {
            console.log('[WEBHOOK] 🔁 Duplicate message ID', msgId, '— skipping.');
            return;
        }
        processedMessageIds.add(msgId);
        // Evict old IDs to prevent unbounded memory growth (keep last 500)
        if (processedMessageIds.size > 500) {
            const first = processedMessageIds.values().next().value;
            processedMessageIds.delete(first);
        }

        const phone = message.from;
        const text  = message.text?.body || '';

        console.log('[WEBHOOK] 📩 WhatsApp incoming | phone:', phone, '| text:', text, '| msgId:', msgId);

        // ── Call chatbot (safe: text-first parse, 10s timeout) ────────────────
        let reply = 'Got it 👍';
        try {
            console.log('[BOT] Calling chatbot service...');
            const botController = new AbortController();
            const botTimeout = setTimeout(() => botController.abort(), 10000);
            const botRes = await fetch('https://lasik-whatsapp-bot-production.up.railway.app/webhook', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ phone, message: text }),
                signal:  botController.signal
            });
            clearTimeout(botTimeout);
            const botRaw = await botRes.text();
            console.log('[BOT] Raw response (first 300):', botRaw.substring(0, 300));
            if (botRaw.trim().startsWith('{') || botRaw.trim().startsWith('[')) {
                const botData = JSON.parse(botRaw);
                reply = botData.reply || reply;
                console.log('[BOT] 🤖 Reply received:', reply);
            } else {
                console.warn('[BOT] ⚠️ Non-JSON response from chatbot (status', botRes.status, ') — using fallback');
            }
        } catch (botErr) {
            if (botErr.name === 'AbortError') {
                console.error('[BOT] ❌ Chatbot timed out after 10s — using fallback reply');
            } else {
                console.error('[BOT] ❌ Chatbot call failed:', botErr.message, '— using fallback reply');
            }
        }

        // ── Send WhatsApp reply (exactly once, safe) ───────────────────────────
        await sendWhatsAppReply(phone, reply);

        // ── Ingest lead into Supabase ──────────────────────────────────────────
        let ingestedLead = null;
        try {
            console.log('[DB] Ingesting lead for phone:', phone);
            const payload = {
                phone_number:       phone,
                last_user_message:  text,
                ingestion_trigger:  'whatsapp_webhook',
            };
            const { data, action } = await ingestLead(supabaseAdmin, payload);
            ingestedLead = data;
            console.log(`[DB] ✅ ${action.toUpperCase()} | id=${data.id} | phone=${phone}`);
        } catch (dbErr) {
            console.error('[DB] ❌ Ingestion failed:', dbErr.message);
        }

        // ── CRM push is INTENTIONALLY NOT triggered here ────────────────────
        // CRM push only happens via Dashboard → "Push to CRM" button (manual).
        // Auto-pushing on every webhook message produces bad data (no name etc.)
        if (ingestedLead) {
            console.log(`[DB] ✅ Lead ${ingestedLead.id} saved. CRM push must be done via Dashboard.`);
        }


    } catch (err) {
        console.error('[WEBHOOK] ❌ Unhandled error:', err.message);
    }
});

// ─── Keep-alive + Puppeteer warm-up (prevents Railway sleep + pre-warms Chrome) ─
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
  : null;

if (SELF_URL) {
  let puppeteerWarmed = false;
  setInterval(async () => {
    try {
      const r = await fetch(SELF_URL);
      console.log(`[KEEPALIVE] Self-ping → ${r.status}`);

      // 🔥 Warm Puppeteer on first ping — lazy import since it's ESM
      if (!puppeteerWarmed) {
        puppeteerWarmed = true;
        console.log('[KEEPALIVE] Launching Puppeteer warm-up...');
        try {
          const { getBrowser } = await import('./crm-automation.js');
          // getBrowser() is not exported — use processQueue with empty set as no-op
          // Instead, just import to trigger module evaluation and Chrome path resolution
          const { processQueue: _pq } = await import('./crm-automation.js');
          console.log('[KEEPALIVE] ✅ Puppeteer module loaded and warmed');
        } catch (pe) {
          console.warn('[KEEPALIVE] Puppeteer warm-up error (non-fatal):', pe.message);
        }
      }
    } catch (e) {
      console.warn('[KEEPALIVE] Ping failed:', e.message);
    }
  }, 4 * 60 * 1000); // every 4 minutes
  console.log(`[KEEPALIVE] Enabled → ${SELF_URL}`);
} else {
  console.log('[KEEPALIVE] RAILWAY_PUBLIC_DOMAIN not set — keep-alive disabled');
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] ✅ Production Server running on port ${PORT}`);
  console.log(`[API] Health: GET https://relive-cure-backend-production.up.railway.app/health`);
});
