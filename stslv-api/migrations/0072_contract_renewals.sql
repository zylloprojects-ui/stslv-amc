-- 0072_contract_renewals
-- A renewal is a new AMC contract linked to the contract it renews. Creating
-- it never changes the source contract, its schedule, invoices or history.
--
-- Additive only: the column is null for every existing contract.
--
-- A source contract has at most one renewal that is not cancelled, so a
-- cancelled renewal draft does not block renewing again.
--
-- To reverse (only while no renewal exists, and with approval):
--   ALTER TABLE amc_contracts DROP COLUMN renewed_from_id;

ALTER TABLE amc_contracts
  ADD COLUMN renewed_from_id bigint,
  ADD CONSTRAINT amc_contracts_renewed_from_fk FOREIGN KEY (renewed_from_id) REFERENCES amc_contracts (id) ON DELETE RESTRICT,
  ADD CONSTRAINT amc_contracts_renewed_from_ck CHECK (renewed_from_id <> id);

CREATE INDEX amc_contracts_renewed_from_idx ON amc_contracts (renewed_from_id);
CREATE UNIQUE INDEX amc_contracts_one_open_renewal_uq ON amc_contracts (renewed_from_id)
  WHERE renewed_from_id IS NOT NULL AND status <> 'CANCELLED';
