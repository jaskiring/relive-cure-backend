// server/llm-agent.js
// Google AI agent for the WhatsApp bot (Gemini Flash-Lite primary, Gemma fallback).
//
// Ships dark: requires GEMINI_API_KEY + BOT_AGENT_MODE in {shadow, live}.
// On any failure (timeout, 429, malformed JSON, network, quota), returns null
// and the caller falls back to the rule-based state machine.
//
// Activation (Railway env vars):
//   GEMINI_API_KEY    = <AI Studio key>                    (required)
//   BOT_AGENT_MODE    = shadow | live                      (required to enable)
//   GEMINI_MODEL      = gemini-2.5-flash-lite              (default; ~1.5k free RPD, ~2s)
//   GEMINI_DAILY_CAP  = 5600                               (4 models × ~1.4k buffer)
//
// Model chain (auto-fallback on daily 429): each model has its own ~1,500 RPD pool on
// AI Studio free tier when billing is linked (see ai.google.dev/rate-limits).
// LLM only extracts fields — WhatsApp replies are composed rule-based in index.js.

import { isUnderQuota, tickRequest, tickFallback, tickTokens, quotaStatus } from './agent-quota.js';

/** Free-tier models ordered fastest-first. Each has a separate daily request pool. */
export const FREE_TIER_MODELS = [
    { id: 'gemini-2.5-flash-lite', rpd: 1500, provider: 'gemini', label: 'Flash-Lite' },
    { id: 'gemini-2.5-flash', rpd: 1500, provider: 'gemini', label: 'Flash' },
    { id: 'gemini-2.0-flash', rpd: 1500, provider: 'gemini', label: 'Flash 2.0' },
    { id: 'gemma-4-26b-a4b-it', rpd: 1500, provider: 'gemma', label: 'Gemma' },
];

const PRIMARY_MODEL = FREE_TIER_MODELS[0].id;
const DEFAULT_MODEL = PRIMARY_MODEL;
const FREE_TIER_RPD_PER_MODEL = 1500;
const GEMINI_TIMEOUT_MS = 8000;
const GEMMA_TIMEOUT_MS = 12000;
const RATE_LIMIT_RETRY_MS = 1500;
const RATE_LIMIT_BACKOFF_MS = 5000;

/** Skip models that already hit Google daily quota today (avoids 3× dead calls before Gemma). */
let _exhaustedDate = null;
const _exhaustedModels = new Set();

function _todayKey() { return new Date().toISOString().slice(0, 10); }

function markModelDailyExhausted(model) {
    const d = _todayKey();
    if (_exhaustedDate !== d) {
        _exhaustedDate = d;
        _exhaustedModels.clear();
    }
    _exhaustedModels.add(model);
}

function isModelDailyExhausted(model) {
    if (_exhaustedDate !== _todayKey()) return false;
    return _exhaustedModels.has(model);
}

function activeModelChain() {
    return modelChain().filter((m) => !isModelDailyExhausted(m));
}

function isGemmaModel(model) {
    return /gemma/i.test(model || '');
}

export function modelChain() {
    const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    if (process.env.AGENT_NO_FALLBACK === '1') return [primary];
    const chain = [primary];
    for (const { id } of FREE_TIER_MODELS) {
        if (!chain.includes(id)) chain.push(id);
    }
    return chain;
}

export function freeTierCapacity() {
    const chain = modelChain();
    const models = chain.map((id) => {
        const meta = FREE_TIER_MODELS.find((m) => m.id === id);
        return { id, rpd: meta?.rpd ?? FREE_TIER_RPD_PER_MODEL, provider: meta?.provider ?? 'gemini', label: meta?.label ?? id };
    });
    return {
        models,
        rpd_per_model: FREE_TIER_RPD_PER_MODEL,
        total_rpd: models.length * FREE_TIER_RPD_PER_MODEL,
    };
}

function requestTimeoutMs(model) {
    return isGemmaModel(model) ? GEMMA_TIMEOUT_MS : GEMINI_TIMEOUT_MS;
}

function isGoogleDailyQuota429(status, errText) {
    if (status !== 429) return false;
    const t = errText || '';
    // Per-model daily pool exhausted — try next model in chain (not transient RPM).
    return /GenerateRequestsPerDay|free_tier_requests|PerDayPerProjectPerModel/i.test(t);
}

