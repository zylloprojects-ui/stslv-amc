-- STSLV AMC — separate runtime role for the API. TEMPLATE: NOT APPLIED ANYWHERE. Needs approval.
--
-- Why: migration 0109 makes the Audit Log append-only with triggers, but the role that OWNS a table can drop or
-- disable its triggers. Today the API connects as the owner (on Neon: neondb_owner). With this split:
--   * the OWNER role runs migrations only (ExecStartPre in stslv-amc-api.service, with the owner's credentials);
--   * the API runs as stslv_app, which can read and write business tables but holds only SELECT and INSERT on
--     activity_logs and owns nothing, so it cannot alter or remove the audit protection.
--
-- Not done in P0 because it changes how production connects (two credentials, migrate step separated from the
-- server start) and must be rehearsed on a Neon branch first. Steps, in order, on a Neon BRANCH:
--   1. Run this file as the owner.
--   2. \password stslv_app
--   3. Start the API with DB_USER=stslv_app and a separate MIGRATE_DB_USER/MIGRATE_DB_PASSWORD for migrations
--      (needs a small change to the start command; prepared, not implemented).
--   4. Run the full smoke test; then repeat on production with approval.

CREATE ROLE stslv_app LOGIN;
GRANT USAGE ON SCHEMA public TO stslv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stslv_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO stslv_app;
-- The audit log: add and read only.
REVOKE UPDATE, DELETE, TRUNCATE ON activity_logs FROM stslv_app;
-- The migration ledger is the owner's business.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM stslv_app;
-- Tables created by future migrations: same grants, then the audit/ledger revokes above re-applied by hand
-- if a future migration recreates either table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stslv_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO stslv_app;
