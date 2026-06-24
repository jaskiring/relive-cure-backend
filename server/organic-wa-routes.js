/**
 * Marketing · Organic + multi-line WhatsApp API routes.
 */
export function registerOrganicWaRoutes(app, { CRM_API_KEY, supabaseAdmin, saveWhatsAppMessage }) {
  function auth(req, res) {
    if (req.headers['x-crm-key'] !== CRM_API_KEY) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  function slugId(label) {
    return String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || `rep_${Date.now()}`;
  }

  // ─── WA lines ─────────────────────────────────────────────────────────────
  app.get('/api/wa-lines', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { data, error } = await supabaseAdmin.from('wa_lines').select('*').order('created_at', { ascending: true });
      if (error) throw error;
      return res.json({ success: true, lines: data || [] });
    } catch (err) {
      const hint = /(does not exist|schema cache)/i.test(err.message || '')
        ? 'Run create_wa_lines.sql in Supabase first.'
        : err.message;
      return res.status(500).json({ success: false, error: hint });
    }
  });

  app.post('/api/wa-lines', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    const label = String(b.label || '').trim();
    if (!label) return res.status(400).json({ success: false, error: 'label required' });
    const id = b.id ? String(b.id).trim() : slugId(label);
    if (id === 'bot') return res.status(400).json({ success: false, error: 'Reserved id' });
    const row = {
      id,
      label,
      kind: 'rep',
      rep_id: b.rep_id ? String(b.rep_id).slice(0, 80) : null,
      phone_display: b.phone_display ? String(b.phone_display).slice(0, 20) : null,
      bridge_status: 'disconnected',
      updated_at: new Date().toISOString(),
    };
    try {
      const { data, error } = await supabaseAdmin.from('wa_lines').upsert(row).select('*').maybeSingle();
      if (error) throw error;
      return res.json({ success: true, line: data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/wa-bridge/qr', async (req, res) => {
    if (!auth(req, res)) return;
    const { line_id, qr_data_url, status } = req.body || {};
    if (!line_id) return res.status(400).json({ success: false, error: 'line_id required' });
    try {
      const patch = {
        qr_data_url: qr_data_url || null,
        qr_updated_at: new Date().toISOString(),
        bridge_status: status || 'qr_pending',
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await supabaseAdmin.from('wa_lines').update(patch).eq('id', line_id).select('*').maybeSingle();
      if (error) throw error;
      return res.json({ success: true, line: data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/wa-bridge/status', async (req, res) => {
    if (!auth(req, res)) return;
    const { line_id, status, phone_display } = req.body || {};
    if (!line_id) return res.status(400).json({ success: false, error: 'line_id required' });
    try {
      const patch = {
        bridge_status: status || 'connected',
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (phone_display) patch.phone_display = String(phone_display).slice(0, 20);
      if (status === 'connected') patch.qr_data_url = null;
      const { data, error } = await supabaseAdmin.from('wa_lines').update(patch).eq('id', line_id).select('*').maybeSingle();
      if (error) throw error;
      return res.json({ success: true, line: data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/wa-bridge/ingest', async (req, res) => {
    if (!auth(req, res)) return;
    if (process.env.WA_LINES_ENABLED !== 'true') {
      return res.status(503).json({
        success: false,
        error: 'WA_LINES_ENABLED is not set — bot path unchanged. Run migrations, then set WA_LINES_ENABLED=true on Railway.',
      });
    }
    const b = req.body || {};
    const lineId = String(b.line_id || '').trim();
    if (!lineId) return res.status(400).json({ success: false, error: 'line_id required' });
    if (!b.phone) return res.status(400).json({ success: false, error: 'phone required' });
    const direction = b.direction === 'outbound' ? 'outbound' : 'inbound';
    await saveWhatsAppMessage({
      phone: b.phone,
      direction,
      body: b.body || null,
      msgType: b.msg_type || 'text',
      waMessageId: b.wa_message_id || null,
      contactName: b.contact_name || null,
      waTimestamp: b.wa_timestamp || null,
      waLineId: lineId,
      loreSource: direction === 'inbound' ? 'customer' : 'rep',
    });
    return res.json({ success: true });
  });

  // ─── Organic leads ────────────────────────────────────────────────────────
  app.get('/api/organic-leads', async (req, res) => {
    if (!auth(req, res)) return;
    const status = req.query.status ? String(req.query.status) : null;
    try {
      let q = supabaseAdmin.from('organic_leads').select('*').order('created_at', { ascending: false }).limit(200);
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ success: true, leads: data || [] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.patch('/api/organic-leads/:id', async (req, res) => {
    if (!auth(req, res)) return;
    const id = req.params.id;
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.status) patch.status = String(b.status).slice(0, 40);
    if (b.phone != null) patch.phone = b.phone ? String(b.phone).slice(0, 20) : null;
    if (b.assigned_rep != null) patch.assigned_rep = b.assigned_rep ? String(b.assigned_rep).slice(0, 80) : null;
    if (b.status === 'contacted') patch.contacted_at = new Date().toISOString();
    try {
      const { data, error } = await supabaseAdmin.from('organic_leads').update(patch).eq('id', id).select('*').maybeSingle();
      if (error) throw error;
      return res.json({ success: true, lead: data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/organic-leads', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    if (!b.platform) return res.status(400).json({ success: false, error: 'platform required' });
    const row = {
      platform: String(b.platform).slice(0, 20),
      username: b.username ? String(b.username).slice(0, 80) : null,
      display_name: b.display_name ? String(b.display_name).slice(0, 120) : null,
      raw_text: b.raw_text ? String(b.raw_text).slice(0, 2000) : null,
      post_hint: b.post_hint ? String(b.post_hint).slice(0, 200) : null,
      screenshot_path: b.screenshot_path ? String(b.screenshot_path).slice(0, 500) : null,
      parsed_at: b.parsed_at || new Date().toISOString(),
      metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
    };
    try {
      const { data, error } = await supabaseAdmin.from('organic_leads').insert(row).select('*').maybeSingle();
      if (error) throw error;
      return res.json({ success: true, lead: data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── Agent jobs ───────────────────────────────────────────────────────────
  app.get('/api/agent-jobs', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { data, error } = await supabaseAdmin.from('agent_jobs').select('*').order('agent_key');
      if (error) throw error;
      return res.json({ success: true, jobs: data || [] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.patch('/api/agent-jobs/:key', async (req, res) => {
    if (!auth(req, res)) return;
    const key = req.params.key;
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.config && typeof b.config === 'object') patch.config = b.config;
    try {
      const { data, error } = await supabaseAdmin.from('agent_jobs').update(patch).eq('agent_key', key).select('*').maybeSingle();
      if (error) throw error;
      return res.json({ success: true, job: data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/organic/re-engage', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { data, error } = await supabaseAdmin
        .from('refrens_leads')
        .select('id, name, phone, status, lead_source, updated_at')
        .or('status.ilike.%deal done%,status.ilike.%won%')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const sixMoAgo = Date.now() - 180 * 86400000;
      const candidates = (data || []).filter(l => {
        const t = l.updated_at ? new Date(l.updated_at).getTime() : 0;
        return t > 0 && t < sixMoAgo;
      });
      return res.json({ success: true, candidates });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}
