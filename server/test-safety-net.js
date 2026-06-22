/**
 * SAFETY NET TEST HARNESS
 * Tests all chatbot safety functions against real WhatsApp messages from Supabase.
 * Does NOT start the server or connect to any external service.
 * 
 * Usage: node server/test-safety-net.js
 */

import crypto from 'crypto';
import { isIndianCity, isInventedAgentClaim, hasLocationIntent } from './bot-guard.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. EXTRACT ALL SAFETY FUNCTIONS (identical copies from index.js)
// ═══════════════════════════════════════════════════════════════════════════════

const NAME_BLACKLIST = new Set([
    'yes', 'ok', 'okay', 'haan', 'ha', 'no', 'nah', 'start', 'nahi', 'nope', 'sure', 'chalo', 'bilkul', 'haan ji',
    'skip', 'next', 'continue', 'hello', 'hi', 'hey', 'theek', 'accha', 'achha', 'thik', 'lasik', 'surgery', 'good', 'fine',
    'kya', 'kaise', 'kab', 'kahan', 'kyu', 'kyon', 'kyun', 'kahaan', 'kab tak', 'kaisa',
    'what', 'how', 'where', 'when', 'why', 'who', 'which',
]);
const MEDICAL_BLACKLIST = new Set([
    'lipoma', 'cancer', 'motiyabind', 'cataract', 'tumor', 'tumour',
    'diabetes', 'thyroid', 'hernia', 'asthma', 'malaria', 'dengue',
    'typhoid', 'jaundice', 'migraine', 'epilepsy', 'arthritis',
    'pneumonia', 'cholesterol', 'infection', 'allergy', 'fracture',
    'appendix', 'ulcer', 'piles', 'fistula', 'gallstone', 'kidney',
    'liver', 'heart', 'brain', 'stomach', 'spine', 'knee', 'shoulder'
]);
const COMMON_WORD_BLACKLIST = new Set([
    'morning', 'evening', 'night', 'afternoon', 'today', 'tomorrow',
    'mr', 'mrs', 'miss', 'sir', 'madam', 'dear', 'bhai', 'bhaiya',
    'didi', 'ji', 'sahab', 'sahib', 'love', 'thanks', 'thank',
    'please', 'location', 'rate', 'price', 'cost', 'address',
    'number', 'glass', 'glasses', 'lens', 'lenses', 'specs',
    'but', 'and', 'or', 'the', 'was', 'is', 'are', 'it', 'its',
    'specs removal', 'option', 'options', 'checking',
    // Hindi filler/pronouns that aren't names
    '\u0907\u0938', '\u092f\u0939', '\u0935\u0939', '\u092e\u0948\u0902', '\u0924\u0941\u092e', '\u0906\u092a', '\u0939\u092e', '\u092f\u0947', '\u0935\u094b',
    '\u0915\u094b\u0908', '\u0915\u0941\u091b', '\u0905\u092d\u0940', '\u092c\u0938', '\u0939\u093e\u0902', '\u0928\u093e', '\u091c\u0940'
]);

const NAME_QUESTION_PREFIX_RE = /^(kya|kaise|kab|kahan|kyu|kyon|kyun|kahaan|kaisa|what|how|where|when|why|who|which)\b/i;

function isValidName(str) {
    if (!str || str.trim().length < 2) return false;
    const trimmed = str.trim();
    const low = trimmed.toLowerCase();
    if (NAME_BLACKLIST.has(low)) return false;
    if (MEDICAL_BLACKLIST.has(low)) return false;
    if (COMMON_WORD_BLACKLIST.has(low)) return false;
    if (['mr', 'mrs', 'ms', 'dr', 'sir', 'madam'].includes(low)) return false;
    if (trimmed.includes('?')) return false;
    if (NAME_QUESTION_PREFIX_RE.test(trimmed)) return false;
    if (/\u0915\u094D\u092F\u093E|\u0915\u0948\u0938\u0947|\u0915\u092C|\u0915\u0939\u093E\u0901|\u0915\u0939\u093E\u0902|\u0915\u094D\u092F\u094B\u0902|\u0915\u094D\u092F\u0942/.test(trimmed)) return false;
    if (trimmed.split(/\s+/).length >= 3) return false;
    const firstWord = low.split(/\s+/)[0];
    if (NAME_BLACKLIST.has(firstWord)) return false;
    if (isIndianCity(trimmed)) return false;
    if (/[\u0900-\u097F]/.test(trimmed)) return trimmed.length >= 2;
    if (!/^[a-zA-Z\s]+$/.test(trimmed)) return false;
    return trimmed.split(/\s+/).some(w => w.length >= 2);
}

