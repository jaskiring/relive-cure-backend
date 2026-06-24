#!/usr/bin/env node
/** Apply operator_inbox migration via Supabase Management SQL (postgres). */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../../relive-cure-agents/.env');

function loadEnv() {
    const out = {};
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}

const env = loadEnv();
const sql = readFileSync(resolve(__dirname, '../migrations/alter_agent_quota_channels.sql'), 'utf8');

// Supabase direct connection — set SUPABASE_DB_URL in relive-cure-agents/.env if needed:
// postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
const conn = env.SUPABASE_DB_URL || env.DATABASE_URL;
if (!conn) {
    console.error('Missing SUPABASE_DB_URL or DATABASE_URL in relive-cure-agents/.env');
    process.exit(2);
}

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
    await client.query(sql);
    const { rows } = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'operator_inbox') AS ok",
    );
    console.log(JSON.stringify({ migration: 'ok', operator_inbox_exists: rows[0]?.ok }));
} finally {
    await client.end();
}
