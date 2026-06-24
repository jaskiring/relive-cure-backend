#!/usr/bin/env node
/**
 * Live test: 5 parallel WhatsApp bot users + fallback chain + rule-based after quota.
 * Run: node server/scripts/test-whatsapp-concurrent.js
 * Optional: BACKEND_URL=https://... (default production)
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
if (!globalThis.fetch) globalThis.fetch = fetch;

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

const BACKEND = (process.env.BACKEND_URL || 'https://relive-cure-backend-production.up.railway.app').replace(/\/$/, '');
const PREFIX = `parallel-${Date.now()}`;

const USERS = [
    { id: 1, message: "Hi I'm Rahul from Bangalore. My eye power is -4 right and -6 left. Do you have insurance?" },
    { id: 2, message: 'lasik kitna padega mujhe delhi se hu, R:-3 L:-4' },
    { id: 3, message: 'motiyabind hai, mumbai me rehta hu' },
    { id: 4, message: 'I want LASIK, power -2.5 both eyes, Gurgaon, have mediclaim' },
    { id: 5, message: 'What is recovery time? I am from Hyderabad power -5' },
];

async function chatUser({ id, message }) {
    const phone = `${PREFIX}-${id}`;
    const t0 = Date.now();
    const r = await fetch(`${BACKEND}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, message }),
    });
    const j = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    const trigger = j.trigger || null;
    const agentFail = j.agent_fail || null;
    let source = trigger || 'unknown';
    if (trigger === 'agent') source = `agent (${j.model || 'gemini'})`;
    else if (agentFail) source = `rule-based (${agentFail})`;
    else if (trigger && trigger !== 'agent') source = `rule-based (${trigger})`;
    return {
        id,
        phone,
        ms,
        ok: r.ok && !!j.reply,
        source,
        trigger,
        model: j.model,
        agent_fail: agentFail,
        reply: (j.reply || j.error || '').slice(0, 100),
    };
}

async function testParallelFive() {
    console.log('\n═══ TEST 1: 5 users messaging at once ═══');
    console.log(`Backend: ${BACKEND}\n`);
    const t0 = Date.now();
    const results = await Promise.all(USERS.map((u) => chatUser(u)));
    const wall = Date.now() - t0;
    for (const r of results) {
        const mark = r.ok ? '✓' : '✗';
        console.log(`  [${mark}] user ${r.id} — ${r.ms}ms — ${r.source}`);
        console.log(`       "${r.reply}…"`);
    }
    const ok = results.filter((r) => r.ok).length;
    const agentHits = results.filter((r) => r.trigger === 'agent').length;
    const ruleHits = results.filter((r) => r.trigger !== 'agent' && r.ok).length;
    console.log(`\n  Wall time: ${wall}ms | Replies: ${ok}/5 | Agent: ${agentHits} | Rule-based path: ${ruleHits}`);
    return { ok: ok === 5, results, wall };
}

async function testQuotaRuleBased() {
    console.log('\n═══ TEST 2: App quota exhausted → rule-based (local LLM module) ═══');
    if (!process.env.GEMINI_API_KEY) {
        console.log('  SKIP — GEMINI_API_KEY not set locally');
        return { ok: true, skipped: true };
    }
    const { resetForTest, _setCapForTest } = await import('../agent-quota.js');
    const { runGeminiAgent, getLastAgentFailReason } = await import(`../llm-agent.js?t=${Date.now()}`);
    process.env.BOT_AGENT_MODE = 'live';
    resetForTest();
    _setCapForTest(0);
    const result = await runGeminiAgent({
        message: 'I am from Mumbai, power -5, need LASIK cost',
        history: [],
        sessionData: {},
    });
    const fail = getLastAgentFailReason();
    const pass = result === null && fail === 'gemini_quota_exhausted';
    console.log(`  Agent returned null: ${result === null}`);
    console.log(`  Fail reason: ${fail}`);
    console.log(`  ${pass ? '✓' : '✗'} Quota gate → rule-based fallback path`);
    resetForTest();
    _setCapForTest(99999);
    return { ok: pass };
}

async function testQuotaViaChat() {
    console.log('\n═══ TEST 3: Quota exhausted → rule-based via /chat (full bot path) ═══');
    if (!process.env.GEMINI_API_KEY) {
        console.log('  SKIP — needs local server with test cap (run after deploy with debug /chat)');
        return { ok: null, skipped: true };
    }
    // Hit production with substantive message — if quota fine, agent path; we verify reply exists
    const phone = `${PREFIX}-quota`;
    const r = await fetch(`${BACKEND}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            phone,
            message: 'I am Priya from Chennai, eye power -3.5, tell me LASIK cost',
        }),
    });
    const j = await r.json().catch(() => ({}));
    const gotReply = !!j.reply;
    const source = j.trigger === 'agent' ? `agent (${j.model})` : `rule-based (${j.agent_fail || j.trigger})`;
    console.log(`  Reply: ${gotReply ? 'yes' : 'no'} — ${source}`);
    if (j.reply) console.log(`  "${j.reply.slice(0, 120)}…"`);
    return { ok: gotReply, source };
}

async function testFallbackChain() {
    console.log('\n═══ TEST 4: Model fallback chain (flash-lite → gemma → flash) ═══');
    if (!process.env.GEMINI_API_KEY) {
        console.log('  SKIP — GEMINI_API_KEY not set');
        return { ok: true, skipped: true };
    }
    const { resetForTest } = await import('../agent-quota.js');
    const { runGeminiAgent, getLastAgentModel, modelChain } = await import(`../llm-agent.js?t=${Date.now()}`);
    process.env.BOT_AGENT_MODE = 'live';
    process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';
    delete process.env.AGENT_NO_FALLBACK;
    resetForTest();
    const chain = modelChain();
    console.log(`  Chain: ${chain.join(' → ')} → rule-based`);
    const result = await runGeminiAgent({
        message: 'Delhi se hu, power R:-4 L:-5, kitna lagega',
        history: [],
        sessionData: {},
    });
    const used = getLastAgentModel();
    const pass = !!result && chain.includes(used);
    console.log(`  ${pass ? '✓' : '✗'} Agent OK — model used: ${used || 'none'}`);
    return { ok: pass, used, chain };
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('WHATSAPP BOT — PARALLEL + FALLBACK TEST');
    console.log('═══════════════════════════════════════════════════════════');

    const t1 = await testParallelFive();
    const t2 = await testQuotaRuleBased();
    const t3 = await testQuotaViaChat();
    const t4 = await testFallbackChain();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Parallel 5 users:     ${t1.ok ? 'PASS' : 'FAIL'} (${t1.wall}ms wall)`);
    console.log(`Quota → rule-based:   ${t2.skipped ? 'SKIP' : t2.ok ? 'PASS' : 'FAIL'}`);
    console.log(`Full /chat reply:     ${t3.skipped ? 'SKIP' : t3.ok ? 'PASS' : 'FAIL'} ${t3.source || ''}`);
    console.log(`Fallback chain:       ${t4.skipped ? 'SKIP' : t4.ok ? 'PASS' : 'FAIL'} ${t4.used ? `(used ${t4.used})` : ''}`);

    const fail = !t1.ok || (!t2.skipped && !t2.ok) || (t3.ok === false) || (!t4.skipped && !t4.ok);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
