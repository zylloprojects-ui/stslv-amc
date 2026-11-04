# Dashboard — 12 KPI cards

Branch `feature/dashboard-12-kpis` (from alpha e53e6dd). No migration, no schema change.

The dashboard's seven arrangeable KPI cards are replaced by twelve cards in three
fixed rows of four (the client's meeting reference). They are not clickable. The
order is fixed: Arrange KPIs, Reset KPI Layout and Reset KPI Names are removed.

## The twelve cards

| # | Row | Label | Source (GET /api/dashboard/operations) | Rule |
|---|-----|-------|------|------|
| 1 | AMC Portfolio | Active AMCs | `kpis.contracts.active` | Contracts with status ACTIVE (unchanged) |
| 2 | AMC Portfolio | Annual AMC Value (Ex VAT) | `kpis.contracts.activeValue` | Sum of `contract_value` (AMC Value / Year) of active contracts, as entered (unchanged) |
| 3 | AMC Portfolio | Final Credit (Ex VAT) | `kpis.contracts.finalCreditTotal` | Sum of `final_credit` of active contracts, as entered (unchanged) |
| 4 | AMC Portfolio | Expiring ≤45 Days | `kpis.contracts.expiringSoon` | Active, `valid_to` between today and today + 45 (unchanged) |
| 5 | Current Month | Services This Month | `kpis.services.thisMonth` | Counted visits scheduled this calendar month (unchanged; equals the workload chart's first bar) |
| 6 | Current Month | Services Pending | `kpis.services.openThisMonth` | Of 5, status SCHEDULED / IN_PROGRESS / POSTPONED (unchanged) |
| 7 | Current Month | Invoices Generated | `kpis.payments.scheduledThisMonth.withInvoiceNo` (**new**) | Accounts scope, scheduled this month, manual Invoice No. entered |
| 8 | Current Month | Invoices Not Generated | `kpis.payments.scheduledThisMonth.withoutInvoiceNo` (**new**) | Accounts scope, scheduled this month, no manual Invoice No. |
| 9 | Overall | Services Overall | `kpis.services.overall` (**new**) | Counted visits, any date (earlier years and visits ahead) |
| 10 | Overall | Services Pending | `kpis.services.openOverall` (**new**) | Of 9, SCHEDULED / IN_PROGRESS / POSTPONED |
| 11 | Overall | Invoices Generated | `kpis.payments.paid` | Accounts scope, Invoice No. entered (unchanged; equals Accounts) |
| 12 | Overall | Invoices Not Generated | `kpis.payments.unpaid` | Accounts scope, no Invoice No. (unchanged; equals Accounts) |

- **Counted visits** (`COUNTED_VISIT`): not CANCELLED or HISTORICAL, on a contract that is not CANCELLED.
- **Accounts scope** (`IN_SCOPE`): SCHEDULED, IN_PROGRESS, POSTPONED or COMPLETED; COMPLETED is kept even on a cancelled contract.
- "Invoices Generated" is the approved manual Invoice No. reference status (shown as Paid in Accounts). It does not verify payment, and the card's hover text says so. Zoho invoices (Invoice Tracking) are not read.
- Amounts are `visit_amount` / contract values, OMR excluding VAT, three decimals. No VAT is read or added.
- Contracts in the Recycle Bin (0101) and their services are excluded through the `amc_contracts` / `amc_visits` views.
- "This month" for cards 5–8 is by **scheduled date** (`current_date`). The older "Paid This Month" (`paidThisMonth`, by date the number was entered) is still returned but no longer shown.

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
