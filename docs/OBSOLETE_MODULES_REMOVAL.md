# Removal of Projects, Procurement and AMC Execution (frontend) — 2026-10-27

The revised client-approved AMC system no longer has Projects, Procurement or AMC Execution as standalone modules.
This change removed them from the web application only. **Nothing in the database was changed**, and every API
endpoint was kept because retained modules depend on it.

## Removed (web)

- Sidebar items: AMC Execution, Projects, Procurement (Operations group).
- Routes: `/amc/execution`, `/projects`, `/projects/:id`, `/procurement` (now Not Found).
- Code: `pages/projects/*`, `pages/procurement/*`, `pages/amc/AmcExecutionPage.tsx` and their tests.
- Job numbers in Expenses, Invoice Tracking, the AMC contract invoice list and Historical Data are plain text
  instead of links to the deleted project page.
- The uncommitted attachments addition to `ProcurementDialogs.tsx` was saved as a patch in
  `D:\Projects\STSLV-AMC-backups\2026-10-27-module-removal\` before the file was deleted.

## Kept on purpose

- `pages/amc/ExecutionVisitModal.tsx` (not routed): the start / complete / postpone / cancel form, for reuse by Service Status.
- `lib/projectOptions.ts`, `lib/projectTypes.ts` (now also holding `FixedProject`): used by Expenses and Invoice Tracking.

## API endpoints retained

| Endpoint | Why it stays |
| --- | --- |
| `GET/PATCH /api/amc/execution/visits[/:id]` | The only API that changes a visit's status (start, complete, postpone, cancel). Completion feeds Ready for Invoice; Service Status will need it. |
| `/api/projects` (list, options, defaults, summary, detail, create, edit, status) | Expenses require an open project; Invoice Tracking allocates to projects; Settings reads `/projects/defaults` (VAT); Dashboard uses the project summary. |
| `/api/procurement` | No retained screen uses it, but it is the only read path to existing procurement records and their quotation attachments. Remove only after a decision on that data (and on Quotations). |

One API change: the overdue-visits notification now links to `/amc/schedule` instead of `/amc/execution`.

## Database objects that may become obsolete (left unchanged)

Do not drop any of these without an explicit decision and a backup.

| Object | Source | Still read by |
| --- | --- | --- |
| `procurement_requests` + its 4 indexes | 0021 | `/api/procurement`, attachments (`entity_type = 'procurement_requests'`), legacy import checks |
| `projects` + its 5 indexes | 0020 | Expenses, Invoices (allocations), Dashboard, Notifications, Historical Data, legacy import |
| `number_sequences` (job number) | 0020 | Project creation |
| `app_settings` (default VAT) | 0020 | Settings page, project creation |
| `v_project_financials` | 0023 | Projects service, Dashboard |
| `project_expenses`, `expense_categories` | 0022 | Expenses (Accounts) — **not obsolete** while expenses are recorded against jobs |
| `invoice_allocations.project_id` (project side of allocations) | 0060 | Invoice Tracking |
| Permission modules `AMC_EXECUTION`, `PROJECTS`, `PROCUREMENT` and their role grants; roles `PROCUREMENT`, `EXECUTION` | 0001, 0004 | API authorisation, Roles & Permissions page |
| `amc_visits` execution columns (`completed_date`, `work_performed`, `execution_notes`, `status_reason`) | 0011 | **Not obsolete**: visit completion and invoicing |

## Open questions for the client

1. Without a Projects screen no new job can be created, so Expenses can be recorded only against existing jobs. How are expenses and project invoices handled in the revised system?
2. Until Service Status is built, no screen can mark an AMC visit completed, so no visit can become Ready for Invoice from the UI.
3. Should existing procurement quotations carry into the new Quotations module, or be archived?
4. Should the `EXECUTION` and `PROCUREMENT` roles be retired or re-scoped?
