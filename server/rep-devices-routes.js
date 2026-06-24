/**
 * Rep device fleet — remote recording path + setup status from dashboard.
 */
function computeSetupStatus(row, now = Date.now()) {
  const hb = row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : 0;
  const offline = !hb || now - hb > 48 * 3600000;
  if (offline) return 'offline';
  const configured = !!(row.recording_path || '').trim();
  const watching = Array.isArray(row.paths_watching) ? row.paths_watching.length : 0;
  if (!configured) return 'pending';
  if (watching === 0) return 'path_missing';
  if (row.last_upload_ok_at) return 'ready';
  return 'path_set';
}

export function registerRepDeviceRoutes(app, { CRM_API_KEY, supabaseAdmin }) {
  function auth(req, res) {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // App heartbeat + config pull (upsert by device_id)
  app.post('/api/rep-devices/heartbeat', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const deviceId = String(b.device_id || '').trim();
    if (!deviceId) return res.status(400).json({ success: false, error: 'device_id required' });

    try {
      const { data: existing } = await supabaseAdmin.from('rep_devices').select('*').eq('device_id', deviceId).maybeSingle();

      const now = new Date().toISOString();
      const row = {
        device_id: deviceId,
        rep_id: b.rep_id ? String(b.rep_id).slice(0, 80) : existing?.rep_id || null,
        rep_name: b.rep_name ? String(b.rep_name).slice(0, 120) : existing?.rep_name || null,
        manufacturer: b.manufacturer ? String(b.manufacturer).slice(0, 80) : existing?.manufacturer,
        device_model: b.device_model ? String(b.device_model).slice(0, 120) : existing?.device_model,
        android_sdk: b.android_sdk != null ? Number(b.android_sdk) : existing?.android_sdk,
        app_version: b.app_version ? String(b.app_version).slice(0, 40) : existing?.app_version,
        recording_path_local: b.recording_path_local ? String(b.recording_path_local).slice(0, 500) : existing?.recording_path_local,
        paths_watching: Array.isArray(b.paths_watching) ? b.paths_watching.slice(0, 20) : (existing?.paths_watching || []),
        google_account: b.google_account ? String(b.google_account).slice(0, 120) : existing?.google_account,
        permissions: b.permissions && typeof b.permissions === 'object' ? b.permissions : (existing?.permissions || {}),
        last_heartbeat_at: now,
        updated_at: now,
      };
      if (b.last_upload_ok) row.last_upload_ok_at = now;
      if (b.last_call_at) row.last_call_at = b.last_call_at;

      // Admin path on server wins — never overwrite from app
      row.recording_path = existing?.recording_path || null;
      row.device_label = existing?.device_label || null;
      row.upload_target = existing?.upload_target || 'supabase';
      row.notes = existing?.notes || null;

      row.setup_status = computeSetupStatus({ ...existing, ...row });

      const { data, error } = await supabaseAdmin.from('rep_devices').upsert(row).select('*').maybeSingle();
      if (error) throw error;

      return res.json({
        success: true,
        device: data,
        config: {
          recording_path: data.recording_path || null,
          device_label: data.device_label || null,
          upload_target: data.upload_target || 'supabase',
          setup_status: data.setup_status,
        },
      });
    } catch (err) {
      const hint = /(does not exist|schema cache)/i.test(err.message || '')
        ? 'Run create_rep_devices.sql in Supabase first.'
        : err.message;
      return res.status(500).json({ success: false, error: hint });
    }
  });

  app.get('/api/rep-devices', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { data, error } = await supabaseAdmin
        .from('rep_devices')
        .select('*')
        .order('last_heartbeat_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      const now = Date.now();
      const devices = (data || []).map(d => ({
        ...d,
        setup_status: computeSetupStatus(d, now),
      }));
      return res.json({ success: true, devices });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/rep-app/overview', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const now = Date.now();
      const { data: deviceRows, error: devErr } = await supabaseAdmin
        .from('rep_devices')
        .select('*')
        .order('last_heartbeat_at', { ascending: false, nullsFirst: false });
      if (devErr) throw devErr;

      const devices = (deviceRows || []).map(d => ({
        ...d,
        setup_status: computeSetupStatus(d, now),
      }));

      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);

      let calls = [];
      let callsErr = null;
      const { data: callRows, error: cErr } = await supabaseAdmin
        .from('call_recordings')
        .select('id, rep_id, rep_name, phone, direction, call_type, connected, has_recording, drive_file_id, duration_sec, call_started_at, outcome, transcript_status, device_meta')
        .order('call_started_at', { ascending: false })
        .limit(300);
      if (cErr && !/(does not exist|schema cache)/i.test(cErr.message || '')) callsErr = cErr.message;
      else calls = callRows || [];

      const todayCalls = calls.filter(c => c.call_started_at && new Date(c.call_started_at) >= dayStart);
      const connectedToday = todayCalls.filter(c => c.connected).length;
      const recordedToday = todayCalls.filter(c => c.has_recording || c.drive_file_id).length;

      const online = devices.filter(d => d.setup_status !== 'offline').length;
      const ready = devices.filter(d => d.setup_status === 'ready').length;
      const pending = devices.filter(d => d.setup_status === 'pending' || d.setup_status === 'path_missing').length;

      const statsByRep = {};
      for (const c of calls) {
        const key = c.rep_id || c.rep_name || 'unknown';
        if (!statsByRep[key]) {
          statsByRep[key] = {
            rep_id: c.rep_id,
            rep_name: c.rep_name,
            total: 0,
            connected: 0,
            outbound: 0,
            inbound: 0,
            missed: 0,
            with_recording: 0,
            today: 0,
          };
        }
        const s = statsByRep[key];
        s.total += 1;
        if (c.connected) s.connected += 1;
        if (c.direction === 'outbound') s.outbound += 1;
        if (c.direction === 'inbound') s.inbound += 1;
        if (c.call_type === 'missed') s.missed += 1;
        if (c.has_recording || c.drive_file_id) s.with_recording += 1;
        if (c.call_started_at && new Date(c.call_started_at) >= dayStart) s.today += 1;
      }

      const devicesEnriched = devices.map(d => ({
        ...d,
        call_stats: statsByRep[d.rep_id] || statsByRep[d.rep_name] || {
          rep_id: d.rep_id,
          rep_name: d.rep_name,
          total: 0, connected: 0, outbound: 0, inbound: 0, missed: 0, with_recording: 0, today: 0,
        },
        path_mismatch: !!(d.recording_path && d.recording_path_local && d.recording_path.trim() !== d.recording_path_local.trim()),
      }));

      return res.json({
        success: true,
        fleet: {
          devices_total: devices.length,
          online,
          ready,
          pending,
          offline: devices.length - online,
          calls_today: todayCalls.length,
          connected_today: connectedToday,
          recorded_today: recordedToday,
          calls_total: calls.length,
        },
        devices: devicesEnriched,
        recent_calls: calls.slice(0, 80),
        calls_available: !callsErr,
        calls_error: callsErr,
      });
    } catch (err) {
      const hint = /(does not exist|schema cache)/i.test(err.message || '')
        ? 'Run create_rep_devices.sql (and call_recordings migration) in Supabase first.'
        : err.message;
      return res.status(500).json({ success: false, error: hint });
    }
  });

  app.patch('/api/rep-devices/:deviceId', async (req, res) => {
    if (!auth(req, res)) return;
    const deviceId = req.params.deviceId;
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.device_label != null) patch.device_label = String(b.device_label).slice(0, 120);
    if (b.recording_path != null) patch.recording_path = b.recording_path ? String(b.recording_path).slice(0, 500) : null;
    if (b.google_account != null) patch.google_account = b.google_account ? String(b.google_account).slice(0, 120) : null;
    if (b.upload_target != null) patch.upload_target = String(b.upload_target).slice(0, 40);
    if (b.notes != null) patch.notes = b.notes ? String(b.notes).slice(0, 1000) : null;

    try {
      const { data: existing, error: getErr } = await supabaseAdmin.from('rep_devices').select('*').eq('device_id', deviceId).maybeSingle();
      if (getErr) throw getErr;
      if (!existing) return res.status(404).json({ success: false, error: 'Device not registered yet — rep must open app first.' });

      patch.setup_status = computeSetupStatus({ ...existing, ...patch });
      const { data, error } = await supabaseAdmin.from('rep_devices').update(patch).eq('device_id', deviceId).select('*').maybeSingle();
      if (error) throw error;
      return res.json({ success: true, device: data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}

export { computeSetupStatus };
