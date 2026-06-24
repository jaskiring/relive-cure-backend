// CRM Operator API — staff chat, voice transcribe, founder inbox (separate Gemini quotas).

import { transcribeOperatorAudio, operatorGeminiStatus } from './operator-gemini.js';
import { runOperatorAgent, operatorLastGeminiError } from './operator-agent.js';
import { staticOperatorReply, checkFounderRoute, buildOperatorContext } from './operator-tools.js';
import { quotaStatusAll, quotaStatusForClient, quotaDashboard, ensureQuotaHydrated, tickRequest, flushQuota } from './agent-quota.js';
import { warnIfOperatorInboxMissing, checkOperatorInboxTable, OPERATOR_MIGRATION_SQL } from './operator-schema.js';
import { recordWorkerHeartbeat, isOperatorWorkerOnline, workerLastSeen, workerMeta, operatorDevUsername, workersOnlineStatus } from './operator-dev-state.js';
import { pickDevRoute, devRouteLabel } from './operator-dev-router.js';
import { runValidateGate } from './operator-validate-gate.js';
import { resolve } from 'path';

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
            quotas: quotaStatusForClient(),
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
        const devOnly = req.query.dev === '1';
        if (devOnly) {
            q = supabaseAdmin
                .from('operator_inbox')
                .select('id, username, kind, message, transcript, edited_prompt, status, dev_status, dev_route, dev_result, approved_by, created_at, updated_at')
                .eq('status', 'approved')
                .in('dev_status', ['queued', 'running', 'ready', 'failed'])
                .order('updated_at', { ascending: false })
                .limit(20);
        }
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
        await flushQuota();
        res.json({
            success: true,
            transcript: result.transcript,
            model: result.model,
            quotas: quotaStatusForClient(),
        });
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
        await flushQuota();

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
            quotas: quotaStatusForClient(),
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
        const approver = req.dashboardUser?.username || null;
        const rowWithPrompt = { ...row, edited_prompt: prompt };
        const override = req.body?.dev_route || req.body?.route || null;
        const dev_route = pickDevRoute(rowWithPrompt, override === 'auto' ? null : override);
        const { data, error } = await supabaseAdmin
            .from('operator_inbox')
            .update({
                edited_prompt: prompt,
                status: 'approved',
                dev_status: 'queued',
                dev_route,
                approved_by: approver,
                dev_result: { route: dev_route, queued_at: new Date().toISOString() },
                updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .select()
            .maybeSingle();
        if (error) return res.status(500).json({ success: false, error: error.message });

        const devUser = operatorDevUsername();
        const youAreDevUser = approver === devUser;
        const workers = workersOnlineStatus();
        let founderOnline = false;
        try {
            const since = new Date(Date.now() - 120_000).toISOString();
            const { data: pres } = await supabaseAdmin
                .from('operator_dev_presence')
                .select('last_seen')
                .eq('username', devUser)
                .eq('source', 'crm')
                .gte('last_seen', since)
                .maybeSingle();
            founderOnline = !!pres;
        } catch { /* table may not exist yet */ }

        const routeLabel = devRouteLabel(dev_route);
        const workerOn = dev_route === 'opencode' ? workers.opencode : workers.cursor;
        let message;
        if (dev_route === 'opencode') {
            if (workerOn) {
                message = `Approved (${routeLabel}) — OpenCode worker will implement on your Mac.`;
            } else {
                message = `Approved (${routeLabel}). Run: cd relive-cure-backend && npm run operator-opencode`;
            }
        } else if (youAreDevUser && founderOnline && workerOn) {
            message = `Approved (${routeLabel}) — Cursor bridge will open the task on your Mac shortly.`;
        } else if (youAreDevUser && founderOnline) {
            message = `Approved (${routeLabel}). Run: cd relive-cure-backend && npm run operator-cursor`;
        } else if (youAreDevUser) {
            message = `Approved (${routeLabel}). Log into CRM on your Mac, then run: npm run operator-cursor`;
        } else {
            message = `Approved for ${devUser} (${routeLabel}). They need CRM + npm run operator-cursor on their Mac.`;
        }

        res.json({
            success: true,
            item: data,
            dev_user: devUser,
            dev_route,
            dev_engine: dev_route,
            founder_online: founderOnline,
            worker_online: workerOn,
            workers,
            message,
        });
    });

    app.post('/api/operator/inbox/:id/dev-done', async (req, res) => {
        if (!(await requireCrmKey(req, res, { adminOnly: true }))) return;
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'invalid id' });
        const note = String(req.body?.note || '').trim();
        const skipValidate = req.body?.skip_validate === true;

        const { data: existing, error: fetchErr } = await supabaseAdmin
            .from('operator_inbox')
            .select('id, dev_status, dev_route, dev_result')
            .eq('id', id)
            .maybeSingle();
        if (fetchErr) return res.status(500).json({ success: false, error: fetchErr.message });
        if (!existing) return res.status(404).json({ success: false, error: 'not found' });
        if (!['ready', 'running', 'queued'].includes(existing.dev_status)) {
            return res.status(400).json({ success: false, error: `cannot mark done from dev_status=${existing.dev_status}` });
        }

        const workspace = process.env.OPERATOR_DEV_WORKSPACE
            || resolve(process.cwd(), '..');
        let validation = null;
        if (!skipValidate) {
            validation = await runValidateGate(workspace);
            if (!validation.ok) {
                return res.status(422).json({
                    success: false,
                    error: 'validate gate failed — fix errors before marking dev done',
                    validation,
                });
            }
        }

        const route = existing.dev_route || existing.dev_result?.route || 'cursor';
        const { data, error } = await supabaseAdmin
            .from('operator_inbox')
            .update({
                dev_status: 'done',
                dev_result: {
                    ...(existing.dev_result || {}),
                    engine: route,
                    completed_by: req.dashboardUser?.username || null,
                    completed_at: new Date().toISOString(),
                    note: note || null,
                    summary: note || 'Marked done in CRM after implementing in Cursor.',
                    validation: validation ? { ok: true, at: new Date().toISOString() } : null,
                },
                updated_at: new Date().toISOString(),
            })
            .eq('id', id)
            .in('dev_status', ['ready', 'running', 'queued'])
            .select()
            .maybeSingle();
        if (error) return res.status(500).json({ success: false, error: error.message });
        if (!data) return res.status(404).json({ success: false, error: 'not found or already done' });
        res.json({ success: true, item: data, validation });
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

    app.post('/api/operator/dev/presence', async (req, res) => {
        if (!(await requireCrmKey(req, res))) return;
        const user = req.dashboardUser;
        const devUser = operatorDevUsername();
        if (user.username !== devUser && user.role !== 'admin') {
            return res.json({ success: true, recorded: false, reason: 'not_dev_user' });
        }
        const at = new Date().toISOString();
        const meta = {
            role: user.role,
            page: req.body?.page || null,
        };
        const { error } = await supabaseAdmin
            .from('operator_dev_presence')
            .upsert({
                username: devUser,
                source: 'crm',
                last_seen: at,
                meta,
            }, { onConflict: 'username,source' });
        if (error) {
            const missing = /operator_dev_presence|does not exist/i.test(error.message || '');
            return res.status(missing ? 503 : 500).json({
                success: false,
                error: error.message,
                migration: missing ? 'server/migrations/alter_operator_dev_presence.sql' : null,
            });
        }
        res.json({
            success: true,
            recorded: true,
            dev_user: devUser,
            at,
            worker_online: isOperatorWorkerOnline(),
        });
    });

    app.post('/api/operator/worker/heartbeat', async (req, res) => {
        const secret = process.env.OPERATOR_WORKER_SECRET || '';
        if (!secret || req.headers['x-worker-secret'] !== secret) {
            return res.status(401).json({ success: false, error: 'unauthorized' });
        }
        recordWorkerHeartbeat(req.body || {});
        res.json({ success: true, online: true });
    });

    app.get('/api/operator/status', async (req, res) => {
        if (!(await requireCrmKey(req, res))) return;
        await ensureQuotaHydrated();
        const inboxReady = await inboxTableOk(supabaseAdmin);
        const devUser = operatorDevUsername();
        let founderOnline = false;
        let founderLastSeen = null;
        try {
            const since = new Date(Date.now() - 120_000).toISOString();
            const { data: pres } = await supabaseAdmin
                .from('operator_dev_presence')
                .select('last_seen, meta')
                .eq('username', devUser)
                .eq('source', 'crm')
                .gte('last_seen', since)
                .maybeSingle();
            founderOnline = !!pres;
            founderLastSeen = pres?.last_seen || null;
        } catch { /* ignore */ }
        res.json({
            success: true,
            enabled: true,
            inbox_ready: inboxReady,
            dev_engine: 'cursor+opencode',
            dev_user: devUser,
            founder_online: founderOnline,
            founder_last_seen: founderLastSeen,
            worker_online: isOperatorWorkerOnline(),
            workers: workersOnlineStatus(),
            worker_last_seen: workerLastSeen() ? new Date(workerLastSeen()).toISOString() : null,
            worker_meta: workerMeta(),
            docs: 'docs/OPERATOR_DEV.md',
            migration: inboxReady ? null : 'server/migrations/alter_agent_quota_channels.sql',
            quota: quotaDashboard(),
            last_gemini_error: operatorLastGeminiError(),
        });
    });

    console.log('[OPERATOR] routes registered (/api/operator/*)');
    warnIfOperatorInboxMissing(supabaseAdmin).catch(() => {});
}
