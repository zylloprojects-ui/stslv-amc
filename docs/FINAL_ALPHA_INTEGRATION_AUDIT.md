# STS-ELV AMC — Final Local Alpha Integration Audit

Date: 2026-11-10. Scope: verify the whole application (original Phase 1, P0–P3, client fixes, later approved
improvements) on `feature/sts-elv-client-fixes-20261109`, then integrate it into **LOCAL** `alpha` only.

**No push, no deployment, no production or shared-database migration, no backup configuration.** Every database used
was a disposable one (`stslv_amc_invoice_ack`: schemas `stslv_test`, `e2e_ack`, `upgrade_*`, `chain_from_*`).

## 1. Repository and branches

| Item | Value |
|---|---|
| Repository | `D:\Projects\STSLV-AMC` (alpha checked out here) |
| Source | `feature/sts-elv-client-fixes-20261109` in `D:\Projects\STSLV-AMC-client-fixes` (verified at 02cc709, plus the verification commit that adds this document) |
| Target | local `alpha` at **c6d8d19** (= `origin/alpha`, 0 ahead / 0 behind) |
| Ancestry | c6d8d19 is an ancestor of the source; **0** alpha commits are missing from the source; 249a68b (P0–P3 integration), 8fbdeff, 81788d0 and 02cc709 are all in the source history |
| Method | **fast-forward** (no merge commit needed, no history rewritten) |
| Alpha working tree | Not clean before integration. `.gitignore` differed in line endings only (CRLF on disk, LF committed). Untracked owner files: `stslv-api/migrations-pending/validation/*`, `stslv-api/src/scripts/seed-amc-demo.ts`, `stslv-api/src/scripts/demo-reset-cleanup.ts`. None overlap the integrated changes. The owner chose to proceed and leave them untouched (2026-11-10). They are still untouched afterwards. |

## 2. P0–P3 preservation

Method:
- For P0, P1, P2, P3 and the integration commit 249a68b, every substantive line each added (relative to c6d8d19) was
  looked up in the same file at 02cc709.
- Every line no longer present was reviewed by hand.
- Functional presence is proven by the P0–P3 test files in the green suites (e.g. `sessions`, `audit-log-protection`,
  `admin-security-gaps`, `p1-approved-rules`, `p1-fixes`, `p2-exports-usage`, `p2-zoho-references`, `custom-roles`,
  `reports-permissions`, `help.test.tsx`).

| Branch | Tip | Files | Lines checked | No longer present | Explanation |
|---|---|---|---|---|---|
| P0 security | 91b4da7 | 91 | 3148 | 5 | CSP hash and fail2ban file name corrected at integration 249a68b; password deny-list extended with `stselv`; `ops` script present (comma only) |
| P1 fixes | 597e356 | 27 | 954 | 11 | Superseded on purpose: expiry and "today" moved to the shared Oman helpers (c8a8174); the visit rule extended for Sales Engineer Name; tests adapted to the required renewal document; one cosmetic class |
| P2 improvements | 051906c | 44 | 1400 | 3 | Zoho-reference aggregation present with a trailing comma; tests adapted to the renewal document |
| P3 Help / handover | c0ea7d5 | 32 | 2276 | 109 | Branding STSLEV → STS-ELV, and documents updated by later approved work (Oman time, register, migration counts) |
| Integration | 249a68b | 197 | 8356 | 72 | Same as above |

No file added by P0–P3 was deleted. **P0–P3 preserved.**

## 3. Requirements traceability

The full matrix is at the end of this document (§13). It has 192 requirements in groups A–H.
- Each row cites its source, the implementation files, the database objects, the permission and the test files.
- Every cited path (123 source files, 142 test files) was checked to exist.
- "Passed" means the code is in place and its test files are part of the green suites in §6. Document claims alone
  were not accepted.

| Group | Passed | Passed (inspection / document review) | Deferred | Failed / Blocked |
|---|---|---|---|---|
| A. Original Phase 1 | 67 | 0 | 3 (client decisions: split payments, Final Credit meaning / margin / VAT, Job Number format) | 0 |
| B. P0 security | 17 | 0 | 4 (Hostinger templates, server roles) | 0 |
| C. P1 business rules | 10 | 0 | 0 | 0 |
| D. P2 improvements | 12 | 1 | 0 | 0 |
| E. P3 Help and handover | 4 | 4 | 0 | 0 |
| F. Client modifications | 31 | 0 | 0 | 0 |
| G. Later approved improvements | 19 | 0 | 0 | 0 |
| H. Deferred infrastructure / production | 0 | 0 | 20 | 0 |

## 4. Modules (browser and API)

The browser sweep ran on the isolated stack. It visited every application route (37) and checked each page for:
- load and page title (STS-ELV AMC branding);
- no error banners, no uncaught or console errors;
- no page-wide horizontal overflow;
- text contrast in the page, the Help panel and the Hide Columns dialog;
- Help opening;
- Dashboard parity: `/dashboard` and `/amc/management` show the same cards, in the same order, with the same values.

| Role | Viewports × themes | Page loads | Clean | Refused (as designed) |
|---|---|---|---|---|
| Super Admin | 1440 / 820 / 390 × light / dark | 222 | 222 | none |
| Admin | 1440 / 390 × light / dark | 148 | 148 | Reports (granted on purpose by Super Admin only) |
| Finance Executive | 1440 / 390 × light / dark | 148 | 148 | everything outside Finance, Dashboard, Help, Notifications, Account |
| Viewer | 1440 × light | 37 | 37 | Invoice Acknowledgements (approved: no access), Reports, Administration, Settings |

- **Dashboard:** exactly 12 cards in the approved order (active, value, credit, expiring, month-services, month-pending,
  month-invoiced, month-not-invoiced, overall-services, overall-pending, overall-invoiced, overall-not-invoiced),
  identical on both routes.
- **Card visibility:** each card follows its module's permission. Finance Executive sees the 4 invoice cards, the same
  on both routes.

Workflow E2E: **34/34** checks. It covers:
- one acknowledgement per invoice, linked services, attach → confirm → green, refresh persistence;
- the viewer and a byte-identical download, refusal of an invalid file;
- reconciliation (link), the Accounts indicator, cancelled-record re-association;
- Viewer and View-only refusals (server 403);
- mobile layout and dialog fit.

Responsive results come from emulated viewports in headless Edge. **No physical device was used.**

## 5. Database and migrations

The chain has 57 migration files: 0001…0107 (already on alpha and production), plus **0108–0116** (new).
`git diff alpha..source -- stslv-api/migrations` shows only the 9 new files added: no existing migration was edited.

| Check | Evidence | Result |
|---|---|---|
| A. Fresh installation | every test run rebuilds `stslv_test` from 0001; `database.test.ts` checks tables and views | Pass |
| B. Upgrade from 0107 (alpha / production level) with representative data | `migration-chain-upgrade.test.ts`. Data: contracts incl. a pre-0111 renewal, 12 services, service reports, manual and Zoho invoices with allocations, contract documents, a customised role, 25 audit rows | Pass |
| C. Upgrade from 0109 (P0–P3 integration baseline) | same test, second case | Pass |
| D. Data preservation | checksum of every pre-existing row over its original columns (users, roles, user_roles, clients, contracts, visits, attachments, invoices, allocations, activity_logs), before and after the upgrade and after the first invoice synchronisation | Unchanged |
| Checksums | `schema_migrations` checksums equal the files for every version; the runner refuses an edited applied file | Pass |
| E. Re-run | `runMigrations` applies nothing the second time; 0113 / 0115 re-applied manually add nothing | Pass |
| Per-migration upgrades | `migration-0110-upgrade`, `migration-0111-upgrade`, `migration-0112-upgrade`, `migration-0114-upgrade` (0113→0116 with legacy acknowledgements and a customised role) | Pass |
| Grants | upgrade adds only `INVOICE_ACKNOWLEDGEMENTS` grants (Super Admin all, Admin V/C/E/X, Finance V/C/X); a removed grant stays removed | Pass |
| Renewal versions / references | 0111 makes existing contracts version 1 of their own number; the pre-0111 renewal keeps its own number | Pass |
| Audit Log integrity | 0109 append-only: deleting an audit row is refused after the upgrade | Pass |
| Invoice associations | first synchronisation on upgraded data: the Zoho invoice covering two services is one invoice; equal manual numbers stay separate | Pass |

Not approved for production. Release approval of 0108–0116 is still open (OI-21, OI-23).

## 6. Tests

