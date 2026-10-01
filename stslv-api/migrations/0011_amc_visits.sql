-- 0011_amc_visits
-- The AMC schedule: one row per scheduled maintenance visit, generated from a
-- contract. The row also carries the execution outcome and the visit amount,
-- and is the record the later Invoice module attaches to.
--
-- A visit is a dated row. There are no month tables and no month columns.

CREATE TABLE amc_visits (
  id                      bigint GENERATED ALWAYS AS IDENTITY,
  amc_contract_id         bigint        NOT NULL,
  -- Running number within the contract, unique among its visits. The number of
  -- an untouched visit removed by schedule regeneration may be issued again.
  sequence_no             integer       NOT NULL,
  -- The maintenance period this visit covers.
  period_start            date          NOT NULL,
  period_end              date          NOT NULL,
  -- Date assigned at generation; never changed afterwards.
  original_scheduled_date date          NOT NULL,
  -- Current planned date. Differs from the original once rescheduled.
  scheduled_date          date          NOT NULL,
  -- Person assigned to this visit. Null means "the contract's responsible engineer".
  assigned_to             text,
  status                  text          NOT NULL DEFAULT 'SCHEDULED',
  -- Amount for this visit. Initialised from the contract's default at
  -- generation and editable per visit. Null means "not set yet"; zero is a
  -- real value (a visit for which nothing is invoiced).
  visit_amount            numeric(14,3),
  -- True once a user has set the amount by hand.
  amount_is_custom        boolean       NOT NULL DEFAULT false,
  completed_date          date,
  completed_by            bigint,
  work_performed          text,
  execution_notes         text,
  -- Reason for a postponement or cancellation.
  status_reason           text,
  -- Planning / office notes, separate from the execution notes.
  notes                   text,
  created_at              timestamptz   NOT NULL DEFAULT now(),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  created_by              bigint,
  updated_by              bigint,
  CONSTRAINT amc_visits_pk PRIMARY KEY (id),
  CONSTRAINT amc_visits_amc_contract_id_fk FOREIGN KEY (amc_contract_id) REFERENCES amc_contracts (id) ON DELETE RESTRICT,
  CONSTRAINT amc_visits_completed_by_fk FOREIGN KEY (completed_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT amc_visits_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT amc_visits_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT amc_visits_sequence_uq UNIQUE (amc_contract_id, sequence_no),
  -- One visit per contract period, whatever its status. This is the database
  -- guard against duplicate schedule generation.
  CONSTRAINT amc_visits_period_uq UNIQUE (amc_contract_id, period_start),
  CONSTRAINT amc_visits_sequence_no_ck CHECK (sequence_no > 0),
  CONSTRAINT amc_visits_period_ck CHECK (period_end >= period_start),
  CONSTRAINT amc_visits_status_ck CHECK (
    status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED')
  ),
  CONSTRAINT amc_visits_visit_amount_ck CHECK (visit_amount IS NULL OR visit_amount >= 0),
  -- A completed visit always has a completion date, and only a completed visit has one.
  CONSTRAINT amc_visits_completion_ck CHECK ((status = 'COMPLETED') = (completed_date IS NOT NULL)),
  CONSTRAINT amc_visits_completed_by_ck CHECK (completed_by IS NULL OR status = 'COMPLETED')
);

CREATE INDEX amc_visits_scheduled_date_idx ON amc_visits (scheduled_date);
CREATE INDEX amc_visits_status_scheduled_date_idx ON amc_visits (status, scheduled_date);
CREATE INDEX amc_visits_completed_by_idx ON amc_visits (completed_by);
CREATE INDEX amc_visits_created_by_idx ON amc_visits (created_by);
CREATE INDEX amc_visits_updated_by_idx ON amc_visits (updated_by);

CREATE TRIGGER amc_visits_set_updated_at
  BEFORE UPDATE ON amc_visits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- v_amc_visit_billing
-- The one definition of a visit's invoice eligibility. It is derived, never
-- stored, so it cannot disagree with the visit.
--
--   NOT_COMPLETED        the visit is not completed.
--   AMOUNT_REQUIRED      completed, but no amount has been set. It cannot be
--                        invoiced until someone enters an amount.
--   NO_INVOICE_REQUIRED  completed with an amount of exactly zero. Nothing is
--                        to be invoiced, so it never waits for an invoice.
--   READY_FOR_INVOICE    completed with an amount above zero.
--
-- No invoice tables exist yet. The Invoice module replaces this view
-- (CREATE OR REPLACE VIEW, in its own migration) to add an INVOICED state for
-- visits that have an active invoice allocation.
-- ---------------------------------------------------------------------------
CREATE VIEW v_amc_visit_billing AS
SELECT
  v.id AS amc_visit_id,
  v.amc_contract_id,
  CASE
    WHEN v.status <> 'COMPLETED' THEN 'NOT_COMPLETED'
    WHEN v.visit_amount IS NULL THEN 'AMOUNT_REQUIRED'
    WHEN v.visit_amount = 0 THEN 'NO_INVOICE_REQUIRED'
    ELSE 'READY_FOR_INVOICE'
  END AS invoice_eligibility
FROM amc_visits v;
