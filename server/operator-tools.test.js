import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAssigneeName, detectStatusFilter, classifyOperatorMessage } from './operator-tools.js';

test('extractAssigneeName from assigned-to phrasing', () => {
    assert.equal(
        extractAssigneeName('how many leads assigned to khushi are there?'),
        'khushi',
    );
    assert.equal(
        extractAssigneeName('total assigned to khushi that are open or not lost'),
        'khushi',
    );
});

test('extractAssigneeName from for/of phrasing', () => {
    assert.equal(extractAssigneeName('count open leads for Khushi Tomar'), 'Khushi Tomar');
});

test('detectStatusFilter', () => {
    assert.equal(detectStatusFilter('open or not lost'), 'not_lost');
    assert.equal(detectStatusFilter('how many open leads'), 'open');
    assert.equal(detectStatusFilter('lost leads for rahul'), 'lost');
    assert.equal(detectStatusFilter('converted deals'), 'converted');
    assert.equal(detectStatusFilter('how many total'), null);
});

test('classifyOperatorMessage routes product feedback to feature', () => {
    const msg = 'In the marketing leads there should be more detail, more analysis and more recommendations.';
    assert.equal(classifyOperatorMessage(msg), 'feature');
    assert.equal(classifyOperatorMessage('how many leads assigned to khushi are there?'), 'data');
    assert.equal(classifyOperatorMessage('the bot said wrong power for a customer'), 'bug');
});
