-- 0106_master_recycle_bin
-- PREPARED FOR REVIEW. Applied to isolated test databases only. Apply after 0105.
-- A release applies it when the API starts, so releasing needs approval of this file too.
--
-- Recycle Bin for Clients, System Types and Sales Engineers (approved 2026-11-04),
-- the same way 0101 did it for AMC contracts. Nothing is physically deleted when a
-- record is moved to the Recycle Bin; Super Admin can restore it with the same id.
--
--   * The tables are renamed clients_all, system_types_all and sales_engineers_all.
--     Foreign keys, unique indexes, triggers and sequences move with them unchanged,
--     and every key stays ON DELETE RESTRICT.
--   * Views with the old names show only the records that are not deleted. They are
--     simple views, so the application's INSERT, UPDATE, DELETE, RETURNING and
--     FOR UPDATE work through them unchanged, and the base table's column defaults
--     and triggers (updated_at, the engineer code default) still apply.
--   * The unique indexes stay on the *_all tables: a name or code held by a record in
--     the Recycle Bin stays reserved, so a restore can never collide with a newer
--     record.
--   * A record in the Recycle Bin cannot be newly referenced: guard triggers on
--     amc_contracts_all, invoices, projects and legacy_import_rows refuse a link to it
--     (SQLSTATE RB001), and restoring a contract whose client, system type or sales
--     engineer is in the Recycle Bin is refused the same way.
--   * A record still referenced by anything outside the Recycle Bin cannot be moved
--     to it (SQLSTATE RB002): AMC contracts not in the Recycle Bin (any status), and
--     for clients also invoices (any status), projects and import rows.
--   * sales_engineer_retired_codes is unchanged. An engineer in the Recycle Bin keeps
--     its code; only a permanent deletion retires it.
--
-- FOR LATER MIGRATIONS: alter clients_all / system_types_all / sales_engineers_all
-- (not the views), reference them in new foreign keys, and recreate the matching
-- view afterwards (CREATE OR REPLACE VIEW ... SELECT * ...) so it shows any new column.
--
-- Reverse (only with approval, and only while none of the three tables has a row in
-- the Recycle Bin, or those rows would reappear as live records):
--   DROP TRIGGER amc_contracts_recycle_bin_guard ON amc_contracts_all;
--   DROP TRIGGER invoices_recycle_bin_guard ON invoices;
--   DROP TRIGGER projects_recycle_bin_guard ON projects;
--   DROP TRIGGER legacy_import_rows_recycle_bin_guard ON legacy_import_rows;
--   DROP TRIGGER clients_recycle_bin_guard ON clients_all;
--   DROP TRIGGER system_types_recycle_bin_guard ON system_types_all;
--   DROP TRIGGER sales_engineers_recycle_bin_guard ON sales_engineers_all;
--   DROP FUNCTION recycle_bin_contract_guard(), recycle_bin_client_link_guard(), recycle_bin_master_guard();
--   DROP VIEW clients; DROP VIEW system_types; DROP VIEW sales_engineers;
--   for each of the three tables (the trigger first: its WHEN clause depends on deleted_at):
--     DROP TRIGGER <t>_set_updated_at ON <t>_all;
--     DROP INDEX <t>_deleted_at_idx; DROP INDEX <t>_deleted_by_idx;
--     ALTER TABLE <t>_all DROP CONSTRAINT <t>_deleted_ck, DROP CONSTRAINT <t>_deleted_by_fk,
--       DROP COLUMN deleted_at, DROP COLUMN deleted_by;
--     ALTER TABLE <t>_all RENAME TO <t>;
--     CREATE TRIGGER <t>_set_updated_at BEFORE UPDATE ON <t> FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--   DELETE FROM schema_migrations WHERE version = '0106';
-- (Rehearsed 2026-11-04 on a copy of stslv_amc_dev: the schema returns exactly to 0105.)

