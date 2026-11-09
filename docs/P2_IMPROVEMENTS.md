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

- `ROLE_LIST_ENABLED = true`: Settings › Organization › **Role list** is shown, to Users & Access viewers only. Custom roles are added, renamed, deactivated and deleted there; permissions are set in Roles & Permissions, which marks custom roles "Custom" and links back.
- The API refuses a built-in role code for a custom role (409), even if that built-in row were missing.

**Who manages roles (approved 2026-11-09, recovery follow-up).** Super Admin **and Admin** manage custom roles and assign them to users. Enforced in the API (`roles.service.ts`: `canManageRoles`, `manageReason`; `roles.routes.ts`: `roleAdministrators`, replacing `superAdminOnly`):

| | Super Admin | Admin (needs Users & Access **Edit**) | Any other role |
|---|---|---|---|
| Add a custom role | Yes | Yes | No (403) |
| Rename, deactivate, reactivate, delete a custom role | Yes | Only if Admin holds **every** permission of that role | No |
| Change a custom role's permissions | Yes | Only within Admin's own permissions, as above | No |
| Give a role Users & Access permissions | Yes | **No** (403); removing them is allowed | No |
| Change a built-in role or its permissions | Yes (never Super Admin's permissions) | **No** (403) | No |
| Assign a custom role to a user | Yes | Only if Admin holds all its permissions (unchanged) | Per USERS:EDIT, same limit |
| Assign Super Admin or Admin | Yes | **No** (unchanged) | No |

- **No privilege escalation:** nobody grants, revokes or assigns a permission they do not hold; Admin never changes its own role (409) or its own role's permissions (built-in); a custom role never takes a built-in code or an existing name (409); Super Admin and Admin accounts stay with Super Admin.
- **Configurable:** Super Admin removing USERS:EDIT from Admin removes role management from Admin at the next request (`canManageRoles: false`).
- `GET /api/roles` tells the page what the viewer may do: `canManageRoles`, and per role `manageable` / `manageReason` beside `permissionsEditable` / `lockedReason`. The Role list and the permission matrix show only those actions; the matrix also keeps Users & Access boxes disabled for Admin unless the role already has them.
- **For owner confirmation:** "Admin cannot give a role Users & Access" is a conservative safeguard added with this change (Admin could otherwise create further user-administering roles). Lifting it is a one-line change in `setRolePermissions`.

Tested: `tests/admin-custom-roles.test.ts` (Admin's full lifecycle with audit entries; assignment and the holder's exact access; built-in roles refused; beyond-authority roles refused; Users & Access refused; no promotion; other roles with USERS:EDIT refused; removing USERS:EDIT from Admin), `tests/custom-roles.test.ts`, `tests/role-model.test.ts`; web: `role-list.test.tsx`, `role-model.test.tsx`.

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

- **Master AMC Status**: new column **Zoho Invoices (Tracking)** after Invoice No.: the Zoho invoice numbers recorded in Invoice Tracking for each service (cancelled ones left out), as on Accounts. Then a separate column **Zoho References (Tracking)**: each of those invoices' Zoho reference (Invoice Tracking "Zoho reference", `invoices.source_reference`), one entry per invoice in the same order, `—` for an invoice recorded without one, empty when none has one. Both are hidden together with Invoice No. Notes say they do not decide Paid or Unpaid and explain the `—`. The page's API data carries `invoiceReferences` beside `invoiceNumbers`. Formatting, permissions (MASTER_AMC_STATUS View + Export) and the audit entry are unchanged. Tested in `tests/p2-zoho-references.test.ts` and `tests/amc-master-status.test.ts`.
- **Recent Invoices** (Dashboard): the export sends `columns=` with the visible columns; `GET /api/invoices/export` then writes a one-sheet "Recent Invoices" file with exactly those columns in the table's order. The Total row appears when Total is visible; its Excel formula excludes cancelled invoices when Status is visible too. Unknown or empty column lists answer 400. Without `columns`, the full Invoice Tracking Report is unchanged. Permission (INVOICES View + Export) unchanged; the audit entry records the columns.

## 6. Related corrections

- **Renewal required fields**: reviewed, no change. The approved rule (an active Sales Engineer on every renewal; no document and no Final Credit) is enforced in the API and the form.
- **Contract Recycle Bin dependencies**: new read-only `GET /api/amc/contracts/:id/usage` (AMC_CONTRACTS:DELETE and Super Admin, like the move). The Move to Recycle Bin dialog now shows what is kept (services by status, Paid services, invoices, documents, the contract it renews) and, when a renewal of it exists, names it and disables the move. No new rule: the blocker is the existing one, and the API still refuses the move.

## Deferred (not implemented)

Per-user column permissions, partial invoicing, new Accounts permissions, Move to Draft, Archive, CSV export, removed legacy modules, Dashboard redesign, frequency changes.
