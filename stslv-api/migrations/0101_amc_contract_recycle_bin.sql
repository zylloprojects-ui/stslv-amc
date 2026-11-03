-- 0101_amc_contract_recycle_bin
-- PREPARED FOR REVIEW. Applied to isolated test databases only. A release applies
-- it when the API starts, so releasing needs approval of this file too.
--
-- AMC Recycle Bin (approved 2026-11-03). Super Admin can move an AMC contract to
-- the Recycle Bin and restore it. Nothing is physically deleted: the contract,
-- its services, invoices, documents and history all stay.
--
-- How deleted contracts are kept out of normal use, without editing every query:
--   * The tables are renamed amc_contracts_all and amc_visits_all. They hold every
--     row, including those in the Recycle Bin. Foreign keys, indexes, triggers and
--     sequences move with them unchanged; every key stays ON DELETE RESTRICT.
--   * Views with the old names, amc_contracts and amc_visits, show only contracts
--     that are not deleted, and only the services of those contracts. They are
--     simple views, so the application's INSERT, UPDATE, DELETE and FOR UPDATE work
--     through them unchanged, and a contract in the Recycle Bin can be neither read
--     nor changed through them: it is "not found" everywhere.
--   * Only the Recycle Bin itself (and invoice allocation display) reads *_all.
--
-- FOR LATER MIGRATIONS: alter amc_contracts_all / amc_visits_all (not the views),
-- reference them in new foreign keys, and recreate the matching view afterwards
-- (CREATE OR REPLACE VIEW ... SELECT * ...) so it shows any new column.
--
-- Reverse (only with approval; contracts in the Recycle Bin would reappear):
--   DROP VIEW v_amc_visit_billing; DROP VIEW amc_visits; DROP VIEW amc_contracts;
--   DROP INDEX amc_contracts_one_open_renewal_uq;
--   ALTER TABLE amc_contracts_all DROP CONSTRAINT amc_contracts_deleted_ck,
--     DROP CONSTRAINT amc_contracts_deleted_by_fk, DROP COLUMN deleted_at, DROP COLUMN deleted_by;
--   ALTER TABLE amc_contracts_all RENAME TO amc_contracts; ALTER TABLE amc_visits_all RENAME TO amc_visits;
--   then recreate amc_contracts_one_open_renewal_uq and v_amc_visit_billing as in 0072 and 0060.

ALTER TABLE amc_contracts RENAME TO amc_contracts_all;
ALTER TABLE amc_visits RENAME TO amc_visits_all;

ALTER TABLE amc_contracts_all
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by bigint,
  ADD CONSTRAINT amc_contracts_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES users (id) ON DELETE RESTRICT,
  -- Both are set when a contract goes to the Recycle Bin, and both cleared on restore.
  ADD CONSTRAINT amc_contracts_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

-- The Recycle Bin lists deleted contracts.
CREATE INDEX amc_contracts_deleted_at_idx ON amc_contracts_all (deleted_at) WHERE deleted_at IS NOT NULL;

-- A renewal in the Recycle Bin no longer blocks renewing its source again. Restoring
-- it is refused while another renewal of the same source is open.
DROP INDEX amc_contracts_one_open_renewal_uq;
CREATE UNIQUE INDEX amc_contracts_one_open_renewal_uq ON amc_contracts_all (renewed_from_id)
  WHERE renewed_from_id IS NOT NULL AND status <> 'CANCELLED' AND deleted_at IS NULL;

CREATE VIEW amc_contracts AS
SELECT * FROM amc_contracts_all WHERE deleted_at IS NULL;

CREATE VIEW amc_visits AS
SELECT * FROM amc_visits_all v
WHERE EXISTS (SELECT 1 FROM amc_contracts_all c WHERE c.id = v.amc_contract_id AND c.deleted_at IS NULL);

-- v_amc_visit_billing was bound to the renamed table; the same definition (0060)
-- now reads the view, so services of deleted contracts leave the billing workflow.
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
  COALESCE(a.invoiced_amount, 0)::numeric(16,3) AS invoiced_amount
FROM amc_visits v
LEFT JOIN (
  SELECT al.amc_visit_id, sum(al.allocated_amount) AS invoiced_amount
  FROM invoice_allocations al
  JOIN invoices i ON i.id = al.invoice_id
  WHERE al.amc_visit_id IS NOT NULL AND i.status <> 'CANCELLED'
  GROUP BY al.amc_visit_id
) a ON a.amc_visit_id = v.id;
