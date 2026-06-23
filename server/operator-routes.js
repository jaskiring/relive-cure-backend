// CRM Operator API — staff chat, voice transcribe, founder inbox (separate Gemini quotas).

import { transcribeOperatorAudio, operatorGeminiStatus } from './operator-gemini.js';
import { runOperatorAgent, operatorLastGeminiError } from './operator-agent.js';
import { staticOperatorReply, checkFounderRoute, buildOperatorContext } from './operator-tools.js';
import { quotaStatusAll, quotaDashboard, ensureQuotaHydrated, tickRequest } from './agent-quota.js';
import { warnIfOperatorInboxMissing, checkOperatorInboxTable, OPERATOR_MIGRATION_SQL } from './operator-schema.js';

function hasExportPermission(tabs, role) {
    return role === 'admin' || (tabs || []).includes('export_leads');
}

async function saveInbox(supabase, row) {
    const { data, error } = await supabase
        .from('operator_inbox')
        .insert({
            ...row,
            updated_at: new Date().toISOString(),
        })
        .select('id, kind, status, needs_founder, created_at')
        .single();
    if (error) {
        const msg = error.message || 'insert failed';
        console.error('[OPERATOR] inbox insert failed:', msg);
        const hint = /operator_inbox|does not exist|relation/i.test(msg)
            ? ' Run server/migrations/alter_agent_quota_channels.sql in Supabase SQL editor.'
            : '';
        return { id: null, error: msg + hint };
    }
    return { id: data.id, ...data };
}

async function inboxTableOk(supabase) {
    const { ok } = await checkOperatorInboxTable(supabase);
    return ok;
}

