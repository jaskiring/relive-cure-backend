// server/bot-guard.test.js
// Run: node --test server/bot-guard.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isIndianCity,
    titleCaseCity,
    isInventedAgentClaim,
    hasLocationIntent,
    LOCATION_REPLY,
} from './bot-guard.js';

test('isIndianCity: rejects city names used as names (Dinesh case)', () => {
    assert.equal(isIndianCity('Hyderabad'), true);
    assert.equal(isIndianCity('Hyderabad ,Telangana'), true);
    assert.equal(isIndianCity('Delhi'), true);
    assert.equal(isIndianCity('Dinesh'), false);
    assert.equal(isIndianCity('Rahul'), false);
});

test('titleCaseCity: normalizes city strings', () => {
    assert.equal(titleCaseCity('hyderabad'), 'Hyderabad');
    assert.equal(titleCaseCity('Hyderabad ,Telangana'), 'Hyderabad Telangana');
});

test('hasLocationIntent: branch/location questions', () => {
    assert.equal(hasLocationIntent('Where is your location'), true);
    assert.equal(hasLocationIntent('Where is your branch in Hyderabad'), true);
    assert.equal(hasLocationIntent('Pickup,drop available'), false);
    assert.equal(hasLocationIntent('Lasik'), false);
});

test('isInventedAgentClaim: blocks production bad replies (918328590366)', () => {
    const bad = [
        'We have a branch in Hyderabad! How can I help?',
        'We have a branch in Hyderabad to serve you!',
        'Yes, we offer pickup and drop services for your convenience in Hyderabad.',
        'Yes, your eye valuation is free!',
    ];
    for (const reply of bad) {
        assert.equal(isInventedAgentClaim(reply), true, `should block: ${reply.slice(0, 50)}`);
    }
    const ok = [
        LOCATION_REPLY.EN,
        'Our specialist can give you a detailed assessment. Shall I connect you?',
        'LASIK starts ₹15,000–₹90,000 depending on technology.',
    ];
    for (const reply of ok) {
        assert.equal(isInventedAgentClaim(reply), false, `should allow: ${reply.slice(0, 50)}`);
    }
});

test('Dinesh regression: name vs city', () => {
    assert.equal(isIndianCity('Hyderabad'), true);
    assert.equal(isIndianCity('Dinesh'), false);
    assert.equal(hasLocationIntent('Where is your branch'), true);
    assert.equal(isInventedAgentClaim('We have a branch in Hyderabad!'), true);
});
