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
console.log('═══════════════════════════════════════');
console.log('[BOOT] ✅ Server starting...');
console.log('[BOOT] SUPABASE_URL:', process.env.SUPABASE_URL || '❌ MISSING');
console.log('[BOOT] SUPABASE_KEY LENGTH:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length || '❌ MISSING');
console.log('[BOOT] CRM_API_KEY SET:', !!process.env.CRM_API_KEY);
console.log('[BOOT] NODE_VERSION:', process.version);
console.log('═══════════════════════════════════════');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_SECRET = 'RELIVE_BOT_SECRET';
const CRM_API_KEY = process.env.CRM_API_KEY || 'relive_crm_secure_key_2026';
console.log("EXPECTED CRM_API_KEY:", process.env.CRM_API_KEY || CRM_API_KEY);

app.use(cors());
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', node: process.version, ts: new Date().toISOString() });
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

    if (leads.length > 20) {
        return res.status(400).json({
            status: "error",
            message: "Too many leads selected. Please filter smaller batches (Max 20)."
        });
    }

    console.log(`[CRM] Processing ${leads.length} lead(s)`);

    try {
        const results = await processQueue(leads);

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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] ✅ Production Server running on port ${PORT}`);
  console.log(`[API] Test DB: GET https://relive-cure-backend.onrender.com/test-db`);
});
