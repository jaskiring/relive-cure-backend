#!/usr/bin/env node
/** Log Operator worker readiness — no secrets, no network. */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const p of [
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../../../relive-cure-agents/.env'),
]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const checks = [
  ['SUPABASE_URL', Boolean(process.env.SUPABASE_URL)],
  ['SUPABASE_SERVICE_ROLE_KEY', Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)],
  ['OPERATOR_DEV_WORKSPACE', Boolean(process.env.OPERATOR_DEV_WORKSPACE)],
  ['OPERATOR_DEV_USER', Boolean(process.env.OPERATOR_DEV_USER)],
  ['BACKEND_URL (heartbeat)', Boolean(process.env.BACKEND_URL)],
  ['OPERATOR_WORKER_SECRET', Boolean(process.env.OPERATOR_WORKER_SECRET)],
];

console.log('[activation-check] Operator workers (relive-cure-backend)');
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✅' : '⏳'} ${name}`);
}
console.log('');
console.log('  Founder: run 3 Supabase migrations (see docs/ACTIVATION.md §S2)');
console.log('  Then: npm run operator-opencode && npm run operator-cursor');
process.exit(0);
