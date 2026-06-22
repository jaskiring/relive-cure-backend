// Shared bot safety helpers — used by index.js and test suites.

export const INDIAN_CITIES = [
    'delhi', 'mumbai', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'gurgaon', 'gurugram',
    'noida', 'chennai', 'kolkata', 'jaipur', 'ahmedabad', 'chandigarh', 'lucknow', 'surat',
    'bhopal', 'indore', 'nagpur', 'faridabad', 'meerut', 'rajkot', 'varanasi', 'amritsar',
    'allahabad', 'prayagraj', 'coimbatore', 'jodhpur', 'madurai', 'raipur', 'kota', 'mohali',
    'panchkula', 'dehradun', 'ghaziabad',
];

export function isIndianCity(str) {
    if (!str || typeof str !== 'string') return false;
    const low = str.trim().toLowerCase();
    const first = low.split(/[,\s]+/)[0];
    return INDIAN_CITIES.some(c => first === c || low === c || low.startsWith(c + ',') || low.startsWith(c + ' '));
}

export function titleCaseCity(str) {
    return str.trim().split(/[,\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Gemini replies that invent branches, transport, or unverified offers. */
export const AGENT_INVENTED_CLAIM_RE = /\b(we have|our branch|a branch|branch in|clinic in|centre in|center in|pickup|drop service|pick.?up|drop.?off|free eye valuation|valuation is free|eye evaluation is free)\b/i;

export function isInventedAgentClaim(reply) {
    return typeof reply === 'string' && AGENT_INVENTED_CLAIM_RE.test(reply);
}

export const LOCATION_INTENT_WORDS = [
    'where', 'location', 'address', 'kahan hai', 'nearest', 'clinic', 'hospital', 'centre', 'branch',
    'कहाँ', 'पता', 'शाखा',
];

export function hasLocationIntent(message) {
    const m = (message || '').toLowerCase();
    return LOCATION_INTENT_WORDS.some(w => m.includes(w));
}

export const LOCATION_REPLY = {
    EN: "Our sales specialist will call you shortly with all the details 😊",
    HI: 'हमारा sales specialist जल्द call करके सारी details share करेगा 😊',
};
