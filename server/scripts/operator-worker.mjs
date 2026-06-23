#!/usr/bin/env node
/**
 * Phase 2 — Operator dev worker (run on M4 Mac, not Railway).
 *
 * Polls operator_inbox for approved items (dev_status=queued), runs Cursor SDK
 * locally against relive-cure-workspace, writes dev_result back to Supabase.
 *
 * Usage:
 *   export CURSOR_API_KEY=cursor_...
 *   export SUPABASE_URL=...
 *   export SUPABASE_SERVICE_ROLE_KEY=...
 *   export OPERATOR_DEV_WORKSPACE=/Users/you/relive-cure-workspace
 *   node server/scripts/operator-worker.mjs
 *
 * Optional: OPERATOR_WORKER_SECRET + BACKEND_URL for heartbeat to dashboard.
 * Optional: CURSOR_DEV_DAILY_CAP=5, CURSOR_DEV_MODEL=auto, POLL_MS=30000
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m || process.env[m[1]]) continue;
        process.env[m[1]] = m[2].trim();
    }
}

loadEnvFile(resolve(__dirname, '../../../relive-cure-agents/.env'));
loadEnvFile(resolve(__dirname, '../../.env'));

const POLL_MS = parseInt(process.env.POLL_MS || '30000', 10);
const DAILY_CAP = parseInt(process.env.CURSOR_DEV_DAILY_CAP || '5', 10);
const WORKSPACE = process.env.OPERATOR_DEV_WORKSPACE
    || resolve(__dirname, '../../../relive-cure-workspace');
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const WORKER_SECRET = process.env.OPERATOR_WORKER_SECRET || '';

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`[OPERATOR-WORKER] Missing ${name}`);
        process.exit(2);
    }
    return v;
}

const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
);

async function heartbeat() {
    if (!BACKEND_URL || !WORKER_SECRET) return;
    try {
        await fetch(`${BACKEND_URL}/api/operator/worker/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
            body: JSON.stringify({ at: new Date().toISOString(), workspace: WORKSPACE }),
        });
    } catch (e) {
        console.warn('[OPERATOR-WORKER] heartbeat failed:', e.message);
    }
}

async function dailyDoneCount() {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { count, error } = await supabase
        .from('operator_inbox')
        .select('id', { count: 'exact', head: true })
        .eq('dev_status', 'done')
        .gte('updated_at', since.toISOString());
    if (error) throw new Error(error.message);
    return count || 0;
}

async function claimNextJob() {
    const { data: rows, error } = await supabase
        .from('operator_inbox')
        .select('id, username, kind, message, transcript, edited_prompt, status, dev_status')
        .eq('status', 'approved')
        .eq('dev_status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1);
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) return null;

    const { data: claimed, error: uErr } = await supabase
        .from('operator_inbox')
        .update({ dev_status: 'running', updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('dev_status', 'queued')
        .select()
        .maybeSingle();
    if (uErr) throw new Error(uErr.message);
    return claimed;
}

function buildDevPrompt(row) {
    const body = row.edited_prompt || row.transcript || row.message || '';
    return `You are implementing an approved ${row.kind} request for Relive Cure CRM (LASIK clinic).

Reporter: ${row.username}
Inbox item #${row.id}

Request:
${body}

Workspace root: ${WORKSPACE}
Primary repos:
- relive-cure-backend/server — Express API, Operator, WhatsApp bot
- relive-cure-dashboard/src — React CRM dashboard

Rules:
- Minimal, focused diff; match existing code style.
- Do not invent CRM counts — use SQL/tools patterns in operator-playbooks.js.
- Run relevant tests if you change backend (npm test in relive-cure-backend).
- Do not git commit or push unless the request explicitly asks for it.
- End with a short summary: files changed, how to verify.`;
}

async function runCursorAgent(prompt) {
    const apiKey = requireEnv('CURSOR_API_KEY');
    const model = process.env.CURSOR_DEV_MODEL || 'auto';
    let Agent;
    let CursorAgentError;
    try {
        ({ Agent, CursorAgentError } = await import('@cursor/sdk'));
    } catch {
        throw new Error('Install @cursor/sdk in relive-cure-backend: npm install @cursor/sdk');
    }

    try {
        const result = await Agent.prompt(prompt, {
            apiKey,
            model: model === 'auto' ? { id: 'auto' } : model,
            local: { cwd: WORKSPACE, settingSources: [] },
        });
        return {
            ok: result.status !== 'error',
            status: result.status,
            summary: result.result || '',
            agent_id: result.agentId || null,
            run_id: result.id || null,
        };
    } catch (e) {
        if (CursorAgentError && e instanceof CursorAgentError) {
            return {
                ok: false,
                status: 'startup_error',
                summary: e.message,
                retryable: e.isRetryable,
            };
        }
        throw e;
    }
}

async function finishJob(id, patch) {
    const { error } = await supabase
        .from('operator_inbox')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) throw new Error(error.message);
}

async function processOne() {
    const used = await dailyDoneCount();
    if (used >= DAILY_CAP) {
        console.log(`[OPERATOR-WORKER] daily cap reached (${used}/${DAILY_CAP}) — waiting`);
        return;
    }

    const job = await claimNextJob();
    if (!job) return;

    console.log(`[OPERATOR-WORKER] #${job.id} ${job.kind} from ${job.username} — running Cursor agent…`);
    const prompt = buildDevPrompt(job);
    const started = Date.now();

    let outcome;
    try {
        outcome = await runCursorAgent(prompt);
    } catch (e) {
        outcome = { ok: false, status: 'error', summary: e.message };
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    if (outcome.ok) {
        await finishJob(job.id, {
            dev_status: 'done',
            dev_result: {
                status: outcome.status,
                summary: outcome.summary?.slice(0, 8000) || '',
                agent_id: outcome.agent_id,
                run_id: outcome.run_id,
                elapsed_sec: elapsed,
                model: process.env.CURSOR_DEV_MODEL || 'auto',
            },
        });
        console.log(`[OPERATOR-WORKER] #${job.id} done in ${elapsed}s`);
    } else {
        await finishJob(job.id, {
            dev_status: 'failed',
            dev_result: {
                status: outcome.status,
                error: outcome.summary,
                retryable: outcome.retryable ?? false,
                elapsed_sec: elapsed,
            },
        });
        console.error(`[OPERATOR-WORKER] #${job.id} failed:`, outcome.summary);
    }
}

async function loop() {
    console.log(`[OPERATOR-WORKER] online — workspace ${WORKSPACE}, cap ${DAILY_CAP}/day, poll ${POLL_MS}ms`);
    console.log('[OPERATOR-WORKER] Uses Cursor API pool (not IDE Composer quota). Set CURSOR_API_KEY from dashboard → Integrations.');
    await heartbeat();
    for (;;) {
        try {
            await processOne();
            await heartbeat();
        } catch (e) {
            console.error('[OPERATOR-WORKER] loop error:', e.message);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}

loop();
