import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ingestLead } from '../src/lib/ingestion.js';
import { processQueue } from './crm-automation.js';
import { supabaseAdmin } from './supabase-admin.js';

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_SECRET = 'RELIVE_BOT_SECRET';
const CRM_API_KEY = process.env.CRM_API_KEY || 'relive_crm_secure_key_2026';
console.log("EXPECTED CRM_API_KEY:", process.env.CRM_API_KEY || CRM_API_KEY);

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Production Ingestion API — CRM Push with dedup guard
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

        // Basic Sanitize
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

// New: Check if lead exists for returning user logic
app.get('/api/check-lead/:phone', async (req, res) => {
    const botKey = req.headers['x-bot-key'];
    console.log("🔐 RECEIVED KEY:", botKey);

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

app.listen(PORT, () => {
    console.log(`[API] Production Server running on port ${PORT}`);
});
