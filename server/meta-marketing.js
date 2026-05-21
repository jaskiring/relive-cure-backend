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

// ─── Lead-form attribution (used by /webhook leadgen events) ─────────────────

// Normalize Indian phone to bare digits (last 10), or just digits if shorter.
function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 7) return null;
  if (d.startsWith('91') && d.length === 12) return d.slice(2);
  if (d.length > 10) return d.slice(-10);
  return d;
}

// Extract phone / name / email / city from a Meta Lead-Form field_data array.
// field_data is an array of { name, values: [string] } objects.
function extractFieldData(fieldData) {
  const out = { phone: null, name: null, email: null, city: null };
  if (!Array.isArray(fieldData)) return out;
  for (const f of fieldData) {
    const key = String(f.name || '').toLowerCase();
    const val = Array.isArray(f.values) && f.values.length ? String(f.values[0]) : '';
    if (!val) continue;
    if (!out.phone && /phone|mobile|whatsapp/.test(key)) out.phone = normalizePhone(val);
    else if (!out.email && /email/.test(key)) out.email = val;
    else if (!out.name && /name|full_name|first_name/.test(key)) out.name = val;
    else if (!out.city && /city|location/.test(key)) out.city = val;
  }
  return out;
}

// Try to match a Meta lead to an existing Refrens / chatbot lead by phone.
// Updates the meta_leads row with matched_lead_id + matched_source.
async function linkToExistingLead(metaLeadId, phone) {
  if (!phone) return null;
  // Try Refrens first (most common source)
  const { data: refrensHit } = await supabaseAdmin
    .from('refrens_leads')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  if (refrensHit) {
    await supabaseAdmin.from('meta_leads')
      .update({ matched_lead_id: refrensHit.id, matched_source: 'refrens', updated_at: new Date().toISOString() })
      .eq('meta_lead_id', metaLeadId);
    return { source: 'refrens', id: refrensHit.id };
  }
  // Then chatbot leads
  const { data: botHit } = await supabaseAdmin
    .from('leads_surgery')
    .select('id')
    .eq('phone_number', phone)
    .maybeSingle();
  if (botHit) {
    await supabaseAdmin.from('meta_leads')
      .update({ matched_lead_id: botHit.id, matched_source: 'chatbot', updated_at: new Date().toISOString() })
      .eq('meta_lead_id', metaLeadId);
    return { source: 'chatbot', id: botHit.id };
  }
  return null;
}

