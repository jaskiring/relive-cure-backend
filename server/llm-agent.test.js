// server/llm-agent.test.js
// Run: node --test server/llm-agent.test.js
//
// Tests the pure helpers (isAgentEnabled, agentMode) via env manipulation,
// and the Gemini caller via fetch mocking. The module reads env at call time,
// so we set env before each test and re-import dynamically with a cache-buster.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadModule() {
    // Dynamic import caches by URL; append a cache-buster query so each load
    // re-evaluates with the current env. Node respects this for ESM.
    const mod = await import(`./llm-agent.js?t=${Date.now()}-${Math.random()}`);
    return mod;
}

function withEnv(env, fn) {
    return async () => {
        const saved = {};
        for (const [k, v] of Object.entries(env)) {
            saved[k] = process.env[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        if (!('AGENT_NO_FALLBACK' in env)) process.env.AGENT_NO_FALLBACK = '1';
        try { return await fn(); }
        finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            if (!('AGENT_NO_FALLBACK' in saved)) delete process.env.AGENT_NO_FALLBACK;
        }
    };
}

test('isAgentEnabled: false with no env', withEnv({ GEMINI_API_KEY: undefined, BOT_AGENT_MODE: undefined }, async () => {
    const { isAgentEnabled } = await loadModule();
    assert.equal(isAgentEnabled(), false);
}));

test('isAgentEnabled: true with key but no mode (defaults to live)', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: undefined }, async () => {
    const { isAgentEnabled, agentMode } = await loadModule();
    assert.equal(isAgentEnabled(), true);
    assert.equal(agentMode(), 'live');
}));

test('isAgentEnabled: true with key + shadow; agentMode reports shadow', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'shadow' }, async () => {
    const { isAgentEnabled, agentMode } = await loadModule();
    assert.equal(isAgentEnabled(), true);
    assert.equal(agentMode(), 'shadow');
}));

test('isAgentEnabled: true with key + live; agentMode reports live', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const { isAgentEnabled, agentMode } = await loadModule();
    assert.equal(isAgentEnabled(), true);
    assert.equal(agentMode(), 'live');
}));

test('isAgentEnabled: false with invalid mode', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'invalid' }, async () => {
    const { isAgentEnabled } = await loadModule();
    assert.equal(isAgentEnabled(), false);
}));

test('runGeminiAgent: returns null when disabled (no fetch call)', withEnv({ GEMINI_API_KEY: undefined, BOT_AGENT_MODE: undefined }, async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
        assert.equal(fetchCalled, false, 'fetch must NOT be called when disabled');
    } finally { globalThis.fetch = origFetch; }
}));

function mockFetch(response) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => response;
    return () => { globalThis.fetch = origFetch; };
}

test('runGeminiAgent: parses valid JSON response', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const restore = mockFetch({
        ok: true,
        json: async () => ({
            candidates: [{
                content: { parts: [{ text: JSON.stringify({
                    reply: 'Hi there! 😊',
                    name: 'Rahul',
                    city: null,
                    eye_power: null,
                    asks_cost: false,
                    asks_recovery: false,
                    asks_pain: false,
                    asks_safety: false,
                    power_concern: false,
                    wants_callback: false,
                    is_cataract: false,
                }) }] }
            }]
        })
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.ok(result, 'should return a parsed result');
        assert.equal(result.reply, 'Hi there! 😊');
        assert.equal(result.name, 'Rahul');
    } finally { restore(); }
}));

test('runGeminiAgent: HTTP 429 ×2 → null', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live', GEMINI_MODEL: 'gemma-4-26b-a4b-it' }, async () => {
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        calls++;
        return { ok: false, status: 429, text: async () => '{"error":{"message":"quota exceeded"}}' };
    };
    try {
        const { runGeminiAgent, getLastAgentFailReason } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
        assert.equal(getLastAgentFailReason(), 'gemma_rate_limited');
        assert.equal(calls, 2, 'should retry once after 429');
    } finally { globalThis.fetch = origFetch; }
}));

