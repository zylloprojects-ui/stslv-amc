-- 0079_seed_services_sales_permission
-- STAGED, NOT APPLIED. Requires 0078 (the SERVICES_SALES module). Move both
-- into migrations/ together.
-- Idempotent: ON CONFLICT DO NOTHING, so tests can run it again after a reset.
--
-- ADMIN receives every action, like every other module.
-- INVOICING may view and record quotation numbers: approved 2026-10-27
-- (Services Sales approval, Option A).
-- Least privilege for the other roles: ACCOUNTANT and EXECUTION may view only,
-- in line with the view access they already hold on the AMC schedule.
-- PROCUREMENT has no AMC access and receives nothing.
-- EXPORT goes to ADMIN only, as for every other module (0004): no export rule
-- has been confirmed for other roles. Any further grant is made by an Admin in
-- Users & Access.

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'SERVICES_SALES', a.action
FROM roles r
CROSS JOIN (VALUES
  ('VIEW'), ('CREATE'), ('EDIT'), ('DELETE'), ('APPROVE'), ('EXPORT')
) AS a (action)
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'SERVICES_SALES', p.action
FROM (VALUES
  ('INVOICING',  'VIEW'),
  ('INVOICING',  'EDIT'),
  ('ACCOUNTANT', 'VIEW'),
  ('EXECUTION',  'VIEW')
) AS p (role_code, action)
JOIN roles r ON r.code = p.role_code
ON CONFLICT DO NOTHING;
