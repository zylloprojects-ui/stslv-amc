-- 0080_page_permission_modules
-- Separate permission modules for pages that shared another module's
-- permissions (approved 2026-10-29, Roles & Permissions proposal A):
--
--   AMC_RENEWAL              AMC Renewal            (was AMC_CONTRACTS)
--   MONTHLY_CALENDAR         Monthly Calendar       (was AMC_SCHEDULE)
--   SERVICE_STATUS           Service Status         (was AMC_SCHEDULE)
--   SALES_ENGINEERS          Sales Engineers        (was SETTINGS)
--   SYSTEM_TYPES             System Types           (was SETTINGS)
--   MAINTENANCE_FREQUENCIES  Maintenance Frequencies (was SETTINGS)
--   DEPARTMENTS              Departments            (was SETTINGS)
--
-- This migration only widens the list of allowed module codes. It grants and
-- removes nothing. The grants that keep every role's access unchanged are
-- seeded by 0081, which must be applied together with this one.
--
-- No module is removed from the list: the retired modules (PROJECTS,
-- PROCUREMENT, EXPENSES, HISTORICAL_DATA, REPORTS) and their grants stay until
-- a separately approved cleanup.
--
-- Lock: a brief ACCESS EXCLUSIVE lock on role_permissions while the CHECK
-- constraint is replaced; the table is small.
--
-- To reverse (only with approval; it discards every grant on the new modules):
--   DELETE FROM role_permissions WHERE module IN ('AMC_RENEWAL', 'MONTHLY_CALENDAR', 'SERVICE_STATUS',
--     'SALES_ENGINEERS', 'SYSTEM_TYPES', 'MAINTENANCE_FREQUENCIES', 'DEPARTMENTS');
--   then restore the constraint as 0078 left it.

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_ck;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_module_ck CHECK (module IN (
    'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
    'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS',
    'HISTORICAL_DATA', 'SERVICES_SALES',
    'AMC_RENEWAL', 'MONTHLY_CALENDAR', 'SERVICE_STATUS',
    'SALES_ENGINEERS', 'SYSTEM_TYPES', 'MAINTENANCE_FREQUENCIES', 'DEPARTMENTS'
  ));
