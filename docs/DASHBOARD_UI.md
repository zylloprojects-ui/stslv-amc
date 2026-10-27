# STSLV AMC — Dashboard and Shared UI

| | |
|---|---|
| Status | Shell and shared UI implemented on `feature/dashboard-ui`; dashboard connected to the AMC and Projects modules on `develop`, 2026-10-01 |
| Scope | Dashboard, application shell, shared UI components, responsive and accessibility fixes. The dashboard wiring added no migration and no table. |

This document records where each dashboard figure comes from, who may see it, what the shared UI offers to every module, and what is left to do.

## 0. AMC Operations Dashboard (2026-10-27)

The dashboard page (`/dashboard`) is now the **AMC Operations Dashboard**. It added no migration and no table. Functional guidance: reference specification `09-dashboard-kpis-calculations.md` (functional only; no code, records or styling taken).

### 0.1 Endpoints

| Endpoint | Permission | Returns |
|---|---|---|
| `GET /api/dashboard/operations` | `DASHBOARD:VIEW`; each section under its module's permission (below), null otherwise | KPIs, portfolio, expiring, workload, today's work, payment availability |
| `GET /api/dashboard/calendar?month=YYYY-MM` | `DASHBOARD:VIEW` and (`AMC_SCHEDULE:VIEW` or `AMC_EXECUTION:VIEW`) | visit counts per day (total, completed, open, overdue) |
| `GET /api/dashboard/readiness` | `DASHBOARD:VIEW` and the built-in Admin role | individual verified checks, no score |
| `GET /api/dashboard/summary` | unchanged | the module figures shown under "Waiting for an invoice and other figures" |

