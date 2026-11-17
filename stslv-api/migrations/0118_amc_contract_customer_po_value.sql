-- 0118_amc_contract_customer_po_value
-- PREPARED FOR REVIEW (client UAT 2026-11-16, CR-013; owner decision 2026-11-17). Applied to isolated local databases
-- only. A release applies it when the API starts, so releasing needs approval of this file.
--
-- The Customer PO Value (ex VAT) of an AMC contract: the amount of the customer's purchase order, excluding VAT, typed
-- on the contract form and shown as "AMC Value (ex VAT)" on Accounts › Invoices so Accounts can invoice from it.
--
--   * It is NOT the AMC Value / Year (contract_value) nor the term total the schedule computes: a PO can cover one
--     year, several years or a different amount. Nothing is calculated from it, and no visit amount reads it.
--   * Nullable, never backfilled: an existing contract has no PO value until someone enters one ("Not entered").
--   * OMR, three decimals, zero or more, like the other contract amounts.
--   * amc_contracts is a view over amc_contracts_all (migration 0101, Recycle Bin). The column is added to the table
--     and the view is re-created with the same definition (0111), so it shows the new column last.
--
-- To reverse (only with approval; it discards every PO value entered):
--   CREATE OR REPLACE cannot drop a view column, so: DROP VIEW amc_contracts; CREATE VIEW amc_contracts AS
--   SELECT <every column of amc_contracts_all except customer_po_value> FROM amc_contracts_all WHERE deleted_at IS NULL;
--   then ALTER TABLE amc_contracts_all DROP COLUMN customer_po_value; DELETE FROM schema_migrations WHERE version = '0118';

ALTER TABLE amc_contracts_all
  ADD COLUMN customer_po_value numeric(14,3),
  ADD CONSTRAINT amc_contracts_customer_po_value_ck CHECK (customer_po_value IS NULL OR customer_po_value >= 0);

CREATE OR REPLACE VIEW amc_contracts AS
SELECT * FROM amc_contracts_all WHERE deleted_at IS NULL;
