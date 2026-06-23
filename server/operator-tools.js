// Operator message classification + reply helpers (data via operator-playbooks + operator-agent).

import { isGoogleDailyLimit, isGoogleTransientLimit } from './operator-data.js';

const BUG_PATTERNS = /\b(bug|broken|wrong|galat|not working|doesn'?t work|fix|issue|error|bot said|chatbot|mirror|crash|stuck)\b/i;
const FEATURE_PATTERNS = /\b(feature|add|new tab|can we have|request|improvement|suggestion|enhancement|build|ship)\b/i;
const FEEDBACK_PATTERNS = /\b(should have|should be|there should|need more|needs more|want more|would be better|please add|we need|more detail|more analysis|more recommend|improve the|upgrade the|better if|missing in)\b/i;
const CRM_TAB_WORDS = /\b(marketing|analytics|pulse|chatbot|bot\s*lab|whatsapp|inbox|settings|dashboard|crm|operator|organic)\b/i;
const DATA_QUERY_PATTERNS = /\b(how many|count|kitne|total|number of|find|lookup|search|show me|list|which|who has|assigned to|tell me)\b/i;

export function classifyOperatorMessage(text) {
    const t = String(text || '').trim();
    if (BUG_PATTERNS.test(t)) return 'bug';
    if (FEATURE_PATTERNS.test(t)) return 'feature';
    if (FEEDBACK_PATTERNS.test(t)) return 'feature';
    if (CRM_TAB_WORDS.test(t) && /\b(more|better|improve|detail|analysis|recommend|change|update)\b/i.test(t)) return 'feature';
    if (DATA_QUERY_PATTERNS.test(t)) return 'data';
    if (/\b(hot lead|today)\b/i.test(t) && /\b(how many|count|kitne)\b/i.test(t)) return 'data';
    if (/\b(assignee|assigned)\b/i.test(t)) return 'data';
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
    const raw = String(message || '').trim();
    if (!raw) return null;

    const stopWord = /^(the|all|any|my|our|their|open|lost|total|how|many|there|tell|me)$/i;

    const patterns = [
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

export function staticOperatorReply(kind, founderRoute, agentResult) {
    if (kind === 'bug' || kind === 'feature') {
        return `Thanks — logged as a ${kind === 'bug' ? 'bug report' : 'feature request'} in the Founder inbox (admin only). Open the Operator orb → inbox icon at top right to review, approve dev, or reject.`;
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
        return `Operator AI could not reach Gemini (${detail.slice(0, 100) || 'all models failed'}). Tap Retry.`;
    }
    if (agentResult?.error === 'rate_limit_retry') {
        return agentResult.detail || 'Gemini busy — tap Retry in a few seconds.';
    }
    return 'I could not generate a reply right now. Try again or rephrase your question.';
}
