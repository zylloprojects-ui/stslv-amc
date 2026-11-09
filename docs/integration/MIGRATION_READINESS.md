# Migration Readiness — 0108 and 0109

Final local integration, 2026-11-09, branch `integration/stslv-amc-final-20261109`.
The owner approved 0108 and 0109 **for isolated local integration testing only**. Nothing here was run on
`stslv_amc_dev`, Neon or any production system.

## 1. The two migrations

| Migration | Purpose | Kind |
|---|---|---|
| `0108_user_sessions.sql` | Server-side sessions: table `user_sessions` (id uuid, user, created/last activity/expiry, password-change flag, address, user agent, revocation reason and actor), 8 constraints, 3 indexes + primary key | Additive (new table) |
| `0109_activity_logs_append_only.sql` | Audit Log protection: function `activity_logs_append_only()`, statement triggers refusing UPDATE, DELETE and TRUNCATE on `activity_logs`; `REVOKE UPDATE, DELETE, TRUNCATE … FROM PUBLIC` | Additive (function + triggers) |

**Dependencies:** 0108 references `users(id)` (0001). 0109 targets `activity_logs` (0002). No other new
migration exists on any of the four branches: P1, P2 and P3 add none. The sequence after the merge is
`… 0106, 0107, 0108, 0109` with no gaps introduced and no duplicate numbers (51 files in total; numbering gaps
before 0105 are historical and accepted by the runner).

**Ordering:** the runner refuses a pending migration numbered below the newest applied one. Production is at
0107, so 0108 and 0109 apply in order.

## 2. Verification performed (disposable database `stslv_amc_final_integration`, local PostgreSQL 17.11)

The database was created for this purpose and checked before use: local host only, exact name, no other
connections. The verification script refuses any other database name or a non-local host.

| Check | Fresh path (empty schema → 0109) | Upgrade path (0107 schema with data → 0109) |
|---|---|---|
| Every migration file applied in order | PASS (51 of 51) | PASS (51 of 51; started at 0107) |
| Only 0108 and 0109 applied by the upgrade | — | PASS (`Applying 0108_user_sessions.sql`, `Applying 0109_activity_logs_append_only.sql`) |
| `user_sessions` indexes (pk, open, user_open, revoked_by) | PASS | PASS |
| `user_sessions` constraints (8) | PASS | PASS |
| Audit Log triggers (`no_update_delete`, `no_truncate`) | PASS | PASS |
| Audit Log INSERT still works | PASS | PASS |
| Audit Log UPDATE / DELETE (even of no row) / TRUNCATE refused | PASS | PASS |
| Existing user and password hash untouched | — | PASS |
| Existing Audit Log entries preserved | — | PASS |
| No sessions exist after 0108 (everyone signs in again) | — | PASS |
| Second run applies nothing (idempotent runner) | — | PASS |

22 of 22 checks passed. In addition, every API test run rebuilds the `stslv_test` schema from all 51
migrations (`tests/global-setup.ts`), and the session, Audit Log and schema-inventory tests run on top of it
(see `TEST_RESULTS.md`).

## 3. Application start and migration behaviour

- `src/server.ts` **never** migrates. Migrations are applied by the start command:
  - Render (`render.yaml`): `node dist/db/migrate-cli.js && node dist/server.js`.
  - Hostinger template (`deploy/hostinger/systemd/stslv-amc-api.service`): `ExecStartPre=…/migrate-cli.js`.
- **Therefore deploying this branch applies 0108 and 0109 automatically.** A release is the migration.
- During this integration no API server process was started against any database; tests use the in-process
  app with `DB_NAME=stslv_amc_final_integration` and `DB_SCHEMA=stslv_test`.
- Each migration runs in its own transaction under an advisory lock (Neon's direct host, not the pooler).

## 4. Effect at release

- **Every user is signed out once.** Tokens issued before 0108 carry no session id and are refused
  ("refuses a validly signed token that names no session (issued before 0108)", `tests/sessions.test.ts`).
  Release outside working hours and tell users beforehand.
- The Audit Log becomes append-only for everyone, including scripts and SQL consoles that connect as the
  application role. Nothing in the application updates or deletes audit entries.
- A role that **owns** `activity_logs` (today the single Neon role) can still drop the triggers with DDL.
  Closing that needs the separate runtime role (`deploy/hostinger/sql/runtime-role.sql`) — a separate,
  approved access change.

## 5. Backup, rollback and recovery

Before release (approval required for each):
1. Fresh `pg_dump` of production (custom format), SHA-256 recorded, restore-tested into a scratch database
   (`docs/handover/DEPLOYMENT_CHECKLIST.md` §B).
2. Note the previous production commit (`c6d8d19`) and the dump file as the rollback pair.

Rollback options:
- **Preferred (keeps data written after release):** forward-fix with a new migration; the code can be reverted
  only together with the database because an older API refuses a database with newer migrations.
- **Undo the two migrations by hand (approval required):** `DROP TRIGGER activity_logs_no_update_delete ON
  activity_logs; DROP TRIGGER activity_logs_no_truncate ON activity_logs; DROP FUNCTION
  activity_logs_append_only(); DROP TABLE user_sessions; DELETE FROM schema_migrations WHERE version IN
  ('0108','0109');` then deploy `c6d8d19`. Everyone signs in again.
- **Full restore:** restore the pre-release dump into a new database and point the API at it (loses data
  written after the release; last resort).

Restores and 0109: `pg_restore` loads rows with COPY (an insert) before it creates triggers, so dumps taken
after 0109 restore normally. `--clean` drops the table rather than deleting rows.

## 6. Approvals still required

- Applying 0108 and 0109 to Neon production (i.e. releasing this branch).
- The pre-release backup and restore drill.
- The release window and user announcement (forced sign-in).
- Optionally, the separate runtime database role.
