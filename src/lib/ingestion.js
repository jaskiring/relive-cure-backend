export const calculateParametersCompleted = (lead) => {
    // Count qualification parameters the bot captures.
    // contact_name removed from scoring — it's now always 'WhatsApp Lead' since name collection
    // was removed (leads get stuck at NAME). The 5 qualifying params are:
    //   city (asked), eye_power (asked), insurance (passive), timeline (passive), request_call (explicit intent)
    const fields = [
        'city',                    // Bot asks first
        'eye_power',               // Bot asks second (main qualifying question)
        'insurance',               // Passive capture from user messages
        'timeline',                // Passive capture from user messages
    ];
    // request_call counts as the 5th parameter — explicit callback = highest intent signal
    if (lead.request_call) return Math.min(5, fields.reduce((c, f) => {
        const val = lead[f]; if (!val) return c;
        const str = String(val).trim();
        if (!str || str === 'WhatsApp Lead') return c;
        if (f === 'eye_power' && typeof val === 'object' && val.raw) return c + 1;
        return str ? c + 1 : c;
    }, 0) + 1); // +1 for request_call
    let count = 0;
    for (const field of fields) {
        const val = lead[field];
        if (!val) continue;
        const str = String(val).trim();
        if (!str || str === 'WhatsApp Lead') continue;
        // For eye_power, it might be a JSON object from parseEyePower
        if (field === 'eye_power' && typeof val === 'object' && val.raw) { count++; continue; }
        if (str) count++;
    }
    return count;
};

const INTENT_RANK = { cold: 0, warm: 1, hot: 2 };

export function detectSignals(oldRow, newPayload) {
    if (!oldRow) return [];
    const signals = [];

    const oldIntent = (oldRow.intent_level || 'cold').toLowerCase();
    const newIntent = (newPayload.intent_level || 'cold').toLowerCase();
    const oldRank = INTENT_RANK[oldIntent] ?? 0;
    const newRank = INTENT_RANK[newIntent] ?? 0;

    if (!oldRow.request_call && newPayload.request_call === true)
        signals.push({ signal_type: 'request_call_raised', old_value: 'false', new_value: 'true', payload: {} });

    if (newRank === 2 && oldRank < 2)
        signals.push({ signal_type: 'intent_hot', old_value: oldIntent, new_value: newIntent, payload: {} });
    else if (newRank > oldRank)
        signals.push({ signal_type: 'intent_level_up', old_value: oldIntent, new_value: newIntent, payload: {} });

    const oldScore = oldRow.intent_score || 0;
    const newScore = newPayload.intent_score || 0;
    if (newScore - oldScore >= 20)
        signals.push({ signal_type: 'score_jump', old_value: String(oldScore), new_value: String(newScore), payload: { delta: newScore - oldScore } });

    for (const field of ['concern_pain', 'concern_safety', 'concern_power']) {
        if (!oldRow[field] && newPayload[field] === true)
            signals.push({ signal_type: 'concern_new', old_value: 'false', new_value: 'true', payload: { field } });
    }

    return signals;
}

export const checkDuplicate = async (supabaseClient, phoneNumber) => {
    if (!phoneNumber) return null;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseClient
        .from('leads_surgery')
        .select('id, remarks')
        .eq('phone_number', phoneNumber)
        .gt('created_at', twentyFourHoursAgo)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error('[DB] ❌ Error checking duplicate:', error.message);
        return null;
    }

    return data;
};

