-- 0100_visit_manual_invoice
-- PREPARED FOR REVIEW. Applied to the isolated finance test database only. A
-- release of this branch applies it when the API starts, so releasing needs
-- approval of this file too.
--
-- The manual Invoice No. typed against one scheduled service. Approved rule
-- (2026-11-01): Invoice No. entered = Paid; cleared = Unpaid. It is a reference
-- status: it does not prove that money was received, and it is separate from
-- the Zoho invoices of Invoice Tracking (invoices, invoice_allocations), which
-- are not changed.
--
--   * Nullable: every existing visit starts Unpaid; nothing is backfilled.
--   * Not unique: one invoice number may cover several services.
--   * manual_invoice_at is when the number was entered, so "Paid This Month" and
--     the Payment Trend have a date. Every change is also in activity_logs.
--
-- Reverse (only with approval, and it loses recorded numbers):
--   DROP INDEX amc_visits_manual_invoice_at_idx;
--   ALTER TABLE amc_visits DROP CONSTRAINT amc_visits_manual_invoice_by_fk,
--     DROP CONSTRAINT amc_visits_manual_invoice_no_ck, DROP CONSTRAINT amc_visits_manual_invoice_set_ck,
--     DROP COLUMN manual_invoice_no, DROP COLUMN manual_invoice_at, DROP COLUMN manual_invoice_by;

ALTER TABLE amc_visits
  ADD COLUMN manual_invoice_no text,
  ADD COLUMN manual_invoice_at timestamptz,
  ADD COLUMN manual_invoice_by bigint,
  ADD CONSTRAINT amc_visits_manual_invoice_by_fk FOREIGN KEY (manual_invoice_by) REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT amc_visits_manual_invoice_no_ck CHECK (
    manual_invoice_no IS NULL OR (manual_invoice_no <> '' AND manual_invoice_no = btrim(manual_invoice_no) AND length(manual_invoice_no) <= 50)
  ),
  ADD CONSTRAINT amc_visits_manual_invoice_set_ck CHECK (
    (manual_invoice_no IS NULL) = (manual_invoice_at IS NULL) AND (manual_invoice_no IS NULL) = (manual_invoice_by IS NULL)
  );

CREATE INDEX amc_visits_manual_invoice_at_idx ON amc_visits (manual_invoice_at) WHERE manual_invoice_no IS NOT NULL;
