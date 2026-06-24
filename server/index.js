// ─── STEP 1: Polyfill fetch BEFORE any other import that uses it ─────────────
import fetch from 'node-fetch';
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
    console.log('[BOOT] node-fetch polyfill applied');
} else {
    globalThis.fetch = fetch;
    console.log('[BOOT] node-fetch override applied (replacing native fetch)');
}

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ingestLead } from '../src/lib/ingestion.js';
import { processQueue } from './crm-automation.js';
import { supabaseAdmin } from './supabase-admin.js';
import { syncRefrensLeads } from './refrens-sync.js';
import { saveWhatsAppMessage } from './whatsapp-store.js';
import { isAgentEnabled, agentMode, setAgentMode, runGeminiAgentDetailed, agentStatus, getLastAgentFailReason, getLastAgentModel } from './llm-agent.js';
import { clearAllGoogleModelExhausted, googleExhaustedModels } from './gemini-model-health.js';
import { INDIAN_CITIES, isIndianCity, titleCaseCity, isInventedAgentClaim } from './bot-guard.js';
import { registerBotLabRoutes, isLabPhone } from './bot-lab.js';
import { registerOperatorRoutes } from './operator-routes.js';
import { issueDashboardSession, parseDashboardSession, requireDashboardAuth } from './dashboard-auth.js';
import { hydrateQuota, ensureQuotaHydrated, isUnderQuota, quotaStatus, quotaStatusAll, quotaStatusForClient, quotaDashboard } from './agent-quota.js';
import { setChannelMode } from './gemini-model-tracker.js';
import { saveSubscription, removeSubscription, fanout, isPushConfigured, VAPID_PUBLIC_KEY } from './push.js';
import { REFRENS_LABELS, REFRENS_STATUS } from '../src/lib/enums.js';
import multer from 'multer';

// In-memory upload (we re-stream to Meta immediately; files are bounded to ~25MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26 * 1024 * 1024 } });
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Startup env diagnostics ──────────────────────────────────────────────────
const REQUIRED_ENV = ["BOT_SECRET", "CRM_API_KEY", "WEBHOOK_VERIFY_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WHATSAPP_ACCESS_TOKEN", "PHONE_NUMBER_ID"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) { console.error(`[FATAL] Missing env vars: ${missing.join(", ")}`); process.exit(1); }

console.log('═══════════════════════════════════════');
console.log('[BOOT] ✅ Server starting...');
console.log('[BOOT] BOT_SECRET SET:', !!process.env.BOT_SECRET);
console.log('[BOOT] PHONE_NUMBER_ID SET:', !!process.env.PHONE_NUMBER_ID);
console.log('[BOOT] NODE_VERSION:', process.version);
console.log('[BOOT] LLM AGENT:', isAgentEnabled() ? `${agentMode().toUpperCase()} (${process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'})` : 'OFF (rule-based bot)');
console.log('═══════════════════════════════════════');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_SECRET = process.env.BOT_SECRET;
const CRM_API_KEY = process.env.CRM_API_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

app.use(cors());
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', node: process.version, ts: new Date().toISOString(), uptime: process.uptime(), bot: 'v6.2-stable', agent: agentStatus() });
});

// ─── Agent mode toggle (dashboard UI) ──────────────────────────────────────
app.get('/api/agent/mode', (req, res) => {
    res.json({ success: true, ...agentStatus() });
});

app.post('/api/agent/mode', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const { mode } = req.body;
    if (!mode || !['shadow', 'live', 'off'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'mode must be "shadow", "live", or "off"' });
    }
    setAgentMode(mode);
    res.json({ success: true, ...agentStatus() });
});

/** Clear false-positive "Google daily exhausted" flags (e.g. after RPM 429). Admin only. */
app.post('/api/agent/clear-exhausted', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const before = googleExhaustedModels();
    clearAllGoogleModelExhausted();
    res.json({
        success: true,
        cleared: before,
        message: before.length ? `Cleared ${before.length} exhausted model flag(s). Refresh Bot Lab.` : 'No exhausted flags were set.',
        ...agentStatus(),
    });
});

