# Technical Handover — STS-ELV AMC

Prepared 2026-11-09 on branch `feature/stslv-p3-handover` from commit `c6d8d19` (the commit live on `develop` since the 2026-11-04 release). Facts are taken from the code and existing documents named in each section. **No secret value appears in this document**; environment variables are listed by name only.

Related: [API reference](API_REFERENCE.md) · [Role permission matrix](ROLE_PERMISSION_MATRIX.md) · [User guide](../user-guide/USER_GUIDE.md) · [Deployment (current hosting)](../DEPLOYMENT.md) · [Document storage](../DOCUMENT_STORAGE.md) · [Backup & Restore](../BACKUP_RESTORE.md) · [Finance workflow rules](../FINANCE_WORKFLOW.md).

---

## 1. Architecture overview

A modular monolith: one React web application, one Express REST API, one PostgreSQL database, one private object-storage bucket.

```
Browser (React SPA, stslv-web)
   │  HTTPS, Bearer JWT
   ▼
REST API (Node.js 24 + Express 5, stslv-api) ──► PostgreSQL 17 (Neon in the current hosting)
   │
   └── S3 API (server-side keys) ──► private Supabase Storage bucket (documents)
```

| Layer | Technology | Notes |
|---|---|---|
| Web | React 19, TypeScript 6, Vite 8, Tailwind CSS 4, TanStack Query, React Router 7 (data router), React Hook Form + Zod | Static build (`dist/`). No server rendering. Calls the API at `VITE_API_BASE_URL` (or the same origin `/api` when empty) |
| API | Node.js 24, Express 5, TypeScript, `pg`, Zod, bcrypt, JWT | Modular: `src/modules/<module>/{routes,service,schemas}`; shared code in `src/shared`; config in `src/config` |
| Database | PostgreSQL 17 | 49 ordered SQL migrations in `stslv-api/migrations`; money in `numeric` |
| Files | Private S3-compatible bucket (Supabase in production), or a local folder in development | Metadata and SHA-256 in table `attachments`; the browser never talks to the bucket |
| Tests | Vitest (web: jsdom + Testing Library; API: real PostgreSQL in a separate schema) | |

Design principles kept throughout: permissions enforced in the API on every request; financial calculations in PostgreSQL / integer thousandths, never floating point; nothing deleted (deactivate, cancel, Recycle Bin); every change in the activity log.

## 2. Module descriptions

| Area | Web page(s) | API module | Main tables |
|---|---|---|---|
| Authentication | `/login`, `/signup`, `/forgot-password`, `/change-password`, `/account` | `auth` | `users` (incl. `must_change_password`, `temporary_password_expires_at`), `user_roles` |
| Users & roles | `/admin/users`, `/admin/roles` | `users`, `roles` | `roles`, `permissions`, `role_permissions` |
| Dashboard | `/dashboard` | `dashboard` | reads contracts, visits, invoices |
| Master data | `/master-data`, `/clients`, `/master-data/*` | `clients`, `masters` | `clients`, `sales_engineers`, `system_types`, `maintenance_frequencies`, `departments` |
| AMC contracts | `/amc/management`, `/amc/contracts`, `/amc/contracts/:id` | `amc` (contracts, billing, schedule) | `amc_contracts_all` (view `amc_contracts` excludes the Recycle Bin, migration 0101), `amc_contract_custom_months`, `amc_contract_references`, `attachments` |
| Schedule & execution | `/amc/schedule`, `/amc/calendar`, `/amc/service-status`, `/amc/master-status` | `amc` (visits, execution, service-status, master-status) | `amc_visits_all` / `amc_visits`, `attachments` (service reports) |
| Renewal | `/amc/renewal` | `amc` (renewals) | `amc_contracts.renewed_from_id` |
| Finance | `/finance/accounts`, `/invoices`, `/amc/service-sales` | `accounts`, `invoices`, `services-sales` | `invoices`, `invoice_allocations`, `amc_visits.manual_invoice_no`, quotation columns |
| Reports | `/reports` | `reports` | read only |
| Administration | `/admin/login-history`, `/admin/audit-log`, `/admin/deletion-log`, `/settings/*`, `/admin/suggestions` | `audit`, `security`, `recycle-bin`, `suggestions`, `holidays`, `notifications` | `activity_logs`, `suggestions`, `suggestion_events`, `app_settings` (holidays and defaults), `notification_reads`; backups are files in `BACKUP_DIR` |
| Help | `/help`, `/help/:topic`, header **?** | — (static content in `stslv-web/src/help`) | — |
| Retired (no pages) | — | `projects`, `procurement`, `expenses`, `historical-data` | kept for existing data and Invoice Tracking allocations (`docs/OBSOLETE_MODULES_REMOVAL.md`) |

