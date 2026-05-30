// Phase M3 — Web Push fanout for the mobile companion app.
// Loads VAPID keys from env, sends notifications to every stored
// PushSubscription on every new lead, and prunes dead subs.

import webpush from 'web-push';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BLtbdYQyzlnogD31ribxQCTAvvcyd4-iOqnmns3I6Ri5FWEmt5i-3Vw_49pYWOeOsGT0xl7UYfj2ov8WyUtrGus';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'KkM8JdUFWkJxR5OYti3ZJnC4NuWxVX_2yEyXmuyO8b0';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:hello@relivecure.com';

let configured = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
}

export function isPushConfigured() {
  return configured;
}

export async function saveSubscription(supabaseAdmin, sub, meta = {}) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error('Invalid subscription payload');
  }
  const row = {
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    user_id: meta.user_id || null,
    user_agent: meta.user_agent || null,
    updated_at: new Date().toISOString(),
  };
  // Upsert by endpoint
  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .upsert(row, { onConflict: 'endpoint' });
  if (error) throw error;
  return { ok: true };
}

export async function removeSubscription(supabaseAdmin, endpoint) {
  await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', endpoint);
  return { ok: true };
}

// Fan out a notification to every stored subscription.
// payload is { title, body, lead_id, intent, phone }
export async function fanout(supabaseAdmin, payload) {
  if (!configured) {
    console.warn('[PUSH] VAPID keys not configured — skipping fanout');
    return { sent: 0, removed: 0 };
  }
  const { data: subs, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth');
  if (error) {
    console.error('[PUSH] fanout fetch failed:', error.message);
    return { sent: 0, removed: 0 };
  }
  if (!subs || subs.length === 0) return { sent: 0, removed: 0 };

  let sent = 0, removed = 0;
  const body = JSON.stringify(payload);
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 * 60 });
      sent++;
    } catch (e) {
      // 404 / 410 = subscription dead; remove from DB
      if (e.statusCode === 404 || e.statusCode === 410) {
        await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        removed++;
      } else {
        console.warn('[PUSH] send failed:', e.statusCode, e.body);
      }
    }
  }
  return { sent, removed };
}

export const VAPID_PUBLIC_KEY = VAPID_PUBLIC;
