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
      // Only fetch campaigns Meta considers live — excludes DELETED/ARCHIVED
      effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES']),
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
    const syncedAt = new Date().toISOString();
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
      last_synced_at: syncedAt
    }));
    const { error } = await supabaseAdmin
      .from('meta_campaigns')
      .upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`Campaigns upsert failed: ${error.message}`);
    // Remove any campaigns that Meta no longer returns (deleted/archived in Meta)
    await supabaseAdmin
      .from('meta_campaigns')
      .delete()
      .lt('last_synced_at', syncedAt);
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

  // A campaign with status=ACTIVE can still be NOT delivering (its ad sets / ads
  // are paused, or it's out of budget) — Meta's Ads Manager "Delivery" column
  // reflects this, our raw `status` toggle does not. We approximate live delivery
  // by recent spend: any spend in the last 4 days ⇒ actively delivering.
  const recentCutoff = new Date(Date.now() - 4 * 86400 * 1000).toISOString().slice(0, 10);

  const totals = {};
  for (const r of (insights || [])) {
    const t = totals[r.campaign_id] = totals[r.campaign_id] || { spend: 0, impressions: 0, clicks: 0, leads: 0, recentSpend: 0 };
    t.spend += Number(r.spend || 0);
    t.impressions += Number(r.impressions || 0);
    t.clicks += Number(r.clicks || 0);
    t.leads += Number(r.leads || 0);
    if (r.date >= recentCutoff) t.recentSpend += Number(r.spend || 0);
  }

  return (campaigns || []).map(c => {
    const t = totals[c.id] || { spend: 0, impressions: 0, clicks: 0, leads: 0, recentSpend: 0 };
    const delivering = (c.status === 'ACTIVE') && t.recentSpend > 0;
    return {
      ...c,
      spend: t.spend,
      impressions: t.impressions,
      clicks: t.clicks,
      leads: t.leads,
      recentSpend: t.recentSpend,
      delivering,
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

// Extract structured fields from a Meta Lead-Form field_data array.
// field_data is an array of { name, values: [string] } objects.
// We pull canonical fields (phone/name/email/city) AND keep every other custom
// field in a normalized `custom` map keyed by the form's question label so
// later breakdowns can chart "eye power", "timeline", "age group" etc.
function extractFieldData(fieldData) {
  const out = { phone: null, name: null, email: null, city: null, custom: {} };
  if (!Array.isArray(fieldData)) return out;
  for (const f of fieldData) {
    const rawKey = String(f.name || '');
    const key = rawKey.toLowerCase();
    const val = Array.isArray(f.values) && f.values.length ? String(f.values[0]) : '';
    if (!val) continue;
    if (!out.phone && /phone|mobile|whatsapp/.test(key)) {
      out.phone = normalizePhone(val);
      continue;
    }
    if (!out.email && /email/.test(key)) {
      out.email = val;
      continue;
    }
    if (!out.name && /name|full_name|first_name/.test(key)) {
      out.name = val;
      continue;
    }
    if (!out.city && /city|location|town/.test(key)) {
      out.city = val;
      continue;
    }
    // Everything else → custom map. Use a stable normalized key so the same
    // question across slightly different forms (e.g. "Eye Power", "eye_power")
    // groups together.
    const normKey = rawKey
      .replace(/[\?\.]+$/g, '')
      .replace(/\s+/g, '_')
      .toLowerCase();
    if (normKey) out.custom[normKey] = val;
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

// ─── Retroactive (historical) lead import from Meta Lead Ads API ──────────────
// Pulls all lead-form submissions from Meta directly — without needing the Page
// webhook. Use this to backfill leads that came in before the webhook was wired,
// or when the webhook isn't set up at all.
//
// Flow:
//   1. Enumerate ads for the campaign (or all ads in the account) to collect
//      lead-form IDs — the creative.lead_gen_form_id field.
//   2. For each form, paginate `GET /{formId}/leads` and store in meta_leads.
//   3. Run linkToExistingLead() for every new lead so CRM matching happens immediately.
//
// Optional params:
//   campaignId — restrict to one campaign (undefined = account-wide)
//   since      — ISO date string; only leads created after this date
// Extract lead_gen_form_id from an ad creative. Verified empirically against
// the Mumbai 14/4/26 campaign: Meta nests the form id inside the CTA's value
// object, NOT as a direct field of link_data / video_data / creative. The
// "lead_gen_form_id" identifiers on those parent objects are invalid Graph
// API field names — requesting them returns a 100 error that invalidates the
// entire creative subfield, which is what caused the original 0-results bug.
function formIdFromCreative(creative) {
  if (!creative) return null;
  const link = creative.object_story_spec?.link_data;
  if (link?.call_to_action?.value?.lead_gen_form_id) return link.call_to_action.value.lead_gen_form_id;
  const video = creative.object_story_spec?.video_data;
  if (video?.call_to_action?.value?.lead_gen_form_id) return video.call_to_action.value.lead_gen_form_id;
  // Asset feed (dynamic / advantage+) creatives carry the form id in
  // asset_feed_spec.call_to_actions[i].value.lead_gen_form_id
  const asf = creative.asset_feed_spec;
  if (Array.isArray(asf?.call_to_actions)) {
    for (const cta of asf.call_to_actions) {
      if (cta?.value?.lead_gen_form_id) return cta.value.lead_gen_form_id;
    }
  }
  return null;
}

// Extract the page_id from a creative so we can fall back to the page-level
// /leadgen_forms endpoint when the per-ad form id isn't exposed.
function pageIdFromCreative(creative) {
  if (!creative) return null;
  return creative.object_story_spec?.page_id
      || creative.effective_object_story_id?.split('_')[0]
      || null;
}

export async function importHistoricalLeads({ campaignId, since } = {}) {
  const creds = await loadCredentials();
  if (!creds) throw new Error('META_ACCESS_TOKEN not set');
  const { accountId, token } = creds;

  // Step 1 — walk the campaign's ads and collect (a) form_ids and (b) page_ids
  // for the fallback path.
  const adsPath = campaignId ? `${campaignId}/ads` : `${accountId}/ads`;
  const formMap = {};   // formId → campaignId (string)
  const pageIds = new Set();
  let after = null;
  let adsScanned = 0;
  let lastError = null;
  for (let page = 0; page < 30; page++) {
    const params = {
      // Request the creative as opaque object_story_spec / asset_feed_spec
      // sub-objects — Graph returns their full JSON including the nested
      // call_to_action.value.lead_gen_form_id. Aggressive subfield drilling
      // (value{lead_gen_form_id}) silently errors on Graph and nulls the
      // creative — keep it simple.
      fields: 'id,campaign_id,creative{id,effective_object_story_id,object_story_spec,asset_feed_spec}',
      // Include PAUSED / ARCHIVED ads so we still find form ids for past leads.
      effective_status: JSON.stringify(['ACTIVE','PAUSED','ARCHIVED','IN_PROCESS','WITH_ISSUES','PREAPPROVED','PENDING_REVIEW']),
      limit: 200
    };
    if (after) params.after = after;
    let data;
    try { data = await graphGet(adsPath, params, token); }
    catch (e) {
      lastError = e.message;
      console.warn(`[META] importHistoricalLeads ads page ${page}: ${e.message}`);
      break;
    }
    for (const ad of (data.data || [])) {
      adsScanned++;
      const fid = formIdFromCreative(ad.creative);
      if (fid) formMap[fid] = ad.campaign_id;
      const pid = pageIdFromCreative(ad.creative);
      if (pid) pageIds.add(pid);
    }
    after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after) break;
  }

  let formIds = Object.keys(formMap);
  let pageFallbackUsed = false;

  // Step 1b — FALLBACK: if no form ids were exposed by the creative fields,
  // walk each page's leadgen_forms endpoint and use those. We still filter
  // the resulting leads by campaign_id, so cross-campaign noise is harmless.
  if (formIds.length === 0 && pageIds.size > 0) {
    pageFallbackUsed = true;
    for (const pid of pageIds) {
      let pageAfter = null;
      for (let p = 0; p < 20; p++) {
        const params = { fields: 'id,name,status', limit: 100 };
        if (pageAfter) params.after = pageAfter;
        let fd;
        try { fd = await graphGet(`${pid}/leadgen_forms`, params, token); }
        catch (e) { console.warn(`[META] page ${pid} leadgen_forms: ${e.message}`); break; }
        for (const f of (fd.data || [])) {
          if (!formMap[f.id]) formMap[f.id] = campaignId || null;
        }
        pageAfter = fd.paging?.cursors?.after;
        if (!fd.paging?.next || !pageAfter) break;
      }
    }
    formIds = Object.keys(formMap);
  }

  if (formIds.length === 0) {
    return {
      imported: 0, linked: 0, forms: 0,
      adsScanned,
      pageIdsFound: pageIds.size,
      lastError,
      message: lastError
        ? `Graph API error while scanning ads: ${lastError}`
        : pageIds.size === 0
          ? `No ads with creatives found in this campaign (scanned ${adsScanned}). The campaign may be paused, not yet launched, or use a creative type we don't recognize.`
          : `Found ${pageIds.size} page(s) but no Lead Forms attached. This campaign may not use Lead Ads (e.g. it drives traffic to a website or WhatsApp instead).`
    };
  }

  // Step 2 — pull leads from each form
  let totalImported = 0;
  let totalLinked = 0;
  const formErrors = {};

  for (const formId of formIds) {
    const cid = formMap[formId];
    let formAfter = null;
    for (let page = 0; page < 200; page++) {
      const params = {
        fields: 'id,created_time,ad_id,adgroup_id,campaign_id,field_data,platform',
        limit: 100
      };
      // Optional time filter (server-side filtering via the Graph API)
      if (since) {
        const sinceTs = Math.floor(new Date(since).getTime() / 1000);
        params.filtering = JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceTs }]);
      }
      if (formAfter) params.after = formAfter;

      let data;
      try { data = await graphGet(`${formId}/leads`, params, token); }
      catch (e) {
        formErrors[formId] = e.message;
        console.warn(`[META] importHistoricalLeads form ${formId} page ${page}: ${e.message}`);
        break;
      }

      const allLeads = data.data || [];
      if (allLeads.length === 0) break;

      // When we used the page fallback, the form may belong to a different
      // campaign than the one being imported — filter by campaign_id so we
      // don't pollute other campaigns' attribution.
      const leads = (pageFallbackUsed && campaignId)
        ? allLeads.filter(l => l.campaign_id === campaignId)
        : allLeads;
      if (leads.length === 0) {
        // page returned leads but none for this campaign — keep paginating
        formAfter = data.paging?.cursors?.after;
        if (!data.paging?.next || !formAfter) break;
        continue;
      }

      // Upsert in chunks of 50
      const rows = leads.map(lead => {
        const fields = extractFieldData(lead.field_data);
        return {
          meta_lead_id: lead.id,
          form_id: formId,
          ad_id: lead.ad_id || null,
          adgroup_id: lead.adgroup_id || null,
          campaign_id: lead.campaign_id || cid || null,
          created_time: lead.created_time || null,
          phone: fields.phone,
          name: fields.name,
          email: fields.email,
          city: fields.city,
          field_data: lead.field_data || null,
          raw_payload: { source: 'historical_import', platform: lead.platform || null },
          updated_at: new Date().toISOString()
        };
      });

      for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50);
        const { error } = await supabaseAdmin
          .from('meta_leads')
          .upsert(chunk, { onConflict: 'meta_lead_id' });
        if (error) {
          console.error(`[META] importHistoricalLeads upsert error: ${error.message}`);
          continue;
        }
        totalImported += chunk.length;
        // Run phone linker for each imported lead
        for (const row of chunk) {
          if (row.phone) {
            const link = await linkToExistingLead(row.meta_lead_id, row.phone);
            if (link) totalLinked++;
          }
        }
      }

      formAfter = data.paging?.cursors?.after;
      if (!data.paging?.next || !formAfter) break;
    }
  }

  const formErrorList = Object.entries(formErrors);
  // Stash extra custom fields per lead (everything not phone/name/email/city)
  // so later breakdowns can use eye power, timeline, insurance, etc.
  // (no-op here — extractFieldData already stores full field_data on the row)

  console.log(`[META] ✅ Historical import done: ${totalImported} leads from ${formIds.length} forms${pageFallbackUsed ? ' (page fallback)' : ''}, ${totalLinked} matched in CRM`);
  if (formErrorList.length > 0) {
    console.warn(`[META] Form errors: ${JSON.stringify(formErrors)}`);
  }

  // If we found forms but couldn't read any leads, the System User token is
  // missing page-level scopes (verified empirically: leads_retrieval alone is
  // not enough; Meta also requires pages_manage_ads + pages_show_list +
  // pages_read_engagement on the token). Surface this as actionable remediation.
  let permissionsHint = null;
  if (formIds.length > 0 && totalImported === 0 && formErrorList.length > 0) {
    const anyPermErr = formErrorList.some(([, msg]) =>
      /does not exist|missing permission|unsupported get|pages_manage_ads|pages_read_engagement|pages_show_list/i.test(msg || '')
    );
    if (anyPermErr) {
      permissionsHint = 'PAGE_SCOPES_REQUIRED';
    }
  }

  return {
    imported: totalImported,
    linked: totalLinked,
    forms: formIds.length,
    adsScanned,
    pageFallbackUsed,
    ...(formErrorList.length > 0 ? { formErrors } : {}),
    ...(permissionsHint ? { permissionsHint } : {})
  };
}

