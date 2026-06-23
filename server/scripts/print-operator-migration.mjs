#!/usr/bin/env node
/**
 * One-time: create operator_inbox + quota columns in Supabase.
 * Usage: paste the SQL below into Supabase → SQL Editor → Run
 * Project: mvtiktflaqdkukswaker
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '../migrations/alter_agent_quota_channels.sql'), 'utf8');

console.log('='.repeat(72));
console.log('Paste this into Supabase SQL Editor and click Run:');
console.log('https://supabase.com/dashboard/project/mvtiktflaqdkukswaker/sql/new');
console.log('='.repeat(72));
console.log(sql);
console.log('='.repeat(72));
