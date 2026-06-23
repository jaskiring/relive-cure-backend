// Deterministic data playbooks — run SQL tools directly (no LLM hallucination).

import {
    classifyOperatorMessage,
    extractAssigneeName,
    detectStatusFilter,
} from './operator-tools.js';
import { executeOperatorTool } from './operator-playbooks.js';

export function isDataQuestion(message) {
    return classifyOperatorMessage(message) === 'data';
}

/** Infer status filter from natural language. */
export function inferStatusFilter(message) {
    const explicit = detectStatusFilter(message);
    if (explicit) return explicit;
    const m = String(message || '').toLowerCase();
    if (/\bnot\s+lost\b|\bnot\s+lost\s+or\b/.test(m)) return 'not_lost';
    if (/\bopen\b/.test(m) && !/\bnot\s+open\b/.test(m)) return 'open';
    return 'all';
}

export function isGoogleDailyLimit(detail) {
    return /GenerateRequestsPerDay|free_tier_requests|PerDayPerProjectPerModel/i.test(detail || '');
}

export function isGoogleTransientLimit(detail) {
    const d = detail || '';
    return (/429|RESOURCE_EXHAUSTED/i.test(d) && !isGoogleDailyLimit(d))
        || /RPM|requests per minute|retry in/i.test(d);
}

/**
 * Run matching tools for a data question without waiting for Gemini.
 * @returns {{ results: object[], assignee: string|null, status: string }}
 */
export async function runDataPlaybook(message, ctx, supabase, user) {
    const results = [];
    const assignee = extractAssigneeName(message);
    const status = inferStatusFilter(message);
    const m = String(message || '').toLowerCase();
    const wantsCount = /\b(how many|count|tell me|total|number of|leads?\s+are)\b/i.test(m);

    if (assignee && wantsCount) {
        if (ctx.canAnalytics || ctx.isAdmin) {
            const r = await executeOperatorTool(
                'count_refrens_by_assignee',
                { assignee_name: assignee, status_filter: status },
                { ctx, supabase, user },
            );
            results.push({ tool: 'count_refrens_by_assignee', ...r });
        }
        if (ctx.canChatbot || ctx.isAdmin) {
            const r2 = await executeOperatorTool(
                'count_chatbot_by_assignee',
                { assignee_name: assignee, status_filter: status },
                { ctx, supabase, user },
            );
            results.push({ tool: 'count_chatbot_by_assignee', ...r2 });
        }
    }

    if (phoneDigits(message)) {
        const r = await executeOperatorTool(
            'lookup_lead_by_phone',
            { phone: phoneDigits(message) },
            { ctx, supabase, user },
        );
        results.push({ tool: 'lookup_lead_by_phone', ...r });
    }

    if (!results.length && wantsCount && /\b(hot|urgent)\b/i.test(m) && /\btoday\b/i.test(m)) {
        const r = await executeOperatorTool('count_hot_chatbot_leads_today', {}, { ctx, supabase, user });
        results.push({ tool: 'count_hot_chatbot_leads_today', ...r });
    }

    if (!results.length && wantsCount && /\btoday\b/i.test(m) && /\b(new|how many)\b/i.test(m)) {
        const r = await executeOperatorTool('count_new_chatbot_leads_today', {}, { ctx, supabase, user });
        results.push({ tool: 'count_new_chatbot_leads_today', ...r });
    }

    if (!results.length && wantsCount && !assignee && (ctx.canAnalytics || ctx.isAdmin)) {
        const r = await executeOperatorTool(
            'count_refrens_pipeline',
            { status_filter: status === 'all' ? 'open' : status },
            { ctx, supabase, user },
        );
        results.push({ tool: 'count_refrens_pipeline', ...r });
    }

    return { results, assignee, status };
}

function phoneDigits(s) {
    const d = String(s || '').replace(/\D/g, '');
    if (d.length >= 10) return d.slice(-10);
    return null;
}

/** Format tool results into staff-facing reply (exact counts, no LLM). */
export function formatDataPlaybookReply(playbook) {
    const lines = [];
    for (const r of playbook.results || []) {
        if (r.error) {
            lines.push(r.message || `Could not run ${r.tool || 'query'}: ${r.error}`);
            continue;
        }
        if (r.count !== undefined && r.source) {
            const who = r.query_name || r.assignee_name || 'pipeline';
            const st = r.status_label || r.status_filter || 'filtered';
            lines.push(`${r.source === 'refrens_leads' ? 'Refrens CRM (Analytics)' : 'WhatsApp bot'}: ${r.count} leads for "${who}" (${st}).`);
            if (r.matched_assignees?.length) {
                lines.push(`CRM assignee names matched: ${r.matched_assignees.join(', ')}.`);
            }
            if (r.count === 0 && r.matched_assignees?.length) {
                lines.push('Zero for this status filter — names exist in CRM under other statuses; try "not lost" or check Analytics.');
            }
        }
        if (r.matches?.length) {
            for (const row of r.matches.slice(0, 3)) {
                lines.push(`Lead ${row.contact_name || '—'} | ${row.assignee || '—'} | ${row.status || '—'} | ${row.phone_number}`);
            }
        }
    }
    if (!lines.length) return null;
    return lines.join('\n');
}

export function playbookHasUsableData(playbook) {
    return (playbook.results || []).some(
        (r) => !r.error && (r.count !== undefined || (r.matches && r.matches.length)),
    );
}
