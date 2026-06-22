-- Tab access requests: non-admin users request tabs; admin approves or denies.
CREATE TABLE IF NOT EXISTS dashboard_tab_requests (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username    TEXT NOT NULL,
    tab         TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'denied')),
    created_at  TIMESTAMPTZ DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_tab_requests_pending_uidx
    ON dashboard_tab_requests (username, tab)
    WHERE status = 'pending';

ALTER TABLE dashboard_tab_requests DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.dashboard_tab_requests TO service_role;
REVOKE ALL ON TABLE public.dashboard_tab_requests FROM anon;
REVOKE ALL ON TABLE public.dashboard_tab_requests FROM authenticated;
