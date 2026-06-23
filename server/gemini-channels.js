/**
 * Gemini model registry + quota math — SINGLE SOURCE OF TRUTH for Relive Cure.
 *
 * Official limits change. Verify live: https://aistudio.google.com/rate-limit
 * Full doc: docs/GEMINI_QUOTA.md
 *
 * IMPORTANT:
 * - Google limits are per PROJECT, per MODEL, per metric (RPM / TPM / RPD).
 * - Our app caps (agent-quota.js) are separate counters per channel — they do NOT
 *   replace Google's limits; they prevent one channel starving another.
 * - AI Studio shows multiple rows per model (generateContent vs Map grounding vs
 *   Search grounding vs Live API). We mostly use generateContent (no grounding).
 */

export const QUOTA_DOC_VERSION = '2026-06-23';
export const QUOTA_VERIFY_URL = 'https://aistudio.google.com/rate-limit';
export const QUOTA_DOCS_PATH = 'docs/GEMINI_QUOTA.md';
/** Subtracted per model when computing default app cap from Google RPD sum. */
export const QUOTA_BUFFER_PER_MODEL = 100;

/**
 * @typedef {Object} GeminiModelSpec
 * @property {string} id
 * @property {string} label
 * @property {'gemini'|'gemma'} provider
 * @property {string} api - generateContent | live | grounding_search | grounding_maps
 * @property {number|null} generate_rpd - Requests/day for generateContent (verify in AI Studio)
 * @property {number|null} rpm - Requests/minute (typical free tier; verify)
 * @property {number|null} tpm_in - Input tokens/minute (typical; verify)
 * @property {string} [notes]
 */

/** Ordered LLM fallback: fast Gemini → Gemma → full Gemini → (caller: rule-based). No billing required. */
export const LLM_FALLBACK_ORDER = [
    'gemini-2.5-flash-lite',
    'gemma-4-26b-a4b-it',
    'gemini-2.5-flash',
];

/** @type {GeminiModelSpec[]} Customer WhatsApp bot — llm-agent.js */
export const WHATSAPP_MODELS = LLM_FALLBACK_ORDER.map((id) => {
    const specs = {
        'gemini-2.5-flash-lite': {
            label: 'Flash-Lite',
            provider: 'gemini',
            notes: 'Primary — fastest Gemini. Free tier ~1.5k RPD per model.',
        },
        'gemma-4-26b-a4b-it': {
            label: 'Gemma 4 26B',
            provider: 'gemma',
            notes: 'Fast fallback before full Flash — separate free-tier pool.',
        },
        'gemini-2.5-flash': {
            label: 'Flash',
            provider: 'gemini',
            notes: 'Full Gemini fallback before rule-based bot.',
        },
    };
    const s = specs[id] || { label: id, provider: 'gemini' };
    return {
        id,
        label: s.label,
        provider: s.provider,
        api: 'generateContent',
        generate_rpd: 1500,
        rpm: 15,
        tpm_in: 1_000_000,
        notes: s.notes,
    };
});

/** @type {GeminiModelSpec[]} CRM Operator text — same fallback order as WhatsApp */
export const OPERATOR_TEXT_MODELS = LLM_FALLBACK_ORDER.map((id) => {
    const wa = WHATSAPP_MODELS.find((m) => m.id === id);
    return {
        ...wa,
        notes: id.includes('gemma')
            ? 'Last LLM resort — plain text only (no tools).'
            : 'Operator — function calling when supported.',
    };
});

/** @type {GeminiModelSpec[]} Voice → text via generateContent + inline audio */
export const OPERATOR_TRANSCRIBE_MODELS = [
    {
        id: 'gemini-2.0-flash',
        label: 'Flash 2.0',
        provider: 'gemini',
        api: 'generateContent',
        generate_rpd: 1500,
        rpm: 15,
        tpm_in: 1_000_000,
        notes: 'Transcribe via inline_data audio. Not the Live API unlimited row.',
    },
    {
        id: 'gemini-2.0-flash-lite',
        label: 'Flash 2.0 Lite',
        provider: 'gemini',
        api: 'generateContent',
        generate_rpd: 1500,
        rpm: 15,
        tpm_in: 1_000_000,
    },
    {
        id: 'gemini-2.5-flash',
        label: 'Flash',
        provider: 'gemini',
        api: 'generateContent',
        generate_rpd: 1500,
        rpm: 15,
        tpm_in: 1_000_000,
        notes: 'Reserved for customers on WA chain — use only after WA primaries exhausted on Google side.',
    },
];

