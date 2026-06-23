import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractAssigneeName,
    extractCityFromMessage,
    normalizeDataQuestion,
    detectStatusFilter,
    classifyOperatorMessage,
    checkFounderRoute,
    staticGeneralReply,
    staticOperatorReply,
    isMarketingDataQuestion,
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

test('extractAssigneeName for hold/has phrasing', () => {
    assert.equal(
        extractAssigneeName('How many needs does Nishikant hold that are from Mumbai?'),
        'Nishikant',
    );
    assert.equal(
        extractAssigneeName('how many leads does Khushi have in Delhi'),
        'Khushi',
    );
});

test('extractCityFromMessage', () => {
    assert.equal(
        extractCityFromMessage('How many needs does Nishikant hold that are from Mumbai?'),
        'Mumbai',
    );
    assert.equal(extractCityFromMessage('open leads in pune for khushi'), 'Pune');
    assert.equal(extractCityFromMessage('how many leads in delhi'), 'Delhi');
});

test('normalizeDataQuestion fixes needs typo', () => {
    assert.match(
        normalizeDataQuestion('How many needs does Nishikant hold'),
        /how many leads does Nishikant hold/i,
    );
});

test('classifyOperatorMessage treats assignee+city counts as data', () => {
    const msg = 'How many needs does Nishikant hold that are from Mumbai?';
    assert.equal(classifyOperatorMessage(msg), 'data');
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

test('staticGeneralReply handles greetings without Gemini', () => {
    const reply = staticGeneralReply('What can you help me with today?', buildOperatorContext('admin', ['analytics'], {}));
    assert.ok(reply);
    assert.match(reply, /live CRM/i);
    assert.match(reply, /sent for admin approval/i);
    const how = staticGeneralReply('how are you', buildOperatorContext('admin', ['analytics'], {}));
    assert.ok(how);
});

test('staticOperatorReply uses sent-for-approval copy for features', () => {
    const reply = staticOperatorReply('feature', { needsFounder: true, kind: 'feature' }, null);
    assert.match(reply, /sent for approval/i);
});

test('suggestToolsForMessage hints crm_overview for generic asks', () => {
    const hints = suggestToolsForMessage('what does this crm do?');
    assert.ok(hints.includes('crm_overview'));
});

test('classifyOperatorMessage treats marketing campaign performance as data', () => {
    const msg = 'i want to know what marketing campaign is working best right now';
    assert.equal(classifyOperatorMessage(msg), 'data');
    assert.ok(isMarketingDataQuestion(msg));
    const hints = suggestToolsForMessage(msg);
    assert.ok(hints.includes('rank_marketing_campaigns'));
});

test('tool declarations respect marketing RBAC', () => {
    const marketing = buildOperatorContext('limited', ['marketing'], {});
    const noMkt = buildOperatorContext('limited', ['chatbot'], {});
    assert.ok(getOperatorToolDeclarations(marketing).some((t) => t.name === 'rank_marketing_campaigns'));
    assert.ok(!getOperatorToolDeclarations(noMkt).some((t) => t.name === 'rank_marketing_campaigns'));
});

test('tool declarations respect analytics RBAC', () => {
    const admin = buildOperatorContext('admin', ['analytics', 'chatbot'], {});
    const limited = buildOperatorContext('limited', ['chatbot'], {});
    assert.ok(getOperatorToolDeclarations(admin).some((t) => t.name === 'count_refrens_by_assignee'));
    assert.ok(!getOperatorToolDeclarations(limited).some((t) => t.name === 'count_refrens_by_assignee'));
    assert.ok(getOperatorToolDeclarations(limited).some((t) => t.name === 'crm_overview'));
});
