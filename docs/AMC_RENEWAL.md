# AMC Renewal

Route: `/amc/renewal` (Operations → AMC Renewal). Branch `feature/amc-renewal`, 2026-10-28.
No migration: the module reads and writes through the renewal link of migration 0072 (`amc_contracts.renewed_from_id`).

## Model

A renewal is a **separate AMC contract** whose `renewed_from_id` points to the contract it renews (the source).
Creating, approving or cancelling a renewal never changes the source contract, its visits, invoices, quotations or history.
The source keeps its own status (Active until a user marks it Expired; contract status never changes by itself).

A source has at most one renewal that is not cancelled (unique index `amc_contracts_one_open_renewal_uq`).
A cancelled renewal is kept for the record and does not block a new one.

The AMC reference is derived from the contract id (`AMC-0042`), so a renewal always has a new, unique reference.

## Renewal states (derived, never stored)

| State | Rule (first that applies) |
|---|---|
| Under Client Approval | the open renewal is a Draft |
| Renewed | the open renewal is Active or Expired |
| Cancelled | every renewal made was cancelled; stays here until a new renewal is started |
| Due / Expired | no renewal; the source is Active or Expired and `valid_to <= current_date + 45` (ended contracts included, no look-back limit) |

Contracts matching none (e.g. Draft or Cancelled sources with no renewal, or ending in 46+ days) are not on the queue.
Eligibility is computed from `current_date` on every request: no scheduled job.

Decisions confirmed by the user on 2026-10-28: Cancelled stays Cancelled; Expired-status contracts are included;
Remarks shows contract notes read-only (the open renewal's notes, otherwise the source's); on this page a renewal
is always created as a Draft and approval activates it (the API and the contract page are unchanged).

## Lifecycle and actions

| Action | Available in | Call | Permission |
|---|---|---|---|
| Start / Restart Renewal | Due, Cancelled | `POST /api/amc/contracts/:id/renewals` (status DRAFT, with `salesEngineerId`) | AMC_RENEWAL:CREATE |
| Approve | Under Client Approval | `POST /api/amc/contracts/:renewalId/status` ACTIVE (generates the renewal's schedule) | AMC_CONTRACTS:EDIT |
| Cancel | Under Client Approval | `POST /api/amc/contracts/:renewalId/status` CANCELLED | AMC_CONTRACTS:EDIT + DELETE |

All existing routes, so validation, transactions, locking and audit entries are the same as on the contract page
(`amc_contract.renewal_created` on the source, `amc_contract.renewal_of` and `amc_contract.status_changed` on the renewal).

Fix included: reactivating a cancelled renewal while its source already has another open renewal now returns
409 with a clear message (previously the unique index raised an unhandled 500). The source row is locked first.

## Sales Engineer on every renewal (approved 2026-10-29)

Every AMC renewal must name an **active Sales Engineer** from the Sales Engineers master list. This applies
whether the renewal starts on this page or on the contract page, and even when the contract being renewed had
no engineer. A new contract that is not a renewal is unchanged: its engineer stays optional.

| Contract being renewed | Renewal form | Saving |
|---|---|---|
| Has an active engineer | That engineer is preselected; the user may choose another active engineer. | Saved with the chosen engineer. |
| Has an inactive engineer | Shows "Previously assigned: <name> (inactive)". Nothing is preselected and the inactive engineer is not offered. | Blocked until an active engineer is chosen. |
| Has no engineer | "A renewal needs an active sales engineer." | Blocked until an active engineer is chosen. |

- "Not linked" is not offered on a renewal. The engineer is never replaced by someone the user did not choose.
- The rule is enforced in the API, whatever the screen sends: `POST /api/amc/contracts/:id/renewals` without an
  active `salesEngineerId` returns 400 with the error on field `salesEngineerId`, and nothing is created
  (`assertRenewalEngineerChosen` and the active check in `applyContractMasters`).
- A role that may renew but cannot read the Sales Engineers list sees an explanation and cannot save. The six
  standard roles were checked: Super Admin, Admin and AMC Operations Executive can renew and can read the list.
- Before go-live, at least one active Sales Engineer must exist, otherwise no contract can be renewed.

## API (new, read-only)

- `GET /api/amc/renewals/queue?search&renewalStatus&page&pageSize` — rows, `kpis {due, underApproval, renewed, cancelled}` (over the search, not the status filter), `windowDays`, `today`. AMC_CONTRACTS:VIEW.
- `GET /api/amc/renewals/queue/export?format=xlsx|pdf&search&renewalStatus&hidden` — VIEW + EXPORT; audit `amc_renewal_queue.exported`.
- `GET /api/amc/reports/renewals/export?format=xlsx|pdf` — VIEW + EXPORT; audit `amc_renewal_history.exported`.
- `GET /api/amc/reports/renewals` (existing) now also returns `createdOn`, the creation day in the database time zone.

## Eligibility across modules (open: shared rule proposed, not applied)

| Module | Statuses | 45-day window | Renewed contracts |
|---|---|---|---|
| AMC Management renewal warning, Notifications | Active | yes | excluded |
| Monthly Calendar warnings (`/reports/expiring`) | Active | yes | **included** |
| Dashboard expiring list | Active | configurable | included, shown with their renewal |
| Renewal Queue "Due / Expired" | Active + Expired | yes | excluded; cancelled-renewal contracts shown as Cancelled |

Proposed shared rule: *a contract needs renewal when its status is Active or Expired, it ends within 45 days or has
ended, and it has no renewal that is not cancelled.* Applying it would change the Calendar (drop renewed contracts)
and Management/Notifications (add Expired-status contracts). Not changed here; needs approval.

## Browser smoke test (2026-10-28)

Headless Edge against the worktree (API 3101, web 5273) and the isolated database `stslv_amc_smoke_renewal`
(seeded test data only). Covered: queue states and 45-day boundary, KPIs, search, status filter and KPI links,
hidden columns, KPI rename/reorder/reset, Excel and PDF exports of both tabs (content checked), Start Renewal,
Approve, Cancel, Restart Renewal, duplicate-renewal and reactivation conflicts, audit entries, Execution /
Accountant / Procurement permissions in UI and API, 390 px and 768 px layouts, dark mode. Source contracts,
their visits and invoices were byte-identical before and after (including `updated_at`).

Fix from the smoke test: at 1440 px the queue table was 75 px wider than its frame and the Actions column was
clipped. The Actions column is now pinned to the right edge of the scrolling table (`STICKY_ACTIONS`).

## Open questions

- Should approval require AMC_CONTRACTS:APPROVE instead of EDIT? Today it follows the existing status-change permission.
- Must a renewal's validity start after the source ends? Not enforced (no existing rule).
- Should a renewal record who approved it and when, beyond the audit log? Would need a migration.
- Should "Due / Expired" have a look-back limit for long-ended contracts that were never renewed?