// Circuit breaker: after repeated 429s, back off briefly (Gemini free tier ~5 RPM).
let _backoffUntil = 0;  // epoch ms — short backoff for 429
let _lastFailReason = null;
let _lastModelUsed = null;

export function getLastAgentFailReason() {
    return _lastFailReason;
}

export function getLastAgentModel() {
    return _lastModelUsed;
}

function _fail(reason) {
    _lastFailReason = reason;
    return null;
}

function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Runtime mode override — set via POST /api/agent/mode from the dashboard.
// When set, it takes priority over the BOT_AGENT_MODE env var.
let _runtimeMode = null;  // 'shadow' | 'live' | 'off' | null (null = use env var)

export function isAgentEnabled() {
    if (_runtimeMode === 'off') return false;
    const mode = _runtimeMode || process.env.BOT_AGENT_MODE || 'live';
    return !!process.env.GEMINI_API_KEY && (mode === 'shadow' || mode === 'live');
}

export function agentMode() {
    if (!isAgentEnabled()) return null;
    return _runtimeMode || process.env.BOT_AGENT_MODE || 'live';
}

export function setAgentMode(mode) {
    if (mode === 'shadow' || mode === 'live' || mode === 'off') {
        _runtimeMode = mode;
        console.log(`[AGENT] mode set to "${mode}" via API`);
        return true;
    }
    return false;
}

export function agentStatus() {
    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const chain = modelChain();
    const capacity = freeTierCapacity();
    return {
        enabled: isAgentEnabled(),
        mode: agentMode(),
        model,
        provider: isGemmaModel(model) ? 'gemma' : 'gemini',
        model_chain: chain,
        fallback_model: chain[1] || null,
        fallback_chain: chain.slice(1),
        free_tier: capacity,
        exhausted_models: [..._exhaustedModels],
        last_model: _lastModelUsed,
        quota: quotaStatus(),
    };
}

