/** Build scoped Operator dev task markdown for Cursor IDE (inbox #{id}). */

export function buildOperatorDevTaskMarkdown(row, { workspace, devUser }) {
    const body = row.edited_prompt || row.transcript || row.message || '';
    return `# Operator dev task — inbox #${row.id}

**Kind:** ${row.kind}
**Reporter:** ${row.username}
**Approved by:** ${row.approved_by || devUser}
**Engine:** Cursor IDE (you implement — Composer / Agent in this workspace)

## Scope (strict)

- Fix **only** what is described below. No drive-by refactors.
- Minimal, focused diff; match existing Relive Cure style.
- Primary repos:
  - \`relive-cure-backend/server\` — Express API, Operator, WhatsApp bot
  - \`relive-cure-dashboard/src\` — React CRM
- Run relevant tests if you change backend (\`npm test\` in relive-cure-backend).
- **Do not** git commit or push unless the request explicitly asks.

## Request

${body}

## Done checklist

When finished in Cursor, mark **Dev done** in CRM Operator inbox (or tell the team what changed).

Files changed, how to verify in the CRM.
`;
}
