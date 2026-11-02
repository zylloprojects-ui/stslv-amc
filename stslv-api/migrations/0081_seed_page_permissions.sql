-- 0081_seed_page_permissions
-- Requires 0080 (the new module codes).
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING, so tests can run it again after a reset.
--
-- Keeps every role's access exactly as it was (approved 2026-10-29):
--   * Each new module receives, for every role, the grants that role already
--     held on the module it is split from, limited to the actions the new
--     module uses. A role that could open a page before can open it now; a
--     role that could not, still cannot. No non-Admin role gains anything.
--   * USERS:APPROVE now governs approving and rejecting sign-ups (proposal B).
--     Until now that took USERS:EDIT, so every role holding USERS:EDIT receives
--     USERS:APPROVE and keeps the ability. Normal user editing stays on USERS:EDIT.
--   * ADMIN receives every action of the new modules, like every other module.
--
-- Nothing is deleted. The grants on the old modules stay: AMC_CONTRACTS,
-- AMC_SCHEDULE and SETTINGS still govern their remaining pages and actions.

-- ADMIN: every new module x every action.
INSERT INTO role_permissions (role_id, module, action)
SELECT r.id, m.module, a.action
FROM roles r
CROSS JOIN (VALUES
  ('AMC_RENEWAL'), ('MONTHLY_CALENDAR'), ('SERVICE_STATUS'),
  ('SALES_ENGINEERS'), ('SYSTEM_TYPES'), ('MAINTENANCE_FREQUENCIES'), ('DEPARTMENTS')
) AS m (module)
CROSS JOIN (VALUES
  ('VIEW'), ('CREATE'), ('EDIT'), ('DELETE'), ('APPROVE'), ('EXPORT')
) AS a (action)
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

-- Every role: the new module's actions, copied from the grants on the module it is split from.
INSERT INTO role_permissions (role_id, module, action)
SELECT rp.role_id, s.new_module, rp.action
FROM (VALUES
  ('AMC_RENEWAL',             'AMC_CONTRACTS', 'VIEW'),
  ('AMC_RENEWAL',             'AMC_CONTRACTS', 'CREATE'),
  ('AMC_RENEWAL',             'AMC_CONTRACTS', 'EXPORT'),

  ('MONTHLY_CALENDAR',        'AMC_SCHEDULE',  'VIEW'),
  ('MONTHLY_CALENDAR',        'AMC_SCHEDULE',  'EXPORT'),

  ('SERVICE_STATUS',          'AMC_SCHEDULE',  'VIEW'),
  ('SERVICE_STATUS',          'AMC_SCHEDULE',  'EXPORT'),

  ('SALES_ENGINEERS',         'SETTINGS',      'VIEW'),
  ('SALES_ENGINEERS',         'SETTINGS',      'CREATE'),
  ('SALES_ENGINEERS',         'SETTINGS',      'EDIT'),
  ('SALES_ENGINEERS',         'SETTINGS',      'EXPORT'),

  ('SYSTEM_TYPES',            'SETTINGS',      'VIEW'),
  ('SYSTEM_TYPES',            'SETTINGS',      'CREATE'),
  ('SYSTEM_TYPES',            'SETTINGS',      'EDIT'),
  ('SYSTEM_TYPES',            'SETTINGS',      'DELETE'),
  ('SYSTEM_TYPES',            'SETTINGS',      'EXPORT'),

  ('MAINTENANCE_FREQUENCIES', 'SETTINGS',      'VIEW'),
  ('MAINTENANCE_FREQUENCIES', 'SETTINGS',      'CREATE'),
  ('MAINTENANCE_FREQUENCIES', 'SETTINGS',      'EDIT'),
  ('MAINTENANCE_FREQUENCIES', 'SETTINGS',      'EXPORT'),

  ('DEPARTMENTS',             'SETTINGS',      'VIEW'),
  ('DEPARTMENTS',             'SETTINGS',      'CREATE'),
  ('DEPARTMENTS',             'SETTINGS',      'EDIT'),
  ('DEPARTMENTS',             'SETTINGS',      'EXPORT')
) AS s (new_module, old_module, action)
JOIN role_permissions rp ON rp.module = s.old_module AND rp.action = s.action
ON CONFLICT DO NOTHING;

-- USERS:APPROVE for every role that could approve sign-ups through USERS:EDIT.
INSERT INTO role_permissions (role_id, module, action)
SELECT rp.role_id, 'USERS', 'APPROVE'
FROM role_permissions rp
WHERE rp.module = 'USERS' AND rp.action = 'EDIT'
ON CONFLICT DO NOTHING;
