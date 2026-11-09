# Outstanding Issues Register — STSLEV AMC

Opened 2026-11-09 during handover preparation (branch `feature/stslv-p3-handover`, base `c6d8d19`). Items come from the repository documentation and the code at that commit. **Items that the parallel P0 (security) and P1 (fixes) sessions may resolve are marked "P0/P1?" and must be re-checked at final integration.** The November 9 audit document named in the P3 brief was not found in the repository or the project folders; reconcile this register with it when it is supplied.

Severity: **S1** blocks go-live · **S2** must have an agreed plan before go-live · **S3** improvement / decision that does not block.
Type: **Decision** (business owner must decide) · **Infra** · **Security** · **Data** · **Defect** · **Doc**.

| ID | Title | Type | Sev | Detail | Source | Owner | Status | Target |
|---|---|---|---|---|---|---|---|---|
| OI-01 | Production backups are manual | Infra | S1 | In-app Backup & Restore is off in production: no durable `BACKUP_DIR`. Backups are `pg_dump` runs from a trusted machine before releases. A named owner, a routine schedule, retention and an off-site copy are needed. | `docs/BACKUP_RESTORE.md` | TBC | Open | Before go-live |
| OI-02 | Document storage has no backup | Infra | S2 | Supabase bucket objects (contract documents, service reports) have no second copy. | `docs/DOCUMENT_STORAGE.md` | TBC | Open | |
| OI-03 | Public source repository | Security | S2 | `zylloprojects-ui/stslv-amc` is public. Decide whether to make it private before client handover. No secrets are in the repository by policy. | `GIT_WORKFLOW.md` | Project owner | Open | |
| OI-04 | Database reachable from the internet | Security | S2 | Neon is reachable with password + TLS. CLAUDE.md says PostgreSQL must not be exposed in production; accepted for the client-review copy only. The Hostinger VPS plan should keep PostgreSQL private. | `docs/DEPLOYMENT.md` | TBC | Open — P0? | Production move |
| OI-05 | Hostinger VPS not provisioned | Infra | S2 | Prerequisites listed in `docs/technical/TECHNICAL_HANDOVER.md` §9; nothing deployed. | P3 brief | TBC | Open | |
| OI-06 | Demo records in production | Data | S2 | DEMO clients, contracts, visits (2026-10-31) and DEMO invoices DEMO-INV-001..003 (2026-11-02) were entered in production with approval. They count in live KPIs and reports. Removal requires a separately approved plan. | Release records | Project owner | Open | Before client sign-off |
| OI-07 | Paid visit on a cancelled contract | Decision | S3 | Stays Scheduled, keeps its number, leaves Accounts and Paid figures. Awaiting decision. P1 commit `3e2cb28` (not merged) counts Completed or Paid services of cancelled contracts — re-check at integration. | `docs/FINANCE_WORKFLOW.md` | Client finance | Open — P1? | |
| OI-19 | Switches delivered off by P1 | Decision | S3 | P1 `3e2cb28` adds controlled contract expiry (`AMC_CONTRACT_EXPIRY_ENABLED`) and the Service Report No. lock after Paid (`SERVICE_REPORT_NO_LOCK_ENABLED`), both off pending approval. Docs describe the "off" behaviour. | P1 branch | Project owner | Open — P1 | Integration |
| OI-08 | `AMC_EXECUTION:APPROVE` has no effect | Decision | S3 | Reopening completed services was removed by the completion lock; the permission is labelled "No effect at present". Retire or keep. | `docs/SERVICE_REPORT_COMPLETION_LOCK.md` | Project owner | Open | |
| OI-09 | Completed services without a report | Decision | S3 | Legacy completed services without a Service Report cannot be given one afterwards. Decide if retroactive upload is wanted. | same | Client operations | Open | |
| OI-10 | Unconfirmed business rules | Decision | S2 | CLAUDE.md §16 items remain open: wider meaning of Final Credit, exact frequency options, billing vs maintenance frequency, rescheduling, multiple invoices per visit, job-number format, project/procurement workflows, split payments, formal margin, VAT configuration, approval hierarchy, site execution fields, attachment requirements. | `CLAUDE.md` §16 | Client | Open | |
| OI-11 | Projects / Procurement have no screens | Decision | S2 | Removed from the web app on 2026-10-27 at the client's revised scope; APIs and data kept. No new job can be created; Expenses only against existing jobs. Confirm with the client that this is the intended Phase 1 scope. | `docs/OBSOLETE_MODULES_REMOVAL.md` | Client | Open | |
| OI-12 | Time zone of "today" | Decision | S3 | Overdue / due logic uses the database's `current_date`. Neon runs in UTC, so "today" changes at 04:00 Oman time. Confirm or set a time zone. | Hosting notes | TBC | Open — verify | |
| OI-13 | Supabase round-trip in production not exercised | Infra | S2 | Storage health check passes in Security Center, but no real production upload/download was performed after release (needs approval to create a record). | Release 2026-11-04 | Project owner | Open | |
| OI-14 | Free-plan limits | Infra | S3 | Render sleeps when idle (first request ~1 min); rate-limit counters reset on restart; Neon free history is short. | `docs/DEPLOYMENT.md` | TBC | Accepted for review | Production move |
| OI-15 | Alpha preview builds call the production API | Infra | S3 | Pages previews (e.g. alpha) are built with the production `VITE_API_BASE_URL`; CORS blocks them unless listed. A separate preview API was recommended. | Hosting notes | TBC | Open — verify | |
| OI-16 | Branch protection / CI not configured | Infra | S3 | GitHub rules are an agreement only. | `GIT_WORKFLOW.md` | TBC | Open | |
| OI-17 | Help and user guide depend on P0/P1 outcomes | Doc | S2 | Sections flagged in `docs/handover/PROJECT_COMPLETION_REPORT.md` §5 must be re-checked after the P0 and P1 branches are integrated. | This branch | Integrator | Open | Final integration |
| OI-18 | November 9 audit not available to P3 | Doc | S3 | The audit referenced by the P3 brief was not found; this register and the UAT checklist were built from repository documents and code. | P3 brief | Project owner | Open | |

## Closed items

| ID | Title | Closed on | How |
|---|---|---|---|
| | | | |
