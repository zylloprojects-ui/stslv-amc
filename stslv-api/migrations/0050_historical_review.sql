-- 0050_historical_review
-- Lets the staged source records be reviewed in the application.
-- Additive only: no existing row, column or grant changes.
--
--   * legacy_import_rows keeps, beside the raw source values, their column
--     order, what the import proposed for the record, why it is held, what it
--     warns about, and the source invoice cell with its classification.
--   * A new permission module, HISTORICAL_DATA, guards the read-only review
--     routes. Its grants are seeded in 0051.
--
-- A held row is a provisional record: it stays in this table only. No client,
-- contract, visit, project or invoice is created for it.

-- ---------------------------------------------------------------------------
-- legacy_import_rows
-- ---------------------------------------------------------------------------
ALTER TABLE legacy_import_rows
  -- The column headings of raw_values, in the order of the sheet: ["S. No", ...].
  -- A jsonb object does not keep the order of its keys; this array does.
  ADD COLUMN source_columns    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The values the import would store for the record, as far as the source
  -- allows them to be worked out. A value the source does not give is null
  -- here: nothing is supplied. Present on held rows too.
  ADD COLUMN proposed_values   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Why the record is held: [{ "code": ..., "message": ... }]. Empty on an
  -- imported row. hold_reason keeps the same reasons as one line of text.
  ADD COLUMN hold_reasons      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Remarks that do not hold the record: ["...", ...].
  ADD COLUMN warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The source invoice cell: { "rawCell", "numbers", "classification", "notes" }.
  -- Null for a kind of record that has no invoice cell (clients, contracts).
  -- It is a reference kept for the Invoice Tracking module, never an invoice.
  ADD COLUMN invoice_reference jsonb;

ALTER TABLE legacy_import_rows
  ADD CONSTRAINT legacy_import_rows_source_columns_ck CHECK (jsonb_typeof(source_columns) = 'array'),
  ADD CONSTRAINT legacy_import_rows_proposed_values_ck CHECK (jsonb_typeof(proposed_values) = 'object'),
  ADD CONSTRAINT legacy_import_rows_hold_reasons_ck CHECK (
    jsonb_typeof(hold_reasons) = 'array' AND (disposition = 'HELD' OR jsonb_array_length(hold_reasons) = 0)
  ),
  ADD CONSTRAINT legacy_import_rows_warnings_ck CHECK (jsonb_typeof(warnings) = 'array'),
  ADD CONSTRAINT legacy_import_rows_invoice_reference_ck CHECK (invoice_reference IS NULL OR jsonb_typeof(invoice_reference) = 'object');

CREATE INDEX legacy_import_rows_kind_disposition_idx ON legacy_import_rows (record_kind, disposition);

-- ---------------------------------------------------------------------------
-- role_permissions: one more module
-- ---------------------------------------------------------------------------
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_ck;

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_module_ck CHECK (module IN (
    'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
    'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS',
    'HISTORICAL_DATA'
  ));
