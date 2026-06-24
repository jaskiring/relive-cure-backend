import { supabaseAdmin } from './supabase-admin.js';
import { fanout, isPushConfigured } from './push.js';

/** Rep-bridge only — never applied to Cloud API bot numbers. */
function normRepPhone(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  if (d.length < 7) return null;
  if (d.startsWith('91') && d.length === 12) return d.slice(2);
  if (d.length > 10) return d.slice(-10);
  return d;
}

/**
 * Production bot path — byte-for-byte same behaviour as pre multi-WA deploy.
 * Phone stays exactly as Meta sends it (e.g. 919882929742) so leads_surgery,
 * whatsapp_conversations, and lead_events keys never drift.
 */
async function saveBotCloudMessage({
  phone,
  direction,
  body = null,
  msgType = 'text',
  mediaId = null,
  waMessageId = null,
  contactName = null,
  waTimestamp = null,
}) {
  if (!phone || !direction) return;
  try {
    let ts = waTimestamp;
    if (ts && /^\d+$/.test(String(ts))) ts = new Date(parseInt(ts, 10) * 1000).toISOString();
    if (!ts) ts = new Date().toISOString();

    await supabaseAdmin
      .from('whatsapp_messages')
      .upsert(
        { wa_message_id: waMessageId, phone, direction, body, msg_type: msgType, media_id: mediaId, wa_timestamp: ts },
        { onConflict: 'wa_message_id', ignoreDuplicates: true }
      );

    if (process.env.LEAD_EVENTS_ENABLED !== 'false') {
      supabaseAdmin.from('lead_events').insert({
        phone,
        ts,
        event_type: direction === 'inbound' ? 'whatsapp_in' : 'whatsapp_out',
        source: direction === 'inbound' ? 'customer' : 'bot',
        payload: { body: body ? body.slice(0, 500) : null, msg_type: msgType, wa_message_id: waMessageId },
      }).then(() => {}).catch(e => console.error('[LORE] whatsapp lead_events failed:', e.message));
    }

    const { data: existing } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('unread_count, last_message_at')
      .eq('phone', phone)
      .maybeSingle();
    const currentUnread = existing?.unread_count || 0;
    const nextUnread = direction === 'inbound' ? currentUnread + 1 : currentUnread;
    const isNewer = !existing?.last_message_at || new Date(ts) >= new Date(existing.last_message_at);

    const convoRow = { phone, unread_count: nextUnread };
    if (contactName) convoRow.contact_name = contactName;
    if (isNewer) {
      convoRow.last_message_at = ts;
      convoRow.last_message_body = body ? body.slice(0, 120) : `[${msgType}]`;
      convoRow.last_direction = direction;
    }

    await supabaseAdmin
      .from('whatsapp_conversations')
      .upsert(convoRow, { onConflict: 'phone' });

    if (direction === 'inbound' && isPushConfigured()) {
      const who = contactName || phone;
      const text = (body || '').slice(0, 80) || `[${msgType}]`;
      fanout(supabaseAdmin, {
        title: `💬 ${who}`,
        body: text,
        phone,
        url: `/m?phone=${encodeURIComponent(phone)}`,
        kind: 'message',
      }).catch(e => console.warn('[PUSH] inline message fanout failed:', e.message));
    }
  } catch (err) {
    console.error('[WA CAPTURE] ❌', err.message);
  }
}

/**
 * Rep WA Web bridge — only when WA_LINES_ENABLED=true and migrations applied.
 */
