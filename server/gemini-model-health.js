/**
 * Shared Google per-model daily exhaustion (429 GenerateRequestsPerDay).
 * WhatsApp and Operator keep separate app counters, but when Google says
 * a model is done for the day, both channels skip it in their fallback chain.
 */

let _date = null;
const _exhausted = new Set();

function _today() { return new Date().toISOString().slice(0, 10); }

function _roll() {
    const d = _today();
    if (_date !== d) { _date = d; _exhausted.clear(); }
}

export function markGoogleModelExhausted(model) {
    _roll();
    if (model) _exhausted.add(model);
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
