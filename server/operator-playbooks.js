// CRM Operator tool registry + playbooks — Gemini calls these via function calling.

import {
    extractAssigneeName,
    detectStatusFilter,
    buildOperatorContext,
} from './operator-tools.js';

export const CRM_OVERVIEW = `Relive Cure CRM (LASIK) — internal dashboard for Relive Cure eye-care leads.

Tabs:
- Pulse: today's flow — new leads, hot queue, SLA, MTD deals.
- Chatbot: WhatsApp bot leads (leads_surgery) — qualification, push to Refrens CRM.
- Bot Lab: sandbox test chats (same bot logic as production).
- WhatsApp Chat: live WABA inbox for reps.
- Analytics: Refrens CRM pipeline — 1200+ leads, status Open/Lost/Deal Done, assignees, export.
- Marketing: Meta Ads campaigns, CPL, audience segments.
- HR / Team: employees, payroll hooks.
- Settings: users, roles, tab access (admin).

Operator (this chat): staff ask data questions, report bugs/features → Founder inbox for Jas.

Data sources:
- refrens_leads = main CRM / Analytics (assignee, status, labels).
- leads_surgery = WhatsApp bot captured leads.
- Role + tab access controls what each user can query.`;

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
    if (xFirst.length >= 3 && xFirst === yFirst) return true;
    const prefixLen = 4;
    if (xFirst.length >= prefixLen && yFirst.length >= prefixLen
        && xFirst.slice(0, prefixLen) === yFirst.slice(0, prefixLen)) return true;
    return false;
}

function canQueryAssignee(ctx, assigneeName, user = {}) {
    if (ctx.isAdmin || ctx.role === 'hr') return true;
    if (!assigneeName) return true;
    const who = [user.username, user.designation, user.displayName].filter(Boolean);
    return who.some((n) => namesLooselyMatch(n, assigneeName));
}

/** @typedef {{ ctx: object, supabase: object, user: object }} ToolRuntime */

