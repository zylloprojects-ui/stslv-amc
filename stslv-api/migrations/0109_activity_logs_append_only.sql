-- 0109_activity_logs_append_only
-- PREPARED FOR REVIEW (P0 security, 2026-11-09). Applied to isolated test databases only.
-- A release applies it when the API starts, so releasing needs approval of this file too.
--
-- Protects the Audit Log (activity_logs) from being changed or erased. New
-- entries are written exactly as before (INSERT is untouched). Any UPDATE,
-- DELETE or TRUNCATE of activity_logs is refused by the database itself,
-- whoever sends it: the API, a script, an SQL console, a bug or an injected
-- statement. Nothing in the application updates or deletes audit entries
-- (checked at c6d8d19), so no feature changes.
--
-- What this does NOT do: a role that OWNS the table (on Neon today, the single
-- role the API connects with) can still remove the triggers with ALTER TABLE
-- or DROP TRIGGER. Removing that power needs separate database roles: the
-- owner for migrations, and a runtime role for the API that holds only SELECT
-- and INSERT on activity_logs. That is a production access change, prepared as
-- deploy/hostinger/sql/runtime-role.sql and NOT part of this migration.
-- Disabling the triggers is itself a deliberate DDL statement, visible in the
-- database logs, rather than an accidental UPDATE or DELETE.
--
-- Backups and restores are unaffected: pg_dump reads the rows, and pg_restore
-- loads them with COPY (an insert) before it creates the triggers. A restore
-- with --clean drops the table (allowed) rather than deleting its rows.
-- Foreign keys: activity_logs.user_id refers to users ON DELETE RESTRICT, so
-- deleting a user never cascades into the audit log (unchanged).
--
-- Statement-level triggers, so even a statement that matches no row is refused,
-- and TRUNCATE (which fires no row trigger) is covered.
--
-- Reverse (only with approval):
--   DROP TRIGGER activity_logs_no_update_delete ON activity_logs;
--   DROP TRIGGER activity_logs_no_truncate ON activity_logs;
--   DROP FUNCTION activity_logs_append_only();

CREATE FUNCTION activity_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only: % on activity_logs is not allowed.', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit entries can only be added. See migration 0109.';
END;
$$;

CREATE TRIGGER activity_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON activity_logs
  FOR EACH STATEMENT EXECUTE FUNCTION activity_logs_append_only();

CREATE TRIGGER activity_logs_no_truncate
  BEFORE TRUNCATE ON activity_logs
  FOR EACH STATEMENT EXECUTE FUNCTION activity_logs_append_only();

-- Nobody but the owner should hold write privileges beyond INSERT. PUBLIC has none by default; this makes
-- the intent explicit and is harmless if already true.
REVOKE UPDATE, DELETE, TRUNCATE ON activity_logs FROM PUBLIC;
