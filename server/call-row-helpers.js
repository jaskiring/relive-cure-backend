/**
 * Shared call row upsert — used by upload-complete and batch call-log sync.
 * Dedup on (rep_id, call_log_id). Emits Lore event only on first insert.
 */
export function createCallRowHelpers({ supabaseAdmin, normCallPhone, linkCallToLead }) {
  async function upsertCallRow(b, { emitLore = true } = {}) {
    const phone = normCallPhone(b.phone);
    if (!phone) return { ok: false, error: 'invalid phone' };

    const duration = Math.max(0, Math.round(Number(b.duration_sec) || 0));
    const connected = typeof b.connected === 'boolean' ? b.connected : duration >= 5;
    const repId = b.rep_id ? String(b.rep_id).slice(0, 80) : null;
    const callLogId = b.call_log_id != null ? String(b.call_log_id) : null;
    const startedAt = b.call_started_at ? new Date(b.call_started_at).toISOString() : new Date().toISOString();

    if (callLogId && repId) {
      const { data: existing } = await supabaseAdmin
        .from('call_recordings')
        .select('id, has_recording, drive_file_id')
        .eq('rep_id', repId)
        .eq('call_log_id', callLogId)
        .maybeSingle();
      if (existing) {
        return { ok: true, action: 'skipped', id: existing.id, existing: true };
      }
    }

    const link = await linkCallToLead(phone);
    const row = {
      rep_id: repId,
      rep_name: b.rep_name ? String(b.rep_name).slice(0, 120) : null,
      phone,
      direction: b.direction === 'inbound' ? 'inbound' : (b.direction === 'outbound' ? 'outbound' : null),
      call_type: b.call_type ? String(b.call_type).slice(0, 40) : null,
      call_log_id: callLogId,
      call_started_at: startedAt,
      duration_sec: duration,
      connected,
      outcome: b.outcome ? String(b.outcome).slice(0, 80) : null,
      followup_needed: !!b.followup_needed,
      drive_file_id: b.drive_file_id ? String(b.drive_file_id).slice(0, 200) : null,
      drive_file_url: b.drive_file_url ? String(b.drive_file_url).slice(0, 500) : null,
      matched_lead_id: link.matched_lead_id,
      matched_source: link.matched_source,
      transcript_status: b.drive_file_id ? 'pending' : (connected && duration >= 10 ? 'pending' : 'no_recording'),
      has_recording: !!b.has_recording,
      device_meta: b.device_meta && typeof b.device_meta === 'object' ? b.device_meta : null,
      updated_at: new Date().toISOString(),
    };

    if (row.drive_file_id) {
      const { data, error } = await supabaseAdmin
        .from('call_recordings')
        .upsert(row, { onConflict: 'drive_file_id' })
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (emitLore) emitCallLore(phone, startedAt, row, data?.id, duration, connected);
      return { ok: true, action: 'upserted', id: data?.id };
    }

    const { data, error } = await supabaseAdmin.from('call_recordings').insert(row).select('id').maybeSingle();
    if (error) throw error;
    if (emitLore) emitCallLore(phone, startedAt, row, data?.id, duration, connected);
    return { ok: true, action: 'inserted', id: data?.id };
  }

  function emitCallLore(phone, startedAt, row, callId, duration, connected) {
    if (process.env.LEAD_EVENTS_ENABLED === 'false') return;
    const callPayload = {
      direction: row.direction,
      duration_sec: duration,
      connected,
      call_type: row.call_type,
      outcome: row.outcome,
      followup_needed: row.followup_needed,
      rep_name: row.rep_name,
      drive_file_url: row.drive_file_url,
      call_id: callId || null,
      has_recording: row.has_recording,
    };
    supabaseAdmin.from('lead_events').insert({
      phone,
      ts: startedAt,
      event_type: 'call_recorded',
      source: 'call',
      payload: callPayload,
    }).then(() => {}, (e) => console.warn('[CALLS] lead_events emit failed:', e?.message));
  }

  async function phoneCallStats(phone) {
    const p = normCallPhone(phone);
    if (!p) return null;
    const { data, error } = await supabaseAdmin
      .from('call_recordings')
      .select('id, direction, call_type, connected, has_recording, drive_file_id, duration_sec, call_started_at, rep_name, outcome, transcript_status')
      .eq('phone', p)
      .order('call_started_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    const rows = data || [];
    const connectedRows = rows.filter(r => r.connected);
    return {
      phone: p,
      total_calls: rows.length,
      times_contacted: rows.length,
      times_connected: connectedRows.length,
      times_missed: rows.filter(r => r.call_type === 'missed' || (!r.connected && r.direction === 'inbound')).length,
      outbound: rows.filter(r => r.direction === 'outbound').length,
      inbound: rows.filter(r => r.direction === 'inbound').length,
      with_recording: rows.filter(r => r.has_recording || r.drive_file_id).length,
      transcribed: rows.filter(r => r.transcript_status === 'done').length,
      last_call_at: rows[0]?.call_started_at || null,
      calls: rows,
    };
  }

  return { upsertCallRow, phoneCallStats };
}