export function registerOperatorRoutes(app, deps) {
    const {
        requireCrmKey,
        supabaseAdmin,
        getAllowedTabsForUser,
        fanout,
        isPushConfigured,
        upload,
    } = deps;

    app.get('/api/operator/quota', async (req, res) => {
        if (!(await requireCrmKey(req, res))) return;
        await ensureQuotaHydrated();
        res.json({
            success: true,
            quotas: quotaStatusAll(),
            quota_dashboard: quotaDashboard(),
            models: operatorGeminiStatus(),
        });
    });

    app.get('/api/operator/history', async (req, res) => {
        if (!(await requireCrmKey(req, res))) return;
        const user = req.dashboardUser;
        const limit = Math.min(parseInt(req.query.limit || '30', 10), 50);
        const { data, error } = await supabaseAdmin
            .from('operator_inbox')
            .select('id, message, reply, kind, status, needs_founder, created_at')
            .eq('username', user.username)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) {
            if (/operator_inbox|does not exist|schema cache/i.test(error.message || '')) {
                return res.json({ success: true, messages: [], inbox_ready: false });
            }
            return res.status(500).json({ success: false, error: error.message });
        }
        res.json({ success: true, messages: (data || []).reverse() });
    });

    app.get('/api/operator/inbox', async (req, res) => {
        if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
        const pendingOnly = req.query.pending === '1';

        let q = supabaseAdmin
            .from('operator_inbox')
            .select('id, username, role, designation, message, transcript, kind, status, reply, needs_founder, dev_status, created_at')
            .eq('needs_founder', true)
            .order('created_at', { ascending: false })
            .limit(80);
        if (pendingOnly) q = q.in('status', ['queued', 'pending']);
        const { data, error } = await q;
        if (error) {
            const missing = /operator_inbox|does not exist|schema cache/i.test(error.message || '');
            return res.status(missing ? 503 : 500).json({
                success: false,
                error: error.message,
                inbox_ready: false,
                migration: missing ? OPERATOR_MIGRATION_SQL : null,
            });
        }
        res.json({ success: true, items: data || [], scope: 'founder', inbox_ready: true });
    });

    app.post('/api/operator/transcribe', upload.single('audio'), async (req, res) => {
        if (!(await requireCrmKey(req, res))) return;
        const file = req.file;
        if (!file?.buffer?.length) {
            return res.status(400).json({ success: false, error: 'audio file required' });
        }
        const result = await transcribeOperatorAudio(file.buffer, file.mimetype || 'audio/webm');
        if (!result.ok) {
            return res.status(503).json({ success: false, error: result.error });
        }
        res.json({ success: true, transcript: result.transcript, model: result.model });
    });

    app.post('/api/operator/chat', async (req, res) => {
        if (!(await requireCrmKey(req, res))) return;
        const user = req.dashboardUser;
        const message = String(req.body?.message || '').trim();
        const transcript = req.body?.transcript ? String(req.body.transcript).trim() : null;
        const text = message || transcript;
        if (!text || text.length > 4000) {
            return res.status(400).json({ success: false, error: 'message required (max 4000 chars)' });
        }

        const tabs = await getAllowedTabsForUser(user);
        const designation = req.body?.designation || null;
        const ctx = buildOperatorContext(user.role, tabs, {
            canExport: hasExportPermission(tabs, user.role),
        });

        const founderRoute = checkFounderRoute(text);

        let agentResult = null;
        if (!founderRoute.needsFounder) {
            agentResult = await runOperatorAgent({
                message: text,
                role: user.role,
                designation: designation || user.designation || null,
                ctx,
                supabase: supabaseAdmin,
                user: {
                    username: user.username,
                    designation: designation || user.designation || null,
                },
            });
        }

        const kind = founderRoute.kind;
        let reply = staticOperatorReply(kind, founderRoute, agentResult);
        const status = founderRoute.needsFounder
            ? 'queued'
            : (agentResult?.ok ? 'answered' : 'limited');

        const saved = await saveInbox(supabaseAdmin, {
            username: user.username,
            role: user.role,
            designation,
            message: message || '(voice)',
            transcript: transcript || null,
            kind,
            status,
            reply,
            tool_data: {
                tools_called: agentResult?.toolsCalled || [],
                model: agentResult?.model || null,
                agent_error: agentResult?.error || null,
            },
            model_used: agentResult?.model || null,
            needs_founder: founderRoute.needsFounder,
        });

        if (saved.error && founderRoute.needsFounder) {
            reply += `\n\n⚠️ Could not save to Founder inbox: ${saved.error}`;
        }

        // Count every operator chat (SQL playbook + Gemini + founder queue) toward operator quota.
        await ensureQuotaHydrated();
        tickRequest('operator');

        if (founderRoute.needsFounder && isPushConfigured?.()) {
            fanout(supabaseAdmin, {
                title: kind === 'bug' ? '🐛 Operator bug report' : '💡 Operator feature request',
                body: `${user.username}: ${text.slice(0, 80)}`,
                url: '/?operator=inbox',
                kind: 'operator',
            }).catch(() => {});
        }

        res.json({
            success: true,
            reply,
            inbox_id: saved.id,
            inbox_saved: !!saved.id,
            inbox_error: saved.error || null,
            kind,
            needs_founder: founderRoute.needsFounder,
            quotas: quotaStatusAll(),
            model: agentResult?.model || null,
            tools_called: (agentResult?.toolsCalled || []).map((t) => t.name),
            retryable: !!agentResult?.retryable
                || /tap retry|temporarily busy|high demand|could not reach|try again/i.test(reply || ''),
            sql_only: !!agentResult?.sql_only,
        });
    });

    app.patch('/api/operator/inbox/:id', async (req, res) => {
        if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
        const { edited_prompt, dev_status, status } = req.body || {};
        const patch = { updated_at: new Date().toISOString() };
        if (edited_prompt != null) patch.edited_prompt = String(edited_prompt);
        if (dev_status != null) patch.dev_status = String(dev_status);
        if (status != null) patch.status = String(status);
        const { data, error } = await supabaseAdmin
            .from('operator_inbox')
            .update(patch)
            .eq('id', id)
            .select()
            .maybeSingle();
        if (error) return res.status(500).json({ success: false, error: error.message });
        res.json({ success: true, item: data });
    });

    app.post('/api/operator/inbox/:id/approve-dev', async (req, res) => {
        if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
        const edited = String(req.body?.edited_prompt || '').trim();
        const { data: row, error: fetchErr } = await supabaseAdmin
            .from('operator_inbox')
            .select('id, message, transcript, kind, username')
            .eq('id', id)
            .maybeSingle();
        if (fetchErr) return res.status(500).json({ success: false, error: fetchErr.message });
        if (!row) return res.status(404).json({ success: false, error: 'not found' });
        const prompt = edited || row.transcript || row.message;
        const { data, error } = await supabaseAdmin
            .from('operator_inbox')
            .update({
                edited_prompt: prompt,
                status: 'approved',
                dev_status: 'queued',
                updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .select()
            .maybeSingle();
        if (error) return res.status(500).json({ success: false, error: error.message });
        res.json({
            success: true,
            item: data,
            message: 'Dev task queued. M4 worker or Cursor agent picks up when worker is online (phase 2).',
        });
    });

    app.post('/api/operator/inbox/:id/reject', async (req, res) => {
        if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
        const note = String(req.body?.note || '').trim();
        const { data, error } = await supabaseAdmin
            .from('operator_inbox')
            .update({
                status: 'rejected',
                dev_status: 'rejected',
                dev_result: note ? { note } : null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .select()
            .maybeSingle();
        if (error) return res.status(500).json({ success: false, error: error.message });
        res.json({ success: true, item: data });
    });

    app.get('/api/operator/status', async (req, res) => {
        if (!(await requireCrmKey(req, res))) return;
        await ensureQuotaHydrated();
        const inboxReady = await inboxTableOk(supabaseAdmin);
        res.json({
            success: true,
            enabled: true,
            inbox_ready: inboxReady,
            worker_online: process.env.OPERATOR_WORKER_ONLINE === '1',
            docs: 'docs/OPERATOR_DEV.md',
            migration: inboxReady ? null : 'server/migrations/alter_agent_quota_channels.sql',
            quota: quotaDashboard(),
            last_gemini_error: operatorLastGeminiError(),
        });
    });

    console.log('[OPERATOR] routes registered (/api/operator/*)');
    warnIfOperatorInboxMissing(supabaseAdmin).catch(() => {});
}
