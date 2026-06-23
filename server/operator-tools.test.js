import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAssigneeName, detectStatusFilter } from './operator-tools.js';

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
