GRANT ALL PRIVILEGES ON TABLE wa_lines TO service_role;
GRANT ALL PRIVILEGES ON TABLE organic_leads TO service_role;
GRANT ALL PRIVILEGES ON TABLE agent_jobs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE organic_leads_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE agent_jobs_id_seq TO service_role;
