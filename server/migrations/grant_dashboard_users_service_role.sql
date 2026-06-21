-- Grant backend (service_role) full access; revoke client roles (password hashes)
GRANT ALL ON TABLE public.dashboard_users TO service_role;
REVOKE ALL ON TABLE public.dashboard_users FROM anon;
REVOKE ALL ON TABLE public.dashboard_users FROM authenticated;
