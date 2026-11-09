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

**Not done — owner decision needed: same visible contract number.** Each AMC Reference Number belongs to one contract
for life: unique index `amc_contracts_reference_uq` (0105) and the reference history `amc_contract_references`
(0107), approved 2026-11-04. A renewal is a separate contract, so it cannot hold the same number without weakening
those constraints, which the brief forbids. Options for the owner:

1. Keep one number per contract (today) and show "Renewal of …" everywhere (already shown on the contract page).
2. A "contract number" shared by a renewal chain plus a period label (e.g. `AMC-0007 · Period 2`), as a new column;
   every screen, export, search and Zoho reference would need to show the period to keep rows distinguishable.
3. A suffix rule for renewals (e.g. `AMC-0007-R1`) — a numbering rule the owner must define.

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

## 7. Service Sales

No total added: Service Sales has **no monetary field** (quotation numbers only). Adding a value column is a scope and
permission decision (who in sales may see money); values and totals are on Accounts and Master AMC Status.

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

## 10. Verification

All on the disposable database `stslv_amc_client_fixes` (schemas `stslv_test`, `upgrade_0110`, `e2e`) and a disposable
copy `stslv_amc_client_fixes_upgrade`. Never `stslv_amc_dev` (read only, for one `pg_dump`), Neon, Supabase or any
hosted service. Both production switches unset (off) throughout.

| Check | Result |
|---|---|
| API suite | **1,804 passed, 2 skipped** (105 files; baseline 1,779 + 25 new in `sts-elv-client-fixes.test.ts` and `migration-0110-upgrade.test.ts`) |
| Web suite | **851 passed** (56 files; baseline 843 + 8 new in `sts-elv-client-fixes.test.tsx`) |
| Typecheck, lint, builds | API typecheck and `tsc` build pass; web `tsc -b` and Vite build pass; oxlint exit 0 (13 earlier warnings, none in changed files) |
| Migration 0110, fresh path | applied by every API test run (the test schema is rebuilt from all migrations) |
| Migration 0110, upgrade path | 0109 → 0110 test; plus a rehearsal on a copy of the development database (at 0106): 0107–0110 applied, contract and visit fingerprints (md5 of every row) identical before and after, no value backfilled |
| Browser E2E | **24 / 24** checks (headless Edge over DevTools; web 5411 → API 3411 with its own JWT secret, schema `e2e`, scratch document folder, mail off; guard: dev API 3001 not running) |

E2E checks: isolation guard; login and STS-ELV title; Validity → Expired / Due; hide and show the Contract column;
Start Renewal form naming the original; the same-number rule explained in the form (**the same number itself is not
implemented**, section 3); renewal refused without the document, then saved with it through the file picker; Service
Status AMC Value; Sales Engineer Name saved and shown after reload beside Service Report No.; Accounts viewer and
Download inside it (file saved); Accounts totals and the missing-value reason; Master AMC Status totals; Service
Sales has no money column; monthly report totals equal Accounts; Help content; a user without AMC Contracts: View
sees no AMC Value (page and API), gets 403 on contracts and may still open the Accounts report; no page-level
horizontal scroll at 1440 px and 390 px on AMC Contracts, Service Status, Accounts and Master AMC Status.

Not exercised in the browser: dark mode, real phones, the Hostinger CSP (the E2E web server sends no CSP).

## 11. Outstanding

1. Same visible contract number on renewal — owner decision (section 3).
2. App-wide "today" in Asia/Muscat instead of the database time zone — touches the Dashboard (section 2).
3. Development Admin login `admin@stslev.com` — change only with approval (section 1).
4. Service Sales money totals — needs a scope/permission decision (section 7).
5. PDF preview under the Hostinger CSP (`object-src 'none'`): verify in UAT; the viewer always offers Download.
