/** In-memory M4 worker heartbeat (POST /api/operator/worker/heartbeat). */

let _lastHeartbeat = null;
let _lastMeta = null;

export function recordWorkerHeartbeat(meta = {}) {
    _lastHeartbeat = Date.now();
    _lastMeta = meta;
}

export function workerLastSeen() {
    return _lastHeartbeat;
}

export function workerMeta() {
    return _lastMeta;
}

/** Online if Railway env says so, or heartbeat within 2 minutes. */
export function isOperatorWorkerOnline() {
    if (process.env.OPERATOR_WORKER_ONLINE === '1') return true;
    return !!(_lastHeartbeat && Date.now() - _lastHeartbeat < 120_000);
}
