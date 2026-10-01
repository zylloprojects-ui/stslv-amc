# STSLV AMC — Projects, Procurement and Project Expenses

| | |
|---|---|
| Status | Implemented on branch `feature/projects` (2026-10-01). Not yet merged into `develop`. |
| Scope | Projects / jobs, procurement against a job, expenses against a job, and the derived job figures. **No invoice records, no reports, no Excel import.** |
| Migrations | `0020` to `0023` (reserved range `0020`–`0029`). |

This document records what was built and, above all, **which rules are provisional**. Nothing below has been confirmed by the client unless it says so. Question numbers (Q6, Q7 …) refer to `PHASE1_SYSTEM_DESIGN.md` section 19.

## 1. The connected flow

```
Client (Client Master)
   └── Project / Job            job number, value, VAT, budget, status
          ├── Procurement       requirement → quotation → order → delivery
          ├── Expenses          the only source of tracked job cost
          └── Completed ──► Ready for invoice   (derived; no invoice record yet)
```

## 2. Database

| Migration | Creates |
|---|---|
| `0020_projects.sql` | `app_settings`, `number_sequences`, `projects` |
| `0021_procurement_requests.sql` | `procurement_requests` |
| `0022_project_expenses.sql` | `expense_categories`, `project_expenses` |
| `0023_project_financials_view.sql` | view `v_project_financials` |

- Money is `numeric(14,3)`. No floating-point column exists. The API accepts and returns money and rates as **decimal strings** (`"1250.500"`); it never converts them to a JavaScript number. All arithmetic is done by PostgreSQL.
- `projects.vat_amount` and `projects.grand_value` are **generated columns**: `round(job_value × vat_rate / 100, 3)` and `job_value + vat_amount`. They cannot be written directly and cannot disagree with their inputs.
- Nothing derived is stored. `v_project_financials` is the single definition of tracked expenses, Operational Job Margin, budget remaining and invoice state.
- Projects, procurement requests and expenses are never deleted: a project or request is cancelled, an expense is voided (with who and why).
- `app_settings`, `number_sequences` and `expense_categories` are configuration and have no foreign keys.

## 3. Provisional rules

