# STS-ELV client fixes — 2026-11-09

Branch `feature/sts-elv-client-fixes-20261109`, worktree `D:\Projects\STSLV-AMC-client-fixes`, based on the verified
P0–P3 integration commit 249a68b. Local only: not pushed, not merged, not deployed.

Excluded and unchanged: Dashboard (functions, cards, values, layout, expiry widgets), Invoice Acknowledgements, Backup &
Restore, Hostinger VPS. The only Dashboard file touched is a one-line brand text in its header
(`STSLEV AMC · Operations Suite` → `STS-ELV AMC · Operations Suite`), part of the application-wide name correction,
and one code comment in `pages/dashboard/style.ts`.

Production switches unchanged and off: `AMC_CONTRACT_EXPIRY_ENABLED`, `SERVICE_REPORT_NO_LOCK_ENABLED`.

## 1. Name: STS-ELV

User-visible "STSLEV AMC" is now "STS-ELV AMC": browser title, login, sidebar and header, loaders, cookie notice,
feedback, settings, users dialog, help panel and topics, export/PDF system name (`shared/export/branding.ts`),
registration email subject and text, the API health message and start-up line, the historical import report title.

Not changed, on purpose: browser storage keys (`stslev.*`, renaming would reset every user's saved layout), routes,
environment variables, database identifiers, storage paths, the repository name and deployment templates
(`stslv-amc` names on the VPS are infrastructure, excluded).

Login identities are **not** changed. The local development Admin is `admin@stslev.com` (an email address, used to
sign in). Changing it is an authentication change and needs the owner's approval; if approved, change it through
Users & Access (or the documented Admin email procedure), on each environment separately. No migration is needed.

`stselv` and `stselvamc` were added to the weak-password word list (API and web), next to the existing `stslev`.

## 2. AMC Contracts — due and expired

**Root cause.** The register's only status filter compared the *stored* status. The automatic expiry run is switched
off until release (`AMC_CONTRACT_EXPIRY_ENABLED`), so a contract past its Valid To stays stored as Active. The Expired
figure (and AMC Management, AMC Renewal) use the rule "status Expired, or Active with Valid To before today", so they
reported an expired contract that Status → Expired could not list. No data was wrong.

**Fix.** A new **Validity** filter (`validity=all|due|expired`, API, page and export), independent of the stored status:

| Value | Rule (existing rules, reused) |
|---|---|
| Expired | status Expired, **or** Active with Valid To before today — the Expired figure's own SQL (`CONTRACT_VALIDITY_FILTERS.expired`, now shared by both) |
| Due | Active, Valid To today or within 45 days — the AMC Renewal queue window (`RENEWAL_WARNING_DAYS`) |

Reading never changes a stored status. A renewed contract stays listed (a renewal never hides the original). The page
also accepts `?validity=due|expired` in its address.

**Time zone.** "Today" stays the database's `current_date`, as on every other page (AMC Management, AMC Renewal and
the Dashboard), so the figures agree. Finding: the local database runs in `Asia/Calcutta`, Neon in UTC. Between
00:00 and 04:00 Oman time a UTC database still has yesterday's date. Moving every page to `Asia/Muscat` would change
the Dashboard (excluded), so it is listed as an open item. The P1 expiry job already measures in Asia/Muscat.

**Contract column.** The Contract column (Upload Contract link) is now in Hide Columns, remembered in the same browser
store as the other columns. It is a page-only column: never sent to the export, which has no such column.

## 3. AMC Renewal

