-- 0023_project_financials_view
-- The single definition of a project's derived figures. Nothing here is
-- stored: every value is calculated from the project row and its expense rows,
-- so it cannot drift out of step with them.
--
--   tracked_expenses       = SUM(project_expenses.amount) where not voided
--   operational_job_margin = projects.job_value (excluding VAT) - tracked_expenses
--   budget_remaining       = projects.budget_amount - tracked_expenses (null without a budget)
--
-- "Operational Job Margin" is NOT accounting profit: it counts only the
-- expenses recorded in this system, and its definition is provisional (Q10).
--
-- invoice_state is the handoff to the Invoice Tracking module:
--   NOT_READY           the project is NEW or IN_PROGRESS
--   READY_FOR_INVOICE   COMPLETED with a job value above zero
--   NO_INVOICE_REQUIRED COMPLETED with a job value of zero: there is nothing
--                       to bill, so it never waits for an invoice
--   NOT_APPLICABLE      CANCELLED
-- No invoice records exist yet. When they do, that module replaces this view
-- (CREATE OR REPLACE VIEW) to take invoiced value into account.

CREATE VIEW v_project_financials AS
SELECT
  p.id AS project_id,
  COALESCE(e.tracked_expenses, 0)::numeric(16,3) AS tracked_expenses,
  (p.job_value - COALESCE(e.tracked_expenses, 0))::numeric(16,3) AS operational_job_margin,
  (p.budget_amount - COALESCE(e.tracked_expenses, 0))::numeric(16,3) AS budget_remaining,
  CASE
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
