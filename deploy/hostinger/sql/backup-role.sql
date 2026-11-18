-- STSLV AMC — read-only database role for the backup jobs on the Hostinger VPS (local PostgreSQL 17).
-- Applied on the VPS by the "postgres" superuser:  sudo -u postgres psql -d postgres -f backup-role.sql
--
-- The role has the SAME NAME as the Linux user that runs the backup units ("stslv-backup"), so it signs in over
-- the local Unix socket with PEER authentication (pg_hba "local all all peer"): no database password exists for
-- backups, nothing to store in backup.env, nothing to leak. It has no password, so it cannot sign in over TCP.
--
-- pg_dump needs to read every table and sequence; this role can read and nothing else, so a compromised backup
-- job cannot change or delete data. pg_read_all_data exists from PostgreSQL 14.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stslv-backup') THEN
    CREATE ROLE "stslv-backup" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- PostgreSQL 16+: whether a membership is inherited is fixed when it is granted, so say it explicitly.
GRANT pg_read_all_data TO "stslv-backup" WITH INHERIT TRUE;
-- The application database revokes CONNECT from PUBLIC. (Database name: as in /etc/stslv-amc/api.env.)
GRANT CONNECT ON DATABASE stslv_amc_test TO "stslv-backup";
-- One connection for the snapshot plus pg_dump's own; read-only sessions as a second safety net.
ALTER ROLE "stslv-backup" CONNECTION LIMIT 3;
ALTER ROLE "stslv-backup" SET default_transaction_read_only = on;

-- Checks (as the Linux user):
--   sudo -u stslv-backup env PGHOST=/var/run/postgresql PGDATABASE=stslv_amc_test pg_dump -Fc --no-sync -f /dev/null
--     → succeeds
--   printf 'begin read write;\nupdate app_settings set key=key where false;\n' \
--     | sudo -u stslv-backup env PGHOST=/var/run/postgresql PGDATABASE=stslv_amc_test psql
--     → ERROR: permission denied for table app_settings
--
-- backup.env:  DB_HOST=/var/run/postgresql  DB_USER=stslv-backup  DB_PASSWORD=  (empty)  PGSSLMODE=disable
--
-- Rollback:  REVOKE CONNECT ON DATABASE stslv_amc_test FROM "stslv-backup"; DROP ROLE "stslv-backup";
