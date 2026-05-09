export const calculateParametersCompleted = (lead) => {
    const fields = ['city', 'insurance', 'preferred_surgery_city', 'timeline'];
    return fields.reduce((count, field) => {
        return lead[field] && String(lead[field]).trim() !== '' ? count + 1 : count;
    }, 0);
};

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
    return { data, action: action.toLowerCase() };
};
