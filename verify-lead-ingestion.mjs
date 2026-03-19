import 'dotenv/config';
import { supabaseAdmin } from './server/supabase-admin.js';

async function checkLead() {
  const phone = '918888888888';
  console.log(`[DB VERIFY] Checking lead: ${phone}`);
  
  try {
    const { data, error } = await supabaseAdmin
      .from('leads_surgery')
      .select('*')
      .eq('phone_number', phone)
      .maybeSingle();
      
    if (error) {
      console.error('[DB VERIFY] ❌ Error:', error.message);
    } else if (data) {
      console.log('[DB VERIFY] ✅ Found Lead:', JSON.stringify(data, null, 2));
    } else {
      console.log('[DB VERIFY] 🕵️ Lead not found.');
    }
  } catch (e) {
    console.error('[DB VERIFY] ❌ Unexpected error:', e.message);
  }
}

checkLead();