async function saveRepBridgeMessage({
  phone,
  direction,
  body = null,
  msgType = 'text',
  waMessageId = null,
  contactName = null,
  waTimestamp = null,
  waLineId,
  loreSource = 'rep',
}) {
  const normalized = normRepPhone(phone) || String(phone || '').replace(/[^\d]/g, '');
  if (!normalized || !direction || !waLineId) return;
  try {
    let ts = waTimestamp;
    if (ts && /^\d+$/.test(String(ts))) ts = new Date(parseInt(ts, 10) * 1000).toISOString();
    if (!ts) ts = new Date().toISOString();

    const msgRow = {
      wa_message_id: waMessageId,
      phone: normalized,
      direction,
      body,
      msg_type: msgType,
      wa_timestamp: ts,
      wa_line_id: waLineId,
    };

    if (waMessageId) {
      await supabaseAdmin.from('whatsapp_messages').upsert(msgRow, { onConflict: 'wa_message_id', ignoreDuplicates: true });
    } else {
      await supabaseAdmin.from('whatsapp_messages').insert(msgRow);
    }

    if (process.env.LEAD_EVENTS_ENABLED !== 'false') {
      supabaseAdmin.from('lead_events').insert({
        phone: normalized,
        ts,
        event_type: direction === 'inbound' ? 'whatsapp_in' : 'whatsapp_out',
        source: loreSource || 'rep',
        payload: {
          body: body ? body.slice(0, 500) : null,
          msg_type: msgType,
          wa_message_id: waMessageId,
          wa_line_id: waLineId,
        },
      }).then(() => {}).catch(e => console.error('[LORE] whatsapp lead_events failed:', e.message));
    }

    const { data: existing } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('unread_count, last_message_at')
      .eq('phone', normalized)
      .eq('wa_line_id', waLineId)
      .maybeSingle();

    const currentUnread = existing?.unread_count || 0;
    const nextUnread = direction === 'inbound' ? currentUnread + 1 : currentUnread;
    const isNewer = !existing?.last_message_at || new Date(ts) >= new Date(existing.last_message_at);

    const convoRow = { phone: normalized, wa_line_id: waLineId, unread_count: nextUnread };
    if (contactName) convoRow.contact_name = contactName;
    if (isNewer) {
      convoRow.last_message_at = ts;
      convoRow.last_message_body = body ? body.slice(0, 120) : `[${msgType}]`;
      convoRow.last_direction = direction;
    }

    await supabaseAdmin.from('whatsapp_conversations').upsert(convoRow);

    if (direction === 'inbound' && isPushConfigured()) {
      const who = contactName || normalized;
      const text = (body || '').slice(0, 80) || `[${msgType}]`;
      fanout(supabaseAdmin, {
        title: `💬 ${who}`,
        body: text,
        phone: normalized,
        url: `/m?phone=${encodeURIComponent(normalized)}`,
        kind: 'message',
      }).catch(e => console.warn('[PUSH] inline message fanout failed:', e.message));
    }
  } catch (err) {
    console.error('[WA CAPTURE] rep line ❌', err.message);
  }
}

/**
 * Capture WhatsApp message. Bot Cloud API always uses legacy path (production-safe).
 * Rep bridge uses multi-line path only when WA_LINES_ENABLED=true.
 */
export async function saveWhatsAppMessage({
  phone,
  direction,
  body = null,
  msgType = 'text',
  mediaId = null,
  waMessageId = null,
  contactName = null,
  waTimestamp = null,
  waLineId = 'bot',
  loreSource = null,
}) {
  const lineId = waLineId || 'bot';
  const repBridge = lineId !== 'bot' && process.env.WA_LINES_ENABLED === 'true';

  if (repBridge) {
    return saveRepBridgeMessage({
      phone, direction, body, msgType, waMessageId, contactName, waTimestamp, waLineId: lineId, loreSource,
    });
  }

  return saveBotCloudMessage({
    phone, direction, body, msgType, mediaId, waMessageId, contactName, waTimestamp,
  });
}

export async function emitOrganicSocialEvent({ phone, username, platform, rawText, action }) {
  if (!phone && !username) return;
  const ts = new Date().toISOString();
  const pseudoPhone = phone || `ig:${String(username || '').replace(/^@/, '')}`;
  try {
    await supabaseAdmin.from('lead_events').insert({
      phone: pseudoPhone,
      ts,
      event_type: 'organic_social',
      source: 'system',
      payload: { platform, username, raw_text: rawText?.slice(0, 500), action },
    });
  } catch (e) {
    console.error('[LORE] organic_social event failed:', e.message);
  }
}
