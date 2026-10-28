-- 0077_amc_visit_service_report_no
-- STAGED, NOT APPLIED. Kept in migrations-pending/ until approved; move it into
-- migrations/ (unchanged) to apply it with the normal migration run.
--
-- The service report number of one scheduled maintenance visit, as written on
-- the paper or PDF service report. Entered on the Service Status page.
--
--   * Nullable: no existing visit is changed and nothing is backfilled.
--   * Free text as the business writes it (at most 50 characters, no leading or
--     trailing spaces). Uniqueness is NOT enforced: whether one report can cover
--     several visits, or a report number can repeat, is not confirmed.
--   * Until this is applied the application keeps working: the Service Status
--     page lists the visits and shows the report number as unavailable.
--
-- To reverse (only with approval; it discards every report number entered):
--   ALTER TABLE amc_visits DROP COLUMN service_report_no;

ALTER TABLE amc_visits
  ADD COLUMN service_report_no text,
  ADD CONSTRAINT amc_visits_service_report_no_ck CHECK (
    service_report_no IS NULL
    OR (char_length(service_report_no) BETWEEN 1 AND 50 AND service_report_no = btrim(service_report_no))
  );
