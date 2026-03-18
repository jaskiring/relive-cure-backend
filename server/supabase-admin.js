import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

console.log("[DEBUG] SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("[DEBUG] SERVICE ROLE KEY LENGTH:", process.env.SUPABASE_SERVICE_ROLE_KEY?.length);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('Missing Supabase environment variables');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[CRITICAL] SERVICE ROLE KEY IS MISSING");
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);
