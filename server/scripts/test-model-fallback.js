#!/usr/bin/env node
/**
 * Live test: model fallback chain + extraction consistency.
 * Run: node server/scripts/test-model-fallback.js
 */
import 'dotenv/config';
import fetch from 'node-fetch';
if (!globalThis.fetch) globalThis.fetch = fetch;

import { resetForTest } from '../agent-quota.js';

const MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemma-4-26b-a4b-it',
];

const SCENARIOS = [
    {
        name: 'full_lead_en',
        message: "Hi I'm Rahul from Bangalore. My eye power is -4 right and -6 left. I have medical insurance.",
        expect: { city: /bangalore/i, eye_power: /-4.*-6|-6.*-4|R.*-4.*L.*-6/i, insurance: true },
    },
    {
        name: 'hinglish_cost',
        message: 'lasik kitna padega mujhe banglore se hu, R:-4 L:-6',
        expect: { city: /bangalore/i, eye_power: /-4|R:-4/i, asks_cost: true },
    },
    {
        name: 'cataract_city',
        message: 'motiyabind hai, delhi me rehta hu',
        expect: { city: /delhi/i, is_cataract: true },
    },
];

import { INDIAN_CITIES } from '../bot-guard.js';

const CITY_ALIASES = { banglore: 'Bangalore', bengaluru: 'Bangalore', bombay: 'Mumbai', gurgaon: 'Gurgaon', gurugram: 'Gurgaon' };
function normalizeCityAlias(s) {
    const k = String(s || '').toLowerCase().trim();
    return CITY_ALIASES[k] || (k.charAt(0).toUpperCase() + k.slice(1));
}

function parseEyePower(message) {
    const m = String(message || '').trim();
    function pairResult(raw, right, left) {
        if (right > 0 && !String(right).includes('+')) right = -right;
        if (left > 0 && !String(left).includes('+')) left = -left;
        return { parsed: `R:${right} L:${left}`, numeric: -((Math.abs(right) + Math.abs(left)) / 2), right, left };
    }
    const structMatch = m.match(/[Rr]\s*:\s*([+-]?\d+(?:\.\d+)?)\s+[Ll]\s*:\s*([+-]?\d+(?:\.\d+)?)/);
    if (structMatch) {
        const r = parseFloat(structMatch[1]); const l = parseFloat(structMatch[2]);
        return pairResult(m, r, l);
    }
    const numRl = m.match(/([+-]?\d+(?:\.\d+)?)\s+right\b.*?([+-]?\d+(?:\.\d+)?)\s+left\b/i);
    if (numRl) {
        return pairResult(m, parseFloat(numRl[1]), parseFloat(numRl[2]));
    }
    const numLeftRight = m.match(/([+-]?\d+(?:\.\d+)?)\s+left\b(?:\s+and)?\s*([+-]?\d+(?:\.\d+)?)\s+right\b/i);
    if (numLeftRight) {
        return pairResult(m, parseFloat(numLeftRight[2]), parseFloat(numLeftRight[1]));
    }
    const numRightLeft = m.match(/([+-]?\d+(?:\.\d+)?)\s+right\b(?:\s+and)?\s*([+-]?\d+(?:\.\d+)?)\s+left\b/i);
    if (numRightLeft) {
        return pairResult(m, parseFloat(numRightLeft[1]), parseFloat(numRightLeft[2]));
    }
    const match = m.match(/[-+]?\d+(\.\d+)?/);
    if (!match) return null;
    let n = parseFloat(match[0]);
    if (n > 0 && !m.includes('+')) n = -n;
    return { parsed: match[0], numeric: n };
}

