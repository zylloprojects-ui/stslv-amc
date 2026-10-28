-- 0078_amc_visit_quotation
-- STAGED, NOT APPLIED. Kept in migrations-pending/ until approved; move it into
-- migrations/ (unchanged), together with 0079, to apply it with the normal
-- migration run. Numbered after 0077 (service report number, Service Status),
-- which is staged separately; this file does not depend on 0077.
--
-- The quotation number of one scheduled maintenance visit, entered by hand on
-- the Services Sales page after the visit is completed. The quotation itself
-- is made outside STSLV AMC: no quotation document and no invoice is created.
--
--   * Nullable: no existing visit is changed and nothing is backfilled.
--   * Free text as the business writes it (at most 50 characters, no leading
--     or trailing spaces). "N/A" is only a placeholder on the page and is not a
--     quotation number, so it cannot be stored. Uniqueness is NOT enforced:
--     whether one quotation can cover several visits is not confirmed.
--   * "Only a completed visit receives a quotation number" is checked by the
--     API, not here: a visit reopened after quoting keeps its number, which the
--     page then reports as an inconsistency instead of the database refusing
--     the reopening.
--   * quotation_updated_at / quotation_updated_by: who last changed the number,
--     and when. Every change is also written to activity_logs.
--   * A new permission module, SERVICES_SALES. Its grants are seeded by 0079.
--
-- Until this is applied the application keeps working: the Services Sales
-- routes answer 403/503 and the page is not offered.
--
-- When this moves into migrations/, in the same change:
--   - move SERVICES_SALES from STAGED_MODULES into MODULES (src/shared/permissions.ts);
--   - add "seed_services_sales_permission" to SEED_MIGRATIONS (tests/helpers.ts).
--
-- Locks: each ALTER TABLE takes a brief ACCESS EXCLUSIVE lock. Adding nullable
-- columns without a default does not rewrite amc_visits.
--
-- To reverse (only with approval; it discards every quotation number entered):
--   DELETE FROM role_permissions WHERE module = 'SERVICES_SALES';
--   ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_ck;
--   ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_module_ck CHECK (module IN (
--     'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
--     'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS',
--     'HISTORICAL_DATA'));
--   ALTER TABLE amc_visits DROP COLUMN quotation_updated_by, DROP COLUMN quotation_updated_at, DROP COLUMN quotation_no;

-- ---------------------------------------------------------------------------
-- amc_visits: quotation number
-- ---------------------------------------------------------------------------
ALTER TABLE amc_visits
  ADD COLUMN quotation_no         text,
  ADD COLUMN quotation_updated_at timestamptz,
  ADD COLUMN quotation_updated_by bigint,
  ADD CONSTRAINT amc_visits_quotation_updated_by_fk FOREIGN KEY (quotation_updated_by) REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT amc_visits_quotation_no_ck CHECK (
    quotation_no IS NULL
    OR (
      char_length(quotation_no) BETWEEN 1 AND 50
      AND quotation_no = btrim(quotation_no)
      AND upper(quotation_no) NOT IN ('N/A', 'NA')
    )
  );

CREATE INDEX amc_visits_quotation_updated_by_idx ON amc_visits (quotation_updated_by);

-- ---------------------------------------------------------------------------
-- role_permissions: one more module
-- ---------------------------------------------------------------------------
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_ck;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_module_ck CHECK (module IN (
    'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
    'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS',
    'HISTORICAL_DATA', 'SERVICES_SALES'
  ));
