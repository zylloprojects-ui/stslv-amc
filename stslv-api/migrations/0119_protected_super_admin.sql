-- 0119: one protected Super Admin account.
--
-- One account, identified by its user id (never by its name or email), is protected from every other administrator:
-- nobody else may change its role, edit it, issue it a temporary password, deactivate it or end its sessions. The
-- application enforces that (modules/users/protected-account.ts). This migration keeps the protection itself safe:
--
--   protected_accounts   at most ONE row (the singleton column is unique and must be true), naming the protected user.
--                        It is written only by the server-side bootstrap script (npm run admin:bootstrap-protected).
--                        No API writes it, so no administrator can give the protection to themselves.
--                        Rows can be added, never updated or deleted: the protection cannot be moved to another user.
--   user_roles guard     the protected user's Super Admin (ADMIN) role cannot be removed, by any path.
--   users guard          the protected user cannot be deactivated or have its sign-up status changed, by any path.
--
-- Nothing existing is changed: the table starts empty and the guards act only on the protected user, so until the
-- bootstrap script is run (after approval) every account behaves exactly as before.
--
-- Moving or removing the protection is a deliberate database-owner step (disable the trigger in one transaction),
-- documented in docs/PROTECTED_SUPER_ADMIN.md; the application never takes it.

CREATE TABLE protected_accounts (
  user_id     bigint      NOT NULL,
  singleton   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT protected_accounts_pk PRIMARY KEY (user_id),
  CONSTRAINT protected_accounts_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT protected_accounts_singleton_ck CHECK (singleton),
  CONSTRAINT protected_accounts_singleton_uq UNIQUE (singleton)
);

COMMENT ON TABLE protected_accounts IS
  'The one protected Super Admin account (migration 0119). Insert-only; written by the bootstrap script only.';

CREATE FUNCTION protected_accounts_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The protected account record cannot be changed: % on protected_accounts is not allowed.', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'See migration 0119 and docs/PROTECTED_SUPER_ADMIN.md.';
END;
$$;

CREATE TRIGGER protected_accounts_no_update_delete
  BEFORE UPDATE OR DELETE ON protected_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION protected_accounts_insert_only();

-- The protected user keeps the Super Admin role: removing it (or turning that row into another role) is refused.
CREATE FUNCTION protected_account_keeps_super_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM protected_accounts p WHERE p.user_id = OLD.user_id)
     AND EXISTS (SELECT 1 FROM roles r WHERE r.id = OLD.role_id AND r.code = 'ADMIN')
     AND (TG_OP = 'DELETE' OR NEW.user_id <> OLD.user_id OR NEW.role_id <> OLD.role_id) THEN
    RAISE EXCEPTION 'The protected account must keep the Super Admin role.'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'See migration 0119 and docs/PROTECTED_SUPER_ADMIN.md.';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER user_roles_protected_account_guard
  BEFORE UPDATE OR DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION protected_account_keeps_super_admin();

-- The protected user stays active and approved.
CREATE FUNCTION protected_account_stays_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NOT NEW.is_active OR NEW.approval_status <> 'APPROVED')
     AND EXISTS (SELECT 1 FROM protected_accounts p WHERE p.user_id = OLD.id) THEN
    RAISE EXCEPTION 'The protected account cannot be deactivated.'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'See migration 0119 and docs/PROTECTED_SUPER_ADMIN.md.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER users_protected_account_guard
  BEFORE UPDATE OF is_active, approval_status ON users
  FOR EACH ROW EXECUTE FUNCTION protected_account_stays_active();
