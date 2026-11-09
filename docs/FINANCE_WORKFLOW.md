# Financial workflow

Approved by the project owner on 2026-11-01, following the Aqua Executive reference specification (`03` §3.1, §3.3; `02` §2.2, §2.4; `09`). Where an older document says something different, this one applies.

## Rules

| Rule | Decision |
|---|---|
| Currency and precision | OMR, excluding VAT, three decimals. Calculated on whole thousandths, never floating point |
| Billing Basis options | AMC Value / Year, Final Credit Value, Custom Billing Value. All three are annual amounts |
| Amount per service | Annual amount ÷ services in one annual cycle, rounded half up to three decimals, the same in every year |
| Rounding remainder | The last service of each complete annual cycle takes it: 500.000 ÷ 6 = 5 × 83.333 + 83.335 |
| Partial contract year | Standard amount for the services actually scheduled, no proration. A cycle that never reaches its last service has no remainder |
| No Billing Basis | The visit keeps the manually entered Cost per Visit until a basis is explicitly selected |
| Recalculating existing visits | Only through an explicit Regenerate, with a reason |
| Paid / Unpaid | Manual Invoice No. entered = Paid. Cleared = Unpaid. No invoice generation, VAT, date or amount |
| Service completion | Changed 2026-11-04: a manual Invoice No. can be entered or changed only on a service whose stored status is Completed. Clearing it (Unpaid) is allowed at any status. Completing a service never makes it Paid |

## Paid is a reference status

Paid means a manual Invoice No. is entered on the service. **It does not verify that money was received.** STSLV AMC has no bank or receipt record. Screens and exports that show Paid carry this note or a hint with it.

The manual number lives on the visit (`amc_visits.manual_invoice_no`, migration 0100). It may be shared by several services. Its date (`manual_invoice_at`) is when it was first entered: correcting a number keeps the date, and clearing it removes the date. Every change is in the activity log with the old and new number.

**Completion first (2026-11-04).** `PATCH /api/amc/visits/:id/manual-invoice` refuses (409 CONFLICT, "Complete the service before entering an invoice number.") a new or different number when the visit's stored `status` is not `COMPLETED`. The status is read under the row lock in the same transaction, never taken from the request. Clearing, and re-saving an unchanged number, are allowed at any status, so numbers entered before the rule on services not yet completed stay visible, still count as Paid and can be cleared. The Invoice No. field (Accounts, AMC Schedule, contract detail) disables entry with the same message on a service that is not completed and offers **Clear** for an existing number.

## Invoice Tracking is separate

Zoho invoices in Invoice Tracking (`invoices`, `invoice_allocations`) are unchanged and still require a date, amounts and reconciled allocations. They do not decide Paid or Unpaid:

* A service with a Zoho record and no manual number is **Unpaid**.
* Accounts and Master AMC Status show Zoho numbers beneath the Invoice No. as "Zoho: …".
* The Invoice Tracking workflow fields (Ready for Invoice, Invoiced, `v_amc_visit_billing`) still follow Zoho records. So do the Schedule Pending Billing card and the Calendar's "Billing status" filter.

## Who reads what

| Screen | Paid / Unpaid source |
|---|---|
| Accounts: row colour, filter, Invoice No. Filled, search, export | Manual Invoice No. |
| Master AMC Status: Yellow / Blue / Green, filter, search, export | Manual Invoice No. |
| AMC Schedule: Color Priority "Invoice Pending" | Manual Invoice No. |
| Calendar: square colour, Paid and Unpaid figures | Manual Invoice No. |
| Dashboard: Unpaid Invoices, Paid This Month, Payment Trend | Manual Invoice No., over the Accounts rows |
| AMC Management: Paid, Unpaid, Paid Invoice Total | Manual Invoice No., same query as the Dashboard |
| Reports: visit reports, Accounts summary, Unpaid Amount | Manual Invoice No. |
| Client 360: invoice figures; Recent Invoices | Invoice Tracking (Zoho) |

Entering a number needs `INVOICES:EDIT`, enforced by the API. `PATCH /api/amc/visits/:id/manual-invoice` takes `invoiceNo` (null or empty clears it) and `expectedUpdatedAt`, and refuses historical and cancelled visits.

