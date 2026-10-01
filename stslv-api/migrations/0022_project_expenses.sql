-- 0022_project_expenses
-- Costs recorded against a project / job. The only source of tracked job cost.
-- Creates: expense_categories, project_expenses.

-- ---------------------------------------------------------------------------
-- expense_categories
-- Small lookup. Deliberately has no foreign keys: it is configuration.
-- ---------------------------------------------------------------------------
CREATE TABLE expense_categories (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  -- Stable key for reports.
  code       text        NOT NULL,
  name       text        NOT NULL,
  is_active  boolean     NOT NULL DEFAULT true,
  sort_order integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_categories_pk PRIMARY KEY (id),
  CONSTRAINT expense_categories_code_uq UNIQUE (code),
  CONSTRAINT expense_categories_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT expense_categories_name_ck CHECK (btrim(name) <> '')
);

CREATE TRIGGER expense_categories_set_updated_at
  BEFORE UPDATE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- PROVISIONAL: these are the examples given in the requirements, not a list
-- confirmed by the business. Idempotent.
INSERT INTO expense_categories (code, name, sort_order) VALUES
  ('MATERIALS',        'Materials',        10),
  ('TRANSPORT',        'Transport',        20),
  ('INSPECTION',       'Inspection',       30),
  ('LABOUR',           'Labour',           40),
  ('SUPPLIER_PAYMENT', 'Supplier payment', 50),
  ('BILLS',            'Bills',            60),
  ('OTHER',            'Other',            70)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- project_expenses
-- One row is one amount on one project. Nothing is designed for one payment
-- split across several jobs (open question Q9): payment_reference is not
-- unique, so the same reference may appear on rows of different projects,
-- and the database checks nothing about what those rows add up to.
--
-- Expenses are never deleted. A wrong entry is voided, with a reason, and is
-- then left out of every total.
-- ---------------------------------------------------------------------------
CREATE TABLE project_expenses (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  -- Not nullable: an expense cannot be saved without a job.
  project_id          bigint        NOT NULL,
  expense_category_id bigint        NOT NULL,
  expense_date        date          NOT NULL,
  description         text          NOT NULL,
  -- Supplier or payee, free text (no supplier master in Phase 1, Q16).
  payee_name          text,
  -- Stored as entered. Whether expenses are recorded inclusive or exclusive
  -- of VAT is not confirmed (open question Q11).
  amount              numeric(14,3) NOT NULL,
  -- Transfer, cheque or bill reference.
  payment_reference   text,
  notes               text,
  voided_at           timestamptz,
  voided_by           bigint,
  void_reason         text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  created_by          bigint,
  updated_by          bigint,
  CONSTRAINT project_expenses_pk PRIMARY KEY (id),
  CONSTRAINT project_expenses_description_ck CHECK (btrim(description) <> ''),
  CONSTRAINT project_expenses_amount_ck CHECK (amount > 0),
  CONSTRAINT project_expenses_voided_ck CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND btrim(void_reason) <> '')
  ),
  CONSTRAINT project_expenses_project_id_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT project_expenses_expense_category_id_fk FOREIGN KEY (expense_category_id) REFERENCES expense_categories (id) ON DELETE RESTRICT,
  CONSTRAINT project_expenses_voided_by_fk FOREIGN KEY (voided_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT project_expenses_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT project_expenses_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- For cost totals per project.
CREATE INDEX project_expenses_project_id_idx ON project_expenses (project_id) WHERE voided_at IS NULL;
CREATE INDEX project_expenses_project_id_all_idx ON project_expenses (project_id);
CREATE INDEX project_expenses_expense_date_idx ON project_expenses (expense_date);
CREATE INDEX project_expenses_expense_category_id_idx ON project_expenses (expense_category_id);
CREATE INDEX project_expenses_payment_reference_idx ON project_expenses (payment_reference);
CREATE INDEX project_expenses_voided_by_idx ON project_expenses (voided_by);
CREATE INDEX project_expenses_created_by_idx ON project_expenses (created_by);
CREATE INDEX project_expenses_updated_by_idx ON project_expenses (updated_by);

CREATE TRIGGER project_expenses_set_updated_at
  BEFORE UPDATE ON project_expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