/** Tool definitions exposed to Gemini (filtered by RBAC). */
export function getOperatorToolDeclarations(ctx) {
    const decls = [
        {
            name: 'crm_overview',
            description: 'Explain what Relive Cure CRM does, its tabs, and data sources. Use for "what is this", "what does CRM do", onboarding, how-to questions.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        {
            name: 'user_access_summary',
            description: 'List which dashboard tabs and permissions the current user has.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    ];

    if (ctx.canAnalytics || ctx.isAdmin) {
        decls.push({
            name: 'count_refrens_by_assignee',
            description: 'Count Refrens CRM leads (Analytics) for an assignee name. Matches assignee or last_comment_by.',
            parameters: {
                type: 'object',
                properties: {
                    assignee_name: { type: 'string', description: 'Rep name e.g. Khushi, Khushi Tomar' },
                    status_filter: {
                        type: 'string',
                        enum: ['all', 'open', 'not_lost', 'lost', 'converted'],
                        description: 'open | not_lost (active pipeline) | lost | converted (Deal Done) | all',
                    },
                },
                required: ['assignee_name'],
            },
        });
        decls.push({
            name: 'count_refrens_pipeline',
            description: 'Count Refrens leads by pipeline status (all reps).',
            parameters: {
                type: 'object',
                properties: {
                    status_filter: {
                        type: 'string',
                        enum: ['open', 'not_lost', 'lost', 'converted', 'all'],
                    },
                },
                required: [],
            },
        });
    }

    if (ctx.canChatbot || ctx.isAdmin) {
        decls.push({
            name: 'count_chatbot_by_assignee',
            description: 'Count WhatsApp bot leads (leads_surgery) for an assignee.',
            parameters: {
                type: 'object',
                properties: {
                    assignee_name: { type: 'string' },
                    status_filter: {
                        type: 'string',
                        enum: ['all', 'open', 'not_lost', 'lost', 'converted'],
                    },
                },
                required: ['assignee_name'],
            },
        });
        decls.push({
            name: 'count_new_chatbot_leads_today',
            description: 'Count new leads_surgery rows created today (UTC).',
            parameters: { type: 'object', properties: {}, required: [] },
        });
        decls.push({
            name: 'count_hot_chatbot_leads_today',
            description: 'Count high-urgency or high-score bot leads created today.',
            parameters: { type: 'object', properties: {}, required: [] },
        });
        decls.push({
            name: 'lookup_lead_by_phone',
            description: 'Find chatbot lead rows by phone number (last 10 digits).',
            parameters: {
                type: 'object',
                properties: {
                    phone: { type: 'string', description: 'Phone number or last 10 digits' },
                },
                required: ['phone'],
            },
        });
    }

    return decls;
}

async function findMatchingAssignees(supabase, needle) {
    const term = needle.trim();
    const first = term.split(/\s+/)[0];
    const terms = [...new Set([term, first].filter((t) => t.length >= 3))];
    const names = new Set();
    for (const t of terms) {
        const { data } = await supabase
            .from('refrens_leads')
            .select('assignee, last_comment_by')
            .or(`assignee.ilike.%${t}%,last_comment_by.ilike.%${t}%`)
            .limit(400);
        for (const row of data || []) {
            for (const field of [row.assignee, row.last_comment_by]) {
                if (!field || String(field).trim() === '-' || String(field).trim() === '') continue;
                const f = String(field).trim();
                if (namesLooselyMatch(f, term) || f.toLowerCase().includes(term.toLowerCase().slice(0, 4))) {
                    names.add(f);
                }
            }
        }
    }
    return [...names].slice(0, 10);
}

async function countRefrensByAssignee(supabase, assigneeName, statusFilter) {
    const needle = assigneeName.trim();
    const matched = await findMatchingAssignees(supabase, needle);

    let q;
    if (matched.length) {
        q = supabase
            .from('refrens_leads')
            .select('id', { count: 'exact', head: true })
            .in('assignee', matched);
    } else {
        const firstToken = needle.split(/\s+/)[0];
        const clauses = new Set([
            `assignee.ilike.%${needle}%`,
            `last_comment_by.ilike.%${needle}%`,
        ]);
        if (firstToken.length >= 4) {
            clauses.add(`assignee.ilike.%${firstToken}%`);
            clauses.add(`last_comment_by.ilike.%${firstToken}%`);
        }
        q = supabase
            .from('refrens_leads')
            .select('id', { count: 'exact', head: true })
            .or([...clauses].join(','));
    }
    q = applyRefrensStatusFilter(q, statusFilter === 'all' ? null : statusFilter);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return { count: count ?? 0, matched_assignees: matched, query_name: needle };
}

async function countRefrensPipeline(supabase, statusFilter) {
    let q = supabase.from('refrens_leads').select('id', { count: 'exact', head: true });
    q = applyRefrensStatusFilter(q, statusFilter === 'all' ? null : statusFilter);
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
    const f = statusFilter === 'all' ? null : statusFilter;
    if (f === 'open') q = q.eq('status', 'Open');
    else if (f === 'lost') q = q.eq('status', 'Lost');
    else if (f === 'converted') q = q.in('status', ['Deal Done', 'Converted', 'Won']);
    else if (f === 'not_lost') q = q.not('status', 'in', '("Lost","Not Serviceable")');
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
}

/**
 * Execute one Operator tool. Returns JSON-serializable object for Gemini functionResponse.
 * @param {string} name
 * @param {object} args
 * @param {ToolRuntime} runtime
 */
export async function executeOperatorTool(name, args, { ctx, supabase, user }) {
    const a = args || {};

    switch (name) {
        case 'crm_overview':
            return { summary: CRM_OVERVIEW };

        case 'user_access_summary':
            return {
                role: ctx.role,
                tabs: ctx.tabs,
                can_export: ctx.canExport,
                can_analytics: ctx.canAnalytics,
                can_chatbot: ctx.canChatbot,
                can_pulse: ctx.canPulse,
                is_admin: ctx.isAdmin,
            };

        case 'count_refrens_by_assignee': {
            if (!ctx.canAnalytics && !ctx.isAdmin) {
                return { error: 'permission_denied', message: 'Analytics tab required.' };
            }
            const assignee = String(a.assignee_name || '').trim();
            if (!assignee) return { error: 'missing_assignee' };
            if (!canQueryAssignee(ctx, assignee, user)) {
                return { error: 'permission_denied', message: 'You can only query your own assignee stats.' };
            }
            const statusFilter = a.status_filter || 'all';
            const { count, matched_assignees, query_name } = await countRefrensByAssignee(supabase, assignee, statusFilter);
            return {
                source: 'refrens_leads',
                assignee_name: assignee,
                query_name,
                status_filter: statusFilter,
                status_label: statusLabel(statusFilter === 'all' ? null : statusFilter),
                count,
                matched_assignees,
            };
        }

        case 'count_refrens_pipeline': {
            if (!ctx.canAnalytics && !ctx.isAdmin) {
                return { error: 'permission_denied', message: 'Analytics tab required.' };
            }
            const statusFilter = a.status_filter || 'open';
            const count = await countRefrensPipeline(supabase, statusFilter);
            return {
                source: 'refrens_leads',
                status_filter: statusFilter,
                count,
            };
        }

        case 'count_chatbot_by_assignee': {
            if (!ctx.canChatbot && !ctx.isAdmin) {
                return { error: 'permission_denied', message: 'Chatbot tab required.' };
            }
            const assignee = String(a.assignee_name || '').trim();
            if (!assignee) return { error: 'missing_assignee' };
            if (!canQueryAssignee(ctx, assignee, user)) {
                return { error: 'permission_denied', message: 'You can only query your own assignee stats.' };
            }
            const statusFilter = a.status_filter || 'all';
            const count = await countChatbotByAssignee(supabase, assignee, statusFilter);
            return {
                source: 'leads_surgery',
                assignee_name: assignee,
                status_filter: statusFilter,
                count,
            };
        }

        case 'count_new_chatbot_leads_today': {
            if (!ctx.canChatbot && !ctx.isAdmin && !ctx.canPulse) {
                return { error: 'permission_denied' };
            }
            const since = new Date();
            since.setHours(0, 0, 0, 0);
            const { count, error } = await supabase
                .from('leads_surgery')
                .select('id', { count: 'exact', head: true })
                .gte('created_at', since.toISOString());
            if (error) throw new Error(error.message);
            return { source: 'leads_surgery', metric: 'new_today', count: count ?? 0 };
        }

        case 'count_hot_chatbot_leads_today': {
            if (!ctx.canChatbot && !ctx.isAdmin && !ctx.canPulse) {
                return { error: 'permission_denied' };
            }
            const since = new Date();
            since.setHours(0, 0, 0, 0);
            const { count, error } = await supabase
                .from('leads_surgery')
                .select('id', { count: 'exact', head: true })
                .gte('created_at', since.toISOString())
                .or('urgency.eq.high,parameters_completed.gte.4');
            if (error) throw new Error(error.message);
            return { source: 'leads_surgery', metric: 'hot_today', count: count ?? 0 };
        }

        case 'lookup_lead_by_phone': {
            if (!ctx.canChatbot && !ctx.isAdmin) {
                return { error: 'permission_denied' };
            }
            const phone = phoneDigits(a.phone || '');
            if (!phone) return { error: 'invalid_phone' };
            const { data: rows, error } = await supabase
                .from('leads_surgery')
                .select('id, contact_name, city, phone_number, eye_power, parameters_completed, urgency, created_at, channel, assignee, status')
                .or(`phone_number.ilike.%${phone}%,phone_number.ilike.%${phone.slice(-10)}%`)
                .order('created_at', { ascending: false })
                .limit(5);
            if (error) throw new Error(error.message);
            return { matches: rows || [] };
        }

        default:
            return { error: 'unknown_tool', name };
    }
}

/** Suggest tools from message keywords (hint for logs / future routing). */
export function suggestToolsForMessage(message) {
    const m = String(message || '').toLowerCase();
    const hints = [];
    if (/\b(what is|what does|how does|explain|overview|purpose)\b/.test(m)) hints.push('crm_overview');
    if (extractAssigneeName(message) && /\b(how many|count|total|tell me|leads?)\b/i.test(m)) {
        hints.push('count_refrens_by_assignee', 'count_chatbot_by_assignee');
    }
    if (detectStatusFilter(message)) hints.push('count_refrens_pipeline');
    if (phoneDigits(message)) hints.push('lookup_lead_by_phone');
    if (/\btoday\b/.test(m) && /\b(hot|urgent)\b/.test(m)) hints.push('count_hot_chatbot_leads_today');
    if (/\btoday\b/.test(m) && /\b(new|how many)\b/.test(m)) hints.push('count_new_chatbot_leads_today');
    return [...new Set(hints)];
}

export { buildOperatorContext };
