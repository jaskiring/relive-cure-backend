-- Extend unified_leads with HR payroll fields (date_closed, refrens_created_at, customer_city alias).
-- Safe to run: DROP + CREATE VIEW only.

DROP VIEW IF EXISTS public.unified_leads;
CREATE VIEW public.unified_leads AS
SELECT
  COALESCE(r.phone, ls.phone_number, wc.phone)               AS phone,
  COALESCE(r.contact_name, ls.contact_name, wc.contact_name) AS contact_name,

  r.id                                                        AS refrens_id,
  r.status                                                    AS refrens_status,
  r.labels                                                    AS refrens_labels,
  r.lead_source                                               AS lead_source,
  r.date_closed                                               AS date_closed,
  r.refrens_created_at                                        AS refrens_created_at,
  r.customer_city                                             AS refrens_city,
  r.customer_city                                             AS customer_city,
  ls.refrens_lead_url                                         AS refrens_lead_url,
  ls.refrens_lead_id                                          AS ls_refrens_lead_id,

  ls.id                                                       AS ls_id,
  ls.intent_level                                             AS intent_level,
  ls.intent_score                                             AS intent_score,
  ls.parameters_completed                                     AS parameters_completed,
  ls.request_call                                             AS request_call,
  ls.pushed_to_crm                                            AS pushed_to_crm,
  ls.status                                                   AS ls_status,
  ls.city                                                     AS city,
  ls.last_activity_at                                         AS last_activity_at,
  ls.bot_version                                              AS bot_version,

  wc.contact_name                                             AS wa_contact_name,
  wc.last_message_at                                          AS last_message_at,

  COALESCE(r.assignee, ls.assignee)                           AS assignee,
  COALESCE(ls.last_user_message, r.last_internal_note)        AS last_user_message,
  COALESCE(ls.last_activity_at, r.refrens_created_at, wc.last_message_at) AS best_created_at,

  (ls.id IS NOT NULL)                                         AS has_bot_lead,
  (r.id  IS NOT NULL)                                         AS has_refrens_lead,
  (wc.phone IS NOT NULL)                                      AS has_whatsapp

FROM            refrens_leads          r
FULL OUTER JOIN leads_surgery          ls ON r.phone = ls.phone_number
LEFT       JOIN whatsapp_conversations wc ON COALESCE(r.phone, ls.phone_number) = wc.phone;

GRANT SELECT ON public.unified_leads TO anon, authenticated, service_role;