// Persisted Gemini credit counter (Supabase agent_quota) — source of truth for the dashboard.
app.get('/api/agent/quota', async (req, res) => {
    try {
        await ensureQuotaHydrated();
        const status = agentStatus();
        const dashboard = quotaDashboard();
        const q = dashboard.channels.whatsapp;
        const remaining = q.remaining ?? Math.max(0, (q.cap || 5600) - (q.count || 0));
        const agentPaused = status.enabled && remaining <= 0;
        const resetsAt = new Date();
        resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
        resetsAt.setUTCHours(0, 0, 0, 0);
        res.json({
            success: true,
            ...status,
            quota: { ...q, remaining },
            quotas: quotaStatusForClient(),
            quota_dashboard: dashboard,
            operator_quota: dashboard.channels.operator,
            operator_transcribe_quota: dashboard.channels.operator_transcribe,
            agent_paused: agentPaused,
            pause_reason: agentPaused ? 'whatsapp_daily_cap_reached' : null,
            resets_at: resetsAt.toISOString(),
            note: 'Independent budgets: whatsapp (customer models) vs operator (CRM models). Shared google_exhausted_models only when Google 429s a model.',
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── DB test ──────────────────────────────────────────────────────────────────
app.get('/test-db', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin.from('leads_surgery').select('id, phone_number, contact_name, created_at').limit(1);
        if (error) return res.status(500).json({ success: false, error: error.message });
        return res.json({ success: true, message: 'Supabase connected', sample: data });
    } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
const VALID_TABS = ['pulse', 'chatbot', 'botlab', 'inbox', 'analytics', 'marketing', 'hr', 'settings', 'export_leads'];
const ROLE_DEFAULT_TABS = {
    admin: VALID_TABS,
    limited: ['chatbot', 'hr'],
    rep: ['chatbot', 'inbox'],
    hr: ['hr'],
};

function normalizeTabs(tabs, roleFallback = 'limited') {
    const arr = Array.isArray(tabs) ? tabs.filter(t => VALID_TABS.includes(t)) : [];
    return arr.length ? arr : (ROLE_DEFAULT_TABS[roleFallback] || ['chatbot']);
}

async function getAllowedTabsForUser(session) {
    if (!session) return [];
    if (session.role === 'admin') return VALID_TABS;
    try {
        const { data } = await supabaseAdmin
            .from('dashboard_users')
            .select('allowed_tabs, role')
            .eq('username', session.username)
            .maybeSingle();
        return normalizeTabs(data?.allowed_tabs, data?.role || session.role);
    } catch {
        return normalizeTabs(null, session.role);
    }
}

async function requireCrmKey(req, res, opts = {}) {
    if (!requireDashboardAuth(req, res, { adminOnly: opts.adminOnly })) return false;
    if (opts.adminOnly) return true;
    const need = opts.permission || opts.tab;
    if (need) {
        const tabs = await getAllowedTabsForUser(req.dashboardUser);
        if (!tabs.includes(need)) {
            res.status(403).json({ success: false, error: 'Access denied' });
            return false;
        }
    }
    return true;
}

function getSessionToken() {
    const u = process.env.VITE_ADMIN_USERNAME || '';
    const p = process.env.VITE_ADMIN_PASSWORD || '';
    return crypto.createHmac('sha256', CRM_API_KEY || 'fallback').update(`${u}:${p}`).digest('hex');
}

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const validUsername = process.env.VITE_ADMIN_USERNAME || 'admin';
    const validPassword = process.env.VITE_ADMIN_PASSWORD;
    if (!validPassword) return res.status(503).json({ success: false, message: 'Auth not configured' });
    // Built-in admin check
    if (username === validUsername && password === validPassword) {
        return res.json({
            success: true,
            token: issueDashboardSession(validUsername, 'admin'),
            sessionToken: getSessionToken(),
            username: validUsername,
            role: 'admin',
            designation: null,
            allowed_tabs: VALID_TABS,
        });
    }
    // Extra users from dashboard_users table
    try {
        const { data } = await supabaseAdmin
            .from('dashboard_users')
            .select('username, password_hash, role, designation, allowed_tabs')
            .eq('username', username)
            .maybeSingle();
        if (data && data.password_hash === crypto.createHash('sha256').update(`rc_user:${password}:relive_cure`).digest('hex')) {
            const role = data.role || 'limited';
            const allowedTabs = normalizeTabs(data.allowed_tabs, role);
            return res.json({
                success: true,
                token: issueDashboardSession(data.username, role),
                sessionToken: getSessionToken(),
                username: data.username,
                role,
                designation: data.designation || null,
                allowed_tabs: allowedTabs,
            });
        }
    } catch { /* table may not exist yet — fall through */ }
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.get('/api/auth/verify', async (req, res) => {
    const token = req.headers['x-crm-key'] || req.headers['x-session-token'];
    const session = parseDashboardSession(token);
    if (!session) return res.json({ valid: false });
    const allowed_tabs = await getAllowedTabsForUser(session);
    res.json({ valid: true, username: session.username, role: session.role, allowed_tabs });
});

// ─── Refrens cookies ──────────────────────────────────────────────────────────
app.get('/api/export-refrens-cookies', async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try { const { getBrowserCookies } = await import('./crm-automation.js'); const cookies = await getBrowserCookies(); res.json({ cookies }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: dump the live Refrens new-lead form structure. Read-only.
app.get('/api/diag/crm-form', async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { dumpCrmNewLeadForm } = await import('./crm-automation.js');
        const dump = await dumpCrmNewLeadForm();
        res.json({ success: true, ...dump });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
    }
});

// Diagnostic: list which Gemini/Gemma models THIS API key can call + free-tier
// methods. Read-only, returns only public model ids (never the key). Open so the
// real available ids can be verified without dashboard auth.
app.get('/api/diag/gemini-models', async (req, res) => {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY not set' });
    try {
        const r = await globalThis.fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${process.env.GEMINI_API_KEY}`);
        const j = await r.json();
        const models = (j.models || [])
            .map(m => ({
                id: (m.name || '').replace(/^models\//, ''),
                methods: m.supportedGenerationMethods || [],
            }))
            .filter(m => m.methods.includes('generateContent'))
            .map(m => m.id)
            .sort();
        const want = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemma-4-31b', 'gemini-2.5-pro'];
        const matches = {};
        for (const w of want) matches[w] = models.filter(id => id.includes(w.replace('gemini-', '').replace('gemma-', '')) || id === w);
        res.json({ success: true, generateContent_models: models, lookups: matches });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Sanity check ─────────────────────────────────────────────────────────────
async function runSanityCheck() {
    const [labelsRes, statusRes] = await Promise.all([
        supabaseAdmin.from('refrens_leads').select('labels'),
        supabaseAdmin.from('refrens_leads').select('status'),
    ]);
    const knownLabels = new Set(REFRENS_LABELS);
    const unknownLabels = new Set();
    labelsRes.data?.forEach(row => {
        if (!row.labels) return;
        row.labels.split(',').forEach(l => { const t = l.trim(); if (t && !knownLabels.has(t)) unknownLabels.add(t); });
    });
    const knownStatuses = new Set(REFRENS_STATUS);
    const unknownStatuses = new Set();
    statusRes.data?.forEach(row => { if (row.status && !knownStatuses.has(row.status)) unknownStatuses.add(row.status); });
    const alarms = [];
    if (unknownLabels.size > 0) alarms.push(`Unknown labels: ${[...unknownLabels].join(', ')}`);
    if (unknownStatuses.size > 0) alarms.push(`Unknown statuses: ${[...unknownStatuses].join(', ')}`);
    if (alarms.length > 0) {
        console.warn('[SANITY] ⚠️', alarms.join(' | '));
        if (isPushConfigured()) {
            fanout(supabaseAdmin, { title: '⚠️ Vocabulary drift', body: alarms.join(' | ').slice(0, 100), url: '/m', kind: 'escalation' }).catch(() => {});
        }
    } else {
        console.log('[SANITY] ✅ All labels/statuses known');
    }
    return { alarms, checkedAt: new Date().toISOString() };
}

app.get('/api/sanity-check', async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const result = await runSanityCheck();
        res.json({ ok: true, ...result });
    } catch (e) {
        console.error('[SANITY] ❌ route error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── CRM Push ─────────────────────────────────────────────────────────────────
app.post('/api/push-to-crm-form', async (req, res) => {
    const crmKey = req.headers['x-crm-key'];
    if (crmKey !== CRM_API_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) return res.status(400).json({ status: 'error', message: 'No leads provided' });
    const pendingLeads = leads.filter(l => !l.pushed_to_crm);
    if (pendingLeads.length === 0) return res.json({ status: 'success', message: 'All already pushed.', processed: 0 });
    if (pendingLeads.length > 20) return res.status(400).json({ status: 'error', message: 'Max 20 leads per batch.' });
    try {
        const results = await processQueue(pendingLeads);
        const failedLeads = results.filter(r => !r.success);
        // Per-lead update so we can persist the per-lead Refrens URL/ID returned by processLead
        const successResults = results.filter(r => r.success);
        for (const r of successResults) {
          const patch = {
            pushed_to_crm: true,
            status: 'PUSHED_TO_CRM',
          };
          if (r.refrens_url) patch.refrens_lead_url = r.refrens_url;
          if (r.refrens_id)  patch.refrens_lead_id  = r.refrens_id;
          // Persist the assignee we just set in Refrens back to leads_surgery so the
          // Chatbot view reflects it immediately (instead of showing "Unassigned"
          // until the next 4h sync writeback).
          const orig = pendingLeads.find(l => l.id === r.id);
          if (orig?.assignee && String(orig.assignee).trim().length >= 2) patch.assignee = String(orig.assignee).trim();
          try {
            const { error } = await supabaseAdmin.from('leads_surgery').update(patch).eq('id', r.id);
            if (error) console.warn(`[CRM] Failed to persist refrens URL for lead ${r.id}:`, error.message);
          } catch (e) {
            console.warn(`[CRM] Persist error for lead ${r.id}:`, e.message);
          }
        }
        // Keep the existing successfulLeads computation for the response
        const successfulLeads = successResults.map(r => r.id);
        res.json({ status: 'success', processed: results.length, success_count: successfulLeads.length, failed_count: failedLeads.length, failed_leads: failedLeads });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ─── Auto-push config (founder-controlled hands-free CRM push) ──────────────
// When enabled, the worker (further below) pushes new, quiet, qualified
// chatbot leads to Refrens automatically and assigns each to a rep. The config
// lives in the single-row auto_push_config table (see migrations) so it
// survives restarts and runs even with no dashboard open.
const AUTO_PUSH_DEFAULT = { id: 1, enabled: false, enabled_at: null, rep_a: null, rep_b: null, split_a_pct: 100 };
async function readAutoPushConfig() {
  try {
    const { data, error } = await supabaseAdmin.from('auto_push_config').select('*').eq('id', 1).maybeSingle();
    if (error) return { ...AUTO_PUSH_DEFAULT, _available: !/(does not exist|schema cache)/i.test(error.message || '') };
    return { ...AUTO_PUSH_DEFAULT, ...(data || {}), _available: true };
  } catch { return { ...AUTO_PUSH_DEFAULT, _available: false }; }
}

app.get('/api/auto-push/config', async (req, res) => {
  if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const cfg = await readAutoPushConfig();
  return res.json({ success: true, available: cfg._available !== false, config: cfg });
});

app.post('/api/auto-push/config', async (req, res) => {
  if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const { enabled, rep_a, rep_b, split_a_pct, updated_by } = req.body || {};
  if (enabled && (!rep_a || !String(rep_a).trim())) {
    return res.status(400).json({ success: false, error: 'At least one rep is required to enable auto-push.' });
  }
  const prev = await readAutoPushConfig();
  const cleanB = rep_b && String(rep_b).trim() ? String(rep_b).trim() : null;
  const row = {
    id: 1,
    enabled: !!enabled,
    rep_a: rep_a ? String(rep_a).trim() : null,
    rep_b: cleanB,
    split_a_pct: cleanB ? Math.max(1, Math.min(99, Math.round(Number(split_a_pct) || 50))) : 100,
    updated_by: updated_by ? String(updated_by).slice(0, 80) : null,
    updated_at: new Date().toISOString(),
    // Re-stamp enabled_at only on an OFF→ON transition so "from that point onwards" is honoured.
    enabled_at: enabled ? ((prev && prev.enabled && prev.enabled_at) ? prev.enabled_at : new Date().toISOString()) : (prev?.enabled_at || null),
  };
  const { error } = await supabaseAdmin.from('auto_push_config').upsert(row, { onConflict: 'id' });
  if (error) {
    const hint = /(does not exist|schema cache)/i.test(error.message || '')
      ? 'auto_push_config table missing — run server/migrations/create_auto_push_config.sql in Supabase first.'
      : error.message;
    return res.status(500).json({ success: false, error: hint });
  }
  console.log(`[AUTO-PUSH] config updated → enabled=${row.enabled}${row.enabled ? ` reps=${row.rep_a}${row.rep_b ? `/${row.rep_b} (${row.split_a_pct}/${100 - row.split_a_pct})` : ''}` : ''}`);
  return res.json({ success: true, config: row });
});

// ─── Lead Lore Engine: call recordings (Phase 4A rep app) ───────────────────
// The rep Android app pairs the OEM call recording with the call-log entry,
// uploads the audio to the rep's Drive, then POSTs the metadata here. We store
// it in call_recordings, link it to the CRM/chatbot lead by phone, and emit a
// lead_events 'call' row so the call shows up in the lead's Lore timeline.
function normCallPhone(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  if (d.length < 7) return null;
  if (d.startsWith('91') && d.length === 12) return d.slice(2);
  if (d.length > 10) return d.slice(-10);
  return d;
}
async function linkCallToLead(phone) {
  try {
    const { data: ref } = await supabaseAdmin.from('refrens_leads').select('id').eq('phone', phone).maybeSingle();
    if (ref) return { matched_lead_id: ref.id, matched_source: 'refrens' };
    const { data: bot } = await supabaseAdmin.from('leads_surgery').select('id').eq('phone_number', phone).maybeSingle();
    if (bot) return { matched_lead_id: bot.id, matched_source: 'chatbot' };
  } catch { /* best-effort */ }
  return { matched_lead_id: null, matched_source: null };
}

// POST /api/calls/upload-complete — the app reports a finished (and optionally
// uploaded) call. Idempotent on drive_file_id when present.
app.post('/api/calls/upload-complete', async (req, res) => {
  if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const b = req.body || {};
  const phone = normCallPhone(b.phone);
  if (!phone) return res.status(400).json({ success: false, error: 'A valid phone number is required.' });
  const duration = Math.max(0, Math.round(Number(b.duration_sec) || 0));
  const connected = (typeof b.connected === 'boolean') ? b.connected : duration >= 5;
  const link = await linkCallToLead(phone);
  const startedAt = b.call_started_at ? new Date(b.call_started_at).toISOString() : new Date().toISOString();
  const row = {
    rep_id: b.rep_id ? String(b.rep_id).slice(0, 80) : null,
    rep_name: b.rep_name ? String(b.rep_name).slice(0, 120) : null,
    phone,
    direction: b.direction === 'inbound' ? 'inbound' : (b.direction === 'outbound' ? 'outbound' : null),
    call_started_at: startedAt,
    duration_sec: duration,
    connected,
    outcome: b.outcome ? String(b.outcome).slice(0, 80) : null,
    followup_needed: !!b.followup_needed,
    drive_file_id: b.drive_file_id ? String(b.drive_file_id).slice(0, 200) : null,
    drive_file_url: b.drive_file_url ? String(b.drive_file_url).slice(0, 500) : null,
    matched_lead_id: link.matched_lead_id,
    matched_source: link.matched_source,
    transcript_status: b.drive_file_id ? 'pending' : 'no_recording',
    device_meta: b.device_meta && typeof b.device_meta === 'object' ? b.device_meta : null,
    updated_at: new Date().toISOString(),
  };
  try {
    let saved;
    if (row.drive_file_id) {
      // Idempotent upsert on drive_file_id so a retried upload doesn't double-insert.
      const { data, error } = await supabaseAdmin.from('call_recordings').upsert(row, { onConflict: 'drive_file_id' }).select('id').maybeSingle();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabaseAdmin.from('call_recordings').insert(row).select('id').maybeSingle();
      if (error) throw error;
      saved = data;
    }
    // Fire-and-forget Lore event so the call shows in the lead timeline.
    supabaseAdmin.from('lead_events').insert({
      phone, ts: startedAt, event_type: 'call', source: 'call',
      payload: { direction: row.direction, duration_sec: duration, connected, outcome: row.outcome, followup_needed: row.followup_needed, rep_name: row.rep_name, drive_file_url: row.drive_file_url, call_id: saved?.id || null },
    }).then(() => {}, (e) => console.warn('[CALLS] lead_events emit failed:', e?.message));
    console.log(`[CALLS] ${row.direction || 'call'} ${connected ? 'connected' : 'no-answer'} ${duration}s · ${phone} · rep=${row.rep_name || row.rep_id || '?'}${row.outcome ? ` · ${row.outcome}` : ''}`);
    return res.json({ success: true, id: saved?.id || null, linked: link.matched_source });
  } catch (err) {
    const hint = /(does not exist|schema cache)/i.test(err.message || '')
      ? 'call_recordings table missing — run server/migrations/create_call_recordings.sql in Supabase first.'
      : err.message;
    console.error('[CALLS] upload-complete failed:', hint);
    return res.status(500).json({ success: false, error: hint });
  }
});

// PATCH /api/calls/:id — post-call tag from rep app (outcome + follow-up flag).
app.patch('/api/calls/:id', async (req, res) => {
  if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ success: false, error: 'Call id required.' });
  const b = req.body || {};
  const patch = { updated_at: new Date().toISOString() };
  if (b.outcome != null) patch.outcome = String(b.outcome).slice(0, 80);
  if (typeof b.followup_needed === 'boolean') patch.followup_needed = b.followup_needed;
  try {
    const { data, error } = await supabaseAdmin.from('call_recordings').update(patch).eq('id', id).select('id, phone, outcome, followup_needed').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Call not found.' });
    return res.json({ success: true, call: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/calls/upload-recording — rep app uploads OEM .m4a to Supabase Storage (increment 2–3 shortcut vs Drive).
app.post('/api/calls/upload-recording', upload.single('file'), async (req, res) => {
  if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const file = req.file;
  const callId = req.body?.call_id ? String(req.body.call_id).trim() : null;
  if (!file?.buffer?.length) return res.status(400).json({ success: false, error: 'Audio file required.' });
  if (!callId) return res.status(400).json({ success: false, error: 'call_id required.' });
  const repId = req.body?.rep_id ? String(req.body.rep_id).slice(0, 80) : 'unknown';
  const ext = (file.originalname || 'recording.m4a').split('.').pop() || 'm4a';
  const storagePath = `rep/${repId}/${callId}.${ext.replace(/[^a-z0-9]/gi, '')}`;
  try {
    const { error: upErr } = await supabaseAdmin.storage.from('call-recordings').upload(storagePath, file.buffer, {
      contentType: file.mimetype || 'audio/mp4',
      upsert: true,
    });
    if (upErr) throw upErr;
    const { data: pub } = supabaseAdmin.storage.from('call-recordings').getPublicUrl(storagePath);
    const { data, error } = await supabaseAdmin.from('call_recordings').update({
      drive_file_id: storagePath,
      drive_file_url: pub?.publicUrl || null,
      transcript_status: 'pending',
      updated_at: new Date().toISOString(),
    }).eq('id', callId).select('id, drive_file_url, transcript_status').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Call row not found — report call metadata first.' });
    console.log(`[CALLS] recording uploaded ${storagePath} → call ${callId}`);
    return res.json({ success: true, id: data.id, url: data.drive_file_url, transcript_status: data.transcript_status });
  } catch (err) {
    console.error('[CALLS] upload-recording failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/calls — call validation feed for the dashboard. Optional filters:
// ?rep=, ?phone=, ?since=ISO, ?limit=. Returns rows + headline aggregates.
app.get('/api/calls', async (req, res) => {
  if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    let q = supabaseAdmin.from('call_recordings').select('*').order('call_started_at', { ascending: false }).limit(limit);
    if (req.query.rep) q = q.eq('rep_id', String(req.query.rep));
    if (req.query.phone) { const p = normCallPhone(req.query.phone); if (p) q = q.eq('phone', p); }
    if (req.query.since) q = q.gte('call_started_at', new Date(req.query.since).toISOString());
    const { data, error } = await q;
    if (error) {
      const hint = /(does not exist|schema cache)/i.test(error.message || '')
        ? 'call_recordings table missing — run the migration in Supabase first.' : error.message;
      return res.status(500).json({ success: false, error: hint, available: false });
    }
    const calls = data || [];
    const connected = calls.filter(c => c.connected).length;
    const stats = {
      total: calls.length,
      connected,
      not_connected: calls.length - connected,
      connect_rate: calls.length ? Math.round((connected / calls.length) * 100) : 0,
      followups: calls.filter(c => c.followup_needed).length,
      with_recording: calls.filter(c => c.drive_file_id).length,
      transcribed: calls.filter(c => c.transcript_status === 'done').length,
    };
    return res.json({ success: true, available: true, stats, calls });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Web Push subscribe / unsubscribe (mobile companion app) ────────────────
// Diagnostic — verify push is fully wired (no auth so it can be hit easily).
// Returns whether VAPID env is set + current subscriber count. Used by the
// dashboard sidebar to show "Notifications on/off" status accurately.
app.get('/api/push/status', async (req, res) => {
  try {
    const configured = isPushConfigured();
    const { count } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint', { count: 'exact', head: true });
    res.json({ configured, subscribers: count ?? 0 });
  } catch (e) {
    res.status(500).json({ configured: isPushConfigured(), error: e.message });
  }
});

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY, configured: isPushConfigured() });
});

// Subscribe + unsubscribe DO NOT require x-crm-key. Reasoning: the
// subscription payload is the user's own browser endpoint + public keys —
// stealing it grants nothing. The security boundary is VAPID-key signing
// on the SEND side, which only the backend has. Auth-gating subscribe
// just causes silent setup failures when localStorage.crm_token drifts
// from CRM_API_KEY.
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, user_id, user_agent } = req.body || {};
    await saveSubscription(supabaseAdmin, subscription, { user_id, user_agent });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await removeSubscription(supabaseAdmin, endpoint);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Test endpoint — manually trigger a notification to confirm setup
app.post('/api/push/test', async (req, res) => {
  if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await fanout(supabaseAdmin, {
      title: 'Test notification',
      body: 'Push is working ✓',
      lead_id: null,
      intent: '',
      phone: '',
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Ingest Lead ──────────────────────────────────────────────────────────────
app.post('/api/ingest-lead', async (req, res) => {
    const botKey = req.headers['x-bot-key'];
    if (botKey !== BOT_SECRET) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const payload = req.body;
        if (!payload.phone_number) return res.status(400).json({ status: 'error', message: 'Missing phone_number' });
        const { data, action } = await ingestLead(supabaseAdmin, payload);
        res.json({ status: 'success', action, lead_id: data.id });
    } catch (error) { res.status(500).json({ status: 'error', message: 'Internal server error' }); }
});

// ─── Check Lead ───────────────────────────────────────────────────────────────
app.get('/api/check-lead/:phone', async (req, res) => {
    const botKey = req.headers['x-bot-key'];
    if (botKey !== BOT_SECRET) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const { phone } = req.params;
    try {
        const { data, error } = await supabaseAdmin.from('leads_surgery').select('id, contact_name, status, lead_stage, interest_cost, interest_recovery, concern_pain, concern_safety, urgency_level, pushed_to_crm').eq('phone_number', phone).maybeSingle();
        if (error) throw error;
        res.json({ status: 'success', exists: !!data, lead: data });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ─── Delete Lead ──────────────────────────────────────────────────────────────
app.delete('/api/leads/:id', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    try {
        const { error } = await supabaseAdmin.from('leads_surgery').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, deleted: req.params.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// BOT ENGINE — v6.2-stable (embedded, no HTTP calls, direct Supabase)
// ═════════════════════════════════════════════════════════════════════════════

const INACTIVITY_MS = 10 * 60 * 1000;
const SESSION_FILE = path.join(__dirname, 'sessions.json');

/** One LLM call at a time per phone — parallel customers OK, no shared fail-reason races. */
const _agentPhoneQueues = new Map();
function runAgentForPhone(phone, fn) {
    const prev = _agentPhoneQueues.get(phone) || Promise.resolve();
    const job = prev.then(fn, fn);
    _agentPhoneQueues.set(phone, job.finally(() => {
        if (_agentPhoneQueues.get(phone) === job) _agentPhoneQueues.delete(phone);
    }));
    return job;
}

// Strong Hinglish markers \u2014 words that essentially only appear in a Hindi
// sentence (pronouns/verbs/question-words). One is enough to call HI.
const HINGLISH_STRONG = new Set(['mujhe', 'mera', 'meri', 'mere', 'mereko', 'apna', 'apni', 'nahi', 'nahin', 'haan', 'kya', 'kyun', 'kyon', 'kaise', 'kaisa', 'kitna', 'kitne', 'kahan', 'chahiye', 'karwana', 'karwani', 'karana', 'karna', 'karni', 'karenge', 'batao', 'bata', 'bataye', 'theek', 'thik', 'achha', 'acha', 'sahi', 'matlab', 'shayad', 'shaayad', 'lagta', 'lagti', 'hoga', 'hogi', 'hoon', 'hun', 'raha', 'rahi', 'rahe', 'wala', 'wali']);
// Weak/ambiguous markers \u2014 common but short; need 2+ to lean HI.
const HINGLISH_WEAK = new Set(['hai', 'hain', 'ho', 'ka', 'ki', 'ke', 'ko', 'se', 'par', 'bhi', 'ji', 'aap', 'hum', 'tum', 'ye', 'wo', 'vo', 'na', 'to', 'toh', 'hu']);
// Clear English structure words.
const ENGLISH_MARKERS = new Set(['i', 'you', 'the', 'is', 'are', 'was', 'were', 'have', 'has', 'had', 'my', 'your', 'want', 'need', 'can', 'will', 'what', 'how', 'where', 'when', 'please', 'yes', 'no', 'price', 'cost', 'eye', 'power', 'glasses', 'both', 'me', 'might', 'about', 'this', 'that']);

function detectLanguageWithConfidence(message) {
    if (!message) return { lang: 'EN', confidence: 'low' };
    // Any Devanagari \u2192 definitively Hindi.
    if (/[\u0900-\u097F]/.test(message)) return { lang: 'HI', confidence: 'high' };
    // Whole-word tokens only \u2014 NEVER substring (so 'motia' won't fire on 'motiabind'
    // inside an English sentence, 'se'/'par' won't fire inside 'please'/'park').
    const tokens = message.toLowerCase().match(/[a-z]+/g) || [];
    let strong = 0, weak = 0, eng = 0;
    for (const tkn of tokens) {
        if (HINGLISH_STRONG.has(tkn)) strong++;
        else if (HINGLISH_WEAK.has(tkn)) weak++;
        if (ENGLISH_MARKERS.has(tkn)) eng++;
    }
    if (strong >= 1) return { lang: 'HI', confidence: 'high' };
    if (weak >= 2 && weak > eng) return { lang: 'HI', confidence: 'high' };
    if (weak === 1 && eng === 0 && tokens.length <= 3) return { lang: 'HI', confidence: 'medium' };
    if (eng >= 1) return { lang: 'EN', confidence: 'high' };
    return { lang: 'EN', confidence: 'low' };
}

// Explicit user request to switch reply language. Returns 'EN' | 'HI' | null.
// Must run BEFORE field capture so "english" isn't swallowed as an answer.
function explicitLangSwitch(message) {
    const m = message.trim().toLowerCase().replace(/[!.?,]+$/g, '');
    if (/^(english|angrezi|angreji|englsh|inglish|in english|english me(in)?|english please|please english|talk in english|speak (in )?english|reply in english|switch to english)$/.test(m)) return 'EN';
    if (/^(hindi|in hindi|hindi me(in)?|hindi please|please hindi|talk in hindi|speak (in )?hindi|reply in hindi|switch to hindi)$/.test(m)) return 'HI';
    return null;
}

function resolveReplyLang(session, message) {
    const { lang, confidence } = detectLanguageWithConfidence(message);
    if (confidence !== 'low') session.lang = lang;
    return session.lang || 'EN';
}

function t(key, lang) { const e = BOT_MSG[key]; if (!e) return ''; return e[lang] || e['EN']; }

const BOT_MSG = {
    GREETING: { EN: 'Hi! 😊 I\'m Relive Cure\'s vision assistant.\n\nAre you exploring LASIK, specs removal, or just checking options?', HI: 'नमस्ते! 😊 मैं Relive Cure का vision assistant हूँ।\n\nक्या आप LASIK, specs removal, या सिर्फ options देख रहे हैं?' },
    GREETING_MORE_INFO: { EN: 'Hi! 😊 Happy to help with LASIK and specs removal.\n\nWhat would you like to know — cost, recovery, or eligibility?', HI: 'नमस्ते! 😊 LASIK और specs removal में मदद करूँगा।\n\nक्या जानना चाहेंगे — cost, recovery, या eligibility?' },
    GREETING_HIGH_INTENT: { EN: 'Great! I can definitely help with that 😊\n\nAre you exploring LASIK, specs removal, or just checking options?', HI: 'बिल्कुल! मैं इसमें मदद कर सकता हूँ 😊\n\nक्या आप LASIK, specs removal, या options देख रहे हैं?' },
    ASK_NAME: { EN: 'What should I call you? 😊', HI: 'आपको क्या बुलाऊँ? 😊' },
    ASK_CITY: { EN: 'Which city are you based in? 📍', HI: 'आप किस शहर में रहते हैं? 📍' },
    ASK_EYE_POWER: { EN: 'Do you wear glasses or lenses? If yes, what\'s your approximate power? 😊', HI: 'क्या आप glasses या lenses पहनते हैं? अगर हाँ, तो approximate power क्या है? 😊' },
    ASK_POWER_STABILITY: { EN: 'How long has your power been stable?', HI: 'आपकी power कितने समय से stable है?' },
    ASK_INSURANCE: { EN: 'Do you have medical or health insurance? 😊', HI: 'क्या आपके पास medical या health insurance है? 😊' },
    INVALID_NAME: { EN: 'I didn\'t catch that 😊 What should I call you?', HI: 'समझ नहीं आया 😊 आपको क्या बुलाऊँ?' },
    WELCOME_BACK: { EN: 'Welcome back! 👋 Would you like to continue where we left off? (Yes/No)', HI: 'वापस आए! 👋 क्या आप वहीं से जारी रखना चाहते हैं? (हाँ/नहीं)' },
    NOT_INTERESTED: { EN: 'No worries at all 😊 If you ever want guidance on eye care, we\'re always here. Take care!', HI: 'कोई बात नहीं 😊 अगर कभी guidance चाहिए, हम यहाँ हैं। ख्याल रखें!' },
    FALLBACK: { EN: 'I may not have the right information for that 😊 But our specialist will call you shortly and answer everything!', HI: 'इसके बारे में सही जानकारी मेरे पास नहीं है 😊 लेकिन specialist जल्द call करेंगे!' }
};

const COMPLETE_VARIANTS = {
    EN: [
        'You\'re all set 😊 Our specialist will reach out shortly.\n\nFeel free to ask me anything about:\n• Cost 💰\n• Recovery ⚡\n• LASIK vs ICL 👁',
        'Our team has your request 👍 A specialist will contact you shortly.\n\nMeanwhile, you can ask me about recovery or eligibility 😊',
        'Perfect 😊 Your consultation request is submitted.\n\nIf you\'d like, I can also help with:\n• Cost\n• Safety\n• Recovery'
    ],
    HI: [
        'आप सब set हैं 😊 Specialist जल्द संपर्क करेंगे।\n\nइस बीच पूछ सकते हैं:\n• Cost 💰\n• Recovery ⚡\n• LASIK vs ICL 👁',
        'आपकी request हमारी team को मिल गई 👍 Specialist जल्द contact करेंगे।\n\nतब तक recovery या eligibility पूछ सकते हैं 😊',
        'बढ़िया 😊 Consultation request submit हो गई।\n\nCost, safety या recovery के बारे में पूछ सकते हैं।'
    ]
};

function getRandomCompleteReply(lang) { const v = COMPLETE_VARIANTS[lang] || COMPLETE_VARIANTS.EN; return v[Math.floor(Math.random() * v.length)]; }

function parseEyePower(message) {
    if (!message || typeof message !== 'string') return { raw: message, parsed: null, numeric: null, confidence: 'low' };
    const m = message.trim();

    function pairResult(raw, right, left) {
        if (right > 0 && !String(right).includes('+')) right = -right;
        if (left > 0 && !String(left).includes('+')) left = -left;
        const avg = (Math.abs(right) + Math.abs(left)) / 2;
        return {
            raw,
            parsed: `R:${right} L:${left}`,
            numeric: -avg,
            confidence: 'high',
            right,
            left,
        };
    }

    // Handle structured format from agent: "R:-4 L:-5" or "L:-5 R:-6"
    const structMatch = m.match(/[Rr]\s*:\s*([+-]?\d+(?:\.\d+)?)\s+[Ll]\s*:\s*([+-]?\d+(?:\.\d+)?)/);
    if (structMatch) {
        const r = parseFloat(structMatch[1]);
        const l = parseFloat(structMatch[2]);
        const avg = (Math.abs(r) + Math.abs(l)) / 2;
        const numeric = -(avg);
        return { raw: m, parsed: m, numeric, confidence: 'high', right: r, left: l };
    }
    const structMatch2 = m.match(/[Ll]\s*:\s*([+-]?\d+(?:\.\d+)?)\s+[Rr]\s*:\s*([+-]?\d+(?:\.\d+)?)/);
    if (structMatch2) {
        const l = parseFloat(structMatch2[1]);
        const r = parseFloat(structMatch2[2]);
        const avg = (Math.abs(r) + Math.abs(l)) / 2;
        const numeric = -(avg);
        return { raw: m, parsed: `R:${r} L:${l}`, numeric, confidence: 'high', right: r, left: l };
    }

    // Handle "5 in both eyes" / "-3 both eyes"
    const bothEyesMatch = m.match(/([+-]?\d+(?:\.\d+)?)\s+(?:in\s+)?both\s+eyes?/i);
    if (bothEyesMatch) {
        let n = parseFloat(bothEyesMatch[1]);
        if (n > 0 && !bothEyesMatch[1].includes('+')) n = -n;
        return { raw: m, parsed: `R:${n} L:${n}`, numeric: n, confidence: 'high', right: n, left: n };
    }

    // Handle "-4 right -6 left" / "4 right 6 left" (number before eye side)
    const numRlMatch = m.match(/([+-]?\d+(?:\.\d+)?)\s+right\b.*?([+-]?\d+(?:\.\d+)?)\s+left\b/i);
    if (numRlMatch) {
        let r = parseFloat(numRlMatch[1]);
        let l = parseFloat(numRlMatch[2]);
        if (r > 0 && !numRlMatch[1].includes('+')) r = -r;
        if (l > 0 && !numRlMatch[2].includes('+')) l = -l;
        const avg = (Math.abs(r) + Math.abs(l)) / 2;
        return { raw: m, parsed: `R:${r} L:${l}`, numeric: -avg, confidence: 'high', right: r, left: l };
    }

    // Handle "right 4 left 5" or "right eye 4 left eye 5"
    const rlMatch = m.match(/right\s*(?:eye\s*)?([+-]?\d+(?:\.\d+)?)\s*[,\s]+left\s*(?:eye\s*)?([+-]?\d+(?:\.\d+)?)/i);
    if (rlMatch) {
        let r = parseFloat(rlMatch[1]);
        let l = parseFloat(rlMatch[2]);
        if (r > 0) r = -r;
        if (l > 0) l = -l;
        const avg = (Math.abs(r) + Math.abs(l)) / 2;
        const numeric = -avg;
        return { raw: m, parsed: `R:${r} L:${l}`, numeric, confidence: 'high', right: r, left: l };
    }

    // Handle "left -5 right -6" or "left eye 5 right eye 6" (optional "and")
    const lrMatch = m.match(/left\s*(?:eye\s*)?([+-]?\d+(?:\.\d+)?)\s*(?:,\s*|\s+and\s+|\s+)right\s*(?:eye\s*)?([+-]?\d+(?:\.\d+)?)/i);
    if (lrMatch) {
        return pairResult(m, parseFloat(lrMatch[2]), parseFloat(lrMatch[1]));
    }

    // Handle "-5 left and -7 right" / "power is -5 left and -7 right"
    const numLeftRightMatch = m.match(/([+-]?\d+(?:\.\d+)?)\s+left\b(?:\s+and)?\s*([+-]?\d+(?:\.\d+)?)\s+right\b/i);
    if (numLeftRightMatch) {
        return pairResult(m, parseFloat(numLeftRightMatch[2]), parseFloat(numLeftRightMatch[1]));
    }

    // Handle "-7 right and -5 left"
    const numRightLeftMatch = m.match(/([+-]?\d+(?:\.\d+)?)\s+right\b(?:\s+and)?\s*([+-]?\d+(?:\.\d+)?)\s+left\b/i);
    if (numRightLeftMatch) {
        return pairResult(m, parseFloat(numRightLeftMatch[1]), parseFloat(numRightLeftMatch[2]));
    }

    // Handle "5 and 7" / "power is -5 and -7" (common WhatsApp shorthand)
    const andPairMatch = m.match(/(?:power\s+is\s+)?([+-]?\d+(?:\.\d+)?)\s+and\s+([+-]?\d+(?:\.\d+)?)/i);
    if (andPairMatch) {
        return pairResult(m, parseFloat(andPairMatch[1]), parseFloat(andPairMatch[2]));
    }

    // Handle "both eyes same" or just a single number
    const match = m.match(/[-+]?\d+(\.\d+)?/);
    if (!match) {
        if (/high|bahut|zyada|jyada/i.test(m)) {
            return { raw: m, parsed: null, numeric: null, confidence: 'low' };
        }
        return { raw: m, parsed: null, numeric: null, confidence: 'low' };
    }
    let numeric = parseFloat(match[0]);
    if (numeric > 0 && !m.includes('+')) numeric = -numeric;
    return { raw: m, parsed: match[0], numeric, confidence: (Math.abs(numeric) >= 0.25 && Math.abs(numeric) <= 22) ? 'high' : 'medium' };
}
function getEyePowerNumeric(ep) { if (!ep) return null; if (typeof ep === 'string') return parseFloat(ep) || null; return ep.numeric || null; }
function getEyePowerString(ep) { if (!ep) return null; if (typeof ep === 'string') return ep; return ep.parsed || ep.raw || null; }

/** True when a new parse should replace a junk or weaker stored eye power. */
function shouldReplaceEyePower(existing, parsed, justAsked) {
    if (!parsed) return false;
    if (!existing) return true;
    const hasBoth = parsed.right != null && parsed.left != null;
    if (hasBoth) return true;
    if (parsed.numeric != null && (existing.numeric == null || justAsked)) return true;
    if (existing.confidence === 'user_stated' && existing.numeric == null && parsed.numeric != null) return true;
    return false;
}

function isGarbageEyePowerCatchAll(ep) {
    if (!ep || ep.numeric != null) return false;
    if (ep.confidence !== 'user_stated') return false;
    const t = String(ep.parsed || ep.raw || '').toLowerCase();
    return t.length > 0 && !/[-+]?\d/.test(t);
}

function getMissingQualField(session) {
    sanitizeSessionFields(session);
    const d = session.data;
    if (!isPlausibleCity(d.city)) return 'CITY';
    if (!d.eyePower) return 'EYE_POWER';
    if (d.eyePower && !d.powerStability && getEyePowerNumeric(d.eyePower) !== null && getEyePowerNumeric(d.eyePower) <= -5) return 'POWER_STABILITY';
    if (!d.insurance) return 'INSURANCE';
    return null;
}

/** When the bot reply already asks a field, mark it so we don't ask again and passiveExtract knows context. */
function markFieldsAskedInReply(reply, session) {
    if (!reply || !session?.data) return;
    const d = session.data;
    const r = reply.toLowerCase();
    d.resumeAsked = d.resumeAsked || [];
    const mark = (field) => {
        d.lastAskedField = field;
        if (!d.resumeAsked.includes(field)) d.resumeAsked.push(field);
    };
    if (!d.insurance && /insurance|bima|medical (insurance|cover)/.test(r)) mark('INSURANCE');
    else if (!d.city && /which city|your city|city are you|located in|शहर/.test(r)) mark('CITY');
    else if (!d.eyePower && /eye power|glasses.*power|contact lens|approximate power|lens number/.test(r)) mark('EYE_POWER');
    else if (!d.powerStability && /power been stable|stable your power|how stable/.test(r)) mark('POWER_STABILITY');
}

function getAcknowledgement(message, lang) {
    const m = message.toLowerCase();
    const acks = [
        { test: () => /issue|problem|trouble|difficulty|blurr?y?|blurred|can'?t see|cannot see|cant see|weak eye|weak eyesight|poor vision|bad vision|low vision|dikhai nahi|dikhta nahi|saaf nahi|kamzor|nazar|धुंधला|दिखाई नहीं|नज़र|कमज़ोर/i.test(m), EN: 'I understand — that must be frustrating 😊', HI: 'मैं समझता हूँ — यह परेशान करने वाला होता है 😊' },
        { test: () => /[-+]?\d+(\.\d+)?/.test(m) && (m.includes('power') || m.includes('minus') || m.includes('-') || m.includes('+')), EN: 'That power range is more common than people think 👍', HI: 'यह power range सोच से ज़्यादा common है 👍' },
        { test: () => /scared|fear|nervous|afraid|darta|daro/i.test(m), EN: 'That\'s completely understandable 😊', HI: 'यह बिल्कुल समझ में आता है 😊' },
        { test: () => /this month|next month|jaldi|soon|abhi|asap/i.test(m), EN: 'That sounds like a good timeline 👍', HI: 'यह एक अच्छा timeline है 👍' },
        { test: () => /pain|dard|hurt|takleef/i.test(m), EN: 'Many people are pleasantly surprised by this 😊', HI: 'बहुत लोग इससे अच्छे से हैरान होते हैं 😊' },
        { test: () => /expensive|costly|afford|budget|cost|price|fees|kharcha|paisa/i.test(m), EN: 'That\'s a fair question 😊', HI: 'यह एक सही सवाल है 😊' },
        { test: () => /ok|okay|sure|haan|theek|accha|bilkul|got it/i.test(m) && m.length < 15, EN: 'Great! 😊', HI: 'बढ़िया! 😊' }
    ];
    for (const ack of acks) { if (ack.test()) return ack[lang] || ack.EN; }
    return null;
}

function getEscalationMessage(type, lang, firstName) {
    const n = firstName ? `, ${firstName}` : '';
    const msgs = {
        educational: { EN: `A specialist can guide you much better regarding this${n} 😊 Our team will call you shortly.`, HI: `इसके बारे में specialist बेहतर guide कर सकते हैं${n} 😊 हमारी team जल्द call करेगी।` },
        candidate: { EN: `Based on what you've shared${n}, you sound like a strong candidate! 😊 Our specialist will call you shortly.`, HI: `आपने जो share किया है${n}, आप एक अच्छे candidate लगते हैं! 😊 Specialist जल्द call करेंगे।` },
        medical: { EN: `That depends on a proper evaluation${n} 😊 Our specialist can assess this during your free consultation.`, HI: `यह evaluation पर depend करता है${n} 😊 Specialist free consultation में assess करेंगे।` },
        callback: { EN: `Perfect${n}! Our team will reach out to you shortly 😊`, HI: `बढ़िया${n}! हमारी team जल्द संपर्क करेगी 😊` }
    };
    const entry = msgs[type] || msgs.educational;
    return entry[lang] || entry.EN;
}

function shouldOfferCallback(session) {
    if (session.data.callback_offered) return false;
    if (getMissingQualField(session)) return false;
    if (!fieldCollected(session, 'INSURANCE')) return false;
    const d = session.data; let score = 0;
    if (d.city) score++;
    if (d.eyePower) score++;
    else if (d.concern_power) score++;
    if (d.interest_cost) score++;
    if (d.interest_recovery) score++;
    if (d.request_call) score += 2;
    return score >= 3;
}

let botSessions = {};
const botProcessedMessages = new Map();
setInterval(() => { const now = Date.now(); for (const [id, ts] of botProcessedMessages.entries()) { if (now - ts > 60000) botProcessedMessages.delete(id); } }, 30000);

try {
    if (fs.existsSync(SESSION_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        for (const [phone, s] of Object.entries(raw)) botSessions[phone] = { ...s, _agentHistory: s._agentHistory || [], inactivityTimer: null };
        console.log(`[SESSION] Hydrated ${Object.keys(botSessions).length} sessions`);
    }
} catch (e) { console.error('[SESSION] Hydration error:', e.message); }

let _saveTimeout = null;
function schedulePersist() {
    clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
        try {
            const toWrite = {};
            for (const [p, s] of Object.entries(botSessions)) {
                toWrite[p] = { state: s.state, data: s.data, ingested: s.ingested, first_ingest_done: s.first_ingest_done || false, last_activity_at: s.last_activity_at, lang: s.lang || 'EN', repeat_count: s.repeat_count || {}, resume_offered: s.resume_offered || false, last_intent_handled: s.last_intent_handled || null, _agentHistory: s._agentHistory || [] };
            }
            fs.writeFileSync(SESSION_FILE, JSON.stringify(toWrite, null, 2));
        } catch (e) { console.error('[SESSION] Persist error:', e.message); }
    }, 200);
}

const NAME_BLACKLIST = new Set([
    'yes', 'ok', 'okay', 'haan', 'ha', 'no', 'nah', 'start', 'nahi', 'nope', 'sure', 'chalo', 'bilkul', 'haan ji',
    'skip', 'next', 'continue', 'hello', 'hi', 'hey', 'theek', 'accha', 'achha', 'thik', 'lasik', 'surgery', 'good', 'fine',
    // Hinglish/English question words — never valid names
    'kya', 'kaise', 'kab', 'kahan', 'kyu', 'kyon', 'kyun', 'kahaan', 'kab tak', 'kaisa',
    'what', 'how', 'where', 'when', 'why', 'who', 'which',
    // Hindi time words (Latin + Devanagari) — appeared as captured names in real data
    'now', 'kal', 'aaj', 'parso',
    'कल', 'आज', 'परसों',
    // Hinglish fillers found as names in real data
    'not', 'in', 'koi', 'kuch', 'dost', 'yaar', 'kuchbhi',
    'mujhe', 'shyad', 'shayad', 'lagta', 'lagti', 'soch', 'think',
    // Hindi money/cost words — mis-extracted as names ("paisa kitna lgega")
    'paisa', 'paise', 'rupay', 'rupee', 'rupees', 'rs', 'kharcha', 'kimat', 'keemat', 'daam', 'dam',
    'kitna', 'kitne', 'lagega', 'lgega', 'book', 'krdo', 'kardo',
]);

// ─── SAFETY NET: Medical + common word blacklists ────────────────────────────
const MEDICAL_BLACKLIST = new Set([
    'lipoma', 'cancer', 'motiyabind', 'cataract', 'tumor', 'tumour',
    'diabetes', 'thyroid', 'hernia', 'asthma', 'malaria', 'dengue',
    'typhoid', 'jaundice', 'migraine', 'epilepsy', 'arthritis',
    'pneumonia', 'cholesterol', 'infection', 'allergy', 'fracture',
    'appendix', 'ulcer', 'piles', 'fistula', 'gallstone', 'kidney',
    'liver', 'heart', 'brain', 'stomach', 'spine', 'knee', 'shoulder'
]);
const COMMON_WORD_BLACKLIST = new Set([
    'morning', 'evening', 'night', 'afternoon', 'today', 'tomorrow',
    'mr', 'mrs', 'miss', 'sir', 'madam', 'dear', 'bhai', 'bhaiya',
    'didi', 'ji', 'sahab', 'sahib', 'love', 'thanks', 'thank',
    'please', 'location', 'rate', 'price', 'cost', 'address',
    'paisa', 'paise', 'rupay', 'rupee', 'rupees', 'kharcha', 'kimat', 'keemat', 'daam',
    'number', 'glass', 'glasses', 'lens', 'lenses', 'specs',
    'but', 'and', 'or', 'the', 'was', 'is', 'are', 'it', 'its',
    'from', 'to', 'with', 'for', 'about', 'into', 'on', 'at', 'by',
    'specs removal', 'option', 'options', 'checking',
    'looking', 'interested', 'consultation', 'help', 'info', 'more', 'details', 'surgery',
    'process', 'procedure', 'treatment', 'correct', 'good', 'fine',
    'actually', 'basically', 'currently', 'recently', 'definitely',
    'hindi', 'english', 'hinglish',
    // Hindi filler/pronouns that aren't names
    'इस', 'यह', 'वह', 'मैं', 'तुम', 'आप', 'हम', 'ये', 'वो',
    'कोई', 'कुछ', 'अभी', 'बस', 'हां', 'ना', 'जी'
]);

const NAME_QUESTION_PREFIX_RE = /^(kya|kaise|kab|kahan|kyu|kyon|kyun|kahaan|kaisa|what|how|where|when|why|who|which)\b/i;
function isValidName(str) {
    if (!str || str.trim().length < 2) return false;
    const trimmed = str.trim();
    const low = trimmed.toLowerCase();
    if (NAME_BLACKLIST.has(low)) return false;
    if (MEDICAL_BLACKLIST.has(low)) return false;
    if (COMMON_WORD_BLACKLIST.has(low)) return false;
    // Reject single-word titles
    if (['mr', 'mrs', 'ms', 'dr', 'sir', 'madam'].includes(low)) return false;
    // Reject anything that looks like a question
    if (trimmed.includes('?')) return false;
    if (NAME_QUESTION_PREFIX_RE.test(trimmed)) return false;
    if (/\u0915\u094D\u092F\u093E|\u0915\u0948\u0938\u0947|\u0915\u092C|\u0915\u0939\u093E\u0901|\u0915\u0939\u093E\u0902|\u0915\u094D\u092F\u094B\u0902|\u0915\u094D\u092F\u0942/.test(trimmed)) return false;
    // Names are typically 1-2 words; 3+ words is almost always a sentence
    if (trimmed.split(/\s+/).length >= 3) return false;
    // Reject if FIRST word is a blacklisted question word (covers "kya hota he ye proccess")
    const firstWord = low.split(/\s+/)[0];
    if (NAME_BLACKLIST.has(firstWord)) return false;
    if (isIndianCity(trimmed)) return false;
    if (/[\u0900-\u097F]/.test(trimmed)) return trimmed.length >= 2;
    if (!/^[a-zA-Z\s]+$/.test(trimmed)) return false;
    return trimmed.split(/\s+/).some(w => w.length >= 2);
}

// ─── SAFETY NET: Disengagement + abuse detection ─────────────────────────────
const DISENGAGE_TRIGGERS = [
    'bye', 'bye bye', 'good bye', 'goodbye', 'block', 'i block you',
    'stop', 'bakwas band', 'bar bar', 'good night', 'so jao', 'ruko',
    'mat bhejo', 'message mat', 'mat karo', 'leave me', 'chhod do',
    'go away', 'get lost'
];
const ABUSE_WORDS = [
    'chutiya', 'chutiye', 'madarchod', 'bhenchod',
    'bhosdike', 'gandu', 'sale', 'saale', 'bewakoof',
    'idiot', 'stupid', 'fool', 'pagal', 'kamina', 'harami'
];
// Match abuse words including obfuscated variants (chhu..tiye, ch*tiya, etc.)
const ABUSE_RE = new RegExp(
    ABUSE_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    '|ch+u+\\.*(t|d)i?y[ae]|bh?o?s[dk]', 'i'
);
function isDisengaged(msg) {
    const m = msg.toLowerCase();
    return DISENGAGE_TRIGGERS.some(t => m.includes(t));
}
function isAbusive(msg) {
    return ABUSE_RE.test(msg);
}

// ─── SAFETY NET: Name correction detector ────────────────────────────────────
const NAME_CORRECTION_NEG = /(?:mera naam|my name|mera nam)\s+(?:nahi hai|nhi hai|isn'?t|is not|nahi h|nhi h)/i;
const NAME_INTRO_RE = /(?:mera naam|my name|i am|i'm|myself|my self|main|mai|i'm)\s+(?:hai|is|h|)\s*(.+)/i;
function checkNameCorrection(message, session) {
    if (NAME_CORRECTION_NEG.test(message)) {
        session.data.contactName = null;
        session.state = 'NAME';
        return 'cleared';
    }
    const posMatch = message.match(NAME_INTRO_RE);
    if (posMatch && posMatch[1].trim().length >= 2) {
        const newName = posMatch[1].trim().split(/\s+/).slice(0, 2).join(' ');
        if (isValidName(newName)) {
            session.data.contactName = newName;
            return 'captured';
        }
    }
    return false;
}

// ─── SAFETY NET: Off-topic condition/body part ───────────────────────────────
const OFF_TOPIC_RE = /\b(back side|peeth|kamar|waist|knee|ghutna|stomach|pet|skin|hair|baal|shoulder|kandha|leg|foot|hand|lipoma|hernia|piles)\b.*\b(problem|issue|pain|dard|ho gyi|ho gayi|hai|h|me hai|mein hai)\b/i;
// Secondary pattern: "my problem/issue is <condition>"
const OFF_TOPIC_RE2 = /\b(problem|issue|bimari|rog)\b.*\b(lipoma|hernia|piles|kamar|peeth|knee|ghutna|stomach|pet|skin|hair|baal|shoulder)\b/i;
function isOffTopic(msg) { return OFF_TOPIC_RE.test(msg) || OFF_TOPIC_RE2.test(msg); }

// ─── SAFETY NET: City validation blacklist ───────────────────────────────────
const CITY_BLACKLIST = new Set([
    'lasik', 'specs removal', 'specs', 'surgery', 'option', 'options',
    'checking', 'number', 'number h', 'glass', 'glasses', 'lens',
    'lenses', 'but', 'and', 'mr', 'yes please', 'rate', 'cost',
    'price', 'love', 'operation', 'eye', 'eyes', 'chashma', 'ok', 'okay',
    'yes', 'no', 'haan', 'nahi', 'theek', 'thik', 'accha', 'achha', 'fine',
    'sure', 'right', 'cool', 'done', 'complete', 'thanks', 'thank you', 'bilkul',
    'got it', 'alright', 'understood', 'hmm', 'hm', 'maybe', 'think',
]);

const CITY_ACK_WORDS = new Set([
    'ok', 'okay', 'yes', 'no', 'haan', 'ha', 'nahi', 'nah', 'theek', 'thik',
    'accha', 'achha', 'fine', 'sure', 'right', 'cool', 'done', 'bilkul', 'ji',
    'got it', 'alright', 'understood', 'hmm', 'maybe',
]);

function normalizeCityAlias(raw) {
    if (!raw) return null;
    const low = raw.trim().toLowerCase();
    const aliases = {
        banglore: 'Bangalore', bengaluru: 'Bangalore', bangalore: 'Bangalore',
        bombay: 'Mumbai', gurgaon: 'Gurgaon', gurugram: 'Gurugram',
        calcutta: 'Kolkata', madras: 'Chennai',
    };
    if (aliases[low]) return aliases[low];
    if (isIndianCity(low)) return titleCaseCity(low);
    return isPlausibleCity(raw) ? titleCaseCity(raw) : null;
}

function isPlausibleCity(city) {
    if (!city || typeof city !== 'string') return false;
    const low = city.trim().toLowerCase();
    if (low.length < 2 || low.length > 40) return false;
    if (CITY_BLACKLIST.has(low) || CITY_ACK_WORDS.has(low)) return false;
    if (COMMON_WORD_BLACKLIST?.has(low)) return false;
    return true;
}

function sanitizeSessionFields(session) {
    const d = session.data;
    if (d.city && !isPlausibleCity(d.city)) {
        d.city = null;
        d.resumeAsked = (d.resumeAsked || []).filter(f => f !== 'CITY');
        if (d.lastAskedField === 'CITY') d.lastAskedField = null;
    }
    if (d.contactName && d.contactName !== 'WhatsApp Lead' && !isValidName(d.contactName)) {
        d.contactName = 'WhatsApp Lead';
    }
}

function fieldCollected(session, field) {
    const d = session.data;
    if (field === 'CITY') return isPlausibleCity(d.city);
    if (field === 'EYE_POWER') return !!d.eyePower;
    if (field === 'POWER_STABILITY') {
        const n = getEyePowerNumeric(d.eyePower);
        return !!(d.powerStability || n === null || n > -5);
    }
    if (field === 'INSURANCE') return !!d.insurance;
    return false;
}

function isCataractMention(msgLow) {
    return /motia|motiyabind|मोतियाबिंद|cataract/i.test(msgLow);
}

function getCataractAck(lang) {
    return {
        EN: 'Cataract is different from LASIK — our specialist can guide you properly on a call 😊',
        HI: 'Samajh gaya — motiyabind aur LASIK alag cheezein hain 😊 Specialist call par sahi guide karenge.',
    }[lang] || 'Samajh gaya — motiyabind aur LASIK alag cheezein hain 😊 Specialist call par sahi guide karenge.';
}

// ─── SAFETY NET: Loop guard ──────────────────────────────────────────────────
const recentOutbound = {};  // phone → [hash1, hash2, hash3]
function hashMsg(text) { return crypto.createHash('md5').update(text || '').digest('hex'); }
function isLooping(phone, reply) {
    const recent = recentOutbound[phone] || [];
    return recent.includes(hashMsg(reply));
}
function trackOutbound(phone, reply) {
    if (!recentOutbound[phone]) recentOutbound[phone] = [];
    recentOutbound[phone].push(hashMsg(reply));
    if (recentOutbound[phone].length > 3) recentOutbound[phone].shift();
}

// ─── Helper: safe first name (never "WhatsApp") ─────────────────────────────
function safeFirstName(session) {
    const cn = session.data?.contactName;
    if (!cn || cn === 'WhatsApp Lead' || isIndianCity(cn)) return '';
    return cn.split(' ')[0];
}

const NOT_INTERESTED_TRIGGERS = ['not interested', 'no thanks', 'don\'t want', 'dont want', 'wrong number', 'galat number', 'nahi chahiye', 'band karo', 'mat bhejo', 'unsubscribe', 'stop messaging', 'please stop', 'remove me'];
const ESCALATION_TRIGGERS = ['icl', 'implantable', 'implant lens', 'cataract', 'motia', 'motiyabind', 'मोतियाबिंद', 'आईसीएल', 'talk to doctor', 'doctor se baat', 'doctor chahiye', 'doctor se milna'];
const SALES_INTENT = ['call me', 'call back', 'callback', 'call chahiye', 'mujhe call', 'contact me', 'book appointment', 'appointment chahiye', 'baat karni hai', 'agent se baat', 'talk to specialist', 'specialist se baat', 'human se baat', 'real person', 'connect me', 'phone karo', 'call karo'];
const HIGH_INTENT_FIRST = ['lasik', 'surgery', 'operation', 'laser eye', 'laser treatment', 'chashma hatana', 'glasses hatana', 'aankhon ka operation', 'karwana', 'karwani', 'vision correction', 'eye surgery'];

function isNotInterested(msg) { return NOT_INTERESTED_TRIGGERS.some(w => msg.toLowerCase().includes(w)); }
function isEscalationTrigger(msg) { return ESCALATION_TRIGGERS.some(w => msg.toLowerCase().includes(w)); }
function isSalesIntent(msg) { return SALES_INTENT.some(w => msg.toLowerCase().includes(w)); }
function isHighIntentFirst(msg) { return HIGH_INTENT_FIRST.some(w => msg.toLowerCase().includes(w)); }

function isPlainGreeting(msgLow) {
    const t = msgLow.trim();
    return /^(hi|hello|hey|hii|helo|hola|namaste|नमस्ते|हेलो|hello there|good (morning|afternoon|evening))[\s!.?]*$/iu.test(t);
}

/** In LIVE mode with quota, route through Gemini instead of greeting/short-message fast paths. */
function preferAgentOverFastPaths() {
    return isAgentEnabled() && agentMode() === 'live' && isUnderQuota('whatsapp');
}

function isAdCtaMessage(msgLow) {
    const t = msgLow.trim();
    if (t.includes('can i get more info') || t.includes('get more info') || t.includes('more info on this')) return true;
    if (/\bmore\s+info\b/.test(t) && t.length < 60) return true;
    return false;
}

function replyAsksForName(reply) {
    const low = (reply || '').toLowerCase();
    return /what should i call|could i just get your name|catch your name|get your name first|name first|आपको क्या बुलाऊँ|अपना नाम|naam bata|नाम बताइ/i.test(low);
}

function getGreetingReply(msgLow, lang) {
    if (isAdCtaMessage(msgLow)) return t('GREETING_MORE_INFO', lang);
    if (isHighIntentFirst(msgLow)) return t('GREETING_HIGH_INTENT', lang);
    return t('GREETING', lang);
}

/** After LLM extraction: build the WhatsApp reply using the same rule-based flow as production. */
function composeAgentReply(session, message, msgLow) {
    const lang = resolveReplyLang(session, message);

    if (isEscalationTrigger(msgLow) || isCataractMention(msgLow)) {
        session.data.is_cataract = true;
        if (!session.data.escalation_note) session.data.escalation_note = message;
        if (session.state === 'GREETING') session.state = 'CORE_CONSULT';
        sanitizeSessionFields(session);
        const missing = getMissingQualField(session);
        if (missing) {
            const ack = getCataractAck(lang);
            const next = getNextQuestion(session, 'normal');
            return next.text ? `${ack}\n\n${next.text}` : ack;
        }
        session.data.request_call = true;
        if (!session.data.callback_offered) session.data.callback_offered = true;
        session.state = 'COMPLETE';
        session.data.human_handoff_started = true;
        session.data.callback_source = 'escalation';
        return getEscalationMessage('educational', lang, safeFirstName(session));
    }
    if (isSalesIntent(msgLow)) {
        session.data.request_call = true;
        if (!session.data.callback_offered) session.data.callback_offered = true;
        session.state = 'COMPLETE';
        session.data.human_handoff_started = true;
        session.data.callback_source = 'sales_intent';
        return getEscalationMessage('callback', lang, safeFirstName(session));
    }

    const intents = detectAllIntents(message).filter(i => i !== 'YES' && i !== 'NO');
    if (intents.includes('LOCATION')) {
        let text = KB.LOCATION[lang] || KB.LOCATION.EN;
        if (!session.data.city) {
            const next = getNextQuestion(session);
            if (next.text) text += `\n\n${next.text}`;
        }
        if (session.state === 'GREETING') session.state = 'CORE_CONSULT';
        return text;
    }

    const kb = buildKnowledgeResponse(message, session);
    if (kb) {
        if (session.state === 'GREETING') session.state = 'CORE_CONSULT';
        return kb;
    }

    if (session.state === 'GREETING') {
        session.state = 'CORE_CONSULT';
        return getGreetingReply(msgLow, lang);
    }

    if (session.state === 'COMPLETE') {
        const kbDone = buildKnowledgeResponse(message, session);
        if (kbDone) return kbDone;
        const ack = getAcknowledgement(message, lang);
        return ack ? `${ack}\n\n${getRandomCompleteReply(lang)}` : getRandomCompleteReply(lang);
    }

    if (shouldOfferCallback(session) && fieldCollected(session, 'INSURANCE')) {
        if (!session.data.callback_offered) session.data.callback_offered = true;
        session.data.request_call = true;
        session.state = 'COMPLETE';
        session.data.human_handoff_started = true;
        const ack = getAcknowledgement(message, lang);
        const cbMsg = getEscalationMessage('candidate', lang, safeFirstName(session));
        return ack ? `${ack}\n\n${cbMsg}` : cbMsg;
    }

    const next = getNextQuestion(session);
    if (next.field) {
        const ack = getAcknowledgement(message, lang);
        if (session.state === 'GREETING') session.state = 'CORE_CONSULT';
        return ack ? `${ack}\n\n${next.text}` : next.text;
    }

    session.data.request_call = true;
    if (!session.data.callback_offered) session.data.callback_offered = true;
    session.state = 'COMPLETE';
    session.data.human_handoff_started = true;
    session.data.callback_source = 'completion';
    return getRandomCompleteReply(lang);
}

/** After a live Gemini reply: pause bot for opt-out / abuse without changing the reply. */
function applyConversationHardStop(phone, session, message, msgLow) {
    if (isNotInterested(msgLow)) {
        session.data.opted_out = true;
        if (session.inactivityTimer) { clearTimeout(session.inactivityTimer); session.inactivityTimer = null; }
        supabaseAdmin.from('whatsapp_conversations')
            .upsert({ phone, bot_paused: true, updated_at: new Date().toISOString() }, { onConflict: 'phone' }).catch(() => {});
        return 'not_interested';
    }
    if (isDisengaged(msgLow) || isAbusive(msgLow)) {
        const abuse = isAbusive(msgLow);
        session.data.opted_out = true;
        if (session.inactivityTimer) { clearTimeout(session.inactivityTimer); session.inactivityTimer = null; }
        supabaseAdmin.from('whatsapp_conversations')
            .upsert({ phone, bot_paused: true, updated_at: new Date().toISOString() }, { onConflict: 'phone' }).catch(() => {});
        if (isPushConfigured()) {
            fanout(supabaseAdmin, {
                title: abuse ? '🚨 Angry lead — bot paused' : '⏸️ Lead disengaged',
                body: `${safeFirstName(session) || phone}: "${message.slice(0, 60)}"`,
                phone, url: `/m?phone=${encodeURIComponent(phone)}`, kind: 'escalation'
            }).catch(() => {});
        }
        return abuse ? 'abuse' : 'disengaged';
    }
    return null;
}

function sanitizeAgentReply(message, session, reply) {
    const lang = session.lang || 'EN';
    const msgLow = message.toLowerCase();
    const intents = detectAllIntents(message).filter(i => i !== 'YES' && i !== 'NO');
    if (intents.includes('LOCATION')) {
        let text = KB.LOCATION[lang] || KB.LOCATION.EN;
        if (!session.data.city) text += `\n\n${t('ASK_CITY', lang)}`;
        return text;
    }
    if (isInventedAgentClaim(reply)) return null;
    const noRealName = !session.data.contactName || session.data.contactName === 'WhatsApp Lead';
    if (noRealName && replyAsksForName(reply) && (intents.length > 0 || isHighIntentFirst(msgLow) || isAdCtaMessage(msgLow))) {
        if (intents.length > 0) {
            const kb = buildKnowledgeResponse(message, session);
            if (kb) return kb;
        }
        return getGreetingReply(msgLow, lang);
    }
    return reply;
}

function passiveExtract(message, session) {
    const m = message.toLowerCase(); const d = session.data;
    // Capture name from natural phrases so rule-based doesn't re-ask after a Gemini fallback.
    if (!isAdCtaMessage(m) && (!d.contactName || d.contactName === 'WhatsApp Lead')) {
        const namePatterns = [
            /\b(?:i'?m|i am|im|mera naam|naam hai)\s+([a-zA-Z\u0900-\u097F]{2,20})\b/i,
            /^([a-zA-Z\u0900-\u097F]{2,20})(?:\s+(?:here|hoon|hun|from|se))?\b/i,
        ];
        for (const re of namePatterns) {
            const nm = message.match(re);
            if (nm?.[1] && isValidName(nm[1]) && !isIndianCity(nm[1])) {
                d.contactName = nm[1].charAt(0).toUpperCase() + nm[1].slice(1).toLowerCase();
                break;
            }
        }
    }
    if (!d.city) {
        for (const city of INDIAN_CITIES) { if (m.includes(city)) { d.city = city.charAt(0).toUpperCase() + city.slice(1); break; } }
        const seCity = m.match(/([a-z]{3,20})\s+se\s+(?:hu|hun|hoon|hai)\b/i);
        if (!d.city && seCity?.[1]) {
            const norm = normalizeCityAlias(seCity[1]);
            if (norm) d.city = norm;
        }
        const fromMatch = m.match(/(?:from|i'm from|i am from|main.*se hoon|main.*se hun)\s+([a-z]+)/i);
        if (fromMatch && !d.city && fromMatch[1].length > 2) {
            const norm = normalizeCityAlias(fromMatch[1]);
            if (norm) d.city = norm;
        }
        // Permissive: when the bot JUST asked CITY, accept any 1-2 word letter
        // reply as a city (covers Bharatpur, Sikar, Bareilly — anything not in
        // the hardcoded list). Devanagari and roman both accepted.
        if (!d.city && d.lastAskedField === 'CITY') {
            const t = message.trim();
            const words = t.split(/\s+/);
            const isShort = t.length >= 2 && t.length <= 30 && words.length <= 2;
            const isLetters = /^[a-zA-Zऀ-ॿ\s.'-]+$/.test(t);
            // Don't accept short generic replies — those are handled by other paths.
            // Also check the first word so "No sorry" / "Yes please" are rejected.
            const _tLow = t.toLowerCase();
            const _genericFirst = ['yes','no','ok','okay','haan','nahi','sure','hi','hello','start','later','baad mein','baad','sorry','not','nope','yep','theek','thik','accha','achha','fine','cool','done','bilkul','right','got it','alright','understood','hmm','maybe','think'];
            const notGeneric = !_genericFirst.includes(_tLow) && !_genericFirst.includes(_tLow.split(/\s+/)[0]);
            // Don't accept LASIK intent words, medical terms, or other non-city answers as cities
            const notBlacklisted = !CITY_BLACKLIST.has(t.toLowerCase());
            if (isShort && isLetters && notGeneric && notBlacklisted && isPlausibleCity(t)) {
                d.city = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }
        }
        if (d.city && d.lastAskedField === 'CITY') d.lastAskedField = null;
    }
    const justAskedPower = d.lastAskedField === 'EYE_POWER';
    const parsedPower = parseEyePower(message);
    const hasBothEyes = parsedPower?.right != null && parsedPower?.left != null;
    const powerMatch = message.match(/[-+]?\d+(\.\d+)?/);
    const powerContext = ['power', 'number', 'minus', 'plus', 'diopter', 'aankhein', 'eye', 'vision', 'right', 'left'];
    const hasContext = powerContext.some(w => m.includes(w)) || /[-+]\d/.test(message);
    const mayTakePower = shouldReplaceEyePower(d.eyePower, parsedPower, justAskedPower)
        || isGarbageEyePowerCatchAll(d.eyePower);
    if (mayTakePower || justAskedPower) {
        // ─── SAFETY: "No glasses/lens" handler ───
        const noGlassesStrong = /\b(no glass|no lens|bina chashma|chashma nahi|chasma nahi|nahi pehanta|nahi pehnta|nahi lagata|without glass)\b/i.test(m);
        const noLensOnly = /^no\s*lens(es)?$/i.test(message.trim()) || /^no$/i.test(message.trim());
        if (justAskedPower && noGlassesStrong && !noLensOnly) {
            d.eyePower = { raw: 'No glasses/lenses', parsed: 'none', numeric: null, confidence: 'user_stated' };
            d.lastAskedField = null;
        } else if (justAskedPower && noLensOnly) {
            d._noLensStated = true;
        } else if (parsedPower && (parsedPower.numeric != null || hasBothEyes)
            && (hasContext || /both\s+eyes?/i.test(m) || justAskedPower || hasBothEyes || mayTakePower)) {
            d.eyePower = parsedPower;
            d.concern_power = true;
            d.lastAskedField = null;
        } else if (justAskedPower && message.trim().length >= 1 && message.trim().length <= 60
            && !explicitLangSwitch(message) && !powerMatch) {
            // Non-numeric reply after eye-power ask — do NOT store garbage text as power.
            // Keep lastAskedField so a follow-up like "5 and 7" can still land.
            if (/\b(wear|wearing|clothes|clother|lens|lenses|glass|glasses|chashma|specs|spectacle)\b/i.test(m)) {
                d._wearsCorrection = true;
            }
        }
    } else if (justAskedPower) {
        d.lastAskedField = null;
    }
    if (!d.powerStability && d.lastAskedField === 'POWER_STABILITY') {
        const t = message.trim();
        if (t.length >= 1 && t.length <= 40) {
            d.powerStability = t;
            d.lastAskedField = null;
        }
    }
    if (!d.timeline) {
        if (/this month|is mahine|abhi|immediately|jaldi|urgent/i.test(m)) { d.timeline = message; d.urgency = 'high'; }
        else if (/2.?3 month|next month|agle mahine|soon/i.test(m)) { d.timeline = message; d.urgency = 'medium'; }
        else if (/exploring|soch raha|dekh raha|just looking/i.test(m)) { d.timeline = message; d.urgency = 'low'; }
    }
    if (!d.insurance) {
        const t = message.trim().toLowerCase();
        const insuranceTurn = d.lastAskedField === 'INSURANCE' || getMissingQualField(session) === 'INSURANCE';
        if (insuranceTurn && (/^(yes|yeah|yep|y|haan|ha|ji|covered)\b/.test(t) || /have insurance|insurance hai|bima hai/.test(t))) {
            d.insurance = 'Yes';
            d.lastAskedField = null;
        } else if (insuranceTurn && (/^(no|nope|n|nahi|nah|not)\b/.test(t) || /don'?t have|dont have|no insurance|insurance nahi/.test(t))) {
            d.insurance = 'No';
            d.lastAskedField = null;
        }
        if (!d.insurance && /insurance hai|insured hoon|health insurance|bima hai|covered hai/i.test(m)) d.insurance = 'Yes';
        else if (!d.insurance && /no insurance|insurance nahi|bima nahi|not insured/i.test(m)) d.insurance = 'No';
    } else if (d.lastAskedField === 'INSURANCE') {
        d.lastAskedField = null;
    }
    if (/motia|motiyabind|मोतियाबिंद|cataract/i.test(m)) d.is_cataract = true;
}

function scoreSession(session) {
    const d = session.data;
    // Count the same fields that parameters_completed tracks
    const hasName = d.contactName && d.contactName !== 'WhatsApp Lead';
    const hasCity = !!d.city;
    const hasPower = !!d.eyePower;
    const hasInsurance = !!d.insurance;
    const hasTimeline = !!d.timeline;
    const params = [hasName, hasCity, hasPower, hasInsurance, hasTimeline].filter(Boolean).length;
    const urgency = d.urgency || '';
    // HOT: 4+ params with high urgency (has insurance/timeline = actively engaged)
    // WARM: 3+ params (name + city + eyePower = completed bot flow)
    // COLD: <3 params (still in early stages)
    const band = (params >= 4 && urgency === 'high') ? 'HOT' : (params >= 3) ? 'WARM' : 'COLD';
    return { intent_score: params, intent_band: band, interest_cost: !!d.interest_cost, interest_recovery: !!d.interest_recovery, concern_pain: !!d.concern_pain, concern_safety: !!d.concern_safety, urgency_level: urgency || (params >= 4 ? 'medium' : 'low'), is_returning: !!d.is_returning };
}

// ─── DIRECT DB INGEST — no HTTP ───────────────────────────────────────────────
async function sendToAPI(phone, session, trigger = 'update') {
    const d = session.data; const scored = scoreSession(session);

    // Use the real WhatsApp display name if the session never captured one.
    // whatsapp_conversations.contact_name is already written by saveWhatsAppMessage
    // before sendToAPI runs (it's called via setImmediate), so this read is safe.
    if ((!d.contactName || d.contactName === 'WhatsApp Lead') && process.env.LEAD_EVENTS_ENABLED !== 'false') {
      try {
        const { data: _wc } = await supabaseAdmin.from('whatsapp_conversations').select('contact_name').eq('phone', phone).maybeSingle();
        if (_wc?.contact_name) d.contactName = _wc.contact_name;
      } catch (_e) { /* non-fatal — fallback stays 'WhatsApp Lead' */ }
    }
    const eyePowerStr = getEyePowerString(d.eyePower);
    const eyePowerNum = getEyePowerNumeric(d.eyePower);
    const userQuestions = [
        d.escalation_note ? `Escalation: ${d.escalation_note}` : null,
        eyePowerStr ? `Eye power: ${eyePowerStr}` : null,
        d.powerStability ? `Power stable: ${d.powerStability}` : null,
        eyePowerNum !== null ? `Eye power numeric: ${eyePowerNum}` : null,
        d.previous_surgery ? `Previous surgery: ${d.previous_surgery}` : null,
        d.ageGroup ? `Age: ${d.ageGroup}` : null,
        d.is_cataract ? 'Cataract mentioned' : null,
        d.opted_out ? 'User opted out' : null
    ].filter(Boolean).join(' | ');

    const payload = {
        phone_number: phone, contact_name: d.contactName || 'WhatsApp Lead',
        city: d.city || undefined, preferred_surgery_city: d.city || undefined,
        eye_power: eyePowerStr || undefined, eye_power_numeric: eyePowerNum,
        timeline: d.timeline || undefined, insurance: d.insurance || undefined,
        interest_cost: scored.interest_cost, interest_recovery: scored.interest_recovery,
        concern_pain: scored.concern_pain, concern_safety: scored.concern_safety,
        concern_power: !!d.concern_power, intent_level: scored.intent_band || 'COLD',
        intent_score: scored.intent_score || 0, urgency_level: scored.urgency_level || 'low',
        request_call: d.request_call || false, last_user_message: d.lastMessage || '',
        user_questions: userQuestions || '', callback_source: d.callback_source || '',
        ingestion_trigger: trigger, language: session.lang || 'EN',
        source: isLabPhone(phone) ? 'bot_lab' : 'whatsapp', bot_version: 'v6.2-stable',
        first_message_at: d.first_message_at || session.last_activity_at || new Date().toISOString(),
        last_message_at: session.last_activity_at || new Date().toISOString(),
        message_count: d.message_count || 1, current_flow_state: session.state || 'UNKNOWN',
        // Opt-out and disengagement — previously lost in memory, now persisted
        opted_out: d.opted_out || false,
        disengagement_trigger: d.disengagement_trigger ? d.disengagement_trigger.slice(0, 200) : null,
        is_returning: d.is_returning || false,
    };

    try {
        const { data, action } = await ingestLead(supabaseAdmin, payload);
        console.log(`[BOT→DB] ✅ ${action.toUpperCase()} | id=${data.id} | phone=${phone}`);
        session.ingested = true; session.first_ingest_done = true; session._lastIngestError = null; schedulePersist();
        // Inline lead-INSERT push fanout — only on first ingest (not updates).
        // More reliable than Supabase realtime in the Node client.
        if (action === 'upserted' && data?.id && isPushConfigured()) {
            const intent = (data.intent_level || '').toUpperCase();
            fanout(supabaseAdmin, {
                title: intent === 'HOT' ? '🔥 HOT lead just landed!' : 'New lead',
                body: `${data.contact_name || data.phone_number}${data.city ? ' · ' + data.city : ''}`,
                lead_id: data.id,
                intent,
                phone: data.phone_number,
                url: `/m?lead=${data.id}`,
                kind: 'lead',
            }).catch(e => console.warn('[PUSH] inline lead fanout failed:', e.message));
        }
    } catch (err) {
        console.error('[BOT→DB] ❌ Direct ingest failed:', err.message);
        throw err;
    }
}

// ─── DIRECT DB CHECK — no HTTP ────────────────────────────────────────────────
function hydrateSessionDataFromLead(row) {
    if (!row) return {};
    const data = {
        contactName: row.contact_name || 'WhatsApp Lead',
        is_returning: true,
    };
    if (row.city) data.city = row.city;
    if (row.insurance) data.insurance = row.insurance;
    if (row.timeline) data.timeline = row.timeline;
    if (row.message_count) data.message_count = row.message_count;
    if (row.eye_power) {
        const parsed = parseEyePower(String(row.eye_power));
        data.eyePower = parsed?.numeric != null ? parsed : { raw: row.eye_power, parsed: row.eye_power, numeric: row.eye_power_numeric ?? null, confidence: 'db' };
    } else if (row.user_questions) {
        const m = String(row.user_questions).match(/Eye power:\s*([^|]+)/i);
        if (m) data.eyePower = parseEyePower(m[1].trim()) || { raw: m[1].trim(), parsed: m[1].trim(), numeric: null, confidence: 'db' };
    }
    if (row.request_call) data.request_call = true;
    if (row.concern_power) data.concern_power = true;
    if (row.interest_cost) data.interest_cost = true;
    return data;
}

async function checkExistingLead(phone) {
    try {
        const { data, error } = await supabaseAdmin.from('leads_surgery').select('id, phone_number, contact_name, city, insurance, timeline, user_questions, message_count, status, lead_stage, interest_cost, interest_recovery, concern_pain, concern_safety, concern_power, urgency_level, pushed_to_crm, request_call').eq('phone_number', phone).maybeSingle();
        if (error) throw error;
        return data || null;
    } catch (e) { console.error('[BOT] checkExistingLead error:', e.message); return null; }
}

// ─── INACTIVITY TIMER — DISABLED ─────────────────────────────────────────────
// The 10-minute followup was too aggressive for a ₹15K-90K decision with a
// 31-day median cycle. It also risked re-engaging angry/disengaged leads.
// Leads are now handled by the sales rep after CRM push.
function resetInactivityTimer(phone) {
    const session = botSessions[phone];
    if (!session) return;
    if (session.inactivityTimer) { clearTimeout(session.inactivityTimer); session.inactivityTimer = null; }
    // No new timer — inactivity followup removed per founder decision.
}

// ─── KNOWLEDGE BASE ───────────────────────────────────────────────────────────
const KB = {
    COST: { EN: '💰 *LASIK Cost at Relive Cure:*\n\nTreatment starts from ₹15,000 and can go up to ₹90,000 depending on your eye condition and recommended technology.\n\nThe best way to know your exact cost is a *free consultation* where our specialist evaluates your eyes.', HI: '💰 *Relive Cure में LASIK की Cost:*\n\nTreatment ₹15,000 से शुरू होती है और ₹90,000 तक हो सकती है।\n\nExact cost के लिए *free consultation* सबसे अच्छा तरीका है।' },
    RECOVERY: { EN: '⚡ *LASIK Recovery is Super Fast:*\n\n• Vision clears in 3–12 hours\n• Normal routine next day\n• Full recovery in 1–2 weeks\n• No patches, no bed rest needed', HI: '⚡ *LASIK Recovery बहुत तेज़ है:*\n\n• 3–12 घंटे में vision clear\n• अगले दिन से normal routine\n• 1–2 हफ्ते में पूरी recovery\n• कोई patch या bed rest नहीं' },
    PAIN: { EN: '✅ *LASIK is Almost Painless:*\n\n• Mild pressure for a few seconds only\n• No real pain during surgery\n• Numbing eye drops used beforehand\n• Mild irritation for a few hours after', HI: '✅ *LASIK लगभग दर्द-रहित है:*\n\n• सिर्फ कुछ सेकंड के लिए हल्का pressure\n• Surgery के दौरान कोई दर्द नहीं\n• Numbing eye drops पहले दी जाती हैं\n• बाद में कुछ घंटे हल्की जलन' },
    ELIGIBILITY: { EN: '🔍 *LASIK Eligibility Depends On:*\n\n• Stable eye power for 1+ year\n• Age 18+ years\n• Healthy eyes & sufficient corneal thickness\n• No major eye diseases', HI: '🔍 *LASIK Eligibility किन बातों पर निर्भर करती है:*\n\n• 1+ साल से stable eye power\n• उम्र 18+ साल\n• Healthy eyes\n• कोई बड़ी eye disease नहीं' },
    SAFETY: { EN: '😊 LASIK is one of the *safest* eye procedures worldwide:\n\n• 98%+ success rate\n• No general anesthesia\n• Takes only 10–15 minutes\n• Full evaluation done before surgery', HI: '😊 LASIK दुनिया के *सबसे safe* procedures में से एक है:\n\n• 98%+ success rate\n• General anesthesia नहीं\n• सिर्फ 10–15 मिनट\n• Surgery से पहले पूरी evaluation' },
    TIMELINE: { EN: '📅 *LASIK at Relive Cure:*\n\n• Surgery: 10–15 mins (both eyes)\n• Same day discharge\n• Back to work next day\n• Driving: after 1–2 days', HI: '📅 *Relive Cure में LASIK:*\n\n• Surgery: 10–15 मिनट\n• Same day discharge\n• अगले दिन काम पर वापस\n• Driving: 1–2 दिन बाद' },
    REFERRAL: { EN: '🎁 Refer a friend → Earn *₹1,000* per surgery. No limit!\n\nOur team will share details when you book 😊', HI: '🎁 एक दोस्त refer करें → *₹1,000* कमाएँ। कोई limit नहीं!\n\nBooking पर team details देगी 😊' },
    LOCATION: { EN: "Our sales specialist will call you shortly with all the details 😊", HI: "हमारा sales specialist जल्द call करके सारी details share करेगा 😊" },
    ALTERNATIVES: { EN: '👓 LASIK vs Glasses:\n\n• LASIK → one-time cost, permanent freedom\n• Glasses → recurring cost, daily hassle\n• Sports / swimming → no glasses with LASIK ✅', HI: '👓 LASIK vs Chashma:\n\n• LASIK → एक बार का खर्च, हमेशा की आज़ादी\n• Chashma → बार-बार खर्च, रोज़ की परेशानी' },
    CONCERN: { EN: '😊 I hear you — blurry vision and being dependent on glasses is exactly what LASIK is designed to fix. Most patients become completely glasses-free after the procedure.\n\nOur specialist can check your eligibility properly — let me grab a couple of quick details first.', HI: '😊 मैं समझता हूँ — धुंधला दिखना और चश्मे पर निर्भर रहना, LASIK इसी के लिए बना है। ज़्यादातर patients procedure के बाद पूरी तरह चश्मा-मुक्त हो जाते हैं।\n\nSpecialist आपकी eligibility ठीक से check कर सकते हैं — पहले कुछ quick details ले लेता हूँ।' }
};

const INTENTS = {
    RECOVERY: ['recovery', 'recover', 'kitne din', 'kitna time', 'how long', 'recover time', 'recovery time', 'theek kab', 'ठीक होने', 'रिकवरी'],
    PAIN: ['pain', 'painful', 'dard', 'dard hoga', 'takleef', 'hurt', 'kya dard', 'दर्द', 'तकलीफ'],
    ELIGIBILITY: ['eligible', 'eligibility', 'suitable', 'possible', 'kar sakta', 'kar sakti', 'ho sakta', 'can i do', 'karwa sakta', 'kya main', 'योग्य', 'हो सकता'],
    REFERRAL: ['refer', 'referral', 'reward', 'earn', 'kya milega', 'रेफर', 'कमाई'],
    COST: ['cost', 'price', 'charges', 'fees', 'kharcha', 'rate', 'expense', 'amount', 'how much', 'how much does', 'how much is', 'money', 'kitna padega', 'kitne ka', 'kitna hai', 'kitna paisa', 'paisa kitna', 'paisa lagega', 'kitne paise', 'कितना खर्चा', 'कीमत', 'फीस', 'खर्च'],
    TIMELINE: ['when', 'how soon', 'schedule', 'kab', 'jaldi', 'next week', 'this week', 'soon', 'immediately', 'कब', 'जल्दी'],
    SAFETY: ['scared', 'fear', 'safe', 'risk', 'side effects', 'nervous', 'afraid', 'dar lag raha', 'danger', 'dangerous', 'डर', 'खतरा', 'सुरक्षित'],
    LOCATION: ['where', 'location', 'address', 'kahan hai', 'nearest', 'clinic', 'hospital', 'centre', 'branch', 'कहाँ', 'पता', 'शाखा'],
    ALTERNATIVES: ['contact lens', 'glasses', 'specs', 'chashma', 'alternative', 'lenses', 'spectacles', 'vs', 'compare', 'चश्मा', 'लेंस'],
    CONCERN: ['issue with my eye', 'issue with my eyes', 'issue in my eye', 'problem with my eye', 'problem in my eye', 'eye problem', 'eye issue', 'eyes problem', 'eyesight problem', 'blurry', 'blurred', 'blur', "can't see", 'cant see', 'cannot see', "can't read", 'unable to see', 'weak eyesight', 'weak eyes', 'weak eye', 'poor vision', 'bad vision', 'low vision', 'vision problem', 'vision issue', 'trouble seeing', 'difficulty seeing', 'thick glasses', 'high power', 'aankh', 'aankhon', 'aankhon mein', 'dikhai nahi', 'dikhta nahi', 'saaf nahi dikhta', 'nazar kamzor', 'kamzor nazar', 'धुंधला', 'दिखाई नहीं', 'नज़र', 'कमज़ोर']
};

function detectAllIntents(message) { const m = message.toLowerCase(); return Object.entries(INTENTS).filter(([, words]) => words.some(w => m.includes(w))).map(([intent]) => intent); }

function getNextQuestion(session, context = 'normal') {
    sanitizeSessionFields(session);
    const d = session.data; const lang = session.lang || 'EN';
    const firstName = d.contactName && d.contactName !== 'WhatsApp Lead' && !isIndianCity(d.contactName) ? d.contactName.split(' ')[0] : '';
    const field = getMissingQualField(session);
    let text = '';
    if (!field) return { text: '', field: null };
    d.resumeAsked = d.resumeAsked || [];
    // Skip only when the field is actually collected — user may ignore a question (e.g. cataract tangent).
    if (context === 'resume' && d.resumeAsked.includes(field) && fieldCollected(session, field)) {
        return { text: '', field: null };
    }
    if (d.resumeAsked.includes(field) && !fieldCollected(session, field)) {
        context = 'normal';
    }
    if (field === 'CITY') text = t('ASK_CITY', lang);
    else if (field === 'EYE_POWER') text = t('ASK_EYE_POWER', lang);
    else if (field === 'POWER_STABILITY') text = t('ASK_POWER_STABILITY', lang);
    else if (field === 'INSURANCE') text = t('ASK_INSURANCE', lang);
    d.resumeAsked.push(field);
    session.data.lastAskedField = field;
    if (context === 'normal' && firstName && field !== 'NAME') { const g = { EN: `Got it, ${firstName} 👍\n\n`, HI: `समझ गया, ${firstName} 👍\n\n` }; text = (g[lang] || g.EN) + text; }
    if (context === 'resume') {
        const fn = {
            NAME: { EN: 'your name', HI: 'आपका नाम' },
            CITY: { EN: 'your city', HI: 'आपका शहर' },
            EYE_POWER: { EN: 'your eye power', HI: 'आपकी eye power' },
            POWER_STABILITY: { EN: 'how stable your power is', HI: 'power कितनी stable है' },
            INSURANCE: { EN: 'whether you have medical insurance', HI: 'क्या आपके पास medical insurance है' },
        };
        const fld = fn[field] || { EN: field, HI: field };
        const r = { EN: `By the way, could you tell me ${fld.EN}?`, HI: `एक बात — ${fld.HI} बता सकते हैं?` };
        text = r[lang] || r.EN;
    }
    return { text, field };
}

/** After Gemini answers, append one passive city/power ask (same as KB path) when details are still missing. */
function enrichAgentReply(session, message, msgLow, reply) {
    const d = session.data;
    const lang = session.lang || 'EN';
    if (!reply) return reply;
    const missing = getMissingQualField(session);
    if (!missing && (d.callback_offered || session.state === 'COMPLETE')) return reply;

    if (session.state === 'GREETING') session.state = 'CORE_CONSULT';

    const intents = detectAllIntents(message).filter(i => i !== 'YES' && i !== 'NO');
    if (intents.includes('COST')) d.interest_cost = true;
    if (intents.includes('RECOVERY')) d.interest_recovery = true;
    if (intents.includes('PAIN')) d.concern_pain = true;
    if (intents.includes('SAFETY')) d.concern_safety = true;
    if (intents.includes('CONCERN')) d.concern_power = true;
    if (/lasik|specs|glasses|vision|eligibility/i.test(msgLow)) d.concern_power = true;
    if (/₹|15,?000|90,?000|cost|price|kitna/i.test(reply)) d.interest_cost = true;

    const engaged = (d.message_count || 0) >= 2
        || intents.length > 0
        || d.interest_cost || d.concern_power || d.request_call
        || /^(sure|okay|ok|yes|haan|ha|theek|thik)$/i.test(msgLow.trim());

    if (!engaged) return reply;

    const rlow = reply.toLowerCase();
    if (/city|शहर|eye power|glasses power|chashma|aankh.*power|power.*aankh|insurance|bima|medical cover/.test(rlow)) {
        markFieldsAskedInReply(reply, session);
        return reply;
    }

    const nextStep = getNextQuestion(session, 'resume');
    if (!nextStep.text || !nextStep.field) return reply;

    return `${reply}\n\n${nextStep.text}`;
}

function buildKnowledgeResponse(message, session) {
    const lang = session.lang || 'EN';
    let intents = detectAllIntents(message).filter(i => i !== 'YES' && i !== 'NO');
    if (/[-+]?\d+(\.\d+)?/.test(message) && !intents.includes('ELIGIBILITY') && session.state !== 'TIMELINE') { intents.push('ELIGIBILITY'); session.data.concern_power = true; }
    if (intents.length === 0) return null;
    const topIntent = intents[0];
    if (session.last_intent_handled === topIntent && session.last_intent_handled_at && Date.now() - session.last_intent_handled_at < 45000) {
        return { EN: 'I just shared details about that 😊 Anything specific you\'d like to know?', HI: 'मैंने अभी इसके बारे में बताया था 😊 कुछ specific पूछना चाहेंगे?' }[lang];
    }
    session.last_intent_handled = topIntent; session.last_intent_handled_at = Date.now();
    const kbEntry = KB[topIntent]; if (!kbEntry) return null;
    const ack = getAcknowledgement(message, lang);
    let baseReply = ack ? `${ack}\n\n${kbEntry[lang] || kbEntry.EN}` : (kbEntry[lang] || kbEntry.EN);
    if (intents.length > 1 && KB[intents[1]]) { const second = KB[intents[1]][lang] || KB[intents[1]].EN; if (second) baseReply += `\n\n─────────────\n\n${second}`; }
    if (intents.includes('COST')) session.data.interest_cost = true;
    if (intents.includes('RECOVERY')) session.data.interest_recovery = true;
    if (intents.includes('PAIN')) session.data.concern_pain = true;
    if (intents.includes('SAFETY')) session.data.concern_safety = true;
    if (intents.includes('CONCERN')) session.data.concern_power = true;
    const isEmotional = ['PAIN', 'SAFETY'].includes(topIntent);
    const isCallbackAlreadyOffered = session.data.callback_offered;
    if (!isEmotional) {
        if (shouldOfferCallback(session) && !isCallbackAlreadyOffered) {
            if (!session.data.callback_offered) session.data.callback_offered = true;
            session.data.request_call = true; session.data.human_handoff_started = true; session.data.callback_source = 'knowledge_trigger'; session.state = 'COMPLETE';
            const fn = safeFirstName(session);
            baseReply += `\n\n${getEscalationMessage('candidate', lang, fn)}`;
        } else {
            const nextStep = getNextQuestion(session, 'resume');
            if (nextStep.text && nextStep.field) {
                // Only ask a field once via the resume path — don't repeat it on every KB response
                if (!session.data.resumeAsked) session.data.resumeAsked = [];
                if (!session.data.resumeAsked.includes(nextStep.field)) {
                    session.data.resumeAsked.push(nextStep.field);
                    baseReply += `\n\n${nextStep.text}`;
                }
            } else if (!isCallbackAlreadyOffered) {
                const rep = { EN: '\n\nOur representative will call you shortly 😊', HI: '\n\nहमारा representative जल्द call करेगा 😊' };
                baseReply += rep[lang] || rep.EN;
            }
        }
    }
    return baseReply;
}

// ─── WHATSAPP SEND (uses polyfilled globalThis.fetch) ────────────────────────
async function sendWhatsAppReply(phone, reply) {
    // ─── LOOP GUARD: block byte-identical replies ───
    if (isLooping(phone, reply)) {
        console.warn(`[LOOP] 🔁 Blocked repeated reply to ${phone} — pausing bot`);
        try {
            await supabaseAdmin.from('whatsapp_conversations')
                .upsert({ phone, bot_paused: true, updated_at: new Date().toISOString() }, { onConflict: 'phone' });
        } catch(e) { console.warn('[LOOP] pause-write failed:', e.message); }
        if (isPushConfigured()) {
            fanout(supabaseAdmin, {
                title: '🔁 Bot loop detected',
                body: `Bot was repeating to ${phone} — auto-paused`,
                phone, url: `/m?phone=${encodeURIComponent(phone)}`, kind: 'escalation'
            }).catch(() => {});
        }
        return;
    }
    const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
    let rawText = '';
    try {
        // Strip markdown formatting for WhatsApp (no bold, bullets, headers, horizontal rules)
        let cleanReply = (reply || '')
            .replace(/\*([^*]+)\*/g, '$1')     // *bold* → bold
            .replace(/_([^_]+)_/g, '$1')         // _italic_ → italic
            .replace(/^#{1,3}\s+/gm, '')          // ### header → header
            .replace(/^[-•]\s+/gm, '')            // • bullet or - bullet → plain
            .replace(/^\d+\.\s+/gm, '')           // 1. numbered → plain
            .replace(/^_{3,}$/gm, '')              // ___ horizontal rule → empty
            .replace(/^[-]{3,}$/gm, '')            // --- horizontal rule → empty
            .replace(/\n{3,}/g, '\n\n')           // collapse 3+ newlines to 2
            .trim();
        const res = await globalThis.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: cleanReply } }) });
        rawText = await res.text();
        if (res.status === 429) { console.warn('[WA SEND] ⚠️ Rate limited (429)'); return; }
        if (rawText.trim().startsWith('{')) {
            const data = JSON.parse(rawText);
            console.log('[WA SEND] ✅', JSON.stringify(data));
            trackOutbound(phone, reply); // track hash for loop detection
            // ─── WhatsApp Engine: capture every outbound message ───
            const _sentId = data.messages?.[0]?.id || null;
            saveWhatsAppMessage({
                phone,
                direction: 'outbound',
                body: reply,
                msgType: 'text',
                waMessageId: _sentId,
                waTimestamp: new Date().toISOString()
            }).catch(e => console.error('[WA CAPTURE] outbound', e.message));
        }
        else { console.warn('[WA SEND] ⚠️ Non-JSON:', rawText.substring(0, 200)); }
    } catch (err) { console.error('[WA SEND] ❌', err.message, rawText.substring(0, 200)); }
}

// ─── CORE MESSAGE HANDLER ─────────────────────────────────────────────────────
// Map the Gemini agent's structured extraction onto session.data, so the existing
// scoring (scoreSession), leads_surgery ingest (sendToAPI), and hands-free
// auto-push all keep working unchanged whether the reply came from the agent or
// the rule-based machine.
function applyAgentExtract(session, ag) {
    const d = session.data;
    const costIntent = ag.asks_cost || ag.asks_recovery || ag.asks_pain || ag.asks_safety;
    if (ag.name && typeof ag.name === 'string' && !costIntent) {
        const nm = ag.name.trim();
        if (isIndianCity(nm)) {
            if (!d.city) d.city = titleCaseCity(nm.split(/[,\s]+/)[0]);
        } else if (isValidName(nm)) {
            if (!d.contactName || d.contactName === 'WhatsApp Lead' || d.contactName.toLowerCase() !== nm.toLowerCase()) {
                d.contactName = nm;
            }
        }
    }
    if (ag.city && typeof ag.city === 'string' && !d.city) {
        const norm = normalizeCityAlias(ag.city.trim());
        if (norm) d.city = norm;
    }
    if (ag.eye_power && typeof ag.eye_power === 'string') {
        const p = parseEyePower(ag.eye_power);
        const hasBoth = p?.right != null && p?.left != null;
        if (shouldReplaceEyePower(d.eyePower, p, false) || isGarbageEyePowerCatchAll(d.eyePower)) {
            if (p && (p.numeric != null || hasBoth)) { d.eyePower = p; d.concern_power = true; }
            else if (p?.raw && p.numeric != null) { d.eyePower = p; d.concern_power = true; }
        }
    }
    if (ag.timeline && typeof ag.timeline === 'string' && !d.timeline) d.timeline = ag.timeline.trim();
    if (ag.insurance === true) d.insurance = 'Yes';
    // Never auto-set insurance "No" from LLM extract — only passiveExtract after we ask.
    if (ag.previous_surgery && typeof ag.previous_surgery === 'string' && !d.previous_surgery) d.previous_surgery = ag.previous_surgery.trim();
    if (ag.age_group && typeof ag.age_group === 'number' && !d.ageGroup) d.ageGroup = ag.age_group;
    if (ag.willing_to_travel === true) d.willing_to_travel = true;
    if (ag.asks_cost) d.interest_cost = true;
    if (ag.asks_recovery) d.interest_recovery = true;
    if (ag.asks_pain) d.concern_pain = true;
    if (ag.asks_safety) d.concern_safety = true;
    if (ag.power_concern) d.concern_power = true;
    if (ag.is_cataract) d.is_cataract = true;
    if (ag.wants_callback) {
        d.request_call = true;
        if (!getMissingQualField(session)) {
            if (!d.callback_offered) d.callback_offered = true;
            d.human_handoff_started = true;
            if (!d.callback_source) d.callback_source = 'agent';
        }
    }
}

async function handleIncomingMessage(reqBody, isTestChat = false) {
    let phone, message, msgId;
    let reply = null, replied = false, finalized = false;
    const setReply = (text) => { if (!replied) { reply = text; replied = true; const s = botSessions[phone]; if (s) markFieldsAskedInReply(text, s); } };
    const finalize = (forceReturn = false) => {
        if (finalized) return reply;
        finalized = true;
        if (!reply) { const s = botSessions[phone]; const l = s?.lang || 'EN'; reply = t('FALLBACK', l); if (s) { s.data.request_call = true; if (!s.data.callback_offered) s.data.callback_offered = true; s.data.human_handoff_started = true; s.data.callback_source = 'fallback'; } }
        if (!forceReturn) sendWhatsAppReply(phone, reply);
        return reply;
    };

    let waProfileName = null;
    try {
        if (reqBody?.entry) {
            const messageObj = reqBody.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
            if (!messageObj) return;
            phone = messageObj.from; message = messageObj.text?.body || ''; msgId = messageObj.id;

            // ─── WhatsApp Engine: capture every inbound message (text + media) ───
            try {
                const _waValue = reqBody.entry?.[0]?.changes?.[0]?.value;
                const _waContactName = _waValue?.contacts?.[0]?.profile?.name || null;
                waProfileName = _waContactName;
                const _waType = messageObj.type || 'text';
                const _waMediaId = (_waType !== 'text' && messageObj[_waType]) ? (messageObj[_waType].id || null) : null;
                saveWhatsAppMessage({
                    phone,
                    direction: 'inbound',
                    body: message || null,
                    msgType: _waType,
                    mediaId: _waMediaId,
                    waMessageId: msgId,
                    contactName: _waContactName,
                    waTimestamp: messageObj.timestamp || null
                }).catch(e => console.error('[WA CAPTURE] inbound', e.message));
            } catch (e) { console.error('[WA CAPTURE] inbound-prep', e.message); }

            // ─── Bot-pause: if a human took over this conversation in the dashboard,
            //     the inbound message is already captured above — just don't auto-reply. ───
            try {
                const { data: _convoPause } = await supabaseAdmin
                    .from('whatsapp_conversations')
                    .select('bot_paused')
                    .eq('phone', phone)
                    .maybeSingle();
                if (_convoPause?.bot_paused) {
                    console.log(`[BOT] ⏸️  paused for ${phone} — human takeover, skipping auto-reply`);
                    return;
                }
            } catch (e) { console.error('[BOT] pause-check error', e.message); }

            if (!message && messageObj.type && messageObj.type !== 'text') {
                const _mLang = botSessions[phone]?.lang || 'EN';
                const _mSess = botSessions[phone];
                let _mReply;
                if (messageObj.type === 'image') {
                    _mReply = _mLang === 'HI'
                        ? 'यह शायद आपकी prescription है 😊 मैं अभी images नहीं पढ़ सकता — क्या आप अपनी eye power type करेंगे (जैसे -2.5)?'
                        : "Looks like you shared an image — possibly a prescription 😊 I can't read images yet. Could you type your eye power (e.g. -2.5)?";
                } else {
                    _mReply = _mLang === 'HI'
                        ? 'मैं अभी सिर्फ text process कर सकता हूँ 😊 कृपया type करें।'
                        : 'I can only process text right now 😊 Please type your message.';
                }
                await sendWhatsAppReply(phone, _mReply); return;
            }
        } else { phone = reqBody.phone; message = reqBody.message || ''; msgId = null; }

        if (!phone || !message) return;
        message = message.trim(); const msgLow = message.toLowerCase();
        console.log(`[BOT] phone=${phone} msg="${message}"`);

        const dedupKey = msgId || (phone + '_' + Buffer.from(message).toString('base64').substring(0, 10) + '_' + Math.floor(Date.now() / 1000));
        if (botProcessedMessages.has(dedupKey)) return;
        botProcessedMessages.set(dedupKey, Date.now());

        if (!botSessions[phone]) {
            const existing = await checkExistingLead(phone);
            const seedData = existing ? hydrateSessionDataFromLead(existing) : {};
            if (!existing && waProfileName) {
                const waFirst = waProfileName.trim().split(/\s+/).slice(0, 2).join(' ');
                if (isValidName(waFirst)) seedData.contactName = waFirst;
            }
            botSessions[phone] = { state: existing ? 'RETURNING' : 'GREETING', data: seedData, inactivityTimer: null, ingested: !!existing, first_ingest_done: !!existing, lang: 'EN', repeat_count: {}, resume_offered: false, last_intent_handled: null };
            if (!existing) { setImmediate(async () => { try { await sendToAPI(phone, botSessions[phone], 'initial'); } catch (e) { console.error('[ASYNC_INGEST_ERROR]', e); } }); }
        }

        let session = botSessions[phone];
        const { lang: detectedLang, confidence: langConf } = detectLanguageWithConfidence(message);
        if (langConf !== 'low' || !session.lang) session.lang = detectedLang;
        const lang = resolveReplyLang(session, message);

        session.last_activity_at = new Date().toISOString();
        if (!session.data.first_message_at) session.data.first_message_at = session.last_activity_at;
        session.data.message_count = (session.data.message_count || 0) + 1;
        session.data.lastMessage = message;

        // ─── Explicit language switch (e.g. user types "english") ───
        // Runs BEFORE field capture so the switch word is never stored as an
        // answer (e.g. eye power). Forces session.lang and re-asks in new lang.
        const langSwitch = explicitLangSwitch(message);
        if (langSwitch) {
            session.lang = langSwitch;
            if (session.state === 'GREETING') session.state = 'CORE_CONSULT';
            const ack = langSwitch === 'EN' ? "Sure, I'll continue in English 😊" : 'ठीक है, मैं हिंदी में बात करूँगा 😊';
            const next = getNextQuestion(session);
            setReply(next && next.text ? `${ack}\n\n${next.text}` : ack);
            resetInactivityTimer(phone);
            return finalizeWithIngest(phone, session, 'rule-based', finalize, isTestChat);
        }

        passiveExtract(message, session);
        sanitizeSessionFields(session);
        resetInactivityTimer(phone);

        if (session.state === 'COMPLETE' || session.state === 'CORE_CONSULT') {
            const stillExists = await checkExistingLead(phone);
            if (!stillExists && session.ingested && !isLabPhone(phone)) {
                delete botSessions[phone];
                botSessions[phone] = { state: 'GREETING', data: {}, inactivityTimer: null, ingested: false, first_ingest_done: false, lang, repeat_count: {}, resume_offered: false, last_intent_handled: null };
                session = botSessions[phone];
            }
        }

        session.repeat_count = session.repeat_count || {};

        const substantiveIntents = detectAllIntents(message).filter(i => i !== 'YES' && i !== 'NO');

        // ─── INTENT-FIRST — ad CTAs & clear KB intents (skip slow LLM when rules suffice) ───
        {
            if (substantiveIntents.length > 0) {
                const kbDirect = buildKnowledgeResponse(message, session);
                if (kbDirect) {
                    if (session.state === 'GREETING') session.state = 'CORE_CONSULT';
                    setReply(kbDirect);
                    return finalizeWithIngest(phone, session, 'knowledge', finalize, isTestChat);
                }
            }
            if (session.state === 'GREETING' && substantiveIntents.length === 0
                && (isAdCtaMessage(msgLow) || (msgLow.length < 50 && !/[-+]?\d/.test(message)))
                && !preferAgentOverFastPaths()) {
                session.state = 'CORE_CONSULT';
                setReply(getGreetingReply(msgLow, lang));
                return finalizeWithIngest(phone, session, 'greeting', finalize, isTestChat);
            }
        }

        // Plain hi/hello — skip slow LLM only when agent is off, shadow, or daily cap hit.
        if (isPlainGreeting(msgLow) && !preferAgentOverFastPaths()) {
            if (session.state === 'RETURNING') {
                const fn = safeFirstName(session);
                const r = {
                    EN: `Hi${fn ? `, ${fn}` : ''}! 👋 How can I help you today?`,
                    HI: `नमस्ते${fn ? `, ${fn}` : ''}! 👋 आज कैसे help करूँ?`,
                };
                setReply(r[lang] || r.EN);
            } else {
                session.state = 'CORE_CONSULT';
                setReply(getGreetingReply(msgLow, lang));
            }
            return finalizeWithIngest(phone, session, 'greeting', finalize, isTestChat);
        }

        // Short messages with nothing to extract — skip LLM when not in live agent mode.
        if (!preferAgentOverFastPaths() && substantiveIntents.length === 0 && msgLow.length < 12 && !/[-+]?\d/.test(message) && !isPlainGreeting(msgLow)) {
            const next = getNextQuestion(session);
            if (next.text) {
                setReply(next.text);
                return finalizeWithIngest(phone, session, 'rule-based', finalize, isTestChat);
            }
        }

        // ─── LLM AGENT — extraction + rule-based reply ───
        if (isAgentEnabled()) {
            let agentResult = null;
            let agentRun = null;
            try {
                agentRun = await runAgentForPhone(phone, () => runGeminiAgentDetailed({
                    message,
                    history: session._agentHistory || [],
                    sessionData: session.data,
                }));
                agentResult = agentRun?.fields ?? null;
                session._lastAgentModel = agentRun?.model ?? null;
                session._lastAgentFail = agentRun?.failReason ?? null;
                session._lastAgentChain = agentRun?.chain ?? [];
            } catch (e) {
                console.error('[AGENT] error → rule-based fallback:', e.message);
                session._lastAgentFail = e.message;
            }

            if (agentResult) {
                applyAgentExtract(session, agentResult);
                passiveExtract(message, session);
                sanitizeSessionFields(session);
                session._lastAgentFail = null;

                const hasData = session.data.city || session.data.eyePower || session.data.contactName;
                if (session.state === 'GREETING' && hasData) session.state = 'CORE_CONSULT';
                if (session.data.request_call && session.state !== 'COMPLETE' && !getMissingQualField(session)) {
                    session.state = 'COMPLETE';
                    if (!session.data.callback_offered) session.data.callback_offered = true;
                    session.data.human_handoff_started = true;
                }

                const sendAgentToUser = agentMode() === 'live' || isLabPhone(phone);
                if (sendAgentToUser) {
                    let toSend = composeAgentReply(session, message, msgLow);
                    if (toSend && !isInventedAgentClaim(toSend)) {
                        toSend = toSend.trim();
                        session._agentHistory = (session._agentHistory || [])
                            .concat({ role: 'user', text: message }, { role: 'model', text: toSend })
                            .slice(-20);
                        setReply(toSend);
                        console.log(`[AGENT:${isLabPhone(phone) ? 'lab' : 'live'}] ✅ ${phone}`);
                        applyConversationHardStop(phone, session, message, msgLow);
                        return finalizeWithIngest(phone, session, 'agent', finalize, isTestChat);
                    }
                    console.log(`[AGENT:live] guard → rule-based for ${phone}`);
                } else {
                    const shadowReply = composeAgentReply(session, message, msgLow);
                    session._agentHistory = (session._agentHistory || [])
                        .concat({ role: 'user', text: message }, { role: 'model', text: shadowReply || '' })
                        .slice(-20);
                    console.log(`[AGENT:shadow] phone=${phone} inbound="${message.slice(0, 80)}" agent_reply="${(shadowReply || '').slice(0, 120)}"`);
                }
            } else {
                session._lastAgentFail = session._lastAgentFail || getLastAgentFailReason() || (isAgentEnabled() ? 'gemini_unavailable' : 'agent_off');
                const hasRealName = session.data.contactName && session.data.contactName !== 'WhatsApp Lead'
                    && !COMMON_WORD_BLACKLIST.has(session.data.contactName.toLowerCase());
                const hasData = session.data.city || session.data.eyePower || hasRealName;
                if (session.state === 'GREETING' && hasData) session.state = 'CORE_CONSULT';
                console.log(`[AGENT:fallback] ${phone} → rule-based (${session._lastAgentFail})`);
            }
        }

        // ─── RULE-BASED FALLBACK (quota exhausted, agent off, or API failed) ───

        if (isNotInterested(msgLow)) {
            session.data.opted_out = true;
            if (session.inactivityTimer) { clearTimeout(session.inactivityTimer); session.inactivityTimer = null; }
            supabaseAdmin.from('whatsapp_conversations')
                .upsert({ phone, bot_paused: true, updated_at: new Date().toISOString() }, { onConflict: 'phone' }).catch(() => {});
            setReply(t('NOT_INTERESTED', lang));
            return finalizeWithIngest(phone, session, 'update', finalize, isTestChat);
        }

        if (isDisengaged(msgLow) || isAbusive(msgLow)) {
            const abuse = isAbusive(msgLow);
            session.data.opted_out = true;
            if (session.inactivityTimer) { clearTimeout(session.inactivityTimer); session.inactivityTimer = null; }
            supabaseAdmin.from('whatsapp_conversations')
                .upsert({ phone, bot_paused: true, updated_at: new Date().toISOString() }, { onConflict: 'phone' }).catch(() => {});
            if (isPushConfigured()) {
                fanout(supabaseAdmin, {
                    title: abuse ? '🚨 Angry lead — bot paused' : '⏸️ Lead disengaged',
                    body: `${safeFirstName(session) || phone}: "${message.slice(0, 60)}"`,
                    phone, url: `/m?phone=${encodeURIComponent(phone)}`, kind: 'escalation'
                }).catch(() => {});
            }
            setReply(lang === 'HI'
                ? 'समझ गया 🙏 ख्याल रखें! कभी भी बात करना चाहें तो message करें।'
                : 'Got it 🙏 Take care! Message us anytime you want to talk.');
            return finalizeWithIngest(phone, session, 'disengaged', finalize, isTestChat);
        }

        const nameCorr = checkNameCorrection(message, session);
        if (nameCorr === 'cleared') {
            setReply(lang === 'HI'
                ? 'माफ़ कीजिए! 🙏 आपका नाम क्या है?'
                : 'Sorry about that! 🙏 What should I call you?');
            return finalizeWithIngest(phone, session, 'name_correction', finalize, isTestChat);
        }
        if (nameCorr === 'captured') {
            const fn = safeFirstName(session);
            const next = getNextQuestion(session);
            const ack = lang === 'HI' ? `धन्यवाद, ${fn}! 😊` : `Thanks, ${fn}! 😊`;
            setReply(next.text ? `${ack}\n\n${next.text}` : ack);
            session.state = 'CORE_CONSULT';
            return finalizeWithIngest(phone, session, 'name_correction', finalize, isTestChat);
        }

        if (isOffTopic(message)) {
            setReply(lang === 'HI'
                ? 'मैं Relive Cure का vision assistant हूँ — इस concern के लिए सही specialist से मिलें 🙏\n\nक्या आपकी आँखों से जुड़ा कोई सवाल है?'
                : 'I\'m Relive Cure\'s vision assistant — for that concern, please consult the right specialist 🙏\n\nDo you have any questions about your eyes?');
            return finalizeWithIngest(phone, session, 'off_topic', finalize, isTestChat);
        }

        const restartWords = ['hi', 'hello', 'hey', 'start', 'hii', 'helo', 'नमस्ते', 'हेलो', 'शुरू'];
        if (!isLabPhone(phone) && restartWords.some(w => msgLow === w || message === w)) {
            const hasData = session.data.contactName && session.data.contactName !== 'WhatsApp Lead';
            if (hasData && !session.resume_offered) { session.state = 'ASK_RESUME'; session.resume_offered = true; setReply(t('WELCOME_BACK', lang)); return finalizeWithIngest(phone, session, 'update', finalize, isTestChat); }
            else if (!hasData) { session.state = 'GREETING'; session.ingested = false; session.resume_offered = false; session.repeat_count = {}; }
        }

        if (isEscalationTrigger(msgLow) || isCataractMention(msgLow)) {
            session.data.is_cataract = true;
            if (!session.data.escalation_note) session.data.escalation_note = message;
            sanitizeSessionFields(session);
            const missing = getMissingQualField(session);
            if (missing) {
                const next = getNextQuestion(session, 'normal');
                setReply(next.text ? `${getCataractAck(lang)}\n\n${next.text}` : getCataractAck(lang));
                if (session.state === 'GREETING') session.state = 'CORE_CONSULT';
                return finalizeWithIngest(phone, session, 'update', finalize, isTestChat);
            }
            session.data.request_call = true;
            if (!session.data.callback_offered) session.data.callback_offered = true;
            session.state = 'COMPLETE';
            session.data.human_handoff_started = true;
            session.data.callback_source = 'escalation';
            const fn = safeFirstName(session);
            setReply(getEscalationMessage('educational', lang, fn));
            return finalizeWithIngest(phone, session, 'update', finalize, isTestChat);
        }

        if (isSalesIntent(msgLow)) { session.data.request_call = true; if (!session.data.callback_offered) session.data.callback_offered = true; session.state = 'COMPLETE'; session.data.human_handoff_started = true; session.data.callback_source = 'sales_intent'; const fn = safeFirstName(session); setReply(getEscalationMessage('callback', lang, fn)); return finalizeWithIngest(phone, session, 'update', finalize, isTestChat); }

        const knowledge = buildKnowledgeResponse(message, session);
        if (knowledge) { setReply(knowledge); return finalizeWithIngest(phone, session, 'knowledge', finalize, isTestChat); }

        const state = session.state;
        session.repeat_count[state] = (session.repeat_count[state] || 0) + 1;

        if (state === 'GREETING') {
            session.state = 'CORE_CONSULT';
            if (!session.data.contactName || COMMON_WORD_BLACKLIST.has((session.data.contactName || '').toLowerCase())) {
                session.data.contactName = 'WhatsApp Lead';
            }
            setReply(getGreetingReply(msgLow, lang));
        }

        else if (state === 'ASK_RESUME') {
            const isYes = ['yes', 'haan', 'ha', 'ok', 'okay', 'sure', 'हाँ', 'ठीक', 'bilkul', 'ji'].some(w => msgLow.includes(w));
            if (isYes) { const next = getNextQuestion(session); if (next.field) { const r = { EN: `Great! Let's continue.\n\n${next.text}`, HI: `बढ़िया! जारी रखते हैं।\n\n${next.text}` }; setReply(r[lang] || r.EN); session.state = 'CORE_CONSULT'; } else { session.state = 'COMPLETE'; setReply(getRandomCompleteReply(lang)); session.data.request_call = true; } }
            else { session.state = 'CORE_CONSULT'; session.data = { contactName: 'WhatsApp Lead' }; session.repeat_count = {}; session.resume_offered = false; setReply(t('GREETING', lang)); }
        }

        else if (state === 'RETURNING') {
            const lead = await checkExistingLead(phone);
            const fn = safeFirstName(session);
            if (lead && lead.pushed_to_crm) { session.state = 'COMPLETE'; const r = { EN: `Welcome back${fn ? `, ${fn}` : ''}! 👋 Your details are saved ✅\n\nHow can I help?\n• Ask about cost or recovery\n• Or say *call* for a specialist`, HI: `वापस आए${fn ? `, ${fn}` : ''}! 👋 Details saved हैं ✅\n\nकैसे help करूँ?\n• Cost या recovery जानें\n• Specialist के लिए *call* लिखें` }; setReply(r[lang] || r.EN); }
            else { const next = getNextQuestion(session); if (next.field) { const r = { EN: `Welcome back! Let's continue.\n\n${next.text}`, HI: `वापस आए! जारी रखते हैं।\n\n${next.text}` }; setReply(r[lang] || r.EN); session.state = 'CORE_CONSULT'; } else { session.state = 'COMPLETE'; setReply(getRandomCompleteReply(lang)); session.data.request_call = true; } }
        }

        else if (state === 'NAME') {
            if (isIndianCity(message)) {
                session.data.city = titleCaseCity(message.split(/[,\s]+/)[0]);
                session.state = 'CORE_CONSULT';
                const next = getNextQuestion(session);
                setReply(next.text || (lang === 'HI' ? 'धन्यवाद! 😊' : 'Thanks! 😊'));
            } else if (!isValidName(message)) {
                // F7: If the user opened with their concern instead of a name
                // (e.g. "Lasik", "surgery", "chashma hatana"), acknowledge it
                // warmly and ask for the name again — don't sound robotic.
                // Capture the stated intent so CORE_CONSULT doesn't re-ask.
                if (isHighIntentFirst(msgLow) && (session.repeat_count['NAME'] || 0) <= 2) {
                    session.data.stated_intent = msgLow;
                    session.state = 'CORE_CONSULT';
                    const kb = buildKnowledgeResponse(message, session);
                    setReply(kb || getGreetingReply(msgLow, lang));
                } else if ((session.repeat_count['NAME'] || 0) > 2) {
                    session.data.contactName = 'WhatsApp Lead'; session.state = 'CORE_CONSULT';
                    setReply({ EN: 'No problem 😊\nAre you exploring LASIK, specs removal, or just checking options right now?', HI: 'कोई बात नहीं 😊\nक्या आप LASIK, specs removal, या सिर्फ options देख रहे हैं?' }[lang]);
                } else {
                    setReply(t('INVALID_NAME', lang));
                }
            } else {
                if (message && message !== 'WhatsApp Lead' && (!session.data.contactName || session.data.contactName === 'WhatsApp Lead')) session.data.contactName = message;
                const fn = safeFirstName(session) || message.split(' ')[0];
                setReply({ EN: `Nice to meet you, ${fn} 😊\nAre you exploring LASIK, specs removal, or just checking options right now?`, HI: `आपसे मिलकर अच्छा लगा, ${fn} 😊\nक्या आप LASIK, specs removal, या सिर्फ options explore कर रहे हैं?` }[lang]);
                session.state = 'CORE_CONSULT';
            }
        }

        else if (state === 'CORE_CONSULT') {
            if (!session.data.powerStability && session.data.lastAskedField === 'POWER_STABILITY') {
                const stab = message.trim();
                if (stab.length >= 1 && stab.length <= 80) session.data.powerStability = stab;
            }

            // ─── SAFETY: Handle "no lens" clarification ───
            if (session.data._noLensStated && session.data.lastAskedField === 'EYE_POWER') {
                delete session.data._noLensStated;
                // User said "no lens" — ask specifically about glasses
                const clarify = { EN: 'Got it, no contact lenses! Do you wear glasses? If yes, what\'s the power? 😊', HI: 'समझ गया, contact lens नहीं! क्या आप glasses पहनते हैं? अगर हाँ, तो power क्या है? 😊' };
                setReply(clarify[lang] || clarify.EN);
                return finalizeWithIngest(phone, session, 'update', finalize, isTestChat);
            }

            if (shouldOfferCallback(session) && fieldCollected(session, 'INSURANCE')) {
                if (!session.data.callback_offered) session.data.callback_offered = true;
                session.data.request_call = true; session.state = 'COMPLETE'; session.data.human_handoff_started = true;
                const fn = safeFirstName(session);
                const ack = getAcknowledgement(message, lang);
                const cbMsg = getEscalationMessage('candidate', lang, fn);
                setReply(ack ? `${ack}\n\n${cbMsg}` : cbMsg);
                return finalizeWithIngest(phone, session, 'complete', finalize, isTestChat);
            }
            const next = getNextQuestion(session);
            if (next.field) {
                const ackCC = getAcknowledgement(message, lang);
                setReply(ackCC ? `${ackCC}\n\n${next.text}` : next.text);
            }
            else { session.data.request_call = true; if (!session.data.callback_offered) session.data.callback_offered = true; session.state = 'COMPLETE'; session.data.human_handoff_started = true; session.data.callback_source = 'completion'; setReply(getRandomCompleteReply(lang)); }
        }

        else if (state === 'COMPLETE') {
            const kb = buildKnowledgeResponse(message, session);
            if (kb) { setReply(kb); }
            else { if (!session.data.human_handoff_started) { session.data.request_call = true; session.data.human_handoff_started = true; } const ack = getAcknowledgement(message, lang); setReply(ack ? `${ack}\n\n${getRandomCompleteReply(lang)}` : getRandomCompleteReply(lang)); }
        }

        return finalizeWithIngest(phone, session, 'update', finalize, isTestChat);
    } catch (err) { console.error('[BOT ERROR]', err); setReply('Something went wrong. Please try again.'); finalize(); }
    finally { schedulePersist(); }
}

function finalizeWithIngest(phone, session, trigger, finalizeFn, isTestChat = false) {
    session._lastTrigger = trigger;
    if (trigger !== 'agent') {
        const detail = session._lastAgentFail || trigger;
        setChannelMode('whatsapp', 'rule-based', detail);
    }
    const runIngest = async () => {
        try {
            await sendToAPI(phone, session, trigger);
            if (!isLabPhone(phone) && isAgentEnabled() && trigger !== 'agent') {
                supabaseAdmin.from('lead_events').insert({
                    phone, ts: new Date().toISOString(),
                    event_type: 'agent_fallback',
                    source: 'agent',
                    payload: { trigger, message: (session.data?.lastMessage || '').slice(0, 200) },
                }).then(() => {}, () => {});
            }
        } catch (e) {
            console.error('[ASYNC_INGEST_ERROR]', e);
            session._lastIngestError = e.message;
        }
    };
    if (isLabPhone(phone)) {
        return runIngest().then(() => finalizeFn(isTestChat));
    }
    setImmediate(() => { runIngest(); });
    return finalizeFn(isTestChat);
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/chat', async (req, res) => {
    try {
        const reply = await handleIncomingMessage(req.body, true);
        const phone = req.body?.phone;
        const sess = phone ? botSessions[phone] : null;
        res.json({
            reply,
            trigger: sess?._lastTrigger || null,
            agent_fail: sess?._lastAgentFail || null,
            model: sess?._lastAgentModel || getLastAgentModel(),
            agent_chain: sess?._lastAgentChain || [],
        });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

registerBotLabRoutes(app, {
    requireCrmKey,
    handleIncomingMessage,
    getBotSessions: () => botSessions,
    schedulePersist,
    supabaseAdmin,
    sendToAPI,
});

registerOperatorRoutes(app, {
    requireCrmKey,
    supabaseAdmin,
    getAllowedTabsForUser,
    fanout,
    isPushConfigured,
    upload,
});

// ─── WhatsApp Inbox: send a message from the dashboard ───────────────────────
app.post('/api/whatsapp/send', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'inbox' }))) return;
    const { phone, message } = req.body || {};
    if (!phone || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'phone and message are required' });
    }
    try {
        // sendWhatsAppReply already captures the outbound message into whatsapp_messages
        await sendWhatsAppReply(phone, String(message).trim());
        res.json({ success: true });
    } catch (e) {
        console.error('[WA SEND API] ❌', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── WhatsApp Inbox: send IMAGE / AUDIO / VIDEO / DOCUMENT from the dashboard ──
// Multipart form fields: `file` (the media), `phone`, optional `caption`, optional `type` override.
// Type is auto-detected from the file's MIME if not provided. Auto-captured into whatsapp_messages.
app.post('/api/whatsapp/send-media', upload.single('file'), async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'inbox' }))) return;
    const { phone, caption, type: typeOverride } = req.body || {};
    const file = req.file;
    if (!phone || !file || !file.buffer) {
        return res.status(400).json({ error: 'phone and file are required (multipart)' });
    }
    // Detect WhatsApp type from MIME (caller may override via the type field).
    const mime = file.mimetype || 'application/octet-stream';
    const waType = typeOverride || (
        mime.startsWith('image/')    ? 'image' :
        mime.startsWith('audio/')    ? 'audio' :
        mime.startsWith('video/')    ? 'video' :
        'document'
    );
    // Meta is strict on audio MIME — accept ogg/opus, aac, amr, mp3, mp4 audio.
    // Browser MediaRecorder usually produces audio/webm;codecs=opus — relabel to audio/ogg
    // so Meta accepts it (the Opus payload is identical inside both containers in practice).
    const sendMime = (waType === 'audio' && /webm/i.test(mime)) ? 'audio/ogg' : mime;

    try {
        // ─── STEP 1: upload the bytes to Meta → get a media_id ───
        const uploadUrl = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/media`;
        const uploadForm = new FormData();
        uploadForm.append('messaging_product', 'whatsapp');
        uploadForm.append('type', sendMime);
        uploadForm.append('file', new Blob([file.buffer], { type: sendMime }), file.originalname || `upload.${waType}`);
        const upRes = await globalThis.fetch(uploadUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
            body: uploadForm
        });
        const upJson = await upRes.json();
        if (!upJson.id) {
            console.error('[WA SEND-MEDIA] ❌ upload failed:', JSON.stringify(upJson).substring(0, 300));
            return res.status(500).json({ error: 'Media upload to Meta failed', detail: upJson });
        }
        const mediaId = upJson.id;

        // ─── STEP 2: send the message referencing media_id ───
        const sendBody = {
            messaging_product: 'whatsapp',
            to: phone,
            type: waType,
            [waType]: caption && String(caption).trim()
                ? { id: mediaId, caption: String(caption).trim() }
                : { id: mediaId }
        };
        // documents need a filename so the recipient sees a sensible name
        if (waType === 'document') sendBody.document.filename = file.originalname || 'document';
        const sendUrl = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
        const sendRes = await globalThis.fetch(sendUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(sendBody)
        });
        const sendJson = await sendRes.json();
        const sentId = sendJson?.messages?.[0]?.id || null;
        if (!sentId) {
            console.error('[WA SEND-MEDIA] ❌ send failed:', JSON.stringify(sendJson).substring(0, 300));
            return res.status(500).json({ error: 'Message send failed', detail: sendJson });
        }
        console.log(`[WA SEND-MEDIA] ✅ ${waType} sent: media_id=${mediaId}, wa_message_id=${sentId}`);

        // ─── STEP 3: capture the outbound media message into whatsapp_messages ───
        saveWhatsAppMessage({
            phone,
            direction: 'outbound',
            body: caption && String(caption).trim() ? String(caption).trim() : null,
            msgType: waType,
            mediaId,
            waMessageId: sentId,
            waTimestamp: new Date().toISOString()
        }).catch(e => console.error('[WA CAPTURE] outbound media', e.message));

        res.json({ success: true, wa_message_id: sentId, media_id: mediaId, type: waType });
    } catch (e) {
        console.error('[WA SEND-MEDIA] ❌', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── WhatsApp Inbox: proxy media (image/audio/video/doc) from the Cloud API ──
// Cloud API media URLs are short-lived and require the auth token, so an <img>
// tag can't load them directly — the dashboard points at this proxy instead.
app.get('/api/whatsapp/media/:mediaId', async (req, res) => {
    const { mediaId } = req.params;
    if (!mediaId) return res.status(400).send('media id required');
    try {
        // Only proxy media ids we actually captured (guards against arbitrary fetches)
        const { data: known } = await supabaseAdmin
            .from('whatsapp_messages')
            .select('id')
            .eq('media_id', mediaId)
            .limit(1)
            .maybeSingle();
        if (!known) return res.status(404).send('Unknown media');

        // Step 1: resolve the short-lived media URL
        const metaRes = await globalThis.fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
        });
        const meta = await metaRes.json();
        if (!meta || !meta.url) return res.status(404).send('Media URL unavailable');

        // Step 2: download the bytes (auth header required)
        const binRes = await globalThis.fetch(meta.url, {
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
        });
        const buf = Buffer.from(await binRes.arrayBuffer());
        res.set('Content-Type', meta.mime_type || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (e) {
        console.error('[WA MEDIA] ❌', e.message);
        res.status(500).send('Media fetch failed');
    }
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('[WEBHOOK] ✅ Verified'); return res.status(200).send(challenge); }
    console.warn('[WEBHOOK] ❌ Verification failed');
    return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const body = req.body || {};
        const objectType = body.object;  // 'whatsapp_business_account' | 'page'

        // ─── Meta Page leadgen events (Phase C-2) ─────────────────────────────
        if (objectType === 'page') {
            const entries = body.entry || [];
            for (const entry of entries) {
                const changes = entry.changes || [];
                for (const change of changes) {
                    if (change.field === 'leadgen') {
                        try {
                            const { processLeadgenChange } = await import('./meta-marketing.js');
                            const r = await processLeadgenChange(change);
                            console.log(`[WEBHOOK] ✅ Leadgen ${r.metaLeadId} processed${r.linked ? ` → linked to ${r.linked.source}` : ''}`);
                        } catch (e) {
                            console.error('[WEBHOOK] ❌ Leadgen process failed:', e.message);
                        }
                    } else {
                        console.log(`[WEBHOOK] Page change field='${change.field}' — ignored`);
                    }
                }
            }
            return;
        }

        // ─── WhatsApp Cloud (existing) ────────────────────────────────────────
        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) { console.log('[WEBHOOK] No message — status update, skipping.'); return; }
        console.log('[WEBHOOK] 📩 phone:', message.from, '| text:', message.text?.body, '| msgId:', message.id);
        await handleIncomingMessage(req.body, false);
    } catch (err) { console.error('[WEBHOOK] ❌ Unhandled error:', err.message); }
});


// ─── Refrens Sync Routes ──────────────────────────────────────────────────────
app.post('/api/sync-refrens', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'analytics' }))) return;
    try {
        const result = await syncRefrensLeads(supabaseAdmin);
        res.json(result);
    } catch (err) {
        console.error('[SYNC-REFRENS ROUTE]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/refrens-analytics', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'analytics' }))) return;
    try {
        // Paginate to fetch all leads (Supabase default cap is 1000/page)
        let allData = [];
        let from = 0;
        const pageSize = 1000;
        while (true) {
            const { data, error } = await supabaseAdmin
                .from('refrens_leads')
                .select('id, phone, contact_name, status, assignee, lead_source, customer_city, refrens_created_at, intent_band, call_outcome, consultation_status, objection_type, follow_up_date, labels, state, timeline, insurance, eye_power, age, reason_for_lasik, parameters_completed, last_user_message, lead_type, city_preference, lead_description, last_comment_by, synced_at, date_closed, next_activity, last_internal_note, first_response_time, whatsapp_link, duplicate, intent_score')
                .order('refrens_created_at', { ascending: false })
                .range(from, from + pageSize - 1);
            if (error) throw new Error(error.message);
            if (!data || data.length === 0) break;
            allData = allData.concat(data);
            if (data.length < pageSize) break;
            from += pageSize;
        }
        res.json({ success: true, count: allData.length, leads: allData });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/sync-status', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'analytics' }))) return;
    try {
        const { count, error: countErr } = await supabaseAdmin
            .from('refrens_leads')
            .select('*', { count: 'exact', head: true });
        if (countErr) throw new Error(countErr.message);

        const { data: lastSync, error: syncErr } = await supabaseAdmin
            .from('refrens_leads')
            .select('synced_at')
            .order('synced_at', { ascending: false })
            .limit(1)
            .single();

        res.json({
            success: true,
            refrens_leads_count: count,
            last_synced_at: lastSync?.synced_at || null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ─── Meta Ads (Marketing API) ────────────────────────────────────────────────
// Credentials live in Railway env vars (META_ACCESS_TOKEN + META_AD_ACCOUNT_ID).
// The token is never written to the database and never returned to the browser.
// All three endpoints are gated on the same CRM API key the dashboard uses for
// other privileged calls (x-crm-key header).
import {
    getStatus as metaGetStatus,
    runSync as metaRunSync,
    listCampaignsWithTotals as metaListCampaigns,
    getCampaignDetail as metaCampaignDetail,
    getCampaignLeads as metaCampaignLeads,
    getCampaignAds as metaCampaignAds,
    getCampaignAudience as metaCampaignAudience,
    backfillLeadLinks as metaBackfillLinks,
    importHistoricalLeads as metaImportHistoricalLeads,
    importAllCampaignLeads as metaImportAllCampaignLeads,
    computeRecommendations as metaComputeRecommendations,
    recordSyncError as metaRecordSyncError,
    bustVerificationCache as metaBustCache,
    getAllCampaignLeadsExport as metaGetAllLeadsExport,
} from './meta-marketing.js';


// GET /api/meta/status — connection status, account name, last sync time
app.get('/api/meta/status', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        // Allow ?refresh=1 to bust the in-memory verification cache (e.g. after the user changes env vars)
        if (req.query.refresh === '1') metaBustCache();
        const status = await metaGetStatus();
        return res.json({ success: true, ...status });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/meta/sync — pull campaigns + last-30d insights now
// Optional body: { since: 'YYYY-MM-DD', until: 'YYYY-MM-DD' }
app.post('/api/meta/sync', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const { since, until } = req.body || {};
        const result = await metaRunSync({ since, until });
        console.log(`[META] ✅ Manual sync done — ${result.campaignsCount} campaigns, ${result.insightsCount} insight rows`);
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('[META] ❌ Sync failed:', err.message);
        metaRecordSyncError(err.message);
        return res.status(500).json({ success: false, error: err.message, reason: err.reason });
    }
});

// GET /api/meta/campaigns — list campaigns + their last-30d totals + CPL
app.get('/api/meta/campaigns', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const campaigns = await metaListCampaigns();
        return res.json({ success: true, campaigns });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/meta/campaign/:id — full drill-down for one campaign
//   ↳ metadata + 30d totals + 7d totals + 7d-vs-prior-7d deltas + daily breakdown
app.get('/api/meta/campaign/:id', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const detail = await metaCampaignDetail(req.params.id);
        return res.json({ success: true, ...detail });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({ success: false, error: err.message });
    }
});

// GET /api/meta/campaign/:id/leads — leads attributed to this campaign + funnel
app.get('/api/meta/campaign/:id/leads', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const result = await metaCampaignLeads(req.params.id);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/meta/backfill-links — re-run lead linker for unmatched meta_leads
// Useful after a Refrens sync brings in leads that came before we had attribution.
app.post('/api/meta/backfill-links', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const result = await metaBackfillLinks();
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/meta/import-leads-all — bulk import for every synced campaign at once.
// Body (optional): { since: 'YYYY-MM-DD' }
// Returns per-campaign results sorted by leads imported, plus aggregate totals.
app.post('/api/meta/import-leads-all', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const { since } = req.body || {};
        console.log(`[META] Bulk historical import requested — since=${since || 'all time'}`);
        const result = await metaImportAllCampaignLeads({ since });
        console.log(`[META] Bulk import done: ${result.imported} leads, ${result.linked} matched, ${result.campaigns} campaigns in ${result.elapsedMs}ms`);
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('[META] Bulk historical import failed:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/meta/campaign/:id/recommendations — actionable suggestions for one campaign
app.get('/api/meta/campaign/:id/recommendations', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const [detail, leads] = await Promise.all([
            metaCampaignDetail(req.params.id),
            metaCampaignLeads(req.params.id)
        ]);
        const recs = metaComputeRecommendations({
            kpis30: detail.kpis30,
            kpis7: detail.kpis7,
            wow: detail.wow,
            breakdowns: leads.breakdowns,
            funnel: leads.funnel,
            accountBenchmark: leads.accountBenchmark,
            campaign: detail.campaign
        });
        return res.json({ success: true, recommendations: recs });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({ success: false, error: err.message });
    }
});

// POST /api/meta/import-leads — retroactively pull historical Lead Ad submissions
// from the Meta Graph API and store them in meta_leads.
// Body (all optional):
//   campaignId  — restrict to one campaign (omit for account-wide)
//   since       — ISO date string to filter leads after this date
// This doesn't need the Page webhook — it reads directly from the Lead Ads API.
app.post('/api/meta/import-leads', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const { campaignId, since } = req.body || {};
        console.log(`[META] Historical lead import requested — campaignId=${campaignId || 'all'}, since=${since || 'all time'}`);
        const result = await metaImportHistoricalLeads({ campaignId, since });
        console.log(`[META] Import result: ${result.imported} leads, ${result.linked} matched, ${result.forms} forms`);
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('[META] Historical import failed:', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/meta/campaign/:id/ads — per-ad performance breakdown (live Graph API)
app.get('/api/meta/campaign/:id/ads', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const result = await metaCampaignAds(req.params.id);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message, fbCode: err.fbCode });
    }
});

// GET /api/meta/campaign/:id/audience — age/gender/region/placement breakdowns
app.get('/api/meta/campaign/:id/audience', async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'marketing' }))) return;
    try {
        const result = await metaCampaignAudience(req.params.id);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message, fbCode: err.fbCode });
    }
});


// GET /api/meta/leads/export — all meta leads across all campaigns (enriched), for Excel download
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional)
app.get('/api/meta/leads/export', async (req, res) => {
    if (!(await requireCrmKey(req, res, { permission: 'export_leads' }))) return;
    try {
        const { from, to } = req.query;
        const result = await metaGetAllLeadsExport({ from, to });
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Dashboard User Management ────────────────────────────────────────────────
// Users are stored in dashboard_users Supabase table. The built-in admin (from
// VITE_ADMIN_USERNAME/VITE_ADMIN_PASSWORD env vars) always has role 'admin' and
// cannot be managed through this API.

function hashPassword(password) {
    return crypto.createHash('sha256')
        .update(`rc_user:${password}:relive_cure`)
        .digest('hex');
}

// dashboard_users table created via migrations/create_dashboard_users.sql

app.get('/api/admin/users', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    try {
        const { data, error } = await supabaseAdmin
            .from('dashboard_users')
            .select('id, username, role, designation, allowed_tabs, created_at')
            .order('created_at', { ascending: true });
        if (error) return res.status(500).json({ success: false, error: error.message });
        const users = (data || []).map(u => ({
            ...u,
            allowed_tabs: normalizeTabs(u.allowed_tabs, u.role),
        }));
        return res.json({ success: true, users });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/users', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const { username, password, role, designation, allowed_tabs } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'username and password required' });
    const validRoles = ['admin', 'limited', 'hr', 'rep'];
    const safeRole = validRoles.includes(role) ? role : 'limited';
    const safeTabs = normalizeTabs(allowed_tabs, safeRole);
    const safeDesignation = typeof designation === 'string' && designation.trim() ? designation.trim() : null;
    const reserved = (process.env.VITE_ADMIN_USERNAME || 'admin').toLowerCase();
    if (username.toLowerCase() === reserved) return res.status(400).json({ success: false, error: 'Cannot create user with reserved admin username' });
    try {
        const { data, error } = await supabaseAdmin
            .from('dashboard_users')
            .insert({
                username,
                password_hash: hashPassword(password),
                role: safeRole,
                designation: safeDesignation,
                allowed_tabs: safeTabs,
            })
            .select('id, username, role, designation, allowed_tabs, created_at')
            .single();
        if (error) return res.status(400).json({ success: false, error: error.message });
        return res.json({ success: true, user: { ...data, allowed_tabs: normalizeTabs(data.allowed_tabs, data.role) } });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.patch('/api/admin/users/:username', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const { username } = req.params;
    const { designation, role, allowed_tabs, password } = req.body || {};
    const reserved = (process.env.VITE_ADMIN_USERNAME || 'admin').toLowerCase();
    if (username.toLowerCase() === reserved) return res.status(400).json({ success: false, error: 'Cannot edit the built-in admin' });
    const validRoles = ['admin', 'limited', 'hr', 'rep'];
    const patch = {};
    if (role !== undefined) patch.role = validRoles.includes(role) ? role : 'limited';
    if (designation !== undefined) {
        patch.designation = typeof designation === 'string' && designation.trim() ? designation.trim() : null;
    }
    if (allowed_tabs !== undefined) {
        patch.allowed_tabs = normalizeTabs(allowed_tabs, patch.role || role || 'limited');
    }
    if (password) patch.password_hash = hashPassword(password);
    if (Object.keys(patch).length === 0) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
    }
    try {
        const { data, error } = await supabaseAdmin
            .from('dashboard_users')
            .update(patch)
            .eq('username', username)
            .select('id, username, role, designation, allowed_tabs, created_at')
            .maybeSingle();
        if (error) return res.status(400).json({ success: false, error: error.message });
        if (!data) return res.status(404).json({ success: false, error: 'User not found' });
        return res.json({ success: true, user: { ...data, allowed_tabs: normalizeTabs(data.allowed_tabs, data.role) } });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Tab access requests ─────────────────────────────────────────────────────

app.get('/api/auth/tab-requests', async (req, res) => {
    if (!(await requireCrmKey(req, res))) return;
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ success: false, error: 'username required' });
    try {
        const { data, error } = await supabaseAdmin
            .from('dashboard_tab_requests')
            .select('id, username, tab, status, created_at, reviewed_at')
            .eq('username', username)
            .order('created_at', { ascending: false });
        if (error) return res.status(500).json({ success: false, error: error.message });
        return res.json({ success: true, requests: data || [] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/auth/tab-requests', async (req, res) => {
    if (!(await requireCrmKey(req, res))) return;
    const username = String(req.body?.username || '').trim();
    const tab = String(req.body?.tab || '').trim();
    if (!username || !tab) return res.status(400).json({ success: false, error: 'username and tab required' });
    if (!VALID_TABS.includes(tab)) return res.status(400).json({ success: false, error: 'invalid tab' });
    const reserved = (process.env.VITE_ADMIN_USERNAME || 'admin').toLowerCase();
    if (username.toLowerCase() === reserved) {
        return res.status(400).json({ success: false, error: 'Admin already has full access' });
    }
    try {
        const { data: user } = await supabaseAdmin
            .from('dashboard_users')
            .select('allowed_tabs, role')
            .eq('username', username)
            .maybeSingle();
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        const tabs = normalizeTabs(user.allowed_tabs, user.role || 'limited');
        if (tabs.includes(tab)) return res.status(400).json({ success: false, error: 'Already has access' });

        const { data: pending } = await supabaseAdmin
            .from('dashboard_tab_requests')
            .select('id')
            .eq('username', username)
            .eq('tab', tab)
            .eq('status', 'pending')
            .maybeSingle();
        if (pending) return res.json({ success: true, request: pending, message: 'Request already pending' });

        const { data, error } = await supabaseAdmin
            .from('dashboard_tab_requests')
            .insert({ username, tab, status: 'pending' })
            .select('id, username, tab, status, created_at')
            .single();
        if (error) return res.status(400).json({ success: false, error: error.message });
        return res.json({ success: true, request: data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/tab-requests', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const status = String(req.query.status || 'pending').trim();
    try {
        let q = supabaseAdmin
            .from('dashboard_tab_requests')
            .select('id, username, tab, status, created_at, reviewed_at, reviewed_by')
            .order('created_at', { ascending: true });
        if (status !== 'all') q = q.eq('status', status);
        const { data, error } = await q;
        if (error) return res.status(500).json({ success: false, error: error.message });
        return res.json({ success: true, requests: data || [] });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/tab-requests/:id/approve', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const { id } = req.params;
    const reviewedBy = String(req.body?.reviewed_by || 'admin').trim();
    try {
        const { data: reqRow, error: fetchErr } = await supabaseAdmin
            .from('dashboard_tab_requests')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (fetchErr) return res.status(500).json({ success: false, error: fetchErr.message });
        if (!reqRow || reqRow.status !== 'pending') return res.status(404).json({ success: false, error: 'Pending request not found' });

        const { data: user } = await supabaseAdmin
            .from('dashboard_users')
            .select('allowed_tabs, role')
            .eq('username', reqRow.username)
            .maybeSingle();
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const tabs = normalizeTabs(user.allowed_tabs, user.role || 'limited');
        if (!tabs.includes(reqRow.tab)) tabs.push(reqRow.tab);

        const { error: userErr } = await supabaseAdmin
            .from('dashboard_users')
            .update({ allowed_tabs: tabs })
            .eq('username', reqRow.username);
        if (userErr) return res.status(500).json({ success: false, error: userErr.message });

        const { data, error } = await supabaseAdmin
            .from('dashboard_tab_requests')
            .update({ status: 'approved', reviewed_at: new Date().toISOString(), reviewed_by: reviewedBy })
            .eq('id', id)
            .select('id, username, tab, status, reviewed_at')
            .single();
        if (error) return res.status(500).json({ success: false, error: error.message });
        return res.json({ success: true, request: data, allowed_tabs: tabs });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/tab-requests/:id/deny', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const { id } = req.params;
    const reviewedBy = String(req.body?.reviewed_by || 'admin').trim();
    try {
        const { data, error } = await supabaseAdmin
            .from('dashboard_tab_requests')
            .update({ status: 'denied', reviewed_at: new Date().toISOString(), reviewed_by: reviewedBy })
            .eq('id', id)
            .eq('status', 'pending')
            .select('id, username, tab, status, reviewed_at')
            .maybeSingle();
        if (error) return res.status(500).json({ success: false, error: error.message });
        if (!data) return res.status(404).json({ success: false, error: 'Pending request not found' });
        return res.json({ success: true, request: data });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/admin/users/:username', async (req, res) => {
    if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
    const { username } = req.params;
    const reserved = (process.env.VITE_ADMIN_USERNAME || 'admin').toLowerCase();
    if (username.toLowerCase() === reserved) return res.status(400).json({ success: false, error: 'Cannot delete the built-in admin' });
    try {
        const { error } = await supabaseAdmin
            .from('dashboard_users')
            .delete()
            .eq('username', username);
        if (error) return res.status(500).json({ success: false, error: error.message });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ─── CSV Upload Sync ─────────────────────────────────────────────────────────
app.post('/api/upload-refrens-csv', express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
    if (!(await requireCrmKey(req, res, { tab: 'analytics' }))) return;
    try {
        const { parse } = await import('csv-parse/sync');
        const rows = parse(req.body.replace(/^\uFEFF/, ''), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });

        function normPhone(raw) {
            if (!raw) return null;
            const d = raw.replace(/[^\d]/g, '');
            if (d.length < 7) return null;
            if (d.startsWith('91') && d.length === 12) return d.slice(2);
            return d;
        }
        function gf(row, ...keys) {
            for (const k of keys) { const v = (row[k]||'').trim(); if (v && !['-','false','true','..'].includes(v)) return v; }
            return null;
        }
        function pd(s) {
            if (!s || ['-',''].includes(s.trim())) return null;
            try { return new Date(s).toISOString(); } catch { return null; }
        }

        const seen = {};
        for (const row of rows) {
            const phone = normPhone(row['Phone']||'') || normPhone(row['phone_number']||'');
            if (!phone) continue;
            seen[phone] = {
                id: phone, phone, contact_name: gf(row,'Contact Name'),
                customer_city: gf(row,'Customer City'), state: gf(row,'State'),
                refrens_created_at: pd(row['Created At']), status: gf(row,'Status'),
                lead_source: gf(row,'Lead Source'), assignee: gf(row,'Assignee'),
                follow_up_date: pd(row['Follow up date']), last_comment_by: gf(row,'Last comment by'),
                first_response_time: gf(row,'First Response Time'), last_internal_note: gf(row,'Last Internal Note'),
                next_activity: pd(row['Next Activity']), date_closed: pd(row['Date Closed']),
                whatsapp_link: gf(row,'Whatsapp Link'), lead_description: gf(row,'Lead Description'),
                labels: gf(row,'Labels'), duplicate: gf(row,'Duplicate'),
                call_outcome: gf(row,'Call Outcome'), consultation_status: gf(row,'Consultation Status'),
                lead_state: gf(row,'Lead State'), intent_band: gf(row,'Intent Band'),
                intent_score: gf(row,'Intent Score'), objection_type: gf(row,'Objection Type'),
                eye_power: gf(row,"what_is_your_current_eye_power?","what\'s_your_eye_power?"),
                insurance: gf(row,"do_you_have_medical_insurance_","do_you_have_medical_insurance?","do_you_have_health_insurance_","do_you_have_insurance?"),
                timeline: gf(row,"when_would_you_prefer_to_undergo_the_lasik_treatment?","when_are_you_planning_for_lasik?","when_are_you_looking_to_get_lasik_consultation?"),
                city_preference: gf(row,"kindly_choose_the_city_where_you_wish_to_avail_the_treatment","which_city_would_you_prefer_for_treatment_"),
                last_user_message: gf(row,'last_user_message'), lead_type: gf(row,'lead_type'),
                parameters_completed: gf(row,'parameters_completed'),
                reason_for_lasik: gf(row,"what_is_the_main_reason_you\'re_considering_lasik_surgery?"),
                age: gf(row,"what\'s_your_age?"), synced_at: new Date().toISOString()
            };
        }

        const mapped = Object.values(seen);
        let upserted = 0;
        for (let i = 0; i < mapped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(mapped.slice(i, i+100), { onConflict: 'id' });
            if (!error) upserted += Math.min(100, mapped.length - i);
            else console.error('[CSV UPLOAD] Batch error:', error.message);
        }
        console.log(`[CSV UPLOAD] ✅ ${upserted}/${mapped.length} upserted from uploaded CSV`);
        res.json({ success: true, total_rows: rows.length, valid_rows: mapped.length, upserted, synced_at: new Date().toISOString() });
    } catch (err) {
        console.error('[CSV UPLOAD] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Keep-alive ───────────────────────────────────────────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health` : null;
if (SELF_URL) {
    setInterval(async () => { try { const r = await globalThis.fetch(SELF_URL); console.log(`[KEEPALIVE] → ${r.status}`); } catch (e) { console.warn('[KEEPALIVE] Ping failed:', e.message); } }, 4 * 60 * 1000);
    console.log(`[KEEPALIVE] Enabled → ${SELF_URL}`);
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[API] ✅ Server running on port ${PORT}`);
    console.log('[BOT] ✅ v6.2-stable embedded — no HTTP overhead');

    // ─── Agent quota hydrate (read today's count from Supabase) ────────────────
    hydrateQuota().catch(e => console.warn('[BOOT] quota hydrate failed:', e.message));

    // ─── Refrens auto-sync scheduler ─────────────────────────────────────────
    async function runRefrensSync() {
        console.log('[SCHEDULER] 🔄 Auto-sync Refrens leads...');
        try {
            const result = await syncRefrensLeads(supabaseAdmin);
            console.log('[SCHEDULER] Refrens sync result:', JSON.stringify(result));
        } catch (err) {
            console.error('[SCHEDULER] Refrens sync failed:', err.message);
        }
    }
    // First run: 3 minutes after boot (let server fully warm up)
    setTimeout(runRefrensSync, 3 * 60 * 1000);
    // Then every 4 hours
    setInterval(runRefrensSync, 4 * 60 * 60 * 1000);
    console.log('[SCHEDULER] Refrens sync: first run in 3 min, then every 4h');

    // ─── Meta Ads auto-sync scheduler ────────────────────────────────────────
    async function runMetaSync() {
        try {
            const status = await metaGetStatus();
            if (!status.connected) {
                // Quietly skip — either env vars are missing or verification failed.
                // The dashboard surfaces the reason; no point spamming logs every hour.
                return;
            }
            console.log('[SCHEDULER] 🔄 Auto-sync Meta Ads...');
            const result = await metaRunSync({});
            console.log(`[SCHEDULER] Meta sync ok — ${result.campaignsCount} campaigns, ${result.insightsCount} insight rows`);
        } catch (err) {
            console.error('[SCHEDULER] Meta sync failed:', err.message);
            metaRecordSyncError(err.message);
        }
    }
    // Time-aware scheduler: hourly 6am-11pm IST, 4-hourly 11pm-6am IST
    function scheduleNextMetaSync() {
        const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
        const hourIST = nowIST.getUTCHours(); // hours in IST (since we added offset)
        const isDaytime = hourIST >= 6 && hourIST < 23;
        const delay = isDaytime ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
        setTimeout(async () => { await runMetaSync(); scheduleNextMetaSync(); }, delay);
    }
    // First run: 5 minutes after boot.
    setTimeout(() => { runMetaSync(); scheduleNextMetaSync(); }, 5 * 60 * 1000);
    console.log('[SCHEDULER] Meta sync: first run in 5 min, then 1h daytime / 4h night (IST)');

    // ─── Sanity-check scheduler (daily) ──────────────────────────────────────
    setTimeout(() => runSanityCheck().catch(e => console.error('[SANITY] daily run failed:', e.message)), 10 * 60 * 1000);
    setInterval(() => runSanityCheck().catch(e => console.error('[SANITY] daily run failed:', e.message)), 24 * 60 * 60 * 1000);
    console.log('[SCHEDULER] Sanity check: first run in 10 min, then every 24h');

    // ─── Auto-push worker — hands-free CRM push for quiet, qualified leads ────
    // Gate (founder's spec): a new lead is auto-pushed once it has given ≥2
    // details AND has gone quiet for ≥2.5 min (abandoned the chat mid-way).
    // Reuses the existing push pipeline (processQueue) and the per-lead
    // `assignee` field the CRM automation already honours. No-ops unless the
    // founder has enabled it from the dashboard.
    let autoPushRunning = false;
    function pickAutoPushRep(cfg) {
      if (!cfg.rep_b) return cfg.rep_a;
      return (Math.random() * 100 < (cfg.split_a_pct || 50)) ? cfg.rep_a : cfg.rep_b;
    }
    async function runAutoPush() {
      if (autoPushRunning) return;
      const cfg = await readAutoPushConfig();
      if (!cfg || !cfg.enabled || !cfg.rep_a) return;
      autoPushRunning = true;
      try {
        const quietCutoff = new Date(Date.now() - 150 * 1000).toISOString().replace('T', ' ').replace('Z', '');
        let q = supabaseAdmin.from('leads_surgery')
          .select('*')
          .eq('pushed_to_crm', false)
          .gte('parameters_completed', 2)
          .lt('last_activity_at', quietCutoff)
          .order('last_activity_at', { ascending: true })
          .limit(10);
        if (cfg.enabled_at) q = q.gte('created_at', cfg.enabled_at);
        const { data: leads, error } = await q;
        if (error) { console.warn('[AUTO-PUSH] fetch failed:', error.message); return; }
        if (!leads || leads.length === 0) return;
        const batch = leads.map(l => ({ ...l, assignee: pickAutoPushRep(cfg) }));
        console.log(`[AUTO-PUSH] pushing ${batch.length} quiet+qualified lead(s)…`);
        const results = await processQueue(batch);
        for (const r of results.filter(x => x.success)) {
          const patch = { pushed_to_crm: true, status: 'PUSHED_TO_CRM' };
          if (r.refrens_url) patch.refrens_lead_url = r.refrens_url;
          if (r.refrens_id) patch.refrens_lead_id = r.refrens_id;
          const orig = batch.find(l => l.id === r.id);
          if (orig?.assignee && String(orig.assignee).trim().length >= 2) patch.assignee = String(orig.assignee).trim();
          try { await supabaseAdmin.from('leads_surgery').update(patch).eq('id', r.id); } catch { /* best-effort */ }
        }
        console.log(`[AUTO-PUSH] done — ${results.filter(x => x.success).length}/${results.length} pushed`);
      } catch (e) {
        console.error('[AUTO-PUSH] worker error:', e.message);
      } finally {
        autoPushRunning = false;
      }
    }
    setTimeout(runAutoPush, 90 * 1000);
    setInterval(runAutoPush, 60 * 1000);
    console.log('[SCHEDULER] Auto-push worker: first run in 90s, then every 60s (gated by config)');

    // ─── Push fanout (Phase M3 + extended): new leads + inbound messages ────
    // Two watchers, same fanout helper. The notification payload always
    // carries a `url` so the SW knows where to navigate on click; the URL
    // works for both /m (mobile companion) and / (desktop dashboard).
    supabaseAdmin
      .channel('m-lead-push')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads_surgery' }, async (payload) => {
        const lead = payload.new;
        if (!lead) return;
        try {
          const intent = (lead.intent_level || '').toUpperCase();
          await fanout(supabaseAdmin, {
            title: intent === 'HOT' ? '🔥 HOT lead just landed!' : 'New lead',
            body: `${lead.contact_name || lead.phone_number}${lead.city ? ' · ' + lead.city : ''}`,
            lead_id: lead.id,
            intent,
            phone: lead.phone_number,
            url: `/m?lead=${lead.id}`,
            kind: 'lead',
          });
        } catch (e) {
          console.warn('[PUSH] lead fanout failed:', e.message);
        }
      })
      .subscribe();

    supabaseAdmin
      .channel('m-msg-push')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' }, async (payload) => {
        const msg = payload.new;
        // Only notify on inbound (skip outbound — that's the user's own send)
        if (!msg || msg.direction !== 'inbound') return;
        try {
          // Look up the conversation row for the name (best-effort)
          const { data: conv } = await supabaseAdmin
            .from('whatsapp_conversations')
            .select('contact_name')
            .eq('phone', msg.phone)
            .maybeSingle();
          const who = conv?.contact_name || msg.phone;
          const text = (msg.text_body || msg.body || msg.caption || '').slice(0, 80) || '[media]';
          await fanout(supabaseAdmin, {
            title: `💬 ${who}`,
            body: text,
            phone: msg.phone,
            url: `/m?phone=${encodeURIComponent(msg.phone)}`,
            kind: 'message',
          });
        } catch (e) {
          console.warn('[PUSH] message fanout failed:', e.message);
        }
      })
      .subscribe();

    supabaseAdmin
      .channel('m-signal-push')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lead_signals' }, async (payload) => {
        const sig = payload.new;
        if (!sig) return;
        try {
          const SIGNAL_TITLES = {
            request_call_raised: '📞 Lead requested a callback!',
            intent_hot:          '🔥 Lead just went HOT!',
            intent_level_up:     '📈 Lead intent upgraded',
            score_jump:          '⬆️ Lead score jumped',
            concern_new:         '⚠️ New concern flagged',
          };
          const title = SIGNAL_TITLES[sig.signal_type] || '📊 Lead signal';
          const detail = sig.old_value && sig.new_value ? ` · ${sig.old_value} → ${sig.new_value}` : '';
          await fanout(supabaseAdmin, {
            title,
            body: `${sig.phone}${detail}`,
            phone: sig.phone,
            url: `/m?phone=${encodeURIComponent(sig.phone)}`,
            kind: 'signal',
          });
        } catch (e) {
          console.warn('[PUSH] signal fanout failed:', e.message);
        }
      })
      .subscribe();

    console.log('[PUSH] fanout active — INSERT on leads_surgery + whatsapp_messages + lead_signals');
});
