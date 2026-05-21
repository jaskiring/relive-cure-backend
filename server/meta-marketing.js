// ─── Meta Ads (Marketing API) helpers ─────────────────────────────────────────
// • AES-256-GCM encrypt/decrypt for the System User token at rest
// • Thin wrappers around graph.facebook.com/v21.0 endpoints we use
// • A single `runSync` that pulls campaigns + the last 30 days of insights
//   and upserts them into meta_campaigns / meta_ad_insights
//
// The raw token only lives in env (META_ENCRYPTION_KEY) + memory while we
// decrypt-for-use. It is never written to the browser, never logged.

import crypto from 'crypto';
import fetch from 'node-fetch';
import { supabaseAdmin } from './supabase-admin.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ─── Encryption ───────────────────────────────────────────────────────────────
// Key comes from META_ENCRYPTION_KEY (64 hex chars = 32 bytes).
// If the env var is missing we fall back to a key derived from CRM_API_KEY +
// SUPABASE_SERVICE_ROLE_KEY so first deploys still encrypt at rest. The user
// can later set META_ENCRYPTION_KEY explicitly and rotate.
function getKey() {
  const explicit = process.env.META_ENCRYPTION_KEY;
  if (explicit && /^[0-9a-fA-F]{64}$/.test(explicit)) {
    return Buffer.from(explicit, 'hex');
  }
  const seed = `${process.env.CRM_API_KEY || ''}:${process.env.SUPABASE_SERVICE_ROLE_KEY || ''}`;
  return crypto.createHash('sha256').update(seed).digest();
}

export function encryptToken(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptToken(blob) {
  const [ivHex, ctHex, tagHex] = String(blob || '').split(':');
  if (!ivHex || !ctHex || !tagHex) throw new Error('meta token blob malformed');
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const out = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  return out.toString('utf8');
}

// ─── Graph API thin wrappers ──────────────────────────────────────────────────
async function graphGet(path, params, token) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('access_token', token);
  const res = await fetch(url.toString());
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = json.error || {};
    const e = new Error(err.message || `Graph API ${res.status}`);
    e.fbCode = err.code;
    e.fbType = err.type;
    e.status = res.status;
    throw e;
  }
  return json;
}

// Normalize account ID to "act_NNN" form.
export function normalizeAccountId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('act_')) return s;
  if (/^\d+$/.test(s)) return `act_${s}`;
  return s;
}

// Quick sanity check + return account name (used during /api/meta/credentials).
export async function verifyAccount(accountId, token) {
  const data = await graphGet(accountId, {
    fields: 'id,name,account_status,currency,timezone_name,business{id,name}'
  }, token);
  return {
    id: data.id,
    name: data.name,
    status: data.account_status,           // 1 = active
    currency: data.currency,
    timezone: data.timezone_name,
    businessId: data.business?.id,
    businessName: data.business?.name
  };
}

// All campaigns for the account (paginates).
export async function fetchCampaigns(accountId, token) {
  const out = [];
  let after = null;
  for (let i = 0; i < 20; i++) { // safety cap (20 pages × 100 = 2000 campaigns)
    const params = {
      fields: 'id,name,objective,status,daily_budget,lifetime_budget,start_time,stop_time',
      limit: 100
    };
    if (after) params.after = after;
    const data = await graphGet(`${accountId}/campaigns`, params, token);
    for (const c of (data.data || [])) out.push(c);
    after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after) break;
  }
  return out;
}

// Daily insights for the account, grouped by campaign + day.
// time_range is { since: 'YYYY-MM-DD', until: 'YYYY-MM-DD' } (inclusive)
export async function fetchInsights(accountId, token, { since, until } = {}) {
  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const u = until || ymd(today);
  const s = since || ymd(new Date(Date.now() - 30 * 86400 * 1000));

  const out = [];
  let after = null;
  for (let i = 0; i < 50; i++) { // safety
    const params = {
      level: 'campaign',
      fields: 'campaign_id,spend,impressions,clicks,reach,cpm,cpc,ctr,actions,date_start,date_stop',
      time_range: JSON.stringify({ since: s, until: u }),
      time_increment: 1,           // one row per day
      limit: 500
    };
    if (after) params.after = after;
    const data = await graphGet(`${accountId}/insights`, params, token);
    for (const r of (data.data || [])) out.push(r);
    after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after) break;
  }
  return out;
}

// ─── Persistence ──────────────────────────────────────────────────────────────
export async function saveCredentials({ token, accountId }) {
  const normalizedId = normalizeAccountId(accountId);
  const account = await verifyAccount(normalizedId, token);   // throws if bad
  const encrypted = encryptToken(token);
  const { error } = await supabaseAdmin
    .from('meta_credentials')
    .upsert({
      id: 'default',
      token_encrypted: encrypted,
      ad_account_id: normalizedId,
      account_name: account.name,
      business_id: account.businessId || null,
    }, { onConflict: 'id' });
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  return { account };
}

