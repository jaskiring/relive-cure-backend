// CRM Operator — Gemini agent with function calling (tool playbooks).

import { isUnderQuota, tickRequest, tickFallback, tickTokens } from './agent-quota.js';
import { OPERATOR_TEXT_MODELS, modelIds } from './gemini-channels.js';
import { markGoogleModelExhausted, isGoogleModelExhausted } from './gemini-model-health.js';
import { getOperatorToolDeclarations, executeOperatorTool, suggestToolsForMessage } from './operator-playbooks.js';

const TIMEOUT_MS = 18000;
const MAX_TOOL_TURNS = 4;

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

function extractFunctionCalls(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts
        .filter((p) => p.functionCall?.name)
        .map((p) => ({
            name: p.functionCall.name,
            args: p.functionCall.args || {},
        }));
}

function buildSystemPrompt({ role, designation, ctx, toolNames }) {
    return `You are Relive Cure CRM Operator — internal AI assistant for LASIK clinic staff.

Staff role: ${role}${designation ? ` (${designation})` : ''}.
Allowed tabs: ${(ctx.tabs || []).join(', ') || 'limited'}.

You have tools to fetch live CRM data. ALWAYS use tools for counts, lookups, and pipeline questions — never guess numbers.
For general questions ("what does this CRM do", "what is Pulse", onboarding), call crm_overview or user_access_summary, then answer in plain language.
For unclear asks, call crm_overview first or ask one short clarifying question — do not dump a raw tab list.

Available tools: ${toolNames.join(', ') || 'none (permissions limited)'}.

Rules:
- Plain text, no markdown, max 5 short sentences unless listing lead details.
- Quote exact counts from tool results.
- Prefer refrens_leads (Analytics) for assignee/pipeline questions; leads_surgery for WhatsApp bot.
- Bug/feature reports are handled separately — if user wants a product change, acknowledge and say they can describe it for Jas.
- Never invent phone numbers, lead counts, or data the user's role cannot access.`;
}

/**
 * Run Gemini operator agent: model picks tools → we execute → model answers.
 */
export async function runOperatorAgent({ message, role, designation, ctx, supabase, user }) {
    if (!apiKey()) return { ok: false, error: 'no_api_key' };
    if (!isUnderQuota('operator')) return { ok: false, error: 'operator_quota_exhausted' };

    const declarations = getOperatorToolDeclarations(ctx);
    const toolNames = declarations.map((d) => d.name);
    const hints = suggestToolsForMessage(message);
    const system = buildSystemPrompt({ role, designation, ctx, toolNames });

    const userIntro = hints.length
        ? `${message}\n\n(Hint: relevant tools may include ${hints.join(', ')})`
        : message;

    const contents = [{ role: 'user', parts: [{ text: userIntro }] }];
    const toolsCalled = [];
    const models = modelIds(OPERATOR_TEXT_MODELS).filter((id) => !isExhausted(id));

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        let lastModel = null;
        let geminiData = null;

        for (const model of models) {
            const body = {
                systemInstruction: { parts: [{ text: system }] },
                contents,
                generationConfig: { temperature: 0.35, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
            };
            if (declarations.length > 0) {
                body.tools = [{ functionDeclarations: declarations }];
                body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
            }

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
                lastModel = model;
                geminiData = data;
                break;
            } catch {
                tickFallback('operator');
            }
        }

        if (!geminiData) {
            return { ok: false, error: 'operator_llm_failed', toolsCalled };
        }

        const calls = extractFunctionCalls(geminiData);
        const modelParts = geminiData?.candidates?.[0]?.content?.parts || [];

        if (!calls.length) {
            const reply = extractText(geminiData);
            if (!reply) {
                return { ok: false, error: 'empty_reply', toolsCalled };
            }
            tickRequest('operator');
            if (geminiData?.usageMetadata) tickTokens(geminiData.usageMetadata, 'operator');
            return { ok: true, reply, model: lastModel, toolsCalled };
        }

        // Model requested tool(s) — append model turn + function results, loop again.
        contents.push({ role: 'model', parts: modelParts });

        const responseParts = [];
        for (const call of calls) {
            let result;
            try {
                result = await executeOperatorTool(call.name, call.args, { ctx, supabase, user });
            } catch (e) {
                result = { error: 'tool_failed', message: e.message };
            }
            toolsCalled.push({ name: call.name, args: call.args, result });
            responseParts.push({
                functionResponse: {
                    name: call.name,
                    response: { result },
                },
            });
        }
        contents.push({ role: 'user', parts: responseParts });
    }

    return { ok: false, error: 'max_tool_turns', toolsCalled };
}