export const ingestLead = async (supabaseClient, leadData) => {
    const {
        phone_number,
        contact_name,
        city,
        insurance,
        preferred_surgery_city,
        timeline,
        last_user_message,
        user_questions,
        bot_fallback,
        intent_band,
        lead_type = 'surgery',
        interest_cost,
        interest_recovery,
        concern_pain,
        concern_safety,
        urgency_level,
        is_returning,
        bot_version,
        language,
        message_count,
        first_message_at,
        last_message_at,
        current_flow_state,
        callback_source
    } = leadData;

    if (!phone_number) {
        throw new Error('phone_number is required for ingestion');
    }

    const parameters_completed = calculateParametersCompleted(leadData);

    let score = parameters_completed * 10;
    if ((leadData.intent_level || '').toUpperCase() === 'HOT') score += 50;
    if ((leadData.urgency_level || '').toLowerCase() === 'high') score += 20;
    if (leadData.request_call === true) score += 20;
    const intent_score = Math.min(score, 100);

    const calculateIntent = (comp, time) => {
        if (comp >= 3 && (time || '').toLowerCase().includes('immediately')) return 'hot';
        if (comp >= 2) return 'warm';
        return 'cold';
    };

    const finalIntentLevel = (leadData.intent_level || intent_band || calculateIntent(parameters_completed, timeline)).toLowerCase();

    let remarks = leadData.remarks || '';
    if (bot_fallback) {
        const fallbackMsg = "Bot could not understand user query.";
        remarks = remarks ? `${remarks}\n${fallbackMsg}` : fallbackMsg;
    }

    const payload = {
        phone_number,
        contact_name: contact_name || 'WhatsApp Lead',
        city,
        insurance,
        preferred_surgery_city,
        timeline,
        source: leadData.source || 'chatbot',
        lead_type,
        parameters_completed,
        intent_score,
        last_user_message: (last_user_message || '').substring(0, 1000),
        user_questions,
        bot_fallback,
        remarks,
        intent_level: finalIntentLevel,
        request_call: leadData.request_call || false,
        ingestion_trigger: leadData.ingestion_trigger || 'unknown',
        concern_power: !!leadData.concern_power,
        last_activity_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
        
        // Trilingual Tracking Fields
        bot_version: bot_version || leadData.bot_version || null,
        language: language || leadData.language || 'EN',
        message_count: message_count || leadData.message_count || null,
        first_message_at: first_message_at || leadData.first_message_at || null,
        last_message_at: last_message_at || leadData.last_message_at || null,
        current_flow_state: current_flow_state || leadData.current_flow_state || null,
        callback_source: callback_source || leadData.callback_source || null
    };

    console.log('[DB] Final Payload:', JSON.stringify(payload, null, 2));

    if (interest_cost !== undefined)     payload.interest_cost = interest_cost;
    if (interest_recovery !== undefined) payload.interest_recovery = interest_recovery;
    if (concern_pain !== undefined)      payload.concern_pain = concern_pain;
    if (concern_safety !== undefined)    payload.concern_safety = concern_safety;
    if (urgency_level)                   payload.urgency_level = urgency_level;
    if (is_returning !== undefined)      payload.is_returning = is_returning;

    // Fetch old row before upsert so detectSignals can diff (best-effort — failure = no signals).
    let oldRow = null;
    if (process.env.LEAD_EVENTS_ENABLED !== 'false') {
        try {
            const { data: _old } = await supabaseClient
                .from('leads_surgery')
                .select('intent_level, intent_score, request_call, concern_pain, concern_safety, concern_power')
                .eq('phone_number', phone_number)
                .maybeSingle();
            oldRow = _old;
        } catch (_e) { /* non-fatal — skip signal detection */ }
    }

    console.log(`[DB] Upserting lead | phone=${phone_number}`);

    const { data, error } = await supabaseClient
        .from('leads_surgery')
        .upsert(payload, {
            onConflict: 'phone_number',
            ignoreDuplicates: false
        })
        .select()
        .single();

    if (error) {
        console.error('[DB] ❌ Upsert failed:', error.message);
        throw error;
    }

    const action = data ? 'UPSERTED' : 'SKIPPED';
    console.log(`[DB] Success | action=${action} | id=${data?.id || 'N/A'}`);

    if (process.env.LEAD_EVENTS_ENABLED !== 'false') {
      // Fire-and-forget lore event.
      supabaseClient.from('lead_events').insert({
        phone:      phone_number,
        ts:         new Date().toISOString(),
        event_type: 'bot_signal',
        source:     'bot',
        payload: {
          parameters_completed: payload.parameters_completed,
          intent_score:         payload.intent_score,
          intent_level:         payload.intent_level,
          request_call:         payload.request_call,
          ingestion_trigger:    payload.ingestion_trigger,
        },
      }).then(() => {}).catch(e => console.error('[LORE] ingest lead_events failed:', e.message));

      // Fire-and-forget signal detection — never throws into upsert path.
      const signals = detectSignals(oldRow, payload);
      if (signals.length > 0) {
        console.log(`[SIGNALS] Detected ${signals.length} signal(s) for ${phone_number}:`, signals.map(s => s.signal_type).join(', '));
        supabaseClient.from('lead_signals').insert(
          signals.map(s => ({ phone: phone_number, ...s, detected_at: new Date().toISOString() }))
        ).then(() => {}).catch(e => console.error('[SIGNALS] lead_signals insert failed:', e.message));
      }
    }

    return { data, action: action.toLowerCase() };
};
