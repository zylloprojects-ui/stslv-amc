-- 0120_amc_renewal_role
-- Adds one built-in operational role (requested 2026-11-19):
--   AMC_RENEWAL_EXECUTIVE  "AMC Renewal"
--
-- It works like Accounts, AMC Sales and AMC Operations Executive: Super Admin
-- configures its permissions in Roles & Permissions (and Service Dept may, within
-- its own permissions, as for the other operational roles); it can never hold
-- Users & Access; it is never deleted. The rules are in src/shared/role-model.ts.
--
-- The role starts with NO permissions: it opens nothing until it is configured.
-- No role_permissions row is written, no user is assigned it, and no other role,
-- permission or assignment is changed. The role code is deliberately not
-- "AMC_RENEWAL", which is the code of the AMC Renewal permission module.
--
-- Numbered 0120 because 0119 is reserved by the parallel protected Super Admin
-- work (feature/protected-super-admin). Release order matters: the runner refuses
-- a file numbered below the last applied one, so 0119 must be applied before (or
-- together with) 0120. If 0120 ships first, renumber whichever comes later.
--
-- Fails safely: stops, changing nothing, if a role with this code already exists
-- (for example a custom role created in Roles & Permissions) or another role is
-- already named "AMC Renewal" (names are unique, case-insensitively, in the API).
--
-- Read-only check to run before applying:
--   SELECT id, code, name, is_active FROM roles
--   WHERE code = 'AMC_RENEWAL_EXECUTIVE' OR lower(name) = lower('AMC Renewal');
--
-- Reverse (only with approval; nobody may hold the role):
--   DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code = 'AMC_RENEWAL_EXECUTIVE');
--   DELETE FROM roles WHERE code = 'AMC_RENEWAL_EXECUTIVE'
--     AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'AMC_RENEWAL_EXECUTIVE');
--   DELETE FROM schema_migrations WHERE version = '0120';

DO $$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(format('%s (%s)', r.name, r.code), ', ') INTO clash
  FROM roles r
  WHERE r.code = 'AMC_RENEWAL_EXECUTIVE' OR lower(r.name) = lower('AMC Renewal');

  IF clash IS NOT NULL THEN
    RAISE EXCEPTION '0120: a role with the code AMC_RENEWAL_EXECUTIVE or the name "AMC Renewal" already exists: %. Rename it (or remove the unused custom role) in Roles & Permissions, then apply 0120 again. Nothing was changed.', clash;
  END IF;
END $$;

INSERT INTO roles (code, name, description) VALUES
  ('AMC_RENEWAL_EXECUTIVE', 'AMC Renewal', 'AMC renewal staff. Starts with no permissions; opens only what Super Admin grants in Roles & Permissions.');
