-- 0121_amc_visit_working_days
-- PREPARED FOR REVIEW (feature/service-working-days, 2026-11-19). Applied to isolated test databases only.
-- A release applies it when the API starts, so releasing needs approval of this file too.
--
-- "Number of Working Days" of one scheduled maintenance visit, typed by hand on the
-- Service Status page (owner's request, 2026-11-19).
--
--   * Entered manually. It is NEVER calculated from dates (scheduled, completed or period dates).
--   * A non-negative whole number. The API also caps it at 9999 (an input sanity limit, not a business rule);
--     the database only refuses negative numbers, so that cap can change without a migration.
--   * Nullable: no existing visit is changed and nothing is backfilled. Blank until someone enters it.
--   * Changes nothing else: not the service status, completion, Paid / Invoice No., service value,
--     contract values or any calculation.
--
--   * amc_visits is a view over amc_visits_all (migration 0101, Recycle Bin). The column is added to the
--     table and the view is re-created with the same definition, so it shows the new column last
--     (as 0110 did). The view stays a simple, updatable view.
--
-- Numbered 0121 because parallel branches hold 0119 (protected Super Admin) and 0120 (AMC Renewal role).
-- If those merge with other numbers, this file keeps a number above every applied migration.
--
-- To reverse (only with approval; it discards every number entered):
--   CREATE OR REPLACE cannot drop a view column, so: re-create amc_visits (and its dependants) without it, then
--   ALTER TABLE amc_visits_all DROP COLUMN working_days;

ALTER TABLE amc_visits_all
  ADD COLUMN working_days integer,
  ADD CONSTRAINT amc_visits_working_days_ck CHECK (working_days IS NULL OR working_days >= 0);

CREATE OR REPLACE VIEW amc_visits AS
SELECT * FROM amc_visits_all v
WHERE EXISTS (SELECT 1 FROM amc_contracts_all c WHERE c.id = v.amc_contract_id AND c.deleted_at IS NULL);
