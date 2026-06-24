#!/usr/bin/env node
/**
 * Operator → Cursor bridge (M4 Mac, not Railway).
 *
 * Polls operator_inbox for approved dev work, writes a scoped task .md file,
 * and opens it in Cursor IDE so you implement with Composer/Agent (correct, not OpenCode).
 *
 * Usage:
 *   cd relive-cure-backend && npm run operator-cursor
 *
 * Env (relive-cure-agents/.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   OPERATOR_DEV_WORKSPACE=/Users/you/relive-cure-workspace
 *   OPERATOR_DEV_USER=admin
 *   OPERATOR_WORKER_SECRET + BACKEND_URL (optional heartbeat)
 *   CURSOR_BIN=cursor (optional)
 *   POLL_MS=15000
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { buildOperatorDevTaskMarkdown } from '../operator-dev-task.js';

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

const POLL_MS = parseInt(process.env.POLL_MS || '15000', 10);
const PRESENCE_MAX_AGE_MS = parseInt(process.env.OPERATOR_PRESENCE_MAX_AGE_MS || '120000', 10);
const WORKSPACE = process.env.OPERATOR_DEV_WORKSPACE
    || resolve(__dirname, '../../../relive-cure-workspace');
const DEV_USER = String(process.env.OPERATOR_DEV_USER || process.env.VITE_ADMIN_USERNAME || 'admin').trim();
const TASK_DIR = resolve(WORKSPACE, 'relive-cure-agents/cursor-dev-tasks');
const CURSOR_BIN = process.env.CURSOR_BIN || 'cursor';
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const WORKER_SECRET = process.env.OPERATOR_WORKER_SECRET || '';

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`[OPERATOR-CURSOR] Missing ${name}`);
        process.exit(2);
    }
    return v;
}

const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
);

async function touchWorkerPresence() {
    const at = new Date().toISOString();
    await supabase.from('operator_dev_presence').upsert({
        username: DEV_USER,
        source: 'worker',
        last_seen: at,
        meta: { workspace: WORKSPACE, engine: 'cursor' },
    }, { onConflict: 'username,source' }).catch(() => {});
}

async function heartbeatBackend() {
    if (!BACKEND_URL || !WORKER_SECRET) return;
    try {
        await fetch(`${BACKEND_URL}/api/operator/worker/heartbeat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-worker-secret': WORKER_SECRET,
            },
            body: JSON.stringify({
                at: new Date().toISOString(),
                workspace: WORKSPACE,
                engine: 'cursor',
                dev_user: DEV_USER,
            }),
        });
    } catch (e) {
        console.warn('[OPERATOR-CURSOR] heartbeat failed:', e.message);
    }
}

async function isFounderLoggedIn() {
    const since = new Date(Date.now() - PRESENCE_MAX_AGE_MS).toISOString();
    const { data, error } = await supabase
        .from('operator_dev_presence')
        .select('last_seen')
        .eq('username', DEV_USER)
        .eq('source', 'crm')
        .gte('last_seen', since)
        .maybeSingle();
    if (error && /operator_dev_presence|does not exist/i.test(error.message)) return true;
    if (error) throw new Error(error.message);
    return !!data;
}

async function claimNextJob() {
    const { data: rows, error } = await supabase
        .from('operator_inbox')
        .select('id, username, kind, message, transcript, edited_prompt, status, dev_status, dev_route, approved_by')
        .eq('status', 'approved')
        .eq('dev_status', 'queued')
        .order('created_at', { ascending: true })
        .limit(10);
    if (error) throw new Error(error.message);

    const row = (rows || []).find((r) => {
        if (r.approved_by && r.approved_by !== DEV_USER) return false;
        const route = r.dev_route || 'cursor';
        return route === 'cursor';
    });
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

function writeTaskFile(row) {
    mkdirSync(TASK_DIR, { recursive: true });
    const path = resolve(TASK_DIR, `inbox-${row.id}.md`);
    writeFileSync(path, buildOperatorDevTaskMarkdown(row, { workspace: WORKSPACE, devUser: DEV_USER }), 'utf8');
    return path;
}

function openInCursor(taskPath) {
    return new Promise((resolveOpen) => {
        const tryCursor = spawn(CURSOR_BIN, ['-r', WORKSPACE, taskPath], {
            detached: true,
            stdio: 'ignore',
        });
        tryCursor.on('error', () => {
            spawn('open', ['-a', 'Cursor', taskPath], { detached: true, stdio: 'ignore' })
                .on('error', (e) => resolveOpen({ ok: false, error: e.message }))
                .on('spawn', () => resolveOpen({ ok: true, via: 'open' }));
        });
        tryCursor.on('spawn', () => {
            tryCursor.unref();
            resolveOpen({ ok: true, via: 'cursor' });
        });
    });
}

async function deliverToCursor(job) {
    const taskPath = writeTaskFile(job);
    console.log(`[OPERATOR-CURSOR] #${job.id} task → ${taskPath}`);
    const opened = await openInCursor(taskPath);
    if (!opened.ok) {
        console.warn(`[OPERATOR-CURSOR] could not auto-open Cursor: ${opened.error}`);
        console.warn(`[OPERATOR-CURSOR] open manually: ${taskPath}`);
    } else {
        console.log(`[OPERATOR-CURSOR] opened in Cursor (${opened.via})`);
    }

    const { error } = await supabase
        .from('operator_inbox')
        .update({
            dev_status: 'ready',
            dev_result: {
                engine: 'cursor',
                task_file: taskPath,
                opened_at: new Date().toISOString(),
                opened_via: opened.via || null,
                summary: 'Task delivered to Cursor — implement in IDE, then Mark dev done in CRM inbox.',
            },
            updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    if (error) throw new Error(error.message);
    console.log(`[OPERATOR-CURSOR] #${job.id} ready — implement in Cursor, then mark done in Operator inbox`);
}

async function processOne() {
    if (!(await isFounderLoggedIn())) {
        console.log(`[OPERATOR-CURSOR] waiting — log into CRM as "${DEV_USER}" on this Mac`);
        return;
    }

    const job = await claimNextJob();
    if (!job) return;

    console.log(`[OPERATOR-CURSOR] #${job.id} ${job.kind} from ${job.username}`);
    await deliverToCursor(job);
}

async function loop() {
    console.log(`[OPERATOR-CURSOR] Cursor IDE bridge — workspace ${WORKSPACE}`);
    console.log(`[OPERATOR-CURSOR] dev user "${DEV_USER}" · tasks ${TASK_DIR} · poll ${POLL_MS}ms`);
    console.log('[OPERATOR-CURSOR] Approve in CRM → task opens in Cursor → you implement → Mark dev done in inbox.');
    await touchWorkerPresence();
    await heartbeatBackend();
    for (;;) {
        try {
            await touchWorkerPresence();
            await processOne();
            await heartbeatBackend();
        } catch (e) {
            console.error('[OPERATOR-CURSOR] loop error:', e.message);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}

loop();
