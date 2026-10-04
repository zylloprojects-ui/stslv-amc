# STSLV AMC — Dashboard and Shared UI

| | |
|---|---|
| Status | Shell and shared UI implemented on `feature/dashboard-ui`; dashboard connected to the AMC and Projects modules on `develop`, 2026-10-01 |
| Scope | Dashboard, application shell, shared UI components, responsive and accessibility fixes. The dashboard wiring added no migration and no table. |

This document records where each dashboard figure comes from, who may see it, what the shared UI offers to every module, and what is left to do.

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

These are the checks the AMC and Projects modules already make on their own summaries. No figure is tied to `INVOICES`: that permission will gate the invoice figures when Invoice Tracking exists. The matrix itself is still provisional (open question Q12).

### 1.4 Rules for money figures

- Amounts travel as three-decimal strings and are formatted as text by `formatMoney` in `lib/money.ts`. They never pass through a JavaScript number.
- **Ready-for-Invoice Value is two amounts, never one total.** The AMC amount is the sum of the visit amounts as entered: the AMC module has no VAT basis for them. The project amount is the sum of job values, which exclude VAT. Adding them would assume they are on the same basis, which the client has not confirmed. The card labels them "AMC — As entered" and "Projects — Excl. VAT".
- "Tracked Expenses" means expenses recorded in STSLV AMC. It must not be labelled as cost, profit or margin (open question Q10).

### 1.5 Points that are still open

| Metric | Open point |
|---|---|
| Ready for Invoice (AMC and Projects) | No invoice records exist yet, so completed work stays "ready for invoice". When Invoice Tracking replaces the two views, invoiced work leaves these figures without any change to the dashboard. |
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
2. Add the "pending invoices" list that `PHASE1_SYSTEM_DESIGN.md` 16.3 asks to be the most prominent item on the dashboard. It needs Invoice Tracking.
3. Update the test count in `docs/FOUNDATION.md` section 7.
