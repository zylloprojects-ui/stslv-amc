-- 0111_amc_contract_versions
-- PREPARED FOR REVIEW (STS-ELV client fixes, owner approval 2026-11-09). Applied to isolated test databases only.
-- A release applies it when the API starts, so releasing needs approval of this file too.
--
-- Same visible contract number across renewals, with a unique identity and version per contract period:
--
--   STS-AMC-001  version 1  (the original contract: version_root_id = its own id)
--   STS-AMC-001  version 2  (its first renewal:     version_root_id = the original's id)
--   STS-AMC-001  version 3  (the next renewal)
--
-- Each period stays its own amc_contracts_all row: its id is the internal identity that visits, invoices,
-- documents, the Audit Log and renewals already refer to. Nothing that refers to a contract changes.
--
-- Integrity (no weaker than before):
--   * amc_contracts_reference_uq (0105) was "lower(amc_reference) is unique on every contract". It becomes "unique on
--     every version-1 contract" (same name). Every later version must carry exactly its root's number (trigger
--     below) and (version_root_id, contract_version) is unique, so a number still belongs to exactly one contract
--     chain, and no other contract can take it.
--   * A version > 1 must name a version-1 root, and if it renews a contract, that contract is in the same chain.
--   * The number history (0107, amc_contract_references) stays per number and is owned by the root. A later version
--     never adds or retires a number. Renaming the root renames every version with it.
--
-- Existing data: every contract becomes version 1 of its own number (version_root_id = id). No number, value, visit,
-- invoice, document or log is changed or rewritten; renewals made before this migration keep their own numbers.
-- updated_at is not touched by the backfill.
--
-- Reverse (only with approval, and only while no contract has contract_version > 1):
--   DROP TRIGGER amc_contracts_version_cascade ON amc_contracts_all;
--   DROP TRIGGER amc_contracts_version_check ON amc_contracts_all;
--   DROP TRIGGER amc_contracts_version_default ON amc_contracts_all;
--   DROP FUNCTION amc_contracts_version_cascade(); DROP FUNCTION amc_contracts_version_check();
--   DROP FUNCTION amc_contracts_version_default();
--   re-create amc_contracts_reference_history() as in 0107;
--   DROP INDEX amc_contracts_reference_uq; CREATE UNIQUE INDEX amc_contracts_reference_uq ON amc_contracts_all (lower(amc_reference));
--   re-create the amc_contracts view without the two columns, then
--   ALTER TABLE amc_contracts_all DROP COLUMN contract_version, DROP COLUMN version_root_id;

ALTER TABLE amc_contracts_all
  ADD COLUMN version_root_id bigint,
  ADD COLUMN contract_version integer;

ALTER TABLE amc_contracts_all DISABLE TRIGGER amc_contracts_set_updated_at;
UPDATE amc_contracts_all SET version_root_id = id, contract_version = 1;
ALTER TABLE amc_contracts_all ENABLE TRIGGER amc_contracts_set_updated_at;

ALTER TABLE amc_contracts_all
  ALTER COLUMN version_root_id SET NOT NULL,
  ALTER COLUMN contract_version SET NOT NULL,
  ADD CONSTRAINT amc_contracts_version_root_fk FOREIGN KEY (version_root_id) REFERENCES amc_contracts_all (id) ON DELETE RESTRICT,
  ADD CONSTRAINT amc_contracts_version_ck CHECK (contract_version >= 1 AND (contract_version = 1) = (version_root_id = id)),
  ADD CONSTRAINT amc_contracts_version_uq UNIQUE (version_root_id, contract_version);

-- A contract inserted without a version (every insert except a renewal version) is version 1 of its own number.
-- The identity column's value is already in NEW.id in a BEFORE trigger.
CREATE FUNCTION amc_contracts_version_default() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version_root_id IS NULL THEN
    NEW.version_root_id := NEW.id;
    NEW.contract_version := 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amc_contracts_version_default
  BEFORE INSERT ON amc_contracts_all
  FOR EACH ROW EXECUTE FUNCTION amc_contracts_version_default();

