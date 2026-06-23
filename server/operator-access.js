/** Who can review founder inbox (bug/feature queue) vs submit only. */

export function canReviewFounderInbox(session, tabs = []) {
    if (!session) return false;
    if (session.role === 'admin') return true;
    return (tabs || []).includes('settings');
}