// ─── Per-ad + audience breakdowns (live Graph API, lazy-loaded) ──────────────
// These are NOT cached in Supabase — pulled on-demand when the user drills
// into a campaign. Tradeoff: slower drill-down (one extra Graph call) but
// always fresh data and no schema migrations.

// In-memory cache to avoid hammering Graph if the user reopens the same
// campaign repeatedly. 5-minute TTL.
const adBreakdownCache = new Map();   // campaignId → { fetchedAt, data }
const audBreakdownCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function readCache(map, key) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.data;
  return null;
}

function writeCache(map, key, data) {
  map.set(key, { fetchedAt: Date.now(), data });
}

// Per-ad performance inside a campaign. Pulled level=ad with the campaign
// filtered server-side via the filtering param.
export async function getCampaignAds(campaignId) {
  const cached = readCache(adBreakdownCache, campaignId);
  if (cached) return cached;

  const creds = await loadCredentials();
  if (!creds) throw new Error('META_ACCESS_TOKEN not set');

  // 1) Fetch ad metadata (names + creative thumbnails)
  const meta = await graphGet(`${campaignId}/ads`, {
    fields: 'id,name,status,creative{thumbnail_url,image_url}',
    limit: 100
  }, creds.token);

  // 2) Fetch ad-level insights (last 30 days, all ads in this campaign)
  const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const insights = await graphGet(`${campaignId}/insights`, {
    level: 'ad',
    fields: 'ad_id,ad_name,spend,impressions,clicks,reach,cpm,cpc,ctr,actions',
    time_range: JSON.stringify({ since, until }),
    limit: 500
  }, creds.token);

  // 3) Merge metadata with insights
  const insightsByAdId = {};
  for (const r of (insights.data || [])) {
    insightsByAdId[r.ad_id] = r;
  }

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

  const ads = (meta.data || []).map(ad => {
    const i = insightsByAdId[ad.id] || {};
    const spend = Number(i.spend || 0);
    const leads = leadsFromActions(i.actions);
    return {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      thumbnail: ad.creative?.thumbnail_url || ad.creative?.image_url || null,
      spend,
      impressions: Number(i.impressions || 0),
      clicks: Number(i.clicks || 0),
      reach: Number(i.reach || 0),
      leads,
      cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
      cpm: i.cpm != null ? Number(i.cpm) : null,
      cpc: i.cpc != null ? Number(i.cpc) : null,
      ctr: i.ctr != null ? Number(i.ctr) : null
    };
  }).sort((a, b) => b.spend - a.spend);  // biggest spenders first

  const result = { ads, count: ads.length };
  writeCache(adBreakdownCache, campaignId, result);
  return result;
}

// Audience breakdowns for a campaign: age × gender, region, placement
export async function getCampaignAudience(campaignId) {
  const cached = readCache(audBreakdownCache, campaignId);
  if (cached) return cached;

  const creds = await loadCredentials();
  if (!creds) throw new Error('META_ACCESS_TOKEN not set');

  const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);

  async function fetchBreakdown(breakdowns) {
    return graphGet(`${campaignId}/insights`, {
      level: 'campaign',
      fields: 'spend,impressions,clicks,reach,actions',
      time_range: JSON.stringify({ since, until }),
      breakdowns,
      limit: 500
    }, creds.token);
  }

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

  function mapRows(rows, keyFields) {
    return (rows || []).map(r => {
      const spend = Number(r.spend || 0);
      const leads = leadsFromActions(r.actions);
      const key = {};
      for (const k of keyFields) key[k] = r[k];
      return {
        ...key,
        spend,
        impressions: Number(r.impressions || 0),
        clicks: Number(r.clicks || 0),
        reach: Number(r.reach || 0),
        leads,
        cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
        ctr: r.impressions > 0 ? Math.round((r.clicks / r.impressions) * 10000) / 100 : null
      };
    });
  }

  // Run all three in parallel — Graph API handles them concurrently fine
  const [ageGender, region, placement] = await Promise.allSettled([
    fetchBreakdown('age,gender'),
    fetchBreakdown('region'),
    fetchBreakdown('publisher_platform,platform_position')
  ]);

  const result = {
    ageGender: ageGender.status === 'fulfilled' ? mapRows(ageGender.value.data, ['age', 'gender']).sort((a, b) => b.spend - a.spend) : [],
    region: region.status === 'fulfilled' ? mapRows(region.value.data, ['region']).sort((a, b) => b.spend - a.spend) : [],
    placement: placement.status === 'fulfilled' ? mapRows(placement.value.data, ['publisher_platform', 'platform_position']).sort((a, b) => b.spend - a.spend) : [],
    errors: {
      ageGender: ageGender.status === 'rejected' ? ageGender.reason.message : null,
      region: region.status === 'rejected' ? region.reason.message : null,
      placement: placement.status === 'rejected' ? placement.reason.message : null
    }
  };
  writeCache(audBreakdownCache, campaignId, result);
  return result;
}

