import { supabaseAdmin } from '../../server/supabase-admin.js';

/**
 * Calculates the number of completed qualification parameters.
 * city, insurance, preferred_surgery_city, timeline
 */
export const calculateParametersCompleted = (lead) => {
    const fields = ['city', 'insurance', 'preferred_surgery_city', 'timeline'];
    return fields.reduce((count, field) => {
        return lead[field] && String(lead[field]).trim() !== '' ? count + 1 : count;
    }, 0);
};

/**
 * Checks for a lead with the same phone number created in the last 24 hours.
 */
export const checkDuplicate = async (phoneNumber) => {
    if (!phoneNumber) return null;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
        .from('leads_surgery')
        .select('id, remarks')
        .eq('phone_number', phoneNumber)
        .gt('created_at', twentyFourHoursAgo)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error('Error checking duplicate:', error);
        return null;
    }

    return data;
};

/**
 * Ingests a lead into the system. 
 * Handles duplicate checks, parameter counting, and fallback remarks.
 */
export const ingestLead = async (leadData) => {
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
        intent_score,        // Bot v3 metadata
        intent_band,         // Bot v3 metadata -> maps to intent_level
        ingestion_trigger,   // Bot v3 metadata
        last_activity_at,    // Bot v3 metadata
        lead_type = 'surgery'
    } = leadData;

    const parameters_completed = calculateParametersCompleted(leadData);

    // Handle bot fallback remark
    let remarks = leadData.remarks || '';
    if (bot_fallback) {
        const fallbackMsg = "Bot could not understand user query.";
        remarks = remarks ? `${remarks}\n${fallbackMsg}` : fallbackMsg;
    }

    const existingLead = await checkDuplicate(phone_number);

    const payload = {
        phone_number,
        contact_name,
        city,
        insurance,
        preferred_surgery_city,
        timeline,
        source: 'chatbot',
        lead_type,
        parameters_completed,
        last_user_message,
        user_questions,
        bot_fallback,
        remarks,
        intent_level: intent_band, // Handled: maps to existing HOT/WARM/COLD band
        created_at: existingLead ? undefined : new Date().toISOString()
    };

    if (existingLead) {
        // Update existing lead
        const { data, error } = await supabaseAdmin
            .from('leads_surgery')
            .update(payload)
            .eq('id', existingLead.id)
            .select()
            .single();

        if (error) throw error;
        return { data, action: 'updated' };
    } else {
        // Insert new lead
        const { data, error } = await supabaseAdmin
            .from('leads_surgery')
            .insert([payload])
            .select()
            .single();

        if (error) throw error;
        return { data, action: 'inserted' };
    }
};
