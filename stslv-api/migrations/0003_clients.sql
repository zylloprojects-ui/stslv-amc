-- 0003_clients
-- Phase 1 Client Master. No client code: the legacy workbooks do not have one.

CREATE TABLE clients (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  name           text        NOT NULL,
  contact_person text,
  email          text,
  phone          text,
  address        text,
  notes          text,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Null only for rows not created by a signed-in user (for example a future import).
  created_by     bigint,
  updated_by     bigint,
  CONSTRAINT clients_pk PRIMARY KEY (id),
  CONSTRAINT clients_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT clients_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT clients_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- Rejects the same name entered twice with different letter case or outer
-- spaces ("IBIS" / "ibis "). It does not merge or match similar spellings
-- ("HOLIDAY INN" / "HOLIDAYINN" remain two different names).
CREATE UNIQUE INDEX clients_name_uq ON clients (lower(btrim(name)));

CREATE INDEX clients_created_by_idx ON clients (created_by);
CREATE INDEX clients_updated_by_idx ON clients (updated_by);

CREATE TRIGGER clients_set_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
