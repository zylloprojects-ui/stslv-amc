# STSLV AMC — Client UAT completion report (Phases 1–4)

Date: 17 November 2026 · Branch `feature/client-uat-nov2026` (worktree `D:\Projects\STSLV-AMC-client-uat`), from `91323e8`
· **Local only: nothing committed, pushed, merged or deployed; production (Neon, Render, Cloudflare) untouched** · Source:
the client workbook *Stselv changes .xlsx* (UAT review 16-Nov-2026), all eight tabs, and the owner's Phase 4 decisions of
17-Nov-2026. Evidence = automated tests (named below), the end-to-end run on the isolated preview (42/42), the CR-031
preview grant/revoke run (15/15) and browser checks at 2560, 1920, 1366 and 390 px. No meeting transcript or recording is
available locally, so transcript line references in the workbook could not be checked.

Statuses: **Completed and Tested** · **Implemented — Client UAT Pending** · **Pending Client Clarification** ·
**Not Implemented**.

## A. Summary

Phase 4 completes every approved requirement except CR-017's own-records rule, which is recorded as **Pending Client
Clarification** (its value restrictions stay in force):

- **CR-013** — a dedicated, optional **Customer PO Value (ex VAT)** on the AMC contract (additive migration 0118). Accounts
  shows it as *AMC Value (ex VAT)* after Sales Engineer, with Service Engineer adjacent and Service Value (ex VAT) as a
  separate column. "Not entered" when empty; nothing backfilled; no calculation reads it.
- **CR-026/027** — kept exactly as built (Paid = Zoho Invoice No. entered; Unpaid = not entered). Verified only.
- **CR-030** — no authorized column is hidden by default; Show/Hide with Reset / Show all on every listed table.
- **CR-031** — Admin (shown as *Service Dept*) now configures the permissions of Accounts, AMC Sales, AMC Operations
  Executive and Viewer, besides custom roles, within its own authority; Super Admin is protected and Admin cannot escalate.
- **CR-017** — ownership filtering **not implemented** (Pending Client Clarification); value restrictions preserved.

## B. Change requests

