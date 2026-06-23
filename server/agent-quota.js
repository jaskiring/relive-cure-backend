// server/agent-quota.js
// Persists Gemini daily counters to Supabase (survives Railway redeploys).
// Channels: whatsapp (customer bot — highest priority), operator (CRM AI), operator_transcribe (voice).

import {
    CHANNEL_BUDGETS,
    WHATSAPP_MODELS,
    OPERATOR_TEXT_MODELS,
    OPERATOR_TRANSCRIBE_MODELS,
    modelIds,
    appCapForModels,
    quotaRegistry,
} from './gemini-channels.js';
import { googleExhaustedModels } from './gemini-model-health.js';
import { hydrateModelUsage, serializeModelUsage, modelStatusForClient } from './gemini-model-tracker.js';

const LEGACY_DAILY_CAP = 1200;
/** App caps derived from model RPD in gemini-channels.js (see docs/GEMINI_QUOTA.md). */
const DEFAULT_DAILY_CAP = appCapForModels(WHATSAPP_MODELS);
const DEFAULT_OPERATOR_CAP = appCapForModels(OPERATOR_TEXT_MODELS);
/** No app cap on transcribe by default — Google free-tier (incl. unlimited audio rows) is the limit. */
const UNLIMITED_CAP = Number.MAX_SAFE_INTEGER;

function isUnlimitedCap(cap) {
    return cap >= UNLIMITED_CAP / 2;
}

const CHANNELS = ['whatsapp', 'operator', 'operator_transcribe'];

function emptyBucket() {
    return { count: 0, fallbacks: 0, tokens_prompt: 0, tokens_output: 0, tokens_thinking: 0, tokens_total: 0 };
}

let _mem = { date: null, whatsapp: emptyBucket(), operator: emptyBucket(), operator_transcribe: emptyBucket() };
let _writeTimer = null;
let _hydrateOk = false;
let _testCap = null;
let _testCapByChannel = null;
let _supabase = null;
const _dailyExhausted = new Set();

function _today() { return new Date().toISOString().slice(0, 10); }

function _normChannel(channel) {
    return CHANNELS.includes(channel) ? channel : 'whatsapp';
}

function _cap(channel = 'whatsapp') {
    const ch = _normChannel(channel);
    if (_testCapByChannel?.[ch] != null) return _testCapByChannel[ch];
    if (_testCap !== null && ch === 'whatsapp') return _testCap;
    if (ch === 'operator') {
        const n = parseInt(process.env.GEMINI_OPERATOR_DAILY_CAP || '', 10);
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_OPERATOR_CAP;
    }
    if (ch === 'operator_transcribe') {
        const raw = (process.env.GEMINI_TRANSCRIBE_DAILY_CAP || '').trim().toLowerCase();
        if (raw === '0' || raw === 'unlimited' || raw === 'off') return UNLIMITED_CAP;
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) return n;
        return UNLIMITED_CAP;
    }
    const n = parseInt(process.env.GEMINI_DAILY_CAP || '', 10);
    if (Number.isFinite(n) && n > 0) {
        if (n <= LEGACY_DAILY_CAP) return DEFAULT_DAILY_CAP;
        return n;
    }
    return DEFAULT_DAILY_CAP;
}

async function _db() {
    if (_supabase) return _supabase;
    const mod = await import('./supabase-admin.js');
    _supabase = mod.supabaseAdmin;
    return _supabase;
}

function _setCapForTest(n) { _testCap = n; }
function _setCapForChannelTest(channel, n) {
    if (!_testCapByChannel) _testCapByChannel = {};
    _testCapByChannel[_normChannel(channel)] = n;
}

function resetForTest() {
    _mem = { date: _today(), whatsapp: emptyBucket(), operator: emptyBucket(), operator_transcribe: emptyBucket() };
    _writeTimer = null;
    _hydrateOk = true;
    _dailyExhausted.clear();
}

/** Load today's counters from Supabase (retries until first success). */
export async function ensureQuotaHydrated() {
    if (_hydrateOk) return;
    await hydrateQuota();
}

