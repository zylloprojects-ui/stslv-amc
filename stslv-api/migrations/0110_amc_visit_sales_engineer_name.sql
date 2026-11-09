-- 0110_amc_visit_sales_engineer_name
-- PREPARED FOR REVIEW (STS-ELV client fixes, 2026-11-09). Applied to isolated test databases only.
-- A release applies it when the API starts, so releasing needs approval of this file too.
--
-- "Sales Engineer Name" of one scheduled maintenance visit, typed by hand on the
-- Service Status page beside the Service Report No. (client's handwritten
-- requirement, 2026-11-09).
--
--   * It is NOT the contract's Sales Engineer master link (amc_contracts.sales_engineer_id,
--     migration 0070). That link is unchanged and still drives the Sales Engineer filters
--     and reports. This column is free text recorded per service, as the business writes it.
--   * Nullable: no existing visit is changed and nothing is backfilled.
--   * At most 120 characters, no leading or trailing spaces, no control characters.
--   * Not covered by the Service Report No. lock (SERVICE_REPORT_NO_LOCK_ENABLED).
--
--   * amc_visits is a view over amc_visits_all (migration 0101, Recycle Bin). The column is added to the
--     table and the view is re-created with the same definition, so it shows the new column last
--     (as 0105 did for amc_contracts). The view stays a simple, updatable view.
--
-- To reverse (only with approval; it discards every name entered):
--   CREATE OR REPLACE cannot drop a view column, so: re-create amc_visits (and its dependants) without it, then
--   ALTER TABLE amc_visits_all DROP COLUMN sales_engineer_name;

ALTER TABLE amc_visits_all
  ADD COLUMN sales_engineer_name text,
  ADD CONSTRAINT amc_visits_sales_engineer_name_ck CHECK (
    sales_engineer_name IS NULL
    OR (
      char_length(sales_engineer_name) BETWEEN 1 AND 120
      AND sales_engineer_name = btrim(sales_engineer_name)
      AND sales_engineer_name !~ '[[:cntrl:]]'
    )
  );

CREATE OR REPLACE VIEW amc_visits AS
SELECT * FROM amc_visits_all v
WHERE EXISTS (SELECT 1 FROM amc_contracts_all c WHERE c.id = v.amc_contract_id AND c.deleted_at IS NULL);
