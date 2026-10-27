-- 0076_maintenance_frequency_rules
--
-- STAGED FOR REVIEW. This file is deliberately outside migrations/: the
-- migration runner, and every API test run (tests/global-setup.ts rebuilds the
-- shared stslv_test schema from migrations/), would otherwise apply it. Move it
-- into migrations/ only with approval, together with the test-reset change
-- described under "Before this file moves into migrations/" below.
--
-- Turns the maintenance frequency list (0075) into the scheduling rules the
-- schedule engine will read, and prepares contract-level custom months and
-- service-code snapshots on visits.
--
-- 1. maintenance_frequencies gains the rule: services per year, months between
--    services, the custom month-selection flag, the service-code prefix and an
--    archive date. Statuses: Active (is_active), Disabled (not active, not
--    archived), Archived (archived_at set; always inactive).
-- 2. The four existing frequencies keep their codes, labels, sort order and
--    status, and get their rule (the intervals the engine already uses:
--    amc.constants.ts FREQUENCY_MONTHS).
-- 3. Three further reference frequencies are added INACTIVE: the schedule
--    engine cannot generate them yet. The application refuses to activate a
--    frequency the engine does not support.
-- 4. amc_contracts.maintenance_frequency keeps its text code. Its fixed list of
--    four codes is replaced by a foreign key to maintenance_frequencies(code):
--    a code in use can never be renamed or removed (ON UPDATE / ON DELETE
--    RESTRICT), and a contract can only name a frequency that exists.
-- 5. amc_contract_custom_months: the months a contract on a custom frequency
--    is serviced in. Empty until the AMC Contracts integration uses it.
-- 6. amc_visits.cycle_no and amc_visits.service_code: a label snapshot taken
--    when a visit is generated ("Year 2 · Q3"). Existing visits are NOT
--    backfilled; they stay NULL and keep showing their visit number.
--
-- Additive except for the two constraints it replaces (maintenance_frequencies_code_ck
-- from 0075 and amc_contracts_maintenance_frequency_ck from 0010). No existing
-- contract, visit, invoice or audit row is changed.
--
-- Requires 0075 (and therefore runs after it). Fails, changing nothing, if any
-- of the four 0075 rows is missing or a contract names a code that has no row.
--
-- Locks: each ALTER TABLE takes a brief ACCESS EXCLUSIVE lock. Adding the
-- foreign key scans amc_contracts once to validate it (a few thousand rows at
-- most). Apply outside working hours on a shared database.
--
-- Before this file moves into migrations/:
--   tests/helpers.ts resetData() runs "TRUNCATE ... users ... CASCADE". Through
--   created_by that empties maintenance_frequencies, and with the new foreign
--   key every later test that creates a contract would fail. resetData() must
--   re-insert the frequency rows (shared test file: needs approval).
--
-- To reverse (with approval, and only while every contract uses one of the
-- four original codes and no contract has custom months):
--   ALTER TABLE amc_visits DROP COLUMN service_code, DROP COLUMN cycle_no;
--   DROP TABLE amc_contract_custom_months;
--   ALTER TABLE amc_contracts DROP CONSTRAINT amc_contracts_maintenance_frequency_fk;
--   DROP INDEX amc_contracts_maintenance_frequency_idx;
--   ALTER TABLE amc_contracts ADD CONSTRAINT amc_contracts_maintenance_frequency_ck
--     CHECK (maintenance_frequency IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY'));
--   DELETE FROM maintenance_frequencies WHERE code NOT IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY');
--   DROP INDEX maintenance_frequencies_prefix_uq;
--   ALTER TABLE maintenance_frequencies
--     DROP CONSTRAINT maintenance_frequencies_code_ck, DROP CONSTRAINT maintenance_frequencies_prefix_ck,
--     DROP CONSTRAINT maintenance_frequencies_rule_ck, DROP CONSTRAINT maintenance_frequencies_archived_ck,
--     DROP COLUMN archived_at, DROP COLUMN code_prefix, DROP COLUMN is_custom,
--     DROP COLUMN interval_months, DROP COLUMN service_count,
--     ADD CONSTRAINT maintenance_frequencies_code_ck CHECK (code IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY'));
--   (and remove the 0076 row from the migration history table)

-- ---------------------------------------------------------------------------
-- 1. Frequency rules
-- ---------------------------------------------------------------------------

ALTER TABLE maintenance_frequencies
  DROP CONSTRAINT maintenance_frequencies_code_ck,
  -- Services per year. NULL only for a custom frequency.
  ADD COLUMN service_count   smallint,
  -- Months between two services. NULL only for a custom frequency.
  ADD COLUMN interval_months smallint,
  -- True: the months are chosen on each contract (amc_contract_custom_months).
  ADD COLUMN is_custom       boolean     NOT NULL DEFAULT false,
  -- Start of the service code shown on generated visits, for example "Q" in "Q3".
  ADD COLUMN code_prefix     text,
  -- Set when the frequency is archived. An archived frequency is always inactive.
  ADD COLUMN archived_at     timestamptz;

-- 2. The four existing frequencies: the intervals the engine already uses.
UPDATE maintenance_frequencies SET service_count = 12, interval_months = 1,  code_prefix = 'M' WHERE code = 'MONTHLY';
UPDATE maintenance_frequencies SET service_count = 4,  interval_months = 3,  code_prefix = 'Q' WHERE code = 'QUARTERLY';
UPDATE maintenance_frequencies SET service_count = 2,  interval_months = 6,  code_prefix = 'H' WHERE code = 'HALF_YEARLY';
UPDATE maintenance_frequencies SET service_count = 1,  interval_months = 12, code_prefix = 'A' WHERE code = 'ANNUALLY';

DO $$
BEGIN
  IF (SELECT count(*) FROM maintenance_frequencies WHERE code IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY')) <> 4 THEN
    RAISE EXCEPTION '0076: the four maintenance frequencies of 0075 are not all present.';
  END IF;
END $$;

ALTER TABLE maintenance_frequencies
  ALTER COLUMN code_prefix SET NOT NULL,
  -- Codes are stable internal keys: upper case, digits and underscores.
  ADD CONSTRAINT maintenance_frequencies_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  ADD CONSTRAINT maintenance_frequencies_prefix_ck CHECK (code_prefix ~ '^[A-Z]{1,4}$'),
  -- A fixed rule divides the year evenly; a custom rule has neither number.
  ADD CONSTRAINT maintenance_frequencies_rule_ck CHECK (
    (is_custom AND service_count IS NULL AND interval_months IS NULL)
    OR (
      -- IS NOT NULL is needed: a NULL would make the whole condition NULL, which a CHECK lets through.
      NOT is_custom
      AND interval_months IS NOT NULL
      AND service_count IS NOT NULL
      AND interval_months IN (1, 2, 3, 4, 6, 12)
      AND service_count > 0
      AND service_count * interval_months = 12
    )
  ),
  ADD CONSTRAINT maintenance_frequencies_archived_ck CHECK (archived_at IS NULL OR NOT is_active);

-- Unique across every row, archived ones included, so a service code printed
-- on an old visit can never come to mean a different frequency.
CREATE UNIQUE INDEX maintenance_frequencies_prefix_uq ON maintenance_frequencies (upper(code_prefix));

-- 3. The further reference frequencies, inactive until the engine supports them.
INSERT INTO maintenance_frequencies (code, label, sort_order, is_active, service_count, interval_months, is_custom, code_prefix) VALUES
  ('BI_MONTHLY', 'Bi-Monthly / Every 2 Months', 5, false, 6, 2, false, 'BM'),
  ('EVERY_4_MONTHS', 'Every 4 Months', 6, false, 3, 4, false, 'T'),
  ('CUSTOM', 'Custom', 7, false, NULL, NULL, true, 'C');

-- ---------------------------------------------------------------------------
-- 4. Contracts refer to a frequency row
-- ---------------------------------------------------------------------------

ALTER TABLE amc_contracts DROP CONSTRAINT amc_contracts_maintenance_frequency_ck;

-- Serves the foreign key and the linked-contract counts.
CREATE INDEX amc_contracts_maintenance_frequency_idx ON amc_contracts (maintenance_frequency);

ALTER TABLE amc_contracts
  ADD CONSTRAINT amc_contracts_maintenance_frequency_fk FOREIGN KEY (maintenance_frequency)
    REFERENCES maintenance_frequencies (code) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 5. Custom months of a contract
-- ---------------------------------------------------------------------------

-- One row per selected month (1 = January). Whether the contract's frequency is
-- custom, and the 1-11 month limit, are checked by the application, which
-- writes these rows in the same transaction as the contract.
CREATE TABLE amc_contract_custom_months (
  amc_contract_id bigint      NOT NULL,
  month           smallint    NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint,
  CONSTRAINT amc_contract_custom_months_pk PRIMARY KEY (amc_contract_id, month),
  CONSTRAINT amc_contract_custom_months_month_ck CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT amc_contract_custom_months_contract_fk FOREIGN KEY (amc_contract_id) REFERENCES amc_contracts (id) ON DELETE RESTRICT,
  CONSTRAINT amc_contract_custom_months_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX amc_contract_custom_months_created_by_idx ON amc_contract_custom_months (created_by);

-- ---------------------------------------------------------------------------
-- 6. Service-code snapshot on visits
-- ---------------------------------------------------------------------------

-- Set once, when a visit is generated, and never recalculated: a later change
-- of the contract's frequency cannot relabel a visit. NULL on every visit
-- generated before this migration (no backfill); those show their visit number.
ALTER TABLE amc_visits
  ADD COLUMN cycle_no     integer,
  ADD COLUMN service_code text,
  ADD CONSTRAINT amc_visits_cycle_no_ck CHECK (cycle_no IS NULL OR cycle_no > 0),
  ADD CONSTRAINT amc_visits_service_code_ck CHECK (service_code IS NULL OR service_code ~ '^[A-Z]{1,4}[1-9][0-9]{0,2}$'),
  ADD CONSTRAINT amc_visits_service_label_ck CHECK ((cycle_no IS NULL) = (service_code IS NULL));
