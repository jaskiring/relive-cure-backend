// ─── STEP 1: Polyfill fetch BEFORE any other import that uses it ─────────────
import fetch from 'node-fetch';
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
    console.log('[BOOT] node-fetch polyfill applied');
} else {
    globalThis.fetch = fetch;
    console.log('[BOOT] node-fetch override applied (replacing native fetch)');
}

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ingestLead } from '../src/lib/ingestion.js';
import { processQueue } from './crm-automation.js';
import { supabaseAdmin } from './supabase-admin.js';
import { syncRefrensLeads } from './refrens-sync.js';
import { saveWhatsAppMessage } from './whatsapp-store.js';
import multer from 'multer';

// In-memory upload (we re-stream to Meta immediately; files are bounded to ~25MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26 * 1024 * 1024 } });
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Startup env diagnostics ──────────────────────────────────────────────────
const REQUIRED_ENV = ["BOT_SECRET", "CRM_API_KEY", "WEBHOOK_VERIFY_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WHATSAPP_ACCESS_TOKEN", "PHONE_NUMBER_ID"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) { console.error(`[FATAL] Missing env vars: ${missing.join(", ")}`); process.exit(1); }

console.log('═══════════════════════════════════════');
console.log('[BOOT] ✅ Server starting...');
console.log('[BOOT] BOT_SECRET SET:', !!process.env.BOT_SECRET);
console.log('[BOOT] PHONE_NUMBER_ID SET:', !!process.env.PHONE_NUMBER_ID);
console.log('[BOOT] NODE_VERSION:', process.version);
console.log('═══════════════════════════════════════');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_SECRET = process.env.BOT_SECRET;
const CRM_API_KEY = process.env.CRM_API_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

app.use(cors());
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', node: process.version, ts: new Date().toISOString(), uptime: process.uptime(), bot: 'v6.2-stable' });
});

