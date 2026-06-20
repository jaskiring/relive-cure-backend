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
        try { return await fn(); }
        finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
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

test('runGeminiAgent: HTTP 429 → null', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const restore = mockFetch({
        ok: false,
        status: 429,
        text: async () => '{"error":{"message":"quota exceeded"}}'
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
    } finally { restore(); }
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

test('runGeminiAgent: empty reply → null', withEnv({ GEMINI_API_KEY: 'fake-key', BOT_AGENT_MODE: 'live' }, async () => {
    const restore = mockFetch({
        ok: true,
        json: async () => ({
            candidates: [{
                content: { parts: [{ text: JSON.stringify({ reply: '' }) }] }
            }]
        })
    });
    try {
        const { runGeminiAgent } = await loadModule();
        const result = await runGeminiAgent({ message: 'hi', history: [] });
        assert.equal(result, null);
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