// Process a single leadgen webhook change. Meta sends us:
//   { value: { leadgen_id, page_id, form_id, ad_id, adgroup_id, created_time } }
// We then fetch the actual form data via Graph API and store it.
export async function processLeadgenChange(change) {
  const v = change?.value;
  if (!v?.leadgen_id) throw new Error('leadgen webhook change has no leadgen_id');
  const creds = await loadCredentials();
  if (!creds) throw new Error('META_ACCESS_TOKEN not set — cannot fetch lead form data');

  // Fetch the lead detail from Graph API
  const detail = await graphGet(v.leadgen_id, {
    fields: 'id,created_time,ad_id,ad_name,adgroup_id,campaign_id,form_id,field_data,platform'
  }, creds.token);

  const fields = extractFieldData(detail.field_data);

  const row = {
    meta_lead_id: detail.id || v.leadgen_id,
    page_id: v.page_id || null,
    form_id: detail.form_id || v.form_id || null,
    ad_id: detail.ad_id || v.ad_id || null,
    adgroup_id: detail.adgroup_id || v.adgroup_id || null,
    campaign_id: detail.campaign_id || null,
    created_time: detail.created_time || v.created_time || new Date().toISOString(),
    phone: fields.phone,
    name: fields.name,
    email: fields.email,
    city: fields.city,
    field_data: detail.field_data || null,
    raw_payload: { change, detail },
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseAdmin
    .from('meta_leads')
    .upsert(row, { onConflict: 'meta_lead_id' });
  if (error) throw new Error(`meta_leads upsert failed: ${error.message}`);

  // Try to link to existing Refrens/chatbot lead by phone
  const link = await linkToExistingLead(row.meta_lead_id, row.phone);

  console.log(`[META] 📥 Leadgen captured: ${row.name || 'no-name'} / ${row.phone || 'no-phone'} → campaign ${row.campaign_id || '?'}${link ? ` → linked to ${link.source}` : ''}`);
  return { metaLeadId: row.meta_lead_id, campaignId: row.campaign_id, linked: link };
}

// Back-fill: re-run linker for all unmatched meta_leads (e.g. after Refrens sync brings in new leads).
export async function backfillLeadLinks() {
  const { data: unmatched, error } = await supabaseAdmin
    .from('meta_leads')
    .select('meta_lead_id, phone')
    .is('matched_lead_id', null)
    .not('phone', 'is', null);
  if (error) throw new Error(error.message);
  let linked = 0;
  for (const r of (unmatched || [])) {
    const link = await linkToExistingLead(r.meta_lead_id, r.phone);
    if (link) linked++;
  }
  return { scanned: unmatched?.length || 0, linked };
}

// Return leads attributed to a specific campaign, joined with their Refrens / chatbot status.
export async function getCampaignLeads(campaignId) {
  const { data: metaLeads, error } = await supabaseAdmin
    .from('meta_leads')
    .select('meta_lead_id, name, phone, email, city, created_time, ad_id, adgroup_id, matched_lead_id, matched_source')
    .eq('campaign_id', campaignId)
    .order('created_time', { ascending: false });
  if (error) throw new Error(error.message);

  if (!metaLeads || metaLeads.length === 0) {
    return { leads: [], funnel: { total: 0, matched: 0, hot: 0, consulted: 0, won: 0, lost: 0, pending: 0 } };
  }

  // Bulk-fetch the matched Refrens leads
  const refrensIds = metaLeads.filter(l => l.matched_source === 'refrens' && l.matched_lead_id).map(l => l.matched_lead_id);
  const botIds = metaLeads.filter(l => l.matched_source === 'chatbot' && l.matched_lead_id).map(l => l.matched_lead_id);

  let refrensMap = {};
  if (refrensIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('refrens_leads')
      .select('id, status, intent_band, assignee, last_internal_note, date_closed')
      .in('id', refrensIds);
    for (const r of (data || [])) refrensMap[r.id] = r;
  }

  let botMap = {};
  if (botIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('leads_surgery')
      .select('id, status, parameters_completed, contact_name, last_user_message')
      .in('id', botIds);
    for (const r of (data || [])) botMap[r.id] = r;
  }

  const leads = metaLeads.map(l => {
    const refrens = l.matched_source === 'refrens' ? refrensMap[l.matched_lead_id] : null;
    const bot = l.matched_source === 'chatbot' ? botMap[l.matched_lead_id] : null;
    const status = refrens?.status || bot?.status || (l.matched_source ? 'matched' : 'pending');
    return {
      ...l,
      refrens,
      bot,
      status,
      isWon: /deal done|won|surgery done|surgery booked/i.test(status),
      isLost: /lost|dnp|not interested/i.test(status),
      isHot: refrens?.intent_band === 'HOT' || /hot/i.test(refrens?.intent_band || '')
    };
  });

  const funnel = {
    total: leads.length,
    matched: leads.filter(l => l.matched_lead_id).length,
    hot: leads.filter(l => l.isHot).length,
    consulted: leads.filter(l => /consult|consulted|interested/i.test(l.refrens?.status || '')).length,
    won: leads.filter(l => l.isWon).length,
    lost: leads.filter(l => l.isLost).length,
    pending: leads.filter(l => !l.matched_lead_id).length
  };

  return { leads, funnel };
}

// ─── Single-campaign drill-down (used by GET /api/meta/campaign/:id) ─────────
// Returns: metadata + 30-day aggregated KPIs + daily breakdown + week-over-week deltas.
export async function getCampaignDetail(campaignId) {
  // 1) Metadata
  const { data: campaign, error: cErr } = await supabaseAdmin
    .from('meta_campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!campaign) {
    const err = new Error(`Campaign ${campaignId} not found in sync — try clicking Sync now first`);
    err.status = 404;
    throw err;
  }

  // 2) Daily insights — last 30 days
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const { data: daily, error: dErr } = await supabaseAdmin
    .from('meta_ad_insights')
    .select('date, spend, impressions, clicks, leads, reach, cpm, cpc, ctr')
    .eq('campaign_id', campaignId)
    .gte('date', since30)
    .order('date', { ascending: true });
  if (dErr) throw new Error(dErr.message);

  // 3) Aggregate totals (30d) and a 7-day vs prior-7d comparison
  const today = new Date();
  const ymd = d => d.toISOString().slice(0, 10);
  const last7Start = ymd(new Date(today.getTime() - 7 * 86400 * 1000));
  const prev7Start = ymd(new Date(today.getTime() - 14 * 86400 * 1000));
  const prev7End   = ymd(new Date(today.getTime() - 8  * 86400 * 1000));

  function sumRange(rows, from, to) {
    let s = { spend: 0, impressions: 0, clicks: 0, leads: 0, reach: 0, days: 0 };
    for (const r of rows) {
      if ((!from || r.date >= from) && (!to || r.date <= to)) {
        s.spend += Number(r.spend || 0);
        s.impressions += Number(r.impressions || 0);
        s.clicks += Number(r.clicks || 0);
        s.leads += Number(r.leads || 0);
        s.reach += Number(r.reach || 0);
        s.days += 1;
      }
    }
    return s;
  }

  const totals30 = sumRange(daily, null, null);
  const totals7  = sumRange(daily, last7Start, null);
  const totalsPrev7 = sumRange(daily, prev7Start, prev7End);

  function deriveKpis(t) {
    return {
      ...t,
      cpl: t.leads > 0 ? Math.round((t.spend / t.leads) * 100) / 100 : null,
      cpm: t.impressions > 0 ? Math.round((t.spend / t.impressions) * 1000 * 100) / 100 : null,
      cpc: t.clicks > 0 ? Math.round((t.spend / t.clicks) * 100) / 100 : null,
      ctr: t.impressions > 0 ? Math.round((t.clicks / t.impressions) * 10000) / 100 : null, // %
      conversionRate: t.clicks > 0 ? Math.round((t.leads / t.clicks) * 10000) / 100 : null, // %
      frequency: t.reach > 0 ? Math.round((t.impressions / t.reach) * 100) / 100 : null
    };
  }

  function pctChange(a, b) {
    if (b === 0) return a > 0 ? null : 0; // null = "new" data
    return Math.round(((a - b) / b) * 1000) / 10; // 1 decimal place
  }

  const kpis30 = deriveKpis(totals30);
  const kpis7 = deriveKpis(totals7);
  const kpisPrev7 = deriveKpis(totalsPrev7);

  // Week-over-week deltas (last 7 vs prior 7)
  const wow = {
    spend: pctChange(kpis7.spend, kpisPrev7.spend),
    leads: pctChange(kpis7.leads, kpisPrev7.leads),
    cpl: kpis7.cpl != null && kpisPrev7.cpl != null ? pctChange(kpis7.cpl, kpisPrev7.cpl) : null,
    ctr: kpis7.ctr != null && kpisPrev7.ctr != null ? pctChange(kpis7.ctr, kpisPrev7.ctr) : null,
    impressions: pctChange(kpis7.impressions, kpisPrev7.impressions),
    clicks: pctChange(kpis7.clicks, kpisPrev7.clicks),
  };

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      objective: campaign.objective,
      status: campaign.status,
      daily_budget: campaign.daily_budget,
      lifetime_budget: campaign.lifetime_budget,
      start_time: campaign.start_time,
      stop_time: campaign.stop_time,
      account_id: campaign.account_id,
      last_synced_at: campaign.last_synced_at
    },
    kpis30,    // 30-day totals + derived metrics
    kpis7,     // last 7 days
    kpisPrev7, // 7 days before that (for comparison)
    wow,       // week-over-week % change
    daily      // raw daily rows for the trend chart
  };
}