export async function loadCredentials() {
  const { data, error } = await supabaseAdmin
    .from('meta_credentials')
    .select('id, ad_account_id, account_name, business_id, token_encrypted, last_sync_at, last_sync_status, updated_at')
    .eq('id', 'default')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    accountId: data.ad_account_id,
    accountName: data.account_name,
    businessId: data.business_id,
    lastSyncAt: data.last_sync_at,
    lastSyncStatus: data.last_sync_status,
    updatedAt: data.updated_at,
    token: decryptToken(data.token_encrypted)
  };
}

export async function getStatus() {
  const creds = await loadCredentials().catch(() => null);
  if (!creds) return { connected: false };
  return {
    connected: true,
    accountId: creds.accountId,
    accountName: creds.accountName,
    businessId: creds.businessId,
    lastSyncAt: creds.lastSyncAt,
    lastSyncStatus: creds.lastSyncStatus
  };
}

// Convert a Graph "actions" array to a lead count.
function leadsFromActions(actions) {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) {
    // on-platform leadgen forms
    if (a.action_type === 'leadgen.other' || a.action_type === 'lead') {
      n += Number(a.value || 0);
    }
  }
  return n;
}

// One-shot sync: pull campaigns + last-30d insights, upsert them.
export async function runSync({ since, until } = {}) {
  const creds = await loadCredentials();
  if (!creds) throw new Error('No credentials saved');
  const { accountId, token } = creds;

  // Campaigns
  const campaigns = await fetchCampaigns(accountId, token);
  if (campaigns.length > 0) {
    const rows = campaigns.map(c => ({
      id: c.id,
      account_id: accountId,
      name: c.name || '(unnamed)',
      objective: c.objective || null,
      status: c.status || null,
      daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      lifetime_budget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
      start_time: c.start_time || null,
      stop_time: c.stop_time || null,
      last_synced_at: new Date().toISOString()
    }));
    const { error } = await supabaseAdmin
      .from('meta_campaigns')
      .upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`Campaigns upsert failed: ${error.message}`);
  }

  // Insights
  const insights = await fetchInsights(accountId, token, { since, until });
  if (insights.length > 0) {
    const rows = insights.map(r => ({
      campaign_id: r.campaign_id,
      date: r.date_start,        // because time_increment=1, date_start === date_stop
      spend: Number(r.spend || 0),
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      leads: leadsFromActions(r.actions),
      reach: r.reach != null ? Number(r.reach) : null,
      cpm: r.cpm != null ? Number(r.cpm) : null,
      cpc: r.cpc != null ? Number(r.cpc) : null,
      ctr: r.ctr != null ? Number(r.ctr) : null,
      last_synced_at: new Date().toISOString()
    }));
    // Batch upsert in chunks of 500 to stay under request limits
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin
        .from('meta_ad_insights')
        .upsert(chunk, { onConflict: 'campaign_id,date' });
      if (error) throw new Error(`Insights upsert failed: ${error.message}`);
    }
  }

  const now = new Date().toISOString();
  await supabaseAdmin
    .from('meta_credentials')
    .update({ last_sync_at: now, last_sync_status: 'ok' })
    .eq('id', 'default');

  return {
    syncedAt: now,
    campaignsCount: campaigns.length,
    insightsCount: insights.length
  };
}

// Convenience for the dashboard: list campaigns + their last-30d totals.
export async function listCampaignsWithTotals() {
  const { data: campaigns, error: cErr } = await supabaseAdmin
    .from('meta_campaigns')
    .select('id, name, objective, status, daily_budget')
    .order('name', { ascending: true });
  if (cErr) throw new Error(cErr.message);

  const { data: insights, error: iErr } = await supabaseAdmin
    .from('meta_ad_insights')
    .select('campaign_id, spend, impressions, clicks, leads, date')
    .gte('date', new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10));
  if (iErr) throw new Error(iErr.message);

  const totals = {};
  for (const r of (insights || [])) {
    const t = totals[r.campaign_id] = totals[r.campaign_id] || { spend: 0, impressions: 0, clicks: 0, leads: 0 };
    t.spend += Number(r.spend || 0);
    t.impressions += Number(r.impressions || 0);
    t.clicks += Number(r.clicks || 0);
    t.leads += Number(r.leads || 0);
  }

  return (campaigns || []).map(c => {
    const t = totals[c.id] || { spend: 0, impressions: 0, clicks: 0, leads: 0 };
    return {
      ...c,
      ...t,
      cpl: t.leads > 0 ? Math.round((t.spend / t.leads) * 100) / 100 : null
    };
  });
}
