// server/agent-quota.test.js
// Uses Node's built-in test runner (no new dependency).
// Run: node --test server/agent-quota.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetForTest, isUnderQuota, tickRequest, tickFallback, tickTokens, quotaStatus, _setCapForTest } from './agent-quota.js';

function setup() {
    resetForTest();
    _setCapForTest(5); // small cap for predictable tests
}

test('isUnderQuota starts true', () => {
    setup();
    assert.equal(isUnderQuota(), true);
});

test('tickRequest decrements remaining quota', () => {
    setup();
    for (let i = 0; i < 5; i++) tickRequest();
    assert.equal(isUnderQuota(), false, 'should be over cap after 5 ticks');
});

test('quotaStatus reports count and cap', () => {
    setup();
    tickRequest();
    tickRequest();
    const s = quotaStatus();
    assert.equal(s.count, 2);
    assert.equal(s.cap, 5);
    assert.equal(s.fallbacks, 0);
});

test('tickFallback increments fallbacks', () => {
    setup();
    tickFallback();
    tickFallback();
    assert.equal(quotaStatus().fallbacks, 2);
});

test('quota resets when resetForTest is called', () => {
    setup();
    for (let i = 0; i < 5; i++) tickRequest();
    assert.equal(isUnderQuota(), false);
    resetForTest();
    assert.equal(isUnderQuota(), true);
});

test('tickTokens accumulates usageMetadata totals', () => {
    setup();
    tickTokens({ promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 10, totalTokenCount: 160 });
    tickTokens({ promptTokenCount: 200, candidatesTokenCount: 80, totalTokenCount: 280 });
    const s = quotaStatus();
    assert.equal(s.tokens.prompt, 300);
    assert.equal(s.tokens.output, 130);
    assert.equal(s.tokens.thinking, 10);
    assert.equal(s.tokens.total, 440);
});

test('quotaStatus includes remaining calls', () => {
    setup();
    tickRequest();
    const s = quotaStatus();
    assert.equal(s.remaining, 4);
});

test('tickRequest does not trigger Supabase write in test mode', () => {
    setup();
    // If this throws or hangs, the test cap guard isn't working.
    tickRequest();
    tickRequest();
    tickRequest();
    assert.equal(quotaStatus().count, 3);
});