export async function hydrateQuota() {
    if (_hydrateOk) return;
    try {
        const today = _today();
        const db = await _db();
        const full = await db
            .from('agent_quota')
            .select('date, request_count, fallback_count, tokens_prompt, tokens_output, tokens_thinking, tokens_total, operator_request_count, operator_fallback_count, operator_tokens_total, transcribe_request_count, transcribe_tokens_total, model_usage_json')
            .eq('date', today)
            .maybeSingle();

        let data = full.data;
        let error = full.error;

        if (error && /operator_request_count|column/i.test(error.message || '')) {
            console.warn('[AGENT-QUOTA] channel columns missing — run alter_agent_quota_channels.sql');
            const legacy = await db
                .from('agent_quota')
                .select('date, request_count, fallback_count, tokens_prompt, tokens_output, tokens_thinking, tokens_total')
                .eq('date', today)
                .maybeSingle();
            data = legacy.data;
            error = legacy.error;
        }

        if (error) {
            console.warn('[AGENT-QUOTA] hydrate failed:', error.message);
            _mem.date = today;
            _hydrateOk = true;
            return;
        }
        if (data) {
            _mem = {
                date: data.date,
                whatsapp: {
                    count: data.request_count || 0,
                    fallbacks: data.fallback_count || 0,
                    tokens_prompt: data.tokens_prompt || 0,
                    tokens_output: data.tokens_output || 0,
                    tokens_thinking: data.tokens_thinking || 0,
                    tokens_total: data.tokens_total || 0,
                },
                operator: {
                    count: data.operator_request_count || 0,
                    fallbacks: data.operator_fallback_count || 0,
                    tokens_prompt: 0,
                    tokens_output: 0,
                    tokens_thinking: 0,
                    tokens_total: data.operator_tokens_total || 0,
                },
                operator_transcribe: {
                    count: data.transcribe_request_count || 0,
                    fallbacks: 0,
                    tokens_prompt: 0,
                    tokens_output: 0,
                    tokens_thinking: 0,
                    tokens_total: data.transcribe_tokens_total || 0,
                },
            };
            console.log(`[AGENT-QUOTA] hydrated ${_mem.date} → WA ${_mem.whatsapp.count}/${_cap('whatsapp')} · OP ${_mem.operator.count}/${_cap('operator')} · TX ${_mem.operator_transcribe.count}`);
            if (data.model_usage_json) hydrateModelUsage(data.model_usage_json);
        } else {
            _mem = { date: today, whatsapp: emptyBucket(), operator: emptyBucket(), operator_transcribe: emptyBucket() };
        }
        _hydrateOk = true;
    } catch (e) {
        console.warn('[AGENT-QUOTA] hydrate error:', e.message);
    }
}

function _bucket(channel) {
    const ch = _normChannel(channel);
    if (!_mem[ch]) _mem[ch] = emptyBucket();
    return _mem[ch];
}

function _rollDateIfNeeded() {
    const d = _today();
    if (_mem.date !== d) {
        _mem = { date: d, whatsapp: emptyBucket(), operator: emptyBucket(), operator_transcribe: emptyBucket() };
        _dailyExhausted.clear();
        _hydrateOk = false;
    }
}

export function isUnderQuota(channel = 'whatsapp') {
    _rollDateIfNeeded();
    const ch = _normChannel(channel);
    if (_dailyExhausted.has(ch)) return false;
    const b = _bucket(ch);
    const under = b.count < _cap(ch);
    if (!under) _dailyExhausted.add(ch);
    return under;
}

export function tickRequest(channel = 'whatsapp') {
    _rollDateIfNeeded();
    _bucket(channel).count += 1;
    _scheduleWrite();
}

export function tickTokens(usage = {}, channel = 'whatsapp') {
    _rollDateIfNeeded();
    const b = _bucket(channel);
    const prompt = Number(usage.promptTokenCount) || 0;
    const output = Number(usage.candidatesTokenCount) || 0;
    const thinking = Number(usage.thoughtsTokenCount) || 0;
    const total = Number(usage.totalTokenCount) || (prompt + output + thinking);
    b.tokens_prompt += prompt;
    b.tokens_output += output;
    b.tokens_thinking += thinking;
    b.tokens_total += total;
    _scheduleWrite();
}

export function tickFallback(channel = 'whatsapp') {
    _rollDateIfNeeded();
    _bucket(channel).fallbacks += 1;
    _scheduleWrite();
}

export function quotaStatus(channel = 'whatsapp') {
    _rollDateIfNeeded();
    const ch = _normChannel(channel);
    const b = _bucket(ch);
    const cap = _cap(ch);
    const unlimited = isUnlimitedCap(cap);
    return {
        channel: ch,
        date: _mem.date || _today(),
        count: b.count,
        cap: unlimited ? null : cap,
        unlimited,
        fallbacks: b.fallbacks,
        remaining: unlimited ? null : Math.max(0, cap - b.count),
        tokens: {
            prompt: b.tokens_prompt,
            output: b.tokens_output,
            thinking: b.tokens_thinking,
            total: b.tokens_total,
        },
    };
}

