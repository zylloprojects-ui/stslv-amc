-- STSLV AMC — read-only database role for the backup job. TEMPLATE: NOT APPLIED ANYWHERE.
-- Run once on Neon by the database owner, ONLY with approval, from a trusted machine. The password is typed at
-- the prompt (\password), never written here.
--
-- pg_dump needs to read every table and sequence; this role can read and nothing else, so a leaked backup
-- credential cannot change or delete data. pg_read_all_data exists from PostgreSQL 14 (Neon: 17).

CREATE ROLE stslv_backup_reader LOGIN;
GRANT pg_read_all_data TO stslv_backup_reader;
-- Connection limit: the backup uses one connection for the snapshot plus pg_dump's own.
ALTER ROLE stslv_backup_reader CONNECTION LIMIT 3;
-- Then:  \password stslv_backup_reader
-- And put the role and password in /etc/stslv-amc/backup.env (DB_USER / DB_PASSWORD) on the VPS only.
-- Verify on a Neon BRANCH first that "node dist/ops/cli.js db-backup" succeeds with this role.
