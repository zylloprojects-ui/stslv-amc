# STSLV AMC — Complete Meeting Requirements Compliance and Functional Verification Report

Date: 2026-10-31. Code audited: `bd954cc`. Work is uncommitted on `feature/meeting-requirements-audit` in the worktree `D:\Projects\STSLV-AMC-meeting-audit`.

Sources: `Complete_Meeting_Analysis.md`, `Meeting_Requirements.md`, `Meeting_Action_Items.md` (from Downloads), the requirements brief, and the project's docs. The recording itself was not re-analysed: its audio has no reliable transcript. The reference ERP was not opened: the only login available is a password shown in the meeting analysis, which was not used.

Status words: **Tested** = completed and tested. **Untested** = implemented, not exercised in this audit. **Partial**, **Missing**, **Blocked** = waits for a decision.

## 1. Requirements by module

| Requirement | Status | Evidence / note |
|---|---|---|
| Rename Services Sales to Quotations | Tested, new | Sidebar, page, exports, permission label; old address redirects. Internal code `SERVICES_SALES` unchanged, so grants are unaffected |
| Written module list and order | Tested, new | Sidebar order follows the spec; Accounts moved under AMC Operations; AMC Schedule kept last |
| Master AMC Status columns | Tested, except value label | Order matches; "Visit Value" instead of "VALUE (EX VAT)" (D1) |
| Master AMC Status invoice + quotation status filters | Tested, new | API, page, cards and export filter header; combined filter tested |
| Service Status columns, updates, history, conflict and permission refusal | Tested | Order matches; workflow test and existing suite |
| Accounts column order | Tested, new (was wrong) | Value now follows Service Report No.; the always-"Not available" Paid / Unpaid column removed from page and export |
| Accounts Paid / Unpaid filter | Blocked (D2) | Filter is Invoice recorded / No invoice recorded |
| Accounts manual invoice number | Partial (D3) | "Record invoice" opens Invoice Tracking; no inline field |
| Dashboard: Active, Services This Month, Expiring ≤45 | Tested | Compared with database and seeded boundary data |
| Dashboard: Not Invoiced / Invoiced Services | Tested, new | Replace two "Not available" cards; same rows as Accounts; not a payment figure |
| Dashboard: Annual AMC Value | Partial (D4) | Sum of contract values, not annualised; card is "AMC Value (OMR)" |
| Dashboard: Total Credit | Partial (D5) | Summed as entered; meaning unconfirmed |
| Dashboard: Payment Trend | Blocked (D2) | Shows unavailable; nothing fabricated |
| Dashboard: other sections, refresh, empty states | Tested by existing suite + page load | Not individually clicked here |
| KPI rename and reset on Dashboard | Tested, new | Figure unchanged after rename; order customisation already existed |
| Clients, Sales Engineers, System Types, Departments | Tested by existing suite | Duplicate client refused and links re-tested in workflow |
| Maintenance Frequencies: six rules | Tested | Counts, intervals, prefixes, generation. Three rules start inactive (D6); Every 4 Months prefix is T, legacy S (D6) |
| AMC reference, form fields, lifecycle, search | Tested | Workflow test and existing suite |
| Contract duration | Tested, new | 1-6 years fills Valid to, stays editable, leap years tested |
| Contract Excel / PDF export | Tested, new (was missing) | `GET /api/amc/contracts/export`, button on the page, respects filters |
| Contract document upload | Partial | On the contract page, not the form; production upload setting not checked (D8) |
| Billing Basis | Missing, blocked (D7) | No such field |
| Schedule: count, month, code, contract, no duplicates | Tested | All five fixed frequencies and custom; regeneration adds nothing |
| Schedule: date change, cancelled contract | Tested | Date change adds/removes untouched visits only; completed work kept |
| Schedule: frequency change | Tested by existing suite | Rule tests; not repeated in the workflow test |
| Scheduled Service Value = Billing Basis / services | **Not implemented**, blocked (D7) | Each visit takes the entered Cost per Visit |
| 300-400 contract performance | Tested | 400 contracts, 2,112 visits: lists 8-26 ms, exports under 2 s (local) |
| Consolidated monthly row per AMC | Blocked (D9) | One row per visit; not in the meeting documents |
| Monthly Calendar views, filters, renewal warnings | Tested by existing suite + page load | |
| Calendar invoice colours (green / blue) | Partial, not visually confirmed | Billing filter and invoiced totals exist |
| Five-level Color Priority | Tested, new | See section 8. The earlier "not defined" was wrong: the repo was searched but not the reference specification |
| AMC Renewal: 45 days, 46 days, today, expired, under approval, renewed, cancelled | Tested | Source contract and visits unchanged by renewal |
| Contract expiry | Partial | Status does not expire by itself; expiry is shown as past validity / Waiting for Renewal |
| Roles: menus and direct page access, six roles | Tested in browser | |
| Roles: API refusal by Viewer, Finance, Operations | Tested | Direct calls return 403, no sign-in 401 |
| Roles: action types, updates, persistence | Tested by existing suite | Not re-exercised by hand |
| Security Center screen | Missing | Parts exist: Login History, Audit Log, temporary passwords, login limits |
| Deletion Log | Missing | Audit Log records actions; no separate log |
| Backup & Restore screen | Missing | No in-app feature, so no automatic schedule exists |
| Backup procedure | Tested on isolated DB | Dump and restore; 9 counts and money total identical |
| Reports page | Missing | Exports live on each module |
| Exports for 7 modules | Tested | Excel opened and PDF signature checked by test; layouts not visually reviewed |
| Obsolete Project Procurement / AMC Execution hidden | Tested | Not in sidebar |
| Dark-mode contrast: Suggestions Review, AMC Management, row numbers | Tested, new | Confirmed and fixed |
| "INVOICES/ - HIDE" | Blocked (D11) | Meaning unclear; Invoice Tracking left visible |

