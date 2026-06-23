// CRM Operator — Gemini agent with function calling (tool playbooks).

import { isUnderQuota, tickRequest, tickFallback, tickTokens, ensureQuotaHydrated } from './agent-quota.js';
import { OPERATOR_TEXT_MODELS, modelIds } from './gemini-channels.js';
import { markGoogleModelExhausted, isGoogleModelExhausted } from './gemini-model-health.js';
import { getOperatorToolDeclarations, executeOperatorTool, suggestToolsForMessage } from './operator-playbooks.js';
import {
    isDataQuestion,
    runDataPlaybook,
    formatDataPlaybookReply,
    playbookHasUsableData,
    isGoogleDailyLimit,
    isGoogleTransientLimit,
} from './operator-data.js';
import { normalizeDataQuestion } from './operator-tools.js';

const TIMEOUT_MS = 18000;
const MAX_TOOL_TURNS = 4;

let _lastGeminiError = null;

export function operatorLastGeminiError() {
    return _lastGeminiError;
}

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

function parseApiError(data, errText, status) {
    const msg = data?.error?.message || data?.error?.status || errText?.slice(0, 240) || `HTTP ${status}`;
    return String(msg);
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
    return `You are Relive Cure CRM Operator — internal assistant for LASIK clinic staff.

Staff role: ${role}${designation ? ` (${designation})` : ''}.
Allowed tabs: ${(ctx.tabs || []).join(', ') || 'limited'}.

You have tools to fetch live CRM data. ALWAYS use tools for counts, lookups, and pipeline questions — never guess numbers.
Tools support filters: assignee name, status (open / not lost / lost), and city (customer_city in Refrens, city in bot leads).
For general questions ("what does this CRM do", "what is Pulse", onboarding), call crm_overview or user_access_summary, then answer in plain language.

Available tools: ${toolNames.join(', ') || 'none (permissions limited)'}.

Rules:
- Plain text, no markdown, max 5 short sentences unless listing lead details.
- Quote exact counts from tool results only.
- Prefer refrens_leads (Analytics) for assignee/pipeline questions.
- Never invent lead counts.`;
}

function buildPlainSystemPrompt({ role, designation, ctx }) {
    return `You are Relive Cure CRM Operator for Relive Cure LASIK clinic staff.
Role: ${role}${designation ? ` (${designation})` : ''}. Tabs: ${(ctx.tabs || []).join(', ') || 'limited'}.
Answer briefly in plain text. Do NOT invent lead counts or assignee statistics — say you need a data tool for those.`;
}

async function tryModels(models, body, channel = 'operator') {
    let lastErr = null;
    for (const model of models) {
        if (isExhausted(model)) continue;
        try {
            const { res, data, errText } = await generateContent(model, body);
            if (res.status === 429 && isDaily429(res.status, errText)) {
                markExhausted(model);
                tickFallback(channel);
                lastErr = parseApiError(data, errText, res.status);
                continue;
            }
            if (res.status === 429) {
                tickFallback(channel);
                lastErr = parseApiError(data, errText, res.status);
                continue;
            }
            if (!res.ok) {
                tickFallback(channel);
                lastErr = parseApiError(data, errText, res.status);
                console.warn(`[OPERATOR] Gemini ${model} HTTP ${res.status}:`, lastErr.slice(0, 120));
                continue;
            }
            return { ok: true, model, data };
        } catch (e) {
            tickFallback(channel);
            lastErr = e.message || 'timeout';
            console.warn(`[OPERATOR] Gemini ${model} error:`, lastErr);
        }
    }
    _lastGeminiError = lastErr;
    return { ok: false, error: lastErr };
}

function failFromGeminiError(err, dataQuery) {
    if (isGoogleDailyLimit(err)) {
        return { ok: false, error: 'operator_llm_failed', detail: err, retryable: true };
    }
    if (isGoogleTransientLimit(err)) {
        return { ok: false, error: 'rate_limit_retry', detail: err, retryable: true };
    }
    if (dataQuery) {
        return { ok: false, error: 'operator_llm_failed', detail: err, retryable: true };
    }
    return { ok: false, error: 'operator_llm_failed', detail: err, retryable: true };
}

async function runPlainFallback({ message, role, designation, ctx }) {
    const system = buildPlainSystemPrompt({ role, designation, ctx });
    const models = modelIds(OPERATOR_TEXT_MODELS).filter((id) => !isExhausted(id));
    const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
    };
    const result = await tryModels(models, body, 'operator');
    if (!result.ok) return failFromGeminiError(result.error, false);
    const reply = extractText(result.data);
    if (!reply) return { ok: false, error: 'empty_reply', detail: 'no text in response', retryable: true };
    if (result.data?.usageMetadata) tickTokens(result.data.usageMetadata, 'operator');
    return { ok: true, reply, model: result.model, toolsCalled: [], plain_fallback: true };
}

