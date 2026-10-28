# AMC Management

Route: `/amc/management` (navigation: Operations → AMC Management).
API: `GET /api/amc/management/summary` (read-only).
Status: built 2026-10-28 on local `alpha`, uncommitted. No migration. No scheduled job.

AMC Management is the administrative control center for AMC contracts. It reads; it does not
store anything new. The only action that writes is **+ New AMC**, which opens the existing
contract form (`ContractFormModal`, `POST /api/amc/contracts`).

## Permissions

| Part | Needs |
|---|---|
| Page, navigation item, endpoint | `AMC_CONTRACTS:VIEW` |
| Contract KPIs, Recent AMC Contracts, Expiry & Renewal | `AMC_CONTRACTS:VIEW` |
| Schedule KPIs (counts) | `AMC_SCHEDULE:VIEW` or `AMC_EXECUTION:VIEW` |
| Schedule Pending Billing, Current Scheduled Value (amounts) | `AMC_SCHEDULE:VIEW` |
| Invoice KPIs | `INVOICES:VIEW` |
| + New AMC | `AMC_CONTRACTS:CREATE` |

The API leaves out (null) every section the user may not see; the page hides the matching
cards and actions. No permission was added or widened.

## Top-level actions

| Action | Goes to | Shown when |
|---|---|---|
| Schedule Engine | `/amc/schedule` (the visit schedule the engine generates) | `AMC_SCHEDULE:VIEW` |
| Invoices | `/invoices` | `INVOICES:VIEW` |
| Alerts | `/notifications` | always |
| Reports | — shown disabled, "not built yet": there is no Reports page | always |
| + New AMC | opens the Add AMC Contract form in place | `AMC_CONTRACTS:CREATE` |

## KPI formulas

Dates are the database's `current_date`, as everywhere else in STSLV AMC.

### Contract KPIs (same query as the dashboard: `contractKpis` in `dashboard/operations.service.ts`)

| KPI | Formula |
|---|---|
| Active AMC | count of contracts with status `ACTIVE` |
| Total AMC Value | `sum(contract_value)` over `ACTIVE` contracts. Not annualised, not invoiced, not collected. |
| Total Final Credit | `sum(final_credit)` as entered, over `ACTIVE` contracts. **Meaning unconfirmed** (client question AMC-5); never called revenue. |
| Expiring within 45 days | `ACTIVE` contracts with `valid_to` between today and today + 45. Each once, renewed or not; how many have a renewal is shown beside it. |

### Schedule KPIs

"Counted visits" = status not `CANCELLED`/`HISTORICAL`, on a contract that is not `CANCELLED`
(`COUNTED_VISIT`, shared with the dashboard and the workload report).

| KPI | Formula |
|---|---|
| Services This Month | counted visits with `scheduled_date` in the current month (`getWorkload`, first month) |
| Schedule Pending Billing | visits with invoice eligibility `READY_FOR_INVOICE` (completed, amount > 0, no active invoice; `v_amc_visit_billing`), count and `sum(visit_amount)`. Also shows completed visits with no amount (`AMOUNT_REQUIRED`). Future visits are never pending billing. |
| Current Scheduled Value | `sum(visit_amount)` over the counted visits of the current month, with the number of those visits that have no amount. A planned amount, not invoiced or collected. |
| Schedule Engine Status | "In sync" when every `ACTIVE` contract has at least one visit that is not cancelled or historical; otherwise "Attention" with the number that have none. The engine runs when a contract is saved or regenerated; there is no background job. |

### Invoice KPIs

Invoices are `ISSUED` or `CANCELLED` only (migration 0060). **Payment is not recorded**, so:

| KPI | Shown |
|---|---|
| Paid Invoices | Not available (reason from the API) |
| Unpaid Invoices | Not available |
| Paid Invoice Total | Not available |
| Invoice Module Status | "Tracking", with the counts of issued and cancelled invoices and "payment not recorded" |

An invoice number is never treated as proof of payment.

## KPI customization

Each group (Contract, Schedule, Invoice) has its own **Customize**, **Reset KPI Names** and
**Reset KPI Order**. In Customize mode each card has a display-name field (max 40 characters,
empty = standard name) and earlier/later buttons; cards can also be dragged.

Persistence: browser `localStorage`, per user id and per group
(`stslev.amc-management.<group>.kpi-names.<userId>`, `….kpi-order.<userId>`), the same mechanism
as the dashboard's KPI layout. It is per user **in this browser only**: it does not follow the user
to another browser or device. Server-side per-user preferences would need a new table
(migration) — not built, needs approval.

