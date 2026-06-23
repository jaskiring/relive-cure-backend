// Operator DB bootstrap — logs loudly if operator_inbox is missing.

export const OPERATOR_MIGRATION_SQL = `server/migrations/alter_agent_quota_channels.sql`;

export async function checkOperatorInboxTable(supabase) {
    const { error } = await supabase.from('operator_inbox').select('id').limit(1);
    if (!error) return { ok: true };
    return { ok: false, error: error.message || 'unknown' };
}

export async function warnIfOperatorInboxMissing(supabase) {
    const { ok, error } = await checkOperatorInboxTable(supabase);
    if (!ok) {
        console.error(
            '[OPERATOR] CRITICAL: operator_inbox table missing:',
            error,
            '— run',
            OPERATOR_MIGRATION_SQL,
            'in Supabase SQL editor (project mvtiktflaqdkukswaker).',
        );
    }
    return ok;
}
