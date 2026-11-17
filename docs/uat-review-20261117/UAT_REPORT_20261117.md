# STSLV AMC — End-user UAT report (role by role, CR by CR)

**Date:** 17 November 2026, 17:00–17:40 (Asia/Muscat) · **Build:** worktree `D:\Projects\STSLV-AMC-client-uat`, branch
`feature/client-uat-nov2026` (Phase 4, uncommitted) · **Environment:** isolated local preview only — web
http://127.0.0.1:5191 → API http://127.0.0.1:3191 → database `stslv_amc_client_uat_preview` (schema 0118) ·
**Data:** synthetic UAT data only · **Production:** not accessed, unchanged.

**Method.** Playwright (`playwright-core` driving the installed Microsoft Edge, headless) with one separate browser
context — own cookies and storage — per role. Every role signed in and out through the real login form with the existing
UAT accounts (passwords read from the local file, never printed or stored in these outputs). For each role: the nine
pages by direct URL, the same pages' APIs, the page controls (Add / Edit / Export / Hide Columns), 15 permission probes
and sign-out. Write probes used invalid bodies or non-existent ids, so an allowed request ends in 400/404 and writes
nothing, while a refused one returns 403. Expected results come from the approved role model and the workbook's
*Workflow & Ownership* tab, not from what the application happened to do.

**Writes made (preview only; backup `preview-before-uat-review-20261117.dump` taken first):** sign-in/out sessions and
their audit entries; export audit entries from the export probes; one Customer PO edit on the synthetic E2E contract
(1,550.000 → 1,575.250, then restored to 1,550.000; both audited). No user, password or permission was changed.