// ─── DB test ──────────────────────────────────────────────────────────────────
app.get('/test-db', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin.from('leads_surgery').select('id, phone_number, contact_name, created_at').limit(1);
        if (error) return res.status(500).json({ success: false, error: error.message });
        return res.json({ success: true, message: 'Supabase connected', sample: data });
    } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getSessionToken() {
    const u = process.env.VITE_ADMIN_USERNAME || '';
    const p = process.env.VITE_ADMIN_PASSWORD || '';
    return crypto.createHmac('sha256', CRM_API_KEY || 'fallback').update(`${u}:${p}`).digest('hex');
}

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const validUsername = process.env.VITE_ADMIN_USERNAME || 'admin';
    const validPassword = process.env.VITE_ADMIN_PASSWORD;
    if (!validPassword) return res.status(503).json({ success: false, message: 'Auth not configured' });
    if (username === validUsername && password === validPassword) {
        res.json({ success: true, token: CRM_API_KEY, sessionToken: getSessionToken() });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.get('/api/auth/verify', (req, res) => {
    const sessionToken = req.headers['x-session-token'];
    if (!sessionToken) return res.json({ valid: false });
    const validUsername = process.env.VITE_ADMIN_USERNAME;
    const validPassword = process.env.VITE_ADMIN_PASSWORD;
    if (!validUsername || !validPassword) return res.json({ valid: false });
    res.json({ valid: sessionToken === getSessionToken() });
});

// ─── Refrens cookies ──────────────────────────────────────────────────────────
app.get('/api/export-refrens-cookies', async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try { const { getBrowserCookies } = await import('./crm-automation.js'); const cookies = await getBrowserCookies(); res.json({ cookies }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CRM Push ─────────────────────────────────────────────────────────────────
app.post('/api/push-to-crm-form', async (req, res) => {
    const crmKey = req.headers['x-crm-key'];
    if (crmKey !== CRM_API_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) return res.status(400).json({ status: 'error', message: 'No leads provided' });
    const pendingLeads = leads.filter(l => !l.pushed_to_crm);
    if (pendingLeads.length === 0) return res.json({ status: 'success', message: 'All already pushed.', processed: 0 });
    if (pendingLeads.length > 20) return res.status(400).json({ status: 'error', message: 'Max 20 leads per batch.' });
    try {
        const results = await processQueue(pendingLeads);
        const successfulLeads = results.filter(r => r.success).map(r => r.id);
        const failedLeads = results.filter(r => !r.success);
        if (successfulLeads.length > 0) {
            await supabaseAdmin.from('leads_surgery').update({ pushed_to_crm: true, status: 'PUSHED_TO_CRM' }).in('id', successfulLeads);
        }
        res.json({ status: 'success', processed: results.length, success_count: successfulLeads.length, failed_count: failedLeads.length, failed_leads: failedLeads });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ─── Ingest Lead ──────────────────────────────────────────────────────────────
app.post('/api/ingest-lead', async (req, res) => {
    const botKey = req.headers['x-bot-key'];
    if (botKey !== BOT_SECRET) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    try {
        const payload = req.body;
        if (!payload.phone_number) return res.status(400).json({ status: 'error', message: 'Missing phone_number' });
        const { data, action } = await ingestLead(supabaseAdmin, payload);
        res.json({ status: 'success', action, lead_id: data.id });
    } catch (error) { res.status(500).json({ status: 'error', message: 'Internal server error' }); }
});

// ─── Check Lead ───────────────────────────────────────────────────────────────
app.get('/api/check-lead/:phone', async (req, res) => {
    const botKey = req.headers['x-bot-key'];
    if (botKey !== BOT_SECRET) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    const { phone } = req.params;
    try {
        const { data, error } = await supabaseAdmin.from('leads_surgery').select('id, contact_name, status, lead_stage, interest_cost, interest_recovery, concern_pain, concern_safety, urgency_level, pushed_to_crm').eq('phone_number', phone).maybeSingle();
        if (error) throw error;
        res.json({ status: 'success', exists: !!data, lead: data });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ─── Delete Lead ──────────────────────────────────────────────────────────────
app.delete('/api/leads/:id', async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { error } = await supabaseAdmin.from('leads_surgery').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, deleted: req.params.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// BOT ENGINE — v6.2-stable (embedded, no HTTP calls, direct Supabase)
// ═════════════════════════════════════════════════════════════════════════════

const INACTIVITY_MS = 10 * 60 * 1000;
const SESSION_FILE = path.join(__dirname, 'sessions.json');

function detectLanguageWithConfidence(message) {
    if (!message) return { lang: 'EN', confidence: 'low' };
    if (/[\u0900-\u097F]/.test(message)) return { lang: 'HI', confidence: 'high' };
    const hinglishWords = ['kya', 'hai', 'haan', 'nahi', 'mujhe', 'mera', 'meri', 'aap', 'karo', 'chahiye', 'bata', 'batao', 'theek', 'achha', 'bolna', 'kuch', 'kaisa', 'kaise', 'kitna', 'kitne', 'kab', 'kahan', 'kyun', 'kaun', 'lagta', 'lagti', 'hoga', 'hogi', 'karwana', 'karwani', 'hun', 'hoon', 'matlab', 'acha', 'sahi'];
    const m = message.toLowerCase();
    const count = hinglishWords.filter(w => m.includes(w)).length;
    if (count >= 2) return { lang: 'HI', confidence: 'high' };
    if (count === 1) return { lang: 'HI', confidence: 'medium' };
    if (/\b(the|is|are|was|what|how|can|will|my|i am|you are|your|when|where|does|did)\b/i.test(m)) return { lang: 'EN', confidence: 'high' };
    return { lang: 'EN', confidence: 'low' };
}

function t(key, lang) { const e = BOT_MSG[key]; if (!e) return ''; return e[lang] || e['EN']; }

const BOT_MSG = {
    GREETING: { EN: 'Hi! 😊 I\'m your Relive Cure vision assistant.\n\nWhat should I call you?', HI: 'नमस्ते! 😊 मैं आपका Relive Cure vision assistant हूँ।\n\nआपको क्या बुलाऊँ?' },
    GREETING_HIGH_INTENT: { EN: 'Great! I can definitely help with that 😊\n\nWhat should I call you?', HI: 'बिल्कुल! मैं इसमें आपकी मदद कर सकता हूँ 😊\n\nआपको क्या बुलाऊँ?' },
    ASK_NAME: { EN: 'What should I call you? 😊', HI: 'आपको क्या बुलाऊँ? 😊' },
    ASK_CITY: { EN: 'Which city are you based in? 📍', HI: 'आप किस शहर में रहते हैं? 📍' },
    ASK_EYE_POWER: { EN: 'Do you wear glasses or lenses? If yes, what\'s your approximate power? 😊', HI: 'क्या आप glasses या lenses पहनते हैं? अगर हाँ, तो approximate power क्या है? 😊' },
    ASK_POWER_STABILITY: { EN: 'How long has your power been stable?', HI: 'आपकी power कितने समय से stable है?' },
    INVALID_NAME: { EN: 'Sorry 😊 What should I call you?', HI: 'माफ़ करें 😊 आपको क्या बुलाऊँ?' },
    WELCOME_BACK: { EN: 'Welcome back! 👋 Would you like to continue where we left off? (Yes/No)', HI: 'वापस आए! 👋 क्या आप वहीं से जारी रखना चाहते हैं? (हाँ/नहीं)' },
    NOT_INTERESTED: { EN: 'No worries at all 😊 If you ever want guidance on eye care, we\'re always here. Take care!', HI: 'कोई बात नहीं 😊 अगर कभी guidance चाहिए, हम यहाँ हैं। ख्याल रखें!' },
    FALLBACK: { EN: 'I may not have the right information for that 😊 But our specialist will call you shortly and answer everything!', HI: 'इसके बारे में सही जानकारी मेरे पास नहीं है 😊 लेकिन specialist जल्द call करेंगे!' }
};

const COMPLETE_VARIANTS = {
    EN: [
        'You\'re all set 😊 Our specialist will reach out shortly.\n\nFeel free to ask me anything about:\n• Cost 💰\n• Recovery ⚡\n• LASIK vs ICL 👁',
        'Our team has your request 👍 A specialist will contact you shortly.\n\nMeanwhile, you can ask me about recovery or eligibility 😊',
        'Perfect 😊 Your consultation request is submitted.\n\nIf you\'d like, I can also help with:\n• Cost\n• Safety\n• Recovery'
    ],
    HI: [
        'आप सब set हैं 😊 Specialist जल्द संपर्क करेंगे।\n\nइस बीच पूछ सकते हैं:\n• Cost 💰\n• Recovery ⚡\n• LASIK vs ICL 👁',
        'आपकी request हमारी team को मिल गई 👍 Specialist जल्द contact करेंगे।\n\nतब तक recovery या eligibility पूछ सकते हैं 😊',
        'बढ़िया 😊 Consultation request submit हो गई।\n\nCost, safety या recovery के बारे में पूछ सकते हैं।'
    ]
};

function getRandomCompleteReply(lang) { const v = COMPLETE_VARIANTS[lang] || COMPLETE_VARIANTS.EN; return v[Math.floor(Math.random() * v.length)]; }

function parseEyePower(message) {
    const match = message.match(/[-+]?\d+(\.\d+)?/);
    if (!match) return { raw: message, parsed: null, numeric: null, confidence: 'low' };
    const numeric = parseFloat(match[0]);
    return { raw: message, parsed: match[0], numeric, confidence: (Math.abs(numeric) >= 0.25 && Math.abs(numeric) <= 22) ? 'high' : 'medium' };
}
function getEyePowerNumeric(ep) { if (!ep) return null; if (typeof ep === 'string') return parseFloat(ep) || null; return ep.numeric || null; }
function getEyePowerString(ep) { if (!ep) return null; if (typeof ep === 'string') return ep; return ep.parsed || ep.raw || null; }

function getAcknowledgement(message, lang) {
    const m = message.toLowerCase();
    const acks = [
        { test: () => /issue|problem|trouble|difficulty|blurr?y?|blurred|can'?t see|cannot see|cant see|weak eye|weak eyesight|poor vision|bad vision|low vision|dikhai nahi|dikhta nahi|saaf nahi|kamzor|nazar|धुंधला|दिखाई नहीं|नज़र|कमज़ोर/i.test(m), EN: 'I understand — that must be frustrating 😊', HI: 'मैं समझता हूँ — यह परेशान करने वाला होता है 😊' },
        { test: () => /[-+]?\d+(\.\d+)?/.test(m) && (m.includes('power') || m.includes('minus') || m.includes('-') || m.includes('+')), EN: 'That power range is more common than people think 👍', HI: 'यह power range सोच से ज़्यादा common है 👍' },
        { test: () => /scared|fear|nervous|afraid|darta|daro/i.test(m), EN: 'That\'s completely understandable 😊', HI: 'यह बिल्कुल समझ में आता है 😊' },
        { test: () => /this month|next month|jaldi|soon|abhi|asap/i.test(m), EN: 'That sounds like a good timeline 👍', HI: 'यह एक अच्छा timeline है 👍' },
        { test: () => /pain|dard|hurt|takleef/i.test(m), EN: 'Many people are pleasantly surprised by this 😊', HI: 'बहुत लोग इससे अच्छे से हैरान होते हैं 😊' },
        { test: () => /expensive|costly|afford|budget|cost|price|fees|kharcha|paisa/i.test(m), EN: 'That\'s a fair question 😊', HI: 'यह एक सही सवाल है 😊' },
        { test: () => /ok|okay|sure|haan|theek|accha|bilkul|got it/i.test(m) && m.length < 15, EN: 'Great! 😊', HI: 'बढ़िया! 😊' }
    ];
    for (const ack of acks) { if (ack.test()) return ack[lang] || ack.EN; }
    return null;
}

function getEscalationMessage(type, lang, firstName) {
    const n = firstName ? `, ${firstName}` : '';
    const msgs = {
        educational: { EN: `A specialist can guide you much better regarding this${n} 😊 Our team will call you shortly.`, HI: `इसके बारे में specialist बेहतर guide कर सकते हैं${n} 😊 हमारी team जल्द call करेगी।` },
        candidate: { EN: `Based on what you've shared${n}, you sound like a strong candidate! 😊 Our specialist will call you shortly.`, HI: `आपने जो share किया है${n}, आप एक अच्छे candidate लगते हैं! 😊 Specialist जल्द call करेंगे।` },
        medical: { EN: `That depends on a proper evaluation${n} 😊 Our specialist can assess this during your free consultation.`, HI: `यह evaluation पर depend करता है${n} 😊 Specialist free consultation में assess करेंगे।` },
        callback: { EN: `Perfect${n}! Our team will reach out to you shortly 😊`, HI: `बढ़िया${n}! हमारी team जल्द संपर्क करेगी 😊` }
    };
    const entry = msgs[type] || msgs.educational;
    return entry[lang] || entry.EN;
}

function shouldOfferCallback(session) {
    if (session.data.callback_offered) return false;
    const d = session.data; let score = 0;
    if (d.city) score++;
    if (d.eyePower) score++;
    else if (d.concern_power) score++;
    if (d.interest_cost) score++;
    if (d.interest_recovery) score++;
    if (d.request_call) score += 2;
    return score >= 2;
}

let botSessions = {};
const botProcessedMessages = new Map();
setInterval(() => { const now = Date.now(); for (const [id, ts] of botProcessedMessages.entries()) { if (now - ts > 60000) botProcessedMessages.delete(id); } }, 30000);

try {
    if (fs.existsSync(SESSION_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        for (const [phone, s] of Object.entries(raw)) botSessions[phone] = { ...s, inactivityTimer: null };
        console.log(`[SESSION] Hydrated ${Object.keys(botSessions).length} sessions`);
    }
} catch (e) { console.error('[SESSION] Hydration error:', e.message); }

let _saveTimeout = null;
function schedulePersist() {
    clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
        try {
            const toWrite = {};
            for (const [p, s] of Object.entries(botSessions)) {
                toWrite[p] = { state: s.state, data: s.data, ingested: s.ingested, first_ingest_done: s.first_ingest_done || false, last_activity_at: s.last_activity_at, lang: s.lang || 'EN', repeat_count: s.repeat_count || {}, resume_offered: s.resume_offered || false, last_intent_handled: s.last_intent_handled || null };
            }
            fs.writeFileSync(SESSION_FILE, JSON.stringify(toWrite, null, 2));
        } catch (e) { console.error('[SESSION] Persist error:', e.message); }
    }, 200);
}

const NAME_BLACKLIST = new Set(['yes', 'ok', 'okay', 'haan', 'ha', 'no', 'nah', 'start', 'nahi', 'nope', 'sure', 'chalo', 'bilkul', 'haan ji', 'skip', 'next', 'continue', 'hello', 'hi', 'hey', 'theek', 'accha', 'achha', 'thik', 'lasik', 'surgery', 'good', 'fine']);
function isValidName(str) {
    if (!str || str.trim().length < 2) return false;
    if (NAME_BLACKLIST.has(str.toLowerCase().trim())) return false;
    if (/[\u0900-\u097F]/.test(str)) return str.trim().length >= 2;
    if (!/^[a-zA-Z\s]+$/.test(str.trim())) return false;
    return str.trim().split(/\s+/).some(w => w.length >= 2);
}

const NOT_INTERESTED_TRIGGERS = ['not interested', 'no thanks', 'don\'t want', 'dont want', 'wrong number', 'galat number', 'nahi chahiye', 'band karo', 'mat bhejo', 'unsubscribe', 'stop messaging', 'please stop', 'remove me'];
const ESCALATION_TRIGGERS = ['icl', 'implantable', 'implant lens', 'cataract', 'motiyabind', 'मोतियाबिंद', 'आईसीएल', 'talk to doctor', 'doctor se baat', 'doctor chahiye', 'doctor se milna'];
const SALES_INTENT = ['call me', 'call back', 'callback', 'call chahiye', 'mujhe call', 'contact me', 'book appointment', 'appointment chahiye', 'baat karni hai', 'agent se baat', 'talk to specialist', 'specialist se baat', 'human se baat', 'real person', 'connect me', 'phone karo', 'call karo'];
const HIGH_INTENT_FIRST = ['lasik', 'surgery', 'operation', 'laser eye', 'laser treatment', 'chashma hatana', 'glasses hatana', 'aankhon ka operation', 'karwana', 'karwani', 'vision correction', 'eye surgery'];

function isNotInterested(msg) { return NOT_INTERESTED_TRIGGERS.some(w => msg.toLowerCase().includes(w)); }
function isEscalationTrigger(msg) { return ESCALATION_TRIGGERS.some(w => msg.toLowerCase().includes(w)); }
function isSalesIntent(msg) { return SALES_INTENT.some(w => msg.toLowerCase().includes(w)); }
function isHighIntentFirst(msg) { return HIGH_INTENT_FIRST.some(w => msg.toLowerCase().includes(w)); }

const INDIAN_CITIES = ['delhi', 'mumbai', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'gurgaon', 'gurugram', 'noida', 'chennai', 'kolkata', 'jaipur', 'ahmedabad', 'chandigarh', 'lucknow', 'surat', 'bhopal', 'indore', 'nagpur', 'faridabad', 'meerut', 'rajkot', 'varanasi', 'amritsar', 'allahabad', 'prayagraj', 'coimbatore', 'jodhpur', 'madurai', 'raipur', 'kota', 'mohali', 'panchkula', 'dehradun', 'ghaziabad'];

function passiveExtract(message, session) {
    const m = message.toLowerCase(); const d = session.data;
    if (!d.city) {
        for (const city of INDIAN_CITIES) { if (m.includes(city)) { d.city = city.charAt(0).toUpperCase() + city.slice(1); break; } }
        const fromMatch = m.match(/(?:from|i'm from|i am from|main.*se hoon|main.*se hun)\s+([a-z]+)/i);
        if (fromMatch && !d.city && fromMatch[1].length > 2) d.city = fromMatch[1].charAt(0).toUpperCase() + fromMatch[1].slice(1);
        if (d.city && d.lastAskedField === 'CITY') d.lastAskedField = null;
    }
    if (!d.eyePower) {
        const powerContext = ['power', 'number', 'minus', 'plus', 'diopter', 'aankhein', 'eye', 'vision'];
        const hasContext = powerContext.some(w => m.includes(w)) || /[-+]\d/.test(message);
        const powerMatch = message.match(/[-+]?\d+(\.\d+)?/);
        const justAskedPower = d.lastAskedField === 'EYE_POWER';
        if (powerMatch && (hasContext || session.state === 'EYE_POWER' || justAskedPower)) {
            d.eyePower = parseEyePower(message);
            d.concern_power = true;
            d.lastAskedField = null; // clear so it doesn't keep matching
        }
    } else if (d.lastAskedField === 'EYE_POWER') {
        d.lastAskedField = null; // already answered, clear the flag
    }
    if (!d.timeline) {
        if (/this month|is mahine|abhi|immediately|jaldi|urgent/i.test(m)) { d.timeline = message; d.urgency = 'high'; }
        else if (/2.?3 month|next month|agle mahine|soon/i.test(m)) { d.timeline = message; d.urgency = 'medium'; }
        else if (/exploring|soch raha|dekh raha|just looking/i.test(m)) { d.timeline = message; d.urgency = 'low'; }
    }
    if (!d.insurance) {
        if (/insurance hai|insured hoon|health insurance|bima hai|covered hai/i.test(m)) d.insurance = 'Yes';
        else if (/no insurance|insurance nahi|bima nahi|not insured/i.test(m)) d.insurance = 'No';
    }
}

function scoreSession(session) {
    const d = session.data;
    const params = ['city', 'insurance', 'eyePower', 'timeline'].filter(f => d[f] && String(d[f]).trim()).length;
    const urgency = d.urgency || '';
    const band = (params >= 3 && urgency === 'high') ? 'HOT' : (params >= 2) ? 'WARM' : 'COLD';
    return { intent_score: params, intent_band: band, interest_cost: !!d.interest_cost, interest_recovery: !!d.interest_recovery, concern_pain: !!d.concern_pain, concern_safety: !!d.concern_safety, urgency_level: urgency || (params >= 3 ? 'medium' : 'low'), is_returning: !!d.is_returning };
}

// ─── DIRECT DB INGEST — no HTTP ───────────────────────────────────────────────
async function sendToAPI(phone, session, trigger = 'update') {
    const d = session.data; const scored = scoreSession(session);
    const eyePowerStr = getEyePowerString(d.eyePower);
    const eyePowerNum = getEyePowerNumeric(d.eyePower);
    const userQuestions = [
        d.escalation_note ? `Escalation: ${d.escalation_note}` : null,
        eyePowerStr ? `Eye power: ${eyePowerStr}` : null,
        d.powerStability ? `Power stable: ${d.powerStability}` : null,
        eyePowerNum !== null ? `Eye power numeric: ${eyePowerNum}` : null,
        d.opted_out ? 'User opted out' : null
    ].filter(Boolean).join(' | ');

    const payload = {
        phone_number: phone, contact_name: d.contactName || 'WhatsApp Lead',
        channel: 'whatsapp',
        city: d.city || '', preferred_surgery_city: d.city || '',
        timeline: d.timeline || '', insurance: d.insurance || '',
        interest_cost: scored.interest_cost, interest_recovery: scored.interest_recovery,
        concern_pain: scored.concern_pain, concern_safety: scored.concern_safety,
        concern_power: !!d.concern_power, intent_level: scored.intent_band || 'COLD',
        intent_score: scored.intent_score || 0, urgency_level: scored.urgency_level || 'low',
        request_call: d.request_call || false, last_user_message: d.lastMessage || '',
        user_questions: userQuestions || '', callback_source: d.callback_source || '',
        ingestion_trigger: trigger, language: session.lang || 'EN',
        source: 'whatsapp', bot_version: 'v6.2-stable',
        first_message_at: d.first_message_at || session.last_activity_at || new Date().toISOString(),
        last_message_at: session.last_activity_at || new Date().toISOString(),
        message_count: d.message_count || 1, current_flow_state: session.state || 'UNKNOWN'
    };

    try {
        const { data, action } = await ingestLead(supabaseAdmin, payload);
        console.log(`[BOT→DB] ✅ ${action.toUpperCase()} | id=${data.id} | phone=${phone}`);
        session.ingested = true; session.first_ingest_done = true; schedulePersist();
    } catch (err) { console.error('[BOT→DB] ❌ Direct ingest failed:', err.message); }
}

// ─── DIRECT DB CHECK — no HTTP ────────────────────────────────────────────────
async function checkExistingLead(phone) {
    try {
        const { data, error } = await supabaseAdmin.from('leads_surgery').select('id, contact_name, status, lead_stage, interest_cost, interest_recovery, concern_pain, concern_safety, urgency_level, pushed_to_crm').eq('phone_number', phone).maybeSingle();
        if (error) throw error;
        return data || null;
    } catch (e) { console.error('[BOT] checkExistingLead error:', e.message); return null; }
}

// ─── INACTIVITY TIMER ────────────────────────────────────────────────────────
function getPersonalizedFollowup(session) {
    const d = session.data; const lang = session.lang || 'EN';
    const name = d.contactName && d.contactName !== 'WhatsApp Lead' ? `, ${d.contactName.split(' ')[0]}` : '';
    const powerNum = getEyePowerNumeric(d.eyePower);
    if (powerNum !== null && powerNum <= -5) return { EN: `Hey${name} 😊 Many people with higher powers explore ICL too — our specialist can guide you on the best option!`, HI: `नमस्ते${name} 😊 High power वाले लोग ICL भी explore करते हैं — specialist best option बता सकते हैं!` }[lang];
    if (d.interest_cost) return { EN: `Hey${name} 😊 LASIK costs vary by technology — our specialist can give you an exact quote!`, HI: `नमस्ते${name} 😊 LASIK की cost technology पर depend करती है — specialist exact quote दे सकते हैं!` }[lang];
    if (d.interest_recovery) return { EN: `Hey${name} 😊 Most LASIK patients are back to normal the very next day. Quick and easy 😊`, HI: `नमस्ते${name} 😊 ज़्यादातर LASIK patients अगले दिन से normal हो जाते हैं। जल्दी और आसान 😊` }[lang];
    return { EN: `Hey${name} 😊 Still thinking about LASIK? Feel free to ask me anything!`, HI: `नमस्ते${name} 😊 अभी भी LASIK के बारे में सोच रहे हैं? कुछ भी पूछें!` }[lang];
}

function resetInactivityTimer(phone) {
    const session = botSessions[phone];
    if (!session) return;
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    session.inactivityTimer = setTimeout(async () => {
        const s = botSessions[phone];
        if (!s || s.data.opted_out) return;
        if (s.data.followup_sent_count >= 1) return;
        s.inactivityTimer = null;
        const today = new Date().toISOString().slice(0, 10);
        if (s.data.last_followup_date === today) { await sendToAPI(phone, s, 'timeout'); return; }
        await sendWhatsAppReply(phone, getPersonalizedFollowup(s));
        s.data.last_followup_date = today;
        s.data.followup_sent_count = (s.data.followup_sent_count || 0) + 1;
        await sendToAPI(phone, s, 'timeout'); schedulePersist();
    }, INACTIVITY_MS);
}

// ─── KNOWLEDGE BASE ───────────────────────────────────────────────────────────
const KB = {
    COST: { EN: '💰 *LASIK Cost at Relive Cure:*\n\nTreatment starts from ₹15,000 and can go up to ₹90,000 depending on your eye condition and recommended technology.\n\nThe best way to know your exact cost is a *free consultation* where our specialist evaluates your eyes.', HI: '💰 *Relive Cure में LASIK की Cost:*\n\nTreatment ₹15,000 से शुरू होती है और ₹90,000 तक हो सकती है।\n\nExact cost के लिए *free consultation* सबसे अच्छा तरीका है।' },
    RECOVERY: { EN: '⚡ *LASIK Recovery is Super Fast:*\n\n• Vision clears in 3–12 hours\n• Normal routine next day\n• Full recovery in 1–2 weeks\n• No patches, no bed rest needed', HI: '⚡ *LASIK Recovery बहुत तेज़ है:*\n\n• 3–12 घंटे में vision clear\n• अगले दिन से normal routine\n• 1–2 हफ्ते में पूरी recovery\n• कोई patch या bed rest नहीं' },
    PAIN: { EN: '✅ *LASIK is Almost Painless:*\n\n• Mild pressure for a few seconds only\n• No real pain during surgery\n• Numbing eye drops used beforehand\n• Mild irritation for a few hours after', HI: '✅ *LASIK लगभग दर्द-रहित है:*\n\n• सिर्फ कुछ सेकंड के लिए हल्का pressure\n• Surgery के दौरान कोई दर्द नहीं\n• Numbing eye drops पहले दी जाती हैं\n• बाद में कुछ घंटे हल्की जलन' },
    ELIGIBILITY: { EN: '🔍 *LASIK Eligibility Depends On:*\n\n• Stable eye power for 1+ year\n• Age 18+ years\n• Healthy eyes & sufficient corneal thickness\n• No major eye diseases', HI: '🔍 *LASIK Eligibility किन बातों पर निर्भर करती है:*\n\n• 1+ साल से stable eye power\n• उम्र 18+ साल\n• Healthy eyes\n• कोई बड़ी eye disease नहीं' },
    SAFETY: { EN: '😊 LASIK is one of the *safest* eye procedures worldwide:\n\n• 98%+ success rate\n• No general anesthesia\n• Takes only 10–15 minutes\n• Full evaluation done before surgery', HI: '😊 LASIK दुनिया के *सबसे safe* procedures में से एक है:\n\n• 98%+ success rate\n• General anesthesia नहीं\n• सिर्फ 10–15 मिनट\n• Surgery से पहले पूरी evaluation' },
    TIMELINE: { EN: '📅 *LASIK at Relive Cure:*\n\n• Surgery: 10–15 mins (both eyes)\n• Same day discharge\n• Back to work next day\n• Driving: after 1–2 days', HI: '📅 *Relive Cure में LASIK:*\n\n• Surgery: 10–15 मिनट\n• Same day discharge\n• अगले दिन काम पर वापस\n• Driving: 1–2 दिन बाद' },
    REFERRAL: { EN: '🎁 Refer a friend → Earn *₹1,000* per surgery. No limit!\n\nOur team will share details when you book 😊', HI: '🎁 एक दोस्त refer करें → *₹1,000* कमाएँ। कोई limit नहीं!\n\nBooking पर team details देगी 😊' },
    LOCATION: { EN: '📍 *Relive Cure:*\nUnitech Cyber Hub, Gurugram\n\n• Near Cyber Hub Metro\n• Free parking\n• Mon–Sat: 9 AM – 7 PM', HI: '📍 *Relive Cure:*\nUnitech Cyber Hub, Gurugram\n\n• Cyber Hub Metro के पास\n• Free parking\n• सोम–शनि: सुबह 9 – शाम 7' },
    ALTERNATIVES: { EN: '👓 LASIK vs Glasses:\n\n• LASIK → one-time cost, permanent freedom\n• Glasses → recurring cost, daily hassle\n• Sports / swimming → no glasses with LASIK ✅', HI: '👓 LASIK vs Chashma:\n\n• LASIK → एक बार का खर्च, हमेशा की आज़ादी\n• Chashma → बार-बार खर्च, रोज़ की परेशानी' },
    CONCERN: { EN: '😊 I hear you — blurry vision and being dependent on glasses is exactly what LASIK is designed to fix. Most patients become completely glasses-free after the procedure.\n\nOur specialist can check your eligibility properly — let me grab a couple of quick details first.', HI: '😊 मैं समझता हूँ — धुंधला दिखना और चश्मे पर निर्भर रहना, LASIK इसी के लिए बना है। ज़्यादातर patients procedure के बाद पूरी तरह चश्मा-मुक्त हो जाते हैं।\n\nSpecialist आपकी eligibility ठीक से check कर सकते हैं — पहले कुछ quick details ले लेता हूँ।' }
};

const INTENTS = {
    RECOVERY: ['recovery', 'recover', 'kitne din', 'kitna time', 'how long', 'recover time', 'recovery time', 'theek kab', 'ठीक होने', 'रिकवरी'],
    PAIN: ['pain', 'painful', 'dard', 'dard hoga', 'takleef', 'hurt', 'kya dard', 'दर्द', 'तकलीफ'],
    ELIGIBILITY: ['eligible', 'eligibility', 'suitable', 'possible', 'kar sakta', 'kar sakti', 'ho sakta', 'can i do', 'karwa sakta', 'kya main', 'योग्य', 'हो सकता'],
    REFERRAL: ['refer', 'referral', 'reward', 'earn', 'kya milega', 'रेफर', 'कमाई'],
    COST: ['cost', 'price', 'charges', 'fees', 'kharcha', 'rate', 'expense', 'amount', 'how much', 'how much does', 'how much is', 'money', 'kitna padega', 'kitne ka', 'kitna hai', 'kitna paisa', 'paisa kitna', 'paisa lagega', 'kitne paise', 'कितना खर्चा', 'कीमत', 'फीस', 'खर्च'],
    TIMELINE: ['when', 'how soon', 'schedule', 'kab', 'jaldi', 'next week', 'this week', 'soon', 'immediately', 'कब', 'जल्दी'],
    SAFETY: ['scared', 'fear', 'safe', 'risk', 'side effects', 'nervous', 'afraid', 'dar lag raha', 'danger', 'dangerous', 'डर', 'खतरा', 'सुरक्षित'],
    LOCATION: ['where', 'location', 'address', 'kahan hai', 'nearest', 'clinic', 'hospital', 'centre', 'कहाँ', 'पता'],
    ALTERNATIVES: ['contact lens', 'glasses', 'specs', 'chashma', 'alternative', 'lenses', 'spectacles', 'vs', 'compare', 'चश्मा', 'लेंस'],
    CONCERN: ['issue with my eye', 'issue with my eyes', 'issue in my eye', 'problem with my eye', 'problem in my eye', 'eye problem', 'eye issue', 'eyes problem', 'eyesight problem', 'blurry', 'blurred', 'blur', "can't see", 'cant see', 'cannot see', "can't read", 'unable to see', 'weak eyesight', 'weak eyes', 'weak eye', 'poor vision', 'bad vision', 'low vision', 'vision problem', 'vision issue', 'trouble seeing', 'difficulty seeing', 'thick glasses', 'high power', 'aankh', 'aankhon', 'aankhon mein', 'dikhai nahi', 'dikhta nahi', 'saaf nahi dikhta', 'nazar kamzor', 'kamzor nazar', 'धुंधला', 'दिखाई नहीं', 'नज़र', 'कमज़ोर']
};

function detectAllIntents(message) { const m = message.toLowerCase(); return Object.entries(INTENTS).filter(([, words]) => words.some(w => m.includes(w))).map(([intent]) => intent); }

function getNextQuestion(session, context = 'normal') {
    const d = session.data; const lang = session.lang || 'EN';
    const firstName = d.contactName && d.contactName !== 'WhatsApp Lead' ? d.contactName.split(' ')[0] : '';
    let field = null, text = '';
    if (!d.contactName) { field = 'NAME'; text = t('ASK_NAME', lang); }
    else if (!d.city) { field = 'CITY'; text = t('ASK_CITY', lang); }
    else if (!d.eyePower) { field = 'EYE_POWER'; text = t('ASK_EYE_POWER', lang); }
    else if (d.eyePower && !d.powerStability && getEyePowerNumeric(d.eyePower) !== null && getEyePowerNumeric(d.eyePower) <= -5) { field = 'POWER_STABILITY'; text = t('ASK_POWER_STABILITY', lang); }
    if (!field) return { text: '', field: null };
    session.data.lastAskedField = field;
    if (context === 'normal' && firstName && field !== 'NAME') { const g = { EN: `Got it, ${firstName} 👍\n\n`, HI: `समझ गया, ${firstName} 👍\n\n` }; text = (g[lang] || g.EN) + text; }
    if (context === 'resume') {
        const fn = { NAME: { EN: 'your name', HI: 'आपका नाम' }, CITY: { EN: 'your city', HI: 'आपका शहर' }, EYE_POWER: { EN: 'your eye power', HI: 'आपकी eye power' }, POWER_STABILITY: { EN: 'how stable your power is', HI: 'power कितनी stable है' } };
        const fld = fn[field] || { EN: field, HI: field };
        const r = { EN: `By the way, could you tell me ${fld.EN}?`, HI: `एक बात — ${fld.HI} बता सकते हैं?` };
        text = r[lang] || r.EN;
    }
    return { text, field };
}

function buildKnowledgeResponse(message, session) {
    const lang = session.lang || 'EN';
    let intents = detectAllIntents(message).filter(i => i !== 'YES' && i !== 'NO');
    if (/[-+]?\d+(\.\d+)?/.test(message) && !intents.includes('ELIGIBILITY') && session.state !== 'TIMELINE') { intents.push('ELIGIBILITY'); session.data.concern_power = true; }
    if (intents.length === 0) return null;
    const topIntent = intents[0];
    if (session.last_intent_handled === topIntent && session.last_intent_handled_at && Date.now() - session.last_intent_handled_at < 45000) {
        return { EN: 'I just shared details about that 😊 Anything specific you\'d like to know?', HI: 'मैंने अभी इसके बारे में बताया था 😊 कुछ specific पूछना चाहेंगे?' }[lang];
    }
    session.last_intent_handled = topIntent; session.last_intent_handled_at = Date.now();
    const kbEntry = KB[topIntent]; if (!kbEntry) return null;
    const ack = getAcknowledgement(message, lang);
    let baseReply = ack ? `${ack}\n\n${kbEntry[lang] || kbEntry.EN}` : (kbEntry[lang] || kbEntry.EN);
    if (intents.length > 1 && KB[intents[1]]) { const second = KB[intents[1]][lang] || KB[intents[1]].EN; if (second) baseReply += `\n\n─────────────\n\n${second}`; }
    if (intents.includes('COST')) session.data.interest_cost = true;
    if (intents.includes('RECOVERY')) session.data.interest_recovery = true;
    if (intents.includes('PAIN')) session.data.concern_pain = true;
    if (intents.includes('SAFETY')) session.data.concern_safety = true;
    if (intents.includes('CONCERN')) session.data.concern_power = true;
    const isEmotional = ['PAIN', 'SAFETY'].includes(topIntent);
    const isCallbackAlreadyOffered = session.data.callback_offered;
    if (!isEmotional) {
        if (shouldOfferCallback(session) && !isCallbackAlreadyOffered) {
            if (!session.data.callback_offered) session.data.callback_offered = true;
            session.data.request_call = true; session.data.human_handoff_started = true; session.data.callback_source = 'knowledge_trigger'; session.state = 'COMPLETE';
            const fn = session.data.contactName ? session.data.contactName.split(' ')[0] : '';
            baseReply += `\n\n${getEscalationMessage('candidate', lang, fn)}`;
        } else {
            const nextStep = getNextQuestion(session, 'resume');
            if (nextStep.text && nextStep.field) {
                // Only ask a field once via the resume path — don't repeat it on every KB response
                if (!session.data.resumeAsked) session.data.resumeAsked = [];
                if (!session.data.resumeAsked.includes(nextStep.field)) {
                    session.data.resumeAsked.push(nextStep.field);
                    baseReply += `\n\n${nextStep.text}`;
                }
            } else if (!isCallbackAlreadyOffered) {
                const rep = { EN: '\n\nOur representative will call you shortly 😊', HI: '\n\nहमारा representative जल्द call करेगा 😊' };
                baseReply += rep[lang] || rep.EN;
            }
        }
    }
    return baseReply;
}

// ─── WHATSAPP SEND (uses polyfilled globalThis.fetch) ────────────────────────
async function sendWhatsAppReply(phone, reply) {
    const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
    let rawText = '';
    try {
        const res = await globalThis.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: reply } }) });
        rawText = await res.text();
        if (res.status === 429) { console.warn('[WA SEND] ⚠️ Rate limited (429)'); return; }
        if (rawText.trim().startsWith('{')) {
            const data = JSON.parse(rawText);
            console.log('[WA SEND] ✅', JSON.stringify(data));
            // ─── WhatsApp Engine: capture every outbound message ───
            const _sentId = data.messages?.[0]?.id || null;
            saveWhatsAppMessage({
                phone,
                direction: 'outbound',
                body: reply,
                msgType: 'text',
                waMessageId: _sentId,
                waTimestamp: new Date().toISOString()
            }).catch(e => console.error('[WA CAPTURE] outbound', e.message));
        }
        else { console.warn('[WA SEND] ⚠️ Non-JSON:', rawText.substring(0, 200)); }
    } catch (err) { console.error('[WA SEND] ❌', err.message, rawText.substring(0, 200)); }
}

// ─── CORE MESSAGE HANDLER ─────────────────────────────────────────────────────
async function handleIncomingMessage(reqBody, isTestChat = false) {
    let phone, message, msgId;
    let reply = null, replied = false, finalized = false;
    const setReply = (text) => { if (!replied) { reply = text; replied = true; } };
    const finalize = (forceReturn = false) => {
        if (finalized) return reply;
        finalized = true;
        if (!reply) { const s = botSessions[phone]; const l = s?.lang || 'EN'; reply = t('FALLBACK', l); if (s) { s.data.request_call = true; if (!s.data.callback_offered) s.data.callback_offered = true; s.data.human_handoff_started = true; s.data.callback_source = 'fallback'; } }
        if (!forceReturn) sendWhatsAppReply(phone, reply);
        return reply;
    };

    try {
        if (reqBody?.entry) {
            const messageObj = reqBody.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
            if (!messageObj) return;
            phone = messageObj.from; message = messageObj.text?.body || ''; msgId = messageObj.id;

            // ─── WhatsApp Engine: capture every inbound message (text + media) ───
            try {
                const _waValue = reqBody.entry?.[0]?.changes?.[0]?.value;
                const _waContactName = _waValue?.contacts?.[0]?.profile?.name || null;
                const _waType = messageObj.type || 'text';
                const _waMediaId = (_waType !== 'text' && messageObj[_waType]) ? (messageObj[_waType].id || null) : null;
                saveWhatsAppMessage({
                    phone,
                    direction: 'inbound',
                    body: message || null,
                    msgType: _waType,
                    mediaId: _waMediaId,
                    waMessageId: msgId,
                    contactName: _waContactName,
                    waTimestamp: messageObj.timestamp || null
                }).catch(e => console.error('[WA CAPTURE] inbound', e.message));
            } catch (e) { console.error('[WA CAPTURE] inbound-prep', e.message); }

            // ─── Bot-pause: if a human took over this conversation in the dashboard,
            //     the inbound message is already captured above — just don't auto-reply. ───
            try {
                const { data: _convoPause } = await supabaseAdmin
                    .from('whatsapp_conversations')
                    .select('bot_paused')
                    .eq('phone', phone)
                    .maybeSingle();
                if (_convoPause?.bot_paused) {
                    console.log(`[BOT] ⏸️  paused for ${phone} — human takeover, skipping auto-reply`);
                    return;
                }
            } catch (e) { console.error('[BOT] pause-check error', e.message); }

            if (!message && messageObj.type && messageObj.type !== 'text') {
                const lang = botSessions[phone]?.lang || 'EN';
                await sendWhatsAppReply(phone, lang === 'HI' ? 'मैं अभी सिर्फ text process कर सकता हूँ 😊 कृपया type करें।' : 'I can only process text right now 😊 Please type your question.'); return;
            }
        } else { phone = reqBody.phone; message = reqBody.message || ''; msgId = null; }

        if (!phone || !message) return;
        message = message.trim(); const msgLow = message.toLowerCase();
        console.log(`[BOT] phone=${phone} msg="${message}"`);

        const dedupKey = msgId || (phone + '_' + Buffer.from(message).toString('base64').substring(0, 10) + '_' + Math.floor(Date.now() / 1000));
        if (botProcessedMessages.has(dedupKey)) return;
        botProcessedMessages.set(dedupKey, Date.now());

        if (!botSessions[phone]) {
            const existing = await checkExistingLead(phone);
            botSessions[phone] = { state: existing ? 'RETURNING' : 'GREETING', data: existing ? { contactName: existing.contact_name, is_returning: true } : {}, inactivityTimer: null, ingested: !!existing, first_ingest_done: !!existing, lang: 'EN', repeat_count: {}, resume_offered: false, last_intent_handled: null };
            if (!existing) { setImmediate(async () => { try { await sendToAPI(phone, botSessions[phone], 'initial'); } catch (e) { console.error('[ASYNC_INGEST_ERROR]', e); } }); }
        }

        let session = botSessions[phone];
        const { lang: detectedLang, confidence: langConf } = detectLanguageWithConfidence(message);
        if (langConf !== 'low' || !session.lang) session.lang = detectedLang;
        const lang = session.lang;

        session.last_activity_at = new Date().toISOString();
        if (!session.data.first_message_at) session.data.first_message_at = session.last_activity_at;
        session.data.message_count = (session.data.message_count || 0) + 1;
        session.data.lastMessage = message;
        passiveExtract(message, session);
        resetInactivityTimer(phone);

        if (session.state === 'COMPLETE' || session.state === 'CORE_CONSULT') {
            const stillExists = await checkExistingLead(phone);
            if (!stillExists && session.ingested) {
                delete botSessions[phone];
                botSessions[phone] = { state: 'GREETING', data: {}, inactivityTimer: null, ingested: false, first_ingest_done: false, lang, repeat_count: {}, resume_offered: false, last_intent_handled: null };
                session = botSessions[phone];
            }
        }

        session.repeat_count = session.repeat_count || {};

        if (isNotInterested(msgLow)) { session.data.opted_out = true; if (session.inactivityTimer) { clearTimeout(session.inactivityTimer); session.inactivityTimer = null; } setReply(t('NOT_INTERESTED', lang)); return finalizeWithIngest(phone, session, 'update', finalize, isTestChat); }

        const restartWords = ['hi', 'hello', 'hey', 'start', 'hii', 'helo', 'नमस्ते', 'हेलो', 'शुरू'];
        if (restartWords.some(w => msgLow === w || message === w)) {
            const hasData = session.data.contactName && session.data.contactName !== 'WhatsApp Lead';
            if (hasData && !session.resume_offered) { session.state = 'ASK_RESUME'; session.resume_offered = true; setReply(t('WELCOME_BACK', lang)); return finalizeWithIngest(phone, session, 'update', finalize, isTestChat); }
            else if (!hasData) { session.state = 'GREETING'; session.ingested = false; session.resume_offered = false; session.repeat_count = {}; }
        }

        if (isEscalationTrigger(msgLow)) { session.data.escalation_note = message; session.data.request_call = true; if (!session.data.callback_offered) session.data.callback_offered = true; session.state = 'COMPLETE'; session.data.human_handoff_started = true; session.data.callback_source = 'escalation'; const fn = session.data.contactName ? session.data.contactName.split(' ')[0] : ''; setReply(getEscalationMessage('educational', lang, fn)); return finalizeWithIngest(phone, session, 'update', finalize, isTestChat); }

        if (isSalesIntent(msgLow)) { session.data.request_call = true; if (!session.data.callback_offered) session.data.callback_offered = true; session.state = 'COMPLETE'; session.data.human_handoff_started = true; session.data.callback_source = 'sales_intent'; const fn = session.data.contactName ? session.data.contactName.split(' ')[0] : ''; setReply(getEscalationMessage('callback', lang, fn)); return finalizeWithIngest(phone, session, 'update', finalize, isTestChat); }

        const knowledge = buildKnowledgeResponse(message, session);
        if (knowledge) { setReply(knowledge); return finalizeWithIngest(phone, session, 'knowledge', finalize, isTestChat); }

        const state = session.state;
        session.repeat_count[state] = (session.repeat_count[state] || 0) + 1;

        if (state === 'GREETING') { session.state = 'NAME'; setReply(isHighIntentFirst(msgLow) ? t('GREETING_HIGH_INTENT', lang) : t('GREETING', lang)); }

        else if (state === 'ASK_RESUME') {
            const isYes = ['yes', 'haan', 'ha', 'ok', 'okay', 'sure', 'हाँ', 'ठीक', 'bilkul', 'ji'].some(w => msgLow.includes(w));
            if (isYes) { const next = getNextQuestion(session); if (next.field) { const r = { EN: `Great! Let's continue.\n\n${next.text}`, HI: `बढ़िया! जारी रखते हैं।\n\n${next.text}` }; setReply(r[lang] || r.EN); session.state = 'CORE_CONSULT'; } else { session.state = 'COMPLETE'; setReply(getRandomCompleteReply(lang)); session.data.request_call = true; } }
            else { session.state = 'GREETING'; session.data = {}; session.repeat_count = {}; session.resume_offered = false; setReply(t('GREETING', lang)); session.state = 'NAME'; }
        }

        else if (state === 'RETURNING') {
            const lead = await checkExistingLead(phone);
            const fn = session.data.contactName ? session.data.contactName.split(' ')[0] : '';
            if (lead && lead.pushed_to_crm) { session.state = 'COMPLETE'; const r = { EN: `Welcome back${fn ? `, ${fn}` : ''}! 👋 Your details are saved ✅\n\nHow can I help?\n• Ask about cost or recovery\n• Or say *call* for a specialist`, HI: `वापस आए${fn ? `, ${fn}` : ''}! 👋 Details saved हैं ✅\n\nकैसे help करूँ?\n• Cost या recovery जानें\n• Specialist के लिए *call* लिखें` }; setReply(r[lang] || r.EN); }
            else { const next = getNextQuestion(session); if (next.field) { const r = { EN: `Welcome back! Let's continue.\n\n${next.text}`, HI: `वापस आए! जारी रखते हैं।\n\n${next.text}` }; setReply(r[lang] || r.EN); session.state = 'CORE_CONSULT'; } else { session.state = 'COMPLETE'; setReply(getRandomCompleteReply(lang)); session.data.request_call = true; } }
        }

        else if (state === 'NAME') {
            if (!isValidName(message)) {
                if (session.repeat_count['NAME'] > 2) { session.data.contactName = 'WhatsApp Lead'; session.state = 'CORE_CONSULT'; setReply({ EN: 'No problem 😊\nAre you exploring LASIK, specs removal, or just checking options right now?', HI: 'कोई बात नहीं 😊\nक्या आप LASIK, specs removal, या सिर्फ options देख रहे हैं?' }[lang]); }
                else { setReply(t('INVALID_NAME', lang)); }
            } else {
                if (message && message !== 'WhatsApp Lead' && (!session.data.contactName || session.data.contactName === 'WhatsApp Lead')) session.data.contactName = message;
                const fn = (session.data.contactName || message).split(' ')[0];
                setReply({ EN: `Nice to meet you, ${fn} 😊\nAre you exploring LASIK, specs removal, or just checking options right now?`, HI: `आपसे मिलकर अच्छा लगा, ${fn} 😊\nक्या आप LASIK, specs removal, या सिर्फ options explore कर रहे हैं?` }[lang]);
                session.state = 'CORE_CONSULT';
            }
        }

        else if (state === 'CORE_CONSULT') {
            if (!session.data.powerStability && getEyePowerNumeric(session.data.eyePower) !== null && getEyePowerNumeric(session.data.eyePower) <= -5) session.data.powerStability = message;
            if (shouldOfferCallback(session)) {
                if (!session.data.callback_offered) session.data.callback_offered = true;
                session.data.request_call = true; session.state = 'COMPLETE'; session.data.human_handoff_started = true;
                const fn = session.data.contactName ? session.data.contactName.split(' ')[0] : '';
                const ack = getAcknowledgement(message, lang);
                const cbMsg = getEscalationMessage('candidate', lang, fn);
                setReply(ack ? `${ack}\n\n${cbMsg}` : cbMsg);
                return finalizeWithIngest(phone, session, 'complete', finalize, isTestChat);
            }
            const next = getNextQuestion(session);
            if (next.field) {
                const ackCC = getAcknowledgement(message, lang);
                setReply(ackCC ? `${ackCC}\n\n${next.text}` : next.text);
            }
            else { session.data.request_call = true; if (!session.data.callback_offered) session.data.callback_offered = true; session.state = 'COMPLETE'; session.data.human_handoff_started = true; session.data.callback_source = 'completion'; setReply(getRandomCompleteReply(lang)); }
        }

        else if (state === 'COMPLETE') {
            const kb = buildKnowledgeResponse(message, session);
            if (kb) { setReply(kb); }
            else { if (!session.data.human_handoff_started) { session.data.request_call = true; session.data.human_handoff_started = true; } const ack = getAcknowledgement(message, lang); setReply(ack ? `${ack}\n\n${getRandomCompleteReply(lang)}` : getRandomCompleteReply(lang)); }
        }

        return finalizeWithIngest(phone, session, 'update', finalize, isTestChat);
    } catch (err) { console.error('[BOT ERROR]', err); setReply('Something went wrong. Please try again.'); finalize(); }
    finally { schedulePersist(); }
}

function finalizeWithIngest(phone, session, trigger, finalizeFn, isTestChat = false) {
    setImmediate(async () => { try { await sendToAPI(phone, session, trigger); } catch (e) { console.error('[ASYNC_INGEST_ERROR]', e); } });
    return finalizeFn(isTestChat);
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/chat', async (req, res) => {
    try { const reply = await handleIncomingMessage(req.body, true); res.json({ reply }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WhatsApp Inbox: send a message from the dashboard ───────────────────────
app.post('/api/whatsapp/send', async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const { phone, message } = req.body || {};
    if (!phone || !message || !String(message).trim()) {
        return res.status(400).json({ error: 'phone and message are required' });
    }
    try {
        // sendWhatsAppReply already captures the outbound message into whatsapp_messages
        await sendWhatsAppReply(phone, String(message).trim());
        res.json({ success: true });
    } catch (e) {
        console.error('[WA SEND API] ❌', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── WhatsApp Inbox: send IMAGE / AUDIO / VIDEO / DOCUMENT from the dashboard ──
// Multipart form fields: `file` (the media), `phone`, optional `caption`, optional `type` override.
// Type is auto-detected from the file's MIME if not provided. Auto-captured into whatsapp_messages.
app.post('/api/whatsapp/send-media', upload.single('file'), async (req, res) => {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const { phone, caption, type: typeOverride } = req.body || {};
    const file = req.file;
    if (!phone || !file || !file.buffer) {
        return res.status(400).json({ error: 'phone and file are required (multipart)' });
    }
    // Detect WhatsApp type from MIME (caller may override via the type field).
    const mime = file.mimetype || 'application/octet-stream';
    const waType = typeOverride || (
        mime.startsWith('image/')    ? 'image' :
        mime.startsWith('audio/')    ? 'audio' :
        mime.startsWith('video/')    ? 'video' :
        'document'
    );
    // Meta is strict on audio MIME — accept ogg/opus, aac, amr, mp3, mp4 audio.
    // Browser MediaRecorder usually produces audio/webm;codecs=opus — relabel to audio/ogg
    // so Meta accepts it (the Opus payload is identical inside both containers in practice).
    const sendMime = (waType === 'audio' && /webm/i.test(mime)) ? 'audio/ogg' : mime;

    try {
        // ─── STEP 1: upload the bytes to Meta → get a media_id ───
        const uploadUrl = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/media`;
        const uploadForm = new FormData();
        uploadForm.append('messaging_product', 'whatsapp');
        uploadForm.append('type', sendMime);
        uploadForm.append('file', new Blob([file.buffer], { type: sendMime }), file.originalname || `upload.${waType}`);
        const upRes = await globalThis.fetch(uploadUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
            body: uploadForm
        });
        const upJson = await upRes.json();
        if (!upJson.id) {
            console.error('[WA SEND-MEDIA] ❌ upload failed:', JSON.stringify(upJson).substring(0, 300));
            return res.status(500).json({ error: 'Media upload to Meta failed', detail: upJson });
        }
        const mediaId = upJson.id;

        // ─── STEP 2: send the message referencing media_id ───
        const sendBody = {
            messaging_product: 'whatsapp',
            to: phone,
            type: waType,
            [waType]: caption && String(caption).trim()
                ? { id: mediaId, caption: String(caption).trim() }
                : { id: mediaId }
        };
        // documents need a filename so the recipient sees a sensible name
        if (waType === 'document') sendBody.document.filename = file.originalname || 'document';
        const sendUrl = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
        const sendRes = await globalThis.fetch(sendUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(sendBody)
        });
        const sendJson = await sendRes.json();
        const sentId = sendJson?.messages?.[0]?.id || null;
        if (!sentId) {
            console.error('[WA SEND-MEDIA] ❌ send failed:', JSON.stringify(sendJson).substring(0, 300));
            return res.status(500).json({ error: 'Message send failed', detail: sendJson });
        }
        console.log(`[WA SEND-MEDIA] ✅ ${waType} sent: media_id=${mediaId}, wa_message_id=${sentId}`);

        // ─── STEP 3: capture the outbound media message into whatsapp_messages ───
        saveWhatsAppMessage({
            phone,
            direction: 'outbound',
            body: caption && String(caption).trim() ? String(caption).trim() : null,
            msgType: waType,
            mediaId,
            waMessageId: sentId,
            waTimestamp: new Date().toISOString()
        }).catch(e => console.error('[WA CAPTURE] outbound media', e.message));

        res.json({ success: true, wa_message_id: sentId, media_id: mediaId, type: waType });
    } catch (e) {
        console.error('[WA SEND-MEDIA] ❌', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── WhatsApp Inbox: proxy media (image/audio/video/doc) from the Cloud API ──
// Cloud API media URLs are short-lived and require the auth token, so an <img>
// tag can't load them directly — the dashboard points at this proxy instead.
app.get('/api/whatsapp/media/:mediaId', async (req, res) => {
    const { mediaId } = req.params;
    if (!mediaId) return res.status(400).send('media id required');
    try {
        // Only proxy media ids we actually captured (guards against arbitrary fetches)
        const { data: known } = await supabaseAdmin
            .from('whatsapp_messages')
            .select('id')
            .eq('media_id', mediaId)
            .limit(1)
            .maybeSingle();
        if (!known) return res.status(404).send('Unknown media');

        // Step 1: resolve the short-lived media URL
        const metaRes = await globalThis.fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
        });
        const meta = await metaRes.json();
        if (!meta || !meta.url) return res.status(404).send('Media URL unavailable');

        // Step 2: download the bytes (auth header required)
        const binRes = await globalThis.fetch(meta.url, {
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
        });
        const buf = Buffer.from(await binRes.arrayBuffer());
        res.set('Content-Type', meta.mime_type || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (e) {
        console.error('[WA MEDIA] ❌', e.message);
        res.status(500).send('Media fetch failed');
    }
});

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('[WEBHOOK] ✅ Verified'); return res.status(200).send(challenge); }
    console.warn('[WEBHOOK] ❌ Verification failed');
    return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!message) { console.log('[WEBHOOK] No message — status update, skipping.'); return; }
        console.log('[WEBHOOK] 📩 phone:', message.from, '| text:', message.text?.body, '| msgId:', message.id);
        await handleIncomingMessage(req.body, false);
    } catch (err) { console.error('[WEBHOOK] ❌ Unhandled error:', err.message); }
});


// ─── Refrens Sync Routes ──────────────────────────────────────────────────────
app.post('/api/sync-refrens', async (req, res) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== process.env.CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const result = await syncRefrensLeads(supabaseAdmin);
        res.json(result);
    } catch (err) {
        console.error('[SYNC-REFRENS ROUTE]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/refrens-analytics', async (req, res) => {
    try {
        // Paginate to fetch all leads (Supabase default cap is 1000/page)
        let allData = [];
        let from = 0;
        const pageSize = 1000;
        while (true) {
            const { data, error } = await supabaseAdmin
                .from('refrens_leads')
                .select('id, phone, contact_name, status, assignee, lead_source, customer_city, refrens_created_at, intent_band, call_outcome, consultation_status, objection_type, follow_up_date, labels, state, timeline, insurance, eye_power, age, reason_for_lasik, parameters_completed, last_user_message, lead_type, city_preference, lead_description, last_comment_by, synced_at, date_closed, next_activity, last_internal_note, first_response_time, whatsapp_link, duplicate, intent_score')
                .order('refrens_created_at', { ascending: false })
                .range(from, from + pageSize - 1);
            if (error) throw new Error(error.message);
            if (!data || data.length === 0) break;
            allData = allData.concat(data);
            if (data.length < pageSize) break;
            from += pageSize;
        }
        res.json({ success: true, count: allData.length, leads: allData });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/sync-status', async (req, res) => {
    try {
        const { count, error: countErr } = await supabaseAdmin
            .from('refrens_leads')
            .select('*', { count: 'exact', head: true });
        if (countErr) throw new Error(countErr.message);

        const { data: lastSync, error: syncErr } = await supabaseAdmin
            .from('refrens_leads')
            .select('synced_at')
            .order('synced_at', { ascending: false })
            .limit(1)
            .single();

        res.json({
            success: true,
            refrens_leads_count: count,
            last_synced_at: lastSync?.synced_at || null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// ─── CSV Upload Sync ─────────────────────────────────────────────────────────
app.post('/api/upload-refrens-csv', express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
    const key = req.headers['x-api-key'];
    if (key !== process.env.CRM_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { parse } = await import('csv-parse/sync');
        const rows = parse(req.body.replace(/^\uFEFF/, ''), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });

        function normPhone(raw) {
            if (!raw) return null;
            const d = raw.replace(/[^\d]/g, '');
            if (d.length < 7) return null;
            if (d.startsWith('91') && d.length === 12) return d.slice(2);
            return d;
        }
        function gf(row, ...keys) {
            for (const k of keys) { const v = (row[k]||'').trim(); if (v && !['-','false','true','..'].includes(v)) return v; }
            return null;
        }
        function pd(s) {
            if (!s || ['-',''].includes(s.trim())) return null;
            try { return new Date(s).toISOString(); } catch { return null; }
        }

        const seen = {};
        for (const row of rows) {
            const phone = normPhone(row['Phone']||'') || normPhone(row['phone_number']||'');
            if (!phone) continue;
            seen[phone] = {
                id: phone, phone, contact_name: gf(row,'Contact Name'),
                customer_city: gf(row,'Customer City'), state: gf(row,'State'),
                refrens_created_at: pd(row['Created At']), status: gf(row,'Status'),
                lead_source: gf(row,'Lead Source'), assignee: gf(row,'Assignee'),
                follow_up_date: pd(row['Follow up date']), last_comment_by: gf(row,'Last comment by'),
                first_response_time: gf(row,'First Response Time'), last_internal_note: gf(row,'Last Internal Note'),
                next_activity: pd(row['Next Activity']), date_closed: pd(row['Date Closed']),
                whatsapp_link: gf(row,'Whatsapp Link'), lead_description: gf(row,'Lead Description'),
                labels: gf(row,'Labels'), duplicate: gf(row,'Duplicate'),
                call_outcome: gf(row,'Call Outcome'), consultation_status: gf(row,'Consultation Status'),
                lead_state: gf(row,'Lead State'), intent_band: gf(row,'Intent Band'),
                intent_score: gf(row,'Intent Score'), objection_type: gf(row,'Objection Type'),
                eye_power: gf(row,"what_is_your_current_eye_power?","what\'s_your_eye_power?"),
                insurance: gf(row,"do_you_have_medical_insurance_","do_you_have_medical_insurance?","do_you_have_health_insurance_","do_you_have_insurance?"),
                timeline: gf(row,"when_would_you_prefer_to_undergo_the_lasik_treatment?","when_are_you_planning_for_lasik?","when_are_you_looking_to_get_lasik_consultation?"),
                city_preference: gf(row,"kindly_choose_the_city_where_you_wish_to_avail_the_treatment","which_city_would_you_prefer_for_treatment_"),
                last_user_message: gf(row,'last_user_message'), lead_type: gf(row,'lead_type'),
                parameters_completed: gf(row,'parameters_completed'),
                reason_for_lasik: gf(row,"what_is_the_main_reason_you\'re_considering_lasik_surgery?"),
                age: gf(row,"what\'s_your_age?"), synced_at: new Date().toISOString()
            };
        }

        const mapped = Object.values(seen);
        let upserted = 0;
        for (let i = 0; i < mapped.length; i += 100) {
            const { error } = await supabaseAdmin.from('refrens_leads').upsert(mapped.slice(i, i+100), { onConflict: 'id' });
            if (!error) upserted += Math.min(100, mapped.length - i);
            else console.error('[CSV UPLOAD] Batch error:', error.message);
        }
        console.log(`[CSV UPLOAD] ✅ ${upserted}/${mapped.length} upserted from uploaded CSV`);
        res.json({ success: true, total_rows: rows.length, valid_rows: mapped.length, upserted, synced_at: new Date().toISOString() });
    } catch (err) {
        console.error('[CSV UPLOAD] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Keep-alive ───────────────────────────────────────────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health` : null;
if (SELF_URL) {
    setInterval(async () => { try { const r = await globalThis.fetch(SELF_URL); console.log(`[KEEPALIVE] → ${r.status}`); } catch (e) { console.warn('[KEEPALIVE] Ping failed:', e.message); } }, 4 * 60 * 1000);
    console.log(`[KEEPALIVE] Enabled → ${SELF_URL}`);
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[API] ✅ Server running on port ${PORT}`);
    console.log('[BOT] ✅ v6.2-stable embedded — no HTTP overhead');

    // ─── Refrens auto-sync scheduler ─────────────────────────────────────────
    async function runRefrensSync() {
        console.log('[SCHEDULER] 🔄 Auto-sync Refrens leads...');
        try {
            const result = await syncRefrensLeads(supabaseAdmin);
            console.log('[SCHEDULER] Refrens sync result:', JSON.stringify(result));
        } catch (err) {
            console.error('[SCHEDULER] Refrens sync failed:', err.message);
        }
    }
    // First run: 3 minutes after boot (let server fully warm up)
    setTimeout(runRefrensSync, 3 * 60 * 1000);
    // Then every 4 hours
    setInterval(runRefrensSync, 4 * 60 * 60 * 1000);
    console.log('[SCHEDULER] Refrens sync: first run in 3 min, then every 4h');
});
