# STSLEV AMC — Invoice Tracking Module

| | |
|---|---|
| Status | Implemented and tested. **Migration `0060_invoices` has not been applied to `stslv_amc_dev`.** |
| Migration | `0060_invoices` (additive) |
| Scope | Recording invoices raised in Zoho against completed AMC visits and projects; the invoiced states; the work list of what is waiting for an invoice; cancellation. **No Zoho integration, no payment tracking, no import of historical invoice references.** |

Invoices are raised in Zoho. This module records what the Zoho invoice says and which completed work it covers. It calculates nothing from a rate: the amount excluding VAT and the VAT amount are both typed from the invoice.

## 1. Provisional business rules

Every rule below was chosen so the module could be built. **None is confirmed by the client.** Each sits in one place, so changing it is a small change.

| # | Rule | Where it lives | Open question |
|---|---|---|---|
| 1 | An invoice records two figures from the Zoho invoice: amount excluding VAT, and VAT amount. The total is their sum. | `invoices` columns | Q11 |
| 2 | An AMC visit is **invoiced** once any active invoice covers it. The visit amount is not compared with the invoiced amount, because whether visit amounts include VAT is not confirmed. | `v_amc_visit_billing` | Q5, E3 |
| 3 | A project is **partly invoiced** while the amounts allocated to it are below its job value, and **invoiced** once they reach it. Both sides exclude VAT. | `v_project_financials` | Q21 |
| 4 | An invoice can only be recorded against **completed** work. | `lockAndCheckTargets` in `invoices.service.ts` | Q21 |
| 5 | Every visit and project on an invoice belongs to the invoice's client. | same | E9 |
| 6 | Work covered by an active invoice is locked (section 5). | `invoice-locks.ts` | — |
| 7 | Cancelling an invoice needs `INVOICES:EDIT` and a reason. Invoices are never deleted. | `invoices.routes.ts`, `cancelInvoice` | Q12 |
| 8 | Payment is not tracked. An invoice is `ISSUED` or `CANCELLED`. | `invoices_status_ck` | Q22 |

Also provisional:

- A visit or a project **may be covered by more than one invoice**, and one invoice may cover several visits and projects. The client's job register shows both for projects; nothing is known for visits (Q5).
- The amounts allocated to a project **may exceed its job value**. No rule forbids it; the project is then simply `INVOICED`.
- The invoice number is free text of up to 50 characters. The Zoho number format is not confirmed (E11).
- One active record per invoice number, letter case ignored. A cancelled record does not block its number.

## 2. Data model

### `invoices`

One row per Zoho invoice.

| Column | Notes |
|---|---|
| `invoice_number` | As on the Zoho invoice. Unique among invoices that are not cancelled (`invoices_invoice_number_uq`, on `lower(invoice_number)`). |
| `client_id` | The client the invoice was issued to. |
| `invoice_date` | A calendar day. Required; never defaulted. |
| `amount_excl_vat` | `numeric(14,3)`, above zero. |
| `vat_amount` | `numeric(14,3)`, zero or more. Required; never calculated. |
| `total_amount` | Generated: `amount_excl_vat + vat_amount`. |
| `status` | `ISSUED` or `CANCELLED`. |
| `source` | `ZOHO`. |
| `source_reference` | Optional further reference from Zoho. |
| `cancelled_at`, `cancelled_by`, `cancellation_reason` | Set exactly when the invoice is cancelled (`invoices_cancellation_ck`). |
| `created_by` | Required. |

### `invoice_allocations`

Which visit or project an invoice covers, and for how much of its amount excluding VAT.

- Exactly one of `amc_visit_id` and `project_id` is set (`invoice_allocations_target_ck`). Both are real foreign keys, so invoiced work cannot be deleted.
- `allocated_amount` is above zero.
- An invoice names a visit or a project once.

### Reconciliation

**The allocations of an invoice add up to its amount excluding VAT, to the third decimal.**

- The API checks it before writing; PostgreSQL does the arithmetic (`assertReconciles`).
- Two deferred constraint triggers (`check_invoice_allocation_total`) check it again when the transaction commits, so no path — not even direct SQL — can leave an invoice that does not reconcile. The error carries the constraint name `invoice_allocations_total_ck`.

The VAT amount is never part of an allocation.

### Views

`CREATE OR REPLACE`, existing columns unchanged, new columns added at the end.

`v_amc_visit_billing` — adds `invoiced_amount` and one eligibility:

| `invoice_eligibility` | When |
|---|---|
| `INVOICED` | Completed, and at least one active invoice covers the visit. |

`v_project_financials` — adds `invoiced_value`, `uninvoiced_value` and two states:

| `invoice_state` | When |
|---|---|
| `PARTLY_INVOICED` | Completed; active invoices allocate less than the job value. |
| `INVOICED` | Completed; active invoices allocate the job value or more. |

`uninvoiced_value` is the job value not yet covered, never below zero. It is null for a historical or a cancelled project: for neither is it an amount to invoice.

A cancelled invoice counts in neither view. Every AMC and Projects list, filter and summary reads these views, so invoiced work leaves the "ready for invoice" figures without any other change.

## 3. Historical invoice references

The invoice numbers in the client's earlier registers **are not invoices** and are not imported: the registers give no invoice date and no amount. They stay in `legacy_import_rows.invoice_reference` and are shown under Historical Data. This migration creates no invoice row.

Historical visits and projects cannot be put on an invoice. Reconciling the historical references needs a Zoho export (number, date, customer, amounts) and is a separate, later step.