## 2. Future scope, reported only

- **Quotations:** Service Report No. column and the "quote submitted or not" filter from the spec.
- **Invoice Tracking:** existing module preserved; nothing added.

## 3. Decisions needed

| # | Decision | Why it matters |
|---|---|---|
| D1 | Is the per-visit amount excluding VAT? | The spec says VALUE (EX VAT); the label stays "Visit Value" under the 2026-10-28 decision |
| D2 | Does invoice number entered mean Paid? | The legacy screen says so, but no project rule does; existing docs say an invoice number is not a payment |
| D3 | May an invoice number be saved without date and amounts? | Invoice records require both, and allocations must reconcile |
| D4 | Is contract value annual or for the whole term? | Decides "Annual AMC Value" on multi-year contracts |
| D5 | What does Final Credit mean? | Still unconfirmed |
| D6 | Activate Bi-Monthly, Every 4 Months, Custom in production? Prefix T or S? | Production state was not read; rules lock once used |
| D7 | Add Billing Basis and calculate visit value? Which rounding? | A financial rule change; the legacy shows 599.999 |
| D8 | Where are contract documents stored in production? | Render's disk is not permanent |
| D9 | What should the consolidated row show? | Not in the documents |
| D10 | What are the five colour levels? | Not defined |
| D11 | What does "INVOICES/ - HIDE" mean? | Could mean hiding Invoice Tracking |
| D12 | Build Backup & Restore, Security Center, Deletion Log, Reports? | Restore from a web screen is high risk |

## 4. Security findings

1. The meeting analysis contains the legacy system's admin password in plain text. Rotate it and do not share the document unredacted.
2. The production health response carries no HSTS, `X-Content-Type-Options` or frame-protection headers.
3. The sign-in token is kept in `localStorage`, so any script injection could read it.
4. Hard deletes exist only for narrow cases (unused system types, untouched visits, role and allocation rows), with no dedicated log.

## 5. Test results

| Check | Result |
|---|---|
| API tests (isolated DB) | 1,320 passed, 1 skipped, 0 failed |
| Web tests | 638 passed, 0 failed |
| Typecheck, builds | Pass |
| Lint | No errors; existing warnings remain |
| Browser sweep | 24 pages x 3 widths x 2 themes: 0 overflow, 0 console errors, 0 failed API calls |
| Playwright | Not configured; browser checks used Edge over CDP |