| Rule as built | Why it is provisional |
|---|---|
| **Job number** = prefix + zero-padded counter from `number_sequences` (seeded `GPSA`, width 4, next number **1**). | Q6. The pattern follows the legacy register, which is historical evidence only — it contains a duplicate and a gap. The client has not approved a numbering rule. **The seeded starting number is a placeholder: set `next_number` to the real next job number before live use.** |
| **VAT**: default rate 5.000% from `app_settings` (`projects.default_vat_rate`), copied to each project; a project may have a different rate (for example 0). Amount rounded half-up to 3 decimals. | Q11. 5% is what the legacy data shows. The rounding rule, exempt jobs and whether the amount may be overridden are unconfirmed. |
| **Project status**: `NEW`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`. `NEW → IN_PROGRESS → COMPLETED`; `NEW → COMPLETED` is allowed; `NEW`/`IN_PROGRESS → CANCELLED`; a completed project can be reopened to `IN_PROGRESS`, a cancelled one to `NEW`. | Q7. |
| **Procurement status**: `REQUESTED`, `QUOTED`, `ORDERED`, `DELIVERED`, `CANCELLED`, in any order. No approval step. | Q8, Q12. |
| **Supplier / payee is free text.** | Q16: a supplier master is not approved. |
| **One procurement request holds one quotation.** | Q17. |
| **Expense categories**: Materials, Transport, Inspection, Labour, Supplier payment, Bills, Other. | The requirement gives these as examples. |
| **Expense amount is stored as entered.** | Q11: inclusive or exclusive of VAT is unconfirmed. |
| **One expense = one amount on one job.** The same payment reference may appear on several jobs; nothing checks what those rows add up to. | Q9: no split-payment rule exists. |
| **Operational Job Margin = job value excluding VAT − tracked expenses.** | Q10. It is **not** accounting profit and is never labelled as such. It counts only expenses recorded here. The legacy "Profit" column is not reproduced. |
| Recorded costs, margin and budget remaining are returned only to users who hold `EXPENSES:VIEW`. | Q12: whether procurement and execution users may see costs is open. This is the cautious reading. |
| Nothing new can be recorded against a `CANCELLED` project. Expenses **can** be recorded against a `COMPLETED` project. | Cancellation rules are unconfirmed. |

### Changing the job number rule

`src/modules/projects/job-number.ts` is the only code that issues a job number. To change prefix, width or the next number, update the row:

```sql
UPDATE number_sequences SET prefix = 'GPSA', pad_length = 4, next_number = 812
WHERE sequence_key = 'job_number';
```

The generator locks that row inside the transaction that inserts the project, so two projects cannot receive the same number and a failed insert does not use one up. A number already held by a project is skipped, never reused. `projects.job_number` has a `UNIQUE` constraint as the final safeguard. There is no screen for this setting yet.

## 4. Ready for invoice

`invoice_state` is derived by `v_project_financials`:

| State | Meaning |
|---|---|
| `NOT_READY` | `NEW` or `IN_PROGRESS` |
| `READY_FOR_INVOICE` | `COMPLETED` with a job value above zero |
| `NO_INVOICE_REQUIRED` | `COMPLETED` with a job value of **zero** — nothing to bill, so it never waits for an invoice |
| `NOT_APPLICABLE` | `CANCELLED` |

No invoice table, column or route exists. The Invoice Tracking module takes over from here:

1. Create `invoices` and its link table to `projects(id)` in its own migration range.
2. `CREATE OR REPLACE VIEW v_project_financials` so that a project whose value is fully invoiced leaves `READY_FOR_INVOICE` (add states such as `INVOICED`; keep the existing column names).
3. Add the new states to `INVOICE_STATES` in `projects.schemas.ts` and `InvoiceState` in the web `projectTypes.ts`.
4. Decide whether a completed project with invoices may still be reopened (today it may).

## 5. API

All routes need a signed-in user. Responses use the standard `{ success, data }` / `{ success, error }` shape.

| Route | Permission | Notes |
|---|---|---|
| `GET /api/projects` | `PROJECTS:VIEW` | `search`, `status`, `invoiceState`, `clientId`, `page`, `pageSize` |
| `GET /api/projects/options` | any of `PROJECTS:VIEW`, `PROCUREMENT:VIEW`, `EXPENSES:VIEW` | Picker list; no financial data |
| `GET /api/projects/defaults` | `PROJECTS:CREATE` | Default VAT rate and a preview of the next job number (nothing is reserved) |
| `GET /api/projects/summary` | `PROJECTS:VIEW` | Dashboard / reporting contract, below |
| `GET /api/projects/:id` | `PROJECTS:VIEW` | |
| `POST /api/projects` | `PROJECTS:CREATE` | Job number, VAT amount and grand value are never accepted from the caller |
| `PATCH /api/projects/:id` | `PROJECTS:EDIT` | Not while cancelled |
| `POST /api/projects/:id/status` | `PROJECTS:EDIT` | `{ status, completedDate? }` |
| `GET /api/procurement` | `PROCUREMENT:VIEW` | `search`, `status`, `projectId`, paging |
| `GET /api/procurement/:id` | `PROCUREMENT:VIEW` | |
| `POST /api/procurement` | `PROCUREMENT:CREATE` | |
| `PATCH /api/procurement/:id` | `PROCUREMENT:EDIT` | The project cannot be changed |
| `POST /api/procurement/:id/status` | `PROCUREMENT:EDIT` | `{ status, deliveredDate? }` |
| `GET /api/expenses` | `EXPENSES:VIEW` | `search`, `projectId`, `categoryId`, `dateFrom`, `dateTo`, `includeVoided`, paging. Returns `totalAmount` for the whole filtered set |
| `GET /api/expenses/categories` | `EXPENSES:VIEW` | |
| `GET /api/expenses/:id` | `EXPENSES:VIEW` | |
| `POST /api/expenses` | `EXPENSES:CREATE` | |
| `PATCH /api/expenses/:id` | `EXPENSES:EDIT` | May move the expense to another job |
| `POST /api/expenses/:id/void` | `EXPENSES:DELETE` | `{ reason }`. Expenses are never hard-deleted |

The seeded permission matrix was not changed. With it: Admin can do everything; Accountant records and edits expenses and views projects and procurement; Procurement creates and edits procurement and views projects and expenses; Execution and Invoicing view projects (Execution also procurement) without costs. Only Admin can create or edit projects, change project status or void an expense until an Admin grants those permissions in Users & Access.

### Dashboard / reporting contract — `GET /api/projects/summary`

```json
{
  "counts": {
    "total": 5, "active": 2, "new": 1, "inProgress": 1,
    "completed": 2, "cancelled": 1,
    "readyForInvoice": 1, "noInvoiceRequired": 1
  },
  "values": {
    "totalJobValue": "3500.500",
    "totalGrandValue": "3675.525",
    "readyForInvoiceValue": "2000.000"
  },
  "costs": {
    "trackedExpenses": "350.125",
    "operationalJobMargin": "3150.375",
    "trackedExpensesOnCancelledProjects": "40.000"
  }
}
```

- `active` = `NEW` + `IN_PROGRESS`.
- Value and cost totals leave cancelled projects out; what was spent on cancelled projects is reported separately.
- `totalJobValue` excludes VAT; `totalGrandValue` includes it.
- `costs` is `null` for a user without `EXPENSES:VIEW`.
- The same function, `getProjectSummary(auth)` in `projects.service.ts`, can be called from the dashboard module instead of over HTTP.

The dashboard calls `getProjectSummary(auth)` from `GET /api/dashboard/summary` and shows these figures (see `DASHBOARD_UI.md` section 1).

## 6. Web application

| Address | Page |
|---|---|
| `/projects` | List with search, status and invoicing filters; create and edit |
| `/projects/:id` | Job details, financial summary, status actions, the job's procurement and expenses |
| `/procurement` | List with search, project and status filters; create, view, edit, status |
| `/expenses` | List with search, project, category and date filters, a total for the filtered set; record, view, edit, void |

`/procurement?projectId=…` and `/expenses?projectId=…` open already filtered to one job.

Every figure shown is the one returned by the API. The only arithmetic in the browser is the VAT preview on the project form while typing; it uses exact integer arithmetic and is labelled as a preview.

## 7. Known gaps

- **No attachments.** Quotation, LPO and receipt files are not stored: the attachment infrastructure does not exist yet (Q14).
- **No screen for settings.** The default VAT rate, the job number sequence and the expense categories are changed in the database.
- **No link between an expense and the procurement request it pays for.** It can be added as a nullable column.
- **No holding list for payments whose job is not yet known** (part of Q9). An expense cannot be saved without a job.
- **No Excel import.** Legacy jobs are not loaded.

## 8. Notes for integration

- `feature/projects` and `feature/amc` both edit `stslv-api/src/app.ts`, `stslv-api/tests/database.test.ts` (the expected table list) and `stslv-web/src/App.tsx`. Each conflict is resolved by keeping both sides' additions.
- The migration runner refuses a migration numbered below the last one applied. A database that has applied `0020`–`0023` will therefore refuse `0010`–`0019` afterwards. Apply the migrations to a shared database only once both ranges are present in the checkout.
- `app_settings` is created by `0020`. Another branch that needs a setting should add a row, not create the table again.

## 9. Tests

| Command | Covers |
|---|---|
| `cd stslv-api && npm test` | Project CRUD and validation, job-number uniqueness (including concurrent creation), three-decimal precision, VAT, status workflow, ready for invoice, zero-value completion, procurement and expense relationships, expense totals, Operational Job Margin, voiding, permissions, database constraints |
| `cd stslv-web && npm test` | Money formatting and VAT preview; list, create, edit, status and permission workflows for the three pages and the project page |