// --- System prompt: clean, focused, context-aware -----------------------------
const SYSTEM_PROMPT = `You are Relive Cure's WhatsApp assistant — a friendly, smart helper for people interested in LASIK / vision correction.

═══ RULE #1: NEVER ASK WHAT YOU ALREADY KNOW ═══
Before asking ANY question, read the conversation history. If the user already told you something, DO NOT ask it again.
- They said "gurgaon" → don't ask their city.
- They said "-4 both eyes" → don't ask their eye power.
- You know their name → don't ask what to call them.
Asking again makes you sound robotic and forgetful. Always check history first.

═══ HOW YOU HELP ═══
1. Answer only what you know from FACTS below — do not guess or assume services, branches, or offers.
2. If you CAN answer (cost, recovery, pain, safety, eligibility) → answer in 1–2 short sentences.
3. If you CANNOT answer (location, branch, address, exact pricing, personal eligibility) → say our sales specialist will call with details. Do NOT invent clinic names, branches, pickup/drop, or free tests.
4. After answering, collect missing details one at a time in this order: city → eye power → (power stability if high power) → medical insurance. Never ask for name first.
5. When they want a callback and you have city + eye power + insurance → confirm a specialist will reach out.

═══ LOCATION / BRANCH / ADDRESS (CRITICAL) ═══
- NEVER say "we have a branch/clinic in [city]" or give an address.
- NEVER confirm pickup, drop, transport, or facility services unless explicitly in FACTS (they are NOT).
- For "where is your location/branch/clinic" → reply: "Our sales specialist will call you shortly with all the details 😊"
- If you don't know their city yet, you may ask which city they're in — once only.

═══ CONVERSATION FLOW ═══
- Answer their question FIRST. Never open with "What should I call you?" or block on name.
- Do NOT ask for name on the first message. Collect name passively (they say "I'm X") or when confirming a callback.
- After your answer, end with ONE short question if details are missing: city → eye power → insurance (in that order). Never both city and power in one message.
- Ask for city ONCE only if unknown. Then eye power ONCE. Then medical insurance ONCE (yes/no).
- Do NOT re-ask anything already in [ALREADY COLLECTED] or conversation history.
- A city name (e.g. Hyderabad, Delhi) is NEVER a person's name.
- After callback offered → confirm specialist will reach out. DO NOT ask "what time?".

═══ STYLE ═══
- MAX 2 short sentences. Plain text only — no markdown, bullets, or lists.
- Match their language. Warm but brief — not chatty, not salesy.
- Do not volunteer extra services or promises.

═══ FACTS YOU CAN STATE ═══
- Cost: LASIK starts ₹15,000–₹90,000 depending on technology. Exact cost in free consultation.
- Recovery: vision clears 3–12 hours, normal routine next day, full recovery 1–2 weeks.
- Pain: nearly painless — numbing drops, mild pressure for seconds, mild irritation for hours.
- Eligibility: stable power 1+ year, age 18+, healthy eyes. Specialist confirms in consultation.
- Safety: one of the safest procedures, 98%+ success, 10–15 min, no general anaesthesia.
- Referral: earn ₹1,000 per surgery referred.

═══ HARD RULES ═══
- NOT a doctor. Never diagnose or promise results. For personal questions → route to specialist.
- Never invent numbers, branches, addresses, transport, or offers beyond the facts above.
- NEVER claim pickup/drop, free eye valuation, or a branch in any city — sales specialist shares details on call.
- CATARACT ≠ LASIK. If cataract mentioned → acknowledge it's different, specialist will guide. Set is_cataract = true.
- You CANNOT see images. Ask them to type instead.
- Stay on vision/eyes/LASIK. Off-topic → gently redirect.
- Callback offered → confirm specialist will reach out. Never ask "what time?".
- DO NOT offer callback on every message. Only when they ask for a call OR you have city + eye power + insurance.

═══ EXTRACTION (report alongside your reply) ═══
Only extract what the user ACTUALLY SAID in THIS message. If they didn't mention it, set it null/false.

- name: ONLY if they explicitly said "my name is X", "call me X", "mera naam X hai". NOT a city name. NOT "I am from X".
- city: their city if they stated it.
- eye_power: format "R:-X L:-Y" if both eyes, single number like "-2.5" if one, "high" if no number. Assume minus for glasses unless they say plus.
- timeline: when they want surgery ("this month", "asap"), else null.
- insurance: true if they have medical/health insurance, false if they said no, null if not mentioned.
- previous_surgery: any prior eye surgery mentioned.
- age_group: their age as a number if stated.
- willing_to_travel: true if they ask about visiting another city for surgery.
- asks_cost / asks_recovery / asks_pain / asks_safety: true if THIS message asks about that.
- power_concern: true if they mention weak vision / blur / can't see without glasses.
- wants_callback: true if they want a call or specialist consultation.
- is_cataract: true if cataract/motiyabind/white-in-eye mentioned.

Always return the JSON. "reply" is the WhatsApp message to send.`;

/** Short prompt for Gemma — extraction only; reply text is composed rule-based in index.js */
const EXTRACT_PROMPT = `Extract LASIK lead fields from the WhatsApp message. Return ONE JSON object only.
Fields (null/false if not stated): name, city, eye_power, timeline, insurance (bool), previous_surgery, age_group (number), willing_to_travel (bool), asks_cost, asks_recovery, asks_pain, asks_safety, power_concern, wants_callback, is_cataract (bool).
Always include "reply": "." (ignored).
Example: {"reply":".","city":null,"insurance":null,"asks_cost":false}`;

const GEMMA_JSON_SUFFIX = `

OUTPUT: One JSON object only. "reply" MUST be a plain string (the WhatsApp message), not an object.
Example: {"reply":"Hi! LASIK starts from ₹15,000. Which city are you in?","city":null,"insurance":null}
No markdown, no thinking text, no extra keys beyond the schema fields.`;

/** Extraction-only schema — replies are composed rule-based in index.js */
const EXTRACT_SCHEMA = {
    type: 'OBJECT',
    properties: {
        name: { type: 'STRING', nullable: true },
        city: { type: 'STRING', nullable: true },
        eye_power: { type: 'STRING', nullable: true },
        timeline: { type: 'STRING', nullable: true },
        insurance: { type: 'BOOLEAN', nullable: true },
        previous_surgery: { type: 'STRING', nullable: true },
        age_group: { type: 'NUMBER', nullable: true },
        willing_to_travel: { type: 'BOOLEAN', nullable: true },
        asks_cost: { type: 'BOOLEAN', nullable: true },
        asks_recovery: { type: 'BOOLEAN', nullable: true },
        asks_pain: { type: 'BOOLEAN', nullable: true },
        asks_safety: { type: 'BOOLEAN', nullable: true },
        power_concern: { type: 'BOOLEAN', nullable: true },
        wants_callback: { type: 'BOOLEAN', nullable: true },
        is_cataract: { type: 'BOOLEAN', nullable: true },
    },
};

