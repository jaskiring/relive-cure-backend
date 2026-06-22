// CRM Bot Lab — sandbox chats for testing bot scenarios without WhatsApp.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { agentStatus, getLastAgentModel } from './llm-agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB_FILE = path.join(__dirname, 'bot-lab-sessions.json');
export const LAB_PHONE_PREFIX = 'crm-lab-';

/** @type {Record<string, { phone: string, label: string, created_at: string, updated_at: string, messages: Array<{ role: 'user'|'assistant', text: string, ts: string }> }>} */
let labMeta = {};

export function isLabPhone(phone) {
    return typeof phone === 'string' && phone.startsWith(LAB_PHONE_PREFIX);
}

function loadLabMeta() {
    try {
        if (fs.existsSync(LAB_FILE)) {
            labMeta = JSON.parse(fs.readFileSync(LAB_FILE, 'utf8')) || {};
        }
    } catch (e) {
        console.warn('[BOT-LAB] load failed:', e.message);
        labMeta = {};
    }
}

function saveLabMeta() {
    try {
        fs.writeFileSync(LAB_FILE, JSON.stringify(labMeta, null, 2));
    } catch (e) {
        console.warn('[BOT-LAB] save failed:', e.message);
    }
}

loadLabMeta();

function snapshotLeadRow(row) {
    if (!row) return null;
    const eyeFromUq = row.user_questions
        ? (String(row.user_questions).match(/Eye power:\s*([^|]+)/i)?.[1]?.trim() || null)
        : null;
    return {
        id: row.id,
        contact_name: row.contact_name,
        city: row.city,
        eye_power: row.eye_power || eyeFromUq,
        eye_power_numeric: row.eye_power_numeric ?? null,
        parameters_completed: row.parameters_completed,
        intent_level: row.intent_level,
        intent_score: row.intent_score,
        request_call: row.request_call,
        timeline: row.timeline,
        insurance: row.insurance,
        source: row.source,
        last_user_message: row.last_user_message,
        message_count: row.message_count,
        current_flow_state: row.current_flow_state,
    };
}

/** Prefer live session data when DB row is stale or missing fields. */
function mergeLeadFromSession(dbLead, session) {
    if (!session?.data) return dbLead;
    const d = session.data;
    const ep = d.eyePower;
    const eye_power = typeof ep === 'string' ? ep : (ep?.parsed || ep?.raw || null);
    const eye_power_numeric = ep && typeof ep === 'object' ? (ep.numeric ?? null) : null;
    const merged = { ...(dbLead || {}) };
    if (d.contactName) merged.contact_name = d.contactName;
    if (d.city) merged.city = d.city;
    if (d.insurance) merged.insurance = d.insurance;
    if (d.timeline) merged.timeline = d.timeline;
    if (eye_power) merged.eye_power = eye_power;
    if (eye_power_numeric != null) merged.eye_power_numeric = eye_power_numeric;
    if (d.lastMessage) merged.last_user_message = d.lastMessage;
    merged.message_count = Math.max(merged.message_count || 0, d.message_count || 0);
    merged.request_call = merged.request_call || !!d.request_call;
    if (session.state) merged.current_flow_state = session.state;
    let pc = 0;
    if (merged.city) pc++;
    if (merged.eye_power) pc++;
    if (merged.insurance) pc++;
    if (merged.timeline) pc++;
    if (merged.request_call) pc = Math.min(5, pc + 1);
    merged.parameters_completed = Math.max(merged.parameters_completed || 0, pc);
    return merged;
}

function snapshotSession(session) {
    if (!session) return null;
    const d = session.data || {};
    return {
        state: session.state || null,
        lang: session.lang || 'EN',
        last_trigger: session._lastTrigger || null,
        agent_fail: session._lastAgentFail || null,
        data: {
            contactName: d.contactName || null,
            city: d.city || null,
            eyePower: d.eyePower ? (d.eyePower.parsed || d.eyePower.raw || d.eyePower) : null,
            request_call: !!d.request_call,
            callback_offered: !!d.callback_offered,
            interest_cost: !!d.interest_cost,
            opted_out: !!d.opted_out,
            is_cataract: !!d.is_cataract,
            insurance: d.insurance || null,
        },
    };
}

export function listLabSessions() {
    return Object.values(labMeta)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .map(s => ({
            phone: s.phone,
            label: s.label,
            created_at: s.created_at,
            updated_at: s.updated_at,
            message_count: s.messages?.length || 0,
            preview: s.messages?.length
                ? (s.messages[s.messages.length - 1].text || '').slice(0, 80)
                : '',
        }));
}

export function getLabSession(phone) {
    if (!isLabPhone(phone) || !labMeta[phone]) return null;
    return labMeta[phone];
}

export function createLabSession(label = 'New test chat') {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const phone = `${LAB_PHONE_PREFIX}${id}`;
    const now = new Date().toISOString();
    labMeta[phone] = {
        phone,
        label: String(label || 'New test chat').slice(0, 80),
        created_at: now,
        updated_at: now,
        messages: [],
    };
    saveLabMeta();
    return labMeta[phone];
}

export function appendLabMessage(phone, role, text) {
    const entry = labMeta[phone];
    if (!entry) return;
    entry.messages.push({
        role: role === 'user' ? 'user' : 'assistant',
        text: String(text || ''),
        ts: new Date().toISOString(),
    });
    entry.updated_at = new Date().toISOString();
    if (entry.messages.length === 1 && role === 'user' && entry.label === 'New test chat') {
        entry.label = String(text).slice(0, 48) + (String(text).length > 48 ? '…' : '');
    }
    saveLabMeta();
}