// Return leads attributed to a specific campaign, joined with their Refrens / chatbot status.
// Account-wide benchmark — surgery rate, CPL, match rate, HOT % across the last 30
// days. Used by getCampaignLeads() to show "vs account avg" deltas in the metrics
// banner. Cached in-process for 5 min.
let accountBenchmarkCache = null;
const BENCHMARK_TTL_MS = 5 * 60 * 1000;
async function getAccountBenchmark() {
  if (accountBenchmarkCache && Date.now() - accountBenchmarkCache.fetchedAt < BENCHMARK_TTL_MS) {
    return accountBenchmarkCache.data;
  }
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

  // 1) Account-wide insights — total spend + total on-platform leads (last 30d)
  const { data: insights } = await supabaseAdmin
    .from('meta_ad_insights')
    .select('spend, leads')
    .gte('date', since30);
  let spend = 0, leads = 0;
  for (const r of (insights || [])) { spend += Number(r.spend || 0); leads += Number(r.leads || 0); }

  // 2) Account-wide meta_leads — match rate, HOT %, surgery rate
  const { data: ml } = await supabaseAdmin
    .from('meta_leads')
    .select('matched_lead_id, matched_source')
    .gte('created_time', since30);
  const total = ml?.length || 0;
  const matched = (ml || []).filter(l => l.matched_lead_id).length;

  // 3) For HOT % and surgery rate, fetch the matched refrens leads in bulk
  const refrensIds = (ml || []).filter(l => l.matched_source === 'refrens' && l.matched_lead_id).map(l => l.matched_lead_id);
  let hot = 0, surgeries = 0;
  if (refrensIds.length > 0) {
    const { data: rls } = await supabaseAdmin
      .from('refrens_leads')
      .select('id, intent_band, status, labels, call_outcome, follow_up_date')
      .in('id', refrensIds);
    for (const r of (rls || [])) {
      const _band = (r.intent_band || '').toLowerCase();
      const _labels = (r.labels || '').toLowerCase();
      const _co = (r.call_outcome || '').toLowerCase();
      const _st = (r.status || '').toLowerCase();
      if (/hot/.test(_band) || /hot|high intent|very interested/.test(_labels) || /hot|very interested/.test(_co) || /deal done|won|surgery/.test(_st)) hot++;
      if (/deal done|won|surgery done|surgery booked/i.test(r.status || '')) surgeries++;
    }
  }

  const data = {
    spend,
    leads,                                          // on-platform leads (Meta)
    metaLeadsTotal: total,                          // form-form attributed leads
    matchRate:   total > 0 ? matched / total : null,
    hotPct:      matched > 0 ? hot / matched : null,
    surgeryRate: matched > 0 ? surgeries / matched : null,
    cpl:         leads > 0 ? spend / leads : null,
    costPerSurgery: surgeries > 0 ? spend / surgeries : null,
    asOf: new Date().toISOString()
  };
  accountBenchmarkCache = { fetchedAt: Date.now(), data };
  return data;
}

