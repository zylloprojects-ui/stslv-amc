# Test Results — Final Integration

2026-11-09, branch `integration/stslv-amc-final-20261109`. All runs on this machine (Windows 11, Node 24.21,
PostgreSQL 17.11) against **disposable resources only**: database `stslv_amc_final_integration` created for
this purpose (schemas `stslv_test` for the API suite, `fresh_path`/`upgrade_path` for the migration checks,
`e2e` for the browser run). Never `stslv_amc_dev`, Neon, Supabase or any hosted service. Full suites were run
one at a time with controlled worker counts.

## 1. Summary

| Check | Result |
|---|---|
| API full suite, integrated (`vitest run --maxWorkers=1`; files run one at a time) | **1779 passed, 2 skipped** (103 files), 0 failed |
| — of which new `tests/integration-cross-branch.test.ts` | 6 / 6 passed |
| Web full suite, integrated (`vitest run --maxWorkers=2`) | **843 passed** (55 files), 0 failed |
| Migration 0108/0109 checks (fresh and upgrade paths) | **22 / 22** passed |
| Browser E2E (headless Edge over DevTools, isolated stack) | **23 / 23** checks passed |
| API typecheck (`tsconfig.typecheck.json`, tests included) | Pass |
| API build (`tsc`) | Pass |
| Web typecheck + production build (`tsc -b && vite build`) | Pass |
| Web lint (oxlint) | Pass (exit 0); 13 warnings, all in files carried unchanged from the source branches |

The 2 skipped API tests are the "before migration 0076" variant (`maintenance-frequencies.test.ts`), which only
applies to an unmigrated database; every source branch shows the same 2 skips.

## 2. Per-branch results before integration (for comparison)

| Branch | API | Web |
|---|---|---|
| P0 `91b4da7` | 1688 passed, 2 skipped (+ schema test 16/16 after fix) | 809 passed |
| P1 `597e356` | 1685 passed, 2 skipped | 808 passed |
| P2 `051906c` | 1699 passed, 2 skipped | 817 passed |
| P3 `c0ea7d5` | no API change | 821 passed |

The integrated totals are higher because the suites are combined (P0 sessions/backup/password/audit tests,
P1 approved-rule tests, P2 role/report/export tests, P3 Help tests) plus the cross-branch test.

## 3. Areas covered by the API suite (selected files)

| Area | Files |
|---|---|
| Authentication, authorization | `auth*.test.ts`, `admin-security-gaps.test.ts`, `permissions.test.ts`, `cross-module-permissions.test.ts` |
| Sessions: creation, expiry, idle timeout, revocation, pre-0108 tokens | `sessions.test.ts` |
| Password policy | `password-policy.test.ts` |
| Roles, custom roles, escalation | `roles.test.ts`, `role-model.test.ts`, `custom-roles.test.ts`, `admin-custom-roles.test.ts`, `integration-cross-branch.test.ts` |
| Audit Log integrity | `audit.test.ts`, `audit-log-protection.test.ts`, `integration-cross-branch.test.ts` |
| Backup and restore (disposable DB, throwaway GnuPG key, temp folders), same-second "latest" | `ops-backup.test.ts` (14) |
| Contracts, lifecycle, renewals, scheduling | `amc-contracts.test.ts`, `amc-contract-*.test.ts`, `amc-renewals.test.ts`, `amc-renewal-queue.test.ts`, `amc-schedule*.test.ts`, `first-service-priority.test.ts` |
| Contract expiry at Oman boundaries, Service Report No. lock, historical Paid services | `p1-approved-rules.test.ts` |
| Service Status, Service Sales, Accounts, invoice references | `amc-service-status.test.ts`, `services-sales*.test.ts`, `accounts*.test.ts`, `invoices*.test.ts` |
| Reports permissions, exports | `reports-permissions.test.ts`, `p2-exports-usage.test.ts`, `p2-zoho-references.test.ts`, `amc-master-status.test.ts` |
| Dashboard, cancelled-contract counting | `dashboard*.test.ts`, P1 scope tests |
| Files, validation, errors | `attachments*.test.ts`, `service-reports*.test.ts`, schema tests |
| Schema inventory | `database.test.ts` |

