-- 0001_access_control
-- Users, roles and database-backed role permissions.
-- Creates: set_updated_at(), roles, users, user_roles, role_permissions.
-- No money-bearing columns. No business tables.

-- Shared trigger function: keeps updated_at correct on every UPDATE.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  code        text        NOT NULL,
  name        text        NOT NULL,
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_pk PRIMARY KEY (id),
  CONSTRAINT roles_code_uq UNIQUE (code),
  CONSTRAINT roles_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT roles_name_ck CHECK (btrim(name) <> '')
);

CREATE TRIGGER roles_set_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  email               text        NOT NULL,
  -- Salted bcrypt hash. The password itself is never stored.
  password_hash       text        NOT NULL,
  full_name           text        NOT NULL,
  is_active           boolean     NOT NULL DEFAULT true,
  last_login_at       timestamptz,
  -- Tokens issued before this moment are rejected.
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_pk PRIMARY KEY (id),
  CONSTRAINT users_email_ck CHECK (btrim(email) <> ''),
  CONSTRAINT users_full_name_ck CHECK (btrim(full_name) <> ''),
  CONSTRAINT users_password_hash_ck CHECK (btrim(password_hash) <> '')
);

-- Email is the login identifier; unique regardless of letter case.
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- user_roles (many-to-many)
-- ---------------------------------------------------------------------------
CREATE TABLE user_roles (
  user_id    bigint      NOT NULL,
  role_id    bigint      NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The composite primary key prevents duplicate assignments.
  CONSTRAINT user_roles_pk PRIMARY KEY (user_id, role_id),
  CONSTRAINT user_roles_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT user_roles_role_id_fk FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT
);

CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);

-- ---------------------------------------------------------------------------
-- role_permissions
-- One row grants one action on one module to one role.
-- A new module or action is added by a later migration that replaces the
-- CHECK constraints below.
-- ---------------------------------------------------------------------------
CREATE TABLE role_permissions (
  role_id    bigint      NOT NULL,
  module     text        NOT NULL,
  action     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_pk PRIMARY KEY (role_id, module, action),
  CONSTRAINT role_permissions_role_id_fk FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT,
  CONSTRAINT role_permissions_module_ck CHECK (module IN (
    'DASHBOARD', 'CLIENTS', 'AMC_CONTRACTS', 'AMC_SCHEDULE', 'AMC_EXECUTION',
    'PROJECTS', 'PROCUREMENT', 'EXPENSES', 'INVOICES', 'REPORTS', 'USERS', 'SETTINGS'
  )),
  CONSTRAINT role_permissions_action_ck CHECK (action IN (
    'VIEW', 'CREATE', 'EDIT', 'DELETE', 'APPROVE', 'EXPORT'
  ))
);
