/** Founder inbox (bug/feature queue) — admin role only. */

export function canReviewFounderInbox(session) {
    return !!session && session.role === 'admin';
}