| CR | Screen | Status | Label / position | Data source | Evidence |
|---|---|---|---|---|---|
| 001 | Dashboard | Completed and Tested | "Overall Till Date", row 4 | Services scheduled on or before Oman today (`periodServiceFigures`) | API `client-uat-nov2026`; web `dashboard.test`; browser |
| 002 | Dashboard | Completed and Tested | "Overall Contract", row 5 (last) | Unchanged calculation | Same |
| 003 | Dashboard | Completed and Tested | "Current Month", row 2 | Unchanged | web test, browser |
| 004 | Dashboard | Completed and Tested | "Current Year (YTD)", row 3 | Jan 1 → Oman today | API + web tests, browser |
| 005 | Add AMC Contract | Completed and Tested | "Sales Engineer" (required picker) | `amc_contracts.sales_engineer_id` | web form tests, E2E stage 1 |
| 006 | AMC Contracts list | Completed and Tested | "Sales Engineer" column | Linked engineer; typed name only without link | API + web tests, browser |
| 007 | Master AMC Status | Completed and Tested | "Sales Engineer" | Contract link | web test, E2E |
| 008 | Master AMC Status | Completed and Tested | "Service Engineer" after Service Status | `amc_visits.sales_engineer_name` (0110) | API + web tests, E2E, browser |
| 009 | Service Status | Completed and Tested | "Sales Engineer", read-only | Contract link | web test, E2E |
| 010 | Service Status | Completed and Tested | "Service Engineer" input | Visit column; flows to Master Status, Accounts, Service Sales | API + web tests, E2E stage 3, Audit label test |
| 011 | Accounts › Invoices | Completed and Tested | "Sales Engineer" after Service Report No. | Contract link | API export order test, browser |
| 012 | Accounts › Invoices | Completed and Tested | "Service Engineer" adjacent to Sales Engineer | Visit column | web order test; browser headers |
| 013 | Accounts › Invoices | **Completed and Tested** (Phase 4) | "AMC Value (ex VAT)" after Service Engineer | **`amc_contracts.customer_po_value`** (0118), as entered | See C |
| 014 | Accounts › Invoices | Completed and Tested | "Service Value (ex VAT)", separate column | `visit_amount` | API + web tests |
| 015 | Service Sales | Completed and Tested | "Sales Engineer" | Contract link | tests, browser |
| 016 | Service Sales | Completed and Tested | "Service Engineer" | Visit column | tests, E2E stage 6 |
| 017 | Service Sales | **Pending Client Clarification** (ownership) | Values withheld from AMC Sales | Server-side, unless AMC Contracts: View | Value restriction tested (page, totals, Excel, PDF, E2E stage 6). Ownership filter **not implemented** — see G |
| 018 | Service Sales | Completed and Tested | Quote No. only after completion | Existing rule | API, E2E stage 6 |
| 019 | AMC Contracts | Completed and Tested | "Contract Value (ex VAT)" | Unchanged | tests, browser |
| 020 | AMC Contracts | Completed and Tested | "Final Credit (ex VAT)" | Unchanged | tests, browser |
| 021 | Service Status | Completed and Tested | "AMC Value (ex VAT)" | `contract_value` (unchanged; CR-013 applies to Accounts) | tests, browser |
| 022 | Service Status | Completed and Tested | "Service Value (ex VAT)" | `visit_amount` | tests, browser |
| 023 | Service Status | Implemented — Client UAT Pending | Compact grid, headings ≤ 2 lines | Scoped CSS | Browser 2560/1920/1366/390 |
| 024 | Monthly Calendar | Completed and Tested | "No. of services completed", position 2 | Existing counts | web test, browser |
| 025 | Monthly Calendar | Completed and Tested | "No. of services not completed", position 3 | Existing counts | web test, browser |
| 026 | Monthly Calendar | **Completed and Tested** (owner decision) | "Paid", position 4 | Zoho Invoice No. entered (reference status) | See D |
| 027 | Monthly Calendar | **Completed and Tested** (owner decision) | "Unpaid", position 5 | No Invoice No. entered | See D |
| 028 | Service Status | Completed and Tested | "Total Filtered" row | Service Value summed; AMC Value once per contract | API + web tests, browser |
| 029 | AMC Schedule | Implemented — Client UAT Pending | Hidden from sidebar; route kept | Navigation only | web tests, browser |
| 030 | All listed grids | **Completed and Tested** (owner decision) | No default-hidden columns; Show/Hide + Reset / Show all | Per-user browser preference | See E |
| 031 | Users & Permissions | **Completed and Tested** | Admin configures operational roles within its own authority | `role_permissions`, audited | See F |
| 032 | Audit Log | Completed and Tested | Includes Customer PO and permission changes | `activity_logs` | E2E audit checks; API tests; preview |

## C. CR-013 — Customer PO Value (ex VAT)

| Item | Result |
|---|---|
| Storage | Migration **0118** (additive): nullable `amc_contracts_all.customer_po_value numeric(14,3)`, CHECK ≥ 0; `amc_contracts` view re-created with the same definition. No backfill. Reverse steps in the file header |
| Entry | AMC Contract form: optional *Customer PO Value (ex VAT)*; OMR, 3 decimals, ≥ 0 (validated in the form and the API); empty clears it. A renewal starts empty (its own PO) |
| Who may edit | Holders of AMC Contracts: Edit (backend); Accounts without it is refused (403, test) |
| Audit | Create: in the entry's description and metadata. Edit: `changes.customerPoValue {from, to}`; clearing is audited too. Audit Log label "Customer PO Value (ex VAT)" |
| Display | Accounts › Invoices *AMC Value (ex VAT)*: the PO value, or **"Not entered"**. Contract 360 figure "Customer PO Value (ex VAT)" (or "Not entered") |
| Exports | Accounts Excel/PDF: column *AMC Value (ex VAT)* = PO value (blank when none) with an explanatory note; AMC Contracts Excel: *Customer PO Value (ex VAT)* column |
| Calculations | **None changed.** Annual value, billing basis, visit amounts, term totals, Service Status AMC Value and totals unchanged |
| Single-year test | Annual 1,200.000, term 1,200.000, **PO 1,100.000** → Accounts 1,100.000 on all 4 services; visits 300.000 |
| Multi-year test | 3 years, annual 1,200.000, term 3,600.000, **PO 3,450.000** → Accounts 3,450.000 on all 12 services; visits 300.000; contract still annual 1,200.000 / term 3,600.000 |
| Validation test | −1, 12.3456, "abc", over 11 integer digits → 400; nothing stored |
| Preview | 0118 applied to `stslv_amc_client_uat_preview` only (backup taken first). E2E contract: annual 1,600.000, PO 1,550.000 → Accounts 1,550.000; all other contracts "Not entered" |