| Gate | Result |
|---|---|
| API full suite, quiet run 1 (02cc709) | 112 files collected / 112 passed; 1865 passed, 0 failed, 2 skipped |
| API full suite, quiet run 2 (with this pass's tests) | **113 files / 113 passed; 1867 passed, 0 failed, 2 skipped**; one test over 10 s (backup round-trip, 27 s, within its own timeout) |
| Web full suite | **59 files; 874 passed, 0 failed** |
| Typecheck | API `tsc --noEmit` clean; web `tsc -b` clean |
| Lint | web oxlint: no errors, only pre-existing warnings; the API has no separate linter (strict typecheck) |
| Production builds | API `tsc` and web `vite build` succeed |

**Skipped tests:** two, both by design. They are the "before migration" variants of
`maintenance-frequencies.test.ts` (0076) and `services-sales-reports.test.ts` (0104), and run only on a database
without that migration.

**Earlier intermittent failures (resolved by cause, not by retry):** the previous session reported timeouts and one
run that silently covered 111 of 112 files. Every one of those runs overlapped other heavy work on the same machine:
browser sweeps, E2E seeding (which runs migrations) and Vite / Edge processes. Both runs here were made with no other
Node, Edge or database sessions active, confirmed beforehand. They collected every file and had no failures and no
timeouts. No test was weakened, skipped or given a longer timeout.

## 7. Security

| Check | Result |
|---|---|
| Authentication, sessions (0108), revocation, idle timeout | `auth*`, `sessions` tests green |
| Server-side authorization on every route | `permission-catalog`, `page-permissions`, `cross-module-permissions`, module 403 tests; browser sweeps of 4 roles |
| Admin / Super Admin safeguards | `admin-security-gaps`, `custom-roles`, `admin-custom-roles`, `role-model` |
| Financial restriction | Accounts / Service Sales / Service Status / Master Status / Invoice Acknowledgements amount gating tests; Viewer and View-only browser checks |
| Documents | private storage only; no static file serving in the API; authenticated download with `no-store`; content-checked uploads; cross-invoice and cross-record refusals tested; orphan cleanup on failed saves tested |
| Exports | Export permission plus source-module permission (`reports-permissions`, `invoices-export`, `p2-exports-usage`) |
| Audit Log | append-only (0109), `audit-log-protection` |
| Committed secrets | none: no `.env` tracked (only `.env.example` with empty values); no keys or credential-bearing connection strings |
| Feature switches | `AMC_CONTRACT_EXPIRY_ENABLED` and `SERVICE_REPORT_NO_LOCK_ENABLED` default **off** (code unchanged) |

## 8. Financial and business rules

Covered by the green suites:
- **Contract and Dashboard figures:** active, expired and expiring-in-45-days counts, Annual AMC Value, Final Credit,
  each contract counted once (`dashboard-shared-counts`, `dashboard`, `sts-elv-client-fixes`).
- **Service amounts:** Billing Basis, cost per visit, last-service remainder, services per cycle, no prorating
  (`amc-billing`, `finance-workflow`, `amc-contract-frequencies`).
- **Renewals:** renewal versions and the same visible number (`contract-versions-sales-value`, `amc-renewals`).
- **Paid reference status:** Invoice No. entered = Paid; it is not proof of payment (`finance-workflow`, `accounts`).
- **Totals:** unique-contract-period totals (`contract-versions-sales-value`); all-page filtered totals (`accounts`,
  `sts-elv-client-fixes`); invoice value once per invoice (`invoice-acknowledgements`, 1700 = 300 + 600 + 800 from 8
  services); monthly reports and Oman month boundaries (`amc-reports`, `services-sales-reports`,
  `business-date-oman`).
- **No invented values and no cross-contract associations:** tests assert null where no value exists, and identities
  never merge across clients.

## 9. Oman time

The API test `business-date-oman.test.ts` and the web test `business-date.test.tsx` cover:
- the day changing at 20:00 UTC;
- month-end, year-end (31 Dec → 1 Jan) and leap years;
- contract validity on the Valid To day;
- overdue services; "paid this month".

The Dashboard showed the Oman date in the browser sweep.

## 10. Bugs fixed during this integration

None in application code. The verification found no new defect.

Added during this integration (tests and documents only):
- `migration-chain-upgrade.test.ts` (upgrades from 0107 and 0109 with checksum preservation);
- a password test for "stselv";
- a dark-mode contrast assertion for the Help link colour;
- Outstanding Issues Register updated: OI-12 status, new OI-23 to OI-26.

## 11. Remaining issues and deferred work

**Open client decisions:**
- OI-10 business rules (split payments, Final Credit meaning, margin, VAT, Job Number format);
- OI-24 `admin@stslev.com` identity;
- OI-25 partially re-entered invoices;
- OI-26 pre-0111 renewal numbers;
- legacy technical identifier renames (`docs/APPLICATION_COMPLETION_AUDIT_20261110.md` §1).

**Release and infrastructure (deferred, H group):**
- production approval of 0108–0116 (OI-21, OI-23), with every user signing in again (OI-20);
- Backup & Restore activation;
- Hostinger setup and server templates (B-18 to B-21);
- separate database roles;
- removing demo data from production;
- UAT and sign-off.

## 12. Integration and post-integration verification (local alpha)

**Integration:**

| Item | Value |
|---|---|
| Alpha before | `c6d8d19` (= `origin/alpha`) |
| Backup reference | local branch `backup/alpha-pre-final-integration-20261110` → `c6d8d19` (verified before the update) |
| Method | `git merge --ff-only feature/sts-elv-client-fixes-20261109` in `D:\Projects\STSLV-AMC`. A fast-forward: no merge commit, no conflict, no history rewritten |
| Alpha after the fast-forward | `cc6c3a4` (= the verified source, including 02cc709 and 249a68b) |
| Alpha now | the commit that adds this section on top of `cc6c3a4` (documentation only) |
| Not changed | `origin/alpha` (still `c6d8d19`), `develop`, `main`, the feature branch, every other branch and worktree; the owner's untracked files and the `.gitignore` line endings in the alpha checkout |

**Run in the alpha checkout itself** (`D:\Projects\STSLV-AMC`, HEAD `cc6c3a4`):
- `.env` points at the development database there, so every command overrode `DB_NAME` to the disposable database.
- The browser servers also overrode the storage folder, port and JWT secret.

| Check | Result |
|---|---|
| API typecheck and build; web typecheck, build and lint | Pass (web lint: pre-existing warnings only) |
| Full API suite (includes the migration upgrade tests 0110, 0111, 0112, 0114 and the 0107 / 0109 chain) | **113 files / 113 passed; 1867 passed, 0 failed, 2 skipped (by design)** |
| Full web suite | **59 files; 874 passed, 0 failed** |
| Browser, Super Admin (3 widths × light / dark) | 222 / 222 clean; Dashboard 12 cards, identical on `/dashboard` and `/amc/management` |
| Browser, Finance Executive (2 widths × light / dark) | 148 / 148 clean; permitted pages only |
| Workflow E2E | **34 / 34**. Covers: invoice acknowledgement, reconciliation, Accounts indicator, cancelled-record re-association, role refusals (Viewer, View-only), mobile |
| Contract renewal, Accounts, Oman-time boundaries, role permissions | covered by the API and web suites above (`amc-renewals`, `contract-versions-sales-value`, `accounts`, `business-date-oman`, `business-date`, `role-model`, `permission-catalog`) |

**Result: local alpha passes every gate.** Not pushed. `origin/alpha` is unchanged.

## 13. Traceability matrix

## A. Original application requirements (Phase 1, CLAUDE.md §2–5, PHASE1_SYSTEM_DESIGN, FINANCE_WORKFLOW)

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| A-01 | CLAUDE.md §4.1 | Auth | Users sign in with email + password; bcrypt hashes | api/modules/auth/auth.service.ts, auth.routes.ts, password.ts; web/pages/LoginPage.tsx | 0001 | public | api:auth.test.ts "POST /api/auth/login"; web:auth.test.tsx "login" | Passed |  |
| A-02 | CLAUDE.md §4.1 | Auth | Protected routes require a valid token (401 otherwise) | api/middleware/authenticate.ts; web/auth/guards.tsx | 0001 | any signed-in | api:auth.test.ts "authenticated access"; web:auth.test.tsx "protected routes" | Passed |  |
| A-03 | CLAUDE.md §4.1 | Auth | Change own password | api/modules/auth/auth.routes.ts; web/pages/account/ChangePasswordForm.tsx | 0001 | signed-in | api:auth.test.ts "POST /api/auth/change-password" | Passed |  |
| A-04 | AUTH_SIGNUP_AND_RECOVERY | Auth | Self sign-up waits for administrator approval/rejection | api/modules/auth/registration.service.ts; api/modules/users/users.routes.ts; web/pages/auth/SignUpPage.tsx | 0040, 0042 | USERS:APPROVE | api:auth-signup.test.ts, auth-rejection.test.ts; web:users.test.tsx "sign-up requests" | Passed |  |
| A-05 | AUTH_SIGNUP_AND_RECOVERY | Auth | Administrator-issued temporary password; forced change at next sign-in | api/modules/auth/temporary-password.ts; web/pages/auth/RequiredPasswordChangePage.tsx | 0086 | USERS:EDIT | api:auth-temporary-password.test.ts; web:auth-recovery.test.tsx "required password change after a temporary password" | Passed |  |
| A-06 | SECURITY (CLAUDE.md §11) | Auth | Sign-in rate limits (per address, per address+email) | api/middleware/rate-limit.ts | — | public | api:auth-login-limits.test.ts "failed sign-in limit…" | Passed |  |
| A-07 | CLAUDE.md §4.1 | Roles | Role-based access; six-role model (Super Admin, Admin, Finance, Master Data, AMC Ops, Viewer) | api/shared/role-model.ts, permissions.ts | 0087, 0088, 0090 | — | api:role-model.test.ts "migration 0087: the six roles"; web:role-model.test.tsx | Passed | Original five business roles replaced by approved six-role model |
| A-08 | CLAUDE.md §4.1 | Roles | Permissions enforced in backend; configurable as data | api/middleware/authorize.ts; api/shared/permission-catalog.ts | 0004, 0080, 0081, 0089, 0091, 0092 | per module | api:permissions.test.ts "role permissions are data", "privilege escalation is blocked"; api:permission-catalog.test.ts | Passed |  |
| A-09 | ROLES_PERMISSIONS | Roles | Per-page permission modules; menus follow permissions | api/shared/permission-catalog.ts; web/layout/navigation.ts | 0080–0092 | per module | api:page-permissions.test.ts; web:page-permissions.test.tsx; web:auth.test.tsx "permission-based navigation" | Passed |  |
| A-10 | ROLES_PERMISSIONS | Users | One role per user; system keeps an active Admin | api/modules/users/users.service.ts | 0082 | USERS:EDIT | api:one-role-constraint.test.ts; api:users.test.ts "one role per user"; api:permissions.test.ts "the system always keeps an active Admin" | Passed |  |
| A-11 | CLAUDE.md §4.1 | Users | Create / edit / deactivate users; Users export | api/modules/users/*; web/pages/users/UsersPage.tsx | 0001 | USERS:VIEW/CREATE/EDIT | api:users.test.ts; api:admin-security-gaps.test.ts "Users export"; web:users.test.tsx | Passed |  |
| A-12 | CLAUDE.md §4.2 | Clients | Client master: create/edit/view, duplicate refused | api/modules/clients/clients.service.ts, clients.routes.ts; web/pages/clients/ClientsPage.tsx | 0003, 0074 | CLIENTS:* | api:clients.test.ts "create client", "update client"; web:clients.test.tsx | Passed |  |
| A-13 | CLIENTS module upgrade | Clients | Deactivate instead of delete; delete only via Recycle Bin | api/modules/clients/clients.service.ts | 0003, 0106 | CLIENTS:EDIT/DELETE | api:clients.test.ts "deactivate client", "delete client" | Passed |  |
| A-14 | Clients module | Clients | Client 360 figures, client code, client exports | api/modules/clients/client-summary.service.ts, clients.export.ts; web/pages/clients/ClientDetailPage.tsx | 0074 | CLIENTS:VIEW/EXPORT | api:client-360.test.ts "Client 360 figures"; web:clients.test.tsx "Client 360" | Passed |  |
| A-15 | Master data modules | Masters | Sales Engineers (code, Engineer 360, delete-if-unused, export) | api/modules/masters/sales-engineers.service.ts; web/pages/masters/SalesEngineersPage.tsx | 0070, 0102 | SALES_ENGINEERS:* | api:sales-engineers.test.ts "Engineer 360", "permanent delete"; web:sales-engineers.test.tsx | Passed |  |
| A-16 | Master data modules | Masters | System Types list/form/status/delete-if-unused | api/modules/masters/system-types.*; web/pages/masters/SystemTypesPage.tsx | 0070 | SYSTEM_TYPES:* | api:system-types.test.ts; web:system-types.test.tsx | Passed |  |
| A-17 | Master data modules | Masters | Departments (no delete) | api/modules/masters/departments.*; web/pages/masters/DepartmentsPage.tsx | 0070 | DEPARTMENTS:* | api:departments.test.ts "no delete"; web:departments.test.tsx | Passed |  |
| A-18 | CLAUDE.md §4.3 / §16.2 | Masters | Maintenance Frequencies master with rules, lock once used | api/modules/masters/maintenance-frequencies.*; web/pages/masters/MaintenanceFrequenciesPage.tsx | 0075, 0076 | MAINTENANCE_FREQUENCIES:* | api:maintenance-frequencies.test.ts "linked contracts and the rule lock"; api:maintenance-frequency-rules.test.ts; web:maintenance-frequencies.test.tsx | Passed | Exact option set still a §16 item |
| A-19 | Master Data Center plan | Masters | Master Data Center hub and summary | api/modules/masters/masters.service.ts; web/pages/masters/MasterDataCenterPage.tsx | 0070–0076 | per master module | api:master-data-summary.test.ts, master-data-center.test.ts; web:master-data-hub.test.tsx | Passed |  |
| A-20 | CLAUDE.md §4.3 | AMC Contracts | Create/edit/view contract with client, engineer, system, dates, frequency, cost per visit, value, Final Credit, status, notes | api/modules/amc/contracts.service.ts, amc.routes.ts, amc.schemas.ts; web/pages/amc/AmcContractsPage.tsx, ContractFormModal.tsx | 0010, 0070, 0093 | AMC_CONTRACTS:CREATE/EDIT/VIEW | api:amc-contracts.test.ts "create contract", "update contract", "validation"; web:amc-contracts.test.tsx "add contract", "edit contract" | Passed |  |
| A-21 | CLAUDE.md §5 | AMC Contracts | Money stored as numeric, OMR 3 decimals, no float | api/shared/money.ts; web/lib/money.ts | 0010 (numeric) | — | api:amc-contracts.test.ts "money"; web:money.test.ts | Passed |  |
| A-22 | AMC_CONTRACT_REQUIREMENTS | AMC Contracts | Required active Sales Engineer, system, mandatory contract document (PDF/Word) | api/modules/amc/contracts.service.ts; web/pages/amc/contractDocument.ts | 0071, 0103 | AMC_CONTRACTS:CREATE | api:amc-contract-requirements.test.ts "sales engineer", "contract document"; web:contract-form-requirements.test.tsx | Passed |  |
| A-23 | AMC_REFERENCE_NUMBER | AMC Contracts | Manual, unique, editable AMC Reference Number with history | api/modules/amc/contract-reference.ts, amc-reference.rules.ts | 0105, 0107 | AMC_CONTRACTS:EDIT | api:amc-contract-reference.test.ts "editing the reference" | Passed |  |
| A-24 | MEETING_REQUIREMENTS_AUDIT §1 | AMC Contracts | Contract duration 1–6 years fills Valid To (editable, leap years) | web/pages/amc/contractValidity.ts | — | AMC_CONTRACTS:CREATE | web:contract-duration.test.ts "contract duration" | Passed |  |
| A-25 | AMC_MODULE | AMC Contracts | Contract status workflow (Active, Expired, Cancelled…) | api/modules/amc/contracts.service.ts; web/pages/amc/ContractStatusDialog.tsx | 0010 | AMC_CONTRACTS:EDIT | api:amc-contracts.test.ts "contract status"; web:amc-contracts.test.tsx "contract status" | Passed |  |
| A-26 | AMC_MODULE | AMC Contracts | Contract 360 page: history, invoices, services, filtered total | api/modules/amc/contracts.service.ts; web/pages/amc/ContractDetailPage.tsx | 0010, 0060 | AMC_CONTRACTS:VIEW | api:amc-contract-360.test.ts; api:contract-register-finance.test.ts "Contract 360 figures"; web:amc-contract-detail.test.tsx | Passed |  |
| A-27 | MEETING_REQUIREMENTS_AUDIT §1 | AMC Contracts | Contract register Excel/PDF export honouring filters | api/modules/amc/contracts.export.ts | — | AMC_CONTRACTS:EXPORT | api:reporting-gaps.test.ts "Exports honour hidden columns"; api:sts-elv-client-fixes.test.ts "refuses an unknown validity and filters the export the same way" | Passed |  |
| A-28 | CLAUDE.md §4.4 | Schedule | Visits generated from start/end date and frequency; date-based rows, no month tables | api/modules/amc/amc.schedule.ts, contract-frequency.service.ts | 0011, 0076 | AMC_CONTRACTS:CREATE | api:amc-schedule.test.ts "periods by frequency", "schedule plan"; api:amc-contracts.test.ts "schedule generation" | Passed |  |
| A-29 | CLAUDE.md §4.4 | Schedule | Multi-year contracts (up to 5+ years) generate correctly | api/modules/amc/amc.schedule.ts | 0011 | — | api:amc-schedule.test.ts "contract date boundaries"; api:amc-billing.test.ts "multi-year terms" | Passed |  |
| A-30 | CLAUDE.md §4.4 | Schedule | Fixed and custom frequency rules (incl. disabled frequencies) | api/modules/masters/maintenance-frequencies.rules.ts | 0075, 0076 | — | api:amc-schedule-rules.test.ts; api:amc-contract-frequencies.test.ts "custom months (PROVISIONAL rule)"; web:amc-contract-frequencies.test.tsx | Passed | Custom rule marked provisional |
| A-31 | CLAUDE.md §4.4 | Schedule | Schedule list with client/system/status/month filters | api/modules/amc/visits.service.ts; web/pages/amc/AmcSchedulePage.tsx | 0011 | AMC_SCHEDULE:VIEW | api:amc-visits.test.ts "schedule list"; web:amc-schedule.test.tsx "schedule" | Passed |  |
| A-32 | CLAUDE.md §4.4 | Schedule | Schedule export / download (Excel, PDF, monthly) | api/modules/amc/schedule.export.ts | — | AMC_SCHEDULE:EXPORT | api:amc-schedule-export.test.ts "Excel export", "PDF export"; api:amc-visit-year-summary.test.ts "monthly download…" | Passed |  |
| A-33 | CLAUDE.md §4.4 | Calendar | Monthly Calendar month/year views with renewal warnings | api/modules/amc/visits.service.ts; web/pages/amc/AmcCalendarPage.tsx, calendar/* | 0011 | AMC_SCHEDULE:VIEW (calendar page module) | api:amc-visit-year-summary.test.ts, amc-calendar-options.test.ts; web:monthly-calendar.test.tsx, amc-calendar.test.tsx | Passed |  |
| A-34 | MEETING_REQUIREMENTS_AUDIT §7 | Schedule | Consolidated monthly schedule (one row per AMC) | api/modules/amc/schedule-monthly.service.ts; web/pages/amc/ConsolidatedSchedule.tsx | — | AMC_SCHEDULE:VIEW | api:completion-modules.test.ts "Consolidated monthly schedule"; web:completion-pages.test.tsx "Consolidated schedule" | Passed |  |
| A-35 | MEETING_REQUIREMENTS_AUDIT §8 | Schedule | Five-level Color Priority incl. manual colour | api/modules/amc/amc.schedule.ts; web/pages/amc/ServiceColor.tsx | 0094 | AMC_SCHEDULE:EDIT | api:schedule-sync.test.ts "Color Priority" | Passed |  |
| A-36 | CLAUDE.md §4.4 (planning) | Schedule | Visit date change / postpone; safe regeneration keeps acted-on visits | api/modules/amc/visits.service.ts, schedule-generations.service.ts | 0011 | AMC_SCHEDULE:EDIT | api:amc-visits.test.ts "planning changes"; api:amc-contracts.test.ts "regenerating a schedule safely" | Passed | Rescheduling rules still §16.4 |
| A-37 | CLAUDE.md §4.5 | Execution | Work list; update execution status; mark complete with completion date and notes | api/modules/amc/visits.service.ts; web/pages/amc/ExecutionVisitModal.tsx | 0011 | AMC_EXECUTION:VIEW/EDIT | api:amc-execution.test.ts "work list", "execution status", "execution constraints in the database" | Passed |  |
| A-38 | SERVICE_STATUS / SERVICE_REPORT_COMPLETION_LOCK | Execution | Service Status page: Service Report No., mandatory service report upload, completion lock | api/modules/amc/service-status.service.ts, service-reports.service.ts; web/pages/amc/ServiceStatusPage.tsx | 0077, 0104 | SERVICE_STATUS:VIEW, AMC_EXECUTION:EDIT | api:amc-service-status.test.ts; api:service-reports.test.ts "completion needs the service report", "the completion lock"; web:service-status.test.tsx | Passed |  |
| A-39 | CLAUDE.md §4.9 | Invoice Tracking | Completed work becomes Ready for Invoice | api/modules/invoices/invoices.service.ts (v_amc_visit_billing) | 0060 | INVOICES:VIEW | api:amc-ready-for-invoice.test.ts "invoice eligibility"; api:invoices.test.ts "work waiting for an invoice" | Passed |  |
| A-40 | CLAUDE.md §4.9 | Invoice Tracking | Record Zoho invoice (number, date, amount, status, reference) against visits/projects | api/modules/invoices/*; web/pages/invoices/InvoicesPage.tsx, InvoiceFormModal.tsx | 0060 | INVOICES:CREATE/EDIT | api:invoices.test.ts "recording an invoice", "validation"; web:invoices.test.tsx "recording an invoice" | Passed |  |
| A-41 | CLAUDE.md §2, §4.9 | Invoice Tracking | More than one invoice per project / visit via allocations; reconciliation | api/modules/invoices/invoices.service.ts, invoice-locks.ts | 0060 (invoice_allocations) | INVOICES:EDIT | api:invoices.test.ts "reconciliation"; api:invoice-locks.test.ts "a visit covered by two invoices", "an invoiced project" | Passed | Multiple invoices per AMC visit still §16.5 |
| A-42 | CLAUDE.md §4.9 | Invoice Tracking | Edit / cancel invoice; invoice reports & Pending Invoices export | api/modules/invoices/invoices.export.ts | 0060 | INVOICES:EDIT/EXPORT | api:invoices.test.ts "cancelling an invoice"; api:invoices-export.test.ts "Pending Invoices report" | Passed |  |
| A-43 | FINANCE_WORKFLOW "Rules" | Finance | Manual Invoice No. per service: entered = Paid, cleared = Unpaid; no generation/VAT/date/amount | api/modules/amc/manual-invoice.service.ts; web/pages/amc/ManualInvoiceField.tsx | 0100 | INVOICES:EDIT | api:finance-workflow.test.ts "manual Invoice No."; web:finance-workflow.test.tsx "manual Invoice No." | Passed |  |
| A-44 | FINANCE_WORKFLOW (2026-11-04) | Finance | Invoice No. entered only on a Completed service; clearing always allowed | api/modules/amc/manual-invoice.service.ts | 0100 | INVOICES:EDIT | api:finance-workflow.test.ts "manual Invoice No." | Passed |  |
| A-45 | CLAUDE.md §4.9; FINANCE_WORKFLOW | Finance | Paid is a reference status, distinguishable from verified payment; Zoho records do not decide it | api/modules/accounts/accounts.service.ts; web/help/helpTopics.ts | 0100 | — | api:finance-workflow.test.ts "every page reads the same status"; web:help.test.tsx "states that Paid is a reference status, not verified payment" | Passed |  |
| A-46 | FINANCE_WORKFLOW; CLAUDE.md §5 | Finance | Billing Basis options (AMC Value/Year, Final Credit, Custom), annual | api/modules/amc/amc.billing.ts, contracts.service.ts | 0093 | AMC_CONTRACTS:EDIT | api:completion-modules.test.ts "Billing Basis"; api:finance-workflow.test.ts "visit amounts from the Billing Basis" | Passed |  |
| A-47 | CLAUDE.md §5 | Finance | Amount per service = annual ÷ services per cycle, half-up, remainder on last service of each complete cycle | api/modules/amc/amc.billing.ts | 0093 | — | api:amc-billing.test.ts "service amounts", "position in the annual cycle" | Passed |  |
| A-48 | CLAUDE.md §5 | Finance | Partial years not prorated; without basis manual Cost per Visit stands | api/modules/amc/amc.billing.ts | 0093 | — | api:amc-billing.test.ts "multi-year terms"; api:schedule-sync.test.ts "Billing Basis amounts" | Passed |  |
| A-49 | CLAUDE.md §5; FINANCE_WORKFLOW "Regenerate" | Finance | Existing visits recalculated only by explicit Regenerate with reason; preserves Completed/Paid/acted-on | api/modules/amc/schedule-generations.service.ts; web/pages/amc/RegenerateDialog.tsx | 0093 | AMC_CONTRACTS:EDIT | api:finance-workflow.test.ts "Regenerate"; web:finance-workflow.test.tsx "Regenerate" | Passed |  |
| A-50 | FINANCE_WORKFLOW "Older contract values" | Reports | Contract Value Review report (never reinterprets older values) | api/modules/reports/reports.service.ts | — | REPORTS:VIEW + AMC_CONTRACTS:VIEW | api:finance-workflow.test.ts "contract value review" | Passed |  |
| A-51 | FINANCE_WORKFLOW "Who reads what" | Accounts | Accounts page: rows, colour, Paid/Unpaid filter, Invoice No., export | api/modules/accounts/*; web/pages/accounts/AccountsPage.tsx | 0100 | ACCOUNTS:VIEW/EXPORT | api:accounts.test.ts "colour classification", "payment status", "export"; web:accounts.test.tsx "Accounts page" | Passed |  |
| A-52 | MASTER_AMC_STATUS | Master AMC Status | Master AMC Status rows, Yellow/Blue/Green, filters, sorting, export | api/modules/amc/master-status.service.ts, master-status.export.ts; web/pages/masterStatus/MasterStatusPage.tsx | 0100 | MASTER_AMC_STATUS:VIEW/EXPORT | api:amc-master-status.test.ts; api:completion-modules.test.ts "Master AMC Status sorting"; web:master-status.test.tsx | Passed |  |
| A-53 | SERVICES_SALES | Service Sales | Service Sales (Quotations): quotation number per service, cards, filters, export, service report view | api/modules/services-sales/*; web/pages/servicesSales/ServicesSalesPage.tsx | 0078, 0079 | SERVICES_SALES:* | api:services-sales.test.ts; api:services-sales-reports.test.ts; web:services-sales.test.tsx | Passed |  |
| A-54 | AMC_RENEWAL | Renewal | Renewal queue (45 days), draft → approve → active, history, export | api/modules/amc/renewals.service.ts, renewal-queue.service.ts; web/pages/amcRenewal/AmcRenewalPage.tsx | 0072 | AMC_RENEWAL:* | api:amc-renewal-queue.test.ts "renewal lifecycle through the queue"; api:amc-renewals.test.ts; web:amc-renewal.test.tsx, renewals.test.tsx | Passed |  |
| A-55 | CLAUDE.md §4.10; DASHBOARD_12_KPIS | Dashboard | 12-card Dashboard (contracts, services, invoices) + calendar, workload, payment trend | api/modules/dashboard/operations.service.ts; web/pages/DashboardPage.tsx, pages/dashboard/* | — | DASHBOARD:VIEW | api:dashboard-operations.test.ts "12-card dashboard: current month and overall figures"; web:dashboard.test.tsx "KPI cards" | Passed |  |
| A-56 | CLAUDE.md §4.10 | Reports | Reports page (12 reports) with filters and Excel/PDF export | api/modules/reports/*; web/pages/reports/ReportsPage.tsx | — | REPORTS:VIEW/EXPORT | api:completion-modules.test.ts "Reports"; api:reporting-gaps.test.ts "Reports filters"; api:amc-reports.test.ts; web:reporting-gaps.test.tsx | Passed |  |
| A-57 | CLAUDE.md §7 Excel | Exports | Shared Excel/PDF export engine with branding and formula-injection guard | api/shared/export/excel.ts, pdf.ts, branding.ts | — | per module EXPORT | api:export-engine.test.ts "formula injection", "Excel workbook", "PDF" | Passed |  |
| A-58 | CLAUDE.md §7 Excel; HISTORICAL_IMPORT | Import | Legacy Excel import via CLI with dry-run preview, staging, traceability, no app import route | api/legacy-import/*; api/scripts/legacy-import.ts, legacy-import-apply.ts | 0030, 0031, 0050 | CLI only | api:legacy-import-dry-run.test.ts; api:legacy-import-apply.test.ts; api:legacy-import-staging.test.ts "no application route that imports" | Passed |  |
| A-59 | HISTORICAL_DATA | Historical | Historical records read-only, never due/ready for invoice | api/modules/historical-data/*; web (historical rows in schedule) | 0030, 0050, 0051 | HISTORICAL_DATA:VIEW | api:historical-data.test.ts; api:historical-amc.test.ts "historical visit: read-only in the application"; web:historical-records.test.tsx | Passed |  |
| A-60 | CLAUDE.md §4.6–4.8 | Projects / Procurement / Expenses | Projects with configurable job number, LPO, VAT, budget; procurement and expenses against a job; job margin | api/modules/projects/* (job-number.ts), procurement/*, expenses/* | 0020–0023 | PROJECTS:*, PROCUREMENT:*, EXPENSES:* | api:projects.test.ts "job number", "financial precision and VAT"; api:procurement.test.ts; api:expenses.test.ts "tracked expenses and operational job margin" | Passed | API only: screens removed 2026-10-27 at client request (OI-11); no web route `/projects` |
| A-61 | CLAUDE.md §7 Files | Attachments | File metadata in PostgreSQL; private storage (local or Supabase S3); permissions follow record | api/modules/attachments/*; api/shared/object-storage.ts, storage-factory.ts | 0071 | follows record | api:attachments.test.ts "attachment permissions follow the record"; api:object-storage.test.ts; web:attachments.test.tsx | Passed |  |
| A-62 | CLAUDE.md §11 auditability | Audit | Audit Log of activity and Login History, filters and export | api/modules/audit/*; web/pages/admin/AuditLogPage.tsx, LoginHistoryPage.tsx | 0002 | USERS:VIEW (admin) | api:audit.test.ts; api:admin-security-gaps.test.ts "Audit Log export", "Login History"; web:audit.test.tsx | Passed |  |
| A-63 | MEETING_REQUIREMENTS_AUDIT §7 | Administration | Security Center, Deletion Log, Backup & Restore (status view) | api/modules/security/*; web/pages/admin/SecurityCenterPage.tsx, DeletionLogPage.tsx, BackupRestorePage.tsx | — | admin only | api:completion-modules.test.ts "Security Center", "Deletion Log", "Backup & Restore"; web:completion-pages.test.tsx | Passed | In-app backups off in production (see H) |
| A-64 | RECYCLE_BIN | Administration | Recycle Bin for contracts and masters: move, restore, purge (Super Admin) | api/modules/recycle-bin/*; web/pages/admin/RecycleBin.tsx | 0101, 0106 | Super Admin | api:master-recycle-bin.test.ts; api:amc-recycle-bin.test.ts; web:recycle-bin.test.tsx | Passed |  |
| A-65 | SUGGESTIONS | Administration | Suggestions submit → review → respond → resolve → close | api/modules/suggestions/*; web/pages/suggestions/* | 0085 | SUGGESTIONS:*, SUGGESTIONS_REVIEW:* | api:suggestions.test.ts "full review workflow…"; web:suggestions.test.tsx | Passed |  |
| A-66 | Notifications / Holidays | Administration | Notifications (renewal warnings, read state); holiday calendar | api/modules/notifications/*, holidays/* | 0073 | signed-in; SETTINGS:* | api:notifications.test.ts; api:holidays.test.ts; web:notifications.test.tsx, holidays.test.tsx | Passed |  |
| A-67 | CLAUDE.md §11 Frontend | UI | Responsive shell, mobile menu, dark theme contrast | web/layout/*; web/index.css | — | — | web:shell.test.tsx "mobile menu"; web:dark-theme-contrast.test.ts | Passed |  |
| A-68 | CLAUDE.md §4.8 / §16.9 | Expenses | Split payments across jobs / unallocated transfers | — | — | — | — | Deferred | Needs client decision (CLAUDE.md §16.9) |
| A-69 | CLAUDE.md §16.1, §16.10–11 | Finance | Wider Final Credit meaning; formal margin; VAT configuration rules | — | — | — | — | Deferred | Open client decisions (OI-10); not invented |
| A-70 | CLAUDE.md §16.6 | Projects | Final Job Number format | api/modules/projects/job-number.ts (configurable via number_sequences) | 0020 | — | api:projects.test.ts "job number" | Deferred | Mechanism exists and is tested; final rule awaits client |

---

## B. P0 security fixes (SESSION_SECURITY.md, integration/SECURITY_REVIEW.md, INTEGRATION_REPORT §4)

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| B-01 | SESSION_SECURITY "Server-side sessions" | Auth | Each sign-in is a `user_sessions` row; token carries `sid`; checked per request | api/modules/auth/sessions.service.ts, token.ts; api/middleware/authenticate.ts | 0108 | signed-in | api:sessions.test.ts "puts the session id in the token and records the device" | Passed |  |
| B-02 | SESSION_SECURITY | Auth | Tokens issued before 0108 (no sid) or naming another user's session are refused | api/middleware/authenticate.ts | 0108 | — | api:sessions.test.ts "refuses a validly signed token that names no session (issued before 0108)" | Passed | Forces one re-sign-in at release (OI-20) |
| B-03 | SESSION_SECURITY | Auth | Sign out ends this session; sign out of all devices ends all (logged) | api/modules/auth/auth.routes.ts (`/logout`, `/logout-all`) | 0108 | signed-in | api:sessions.test.ts "sign out of all devices ends every session…"; api:admin-security-gaps.test.ts "POST /api/auth/logout" | Passed |  |
| B-04 | SESSION_SECURITY | Auth | 30-min inactivity limit from real input (`X-Idle-Seconds`), not background polling | api/middleware/authenticate.ts; web/lib/sessions.ts | 0108 | — | api:sessions.test.ts "background polling that reports the person idle does not keep the session alive"; web:sessions.test.tsx "inactivity reporting" | Passed | `SESSION_IDLE_TIMEOUT_MINUTES` 5–1440 |
| B-05 | SESSION_SECURITY | Auth | Password change ends other sessions; temporary password and deactivation end all | api/modules/auth/sessions.service.ts, users.service.ts | 0108 | — | api:sessions.test.ts "password changes end other sessions", "deactivating a user ends their sessions" | Passed |  |
| B-06 | SESSION_SECURITY "Endpoints" | Auth | My Account → Active sessions: list own, sign out a device | api/modules/auth/auth.routes.ts (`/sessions`); web/pages/account/ActiveSessions.tsx | 0108 | signed-in (own only; other id → 404) | api:sessions.test.ts "lists the user's own open sessions…"; web:sessions.test.tsx "active sessions (My Account)" | Passed |  |
| B-07 | SESSION_SECURITY | Admin | Administrators list/revoke sessions (Security Center, Users) within may-manage rule | api/modules/security/security.routes.ts; api/modules/users/users.routes.ts; web/pages/admin/ActiveSessionsPanel.tsx | 0108 | USERS:VIEW/EDIT + administrator | api:sessions.test.ts "administrator session management"; api:integration-cross-branch.test.ts "cannot list or end other users' sessions" | Passed |  |
| B-08 | SESSION_SECURITY "Password policy" | Auth | New passwords: ≥12 chars, 3 classes, 5 distinct, no weak/brand words, no personal parts | api/shared/password-policy.ts; web/lib/password.ts | — | — | api:password-policy.test.ts "refuses short, one-kind, repetitive and well-known passwords"; web:auth-recovery.test.tsx, users.test.tsx | Passed | Existing hashes keep working (tested) |
| B-09 | SESSION_SECURITY "Audit Log protection" | Audit | `activity_logs` append-only: UPDATE/DELETE/TRUNCATE refused | migration triggers | 0109 | — | api:audit-log-protection.test.ts "refuses UPDATE, DELETE and TRUNCATE, even of no row…" | Passed | Owner role can still drop triggers (S-4, see H-08) |
| B-10 | SESSION_SECURITY "Brute-force" | Auth | Existing sign-in, sign-up, temp-password limits unchanged | api/middleware/rate-limit.ts | — | public | api:auth-login-limits.test.ts; api:auth-temporary-password.test.ts "public route rate limit" | Passed | In-memory per process |
| B-11 | SECURITY_REVIEW §2 | API | Reverse-proxy trust (`TRUST_PROXY`) cannot be spoofed by caller | api/app.ts | — | — | api:trust-proxy.test.ts "does not let a caller choose its own address behind the trusted proxy" | Passed |  |
| B-12 | MEETING_REQUIREMENTS_AUDIT §4.2 | API | Security headers (nosniff, HSTS in production) | api/app.ts | — | — | api:schedule-sync.test.ts and api:attachments.test.ts (grep `nosniff`) | Passed |  |
| B-13 | SECURITY_REVIEW §2 | API | Errors return codes/messages, no stack traces | api/shared/errors.ts | — | — | api:admin-security-gaps.test.ts | Passed |  |
| B-14 | INTEGRATION_REPORT §4 | Roles | A custom role with all of Admin's permissions is not Admin (no role mgmt, no session control, no lock override) | api/modules/roles/roles.service.ts; api/modules/amc/service-status.service.ts | — | role-based | api:integration-cross-branch.test.ts "a custom role with Admin's permissions is not Admin (P0 x P1 x P2)" | Passed |  |
| B-15 | BACKUP_AUTOMATION | Ops | Encrypted DB backup, off-site store, verify, isolated restore, alerts without credentials | api/ops/backup/db-backup.ts, db-restore.ts, gpg.ts, notify.ts, log.ts; api/ops/cli.ts | — | operator CLI | api:ops-backup.test.ts "backs up, encrypts, stores off-site, verifies and restores row-for-row" | Passed | Code tested on disposable resources; activation is H-01 |
| B-16 | BACKUP_AUTOMATION | Ops | Retention 7/4/12, never overwrite, newest never deleted | api/ops/backup/retention.ts, store.ts | — | operator CLI | api:ops-backup.test.ts "prunes complete backups outside 7 daily / 4 weekly / 12 monthly" | Passed |  |
| B-17 | BACKUP_AUTOMATION | Ops | Document backup with checksums and verified restore | api/ops/backup/documents.ts | — | operator CLI | api:ops-backup.test.ts "copies every file encrypted, reports missing and altered files…" | Passed | Not run against Supabase (H-02) |
| B-18 | HOSTINGER_READINESS; OI-05 | Infra | VPS templates: Nginx, TLS, UFW, SSH, systemd units/timers, logrotate, journald, monitoring | deploy/hostinger/{nginx,certbot,firewall,ssh,systemd,logrotate,journald,scripts}/ | — | — | none located (no test references deploy/hostinger) | Deferred | Templates; provisioning is H-03 Template reviewed; real verification belongs to the Hostinger phase. |
| B-19 | SECURITY_REVIEW S-1 | Infra | CSP `script-src` hash computed from LF build | deploy/hostinger/nginx/snippets/stslv-security-headers.conf | — | — | none located | Deferred | Browser check on VPS is H-10 Template reviewed; CSP check in a browser on the server belongs to the Hostinger phase. |
| B-20 | SECURITY_REVIEW S-2/S-3 | Infra | fail2ban jail template; P1 switches listed (off) in VPS env example | deploy/hostinger/fail2ban/stslv-jail.conf; deploy/hostinger/env/api.env.example | — | — | none located | Deferred | Template reviewed; activation belongs to the Hostinger phase. |
| B-21 | SESSION_SECURITY; OI-21 | DB | Separate runtime DB role (SELECT/INSERT only on audit log) and backup role | deploy/hostinger/sql/runtime-role.sql, backup-role.sql | — | — | none located | Deferred | Prepared, not applied (H-08) SQL reviewed; applying separate roles belongs to the production phase (OI-21). |

---

## C. P1 business-rule corrections (P1_FIXES.md, FINANCE_WORKFLOW "Known differences")

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| C-01 | P1_FIXES "Dashboard reconciliation" | AMC (shared) | One service scope for every page; on a Cancelled contract only Completed or Paid services count | api/modules/amc/service-scope.ts | — | — | api:p1-fixes.test.ts "cancelled-contract financial handling" | Passed |  |
| C-02 | P1_FIXES | Dashboard/Accounts | Services Overall = Generated + Not Generated = Service Status = Accounts = Master AMC Status rows | api/modules/dashboard/operations.service.ts, accounts.service.ts, master-status.service.ts | — | — | api:p1-fixes.test.ts "gives the same service counts and Paid totals on every page" | Passed |  |
| C-03 | P1 approved rule 1 | Contracts | Automatic expiry: Active → Expired the day after Valid To (Asia/Muscat), dry run default | api/modules/amc/contract-expiry.service.ts; api/scripts/expire-contracts.ts | — | CLI (`contracts:expire`) | api:p1-approved-rules.test.ts "expires on the day after Valid To, not on Valid To itself" | Passed | Switch `AMC_CONTRACT_EXPIRY_ENABLED` off (H-05) |
| C-04 | P1 approved rules 2–3 | Contracts | Expiry keeps visit statuses/values; open renewal neither blocks nor is changed; idempotent, concurrent-safe | api/modules/amc/contract-expiry.service.ts | — | — | api:p1-approved-rules.test.ts "is idempotent…", "concurrent runs expire each contract exactly once"; api:p1-fixes.test.ts "applies once, preserves visits…" | Passed |  |
| C-05 | P1 | Contracts | Apply refused unless switch is exactly `true` | api/modules/amc/contract-expiry.service.ts | — | — | api:p1-approved-rules.test.ts "refuses to apply without explicit enablement…" | Passed |  |
| C-06 | P1 approved rule 4 | Service Status | Service Report No. locked once service is Paid (switch) | api/modules/amc/service-status.service.ts | — | AMC_EXECUTION:EDIT | api:p1-approved-rules.test.ts "a Paid service is locked…"; web:service-status.test.tsx "service report number lock" | Passed | Switch `SERVICE_REPORT_NO_LOCK_ENABLED` off (H-05) |
| C-07 | P1 approved rule 5 | Service Status | Super Admin / Admin override with mandatory reason, audited | api/modules/amc/service-status.service.ts | — | role Super Admin/Admin | api:p1-approved-rules.test.ts "Admin and Super Admin override with a reason, each written to the Audit Log" | Passed | Role-based, not a configurable permission |
| C-08 | P1 approved rule 6 | Finance | Historical Paid-but-not-Completed preserved; read-only review query | docs/sql/paid-not-completed-review.sql; service-scope.ts | — | — | api:p1-approved-rules.test.ts "historical Paid-but-not-Completed exceptions" | Passed | Running on production needs approval |
| C-09 | P1 "Permission descriptions" | Roles | Permission texts corrected (Invoice No. is INVOICES:EDIT; Recycle Bin Super Admin only) | api/shared/permission-catalog.ts | — | — | api:p1-fixes.test.ts "permission descriptions" | Passed |  |
| C-10 | P1 "Feature switches" | Config | Both P1 switches off by default in `.env.example`/`render.yaml` | api/config/env.ts | — | — | api:sts-elv-client-fixes.test.ts "keeps both production feature switches off unless explicitly enabled" | Passed |  |

---

## D. P2 improvements (P2_IMPROVEMENTS.md)

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| D-01 | P2 §1 | Reports | Report needs REPORTS:VIEW + source module View; export needs both Exports | api/modules/reports/reports.service.ts (`canViewReport`, `canExportReport`, `assertReportAccess`) | — | REPORTS + AMC_CONTRACTS/AMC_RENEWAL/ACCOUNTS | api:reports-permissions.test.ts "Reports permission isolation" | Passed |  |
| D-02 | P2 §1 | Reports | `GET /api/reports` lists only openable reports; page opens first offered / "No reports available" | api/modules/reports/reports.routes.ts; web/pages/reports/ReportsPage.tsx | — | REPORTS:VIEW | web:p2-improvements.test.tsx "Reports page: only what the role may open" | Passed |  |
| D-03 | P2 §2 | Roles | Role list in Settings (custom roles add/rename/deactivate/delete) | web/pages/settings/RoleListPanel.tsx; web/lib/features.ts (`ROLE_LIST_ENABLED`) | 0001 roles | USERS:VIEW | web:role-list.test.tsx; web:p2-improvements.test.tsx "Custom roles: Role list in Settings" | Passed |  |
| D-04 | P2 §2 | Roles | Super Admin and Admin manage custom roles; Admin only within own permissions | api/modules/roles/roles.service.ts (`canManageRoles`), roles.routes.ts | — | USERS:EDIT + role | api:admin-custom-roles.test.ts "Admin manages custom roles", "Admin is kept within its authority" | Passed |  |
| D-05 | P2 §2 | Roles | No privilege escalation; built-in role codes refused for custom roles (409) | api/modules/roles/roles.service.ts | — | — | api:admin-custom-roles.test.ts "no privilege escalation"; api:custom-roles.test.ts | Passed |  |
| D-06 | P2 §2; OI-22 | Roles | Admin cannot give a role Users & Access permissions | api/modules/roles/roles.service.ts (`setRolePermissions`) | — | — | api:admin-custom-roles.test.ts; api:integration-cross-branch.test.ts "…nor promote anyone through a custom role" | Passed | Owner decision 2026-11-09 |
| D-07 | P2 §3 | Calendar | Month view By service / By contract (`group=contract`) | web/pages/amc/AmcCalendarPage.tsx, calendar/ContractMonthView.tsx, contractMonth.ts | — | calendar page module | web:p2-improvements.test.tsx "Monthly Calendar: By contract" | Passed |  |
| D-08 | P2 §3 | Calendar | Year view Unpaid in blue (#1479BD); "Services in year" tile navy | web/pages/amc/calendar/YearView.tsx | — | — | none located (no colour assertion found in monthly-calendar.test.tsx / p2-improvements.test.tsx) | Passed (inspection) | Colours confirmed in source; no automated colour assertion. |
| D-09 | P2 §4 | Schedule | First Service = earliest valid visit by date, shared by Contracts and Schedule | api/modules/amc/amc.schedule.ts (`FIRST_SERVICE_SQL`), visits.service.ts | — | — | api:first-service-priority.test.ts "skips a cancelled visit: the next valid visit becomes first…" | Passed |  |
| D-10 | P2 §5 | Master AMC Status | Export adds Zoho Invoices (Tracking) and Zoho References (Tracking) columns | api/modules/amc/master-status.service.ts, master-status.export.ts | 0060 | MASTER_AMC_STATUS:VIEW/EXPORT | api:p2-zoho-references.test.ts; api:p2-exports-usage.test.ts "lists the Zoho invoice numbers of each service beside Invoice No." | Passed |  |
| D-11 | P2 §5 | Dashboard | Recent Invoices export writes only visible columns; unknown/empty → 400 | api/modules/invoices/invoices.export.ts | — | INVOICES:VIEW+EXPORT | api:p2-exports-usage.test.ts "writes exactly the visible columns, in the table's order…" | Passed |  |
| D-12 | P2 §6 | Contracts | `GET /contracts/:id/usage`; Recycle Bin dialog shows what is kept and blocking renewal | api/modules/amc/amc.routes.ts; web/pages/amc/ContractRecycleBinUsage.tsx | 0101 | AMC_CONTRACTS:DELETE + Super Admin | api:p2-exports-usage.test.ts "names the renewal that blocks the move…"; web:p2-improvements.test.tsx "Contract Recycle Bin dialog: dependencies" | Passed |  |
| D-13 | P2 §6 | Renewal | Renewal requires an active Sales Engineer (reviewed, unchanged) | api/modules/amc/renewals.service.ts | 0072 | AMC_RENEWAL:CREATE | api:amc-renewals.test.ts "the sales engineer of a renewal" | Passed |  |

---

## E. P3 Help and handover (RELEASE_NOTES "Help and handover", INTEGRATION_REPORT §4)

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| E-01 | RELEASE_NOTES (P3) | Help | `?` header button opens context help side panel (full screen on phones), Escape closes | web/help/HelpPanel.tsx, helpModel.ts | — | role-aware | web:help.test.tsx "opens help for the current page from the header, and closes on Escape" | Passed |  |
| E-02 | RELEASE_NOTES (P3) | Help | Full Help page `/help`, `/help/<topic>`, topic list, narrow-screen drop-down | web/pages/help/HelpPage.tsx | — | role-aware | web:help.test.tsx "offers a topic drop-down for narrow screens", "opens a topic by address, and refuses one the role cannot read" | Passed |  |
| E-03 | RELEASE_NOTES (P3) | Help | Topics follow sidebar access; cover every page; search | web/help/helpTopics.ts, useHelpTopics.ts | — | same as sidebar | web:help.test.tsx "covers every page in the navigation", "shows a page topic exactly to the users the sidebar shows the page to" | Passed |  |
| E-04 | RELEASE_NOTES (P3) | Help/User guide | Each topic names an existing USER_GUIDE chapter | web/help/helpTopics.ts; docs/user-guide/USER_GUIDE.md | — | — | web:help.test.tsx "names a chapter of the user guide that exists" | Passed |  |
| E-05 | docs/README.md (P3) | Handover | Technical handover, API reference, role permission matrix | docs/technical/TECHNICAL_HANDOVER.md, API_REFERENCE.md, ROLE_PERMISSION_MATRIX.md | — | — | none (document deliverable) | Passed (document review) | Existence verified; not testable |
| E-06 | docs/README.md (P3) | Handover | Training guide and UAT checklist (incl. INT-01…19) | docs/training/TRAINING_GUIDE.md; docs/uat/UAT_CHECKLIST.md | — | — | none (document deliverable) | Passed (document review) | UAT not executed (H-15) |
| E-07 | docs/README.md (P3) | Handover | Handover pack: admin checklist, sign-off form, deployment checklist, infra register, user access, attendance template | docs/handover/*.md | — | — | none (document deliverable) | Passed (document review) | Client to complete |
| E-08 | OUTSTANDING_ISSUES_REGISTER | Handover | Outstanding Issues Register and Release Notes maintained | docs/handover/OUTSTANDING_ISSUES_REGISTER.md, RELEASE_NOTES.md | — | — | none (document deliverable) | Passed (document review) | Register not yet updated for 0110–0116 work |

---

## F. Client-requested modifications (STS_ELV_CLIENT_FIXES_20261109.md)

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| F-01 | Client fixes §1 | Branding | User-visible name "STS-ELV AMC" (title, login, sidebar, header, help, exports, emails, API health) | stslv-web/index.html; api/shared/export/branding.ts; api/app.ts | — | — | api:sts-elv-client-fixes.test.ts "uses the confirmed STS-ELV name in exports and the API"; web:auth.test.tsx, shell.test.tsx, help.test.tsx (grep "STS-ELV AMC") | Passed | Storage keys, routes, DB ids deliberately unchanged |
| F-02 | Client fixes §1 | Auth | `stselv`, `stselvamc` added to weak-password list (API and web) | api/shared/password-policy.ts; web/lib/password.ts | — | — | none located for `stselv`/`stselvamc` (api:password-policy.test.ts covers the older brand word "Stslv@2026!!") | Passed | Present in both deny-lists api:password-policy.test.ts refuses "Stselv@2026!!" and "StselvAmc#2026" (added at integration). |
| F-03 | Client fixes §2 | AMC Contracts | Validity filter `all/due/expired` independent of stored status (API, page, export, `?validity=`) | api/modules/amc/contracts.service.ts, amc.schemas.ts (`CONTRACT_VALIDITY_FILTERS`); web/pages/amc/AmcContractsPage.tsx | — | AMC_CONTRACTS:VIEW/EXPORT | api:sts-elv-client-fixes.test.ts "lists expired contracts by validity, whatever their stored status"; web:sts-elv-client-fixes.test.tsx "opens already filtered from ?validity=due" | Passed |  |
| F-04 | Client fixes §2 | AMC Contracts | Due = Active ending within 45 days; Expired agrees with Expired figure; reading never changes status; renewed stays listed | api/modules/amc/contracts.service.ts | — | AMC_CONTRACTS:VIEW | api:sts-elv-client-fixes.test.ts "agrees with the Expired figure and never changes the stored status", "keeps a renewed contract visible under Expired" | Passed |  |
| F-05 | Client fixes §2 | AMC Contracts | Contract column hideable in Hide Columns, page-only (not exported) | web/pages/amc/AmcContractsPage.tsx | — | — | web:sts-elv-client-fixes.test.tsx "hides and shows the Contract column, remembering the choice…" | Passed |  |
| F-06 | Client fixes §3 | Renewal | "Start Renewal" opens prefilled Add AMC Contract form naming the original | web/pages/amc/ContractFormModal.tsx, ContractDetailPage.tsx, amcRenewal/AmcRenewalPage.tsx | — | AMC_RENEWAL:CREATE | web:amc-renewal.test.tsx (button "Start Renewal"); web:contract-register-finance.test.tsx | Passed |  |
| F-07 | Client fixes §3 | Renewal | Updated renewal contract document required (PDF/Word), validated before storage, removed if renewal fails, audited | api/modules/amc/contracts.service.ts | 0071, 0103 | AMC_RENEWAL:CREATE | api:sts-elv-client-fixes.test.ts "refuses a renewal without its document and creates nothing", "refuses a file that is not a PDF or Word document, and stores nothing" | Passed |  |
| F-08 | Client fixes §3 | Renewal | Original contract unchanged; `renewed_from_id` link and audit kept | api/modules/amc/contracts.service.ts, renewals.service.ts | 0072 | AMC_RENEWAL:CREATE | api:sts-elv-client-fixes.test.ts "saves the renewal with its own document, linked to the unchanged original"; api:contract-versions-sales-value.test.ts "keeps the original unchanged…" | Passed |  |
| F-09 | Client fixes §3a | Contract versions | Renewal keeps the same visible number; own id; version = max+1 | api/modules/amc/contracts.service.ts, contract-reference.ts | 0111 | AMC_RENEWAL:CREATE | api:contract-versions-sales-value.test.ts "gives every period the same number, its own id and the next version" | Passed |  |
| F-10 | Client fixes §3a | Contract versions | Typed different number on renewal refused (400) | api/modules/amc/contracts.service.ts | 0111 | — | api:sts-elv-client-fixes.test.ts "refuses a different contract number: a renewal keeps the number of the contract it renews" | Passed |  |
| F-11 | Client fixes §3a | Contract versions | DB integrity: unique (root, version), version check, triggers on root/number/link; number unique per chain | migration constraints/triggers | 0111 | — | api:contract-versions-sales-value.test.ts "is enforced by the database: unique versions, one number per chain, no cross-chain links"; api:migration-0111-upgrade.test.ts | Passed |  |
| F-12 | Client fixes §3a | Contract versions | Cancelled renewal keeps its version; never reused; one open renewal per contract | api/modules/amc/renewals.service.ts | 0111 | — | api:contract-versions-sales-value.test.ts "never reuses a version…", "refuses a second open renewal of the same period" | Passed |  |
| F-13 | Client fixes §3a | Contract versions | Lists/reports/exports show `STS-AMC-001 (V2)`; V2 badge; Contract 360 "Version 2" | api/modules/amc/contract-reference.ts, contracts.export.ts; web/pages/amc/AmcContractsPage.tsx, ContractDetailPage.tsx | 0111 | — | api:contract-versions-sales-value.test.ts "links services and invoices to the right period, and labels each period on every list"; web:contract-versions-sales-value.test.tsx "shows the same number for the original and its renewal…" | Passed |  |
| F-14 | Client fixes §9b | Migration | 0111 upgrade backfills (id,1), no number/value/history change | stslv-api/migrations/0111_amc_contract_versions.sql | 0111 | — | api:migration-0111-upgrade.test.ts "backfills every existing contract as version 1 of its own number, changing nothing else" | Passed | Production apply is H-04 |
| F-15 | Client fixes §4 | Service Status | AMC Value (OMR) column from contract, only for AMC_CONTRACTS:VIEW (null otherwise), never totalled | api/modules/amc/service-status.service.ts, service-status.export.ts; web/pages/amc/ServiceStatusPage.tsx | — | AMC_CONTRACTS:VIEW | api:sts-elv-client-fixes.test.ts "Service Status shows the contract's AMC Value only to users who may view contracts"; web:sts-elv-client-fixes.test.tsx "does not offer the AMC Value column to users who may not view contracts" | Passed |  |
| F-16 | Client fixes §4 | Service Status | Sales Engineer Name free text per service (≤120, no control chars, trimmed, empty clears), audited | api/modules/amc/service-status.service.ts, amc.schemas.ts | 0110 | AMC_EXECUTION:EDIT | api:sts-elv-client-fixes.test.ts "validates length and control characters, and clears with an empty value", "needs Edit on AMC Execution"; web:sts-elv-client-fixes.test.tsx "saves the typed Sales Engineer Name…" | Passed |  |
| F-17 | Client fixes §9 | Migration | 0110 adds nullable `amc_visits_all.sales_engineer_name`, view recreated, no backfill | stslv-api/migrations/0110_amc_visit_sales_engineer_name.sql | 0110 | — | api:migration-0110-upgrade.test.ts "upgrades a 0109 schema to 0110" | Passed |  |
| F-18 | Client fixes §5 | Accounts | View Service Report: read-only viewer (PDF in page, Word download), Download inside viewer | api/modules/accounts/accounts.routes.ts (`GET /:id/report`); web/pages/accounts/ServiceReportViewer.tsx | 0104 | ACCOUNTS:VIEW | api:sts-elv-client-fixes.test.ts "lists the report on the Accounts row and serves the file to Accounts viewers"; web:sts-elv-client-fixes.test.tsx "opens the report in a read-only viewer with Download inside it…" | Passed | CSP check on VPS H-10 |
| F-19 | Client fixes §5 | Accounts | Report route refuses users without ACCOUNTS:VIEW; "No report uploaded" state | api/modules/accounts/accounts.routes.ts | — | ACCOUNTS:VIEW | api:sts-elv-client-fixes.test.ts "refuses anyone without Accounts View, and a request without sign-in", "says clearly when no report exists" | Passed |  |
| F-20 | Client fixes §5 | Accounts | Missing values explained ("No Billing Basis or Cost per Visit"), counted "not included" | api/modules/accounts/accounts.service.ts; web/pages/accounts/AccountsPage.tsx | — | ACCOUNTS:VIEW | api:sts-elv-client-fixes.test.ts "Accounts totals follow the filters and are zero for an empty result" | Passed | Root cause is data (contract without basis) |
| F-21 | Client fixes §5 | Accounts | Zoho Invoice Value column = sum of active allocations per service (cancelled excluded), also in export | api/modules/accounts/accounts.service.ts, accounts.export.ts | 0060 | ACCOUNTS:VIEW | api:sts-elv-client-fixes.test.ts "Accounts shows each service's own Zoho invoice value, leaving out the cancelled invoice" | Passed |  |
| F-22 | Client fixes §5 | Accounts | Filtered totals over all pages: service value, Paid part, invoice value (never mixed) | api/modules/accounts/accounts.service.ts; web/pages/accounts/AccountsPage.tsx | — | ACCOUNTS:VIEW | api:sts-elv-client-fixes.test.ts "Accounts totals cover every filtered row across pages, with decimal precision"; web:sts-elv-client-fixes.test.tsx "shows the filtered totals over every page…" | Passed |  |
| F-23 | Client fixes §6 | Master AMC Status | Value cell adds Zoho amount and (with AMC_CONTRACTS:VIEW) AMC Value; Total Filtered row | api/modules/amc/master-status.service.ts; web/pages/masterStatus/MasterStatusPage.tsx | — | MASTER_AMC_STATUS:VIEW (+AMC_CONTRACTS:VIEW) | api:sts-elv-client-fixes.test.ts "Master AMC Status reconciles with Accounts and keeps its Zoho columns" | Passed | Export columns unchanged |
| F-24 | Client fixes §7 | Service Sales | AMC Value column = visit's own contract period value; hideable | api/modules/services-sales/services-sales.service.ts; web/pages/servicesSales/ServicesSalesPage.tsx | 0111 | SERVICES_SALES:VIEW + AMC_CONTRACTS:VIEW | api:contract-versions-sales-value.test.ts "shows each visit's own contract period value"; web:contract-versions-sales-value.test.tsx "can hide and show the AMC Value column like any other" | Passed |  |
| F-25 | Client fixes §7 | Service Sales | Total AMC Value over unique contract periods matching filters, all pages; in export notes | api/modules/services-sales/services-sales.service.ts (`amcValueTotal`), services-sales.export.ts | — | AMC_CONTRACTS:VIEW | api:contract-versions-sales-value.test.ts "totals unique contract periods across every page, not visits", "exports the AMC Value column and the unique-contract total to a permitted user" | Passed |  |
| F-26 | Client fixes §7 | Service Sales | Without AMC_CONTRACTS:VIEW: no value, no total (API, page, export) | api/modules/services-sales/services-sales.service.ts | — | AMC_CONTRACTS:VIEW | api:contract-versions-sales-value.test.ts "never sends AMC Value or its total to a user without AMC Contracts: View…"; web:contract-versions-sales-value.test.tsx "offers no AMC Value column or total…" | Passed |  |
| F-27 | Client fixes §8 | Reports | Monthly/Client-wise/Engineer-wise reports add Paid Value, Zoho Invoice Value, Services Without Value; reconcile with Accounts | api/modules/reports/reports.service.ts | — | REPORTS + ACCOUNTS | api:sts-elv-client-fixes.test.ts "the monthly report reconciles with Accounts for the same scope" | Passed |  |
| F-28 | Client fixes §12 | Dates | One business calendar (Asia/Muscat) for every "today", month and date filter (API and web) | api/shared/business-date.ts (`BUSINESS_TODAY_SQL`, `businessDateSql`, `businessDayStartSql`); web/lib/businessDate.ts | — (no migration) | — | api:business-date-oman.test.ts "changes day at midnight in Oman (20:00 UTC), not at UTC midnight"; web:business-date.test.tsx "business date helpers" | Passed |  |
| F-29 | Client fixes §12 | Dates | Valid through Valid To in Oman; expired next Oman day; agreement across Contracts, Renewal, Service Status, Dashboard; "paid this month" by Oman month | as F-28 | — | — | api:business-date-oman.test.ts "agrees across AMC Renewal, Service Status, AMC Management and the Dashboard", "counts an Invoice No. entered at 00:30 on the 1st in Oman…"; web:business-date.test.tsx "shows \"Ended 1 day ago\" from the next Oman day" | Passed |  |
| F-30 | Client fixes §13 | Dashboard | `/amc/management` renders the same DashboardPage (same API, cards, permission DASHBOARD:VIEW) | web/pages/amcManagement/AmcManagementPage.tsx → web/pages/DashboardPage.tsx; web/App.tsx | — | DASHBOARD:VIEW | web:amc-management.test.tsx "AMC Management and the Dashboard are the same page", "refuses both without Dashboard: View, even with AMC Contracts: View…" | Passed | `GET /api/amc/management/summary` kept read-only |
| F-31 | Client fixes §13 | Dashboard | Active AMCs / Annual Value / Final Credit count each contract once (past-validity and waiting renewal excluded and shown) | api/modules/dashboard/operations.service.ts, api/modules/amc/summary.service.ts (`activePastValidity`, `activeAwaitingPredecessor`); web/pages/dashboard/kpis.ts | — | DASHBOARD:VIEW | api:dashboard-shared-counts.test.ts "does not add an approved renewal on top of the original while the original runs"; web:amc-management.test.tsx "shows the same financial totals and expiry counts on both, with what is not counted" | Passed |  |

---

## G. Later approved improvements (INVOICE_ACKNOWLEDGEMENTS.md, APPLICATION_COMPLETION_AUDIT_20261110.md)

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| G-01 | Inv. Ack. intro | Invoice Ack. | Finance → Invoice Acknowledgements page after Accounts (`/finance/invoice-acknowledgements`) | web/pages/invoiceAcknowledgements/InvoiceAcknowledgementsPage.tsx; web/App.tsx; web/layout/navigation.ts | 0112, 0113 | INVOICE_ACKNOWLEDGEMENTS:VIEW | web:invoice-acknowledgements.test.tsx "appears under Finance after Accounts, keeping the other Finance entries, and opens the page" | Passed |  |
| G-02 | Inv. Ack. §1 | Invoice identity | One row per invoice (`ack_invoices` + `ack_invoice_services`), ZOHO or SERVICE basis, contract period incl. version | api/modules/invoice-acknowledgements/invoice-sync.ts, invoice-acknowledgements.service.ts | 0114 | VIEW | api:invoice-acknowledgements.test.ts "lists each invoice once, with all its services, on the right contract period"; web:invoice-acknowledgements.test.tsx "one row per invoice" | Passed |  |
| G-03 | Inv. Ack. §1, §6 | Invoice identity | Matches Accounts: each service with Invoice No. linked to exactly one listed invoice; invoice value counted once | api/modules/invoice-acknowledgements/invoice-sync.ts | 0114 | VIEW | api:invoice-acknowledgements.test.ts "matches Accounts: the same invoice numbers on the same services…", "counts each invoice once in the totals" | Passed |  |
| G-04 | Inv. Ack. §1 | Invoice identity | Equal numbers never merged automatically; same client → SAME_NUMBER flag; different clients separate | api/modules/invoice-acknowledgements/invoice-sync.ts | 0114 | — | api:invoice-acknowledgements.test.ts "equal numbers are never merged automatically" | Passed |  |
| G-05 | Inv. Ack. §1 | Invoice identity | Corrected Invoice No. keeps old association as history; returning number restores old invoice | api/modules/invoice-acknowledgements/invoice-sync.ts | 0114 | — | api:invoice-acknowledgements.test.ts "starts the new number Pending and finds the earlier invoice again if the number returns" | Passed |  |
| G-06 | Inv. Ack. §3 | Workflow | Attach acknowledgement (PDF/PNG/JPEG by content, ≤12 MB, private storage), still Pending | api/modules/invoice-acknowledgements/*.routes.ts, *.service.ts; web/pages/invoiceAcknowledgements/AcknowledgementDialogs.tsx | 0112 | INVOICE_ACKNOWLEDGEMENTS:CREATE | api:invoice-acknowledgements.test.ts "attaches one document for the whole invoice, still Pending…", "refuses an invalid, empty or wrongly named file…" | Passed |  |
| G-07 | Inv. Ack. §3 | Workflow | OK/Confirm verifies SHA-256, locks, sets Acknowledged with user/time; race → one wins | api/modules/invoice-acknowledgements/invoice-acknowledgements.service.ts | 0112 | CREATE | api:invoice-acknowledgements.test.ts "confirms only the document the user saw, and one of two simultaneous confirmations" | Passed |  |
| G-08 | Inv. Ack. §3 | Workflow | Replace document only with Edit + reason; history kept; no undo/delete once confirmed | api/modules/invoice-acknowledgements/invoice-acknowledgements.service.ts | 0112 | INVOICE_ACKNOWLEDGEMENTS:EDIT | api:invoice-acknowledgements.test.ts "replaces only with Edit and a reason, keeping the earlier version, date and user", "prevents a second acknowledgement, a silent overwrite and removal once acknowledged" | Passed |  |
| G-09 | Inv. Ack. §3 | Reconcile | Link as one invoice / They are separate / Make current, Edit + reason, audited; flagged invoice blocks new work | api/modules/invoice-acknowledgements/invoice-acknowledgements.service.ts | 0114 | EDIT | api:invoice-acknowledgements.test.ts "links them as one invoice on an authorised, reasoned request…", "confirms invoices as separate on request…"; web:invoice-acknowledgements.test.tsx "blocks acknowledgement on a flagged invoice and lets only Edit reconcile it" | Passed |  |
| G-10 | Inv. Ack. §2 | Legacy adoption | Earlier per-service acknowledgements adopted; conflicts all kept and flagged | api/modules/invoice-acknowledgements/invoice-sync.ts | 0114 | — | api:invoice-acknowledgements.test.ts "keeps conflicting confirmed acknowledgements, chooses none, and blocks new work"; api:migration-0114-upgrade.test.ts "keeps every earlier acknowledgement, adopts the unambiguous one and flags the conflict" | Passed |  |
| G-11 | Inv. Ack. §2, §5 | DB guards | Associations/identities undeletable; no cross-client/number moves; confirm needs document | migrations 0112, 0114 triggers | 0112, 0114 | — | api:invoice-acknowledgements.test.ts "database guards", "never links invoices of different clients, and the database refuses moving a service across" | Passed |  |
| G-12 | Inv. Ack. §5 | Security | Failed save removes stored file; storage down stores nothing; cross-invoice document → 404 | api/modules/invoice-acknowledgements/invoice-acknowledgements.service.ts | — | — | api:invoice-acknowledgements.test.ts "removes the stored file and records nothing when the database save fails", "stores nothing when storage is down…" | Passed |  |
| G-13 | Inv. Ack. §4 | Permissions | Approved defaults: Super Admin & Admin V/C/E/X; Finance V/C/X; others none; amounts also need ACCOUNTS:VIEW | migrations 0113, 0115; api/modules/invoice-acknowledgements/invoice-acknowledgements.routes.ts | 0113, 0115 | INVOICE_ACKNOWLEDGEMENTS:*; ACCOUNTS:VIEW | api:invoice-acknowledgements.test.ts "gives Super Admin, Admin and Finance Executive the page; Viewer and AMC Operations nothing", "hides amounts from a role that cannot view Accounts" | Passed |  |
| G-14 | Inv. Ack. §4 | Permissions | 0115 insert-only and idempotent; customised roles keep grants | stslv-api/migrations/0115_seed_invoice_acknowledgement_defaults.sql | 0115 | — | api:migration-0114-upgrade.test.ts (0113 → 0114/0115/0116, customised role, idempotency) | Passed |  |
| G-15 | Inv. Ack. §3 | Filters/export | Filters (status, number, client, search, dates), sorting, hide columns, export one row per invoice (audited) | api/modules/invoice-acknowledgements/invoice-acknowledgements.export.ts | — | EXPORT | api:invoice-acknowledgements.test.ts "exports one row per invoice, amounts only for Accounts viewers, and logs it"; web:invoice-acknowledgements.test.tsx "hides and shows columns…" | Passed |  |
| G-16 | Inv. Ack. §1; Completion audit §2.1 | Cancelled record | Cancelled Invoice Tracking record: non-blocking ZOHO_CANCELLED warning; no automatic change | api/modules/invoice-acknowledgements/invoice-sync.ts | 0116 | — | api:invoice-acknowledgements.test.ts "keeps the invoice, warns, and never reassociates on its own" | Passed |  |
| G-17 | Inv. Ack. §1 (0116) | Cancelled record | Re-associate to verified re-entered ISSUED record (same client/number, all services), Edit + reason, audited; DB refuses other changes | api/modules/invoice-acknowledgements/invoice-acknowledgements.routes.ts (`POST /:invoiceId/reassociate`) | 0116 | EDIT | api:invoice-acknowledgements.test.ts "re-associates only a verified replacement, only with Edit and a reason…", "is also refused by the database outside the cancelled-to-active case"; web:invoice-acknowledgements.test.tsx "warns without blocking acknowledgement, and re-associates only a verified record with a reason" | Passed | Partial-coverage records: client decision (H-18) |
| G-18 | Inv. Ack. §6; Completion audit §2.2 | Accounts | "Ack: Acknowledged / Pending" under Invoice No. only for INVOICE_ACKNOWLEDGEMENTS:VIEW; not exported; no Paid effect | api/modules/accounts/accounts.service.ts (`acknowledgementStatus`); web/pages/accounts/AccountsPage.tsx | 0114 | ACCOUNTS:VIEW + INVOICE_ACKNOWLEDGEMENTS:VIEW | api:invoice-acknowledgements.test.ts "shows Acknowledged / Pending beside the Invoice No. only to users who may view Invoice Acknowledgements"; web:accounts.test.tsx "Accounts acknowledgement indicator (read only)" | Passed |  |
| G-19 | Completion audit §1, §3 | Branding / UI | Branding pass (dashboard panel text, storage probe, docs); dark-mode fixes D1 (#7cc0f0) and D3 (ack row tints); D2 date only from ISSUED record | web/index.css; web/pages/dashboard/*; api/scripts/storage-check.ts; invoice-sync.ts | — | — | web:dark-theme-contrast.test.ts (status colours); web:invoice-acknowledgements.test.tsx; no test asserts the D1 Help-chip colour or the storage probe text | Passed | Partially covered; D1 and probe text not test-asserted web:dark-theme-contrast.test.ts "Help related-topic chip stays readable" (added at integration); browser sweep contrast checks (all routes, light/dark). |

---

## H. Explicitly deferred infrastructure / production work and open decisions

| ID | Source | Module | Expected behavior | Implementation | DB / migrations | Permission | Automated test evidence | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| H-01 | OI-01; OUTSTANDING_ISSUES H-1 | Backups | Activate scheduled encrypted off-site DB backups (bucket, key pair, owner, timers, first restore drill) | code ready: api/ops/backup/*; deploy/hostinger/systemd/stslv-amc-db-backup.* | — | — | (code: api:ops-backup.test.ts) | Deferred | Next phase; S1 |
| H-02 | OI-02 | Backups | Activate document (Supabase bucket) backups | api/ops/backup/documents.ts; stslv-amc-docs-backup.* | — | — | (code: api:ops-backup.test.ts) | Deferred |  |
| H-03 | OI-05; HOSTINGER_READINESS | Infra | Provision Hostinger VPS from templates; VPS UAT before DNS switch | deploy/hostinger/* | — | — | — | Deferred |  |
| H-04 | OI-21; Inv. Ack. §8.3; Completion audit §6.4 | Release | Approve and apply migrations 0108–0116 to production | stslv-api/migrations/0108…0116 | 0108–0116 | — | upgrade tests exist (migration-0110/0111/0112/0114-upgrade) | Deferred | Applied only to disposable DBs |
| H-05 | OI-19; D-1 | Release | Switch on `SERVICE_REPORT_NO_LOCK_ENABLED` and the expiry job | env switches | — | — | — | Deferred | Rules approved; activation not |
| H-06 | OUTSTANDING_ISSUES H-4 | Infra | systemd timer for `contracts:expire` with switch only in its unit | — (no timer in deploy/hostinger/systemd) | — | — | — | Deferred | Not found by design |
| H-07 | Client fixes §1, §11.3; Completion audit §1, §6.1 | Identity | Rename dev Admin login `admin@stslev.com` (add new Super Admin, verify, deactivate old) | — | — | — | — | Deferred | Client decision |
| H-08 | OI-21; SECURITY_REVIEW S-4 | DB | Apply separate runtime/backup DB roles | deploy/hostinger/sql/runtime-role.sql, backup-role.sql | — | — | — | Deferred |  |
| H-09 | Completion audit §1, §6.2 | Branding | Rename storage keys (`stslev.*`, `stslv-amc.token`), logo asset, operational ids, backup alert prefix, VPS file names | — | — | — | — | Deferred | Rename plans documented |
| H-10 | OUTSTANDING_ISSUES H-5; Client fixes §11.5 | Infra | Verify CSP in real browser on VPS (PDF viewer, exports) | — | — | — | — | Deferred |  |
| H-11 | OI-20; B-3 | Release | Release window and user notice (everyone signs in again once) | — | — | — | — | Deferred |  |
| H-12 | OUTSTANDING_ISSUES B-2 | Release | Fresh production backup and restore drill before release | — | — | — | — | Deferred |  |
| H-13 | OUTSTANDING_ISSUES B-5 | Release | Merge, push and deploy integration and client-fix branches | — | — | — | — | Deferred | Approval required |
| H-14 | OI-06; D-3 | Data | Remove DEMO records from production | — | — | — | — | Deferred | Separate approved plan |
| H-15 | OUTSTANDING_ISSUES B-4 | UAT | Client UAT, training, sign-off | docs/uat/UAT_CHECKLIST.md | — | — | — | Deferred | Not executed |
| H-16 | OI-03, OI-16 | Repo | Public repository decision; branch protection / CI | — | — | — | — | Deferred |  |
| H-17 | OI-04, OI-13, OI-14, OI-15 | Infra | Private PostgreSQL in production; Supabase round-trip check; free-plan limits; preview API | — | — | — | — | Deferred |  |
| H-18 | Inv. Ack. §8.2; Completion audit §6.3 | Invoice Ack. | Rule for a re-entered record covering only some services | — | — | — | — | Deferred | Not offered; client decision |
| H-19 | Client fixes §11.6 | Contract versions | Merge pre-0111 renewals under one number | — | — | — | — | Deferred | Data change needs approval |
| H-20 | P2 "Deferred"; OI-08, OI-09, OI-10, OI-11; SESSION_SECURITY | Various | Per-user column permissions, partial invoicing, Move to Draft/Archive, CSV export, MFA, per-account lockout, AMC_EXECUTION:APPROVE retire, retroactive service reports, Projects/Procurement screens, CLAUDE.md §16 rules | — | — | — | — | Deferred |  |

---

