-- 0075_maintenance_frequencies
-- A master list of the maintenance frequencies, so that administrators can set
-- the label each one is shown with and stop offering one for new contracts.
--
-- The four codes are fixed. They are the codes the schedule generator uses
-- (amc.constants.ts FREQUENCY_MONTHS) and the values allowed by
-- amc_contracts_maintenance_frequency_ck; no other code can be added here.
-- Each contract keeps its own maintenance_frequency code, so changing a label
-- or deactivating a frequency never changes a contract or a generated visit.
--
-- Additive only: no existing table or row is changed.
--
-- To reverse (with approval): DROP TABLE maintenance_frequencies;

CREATE TABLE maintenance_frequencies (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  code        text        NOT NULL,
  label       text        NOT NULL,
  sort_order  integer     NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  updated_by  bigint,
  CONSTRAINT maintenance_frequencies_pk PRIMARY KEY (id),
  CONSTRAINT maintenance_frequencies_code_uq UNIQUE (code),
  CONSTRAINT maintenance_frequencies_code_ck CHECK (code IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY')),
  CONSTRAINT maintenance_frequencies_label_ck CHECK (btrim(label) <> ''),
  CONSTRAINT maintenance_frequencies_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT maintenance_frequencies_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX maintenance_frequencies_label_uq ON maintenance_frequencies (lower(btrim(label)));
CREATE INDEX maintenance_frequencies_created_by_idx ON maintenance_frequencies (created_by);
CREATE INDEX maintenance_frequencies_updated_by_idx ON maintenance_frequencies (updated_by);

CREATE TRIGGER maintenance_frequencies_set_updated_at
  BEFORE UPDATE ON maintenance_frequencies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The four existing frequencies, all active, with the labels the application already shows.
INSERT INTO maintenance_frequencies (code, label, sort_order) VALUES
  ('MONTHLY', 'Monthly', 1),
  ('QUARTERLY', 'Quarterly', 2),
  ('HALF_YEARLY', 'Half-yearly', 3),
  ('ANNUALLY', 'Annually', 4);
