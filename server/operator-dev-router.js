/** Route dev tasks to OpenCode (mechanical) vs Cursor (complex). */

const COMPLEX_RE = /\b(refactor|architect|redesign|migrate|multiple files|security audit|auth overhaul|frozen|puppeteer|entire tab|app\.jsx)\b/i;

export function pickDevRoute(row, override) {
    const route = String(override || '').toLowerCase();
    if (route === 'cursor' || route === 'opencode') return route;

    const text = String(row.edited_prompt || row.transcript || row.message || '');
    if (row.kind === 'feature') return 'cursor';
    if (text.length > 900) return 'cursor';
    if (COMPLEX_RE.test(text)) return 'cursor';
    return 'opencode';
}

export function devRouteLabel(route) {
    return route === 'opencode' ? 'OpenCode (auto)' : 'Cursor (manual)';
}