const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        reply: { type: 'STRING' },
        name: { type: 'STRING', nullable: true },
        city: { type: 'STRING', nullable: true },
        eye_power: { type: 'STRING', nullable: true },
        timeline: { type: 'STRING', nullable: true },
        insurance: { type: 'BOOLEAN' },
        previous_surgery: { type: 'STRING', nullable: true },
        age_group: { type: 'NUMBER', nullable: true },
        willing_to_travel: { type: 'BOOLEAN' },
        asks_cost: { type: 'BOOLEAN' },
        asks_recovery: { type: 'BOOLEAN' },
        asks_pain: { type: 'BOOLEAN' },
        asks_safety: { type: 'BOOLEAN' },
        power_concern: { type: 'BOOLEAN' },
        wants_callback: { type: 'BOOLEAN' },
        is_cataract: { type: 'BOOLEAN' },
    },
    required: ['reply'],
};

function extractCandidateText(cand) {
    const parts = cand?.content?.parts || [];
    const visible = parts.filter(p => p.text && !p.thought).map(p => p.text);
    if (visible.length) return visible.join('').trim();
    return parts.map(p => p.text || '').join('').trim();
}

function parseAgentJson(raw) {
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try {
        let obj = JSON.parse(cleaned);
        if (Array.isArray(obj) && obj[0] && typeof obj[0] === 'object') obj = obj[0];
        return obj;
    } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error('no json object');
    }
}

