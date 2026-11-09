# Service Report upload and completion lock

Service Status page (`/amc/service-status`), 2026-11-04. Branch `feature/service-status-report-completion-lock`.

## Rules

1. **Each service has its own Service Report.** A report belongs to one scheduled visit (`amc_visits_all.id`), never to the contract. PDF, DOC and DOCX are accepted. Files are recognised by their content: a Word file with macros is refused, and so is a name that does not match the content. The size limit is `ATTACHMENT_MAX_MB` (default 12 MB). The browser checks the file first and the API checks it again.
2. **Completion needs the report.** A service can be saved as Completed only while it has a current report. On the page, choosing Completed without one shows the popup **"Please upload service report."**. The dropdown keeps its previous value, the Upload Report action is highlighted, and nothing is saved. The API checks again with the visit row locked. Without a report it answers `409 SERVICE_REPORT_REQUIRED` with the same message. Every completion path goes through `applyExecution`: the Service Status save, the execution API, and the Visit actions dialog on AMC Schedule and Service Status.
3. **Completion date.** The page no longer shows a date field. On completion the API records today's date (the database's `current_date`), the same date the page used to pre-fill. An API caller may still name a date in the completing request. The rules are unchanged: it must not be in the future, and it is never removed.
4. **Completion lock.** Once a visit is saved as Completed:
   - its status cannot change to anything else;
   - its completion date cannot change;
   - its report cannot be replaced or removed;
   - this applies to every user, Admin included, and on every route. The API answers `409 COMPLETION_LOCKED`.

   The database enforces the same rule with trigger `amc_visits_completion_lock` on `amc_visits_all`, so no other writer can bypass it. There is no unlock action. Work notes and the Service Report No. of a completed visit can still be saved.
5. **Existing completed services without a report** are kept exactly as they are: still completed, still locked, with no report. No upload is forced, and none can be added afterwards.
6. **Before completion** a report can be replaced, which adds a new version of the same document and keeps the earlier one. It can also be removed: the row is marked not current, and neither the row nor the file is deleted. Every upload, replacement and removal is written to the activity log (`amc_visit.service_report_uploaded`, `…_replaced`, `…_removed`).

## Storage

- Reports are stored with the existing attachment mechanism. The metadata goes in `attachments` with `entity_type = 'amc_visits'`, `entity_id` set to the visit id and `category = 'SERVICE_REPORT'`. The file is kept in the configured storage (`ATTACHMENTS_DIR`) under a generated key, never under the user's file name. A SHA-256 checksum is checked on every download.
- The file is validated before anything is stored. If the database write fails, the stored file is removed again, so no orphan file is left behind.
- Service reports are reached only through the Service Status routes. The generic `/api/attachments` routes refuse them (403 by attachment id, 400 when listed by record type), so the completion rules cannot be bypassed.

## API

| Route | Permission | Notes |
|---|---|---|
| `GET /api/amc/service-status/:id` | `SERVICE_STATUS:VIEW` | One service, with `serviceReport` and `locked`. Used by the View dialog. |
| `GET /api/amc/service-status/:id/report/download` | `SERVICE_STATUS:VIEW` | The current report file. |
| `POST /api/amc/service-status/:id/report` | `AMC_EXECUTION:EDIT` | Raw file body, name URI-encoded in `X-File-Name`. Uploads or replaces the report. `409` once the service is completed. |
| `DELETE /api/amc/service-status/:id/report` | `AMC_EXECUTION:EDIT` | Removes the report before completion. |
| `PATCH /api/amc/service-status/:id` | `AMC_EXECUTION:EDIT` | As before. `completedDate` is now optional when completing. |
| `GET /api/amc/service-status` | `SERVICE_STATUS:VIEW` | Each item gains `serviceReport` and `locked`. The list gains `serviceReportsAvailable` and `serviceReportLimits`. |

The Service Status export is unchanged. It has no report-file column. `serviceReport` is accepted in `hidden` so that hiding the page column does not break an export.

## Migration 0104 (`0104_visit_service_reports.sql`)

- Adds `'amc_visits'` to `attachments_entity_type_ck`, and adds `attachments_visit_report_ck`: a visit holds service reports only.
- Widens `attachments_mime_ck` to PDF, PNG, JPEG, DOC and DOCX. This is the same list as 0103 (contract Word documents), so 0103 and 0104 produce the same constraint whichever applies last.
- Adds unique index `attachments_service_report_uq`: one current report per visit. The API looks for this index to know that reports can be stored.
- Adds trigger `amc_visits_completion_lock` on `amc_visits_all`.
- Changes no existing row.

**Not applied** to `stslv_amc_dev` or Neon. It is applied only on the isolated databases `stslv_amc_test_service_status_lock` (test schema) and `stslv_amc_smoke_service_status_lock` (browser smoke).

**Until 0104 is applied, no service can be completed.** The API answers `503 FEATURE_UNAVAILABLE` and the page says so. 0104 therefore has to be applied together with the release of this code.

Order: the migration runner refuses a migration numbered below the last applied one, so 0102 and 0103 must be applied before 0104.

## Open points for decision

- `AMC_EXECUTION:APPROVE` used to allow reopening. Nothing checks it now. It stays in the permission catalog, labelled "No effect at present", because seeded roles hold it (0087). Retiring it, and removing those grants, needs a decision.
- The Service Report No. of a completed visit stays editable. Only the status, the completion date and the report document are locked.
  **Proposed lock after Paid (P1 fixes, 2026-11-09), built and switched OFF.** With `SERVICE_REPORT_NO_LOCK_ENABLED=true` the number is editable until the service is Paid (manual Invoice No. entered) and locked afterwards: `PATCH /api/amc/service-status/:id` answers `409 REPORT_NUMBER_LOCKED` for a change. Super Admin or Admin may override with `reportNumberOverrideReason` (5 to 500 characters); anyone else gets 403. The override is logged as `amc_visit.service_report_no_override` with the reason and the old and new number. Re-saving the same number is allowed, existing numbers are never changed, and clearing the Invoice No. (Unpaid) unlocks it. The page shows a lock icon and, for an administrator, a reason field. Items carry `paid` and `reportNumberLocked`; the list carries `reportNumberLockEnabled`. Activation needs the client's approval of the rule, and of who may override (currently the Super Admin and Admin roles, as for the Audit Log).
- A completed service that has no report (legacy data) cannot be given one afterwards. If retroactive uploads are wanted, that is a separate change.