// Pulls the leads attributed to a single campaign + a stack of breakdowns:
//   funnel        — flat counts (total/matched/hot/consulted/won/lost/pending)
//   breakdowns    — { byIntent, byStage, byAd, byCity, byPlatform, intentByStage, timeline }
//   accountBenchmark — for "vs account avg" deltas in the metrics banner
//
// All breakdowns are computed in-process from the same lead rows — no extra DB
// hits except the cached benchmark + a cached getCampaignAds() call for ad names.
export async function getCampaignLeads(campaignId) {
  const { data: metaLeads, error } = await supabaseAdmin
    .from('meta_leads')
    .select('meta_lead_id, name, phone, email, city, created_time, ad_id, adgroup_id, matched_lead_id, matched_source, raw_payload')
    .eq('campaign_id', campaignId)
    .order('created_time', { ascending: false });
  if (error) throw new Error(error.message);

  if (!metaLeads || metaLeads.length === 0) {
    const accountBenchmark = await getAccountBenchmark();
    const funnel = { total: 0, matched: 0, hot: 0, consulted: 0, booked: 0, won: 0, lost: 0, pending: 0 };
    const { recommendations, analytics } = await buildCampaignLeadExtras(campaignId, {
      breakdowns: null,
      funnel,
      accountBenchmark,
    });
    return {
      leads: [],
      funnel,
      breakdowns: null,
      accountBenchmark,
      recommendations,
      analytics,
    };
  }

  // Bulk-fetch matched refrens + chatbot rows
  const refrensIds = metaLeads.filter(l => l.matched_source === 'refrens' && l.matched_lead_id).map(l => l.matched_lead_id);
  const botIds     = metaLeads.filter(l => l.matched_source === 'chatbot' && l.matched_lead_id).map(l => l.matched_lead_id);

  let refrensMap = {};
  if (refrensIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('refrens_leads')
      .select('id, status, intent_band, intent_score, assignee, last_internal_note, date_closed, lead_source, customer_city, labels, follow_up_date, call_outcome')
      .in('id', refrensIds);
    for (const r of (data || [])) refrensMap[r.id] = r;
  }

  let botMap = {};
  if (botIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('leads_surgery')
      .select('id, status, parameters_completed, intent_level, intent_score, contact_name, last_user_message, insurance, eye_power, eye_power_numeric, timeline, urgency_level, interest_cost, interest_recovery, concern_pain, concern_safety, concern_power, request_call, city')
      .in('id', botIds);
    for (const r of (data || [])) botMap[r.id] = r;
  }

  // Resolve ad names via the cached Graph API call. Best-effort — if it fails
  // (e.g. Meta API blip), the By-ad chart falls back to raw ad_ids.
  let adNameById = {};
  try {
    const { ads } = await getCampaignAds(campaignId);
    for (const a of (ads || [])) adNameById[a.id] = a.name;
  } catch { /* non-fatal */ }

  // Derive intent + stage per lead, then collect aggregations in one pass.
  // Priority: explicit intent_band → Refrens labels → call_outcome → CRM status inference → chatbot → WARM default for matched leads
  function intentOf(lead, refrens, bot) {
    // 1. Explicit intent_band (rarely set)
    const band = (refrens?.intent_band || '').trim();
    if (/hot/i.test(band)) return 'HOT';
    if (/warm/i.test(band)) return 'WARM';
    if (/cold/i.test(band)) return 'COLD';

    // 2. Refrens labels — reps tag leads as "High Intent", "Warm", etc.
    const labels = (refrens?.labels || '').toLowerCase();
    if (/hot|high intent|very interested|urgent/i.test(labels)) return 'HOT';
    if (/warm|interested|follow.?up/i.test(labels)) return 'WARM';
    if (/cold|dnp|junk|spam|not interested|wrong/i.test(labels)) return 'COLD';

    // 3. Call outcome
    const callOutcome = (refrens?.call_outcome || '').toLowerCase();
    if (/hot|very interested|callback|convert/i.test(callOutcome)) return 'HOT';
    if (/warm|interested|considering|follow|maybe/i.test(callOutcome)) return 'WARM';
    if (/not interested|wrong|junk|irrelevant|dnp/i.test(callOutcome)) return 'COLD';

    // 3b. Chatbot request_call flag — explicit callback = HOT
    if (bot?.request_call) return 'HOT';

    // 4. CRM status inference
    const status = (refrens?.status || '').toLowerCase();
    if (/deal done|won|surgery done|surgery booked/i.test(status)) return 'HOT';
    if (/consult|booked|in[- ]progress/i.test(status)) return 'WARM';
    if (/lost|dnp|not interested|not serviceable|junk/i.test(status)) return 'COLD';
    if (refrens?.follow_up_date) return 'WARM'; // rep set a follow-up date → they're engaged

    // 5. Chatbot's derived intent (for chatbot-matched leads)
    const lvl = (bot?.intent_level || '').toUpperCase();
    if (lvl === 'HOT' || lvl === 'WARM' || lvl === 'COLD') return lvl;

    // 6. Matched to CRM but no signal = at least WARM (they filled a Meta Lead Ad form — an active inquiry)
    if (lead.matched_lead_id) return 'WARM';

    return 'Unknown'; // unmatched: no data at all
  }
  function stageOf(lead, refrens, bot) {
    const status = String(refrens?.status ?? bot?.status ?? '').toLowerCase();
    if (/deal done|won|surgery done|surgery booked/i.test(status)) return 'done';
    if (/booked|appointment|consultation booked/i.test(status))    return 'booked';
    if (/consult|consulted|interested/i.test(status))              return 'consulted';
    if (/contacted|in[- ]progress/i.test(status))                  return 'contacted';
    if (/lost|dnp|not interested|not serviceable/i.test(status))   return 'lost';
    if (lead.matched_lead_id)                                       return 'matched';
    return 'captured';
  }
  function platformOf(lead) {
    const rp = lead.raw_payload || {};
    return rp.platform || rp.detail?.platform || 'unknown';
  }
  function cityOf(lead, refrens) {
    return refrens?.customer_city || lead.city || 'Unknown';
  }
  // Fuzzy-pick a value from a Meta-form custom-field map by key regex.
  function pickCustom(custom, re) {
    for (const [k, v] of Object.entries(custom || {})) { if (re.test(k) && v) return String(v); }
    return '';
  }
  // Normalize an insurance value to Yes / No / '' for clean filtering.
  function normInsurance(v) {
    if (!v) return '';
    const s = String(v).toLowerCase();
    if (/^(yes|haan|hai|y|true|covered|insured)/.test(s) || /insurance hai|bima hai/.test(s)) return 'Yes';
    if (/^(no|nahi|n|false|not)/.test(s) || /no insurance|bima nahi/.test(s)) return 'No';
    return String(v);
  }

  const STAGES = ['captured','matched','contacted','consulted','booked','done','lost'];
  const INTENTS = ['HOT','WARM','COLD','Unknown'];

  const byIntent       = { HOT:{count:0,surgeries:0}, WARM:{count:0,surgeries:0}, COLD:{count:0,surgeries:0}, Unknown:{count:0,surgeries:0} };
  const byStage        = { captured:0, matched:0, contacted:0, consulted:0, booked:0, done:0, lost:0 };
  const byAdMap        = {};   // ad_id → { count, surgeries }
  const byCityMap      = {};
  const byPlatformMap  = {};
  const intentByStage  = {};   // intent → { stage: count }
  for (const i of INTENTS) { intentByStage[i] = {}; for (const s of STAGES) intentByStage[i][s] = 0; }
  const timelineMap    = {};   // YYYY-MM-DD → count

  // Custom form-field harvest — every Lead Form question that isn't the
  // canonical phone/name/email/city. Each question becomes its own breakdown
  // keyed by normalized question label, e.g. "eye_power" → { "-2.0":4, "-4.0":3 }.
  // Surfaced as breakdowns.byCustomField in the API response so the dashboard
  // can chart audience composition by whatever the form asked.
  const customFieldMap = {};   // questionKey → { question, values: { answer → { count, surgeries } } }

  const leads = metaLeads.map(l => {
    const refrens = l.matched_source === 'refrens' ? refrensMap[l.matched_lead_id] : null;
    const bot     = l.matched_source === 'chatbot' ? botMap[l.matched_lead_id] : null;
    const status  = refrens?.status || bot?.status || (l.matched_source ? 'matched' : 'pending');
    const intent  = intentOf(l, refrens, bot);
    const stage   = stageOf(l, refrens, bot);
    const safeStage = STAGES.includes(stage) ? stage : 'captured';
    const isWon   = safeStage === 'done';
    const isLost  = safeStage === 'lost';
    const isHot   = intent === 'HOT';
    const platform = platformOf(l);
    const city     = cityOf(l, refrens);

    // Aggregations
    byIntent[intent].count++;
    if (isWon) byIntent[intent].surgeries++;
    byStage[safeStage] = (byStage[safeStage] || 0) + 1;
    if (l.ad_id) {
      const k = l.ad_id;
      const e = byAdMap[k] = byAdMap[k] || { ad_id: k, ad_name: adNameById[k] || k, count: 0, surgeries: 0 };
      e.count++; if (isWon) e.surgeries++;
    }
    const ce = byCityMap[city] = byCityMap[city] || { city, count: 0, surgeries: 0 };
    ce.count++; if (isWon) ce.surgeries++;
    const pe = byPlatformMap[platform] = byPlatformMap[platform] || { platform, count: 0, surgeries: 0 };
    pe.count++; if (isWon) pe.surgeries++;
    intentByStage[intent][safeStage] = (intentByStage[intent][safeStage] || 0) + 1;
    if (l.created_time) {
      const d = String(l.created_time).slice(0, 10);
      timelineMap[d] = (timelineMap[d] || 0) + 1;
    }

    // Custom form fields — re-extract on the fly from raw field_data so we
    // don't have to migrate the historical rows. Lightweight (already in JSON).
    if (Array.isArray(l.field_data)) {
      const fields = extractFieldData(l.field_data);
      for (const [qKey, answer] of Object.entries(fields.custom || {})) {
        const slot = customFieldMap[qKey] = customFieldMap[qKey] || {
          question: qKey.replace(/_/g, ' '),
          values: {}
        };
        const v = slot.values[answer] = slot.values[answer] || { value: answer, count: 0, surgeries: 0 };
        v.count++;
        if (isWon) v.surgeries++;
      }
    }

    // Harvest the lead's own Meta-form custom answers (fallback for form-only
    // leads that never messaged WhatsApp), then coalesce bot → form for the
    // qualification data points used in the export + filters.
    const formCustom = Array.isArray(l.field_data) ? extractFieldData(l.field_data).custom : {};
    const insurance = normInsurance(bot?.insurance || pickCustom(formCustom, /insur|bima|medical_?cover/));
    const eyePower  = (bot?.eye_power || pickCustom(formCustom, /eye|power|spectacle|glass|sight|vision|number/) || '').toString().trim();
    const timeline  = (bot?.timeline || pickCustom(formCustom, /timeline|how_?soon|when|plan|surgery_?date|month/) || '').toString().trim();
    const ageGroup  = pickCustom(formCustom, /\bage\b|umar|age_?group|how_?old/);
    const assignee  = refrens?.assignee || '';

    return {
      ...l,
      refrens,
      bot,
      status,
      intent,
      stage: safeStage,
      isWon, isLost, isHot,
      // flattened qualification fields for export + filtering
      insurance,
      eye_power: eyePower,
      timeline,
      age_group: ageGroup,
      assignee,
    };
  });

  // Build the timeline array for the last 30 days, zero-filled
  const timeline = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10);
    timeline.push({ date: d, count: timelineMap[d] || 0 });
  }

  const funnel = {
    total: leads.length,
    matched: leads.filter(l => l.matched_lead_id).length,
    hot: byIntent.HOT.count,
    consulted: byStage.consulted || 0,
    booked: byStage.booked || 0,
    won: byStage.done || 0,
    lost: byStage.lost || 0,
    pending: leads.filter(l => !l.matched_lead_id).length
  };

  // Refrens-style bifurcation — only counts leads matched to a Refrens record,
  // so the numbers line up with the Analytics tab definitions exactly.
  const refrensStatusMap   = {};   // raw refrens status → count
  const refrensHealthMap   = {};   // bucket: Lost / DNP / SLA Breached / Converted / Active / Other
  const refrensSlaMap      = { onTime: 0, breached: 0, dnp: 0 };
  const refrensAssigneeMap = {};
  for (const l of leads) {
    if (!l.refrens) continue;
    const st = l.refrens.status || 'Unknown';
    refrensStatusMap[st] = (refrensStatusMap[st] || 0) + 1;
    // Health bucket — same logic as Analytics tab Lead Health donut
    let bucket = 'Active';
    if (/lost.*final|^lost$/i.test(st)) bucket = 'Lost — Final';
    else if (/dnp.*lost/i.test(st)) bucket = 'DNP Lost';
    else if (/dnp/i.test(st)) bucket = 'DNP';
    else if (/sla.*breach|breached/i.test(st)) bucket = 'SLA Breached';
    else if (/deal.*done|won|surgery/i.test(st)) bucket = 'Converted';
    else if (/recover/i.test(st)) bucket = 'Lost — Recoverable';
    else if (/no.*follow|stale/i.test(st)) bucket = 'No Follow-up Set';
    refrensHealthMap[bucket] = (refrensHealthMap[bucket] || 0) + 1;
    // SLA / DNP
    if (/dnp/i.test(st)) refrensSlaMap.dnp++;
    else if (/sla.*breach|breached/i.test(st)) refrensSlaMap.breached++;
    else refrensSlaMap.onTime++;
    // Assignee
    if (l.refrens.assignee) {
      const a = refrensAssigneeMap[l.refrens.assignee] = refrensAssigneeMap[l.refrens.assignee] || { assignee: l.refrens.assignee, count: 0, surgeries: 0 };
      a.count++; if (l.isWon) a.surgeries++;
    }
  }

  // Insurance breakdown — coalesced bot+form value per lead (Yes / No / Unknown).
  const insuranceMap = {};
  for (const l of leads) {
    const key = l.insurance || 'Unknown';
    const e = insuranceMap[key] = insuranceMap[key] || { value: key, count: 0, surgeries: 0 };
    e.count++; if (l.isWon) e.surgeries++;
  }

  // Custom form-field breakdowns: convert each question into a sorted array
  // of {value, count, surgeries, surgeryRate}. Cap at top 10 answers per
  // question to keep the response light.
  const byCustomField = {};
  for (const [qKey, slot] of Object.entries(customFieldMap)) {
    const arr = Object.values(slot.values).sort((a, b) => b.count - a.count);
    if (arr.length === 0) continue;
    byCustomField[qKey] = {
      question: slot.question,
      values: arr.slice(0, 10).map(v => ({
        ...v,
        surgeryRate: v.count > 0 ? Math.round((v.surgeries / v.count) * 1000) / 10 : 0
      })),
      total: arr.reduce((s, v) => s + v.count, 0)
    };
  }

  const breakdowns = {
    byIntent,
    byStage,
    byAd:       Object.values(byAdMap).sort((a,b) => b.count - a.count).slice(0, 8),
    byCity:     Object.values(byCityMap).sort((a,b) => b.count - a.count).slice(0, 8),
    byPlatform: Object.values(byPlatformMap).sort((a,b) => b.count - a.count),
    intentByStage,
    timeline,
    // New: per-form-question harvest (eye power, timeline, insurance, etc.)
    byCustomField,
    // New: Refrens-aligned bifurcation so Marketing tab matches Analytics tab
    refrensHealth:   Object.entries(refrensHealthMap).map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count),
    refrensStatus:   Object.entries(refrensStatusMap).map(([status, count]) => ({ status, count })).sort((a,b) => b.count - a.count),
    refrensSla:      refrensSlaMap,
    refrensAssignee: Object.values(refrensAssigneeMap).sort((a,b) => b.count - a.count),
    byInsurance:     Object.values(insuranceMap).sort((a,b) => b.count - a.count)
  };

  const accountBenchmark = await getAccountBenchmark();
  const { recommendations, analytics } = await buildCampaignLeadExtras(campaignId, {
    breakdowns,
    funnel,
    accountBenchmark,
  });

  return { leads, funnel, breakdowns, accountBenchmark, recommendations, analytics };
}