test('runGeminiAgent: HTTP 429 then success → parsed', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live', GEMINI_MODEL: 'gemini-2.5-flash' }, async () => {
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        calls++;
        if (calls === 1) {
            return { ok: false, status: 429, text: async () => '{"error":{"message":"quota exceeded"}}' };
        }
        return {
            ok: true,
            json: async () => ({
                candidates: [{
                    content: { parts: [{ text: JSON.stringify({ reply: 'Hi! 😊' }) }] }
                }]
            })
        };
    };
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.ok(result);
        assert.equal(result.reply, 'Hi! 😊');
        assert.equal(calls, 2);
    } finally { globalThis.fetch = origFetch; }
}));

test('runGeminiAgent: HTTP 500 → null', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const restore = mockFetch({
        ok: false,
        status: 500,
        text: async () => '{"error":{"message":"server error"}}'
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
    } finally { restore(); }
}));

test('runGeminiAgent: blocked → null', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const restore = mockFetch({
        ok: true,
        json: async () => ({
            promptFeedback: { blockReason: 'SAFETY' },
            candidates: []
        })
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
    } finally { restore(); }
}));

test('runGeminiAgent: malformed JSON → null', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const restore = mockFetch({
        ok: true,
        json: async () => ({
            candidates: [{
                content: { parts: [{ text: 'this is not json at all' }] }
            }]
        })
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
    } finally { restore(); }
}));

test('runGeminiAgent: empty extract object still ok (reply composed rule-based)', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live', GEMINI_MODEL: 'gemini-2.5-flash-lite' }, async () => {
    const restore = mockFetch({
        ok: true,
        json: async () => ({
            candidates: [{
                content: { parts: [{ text: JSON.stringify({ city: 'Delhi', insurance: null }) }] }
            }]
        })
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result?.city, 'Delhi');
    } finally { restore(); }
}));

test('runGeminiAgent: fetch throws → null', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const restore = mockFetch(null); // not used; we override directly
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network down'); };
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
    } finally { globalThis.fetch = origFetch; restore(); }
}));

test('modelChain: primary first then all free-tier fallbacks', withEnv({
    GEMINI_API_KEY: 'fake-key',
    BOT_AGENT_MODE: 'live',
    GEMINI_MODEL: 'gemini-2.5-flash-lite',
    AGENT_NO_FALLBACK: undefined,
}, async () => {
    delete process.env.AGENT_NO_FALLBACK;
    const { modelChain } = await loadModule();
    assert.deepEqual(modelChain(), [
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemma-4-26b-a4b-it',
    ]);
}));

test('runGeminiAgent: daily quota on primary tries next model in chain', async () => {
    const { resetForTest } = await import('./agent-quota.js');
    resetForTest();
    const saved = {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        BOT_AGENT_MODE: process.env.BOT_AGENT_MODE,
        GEMINI_MODEL: process.env.GEMINI_MODEL,
        AGENT_NO_FALLBACK: process.env.AGENT_NO_FALLBACK,
    };
    process.env.GEMINI_API_KEY = 'fake-key';
    process.env.BOT_AGENT_MODE = 'live';
    process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';
    delete process.env.AGENT_NO_FALLBACK;
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        calls++;
        if (String(url).includes('gemini-2.5-flash-lite')) {
            return {
                ok: false,
                status: 429,
                text: async () => JSON.stringify({
                    error: {
                        status: 'RESOURCE_EXHAUSTED',
                        message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 1500, model: gemini-2.5-flash-lite GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                    },
                }),
            };
        }
        return {
            ok: true,
            json: async () => ({
                candidates: [{
                    content: { parts: [{ text: JSON.stringify({ city: 'Mumbai' }) }] },
                }],
            }),
        };
    };
    try {
        const { runGeminiAgent, getLastAgentModel } = await loadModule();
        const result = await runGeminiAgent({ message: 'mumbai', history: [] });
        assert.equal(result?.city, 'Mumbai');
        assert.equal(getLastAgentModel(), 'gemini-2.5-flash');
        assert.ok(calls >= 2, 'should call primary then fallback');
    } finally {
        globalThis.fetch = origFetch;
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});

test('runGeminiAgent: strips ```json fences before parsing', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const fenced = '```json\n' + JSON.stringify({ reply: 'fenced reply' }) + '\n```';
    const restore = mockFetch({
        ok: true,
        json: async () => ({
            candidates: [{
                content: { parts: [{ text: fenced }] }
            }]
        })
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.ok(result);
        assert.equal(result.reply, 'fenced reply');
    } finally { restore(); }
}));
