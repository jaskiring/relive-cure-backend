-- Optional: canonical Refrens assignee name per employee (improves payroll matching).
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS crm_assignee TEXT;
