# STSLV AMC — Implementation Progress

Local development record for the module programme started on 2026-10-26.
Functional guidance came from an independent reference specification kept
outside this repository; no reference-system code, data or records are used.

Nothing here has been pushed or deployed. Commits are local only.

## Checkpoints

| Commit | Content |
|---|---|
| `a03fd4b` | Checkpoint: Invoice Tracking, report exports, historical-data updates |
| `6f7be39` | M1 security: login rate limits, failed-login logging, dependency fixes |
| `a2ec128` | F1 AMC Contract 360 page |
| (uncommitted) | Modules below, pending review |

## Modules

Status: DONE = built, tested, reachable locally. NEEDS MIGRATION = built and
tested on the isolated test database; works on `stslv_amc_dev` only after the
listed migration is approved and applied. BLOCKED = waits for a business
decision; nothing was invented to get round it.

| # | Module | Status | Local URL |
|---|---|---|---|
| 1 | Login History | DONE | `/admin/login-history` |
| 1 | Audit Log (built-in Admin role only) | DONE | `/admin/audit-log` |
| 2 | Master Data: sales engineers, system types, departments | NEEDS MIGRATION 0070 | `/admin/master-data` |
| 2 | Contract links to master records | NEEDS MIGRATION 0070 | contract page → Contract overview → Master records |
| 3 | Documents: contract documents, procurement quotations, expense receipts; versions; checksum; authorised download | NEEDS MIGRATION 0071 | contract page → Documents; procurement and expense details |
| 3 | Durable storage for the hosted application | BLOCKED (storage decision; uploads are off in production until `ATTACHMENTS_DIR` is set on purpose) | |
| 4 | Expiring contracts (read-only, user-chosen window) | DONE | `/reports` → Expiring contracts |
| 4 | Create renewal (new linked contract, source unchanged), renewal links, renewal history | NEEDS MIGRATION 0072 | contract page → Renewals; `/reports` → Renewal history |
| 4 | Renewal queue statuses, automatic expiry, expiry-band notifications | BLOCKED (thresholds and workflow not confirmed) | |
| 5 | Contract history: new actions labelled (master links, renewals, documents) | DONE | contract page → Contract history |
| 5 | Archive workflow, required cancellation reason | BLOCKED (semantics not confirmed); no delete, no trash | |
| 6 | AMC Calendar (month grid, phone list view, filters, visit details) | DONE | `/amc/calendar` |
| 6 | Service report no. / quotation no. per visit | BLOCKED (meaning and validation not confirmed) | |
| 7 | Notifications: bell with unread count, notifications page, per-user read state; alerts only from figures STSLV already defines | NEEDS MIGRATION 0073 | header bell, `/notifications` |
| 7 | Further notification events, email/SMS | BLOCKED (events not approved; no external services) | |
| 8 | Security viewing (Login History, Audit Log filtered to module "Sign-in and accounts") | DONE | as module 1 |
| 8 | Sessions, single-session, timeouts, password policy | BLOCKED (authentication change needs explicit approval) | |
| 9 | Reports: portfolio, expiring, renewal history, workload chart and table, upcoming, overdue, billing (invoiced is never called paid) | DONE | `/reports` |
| 9 | New report exports | BLOCKED (earlier decision: no further module exports until export samples are approved) | |
| 10 | Navigation, permissions, responsive checks, full test runs, browser walk-through | DONE | |

## Master Data Center (2026-10-27)

Sidebar section **Master Data Center** with **Clients** (`/clients`, CLIENTS) and **Sales Engineers** (`/master-data/sales-engineers`, SETTINGS). Clients moved out of Operations; the admin page `/admin/master-data` now holds only System Types and Departments (renamed "System Types & Departments").

| Reference item (01-master-data, VERIFIED) | STSLV |
|---|---|
| Client fields name (required), contact person, phone, email, address, remarks | existing (remarks = notes) |
| Client type Company/Individual, VAT number | added, migration 0074 (optional, not unique) |
| Client list: search name/VAT/phone/email, status filter, View and Edit | done; plus type filter, sort, paging |
| Client View (separate from Edit) | quick view pop-up and full client page `/clients/:id` with AMC contracts and history |
| Sales engineer fields name (required), employee no., user link, email, phone, department | done (migration 0070) |
| Engineer list: engineer, employee no., department, contact, user link, status, actions | done; plus View page, sort, paging |
| Soft delete only (deactivate, never delete) | done for both |
| Engineer selected on AMC contract | optional picker on the contract form (link only; typed engineer kept) |
| Codes CL-000x / SE-000x | not built: INFERRED numbering, rule unconfirmed (like job numbers) |
| Three statuses Active/Disabled/Archived | not built: STSLV keeps active/inactive until the meaning of Archived is confirmed |
| Column hide toggle, PDF/Excel buttons on the lists | not built: exports wait for the export-sample approval |

Endpoints added: `GET /api/clients/features`, `GET /api/clients/:id/history`, list sort/filter (`sort`, `direction`, `clientType`), `GET /api/masters/:type/:id/history`, master list `sort`/`direction`, `salesEngineerId` on `POST/PATCH /api/amc/contracts` and `GET /api/amc/contracts?salesEngineerId=`.

On a database without 0074 the Clients module works as before and only a type or VAT value is refused ("database update not applied"); without 0070 the Sales Engineers pages say so and the contract form shows no engineer picker.

## API endpoints added

