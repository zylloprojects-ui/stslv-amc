-- 0004_seed_roles_and_permissions
-- Seeds the five initial roles and a starting permission matrix.
-- Idempotent: every statement uses ON CONFLICT DO NOTHING.
--
-- ADMIN receives every module/action.
-- The matrix for the other four roles is PROVISIONAL. It follows the draft in
-- docs/PHASE1_SYSTEM_DESIGN.md section 12.3 and has not been approved by the
-- business (open question Q12). It is data: an Admin can change it in
-- Users & Access without a code change. No APPROVE, DELETE or EXPORT
-- permission is granted to a non-admin role, because no approval or export
-- rule has been confirmed.

INSERT INTO roles (code, name, description) VALUES
  ('ADMIN',       'Admin',       'Full access, including users, roles and settings.'),
  ('ACCOUNTANT',  'Accountant',  'Records project expenses and reviews financial information.'),
  ('PROCUREMENT', 'Procurement', 'Manages procurement for projects.'),
  ('EXECUTION',   'Execution',   'Carries out and updates AMC visits and site work.'),
  ('INVOICING',   'Invoicing',   'Records Zoho invoice details against completed work.')
ON CONFLICT (code) DO NOTHING;

-- ADMIN: every module x every action.
INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, m.module, a.action
FROM roles r
CROSS JOIN (VALUES
  ('DASHBOARD'), ('CLIENTS'), ('AMC_CONTRACTS'), ('AMC_SCHEDULE'), ('AMC_EXECUTION'),
  ('PROJECTS'), ('PROCUREMENT'), ('EXPENSES'), ('INVOICES'), ('REPORTS'), ('USERS'), ('SETTINGS')
) AS m (module)
CROSS JOIN (VALUES
  ('VIEW'), ('CREATE'), ('EDIT'), ('DELETE'), ('APPROVE'), ('EXPORT')
) AS a (action)
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

-- Other roles: provisional matrix.
INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, p.module, p.action
FROM (VALUES
  ('ACCOUNTANT',  'DASHBOARD',     'VIEW'),
  ('ACCOUNTANT',  'CLIENTS',       'VIEW'),
  ('ACCOUNTANT',  'AMC_CONTRACTS', 'VIEW'),
  ('ACCOUNTANT',  'AMC_SCHEDULE',  'VIEW'),
  ('ACCOUNTANT',  'PROJECTS',      'VIEW'),
  ('ACCOUNTANT',  'PROCUREMENT',   'VIEW'),
  ('ACCOUNTANT',  'EXPENSES',      'VIEW'),
  ('ACCOUNTANT',  'EXPENSES',      'CREATE'),
  ('ACCOUNTANT',  'EXPENSES',      'EDIT'),
  ('ACCOUNTANT',  'INVOICES',      'VIEW'),
  ('ACCOUNTANT',  'REPORTS',       'VIEW'),

  ('PROCUREMENT', 'DASHBOARD',     'VIEW'),
  ('PROCUREMENT', 'CLIENTS',       'VIEW'),
  ('PROCUREMENT', 'PROJECTS',      'VIEW'),
  ('PROCUREMENT', 'PROCUREMENT',   'VIEW'),
  ('PROCUREMENT', 'PROCUREMENT',   'CREATE'),
  ('PROCUREMENT', 'PROCUREMENT',   'EDIT'),
  ('PROCUREMENT', 'EXPENSES',      'VIEW'),

  ('EXECUTION',   'DASHBOARD',     'VIEW'),
  ('EXECUTION',   'CLIENTS',       'VIEW'),
  ('EXECUTION',   'AMC_CONTRACTS', 'VIEW'),
  ('EXECUTION',   'AMC_SCHEDULE',  'VIEW'),
  ('EXECUTION',   'AMC_EXECUTION', 'VIEW'),
  ('EXECUTION',   'AMC_EXECUTION', 'EDIT'),
  ('EXECUTION',   'PROJECTS',      'VIEW'),
  ('EXECUTION',   'PROCUREMENT',   'VIEW'),

  ('INVOICING',   'DASHBOARD',     'VIEW'),
  ('INVOICING',   'CLIENTS',       'VIEW'),
  ('INVOICING',   'AMC_CONTRACTS', 'VIEW'),
  ('INVOICING',   'AMC_SCHEDULE',  'VIEW'),
  ('INVOICING',   'PROJECTS',      'VIEW'),
  ('INVOICING',   'INVOICES',      'VIEW'),
  ('INVOICING',   'INVOICES',      'CREATE'),
  ('INVOICING',   'INVOICES',      'EDIT'),
  ('INVOICING',   'REPORTS',       'VIEW')
) AS p (role_code, module, action)
JOIN roles r ON r.code = p.role_code
ON CONFLICT DO NOTHING;
