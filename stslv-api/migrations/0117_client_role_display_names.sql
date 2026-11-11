-- 0117_client_role_display_names
-- Client-requested display names for three built-in roles (2026-11-11):
--   ADMINISTRATOR          "Admin"                 -> "Service Dept"
--   FINANCE_EXECUTIVE      "Finance Executive"     -> "Accounts"
--   MASTER_DATA_EXECUTIVE  "Master Data Executive" -> "AMC Sales"
--
-- Only roles.name changes, plus the one word "Admin" in the Super Admin role's
-- description ("including Admin accounts" -> "including Service Dept accounts").
-- Role ids, codes, other descriptions, active flags, every role_permissions row
-- and every user_roles assignment are untouched, so access is exactly as before. The names equal BUILT_IN_ROLE_NAMES in
-- src/shared/role-model.ts (tests/role-display-names.test.ts checks both agree).
--
-- Historical audit entries are not changed: activity_logs is append-only (0109)
-- and keeps the names that were current when each entry was written.
--
-- Each row is renamed only while it still has its seeded name, so a name that
-- Super Admin has already changed in Roles & Permissions is left as it is.
-- Fails safely: if another role already uses one of the new names (the API
-- refuses duplicate names, case-insensitively), the migration stops and the
-- runner rolls it back; nothing is changed. Rename that role first.
--
-- Read-only check to run before applying:
--   SELECT id, code, name FROM roles WHERE lower(name) IN ('service dept', 'accounts', 'amc sales')
--      OR code IN ('ADMINISTRATOR', 'FINANCE_EXECUTIVE', 'MASTER_DATA_EXECUTIVE');
--
-- Reverse (only with approval):
--   UPDATE roles SET name = 'Admin'                 WHERE code = 'ADMINISTRATOR'         AND name = 'Service Dept';
--   UPDATE roles SET name = 'Finance Executive'     WHERE code = 'FINANCE_EXECUTIVE'     AND name = 'Accounts';
--   UPDATE roles SET name = 'Master Data Executive' WHERE code = 'MASTER_DATA_EXECUTIVE' AND name = 'AMC Sales';
--   UPDATE roles SET description = 'Full access to every module, including Admin accounts and all role permissions. Cannot be changed.'
--     WHERE code = 'ADMIN' AND description = 'Full access to every module, including Service Dept accounts and all role permissions. Cannot be changed.';
--   DELETE FROM schema_migrations WHERE version = '0117';

DO $$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(format('%s (%s)', r.name, r.code), ', ') INTO clash
  FROM roles r
  JOIN (VALUES
    ('ADMINISTRATOR', 'Service Dept'),
    ('FINANCE_EXECUTIVE', 'Accounts'),
    ('MASTER_DATA_EXECUTIVE', 'AMC Sales')
  ) AS v (code, name) ON lower(r.name) = lower(v.name) AND r.code <> v.code;

  IF clash IS NOT NULL THEN
    RAISE EXCEPTION '0117: another role already uses a new name: %. Rename it in Roles & Permissions, then apply 0117 again. Nothing was changed.', clash;
  END IF;
END $$;

UPDATE roles r
SET name = v.new_name
FROM (VALUES
  ('ADMINISTRATOR', 'Admin', 'Service Dept'),
  ('FINANCE_EXECUTIVE', 'Finance Executive', 'Accounts'),
  ('MASTER_DATA_EXECUTIVE', 'Master Data Executive', 'AMC Sales')
) AS v (code, old_name, new_name)
WHERE r.code = v.code AND r.name = v.old_name;

-- The Super Admin description names the renamed Admin role. Only that word changes, and only while the text is
-- still the one 0087 seeded; Super Admin's name, code, grants and holders are unchanged.
UPDATE roles
SET description = 'Full access to every module, including Service Dept accounts and all role permissions. Cannot be changed.'
WHERE code = 'ADMIN'
  AND description = 'Full access to every module, including Admin accounts and all role permissions. Cannot be changed.';
