// ─── Meta Ads (Marketing API) helpers ─────────────────────────────────────────
// Credentials live in Railway env vars (META_ACCESS_TOKEN + META_AD_ACCOUNT_ID).
// We never write the token to Supabase or to disk. Verification of the account
// (name, currency) is cached in memory for the lifetime of the process so we
// don't ping Graph on every status check.
//
// Tables used (see meta-marketing.sql):
//   meta_campaigns       — campaign metadata (synced from Graph)
//   meta_ad_insights     — daily spend/impressions/clicks/leads (composite PK)
//
// (The meta_credentials table is no longer used. It's safe to drop, but harmless to leave.)

import fetch from 'node-fetch';
import { supabaseAdmin } from './supabase-admin.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ─── In-memory state ──────────────────────────────────────────────────────────
// Reset on every process restart. last_sync_at is read from DB so it survives
// restarts; verification cache + last_sync_status are best-effort in-memory.
let verifiedAccountCache = null;       // { id, name, currency, businessName, ... }
let lastSyncStatusCache = null;        // 'ok' | 'error: <msg>'

// ─── Credentials from env vars ───────────────────────────────────────────────
export function normalizeAccountId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('act_')) return s;
  if (/^\d+$/.test(s)) return `act_${s}`;
  return s;
}

export async function loadCredentials() {
  const token = process.env.META_ACCESS_TOKEN;
  const rawAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !rawAccountId) return null;
  return {
    token: token.trim(),
    accountId: normalizeAccountId(rawAccountId)
  };
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

export async function fetchCampaigns(accountId, token) {
  const out = [];
  let after = null;
  for (let i = 0; i < 20; i++) {
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

export async function fetchInsights(accountId, token, { since, until } = {}) {
  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const u = until || ymd(today);
  const s = since || ymd(new Date(Date.now() - 30 * 86400 * 1000));

  const out = [];
  let after = null;
  for (let i = 0; i < 50; i++) {
    const params = {
      level: 'campaign',
      fields: 'campaign_id,spend,impressions,clicks,reach,cpm,cpc,ctr,actions,date_start,date_stop',
      time_range: JSON.stringify({ since: s, until: u }),
      time_increment: 1,
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

// ─── Status (used by GET /api/meta/status) ───────────────────────────────────
export async function getStatus() {
  const creds = await loadCredentials();
  if (!creds) {
    return {
      connected: false,
      reason: 'env_missing',
      message: 'Set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in Railway → Variables.'
    };
  }

  // Verify the account (cached for the process lifetime).
  if (!verifiedAccountCache || verifiedAccountCache._for !== creds.accountId) {
    try {
      const acc = await verifyAccount(creds.accountId, creds.token);
      verifiedAccountCache = { ...acc, _for: creds.accountId };
    } catch (e) {
      return {
        connected: false,
        reason: 'verify_failed',
        message: e.message,
        fbCode: e.fbCode
      };
    }
  }

  // last_sync_at = most recent last_synced_at across meta_campaigns. Survives restarts.
  let lastSyncAt = null;
  try {
    const { data } = await supabaseAdmin
      .from('meta_campaigns')
      .select('last_synced_at')
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    lastSyncAt = data?.last_synced_at || null;
  } catch { /* not fatal */ }

  return {
    connected: true,
    accountId: creds.accountId,
    accountName: verifiedAccountCache.name,
    businessId: verifiedAccountCache.businessId,
    businessName: verifiedAccountCache.businessName,
    currency: verifiedAccountCache.currency,
    lastSyncAt,
    lastSyncStatus: lastSyncStatusCache
  };
}

// ─── Sync (used by POST /api/meta/sync + scheduler) ───────────────────────────
function leadsFromActions(actions) {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) {
    if (a.action_type === 'leadgen.other' || a.action_type === 'lead') {
      n += Number(a.value || 0);
    }
  }
  return n;
}

export async function runSync({ since, until } = {}) {
  const creds = await loadCredentials();
  if (!creds) {
    const err = new Error('META_ACCESS_TOKEN or META_AD_ACCOUNT_ID not set in env');
    err.reason = 'env_missing';
    throw err;
  }
  const { accountId, token } = creds;

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

  const insights = await fetchInsights(accountId, token, { since, until });
  if (insights.length > 0) {
    const rows = insights.map(r => ({
      campaign_id: r.campaign_id,
      date: r.date_start,
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
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await supabaseAdmin
        .from('meta_ad_insights')
        .upsert(chunk, { onConflict: 'campaign_id,date' });
      if (error) throw new Error(`Insights upsert failed: ${error.message}`);
    }
  }

  lastSyncStatusCache = 'ok';
  return {
    syncedAt: new Date().toISOString(),
    campaignsCount: campaigns.length,
    insightsCount: insights.length
  };
}

export function recordSyncError(msg) {
  lastSyncStatusCache = `error: ${msg}`;
}

// ─── Campaign list with 30-day totals + CPL ──────────────────────────────────
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

// Bust the verification cache (called when env vars might have changed via Railway redeploy).
export function bustVerificationCache() {
  verifiedAccountCache = null;
}
