# Integration of Sessions 1–12 (2026-11-04)

Twelve feature branches, each one commit on alpha `e53e6dd`, were merged into
`integration/stslv-amc-sessions-1-to-12` and then into local alpha. Nothing was
pushed or deployed; Neon was not touched.

| # | Branch | Commit | Area |
|---|--------|--------|------|
| 1 | feature/add-client-default-company | f7e8529 | Add Client defaults to Company |
| 2 | feature/dashboard-12-kpis | 5bd90c5 | Dashboard: 12 KPI cards |
| 3 | feature/sales-engineers-code-delete | 7041bbe | Manual engineer code, Super Admin delete (0102) |
| 4 | feature/amc-management-ui-polish | 3b018af | AMC Management Hide/Show, no KPI links |
| 5 | feature/amc-contract-kpis-required-fields | fcf05c1 | Contract KPIs, required fields, contract document (0103) |
| 6 | feature/master-amc-status-columns-layout | 73bf8d1 | Master AMC Status: Hide Columns in Filters |
| 7 | feature/master-amc-status-reference-links | 0bce1c6 | Master AMC Status: reference opens the contract |
| 8 | feature/service-status-report-completion-lock | 032524e | Service report, completion lock (0104) |
| 9 | feature/service-sales-report-view-download | 3b738bd | Service Sales: report View/Download |
| 10 | feature/accounts-ui-invoice-validation | 98a5a40 | Accounts: Invoice No. only after completion |
| 11 | feature/service-quotation-contract-schedule | 30933fb | Contract 360: Quotation No. column |
| 12 | feature/manual-amc-reference | 8969d0f | Manual AMC Reference Number (0105) |

## Changes made during integration

- **Shared file-content check.** Contract documents (0103) and service reports
  (0104) had separate copies of the PDF/Word recognition and macro refusal.
  `recogniseFile` in `attachments.service.ts` is now the only copy; each caller
  keeps its own wording.
- **Contract creation.** `createNewContract` (contract document, Session 5) calls
  Session 12's `createContract`; the `attach` hook reaches `insertContract`, so the
  document is recorded in the contract's own transaction and the stored file is
  removed again when the reference is a duplicate.
- **Migration 0102 corrected before first use on a shared database.** The engineer
  code backfill fired the `updated_at` trigger, so every existing engineer showed
  the migration time as its last change (found in the restored-database
  rehearsal). It now disables that trigger for the backfill, as 0105 does. 0102
  had only been applied to isolated test databases: any of those must be
  recreated rather than migrated, because the file's checksum changed.
- **Tests** written before another session's rule were brought up to the combined
  rules: new contracts carry the full Add AMC Contract body, completing needs a
  service report, renewals type their own reference. A test now covers the
  legacy importer refusing a register without AMC References.

## Migrations

Order 0102 → 0103 → 0104 → 0105, each in its own transaction (the runner). Rehearsed
on a restore of `stslv_amc_dev`: every table count and every contract, visit,
completed visit, engineer, attachment and client row (including `updated_at`) is
unchanged apart from the new columns; existing references stay `AMC-` + id and
existing engineer codes stay `SE-` + id.

## Known follow-ups

- Service Status and Service Sales each have a reader for the current service
  report; both check the stored checksum and look up by visit id, Service Sales
  additionally by its own scope. They could share one reader.
- A new contract needs file storage (`ATTACHMENTS_DIR`). Without it, Add AMC
  Contract is refused with a clear message, by design. Production document storage
  remains a release blocker.
