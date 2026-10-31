-- 0092_seed_independent_page_permissions
-- Keeps every role's access as it is when the pages move to their own modules (0091). Additive and
-- idempotent: each role receives only what it could already do, worked out from its saved grants.
-- Removes no grant, changes no role assignment. The old grants stay and keep their other meanings.
--
--   MASTER_AMC_STATUS:VIEW    held AMC_SCHEDULE:VIEW, SERVICES_SALES:VIEW and INVOICES View or Read
--   MASTER_AMC_STATUS:EXPORT  the above, and AMC_SCHEDULE:EXPORT
--   ACCOUNTS:VIEW             held INVOICES:VIEW and AMC_SCHEDULE View or Read
--   ACCOUNTS:EXPORT           the above, and INVOICES:EXPORT
--   SUGGESTIONS:VIEW, CREATE  every existing role: every signed-in user could already submit
--   SUGGESTIONS_REVIEW:VIEW, EDIT  ADMIN and ADMINISTRATOR, the reviewers until now
--   ADMIN                     every action of the four modules (full access, as for every module)
--
-- A role created after this starts with none of them. Built-in role descriptions are updated only
-- while they are still the text migration 0087 wrote; an edited description is left alone.
--
-- Reverse (only with approval):
--   DELETE FROM role_permissions WHERE module IN ('MASTER_AMC_STATUS', 'ACCOUNTS', 'SUGGESTIONS', 'SUGGESTIONS_REVIEW');
--   then restore the descriptions below, and DELETE FROM schema_migrations WHERE version = '0092';

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'MASTER_AMC_STATUS', 'VIEW'
FROM roles r
WHERE EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'AMC_SCHEDULE' AND p.action = 'VIEW')
  AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'SERVICES_SALES' AND p.action = 'VIEW')
  AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'INVOICES' AND p.action IN ('VIEW', 'READ'))
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'MASTER_AMC_STATUS', 'EXPORT'
FROM roles r
WHERE EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'MASTER_AMC_STATUS' AND p.action = 'VIEW')
  AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'AMC_SCHEDULE' AND p.action = 'EXPORT')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'ACCOUNTS', 'VIEW'
FROM roles r
WHERE EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'INVOICES' AND p.action = 'VIEW')
  AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'AMC_SCHEDULE' AND p.action IN ('VIEW', 'READ'))
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'ACCOUNTS', 'EXPORT'
FROM roles r
WHERE EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'ACCOUNTS' AND p.action = 'VIEW')
  AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.module = 'INVOICES' AND p.action = 'EXPORT')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'SUGGESTIONS', a.action
FROM roles r CROSS JOIN (VALUES ('VIEW'), ('CREATE')) AS a (action)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, 'SUGGESTIONS_REVIEW', a.action
FROM roles r CROSS JOIN (VALUES ('VIEW'), ('EDIT')) AS a (action)
WHERE r.code IN ('ADMIN', 'ADMINISTRATOR')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, m.module, a.action
FROM roles r
CROSS JOIN (VALUES ('MASTER_AMC_STATUS'), ('ACCOUNTS'), ('SUGGESTIONS'), ('SUGGESTIONS_REVIEW')) AS m (module)
CROSS JOIN (VALUES ('VIEW'), ('CREATE'), ('EDIT'), ('DELETE'), ('APPROVE'), ('EXPORT'), ('READ')) AS a (action)
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

UPDATE roles r SET description = v.new_text
FROM (VALUES
  ('FINANCE_EXECUTIVE', 'Finance section: Invoice Tracking and Accounts.',
   'Starts with Invoice Tracking and Accounts. Super Admin can add permissions on other modules.'),
  ('MASTER_DATA_EXECUTIVE', 'Master Data Center: clients, sales engineers, system types, maintenance frequencies and departments.',
   'Starts with the Master Data Center. Super Admin can add permissions on other modules.'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC Operations: contracts, renewals, schedule, calendar, service status, visit execution and services sales.',
   'Starts with AMC Operations. Super Admin can add permissions on other modules.'),
  ('VIEWER', 'Read-only access to the business modules it is given. View and Export only.',
   'Starts with View on the business modules. Super Admin can grant more.')
) AS v (code, old_text, new_text)
WHERE r.code = v.code AND r.description = v.old_text;
