# STSLV AMC — Dashboard and Shared UI

| | |
|---|---|
| Status | Implemented on `feature/dashboard-ui`, 2026-10-01 |
| Scope | Dashboard presentation, application shell, shared UI components, responsive and accessibility fixes. Frontend only: no migration, no table, no API contract was added or changed. |

This document records how the dashboard is built to receive real figures, what the shared UI offers to every module, and what is left to do once the AMC and Projects branches are merged.

## 1. Dashboard

### 1.1 What it shows today

| Group | Metric | State |
|---|---|---|
| Clients | Active Clients | **Real.** Read from `GET /api/dashboard/summary` (`clients.active`, `clients.inactive`). |
| AMC | Active Contracts | Not yet available |
| AMC | Visits Due | Not yet available |
| AMC | Ready for Invoice | Not yet available |
| Projects | Active Projects | Not yet available |
| Projects | Projects Ready for Invoice | Not yet available |
| Finance | Tracked Expenses | Not yet available |
| Finance | Ready-for-Invoice Value | Not yet available |

A metric that is not connected shows a dash, the label "Not yet available" and the module the figure will come from. It never shows a number. No operational figure is hard-coded anywhere in the web application, and a test proves that extra values sent by the API do not appear until a metric is deliberately connected.

### 1.2 How a metric is connected

All metrics are declared in one list, `stslv-web/src/pages/dashboard/metrics.ts`. A metric is "not yet available" for exactly one reason: it has no `read` function.

To connect one, after the module that owns the figure is merged:

1. **API.** Add the figure to `GET /api/dashboard/summary`, computed by a query over the module's tables (see `PHASE1_SYSTEM_DESIGN.md` section 16). Return it only to users who hold `VIEW` on the module (section 1.3).
2. **Type.** Extend `DashboardSummary` in `metrics.ts` to match what the API really returns.
3. **Metric.** Give the metric a `read` function that turns the summary into display text.

Nothing else changes: the card, the loading and failure states, the permission filter and the layout already handle a connected metric. The Active Clients metric is the working example.

The names of the new summary fields are **not** decided here. They belong to the session that writes the query, so that the dashboard conforms to the API and not the other way round.

### 1.3 Permissions

A user sees a metric only if they hold `VIEW` on the module it belongs to, in the same way the navigation hides modules. The ready-for-invoice metrics are tied to `INVOICES`, the module that acts on them. This mapping is provisional, like the rest of the permission matrix (open question Q12).

Hiding a card is a convenience. **When a figure is added to the API it must be protected there too**: today the summary route checks only `DASHBOARD:VIEW`, which is enough for a client count but not for contract, project or money figures.

### 1.4 Rules for money figures

Tracked Expenses and Ready-for-Invoice Value are amounts of money. When they are connected:

- The API must send them as decimal strings, as it does everywhere else. A metric's `read` returns text, so an amount never has to pass through a JavaScript number.
- A shared formatter for decimal strings does not exist yet. It should be written once, with tests, and used by the dashboard and by the Projects and Expenses screens. It must not use `parseFloat` or `Number`.
- The number of decimal places and the currency label must follow what the Projects and Expenses modules use.
- "Tracked Expenses" means expenses recorded in STSLV AMC. It must not be labelled as cost, profit or margin (open question Q10).

### 1.5 Definitions that are still open

These need the owning module and, in some cases, the client:

| Metric | Open point |
|---|---|
| Visits Due | Due in which period: this month, the next N days, or overdue as well? `PHASE1_SYSTEM_DESIGN.md` 16.1 lists them as separate metrics. The card can show the period in its detail line. |
| Ready for Invoice (AMC) | Depends on Invoice Tracking: "completed with no active invoice allocation". Until invoices exist, the honest figure is "completed visits", which is a different thing and should be labelled as such or left unavailable. |
| Projects Ready for Invoice | Same dependency, plus open question Q21 (invoicing before completion). |
| Ready-for-Invoice Value | Needs both of the above and open question Q11 (VAT inclusive or exclusive). |

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
| `npm test` | 61 tests in 5 files (36 foundation tests kept, 25 added) |
| `npm run lint` | Passes |
| `npm run build` | Passes |
| Browser check | Login, Dashboard, Clients, Users & Access, Roles & Permissions, Settings, Account, placeholder, not-found and access-denied pages, with their dialogs, at 1440, 820 and 375 pixels wide. No page scrolls sideways at any of the three widths. |

The browser check ran against a stand-in API with invented records, outside the repository. The development database was not read or written. `docs/FOUNDATION.md` section 7 still gives the foundation's test count (36); it was left unchanged to avoid a conflict with the other branches and should be updated when the branches are merged.

## 4. Work remaining after the AMC and Projects branches are merged

1. Merge `develop` into this branch and resolve `src/App.tsx` (the list of placeholder routes shrinks as modules arrive) and any shared component both sides touched.
2. Connect the dashboard metrics, one at a time, following section 1.2, and settle the definitions in section 1.5.
3. Add per-module permission checks to `GET /api/dashboard/summary` (section 1.3) with API tests.
4. Write the shared decimal-string formatter (section 1.4).
5. Move the new modules' tables to `TableScroll`, and check their pages at phone and tablet width.
6. Add the "pending invoices" list that `PHASE1_SYSTEM_DESIGN.md` 16.3 asks to be the most prominent item on the dashboard. It needs Invoice Tracking.
7. Update the test count in `docs/FOUNDATION.md` section 7.
