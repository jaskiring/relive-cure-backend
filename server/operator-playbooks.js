// CRM Operator tool registry + playbooks — Gemini calls these via function calling.

import {
    extractAssigneeName,
    extractCityFromMessage,
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

function applyRefrensCityFilter(q, city) {
    if (!city) return q;
    const c = String(city).trim();
    return q.or(`customer_city.ilike.%${c}%,city_preference.ilike.%${c}%`);
}

function applyChatbotCityFilter(q, city) {
    if (!city) return q;
    return q.ilike('city', `%${String(city).trim()}%`);
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
            description: 'Count Refrens CRM leads (Analytics) for an assignee name. Optional city filter (customer_city). Matches assignee or last_comment_by.',
            parameters: {
                type: 'object',
                properties: {
                    assignee_name: { type: 'string', description: 'Rep name e.g. Khushi, Nishikant' },
                    status_filter: {
                        type: 'string',
                        enum: ['all', 'open', 'not_lost', 'lost', 'converted'],
                        description: 'open | not_lost (active pipeline) | lost | converted (Deal Done) | all',
                    },
                    city: { type: 'string', description: 'Optional city e.g. Mumbai, Delhi, Pune' },
                },
                required: ['assignee_name'],
            },
        });
        decls.push({
            name: 'count_refrens_by_city',
            description: 'Count Refrens CRM leads in a city (customer_city or treatment city preference). All assignees.',
            parameters: {
                type: 'object',
                properties: {
                    city: { type: 'string', description: 'City name e.g. Mumbai' },
                    status_filter: {
                        type: 'string',
                        enum: ['all', 'open', 'not_lost', 'lost', 'converted'],
                    },
                },
                required: ['city'],
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
            description: 'Count WhatsApp bot leads (leads_surgery) for an assignee. Optional city filter.',
            parameters: {
                type: 'object',
                properties: {
                    assignee_name: { type: 'string' },
                    status_filter: {
                        type: 'string',
                        enum: ['all', 'open', 'not_lost', 'lost', 'converted'],
                    },
                    city: { type: 'string', description: 'Optional city e.g. Mumbai' },
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

    if (ctx.canMarketing || ctx.isAdmin) {
        decls.push({
            name: 'marketing_account_summary',
            description: 'Meta Ads account totals for last 30 days: spend, leads, impressions, average CPL across all synced campaigns.',
            parameters: { type: 'object', properties: {}, required: [] },
        });
        decls.push({
            name: 'rank_marketing_campaigns',
            description: 'Rank Meta ad campaigns by performance (last 30 days). Use for "which campaign is working best", top CPL, most leads, etc.',
            parameters: {
                type: 'object',
                properties: {
                    metric: {
                        type: 'string',
                        enum: ['leads', 'cpl', 'spend', 'efficiency'],
                        description: 'leads = most leads; cpl = lowest cost per lead; spend = highest spend; efficiency = leads per ₹1000 spend',
                    },
                    limit: { type: 'number', description: 'How many campaigns to return (default 5)' },
                    delivering_only: {
                        type: 'boolean',
                        description: 'If true, only campaigns with spend in last 4 days (actively delivering)',
                    },
                },
                required: [],
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

async function countRefrensByAssignee(supabase, assigneeName, statusFilter, city = null) {
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
    q = applyRefrensCityFilter(q, city);
    q = applyRefrensStatusFilter(q, statusFilter === 'all' ? null : statusFilter);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return { count: count ?? 0, matched_assignees: matched, query_name: needle, city: city || null };
}

async function countRefrensByCity(supabase, city, statusFilter) {
    let q = supabase
        .from('refrens_leads')
        .select('id', { count: 'exact', head: true });
    q = applyRefrensCityFilter(q, city);
    q = applyRefrensStatusFilter(q, statusFilter === 'all' ? null : statusFilter);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
}

async function countRefrensPipeline(supabase, statusFilter) {
    let q = supabase.from('refrens_leads').select('id', { count: 'exact', head: true });
    q = applyRefrensStatusFilter(q, statusFilter === 'all' ? null : statusFilter);
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
}

async function countChatbotByAssignee(supabase, assigneeName, statusFilter, city = null) {
    const needle = assigneeName.trim();
    let q = supabase
        .from('leads_surgery')
        .select('id', { count: 'exact', head: true })
        .ilike('assignee', `%${needle}%`);
    q = applyChatbotCityFilter(q, city);
    const f = statusFilter === 'all' ? null : statusFilter;
    if (f === 'open') q = q.eq('status', 'Open');
    else if (f === 'lost') q = q.eq('status', 'Lost');
    else if (f === 'converted') q = q.in('status', ['Deal Done', 'Converted', 'Won']);
    else if (f === 'not_lost') q = q.not('status', 'in', '("Lost","Not Serviceable")');
    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return count ?? 0;
}

async function loadCampaignTotals(supabase) {
    const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const recentCutoff = new Date(Date.now() - 4 * 86400 * 1000).toISOString().slice(0, 10);

    const { data: campaigns, error: cErr } = await supabase
        .from('meta_campaigns')
        .select('id, name, objective, status, daily_budget')
        .order('name', { ascending: true });
    if (cErr) throw new Error(cErr.message);

    const { data: insights, error: iErr } = await supabase
        .from('meta_ad_insights')
        .select('campaign_id, spend, impressions, clicks, leads, date')
        .gte('date', since);
    if (iErr) throw new Error(iErr.message);

    const totals = {};
    for (const r of (insights || [])) {
        const t = totals[r.campaign_id] = totals[r.campaign_id] || {
            spend: 0, impressions: 0, clicks: 0, leads: 0, recentSpend: 0,
        };
        t.spend += Number(r.spend || 0);
        t.impressions += Number(r.impressions || 0);
        t.clicks += Number(r.clicks || 0);
        t.leads += Number(r.leads || 0);
        if (r.date >= recentCutoff) t.recentSpend += Number(r.spend || 0);
    }

    const rows = (campaigns || []).map((c) => {
        const t = totals[c.id] || { spend: 0, impressions: 0, clicks: 0, leads: 0, recentSpend: 0 };
        const delivering = (c.status === 'ACTIVE') && t.recentSpend > 0;
        const cpl = t.leads > 0 ? Math.round((t.spend / t.leads) * 100) / 100 : null;
        const efficiency = t.spend > 0 ? Math.round((t.leads / t.spend) * 1000 * 100) / 100 : null;
        return {
            id: c.id,
            name: c.name,
            status: c.status,
            objective: c.objective,
            spend: Math.round(t.spend * 100) / 100,
            impressions: t.impressions,
            clicks: t.clicks,
            leads: t.leads,
            cpl,
            efficiency,
            delivering,
        };
    });

    return { rows, since, recentCutoff };
}

function rankCampaigns(rows, metric = 'leads', limit = 5, deliveringOnly = false) {
    let pool = deliveringOnly ? rows.filter((c) => c.delivering) : rows.slice();
    if (!pool.length) pool = rows.slice();

    const sorters = {
        leads: (a, b) => b.leads - a.leads || (a.cpl ?? 999999) - (b.cpl ?? 999999),
        spend: (a, b) => b.spend - a.spend,
        cpl: (a, b) => {
            const ac = a.cpl ?? 999999;
            const bc = b.cpl ?? 999999;
            if (a.leads < 1 && b.leads < 1) return 0;
            if (a.leads < 1) return 1;
            if (b.leads < 1) return -1;
            return ac - bc;
        },
        efficiency: (a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0),
    };
    const sortFn = sorters[metric] || sorters.leads;
    return pool.sort(sortFn).slice(0, Math.min(limit, 10));
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
                can_marketing: ctx.canMarketing,
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
            const city = a.city ? String(a.city).trim() : null;
            const { count, matched_assignees, query_name } = await countRefrensByAssignee(
                supabase, assignee, statusFilter, city,
            );
            return {
                source: 'refrens_leads',
                assignee_name: assignee,
                query_name,
                status_filter: statusFilter,
                status_label: statusLabel(statusFilter === 'all' ? null : statusFilter),
                city,
                count,
                matched_assignees,
            };
        }

        case 'count_refrens_by_city': {
            if (!ctx.canAnalytics && !ctx.isAdmin) {
                return { error: 'permission_denied', message: 'Analytics tab required.' };
            }
            const city = String(a.city || '').trim();
            if (!city) return { error: 'missing_city' };
            const statusFilter = a.status_filter || 'all';
            const count = await countRefrensByCity(supabase, city, statusFilter);
            return {
                source: 'refrens_leads',
                city,
                status_filter: statusFilter,
                status_label: statusLabel(statusFilter === 'all' ? null : statusFilter),
                count,
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
            const city = a.city ? String(a.city).trim() : null;
            const count = await countChatbotByAssignee(supabase, assignee, statusFilter, city);
            return {
                source: 'leads_surgery',
                assignee_name: assignee,
                status_filter: statusFilter,
                city,
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

        case 'marketing_account_summary': {
            if (!ctx.canMarketing && !ctx.isAdmin) {
                return { error: 'permission_denied', message: 'Marketing tab access required for Meta Ads data.' };
            }
            const { rows, since } = await loadCampaignTotals(supabase);
            const summary = rows.reduce((acc, c) => {
                acc.spend += c.spend;
                acc.leads += c.leads;
                acc.impressions += c.impressions;
                acc.clicks += c.clicks;
                if (c.delivering) acc.delivering_count += 1;
                return acc;
            }, { spend: 0, leads: 0, impressions: 0, clicks: 0, delivering_count: 0, campaign_count: rows.length });
            summary.avg_cpl = summary.leads > 0
                ? Math.round((summary.spend / summary.leads) * 100) / 100
                : null;
            return {
                source: 'meta_ad_insights',
                period: `last 30 days since ${since}`,
                summary,
            };
        }

        case 'rank_marketing_campaigns': {
            if (!ctx.canMarketing && !ctx.isAdmin) {
                return { error: 'permission_denied', message: 'Marketing tab access required for campaign rankings.' };
            }
            const metric = a.metric || 'leads';
            const limit = Math.min(parseInt(a.limit, 10) || 5, 10);
            const deliveringOnly = !!a.delivering_only;
            const { rows, since } = await loadCampaignTotals(supabase);
            if (!rows.length) {
                return {
                    source: 'meta_campaigns',
                    error: 'no_data',
                    message: 'No synced Meta campaigns yet — open Marketing tab and click Sync now.',
                };
            }
            const campaigns = rankCampaigns(rows, metric, limit, deliveringOnly);
            return {
                source: 'meta_ad_insights',
                metric,
                delivering_only: deliveringOnly,
                period: `last 30 days since ${since}`,
                campaigns,
            };
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
    if (extractAssigneeName(message) && /\b(how many|count|total|tell me|leads?|hold|holds)\b/i.test(m)) {
        hints.push('count_refrens_by_assignee', 'count_chatbot_by_assignee');
    }
    const city = extractCityFromMessage(message);
    if (city && /\b(how many|count|total|leads?)\b/i.test(m)) {
        hints.push('count_refrens_by_city');
        if (extractAssigneeName(message)) {
            hints.push('count_refrens_by_assignee', 'count_chatbot_by_assignee');
        }
    }
    if (detectStatusFilter(message)) hints.push('count_refrens_pipeline');
    if (phoneDigits(message)) hints.push('lookup_lead_by_phone');
    if (/\btoday\b/.test(m) && /\b(hot|urgent)\b/.test(m)) hints.push('count_hot_chatbot_leads_today');
    if (/\btoday\b/.test(m) && /\b(new|how many)\b/.test(m)) hints.push('count_new_chatbot_leads_today');
    if (/\b(marketing|campaign|meta ads?|cpl|ad spend)\b/.test(m)
        && /\b(best|top|which|working|perform|rank|compare|effective)\b/.test(m)) {
        hints.push('rank_marketing_campaigns');
    }
    if (/\b(marketing|meta ads?)\b/.test(m) && /\b(total|summary|overall|account)\b/.test(m)) {
        hints.push('marketing_account_summary');
    }
    return [...new Set(hints)];
}

export { buildOperatorContext };
