# Dashboard — 12 KPI cards

> **2026-11-09:** this Dashboard is the one shared Dashboard, shown on both `/dashboard` and `/amc/management`
> (client requirement: the two must be identical). See STS_ELV_CLIENT_FIXES_20261109.md § 13.

Branch `feature/dashboard-12-kpis` (from alpha e53e6dd). No migration, no schema change.

The dashboard's seven arrangeable KPI cards are replaced by twelve cards in three
fixed rows of four (the client's meeting reference). They are not clickable. The
order is fixed: Arrange KPIs, Reset KPI Layout and Reset KPI Names are removed.

## The twelve cards

| # | Row | Label | Source (GET /api/dashboard/operations) | Rule |
|---|-----|-------|------|------|
| 1 | AMC Portfolio | Active AMCs | `kpis.contracts.active` | **Each contract once (2026-11-09):** status ACTIVE, Valid To today or later (Oman), and not a renewal whose predecessor is still counted. `activePastValidity` and `activeAwaitingPredecessor` say what is left out |
| 2 | AMC Portfolio | Annual AMC Value (Ex VAT) | `kpis.contracts.activeValue` | Sum of `contract_value` (AMC Value / Year) of the contracts counted in card 1, as entered |
| 3 | AMC Portfolio | Final Credit (Ex VAT) | `kpis.contracts.finalCreditTotal` | Sum of `final_credit` of the contracts counted in card 1, as entered (none invented when missing) |
| 4 | AMC Portfolio | Expiring ≤45 Days | `kpis.contracts.expiringSoon` | Active, `valid_to` between today and today + 45 (unchanged) |
| 5 | Current Month | Services This Month | `kpis.services.thisMonth` | Counted visits scheduled this calendar month (unchanged; equals the workload chart's first bar) |
| 6 | Current Month | Services Pending | `kpis.services.openThisMonth` | Of 5, status SCHEDULED / IN_PROGRESS / POSTPONED (unchanged) |
| 7 | Current Month | Invoices Generated | `kpis.payments.scheduledThisMonth.withInvoiceNo` (**new**) | Accounts scope, scheduled this month, manual Invoice No. entered |
| 8 | Current Month | Invoices Not Generated | `kpis.payments.scheduledThisMonth.withoutInvoiceNo` (**new**) | Accounts scope, scheduled this month, no manual Invoice No. |
| 9 | Overall | Services Overall | `kpis.services.overall` (**new**) | Counted visits, any date (earlier years and visits ahead) |
| 10 | Overall | Services Pending | `kpis.services.openOverall` (**new**) | Of 9, SCHEDULED / IN_PROGRESS / POSTPONED |
| 11 | Overall | Invoices Generated | `kpis.payments.paid` | Accounts scope, Invoice No. entered (unchanged; equals Accounts) |
| 12 | Overall | Invoices Not Generated | `kpis.payments.unpaid` | Accounts scope, no Invoice No. (unchanged; equals Accounts) |

- **One scope for every card** (P1 fixes, 2026-11-09; `amc/service-scope.ts`): SCHEDULED, IN_PROGRESS, POSTPONED or COMPLETED, and on a CANCELLED contract only COMPLETED or Paid (manual Invoice No.) services. `COUNTED_VISIT` (cards 5, 6, 9, 10, workload chart) and `IN_SCOPE` (cards 7, 8, 11, 12, Service Status, Accounts, Master AMC Status, Service Sales) are now the same rule. Before this, completed services of cancelled contracts were in cards 11 and 12 but not in 9.
- **Reconciliation** (tested in `tests/p1-fixes.test.ts`): card 9 = card 11 + card 12 = Service Status total = Accounts rows = Master AMC Status rows; card 5 = card 7 + card 8 = workload first bar; Completed = card 9 − card 10.
- "Invoices Generated" is the approved manual Invoice No. reference status (shown as Paid in Accounts). It does not verify payment, and the card's hover text says so. Zoho invoices (Invoice Tracking) are not read.
- Amounts are `visit_amount` / contract values, OMR excluding VAT, three decimals. No VAT is read or added.
- Contracts in the Recycle Bin (0101) and their services are excluded through the `amc_contracts` / `amc_visits` views.
- "This month" for cards 5–8 is by **scheduled date** in the Oman calendar month (business date, Asia/Muscat). The older "Paid This Month" (`paidThisMonth`, by date the number was entered) is still returned but no longer shown.

## API changes (additive, backward-compatible)

`GET /api/dashboard/operations`:

- `kpis.services` gains `overall` and `openOverall`. The section is still null without AMC_SCHEDULE:VIEW or AMC_EXECUTION:VIEW.
- `kpis.payments` gains `scheduledThisMonth: { withInvoiceNo, withInvoiceNoValue, withoutInvoiceNo, withoutInvoiceNoValue }`. It is still null without INVOICES:VIEW.
- `paymentFigures()` is shared with AMC Management (`management.service.ts`), which reads only the existing fields.

## Preferences

The old `stslev.dashboard.kpi-order.<user>` and `stslev.dashboard.kpis.kpi-names.<user>` browser entries are no longer read and are not deleted. The calendar open/closed choice is kept.

## Integrating into alpha

1. `git diff alpha...feature/dashboard-12-kpis --stat`: check the changed files against what alpha changed since e53e6dd, especially `operations.service.ts`, `DashboardPage.tsx`, `dashboard/kpis.ts`, `KpiStrip.tsx` and `test/dashboard.test.tsx`.
2. Merge with `--no-ff` on a local integration branch first. Then run the API typecheck and tests on an isolated `DB_NAME`, and the web typecheck, lint, tests and build.
3. Browser-check `/dashboard` at 390, 768, 1366 and 1920 px.
