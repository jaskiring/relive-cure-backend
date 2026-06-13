// Vocabulary constants shared across backend + dashboard.
// Single source of truth for label names, status values, and classification keywords.
// Both repos keep a mirrored copy; never diverge them.

export const REFRENS_LABELS = ['Followup', 'Dnp', 'High Intent', 'OPD Done', 'IPD Done'];

export const REFRENS_STATUS = ['New', 'Open', 'Lost', 'Deal Done', 'Not Serviceable'];

export const LS_STATUS = ['new', 'contacted', 'follow_up', 'ipd_done', 'lost', 'pushed_to_crm'];

// Regex that matches a single label token as "hot" — use with a full token, not a substring search.
export const HOT_KEYWORDS = /^(hot|high intent|urgent|very interested)$/i;

export const CALLBACK_SRC = ['knowledge_trigger', 'fallback', 'sales_intent', 'escalation', 'completion'];
