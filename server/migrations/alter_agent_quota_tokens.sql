-- Track real Gemini token usage from usageMetadata on each API response.
ALTER TABLE public.agent_quota
  ADD COLUMN IF NOT EXISTS tokens_prompt   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_output   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_thinking integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_total    integer NOT NULL DEFAULT 0;
