// Operator message classification + reply helpers (data via operator-playbooks + operator-agent).

import { isGoogleDailyLimit, isGoogleTransientLimit } from './operator-data.js';
import { INDIAN_CITIES, titleCaseCity } from './bot-guard.js';

const BUG_PATTERNS = /\b(bug|broken|wrong|galat|not working|doesn'?t work|fix|issue|error|bot said|chatbot|mirror|crash|stuck)\b/i;
const FEATURE_PATTERNS = /\b(feature|add|new tab|can we have|request|improvement|suggestion|enhancement|build|ship)\b/i;
const FEEDBACK_PATTERNS = /\b(should have|should be|there should|need more|needs more|want more|would be better|please add|we need|more detail|more analysis|more recommend|improve the|upgrade the|better if|missing in)\b/i;
const CRM_TAB_WORDS = /\b(marketing|analytics|pulse|chatbot|bot\s*lab|whatsapp|inbox|settings|dashboard|crm|operator|organic)\b/i;
const DATA_QUERY_PATTERNS = /\b(how many|count|kitne|total|number of|find|lookup|search|show me|list|which|who has|assigned to|tell me)\b/i;

/** Fix common typos before parsing data questions. */
export function normalizeDataQuestion(message) {
    return String(message || '')
        .replace(/\bhow many needs\b/gi, 'how many leads')
        .replace(/\bneeds does\b/gi, 'leads does')
        .replace(/\bneeds do\b/gi, 'leads do');
}

export function extractCityFromMessage(message) {
    const raw = String(message || '');
    const m = raw.toLowerCase();

    const fromMatch = raw.match(
        /\b(?:from|in|at|based in|located in|near)\s+([a-z][a-z\s.'-]{2,30}?)(?:\s+(?:that|who|which|are|is|was|with|not|open|lost|,|\?)|$)/i,
    );
    if (fromMatch?.[1]) {
        const c = normalizeCityToken(fromMatch[1]);
        if (c) return c;
    }

    for (const city of INDIAN_CITIES) {
        const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(m)) return titleCaseCity(city);
    }
    return null;
}

function normalizeCityToken(token) {
    let t = String(token || '').trim();
    const tailIdx = t.search(/\s+(?:that|who|which|are|is|was|with|not|open|lost)\b/i);
    if (tailIdx > 0) t = t.slice(0, tailIdx).trim();
    t = t.replace(/[?.!,]+$/, '').trim();
    const low = t.toLowerCase();
    for (const city of INDIAN_CITIES) {
        if (low === city || low.startsWith(`${city} `) || low.startsWith(`${city},`)) {
            return titleCaseCity(city);
        }
    }
    if (t.length >= 3 && /^[a-z\s.'-]+$/i.test(t)) {
        return t.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    return null;
}

export function classifyOperatorMessage(text) {
    const t = normalizeDataQuestion(String(text || '').trim());
    if (BUG_PATTERNS.test(t)) return 'bug';
    if (FEATURE_PATTERNS.test(t)) return 'feature';
    if (FEEDBACK_PATTERNS.test(t)) return 'feature';
    if (CRM_TAB_WORDS.test(t) && /\b(more|better|improve|detail|analysis|recommend|change|update)\b/i.test(t)) return 'feature';
    if (DATA_QUERY_PATTERNS.test(t)) return 'data';
    if (/\b(hot lead|today)\b/i.test(t) && /\b(how many|count|kitne)\b/i.test(t)) return 'data';
    if (/\b(assignee|assigned|hold|holds)\b/i.test(t) && /\b(how many|count|leads?|needs?)\b/i.test(t)) return 'data';
    if (extractCityFromMessage(t) && /\b(how many|count|leads?)\b/i.test(t)) return 'data';
    if (/\b(\+91|\d{10})\b/.test(t)) return 'data';
    if (/\b(lead|phone|thread|whatsapp|inbox)\b/i.test(t) && /\?/.test(t)) return 'data';
    if (/\b(what is|what does|how does|explain|tell me about)\b/i.test(t) && /\b(crm|dashboard|relive|pulse|analytics|marketing)\b/i.test(t)) return 'general';
    return 'general';
}

export function buildOperatorContext(role, tabs, permissions = {}) {
    return {
        role: role || 'limited',
        tabs: tabs || [],
        canExport: !!permissions.canExport,
        canAnalytics: (tabs || []).includes('analytics'),
        canInbox: (tabs || []).includes('inbox'),
        canChatbot: (tabs || []).includes('chatbot'),
        canPulse: (tabs || []).includes('pulse'),
        isAdmin: role === 'admin',
    };
}

/** Pull assignee name from natural-language CRM questions. */
export function extractAssigneeName(message) {
    const raw = normalizeDataQuestion(String(message || '').trim());
    if (!raw) return null;

    const stopWord = /^(the|all|any|my|our|their|open|lost|total|how|many|there|tell|me|does|do)$/i;

    const patterns = [
        /\bdoes\s+([a-z][\w.'\s-]{2,30}?)\s+(?:hold|have)\b/i,
        /\b([a-z][\w.'-]{2,30})\s+holds?\b/i,
        /\bassigned\s+to\s+([a-z][\w.'\s-]{2,50})/i,
        /\b(?:open\s+)?leads?\s+for\s+([a-z][\w.'\s-]{2,50})/i,
        /\bfor\s+([a-z][\w.'\s-]{2,50})/i,
        /\bassign(?:ed|ee)?\s+(?:to\s+)?([a-z][\w.'\s-]{2,50})/i,
        /\b([a-z][\w.'\s-]{2,50}?)(?:'s| ke| ki)\s+leads?\b/i,
    ];

    for (const re of patterns) {
        const m = raw.match(re);
        if (!m?.[1]) continue;
        const name = cleanAssigneeName(m[1]);
        if (name.length >= 2 && !stopWord.test(name)) {
            return name;
        }
    }
    return null;
}

function cleanAssigneeName(name) {
    let n = String(name || '').replace(/\s+/g, ' ').trim();
    const tailStop = /\s+(?:that|who|which|are|is|was|with|not|open|lost|or|any|anything)\b/i;
    const idx = n.search(tailStop);
    if (idx > 0) n = n.slice(0, idx).trim();
    return n.replace(/[?.!,]+$/, '').trim();
}

/** open | not_lost | lost | converted | null (all) */
export function detectStatusFilter(message) {
    const m = String(message || '').toLowerCase();
    if (/\bnot\s+lost\b|\bopen\s+or\s+not\s+lost\b|\bactive\s+pipeline\b/.test(m)) return 'not_lost';
    if (/\b(deal done|converted|won|closed)\b/.test(m)) return 'converted';
    if (/\blost\b/.test(m) && !/\bnot\s+lost\b/.test(m)) return 'lost';
    if (/\bopen\b/.test(m) && !/\bnot\s+open\b/.test(m)) return 'open';
    return null;
}

/** Founder inbox routing only — data queries go through Gemini + tools. */
export function checkFounderRoute(message) {
    const kind = classifyOperatorMessage(message);
    if (kind === 'bug' || kind === 'feature') {
        return {
            needsFounder: true,
            kind,
            toolContext: `Classification: ${kind}. Logged for founder approval.`,
        };
    }
    return { needsFounder: false, kind };
}

/** Greetings and onboarding — no Gemini required. */
export function staticGeneralReply(message, ctx = {}) {
    const t = String(message || '').trim().toLowerCase();
    if (!t) return null;

    const isGreeting = /^(hi|hello|hey|namaste|good\s+(morning|afternoon|evening))\b/.test(t)
        || /\b(what can you help|how can you help|what do you do|what are you|who are you)\b/.test(t);

    const isCrmExplain = /\b(what is|what does|how does|explain|tell me about)\b/.test(t)
        && /\b(crm|dashboard|pulse|analytics|relive|operator|chatbot)\b/.test(t);

    if (!isGreeting && !isCrmExplain) return null;

    const lines = [
        'I answer live CRM questions from real database counts — never guesses.',
        'Try: "How many open leads for [name]?" or "leads in Delhi".',
        'Bugs and feature ideas are sent for admin approval.',
    ];
    if (ctx.canAnalytics || ctx.isAdmin) {
        lines.splice(2, 0, 'Refrens assignee, city, and status filters are supported.');
    }
    return lines.join(' ');
}

export function staticOperatorReply(kind, founderRoute, agentResult) {
    if (kind === 'bug' || kind === 'feature') {
        const label = kind === 'bug' ? 'bug report' : 'feature request';
        return `Thanks — your ${label} has been sent for approval.`;
    }
    if (agentResult?.ok) return agentResult.reply;
    if (agentResult?.error === 'operator_quota_exhausted') {
        return 'Internal AI limit reached for today. Try again after UTC midnight.';
    }
    if (agentResult?.error === 'no_api_key') {
        return 'Operator AI is not configured on the server (GEMINI_API_KEY missing).';
    }
    if (agentResult?.error === 'operator_llm_failed') {
        const detail = agentResult.detail || '';
        if (isGoogleDailyLimit(detail)) {
            return 'Google Gemini daily limit reached for this model (not your 4200 app cap). Resets UTC midnight — or link billing in AI Studio.';
        }
        if (isGoogleTransientLimit(detail)) {
            return 'Gemini is temporarily busy (requests/minute). Tap Retry in a few seconds.';
        }
        if (/API key|API_KEY|invalid/i.test(detail)) {
            return 'Operator AI: Gemini API key invalid or missing on Railway (GEMINI_API_KEY).';
        }
        if (/all google models exhausted|all models failed/i.test(detail)) {
            return 'Google Gemini daily limit reached for this model (not your 4200 app cap). Resets UTC midnight — or link billing in AI Studio.';
        }
        return `Operator AI could not reach Gemini (${detail.slice(0, 100) || 'all models failed'}). Tap Retry.`;
    }
    if (agentResult?.error === 'rate_limit_retry') {
        return agentResult.detail || 'Gemini busy — tap Retry in a few seconds.';
    }
    return 'I could not generate a reply right now. Try again or rephrase your question.';
}