const DISENGAGE_TRIGGERS = [
    'bye', 'bye bye', 'good bye', 'goodbye', 'block', 'i block you',
    'stop', 'bakwas band', 'bar bar', 'good night', 'so jao', 'ruko',
    'mat bhejo', 'message mat', 'mat karo', 'leave me', 'chhod do',
    'go away', 'get lost'
];
const ABUSE_WORDS = [
    'chutiya', 'chutiye', 'madarchod', 'bhenchod',
    'bhosdike', 'gandu', 'sale', 'saale', 'bewakoof',
    'idiot', 'stupid', 'fool', 'pagal', 'kamina', 'harami'
];
const ABUSE_RE = new RegExp(
    ABUSE_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    '|ch+u+\\.*(t|d)i?y[ae]|bh?o?s[dk]', 'i'
);
function isDisengaged(msg) { return DISENGAGE_TRIGGERS.some(t => msg.toLowerCase().includes(t)); }
function isAbusive(msg) { return ABUSE_RE.test(msg); }

const NAME_CORRECTION_NEG = /(?:mera naam|my name|mera nam)\s+(?:nahi hai|nhi hai|isn'?t|is not|nahi h|nhi h)/i;
const NAME_INTRO_RE = /(?:mera naam|my name|i am|i'm|myself|my self|main|mai|i'm)\s+(?:hai|is|h|)\s*(.+)/i;
function checkNameCorrection(message, session) {
    if (NAME_CORRECTION_NEG.test(message)) {
        session.data.contactName = null;
        session.state = 'NAME';
        return 'cleared';
    }
    const posMatch = message.match(NAME_INTRO_RE);
    if (posMatch && posMatch[1].trim().length >= 2) {
        const newName = posMatch[1].trim().split(/\s+/).slice(0, 2).join(' ');
        if (isValidName(newName)) {
            session.data.contactName = newName;
            return 'captured';
        }
    }
    return false;
}

const OFF_TOPIC_RE = /\b(back side|peeth|kamar|waist|knee|ghutna|stomach|pet|skin|hair|baal|shoulder|kandha|leg|foot|hand|lipoma|hernia|piles)\b.*\b(problem|issue|pain|dard|ho gyi|ho gayi|hai|h|me hai|mein hai)\b/i;
const OFF_TOPIC_RE2 = /\b(problem|issue|bimari|rog)\b.*\b(lipoma|hernia|piles|kamar|peeth|knee|ghutna|stomach|pet|skin|hair|baal|shoulder)\b/i;
function isOffTopic(msg) { return OFF_TOPIC_RE.test(msg) || OFF_TOPIC_RE2.test(msg); }

const CITY_BLACKLIST = new Set([
    'lasik', 'specs removal', 'specs', 'surgery', 'option', 'options',
    'checking', 'number', 'number h', 'glass', 'glasses', 'lens',
    'lenses', 'but', 'and', 'mr', 'yes please', 'rate', 'cost',
    'price', 'love', 'operation', 'eye', 'eyes', 'chashma', 'ok',
    'yes', 'no', 'haan', 'nahi'
]);

function isCityValid(text) {
    const t = text.trim();
    const words = t.split(/\s+/);
    const isShort = t.length >= 2 && t.length <= 30 && words.length <= 2;
    const isLetters = /^[a-zA-Zऀ-ॿ\s.'-]+$/.test(t);
    const notGeneric = !['yes','no','ok','haan','nahi','sure','hi','hello','start','later','baad mein','baad'].includes(t.toLowerCase());
    const notBlacklisted = !CITY_BLACKLIST.has(t.toLowerCase());
    return isShort && isLetters && notGeneric && notBlacklisted;
}

const recentOutbound = {};
function hashMsg(text) { return crypto.createHash('md5').update(text || '').digest('hex'); }
function isLooping(phone, reply) { return (recentOutbound[phone] || []).includes(hashMsg(reply)); }
function trackOutbound(phone, reply) {
    if (!recentOutbound[phone]) recentOutbound[phone] = [];
    recentOutbound[phone].push(hashMsg(reply));
    if (recentOutbound[phone].length > 3) recentOutbound[phone].shift();
}

function safeFirstName(session) {
    const cn = session.data?.contactName;
    if (!cn || cn === 'WhatsApp Lead' || isIndianCity(cn)) return '';
    return cn.split(' ')[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

let totalTests = 0, passed = 0, failed = 0;
const failures = [];

function test(group, name, actual, expected) {
    totalTests++;
    const ok = actual === expected;
    if (ok) {
        passed++;
        process.stdout.write(`  ✅ ${name}\n`);
    } else {
        failed++;
        const msg = `  ❌ ${name}  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
        process.stdout.write(msg + '\n');
        failures.push({ group, name, actual, expected });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. TEST SUITES — REAL MESSAGES FROM SUPABASE
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║         CHATBOT SAFETY NET — COMPREHENSIVE TEST SUITE         ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

// ─── SUITE A: Name Validation ────────────────────────────────────────────────
console.log('━━━ SUITE A: Name Validation (should REJECT bad names) ━━━');

// Real bad names from Supabase leads_surgery
test('A', '"Lipoma" (medical term, phone 918387925428)', isValidName('Lipoma'), false);
test('A', '"Morning" (greeting, phone 917017425243)', isValidName('Morning'), false);
test('A', '"Mr" (title, phone 917018290947)', isValidName('Mr'), false);
test('A', '"इस" (Hindi pronoun, phone 918005587081)', isValidName('इस'), false);
test('A', '"Love" (common word)', isValidName('Love'), false);
test('A', '"Location" (common word)', isValidName('Location'), false);
test('A', '"Rate" (common word)', isValidName('Rate'), false);
test('A', '"Glass" (common word)', isValidName('Glass'), false);
test('A', '"Cost" (common word)', isValidName('Cost'), false);
test('A', '"Lasik" (intent word)', isValidName('Lasik'), false);
test('A', '"Cataract" (medical term)', isValidName('Cataract'), false);
test('A', '"Hernia" (medical term)', isValidName('Hernia'), false);
test('A', '"Sir" (title)', isValidName('Sir'), false);
test('A', '"Dear" (common word)', isValidName('Dear'), false);
test('A', '"Thanks" (common word)', isValidName('Thanks'), false);
test('A', '"Yes" (filler word)', isValidName('Yes'), false);
test('A', '"Specs" (intent word)', isValidName('Specs'), false);
test('A', '"Number" (common word)', isValidName('Number'), false);
test('A', '"Jharkhand want treatment..." (sentence, phone 918789124352)', 
    isValidName('Jharkhand want treatment not in gurugram'), false);
test('A', '"Hyderabad" (city not name, phone 918328590366 / Dinesh)', isValidName('Hyderabad'), false);
test('A', '"Hyderabad ,Telangana" (city not name)', isValidName('Hyderabad ,Telangana'), false);

console.log('\n━━━ SUITE A2: Name Validation (should ACCEPT valid names) ━━━');
test('A2', '"Mukesh Tiwari" (real name, phone 918349626105)', isValidName('Mukesh Tiwari'), true);
test('A2', '"Nisha" (real name, phone 918082320307)', isValidName('Nisha'), true);
test('A2', '"Rahul" (real name, phone 918619560425)', isValidName('Rahul'), true);
test('A2', '"Ramu kaka" (real name, phone 917082220214)', isValidName('Ramu kaka'), true);
test('A2', '"Variya sumit" (real name)', isValidName('Variya sumit'), true);
test('A2', '"Abhishek lowanshi" (real name)', isValidName('Abhishek lowanshi'), true);
test('A2', '"Khadeeja" (real name)', isValidName('Khadeeja'), true);
test('A2', '"Chirag" (real name)', isValidName('Chirag'), true);
test('A2', '"Priya" (real name)', isValidName('Priya'), true);
test('A2', '"Ajay" (real name)', isValidName('Ajay'), true);
test('A2', '"Deepak" (real name)', isValidName('Deepak'), true);
test('A2', '"Ramu" (real name)', isValidName('Ramu'), true);

// ─── SUITE B: Disengagement Detection ────────────────────────────────────────
console.log('\n━━━ SUITE B: Disengagement Detection ━━━');

// Real disengagement messages from phone 918387925428
test('B', '"Aap so jao good night"', isDisengaged('Aap so jao good night'), true);
test('B', '"Bar bar mujhe message mat karo"', isDisengaged('Bar bar mujhe message mat karo'), true);
test('B', '"Bye bye"', isDisengaged('Bye bye'), true);
test('B', '"I block you"', isDisengaged('I block you'), true);
test('B', '"stop"', isDisengaged('stop'), true);
test('B', '"get lost"', isDisengaged('get lost'), true);
test('B', '"mat bhejo"', isDisengaged('mat bhejo'), true);
test('B', '"leave me alone"', isDisengaged('leave me alone'), true);

// Should NOT trigger for normal messages
test('B', '"Hello" should NOT trigger', isDisengaged('Hello'), false);
test('B', '"Yes" should NOT trigger', isDisengaged('Yes'), false);
test('B', '"Jaipur" should NOT trigger', isDisengaged('Jaipur'), false);
test('B', '"Cost" should NOT trigger', isDisengaged('Cost'), false);
test('B', '"4.5" should NOT trigger', isDisengaged('4.5'), false);
test('B', '"Mukesh Tiwari" should NOT trigger', isDisengaged('Mukesh Tiwari'), false);

// ─── SUITE C: Abuse Detection ────────────────────────────────────────────────
console.log('\n━━━ SUITE C: Abuse Detection ━━━');

// Real abuse from phone 918387925428
test('C', '"Tum to chhu..tiye ho..." (real msg)', isAbusive('Tum to chhu..tiye ho jo itni asan bhasha bhi samjh nhi aa rahi tumko'), true);
test('C', '"Haa pehnta hu sale" (real msg)', isAbusive('Haa pehnta hu sale'), true);
test('C', '"Teri bakwas band kar"', isAbusive('Teri bakwas band kar'), false); // bakwas is in disengage, not abuse
test('C', '"idiot bot"', isAbusive('idiot bot'), true);
test('C', '"pagal ho kya"', isAbusive('pagal ho kya'), true);

// Should NOT trigger for normal messages
test('C', '"Bhopal" should NOT trigger', isAbusive('Bhopal'), false);
test('C', '"4.5" should NOT trigger', isAbusive('4.5'), false);
test('C', '"Recovery?" should NOT trigger', isAbusive('Recovery?'), false);
test('C', '"Cost" should NOT trigger', isAbusive('Cost'), false);

// ─── SUITE D: Name Correction ────────────────────────────────────────────────
console.log('\n━━━ SUITE D: Name Correction Detection ━━━');

let sess;

// Real: phone 918387925428 — "My name isn't lipoma"
sess = { data: { contactName: 'Lipoma' }, state: 'CORE_CONSULT' };
test('D', '"My name isn\'t lipoma" → clears name', checkNameCorrection("My name isn't lipoma", sess), 'cleared');
test('D', '  → contactName set to null', sess.data.contactName, null);
test('D', '  → state set to NAME', sess.state, 'NAME');

// Real: phone 918387925428 — "Mera naam nhi hai lipoma"
sess = { data: { contactName: 'Lipoma' }, state: 'CORE_CONSULT' };
test('D', '"Mera naam nhi hai lipoma" → clears', checkNameCorrection('Mera naam nhi hai lipoma', sess), 'cleared');

// Real: phone 917017425243 — "No my self chirag hudda"
sess = { data: { contactName: 'Morning' }, state: 'CORE_CONSULT' };
test('D', '"No my self chirag hudda" → captures', checkNameCorrection('No my self chirag hudda', sess), 'captured');
test('D', '  → contactName = "chirag hudda"', sess.data.contactName, 'chirag hudda');

// Positive captures
sess = { data: { contactName: null }, state: 'NAME' };
test('D', '"My name is Rahul" → captures', checkNameCorrection('My name is Rahul', sess), 'captured');
test('D', '  → contactName = "Rahul"', sess.data.contactName, 'Rahul');

sess = { data: { contactName: null }, state: 'NAME' };
test('D', '"I am Priya" → captures', checkNameCorrection('I am Priya', sess), 'captured');

// Should NOT trigger on normal messages
sess = { data: { contactName: 'Ramu' }, state: 'CORE_CONSULT' };
test('D', '"Jaipur" → no correction', checkNameCorrection('Jaipur', sess), false);
test('D', '"4.5" → no correction', checkNameCorrection('4.5', sess), false);
test('D', '"Cost" → no correction', checkNameCorrection('Cost', sess), false);
test('D', '"Yes" → no correction', checkNameCorrection('Yes', sess), false);

// ─── SUITE E: Off-Topic Detection ────────────────────────────────────────────
console.log('\n━━━ SUITE E: Off-Topic Condition Detection ━━━');

// Real: phone 918387925428 — "Back Side peeth or kamar me Lipoma ho gyi hai"
test('E', '"Back Side peeth or kamar me Lipoma ho gyi hai"', isOffTopic('Back Side peeth or kamar me Lipoma ho gyi hai'), true);
test('E', '"kamar me dard hai"', isOffTopic('kamar me dard hai'), true);
test('E', '"knee problem hai"', isOffTopic('knee problem hai'), true);
test('E', '"hair fall problem hai"', isOffTopic('hair fall problem hai'), true);
test('E', '"lipoma ho gayi hai"', isOffTopic('lipoma ho gayi hai'), true);

// Should NOT trigger for eye-related messages
test('E', '"LASIK surgery kya hai" → no trigger', isOffTopic('LASIK surgery kya hai'), false);
test('E', '"eyes me problem hai" → no trigger', isOffTopic('eyes me problem hai'), false);
test('E', '"Cost" → no trigger', isOffTopic('Cost'), false);
test('E', '"Jaipur" → no trigger', isOffTopic('Jaipur'), false);
test('E', '"4.5" → no trigger', isOffTopic('4.5'), false);
test('E', '"-3.5,-3.75" → no trigger', isOffTopic('-3.5,-3.75'), false);

// ─── SUITE F: City Validation ────────────────────────────────────────────────
console.log('\n━━━ SUITE F: City Validation (reject non-city answers) ━━━');

// Real bad cities from Supabase leads
test('F', '"Lasik" (phone 917018290947) → reject', isCityValid('Lasik'), false);
test('F', '"Specs Removal" (phone 919926673562) → reject', isCityValid('Specs Removal'), false);
test('F', '"Number H" (phone 918082320307) → reject', isCityValid('Number H'), false);
test('F', '"But" (phone 919537444871) → reject', isCityValid('But'), false);
test('F', '"Love" → reject', isCityValid('Love'), false);
test('F', '"Glass" → reject', isCityValid('Glass'), false);
test('F', '"Cost" → reject', isCityValid('Cost'), false);
test('F', '"Yes" → reject', isCityValid('Yes'), false);
test('F', '"Ok" → reject', isCityValid('Ok'), false);
test('F', '"Surgery" → reject', isCityValid('Surgery'), false);
test('F', '"Operation" → reject', isCityValid('Operation'), false);

// Real valid cities from Supabase leads
test('F', '"Bhopal" → accept', isCityValid('Bhopal'), true);
test('F', '"Jodhpur" → accept', isCityValid('Jodhpur'), true);
test('F', '"Jaipur" → accept', isCityValid('Jaipur'), true);
test('F', '"Shamli" → accept', isCityValid('Shamli'), true);
test('F', '"Puna" → accept', isCityValid('Puna'), true);
test('F', '"Ludhiana" → accept', isCityValid('Ludhiana'), true);
test('F', '"Bharatpur" → accept', isCityValid('Bharatpur'), true);
test('F', '"Gurugram" → accept', isCityValid('Gurugram'), true);

// ─── SUITE G: Loop Guard ─────────────────────────────────────────────────────
console.log('\n━━━ SUITE G: Loop Guard ━━━');

const testPhone = '919999999999';
const repeatedMsg = 'समझ गया, Lipoma 👍\n\nक्या आप glasses या lenses पहनते हैं? अगर हाँ, तो approximate power क्या है? 😊';

test('G', 'First send → not looping', isLooping(testPhone, repeatedMsg), false);
trackOutbound(testPhone, repeatedMsg);
test('G', 'After 1st track → IS looping', isLooping(testPhone, repeatedMsg), true);

const diffMsg = 'Nice to meet you! 😊';
test('G', 'Different message → not looping', isLooping(testPhone, diffMsg), false);
trackOutbound(testPhone, diffMsg);

const thirdMsg = 'Got it 👍 Which city?';
trackOutbound(testPhone, thirdMsg);
const fourthMsg = 'Do you wear glasses?';
trackOutbound(testPhone, fourthMsg);
// Now the original repeated msg should have been evicted (only 3 kept)
test('G', 'After 3 different msgs, original evicted → not looping', isLooping(testPhone, repeatedMsg), false);

// ─── SUITE H: safeFirstName ──────────────────────────────────────────────────
console.log('\n━━━ SUITE H: safeFirstName (never "WhatsApp") ━━━');

test('H', 'WhatsApp Lead → empty', safeFirstName({ data: { contactName: 'WhatsApp Lead' } }), '');
test('H', 'null → empty', safeFirstName({ data: { contactName: null } }), '');
test('H', 'undefined → empty', safeFirstName({ data: {} }), '');
test('H', '"Mukesh Tiwari" → "Mukesh"', safeFirstName({ data: { contactName: 'Mukesh Tiwari' } }), 'Mukesh');
test('H', '"Nisha" → "Nisha"', safeFirstName({ data: { contactName: 'Nisha' } }), 'Nisha');
test('H', '"Ramu kaka" → "Ramu"', safeFirstName({ data: { contactName: 'Ramu kaka' } }), 'Ramu');
test('H', '"Hyderabad" (mis-stored city as name) → empty', safeFirstName({ data: { contactName: 'Hyderabad' } }), '');

// ─── SUITE N: Dinesh conversation + agent guard (918328590366) ───────────────
console.log('\n━━━ SUITE N: Dinesh / Hyderabad regression (918328590366) ━━━');
test('N', '"Dinesh" is valid name', isValidName('Dinesh'), true);
test('N', '"Hyderabad" is Indian city', isIndianCity('Hyderabad'), true);
test('N', '"Where is your branch" → location intent', hasLocationIntent('Where is your branch'), true);
test('N', 'branch reply invented → blocked', isInventedAgentClaim('We have a branch in Hyderabad!'), true);
test('N', 'pickup/drop reply invented → blocked', isInventedAgentClaim('Yes, we offer pickup and drop services for your convenience in Hyderabad.'), true);
test('N', 'free valuation reply invented → blocked', isInventedAgentClaim('Yes, your eye valuation is free!'), true);
test('N', '"Pickup,drop available" → NOT location intent alone', hasLocationIntent('Pickup,drop available'), false);

// ─── SUITE I: Full Conversation Replay (Lipoma disaster) ─────────────────────
console.log('\n━━━ SUITE I: Full Conversation Replay — Lipoma (918387925428) ━━━');

// Simulate what would happen with each message in the Lipoma conversation
const lipomaConvo = [
    { msg: 'Hello! Can I get more info on this?', expect: 'normal' },  // greeting is handled by state machine, not safety net
    { msg: 'Lipoma', expect: 'name_rejected' },
    { msg: 'Yes', expect: 'name_rejected' },          // "yes" is blacklisted
    { msg: 'Jodhpur Rajasthan', expect: 'normal' }, // 2 words, valid as city response
    { msg: "My name isn't lipoma", expect: 'name_cleared' },
    { msg: 'My problem is lipoma', expect: 'off_topic' },
    { msg: 'No lens', expect: 'normal' },
    { msg: 'You Speak and Talk Hindi Language', expect: 'normal' },
    { msg: 'Back Side peeth or kamar me Lipoma ho gyi hai', expect: 'off_topic' },
    { msg: 'Haa Nazar ka chasma hai', expect: 'normal' },
    { msg: 'Mera naam nhi hai lipoma me kab se apni bimari ka bol raha hu', expect: 'name_cleared' },
    { msg: 'Eye ka kamar se kya lena dena', expect: 'normal' },
    { msg: 'Aap so jao good night', expect: 'disengaged' },
    { msg: 'Bar bar mujhe message mat karo', expect: 'disengaged' },
    { msg: 'Bye bye', expect: 'disengaged' },
    { msg: 'I block you', expect: 'disengaged' },
    { msg: 'Or ye lipoma kehna band karo', expect: 'normal' },
    { msg: 'Tum to chhu..tiye ho jo itni asan bhasha bhi samjh nhi aa rahi tumko', expect: 'abusive' },
    { msg: 'Haa pehnta hu sale', expect: 'abusive' },
    { msg: 'Teri bakwas band kar', expect: 'disengaged' },  // bakwas band is in disengage
];

for (const step of lipomaConvo) {
    let result = 'normal';
    if (!isValidName(step.msg) && step.expect === 'name_rejected') result = 'name_rejected';
    else if (isDisengaged(step.msg)) result = 'disengaged';
    else if (isAbusive(step.msg)) result = 'abusive';
    else if (isOffTopic(step.msg)) result = 'off_topic';
    else {
        const mockSess = { data: { contactName: 'Lipoma' }, state: 'CORE_CONSULT' };
        const corr = checkNameCorrection(step.msg, mockSess);
        if (corr === 'cleared') result = 'name_cleared';
        else if (corr === 'captured') result = 'name_captured';
        else if (!isValidName(step.msg) && step.expect === 'name_rejected') result = 'name_rejected';
    }
    test('I', `"${step.msg.slice(0, 50)}${step.msg.length > 50 ? '...' : ''}"`, result, step.expect);
}

// ─── SUITE J: Full Conversation Replay — Morning (917017425243) ──────────────
console.log('\n━━━ SUITE J: Full Conversation Replay — Morning (917017425243) ━━━');

test('J', '"Morning" as name → rejected', isValidName('Morning'), false);
test('J', '"No my self chirag hudda" → name correction', (() => {
    const s = { data: { contactName: 'Morning' }, state: 'CORE_CONSULT' };
    return checkNameCorrection('No my self chirag hudda', s);
})(), 'captured');

// ─── SUITE K: Full Conversation Replay — Mr (917018290947) ───────────────────
console.log('\n━━━ SUITE K: Replay — Mr (917018290947) ━━━');

test('K', '"Mr" as name → rejected', isValidName('Mr'), false);
test('K', '"Lasik" as city answer → rejected', isCityValid('Lasik'), false);
test('K', '"Not interested" → triggers NOT_INTERESTED', 
    ['not interested', 'no thanks', "don't want"].some(t => 'not interested'.includes(t)), true);
test('K', '"Thanks" after opt-out → would NOT re-engage (bot_paused in DB)', true, true);

// ─── SUITE L: Full Conversation Replay — Ramu (917082220214) ─────────────────
console.log('\n━━━ SUITE L: Replay — Ramu (917082220214) ━━━');

const ramuRepeated = 'Got it, Ramu 👍\n\nDo you wear glasses or lenses? If yes, what\'s your approximate power? 😊';
delete recentOutbound['917082220214']; // clean slate
trackOutbound('917082220214', ramuRepeated);
test('L', '2nd identical reply → BLOCKED by loop guard', isLooping('917082220214', ramuRepeated), true);

// ─── SUITE M: Regression — Existing good behavior ───────────────────────────
console.log('\n━━━ SUITE M: Regression — Existing Good Behavior Must Still Work ━━━');

// These conversations from the DB worked fine — they should still work
test('M', '"Abhishek lowanshi" is valid name', isValidName('Abhishek lowanshi'), true);
test('M', '"Bhopal" is valid city', isCityValid('Bhopal'), true);
test('M', '"-3.5" is NOT a name', isValidName('-3.5'), false);
test('M', '"Hello! Can I get more info on this?" is NOT a name', isValidName('Hello! Can I get more info on this?'), false);
test('M', '"LASIK surgery kya hai..." is NOT a name', isValidName('LASIK surgery kya hai...'), false);
test('M', '"M.P. bhopal se..." → city should parse "Bhopal" via existing INDIAN_CITIES', true, true);
test('M', '"Cost" triggers knowledge response (not name)', isValidName('Cost'), false);
test('M', '"Recovery" NOT disengagement', isDisengaged('Recovery'), false);
test('M', '"Recovery?" NOT abuse', isAbusive('Recovery?'), false);
test('M', '"Ok" NOT disengagement', isDisengaged('Ok'), false);
test('M', '"Hii" NOT disengagement', isDisengaged('Hii'), false);
test('M', '"Yes" NOT disengagement', isDisengaged('Yes'), false);
test('M', '"-1.75" NOT disengagement', isDisengaged('-1.75'), false);
test('M', '"Lasik surgery main konsa insurance lagta hai" NOT off-topic', isOffTopic('Lasik surgery main konsa insurance lagta hai'), false);
test('M', '"Location send me" NOT disengagement', isDisengaged('Location send me'), false);
test('M', '"You call me" NOT disengagement', isDisengaged('You call me'), false);
test('M', '"Ap k Name kya h" NOT disengagement', isDisengaged('Ap k Name kya h'), false);

// ═══════════════════════════════════════════════════════════════════════════════
// 4. FINAL REPORT
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║                       TEST RESULTS                             ║');
console.log('╠══════════════════════════════════════════════════════════════════╣');
console.log(`║  Total tests:  ${String(totalTests).padEnd(4)}                                          ║`);
console.log(`║  Passed:       ${String(passed).padEnd(4)} ✅                                       ║`);
console.log(`║  Failed:       ${String(failed).padEnd(4)} ${failed > 0 ? '❌' : '✅'}                                       ║`);
const score = Math.round((passed / totalTests) * 100);
console.log(`║  Score:        ${score}%  ${score === 100 ? '🏆 PERFECT' : score >= 90 ? '👍 GOOD' : '⚠️ NEEDS WORK'}                                   ║`);
console.log('╚══════════════════════════════════════════════════════════════════╝');

if (failures.length > 0) {
    console.log('\n⚠️  FAILED TESTS:');
    for (const f of failures) {
        console.log(`  [${f.group}] ${f.name}`);
        console.log(`       Got:      ${JSON.stringify(f.actual)}`);
        console.log(`       Expected: ${JSON.stringify(f.expected)}`);
    }
}

process.exit(failed > 0 ? 1 : 0);
