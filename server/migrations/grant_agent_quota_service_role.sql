-- Backend uses service_role; agent_quota upserts were failing silently without this grant.
GRANT ALL ON TABLE public.agent_quota TO service_role;
REVOKE ALL ON TABLE public.agent_quota FROM anon;
REVOKE ALL ON TABLE public.agent_quota FROM authenticated;
