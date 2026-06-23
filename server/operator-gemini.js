// CRM Operator — Gemini (dedicated models + separate app quota from WhatsApp).

import { isUnderQuota, tickRequest, tickFallback, tickTokens } from './agent-quota.js';
import { OPERATOR_TEXT_MODELS, OPERATOR_TRANSCRIBE_MODELS, modelIds } from './gemini-channels.js';
import { markGoogleModelExhausted, isGoogleModelExhausted, googleExhaustedModels } from './gemini-model-health.js';

export { OPERATOR_TEXT_MODELS, OPERATOR_TRANSCRIBE_MODELS };

const TIMEOUT_MS = 12000;

function markExhausted(model) {
    markGoogleModelExhausted(model);
}

function isExhausted(model) {
    return isGoogleModelExhausted(model);
}

function isDaily429(status, errText) {
    if (status !== 429) return false;
    return /GenerateRequestsPerDay|free_tier_requests|PerDayPerProjectPerModel/i.test(errText || '');
}

function apiKey() {
    return process.env.GEMINI_API_KEY || process.env.GEMINI_OPERATOR_API_KEY || process.env.GOOGLE_API_KEY;
}

async function generateContent(model, body) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await globalThis.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { error: { message: text.slice(0, 200) } }; }
        return { res, data, errText: text };
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

function extractText(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim()
        || parts.map((p) => p.text || '').join('').trim();
}

export async function transcribeOperatorAudio(buffer, mimeType = 'audio/webm') {
    if (!apiKey()) return { ok: false, error: 'no_api_key' };
    if (!isUnderQuota('operator_transcribe')) return { ok: false, error: 'transcribe_quota_exhausted' };

    const sendMime = /webm/i.test(mimeType) ? 'audio/webm' : mimeType;
    const b64 = buffer.toString('base64');
    const models = modelIds(OPERATOR_TRANSCRIBE_MODELS).filter((id) => !isExhausted(id));

    for (const model of models) {
        const body = {
            contents: [{
                parts: [
                    { text: 'Transcribe this voice message. Speakers may use Hindi, English, or Hinglish. Output plain transcript only, no labels.' },
                    { inline_data: { mime_type: sendMime, data: b64 } },
                ],
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
        };
        try {
            const { res, data, errText } = await generateContent(model, body);
            if (res.status === 429 && isDaily429(res.status, errText)) {
                markExhausted(model);
                tickFallback('operator_transcribe');
                continue;
            }
            if (!res.ok) {
                tickFallback('operator_transcribe');
                continue;
            }
            const transcript = extractText(data);
            if (!transcript) continue;
            tickRequest('operator_transcribe');
            if (data?.usageMetadata) tickTokens(data.usageMetadata, 'operator_transcribe');
            return { ok: true, transcript, model };
        } catch {
            tickFallback('operator_transcribe');
        }
    }
    return { ok: false, error: 'transcribe_failed' };
}

export async function runOperatorChat({ message, toolContext, role, designation }) {
    if (!apiKey()) return { ok: false, error: 'no_api_key' };
    if (!isUnderQuota('operator')) return { ok: false, error: 'operator_quota_exhausted' };

    const system = `You are Relive Cure CRM Operator — internal assistant for staff only.
Role: ${role}${designation ? ` (${designation})` : ''}.
Answer ONLY from TOOL DATA below. If data is missing, say you cannot access it (permissions).
Never invent lead counts, phone numbers, or export data the role cannot see.
Keep replies under 4 short sentences. Plain text, no markdown.
If the user reports a bot bug, wrong reply, or asks for a new feature, say it is logged for Jas to review — do not promise a fix time.`;

    const userText = `USER: ${message}

TOOL DATA:
${toolContext || '(no tool data — answer generally about Relive Cure CRM workflows)'}`;

    const models = modelIds(OPERATOR_TEXT_MODELS).filter((id) => !isExhausted(id));

    for (const model of models) {
        const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 320, thinkingConfig: { thinkingBudget: 0 } },
        };
        try {
            const { res, data, errText } = await generateContent(model, body);
            if (res.status === 429 && isDaily429(res.status, errText)) {
                markExhausted(model);
                tickFallback('operator');
                continue;
            }
            if (!res.ok) {
                tickFallback('operator');
                continue;
            }
            const reply = extractText(data);
            if (!reply) continue;
            tickRequest('operator');
            if (data?.usageMetadata) tickTokens(data.usageMetadata, 'operator');
            return { ok: true, reply, model };
        } catch {
            tickFallback('operator');
        }
    }
    return { ok: false, error: 'operator_llm_failed' };
}

export function operatorGeminiStatus() {
    return {
        channel: 'operator',
        text_models: modelIds(OPERATOR_TEXT_MODELS),
        transcribe_models: modelIds(OPERATOR_TRANSCRIBE_MODELS),
        google_exhausted_today: googleExhaustedModels(),
        note: 'Operator models are separate from WhatsApp (no flash-lite/flash on operator text).',
    };
}
