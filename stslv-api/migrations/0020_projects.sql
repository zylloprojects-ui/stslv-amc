-- 0020_projects
-- Projects / jobs, with the configuration they need.
-- Creates: app_settings, number_sequences, projects.
--
-- Money is numeric(14,3): the client's workbooks record three decimal places.
-- No floating-point type is used anywhere.

-- ---------------------------------------------------------------------------
-- app_settings
-- Small key/value store for values that must not be hard-coded.
-- Deliberately has no foreign keys: it is configuration, not business data.
-- ---------------------------------------------------------------------------
CREATE TABLE app_settings (
  key         text        NOT NULL,
  value       text        NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_pk PRIMARY KEY (key),
  CONSTRAINT app_settings_key_ck CHECK (key ~ '^[a-z][a-z0-9_.]*$')
);

CREATE TRIGGER app_settings_set_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- PROVISIONAL: 5% is the rate observed on every job in the legacy register.
-- It is the default offered on a new project, not a confirmed business rule
-- (open question Q11). Each project stores its own rate.
INSERT INTO app_settings (key, value, description) VALUES
  ('projects.default_vat_rate', '5.000',
   'VAT rate (percent) offered by default on a new project. Provisional: based on legacy data, not confirmed by the business.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- number_sequences
-- Configurable counter for business numbers. The format is data, not code.
-- ---------------------------------------------------------------------------
CREATE TABLE number_sequences (
  sequence_key text        NOT NULL,
  prefix       text        NOT NULL DEFAULT '',
  -- The next value to issue.
  next_number  bigint      NOT NULL,
  -- Zero-padding width of the numeric part. Longer numbers are not truncated.
  pad_length   smallint    NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT number_sequences_pk PRIMARY KEY (sequence_key),
  CONSTRAINT number_sequences_next_number_ck CHECK (next_number > 0),
  CONSTRAINT number_sequences_pad_length_ck CHECK (pad_length BETWEEN 0 AND 12),
  CONSTRAINT number_sequences_prefix_ck CHECK (prefix = btrim(prefix) AND length(prefix) <= 20)
);

CREATE TRIGGER number_sequences_set_updated_at
  BEFORE UPDATE ON number_sequences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- PROVISIONAL: the legacy register uses "GPSA" followed by four digits. That
-- is historical evidence, not a confirmed future rule (open question Q6).
-- The starting number is a placeholder: set next_number to the real next job
-- number before the system is used for live work.
INSERT INTO number_sequences (sequence_key, prefix, next_number, pad_length) VALUES
  ('job_number', 'GPSA', 1, 4)
ON CONFLICT (sequence_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  -- Business reference. Plain unique text: the database does not know the format.
  job_number    text          NOT NULL,
  client_id     bigint        NOT NULL,
  description   text          NOT NULL,
  job_date      date          NOT NULL,
  lpo_number    text,
  lpo_date      date,
  -- Job / LPO value excluding VAT.
  job_value     numeric(14,3) NOT NULL,
  -- Percent, explicit on every project (5.000 means 5%).
  vat_rate      numeric(6,3)  NOT NULL,
  -- Always job_value x vat_rate / 100, rounded to three decimals by PostgreSQL.
  -- PROVISIONAL: the rounding rule and whether the amount may be overridden
  -- are not confirmed (Q11). If an override is approved, a later migration
  -- turns this into an ordinary column.
  vat_amount    numeric(14,3) GENERATED ALWAYS AS (round(job_value * vat_rate / 100, 3)) STORED,
  grand_value   numeric(15,3) GENERATED ALWAYS AS (job_value + round(job_value * vat_rate / 100, 3)) STORED,
  -- Planned cost budget, where one is set.
  budget_amount numeric(14,3),
  status        text          NOT NULL DEFAULT 'NEW',
  completed_date date,
  notes         text,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  -- Null only for rows not created by a signed-in user (for example a future import).
  created_by    bigint,
  updated_by    bigint,
  CONSTRAINT projects_pk PRIMARY KEY (id),
  CONSTRAINT projects_job_number_uq UNIQUE (job_number),
  CONSTRAINT projects_job_number_ck CHECK (job_number <> '' AND job_number = btrim(job_number)),
  CONSTRAINT projects_description_ck CHECK (btrim(description) <> ''),
  CONSTRAINT projects_job_value_ck CHECK (job_value >= 0),
  CONSTRAINT projects_vat_rate_ck CHECK (vat_rate >= 0 AND vat_rate <= 100),
  CONSTRAINT projects_budget_amount_ck CHECK (budget_amount IS NULL OR budget_amount >= 0),
  -- PROVISIONAL status list (open question Q7).
  CONSTRAINT projects_status_ck CHECK (status IN ('NEW', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  -- A completion date exists exactly when the project is completed.
  CONSTRAINT projects_completed_date_ck CHECK ((status = 'COMPLETED') = (completed_date IS NOT NULL)),
  CONSTRAINT projects_client_id_fk FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT projects_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT projects_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- There is deliberately no invoice_number column: a project can have several
-- invoices, which the Invoice Tracking module will link through its own table.

CREATE INDEX projects_client_id_idx ON projects (client_id);
CREATE INDEX projects_status_idx ON projects (status);
CREATE INDEX projects_job_date_idx ON projects (job_date);
CREATE INDEX projects_created_by_idx ON projects (created_by);
CREATE INDEX projects_updated_by_idx ON projects (updated_by);

CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
