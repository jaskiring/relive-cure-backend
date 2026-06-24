#!/usr/bin/env node
/** E2E: migration check, login, operator chat, quota delta. */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../../relive-cure-agents/.env');

function loadEnv() {
    const out = {};
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}

const env = loadEnv();
const BACKEND = env.BACKEND_URL || 'https://relive-cure-backend-production.up.railway.app';

function issueSession(username, role, crmApiKey) {
    const body = Buffer.from(JSON.stringify({
        u: username,
        r: role || 'limited',
        e: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })).toString('base64url');
    const sig = createHmac('sha256', crmApiKey).update(body).digest('base64url');
    return `${body}.${sig}`;
}

async function main() {
    const report = { steps: [] };

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const { error: inboxErr } = await supabase.from('operator_inbox').select('id').limit(1);
    report.inbox_table = inboxErr ? { ok: false, error: inboxErr.message } : { ok: true };

    const { data: quotaRow } = await supabase
        .from('agent_quota')
        .select('date, request_count, operator_request_count, transcribe_request_count, tokens_total, operator_tokens_total')
        .eq('date', new Date().toISOString().slice(0, 10))
        .maybeSingle();
    report.db_quota_before = quotaRow || null;

    const loginRes = await fetch(`${BACKEND}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: env.VITE_ADMIN_USERNAME, password: env.VITE_ADMIN_PASSWORD }),
    });
    let token = null;
    let role = 'admin';
    const login = await loginRes.json();
    if (login.success && login.token) {
        token = login.token;
        role = login.role;
        report.steps.push({ step: 'login', ok: true, username: login.username, role: login.role, via: 'password' });
    } else if (env.CRM_API_KEY) {
        token = issueSession(env.VITE_ADMIN_USERNAME || 'admin', 'admin', env.CRM_API_KEY);
        const verify = await fetch(`${BACKEND}/api/auth/verify`, { headers: { 'x-crm-key': token } });
        const v = await verify.json();
        if (v.valid) {
            report.steps.push({ step: 'login', ok: true, username: v.username, role: v.role, via: 'crm_session' });
            role = v.role;
        } else {
            report.steps.push({ step: 'login', ok: false, via: 'crm_session', message: 'CRM_API_KEY mismatch with production' });
            console.log(JSON.stringify(report, null, 2));
            process.exit(1);
        }
    } else {
        report.steps.push({ step: 'login', ok: false, status: loginRes.status, message: login.message });
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
    }

    const qBefore = await fetch(`${BACKEND}/api/operator/quota`, {
        headers: { 'x-crm-key': token },
    });
    const qBeforeJ = await qBefore.json();
    report.quota_api_before = qBeforeJ.quotas;

    const chatRes = await fetch(`${BACKEND}/api/operator/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-crm-key': token },
        body: JSON.stringify({ message: 'how many open leads for Nishikant' }),
    });
    const chat = await chatRes.json();
    report.steps.push({
        step: 'operator_chat',
        ok: chat.success,
        reply_preview: String(chat.reply || '').slice(0, 200),
        model: chat.model,
        sql_only: chat.sql_only,
        retryable: chat.retryable,
        quotas_after: chat.quotas,
    });

    const qAfter = await fetch(`${BACKEND}/api/operator/quota`, {
        headers: { 'x-crm-key': token },
    });
    const qAfterJ = await qAfter.json();
    report.quota_api_after = qAfterJ.quotas;

    const opBefore = qBeforeJ.quotas?.operator?.count ?? 0;
    const opAfter = qAfterJ.quotas?.operator?.count ?? 0;
    report.operator_delta = opAfter - opBefore;

    const { data: inboxRows } = await supabase
        .from('operator_inbox')
        .select('id, username, kind, message, reply, needs_founder, status')
        .order('created_at', { ascending: false })
        .limit(3);
    report.recent_inbox = inboxRows || [];

    const { data: quotaAfterRow } = await supabase
        .from('agent_quota')
        .select('date, request_count, operator_request_count, transcribe_request_count, tokens_total, operator_tokens_total')
        .eq('date', new Date().toISOString().slice(0, 10))
        .maybeSingle();
    report.db_quota_after = quotaAfterRow || null;

    report.pass = report.inbox_table.ok
        && report.operator_delta >= 1
        && chat.success
        && /leads|Refrens|Nishikant/i.test(chat.reply || '');

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
