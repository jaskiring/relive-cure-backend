/**
 * One-shot backfill: seeds lead_events from existing whatsapp_messages +
 * leads_surgery (pushed_to_crm=true rows).
 *
 * Run ONCE, locally, against prod Supabase:
 *   node server/scripts/backfill-lead-events.mjs
 *   node server/scripts/backfill-lead-events.mjs --dry-run   (counts only, no writes)
 *
 * Safe to re-run — all inserts use ON CONFLICT DO NOTHING (the UNIQUE
 * constraint on (phone, ts, event_type) deduplicates automatically).
 *
 * Requires env vars: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (reads from .env file in the project root via dotenv).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 500;   // rows per Supabase batch

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAll(table, select, extraFilter = null) {
  const rows = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (extraFilter) q = extraFilter(q);
    const { data, error } = await q;
    if (error) throw new Error(`[${table}] ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function insertBatch(rows) {
  if (DRY_RUN) return { count: rows.length };
  const { error } = await supabase
    .from('lead_events')
    .upsert(rows, { onConflict: 'phone,ts,event_type', ignoreDuplicates: true });
  if (error) throw new Error(`[lead_events insert] ${error.message}`);
  return { count: rows.length };
}

// ── Source 1: whatsapp_messages ───────────────────────────────────────────────

async function backfillMessages() {
  console.log('[1/2] Fetching whatsapp_messages …');
  const msgs = await fetchAll(
    'whatsapp_messages',
    'phone, direction, body, msg_type, wa_message_id, wa_timestamp'
  );
  console.log(`      ${msgs.length} messages found`);

  const events = msgs.map(m => ({
    phone:      m.phone,
    ts:         m.wa_timestamp,
    event_type: m.direction === 'inbound' ? 'whatsapp_in' : 'whatsapp_out',
    source:     m.direction === 'inbound' ? 'customer' : 'bot',
    payload: {
      body:          m.body,
      msg_type:      m.msg_type,
      wa_message_id: m.wa_message_id,
    },
  })).filter(e => e.ts);   // skip rows with null timestamp (shouldn't exist)

  const result = await insertBatch(events);
  console.log(`      ${DRY_RUN ? '[DRY RUN] would insert' : 'inserted'} ${result.count} message events`);
  return result.count;
}

// ── Source 2: leads_surgery pushed_to_crm=true ───────────────────────────────

async function backfillCrmPushes() {
  console.log('[2/2] Fetching leads_surgery (pushed_to_crm=true) …');
  const leads = await fetchAll(
    'leads_surgery',
    'phone_number, updated_at, intent_level, intent_score, parameters_completed',
    q => q.eq('pushed_to_crm', true)
  );
  console.log(`      ${leads.length} pushed leads found`);

  const events = leads.map(l => ({
    phone:      l.phone_number,
    ts:         l.updated_at,
    event_type: 'crm_pushed',
    source:     'system',
    payload: {
      intent_level:          l.intent_level,
      intent_score:          l.intent_score,
      parameters_completed:  l.parameters_completed,
    },
  })).filter(e => e.phone && e.ts);

  const result = await insertBatch(events);
  console.log(`      ${DRY_RUN ? '[DRY RUN] would insert' : 'inserted'} ${result.count} crm_pushed events`);
  return result.count;
}

// ── Verify ────────────────────────────────────────────────────────────────────

async function verifyCount() {
  const { count, error } = await supabase
    .from('lead_events')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`[verify] ${error.message}`);
  console.log(`\n✅ lead_events total rows: ${count}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  if (DRY_RUN) console.log('⚠️  DRY RUN — no rows will be written\n');

  try {
    const n1 = await backfillMessages();
    const n2 = await backfillCrmPushes();
    console.log(`\nTotal events processed: ${n1 + n2}`);
    if (!DRY_RUN) await verifyCount();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Backfill failed:', err.message);
    process.exit(1);
  }
})();
