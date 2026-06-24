/**
 * Shared Google per-model daily exhaustion (429 GenerateRequestsPerDay).
 * WhatsApp and Operator keep separate app counters, but when Google says
 * a model is done for the day, both channels skip it in their fallback chain.
 *
 * IMPORTANT: RPM/transient 429s must NOT mark a model exhausted — that was
 * causing Flash models to go red at 2/1500 and leaving only slow Gemma.
 */

let _date = null;
const _exhausted = new Set();

/** Do not mark daily-exhausted unless at least this many successful calls today. */
export const EXHAUST_MARK_MIN_USES = 25;

function _today() { return new Date().toISOString().slice(0, 10); }

function _roll() {
    const d = _today();
    if (_date !== d) { _date = d; _exhausted.clear(); }
}

/**
 * @param {string} model
 * @param {{ usedToday?: number }} [opts]
 * @returns {boolean} whether marked
 */
export function markGoogleModelExhausted(model, opts = {}) {
    _roll();
    if (!model) return false;
    const used = opts.usedToday;
    if (Number.isFinite(used) && used < EXHAUST_MARK_MIN_USES) {
        console.warn(`[GEMINI-HEALTH] skip daily-exhausted for ${model} — only ${used} uses today (likely RPM 429, not daily cap)`);
        return false;
    }
    _exhausted.add(model);
    return true;
}

export function clearGoogleModelExhausted(model) {
    _roll();
    if (model) _exhausted.delete(model);
}

export function clearAllGoogleModelExhausted() {
    _roll();
    _exhausted.clear();
}

export function isGoogleModelExhausted(model) {
    _roll();
    return _exhausted.has(model);
}

export function googleExhaustedModels() {
    _roll();
    return [..._exhausted];
}

export function resetGoogleModelExhaustedForTest() {
    _date = _today();
    _exhausted.clear();
}
