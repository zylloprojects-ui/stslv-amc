# Master AMC Status

Route: `/amc/master-status` (navigation: Operations → Master AMC Status).
API: `GET /api/amc/master-status`, `GET /api/amc/master-status/options`,
`GET /api/amc/master-status/export` (all read-only).
Status: built 2026-10-28 on local `alpha`. No new migration; needs migration 0078 (below). No scheduled job.

Master AMC Status is a read-only overview with **one row per scheduled maintenance visit**
(`amc_visits`), never one row per contract. It shows each visit's completion, invoice and
quotation status in one place. It reads the same visit records as AMC Schedule, Service Status
and Services Sales, and the invoices recorded in Invoice Tracking. Nothing on the page writes.

## Scope

The same visits as Service Status and Services Sales:

* Included: visits with status `SCHEDULED`, `IN_PROGRESS`, `POSTPONED` or `COMPLETED`.
* Excluded: cancelled and historical visits, and outstanding (not completed) work of a cancelled
  contract. Completed work always stays.

Rows are ordered by scheduled date, then client name, then visit id.

## Permissions

| Part | Needs |
|---|---|
| Page, navigation item, list and filter options | `AMC_SCHEDULE:VIEW` **and** `INVOICES:VIEW` **and** `SERVICES_SALES:VIEW` |
| Excel / PDF download | the above, plus `AMC_SCHEDULE:EXPORT` |
| View (contract) link on each row | `AMC_CONTRACTS:VIEW`; otherwise the row shows "No access" |

The page shows invoice numbers (Invoice Tracking) and quotation numbers (Services Sales), so a
role sees it only when its own grants already show both. The API enforces all three checks; the
navigation item (`alsoRequires` in `layout/navigation.ts`) and the route only mirror them.

With the seeded roles (covered by `tests/amc-master-status.test.ts`): Admin, Accountant and
Invoicing can view; Execution (no invoice view) and Procurement (no AMC access) cannot; only Admin
can download. No permission was added or widened.

## KPI cards (six)

Every card is calculated by the API over **exactly the rows the applied filters select**, across
all pages (not only the page shown).

| Card | Formula |
|---|---|
| Total Services | number of selected rows. Always equals Green + Blue + Yellow + Red. |
| Green Rows | rows coloured Green |
| Blue Rows | rows coloured Blue |
| Yellow Rows | rows coloured Yellow |
| Red Rows | rows coloured Red |
| Total Visit Value | `sum(amc_visits.visit_amount)` over the selected rows, in the database (exact decimal, 3 places). Rows with no amount add nothing; their number is shown on the card so an incomplete total is visible. |

## Row colours

Derived on every request; never stored. The first rule that applies wins:

| Colour | Rule |
|---|---|
| **Red** | The visit is not completed (Service Status "Not Completed" or "Waiting for Renewal"). |
| **Yellow** | Completed, and no active (not cancelled) invoice covers it. |
| **Blue** | Completed and invoiced, and no quotation number is recorded. |
| **Green** | Completed, invoiced, and a quotation number is recorded. |

* Service Status is the same derived rule as the Service Status page (`serviceStatusSql`), so a
  visit shows the same status on both pages: Completed when the visit is completed; Waiting for
  Renewal when the contract is Expired or past its validity and has no renewal that is not
  cancelled; otherwise Not Completed.
* An invoice number shows that an invoice was **recorded**, not that it was paid. Green says
  nothing about money received. Payment is not tracked anywhere in STSLV AMC.
* The order (invoice checked before quotation) is pending client confirmation (MAS-2, below).

## Columns

`#`, AMC Reference, Client, System, Frequency, Service, Scheduled Month, Visit Value,
Service Status, Invoice No., Quote No., Sales Engineer, and a View link.

* **AMC Reference** ("AMC-0007") is derived from the contract id, as on Service Status. It is
  provisional.
* **Service** is the service code and contract year from migration 0076 ("Year 2 · Q3"); visits
  generated before service codes existed show their visit number.
* A missing invoice, quotation, value or sales engineer is shown as "—", never as zero.

**Hide Columns:** every column except AMC Reference and View can be hidden, and
**Reset to Default** shows them all again. The choice is stored in browser `localStorage`, per user
id (`stslev.master-amc-status.hidden-columns.<userId>`), so it applies in this browser only.

## Filters

