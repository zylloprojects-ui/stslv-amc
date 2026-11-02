-- 0087_six_role_model
-- The six-role model (approved 2026-10-29):
--   ADMIN                    "Super Admin"              fixed full access (code unchanged)
--   ADMINISTRATOR            "Admin"                    configured by Super Admin only
--   FINANCE_EXECUTIVE        "Finance Executive"        Finance section
--   MASTER_DATA_EXECUTIVE    "Master Data Executive"    Master Data Center
--   AMC_OPERATIONS_EXECUTIVE "AMC Operations Executive" AMC Operations
--   VIEWER                   "Viewer"                   View and Export only
--
-- Changes: renames the ADMIN role to "Super Admin" (its code, id, grants and
-- assignments are unchanged), adds five roles and their starting grants.
-- Nobody is assigned a new role and no existing grant is removed. The legacy
-- roles are made inactive separately, by 0088.
--
-- The starting grants equal defaultGrants() in src/shared/role-model.ts, which
-- also enforces each role's scope in the API (tests/role-model.test.ts checks
-- both agree). Only permissions the current application checks are seeded.
--
-- Idempotent: ON CONFLICT DO NOTHING; the rename only touches the ADMIN row.
-- Run again by the API tests after they empty role_permissions.
--
-- Reverse (only with approval; no user may hold one of the five roles):
--   DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE code IN
--     ('ADMINISTRATOR','FINANCE_EXECUTIVE','MASTER_DATA_EXECUTIVE','AMC_OPERATIONS_EXECUTIVE','VIEWER'));
--   DELETE FROM roles WHERE code IN
--     ('ADMINISTRATOR','FINANCE_EXECUTIVE','MASTER_DATA_EXECUTIVE','AMC_OPERATIONS_EXECUTIVE','VIEWER');
--   UPDATE roles SET name = 'Admin', description = 'Full access, including users, roles and settings.' WHERE code = 'ADMIN';
--   DELETE FROM schema_migrations WHERE version = '0087';

UPDATE roles
SET name = 'Super Admin',
    description = 'Full access to every module, including Admin accounts and all role permissions. Cannot be changed.'
WHERE code = 'ADMIN' AND name <> 'Super Admin';