## 4. Workflow

```
Completed visit / project
   └── Ready for invoice            derived; listed under "Waiting for an invoice"
          └── Invoice raised in Zoho
                 └── Recorded here  number, date, amount excl. VAT, VAT, what it covers
                        └── Invoiced (visit) / Partly invoiced or Invoiced (project)
                               └── Cancelled, with a reason → the work is ready for invoice again
```

Editing an invoice may change its details and replace its allocations as a whole; every rule of a new invoice is checked again. A cancelled invoice cannot be edited or brought back; it is entered again if it was cancelled by mistake.

## 5. Locking

While an **active** invoice covers it:

| Record | Refused (409) | Still allowed |
|---|---|---|
| AMC visit | Changing the visit amount. Any status change away from `COMPLETED` (reopening), with or without `AMC_EXECUTION:APPROVE`. | Notes, assignment, work performed, execution notes, completion date. |
| Project | Reopening (`COMPLETED → IN_PROGRESS`). Changing the client. | Other edits, including the job value: the invoice state follows it. |
| AMC contract | Changing the client, while any of its visits is invoiced. | Everything else. |

The lock lifts when the invoice is cancelled, or when the work is taken off the invoice by editing it. Work covered by two invoices stays locked until neither is active.

The AMC and Projects services make the check inside the transaction that holds the row lock, and recording an invoice locks the same rows first, so an invoice cannot be recorded on work that is being reopened at the same moment.

## 6. Permissions

Uses the existing `INVOICES` module. Nothing was added to the seeded matrix.

| Action | Permission |
|---|---|
| List and view invoices, summary, work waiting for an invoice | `INVOICES:VIEW` |
| Visit amounts in the work list and summary | also `AMC_SCHEDULE:VIEW` |
| Job values in the work list and summary | also `PROJECTS:VIEW` |
| Record an invoice | `INVOICES:CREATE` |
| Edit an invoice | `INVOICES:EDIT` |
| Cancel an invoice | `INVOICES:EDIT` |

With the seeded (provisional) matrix: Admin and Invoicing can record, edit and cancel; Accountant can view.

## 7. API

All under `/api/invoices`, all authenticated. Money travels as text with three decimals.

| Method and path | Purpose |
|---|---|
| `GET /` | List. `search` (invoice number, client, Zoho reference, job number), `status`, `clientId`, `projectId`, `amcVisitId`, `dateFrom`, `dateTo`, paging. Returns `totals` over every match; cancelled invoices are never counted. |
| `GET /summary` | Figures for the dashboard. `amc` and `projects` are null without their view permission. |
| `GET /billable` | Completed work waiting for an invoice. `clientId`; `includeInvoiced=true` (needs `clientId`) also lists that client's invoiced work. |
| `GET /:id` | One invoice with its allocations. |
| `POST /` | `{ invoiceNumber, clientId, invoiceDate, amountExclVat, vatAmount, sourceReference?, notes?, allocations: [{ amcVisitId \| projectId, amount }] }`. |
| `PATCH /:id` | Any of the fields above. `allocations`, when sent, replaces them all. |
| `POST /:id/cancel` | `{ reason }`. |

`GET /api/projects/:id` and the project list also return `invoicedValue` and `uninvoicedValue`. `GET /api/dashboard/summary` returns `invoices` (the invoice summary) to users with `INVOICES:VIEW`.

AMC and project amounts are never added together: whether visit amounts include VAT is not confirmed.

## 8. Audit

Each write is logged to `activity_logs` in the same transaction, module `INVOICES`, entity `invoices`:

| Action | Metadata |
|---|---|
| `invoice.created` | Number, date, amounts, allocations. |
| `invoice.updated` | `changes`: each field from/to, and the allocations from/to when they changed. |
| `invoice.cancelled` | Reason, number, amounts, allocations. |

## 9. Web

- **Invoice Tracking** (`/invoices`): "Waiting for an invoice" (visits and projects, each with its own pending figure) and "Invoices recorded" (search, status and date filters, total excluding VAT).
- **Record / Edit Invoice**: the details as typed from the Zoho invoice; the client's completed work with a tick and an amount each; a running check that the allocations equal the amount excluding VAT. No date, amount or VAT is pre-filled. The part of a project's job value not yet invoiced is offered as its allocation; no amount is offered for a visit.
- **Project page**: invoiced and not-yet-invoiced figures, and the project's invoices.
- **AMC schedule**: the `Invoiced` state and filter; a visit's details name its invoices.
- **Dashboard**: "Invoices Recorded"; partly invoiced projects stated beside "Projects Ready for Invoice".

## 10. Not included

Zoho API integration; payment status; reconciliation or import of historical invoice references; invoice export; a release-for-invoicing step; attachments.

## 11. Tests

| Command | Covers |
|---|---|
| `cd stslv-api && npm test` | `invoices.test.ts`: recording, three-decimal precision, exact reconciliation (API and database), validation, duplicate numbers, work that cannot be invoiced, listing and filters, the work list, editing, cancellation, permissions, summary, database constraints. `invoice-locks.test.ts`: every lock, lifting by cancellation and by editing, two invoices on one visit, concurrent reopen. |
| `cd stslv-web && npm test` | `invoices.test.tsx`: the page, recording, validation, API errors, editing, cancelling, permissions, the project page. |

The API tests must be run against the isolated test database (`DB_NAME=stslv_amc_dev_projects`).