Search, Client, Sales Engineer, Month, Year, Service Status and Row Colour. Filters change only
when **Apply** is selected; **Reset** clears them. The rows, the six cards and the downloads all
use the same applied filters (one SQL condition shared by all three), so they always agree.

* **Search:** client name, invoice number, quotation number, or an AMC reference ("AMC-0007",
  "amc7" or "7" find contract 7). Case-insensitive.
* **Month / Year:** of the scheduled date. Either may be used alone: a month alone means that month
  in every year.
* Client, Sales Engineer and Year lists are taken from the contracts that have visits on the page
  (`/options`).
* Unknown filter values are rejected with a validation error. Page size is 50 on the page (API
  maximum 200).

## Visit Value

`amc_visits.visit_amount` as stored on each visit (the per-visit amount of the schedule).

**VAT basis not confirmed.** Whether this amount includes or excludes VAT is an open client
question (MAS-1). Until it is answered the page and the export call it "Visit Value" /
"Total Visit Value" and make no VAT claim (not "Ex VAT", not "Inc VAT"). It is a scheduled
amount, not revenue, not invoiced and not collected.

## Invoices and quotations

* **Invoices** come from Invoice Tracking (`invoices`, `invoice_allocations`, migration 0060).
  A visit can be covered by more than one invoice; every active invoice is listed, oldest first.
  Cancelled invoices are ignored. Invoices are created in Zoho; this page only shows the numbers
  recorded in STSLV AMC.
* **Quotation number** is `amc_visits.quotation_no` (migration 0078), entered on the Services
  Sales page after a visit is completed. No quotation document is created or stored.
  "N/A" is not a quotation number and cannot be stored (MAS-3, below).

## Excel / PDF export

`GET /api/amc/master-status/export?format=xlsx|pdf&hidden=<column ids>&<filters>`

* Covers **every** visit matching the applied filters, on every page, in the page's order.
* Contains only the columns shown on the page (`hidden=` takes the same column ids), plus
  AMC Reference and the Row Colour, which are always included.
* Grouped by scheduled month, with a Total Visit Value row (an Excel `SUM` formula) unless Visit
  Value is hidden, and notes giving the card figures, the colour rules, "an invoice number is not
  a payment" and the number of rows without a value.
* The filters are described at the top of the report. Client and sales engineer names are read
  from the database, never taken from the request.
* Size limits (shared export engine): 50,000 rows for Excel, 2,000 for PDF; above that the
  download is refused with a message.
* Each download is recorded in the activity log (`master_amc_status.exported`).

## Required migration 0078

The routes need `amc_visits.quotation_no` (migration 0078, Services Sales). Every database that
has 0078 also has 0060 (invoices), 0070 (sales engineers, system types), 0072 (renewals),
0075 (frequency master) and 0076 (service codes), all of which the page reads.

* Local `stslv_amc_dev`: 0077–0079 applied on 2026-10-28.
* Neon (client review): **not applied**. Until it is, the routes answer 503 and the page shows
  the reason. Applying it needs explicit approval.

Master AMC Status adds no migration of its own.

## Not built / limitations

* Read only: no status, invoice or quotation can be changed from this page (use Service Status,
  Invoice Tracking and Services Sales).
* No payment tracking: paid / unpaid is not recorded anywhere.
* Hidden-column choices are per browser, not stored on the server.
* No scheduler or background job; every figure is calculated on request.
* AMC references are derived from the contract id (provisional).

## Pending client confirmations

Recorded in `docs/client-source/CLIENT_DATA_CONFIRMATION.md`:

* **MAS-1:** is the per-visit amount entered including or excluding VAT?
* **MAS-2:** the colour rules put the invoice before the quotation, so a completed visit with a
  quotation but no invoice is Yellow. Is that order intended?
* **MAS-3:** the legacy screen shows a Green row with Quote "N/A". Here that row would be Blue.
  Is a visit with no quotation ever meant to be Green (for example, "no quotation required")?

## Tests

* API: `tests/amc-master-status.test.ts` (one row per visit, scope, colour priority, cancelled
  invoices, multiple invoices, exact value totals, every filter and the cards, paging, options,
  permissions, Excel and PDF export with hidden columns).
* Web: `src/test/master-status.test.tsx` (rows, cards and columns, missing values, filters with
  Apply/Reset, hide columns, downloads, export permission, View link, error and empty states,
  phone width, routing and navigation permissions).
