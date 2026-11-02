-- 0088_deactivate_legacy_roles
-- The roles of the first permission model (Accountant, Procurement, Execution,
-- Invoicing) are replaced by the six-role model of 0087 (approved 2026-10-29).
-- They are kept, with every grant, and made inactive: an inactive role cannot
-- be assigned and grants nothing. Nothing is deleted.
--
-- Fails safely. If any user (active, pending or rejected) still holds one of
-- them, the migration stops and the runner rolls it back; nothing is changed.
-- An administrator first gives each such user one of the six roles in
-- Users & Access, then the migration is run again. Only a count is reported.
--
-- Read-only check to run before applying:
--   SELECT r.code, count(ur.user_id) FROM roles r LEFT JOIN user_roles ur ON ur.role_id = r.id
--   WHERE r.code IN ('ACCOUNTANT','PROCUREMENT','EXECUTION','INVOICING') GROUP BY r.code;
--
-- Reverse (only with approval):
--   UPDATE roles SET is_active = true WHERE code IN ('ACCOUNTANT','PROCUREMENT','EXECUTION','INVOICING');
--   DELETE FROM schema_migrations WHERE version = '0088';

DO $$
DECLARE
  affected integer;
BEGIN
  SELECT count(DISTINCT ur.user_id) INTO affected
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE r.code IN ('ACCOUNTANT', 'PROCUREMENT', 'EXECUTION', 'INVOICING');

  IF affected > 0 THEN
    RAISE EXCEPTION '0088: % user(s) still hold a legacy role (Accountant, Procurement, Execution or Invoicing). Give each one of the six roles in Users & Access, then apply 0088 again. Nothing was changed.', affected;
  END IF;
END $$;

UPDATE roles
SET is_active = false
WHERE code IN ('ACCOUNTANT', 'PROCUREMENT', 'EXECUTION', 'INVOICING') AND is_active;