Limits: the cookie dialog covered the first sweep, so that sweep measured layout, errors and contrast, not interaction. Interaction was then clicked on desktop only. The contrast scan skips text on gradients. Light mode still has near misses (4.35-4.42 against 4.5) and pale dashes. There is no clean before-change API figure, because the baseline ran while edits were being made; its 2 failures came from that overlap.

## 6. Handover

No migration is needed. Nothing was committed, pushed or deployed. `main`, `develop`, `alpha`, production and Neon were not changed; the only production contact was one read-only request to the public health endpoint.

Disposable: databases `stslv_amc_test_meeting_audit`, `stslv_amc_e2e_meeting_audit`, `stslv_amc_e2e_meeting_audit_restore`. The worktree's `.env` points at the E2E database.

## 7. Completion session (2026-10-31, later)

This section supersedes the earlier rows it mentions. Still uncommitted on the same branch.

Added: Billing Basis (record only, migration 0093), consolidated monthly schedule, Accounts invoice dialog (through the existing invoice API, no typed-in figure assumed), Master AMC Status sorting and Details dialog, calendar invoice indicator, Reports (9), Security Center, Deletion Log, Backup & Restore.

- **Migration 0093** is prepared, tested on isolated databases, and not applied to `stslv_amc_dev` or Neon. A release applies it at API start.
- **Reports permission:** REPORTS is now an active module. Among active roles only Super Admin holds it; Super Admin grants it to others. Inactive legacy roles ACCOUNTANT and INVOICING hold an old REPORTS:VIEW, which takes effect only if reactivated.
- **Backups:** off until `BACKUP_DIR` is set; production also needs `BACKUP_STORAGE_DURABLE=true` and `pg_dump` / `pg_restore`. No schedule, and no restore from the application.
- **Deletion Log** reads `activity_logs`; it holds only what the application recorded.
- Not done: the value formula; Ex VAT label; paid rule.

## 8. Reference specification session (2026-11-01)

Source added: the AMC ERP Functional Reference Specification, files `00` to `10` in Downloads. It is evidence about the legacy system, not approval of a rule for STSLV.

Added:
- **Billing Basis:** Custom option and value; the selected amount on the contract, exports and report; a read-only Calculation Rule panel and Schedule history. Visit amounts still come from Cost per Visit.
- **Color Priority:** Manual → Cancelled → Invoice Pending → First Service → Normal, on AMC Schedule, with a manual colour (migration 0094). The palette and the colours of the other levels are a display choice: the reference gives the order, not the colours. Master AMC Status, Accounts and Calendar keep their own documented colours.
- **Sync:** every page that changes operational data now refreshes every page that shows it (`lib/refreshOperationalData.ts`).
- **Security Center:** health checks without a score, paged and filterable events with network address, API security headers.
- **Deletion Log:** also covers cancelled visits and deactivated records, and any other record whose logged status change is to Cancelled; Excel and PDF export.
- **Backup:** readiness checks and `docs/BACKUP_RESTORE.md`. Fixed a defect in this branch where a failed status write stopped the whole API.

Decisions, with the evidence available:

| # | Decision | What the reference shows |
|---|---|---|
| 1 | Calculate visit value from the basis? | Basis ÷ services per year, rounded to 3 decimals (83.333), flat across years, fixed at generation. Marked INFERRED. Rounding leaves a remainder (6 × 83.333 = 499.998) with no stated handling |
| 2 | Which amount does "Contract value" mean? | Its field is "AMC Value / Year", so a multi-year STSLV contract value may need dividing. STSLV has not defined this |
| 3 | Does an invoice number mean Paid? | Yes in the legacy, stated on screen. Project docs say it is not a payment |
| 4 | May an invoice number be saved alone? | Yes in the legacy. STSLV invoices require a date and amounts |
| 5 | Is the visit amount Ex VAT? | The written spec says VALUE (EX VAT); never stated for the entered amount |
| 6 | Final Credit meaning | A required field, one of the billing bases; meaning still not stated |

Not built, needing approval: forced sign-out and a session list (authentication change), Trash and restore, in-app restore, automatic backups (storage and retention), `INVOICES/ - HIDE`.
