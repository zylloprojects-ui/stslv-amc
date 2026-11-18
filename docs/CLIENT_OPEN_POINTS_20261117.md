# Client open points: provisional decisions (17 Nov 2026)

These four points came from the client meeting of 16 Nov 2026 and were not settled in it. The project owner asked the
development team to apply best practice. Each decision below is **provisional until the client confirms it**, is
reversible, deletes no data and changes no financial calculation.

| # | Point | Decision applied | How to reverse |
|---|---|---|---|
| 1 | Engineers see only their own records (CR-017) | Built **behind a switch, off by default**: `SERVICE_SALES_OWN_RECORDS_ENABLED=true` on the API. When on, a Service Sales user **without** AMC Contracts: View sees only the services of contracts whose Sales Engineer is linked to their user (Master Data → Sales Engineers → linked user). Users with AMC Contracts: View (management, accounts, administrators) still see everything. A sales user with no linked Sales Engineer sees nothing. The list, cards, totals, Excel/PDF export, service report download and quotation save all follow the rule on the server; another engineer's service answers "not found". The page shows a notice when the list is limited. | Leave the switch unset or set it to anything but `true`. |
| 2 | "Responsible engineer" field next to Sales Engineer | **Hidden on Add AMC Contract.** The client wants one engineer: whoever brings the job is the Sales Engineer. Choosing a Sales Engineer still copies the name into the old field, as before, so existing exports and fallbacks keep a name. The field and the contract-page line appear only when an **older** contract holds a different name, so that value can still be read, corrected or cleared. Nothing is deleted. | Show the field again in `ContractFormModal.tsx` (`showResponsibleEngineer`). |
| 3 | "Invoices Not Generated" also counts services not yet completed | **The figure is unchanged.** Its detail line now adds how many of those services are **already completed and waiting for an Invoice No.**, with their value, for example "2 completed, awaiting invoice (OMR 1,200.000)". This is shown on every row: Current Month, Current Year (YTD), Overall Till Date and Overall Contract. Missed invoicing is the client's main pain point; the existing meaning is kept. | Additive only: remove the detail text in `stslv-web/src/pages/dashboard/kpis.ts`. |
| 4 | Contract page "All Schedules" button opened the retired AMC Schedule page | Renamed **Service Schedule**; it opens the contract's own Service schedule tab (every service of that contract). The AMC Schedule page itself still exists and is still reachable by URL. | Restore the link in `ContractDetailPage.tsx`. |

## To confirm with the client

1. Should the own-records rule be switched on? If so, link each sales user to their Sales Engineer record first, or they will see an empty list. Should it also apply to any other page?
2. Is it right to stop recording a separate Responsible engineer on new contracts?
3. Is the "completed, awaiting invoice" detail the figure they want to watch, or should it become a card of its own?
4. Can the AMC Schedule page be removed completely, or should it stay available by URL?

## Tests

- API: `tests/services-sales-own-records.test.ts` (7 tests, switch on and off); a new "completed, awaiting invoice" test in `tests/client-uat-nov2026.test.ts`.
- Web: `dashboard-awaiting-invoice.test.ts`, `contract-responsible-engineer.test.ts`; updated tests for the contract form, contract page, toolbar and Service Sales notice.
