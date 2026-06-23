// Role-aware data tools for CRM Operator (no LLM).

const BUG_PATTERNS = /\b(bug|broken|wrong|galat|not working|fix|issue|error|bot said|chatbot|mirror)\b/i;
const FEATURE_PATTERNS = /\b(feature|add|new tab|can we have|request|improvement|suggestion)\b/i;

export function classifyOperatorMessage(text) {
    const t = String(text || '').trim();
    if (BUG_PATTERNS.test(t)) return 'bug';
    if (FEATURE_PATTERNS.test(t)) return 'feature';
    if (/\b(how many|count|kitne|total|hot lead|today)\b/i.test(t)) return 'data';
    if (/\b(lead|phone|\+91|thread|whatsapp|inbox|assignee|assigned)\b/i.test(t)) return 'data';
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

    const patterns = [
        /\bassign(?:ed|ee)?\s+(?:to\s+)?([a-z][a-z\s.'-]{1,48}?)(?:\s+(?:that|who|which|are|is|have|has|with|ke|ki|ko|open|lost|total|count|there|today)\b|[?.!,]|$)/i,
        /\b(?:for|of)\s+([a-z][a-z\s.'-]{1,48}?)(?:\s+(?:leads?|open|assigned|total|count)\b|[?.!,]|$)/i,
        /\b([a-z][a-z\s.'-]{1,48}?)(?:'s| ke| ki)\s+leads?\b/i,
    ];

    for (const re of patterns) {
        const m = raw.match(re);
        if (!m?.[1]) continue;
        const name = m[1].replace(/\s+/g, ' ').trim();
        if (name.length >= 2 && !/^(the|all|any|my|our|their|open|lost|total|how|many)$/i.test(name)) {
            return name;
        }
    }
    return null;
}

/** open | not_lost | lost | converted | null (all) */
export function detectStatusFilter(message) {
    const m = String(message || '').toLowerCase();
    if (/\bnot\s+lost\b|\bopen\s+or\s+not\s+lost\b|\bactive\s+pipeline\b|\bnot\s+lost\b/.test(m)) return 'not_lost';
    if (/\b(deal done|converted|won|closed)\b/.test(m)) return 'converted';
    if (/\blost\b/.test(m) && !/\bnot\s+lost\b/.test(m)) return 'lost';
    if (/\bopen\b/.test(m) && !/\bnot\s+open\b/.test(m)) return 'open';
    return null;
}

function phoneDigits(s) {
    const d = String(s || '').replace(/\D/g, '');
    if (d.length >= 10) return d.slice(-10);
    return null;
}

function namesLooselyMatch(a, b) {
    const x = String(a || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const y = String(b || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!x || !y) return false;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    const xFirst = x.split(' ')[0];
    const yFirst = y.split(' ')[0];
    return xFirst.length >= 3 && xFirst === yFirst;
}

function canQueryAssignee(ctx, assigneeName, user = {}) {
    if (ctx.isAdmin || ctx.role === 'hr') return true;
    if (!assigneeName) return true;
    const who = [user.username, user.designation, user.displayName].filter(Boolean);
    return who.some((n) => namesLooselyMatch(n, assigneeName));
}

function statusLabel(filter) {
    if (filter === 'open') return 'status Open';
    if (filter === 'not_lost') return 'status not Lost / Not Serviceable';
    if (filter === 'lost') return 'status Lost';
    if (filter === 'converted') return 'status Deal Done';
    return 'all statuses';
}

function applyRefrensStatusFilter(q, filter) {
    if (filter === 'open') return q.eq('status', 'Open');
    if (filter === 'lost') return q.eq('status', 'Lost');
    if (filter === 'converted') return q.eq('status', 'Deal Done');
    if (filter === 'not_lost') return q.not('status', 'in', '("Lost","Not Serviceable")');
    return q;
}

async function countRefrensByAssignee(supabase, assigneeName, statusFilter) {
    const needle = assigneeName.trim();
    let q = supabase
        .from('refrens_leads')
        .select('id', { count: 'exact', head: true })
        .or(`assignee.ilike.%${needle}%,last_comment_by.ilike.%${needle}%`);
    q = applyRefrensStatusFilter(q, statusFilter);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
}

async function countChatbotByAssignee(supabase, assigneeName, statusFilter) {
    const needle = assigneeName.trim();
    let q = supabase
        .from('leads_surgery')
        .select('id', { count: 'exact', head: true })
        .ilike('assignee', `%${needle}%`);
    if (statusFilter === 'open') q = q.eq('status', 'Open');
    else if (statusFilter === 'lost') q = q.eq('status', 'Lost');
    else if (statusFilter === 'converted') q = q.in('status', ['Deal Done', 'Converted', 'Won']);
    else if (statusFilter === 'not_lost') q = q.not('status', 'in', '("Lost","Not Serviceable")');
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
}

export async function runOperatorTools(message, ctx, supabase, user = {}) {
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

    if (!ctx.canChatbot && !ctx.canAnalytics && !ctx.isAdmin) {
        lines.push('Your role does not include lead data access (Chatbot or Analytics tab required).');
        return { kind, needsFounder: false, toolContext: lines.join('\n'), data: null };
    }

    try {
        const assigneeName = extractAssigneeName(message);
        const statusFilter = detectStatusFilter(message);
        const wantsCount = /\b(how many|count|kitne|total|number of)\b/i.test(m);

        if (assigneeName && wantsCount) {
            if (!canQueryAssignee(ctx, assigneeName, user)) {
                lines.push(`You can only query lead counts for your own assignee name (${user.designation || user.username || 'your account'}).`);
            } else if (ctx.canAnalytics || ctx.isAdmin) {
                const refrensCount = await countRefrensByAssignee(supabase, assigneeName, statusFilter);
                lines.push(
                    `Refrens CRM leads assigned to "${assigneeName}" (${statusLabel(statusFilter)}): ${refrensCount}`,
                );
                lines.push('(Matches assignee or last_comment_by — same logic as Analytics.)');
            }
            if ((ctx.canChatbot || ctx.isAdmin) && canQueryAssignee(ctx, assigneeName, user)) {
                const botCount = await countChatbotByAssignee(supabase, assigneeName, statusFilter);
                lines.push(
                    `Chatbot leads_surgery rows for assignee "${assigneeName}" (${statusLabel(statusFilter)}): ${botCount}`,
                );
            }
        }

        if (lines.length === 0 && /\b(hot|urgent)\b/i.test(m) && /\b(how many|count|kitne|today)\b/i.test(m)) {
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
                .select('id, contact_name, city, phone_number, eye_power, parameters_completed, urgency, created_at, channel, assignee, status')
                .or(`phone_number.ilike.%${phone},phone_number.ilike.%${phone.slice(-10)}%`)
                .order('created_at', { ascending: false })
                .limit(3);
            if (rows?.length) {
                for (const r of rows) {
                    lines.push(`Lead: ${r.contact_name || '—'} | ${r.city || '—'} | assignee ${r.assignee || '—'} | status ${r.status || '—'} | power ${r.eye_power || '—'} | ${r.phone_number}`);
                }
            } else {
                lines.push(`No lead found for phone containing ${phone}.`);
            }
        }

        if (lines.length === 0 && /\btoday\b/i.test(m) && /\b(how many|count|new|kitne)\b/i.test(m) && ctx.canPulse) {
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
            lines.push('Try: "How many leads assigned to Khushi with status Open?" or search by phone number.');
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
