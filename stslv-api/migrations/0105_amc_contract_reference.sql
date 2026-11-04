-- 0105_amc_contract_reference
-- PREPARED FOR REVIEW. Applied to isolated test databases only. Apply after
-- 0102, 0103 and 0104 (parallel branches); it does not depend on them.
--
-- Manual AMC Reference Number (requested 2026-11-04). Until now the reference
-- ("AMC-0007") was derived from the contract id and never stored. From this
-- migration it is stored, typed by the user when a contract or renewal is
-- created, never generated, and read-only afterwards.
--
--   * Every existing contract, including those in the Recycle Bin and cancelled
--     ones, keeps exactly the reference it showed before: 'AMC-' and the id
--     padded to four digits. Nothing is renumbered.
--   * Required, trimmed, 1 to 50 characters, letters, digits, spaces and
--     - _ . / & (the master-code convention), starting with a letter or digit.
--     Case is kept as typed.
--   * Unique without regard to case over amc_contracts_all, so a reference of a
--     cancelled contract or one in the Recycle Bin can never be reused. The unique
--     index also makes two simultaneous creations with one reference safe.
--   * Relationships keep using the contract id; nothing references this text.
--
-- The backfill runs with the updated_at trigger disabled, so no contract looks
-- edited by this migration.
--
-- Reverse (only with approval; typed references would be lost):
--   DROP INDEX amc_contracts_reference_uq;
--   DROP VIEW amc_contracts;  -- a view cannot lose a column through CREATE OR REPLACE
--   ALTER TABLE amc_contracts_all DROP CONSTRAINT amc_contracts_reference_ck, DROP COLUMN amc_reference;
--   CREATE VIEW amc_contracts AS SELECT * FROM amc_contracts_all WHERE deleted_at IS NULL;
--   (Check pg_depend for other views on amc_contracts before dropping it on a live database.)

ALTER TABLE amc_contracts_all ADD COLUMN amc_reference text;

ALTER TABLE amc_contracts_all DISABLE TRIGGER amc_contracts_set_updated_at;
UPDATE amc_contracts_all SET amc_reference = 'AMC-' || lpad(id::text, greatest(4, length(id::text)), '0');
ALTER TABLE amc_contracts_all ENABLE TRIGGER amc_contracts_set_updated_at;

ALTER TABLE amc_contracts_all
  ALTER COLUMN amc_reference SET NOT NULL,
  ADD CONSTRAINT amc_contracts_reference_ck CHECK (
    amc_reference = btrim(amc_reference)
    AND length(amc_reference) BETWEEN 1 AND 50
    AND amc_reference ~ '^[A-Za-z0-9][A-Za-z0-9 _./&-]*$'
  );

CREATE UNIQUE INDEX amc_contracts_reference_uq ON amc_contracts_all (lower(amc_reference));

-- The view lists the table's columns as they were when it was created; this adds the new one.
CREATE OR REPLACE VIEW amc_contracts AS
SELECT * FROM amc_contracts_all WHERE deleted_at IS NULL;
