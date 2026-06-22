// Signed dashboard session tokens — non-admin users never receive the raw CRM_API_KEY.
import crypto from 'crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signingSecret() {
    return process.env.CRM_API_KEY || 'fallback';
}

export function issueDashboardSession(username, role) {
    const body = Buffer.from(JSON.stringify({
        u: username,
        r: role || 'limited',
        e: Date.now() + SESSION_TTL_MS,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
}

export function parseDashboardSession(token) {
    if (!token) return null;
    // Never treat the raw CRM_API_KEY as a dashboard session — old tokens leaked full access.
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
    if (sig !== expected) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!payload?.u || !payload?.e || payload.e < Date.now()) return null;
        return { username: payload.u, role: payload.r || 'limited' };
    } catch {
        return null;
    }
}

export function requireDashboardAuth(req, res, { adminOnly = false } = {}) {
    const token = req.headers['x-crm-key'] || req.headers['x-api-key'];
    const session = parseDashboardSession(token);
    if (!session) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return false;
    }
    if (adminOnly && session.role !== 'admin') {
        res.status(403).json({ success: false, error: 'Admin only' });
        return false;
    }
    req.dashboardUser = session;
    return true;
}
