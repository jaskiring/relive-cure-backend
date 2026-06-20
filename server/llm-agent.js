// server/llm-agent.js
// Gemini 2.5 Flash agent (free tier) for the WhatsApp bot. v2.
//
// Ships dark: requires GEMINI_API_KEY + BOT_AGENT_MODE in {shadow, live}.
// On any failure (timeout, 429, malformed JSON, network, quota), returns null
// and the caller falls back to the rule-based state machine — production is
// never at the mercy of a free API.
//
// Shadow mode (default when enabled): the agent runs and its reply is
// returned to the caller for logging, but the CALLER sends the rule-based
// reply to the customer. Live mode: caller sends the agent's reply.
//
// Activation (Railway env vars):
//   GEMINI_API_KEY    = <free AI Studio key>           (required)
//   BOT_AGENT_MODE    = shadow | live                  (required to enable)
//   GEMINI_MODEL      = gemini-2.5-flash               (optional override)
//
// No SDK dependency — calls the Gemini REST endpoint via globalThis.fetch.

import { isUnderQuota, tickRequest, tickFallback, quotaStatus } from './agent-quota.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 8000;

// Circuit breaker: after a 429, back off briefly (Gemini free tier ~5 RPM).
// After daily cap exhaustion, block until next UTC midnight.
let _backoffUntil = 0;  // epoch ms — short backoff for 429

// Runtime mode override — set via POST /api/agent/mode from the dashboard.
// When set, it takes priority over the BOT_AGENT_MODE env var.
let _runtimeMode = null;  // 'shadow' | 'live' | 'off' | null (null = use env var)

export function isAgentEnabled() {
    if (_runtimeMode === 'off') return false;
    const mode = _runtimeMode || process.env.BOT_AGENT_MODE;
    return !!process.env.GEMINI_API_KEY && (mode === 'shadow' || mode === 'live');
}

export function agentMode() {
    if (!isAgentEnabled()) return null;
    return _runtimeMode || process.env.BOT_AGENT_MODE;
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
    return {
        enabled: isAgentEnabled(),
        mode: agentMode(),
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
        quota: quotaStatus(),
    };
}

// --- System prompt: encodes the SAME flow as the rule-based bot ---------------
const SYSTEM_PROMPT = `You are Relive Cure's friendly WhatsApp vision assistant. Relive Cure is a LASIK / vision-correction clinic. You talk to people on WhatsApp who came from ads or referrals and may want to get rid of glasses/specs.

YOUR JOB
- Have a warm, natural, helpful chat. Answer their questions about LASIK clearly.
- Collect over the course of the chat: NAME, CITY, EYE POWER (glasses/lens prescription).
- Guide interested people toward a FREE consultation with a specialist.

CONVERSATION FLOW (follow this order, never skip ahead):
1. Greet warmly. Ask how you can help.
2. After 1-2 exchanges, ask for their name casually ("by the way, what should I call you?"). Ask ONCE only.
3. Ask for their city.
4. Ask for their eye power (e.g. "-2.5", "both eyes same").
5. Answer any questions about cost, recovery, pain, safety.
6. If interested, offer to connect with a specialist for free consultation.
7. Once callback is offered, DO NOT ask "what time?" or "when should they call?" — just confirm the specialist will reach out.

STYLE
- WhatsApp short: 1-4 short lines per reply. No long paragraphs. Occasional emoji (not every line).
- Mirror the user's language: English if English, Hindi if Hindi, Hinglish if Hinglish.
- Don't repeat questions you already asked. If they already answered something, move on.
- Never ask for "a good time to call" — the specialist handles scheduling.

FACTS YOU MAY STATE (do not invent anything beyond these):
- Cost: LASIK at Relive Cure starts from ₹15,000 and goes up to ₹90,000 depending on the eye and the technology. Exact cost is decided in the free consultation.
- Recovery: vision clears in 3-12 hours, normal routine next day, full recovery in 1-2 weeks. No patches or bed rest.
- Pain: nearly painless — numbing drops are used; only mild pressure for a few seconds; mild irritation for a few hours after.
- Eligibility: stable eye power for 1+ year, age 18+, healthy eyes / enough corneal thickness, no major eye disease. A specialist confirms eligibility in the consultation.
- Safety: one of the safest eye procedures, 98%+ success, ~10-15 minutes, no general anaesthesia.
- Referral: refer a friend, earn ₹1,000 per surgery.

HARD RULES (never break these):
- You are NOT a doctor. Never diagnose, never give a medical opinion on someone's specific eyes, never promise a result. For anything specific ("is it safe for ME", "what will MY cost be") → reassure and route to the free consultation.
- Never invent prices, numbers, success rates, timelines, or medical claims beyond the FACTS above.
- CATARACT is NOT what LASIK fixes. If the person mentions cataract (cataract / motiyabind / मोतियाबिंद / "white in eye" / older person can't see clearly at distance AND near), do NOT pitch LASIK. Acknowledge cataract is different, offer specialist. Set is_cataract = true.
- If the person asks for a call back / says "call me" → reassure specialist will call, set wants_callback = true. DO NOT ask what time.
- You cannot see images. Ask them to type the power instead.
- Stay on vision/eyes/LASIK. If off-topic, gently redirect.

NAME EXTRACTION RULES (critical — wrong name in reply looks terrible):
- Only extract a name if the user EXPLICITLY states it: "mera naam X hai", "I am X", "my name is X", "call me X", " naam X hai".
- NEVER extract from: "i am looking for", "i want", "i need", "i am interested", "yes i am" — these are NOT names.
- NEVER extract: "looking", "yes", "no", "hi", "hello", "ok", "sure", "fine", "good", "interested", "consultation", "help", "info", "surgery", "lasik", "motia", " nto", "not", "qm", or any common word.
- NEVER use the extracted name in your reply text UNLESS you are completely certain it is a real person's name. If unsure, do NOT say "Thanks, X!" — just answer their question.
- If the user corrects their name ("no i am X"), use the corrected name.

EXTRACTION: alongside your reply, report any details the user has revealed:
- name: their actual name ONLY if clearly stated, else null.
- city: their city if stated, else null.
- eye_power: their glasses/lens power if stated (e.g. "-2.5", "+1.0", "high power"), else null.
- asks_cost / asks_recovery / asks_pain / asks_safety: true if THIS message asks about that topic.
- power_concern: true if they describe weak vision / blur / high power / dependence on glasses.
- wants_callback: true if they want a human / a call.
- is_cataract: true if cataract is indicated.

Always return the JSON object. "reply" is the WhatsApp message to send back.`;

