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

/** Compact prompt for OpenCode CLI (mechanical tasks only). */
export function buildOperatorOpencodePrompt(row, { workspace, devUser }) {
    const body = row.edited_prompt || row.transcript || row.message || '';
    return `Operator inbox #${row.id} — mechanical CRM fix (minimal diff only).

Reporter: ${row.username} · Kind: ${row.kind} · Approved by: ${row.approved_by || devUser}
Workspace root: ${workspace}

Rules:
- Fix ONLY what is described. No refactors, no unrelated files.
- Primary repos: relive-cure-backend/server, relive-cure-dashboard/src
- Match existing Relive Cure style.
- Do NOT git commit or push.

Request:
${body}

When done, list files changed and how to verify in the CRM.`;
}
