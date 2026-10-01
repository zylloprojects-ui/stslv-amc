-- 0031_legacy_import_staging
-- Durable audit trail of a controlled import from the client's earlier
-- registers. Creates: legacy_import_batches, legacy_import_rows.
--
-- Every source record is kept here exactly as it was read, whether it was
-- imported or held back, with a link to the record it produced. The invoice
-- references of the source registers stay here until the Invoice Tracking
-- module reconciles them: they are not copied onto projects or visits.
--
-- These tables are written by the import process only. They have no API and
-- no page.

-- ---------------------------------------------------------------------------
-- legacy_import_batches
-- One row per import run.
-- ---------------------------------------------------------------------------
CREATE TABLE legacy_import_batches (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  label        text        NOT NULL,
  -- The date of the import, taken from the database at that moment. It is the
  -- boundary between history and operational scheduling for the contracts of
  -- this batch (amc_contracts.schedule_cutover_date).
  cutover_date date        NOT NULL DEFAULT CURRENT_DATE,
  -- The source files as read: [{ "name": ..., "sha256": ... }].
  source_files jsonb       NOT NULL DEFAULT '[]'::jsonb,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Null when the import is run from the command line.
  created_by   bigint,
  CONSTRAINT legacy_import_batches_pk PRIMARY KEY (id),
  CONSTRAINT legacy_import_batches_label_ck CHECK (btrim(label) <> ''),
  CONSTRAINT legacy_import_batches_source_files_ck CHECK (jsonb_typeof(source_files) = 'array'),
  CONSTRAINT legacy_import_batches_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX legacy_import_batches_created_by_idx ON legacy_import_batches (created_by);

-- ---------------------------------------------------------------------------
-- legacy_import_rows
-- One row per source record.
-- ---------------------------------------------------------------------------
CREATE TABLE legacy_import_rows (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  batch_id            bigint      NOT NULL,
  source_workbook     text        NOT NULL,
  source_sheet        text        NOT NULL,
  source_row          integer     NOT NULL,
  -- The cell the record starts at, where one sheet row holds several records
  -- (the AMC schedule has three month blocks side by side). Otherwise empty.
  source_cell         text        NOT NULL DEFAULT '',
  record_kind         text        NOT NULL,
  -- What identifies the record in the source, for example a job number.
  original_identifier text        NOT NULL,
  -- Every source value of the record, by column heading, exactly as read.
  raw_values          jsonb       NOT NULL,
  disposition         text        NOT NULL,
  -- Why a record was not imported. Present on held records only.
  hold_reason         text,
  -- The record an imported row produced. At most one, matching record_kind.
  client_id           bigint,
  amc_contract_id     bigint,
  amc_visit_id        bigint,
  project_id          bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_import_rows_pk PRIMARY KEY (id),
  CONSTRAINT legacy_import_rows_batch_id_fk FOREIGN KEY (batch_id) REFERENCES legacy_import_batches (id) ON DELETE RESTRICT,
  CONSTRAINT legacy_import_rows_client_id_fk FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT legacy_import_rows_amc_contract_id_fk FOREIGN KEY (amc_contract_id) REFERENCES amc_contracts (id) ON DELETE RESTRICT,
  CONSTRAINT legacy_import_rows_amc_visit_id_fk FOREIGN KEY (amc_visit_id) REFERENCES amc_visits (id) ON DELETE RESTRICT,
  CONSTRAINT legacy_import_rows_project_id_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
  -- The same source record cannot be staged twice, in this batch or a later one.
  CONSTRAINT legacy_import_rows_source_uq UNIQUE (source_workbook, source_sheet, source_row, source_cell, record_kind),
  CONSTRAINT legacy_import_rows_source_ck CHECK (
    btrim(source_workbook) <> '' AND btrim(source_sheet) <> '' AND source_row > 0 AND btrim(original_identifier) <> ''
  ),
  CONSTRAINT legacy_import_rows_record_kind_ck CHECK (record_kind IN ('CLIENT', 'AMC_CONTRACT', 'AMC_VISIT', 'PROJECT')),
  CONSTRAINT legacy_import_rows_raw_values_ck CHECK (jsonb_typeof(raw_values) = 'object'),
  CONSTRAINT legacy_import_rows_disposition_ck CHECK (disposition IN ('IMPORTED', 'HELD')),
  CONSTRAINT legacy_import_rows_hold_reason_ck CHECK ((disposition = 'HELD') = (hold_reason IS NOT NULL AND btrim(hold_reason) <> '')),
  -- An imported row links exactly one record; a held row links none.
  CONSTRAINT legacy_import_rows_link_ck CHECK (
    num_nonnulls(client_id, amc_contract_id, amc_visit_id, project_id) = CASE WHEN disposition = 'IMPORTED' THEN 1 ELSE 0 END
  ),
  CONSTRAINT legacy_import_rows_link_kind_ck CHECK (
    (client_id IS NULL OR record_kind = 'CLIENT')
    AND (amc_contract_id IS NULL OR record_kind = 'AMC_CONTRACT')
    AND (amc_visit_id IS NULL OR record_kind = 'AMC_VISIT')
    AND (project_id IS NULL OR record_kind = 'PROJECT')
  )
);

CREATE INDEX legacy_import_rows_batch_id_idx ON legacy_import_rows (batch_id);
-- Several source names may lead to one client (aliases), so this is not unique.
CREATE INDEX legacy_import_rows_client_id_idx ON legacy_import_rows (client_id) WHERE client_id IS NOT NULL;
-- A contract, visit or project comes from exactly one source record.
CREATE UNIQUE INDEX legacy_import_rows_amc_contract_id_uq ON legacy_import_rows (amc_contract_id) WHERE amc_contract_id IS NOT NULL;
CREATE UNIQUE INDEX legacy_import_rows_amc_visit_id_uq ON legacy_import_rows (amc_visit_id) WHERE amc_visit_id IS NOT NULL;
CREATE UNIQUE INDEX legacy_import_rows_project_id_uq ON legacy_import_rows (project_id) WHERE project_id IS NOT NULL;