export async function deleteLabSession(phone, { botSessions, schedulePersist, supabaseAdmin }) {
    if (!isLabPhone(phone)) throw new Error('Not a lab session');
    if (botSessions?.[phone]) {
        delete botSessions[phone];
        schedulePersist?.();
    }
    delete labMeta[phone];
    saveLabMeta();
    if (supabaseAdmin) {
        const tables = [
            ['lead_events', 'phone'],
            ['whatsapp_messages', 'phone'],
            ['whatsapp_conversations', 'phone'],
            ['leads_surgery', 'phone_number'],
        ];
        for (const [table, col] of tables) {
            const { error } = await supabaseAdmin.from(table).delete().eq(col, phone);
            if (error) console.warn(`[BOT-LAB] delete ${table}:`, error.message);
        }
    }
}

export function registerBotLabRoutes(app, deps) {
    const { CRM_API_KEY, handleIncomingMessage, getBotSessions, schedulePersist, supabaseAdmin, sendToAPI } = deps;

    const auth = (req, res, next) => {
        if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
        next();
    };

    app.get('/api/bot-lab/sessions', auth, (_req, res) => {
        res.json({ success: true, sessions: listLabSessions(), agent: agentStatus() });
    });

    app.post('/api/bot-lab/sessions', auth, (req, res) => {
        const session = createLabSession(req.body?.label);
        res.json({ success: true, session });
    });

    app.get('/api/bot-lab/sessions/:phone', auth, async (req, res) => {
        const phone = req.params.phone;
        if (!isLabPhone(phone)) return res.status(400).json({ error: 'Invalid lab session id' });
        const session = getLabSession(phone);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        const botSessions = getBotSessions();
        const sess = botSessions[phone];
        let lead = null;
        if (supabaseAdmin) {
            const { data } = await supabaseAdmin
                .from('leads_surgery')
                .select('id, contact_name, city, user_questions, parameters_completed, intent_level, intent_score, request_call, timeline, insurance, source, last_user_message, message_count, current_flow_state')
                .eq('phone_number', phone)
                .maybeSingle();
            lead = snapshotLeadRow(mergeLeadFromSession(data, sess));
        } else if (sess) {
            lead = snapshotLeadRow(mergeLeadFromSession(null, sess));
        }
        res.json({
            success: true,
            session,
            bot: snapshotSession(sess),
            lead,
            agent: agentStatus(),
        });
    });

    app.post('/api/bot-lab/sessions/:phone/chat', auth, async (req, res) => {
        const phone = req.params.phone;
        if (!isLabPhone(phone)) return res.status(400).json({ error: 'Invalid lab session id' });
        const message = String(req.body?.message || '').trim();
        if (!message) return res.status(400).json({ error: 'message is required' });
        if (!labMeta[phone]) return res.status(404).json({ error: 'Session not found' });

        try {
            appendLabMessage(phone, 'user', message);
            const reply = await handleIncomingMessage({ phone, message }, true);
            appendLabMessage(phone, 'assistant', reply || '');
            const botSessions = getBotSessions();
            const sess = botSessions[phone];
            let lead = null;
            let ingestError = sess?._lastIngestError || null;
            if (supabaseAdmin && sendToAPI && sess) {
                try {
                    await sendToAPI(phone, sess, 'lab_sync');
                } catch (e) {
                    ingestError = e.message;
                    console.warn('[BOT-LAB] lead sync failed:', e.message);
                }
            }
            if (supabaseAdmin) {
                const { data } = await supabaseAdmin
                    .from('leads_surgery')
                    .select('id, contact_name, city, user_questions, parameters_completed, intent_level, intent_score, request_call, timeline, insurance, source, last_user_message, message_count, current_flow_state')
                    .eq('phone_number', phone)
                    .maybeSingle();
                lead = snapshotLeadRow(mergeLeadFromSession(data, sess));
            } else if (sess) {
                lead = snapshotLeadRow(mergeLeadFromSession(null, sess));
            }
            const trigger = sess?._lastTrigger || null;
            const agentFail = sess?._lastAgentFail || null;
            const usedModel = getLastAgentModel();
            const provider = usedModel?.includes('gemma') ? 'gemma' : (usedModel ? 'gemini' : (agentStatus().provider || 'gemini'));
            let replySource = trigger === 'agent' ? provider : (trigger ? 'rule-based' : 'unknown');
            if (agentFail && trigger !== 'agent') {
                replySource = `rule-based (${agentFail})`;
            }
            res.json({
                success: true,
                reply: reply || '',
                reply_source: replySource,
                agent_fail: agentFail,
                trigger,
                session: labMeta[phone],
                bot: snapshotSession(sess),
                lead,
                ingest_error: ingestError,
                agent: agentStatus(),
            });
        } catch (e) {
            console.error('[BOT-LAB] chat error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/bot-lab/sessions/:phone', auth, async (req, res) => {
        const phone = req.params.phone;
        if (!isLabPhone(phone)) return res.status(400).json({ error: 'Invalid lab session id' });
        try {
            await deleteLabSession(phone, { botSessions: getBotSessions(), schedulePersist, supabaseAdmin });
            res.json({ success: true, deleted: phone });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}
