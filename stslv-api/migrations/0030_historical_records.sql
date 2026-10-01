-- 0030_historical_records
-- Lets records imported from the client's earlier registers be stored as what
-- they are: history whose workflow state in this system is not established.
-- Additive only. Every existing row keeps its meaning: the new columns default
-- to "not historical", and no existing status changes.
--
-- A historical record is created only by the controlled import process, never
-- through the application's own create, edit or status routes.
--
--   projects.status = 'HISTORICAL'    a job from an earlier register
--   amc_visits.status = 'HISTORICAL'  a period row from an earlier schedule,
--                                     whose execution is not recorded
--
-- Neither is operational work. Both are left out of "ready for invoice" until
-- the Invoice Tracking module reconciles their invoice history.

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  -- The status exactly as written in the source register, for example
  -- "Completed" or "Not Completed". Present on historical projects only.
  ADD COLUMN legacy_status text,
  -- How much of job_date is known. MONTH means the source gave a month and a
  -- year only: job_date then holds the first day of that month as a
  -- placeholder, not as a fact.
  ADD COLUMN job_date_precision text NOT NULL DEFAULT 'DAY';

ALTER TABLE projects DROP CONSTRAINT projects_status_ck;

ALTER TABLE projects
  -- PROVISIONAL operational list (open question Q7), plus HISTORICAL.
  ADD CONSTRAINT projects_status_ck CHECK (status IN ('NEW', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'HISTORICAL')),
  ADD CONSTRAINT projects_legacy_status_ck CHECK (legacy_status IS NULL OR (legacy_status <> '' AND legacy_status = btrim(legacy_status))),
  -- A project is historical exactly when it carries a source status. An
  -- operational project cannot be turned into a historical one, or back.
  ADD CONSTRAINT projects_historical_ck CHECK ((status = 'HISTORICAL') = (legacy_status IS NOT NULL)),
  ADD CONSTRAINT projects_job_date_precision_ck CHECK (job_date_precision IN ('DAY', 'MONTH')),
  -- Only a historical project may have a month-only date, held as day 1.
  ADD CONSTRAINT projects_job_date_month_ck CHECK (
    job_date_precision = 'DAY' OR (status = 'HISTORICAL' AND EXTRACT(DAY FROM job_date) = 1)
  );

-- projects_completed_date_ck is unchanged: a historical project is not
-- COMPLETED, so it has no completion date and none is invented.

-- ---------------------------------------------------------------------------
-- amc_contracts
-- ---------------------------------------------------------------------------
ALTER TABLE amc_contracts
  -- Set only by the controlled import, to the date of that import. The system
  -- generates visits only for periods that start on or after this date:
  -- everything earlier is history and comes from the source records alone, so
  -- a period the source does not list is never created. Null (every contract
  -- entered in the application) means the whole validity period is generated,
  -- as before.
  ADD COLUMN schedule_cutover_date date;

-- ---------------------------------------------------------------------------
-- amc_visits
-- ---------------------------------------------------------------------------
ALTER TABLE amc_visits DROP CONSTRAINT amc_visits_status_ck;

ALTER TABLE amc_visits
  ADD CONSTRAINT amc_visits_status_ck CHECK (
    status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED', 'HISTORICAL')
  );

-- amc_visits_completion_ck is unchanged: a historical visit is not COMPLETED,
-- so it has no completion date and none is invented.

-- ---------------------------------------------------------------------------
-- v_project_financials
-- Same columns as before. One state is added, checked first:
--   HISTORICAL  the project is a historical record. It is not waiting for an
--               invoice, whatever its value: its invoice history has not been
--               reconciled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_project_financials AS
SELECT
  p.id AS project_id,
  COALESCE(e.tracked_expenses, 0)::numeric(16,3) AS tracked_expenses,
  (p.job_value - COALESCE(e.tracked_expenses, 0))::numeric(16,3) AS operational_job_margin,
  (p.budget_amount - COALESCE(e.tracked_expenses, 0))::numeric(16,3) AS budget_remaining,
  CASE
    WHEN p.status = 'HISTORICAL' THEN 'HISTORICAL'
    WHEN p.status = 'CANCELLED' THEN 'NOT_APPLICABLE'
    WHEN p.status <> 'COMPLETED' THEN 'NOT_READY'
    WHEN p.job_value = 0 THEN 'NO_INVOICE_REQUIRED'
    ELSE 'READY_FOR_INVOICE'
  END AS invoice_state
FROM projects p
LEFT JOIN (
  SELECT project_id, sum(amount) AS tracked_expenses
  FROM project_expenses
  WHERE voided_at IS NULL
  GROUP BY project_id
) e ON e.project_id = p.id;

-- ---------------------------------------------------------------------------
-- v_amc_visit_billing
-- Same columns as before. One eligibility is added, checked first:
--   HISTORICAL  the visit is a historical record. It is not waiting for an
--               invoice, whatever its amount.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_amc_visit_billing AS
SELECT
  v.id AS amc_visit_id,
  v.amc_contract_id,
  CASE
    WHEN v.status = 'HISTORICAL' THEN 'HISTORICAL'
    WHEN v.status <> 'COMPLETED' THEN 'NOT_COMPLETED'
    WHEN v.visit_amount IS NULL THEN 'AMOUNT_REQUIRED'
    WHEN v.visit_amount = 0 THEN 'NO_INVOICE_REQUIRED'
    ELSE 'READY_FOR_INVOICE'
  END AS invoice_eligibility
FROM amc_visits v;
