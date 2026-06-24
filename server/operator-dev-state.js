/** In-memory dev worker heartbeat (POST /api/operator/worker/heartbeat). */

const _byEngine = {};
let _lastHeartbeat = null;
let _lastMeta = null;

const ONLINE_MS = 120_000;

export function recordWorkerHeartbeat(meta = {}) {
    const engine = String(meta.engine || 'cursor').toLowerCase();
    const at = Date.now();
    _byEngine[engine] = { at, meta };
    _lastHeartbeat = at;
    _lastMeta = meta;
}

export function workerLastSeen(engine) {
    if (engine) return _byEngine[engine]?.at ?? null;
    return _lastHeartbeat;
}

export function workerMeta(engine) {
    if (engine) return _byEngine[engine]?.meta ?? null;
    return _lastMeta;
}

function engineOnline(engine) {
    if (process.env.OPERATOR_WORKER_ONLINE === '1') return true;
    const at = _byEngine[engine]?.at;
    return !!(at && Date.now() - at < ONLINE_MS);
}

/** Any worker heartbeat within window. */
export function isOperatorWorkerOnline() {
    if (process.env.OPERATOR_WORKER_ONLINE === '1') return true;
    if (_lastHeartbeat && Date.now() - _lastHeartbeat < ONLINE_MS) return true;
    return Object.values(_byEngine).some((h) => h.at && Date.now() - h.at < ONLINE_MS);
}

export function workersOnlineStatus() {
    return {
        cursor: engineOnline('cursor'),
        opencode: engineOnline('opencode'),
        any: isOperatorWorkerOnline(),
    };
}

/** CRM username allowed to trigger local dev workers (founder machine). */
export function operatorDevUsername() {
    return String(
        process.env.OPERATOR_DEV_USER
        || process.env.VITE_ADMIN_USERNAME
        || 'admin',
    ).trim();
}