## Regenerate

`GET /api/amc/contracts/:id/schedule/regenerate` previews. `POST` with `reason` applies. Both need `AMC_CONTRACTS:EDIT`. It applies only to an active contract with a Billing Basis.

Kept unchanged: Completed, Historical, Cancelled, Paid, a visit with an active Zoho invoice, and a hand-set amount. Everything else takes the calculated amount, and missing visits are added and untouched visits outside the terms removed, as when generating.

The log entry `amc_contract.schedule_regenerated` holds the reason, basis, annual amount, each changed visit's old and new amount, and the preserved visits. Earlier entries stay readable; a field they never recorded shows as not recorded and is never guessed.

Contract edits never recalculate existing visits. A visit with a manual Invoice No., service report number or quotation number now counts as acted on, so a change of terms cannot delete it. A Paid visit also refuses a new amount until the number is cleared, and cancelling a contract's open visits skips Paid ones.

## Reconciliation

`schedule.expectedTermTotal` is what the term's visits should add up to: annual amounts, partial years not prorated, from the cutover date for an imported contract. `schedule.valueDifference` is that less the visits (not cancelled, not historical). A difference is information, not an error: hand-set or preserved amounts cause one.

Without a Billing Basis the difference is null: an older value may be annual or whole-term, so it is never compared.

## Older contract values

"AMC Value / Year" is the label of `contract_value`. Values entered before this rule may be whole-term amounts. They are **not** reinterpreted. The **Contract Value Review** report lists multi-year contracts with no basis or with AMC Value / Year as basis, and compares the value with the visit amounts: *May be whole-term*, *Looks annual* or *Unclear*. It is an aid for a person and changes nothing.

Selecting AMC Value / Year on a contract whose value is whole-term would bill too high after Regenerate. Check the report first.

## Reports

Reports read the same records as their source modules, and PostgreSQL calculates every total. **System** (`system_description`) and **Status** filter the reports: the contract's status on reports over contracts, the visit's on reports over visits. A status a report does not have is refused. Completed Services has no Status filter (every row is Completed), nor has Expiry & Renewal Due (every row is Active).

* **AMC Contract Summary** carries the KPI strip: Contracts in Scope, AMC Value, Scheduled (Current Year), Unpaid Amount. Each is that report's row count or column total. Scheduled (Current Year) equals Accounts' Total Value for the same year.
* **Billing Schedule** (id `scheduled-services`) adds the Paid / Unpaid filter, the same split as Accounts.
* **Expiry & Renewal Due** uses the Dashboard's Expiring Contracts rule: status Active and validity ending within 90 days, or already past. Both give the same total. Contracts with status Expired are on AMC Renewal, not here.
* **Renewal History** has the same rows as AMC Renewal's history.

## Known differences from the reference

* **A Paid visit on a cancelled contract** (P1 fixes, 2026-11-09) stays Scheduled, keeps its number, amount and audit history, and **stays in Accounts, Master AMC Status, Service Status and the Paid figures**. One shared scope (`stslv-api/src/modules/amc/service-scope.ts`) now decides which services every page counts: not Cancelled, not Historical, and on a cancelled contract only the Completed or Paid ones. Open unpaid work of a cancelled contract is still left out. Cancelling never resets a visit to Scheduled, never clears a number, never changes an amount and never creates an invoice.
* **Historical Paid-but-not-Completed services** (numbers entered before the 2026-11-04 "complete first" rule). **Approved 2026-11-09:** they are preserved exactly as they are, with no automatic completion, cancellation or clearing, by any process (contract expiry, cancellation, page loads). They are identified for a person to review with the read-only query `docs/sql/paid-not-completed-review.sql`; running it on production needs separate approval and a `READ ONLY` transaction. Regression-tested in `stslv-api/tests/p1-approved-rules.test.ts`.

* **Schedule Pending Billing** and **Current Scheduled Value** keep their existing STSLV meanings: completed visits ready for a Zoho invoice, and this month's planned value. The reference counts every generated row in both.
* **Schedule history** is the activity log, not a separate generation table, and the rows of an earlier generation are not kept as rows: changed amounts are in the log entry.
* **Per-visit amount override** already exists as `updateVisit`; the reference only implies it.