const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        reply: { type: 'STRING' },
        name: { type: 'STRING', nullable: true },
        city: { type: 'STRING', nullable: true },
        eye_power: { type: 'STRING', nullable: true },
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

/**
 * Run the Gemini agent for one inbound message.
 * @param {{ message: string, history?: Array<{role:'user'|'model', text:string}> }} args
 * @returns {Promise<object|null>} structured result or null to fall back.
 *   Caller MUST treat null as "use the rule-based reply".
 */
export async function runGeminiAgent({ message, history = [] }) {
    if (!isAgentEnabled()) return null;

    // Circuit breaker: skip if backing off from a recent 429.
    if (Date.now() < _backoffUntil) {
        console.warn('[AGENT] circuit breaker open (post-429 backoff) → fallback');
        return null;
    }
    if (!isUnderQuota()) {
        console.warn('[AGENT] daily free cap reached → fallback');
        return null;
    }

    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const contents = [
        ...history
            .filter(h => h && h.text)
            .slice(-16)
            .map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] })),
        { role: 'user', parts: [{ text: message }] },
    ];

    const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.6,
            maxOutputTokens: 500,
            thinkingConfig: { thinkingBudget: 0 },
        },
    };

    tickRequest();  // count the attempt

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
        res = await globalThis.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        tickFallback();
        console.error('[AGENT] request failed → fallback:', e.message);
        return null;
    }
    clearTimeout(timer);

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        tickFallback();
        if (res.status === 429) {
            _backoffUntil = Date.now() + 10_000; // retry after 10s
            console.warn('[AGENT] 429 rate limited → backing off 10s');
        } else {
            console.error(`[AGENT] HTTP ${res.status} → fallback:`, txt.slice(0, 200));
        }
        return null;
    }

    let data;
    try { data = await res.json(); }
    catch (e) {
        tickFallback();
        console.error('[AGENT] bad JSON envelope → fallback');
        return null;
    }

    const cand = data?.candidates?.[0];
    if (data?.promptFeedback?.blockReason || !cand) {
        tickFallback();
        console.warn('[AGENT] blocked/empty → fallback');
        return null;
    }
    const raw = (cand.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!raw) {
        tickFallback();
        console.warn('[AGENT] empty text → fallback');
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
    } catch (e) {
        tickFallback();
        console.error('[AGENT] could not parse model JSON → fallback:', raw.slice(0, 120));
        return null;
    }
    if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
        tickFallback();
        console.warn('[AGENT] no usable reply → fallback');
        return null;
    }
    return parsed;
}