Evidence files: `uat-results.json` (raw results), `screenshots/<role>/` (118 screenshots, 58 MB) and
`Stselv changes - UAT results 2026-11-17.xlsx` (the client tracker with results; the original workbook is unchanged).
They are **kept locally and not committed** — the repository is public, the screenshots are large, and the tracker holds
the client's meeting details — in the local folder `docs/uat-review-20261117/` and in the integration backup under
`D:\Projects\_backups\`. Screenshot paths below refer to that local folder.

## 1. Role-by-role results

| Role (account) | Login | Pages (9) | Permission probes (15) | Logout (token revoked, protected page → login) | Result |
|---|---|---|---|---|---|
| Super Admin (`uat-superadmin`) | Pass | 9/9 | 15/15 | Pass | **PASS** |
| Service Dept / Admin (`uat-servicedept`) | Pass | 9/9 | 15/15 | Pass | **PASS** |
| Accounts (`uat-accounts`) | Pass | 9/9 | 15/15 | Pass | **PASS** |
| AMC Sales (`uat-amcsales`) | Pass | 9/9 | 15/15 | Pass | **PASS** |
| AMC Operations Executive (`uat-ops`) | Pass | 9/9 | 15/15 | Pass | **PASS** |
| Viewer (`uat-viewer`) | Pass | 9/9 | 15/15 | Pass | **PASS** |

"9/9" means each page opened, or showed *Access denied*, exactly as expected, and its API agreed (200 or 403).

### Page access (UI by direct URL = API)

| Page | Super Admin | Service Dept | Accounts | AMC Sales | AMC Ops | Viewer |
|---|---|---|---|---|---|---|
| Dashboard `/dashboard` | Open | Open | Open | Open (no figures, O-3) | Open | Open |
| AMC Contracts `/amc/contracts` | Open | Open | Denied | Denied | Open | Open |
| Master AMC Status `/amc/master-status` | Open | Open | Denied | Denied | Open | Open |
| Service Status `/amc/service-status` | Open | Open | Denied | Denied | Open | Open |
| Monthly Calendar `/amc/calendar` | Open | Open | Denied | Denied | Open | Open |
| Accounts / Invoices `/finance/accounts` | Open | Open | Open | Denied | Denied | Open |
| Service Sales `/amc/service-sales` | Open | Open | Denied | Open (no values) | Open | Open |
| Roles & Permissions `/admin/roles` | Open | Open | Denied | Denied | Denied | Denied |
| Audit Log `/admin/audit-log` | Open | Open | Denied | Denied | Denied | Denied |

### Create / Edit / Delete / Export (API; 403 = refused)

| Probe | Super Admin | Service Dept | Accounts | AMC Sales | AMC Ops | Viewer |
|---|---|---|---|---|---|---|
| Contract create | Allowed | Allowed | Refused | Refused | Allowed | Refused |
| Contract edit | Allowed | Allowed | Refused | Refused | Allowed | Refused |
| Contract delete (Recycle Bin) | Allowed | Refused¹ | Refused | Refused | Refused¹ | Refused |
| Contract export | Allowed | Allowed | Refused | Refused | Allowed | Refused |
| Master Status export | Allowed | Allowed | Refused | Refused | Allowed | Refused |
| Service Status edit | Allowed | Allowed | Refused | Refused | Allowed | Refused |
| Service Status export | Allowed | Allowed | Refused | Refused | Allowed | Refused |
| Invoice No. edit (Accounts) | Allowed | Allowed | Allowed | Refused | Refused | Refused |
| Accounts export | Allowed | Allowed | Allowed | Refused | Refused | Refused |
| Service Sales edit (Quote No.) | Allowed | Allowed | Refused | Allowed | Allowed | Refused |
| Service Sales export | Allowed | Allowed | Refused | Refused² | Allowed | Refused |
| Client create | Allowed | Allowed | Refused | Allowed | Refused | Refused |
| Client delete (Recycle Bin) | Allowed | Refused¹ | Refused | Refused¹ | Refused | Refused |
| Change role permissions | Allowed | Allowed | Refused | Refused | Refused | Refused |
| Users list | Allowed | Allowed | Refused | Refused | Refused | Refused |

¹ Moving a contract or client to the Recycle Bin is Super Admin only (existing rule); the role's Delete grant does not
override it. See O-1. ² AMC Sales holds Service Sales View + Edit in the preview, not Export.

The buttons on the pages match: Viewer has no Add, Edit or Export buttons on any page; Accounts has Export on Accounts
only; AMC Sales has no Export on Service Sales.

**Roles & Permissions page (CR-031):** Super Admin can edit every role except its own (read-only). Service Dept can edit
Accounts, AMC Sales, AMC Operations Executive and Viewer; Super Admin and Service Dept (its own role) are read-only.
Screenshots `screenshots/superadmin/roles-*.png`, `screenshots/servicedept/roles-*.png`.

### AMC Sales — no AMC or Service Value anywhere (CR-017, values part)

| Check | Result |
|---|---|
| Service Sales page columns | 13 columns, none a value (`amcsales/page-serviceSales.png`) |
| Hide Columns dialog | 11 options, none a value; after *Show all* still no value column (`amcsales/amc-sales-service-sales-after-show-all.png`) |
| Page text | None of the preview's contract or service amounts appears |
| API `/services-sales` | `amcValueVisible:false`, `amcValueTotal:null`, 0 of 32 rows with AMC or Service Value |
| All 28 API responses received in the session | No non-null value field, no known amount |
| Direct APIs: contracts, service status, master status, accounts, calendar, dashboard calendar, reports, invoices, schedule | All 403 |
| Direct URLs: `/amc/contracts`, `/amc/contracts/8`, `/amc/service-status`, `/finance/accounts`, `/amc/master-status`, `/reports` | All *Access denied* (`amcsales/amc-sales-direct-url-denied.png`) |
| Excel and PDF export | 403 (no Export grant); no export buttons. Value removal for a Service Sales user who has Export is covered by the automated API tests (Excel and PDF) |
| Dashboard | Key Figures empty: no values (O-3) |

**Result: PASS.** CR-017's engineer-ownership rule is **not implemented** and remains Pending Client Clarification.

## 2. Change requests (all 32)

| CR | Screen | Result | Evidence (screenshot under `screenshots/`) |
|---|---|---|---|
| CR-001 | Dashboard | Pass — row 4 "Overall Till Date" | superadmin/page-dashboard.png |
| CR-002 | Dashboard | Pass — row 5 (last) "Overall Contract", calculation unchanged | superadmin/page-dashboard.png |
| CR-003 | Dashboard | Pass — row 2 "Current Month" | superadmin/page-dashboard.png |
| CR-004 | Dashboard | Pass — row 3 "Current Year (YTD)", same four figures | superadmin/page-dashboard.png |
| CR-005 | Add AMC Contract | Pass — "Sales Engineer *" (required) | superadmin/cr005-add-contract-form.png |
| CR-006 | AMC Contracts | Pass — "Sales Engineer" column | superadmin/page-contracts.png |
| CR-007 | Master AMC Status | Pass — "Sales Engineer" | superadmin/page-masterStatus.png |
| CR-008 | Master AMC Status | Pass — "Service Engineer" right after "Service Status" | superadmin/page-masterStatus.png |
| CR-009 | Service Status | Pass — "Sales Engineer", read-only from the contract | superadmin/cr023-cr028-service-status.png |
| CR-010 | Service Status | Pass — one label "Service Engineer" (input); flows to Master Status, Accounts, Service Sales | superadmin/cr023-cr028-service-status.png |
| CR-011 | Accounts | Pass — "Sales Engineer" after "Service Report No." | superadmin/page-accounts.png |
| CR-012 | Accounts | Pass — "Service Engineer" next to Sales Engineer | superadmin/page-accounts.png |
| CR-013 | Accounts | Pass — "AMC Value (ex VAT)" = Customer PO Value; "Not entered" when blank; UI edit shown on Contract 360 and Accounts and audited (from/to, user) | superadmin/cr013-po-edited-accounts.png, cr013-po-edited-contract-360.png, cr013-cr032-po-change-in-audit-log.png |
| CR-014 | Accounts | Pass — "Service Value (ex VAT)" after AMC Value | superadmin/page-accounts.png |
| CR-015 | Service Sales | Pass — "Sales Engineer" | superadmin/page-serviceSales.png |
| CR-016 | Service Sales | Pass — "Service Engineer" after Service Report | amcsales/page-serviceSales.png |
| CR-017 | Service Sales | **Partial — Pending Client Clarification.** Values: Pass (section 1). Ownership: not implemented | amcsales/*.png |
| CR-018 | Service Sales | Pass — Quote No. before completion refused (409) | — |
| CR-019 | AMC Contracts | Pass — "Contract Value (ex VAT)" | superadmin/page-contracts.png |
| CR-020 | AMC Contracts | Pass — "Final Credit (ex VAT)" | superadmin/page-contracts.png |
| CR-021 | Service Status | Pass — "AMC Value (ex VAT)" (see O-2 for Service Sales) | superadmin/page-serviceStatus.png |
| CR-022 | Service Status | Pass — "Service Value (ex VAT)" (see O-2) | superadmin/page-serviceStatus.png |
| CR-023 | Service Status | Pass — headings at most 2 lines at 1920 px; no page side-scroll at 1366 and 390 px; client to confirm on a 27" monitor | superadmin/cr023-cr028-service-status.png, responsive-*.png |
| CR-024 | Monthly Calendar | Pass — position 2 "No. of services completed" | superadmin/page-calendar.png |
| CR-025 | Monthly Calendar | Pass — position 3 "No. of services not completed" | superadmin/page-calendar.png |
| CR-026 | Monthly Calendar | Pass (approved rule) — position 4 "Paid" = Zoho Invoice No. entered | superadmin/page-calendar.png |
| CR-027 | Monthly Calendar | Pass (approved rule) — position 5 "Unpaid" | superadmin/page-calendar.png |
| CR-028 | Service Status | Pass — "Total Filtered" row; Q-03 open | superadmin/cr023-cr028-service-status.png |
| CR-029 | AMC Schedule | Pass — not in the sidebar, still opens by address; Q-08 open | — |
| CR-030 | All grids | Pass (approved decision) — every authorized column visible by default (e.g. Accounts 13 of 13, Service Status 13 of 13, Contracts 10/10); Show/Hide with Reset / Show all | superadmin/hide-columns-*.png |
| CR-031 | Users & Permissions | Pass — six roles in separate sessions, all PASS; Admin configurable within its authority | section 1 |
| CR-032 | Audit Log | Pass — records sign-in/out, exports, contract create/update (incl. Customer PO from/to), completion, Service Engineer, Invoice No., acknowledgement, quotation, regenerate, renewal, permission changes | superadmin/cr032-audit-log.png |

**Totals:** 31 Pass (including approved decisions CR-026, CR-027, CR-030) · 1 Partial — Pending Client Clarification
(CR-017 ownership) · 0 Fail.

## 3. Remaining issues and exact locations

| ID | Type | Location | Description | Owner |
|---|---|---|---|---|
| P-1 | Pending clarification | AMC Sales › Service Sales `/amc/service-sales` | CR-017 ownership ("each engineer sees only own records"): whose records (contract Sales Engineer or visit Service Engineer) and who sees all | Client |
| P-2 | Pending clarification | Administration › Roles & Permissions `/admin/roles` | The privileged Admin role is displayed as "Service Dept". Confirm it is the "Admin" of CR-031 | Client |
| P-3 | Open questions | Various | Q-03 totals placement, Q-04 Accounts column order, Q-06 recording, Q-07 older data, Q-08 AMC Schedule hide vs remove | Client |
| O-1 | Observation | AMC Contracts `/amc/contracts`, Clients `/clients`; Roles & Permissions | A Delete grant does not let Service Dept, AMC Ops or AMC Sales move contracts or clients to the Recycle Bin (Super Admin only, existing rule; the message explains). Contract Delete is still needed to cancel a contract | Client awareness |
| O-2 | Observation (label) | Service Sales `/amc/service-sales` (roles that may see values) | Headings "AMC Value (OMR)" and "Service Value (OMR)"; CR-021/022 renamed only the AMC Execution headings. Relabel to "(ex VAT)" if wanted (needs approval) | Client |
| O-3 | Observation (UX) | Dashboard `/dashboard` as AMC Sales | "Key Figures" is empty (correctly no values). Decide whether AMC Sales should see Service Sales counters there | Client |
| O-4 | Observation (label) | Accounts `/finance/accounts`; Master AMC Status `/amc/master-status` | "Zoho Invoice Value (Ex VAT, OMR)" and "Value (Ex VAT)" differ in wording from "(ex VAT)" elsewhere | Client |
| O-5 | Note | Accounts, Service Status, Contracts as Viewer | Viewer sees AMC and Service values (it holds View on those pages). Expected under the role model; client to confirm | Client |

No defects were found in the tested scope.

## 4. Production and repository

- Production (Neon, Render, Cloudflare) was not accessed; no production data, users or permissions were changed.
- No application code was changed for this UAT; nothing was committed, pushed, merged or deployed.
- Main alpha folder `D:\Projects\STSLV-AMC` unchanged; alpha = origin/alpha = origin/develop = `91323e8`.
- The local preview servers (5191, 3191) are left running for review.
