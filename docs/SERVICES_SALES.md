# Service Sales

Final module name, confirmed 2026-11-01. Sidebar: AMC Sales → Service Sales (since 2026-11-10); in Roles & Permissions it stays in the Finance permission group. It was briefly named Quotations. Its page address is `/amc/service-sales`; the former addresses `/amc/quotations` and `/amc/services-sales` redirect there. The API `/api/services-sales` and the permission code `SERVICES_SALES` are unchanged; quotation numbers keep that name because that is what they are.

Renamed 2026-10-31 to follow the client's written instruction "rename service sales to quotations". Only the names shown to people changed: the API path `/api/services-sales`, the permission code `SERVICES_SALES`, the database columns and users' saved layouts are unchanged, so no grant or record is affected.

Service Report No. and Quote filter: added 2026-11-01 from the written specification. Service Report No. is read only here; it is entered on Service Status.

**Assumption to confirm with the client:** the Quote filter reads "Quote Submitted" as `quotation_no IS NOT NULL` and "Not Submitted" as `quotation_no IS NULL`. There is no separate record of a quote being sent, so a recorded number is the only evidence. This differs from the "Quoted" sales status, which also needs the service to be completed: a number recorded before a visit was reopened counts as Submitted but not as Quoted.

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
| `GET /api/services-sales/:id/report` (the visit's Service Report file) | SERVICES_SALES:VIEW |

Filters: `search` (AMC reference, client, system, service code, quote no.), `clientId`, `salesEngineerId`, `systemTypeId`, `frequency`, `month`, `year`, `serviceStatus` (`NOT_COMPLETED` / `COMPLETED`), `quoteSubmission` (`SUBMITTED` / `NOT_SUBMITTED`). The cards, rows and export all follow them, and the export's header names them. Search also matches the service report number. The export takes `hidden` (the page's hidden columns) and leaves those columns out; AMC Reference and Sales status always stay.

## Service Report column (view and download only, 2026-11-04)

The **Service Report** column, right after **Service Report No.**, shows the document uploaded on Service Status for that service: **View** and **Download**, or *Not uploaded*. Service Sales never uploads, replaces or removes a report, and keeps no copy of it.

- **Source.** The attachment rows of migration 0104 (feature/service-status-report-completion-lock): `entity_type = 'amc_visits'`, `category = 'SERVICE_REPORT'`, `entity_id` = the visit id, `is_current`. At most one current report per visit, so a replacement on Service Status is what the page shows on its next read. Each list item carries `serviceReport` (`id`, `originalName`, `mimeType`, `sizeBytes`, `uploadedAt`) or `null`; the response says `serviceReportsAvailable`. The storage key and checksum never leave the API.
- **Linkage.** Always the visit id. Never the AMC reference, client, month or report number, so two services of one contract each show their own report.
- **File.** `GET /api/services-sales/:id/report` serves the current report of that visit only when the visit is on this page (not cancelled, historical or in the Recycle Bin), after checking the checksum recorded at upload. Errors: `SERVICE_REPORT_NOT_FOUND` (404), `FILE_MISSING` (404), `INTEGRITY_FAILED` (409), `FEATURE_UNAVAILABLE` (503, before 0104).
- **View** fetches the file with the signed-in user's token and opens it in a new tab from a temporary in-browser address (PDF, PNG, JPEG). Word files cannot be shown by browsers, so View downloads them. **Download** saves the file under its original name.
- **Permission.** Viewing the report needs SERVICES_SALES:VIEW, the same as the page (decided 2026-11-04). Service Status' own download route keeps SERVICE_STATUS:VIEW.
- **Columns and export.** The column is in Hide Columns (with the shown-column count). Saved choices list hidden columns, so earlier choices are kept and the new column is shown at first. The export has no Service Report column; the page does not send it as hidden.
- **Before 0104** every row shows *Not uploaded* and the file route answers 503.

## Applying 0078 and 0079

See `stslv-api/migrations-pending/validation-0078/README.md`. `SERVICES_SALES` must move from `STAGED_MODULES` into `MODULES` (API and web) in the same change.