export async function runOperatorAgent({ message, role, designation, ctx, supabase, user }) {
    await ensureQuotaHydrated();

    const queryText = normalizeDataQuestion(message);

    if (!apiKey()) return { ok: false, error: 'no_api_key', retryable: false };
    if (!isUnderQuota('operator')) return { ok: false, error: 'operator_quota_exhausted', retryable: false };

    const dataQuery = isDataQuestion(queryText);
    let playbook = null;
    let toolsCalled = [];

    if (dataQuery) {
        playbook = await runDataPlaybook(queryText, ctx, supabase, user);
        toolsCalled = (playbook.results || []).map((r) => ({
            name: r.tool,
            args: { assignee_name: playbook.assignee, status_filter: playbook.status },
            result: r,
        }));
        const sqlReply = formatDataPlaybookReply(playbook);
        if (sqlReply && playbookHasUsableData(playbook)) {
            return {
                ok: true,
                reply: sqlReply,
                model: 'sql_playbook',
                toolsCalled,
                sql_only: true,
            };
        }
    }

    const declarations = getOperatorToolDeclarations(ctx);
    const toolNames = declarations.map((d) => d.name);
    const hints = suggestToolsForMessage(queryText);
    let system = buildSystemPrompt({ role, designation, ctx, toolNames });

    let userIntro = hints.length
        ? `${queryText}\n\n(Hint: relevant tools may include ${hints.join(', ')})`
        : queryText;
    if (playbook?.results?.length) {
        userIntro += `\n\n(PRELOADED TOOL DATA — quote exactly, do not invent:\n${JSON.stringify(playbook.results)}\n)`;
    }

    const contents = [{ role: 'user', parts: [{ text: userIntro }] }];
    const toolModels = modelIds(OPERATOR_TEXT_MODELS).filter(
        (id) => !isExhausted(id) && !id.includes('gemma'),
    );

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents,
            generationConfig: { temperature: 0.35, maxOutputTokens: 512 },
        };
        if (declarations.length > 0) {
            body.tools = [{ functionDeclarations: declarations }];
            body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        }

        const result = await tryModels(toolModels, body, 'operator');
        if (!result.ok) {
            if (dataQuery && playbook && formatDataPlaybookReply(playbook)) {
                return {
                    ok: true,
                    reply: formatDataPlaybookReply(playbook),
                    model: 'sql_playbook',
                    toolsCalled,
                    sql_only: true,
                    gemini_skipped: result.error,
                };
            }
            return { ...failFromGeminiError(result.error, dataQuery), toolsCalled };
        }

        const geminiData = result.data;
        const lastModel = result.model;
        const calls = extractFunctionCalls(geminiData);
        const modelParts = geminiData?.candidates?.[0]?.content?.parts || [];

        if (!calls.length) {
            const reply = extractText(geminiData);
            if (!reply) {
                if (dataQuery) return failFromGeminiError('empty tool response', true);
                const plain = await runPlainFallback({ message: queryText, role, designation, ctx });
                return { ...plain, toolsCalled };
            }
            if (dataQuery && /\b\d+\s+(open\s+)?leads?\b/i.test(reply) && !toolsCalled.length) {
                const sqlReply = formatDataPlaybookReply(playbook);
                if (sqlReply) return { ok: true, reply: sqlReply, model: 'sql_playbook', toolsCalled, sql_only: true };
            }
            if (dataQuery && /\b(cannot|can't|unable to)\s+filter\b/i.test(reply)) {
                const sqlReply = formatDataPlaybookReply(playbook);
                if (sqlReply) return { ok: true, reply: sqlReply, model: 'sql_playbook', toolsCalled, sql_only: true };
            }
            if (geminiData?.usageMetadata) tickTokens(geminiData.usageMetadata, 'operator');
            return { ok: true, reply, model: lastModel, toolsCalled };
        }

        contents.push({ role: 'model', parts: modelParts });

        const responseParts = [];
        for (const call of calls) {
            let toolResult;
            try {
                toolResult = await executeOperatorTool(call.name, call.args, { ctx, supabase, user });
            } catch (e) {
                toolResult = { error: 'tool_failed', message: e.message };
            }
            toolsCalled.push({ name: call.name, args: call.args, result: toolResult });
            responseParts.push({
                functionResponse: {
                    name: call.name,
                    response: { result: toolResult },
                },
            });
        }
        contents.push({ role: 'user', parts: responseParts });
    }

    if (dataQuery && playbook && formatDataPlaybookReply(playbook)) {
        return {
            ok: true,
            reply: formatDataPlaybookReply(playbook),
            model: 'sql_playbook',
            toolsCalled,
            sql_only: true,
        };
    }

    if (dataQuery) {
        return { ok: false, error: 'operator_llm_failed', detail: 'max_tool_turns', retryable: true, toolsCalled };
    }

    const plain = await runPlainFallback({ message: queryText, role, designation, ctx });
    return { ...plain, toolsCalled };
}
