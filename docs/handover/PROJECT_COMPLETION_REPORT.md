# Project Completion Report — STS-ELV AMC Phase 1 (draft)

Status: **DRAFT — not accepted.** Prepared 2026-11-09 for handover. Training has not been delivered, UAT has not been executed and the client has not signed off. Those sections are left open and must be completed from real records.

## 1. Objective

Replace the client's Excel-based AMC tracking with one connected workflow so that every AMC contract, scheduled service, completion and invoice number is traceable, missed visits and missed invoices are visible, and management has one source of figures (CLAUDE.md §1, §17).

## 2. Delivered scope (at commit `c6d8d19`, live on the client-review hosting)

| Requirement area (CLAUDE.md §4) | Delivered | Notes |
|---|---|---|
| 4.1 Authentication, users, role-based access | Yes | Six-role model; configurable permissions; enforced in the API |
| 4.2 Client master | Yes | Plus Sales Engineers, System Types, Maintenance Frequencies, Departments |
| 4.3 AMC contracts | Yes | Manual AMC reference, contract document, Billing Basis, status workflow, Contract 360 |
| 4.4 AMC schedule | Yes | Generated from validity and frequency; month view, filters, exports; date-based records |
| 4.5 AMC execution | Yes | Service Status with Service Report and completion lock |
| 4.6 Projects | **Removed from the UI** at the client's revised scope (2026-10-27); API and data kept | Confirm (OI-11) |
| 4.7 Procurement | **Removed from the UI**; API and data kept | Confirm (OI-11) |
| 4.8 Project expenses | **No screen**; API kept | Confirm (OI-11) |
| 4.9 Invoice tracking | Yes | Zoho invoices with allocations; separate manual Invoice No. (Paid reference status) approved 2026-11-01 |
| 4.10 Dashboard and reports | Yes | 12 KPIs, calendar, 12 reports with Excel/PDF |
| Additional | Yes | AMC Renewal, Master AMC Status, Accounts, Service Sales, Recycle Bin, Audit Log, Login History, Security Center, Suggestions, Notifications, Supabase document storage |
| Help and documentation | Integrated locally on `integration/stslv-amc-final-20261109` (not released) | In-app Help; user guide; technical, training, UAT and handover documents; updated for P0, P1 and P2 |
| Production safety (P0) | Integrated locally (not released) | Server-side sessions, password policy, append-only Audit Log (migrations 0108, 0109), scheduled encrypted backups and VPS templates — none active in production |
| Mandatory fixes (P1) and improvements (P2) | Integrated locally (not released) | Shared service scope, approved expiry and report-number rules (switches off), custom roles for Super Admin and Admin, report permission isolation, calendar By contract, Zoho references export |

## 3. Quality evidence

| Evidence | Result | Where |
|---|---|---|
| Web automated tests (P3 branch, 2026-11-09) | 821 / 821 passed (53 files) with `--maxWorkers=2`; typecheck, lint, build pass. Default-parallel runs on a loaded machine showed timing failures (2, also present on base `c6d8d19`; 29 under heavy load), none reproducible in isolation | `stslv-web` Vitest |
| API automated tests | Run by each feature session, then on the integrated branch against a disposable database: see `docs/integration/TEST_RESULTS.md` | `stslv-api/tests` |
| Integrated web tests | See `docs/integration/TEST_RESULTS.md` | `stslv-web` Vitest |
| Release checks | Pre/post-release read-only database comparisons for each production release | Delivery team records |
| UAT | **Not executed** | `docs/uat/UAT_CHECKLIST.md` |
| Training | **Not delivered** | `docs/training/TRAINING_GUIDE.md` |

## 4. Open items

See `docs/handover/OUTSTANDING_ISSUES_REGISTER.md`. Items that block go-live in their current state: **OI-01** (backup ownership). Items needing a plan before sign-off: OI-02 to OI-06, OI-10, OI-11, OI-13, OI-17.

## 5. Documentation dependent on unfinished work

> **Integration update (2026-11-09):** P0, P1, P2 and P3 were integrated locally on `integration/stslv-amc-final-20261109` and the documents below were re-checked and updated. What changed and what remains: `docs/integration/INTEGRATION_REPORT.md` and `docs/integration/OUTSTANDING_ISSUES.md`. The text below is kept as written for the record.

The user guide and in-app Help describe `c6d8d19`. The parallel P0 (security) and P1 (fixes) branches started from the same commit and were unfinished when this was written. After they are integrated, re-check:

| Document / topic | Depends on |
|---|---|
| User guide: Getting started (sign-in, passwords), Users and Roles, Security Center, Login History; Help topics `getting-started`, `users-and-roles`, `security-center`, `login-history` | P0 security changes (sessions, rate limits, password rules, headers, CORS) |
| Technical handover §6 (Neon exposure), §9 (VPS), §10 (env names), §11 (troubleshooting); API reference §1 | P0 changes to configuration or API behaviour |
| User guide: Service Status, AMC Schedule, Accounts, Contract 360, Reports, Dashboard; matching Help topics; UAT sections 4–13 | P1 fixes to workflows, labels or figures |
| Role permission matrix | Any change to the permission catalog or starting grants |
| Release notes | Final integrated commit |

**Known P1 changes to reflect (local commit `3e2cb28` on `feature/stslv-p1-fixes`, seen 2026-11-09, not merged):**

| P1 change | Documents to update at integration |
|---|---|
| One shared service scope: services of a **cancelled** contract count only if Completed or Paid (Dashboard, Service Status, Accounts, Master AMC Status, Service Sales, workload) | User guide Dashboard, Service Status, Accounts, Master AMC Status, Service Sales; Help topics of the same pages; Outstanding Issues OI-07 (may be resolved); UAT ACC/MAS/SS tests |
| Controlled contract expiry: `npm run contracts:expire` (Asia/Muscat, advisory lock); `--apply` only with `AMC_CONTRACT_EXPIRY_ENABLED=true` (off) | User guide/Help statements "Contracts are never expired automatically" (still true while off); Technical handover §10 env names and §12 scripts; Deployment checklist; OI-12 (time zone) |
| Service Report No. locked after Paid, behind `SERVICE_REPORT_NO_LOCK_ENABLED` (off); override by Super Admin/Admin with a reason (`amc_visit.service_report_no_override`) | User guide Service Status ("Service Report No. can still be saved after completion"); Help `service-status`; Technical handover §10 |
| Permission catalog texts: Accounts / Invoice Tracking Edit wording; Recycle Bin listed as Super Admin only | Role permission matrix §3; User guide Users and Roles |

A P2 session (improvements) was also reported running; its changes were not inspected by P3 and must be reviewed the same way.

## 6. Remaining activities before closure

1. ~~Integrate P0, P1 and P3; re-verify the documents in §5.~~ Done locally 2026-11-09 (P0, P1, P2, P3); production release still needs approval.
2. Execute UAT; record results; fix or accept failures.
3. Deliver training; record attendance.
4. Complete the Infrastructure Ownership Register, User Access Handover and Admin Handover Checklist.
5. Resolve or accept outstanding issues.
6. Client sign-off (`CLIENT_SIGNOFF_FORM.md`).

## 7. Sign-off

Not signed. See `CLIENT_SIGNOFF_FORM.md`.
