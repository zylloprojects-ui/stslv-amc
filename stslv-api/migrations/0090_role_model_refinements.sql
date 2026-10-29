-- 0090_role_model_refinements
-- Revises the starting grants of 0087 after the review of 2026-10-29 (approved):
--
-- 1. Executive roles open only their own section's pages. The View grants they
--    held only for data shown inside their pages become data-only READ:
--      FINANCE_EXECUTIVE         AMC_SCHEDULE:VIEW -> AMC_SCHEDULE:READ
--                                (Invoice Tracking and Accounts show visit details)
--      AMC_OPERATIONS_EXECUTIVE  CLIENTS:VIEW      -> CLIENTS:READ
--                                (contract form, schedule and calendar client lists)
--                                INVOICES:VIEW     -> INVOICES:READ
--                                (Master AMC Status, AMC Management, contract and visit details)
--    Accounts and Master AMC Status keep working for these roles; the Schedule,
--    Clients, Invoice Tracking and Accounts pages no longer open for the other section.
-- 2. ADMINISTRATOR: role definitions are Super Admin only, so USERS:DELETE (which
--    only deleted roles) is removed. It needs no READ grant: View of a module covers
--    its data-only Read, also when Admin assigns a role holding Read.
-- 3. ADMIN (Super Admin) keeps every action of every module: it receives READ on
--    every module.
--
-- Requires 0087 and 0089. Idempotent; run again by the API tests after they empty
-- role_permissions. Assigns nobody. Only the grants named above are removed.
--
-- Reverse (only with approval): delete the READ grants of FINANCE_EXECUTIVE,
-- AMC_OPERATIONS_EXECUTIVE and ADMIN, re-insert AMC_SCHEDULE:VIEW (Finance),
-- CLIENTS:VIEW and INVOICES:VIEW (AMC Operations) and USERS:DELETE (Admin), then
--   DELETE FROM schema_migrations WHERE version = '0090';

DELETE FROM role_permissions rp
USING roles r
WHERE r.id = rp.role_id
  AND (
    (r.code = 'FINANCE_EXECUTIVE' AND rp.module = 'AMC_SCHEDULE' AND rp.action = 'VIEW')
    OR (r.code = 'AMC_OPERATIONS_EXECUTIVE' AND rp.module IN ('CLIENTS', 'INVOICES') AND rp.action = 'VIEW')
    OR (r.code = 'ADMINISTRATOR' AND rp.module = 'USERS' AND rp.action = 'DELETE')
  );

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, p.module, 'READ'
FROM (VALUES
  ('FINANCE_EXECUTIVE',        'AMC_SCHEDULE'),
  ('AMC_OPERATIONS_EXECUTIVE', 'CLIENTS'),
  ('AMC_OPERATIONS_EXECUTIVE', 'INVOICES')
) AS p (role_code, module)
JOIN roles r ON r.code = p.role_code
ON CONFLICT DO NOTHING;

-- Super Admin: READ on every module it holds.
INSERT INTO role_permissions (role_id, module, action)
SELECT DISTINCT rp.role_id, rp.module, 'READ'
FROM role_permissions rp
JOIN roles r ON r.id = rp.role_id
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;