ALTER TABLE clients RENAME TO clients_all;
ALTER TABLE system_types RENAME TO system_types_all;
ALTER TABLE sales_engineers RENAME TO sales_engineers_all;

ALTER TABLE clients_all
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by bigint,
  ADD CONSTRAINT clients_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES users (id) ON DELETE RESTRICT,
  -- Both are set when a record goes to the Recycle Bin, and both cleared on restore.
  ADD CONSTRAINT clients_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

ALTER TABLE system_types_all
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by bigint,
  ADD CONSTRAINT system_types_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT system_types_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

ALTER TABLE sales_engineers_all
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by bigint,
  ADD CONSTRAINT sales_engineers_deleted_by_fk FOREIGN KEY (deleted_by) REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT sales_engineers_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

-- The Recycle Bin lists deleted records.
CREATE INDEX clients_deleted_at_idx ON clients_all (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX system_types_deleted_at_idx ON system_types_all (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX sales_engineers_deleted_at_idx ON sales_engineers_all (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX clients_deleted_by_idx ON clients_all (deleted_by) WHERE deleted_by IS NOT NULL;
CREATE INDEX system_types_deleted_by_idx ON system_types_all (deleted_by) WHERE deleted_by IS NOT NULL;
CREATE INDEX sales_engineers_deleted_by_idx ON sales_engineers_all (deleted_by) WHERE deleted_by IS NOT NULL;

-- Moving a record to the Recycle Bin or restoring it is recorded by deleted_at and
-- deleted_by (and the activity log); it does not change updated_at, which keeps
-- meaning "the record's details were last changed". Every other update still sets it.
DROP TRIGGER clients_set_updated_at ON clients_all;
CREATE TRIGGER clients_set_updated_at
  BEFORE UPDATE ON clients_all
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION set_updated_at();
DROP TRIGGER system_types_set_updated_at ON system_types_all;
CREATE TRIGGER system_types_set_updated_at
  BEFORE UPDATE ON system_types_all
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION set_updated_at();
DROP TRIGGER sales_engineers_set_updated_at ON sales_engineers_all;
CREATE TRIGGER sales_engineers_set_updated_at
  BEFORE UPDATE ON sales_engineers_all
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION set_updated_at();

CREATE VIEW clients AS SELECT * FROM clients_all WHERE deleted_at IS NULL;
CREATE VIEW system_types AS SELECT * FROM system_types_all WHERE deleted_at IS NULL;
CREATE VIEW sales_engineers AS SELECT * FROM sales_engineers_all WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- A live record may not point at a record in the Recycle Bin (RB001).
-- The parent row is read with FOR KEY SHARE, which waits for a transaction that is
-- moving that parent to the Recycle Bin (it holds FOR UPDATE), so the two cannot
-- both succeed.
-- ---------------------------------------------------------------------------

CREATE FUNCTION recycle_bin_contract_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_deleted timestamptz;
BEGIN
  -- A contract in the Recycle Bin may keep pointing at records in the Recycle Bin.
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT deleted_at INTO parent_deleted FROM clients_all WHERE id = NEW.client_id FOR KEY SHARE;
  IF parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'The client of this AMC contract is in the Recycle Bin.'
      USING ERRCODE = 'RB001', TABLE = 'clients_all', DETAIL = 'clients:' || NEW.client_id;
  END IF;

  IF NEW.system_type_id IS NOT NULL THEN
    SELECT deleted_at INTO parent_deleted FROM system_types_all WHERE id = NEW.system_type_id FOR KEY SHARE;
    IF parent_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'The system type of this AMC contract is in the Recycle Bin.'
        USING ERRCODE = 'RB001', TABLE = 'system_types_all', DETAIL = 'system_types:' || NEW.system_type_id;
    END IF;
  END IF;

  IF NEW.sales_engineer_id IS NOT NULL THEN
    SELECT deleted_at INTO parent_deleted FROM sales_engineers_all WHERE id = NEW.sales_engineer_id FOR KEY SHARE;
    IF parent_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'The sales engineer of this AMC contract is in the Recycle Bin.'
        USING ERRCODE = 'RB001', TABLE = 'sales_engineers_all', DETAIL = 'sales_engineers:' || NEW.sales_engineer_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER amc_contracts_recycle_bin_guard
  BEFORE INSERT OR UPDATE OF client_id, system_type_id, sales_engineer_id, deleted_at ON amc_contracts_all
  FOR EACH ROW EXECUTE FUNCTION recycle_bin_contract_guard();

CREATE FUNCTION recycle_bin_client_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_deleted timestamptz;
BEGIN
  IF NEW.client_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT deleted_at INTO parent_deleted FROM clients_all WHERE id = NEW.client_id FOR KEY SHARE;
  IF parent_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'This client is in the Recycle Bin.'
      USING ERRCODE = 'RB001', TABLE = 'clients_all', DETAIL = 'clients:' || NEW.client_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_recycle_bin_guard
  BEFORE INSERT OR UPDATE OF client_id ON invoices
  FOR EACH ROW EXECUTE FUNCTION recycle_bin_client_link_guard();
CREATE TRIGGER projects_recycle_bin_guard
  BEFORE INSERT OR UPDATE OF client_id ON projects
  FOR EACH ROW EXECUTE FUNCTION recycle_bin_client_link_guard();
CREATE TRIGGER legacy_import_rows_recycle_bin_guard
  BEFORE INSERT OR UPDATE OF client_id ON legacy_import_rows
  FOR EACH ROW EXECUTE FUNCTION recycle_bin_client_link_guard();

-- ---------------------------------------------------------------------------
-- A record still used outside the Recycle Bin may not be moved into it (RB002).
-- The row is locked FOR UPDATE first, which waits for any transaction that is
-- linking a new record to it (that holds FOR KEY SHARE through its foreign key),
-- so the checks below see every committed link.
-- ---------------------------------------------------------------------------

CREATE FUNCTION recycle_bin_master_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  used boolean;
BEGIN
  IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format('SELECT 1 FROM %I WHERE id = $1 FOR UPDATE', TG_TABLE_NAME) USING NEW.id;

  IF TG_TABLE_NAME = 'clients_all' THEN
    used := EXISTS (SELECT 1 FROM amc_contracts_all WHERE client_id = NEW.id AND deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM invoices WHERE client_id = NEW.id)
         OR EXISTS (SELECT 1 FROM projects WHERE client_id = NEW.id)
         OR EXISTS (SELECT 1 FROM legacy_import_rows WHERE client_id = NEW.id);
  ELSIF TG_TABLE_NAME = 'system_types_all' THEN
    used := EXISTS (SELECT 1 FROM amc_contracts_all WHERE system_type_id = NEW.id AND deleted_at IS NULL);
  ELSE
    used := EXISTS (SELECT 1 FROM amc_contracts_all WHERE sales_engineer_id = NEW.id AND deleted_at IS NULL);
  END IF;

  IF used THEN
    RAISE EXCEPTION 'This record is still in use and cannot be moved to the Recycle Bin.'
      USING ERRCODE = 'RB002', TABLE = TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER clients_recycle_bin_guard
  BEFORE UPDATE OF deleted_at ON clients_all
  FOR EACH ROW EXECUTE FUNCTION recycle_bin_master_guard();
CREATE TRIGGER system_types_recycle_bin_guard
  BEFORE UPDATE OF deleted_at ON system_types_all
  FOR EACH ROW EXECUTE FUNCTION recycle_bin_master_guard();
CREATE TRIGGER sales_engineers_recycle_bin_guard
  BEFORE UPDATE OF deleted_at ON sales_engineers_all
  FOR EACH ROW EXECUTE FUNCTION recycle_bin_master_guard();
