/**
 * Per-model usage + active model per channel (WhatsApp / Operator).
 * Shared Google project — one counter per model id across channels.
 */

import {
    WHATSAPP_MODELS,
    OPERATOR_TEXT_MODELS,
    modelSpecById,
    allTrackedModels,
} from './gemini-channels.js';
import { isGoogleModelExhausted, googleExhaustedModels } from './gemini-model-health.js';

let _date = null;
/** @type {Map<string, number>} */
const _usage = new Map();
/** @type {{ whatsapp: object|null, operator: object|null }} */
const _active = { whatsapp: null, operator: null };

function _today() {
    return new Date().toISOString().slice(0, 10);
}

function _roll() {
    const d = _today();
    if (_date !== d) {
        _date = d;
        _usage.clear();
        _active.whatsapp = null;
        _active.operator = null;
    }
}

function _labelFor(id, fallback = id) {
    return modelSpecById(id)?.label || fallback;
}

export function getModelUsageCount(modelId) {
    _roll();
    return _usage.get(modelId) || 0;
}

/**
 * Record a successful LLM call on a model.
 * @param {string} modelId
 * @param {'whatsapp'|'operator'} channel
 */
export function tickModelRequest(modelId, channel = 'whatsapp') {
    if (!modelId || modelId === 'static' || modelId === 'sql_playbook') return;
    _roll();
    _usage.set(modelId, (_usage.get(modelId) || 0) + 1);
    const spec = modelSpecById(modelId);
    const rpd = spec?.generate_rpd || 1500;
    const used = _usage.get(modelId) || 0;
    _active[channel] = {
        id: modelId,
        label: spec?.label || modelId,
        provider: spec?.provider || (/gemma/i.test(modelId) ? 'gemma' : 'gemini'),
        mode: 'llm',
        used,
        rpd,
        remaining: Math.max(0, rpd - used),
        google_exhausted: isGoogleModelExhausted(modelId),
        at: new Date().toISOString(),
    };
}

/**
 * Record non-LLM path (rule-based, static, sql).
 * @param {'whatsapp'|'operator'} channel
 * @param {string} mode - rule-based | static | sql | error
 * @param {string} [detail]
 */
export function setChannelMode(channel, mode, detail = '') {
    _roll();
    const ch = channel === 'operator' ? 'operator' : 'whatsapp';
    _active[ch] = {
        id: mode,
        label: detail || mode,
        provider: mode,
        mode,
        used: null,
        rpd: null,
        remaining: null,
        google_exhausted: false,
        at: new Date().toISOString(),
    };
}

export function hydrateModelUsage(json) {
    _roll();
    if (!json || typeof json !== 'object') return;
    for (const [id, n] of Object.entries(json)) {
        const count = Number(n);
        if (Number.isFinite(count) && count > 0) _usage.set(id, count);
    }
}

export function serializeModelUsage() {
    _roll();
    return Object.fromEntries(_usage);
}

function _modelRow(spec) {
    const used = _usage.get(spec.id) || 0;
    const rpd = spec.generate_rpd || 1500;
    const googleExhausted = isGoogleModelExhausted(spec.id);
    return {
        id: spec.id,
        label: spec.label,
        provider: spec.provider,
        rpd,
        used,
        remaining: googleExhausted ? 0 : Math.max(0, rpd - used),
        google_exhausted: googleExhausted,
        exhausted: googleExhausted || used >= rpd,
    };
}

/** Per-model counters for dashboard (deduped registry). */
export function modelUsageSnapshot() {
    _roll();
    return allTrackedModels().map(_modelRow);
}

export function activeModelsSnapshot() {
    _roll();
    return {
        whatsapp: _active.whatsapp,
        operator: _active.operator,
    };
}

/** Full client payload — merge into quotaStatusForClient. */
export function modelStatusForClient() {
    return {
        active_models: activeModelsSnapshot(),
        model_usage: modelUsageSnapshot(),
        google_exhausted_models: googleExhaustedModels(),
        fallback_order: allTrackedModels().map((m) => m.id),
    };
}

export function resetModelTrackerForTest() {
    _date = _today();
    _usage.clear();
    _active.whatsapp = null;
    _active.operator = null;
}