INSERT INTO roles (code, name, description) VALUES
  ('ADMINISTRATOR',            'Admin',                    'Operational and administrative access as configured by Super Admin. Manages the other roles and their users.'),
  ('FINANCE_EXECUTIVE',        'Finance Executive',        'Finance section: Invoice Tracking and Accounts.'),
  ('MASTER_DATA_EXECUTIVE',    'Master Data Executive',    'Master Data Center: clients, sales engineers, system types, maintenance frequencies and departments.'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC Operations Executive', 'AMC Operations: contracts, renewals, schedule, calendar, service status, visit execution and services sales.'),
  ('VIEWER',                   'Viewer',                   'Read-only access to the business modules it is given. View and Export only.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, p.module, p.action
FROM (VALUES
  -- ADMINISTRATOR (57)
  ('ADMINISTRATOR', 'DASHBOARD', 'VIEW'),
  ('ADMINISTRATOR', 'CLIENTS', 'VIEW'),
  ('ADMINISTRATOR', 'CLIENTS', 'CREATE'),
  ('ADMINISTRATOR', 'CLIENTS', 'EDIT'),
  ('ADMINISTRATOR', 'CLIENTS', 'DELETE'),
  ('ADMINISTRATOR', 'CLIENTS', 'EXPORT'),
  ('ADMINISTRATOR', 'SALES_ENGINEERS', 'VIEW'),
  ('ADMINISTRATOR', 'SALES_ENGINEERS', 'CREATE'),
  ('ADMINISTRATOR', 'SALES_ENGINEERS', 'EDIT'),
  ('ADMINISTRATOR', 'SALES_ENGINEERS', 'EXPORT'),
  ('ADMINISTRATOR', 'SYSTEM_TYPES', 'VIEW'),
  ('ADMINISTRATOR', 'SYSTEM_TYPES', 'CREATE'),
  ('ADMINISTRATOR', 'SYSTEM_TYPES', 'EDIT'),
  ('ADMINISTRATOR', 'SYSTEM_TYPES', 'DELETE'),
  ('ADMINISTRATOR', 'SYSTEM_TYPES', 'EXPORT'),
  ('ADMINISTRATOR', 'MAINTENANCE_FREQUENCIES', 'VIEW'),
  ('ADMINISTRATOR', 'MAINTENANCE_FREQUENCIES', 'CREATE'),
  ('ADMINISTRATOR', 'MAINTENANCE_FREQUENCIES', 'EDIT'),
  ('ADMINISTRATOR', 'MAINTENANCE_FREQUENCIES', 'EXPORT'),
  ('ADMINISTRATOR', 'DEPARTMENTS', 'VIEW'),
  ('ADMINISTRATOR', 'DEPARTMENTS', 'CREATE'),
  ('ADMINISTRATOR', 'DEPARTMENTS', 'EDIT'),
  ('ADMINISTRATOR', 'DEPARTMENTS', 'EXPORT'),
  ('ADMINISTRATOR', 'AMC_CONTRACTS', 'VIEW'),
  ('ADMINISTRATOR', 'AMC_CONTRACTS', 'CREATE'),
  ('ADMINISTRATOR', 'AMC_CONTRACTS', 'EDIT'),
  ('ADMINISTRATOR', 'AMC_CONTRACTS', 'DELETE'),
  ('ADMINISTRATOR', 'AMC_CONTRACTS', 'EXPORT'),
  ('ADMINISTRATOR', 'AMC_RENEWAL', 'VIEW'),
  ('ADMINISTRATOR', 'AMC_RENEWAL', 'CREATE'),
  ('ADMINISTRATOR', 'AMC_RENEWAL', 'EXPORT'),
  ('ADMINISTRATOR', 'AMC_SCHEDULE', 'VIEW'),
  ('ADMINISTRATOR', 'AMC_SCHEDULE', 'EDIT'),
  ('ADMINISTRATOR', 'AMC_SCHEDULE', 'EXPORT'),
  ('ADMINISTRATOR', 'MONTHLY_CALENDAR', 'VIEW'),
  ('ADMINISTRATOR', 'MONTHLY_CALENDAR', 'EXPORT'),
  ('ADMINISTRATOR', 'SERVICE_STATUS', 'VIEW'),
  ('ADMINISTRATOR', 'SERVICE_STATUS', 'EXPORT'),
  ('ADMINISTRATOR', 'AMC_EXECUTION', 'VIEW'),
  ('ADMINISTRATOR', 'AMC_EXECUTION', 'EDIT'),
  ('ADMINISTRATOR', 'AMC_EXECUTION', 'APPROVE'),
  ('ADMINISTRATOR', 'SERVICES_SALES', 'VIEW'),
  ('ADMINISTRATOR', 'SERVICES_SALES', 'EDIT'),
  ('ADMINISTRATOR', 'SERVICES_SALES', 'EXPORT'),
  ('ADMINISTRATOR', 'INVOICES', 'VIEW'),
  ('ADMINISTRATOR', 'INVOICES', 'CREATE'),
  ('ADMINISTRATOR', 'INVOICES', 'EDIT'),
  ('ADMINISTRATOR', 'INVOICES', 'EXPORT'),
  ('ADMINISTRATOR', 'USERS', 'VIEW'),
  ('ADMINISTRATOR', 'USERS', 'CREATE'),
  ('ADMINISTRATOR', 'USERS', 'EDIT'),
  ('ADMINISTRATOR', 'USERS', 'DELETE'),
  ('ADMINISTRATOR', 'USERS', 'APPROVE'),
  ('ADMINISTRATOR', 'SETTINGS', 'VIEW'),
  ('ADMINISTRATOR', 'SETTINGS', 'CREATE'),
  ('ADMINISTRATOR', 'SETTINGS', 'EDIT'),
  ('ADMINISTRATOR', 'SETTINGS', 'DELETE'),
  -- FINANCE_EXECUTIVE (6)
  ('FINANCE_EXECUTIVE', 'DASHBOARD', 'VIEW'),
  ('FINANCE_EXECUTIVE', 'AMC_SCHEDULE', 'VIEW'),
  ('FINANCE_EXECUTIVE', 'INVOICES', 'VIEW'),
  ('FINANCE_EXECUTIVE', 'INVOICES', 'CREATE'),
  ('FINANCE_EXECUTIVE', 'INVOICES', 'EDIT'),
  ('FINANCE_EXECUTIVE', 'INVOICES', 'EXPORT'),
  -- MASTER_DATA_EXECUTIVE (23)
  ('MASTER_DATA_EXECUTIVE', 'DASHBOARD', 'VIEW'),
  ('MASTER_DATA_EXECUTIVE', 'CLIENTS', 'VIEW'),
  ('MASTER_DATA_EXECUTIVE', 'CLIENTS', 'CREATE'),
  ('MASTER_DATA_EXECUTIVE', 'CLIENTS', 'EDIT'),
  ('MASTER_DATA_EXECUTIVE', 'CLIENTS', 'DELETE'),
  ('MASTER_DATA_EXECUTIVE', 'CLIENTS', 'EXPORT'),
  ('MASTER_DATA_EXECUTIVE', 'SALES_ENGINEERS', 'VIEW'),
  ('MASTER_DATA_EXECUTIVE', 'SALES_ENGINEERS', 'CREATE'),
  ('MASTER_DATA_EXECUTIVE', 'SALES_ENGINEERS', 'EDIT'),
  ('MASTER_DATA_EXECUTIVE', 'SALES_ENGINEERS', 'EXPORT'),
  ('MASTER_DATA_EXECUTIVE', 'SYSTEM_TYPES', 'VIEW'),
  ('MASTER_DATA_EXECUTIVE', 'SYSTEM_TYPES', 'CREATE'),
  ('MASTER_DATA_EXECUTIVE', 'SYSTEM_TYPES', 'EDIT'),
  ('MASTER_DATA_EXECUTIVE', 'SYSTEM_TYPES', 'DELETE'),
  ('MASTER_DATA_EXECUTIVE', 'SYSTEM_TYPES', 'EXPORT'),
  ('MASTER_DATA_EXECUTIVE', 'MAINTENANCE_FREQUENCIES', 'VIEW'),
  ('MASTER_DATA_EXECUTIVE', 'MAINTENANCE_FREQUENCIES', 'CREATE'),
  ('MASTER_DATA_EXECUTIVE', 'MAINTENANCE_FREQUENCIES', 'EDIT'),
  ('MASTER_DATA_EXECUTIVE', 'MAINTENANCE_FREQUENCIES', 'EXPORT'),
  ('MASTER_DATA_EXECUTIVE', 'DEPARTMENTS', 'VIEW'),
  ('MASTER_DATA_EXECUTIVE', 'DEPARTMENTS', 'CREATE'),
  ('MASTER_DATA_EXECUTIVE', 'DEPARTMENTS', 'EDIT'),
  ('MASTER_DATA_EXECUTIVE', 'DEPARTMENTS', 'EXPORT'),
  -- AMC_OPERATIONS_EXECUTIVE (24)
  ('AMC_OPERATIONS_EXECUTIVE', 'DASHBOARD', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'CLIENTS', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_CONTRACTS', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_CONTRACTS', 'CREATE'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_CONTRACTS', 'EDIT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_CONTRACTS', 'DELETE'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_CONTRACTS', 'EXPORT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_RENEWAL', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_RENEWAL', 'CREATE'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_RENEWAL', 'EXPORT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_SCHEDULE', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_SCHEDULE', 'EDIT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_SCHEDULE', 'EXPORT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'MONTHLY_CALENDAR', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'MONTHLY_CALENDAR', 'EXPORT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'SERVICE_STATUS', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'SERVICE_STATUS', 'EXPORT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_EXECUTION', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_EXECUTION', 'EDIT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'AMC_EXECUTION', 'APPROVE'),
  ('AMC_OPERATIONS_EXECUTIVE', 'SERVICES_SALES', 'VIEW'),
  ('AMC_OPERATIONS_EXECUTIVE', 'SERVICES_SALES', 'EDIT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'SERVICES_SALES', 'EXPORT'),
  ('AMC_OPERATIONS_EXECUTIVE', 'INVOICES', 'VIEW'),
  -- VIEWER (14)
  ('VIEWER', 'DASHBOARD', 'VIEW'),
  ('VIEWER', 'CLIENTS', 'VIEW'),
  ('VIEWER', 'SALES_ENGINEERS', 'VIEW'),
  ('VIEWER', 'SYSTEM_TYPES', 'VIEW'),
  ('VIEWER', 'MAINTENANCE_FREQUENCIES', 'VIEW'),
  ('VIEWER', 'DEPARTMENTS', 'VIEW'),
  ('VIEWER', 'AMC_CONTRACTS', 'VIEW'),
  ('VIEWER', 'AMC_RENEWAL', 'VIEW'),
  ('VIEWER', 'AMC_SCHEDULE', 'VIEW'),
  ('VIEWER', 'MONTHLY_CALENDAR', 'VIEW'),
  ('VIEWER', 'SERVICE_STATUS', 'VIEW'),
  ('VIEWER', 'AMC_EXECUTION', 'VIEW'),
  ('VIEWER', 'SERVICES_SALES', 'VIEW'),
  ('VIEWER', 'INVOICES', 'VIEW')
) AS p (role_code, module, action)
JOIN roles r ON r.code = p.role_code
ON CONFLICT DO NOTHING;
