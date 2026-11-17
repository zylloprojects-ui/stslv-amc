# Client UAT changes — 16 November 2026

Source: the client's workbook "Stselv changes .xlsx" (UAT review call, 16-Nov-2026): 32 change requests, 8 open
questions, Engineer Field Matrix, Dashboard Spec, Monthly Calendar mapping, Confirmed – No Change, Workflow & Ownership.
Branch `feature/client-uat-nov2026` (worktree `STSLV-AMC-client-uat`), from alpha / production `91323e8`. Local only:
not committed, not merged, not pushed, not deployed. **No migration**: the schema stays at 0117.

## Engineers (CR-005 to CR-012, CR-015, CR-016)

| Identity | Meaning (client rule) | Stored in | Entered on |
|---|---|---|---|
| **Sales Engineer** | Who brought the AMC (contract level) | `amc_contracts.sales_engineer_id` → Sales Engineers master | Add / Edit AMC Contract |
| **Service Engineer** | Who performed one visit (visit level) | `amc_visits.sales_engineer_name` (migration 0110, free text) | AMC Execution › Service Status, beside the Service Report No. |

- The contract link was shown as "Service Engineer" since 2026-11-11 (`18b16e7`). That label change was reverted, so every
  contract-level column, filter, export and report reads "Sales Engineer" again.
- The 0110 field was labelled "Sales Engineer Name" (2026-11-09). The workbook identifies this same input as the Service
  Engineer, so only its label changed; the column, its API field `salesEngineerName`, its audit action code
  `amc_visit.sales_engineer_name_changed` and every stored value are unchanged. Nothing is copied from the contract and
  nothing is backfilled: a visit without an entry shows "—" (Q-07).
- AMC Contracts list: the *Sales Engineer* column shows the linked engineer, and the typed `responsible_engineer` only for a
  contract with no link (older and imported contracts). Sorting and search follow the same rule.
- Service Engineer is added to Master AMC Status (after Service Status), Accounts (after Sales Engineer) and Service Sales
  (after the Service Report), with their exports; one rule in `stslv-api/src/modules/amc/service-engineer.ts`.

## Values (CR-013, CR-014, CR-019 to CR-022)

All amounts are stored in OMR excluding VAT (FINANCE_WORKFLOW.md); only headings changed, no value was recalculated.

- AMC Contracts: *Contract Value (ex VAT)*, *Final Credit (ex VAT)* (page and download).
- Service Status: *AMC Value (ex VAT)*, *Service Value (ex VAT)* (page and download).
- Accounts: *AMC Value (ex VAT)* = the contract's AMC Value / Year (`contract_value`), the same figure Service Status and
  Master AMC Status show; repeated per service, never totalled. Phase 2: shown to everyone who may open Accounts (page and
  download), because the client asked for it so Accounts can invoice; this gives no access to the contracts module.
  *Service Value (ex VAT)* = `visit_amount` (renamed from "Value (Ex VAT, OMR)").
- Accounts column order (provisional, Q-04): Service Report No. → Sales Engineer → Service Engineer → AMC Value → Service Value.

## Dashboard (CR-001 to CR-004)

Rows: AMC Portfolio (existing first row, Q-02) → Current Month → Current Year (YTD) → **Overall Till Date** (new) →
Overall Contract (the former "Overall", calculation unchanged). YTD and Till Date show the same four cards as the other
rows (services with completed count, pending with overdue count, Invoices Generated / Not Generated). Both come from one
query, `periodServiceFigures()` in `stslv-api/src/modules/dashboard/operations.service.ts`, using the shared service scope
(`SERVICE_IN_SCOPE`) and Oman's business date; Till Date = every counted service scheduled on or before today (any year).
The YTD card *Services Completed* became the "N completed" line of *Services YTD*.

## Monthly Calendar (CR-024 to CR-027)

Month cards: Scheduled value → No. of services completed → No. of services not completed → Paid → Unpaid. Paid / Unpaid
are the existing reference status (manual Invoice No. entered or not), as counts with the services' values; the Zoho
invoiced rows were removed from the cards. All figures were already returned by the API; nothing new is calculated.

## Other

- CR-017: AMC Value and Service Value are already withheld server-side from any user without *AMC Contracts: View*
  (page, totals, Excel, PDF). "Each engineer sees only their own records" is **not implemented** (Q-05).
- CR-018: verified existing — the quotation number needs a completed service (API and page).
- CR-023: Service Status grid compacted (scoped CSS): headings on at most two lines, tighter cells.
- CR-029: AMC Schedule removed from the sidebar and page search only (Q-08); route, data and exports unchanged.
- CR-028, CR-030: not implemented — need the client's choice of screens/columns (Q-03; columns not named).

## Open questions

See the implementation report for the full register (Q-01 to Q-08 plus questions found during implementation).
