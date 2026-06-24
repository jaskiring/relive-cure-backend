-- Grant Rep Application tab to admin users (idempotent).
UPDATE dashboard_users
SET allowed_tabs = array_append(allowed_tabs, 'repapp')
WHERE role = 'admin'
  AND NOT ('repapp' = ANY(allowed_tabs));
