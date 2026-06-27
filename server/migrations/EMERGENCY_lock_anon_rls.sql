-- ════════════════════════════════════════════════════════════════════════════
-- EMERGENCY DATA-LEAK LOCKDOWN  — run in Supabase SQL editor NOW.
--
-- WHY: the public anon key (shipped in the dashboard JS) can currently read
-- every table — refrens_leads (4,674), leads_surgery (patient PII), hr_salary
-- (salaries), employees — because RLS is OFF. Anyone on the internet can dump it.
--
-- WHAT THIS DOES: enables RLS + revokes anon/authenticated on every public table
-- and view. With no policies, RLS denies anon/authenticated all access.
--
-- SAFE FOR THE BACKEND: the server uses the SERVICE-ROLE key, which BYPASSES RLS
-- and keeps its grants — so the WhatsApp bot, CRM push, 4h sync, and all
-- /api/* endpoints keep working unchanged.
--
-- BREAKS (intentionally): any dashboard tab that reads Supabase DIRECTLY with the
-- anon key (HR module, and parts of Chatbot/Analytics/Inbox). Those reads must be
-- moved to authenticated backend endpoints (Phase 1). A broken tab is acceptable;
-- a world-readable patient + salary database is not.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE r RECORD;
BEGIN
  -- Tables: enable RLS (deny-all to non-bypass roles) + revoke direct grants.
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', r.tablename);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated;', r.tablename);
  END LOOP;

  -- Views (e.g. unified_leads) don't have RLS — revoke the grants directly.
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated;', r.viewname);
  END LOOP;
END $$;

-- Stop future auto-grants to anon/authenticated on new tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

-- ── VERIFY (run after): should now return 401 / permission denied, NOT data ──
-- curl -s -o /dev/null -w "%{http_code}\n" \
--   'https://<ref>.supabase.co/rest/v1/leads_surgery?select=id&limit=1' \
--   -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
-- Expect 401 or empty. If you still get 200 + rows, RLS didn't apply — re-check.
