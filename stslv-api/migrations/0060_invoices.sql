-- 0060_invoices
-- Invoice Tracking. Creates: invoices, invoice_allocations.
-- Replaces: v_amc_visit_billing, v_project_financials (same columns as before,
-- new columns added at the end, new states added).
-- Additive only: no existing row, column, constraint or grant changes.
--
-- Invoices are raised in Zoho. This system records what the Zoho invoice says
-- and which completed work it covers. Nothing here is calculated from a rate:
-- the amount excluding VAT and the VAT amount are both entered from the
-- invoice. Money is numeric(14,3), like every other amount.
--
-- No invoice is created by this migration. The invoice references of the
-- earlier registers stay in legacy_import_rows: they have no date and no
-- amount, so they are not invoices.
--
-- PROVISIONAL business rules (pending client confirmation; Q5, Q11, Q21, Q22):
--   * an AMC visit is INVOICED once any active invoice covers it;
--   * a project is PARTLY_INVOICED / INVOICED by comparing the amounts
--     allocated to it with its job value, both excluding VAT;
--   * an invoice has two statuses, ISSUED and CANCELLED; payment is not tracked.

-- ---------------------------------------------------------------------------
-- invoices
-- One row per invoice issued in Zoho. A reference record, not an accounting
-- document.
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  -- The invoice number as it appears on the Zoho invoice. Plain text: the
  -- database does not know the format.
  invoice_number      text          NOT NULL,
  -- The client the invoice was issued to.
  client_id           bigint        NOT NULL,
  invoice_date        date          NOT NULL,
  -- Both amounts are entered from the invoice. Neither is derived from a rate.
  amount_excl_vat     numeric(14,3) NOT NULL,
  vat_amount          numeric(14,3) NOT NULL,
  total_amount        numeric(15,3) GENERATED ALWAYS AS (amount_excl_vat + vat_amount) STORED,
  status              text          NOT NULL DEFAULT 'ISSUED',
  -- Where the invoice was raised. Only Zoho today.
  source              text          NOT NULL DEFAULT 'ZOHO',
  -- A further reference from the source system, where the user has one.
  source_reference    text,
  notes               text,
  cancelled_at        timestamptz,
  cancelled_by        bigint,
  cancellation_reason text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  -- Required: every invoice record shows who entered it.
  created_by          bigint        NOT NULL,
  updated_by          bigint,
  CONSTRAINT invoices_pk PRIMARY KEY (id),
  CONSTRAINT invoices_invoice_number_ck CHECK (invoice_number <> '' AND invoice_number = btrim(invoice_number)),
  CONSTRAINT invoices_amount_excl_vat_ck CHECK (amount_excl_vat > 0),
  CONSTRAINT invoices_vat_amount_ck CHECK (vat_amount >= 0),
  CONSTRAINT invoices_status_ck CHECK (status IN ('ISSUED', 'CANCELLED')),
  CONSTRAINT invoices_source_ck CHECK (source IN ('ZOHO')),
  CONSTRAINT invoices_source_reference_ck CHECK (source_reference IS NULL OR (source_reference <> '' AND source_reference = btrim(source_reference))),
  -- A cancelled invoice always says when, by whom and why; no other invoice does.
  CONSTRAINT invoices_cancellation_ck CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (status = 'CANCELLED') = (cancelled_by IS NOT NULL)
    AND (status = 'CANCELLED') = (cancellation_reason IS NOT NULL AND btrim(cancellation_reason) <> '')
  ),
  CONSTRAINT invoices_client_id_fk FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT invoices_cancelled_by_fk FOREIGN KEY (cancelled_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT invoices_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT invoices_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- One active record per invoice number, letter case ignored. A cancelled
-- record does not block the number, so an invoice entered by mistake can be
-- cancelled and entered again.
CREATE UNIQUE INDEX invoices_invoice_number_uq ON invoices (lower(invoice_number)) WHERE status <> 'CANCELLED';

CREATE INDEX invoices_client_id_idx ON invoices (client_id);
CREATE INDEX invoices_invoice_date_idx ON invoices (invoice_date);
CREATE INDEX invoices_status_idx ON invoices (status);
CREATE INDEX invoices_cancelled_by_idx ON invoices (cancelled_by);
CREATE INDEX invoices_created_by_idx ON invoices (created_by);
CREATE INDEX invoices_updated_by_idx ON invoices (updated_by);

CREATE TRIGGER invoices_set_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- invoice_allocations
-- Which AMC visit or which project an invoice covers, and for how much of its
-- amount excluding VAT. Every link is a real foreign key, so a visit or a
-- project with an allocation cannot be deleted.
--
-- One invoice may cover several visits or projects, and one project may be
-- covered by several invoices: both occur in the client's job register.
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_allocations (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  invoice_id       bigint        NOT NULL,
  amc_visit_id     bigint,
  project_id       bigint,
  -- Part of the invoice's amount excluding VAT.
  allocated_amount numeric(14,3) NOT NULL,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  created_by       bigint        NOT NULL,
  CONSTRAINT invoice_allocations_pk PRIMARY KEY (id),
  -- Every allocation points at exactly one piece of work.
  CONSTRAINT invoice_allocations_target_ck CHECK (num_nonnulls(amc_visit_id, project_id) = 1),
  CONSTRAINT invoice_allocations_allocated_amount_ck CHECK (allocated_amount > 0),
  CONSTRAINT invoice_allocations_invoice_id_fk FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE RESTRICT,
  CONSTRAINT invoice_allocations_amc_visit_id_fk FOREIGN KEY (amc_visit_id) REFERENCES amc_visits (id) ON DELETE RESTRICT,
  CONSTRAINT invoice_allocations_project_id_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT invoice_allocations_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- An invoice names a visit or a project once.
CREATE UNIQUE INDEX invoice_allocations_invoice_visit_uq ON invoice_allocations (invoice_id, amc_visit_id) WHERE amc_visit_id IS NOT NULL;
CREATE UNIQUE INDEX invoice_allocations_invoice_project_uq ON invoice_allocations (invoice_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX invoice_allocations_amc_visit_id_idx ON invoice_allocations (amc_visit_id) WHERE amc_visit_id IS NOT NULL;
CREATE INDEX invoice_allocations_project_id_idx ON invoice_allocations (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX invoice_allocations_created_by_idx ON invoice_allocations (created_by);

-- ---------------------------------------------------------------------------
-- Reconciliation
-- The allocations of an invoice add up to its amount excluding VAT, to the
-- third decimal. The API checks this before it writes; these deferred
-- constraint triggers check it again when the transaction commits, so no path
-- can leave an invoice that does not reconcile.
-- ---------------------------------------------------------------------------
CREATE FUNCTION check_invoice_allocation_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invoice_ids        bigint[];
  checked_invoice_id bigint;
  invoice_amount     numeric(14,3);
  allocated_total    numeric(16,3);
BEGIN
  -- Each branch reads only the row variables its trigger provides.
  IF TG_TABLE_NAME = 'invoices' THEN
    invoice_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    invoice_ids := ARRAY[NEW.invoice_id];
  ELSIF TG_OP = 'DELETE' THEN
    invoice_ids := ARRAY[OLD.invoice_id];
  ELSE
    invoice_ids := ARRAY[OLD.invoice_id, NEW.invoice_id];
  END IF;

  FOREACH checked_invoice_id IN ARRAY invoice_ids
  LOOP
    SELECT amount_excl_vat INTO invoice_amount FROM invoices WHERE id = checked_invoice_id;

    IF FOUND THEN
      SELECT COALESCE(sum(allocated_amount), 0) INTO allocated_total
      FROM invoice_allocations WHERE invoice_id = checked_invoice_id;

      IF allocated_total <> invoice_amount THEN
        RAISE EXCEPTION 'Invoice % does not reconcile: allocations total %, amount excluding VAT is %.',
          checked_invoice_id, allocated_total, invoice_amount
          USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_allocations_total_ck';
      END IF;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER invoices_allocation_total
  AFTER INSERT OR UPDATE OF amount_excl_vat ON invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_invoice_allocation_total();

CREATE CONSTRAINT TRIGGER invoice_allocations_total
  AFTER INSERT OR UPDATE OR DELETE ON invoice_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_invoice_allocation_total();

-- ---------------------------------------------------------------------------
-- v_amc_visit_billing
-- Same columns as before, plus invoiced_amount. One eligibility is added:
--   INVOICED  the visit is completed and at least one active (not cancelled)
--             invoice covers it. PROVISIONAL: the visit amount is not compared
--             with the invoiced amount, because whether visit amounts include
--             VAT is unconfirmed.
-- Cancelling the invoice returns the visit to READY_FOR_INVOICE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_amc_visit_billing AS
SELECT
  v.id AS amc_visit_id,
  v.amc_contract_id,
  CASE
    WHEN v.status = 'HISTORICAL' THEN 'HISTORICAL'
    WHEN v.status <> 'COMPLETED' THEN 'NOT_COMPLETED'
    WHEN a.invoiced_amount IS NOT NULL THEN 'INVOICED'
    WHEN v.visit_amount IS NULL THEN 'AMOUNT_REQUIRED'
    WHEN v.visit_amount = 0 THEN 'NO_INVOICE_REQUIRED'
    ELSE 'READY_FOR_INVOICE'
  END AS invoice_eligibility,
  -- Sum of the amounts excluding VAT that active invoices allocate to the visit.
  COALESCE(a.invoiced_amount, 0)::numeric(16,3) AS invoiced_amount
FROM amc_visits v
LEFT JOIN (
  SELECT al.amc_visit_id, sum(al.allocated_amount) AS invoiced_amount
  FROM invoice_allocations al
  JOIN invoices i ON i.id = al.invoice_id
  WHERE al.amc_visit_id IS NOT NULL AND i.status <> 'CANCELLED'
  GROUP BY al.amc_visit_id
) a ON a.amc_visit_id = v.id;

-- ---------------------------------------------------------------------------
-- v_project_financials
-- Same columns as before, plus invoiced_value and uninvoiced_value (null where
-- it does not apply). Two
-- states are added for a COMPLETED project that active invoices cover:
--   PARTLY_INVOICED  the amounts allocated to it are below its job value
--   INVOICED         the amounts allocated to it reach or exceed its job value
-- Both sides of the comparison exclude VAT. PROVISIONAL (Q21).
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
    WHEN a.invoiced_value >= p.job_value THEN 'INVOICED'
    WHEN a.invoiced_value IS NOT NULL THEN 'PARTLY_INVOICED'
    WHEN p.job_value = 0 THEN 'NO_INVOICE_REQUIRED'
    ELSE 'READY_FOR_INVOICE'
  END AS invoice_state,
  -- Sum of the amounts excluding VAT that active invoices allocate to the project.
  COALESCE(a.invoiced_value, 0)::numeric(16,3) AS invoiced_value,
  -- Job value excluding VAT not yet covered by an active invoice; never below
  -- zero. Null for a historical project, whose invoice history is not
  -- reconciled, and for a cancelled one: for neither is it an amount to invoice.
  CASE
    WHEN p.status IN ('HISTORICAL', 'CANCELLED') THEN NULL
    ELSE GREATEST(p.job_value - COALESCE(a.invoiced_value, 0), 0)::numeric(16,3)
  END AS uninvoiced_value
FROM projects p
LEFT JOIN (
  SELECT project_id, sum(amount) AS tracked_expenses
  FROM project_expenses
  WHERE voided_at IS NULL
  GROUP BY project_id
) e ON e.project_id = p.id
LEFT JOIN (
  SELECT al.project_id, sum(al.allocated_amount) AS invoiced_value
  FROM invoice_allocations al
  JOIN invoices i ON i.id = al.invoice_id
  WHERE al.project_id IS NOT NULL AND i.status <> 'CANCELLED'
  GROUP BY al.project_id
) a ON a.project_id = p.id;
