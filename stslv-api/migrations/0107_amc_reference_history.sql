-- 0107_amc_reference_history
-- PREPARED FOR REVIEW. Applied to isolated test databases only. A release applies
-- it when the API starts, so releasing needs approval of this file too.
--
-- AMC Reference Number history (approved 2026-11-04). The reference became
-- editable in Edit AMC Contract; a number a contract has ever held must never be
-- given to another contract, including a number given up by an edit.
--
--   * amc_contract_references keeps every reference a contract has held: the one
--     it holds now (retired_at NULL) and every earlier one (retired_at set). The
--     key is lower(reference), so the rule ignores case, as 0105's index does.
--   * Triggers on amc_contracts_all keep it up to date for every path that writes
--     a reference (the API, renewals, the legacy importer, scripts):
--       - INSERT: the new reference is registered; if any contract has ever held
--         it, the insert is refused (unique violation, constraint
--         amc_contract_references_pk).
--       - UPDATE of the reference: the old one is marked retired, the new one is
--         registered the same way. A contract may take back a number it held
--         itself before; a change of letter case only keeps the same entry.
--     Two simultaneous requests for one number: the primary key makes the second
--     wait and then be refused, so only one can succeed.
--   * Backfill: every existing contract (cancelled and Recycle Bin included) gets
--     its current reference registered as held. No contract, reference, service,
--     invoice, audit entry or relationship is changed. No reference has been
--     edited on any database before this migration (the edit arrives with it), so
--     there is no earlier history to recover.
--   * amc_contract_id refers to amc_contracts_all ON DELETE CASCADE: the
--     application never deletes a contract row (the Recycle Bin only marks it), so
--     a reservation lasts as long as its contract, which in practice is for ever.
--     Only a deliberate administrative reset that removes contract rows also
--     removes their reservations, instead of being blocked by this table.
--
-- Reverse (only with approval; the history of changed numbers would be lost):
--   DROP TRIGGER amc_contracts_reference_history_update ON amc_contracts_all;
--   DROP TRIGGER amc_contracts_reference_history_insert ON amc_contracts_all;
--   DROP FUNCTION amc_contracts_reference_history();
--   DROP TABLE amc_contract_references;

CREATE TABLE amc_contract_references (
  reference_key   text        NOT NULL,
  reference       text        NOT NULL,
  amc_contract_id bigint      NOT NULL,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  assigned_by     bigint,
  retired_at      timestamptz,
  retired_by      bigint,
  CONSTRAINT amc_contract_references_pk PRIMARY KEY (reference_key),
  CONSTRAINT amc_contract_references_key_ck CHECK (reference_key = lower(reference)),
  CONSTRAINT amc_contract_references_contract_fk FOREIGN KEY (amc_contract_id) REFERENCES amc_contracts_all (id) ON DELETE CASCADE,
  CONSTRAINT amc_contract_references_assigned_by_fk FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT amc_contract_references_retired_by_fk FOREIGN KEY (retired_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX amc_contract_references_contract_idx ON amc_contract_references (amc_contract_id);
-- A contract holds exactly one current reference.
CREATE UNIQUE INDEX amc_contract_references_current_uq ON amc_contract_references (amc_contract_id) WHERE retired_at IS NULL;
CREATE INDEX amc_contract_references_assigned_by_idx ON amc_contract_references (assigned_by);
CREATE INDEX amc_contract_references_retired_by_idx ON amc_contract_references (retired_by);

INSERT INTO amc_contract_references (reference_key, reference, amc_contract_id, assigned_at, assigned_by)
SELECT lower(amc_reference), amc_reference, id, created_at, created_by
FROM amc_contracts_all;

CREATE FUNCTION amc_contracts_reference_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor bigint := CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.updated_by END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF lower(NEW.amc_reference) = lower(OLD.amc_reference) THEN
      -- Only the letter case changed: the same entry, written as now typed.
      UPDATE amc_contract_references SET reference = NEW.amc_reference
      WHERE reference_key = lower(NEW.amc_reference) AND amc_contract_id = NEW.id;
      RETURN NEW;
    END IF;

    UPDATE amc_contract_references SET retired_at = now(), retired_by = actor
    WHERE amc_contract_id = NEW.id AND retired_at IS NULL;
  END IF;

  -- Registers the number. A number this contract held before is taken back; one any other contract has held is refused.
  INSERT INTO amc_contract_references (reference_key, reference, amc_contract_id, assigned_by)
  VALUES (lower(NEW.amc_reference), NEW.amc_reference, NEW.id, actor)
  ON CONFLICT (reference_key) DO UPDATE
    SET reference = EXCLUDED.reference, assigned_at = now(), assigned_by = EXCLUDED.assigned_by, retired_at = NULL, retired_by = NULL
    WHERE amc_contract_references.amc_contract_id = EXCLUDED.amc_contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AMC Reference Number "%" has already been used by another contract.', NEW.amc_reference
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'amc_contract_references_pk', TABLE = 'amc_contract_references';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER amc_contracts_reference_history_insert
  AFTER INSERT ON amc_contracts_all
  FOR EACH ROW EXECUTE FUNCTION amc_contracts_reference_history();

CREATE TRIGGER amc_contracts_reference_history_update
  AFTER UPDATE OF amc_reference ON amc_contracts_all
  FOR EACH ROW WHEN (OLD.amc_reference IS DISTINCT FROM NEW.amc_reference)
  EXECUTE FUNCTION amc_contracts_reference_history();
