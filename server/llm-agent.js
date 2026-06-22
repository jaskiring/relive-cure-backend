// server/llm-agent.js
// Gemini 2.5 Flash agent (free tier) for the WhatsApp bot. v2.
//
// Ships dark: requires GEMINI_API_KEY + BOT_AGENT_MODE in {shadow, live}.
// On any failure (timeout, 429, malformed JSON, network, quota), returns null
// and the caller falls back to the rule-based state machine.
//
// The caller tries Gemini FIRST on every message while enabled and under quota.
// Rule-based (including call-me, cataract, KB templates) only runs when the
// agent is off, daily cap is hit, or the API fails.
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

import { isUnderQuota, tickRequest, tickFallback, tickTokens, quotaStatus } from './agent-quota.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const REQUEST_TIMEOUT_MS = 8000;

// Circuit breaker: after a 429, back off briefly (Gemini free tier ~5 RPM).
// After daily cap exhaustion, block until next UTC midnight.
let _backoffUntil = 0;  // epoch ms — short backoff for 429

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
    return {
        enabled: isAgentEnabled(),
        mode: agentMode(),
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
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

/**
 * Run the Gemini agent for one inbound message.
 * @param {{ message: string, history?: Array<{role:'user'|'model', text:string}>, sessionData?: object }} args
 * @returns {Promise<object|null>} structured result or null to fall back.
 *   Caller MUST treat null as "use the rule-based reply".
 */
export async function runGeminiAgent({ message, history = [], sessionData = null }) {
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

    const contents = [
        ...history
            .filter(h => h && h.text)
            .slice(-16)
            .map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] })),
        { role: 'user', parts: [{ text: fullMessage }] },
    ];

    const body = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.3,
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingBudget: 512 },
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
    if (data?.usageMetadata) {
        tickTokens(data.usageMetadata);
        console.log(`[AGENT] tokens +${data.usageMetadata.totalTokenCount || 0} (in ${data.usageMetadata.promptTokenCount || 0}, out ${data.usageMetadata.candidatesTokenCount || 0}, think ${data.usageMetadata.thoughtsTokenCount || 0})`);
    }
    return parsed;
}