export function quotaStatusAll() {
    return {
        whatsapp: quotaStatus('whatsapp'),
        operator: quotaStatus('operator'),
        operator_transcribe: quotaStatus('operator_transcribe'),
    };
}

/** Client payloads — per-model usage + active model per channel. */
export function quotaStatusForClient() {
    return {
        ...quotaStatusAll(),
        ...modelStatusForClient(),
    };
}

/** Dashboard-friendly: two independent budgets + models per channel. */
export function quotaDashboard() {
    const all = quotaStatusAll();
    const registry = quotaRegistry();
    return {
        independent_budgets: true,
        registry_version: registry.version,
        verify_url: registry.verify_url,
        docs: registry.docs,
        google_exhausted_models: googleExhaustedModels(),
        channels: {
            whatsapp: {
                ...CHANNEL_BUDGETS.whatsapp,
                defaultCap: CHANNEL_BUDGETS.whatsapp.defaultCap,
                google_rpd_max: CHANNEL_BUDGETS.whatsapp.googleRpdMax(),
                ...all.whatsapp,
                models: WHATSAPP_MODELS,
            },
            operator: {
                ...CHANNEL_BUDGETS.operator,
                defaultCap: CHANNEL_BUDGETS.operator.defaultCap,
                google_rpd_max: CHANNEL_BUDGETS.operator.googleRpdMax(),
                ...all.operator,
                models: OPERATOR_TEXT_MODELS,
            },
            operator_transcribe: {
                ...CHANNEL_BUDGETS.operator_transcribe,
                google_rpd_max: CHANNEL_BUDGETS.operator_transcribe.googleRpdMax(),
                ...all.operator_transcribe,
                models: OPERATOR_TRANSCRIBE_MODELS,
            },
        },
        live_audio_models: registry.live_audio_models,
        grounding: registry.grounding,
    };
}

function _scheduleWrite() {
    if (_testCap !== null || _testCapByChannel) return;
    clearTimeout(_writeTimer);
    _writeTimer = setTimeout(_flush, 500);
}

async function flushQuota() {
    clearTimeout(_writeTimer);
    if (_testCap !== null || _testCapByChannel) return;
    const total = CHANNELS.reduce((n, ch) => n + _bucket(ch).count, 0);
    if (total === 0 && _mem.whatsapp.fallbacks === 0 && _mem.operator.fallbacks === 0) return;
    await _flush();
}

if (typeof process !== 'undefined' && !process._quotaShutdownRegistered) {
    process._quotaShutdownRegistered = true;
    const shutdown = async () => { await flushQuota(); process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('beforeExit', () => { _flush(); });
}

async function _flush() {
    try {
        const db = await _db();
        const wa = _mem.whatsapp;
        const op = _mem.operator;
        const tx = _mem.operator_transcribe;
        const row = {
            date: _mem.date,
            request_count: wa.count,
            fallback_count: wa.fallbacks,
            tokens_prompt: wa.tokens_prompt,
            tokens_output: wa.tokens_output,
            tokens_thinking: wa.tokens_thinking,
            tokens_total: wa.tokens_total,
            operator_request_count: op.count,
            operator_fallback_count: op.fallbacks,
            operator_tokens_total: op.tokens_total,
            transcribe_request_count: tx.count,
            transcribe_tokens_total: tx.tokens_total,
            model_usage_json: serializeModelUsage(),
            updated_at: new Date().toISOString(),
        };
        let { error } = await db.from('agent_quota').upsert(row, { onConflict: 'date' });
        if (error && /operator_request_count|column/i.test(error.message || '')) {
            const { error: e2 } = await db.from('agent_quota').upsert({
                date: row.date,
                request_count: row.request_count,
                fallback_count: row.fallback_count,
                tokens_prompt: row.tokens_prompt,
                tokens_output: row.tokens_output,
                tokens_thinking: row.tokens_thinking,
                tokens_total: row.tokens_total,
                updated_at: row.updated_at,
            }, { onConflict: 'date' });
            error = e2;
        }
        if (error) console.warn('[AGENT-QUOTA] write failed:', error.message);
    } catch (e) {
        console.warn('[AGENT-QUOTA] write error:', e.message);
    }
}

export { _setCapForTest, _setCapForChannelTest, resetForTest, flushQuota };