function simulateProductionIngest(message, agentFields) {
    const d = {
        contactName: 'WhatsApp Lead',
        city: null,
        eyePower: null,
        insurance: null,
        is_cataract: false,
        interest_cost: false,
    };
    const ag = agentFields || {};
    if (ag.name) d.contactName = ag.name;
    if (ag.city) d.city = normalizeCityAlias(ag.city);
    if (ag.eye_power) {
        const p = parseEyePower(ag.eye_power);
        if (p) d.eyePower = p;
    }
    if (ag.insurance === true) d.insurance = 'Yes';
    if (ag.is_cataract) d.is_cataract = true;
    if (ag.asks_cost) d.interest_cost = true;

    const m = message.toLowerCase();
    if (!d.city) {
        for (const city of INDIAN_CITIES) {
            if (m.includes(city)) { d.city = city.charAt(0).toUpperCase() + city.slice(1); break; }
        }
        const seCity = m.match(/([a-z]{3,20})\s+se\s+(?:hu|hun|hoon|hai)\b/i);
        if (!d.city && seCity?.[1]) d.city = normalizeCityAlias(seCity[1]);
        const fromMatch = m.match(/(?:from|i'm from|i am from)\s+([a-z]+)/i);
        if (!d.city && fromMatch?.[1]) d.city = normalizeCityAlias(fromMatch[1]);
        if (!d.city && /delhi me rehta/i.test(m)) d.city = 'Delhi';
    }
    if (!d.eyePower) {
        const p = parseEyePower(message);
        if (p && (p.right != null || /power|eye|right|left|r:|l:/i.test(message))) d.eyePower = p;
    }
    if (!d.insurance && /\b(insurance|covered|mediclaim|health policy)\b/i.test(m)) d.insurance = 'Yes';
    if (!d.is_cataract && /\b(motiyabind|motia|cataract|motiyabind)\b/i.test(m)) d.is_cataract = true;
    if (!d.interest_cost && /\b(kitna|cost|price|paisa|paise|fee)\b/i.test(m)) d.interest_cost = true;
    if (d.contactName === 'WhatsApp Lead') {
        const nm = message.match(/\b(?:i'?m|i am)\s+([a-zA-Z]{2,20})\b/i);
        if (nm?.[1]) d.contactName = nm[1].charAt(0).toUpperCase() + nm[1].slice(1).toLowerCase();
    }
    return d;
}

function snapshotLead(d) {
    const ep = d.eyePower;
    return {
        contact_name: d.contactName,
        city: d.city,
        eye_power: ep?.parsed || ep?.raw || null,
        insurance: d.insurance,
        is_cataract: d.is_cataract,
        interest_cost: d.interest_cost,
    };
}

function pickFields(ag) {
    if (!ag) return null;
    return {
        city: ag.city ?? null,
        eye_power: ag.eye_power ?? null,
        insurance: ag.insurance ?? null,
        asks_cost: !!ag.asks_cost,
        is_cataract: !!ag.is_cataract,
        name: ag.name ?? null,
    };
}

function matchesExpectLead(lead, expect) {
    const mapped = {
        city: lead.city,
        eye_power: lead.eye_power,
        insurance: lead.insurance === 'Yes',
        asks_cost: !!lead.interest_cost,
        is_cataract: !!lead.is_cataract,
    };
    return matchesExpect(mapped, expect);
}

function matchesExpect(got, expect) {
    const misses = [];
    for (const [k, v] of Object.entries(expect)) {
        const g = got?.[k];
        if (v instanceof RegExp) {
            if (!g || !v.test(String(g))) misses.push(`${k}: got ${JSON.stringify(g)} want ${v}`);
        } else if (typeof v === 'boolean') {
            if (!!g !== v) misses.push(`${k}: got ${g} want ${v}`);
        } else if (g !== v) {
            misses.push(`${k}: got ${JSON.stringify(g)} want ${JSON.stringify(v)}`);
        }
    }
    return misses;
}

async function loadAgent() {
    return import(`../llm-agent.js?t=${Date.now()}`);
}

async function runOneModel(model, scenario, history = []) {
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
    process.env.BOT_AGENT_MODE = 'live';
    process.env.GEMINI_MODEL = model;
    process.env.AGENT_NO_FALLBACK = '1';
    resetForTest();

    const { runGeminiAgent, getLastAgentModel, getLastAgentFailReason } = await loadAgent();
    const t0 = Date.now();
    const result = await runGeminiAgent({ message: scenario.message, history, sessionData: {} });
    const ms = Date.now() - t0;
    return {
        model,
        ms,
        ok: !!result,
        fail: getLastAgentFailReason(),
        used: getLastAgentModel(),
        fields: pickFields(result),
    };
}

async function runFallbackChain(scenario) {
    delete process.env.AGENT_NO_FALLBACK;
    process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';
    process.env.BOT_AGENT_MODE = 'live';
    resetForTest();

    const { runGeminiAgent, getLastAgentModel, getLastAgentFailReason, modelChain, agentStatus } = await loadAgent();
    const t0 = Date.now();
    const result = await runGeminiAgent({ message: scenario.message, history: [], sessionData: {} });
    const ms = Date.now() - t0;
    const status = agentStatus();
    return {
        chain: modelChain(),
        ms,
        ok: !!result,
        fail: getLastAgentFailReason(),
        used: getLastAgentModel(),
        fields: pickFields(result),
        ruleBasedWouldTrigger: !result,
    };
}

function normFields(f) {
    if (!f) return null;
    return {
        city: f.city ? String(f.city).toLowerCase().replace(/banglore/, 'bangalore') : null,
        eye_power: f.eye_power ? String(f.eye_power).replace(/\s+/g, ' ').toLowerCase() : null,
        insurance: f.insurance,
        asks_cost: f.asks_cost,
        is_cataract: f.is_cataract,
        name: f.name ? String(f.name).toLowerCase() : null,
    };
}

function fieldConsistency(rows) {
    const okRows = rows.filter((r) => r.ok);
    if (okRows.length < 2) return { consistent: null, note: 'not enough successful models' };
    const norms = okRows.map((r) => normFields(r.fields));
    const keys = ['city', 'eye_power', 'insurance', 'asks_cost', 'is_cataract'];
    const diffs = [];
    for (const k of keys) {
        const vals = [...new Set(norms.map((n) => JSON.stringify(n[k])))];
        if (vals.length > 1) diffs.push({ field: k, values: norms.map((n) => n[k]) });
    }
    return { consistent: diffs.length === 0, diffs };
}

async function main() {
    const fallbackOnly = process.argv.includes('--fallback-only');
    if (!process.env.GEMINI_API_KEY) {
        console.error('GEMINI_API_KEY missing in .env');
        process.exit(1);
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('MODEL FALLBACK + EXTRACTION CONSISTENCY TEST');
    console.log('═══════════════════════════════════════════════════════════\n');

    const allResults = [];

    for (const scenario of SCENARIOS) {
        console.log(`\n▶ Scenario: ${scenario.name}`);
        console.log(`  Message: "${scenario.message.slice(0, 70)}..."\n`);

        const perModel = [];
        let cons = null;
        if (!fallbackOnly) {
            for (const model of MODELS) {
                try {
                    const r = await runOneModel(model, scenario);
                    perModel.push(r);
                    const expectMiss = r.ok ? matchesExpect(r.fields, scenario.expect) : ['agent returned null'];
                    const status = r.ok && expectMiss.length === 0 ? 'PASS' : r.ok ? 'PARTIAL' : 'FAIL';
                    console.log(`  [${status}] ${model} (${r.ms}ms) used=${r.used || '-'} fail=${r.fail || '-'}`);
                    if (r.fields) console.log(`         fields: ${JSON.stringify(r.fields)}`);
                    if (expectMiss.length && r.ok) console.log(`         expect gaps: ${expectMiss.join('; ')}`);
                } catch (e) {
                    console.log(`  [ERROR] ${model}: ${e.message}`);
                    perModel.push({ model, ok: false, error: e.message });
                }
            }
            cons = fieldConsistency(perModel);
            if (cons.consistent === true) console.log('  ✓ Cross-model extraction consistent');
            else if (cons.consistent === false) {
                console.log('  ⚠ Cross-model differences:');
                for (const d of cons.diffs) console.log(`    ${d.field}: ${d.values.join(' | ')}`);
            }
        }

        console.log('\n  --- Fallback chain (primary flash-lite) ---');
        try {
            const fb = await runFallbackChain(scenario);
            const fbStatus = fb.ok ? 'AGENT OK (not rule-based)' : 'RULE-BASED FALLBACK';
            console.log(`  [${fbStatus}] ${fb.ms}ms model=${fb.used || '-'} fail=${fb.fail || '-'}`);
            console.log(`  chain: ${fb.chain.join(' → ')}`);
            if (fb.fields) console.log(`  LLM only: ${JSON.stringify(fb.fields)}`);
            if (fb.ok) {
                const ingested = snapshotLead(simulateProductionIngest(scenario.message, fb.fields));
                const ingestMiss = matchesExpectLead(ingested, scenario.expect);
                const ingestStatus = ingestMiss.length === 0 ? 'PASS' : 'PARTIAL';
                console.log(`  [${ingestStatus}] After agent+passive ingest: ${JSON.stringify(ingested)}`);
                if (ingestMiss.length) console.log(`         ingest gaps: ${ingestMiss.join('; ')}`);
                fb.ingested = ingested;
                fb.ingestOk = ingestMiss.length === 0;
            }
            if (fb.ok && fb.used && fb.used !== 'gemini-2.5-flash-lite') {
                console.log(`  ✓ Fell back from flash-lite to ${fb.used}`);
            }
            allResults.push({ scenario: scenario.name, fallback: fb });
        } catch (e) {
            console.log(`  [ERROR] fallback: ${e.message}`);
        }

        allResults.push({ scenario: scenario.name, perModel, consistency: fallbackOnly ? null : cons });
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    const fallbackOk = allResults.filter((r) => r.fallback?.ok).length;
    const fallbackTotal = allResults.filter((r) => r.fallback).length;
    console.log(`Fallback kept agent path: ${fallbackOk}/${fallbackTotal} scenarios`);
    const modelPasses = allResults.flatMap((r) => r.perModel || []).filter((m) => m.ok).length;
    const modelTotal = allResults.flatMap((r) => r.perModel || []).length;
    console.log(`Per-model agent success: ${modelPasses}/${modelTotal} calls`);
    const ingestOk = allResults.filter((r) => r.fallback?.ingestOk).length;
    console.log(`Final ingested lead data correct: ${ingestOk}/${fallbackTotal} scenarios`);

    const anyFallback = allResults.some((r) => r.fallback?.ok && r.fallback?.used !== 'gemini-2.5-flash-lite');
    if (anyFallback) console.log('✓ Auto-fallback to secondary model confirmed');
    if (fallbackOk === fallbackTotal) console.log('✓ No scenario fell through to rule-based bot');
    else console.log('✗ Some scenarios would use rule-based bot — check quota / API key');

    process.exit(fallbackOk === fallbackTotal ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