- **Start Renewal** (now also the button's name on the contract page) opens the Add AMC Contract form, filled from the
  contract being renewed, with a panel naming that contract (number, client, system, validity).
- An **updated renewal contract document is required** (PDF or Word, size limit as for contracts). It is checked
  (name, size, content type) before anything is stored, written to the existing private document storage, recorded in
  the renewal's own transaction with an `attachment.uploaded` Audit Log entry and the title "Renewal contract
  document", and removed from storage again if the renewal is not created. The old contract's document is never
  reused. The route reads its larger body only after sign-in and the AMC_RENEWAL:CREATE check (as Add AMC Contract).
- The original contract is unchanged (record, documents, schedule, history); the link (`renewed_from_id`) and both
  Audit Log entries are kept as before.

### 3a. Same visible contract number — versions (owner approval 2026-11-09, migration 0111)

The first pass left this open because each number belonged to exactly one contract (0105/0107). The owner approved
option 2 in its versioned form: the original and every renewal show the **same** contract number, and each renewal is
its own contract period with a unique internal identity and version.

| Period | `amc_reference` (visible) | `id` (identity) | `version_root_id` | `contract_version` | Shown as |
|---|---|---|---|---|---|
| Original | STS-AMC-001 | 7 | 7 | 1 | STS-AMC-001 |
| First renewal | STS-AMC-001 | 12 | 7 | 2 | STS-AMC-001 (V2) |
| Second renewal | STS-AMC-001 | 15 | 7 | 3 | STS-AMC-001 (V3) |

**Why this design.** Each period stays its own `amc_contracts_all` row, so its `id` — which visits, invoices
(allocations), documents, the Audit Log, renewal links and every report already use — keeps every record on the
correct period. Nothing that refers to a contract changes, and no number, value or history is rewritten. The two
alternatives were rejected: a separate "display number" column would leave two numbers per contract, and a suffix
rule changes the number the client sees.

**Integrity (no weaker than before).**
- `amc_contracts_reference_uq` keeps its name; it is now "unique among version-1 (original) contracts". A trigger
  forces every later version to carry exactly its original's number, and `(version_root_id, contract_version)` is a
  unique constraint. Together a number still belongs to exactly one contract chain, and no other contract can take
  it (tested: a new contract with the number gets 409; another original renamed to it is refused by the database).
- `amc_contracts_version_ck`: version ≥ 1, and version 1 ⇔ `version_root_id = id`. FK `version_root_id` →
  `amc_contracts_all(id)`.
- Trigger `amc_contracts_version_check`: a later version's root must be a version 1 (`amc_contracts_version_root_ck`),
  its number must equal the root's (`amc_contracts_version_reference_ck`), and the contract it renews must be in the
  same chain (`amc_contracts_version_link_ck`) — no cross-version or cross-chain links.
- Versions are assigned in the renewal's transaction after locking the original (`SELECT … FOR UPDATE`), as
  max + 1; the unique constraint also refuses a duplicate. A cancelled renewal keeps its version; the next renewal
  takes the next one (never reused).
- Number history (0107) is per number, owned by the original; a later version never adds or retires a number. Renaming
  the number on any version renames the original, and a trigger renames every version with it in the same
  transaction. A number given up stays retired for every other contract (as before).

**Workflow.** Start Renewal shows the original's number read-only ("The renewal keeps contract number … and is saved
as the next version of it"); the API keeps that number and refuses a different typed number (400, nothing created).
The updated renewal document is still required. Existing rules are unchanged: one open renewal per contract,
draft → approve → active, expiry, permissions (AMC_RENEWAL:CREATE).

**Display.** Lists, reports and exports (Accounts, Service Status, Master AMC Status, Service Sales, Renewal queue and
history, Reports, Monthly Calendar, AMC Contracts export) show `STS-AMC-001 (V2)` from the second version on; version
1 looks exactly as before. AMC Contracts shows a `V2` badge next to the number; Contract 360 shows "Version 2". The
contract API returns `amcReference` (the number, for editing), `contractVersion` and `versionRootId`.

**Existing renewals** made before 0111 keep their own, different numbers: each is version 1 of its own number, still
linked by `renewed_from_id`. Nothing is renumbered (the brief forbids rewriting historical numbers).

## 4. Service Status

- **AMC Value (OMR)** column: the linked contract's AMC Value / Year, read from the contract (not copied). Sent only to
  users holding **AMC Contracts: View** (the permission that already shows contract values); for anyone else the API
  sends `null`, the column is not offered and the export omits it. It is repeated per service, so it is never totalled.
- **Sales Engineer Name**: free text per service (migration 0110), beside Service Report No., saved with the row's
  Save, up to 120 characters, no control characters, trimmed; empty clears. Needs AMC_EXECUTION:EDIT (server-side),
  Audit Log `amc_visit.sales_engineer_name_changed`. Separate from the contract's Sales Engineer master link (0070),
  which still drives the Sales Engineer column, filters and reports. Not covered by the Service Report No. lock.
- Layout: narrower status, report-number and engineer cells, client and engineer names clamped to two lines with the
  full value in the tooltip; the table keeps its own horizontal scroll.

## 5. Accounts

- **View Service Report** under the Service Report No.: a read-only viewer (PDF shown in the page from a blob address;
  Word offers Download), with **Download inside the viewer**, loading, error and "No report uploaded" states. New route
  `GET /api/accounts/:id/report` (ACCOUNTS:VIEW, only visits Accounts lists, `Cache-Control: no-store`, checksum
  checked). No public or storage link. Downloads elsewhere are unchanged. (Accounts had no separate Download action.)
- **Missing values — root cause.** A service has no value when its contract has neither a Billing Basis nor a Cost
  per Visit (the approved rule: no amount is invented). Example in the development database: contract `0001`
  (AMC Value 8000, Final Credit 9000, no basis, no cost per visit). Such rows now say "No Billing Basis or Cost per
  Visit on the contract", and the totals count them as "not included". Fix at the source: set a Billing Basis or Cost
  per Visit on the contract, then Regenerate.
- **Zoho invoice amounts** were not shown anywhere on Accounts (only their numbers). New column **Zoho Invoice Value**
  = sum of the active (not cancelled) invoice allocations of the service (one allocation per invoice and visit, so no
  double counting); also in the export.
- **Filtered totals** (PostgreSQL sums over every row the filters select, all pages): Total Filtered Service Value
  (OMR), its Paid (Invoice No. entered) part, and Total Filtered Invoice Value (OMR). Service value and invoice value
  are never mixed; all amounts are OMR excluding VAT, the only currency.

## 6. Master AMC Status

Same root cause for missing values. The Value cell now also shows the Zoho invoice amount and, for users with AMC
Contracts: View, the contract's AMC Value / Year; a Total Filtered row (service value, Paid value, Zoho invoice value,
services without value) over all pages. The export's columns are unchanged — "Zoho Invoices (Tracking)" and "Zoho
References (Tracking)" stay — and its notes add the Paid and Zoho totals. P1 counting rules are unchanged.