Business rules worth knowing before changing code: `docs/FINANCE_WORKFLOW.md` (Billing Basis, Regenerate, Paid), `docs/SERVICE_REPORT_COMPLETION_LOCK.md`, `docs/AMC_RENEWAL.md`, `docs/AMC_REFERENCE_NUMBER.md`, `docs/RECYCLE_BIN.md`.

## 3. Database and migrations

- **51 migrations**, `0001_access_control.sql` … `0109_activity_logs_append_only.sql` (49 up to 0107 are in production; **0108_user_sessions** and **0109_activity_logs_append_only** are new in the integrated branch, verified on disposable databases only, see `docs/integration/MIGRATION_READINESS.md`). Never edit an applied file; add a higher-numbered migration.
- **Runner** (`src/db/migrate.ts`, `migrate-cli.ts`): table `schema_migrations` (version, name, checksum, applied_at); SHA-256 checksum of each file (CRLF normalised); refuses an edited or missing applied file, duplicate versions, or a pending migration numbered below the last applied one; `pg_advisory_lock` prevents concurrent runs (hence Neon's **direct** host, not the pooler); each migration in its own transaction.
- **Commands:** `npm run migrate` (apply), `npm run migrate:status` (dry run). In production the start command applies pending migrations before the server starts; a failure keeps the previous release running.
- Security Center → *Database updates* shows "All N database updates applied" and the latest migration.
- An older API refuses a database with newer migrations, so a code rollback after a migration needs a database restore (see the Deployment Checklist).

Key constraints and triggers: `activity_logs` append-only (0109: UPDATE/DELETE/TRUNCATE refused); `user_sessions` (0108); one open renewal per contract (`amc_contracts_one_open_renewal_uq`), completion lock (`amc_visits_completion_lock`), one current service report per visit, unique AMC references across history (`amc_contract_references`).

## 4. API

See [API_REFERENCE.md](API_REFERENCE.md). Health checks: `GET /api/health`, `GET /api/health/database`.

## 5. Roles and permissions

See [ROLE_PERMISSION_MATRIX.md](ROLE_PERMISSION_MATRIX.md). Six built-in roles: Super Admin (fixed), Admin, Finance Executive, Master Data Executive, AMC Operations Executive, Viewer.

## 6. Neon database configuration (current production database)

From `docs/DEPLOYMENT.md` and `render.yaml`:

| Setting | Value |
|---|---|
| PostgreSQL version | 17 (dumps cannot be restored into an older major version) |
| Region | AWS Europe (Frankfurt), next to the Render service |
| Connection | **Direct** host (no `-pooler`), TLS required: `PGSSLMODE=require` |
| Credentials | Entered only in the Render dashboard (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`; `DB_PORT` 5432) |
| Schema | `public` (tests use a separate schema via `DB_SCHEMA`, never in production) |
| Time zone | Database session may stay UTC (Neon default). Every business date ("today", due/overdue, expiry, "this month", date filters) is computed in Asia/Muscat by `stslv-api/src/shared/business-date.ts` and `stslv-web/src/lib/businessDate.ts`; timestamps stay timestamptz. OI-12 resolved 2026-11-09 |
| Exposure | Reachable from the internet with password + TLS: accepted for the client-review copy only |
| Backups | Free plan short history; real backups are manual `pg_dump` (§8) |

## 7. Supabase document storage

From `docs/DOCUMENT_STORAGE.md`:

- Private bucket, reached through Supabase's S3-compatible endpoint with SigV4 keys held only by the API. No public URLs, no signed links; every download goes through the API, which checks permission and the SHA-256 recorded at upload.
- Objects: `attachments/<uuid>.<ext>`; the database keeps `<uuid>.<ext>` in `attachments.storage_key`.
- Used by contract documents, service reports, Service Sales report downloads and legacy procurement/expense attachments.
- Maximum file size `ATTACHMENT_MAX_MB` (default 12). Keep any per-bucket limit ≥ 15 MB.
- Exactly one store may be configured (Supabase, R2 or a local folder); a partial set stops the API at start. Without storage in production, **contracts cannot be added** (the document is mandatory).
- Check end to end: `npm run storage:check` (no database needed). Security Center → *Document storage*.
- Key rotation: create a new key in Supabase, update the two key variables on the host, redeploy, then revoke the old key.

## 8. Backup and restore responsibilities

| Item | Current state | Responsibility (to be named in the Infrastructure Ownership Register) |
|---|---|---|
| Database | Manual `pg_dump --format=custom --schema=public --no-owner --no-privileges` from a trusted machine before every release, restore-tested into a scratch database, SHA-256 recorded | System owner: routine schedule, retention, off-site copy, quarterly restore test |
| In-app Backup & Restore | Off in production (`BACKUP_DIR` unset; no durable disk on Render) | Decide whether to enable on the VPS with a durable folder |
| Documents bucket | No second copy in production | System owner |
| Scheduled off-site backups (P0, prepared) | Implemented in `stslv-api/src/ops` (`dist/ops/cli.js`; `npm run ops -- <command>`) with systemd timers in `deploy/hostinger/systemd`: encrypted daily database and document backups, 7/4/12 retention, verification, alerts, heartbeats, isolated restore drills. **Not active anywhere; tested on disposable resources only** (`docs/BACKUP_AUTOMATION.md`) | System owner: bucket, keys, activation (approval) |
| Restore | Never over the live database: restore into a new database, compare counts and totals, switch only with written approval (`docs/BACKUP_RESTORE.md`) | System owner with project owner approval |

## 9. Hostinger VPS deployment prerequisites

Nothing is deployed on a VPS yet. Configuration templates for every item below now exist in `deploy/hostinger/` (P0; Nginx, TLS renewal, security headers and CSP, UFW, SSH hardening, systemd units and timers, logrotate, journald, monitoring, least-privilege database roles) and are described in `docs/HOSTINGER_VPS.md` and `docs/integration/HOSTINGER_READINESS.md`. They contain placeholders only and have not been applied to any server. Before moving production there, the following must be in place (decisions marked **Decide**):

**Server**
- [ ] VPS plan with ≥ 2 vCPU, ≥ 4 GB RAM, SSD sized for database + backups (**Decide** plan).
- [ ] Ubuntu LTS (or another supported Linux), automatic security updates.
- [ ] Non-root sudo user; SSH key authentication; password login and root SSH disabled.
- [ ] Firewall: allow 22 (preferably restricted to admin addresses), 80, 443 only. **PostgreSQL port 5432 not exposed.**
- [ ] Time zone and NTP set (**Decide** server time zone; see OI-12).

**Software**
- [ ] Node.js 24 LTS.
- [ ] PostgreSQL 17 server and client tools (`pg_dump`/`pg_restore` 17), listening on localhost only.
- [ ] A reverse proxy (e.g. Nginx or Caddy) with TLS certificates (Let's Encrypt) and HTTP→HTTPS redirect.
- [ ] A process manager (systemd unit or PM2) to keep the API running and restart on failure.

**Application**
- [ ] Domain name and DNS records for the web and API addresses (**Decide**: same origin `/api` proxy, or a separate API host).
- [ ] Web: `npm ci && npm run build` in `stslv-web`; serve `dist/` with SPA fallback to `index.html`. Set `VITE_API_BASE_URL` at build time if the API is on another host; leave it empty when the proxy serves `/api` on the same origin.
- [ ] API: `npm ci --include=dev && npm run build`; start with `node dist/db/migrate-cli.js && node dist/server.js`.
- [ ] API environment file readable only by the service user, with the variables in §10 (`TRUST_PROXY=1` behind one proxy; `CORS_ORIGIN` = web address; `NODE_ENV=production`).
- [ ] Document storage: keep Supabase (same variables) or a durable local folder `ATTACHMENTS_DIR` included in backups (**Decide**).
- [ ] Optional in-app backups: `BACKUP_DIR` on durable disk, `BACKUP_STORAGE_DURABLE=true`, tool paths if needed.

**Migration from Neon**
- [ ] Planned stop; final `pg_dump` from Neon; restore into the VPS database; compare counts and money totals; point the API at it; verify; then decommission Neon only with approval.

**Operations**
- [ ] Nightly `pg_dump` with retention and an off-site copy; restore test procedure — implemented as `stslv-amc-db-backup.timer` / `stslv-amc-docs-backup.timer` (`docs/BACKUP_AUTOMATION.md`), to be activated with approval.
- [ ] Log rotation for API and proxy logs; disk-space monitoring; uptime check on `/api/health`.
- [ ] Documented SSH/console access owners in the Infrastructure Ownership Register.

## 10. Environment variable names (no values)

**API (`stslv-api`)** — see `stslv-api/.env.example` for explanations.

| Group | Names |
|---|---|
| Runtime | `NODE_ENV`, `PORT`, `NODE_VERSION` (host) |
| Database | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `PGSSLMODE`; `DB_SCHEMA` (tests only) |
| Sign-in | `JWT_SECRET`, `JWT_EXPIRES_IN`, `BCRYPT_ROUNDS`, `SESSION_IDLE_TIMEOUT_MINUTES` (default 30, 5–1440) |
| Business-rule switches (approved, **off** until release) | `SERVICE_REPORT_NO_LOCK_ENABLED` (API); `AMC_CONTRACT_EXPIRY_ENABLED` (scheduled expiry job only, never the web server) |
| Web access | `CORS_ORIGIN`, `APP_URL`, `TRUST_PROXY` |
| Mail | `MAIL_TRANSPORT` (`none` in production) |
| Rate limits | `LOGIN_RATE_LIMIT`, `LOGIN_FAILURE_LIMIT`, `PUBLIC_AUTH_RATE_LIMIT`, `TEMPORARY_PASSWORD_RATE_LIMIT` |
| Documents — Supabase | `SUPABASE_PROJECT_REF`, `SUPABASE_S3_REGION`, `SUPABASE_S3_BUCKET`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`, `SUPABASE_S3_ENDPOINT` |
| Documents — R2 (alternative) | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` |
| Documents — local (alternative) | `ATTACHMENTS_DIR`; size limit `ATTACHMENT_MAX_MB` |
| Backups (in-app page) | `BACKUP_DIR`, `BACKUP_STORAGE_DURABLE`, `PG_DUMP_PATH`, `PG_RESTORE_PATH` |
| Scheduled backups (ops CLI, own environment file) | see `deploy/hostinger/env/backup.env.example` (`BACKUP_*`, GnuPG recipient fingerprint, off-site bucket, alert webhook, heartbeat URLs) — never in the API's environment |

**Web (`stslv-web`, build time)**: `VITE_API_BASE_URL`, `VITE_SHOW_DASHBOARD_DETAIL_PANELS` (optional); development only: `VITE_API_PROXY_TARGET`.

Secrets (`DB_PASSWORD`, `JWT_SECRET`, storage keys) live only in the host's environment. Changing `JWT_SECRET` signs everyone out. Releasing migration 0108 also signs everyone out once (tokens issued before it carry no session).

## 11. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| "Cannot reach the server" after sign-in, first request slow | Render free service waking up (~1 min) | Wait and **Try again**; on the VPS check the process manager |
| Every request fails with CORS errors | Web address not in `CORS_ORIGIN` (exact match, no trailing slash) | Correct `CORS_ORIGIN`, redeploy API |
| API does not start: migration error | Edited applied migration, missing file, out-of-order number, or a failing new migration | Read the start log; never edit applied files; fix with a new migration; the previous release keeps running on Render |
| API does not start: storage configuration | Partial or duplicate storage variables | Set exactly one complete store (§7) |
| "Contract documents … could not be saved" / 503 STORAGE_ERROR | Bucket unreachable or key revoked | `npm run storage:check`; Security Center → Document storage; rotate keys |
| `FEATURE_UNAVAILABLE` (503) on a page | A migration that page needs is not applied | Security Center → Database updates; apply pending migrations |
| Users report "Too many attempts" | Sign-in rate limit; or `TRUST_PROXY` wrong so all users share one address | Wait 15 minutes; check `metadata.ip` of `auth.login_failed` in the Audit Log |
| A user cannot see a page | Role lacks View | Roles & Permissions (Super Admin; Admin for custom roles) |
| "You were signed out after 30 minutes of inactivity" / "This session has been signed out" | Inactivity limit, sign-out elsewhere, administrator, password change | Sign in again; Security Center → Active sessions |
| An Audit Log change fails with "append-only" | Migration 0109 protects `activity_logs` | Expected; audit entries are never changed or deleted |
| Forgotten password | — | Users & Access → Generate temporary password (15 minutes) |
| No Super Admin can sign in | — | `docs/AUTH_SIGNUP_AND_RECOVERY.md` recovery procedure (`npm run admin:create` creates a **Super Admin** — role code `ADMIN` — on a machine with database access) |
| "Complete the service before entering an invoice number." | Service not Completed | Complete it on Service Status first |
| "Please upload service report." | No report on the service | Upload Report, then complete |
| A completed service is wrong | Completion lock: no reopen in the application | Record the correction in notes; any data correction needs an approved, audited database change |
| Totals differ between Accounts and Invoice Tracking | Different sources (manual Invoice No. vs Zoho records) | Expected; see `docs/FINANCE_WORKFLOW.md` |
| Deep link returns 404 on the web host | SPA fallback missing | Serve `index.html` for unknown paths (Pages does this by default; configure on the VPS proxy) |

## 12. Development and tests

```
cd stslv-api && npm run typecheck && npm test && npm run build
cd stslv-web && npm run typecheck && npm test && npm run lint && npm run build
```

API tests run against the database in `.env` but inside a separate schema (`DB_SCHEMA`, recreated from all migrations each run). Use a dedicated test database per developer/session; never point tests at the production or main development database. Git workflow: `GIT_WORKFLOW.md`.
