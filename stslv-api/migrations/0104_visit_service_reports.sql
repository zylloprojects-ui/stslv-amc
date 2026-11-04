-- 0104_visit_service_reports
-- Service Status (2026-11-04): each scheduled AMC service (visit) carries its
-- own Service Report document, and a service cannot be marked Completed
-- without one. The report is stored like every other attachment (0071): only
-- metadata here, the file in the configured storage under a generated key.
--
-- What changes:
--   * attachments may now belong to a visit: entity_type 'amc_visits', always
--     with category 'SERVICE_REPORT'. entity_id is the visit id (amc_visits_all,
--     0101), never the contract id, so every service has its own report.
--   * The file types widen to PDF, PNG, JPEG and Word (.doc, .docx). This is the
--     same list as 0103 (contract Word documents, feature/amc-contract-kpis-
--     required-fields), so the two migrations give the same result in either
--     order. Which record types may hold which types is decided in the API: a
--     service report is PDF, .doc or .docx.
--   * At most one current service report per visit, enforced here so two
--     uploads at the same moment cannot both become current. Replacing a report
--     adds a new version of the same document (earlier versions are kept, as
--     for every attachment). Removing it before completion marks it not current;
--     no row and no file is deleted.
--
--   * A completed visit is locked in the database as well as in the API: its
--     status cannot leave COMPLETED and its completion date cannot change. The
--     API refuses this first with a clear message; the trigger is the last
--     guard against any other writer (a script, a future endpoint, a stale
--     update). There is no unlock: reopening needs a separately approved change.
--
-- Nothing else changes: no visit, completion date, report number or existing
-- attachment is altered. Completed visits without a report stay as they are.
--
-- Number: 0102 (Sales Engineers code) and 0103 (contract Word documents) are
-- taken by parallel sessions, so this is 0104.
--
-- To reverse (only while no service report has been uploaded, and with approval):
--   DROP TRIGGER amc_visits_completion_lock ON amc_visits_all; DROP FUNCTION amc_visits_completion_lock();
--   DROP INDEX attachments_service_report_uq;
--   ALTER TABLE attachments DROP CONSTRAINT attachments_visit_report_ck;
--   ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_ck,
--     ADD CONSTRAINT attachments_entity_type_ck CHECK (entity_type IN ('amc_contracts', 'procurement_requests', 'project_expenses'));
--   (the file-type check is left as 0103 sets it; restore 0071's only if 0103 is also reversed)
-- Before that, check:
--   SELECT count(*) FROM attachments WHERE entity_type = 'amc_visits';

ALTER TABLE attachments
  DROP CONSTRAINT attachments_entity_type_ck,
  ADD CONSTRAINT attachments_entity_type_ck CHECK (entity_type IN ('amc_contracts', 'procurement_requests', 'project_expenses', 'amc_visits'));

-- A visit holds service reports only.
ALTER TABLE attachments
  ADD CONSTRAINT attachments_visit_report_ck CHECK (entity_type <> 'amc_visits' OR category = 'SERVICE_REPORT');

ALTER TABLE attachments
  DROP CONSTRAINT attachments_mime_ck,
  ADD CONSTRAINT attachments_mime_ck CHECK (mime_type IN (
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ));

-- One current service report per visit. The API checks for this index to know
-- that service reports can be stored (and so that completion can require one).
CREATE UNIQUE INDEX attachments_service_report_uq ON attachments (entity_id)
  WHERE entity_type = 'amc_visits' AND is_current;

-- The completion lock (see above).
CREATE FUNCTION amc_visits_completion_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND (NEW.status IS DISTINCT FROM 'COMPLETED' OR NEW.completed_date IS DISTINCT FROM OLD.completed_date) THEN
    RAISE EXCEPTION 'AMC visit % is completed and locked.', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'amc_visits_completion_lock';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amc_visits_completion_lock
  BEFORE UPDATE OF status, completed_date ON amc_visits_all
  FOR EACH ROW EXECUTE FUNCTION amc_visits_completion_lock();