## D. CR-026 / CR-027 — Paid / Unpaid (verified, unchanged)

Paid = a Zoho Invoice No. is entered on the service; Unpaid = none entered. No payment tracking, no Zoho API, no
relabelling. Monthly Calendar order (CR-024 to CR-027) unchanged. Verified by the existing calendar, Accounts and
finance-workflow suites (all passing) and E2E stage 4 (Invoice No. entry → Paid; refused before completion and for AMC
Sales). This Paid remains a reference status, distinct from verified payment (docs/FINANCE_WORKFLOW.md).

## E. CR-030 — Column visibility

No authorized column is hidden by default; a user's saved choice is kept (stored per user in their browser, unchanged
format). A column the role may not see is never offered, so no toggle can reveal it (the API also never sends it).

| Table | Default (fresh sign-in, browser) | Show/Hide | Reset / Show all |
|---|---|---|---|
| Accounts › Invoices | All 13 optional columns shown | Hide Columns dialog | *Reset to Default* (existing) |
| Service Status | "13 of 13 shown" | Hide Columns dialog | *Show all* (existing) |
| Master AMC Status | All shown | Hide Columns dialog | *Reset to Default* (existing) |
| AMC Contracts | "Columns 10/10" | Columns menu | **New:** *Show all columns* (browser: 10/10 → 9/10 → 10/10) |
| Service Sales | All shown | Hide Columns dialog | *Show all* (existing) |

The *Show all columns* button is in the shared Columns menu, so the other pages using it (Clients, master lists, Audit
Log, AMC Schedule) gain it too; it only restores columns the menu offers (unit test).

## F. CR-031 — Configurable permissions

| Rule | Enforcement | Evidence |
|---|---|---|
| Super Admin: full access, permissions fixed | Backend (`SUPER_ADMIN_LOCKED`) | role tests; preview: Admin refused |
| Admin (*Service Dept*, needs Users & Access Edit) configures **Accounts, AMC Sales, AMC Operations Executive, Viewer** and custom roles | `roles.service.ts` `lockedReason` | API: grant + revoke for each; preview 15/15 |
| Only permissions Admin holds itself (no grant beyond its authority) | Existing check per added/removed permission; a role already holding something Admin lacks is out of Admin's reach | API (REPORTS:VIEW refused; Viewer given Reports by Super Admin → Admin refused) |
| No Users & Access grants by Admin | Existing `SECURITY_MODULES` rule | API + preview (403) |
| No self-escalation; Admin and Super Admin roles locked to Admin | `OWN_ROLE` / built-in check | API + preview (403) |
| Built-in roles: name, status, existence stay with Super Admin | `manageReason` unchanged | API |
| Other roles cannot manage roles | `canManageRoles` | API + preview (Viewer 403) |
| Audited | `role.permissions_changed` | preview: grant and revoke entries in the Audit Log |
| No hardcoded access, no automatic grants | Grants are only `role_permissions`; nothing granted by this change | — |

Preview run: Service Dept granted Viewer *Service Status: Export*, the Viewer user received it, Service Dept revoked it,
and Viewer ended exactly as it started. **Production grants are unchanged.**

**Naming note for the client:** the privileged *Admin* role (code ADMINISTRATOR) is displayed as **"Service Dept"** since
release 0117. The rule above applies to that role. If the client meant a separate "Service" operational role, that needs
clarification.

## G. CR-017 — Pending Client Clarification

