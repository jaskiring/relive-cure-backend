// Role-aware data tools for CRM Operator (no LLM).

const BUG_PATTERNS = /\b(bug|broken|wrong|galat|not working|fix|issue|error|bot said|chatbot|mirror)\b/i;
const FEATURE_PATTERNS = /\b(feature|add|new tab|can we have|request|improvement|suggestion)\b/i;

export function classifyOperatorMessage(text) {
    const t = String(text || '').trim();
    if (BUG_PATTERNS.test(t)) return 'bug';
    if (FEATURE_PATTERNS.test(t)) return 'feature';
    if (/\b(how many|count|kitne|total|hot lead|today)\b/i.test(t)) return 'data';
    if (/\b(lead|phone|\+91|thread|whatsapp|inbox)\b/i.test(t)) return 'data';
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

function phoneDigits(s) {
    const d = String(s || '').replace(/\D/g, '');
    if (d.length >= 10) return d.slice(-10);
    return null;
}

export async function runOperatorTools(message, ctx, supabase) {
    const kind = classifyOperatorMessage(message);
    const lines = [];
    const m = message.toLowerCase();

    if (kind === 'bug' || kind === 'feature') {
        return {
            kind,
            needsFounder: true,
            toolContext: `Classification: ${kind}. Logged for founder approval.`,
            data: null,
        };
    }

    if (!ctx.canChatbot && !ctx.isAdmin) {
        lines.push('Your role does not include Chatbot/lead data access.');
        return { kind, needsFounder: false, toolContext: lines.join('\n'), data: null };
    }

    try {
        if (/\b(hot|urgent)\b/i.test(m) && /\b(how many|count|kitne|today)\b/i.test(m)) {
            const since = new Date();
            since.setHours(0, 0, 0, 0);
            const { count, error } = await supabase
                .from('leads_surgery')
                .select('id', { count: 'exact', head: true })
                .gte('created_at', since.toISOString())
                .or('urgency.eq.high,parameters_completed.gte.4');
            if (!error) lines.push(`Hot/high-intent leads created today (approx): ${count ?? 0}`);
        }

        const phone = phoneDigits(message);
        if (phone) {
            const { data: rows } = await supabase
                .from('leads_surgery')
                .select('id, contact_name, city, phone_number, eye_power, parameters_completed, urgency, created_at, channel')
                .or(`phone_number.ilike.%${phone},phone_number.ilike.%${phone.slice(-10)}%`)
                .order('created_at', { ascending: false })
                .limit(3);
            if (rows?.length) {
                for (const r of rows) {
                    lines.push(`Lead: ${r.contact_name || '—'} | ${r.city || '—'} | power ${r.eye_power || '—'} | score ${r.parameters_completed ?? 0} | ${r.phone_number}`);
                }
            } else {
                lines.push(`No lead found for phone containing ${phone}.`);
            }
        }

        if (lines.length === 0 && /\b(how many|count|total)\b/i.test(m) && ctx.canPulse) {
            const since = new Date();
            since.setHours(0, 0, 0, 0);
            const { count } = await supabase
                .from('leads_surgery')
                .select('id', { count: 'exact', head: true })
                .gte('created_at', since.toISOString());
            lines.push(`New leads_surgery rows today: ${count ?? 0}`);
        }

        if (lines.length === 0) {
            lines.push('Tabs you can use: ' + (ctx.tabs.join(', ') || 'limited'));
            if (!ctx.canExport) lines.push('Bulk export is not enabled for your account.');
        }
    } catch (e) {
        lines.push(`Tool error: ${e.message}`);
    }

    return {
        kind,
        needsFounder: false,
        toolContext: lines.join('\n'),
        data: lines,
    };
}

export function staticOperatorReply(kind, toolResult, llmResult) {
    if (kind === 'bug' || kind === 'feature') {
        return `Thanks — logged as a ${kind === 'bug' ? 'bug report' : 'feature request'} for Jas. You'll be updated after review.`;
    }
    if (llmResult?.ok) return llmResult.reply;
    if (toolResult?.data?.length) return toolResult.data.join('\n');
    if (llmResult?.error === 'operator_quota_exhausted') {
        return 'Internal AI limit reached for today. Your message is saved — Jas can still see it in the Operator inbox.';
    }
    return 'I could not generate a reply right now. Try a shorter question or check the relevant CRM tab.';
}
