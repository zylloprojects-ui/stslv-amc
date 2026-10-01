# STSLV AMC — AMC Contracts, Schedule and Execution

| | |
|---|---|
| Status | Implemented on branch `feature/amc` (2026-10-01). Not yet merged to `develop`. |
| Scope | AMC contracts, generated visit schedule, execution, and the derived "ready for invoice" state. **No invoice records exist**; that is the Invoice module's work. |
| Migrations | `0010_amc_contracts.sql`, `0011_amc_visits.sql` (reserved range 0010–0019) |

The connected flow:

```
Client (Client Master)
   └── AMC contract            amc_contracts
          └── visits           amc_visits        one dated row per maintenance period
                 ├── execution                   status, completion date, work notes (same row)
                 └── invoice eligibility         derived by v_amc_visit_billing, never stored
```

Rules marked **PROVISIONAL** are working choices that depend on an unconfirmed client rule (see section 9).

## 1. Tables

### `amc_contracts`

| Column | Type | Notes |
|---|---|---|
| `client_id` | bigint, FK → `clients` | The Client Master is the only source of client data. No client name or code is stored here. |
| `responsible_engineer` | text, nullable | A name, as in the legacy sheet. Not a link to a user (Q20 unresolved). |
| `valid_from`, `valid_to` | date | `valid_to >= valid_from`. |
| `system_description` | text | Free text ("FIRE", "CCTV"). No lookup table (Q15 unresolved); the form suggests values already in use. |
| `description`, `notes` | text, nullable | |
| `contract_value` | numeric(14,3) | Required, ≥ 0. |
| `final_credit` | numeric(14,3), nullable | **Neutral.** Stored as entered. Used in no calculation, total, validation or report (Q1 unresolved). |
| `maintenance_frequency` | text | `MONTHLY`, `QUARTERLY`, `HALF_YEARLY`, `ANNUALLY`. |
| `default_visit_amount` | numeric(14,3), nullable | Starting amount for generated visits. |
| `status` | text | `DRAFT`, `ACTIVE`, `EXPIRED`, `CANCELLED`. |

There is no contract number and no billing-frequency column: neither is confirmed.

### `amc_visits`

One row per scheduled visit. Execution is not a separate table: it is the status, completion and notes of the visit.

