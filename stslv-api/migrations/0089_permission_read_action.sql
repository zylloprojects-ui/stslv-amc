-- 0089_permission_read_action
-- Adds the action READ to role_permissions (approved 2026-10-29): data-only read.
-- A role holding MODULE:READ may see that module's data where another section's
-- page shows it (visit details in Accounts, invoice numbers in Master AMC Status,
-- the client list in the contract form), without opening any of the module's own
-- pages or lists. The API checks it only at the places listed in
-- src/shared/permission-catalog.ts; View still covers everything Read allows.
--
-- Replaces role_permissions_action_ck with the six earlier actions plus READ.
-- Grants and removes nothing. Brief lock on role_permissions.
--
-- Reverse (only with approval; no READ grant may remain):
--   DELETE FROM role_permissions WHERE action = 'READ';
--   ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_action_ck;
--   ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_action_ck
--     CHECK (action IN ('VIEW', 'CREATE', 'EDIT', 'DELETE', 'APPROVE', 'EXPORT'));
--   DELETE FROM schema_migrations WHERE version = '0089';

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_action_ck;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_action_ck CHECK (action IN (
    'VIEW', 'CREATE', 'EDIT', 'DELETE', 'APPROVE', 'EXPORT', 'READ'
  ));