// Shared helper — one getCampaignDetail() call powers both recommendations
// and the deeper analytics payload for the Leads tab.
async function buildCampaignLeadExtras(campaignId, { breakdowns, funnel, accountBenchmark }) {
  let recommendations = [];
  let analytics = null;
  try {
    const det = await getCampaignDetail(campaignId);
    analytics = computeCampaignLeadAnalytics({
      kpis30: det.kpis30,
      kpis7: det.kpis7,
      wow: det.wow,
      breakdowns: breakdowns || {},
      funnel: funnel || {},
      accountBenchmark,
    });
    recommendations = computeRecommendations({
      kpis30: det.kpis30,
      kpis7: det.kpis7,
      wow: det.wow,
      breakdowns: breakdowns || {},
      funnel: funnel || {},
      accountBenchmark,
      campaign: det.campaign,
    });
  } catch (e) {
    console.warn(`[META] campaign lead extras skipped for ${campaignId}: ${e.message}`);
  }
  return { recommendations, analytics };
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

// ─── Bulk import: walk every synced campaign and pull its historical leads ────
// One-click bulk path so the operator doesn't have to click Import on each of
// 76 campaigns. Returns a per-campaign report plus aggregate totals so the UI
// can show "Imported N leads across M campaigns" and call out the campaigns
// that failed (e.g. with the page-scopes permission error).
export async function importAllCampaignLeads({ since } = {}) {
  const { data: campaigns, error } = await supabaseAdmin
    .from('meta_campaigns')
    .select('id, name, status');
  if (error) throw new Error(error.message);
  if (!campaigns || campaigns.length === 0) {
    return { imported: 0, linked: 0, campaigns: 0, results: [] };
  }

  // Filter to ACTIVE + PAUSED — DELETED / ARCHIVED very rarely have new forms
  const eligible = campaigns.filter(c => /^(ACTIVE|PAUSED)$/i.test(c.status || ''));

  let totalImported = 0, totalLinked = 0;
  const results = [];
  const startedAt = Date.now();

  for (const c of eligible) {
    try {
      const r = await importHistoricalLeads({ campaignId: c.id, since });
      totalImported += (r.imported || 0);
      totalLinked   += (r.linked || 0);
      results.push({
        campaignId: c.id,
        campaignName: c.name,
        imported: r.imported || 0,
        linked: r.linked || 0,
        forms: r.forms || 0,
        permissionsHint: r.permissionsHint || null,
        ...(r.message ? { message: r.message } : {})
      });
      // brief pause between campaigns to avoid Graph rate limiting
      await new Promise(res => setTimeout(res, 300));
    } catch (e) {
      results.push({ campaignId: c.id, campaignName: c.name, error: e.message });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[META] Bulk import done: ${totalImported} leads / ${totalLinked} matched across ${eligible.length} campaigns in ${(elapsedMs/1000).toFixed(1)}s`);
  return {
    imported: totalImported,
    linked: totalLinked,
    campaigns: eligible.length,
    elapsedMs,
    results: results.sort((a, b) => (b.imported || 0) - (a.imported || 0))
  };
}

// ─── Campaign lead analytics (structured insights for the Leads tab) ─────────
// Pure function — all numbers come from getCampaignLeads() aggregations +
// getCampaignDetail() KPIs + the cached account benchmark (real SQL counts).
export function computeCampaignLeadAnalytics({ kpis30, kpis7, wow, breakdowns, funnel, accountBenchmark }) {
  const b = breakdowns || {};
  const f = funnel || {};
  const bench = accountBenchmark || {};
  const k30 = kpis30 || {};
  const k7 = kpis7 || {};

  const matchRate = f.total > 0 ? f.matched / f.total : null;
  const surgeryRate = f.matched > 0 ? f.won / f.matched : null;
  const hotPct = f.matched > 0 ? f.hot / f.matched : null;
  const captureToSurgery = f.total > 0 ? f.won / f.total : null;
  const spend = Number(k30.spend || 0);
  const cplCaptured = f.total > 0 && spend > 0 ? spend / f.total : null;
  const cps = f.won > 0 && spend > 0 ? spend / f.won : null;
  const metaCpl = k30.cpl != null ? k30.cpl : (k30.leads > 0 && spend > 0 ? spend / k30.leads : null);

  function pctDelta(cur, avg, asPp = false) {
    if (cur == null || avg == null) return null;
    if (asPp) return Math.round((cur - avg) * 1000) / 10;
    if (avg === 0) return null;
    return Math.round(((cur - avg) / avg) * 1000) / 10;
  }

  const benchmarkComparisons = [
    { key: 'matchRate', label: 'CRM match rate', campaign: matchRate, account: bench.matchRate, format: 'pct', lowerBetter: false },
    { key: 'surgeryRate', label: 'Surgery rate (matched)', campaign: surgeryRate, account: bench.surgeryRate, format: 'pct', lowerBetter: false },
    { key: 'hotPct', label: 'HOT share (matched)', campaign: hotPct, account: bench.hotPct, format: 'pct', lowerBetter: false },
    { key: 'captureToSurgery', label: 'Captured → surgery', campaign: captureToSurgery, account: bench.surgeryRate != null && bench.matchRate != null ? bench.surgeryRate * bench.matchRate : null, format: 'pct', lowerBetter: false },
    { key: 'metaCpl', label: 'Meta CPL (platform)', campaign: metaCpl, account: bench.cpl, format: 'rs', lowerBetter: true },
    { key: 'cplCaptured', label: 'Cost / captured lead', campaign: cplCaptured, account: bench.cpl, format: 'rs', lowerBetter: true },
    { key: 'costPerSurgery', label: 'Cost / surgery', campaign: cps, account: bench.costPerSurgery, format: 'rs', lowerBetter: true },
  ].map((row) => {
    const delta = row.format === 'pct'
      ? pctDelta(row.campaign, row.account, true)
      : pctDelta(row.campaign, row.account, false);
    const better = row.campaign != null && row.account != null
      ? (row.lowerBetter ? row.campaign < row.account : row.campaign > row.account)
      : null;
    return { ...row, delta, better };
  });

  const contacted = (b.byStage?.contacted || 0) + (b.byStage?.consulted || 0) + (b.byStage?.booked || 0) + (b.byStage?.done || 0);
  const consulted = (b.byStage?.consulted || 0) + (b.byStage?.booked || 0) + (b.byStage?.done || 0);
  const booked = (b.byStage?.booked || 0) + (b.byStage?.done || 0);
  const funnelSteps = [
    { stage: 'Captured', count: f.total || 0 },
    { stage: 'Matched', count: f.matched || 0 },
    { stage: 'Contacted', count: contacted },
    { stage: 'Consulted', count: consulted },
    { stage: 'Booked', count: booked },
    { stage: 'Surgery done', count: f.won || 0 },
  ].map((step, i, arr) => {
    const prev = i > 0 ? arr[i - 1].count : null;
    const rateFromPrev = prev > 0 ? Math.round((step.count / prev) * 1000) / 10 : null;
    const dropFromPrev = prev != null ? prev - step.count : null;
    return { ...step, rateFromPrev, dropFromPrev };
  });

  let maxDrop = 0;
  let bottleneck = null;
  for (let i = 1; i < funnelSteps.length; i++) {
    const drop = funnelSteps[i].dropFromPrev || 0;
    if (drop > maxDrop) {
      maxDrop = drop;
      bottleneck = {
        from: funnelSteps[i - 1].stage,
        to: funnelSteps[i].stage,
        drop,
        dropPct: funnelSteps[i - 1].count > 0 ? Math.round((drop / funnelSteps[i - 1].count) * 1000) / 10 : null,
      };
    }
  }

  const timeline = b.timeline || [];
  const last7 = timeline.slice(-7).reduce((s, d) => s + d.count, 0);
  const prior7 = timeline.slice(-14, -7).reduce((s, d) => s + d.count, 0);
  const velocityWow = prior7 > 0 ? Math.round(((last7 - prior7) / prior7) * 1000) / 10 : (last7 > 0 ? null : 0);
  const avgPerDay30 = timeline.length > 0
    ? Math.round((timeline.reduce((s, d) => s + d.count, 0) / timeline.length) * 10) / 10
    : 0;
  const peakDay = timeline.reduce((best, d) => (d.count > (best?.count || 0) ? d : best), null);

  const sla = b.refrensSla || {};
  const slaTotal = (sla.onTime || 0) + (sla.breached || 0) + (sla.dnp || 0);
  const lostCount = Object.values(b.intentByStage || {}).reduce((s, stg) => s + (stg.lost || 0), 0);
  const insuranceYes = (b.byInsurance || []).find((x) => /^yes$/i.test(x.value))?.count || 0;
  const insuranceTotal = (b.byInsurance || []).reduce((s, x) => s + x.count, 0);

  const quality = {
    matchRate,
    surgeryRate,
    hotPct,
    captureToSurgery,
    lossRate: f.matched > 0 ? lostCount / f.matched : null,
    slaBreachPct: slaTotal > 0 ? (sla.breached || 0) / slaTotal : null,
    dnpPct: slaTotal > 0 ? (sla.dnp || 0) / slaTotal : null,
    insuranceYesPct: insuranceTotal > 0 ? insuranceYes / insuranceTotal : null,
    unmatched: f.pending,
  };

  function bestSegment(items, labelKey) {
    const eligible = (items || []).filter((x) => x.count >= 5);
    if (!eligible.length) return null;
    const best = [...eligible].sort((a, c) => (c.surgeries / c.count) - (a.surgeries / a.count))[0];
    return {
      label: best[labelKey] || best.ad_name,
      count: best.count,
      surgeries: best.surgeries,
      surgeryRate: Math.round((best.surgeries / best.count) * 1000) / 10,
    };
  }

  const topSegments = {
    city: bestSegment(b.byCity, 'city'),
    ad: bestSegment(b.byAd, 'ad_name'),
    platform: bestSegment(b.byPlatform, 'platform'),
  };

  const insights = [];
  if (f.total === 0 && spend > 500) {
    insights.push({
      type: 'critical',
      title: 'Spend without attributed leads',
      detail: `₹${Math.round(spend).toLocaleString('en-IN')} spent in 30d but 0 form leads in CRM — verify Lead Ads setup or import historical submissions.`,
    });
  }
  if (bottleneck && maxDrop >= 3) {
    insights.push({
      type: 'warn',
      title: `Largest funnel drop: ${bottleneck.from} → ${bottleneck.to}`,
      detail: `${bottleneck.drop} leads lost (${bottleneck.dropPct}% of ${bottleneck.from}) — sales effort here has the highest leverage.`,
    });
  }
  if (matchRate != null && bench.matchRate != null && matchRate < bench.matchRate * 0.75) {
    insights.push({
      type: 'warn',
      title: 'Below-average phone match rate',
      detail: `${Math.round(matchRate * 100)}% vs account ${Math.round(bench.matchRate * 100)}% — run backfill-links after Refrens sync or check form phone quality.`,
    });
  }
  if (surgeryRate != null && bench.surgeryRate != null) {
    const diff = (surgeryRate - bench.surgeryRate) * 100;
    if (Math.abs(diff) >= 2) {
      insights.push({
        type: surgeryRate > bench.surgeryRate ? 'good' : 'warn',
        title: surgeryRate > bench.surgeryRate ? 'Outperforming on surgery rate' : 'Underperforming on surgery rate',
        detail: `${(surgeryRate * 100).toFixed(1)}% matched→surgery vs account ${(bench.surgeryRate * 100).toFixed(1)}% (${diff > 0 ? '+' : ''}${diff.toFixed(1)} pp).`,
      });
    }
  }
  if (velocityWow != null && Math.abs(velocityWow) >= 20) {
    insights.push({
      type: velocityWow > 0 ? 'good' : 'warn',
      title: velocityWow > 0 ? 'Lead volume accelerating' : 'Lead volume slowing',
      detail: `${last7} leads in last 7d vs ${prior7} prior week (${velocityWow > 0 ? '+' : ''}${velocityWow}%).`,
    });
  }
  if (topSegments.city) {
    insights.push({
      type: 'info',
      title: `Best-converting city: ${topSegments.city.label}`,
      detail: `${topSegments.city.surgeryRate}% surgery rate across ${topSegments.city.count} leads (${topSegments.city.surgeries} closed).`,
    });
  }
  if (topSegments.ad) {
    insights.push({
      type: 'info',
      title: `Best-converting ad: ${topSegments.ad.label}`,
      detail: `${topSegments.ad.surgeryRate}% surgery rate across ${topSegments.ad.count} attributed leads.`,
    });
  }
  if (slaTotal >= 10 && quality.slaBreachPct > 0.2) {
    insights.push({
      type: 'critical',
      title: 'SLA breaches on matched leads',
      detail: `${Math.round(quality.slaBreachPct * 100)}% of matched leads breached response SLA — first-call speed is hurting conversion.`,
    });
  }
  if (f.pending >= 10) {
    insights.push({
      type: 'info',
      title: `${f.pending} unmatched leads`,
      detail: 'Form submissions with no CRM phone match — run backfill-links after Refrens sync or re-import.',
    });
  }
  if (k30.frequency != null && k30.frequency > 3) {
    insights.push({
      type: 'info',
      title: 'Ad frequency elevated',
      detail: `Avg user saw the ad ${k30.frequency.toFixed(1)}× in 30d — watch CTR and refresh creative if CPL rises.`,
    });
  }
  if (wow?.cpl != null && Math.abs(wow.cpl) >= 15) {
    insights.push({
      type: wow.cpl < 0 ? 'good' : 'warn',
      title: wow.cpl < 0 ? 'CPL improving week-over-week' : 'CPL rising week-over-week',
      detail: `Platform CPL ${wow.cpl > 0 ? '+' : ''}${wow.cpl.toFixed(0)}% vs prior 7d (₹${Math.round(k7.cpl || 0)} now).`,
    });
  }

  const adEfficiency = (b.byAd || []).map((ad) => {
    const share = f.total > 0 ? ad.count / f.total : 0;
    const estSpend = spend > 0 && share > 0 ? spend * share : null;
    const estCpl = estSpend != null && ad.count > 0 ? Math.round(estSpend / ad.count) : null;
    return {
      ad_id: ad.ad_id,
      ad_name: ad.ad_name,
      leads: ad.count,
      surgeries: ad.surgeries,
      sharePct: Math.round(share * 1000) / 10,
      estSpend: estSpend != null ? Math.round(estSpend) : null,
      estCpl,
      surgeryRate: ad.count > 0 ? Math.round((ad.surgeries / ad.count) * 1000) / 10 : 0,
    };
  }).sort((a, c) => c.leads - a.leads).slice(0, 8);

  return {
    benchmarkComparisons,
    funnelSteps,
    bottleneck,
    velocity: {
      last7,
      prior7,
      wowPct: velocityWow,
      avgPerDay30,
      peakDay: peakDay ? { date: peakDay.date, count: peakDay.count } : null,
    },
    quality,
    topSegments,
    adEfficiency,
    insights: insights.slice(0, 12),
    computedAt: new Date().toISOString(),
  };
}

// ─── Campaign recommendations engine ──────────────────────────────────────────
// Given the kpis30 + breakdowns + accountBenchmark for a single campaign,
// produce a ranked list of actionable suggestions. Each suggestion has:
//   severity : 'critical' | 'warn' | 'info' | 'good'
//   title    : short imperative ("Reduce CPL", "Scale this campaign")
//   detail   : one-sentence explanation grounded in the data
//   metric   : the underlying number that triggered it
// The UI renders them in order; no auto-action, the operator decides.
export function computeRecommendations({ kpis30, kpis7, wow, breakdowns, funnel, accountBenchmark, campaign }) {
  const rec = [];
  const k30 = kpis30 || {};
  const k7 = kpis7 || {};
  const bench = accountBenchmark || {};
  const b = breakdowns || {};
  const f = funnel || {};

  const fmtPct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const fmtPp  = (cur, avg) => avg == null ? '—' : `${((cur - avg) * 100).toFixed(1)} pp`;
  const fmtRs  = v => v == null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`;

  // 1) Surgery rate vs account avg
  if (f.matched > 8 && bench.surgeryRate != null) {
    const surgRate = f.matched > 0 ? f.won / f.matched : 0;
    if (surgRate > bench.surgeryRate * 1.3) {
      rec.push({ severity: 'good', title: '📈 Scale this campaign',
        detail: `Surgery rate ${fmtPct(surgRate)} is ${fmtPp(surgRate, bench.surgeryRate)} above account avg (${fmtPct(bench.surgeryRate)}). Same creative, larger budget could compound the conversion.`,
        metric: { surgRate, benchmark: bench.surgeryRate } });
    } else if (surgRate < bench.surgeryRate * 0.5 && f.matched >= 20) {
      rec.push({ severity: 'critical', title: '🛑 Pause and refresh creative',
        detail: `Surgery rate ${fmtPct(surgRate)} is less than half the account avg (${fmtPct(bench.surgeryRate)}). ${f.matched} leads matched but only ${f.won} closed — the creative is attracting wrong-fit prospects.`,
        metric: { surgRate, benchmark: bench.surgeryRate } });
    }
  }

  // 2) Cost-per-surgery vs account avg
  if (f.won > 0 && k30.spend > 0 && bench.costPerSurgery != null) {
    const cps = k30.spend / f.won;
    if (cps > bench.costPerSurgery * 1.5) {
      rec.push({ severity: 'warn', title: '💸 Cost per surgery is high',
        detail: `${fmtRs(cps)} per surgery vs account avg ${fmtRs(bench.costPerSurgery)} — ${Math.round(((cps / bench.costPerSurgery) - 1) * 100)}% above. Consider narrowing audience or testing cheaper placements.`,
        metric: { cps, benchmark: bench.costPerSurgery } });
    } else if (cps < bench.costPerSurgery * 0.7) {
      rec.push({ severity: 'good', title: '✅ Cost per surgery is excellent',
        detail: `${fmtRs(cps)} per surgery vs account avg ${fmtRs(bench.costPerSurgery)} — ${Math.round((1 - cps / bench.costPerSurgery) * 100)}% below. Increase daily budget while CPL holds.`,
        metric: { cps, benchmark: bench.costPerSurgery } });
    }
  }

  // 3) HOT leads stuck at the contacted/consulted bottleneck
  if (b.byIntent?.HOT?.count >= 5 && b.intentByStage?.HOT) {
    const hot = b.byIntent.HOT;
    const hotDone = b.intentByStage.HOT.done || 0;
    const hotConsulted = b.intentByStage.HOT.consulted || 0;
    if (hot.count >= 5 && hotDone === 0) {
      rec.push({ severity: 'critical', title: '🔥 HOT leads not converting',
        detail: `${hot.count} HOT-intent leads from this campaign and 0 surgeries closed. Sales handoff is broken — review SLA on first response and HOT-lead routing.`,
        metric: { hotCount: hot.count, hotDone: 0 } });
    } else if (hot.count >= 8 && hotConsulted < hot.count * 0.3) {
      rec.push({ severity: 'warn', title: '🔥 HOT leads stuck before consultation',
        detail: `Only ${hotConsulted}/${hot.count} HOT leads reached Consulted (${Math.round((hotConsulted / hot.count) * 100)}%). Sales contact rate too low — speed up first call.`,
        metric: { hotCount: hot.count, hotConsulted } });
    }
  }

  // 4) Match-rate vs account avg
  if (f.total >= 10 && bench.matchRate != null) {
    const matchRate = f.matched / f.total;
    if (matchRate < bench.matchRate * 0.6) {
      rec.push({ severity: 'warn', title: '🔍 Phone-match rate is low',
        detail: `Only ${Math.round(matchRate * 100)}% of ${f.total} captured leads matched a CRM record (avg ${fmtPct(bench.matchRate)}). Either form phones are dirty (autofilled bad numbers) or Refrens sync is behind.`,
        metric: { matchRate, benchmark: bench.matchRate } });
    }
  }

  // 5) Single-city dominance — diversification opportunity
  const byCity = b.byCity || [];
  if (byCity.length > 0 && f.total >= 15) {
    const topCity = byCity[0];
    const topShare = topCity.count / f.total;
    if (topShare > 0.7) {
      rec.push({ severity: 'info', title: `🗺 ${topCity.city} dominates — test new geos`,
        detail: `${Math.round(topShare * 100)}% of leads come from ${topCity.city}. Spin up a lookalike for the next 2-3 cities to widen the funnel without diluting CPL.`,
        metric: { topCity: topCity.city, share: topShare } });
    }
  }

  // 6) Single-ad concentration — creative fatigue risk
  const byAd = b.byAd || [];
  if (byAd.length >= 1 && f.total >= 15) {
    const topAd = byAd[0];
    const topAdShare = topAd.count / f.total;
    if (byAd.length === 1) {
      rec.push({ severity: 'info', title: '🎨 Only one ad creative running',
        detail: `Every lead came from a single ad ("${topAd.ad_name}"). Add 2-3 creative variants to avoid fatigue and learn what hooks work.`,
        metric: { ads: 1 } });
    } else if (topAdShare > 0.8) {
      rec.push({ severity: 'info', title: '🎨 One ad is doing the heavy lifting',
        detail: `${Math.round(topAdShare * 100)}% of leads from "${topAd.ad_name}". Pause low performers and reallocate budget to the winner.`,
        metric: { topAd: topAd.ad_name, share: topAdShare } });
    }
  }

  // 7) Platform-mix observation
  const byPlat = b.byPlatform || [];
  if (byPlat.length >= 2 && f.total >= 15) {
    const totalP = byPlat.reduce((s, p) => s + p.count, 0);
    const fb = byPlat.find(p => /facebook|fb/i.test(p.platform))?.count || 0;
    const ig = byPlat.find(p => /instagram|ig/i.test(p.platform))?.count || 0;
    const fbShare = totalP > 0 ? fb / totalP : 0;
    const igShare = totalP > 0 ? ig / totalP : 0;
    if (igShare > 0.85) {
      rec.push({ severity: 'info', title: '📱 Almost all leads are from Instagram',
        detail: `${Math.round(igShare * 100)}% from IG, ${Math.round(fbShare * 100)}% from FB. Consider placement-specific creative or reallocating away from FB if FB CPL is higher.`,
        metric: { fbShare, igShare } });
    } else if (fbShare > 0.85) {
      rec.push({ severity: 'info', title: '📱 Almost all leads are from Facebook',
        detail: `${Math.round(fbShare * 100)}% from FB. Test Reels/Stories placements on IG — often half the CPL for LASIK leads.`,
        metric: { fbShare, igShare } });
    }
  }

  // 8) Week-over-week direction
  if (wow?.cpl != null && wow.cpl > 30 && k7.spend > 1000) {
    rec.push({ severity: 'warn', title: '📈 CPL trending up',
      detail: `CPL rose ${wow.cpl.toFixed(0)}% week-over-week (₹${Math.round(k7.cpl || 0)} vs prior week). Auction is heating up — refresh creative or shift schedule.`,
      metric: { wowCpl: wow.cpl } });
  } else if (wow?.cpl != null && wow.cpl < -20 && k7.leads > 5) {
    rec.push({ severity: 'good', title: '📉 CPL improving week-over-week',
      detail: `CPL dropped ${Math.abs(wow.cpl).toFixed(0)}% this week (₹${Math.round(k7.cpl || 0)} vs prior). Lock in budget while the trend holds.`,
      metric: { wowCpl: wow.cpl } });
  }

  // 9) Frequency / fatigue (impressions ÷ reach)
  if (k30.frequency != null && k30.frequency > 3.5 && k30.reach > 500) {
    rec.push({ severity: 'warn', title: '🔁 Audience fatigue likely',
      detail: `Frequency is ${k30.frequency.toFixed(1)} (avg user has seen the ad ${k30.frequency.toFixed(1)}× in 30 days). CTR usually craters past 3.0 — rotate creative or expand audience.`,
      metric: { frequency: k30.frequency } });
  }

  // 10) Spend with no leads at all
  if (k30.spend > 1000 && f.total === 0) {
    rec.push({ severity: 'critical', title: '⚠️ Spending without leads',
      detail: `${fmtRs(k30.spend)} spent in 30 days with 0 attributed Lead Form submissions. Either the form is broken, or this campaign drives traffic (not Lead Ads) — confirm in Ads Manager.`,
      metric: { spend: k30.spend, leads: 0 } });
  }

  // 11) SLA / DNP on matched leads
  const sla = b.refrensSla || {};
  const slaTotal = (sla.onTime || 0) + (sla.breached || 0) + (sla.dnp || 0);
  if (slaTotal >= 10) {
    const breachPct = (sla.breached || 0) / slaTotal;
    const dnpPct = (sla.dnp || 0) / slaTotal;
    if (breachPct > 0.25) {
      rec.push({ severity: 'critical', title: '⏱ SLA breach rate is high',
        detail: `${Math.round(breachPct * 100)}% of ${slaTotal} matched leads breached first-response SLA. Route new leads to faster assignees or tighten call-back SOP.`,
        metric: { breachPct, slaTotal } });
    } else if (dnpPct > 0.35) {
      rec.push({ severity: 'warn', title: '📵 DNP rate is high on matched leads',
        detail: `${Math.round(dnpPct * 100)}% DNP among matched leads — verify phone numbers at form capture and retry cadence before marking lost.`,
        metric: { dnpPct, slaTotal } });
    }
  }

  // 12) Lead capture velocity (from timeline)
  const timeline = b.timeline || [];
  const last7 = timeline.slice(-7).reduce((s, d) => s + d.count, 0);
  const prior7 = timeline.slice(-14, -7).reduce((s, d) => s + d.count, 0);
  if (prior7 >= 5 && last7 < prior7 * 0.6) {
    rec.push({ severity: 'warn', title: '📉 Lead capture slowing',
      detail: `Only ${last7} leads captured in the last 7 days vs ${prior7} the week before (${Math.round(((last7 - prior7) / prior7) * 100)}%). Check delivery status, budget, or creative fatigue.`,
      metric: { last7, prior7 } });
  } else if (prior7 >= 3 && last7 > prior7 * 1.5) {
    rec.push({ severity: 'good', title: '📈 Lead capture accelerating',
      detail: `${last7} leads in the last 7 days vs ${prior7} prior week — keep budget stable while CPL holds.`,
      metric: { last7, prior7 } });
  }

  // 13) Sales contact bottleneck (matched → contacted)
  if (f.matched >= 15 && b.byStage) {
    const contacted = (b.byStage.contacted || 0) + (b.byStage.consulted || 0) + (b.byStage.booked || 0) + (b.byStage.done || 0);
    const contactRate = contacted / f.matched;
    if (contactRate < 0.4) {
      rec.push({ severity: 'warn', title: '📞 Low contact rate on matched leads',
        detail: `Only ${contacted}/${f.matched} matched leads (${Math.round(contactRate * 100)}%) reached Contacted — first-call speed or assignee capacity is the bottleneck.`,
        metric: { contacted, matched: f.matched } });
    }
  }

  // 14) Assignee load imbalance
  const assignees = b.refrensAssignee || [];
  if (assignees.length >= 2 && f.matched >= 20) {
    const top = assignees[0];
    const topShare = top.count / f.matched;
    if (topShare > 0.55) {
      rec.push({ severity: 'info', title: `👤 ${top.assignee} carries most leads`,
        detail: `${Math.round(topShare * 100)}% of matched leads assigned to ${top.assignee} (${top.count}/${f.matched}). Rebalance routing to spread follow-up load.`,
        metric: { assignee: top.assignee, share: topShare } });
    }
  }

  // 15) Unmatched backlog — backfill opportunity
  if (f.pending >= 15 && f.total >= 20) {
    const unmatchPct = f.pending / f.total;
    rec.push({ severity: 'warn', title: '🔗 Large unmatched backlog',
      detail: `${f.pending} of ${f.total} leads (${Math.round(unmatchPct * 100)}%) have no CRM match. Click backfill-links after Refrens sync to recover attribution.`,
      metric: { pending: f.pending, total: f.total } });
  }

  // Severity ranking
  const sevRank = { critical: 0, warn: 1, info: 2, good: 3 };
  return rec.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
}

// ─── Bulk campaign leads export ───────────────────────────────────────────────
// Returns all meta leads across all campaigns, enriched with CRM data.
// Used by GET /api/meta/leads/export
export async function getAllCampaignLeadsExport({ from, to } = {}) {
  let query = supabaseAdmin
    .from('meta_leads')
    .select('meta_lead_id, name, phone, email, city, created_time, ad_id, campaign_id, matched_lead_id, matched_source, raw_payload')
    .order('created_time', { ascending: false });
  if (from) query = query.gte('created_time', from + 'T00:00:00.000Z');
  if (to)   query = query.lte('created_time', to   + 'T23:59:59.999Z');

  const { data: metaLeads, error } = await query;
  if (error) throw new Error(error.message);
  if (!metaLeads || metaLeads.length === 0) return { leads: [], total: 0 };

  // Campaign id → name
  const campaignIds = [...new Set(metaLeads.map(l => l.campaign_id).filter(Boolean))];
  const { data: camps } = await supabaseAdmin
    .from('meta_campaigns')
    .select('id, name')
    .in('id', campaignIds);
  const campName = {};
  for (const c of (camps || [])) campName[c.id] = c.name;

  // ad_id → name (best-effort via meta_ad_insights table — it stores ad_id but not name,
  // so we skip ad resolution here; campaign name is sufficient for export)

  // Bulk-fetch matched CRM rows
  const refrensIds = metaLeads.filter(l => l.matched_source === 'refrens' && l.matched_lead_id).map(l => l.matched_lead_id);
  const botIds     = metaLeads.filter(l => l.matched_source === 'chatbot' && l.matched_lead_id).map(l => l.matched_lead_id);

  let refrensMap = {};
  if (refrensIds.length) {
    const { data } = await supabaseAdmin
      .from('refrens_leads')
      .select('id, status, intent_band, labels, call_outcome, follow_up_date, customer_city')
      .in('id', refrensIds);
    for (const r of (data || [])) refrensMap[r.id] = r;
  }
  let botMap = {};
  if (botIds.length) {
    const { data } = await supabaseAdmin
      .from('leads_surgery')
      .select('id, status, intent_level, contact_name, request_call')
      .in('id', botIds);
    for (const r of (data || [])) botMap[r.id] = r;
  }

  function exportIntentOf(lead, refrens, bot) {
    const band = (refrens?.intent_band || '').trim();
    if (/hot/i.test(band))  return 'HOT';
    if (/warm/i.test(band)) return 'WARM';
    if (/cold/i.test(band)) return 'COLD';
    const labels = (refrens?.labels || '').toLowerCase();
    if (/hot|high intent|very interested|urgent/i.test(labels)) return 'HOT';
    if (/warm|interested|follow.?up/i.test(labels))             return 'WARM';
    if (/cold|dnp|junk|spam|not interested|wrong/i.test(labels)) return 'COLD';
    const callOutcome = (refrens?.call_outcome || '').toLowerCase();
    if (/hot|very interested|callback|convert/i.test(callOutcome)) return 'HOT';
    if (/warm|interested|considering|follow|maybe/i.test(callOutcome)) return 'WARM';
    if (/not interested|wrong|junk|irrelevant|dnp/i.test(callOutcome)) return 'COLD';
    if (bot?.request_call) return 'HOT';
    const status = (refrens?.status || '').toLowerCase();
    if (/deal done|won|surgery done|surgery booked/i.test(status)) return 'HOT';
    if (/consult|booked|in[- ]progress/i.test(status))            return 'WARM';
    if (/lost|dnp|not interested|not serviceable|junk/i.test(status)) return 'COLD';
    if (refrens?.follow_up_date) return 'WARM';
    const lvl = (bot?.intent_level || '').toUpperCase();
    if (lvl === 'HOT' || lvl === 'WARM' || lvl === 'COLD') return lvl;
    if (lead.matched_lead_id) return 'WARM';
    return 'Unknown';
  }

  const leads = metaLeads.map(l => {
    const refrens = l.matched_source === 'refrens' ? refrensMap[l.matched_lead_id] : null;
    const bot     = l.matched_source === 'chatbot' ? botMap[l.matched_lead_id]     : null;
    return {
      Campaign:      campName[l.campaign_id] || l.campaign_id || '—',
      Name:          l.name || bot?.contact_name || '(unnamed)',
      Phone:         l.phone || '—',
      Email:         l.email || '—',
      City:          l.city || refrens?.customer_city || '—',
      Intent:        exportIntentOf(l, refrens, bot),
      'CRM Status':  refrens?.status || (bot ? 'Chatbot lead' : '—'),
      'Matched CRM': l.matched_lead_id ? 'Yes' : 'No',
      'Captured Date': l.created_time ? new Date(l.created_time).toLocaleDateString('en-IN') : '—',
    };
  });

  return { leads, total: leads.length };
}
