-- 0091_independent_page_modules
-- New permission modules (approved 2026-10-31), so these pages are configured on their own:
--   MASTER_AMC_STATUS   Master AMC Status (before: AMC_SCHEDULE + SERVICES_SALES + INVOICES read)
--   ACCOUNTS            Accounts (before: INVOICES + AMC_SCHEDULE read)
--   SUGGESTIONS         submitting and following one's own suggestions (before: every signed-in user)
--   SUGGESTIONS_REVIEW  reviewing and managing all suggestions (before: Super Admin and Admin roles)
--
-- Replaces role_permissions_module_ck with the earlier list plus these four. Grants and removes
-- nothing; 0092 grants what keeps every role's access unchanged. Apply 0091 and 0092 together.
-- Brief lock on role_permissions.
--
-- Reverse (only with approval; first delete the grants as described in 0092):
--   ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_ck;
--   ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_module_ck CHECK (module IN (
--     'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
--     'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS',
--     'HISTORICAL_DATA', 'SERVICES_SALES',
--     'AMC_RENEWAL', 'MONTHLY_CALENDAR', 'SERVICE_STATUS',
--     'SALES_ENGINEERS', 'SYSTEM_TYPES', 'MAINTENANCE_FREQUENCIES', 'DEPARTMENTS'));
--   DELETE FROM schema_migrations WHERE version = '0091';

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_ck;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_module_ck CHECK (module IN (
    'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
    'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS',
    'HISTORICAL_DATA', 'SERVICES_SALES',
    'AMC_RENEWAL', 'MONTHLY_CALENDAR', 'SERVICE_STATUS',
    'SALES_ENGINEERS', 'SYSTEM_TYPES', 'MAINTENANCE_FREQUENCIES', 'DEPARTMENTS',
    'MASTER_AMC_STATUS', 'ACCOUNTS', 'SUGGESTIONS', 'SUGGESTIONS_REVIEW'
  ));