/**
 * Live / Native Audio models (AI Studio shows Unlimited RPD) — NOT wired yet.
 * Use when migrating Operator voice off generateContent.
 */
export const LIVE_AUDIO_MODELS = [
    {
        id: 'gemini-2.5-flash-native-audio-preview-12-2025',
        label: '2.5 Flash Native Audio',
        provider: 'gemini',
        api: 'live',
        generate_rpd: null,
        rpm: null,
        tpm_in: 1_000_000,
        notes: 'AI Studio 2026-06-23: Unlimited RPD, 1M TPM. Separate Live API endpoint.',
    },
    {
        id: 'gemini-3-flash-live',
        label: '3 Flash Live',
        provider: 'gemini',
        api: 'live',
        generate_rpd: null,
        rpm: null,
        tpm_in: 65_000,
        notes: 'AI Studio 2026-06-23: Unlimited RPD, 65K TPM.',
    },
];

/** Grounding quotas (we do NOT use these in bot/operator today). From pricing page + AI Studio. */
export const GROUNDING_QUOTAS_FREE = {
    search_shared_rpd: 1500,
    maps_rpd: 500,
    notes: 'Search 1.5K shared across Gemini 2/2.5/3 on free tier. Map 500 RPD per model row. Not our generateContent usage.',
};

export const CHANNEL_BUDGETS = {
    whatsapp: {
        key: 'whatsapp',
        label: 'Customer WhatsApp bot',
        env: 'GEMINI_DAILY_CAP',
        get defaultCap() { return appCapForModels(WHATSAPP_MODELS); },
        googleRpdMax: () => googleRpdSum(WHATSAPP_MODELS),
    },
    operator: {
        key: 'operator',
        label: 'CRM Operator (text)',
        env: 'GEMINI_OPERATOR_DAILY_CAP',
        get defaultCap() { return appCapForModels(OPERATOR_TEXT_MODELS); },
        googleRpdMax: () => googleRpdSum(OPERATOR_TEXT_MODELS),
    },
    operator_transcribe: {
        key: 'operator_transcribe',
        label: 'CRM Operator (voice)',
        env: 'GEMINI_TRANSCRIBE_DAILY_CAP',
        defaultCap: null,
        googleRpdMax: () => googleRpdSum(OPERATOR_TRANSCRIBE_MODELS),
        notes: 'App cap null = unlimited app-side. Google still enforces per-model RPD/TPM unless Live API.',
    },
};

export function modelIds(list) {
    return list.map((m) => m.id);
}

/** Shared fallback chain — fast → Gemma → full Gemini. */
export function llmFallbackChain(channel = 'whatsapp') {
    if (channel === 'operator') return modelIds(OPERATOR_TEXT_MODELS);
    return modelIds(WHATSAPP_MODELS);
}

/** Deduped model specs for usage dashboard. */
export function allTrackedModels() {
    const seen = new Set();
    const out = [];
    for (const m of [...WHATSAPP_MODELS, ...OPERATOR_TEXT_MODELS]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
    }
    return out;
}

export function modelSpecById(id) {
    return allTrackedModels().find((m) => m.id === id) || null;
}

export function googleRpdSum(models) {
    return models.reduce((s, m) => s + (m.generate_rpd || 0), 0);
}

/** Default app cap = sum(model RPD) − buffer per model (matches legacy 5600 for 4×1500 WA chain). */
export function appCapForModels(models, buffer = QUOTA_BUFFER_PER_MODEL) {
    return models.reduce((s, m) => s + Math.max(0, (m.generate_rpd || 0) - buffer), 0);
}

export function quotaRegistry() {
    return {
        version: QUOTA_DOC_VERSION,
        verify_url: QUOTA_VERIFY_URL,
        docs: QUOTA_DOCS_PATH,
        channels: {
            whatsapp: { models: WHATSAPP_MODELS, app_cap_default: appCapForModels(WHATSAPP_MODELS), google_rpd_max: googleRpdSum(WHATSAPP_MODELS) },
            operator: { models: OPERATOR_TEXT_MODELS, app_cap_default: appCapForModels(OPERATOR_TEXT_MODELS), google_rpd_max: googleRpdSum(OPERATOR_TEXT_MODELS) },
            operator_transcribe: { models: OPERATOR_TRANSCRIBE_MODELS, app_cap_default: null, google_rpd_max: googleRpdSum(OPERATOR_TRANSCRIBE_MODELS) },
        },
        live_audio_models: LIVE_AUDIO_MODELS,
        grounding: GROUNDING_QUOTAS_FREE,
    };
}