| Column | Notes |
|---|---|
| `amc_contract_id` | FK → `amc_contracts`. |
| `sequence_no` | Running number within the contract. Unique per contract. |
| `period_start`, `period_end` | The maintenance period the visit covers. `(amc_contract_id, period_start)` is unique: the database guard against duplicate generation. |
| `original_scheduled_date`, `scheduled_date` | The generated date, and the current planned date. |
| `assigned_to` | Nullable. Null means "the contract's responsible engineer". |
| `status` | `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `POSTPONED`, `CANCELLED`. |
| `visit_amount` | numeric(14,3), nullable. Null = not set yet. Zero is a real value. |
| `amount_is_custom` | True once a user has set the amount by hand. |
| `completed_date`, `completed_by` | Set exactly when the status is `COMPLETED` (check constraint). |
| `work_performed`, `execution_notes`, `status_reason`, `notes` | Text. |

### `v_amc_visit_billing` (view)

The single definition of invoice eligibility. See section 5.

Money is `numeric(14,3)` everywhere. It travels through the API as text (`"405.000"`) and is never converted to a floating-point number in the API or the web application; totals are summed by PostgreSQL.

## 2. Contracts

- Created as `DRAFT` (no schedule) or `ACTIVE` (schedule generated in the same transaction).
- A contract can only be given a client that exists and is active.
- Status changes are made by a user, never automatically. A contract whose validity has ended is flagged (`isPastValidity`) but stays `ACTIVE` until someone changes it — whether contracts expire by themselves is unconfirmed.
- Allowed transitions: `DRAFT → ACTIVE | CANCELLED`, `ACTIVE → EXPIRED | CANCELLED`, `EXPIRED → ACTIVE`, `CANCELLED → ACTIVE`.
- Marking a contract `EXPIRED` or `CANCELLED` leaves its visits alone unless the user ticks "also cancel the scheduled and postponed visits". Completed and in-progress visits are never changed by a contract status change.
- The validity period and frequency can be edited only while the contract is `DRAFT` or `ACTIVE`.
- Contract value is **not** required to equal the sum of the visit amounts. The contract shows both and the difference, for information only.
- A technical safety limit of 10 years applies to the validity period, so a mistyped year cannot generate thousands of visits. It is not a business rule.

## 3. Schedule generation

Generated when a contract becomes `ACTIVE`, and re-synchronised when the validity or frequency of an active contract is edited.

- Interval: monthly 1, quarterly 3, half-yearly 6, annually 12 months.
- Every period start is counted from `valid_from` (31 Jan → 28 Feb → 31 Mar; no drift).
- A period is created only if it starts on or before `valid_to`. **Nothing is scheduled after the validity ends.**
- The last period ends on `valid_to`, even if that makes it short. **PROVISIONAL:** a short final period still gets a visit.
- **PROVISIONAL:** the scheduled date is the first day of the period.
- Each visit's amount starts as the contract's default visit amount (or empty if there is none).

### Safe regeneration

A visit is **locked** once anyone has acted on it: any status other than `SCHEDULED`, a changed date, a hand-set amount, an assignment, or any note. Everything else is **untouched**.

1. A locked visit is never changed or removed.
2. An untouched visit is kept if it matches a period exactly; otherwise it is removed (it carries nothing beyond what generation produces).
3. A period gets a new visit unless a kept visit already starts inside it — so a period where work was recorded, or whose visit was cancelled, is never scheduled twice.
4. If a locked visit (other than a cancelled one) would fall outside the new validity, the change is refused with a message naming the visits.
5. `valid_from` cannot be moved once any visit has been worked on, because every period is counted from it.

Changing the **default visit amount** does not change existing visits; it applies to visits generated afterwards.

The contract row is locked for the whole operation, the removal re-checks "still untouched" in SQL, and the unique constraint on `(contract, period_start)` is the last guard. Every regeneration is written to `activity_logs` with the periods added and removed. The web form shows a preview (added / removed / kept) and asks for confirmation before saving such a change.

## 4. Execution

- Any status can follow any other, with two exceptions: leaving `COMPLETED` (reopening) requires `AMC_EXECUTION:APPROVE`; and a completion date is required to complete.
- Completing records the completion date (not in the future) and the user who completed it.
- Postponing keeps the visit on the list of outstanding work; a new planned date and a reason can be recorded. The original date is kept.
- A cancelled visit can be restored to `SCHEDULED`.
- "Overdue" is derived (scheduled or postponed, planned date before today); it is not a stored status.
- The execution work list leaves out the outstanding visits of a `CANCELLED` contract.
- The execution endpoints return no amounts and no invoicing state.

## 5. Ready for invoice

Invoice eligibility is **derived** by the view `v_amc_visit_billing` from the visit's status and amount. It is not a column and cannot disagree with the visit.

| `invoice_eligibility` | When |
|---|---|
| `NOT_COMPLETED` | The visit's status is not `COMPLETED`. |
| `READY_FOR_INVOICE` | Completed, and the visit amount is above zero. |
| `NO_INVOICE_REQUIRED` | Completed, and the visit amount is exactly zero. |
| `AMOUNT_REQUIRED` | Completed, and no amount has been set. |

Consequences:

- Completing a visit with an amount makes it ready for invoice at once. No separate "release" step exists (none is confirmed).
- Reopening a completed visit returns it to `NOT_COMPLETED`.
- The amount used is the visit's own amount, including any override.

### Zero-value and missing amounts

- **Zero-value visits** (for example a contract billed 500 / 0 / 500 / 0) become `NO_INVOICE_REQUIRED` when completed. They never appear in the ready-for-invoice list and never wait for an invoice.
- **Visits with no amount** become `AMOUNT_REQUIRED` when completed. They are kept visible as a separate group so they are not lost; entering an amount moves them to `READY_FOR_INVOICE` (or to `NO_INVOICE_REQUIRED` if the amount is zero).

## 6. Permissions

Uses the existing role-permission tables. Nothing was added to the seeded matrix.

| Action | Permission |
|---|---|
| List / view contracts, systems, schedule preview | `AMC_CONTRACTS:VIEW` |
| Create contract | `AMC_CONTRACTS:CREATE` |
| Edit contract, change status, generate schedule | `AMC_CONTRACTS:EDIT` |
| Cancel a contract | `AMC_CONTRACTS:EDIT` **and** `AMC_CONTRACTS:DELETE` |
| List / view schedule (with amounts and eligibility) | `AMC_SCHEDULE:VIEW` |
| Edit a visit's amount, date, assignment, notes | `AMC_SCHEDULE:EDIT` |
| Execution work list | `AMC_EXECUTION:VIEW` |
| Update execution status and notes | `AMC_EXECUTION:EDIT` |
| Reopen a completed visit | `AMC_EXECUTION:EDIT` **and** `AMC_EXECUTION:APPROVE` |
| AMC summary | Any of the three `VIEW` permissions; each section is filled only if permitted |

With the seeded (provisional) matrix, only Admin can create or edit contracts and edit visit amounts; Execution can update execution; Accountant and Invoicing can view. An Admin changes this in Users & Access.

## 7. API

All under `/api/amc`, all authenticated. Responses use the standard `{ success, data }` / `{ success, error }` shape.

| Method and path | Purpose |
|---|---|
| `GET /contracts` | List. `search`, `status`, `clientId`, `frequency`, `page`, `pageSize`. |
| `GET /contracts/systems` | Distinct system descriptions in use. |
| `GET /contracts/:id` | One contract with its schedule figures. |
| `POST /contracts` | Create (`status`: `DRAFT` or `ACTIVE`). |
| `PATCH /contracts/:id` | Update. Returns `scheduleChange` when the schedule was re-synchronised. |
| `POST /contracts/:id/status` | `{ status, cancelOpenVisits?, reason? }`. |
| `GET /contracts/:id/schedule/preview` | What generation would add, remove and keep; optional `validFrom`, `validTo`, `maintenanceFrequency`. Changes nothing. |
| `POST /contracts/:id/schedule/generate` | Add missing visits to an active contract. Safe to repeat. |
| `GET /visits` | Schedule. `from`, `to` (scheduled date), `clientId`, `contractId`, `status` (comma list), `system`, `invoiceEligibility`, `overdue`, `search`, paging. Returns `totals.visitAmount`. |
| `GET /visits/:id` | One visit with amount and eligibility. |
| `PATCH /visits/:id` | `{ visitAmount?, scheduledDate?, assignedTo?, notes? }`. |
| `GET /execution/visits` | Work list. `scope` = `due` \| `upcoming` \| `open` \| `completed` \| `all`, `days`, `clientId`, `search`, paging. |
| `GET /execution/visits/:id` | One visit, no amounts. |
| `PATCH /execution/visits/:id` | `{ status?, completedDate?, scheduledDate?, workPerformed?, executionNotes?, statusReason? }`. |
| `GET /summary` | Figures for the dashboard and reports. `upcomingDays` (default 30). |

## 8. Handoffs

### Invoice module

- A visit is invoiceable when `v_amc_visit_billing.invoice_eligibility = 'READY_FOR_INVOICE'`.
- The list to work from: `GET /api/amc/visits?invoiceEligibility=READY_FOR_INVOICE` (client, contract, period, completion date, `visitAmount`; `totals.visitAmount` is the sum).
- To add the invoiced state, the Invoice module replaces the view in its own migration (`CREATE OR REPLACE VIEW v_amc_visit_billing`), adding `INVOICED` for visits with an active allocation, and adds `INVOICED` to `INVOICE_ELIGIBILITIES` in `stslv-api/src/modules/amc/amc.constants.ts` and `stslv-web/src/pages/amc/types.ts`. Every AMC list, filter and summary reads the view, so nothing else changes.
- `invoice_allocations.amc_visit_id` should reference `amc_visits(id)`.
- Still to be decided by the Invoice module: once a visit is invoiced, its amount should no longer be editable and it should not be reopened. Today both are allowed because no invoice exists.
- An allocation rule of `allocated_amount > 0` is compatible with this design: zero-value visits never need an allocation.

### Dashboard and reports

`GET /api/amc/summary` returns real counts computed at request time. A section is `null` when the user may not see it.

| Dashboard figure | Field |
|---|---|
| Active AMC Contracts | `contracts.active` (and `activePastValidity`, `draft`, `expired`, `cancelled`) |
| Visits Due | `visits.due` (outstanding, planned today or earlier); `visits.overdue` |
| Upcoming Visits | `visits.upcoming` within `visits.upcomingDays`; `visits.dueThisMonth` |
| Completed Visits | `visits.completedThisMonth`, `visits.completedTotal` |
| Ready for Invoice | `invoicing.readyForInvoice.count` and `.amount` |
| Needing attention | `invoicing.amountRequired.count`; `invoicing.noInvoiceRequired.count` |

"Outstanding" means scheduled, in progress or postponed, on a contract that is not cancelled — the same definition as the execution work list.

The web pages invalidate the `['dashboard']` query after every AMC change, so a dashboard reading this endpoint under that key refreshes by itself. `DashboardPage` was not modified.

## 9. Unconfirmed rules and how they are contained

| Question | What the module does now |
|---|---|
| Q1 Final Credit meaning | Stored, shown, used in nothing. |
| Q2 Frequency list | Four month-based options in one constant and one check constraint. |
| Q3 Billing vs maintenance frequency | No billing frequency. Per-visit amounts (including zero) cover uneven billing. |
| Q4 Position of the visit in its period, short final period, rescheduling limits | First day of period; short final period gets a visit; a visit may be moved to any date; a reason is optional. |
| Q4 Renewal | A renewal is a new contract, or an extension of `valid_to` (which adds visits). No automatic roll-over. |
| Contract expiry | Never automatic. |
| Cancelling a contract | Visits are cancelled only on explicit request. |
| Reopening completed visits | Allowed with `AMC_EXECUTION:APPROVE` (Admin only in the seeded matrix). |
| Q13 Site execution fields | Status, completion date, work performed, execution notes only. |
| Q15 Several systems per contract | One system text per contract. |
| Q20 Engineers as users | Engineer and assignee are names; visits are not filtered per user. |
| E3 VAT on AMC values | No VAT handling; amounts are stored as entered. |

## 10. Not included

Invoices and invoice allocations, schedule export/download, Excel import, attachments on contracts or visits, and a screen for the activity log.

## 11. Tests

| Command | AMC coverage |
|---|---|
| `cd stslv-api && npm test` | 136 AMC tests: schedule arithmetic, contracts, validation, three-decimal money, frequencies, date boundaries, safe regeneration, amount overrides, execution statuses, completion, ready-for-invoice, zero-value visits, summary, permissions, database constraints. |
| `cd stslv-web && npm test` | 47 AMC tests: the three pages, forms, validation, schedule-change confirmation, status changes, execution updates, permissions. |

The dev database (`public` schema) does not yet have migrations 0010 and 0011. They are applied with `npm run migrate` after `feature/amc` is integrated, in number order with the other branches' migrations.