-- A later version carries exactly its root's number, its root is a version 1, and the contract it renews is in the
-- same chain.
CREATE FUNCTION amc_contracts_version_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  root_reference text;
  root_version integer;
  source_root bigint;
BEGIN
  IF NEW.contract_version > 1 THEN
    SELECT amc_reference, contract_version INTO root_reference, root_version FROM amc_contracts_all WHERE id = NEW.version_root_id;

    IF root_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'A contract version must belong to an original (version 1) contract.'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'amc_contracts_version_root_ck', TABLE = 'amc_contracts_all';
    END IF;
    IF lower(NEW.amc_reference) IS DISTINCT FROM lower(root_reference) THEN
      RAISE EXCEPTION 'Contract version % must keep the contract number % of its original contract.', NEW.contract_version, root_reference
        USING ERRCODE = 'check_violation', CONSTRAINT = 'amc_contracts_version_reference_ck', TABLE = 'amc_contracts_all';
    END IF;
    IF NEW.renewed_from_id IS NOT NULL THEN
      SELECT version_root_id INTO source_root FROM amc_contracts_all WHERE id = NEW.renewed_from_id;
      IF source_root IS DISTINCT FROM NEW.version_root_id THEN
        RAISE EXCEPTION 'A contract version can only renew a contract with the same contract number.'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'amc_contracts_version_link_ck', TABLE = 'amc_contracts_all';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER amc_contracts_version_check
  BEFORE INSERT OR UPDATE OF amc_reference, version_root_id, contract_version, renewed_from_id ON amc_contracts_all
  FOR EACH ROW EXECUTE FUNCTION amc_contracts_version_check();

-- Renaming an original contract renames every later version with it, in the same statement's transaction.
CREATE FUNCTION amc_contracts_version_cascade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE amc_contracts_all SET amc_reference = NEW.amc_reference, updated_by = NEW.updated_by
  WHERE version_root_id = NEW.id AND id <> NEW.id AND amc_reference IS DISTINCT FROM NEW.amc_reference;
  RETURN NULL;
END;
$$;

CREATE TRIGGER amc_contracts_version_cascade
  AFTER UPDATE OF amc_reference ON amc_contracts_all
  FOR EACH ROW WHEN (NEW.contract_version = 1 AND OLD.amc_reference IS DISTINCT FROM NEW.amc_reference)
  EXECUTE FUNCTION amc_contracts_version_cascade();

-- 0105's uniqueness, now over the original (version 1) contracts; same index name, so its error mapping is unchanged.
DROP INDEX amc_contracts_reference_uq;
CREATE UNIQUE INDEX amc_contracts_reference_uq ON amc_contracts_all (lower(amc_reference)) WHERE contract_version = 1;

-- 0107's history: a number is recorded for its original contract only. A later version shares it and never adds,
-- moves or retires it. Otherwise unchanged from 0107.
CREATE OR REPLACE FUNCTION amc_contracts_reference_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor bigint := CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE NEW.updated_by END;
BEGIN
  IF NEW.contract_version > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF lower(NEW.amc_reference) = lower(OLD.amc_reference) THEN
      UPDATE amc_contract_references SET reference = NEW.amc_reference
      WHERE reference_key = lower(NEW.amc_reference) AND amc_contract_id = NEW.id;
      RETURN NEW;
    END IF;

    UPDATE amc_contract_references SET retired_at = now(), retired_by = actor
    WHERE amc_contract_id = NEW.id AND retired_at IS NULL;
  END IF;

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

CREATE INDEX amc_contracts_version_root_idx ON amc_contracts_all (version_root_id);

CREATE OR REPLACE VIEW amc_contracts AS
SELECT * FROM amc_contracts_all WHERE deleted_at IS NULL;