## 4. Browser end-to-end run

**Stack:** web `http://127.0.0.1:5311` (Vite, `VITE_API_PROXY_TARGET=http://127.0.0.1:3311`) → API on 3311 with
its own random `JWT_SECRET`, `DB_NAME=stslv_amc_final_integration`, `DB_SCHEMA=e2e`, local scratch folder for
documents, `MAIL_TRANSPORT=none`, `SERVICE_REPORT_NO_LOCK_ENABLED=true`. The expiry job ran once with
`AMC_CONTRACT_EXPIRY_ENABLED=true` in its own process. Data: synthetic (`*@e2e.invalid`, `E2E-AMC-*`), seeded
through the application's own services. A guard aborted the run unless only seeded `E2E-` contracts were
visible and the main development API (3001) was not running. No API server was ever started against
`stslv_amc_dev`.

**Driver:** headless Microsoft Edge over the DevTools protocol (Playwright is not installed in this project).

| # | Check | Result |
|---|---|---|
| G | Isolation guard | PASS |
| 1a–1e | Super Admin: login form; Role list buttons; add custom role (UI); set its permission in Roles & Permissions (UI, saved); may give Users & Access | PASS |
| 2a–2b | Admin: Add role present, no actions on built-in roles; adds a custom role (UI) with Edit/Delete | PASS |
| 3a–3c | Admin: Users & Access boxes disabled (UI); grant refused (403); built-in rename and Super Admin assignment refused (403) | PASS |
| 4 | Viewer: no Roles & Permissions page; role creation 403 | PASS |
| 5 | Contract 360 and generated schedule (13 monthly services) | PASS — contract created by the seed through the service layer, not the form |
| 6 | Calendar Month view By contract / By service (UI); no switch in Year view | PASS |
| 7 | Invoice No. saved from the signed-in Finance page; shown in Accounts and Master AMC Status | PASS — saved through the page's API call, not by typing in the field |
| 8 | Paid reference status; Zoho invoice and reference returned together; Finance refused Master AMC Status export | PASS |
| 9 | Service Report No. locked after Paid: Ops refused (403/409), Admin overrides with reason (200), Audit Log page shows it | PASS |
| 10 | Finance opens Reports (UI) and exports Monthly Maintenance (xlsx) | PASS |
| 11 | AMC Contract Summary not offered; view and export 403 | PASS |
| 12 | Expiry: ended yesterday (Oman) → Expired (shown in UI); ends today → Active; open renewal unchanged; second run 0 changes | PASS |
| 13 | Admin signs a Viewer session out in Security Center → Active sessions (UI); token refused `SESSION_REVOKED` | PASS |
| 14 | Help: Viewer sees no administration topics; Admin sees Roles & Permissions with the custom-role rules | PASS |
| L | No horizontal page scroll at 390 px and 1440 px: Help, Role list, Calendar By contract, Security Center, Master AMC Status | PASS (screenshots reviewed; Role list table cramped at 390 px inside its own scroll box — Low, `OUTSTANDING_ISSUES.md` M-1) |

Two earlier runs failed on script issues, not application defects, and were corrected: reading a visit
through an endpoint Finance may not use (the run then used the Accounts list, as the Accounts page does), a
Master AMC Status check as Finance (who correctly has no access), an expiry message pattern, and text checks
using `innerText` (affected by CSS upper-casing; changed to `textContent`). The schema was dropped, re-migrated
and re-seeded before the final run.

**Limits:** not a full UI workflow test. Contract creation through the form, document and report uploads
through the file picker, opening exported files, dark mode, real devices, and the 30-minute inactivity
sign-out in real time were not exercised in the browser (they are covered by API/web component tests where
applicable, and listed for UAT).

## 5. Failures and regressions

No integration regression. During integration:
- one migration-check assertion of mine expected 109 migration files; the numbering has historical gaps and
  there are 51 files — the check was corrected, all migrations were applied in both paths;
- one web lint/typecheck run and the Help test (17/17) were repeated after the Help/guide edits.

No security assertion was weakened; no test expectation was changed to make a failure pass.