function buildRequestBody(model, contents) {
    const gemma = isGemmaModel(model);
    const generationConfig = {
        temperature: 0.2,
        maxOutputTokens: gemma ? 160 : 128,
        responseMimeType: 'application/json',
        responseSchema: EXTRACT_SCHEMA,
    };
    if (gemma) {
        generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
    } else {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    return {
        systemInstruction: {
            parts: [{ text: EXTRACT_PROMPT }],
        },
        contents,
        generationConfig,
    };
}

function failReasonPrefix(model) {
    return isGemmaModel(model) ? 'gemma' : 'gemini';
}

/**
 * Run the Gemini agent for one inbound message.
 * @param {{ message: string, history?: Array<{role:'user'|'model', text:string}>, sessionData?: object }} args
 * @returns {Promise<object|null>} structured result or null to fall back.
 *   Caller MUST treat null as "use the rule-based reply".
 */
export async function runGeminiAgent({ message, history = [], sessionData = null }) {
    _lastFailReason = null;
    _lastModelUsed = null;
    if (!isAgentEnabled()) return null;

    // Circuit breaker: skip if backing off from a recent 429.
    if (Date.now() < _backoffUntil) {
        console.warn('[AGENT] circuit breaker open (post-429 backoff) → fallback');
        return _fail('gemini_rate_limited');
    }
    if (!isUnderQuota()) {
        console.warn('[AGENT] daily free cap reached → fallback');
        return _fail('gemini_quota_exhausted');
    }

    // Build context line from session data so the agent NEVER re-asks collected info
    let contextLine = '';
    if (sessionData) {
        const parts = [];
        if (sessionData.contactName && sessionData.contactName !== 'WhatsApp Lead') parts.push(`Name: ${sessionData.contactName}`);
        if (sessionData.city) parts.push(`City: ${sessionData.city}`);
        if (sessionData.eyePower) {
            const ep = sessionData.eyePower;
            const eyeStr = ep.parsed || ep.raw || (ep.numeric !== null ? String(ep.numeric) : '');
            if (eyeStr) parts.push(`Eye Power: ${eyeStr}`);
        }
        if (sessionData.timeline) parts.push(`Timeline: ${sessionData.timeline}`);
        if (sessionData.insurance) parts.push(`Insurance: ${sessionData.insurance}`);
        if (sessionData.previous_surgery) parts.push(`Previous Surgery: ${sessionData.previous_surgery}`);
        if (sessionData.ageGroup) parts.push(`Age: ${sessionData.ageGroup}`);
        if (sessionData.is_cataract) parts.push(`Cataract: yes`);
        if (sessionData.request_call) parts.push(`Callback requested: yes`);
        if (parts.length > 0) {
            contextLine = `[ALREADY COLLECTED — DO NOT ASK AGAIN: ${parts.join(', ')}]\n`;
        }
    }

    const fullMessage = contextLine + message;

    const chain = activeModelChain();
    if (!chain.length) {
        console.warn('[AGENT] all models daily-exhausted → fallback');
        return _fail('agent_quota_exhausted');
    }
    for (let mi = 0; mi < chain.length; mi++) {
        const model = chain[mi];
        const histSlice = isGemmaModel(model) ? -4 : -8;
        const modelContents = [
            ...history
                .filter(h => h && h.text)
                .slice(histSlice)
                .map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] })),
            { role: 'user', parts: [{ text: fullMessage }] },
        ];
        const reqBody = buildRequestBody(model, modelContents);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const prefix = failReasonPrefix(model);

        for (let attempt = 1; attempt <= 2; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs(model));
            let res;
            try {
                res = await globalThis.fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody),
                    signal: ctrl.signal,
                });
            } catch (e) {
                clearTimeout(timer);
                tickFallback();
                const reason = e.name === 'AbortError' ? `${prefix}_timeout` : `${prefix}_network_error`;
                console.error(`[AGENT:${model}] ${reason} → fallback:`, e.message);
                if (mi < chain.length - 1) break;
                return _fail(reason);
            }
            clearTimeout(timer);

            if (res.status === 429) {
                const errText = await res.text().catch(() => '');
                if (isGoogleDailyQuota429(res.status, errText)) {
                    markModelDailyExhausted(model);
                    if (mi < chain.length - 1) {
                        console.warn(`[AGENT:${model}] Google daily free-tier cap hit → trying ${chain[mi + 1]}`);
                        break;
                    }
                }
                if (attempt < 2) {
                    console.warn(`[AGENT:${model}] 429 rate limited → retry in 2.5s`);
                    await _sleep(RATE_LIMIT_RETRY_MS);
                    continue;
                }
                tickFallback();
                _backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
                console.warn(`[AGENT:${model}] 429 after retry → backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
                if (mi < chain.length - 1) break;
                return _fail(`${prefix}_rate_limited`);
            }

            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                tickFallback();
                console.error(`[AGENT:${model}] HTTP ${res.status} → fallback:`, txt.slice(0, 200));
                if (mi < chain.length - 1 && (res.status >= 500 || res.status === 404)) break;
                return _fail(`${prefix}_http_error`);
            }

            let data;
            try { data = await res.json(); }
            catch (e) {
                tickFallback();
                console.error(`[AGENT:${model}] bad JSON envelope → fallback`);
                if (mi < chain.length - 1) break;
                return _fail(`${prefix}_bad_response`);
            }

            const cand = data?.candidates?.[0];
            if (data?.promptFeedback?.blockReason || !cand) {
                tickFallback();
                console.warn(`[AGENT:${model}] blocked/empty → fallback`);
                if (mi < chain.length - 1) break;
                return _fail(`${prefix}_blocked`);
            }
            const raw = extractCandidateText(cand);
            if (!raw) {
                tickFallback();
                console.warn(`[AGENT:${model}] empty text → fallback`);
                if (mi < chain.length - 1) break;
                return _fail(`${prefix}_empty`);
            }

            let parsed;
            try {
                parsed = parseAgentJson(raw);
            } catch (e) {
                tickFallback();
                console.error(`[AGENT:${model}] could not parse model JSON → fallback:`, raw.slice(0, 120));
                if (mi < chain.length - 1) break;
                return _fail(`${prefix}_bad_json`);
            }
            if (!parsed) {
                tickFallback();
                console.warn(`[AGENT:${model}] empty parse → fallback`);
                if (mi < chain.length - 1) break;
                return _fail(`${prefix}_bad_json`);
            }

            tickRequest();
            _lastModelUsed = model;
            if (data?.usageMetadata) {
                tickTokens(data.usageMetadata);
                console.log(`[AGENT:${model}] tokens +${data.usageMetadata.totalTokenCount || 0} (in ${data.usageMetadata.promptTokenCount || 0}, out ${data.usageMetadata.candidatesTokenCount || 0}, think ${data.usageMetadata.thoughtsTokenCount || 0})`);
            }
            return parsed;
        }
    }

    return _fail('agent_quota_exhausted');
}

