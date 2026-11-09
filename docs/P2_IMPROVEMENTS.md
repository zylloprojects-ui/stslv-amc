# P2 approved improvements (2026-11-09)

Branch `feature/stslv-p2-improvements`, worktree `D:\Projects\STSLV-AMC-p2-improvements`, based on c6d8d19 (the common base of the P0, P1 and P3 sessions). Local only: not pushed, merged or deployed. **No migration.** No new finance rule.

## 1. Reports permission isolation

A report needs **REPORTS:VIEW and View of its source module**; its export needs **REPORTS:EXPORT and Export of its source module** as well. Enforced in the API (`reports.service.ts`: `canViewReport`, `canExportReport`, `assertReportAccess`); the page only mirrors it.

| Source module | Reports |
|---|---|
| AMC_CONTRACTS | AMC Contract Summary, Contract Value Review |
| AMC_RENEWAL | AMC Renewal, Expiry & Renewal Due, Renewal History |
| ACCOUNTS | Billing Schedule, Completed Services, Pending Services, Monthly Maintenance, Accounts / Paid and Unpaid Summary, Client-wise Summary, Sales Engineer-wise Summary |

Every report showing values, Invoice No., Paid / Unpaid or Zoho invoice numbers per service is owned by Accounts, the page that shows exactly those columns over the same visits.

- `GET /api/reports` lists only the reports the user may open, each with `canExport`.
- `GET /api/reports/options` (client and engineer names) is refused when no report is open to the user.
- A refused report or export answers 403 with no figures and writes no audit entry.
- Super Admin holds every permission and keeps every report and export.
- The page opens the first report offered (no longer a fixed one) and says "No reports available" when there is none.

Verified for all six roles (`tests/reports-permissions.test.ts`): without REPORTS every role is refused; with REPORTS granted each role sees exactly the reports of the modules it views and exports exactly where it holds Export.

## 2. Custom roles

The API already existed (Super Admin only; grant only what you hold; scope and dependency checks; versioned saves). Completed:

- `ROLE_LIST_ENABLED = true`: Settings › Organization › **Role list** is shown, to Users & Access viewers only. Super Admin adds, renames, deactivates and deletes custom roles there; permissions are set in Roles & Permissions, which marks custom roles "Custom" and links back.
- The API refuses a built-in role code for a custom role (409), even if that built-in row were missing.

Unchanged and tested (`tests/custom-roles.test.ts`): only Super Admin creates or changes roles and permissions; nobody grants beyond what they hold; Admin may assign a custom role only while holding all of its permissions; nobody changes their own role (409); built-in roles are never deleted and only Super Admin renames or deactivates them; Super Admin's permissions are fixed; a role held by someone cannot be deactivated or deleted; a holder signs in with exactly the role's permissions and a change applies on the next request.

Per-user column-level access was **not** added (deferred).

## 3. Monthly Calendar

- Month view has a **By service / By contract** switch (kept in the address as `group=contract`). By service is the original grid, unchanged. By contract consolidates the same `GET /amc/visits` result (same filters, no new query) into one entry per AMC contract: reference (link), client, system, engineer, state in words (Open, Partly completed, All completed, Overdue, Cancelled), each service with its date and status (opens the visit), and Services / Paid / Unpaid counts plus counts per status. Only counts are derived in the browser; no amount is summed there. One column on phones, two areas from large screens up.
- Year view: **Unpaid is blue** (#1479BD) like the Month view's Paid green / Unpaid blue; it was amber. The "Services in year" tile moved to navy so it is not confused with Unpaid.

## 4. First Service colour

One definition for both modules (`amc.schedule.ts`: `FIRST_SERVICE_VALID`, `FIRST_SERVICE_SQL`): a contract's first service is its **earliest valid visit by scheduled date**; cancelled and historical visits are never first and never block another visit; ties go to the lower sequence number, then id.

- AMC Contracts (First Service date) already used the earliest non-cancelled date; it now reads the shared definition.
- AMC Schedule (First Service colour) used the lowest sequence number and let an earlier **cancelled** visit block it. Now aligned: cancelling, postponing or re-dating a visit moves "first" to the earliest valid visit.
- The five-level order is unchanged: Manual → Cancelled → Invoice Pending → First Service → Normal.

Tested with cancelled, postponed and re-dated visits (`tests/first-service-priority.test.ts`).

## 5. Exports

- **Master AMC Status**: new column **Zoho Invoices (Tracking)** after Invoice No.: the Zoho invoice numbers recorded in Invoice Tracking for each service (cancelled ones left out), as on Accounts. Hidden together with Invoice No. A note says they do not decide Paid or Unpaid. Formatting, permissions (MASTER_AMC_STATUS View + Export) and the audit entry are unchanged.
- **Recent Invoices** (Dashboard): the export sends `columns=` with the visible columns; `GET /api/invoices/export` then writes a one-sheet "Recent Invoices" file with exactly those columns in the table's order. The Total row appears when Total is visible; its Excel formula excludes cancelled invoices when Status is visible too. Unknown or empty column lists answer 400. Without `columns`, the full Invoice Tracking Report is unchanged. Permission (INVOICES View + Export) unchanged; the audit entry records the columns.

## 6. Related corrections

- **Renewal required fields**: reviewed, no change. The approved rule (an active Sales Engineer on every renewal; no document and no Final Credit) is enforced in the API and the form.
- **Contract Recycle Bin dependencies**: new read-only `GET /api/amc/contracts/:id/usage` (AMC_CONTRACTS:DELETE and Super Admin, like the move). The Move to Recycle Bin dialog now shows what is kept (services by status, Paid services, invoices, documents, the contract it renews) and, when a renewal of it exists, names it and disables the move. No new rule: the blocker is the existing one, and the API still refuses the move.

## Deferred (not implemented)

Per-user column permissions, partial invoicing, new Accounts permissions, Move to Draft, Archive, CSV export, removed legacy modules, Dashboard redesign, frequency changes.
