# Services Sales

The sales and quotation counterpart of Service Status: one row per scheduled AMC service (a row of `amc_visits`), never one per contract. Services Sales reads the same visit records as Service Status, the AMC Schedule and the AMC Calendar. The only thing it writes is the visit's quotation number.

Status: built 2026-10-28, uncommitted on `alpha`. It needs the staged migrations 0078 and 0079 (`stslv-api/migrations-pending/`), which have not been applied to any database. Until they are, the routes answer 403 and the page is not offered.

## Rules (approved 2026-10-27)

| Visit status | Quotation number | Shown as |
|---|---|---|
| Scheduled, In progress, Postponed | any | Not Completed (red) |
| Completed | none | Completed / Quote Pending (blue) |
| Completed | recorded | Quoted (green) |
| Cancelled, Historical | | not on the page; never changed |

- Waiting for Renewal (derived on Service Status) is a visit that is not completed, so it counts as Not Completed here.
- Outstanding work of a cancelled contract is left out, as on Service Status, so both pages count the same visits.
- Completion is read only on this page. It is changed on Service Status.
- A new quotation number needs a completed visit (409 otherwise). Clearing a number is always allowed and is audited.
- A visit reopened after quoting keeps its number. It counts as Not Completed and is reported ("recorded before completion"). The number is never deleted automatically.
- "N/A" is only a display placeholder: the API and the database refuse it as a number. Numbers are at most 50 characters, trimmed, with no line breaks. Uniqueness is not enforced (not confirmed).
- Saving a number changes only `quotation_no`, `quotation_updated_at`, `quotation_updated_by` and `updated_by` of that one visit. It creates no quotation document and no invoice.
- A save over a newer change to the same visit is refused (`expectedUpdatedAt`).
- KPI cards, rows and downloads all use one server-side filter, so they always agree. Total = Not Completed + Quote Pending + Quoted.
- The page opens on all months and years.

## Permissions (SERVICES_SALES)

Admin: every action. Invoicing: view and edit. Accountant and Execution: view only. Procurement: none. EXPORT is Admin-only, as on every other module, until an Admin grants it.

## API

| Route | Permission |
|---|---|
| `GET /api/services-sales` (filters, paging, `kpis`) | SERVICES_SALES:VIEW |
| `GET /api/services-sales/options` | SERVICES_SALES:VIEW |
| `GET /api/services-sales/export?format=xlsx\|pdf` | SERVICES_SALES:VIEW + EXPORT |
| `PATCH /api/services-sales/:id` `{ quotationNo, expectedUpdatedAt }` | SERVICES_SALES:EDIT |

Filters: `search` (AMC reference, client, system, service code, quote no.), `clientId`, `salesEngineerId`, `systemTypeId`, `frequency`, `month`, `year`, `serviceStatus` (`NOT_COMPLETED` / `COMPLETED`).

## Applying 0078 and 0079

See `stslv-api/migrations-pending/validation-0078/README.md`. `SERVICES_SALES` must move from `STAGED_MODULES` into `MODULES` (API and web) in the same change.