## 7. Service Sales — AMC Value and filtered total (owner approval 2026-11-09)

- **AMC Value (OMR)** column: the AMC Value / Year of each visit's own contract period (`c.contract_value` of the
  visit's contract row; a renewal version has its own value). Read only, in Hide Columns, OMR with three decimals.
- **Total AMC Value of matching contracts**: `SELECT sum(contract_value) FROM (SELECT DISTINCT c.id, c.contract_value
  … same FROM/WHERE as the list) t` — every **unique contract period** with at least one visit matching the active
  filters, on **all pages**. A period with four matching visits counts once; a renewal is its own period. The footer
  says "N unique contract periods, all pages" and "Not an invoice value or a payment". The export puts the same total
  in its notes; the per-row column is never summed (it repeats per visit).
- **Permissions**: the API computes and sends values and the total only when the user holds AMC_CONTRACTS:VIEW
  (`servicesSalesAccess`). Otherwise `amcValue` is null on every row, `amcValueTotal` is null (not computed), the
  page offers no column, and the export has neither the column nor the note. Service Sales' own permissions, filters,
  sorting and layout are unchanged.

## 8. Reports — monthly invoice values

**Root cause.** Monthly Maintenance (and Client-wise / Sales Engineer-wise) grouped services by scheduled month but
showed only Value and Unpaid Value: the invoiced side and the Zoho invoice amounts were missing, and services with no
amount silently counted as 0. Added columns: Paid Value (Invoice No. entered — a reference status, not money
received), Zoho Invoice Value (Invoice Tracking, cancelled left out) and Services Without Value; the service-list
reports gain Zoho Invoice Value. Same scope as Accounts (`IN_SCOPE`), so totals reconcile with Accounts for the same
filters and period. Report access is unchanged (Reports View + source View; Export + source Export).

## 9. Migration 0110