| Endpoint | Permission |
|---|---|
| `GET /api/audit/logins` | USERS:VIEW |
| `GET /api/audit/activity`, `GET /api/audit/activity/options` | built-in Admin role |
| `GET /api/amc/reports/expiring?days=` | AMC_CONTRACTS:VIEW |
| `GET /api/amc/reports/workload?months=` | AMC_SCHEDULE:VIEW |
| `GET/POST/PATCH /api/masters/{departments,sales-engineers,system-types}`, `.../:id/status`, `.../options` | read: SETTINGS:VIEW or AMC_CONTRACTS:VIEW; change: SETTINGS:CREATE / EDIT |
| `GET/PUT /api/amc/contracts/:id/masters` | AMC_CONTRACTS:VIEW / EDIT |
| `GET /api/attachments?entityType=&entityId=`, `POST /api/attachments` (raw file), `GET/POST /api/attachments/:id/versions`, `GET /api/attachments/:id/download` | the record's module: VIEW to list and download, EDIT to upload |
| `GET/POST /api/amc/contracts/:id/renewals`, `GET /api/amc/reports/renewals` | AMC_CONTRACTS:VIEW / CREATE |
| `GET /api/notifications`, `POST /api/notifications/:key/read`, `POST /api/notifications/read-all` | any signed-in user; alerts filtered by permission |

Successful sign-ins now also record the network address (`metadata.ip`), as
failed ones already did.

## Migrations awaiting approval

Each is additive and has reversal notes at the top of the file. None has been
applied to `stslv_amc_dev` or Neon. The test suite applies them to the
isolated `stslv_amc_dev_projects` / `stslv_test` schema only.

| File | Adds |
|---|---|
| `0070_master_data.sql` | `departments`, `sales_engineers`, `system_types`; nullable `amc_contracts.sales_engineer_id` / `system_type_id` |
| `0071_attachments.sql` | `attachments` (metadata, version, checksum; no file contents) |
| `0072_contract_renewals.sql` | nullable `amc_contracts.renewed_from_id`; at most one open renewal per contract |
| `0073_notification_reads.sql` | `notification_reads` (per-user read marks) |
| `0074_client_details.sql` | nullable `clients.client_type` (COMPANY/INDIVIDUAL) and `clients.vat_number` |

Until a migration is applied, its features answer `503 FEATURE_UNAVAILABLE`
and the pages say so; every existing page keeps working.

To apply (after approval, with a fresh backup first): `npm run migrate:status`
then `npm run migrate` in `stslv-api`.

## Business decisions required

1. Expiry warning thresholds and whether contracts expire automatically (renewal queue and expiry notifications depend on this).
2. Renewal workflow: statuses after a contract enters renewal, and what happens to the original contract.
3. Archive semantics for contracts; cancellation reason required or optional.
4. Meaning and validation of a service report number and a quotation number on a visit.
5. Which events create in-app notifications, and for whom.
6. Attachment storage for the hosted application (Render's disk is not permanent), allowed file types and size limit.
7. Session policy: idle and absolute timeouts, single session for administrators, password complexity.
8. Whether to map existing free-text engineers and systems to the new master lists (no automatic mapping is done).

## Configuration added

| Setting | Default | Purpose |
|---|---|---|
| `ATTACHMENTS_DIR` | local: `stslv-api/storage/attachments` (git-ignored); production: none, so uploads are off | where attachment files are kept |
| `ATTACHMENT_MAX_MB` | 10 | largest file accepted (PROVISIONAL) |

## Verification (2026-10-26)

- API typecheck: pass. API tests: 41 files, 777 tests passed, on `stslv_amc_dev_projects` / schema `stslv_test` only.
- Web typecheck and lint: pass. Web tests: 26 files, 412 tests passed.
- Browser walk-through (headless Edge, isolated stack with migrations 0070-0073 in the test schema, invented records): Login History, Audit Log, AMC Calendar (desktop and 390 px phone width, no horizontal scroll), Reports, Master Data (added a system type through the form), contract page (master records panel, Renewals, Documents with a PDF upload), Notifications. No console errors, no failed API requests.
- `stslv_amc_dev`: read-only `migrate:status` shows 0070-0073 pending; nothing applied. On this database the new features answer "database update not applied yet" and every existing page works as before.

### Master Data Center verification (2026-10-27)

- API: 43 files, 793 tests passed (isolated schema). Web: 27 files, 425 tests passed. Typecheck and lint pass.
- Browser (headless Edge, isolated stack): client create with validation → type/VAT saved → found again by VAT search after reload → client page → edit → history; engineer create with validation → view → edit; contract created with the engineer picked (typed name filled); contract shown on both the client and engineer pages; engineer deactivated and the link kept; phone width without horizontal scroll on all four pages. No console errors, no failed API requests.

## Where to resume

1. Approve (or not) migrations 0070-0073 for `stslv_amc_dev`, after a fresh backup.
2. Review and approve a local commit of these modules.
3. Answer the business decisions above to unblock the BLOCKED items.

## AMC Operations Dashboard (2026-10-27)

`/dashboard` replaced by the AMC Operations Dashboard: seven KPIs, maintenance calendar with service details, workload chart, payment trend, portfolio status, expiring contracts, recent invoices, production readiness. No migration. Details, calculation rules and permissions: `docs/DASHBOARD_UI.md` section 0.

- New endpoints: `GET /api/dashboard/operations`, `GET /api/dashboard/calendar?month=`, `GET /api/dashboard/readiness` (built-in Admin).
- Payment is not tracked (invoices are Issued/Cancelled only): Unpaid Invoices, Paid This Month and Payment Trend show "Not available".
- Demo seed `stslv-api/src/scripts/seed-dashboard-demo.ts` (fictional, idempotent, dry run by default) used only on `stslv_amc_dev_projects` / `stslv_dashboard_demo`.
- Verification: API 44 files / 814 tests and web 24 files / 356 tests passed; typecheck, lint and both builds pass; headless Edge walk-through on the isolated stack (no console errors, no failed requests, no horizontal scroll at 390/820/1440 px); read-only service run on `stslv_amc_dev`.
