# Dashboard and AMC Management: separate pages, shared KPI cards — and the "OMR 0.000" invoice amount

Client correction, 2026-11-10. Branch `feature/dashboard-management-split` (from alpha `e44cb2e`). No migration, no
schema change, no data change.

## 1. Separate pages again

Commit `02a665c` (2026-11-09) made `/amc/management` render the Dashboard itself. The client meant something narrower:
only the **KPI cards the two pages have in common** must match. Each page keeps its own content.

| | `/dashboard` | `/amc/management` |
|---|---|---|
| Component | `pages/DashboardPage.tsx` | `pages/amcManagement/AmcManagementPage.tsx` (restored from `02a665c^`) |
| API | `GET /api/dashboard/operations` | `GET /api/amc/management/summary` |
| Permission (route, API, Help topic) | Dashboard: View | AMC Contracts: View (as before `02a665c`) |
| Sidebar | Listed (top-level) | **Not listed** (owner decision 2026-11-10: the approved sidebar of `a438a42` stays as it is). Opened from `/amc/management`, the expiry alerts and bookmarks |
| Own content | 12 cards in 3 fixed rows, AMC Maintenance Calendar, Upcoming Service Workload, Payment Trend (and the hidden detail panels) | 3 KPI groups with Customize / Reset, header actions (Schedule Engine, Invoices, Reports, Alerts, + New AMC), Recent AMC Contracts, Expiry & Renewal (Critical, Not Renewed & Expired, renewal warning, 90/60/45/30/15-day bands, list) |

Nothing on the Dashboard was removed by `02a665c`, so the Dashboard is unchanged apart from the invoice amount line (§ 2).

### Shared cards

| AMC Management id | Dashboard card (id) | Group on AMC Management |
|---|---|---|
| `active` | Active AMCs (`active`) | Contract KPIs |
| `value` | Annual AMC Value (Ex VAT) (`value`) | Contract KPIs |
| `credit` | Final Credit (Ex VAT) (`credit`) | Contract KPIs |
| `expiring` | Expiring ≤45 Days (`expiring`) | Contract KPIs |
| `services` | Services This Month (`month-services`) | Schedule KPIs |
| `paid` | Invoices Generated, Overall (`overall-invoiced`) | Invoice KPIs |
| `unpaid` | Invoices Not Generated, Overall (`overall-not-invoiced`) | Invoice KPIs |

Page-specific on AMC Management: Schedule Pending Billing, Current Scheduled Value, Schedule Engine Status, Paid Invoice
Total, Invoice Module Status. Page-specific on the Dashboard: Services Pending (month and overall), Invoices Generated /
Not Generated of the current month, Services Overall.

How they match:

* **One calculation.** `sharedKpis()` in `stslv-api/src/modules/dashboard/operations.service.ts` returns the `kpis`
  object (contracts, service counts, Invoice No. figures). `getOperationsDashboard` and `getAmcManagementSummary` both
  call it; each passes its own permission rule (`SharedKpiAccess`), so permissions stay page-specific. The summary's
  older fields (`contracts`, `invoices.paid`, `invoices.paidTotal`) are taken from the same object.
* **One definition per card.** AMC Management's shared cards are the Dashboard's `KPIS` entries
  (`pages/dashboard/kpis.ts`, `SHARED_WITH_MANAGEMENT`): label, icon, wording, hint and permission. Their colour is
  the Dashboard column colour (`kpiColumn`). Their name cannot be changed in Customize (the order can), and names
  saved before are ignored for them.
* **One card body.** `KpiFigure` (`pages/dashboard/KpiStrip.tsx`) draws the figure, the OMR unit, the size rule and
  the detail line on the Dashboard cards and in every KPI group (AMC Management, AMC Renewal).

The management ids are kept, so saved card orders keep working. The Oman business date applies to both
(`BUSINESS_TODAY_SQL`), so month boundaries agree.

## 2. "Invoices Generated · OMR 0.000"

**Finding (local alpha, `stslv_amc_local_alpha`, read-only queries).** One service has an Invoice No.: visit 47, contract
13 (DEMO Skyline Business Tower), scheduled 2026-11-04, Completed, Invoice No. `1234`. Its `visit_amount` is **NULL**:
the contract has no default visit amount and no Billing Basis. There is no Zoho record (no `invoice_allocations` row).
The Invoice Acknowledgement record for `1234` has no amount either.

**Authoritative amount.** By the approved finance rules (FINANCE_WORKFLOW.md), the manual Invoice No. carries **no
amount**. Its card money figure is the documented "Value of Paid services": the sum of `visit_amount` (OMR, excluding
VAT) of the services with an Invoice No. Accounts, Master AMC Status and Reports use the same figure. Zoho Invoice
Tracking amounts are separate and do not decide Paid.

**Root cause.** `paymentFigures()` returns `COALESCE(sum(visit_amount), 0)`, and the card printed it. A service whose
value was never recorded therefore showed as a real `OMR 0.000`. Permissions were not involved, nothing was mapped to
the wrong field, and nothing was counted twice.

**Fix.**

* `paymentFigures()` now also returns how many of the counted services have no recorded value: `paidAmountMissing`,
  `unpaidAmountMissing`, `scheduledThisMonth.withInvoiceNoAmountMissing` and `withoutInvoiceNoAmountMissing`. The sums
  are unchanged.
* The cards (`invoiceAmountText`) show:
  * **Amount not recorded · Invoice No. entered** when none of the services has a value;
  * **OMR x · N without amount** when some have none;
  * **OMR 0.000** only for a stored zero, or when there are no services at all.
* Paid Invoice Total (AMC Management) shows *Not recorded* in the same case.
* **Multiple services per Invoice No.** Figures are per service. Each service adds its own value once. No invoice-level
  amount is summed, so a number shared by several services is never counted twice. The count stays the number of
  services, as on Accounts.

No contract value, annual value or Cost per Visit is substituted. No record was changed.

## 3. Tests

* API: `tests/amc-management.test.ts`. The summary's `kpis` equals the Dashboard's. An Invoice No. on a service with no
  value gives `paidAmountMissing 1`. The same number on a second service with a value adds it once, and Accounts
  agrees. Nothing is written to `visit_amount`. `tests/dashboard-operations.test.ts` checks the new counts against SQL.
* Web: `src/test/amc-management.test.tsx` restores the AMC Management page tests (groups, Customize, header actions,
  Recent AMC Contracts, Expiry & Renewal, Hide/Show, permissions). It also checks that each shared card is identical
  on both pages (name, figure, wording, hint, icon colours, accent), for Admin and for a restricted role. It checks
  that each page keeps its own sections, and that the amount shows "Amount not recorded" on both pages.