`0110_amc_visit_sales_engineer_name.sql`: nullable `amc_visits_all.sales_engineer_name` with a CHECK, and the
`amc_visits` view re-created with the same definition so it shows the column. Nothing is backfilled or rewritten.
Applied to isolated test databases only. A release applies it when the API starts, so releasing needs approval of
this file too (together with 0108 and 0109 from P0).

## 9b. Migration 0111

`0111_amc_contract_versions.sql`, forward-only: adds `version_root_id` and `contract_version` to `amc_contracts_all`
(backfilled `(id, 1)` with `updated_at` untouched), the constraints and triggers of section 3a, the partial unique
index under the old name, a `CREATE OR REPLACE` of the 0107 history function (skips later versions), an index on
`version_root_id`, and re-creates the `amc_contracts` view to show the columns. Reverse steps are in the file (only
while no version > 1 exists). Releasing needs approval of 0111 with 0108, 0109 and 0110.

## 10. Verification

All on the disposable database `stslv_amc_client_fixes` (schemas `stslv_test`, `upgrade_0110`, `e2e`) and a disposable
copy `stslv_amc_client_fixes_upgrade`. Never `stslv_amc_dev` (read only, for one `pg_dump`), Neon, Supabase or any
hosted service. Both production switches unset (off) throughout.

| Check | Result |
|---|---|
| API suite (after 0111 and Service Sales) | **1,817 passed, 2 skipped** (107 files; + `contract-versions-sales-value.test.ts` 12 tests, `migration-0111-upgrade.test.ts`) |
| Web suite (after 0111 and Service Sales) | **855 passed** (57 files; + `contract-versions-sales-value.test.tsx` 4 tests) |
| First pass (for the record) | API 1,804 passed / 2 skipped; web 851 passed; E2E 24/24 |
| Typecheck, lint, builds | API typecheck and `tsc` build pass; web `tsc -b` and Vite build pass; oxlint exit 0 (13 earlier warnings, none in changed files) |
| Migration 0110, fresh path | applied by every API test run (the test schema is rebuilt from all migrations) |
| Migration 0110, upgrade path | 0109 → 0110 test; plus a rehearsal on a copy of the development database (at 0106): 0107–0110 applied, contract and visit fingerprints (md5 of every row) identical before and after, no value backfilled |
| Migration 0111, fresh and upgrade paths | fresh: every API run; upgrade: 0110 → 0111 test (existing contracts, one renewing another, become version 1 of their own numbers; numbers, values, `updated_at` and history unchanged); rehearsal on the disposable dev copy: 7 contracts, fingerprints identical, all version 1 of their own number, 7 current history entries |
| Browser E2E | **29 / 29** checks on a fresh schema `e2e2` at 0111 (headless Edge over DevTools; web 5411 → API 3411 with its own JWT secret, scratch document folder, mail off; guard: dev API 3001 not running) |

E2E checks: isolation guard; login and STS-ELV title; Validity → Expired / Due; hide and show the Contract column;
Start Renewal form naming the original with its number read-only; renewal refused without the document, then saved
through the file picker as version 2 with the same number; original and renewal both listed under the same number with
a V2 badge, the renewal page showing "Version 2" and its services labelled (V2) on Accounts while the original's are
not; a renewal of version 2 becomes version 3; Service
Status AMC Value; Sales Engineer Name saved and shown after reload beside Service Report No.; Accounts viewer and
Download inside it (file saved); Accounts totals and the missing-value reason; Master AMC Status totals; Service
Sales AMC Value column and unique-contract total (checked against the contracts' own values, page size 1), hidden and
shown again; monthly report totals equal Accounts; Help content; a user without AMC Contracts: View
sees no AMC Value (page and API, including Service Sales and its total), gets 403 on contracts and may still open
the Accounts report; no page-level horizontal scroll at 1440 px and 390 px on AMC Contracts, Service Status, Accounts,
Master AMC Status and Service Sales.

Not exercised in the browser: dark mode, real phones, the Hostinger CSP (the E2E web server sends no CSP).

## 11. Outstanding

1. Same visible contract number on renewal — **done** (section 3a, migration 0111).
2. App-wide "today" in Asia/Muscat — **done** (section 12), Dashboard included.
3. Development Admin login `admin@stslev.com` — change only with approval (section 1).
4. Service Sales money totals — **done** (section 7).
6. Renewals made before 0111 keep their own numbers (not renumbered). If the client wants them merged under one number,
   that is a data change on real records and needs separate approval.
5. PDF preview under the Hostinger CSP (`object-src 'none'`): verify in UAT; the viewer always offers Download.

## 12. Oman business dates everywhere (owner approval 2026-11-09)

**Before.** Every "today" was PostgreSQL `current_date`, which follows the database session's time zone (local:
Asia/Calcutta; Neon: UTC, so "today" changed at 04:00 Oman time). The Dashboard's "paid this month" and payment chart
grouped stored timestamps by the session's month; "Renewed on" and date-range filters on logs used the session's day;
the web app used the browser's clock for its default month, calendar "today" and "days left". Only the P1 expiry job
used Oman time, so modules could disagree for up to four hours a day.