Reused without change: `GET /api/amc/visits` (a day's services), `GET /api/amc/visits/:id` (service details), `GET /api/invoices` (recent invoices, invoice numbers of a visit), `GET /api/invoices/export` (Excel/PDF, needs `INVOICES:EXPORT`).

Code: `stslv-api/src/modules/dashboard/operations.service.ts`, `readiness.service.ts`; web `stslv-web/src/pages/DashboardPage.tsx` and `pages/dashboard/` (`kpis.ts`, `KpiStrip.tsx`, `MaintenanceCalendar.tsx`, `Widgets.tsx`, `RecentInvoices.tsx`, `dashboardPreferences.ts`).

### 0.2 Calculation rules

"Today" and "this month" are PostgreSQL `current_date`, the same date every module uses; the server time zone is returned and shown on the page (local database: Asia/Calcutta; the business time zone is still an open decision).

| KPI / widget | Permission | Rule |
|---|---|---|
| Active AMC | `AMC_CONTRACTS:VIEW` | contracts with status `ACTIVE` (past-validity ones stated beside it) |
| Active AMC Value | `AMC_CONTRACTS:VIEW` | `sum(contract_value)` of active contracts, numeric(16,3). **Not annualised**; labelled so. |
| Total Final Credit | `AMC_CONTRACTS:VIEW` | `sum(final_credit)` of active contracts as entered, with how many have a figure. Meaning unconfirmed (Q1); never called revenue or collected. |
| Services This Month | `AMC_SCHEDULE:VIEW` or `AMC_EXECUTION:VIEW` | visits planned this calendar month, not cancelled, not historical, on a contract that is not cancelled. Same rule as the workload report, so it equals the first workload bar. |
| Unpaid Invoices, Paid This Month, Payment Trend | `INVOICES:VIEW` | **Not available.** Invoices are `ISSUED`/`CANCELLED` only (0060); there is no paid date or paid amount. Nothing is derived from an invoice number or invoice date. |
| Expiring ≤45 Days | `AMC_CONTRACTS:VIEW` | active contracts with `valid_to` from today to today + 45, both ends included, each contract counted once; contracts with a renewal that is not cancelled are stated beside it (needs 0072, otherwise null) |
| Expiring Contracts (widget) | `AMC_CONTRACTS:VIEW` | active contracts with `valid_to` ≤ today + 90 (past-validity ones first, flagged), first 10 with the total; renewal link when 0072 is applied |
| AMC Portfolio Status | `AMC_CONTRACTS:VIEW` | count per status for all four statuses; percentage to one decimal, rounded half up with integer arithmetic; null when there are no contracts |
| Upcoming Service Workload | schedule or execution view | `getWorkload` of the AMC reports, 6 months from this month |
| Today / Next 7 days | schedule or execution view | counted visits planned today; open visits planned in the next 7 days; first 10 of each with totals; no amounts |
| Service details | `AMC_SCHEDULE:VIEW` (amount); invoice no. needs `INVOICES:VIEW` | the stored visit; "AMC reference" is the contract record number (STSLV has no contract number); payment status "Not tracked" |
| Production Readiness | built-in Admin | API, database, pending migrations (files vs `schema_migrations`), backup (not recorded by STSLV: shown as not available), CORS origins, sign-in limits, failed sign-ins in 24 h |

Nothing on the dashboard changes a contract or visit status.

### 0.3 Preferences

KPI order, calendar open/closed and hidden Recent Invoices columns are kept in this browser's `localStorage`, per signed-in user (`stslev.dashboard.*.<userId>`), like the other display preferences. They do not follow the user to another browser; no table was added. "Reset KPI Layout" restores the default order.

### 0.4 Demo data

`stslv-api/src/scripts/seed-dashboard-demo.ts` creates clearly fictional records ("DEMO –" clients, "DEMO-INV-" invoice) through the normal services. Without `--insert-demo` it writes nothing; it does nothing if the demo clients already exist. It has only been run on `stslv_amc_dev_projects`, schema `stslv_dashboard_demo`. Do not run it on `stslv_amc_dev` without approval.

### 0.5 Open points

Payment tracking (paid date, paid amount) does not exist; currency label (OMR) not confirmed, so amounts carry none; Final Credit meaning (Q1); business time zone; whether contracts with an open renewal should leave the expiry KPI; no Security Center or Backup & Restore module exists (the readiness panel links to Login History and Audit Log instead).

The sections below describe the earlier module-figure cards, which remain on the page under "Waiting for an invoice and other figures" (Active Contracts moved to the KPI strip; the Projects cards and links were removed with the Projects pages).

## 1. Dashboard

### 1.1 What it shows

Every figure is read from `GET /api/dashboard/summary`. The dashboard module calculates nothing about AMC or projects itself: `dashboard.service.ts` returns the Clients count next to the AMC module's own summary (`getAmcSummary`) and the Projects module's own summary (`getProjectSummary`), unchanged.

| Group | Metric | Field | Meaning, as defined by the owning module |
|---|---|---|---|
| Clients | Active Clients | `clients.active` (`clients.inactive`) | Clients marked active. |
| AMC | Active Contracts | `amc.contracts.active` (`activePastValidity`) | Contracts with status `ACTIVE`, including those whose validity has ended. |
| AMC | Visits Due | `amc.visits.due` (`overdue`) | Scheduled, in-progress or postponed visits, planned today or earlier, on a contract that is not cancelled. |
| AMC | Ready for Invoice | `amc.invoicing.readyForInvoice.count` (`amountRequired.count`) | `v_amc_visit_billing`: completed visits with an amount above zero. |
| Projects | Active Projects | `projects.counts.active` (`new`, `inProgress`) | Projects that are `NEW` or `IN_PROGRESS`. |
| Projects | Projects Ready for Invoice | `projects.counts.readyForInvoice` | `v_project_financials`: completed projects with a job value above zero. |
| Finance | Tracked Expenses | `projects.costs.trackedExpenses` (`trackedExpensesOnCancelledProjects`) | Expenses recorded here and not voided, cancelled projects left out. |
| Finance | Invoices Recorded | `invoices.issued.count` (`issued.amountExclVat`, `cancelled.count`) | Active invoices recorded in Invoice Tracking; cancelled invoices are not counted. |
| Finance | Ready-for-Invoice Value | `amc.invoicing.readyForInvoice.amount` and `projects.values.readyForInvoiceValue` | Two separate amounts. See section 1.4. |

No operational figure is hard-coded anywhere in the web application. A card shows a number only when the API returned it.

### 1.2 How a metric is declared

All metrics are declared in one list, `stslv-web/src/pages/dashboard/metrics.ts`. Each has:

- `visible`: whether the user's role includes the figure. It mirrors the API's check so that the right cards show while loading.
- `read`: turns the summary into display text, or returns `null` when the API left the figure out. The card is then not shown at all: never a zero, never a placeholder.

A metric without `read` has no data source and is shown as "Not yet available". No metric is in that state today; it remains for figures whose module is not built yet.

To add a figure: have the owning module report it, return it from `dashboard.service.ts` under that module's permission, extend `DashboardSummary` in `metrics.ts`, and add the metric.

### 1.3 Permissions

The API is the authority. A section the user may not see is returned as `null`.

| Figure | Permission |
|---|---|
| Any dashboard figure | `DASHBOARD:VIEW` |
| Active Clients | `CLIENTS:VIEW` |
| Active Contracts | `AMC_CONTRACTS:VIEW` |
| Visits Due | `AMC_SCHEDULE:VIEW` or `AMC_EXECUTION:VIEW` |
| AMC Ready for Invoice, and its amount | `AMC_SCHEDULE:VIEW` |
| Active Projects, Projects Ready for Invoice, and its value | `PROJECTS:VIEW` |
| Tracked Expenses | `PROJECTS:VIEW` and `EXPENSES:VIEW` |

| Invoices Recorded | `INVOICES:VIEW` |

These are the checks the AMC, Projects and Invoice Tracking modules already make on their own summaries. `INVOICES:VIEW` opens only the invoice figures: the AMC and project figures inside the invoice summary still need `AMC_SCHEDULE:VIEW` and `PROJECTS:VIEW`. The matrix itself is still provisional (open question Q12).

### 1.4 Rules for money figures

- Amounts travel as three-decimal strings and are formatted as text by `formatMoney` in `lib/money.ts`. They never pass through a JavaScript number.
- **Ready-for-Invoice Value is two amounts, never one total.** The AMC amount is the sum of the visit amounts as entered: the AMC module has no VAT basis for them. The project amount is the sum of job values, which exclude VAT. Adding them would assume they are on the same basis, which the client has not confirmed. The card labels them "AMC — As entered" and "Projects — Excl. VAT".
- "Tracked Expenses" means expenses recorded in STSLV AMC. It must not be labelled as cost, profit or margin (open question Q10).

### 1.5 Points that are still open

| Metric | Open point |
|---|---|
| Ready for Invoice (AMC and Projects) | Invoiced work leaves these figures once its invoice is recorded in Invoice Tracking. A partly invoiced project is not in the project count; it is stated beside it ("N more partly invoiced"). The invoicing rules are provisional (`docs/INVOICE_MODULE.md`). |
| Ready-for-Invoice Value | VAT basis of AMC visit amounts (Q11). Until it is confirmed the two amounts stay separate. |
| Projects Ready for Invoice | Invoicing before completion (Q21). |

## 2. Shared UI available to every module

All in `stslv-web/src/components/`.

| Item | Use |
|---|---|
| `PageHeader` | Page title, description and actions. It also sets the browser tab title, so a page that uses it needs nothing more. |
| `TableScroll` + `TABLE` | Wrap every data table in `<TableScroll label="…">`. A wide table then scrolls inside its card instead of widening the page, and the scroll area can be reached with the keyboard. `TABLE.text` is for name and free-text cells, `TABLE.unbroken` for emails and references. |
| `Modal`, `ConfirmDialog` | Dialogs. The title and the footer buttons stay in view and long content scrolls between them. Focus is trapped, Escape closes the top dialog only, and the page behind does not scroll. |
| `Alert` | Messages. Pass `onDismiss` for a success message that would otherwise stay on screen. |
| `TextField`, `TextAreaField` | Form fields with label, hint, error and the matching accessibility attributes. |
| `Spinner`, `EmptyState`, `Badge`, `StatusBadge`, `Card`, `Button` | Loading, empty and status presentation. |
| `usePageTitle`, `useDialogBehavior` (`hooks.ts`) | For a page without a `PageHeader`, and for anything else that opens over the page. |

A grid or flex child that contains a table needs `min-w-0` (or a `minmax(0, 1fr)` column). Without it the table widens the whole page on a phone; this was the cause of the one page-level overflow found in the foundation (Roles & Permissions).

## 3. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | Passes |
| `npm test` | 61 tests in 5 files on `feature/dashboard-ui` (36 foundation tests kept, 25 added). The dashboard wiring is covered by `stslv-web/src/test/dashboard.test.tsx` and `stslv-api/tests/dashboard.test.ts`. |
| `npm run lint` | Passes |
| `npm run build` | Passes |
| Browser check | Login, Dashboard, Clients, Users & Access, Roles & Permissions, Settings, Account, placeholder, not-found and access-denied pages, with their dialogs, at 1440, 820 and 375 pixels wide. No page scrolls sideways at any of the three widths. |

The browser check ran against a stand-in API with invented records, outside the repository. The development database was not read or written. `docs/FOUNDATION.md` section 7 still gives the foundation's test count (36); it was left unchanged to avoid a conflict with the other branches and should be updated when the branches are merged.

## 4. Work remaining

1. Move the AMC and Projects tables to `TableScroll`, and check their pages at phone and tablet width.
2. Add the "pending invoices" list that `PHASE1_SYSTEM_DESIGN.md` 16.3 asks to be the most prominent item on the dashboard. The list itself now exists on the Invoice Tracking page ("Waiting for an invoice"); the ready-for-invoice cards link to it.
3. Update the test count in `docs/FOUNDATION.md` section 7.
