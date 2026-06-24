#!/usr/bin/env node
/**
 * Operator → OpenCode worker (M4 Mac, local only).
 *
 * Polls operator_inbox for approved mechanical tasks (dev_route=opencode),
 * runs OpenCode non-interactively, validates, marks done or failed.
 *
 * Usage:
 *   cd relive-cure-backend && npm run operator-opencode
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import { buildOperatorOpencodePrompt } from '../operator-dev-task.js';
import { runValidateGate } from '../operator-validate-gate.js';

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
const WORKSPACE = process.env.OPERATOR_DEV_WORKSPACE
    || resolve(__dirname, '../../../relive-cure-workspace');
const DEV_USER = String(process.env.OPERATOR_DEV_USER || process.env.VITE_ADMIN_USERNAME || 'admin').trim();
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/$/, '');
const WORKER_SECRET = process.env.OPERATOR_WORKER_SECRET || '';
const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || '';
const OPENCODE_AGENT = process.env.OPENCODE_AGENT || 'build';

function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`[OPERATOR-OPENCODE] Missing ${name}`);
        process.exit(2);
    }
    return v;
}

const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
);

function runCmd(cwd, cmd, args, timeoutMs = 900_000) {
    return new Promise((resolveRun) => {
        const child = spawn(cmd, args, { cwd, shell: false, env: process.env });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            resolveRun({ ok: false, code: -1, stdout, stderr: `${stderr}\n(timeout ${timeoutMs}ms)` });
        }, timeoutMs);
        child.stdout?.on('data', (d) => { stdout += d; });
        child.stderr?.on('data', (d) => { stderr += d; });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolveRun({ ok: code === 0, code, stdout, stderr });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolveRun({ ok: false, code: -1, stdout, stderr: err.message });
        });
    });
}

async function touchWorkerPresence() {
    const at = new Date().toISOString();
    await supabase.from('operator_dev_presence').upsert({
        username: DEV_USER,
        source: 'worker_opencode',
        last_seen: at,
        meta: { workspace: WORKSPACE, engine: 'opencode' },
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
                engine: 'opencode',
                dev_user: DEV_USER,
            }),
        });
    } catch (e) {
        console.warn('[OPERATOR-OPENCODE] heartbeat failed:', e.message);
    }
}

async function claimNextJob() {
    const { data: rows, error } = await supabase
        .from('operator_inbox')
        .select('id, username, kind, message, transcript, edited_prompt, status, dev_status, dev_route, approved_by')
        .eq('status', 'approved')
        .eq('dev_status', 'queued')
        .eq('dev_route', 'opencode')
        .order('created_at', { ascending: true })
        .limit(5);
    if (error) throw new Error(error.message);

    const row = (rows || []).find((r) => !r.approved_by || r.approved_by === DEV_USER);
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

async function runOpencode(job) {
    const prompt = buildOperatorOpencodePrompt(job, { workspace: WORKSPACE, devUser: DEV_USER });
    const args = [
        'run',
        '--dir', WORKSPACE,
        '--dangerously-skip-permissions',
        '--agent', OPENCODE_AGENT,
    ];
    if (OPENCODE_MODEL) args.push('-m', OPENCODE_MODEL);
    args.push(prompt);
    console.log(`[OPERATOR-OPENCODE] #${job.id} running OpenCode in ${WORKSPACE}`);
    return runCmd(WORKSPACE, OPENCODE_BIN, args, 900_000);
}

async function markFailed(job, error, extra = {}) {
    const { error: uErr } = await supabase
        .from('operator_inbox')
        .update({
            dev_status: 'failed',
            dev_result: {
                engine: 'opencode',
                failed_at: new Date().toISOString(),
                error: String(error || 'unknown').slice(0, 4000),
                ...extra,
            },
            updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    if (uErr) throw new Error(uErr.message);
    console.error(`[OPERATOR-OPENCODE] #${job.id} failed: ${error}`);
}

async function markDone(job, validation, opencodeRun) {
    const summary = (opencodeRun.stdout || '').trim().split('\n').slice(-8).join('\n')
        || 'OpenCode completed; validate gate passed.';
    const { error } = await supabase
        .from('operator_inbox')
        .update({
            dev_status: 'done',
            dev_result: {
                engine: 'opencode',
                completed_at: new Date().toISOString(),
                summary: summary.slice(0, 2000),
                validation: { ok: true, at: new Date().toISOString() },
                opencode_exit: opencodeRun.code,
            },
            updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    if (error) throw new Error(error.message);
    console.log(`[OPERATOR-OPENCODE] #${job.id} done — validate gate green`);
}

async function processJob(job) {
    const opencodeRun = await runOpencode(job);
    if (!opencodeRun.ok) {
        await markFailed(job, opencodeRun.stderr || `OpenCode exit ${opencodeRun.code}`, {
            opencode_stdout: opencodeRun.stdout?.slice(-3000) || null,
            opencode_stderr: opencodeRun.stderr?.slice(-3000) || null,
        });
        return;
    }

    const validation = await runValidateGate(WORKSPACE);
    if (!validation.ok) {
        await markFailed(job, validation.error || 'validate gate failed', {
            validation,
            opencode_stdout: opencodeRun.stdout?.slice(-2000) || null,
        });
        return;
    }

    await markDone(job, validation, opencodeRun);
}

async function processOne() {
    const job = await claimNextJob();
    if (!job) return;
    console.log(`[OPERATOR-OPENCODE] #${job.id} ${job.kind} from ${job.username}`);
    try {
        await processJob(job);
    } catch (e) {
        try {
            await markFailed(job, e.message);
        } catch (e2) {
            console.error('[OPERATOR-OPENCODE] could not mark failed:', e2.message);
        }
    }
}

async function loop() {
    console.log(`[OPERATOR-OPENCODE] local worker — workspace ${WORKSPACE}`);
    console.log(`[OPERATOR-OPENCODE] dev user "${DEV_USER}" · poll ${POLL_MS}ms · agent ${OPENCODE_AGENT}`);
    await touchWorkerPresence();
    await heartbeatBackend();
    for (;;) {
        try {
            await touchWorkerPresence();
            await processOne();
            await heartbeatBackend();
        } catch (e) {
            console.error('[OPERATOR-OPENCODE] loop error:', e.message);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}

loop();