**Now.** One business calendar, Oman (Asia/Muscat), whatever the server, database or browser time zone:

| Where | Helper |
|---|---|
| API SQL "today" (~60 places: Dashboard, AMC Management, AMC Contracts, Renewal queue and reports, Service Status, Schedule/visits, Calendar summaries, Client 360, Sales Engineers, Reports, Procurement and Projects default dates) | `BUSINESS_TODAY_SQL` = `(now() AT TIME ZONE 'Asia/Muscat')::date` |
| Day or month of a stored timestamp ("Renewed on", Renewal History report filter, Dashboard "paid this month" and payment chart) | `businessDateSql(ts)` |
| Date-range filters on stored timestamps (Audit Log, Security Center logs, Suggestions, Recycle Bin) | `businessDayStartSql(date)`: an Oman day starts at 20:00 UTC the evening before |
| Reports' printed time zone, contract expiry job | `BUSINESS_TIME_ZONE` (`REPORT_TIME_ZONE` and `CONTRACT_TIME_ZONE` point at it) |
| Web "today", default month, calendar today, contract "days left", Dashboard heading date, log quick ranges | `lib/businessDate.ts` (`businessToday`, `businessDateOf`, `daysBetween`, `addCalendarDays`, `formatBusinessDayLong`); `todayIso()` in `lib/format.ts` and `amcFormat.ts` delegate to it |

API: `stslv-api/src/shared/business-date.ts`. Web: `stslv-web/src/lib/businessDate.ts`. The Dashboard and AMC
Management now report `timeZone: "Asia/Muscat"`.

**Unchanged.** Stored timestamps stay `timestamptz` (absolute instants; Audit Log and other times display as before).
Date-only fields (Valid From/To, scheduled, completed, invoice dates) are calendar dates and are never shifted or
reinterpreted. No data is changed and **no migration** is needed; the database/session time zone is not changed
(it is not reliable through connection poolers, so every expression is explicit). Renewal, invoice, service-counting,
Paid reference and permission rules, historical numbers and records, Backup & Restore, Invoice Acknowledgements,
Hostinger settings and both production switches are unchanged; the expiry job stays switched off.

**Rule.** A contract is valid through its Valid To date in Oman and expired (Validity → Expired, Expired figure,
"Waiting for Renewal", past validity) from the next Oman calendar day; a service is overdue from the Oman day after
its scheduled date; "this month" is the Oman month.

**Tests.** `stslv-api/tests/business-date-oman.test.ts` (9) runs its database sessions in a time zone that is on a
different calendar day from Oman at that moment (UTC−12 or UTC+14: one always is), and checks Oman midnight
(19:59:59Z / 20:00:00Z), month end, year end, 29 February, day starts for filters, Valid To today vs yesterday across
Contracts, Due/Expired, KPIs, Renewal queue, Service Status, AMC Management and Dashboard, overdue and completion date,
"Renewed on", and "paid this month" at 00:30 on the 1st vs one minute before. Against the previous code 4 of these
fail (verified by stashing the source changes); with this change all pass. `stslv-web/src/test/business-date.test.tsx`
(6) fixes the browser clock at instants around Oman midnight (e.g. 20:30 UTC on 31 December = 1 January in Oman) and
checks the helpers and the contracts page's "Ends today" / "Ended 1 day ago".
