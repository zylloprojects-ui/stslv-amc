-- 0070_master_data
-- Master lists for departments, sales engineers and system types, and an
-- optional link from an AMC contract to a sales engineer and a system type.
--
-- Additive only: no existing column is changed or filled. The free-text
-- responsible_engineer and system_description of every existing contract stay
-- exactly as entered; no contract is linked to a master record automatically.
--
-- To reverse (only before any contract has been linked, and with approval):
--   ALTER TABLE amc_contracts DROP COLUMN sales_engineer_id, DROP COLUMN system_type_id;
--   DROP TABLE sales_engineers; DROP TABLE system_types; DROP TABLE departments;

CREATE TABLE departments (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  code        text        NOT NULL,
  name        text        NOT NULL,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  updated_by  bigint,
  CONSTRAINT departments_pk PRIMARY KEY (id),
  CONSTRAINT departments_code_ck CHECK (btrim(code) <> ''),
  CONSTRAINT departments_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT departments_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT departments_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX departments_code_uq ON departments (lower(btrim(code)));
CREATE INDEX departments_created_by_idx ON departments (created_by);
CREATE INDEX departments_updated_by_idx ON departments (updated_by);

CREATE TRIGGER departments_set_updated_at
  BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sales_engineers (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  name          text        NOT NULL,
  employee_no   text,
  email         text,
  phone         text,
  department_id bigint,
  -- The engineer's own sign-in, when they have one. At most one engineer per user.
  user_id       bigint,
  notes         text,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint,
  updated_by    bigint,
  CONSTRAINT sales_engineers_pk PRIMARY KEY (id),
  CONSTRAINT sales_engineers_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT sales_engineers_department_fk FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE RESTRICT,
  CONSTRAINT sales_engineers_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT sales_engineers_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT sales_engineers_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX sales_engineers_name_uq ON sales_engineers (lower(btrim(name)));
CREATE UNIQUE INDEX sales_engineers_employee_no_uq ON sales_engineers (lower(btrim(employee_no))) WHERE employee_no IS NOT NULL;
CREATE UNIQUE INDEX sales_engineers_user_uq ON sales_engineers (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX sales_engineers_department_idx ON sales_engineers (department_id);
CREATE INDEX sales_engineers_created_by_idx ON sales_engineers (created_by);
CREATE INDEX sales_engineers_updated_by_idx ON sales_engineers (updated_by);

CREATE TRIGGER sales_engineers_set_updated_at
  BEFORE UPDATE ON sales_engineers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE system_types (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  code        text        NOT NULL,
  name        text        NOT NULL,
  description text,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint,
  updated_by  bigint,
  CONSTRAINT system_types_pk PRIMARY KEY (id),
  CONSTRAINT system_types_code_ck CHECK (btrim(code) <> ''),
  CONSTRAINT system_types_name_ck CHECK (btrim(name) <> ''),
  CONSTRAINT system_types_sort_order_ck CHECK (sort_order >= 0),
  CONSTRAINT system_types_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT system_types_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX system_types_code_uq ON system_types (lower(btrim(code)));
CREATE INDEX system_types_created_by_idx ON system_types (created_by);
CREATE INDEX system_types_updated_by_idx ON system_types (updated_by);

CREATE TRIGGER system_types_set_updated_at
  BEFORE UPDATE ON system_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Optional links. Null for every existing contract until a user links it.
ALTER TABLE amc_contracts
  ADD COLUMN sales_engineer_id bigint,
  ADD COLUMN system_type_id    bigint,
  ADD CONSTRAINT amc_contracts_sales_engineer_fk FOREIGN KEY (sales_engineer_id) REFERENCES sales_engineers (id) ON DELETE RESTRICT,
  ADD CONSTRAINT amc_contracts_system_type_fk FOREIGN KEY (system_type_id) REFERENCES system_types (id) ON DELETE RESTRICT;

CREATE INDEX amc_contracts_sales_engineer_idx ON amc_contracts (sales_engineer_id);
CREATE INDEX amc_contracts_system_type_idx ON amc_contracts (system_type_id);
