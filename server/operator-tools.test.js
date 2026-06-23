import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractAssigneeName,
    detectStatusFilter,
    classifyOperatorMessage,
    checkFounderRoute,
} from './operator-tools.js';
import { suggestToolsForMessage, getOperatorToolDeclarations } from './operator-playbooks.js';
import { buildOperatorContext } from './operator-tools.js';

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

test('extractAssigneeName for NISHANT phrasing', () => {
    assert.equal(
        extractAssigneeName('TELL ME HOW MANY OPEN LEADS ARE THERE FOR NISHANT'),
        'NISHANT',
    );
    assert.equal(
        extractAssigneeName('how many open leads for nishant that are not lost'),
        'nishant',
    );
});

test('classifyOperatorMessage treats tell-me lead counts as data', () => {
    const msg = 'TELL ME HOW MANY OPEN LEADS ARE THERE FOR NISHANT';
    assert.equal(classifyOperatorMessage(msg), 'data');
});

test('classifyOperatorMessage routes product feedback to feature', () => {
    const msg = 'In the marketing leads there should be more detail, more analysis and more recommendations.';
    assert.equal(classifyOperatorMessage(msg), 'feature');
    assert.equal(classifyOperatorMessage('how many leads assigned to khushi are there?'), 'data');
    assert.equal(classifyOperatorMessage('the bot said wrong power for a customer'), 'bug');
});

test('general CRM questions are not data queries', () => {
    assert.equal(classifyOperatorMessage('what does this crm do ?'), 'general');
    assert.equal(checkFounderRoute('what does this crm do ?').needsFounder, false);
});

test('suggestToolsForMessage hints crm_overview for generic asks', () => {
    const hints = suggestToolsForMessage('what does this crm do?');
    assert.ok(hints.includes('crm_overview'));
});

test('tool declarations respect analytics RBAC', () => {
    const admin = buildOperatorContext('admin', ['analytics', 'chatbot'], {});
    const limited = buildOperatorContext('limited', ['chatbot'], {});
    assert.ok(getOperatorToolDeclarations(admin).some((t) => t.name === 'count_refrens_by_assignee'));
    assert.ok(!getOperatorToolDeclarations(limited).some((t) => t.name === 'count_refrens_by_assignee'));
    assert.ok(getOperatorToolDeclarations(limited).some((t) => t.name === 'crm_overview'));
});
