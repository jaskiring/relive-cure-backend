import { supabaseAdmin } from './supabase-admin.js';
import { fanout, isPushConfigured } from './push.js';

/**
 * Best-effort capture of a WhatsApp message into our own store.
 * NEVER throws — a capture failure must not break the bot's reply path.
 *
 * @param {object} m
 * @param {string} m.phone        - lead's wa_id / phone number
 * @param {string} m.direction    - 'inbound' | 'outbound'
 * @param {string|null} [m.body]  - text content (null for pure media)
 * @param {string} [m.msgType]    - 'text' | 'image' | 'audio' | 'document' | 'video' | 'sticker' | ...
 * @param {string|null} [m.mediaId]      - Cloud API media id (for media messages)
 * @param {string|null} [m.waMessageId] - Cloud API message id (used for dedup)
 * @param {string|null} [m.contactName] - WhatsApp profile display name
 * @param {string|number|null} [m.waTimestamp] - Meta timestamp (unix seconds) or ISO string
 */
export async function saveWhatsAppMessage({ phone, direction, body = null, msgType = 'text', mediaId = null, waMessageId = null, contactName = null, waTimestamp = null }) {
  if (!phone || !direction) return;
  try {
    // Normalize timestamp: Meta sends unix seconds (as a string) for inbound messages.
    let ts = waTimestamp;
    if (ts && /^\d+$/.test(String(ts))) ts = new Date(parseInt(ts, 10) * 1000).toISOString();
    if (!ts) ts = new Date().toISOString();

    // 1. Insert the message. Dedup on wa_message_id — duplicates are silently ignored.
    await supabaseAdmin
      .from('whatsapp_messages')
      .upsert(
        { wa_message_id: waMessageId, phone, direction, body, msg_type: msgType, media_id: mediaId, wa_timestamp: ts },
        { onConflict: 'wa_message_id', ignoreDuplicates: true }
      );

    // 1b. Fire-and-forget lore event — never awaited, never throws into main path.
    if (process.env.LEAD_EVENTS_ENABLED !== 'false') {
      supabaseAdmin.from('lead_events').insert({
        phone,
        ts,
        event_type: direction === 'inbound' ? 'whatsapp_in' : 'whatsapp_out',
        source:     direction === 'inbound' ? 'customer' : 'bot',
        payload:    { body: body ? body.slice(0, 500) : null, msg_type: msgType, wa_message_id: waMessageId },
      }).then(() => {}).catch(e => console.error('[LORE] whatsapp lead_events failed:', e.message));
    }

    // 2. Upsert the conversation summary row (one per phone).
    const { data: existing } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('unread_count, last_message_at')
      .eq('phone', phone)
      .maybeSingle();
    const currentUnread = existing?.unread_count || 0;
    const nextUnread = direction === 'inbound' ? currentUnread + 1 : currentUnread;

    // Only overwrite the "last message" fields if this message is actually
    // newer than what's stored — inbound + outbound capture writes run
    // concurrently, so without this the earlier message can win the race.
    const isNewer = !existing?.last_message_at
      || new Date(ts) >= new Date(existing.last_message_at);

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

    // 3. Push notification — inbound only. Fires inline (not via Supabase
    // realtime which is unreliable in the Node client). Best-effort; never
    // throws. The browser SW dedupes by tag so duplicates from any other
    // path collapse into one toast.
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
