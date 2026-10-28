# Accounts

Route: `/finance/accounts` (navigation: Finance → Accounts).
API: `GET /api/accounts`, `GET /api/accounts/options`, `GET /api/accounts/export` (all read-only).
Status: built 2026-10-28 on branch `feature/accounts-reconciliation`. No migration of its own; needs migration 0077.

Accounts is a read-only **billing reconciliation** with one row per scheduled maintenance visit
(`amc_visits`), never one per contract. It shows, for each visit, whether the service is completed,
its service report number and the invoice numbers recorded against it. It reads the same records
as Service Status, Master AMC Status and Invoice Tracking. Nothing on the page writes.

## Sources of truth (nothing is copied)

| Shown | Source |
|---|---|
| Visit, scheduled date, visit value | `amc_visits` (as AMC Schedule) |
| Service Status | `serviceStatusSql` — the Service Status page's own rule |
| Service Report No. | `amc_visits.service_report_no` (migration 0077), entered on Service Status |
| Invoice No. | `invoices` + `invoice_allocations` (migration 0060), recorded in Invoice Tracking. Every active invoice of the visit, oldest first; cancelled invoices are ignored |
| Paid / Unpaid | **Not available.** Payment is not recorded anywhere in STSLV AMC (`invoices.status` is `ISSUED` or `CANCELLED`) |
| Scope | Same as Service Status / Master AMC Status: no cancelled or historical visits, no open work of a cancelled contract |

## Row colours (three, separate from Master AMC Status)

| Colour | Rule |
|---|---|
| **Red** | Service not completed (Service Status "Not Completed" or "Waiting for Renewal"). |
| **Blue** | Completed, no active invoice recorded. |
| **Green** | Completed, at least one active invoice recorded. |

Green means an invoice was **recorded**, not that it was **paid**. Quotation numbers play no part here
(they do on Master AMC Status, which keeps its own four colours).

## KPI cards

Calculated by the API over exactly the rows the applied filters select (all pages), in one query
shared with the rows and the export.

| Card | Formula |
|---|---|
| Rows | number of selected rows |
| Completed | rows whose visit is `COMPLETED` |
| Not Completed | Rows − Completed (includes Waiting for Renewal) |
| Invoice No. Filled | rows with at least one active invoice |
| Total Visit Value | `sum(amc_visits.visit_amount)` in the database (3 decimals); rows without a value add nothing and their number is shown |

Cards can be renamed and reordered (**Customize**, **Reset KPI Names**, **Reset KPI Order**), using the
same hook as AMC Management (`useKpiCustomization`, stored per user in this browser under
`stslev.accounts.kpis.*`). A renamed card still shows the same figure.

**"Ex VAT" is not claimed.** Whether `visit_amount` includes VAT is unconfirmed (MAS-1). Following the
2026-10-28 decision for Master AMC Status, the card and column say "Visit Value".

## Filters

Search (AMC reference, client, invoice number, service report number), Client, Sales Engineer,
Month, Year, Invoice Status, Service Status. Applied with **Apply**, cleared with **Reset**.

* **Invoice Status** is "Invoice recorded" / "No invoice recorded". A Paid / Unpaid filter cannot
  exist until payment is recorded; the page says so.
* **Service Status** is Completed / Not Completed (Not Completed includes Waiting for Renewal).

## Columns and actions

`#`, AMC Reference (link to the contract), Client, System, Frequency, Service, Scheduled Month,
Visit Value, Service Status, Service Report No., Invoice No., Paid / Unpaid, Sales Engineer, Actions.
Every column except AMC Reference and Actions can be hidden (stored per user in this browser).

Actions: **View** (contract, needs `AMC_CONTRACTS:VIEW`); **Record invoice** on Blue rows for users
with `INVOICES:CREATE` — it opens Invoice Tracking, where the invoice is recorded with its date,
amounts and allocation. Accounts has no inline invoice field (see below).

## Invoice number: why there is no inline Save

An invoice number in STSLV AMC belongs to an `invoices` record (number, client, date, amount excl.
VAT, VAT) linked to visits by `invoice_allocations`, whose amounts must add up to the invoice amount
(checked by the API and by a deferred database trigger). A number typed on its own cannot become a
valid invoice without inventing a date and amounts, and linking an existing invoice to another visit
changes that invoice's allocation amounts, whose basis (visit value incl./excl. VAT) is unconfirmed.
So Accounts shows the number read-only and points to Invoice Tracking. A decision is needed before
any inline save (see questions).

## Permissions

| Part | Needs |
|---|---|
| Page, navigation item, list and options | `AMC_SCHEDULE:VIEW` **and** `INVOICES:VIEW` |
| Excel / PDF download | the above, plus `INVOICES:EXPORT` |

Seeded roles: Admin, Accountant and Invoicing can view; Execution (no invoice view) and Procurement
(no AMC access) cannot; only Admin can download. No permission was added.

## Export

`GET /api/accounts/export?format=xlsx|pdf&hidden=<column ids>&<filters>` — every matching row in
page order, the visible columns plus AMC Reference and Row Colour, grouped by month, with a Total
Visit Value row and notes (card figures, colour rules, "an invoice number is not a payment", VAT
basis unconfirmed). Logged as `accounts.exported`. Shared engine limits apply.

## Migration

None. Requires 0077 (`amc_visits.service_report_no`); without it every route answers 503 and the page
shows the reason. Applied on local `stslv_amc_dev` (2026-10-28); **not** on Neon.

## Open questions

* **ACC-1** Is the visit value (cost per visit) entered including or excluding VAT? (same as MAS-1)
  Until answered, nothing is labelled "Ex VAT".
* **ACC-2** Should payment (paid / unpaid, date received) be recorded in STSLV AMC, or read from Zoho?
  Until then Paid / Unpaid is "Not available".
* **ACC-3** Should Accounts allow entering an invoice number inline? If yes: is it allowed without the
  invoice date and amounts, may one number cover several visits, and what amount is allocated to each
  visit?

## Tests

* API: `tests/accounts.test.ts` — one row per visit, scope, Red/Blue/Green, quotation ignored, waiting
  for renewal, cancelled and multiple invoices, payment never reported, report number mapping and
  search, exact value totals, every filter and the cards, paging, empty result, options, permissions,
  Excel/PDF export, no write route.
* Web: `src/test/accounts.test.tsx` — rows, colours, cards, columns, missing values, Not available,
  filters with Apply/Reset, KPI rename/reorder/reset, hide columns, downloads, export permission,
  links, no inline edit, error and empty states, phone width, routing and navigation permissions.
