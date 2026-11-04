-- 0102_sales_engineer_code
-- PREPARED FOR REVIEW. Applied to isolated test databases only. A release applies
-- it when the API starts, so releasing needs approval of this file too.
--
-- Sales Engineers: manual engineer code and permanent delete (requested 2026-11-03).
--
-- Until now the engineer code was not stored: the API derived "SE-0001" from the
-- id. The code is now a stored, editable, required value:
--   * code is backfilled with exactly the code each engineer shows today, so no
--     existing code changes. The id stays the primary key and the only key that
--     contracts refer to (amc_contracts_all.sales_engineer_id), so a changed code
--     never breaks a link.
--   * A code is unique ignoring case and surrounding spaces, across active and
--     disabled engineers alike.
--   * An INSERT that names no code (scripts, older test fixtures) still gets the
--     old "SE-" form from the trigger below. The API itself always requires one.
--   * sales_engineer_retired_codes keeps the code of every permanently deleted
--     engineer, so the code is never given to another engineer. The API checks it
--     on create and edit.
--
-- No table other than sales_engineers is changed, and no foreign key is added or
-- altered: contracts keep ON DELETE RESTRICT, so an engineer on any contract
-- (including one in the Recycle Bin) can never be deleted.
--
-- Reverse (only with approval; manually entered codes would be lost):
--   DROP TABLE sales_engineer_retired_codes;
--   DROP TRIGGER sales_engineers_default_code ON sales_engineers;
--   DROP FUNCTION sales_engineers_default_code();
--   DROP INDEX sales_engineers_code_uq;
--   ALTER TABLE sales_engineers DROP CONSTRAINT sales_engineers_code_ck, DROP COLUMN code;

ALTER TABLE sales_engineers ADD COLUMN code text;

-- The code each engineer shows today (the former derivation in masters.service.ts).
-- The backfill runs with the updated_at trigger disabled, so no engineer looks edited by this migration
-- (the same approach as 0105; added during the Sessions 1-12 integration rehearsal, before 0102 was
-- applied to any shared database).
ALTER TABLE sales_engineers DISABLE TRIGGER sales_engineers_set_updated_at;
UPDATE sales_engineers
SET code = 'SE-' || lpad(id::text, greatest(4, length(id::text)), '0')
WHERE code IS NULL;
ALTER TABLE sales_engineers ENABLE TRIGGER sales_engineers_set_updated_at;

ALTER TABLE sales_engineers
  ALTER COLUMN code SET NOT NULL,
  -- Not blank, and stored without surrounding spaces (the API trims it).
  ADD CONSTRAINT sales_engineers_code_ck CHECK (btrim(code) <> '' AND code = btrim(code) AND length(code) <= 20);

CREATE UNIQUE INDEX sales_engineers_code_uq ON sales_engineers (lower(code));

-- Fills a code an INSERT left out, in the former SE-0001 form. The id is already
-- assigned when a BEFORE INSERT trigger runs.
CREATE FUNCTION sales_engineers_default_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL THEN
    NEW.code := 'SE-' || lpad(NEW.id::text, greatest(4, length(NEW.id::text)), '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_engineers_default_code
  BEFORE INSERT ON sales_engineers
  FOR EACH ROW EXECUTE FUNCTION sales_engineers_default_code();

-- Codes of permanently deleted engineers. Never reused; rows are only added.
CREATE TABLE sales_engineer_retired_codes (
  code_key    text        NOT NULL,
  code        text        NOT NULL,
  engineer_id bigint      NOT NULL,
  name        text        NOT NULL,
  retired_at  timestamptz NOT NULL DEFAULT now(),
  retired_by  bigint,
  CONSTRAINT sales_engineer_retired_codes_pk PRIMARY KEY (code_key),
  CONSTRAINT sales_engineer_retired_codes_key_ck CHECK (code_key = lower(code)),
  CONSTRAINT sales_engineer_retired_codes_retired_by_fk FOREIGN KEY (retired_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX sales_engineer_retired_codes_retired_by_idx ON sales_engineer_retired_codes (retired_by);