Engineer ownership filtering ("each Sales Engineer sees only their own records") is **not implemented**. Open: whose
records (contract Sales Engineer via `sales_engineers.user_id`, or visit Service Engineer — free text, no user link), and
who sees everything. Preserved: AMC and Service Values are never sent to a Service Sales user without AMC Contracts:
View (page, totals, Excel, PDF; tests and E2E stage 6). CR-031 lets Admin change grants within its authority; giving AMC
Sales *AMC Contracts: View* would reveal values, by design of the permission.

## H. Test results

| Check | Result |
|---|---|
| API suite (vitest, isolated `stslv_amc_client_uat`; `ops-backup` excluded as before) | 118 files, 1,936 passed, 2 skipped, 0 failed |
| Web suite (vitest) | 63 files, 952 passed, 0 failed (help tests re-run after the last help text edit: 28 passed) |
| Typecheck API / web | Clean / clean |
| Lint (oxlint, web) | Exit 0; warnings only, all pre-existing in unchanged files |
| Builds API / web | Succeed |
| Migration tests | `migration-0118-upgrade` (0117 → 0118, existing contract untouched, no backfill, CHECK) and `migration-chain-upgrade` pass |
| Role tests | `role-model`, `admin-custom-roles`, `custom-roles`, `roles`, `permissions`, `cross-module-permissions`, `role-display-names` pass |
| E2E 7-stage workflow (preview) | 42/42, including S-02 refusal, Regenerate keeps services, renewal, audit of every stage |
| CR-031 preview grant/revoke | 15/15 |
| Browser (headless Edge, preview) | Accounts PO / "Not entered" at 1920, 1366, 390 (no page side-scroll); Contract 360 figure; Add form field (optional); default columns; Show all columns; Roles page as Service Dept (Viewer/Accounts editable, Service Dept not) |
| S-02 protection | `schedule-protection` (7 tests) pass; E2E shortening refusal |

## I. Technical changes (Phase 4)

- **Database:** `migrations/0118_amc_contract_customer_po_value.sql` (additive, reversible; applied only to the test and
  preview databases). Not on `stslv_amc_dev` or Neon.
- **Backend:** `amc.schemas.ts` (field), `contracts.service.ts` (read via `to_jsonb`, write when given, audit, refused
  with a clear error if 0118 is missing), `contracts.export.ts` (column), `accounts.service.ts` / `accounts.export.ts`
  (AMC Value = PO), `role-model.ts` + `roles.service.ts` (CR-031).
- **Frontend:** `ContractFormModal.tsx`, `ContractDetailPage.tsx`, `types.ts`, `AccountsPage.tsx` ("Not entered"),
  `ColumnsMenu.tsx` (Show all columns), `auditTypes.ts` (label), `helpTopics.ts`.
- **Docs:** `USER_GUIDE.md` (contract field, Accounts column, role table), this report.
- **Tests added/updated:** `migration-0118-upgrade.test.ts`, `client-uat-nov2026.test.ts`, `admin-custom-roles.test.ts`,
  `role-model.test.ts`, `cross-module-permissions.test.ts`; web `columns-menu.test.tsx`, `accounts.test.tsx`,
  `contract-form-requirements.test.tsx`, `amc-contracts.test.tsx`, `audit-engineer-labels.test.ts`.
- Phases 1–3 changes are as previously reported (engineers, Dashboard rows, S-02 lock, Service Status totals, navigation).

## J. Pending items and verdict

**Pending client clarification:** CR-017 ownership rule (G); the Admin / "Service Dept" naming (F); Q-03 (totals
placement), Q-04 (column order), Q-06 (recording), Q-07, Q-08 (AMC Schedule hide vs remove).

**Before production (owner):** approve migration 0118 and this change set for integration into alpha and release (0118
runs automatically when the API starts); the client's Super Admin or Admin applies the production role grants they want
(e.g. Service Sales View + Edit for AMC Sales) in Roles & Permissions; existing contracts need their Customer PO Values
entered — none were backfilled.

**Verdict:** all approved CRs are implemented and tested locally, except CR-017's ownership rule (pending
clarification). **Production is unchanged** and nothing has been committed, pushed, merged or deployed.