A renamed card keeps its meaning: the standard name is on hover and read by screen readers.

## Expiry & Renewal

### Bands

Supplied with the AMC Management requirements (reference AMC ERP): 90, 60, 45, 30 and 15 days
before `valid_to`. A contract is in exactly one band — the smallest limit at or above its days
left: 90 = 61–90, 60 = 46–60, 45 = 31–45, 30 = 16–30, 15 = 0–15. Only `ACTIVE` contracts.

A contract is **renewed** when a renewal of it exists that is not cancelled (the rule of
migration 0072's unique index and of Service Status).

### Figures

| Figure | Formula |
|---|---|
| Band count / not renewed | per band: active contracts in it / of those, not renewed |
| Renewal warning | not-renewed `ACTIVE` contracts with 0–45 days left (all bands up to 45) |
| Critical — expiring within 15 days | `ACTIVE` contracts with 0–15 days left, each once |
| Not Renewed & Expired | contracts with status `EXPIRED`, or `ACTIVE` with `valid_to` before today, that are not renewed. Draft and cancelled contracts are excluded. |

No double counting in renewal chains: a renewed source is left out of "not renewed" figures,
and its renewal is counted on its own dates.

### Alerts (in-app notifications)

Worked out on request (no stored alerts), for users with `AMC_CONTRACTS:VIEW`:

* `contracts.renewal_warning` — the renewal warning; `pinned`: always listed while it applies.
* `contracts.expiry.ninety|sixty|forty_five|thirty|fifteen` — one per band with unrenewed
  contracts (30 and 15 are "Needs attention", the others "For information").

Read state is per user (`notification_reads`, migration 0073). The fingerprint is the list of
contract ids in the alert, so a read alert becomes unread when a contract enters it. Marking an
alert read never hides it, from that user or any other. **True per-user dismissal (hiding)** is
not built: it needs a new column or table (migration) and approval.

Also fixed: the existing "Active contracts past their validity" alert linked to `/reports`, which
has no page; it now links to `/amc/management`.

### Renewal

Unchanged: renewing is done from the contract page (`POST /api/amc/contracts/:id/renewals`),
which creates a new contract linked by `renewed_from_id`; the original stays unchanged. Chains
are protected: there is no delete endpoint for contracts, and `renewed_from_id` is
`ON DELETE RESTRICT`.

## Automatic expiry processing — not built (needs approval)

There is no scheduler, cron or background job in STSLV AMC. Contracts are never expired
automatically: a user changes an `ACTIVE` contract past validity to `EXPIRED` from the contract
page. Expiry alerts need no job, because they are computed on every request.

Proposed design, if approved:

1. **Business rule first.** Confirm with the client when an Active contract becomes Expired
   (on the day after `valid_to`? only if not renewed? what happens to its open visits?). This is
   a status change on financial/operational records, so it must not be guessed.
2. **One idempotent service function**, e.g. `expireContractsPastValidity(asOf)`, in
   `amc/contracts.service.ts`, reusing the existing status-change path so each change is
   validated, written in a transaction and recorded in the activity log with a system actor.
   It changes only `ACTIVE` contracts with `valid_to < asOf`, never touches renewals, and running
   it twice changes nothing the second time.
3. **A CLI script** (`npm run contracts:expire -- --dry-run`) that prints what it would change;
   applying needs an explicit flag.
4. **Scheduling outside the web process** (Render cron job or the host's scheduler) running the
   script once a day, so a restarted or scaled web server never runs it twice. A system user
   would need to exist for the activity log (migration or seed: needs approval).
5. **Rollout:** dry-run on a copy of the data, review the list with the client, run once by hand,
   then enable the schedule. Neon/production only with explicit approval.

## Open items

* Final Credit meaning (client question AMC-5).
* Total AMC Value counts Active contracts only (consistent with the dashboard); confirm whether the
  client expects Draft/Expired included.
* "AMC-0007" references are derived from the id (provisional, as in Service Status).
* Payment tracking (paid/unpaid) does not exist in the data model.
* Reports page does not exist.
* Server-side KPI preferences and alert dismissal need migrations.
* Daily expiry job (above).

## Tests

* Web: `src/test/amc-management.test.tsx` (page, actions, every KPI, customization and reset,
  per-user isolation, recent contracts, expiry, empty/loading/error, permissions, responsive grid
  classes); `src/test/notifications.test.tsx` (pinned renewal warning).
* API: `tests/amc-management.test.ts` (bands, figures vs base tables, renewal chains, deletion
  protection, read-only, permissions, expiry alerts and per-user read state);
  `tests/notifications.test.ts` (link fix).
