# Requirement gap analysis

Date: 2026-11-01. Code: `feature/finance-completion`, uncommitted, on `4b7a66c`. Sources: the 24 October meeting analysis, the Aqua Executive functional reference (files `00`-`10`) and [FINANCE_WORKFLOW.md](FINANCE_WORKFLOW.md).

The reference describes a legacy system. It is evidence of behaviour, not a rule by itself. Bugs it flags are not copied.

## Status words

| Status | Meaning |
|---|---|
| **Verified** | Implemented and exercised through the running application (browser or real API) with fictional data |
| **Tested** | Implemented, with automated tests, but not exercised in the browser run |
| **Partial** | Part exists; the row says what is absent |
| **Missing** | Absent, clearly specified, not built |
| **Excluded** | Deliberately not built, awaiting separate approval |
| **Decision** | Needs a business or production decision |

## AMC Operations Dashboard

| Requirement | Status | Note |
|---|---|---|
| Seven KPI tiles with codes | Verified | Unpaid Invoices and Paid This Month use the manual Invoice No. |
| Title, subtitle, New AMC, System Online, KPI layout reset | Verified | |
| Mini calendar, Service Details | Tested | Details show the manual Invoice No., Zoho invoices apart, AMC reference |
| Upcoming Service Workload, Portfolio Status | Verified | |
| Payment Trend | Verified | By the date the number was entered |
| Expiring Contracts, link to the expiry report | Tested | |
| Recent Invoices | Tested | Zoho records, labelled so. Reference shows paid invoices: see Decisions |
| Production Readiness widget | Decision | Available in Security Center; an earlier decision keeps it off the Dashboard |

## Master Data Center

| Requirement | Status | Note |
|---|---|---|
| Hub, Clients, Sales Engineers, System Types, Frequencies, Departments: lists, forms, codes, status | Verified | Create, duplicate refusal, Excel and PDF run through the API; every page rendered |
| Archived status on Clients, Engineers, System Types, Departments | Decision | Frequencies only today |
| Six frequency records usable | Decision | Bi-Monthly, Every 4 Months and Custom are seeded inactive |

## AMC Contracts and Contract 360

| Requirement | Status | Note |
|---|---|---|
| Register: reference, credit, countdown, six filters, Filtered Total, Hide Columns, export, Upload link | Verified | |
| Form: client code, frequency, dates, duration, value, credit, basis, custom value, remarks | Verified | |
| Required Sales Engineer, Final Credit and duration; system type dropdown | Decision | Optional or free text today; filters and exports use the free text |
| Manual AMC reference and numbering | Decision | Reference derives from the record id |
| Contract 360: reference, toolbar, overview, KPIs, commercial, generation, linked modules, created and updated by | Verified | |
| Related invoices: Invoice No., OK, Paid, Paid date, colour, per-row schedule link, export | Tested | Field Verified on Accounts and this page's API |
| Revision history with sequence number | Tested | Activity log; no "view snapshot" |
| Cancel requires a reason | Verified | |
| Move to Draft, Archive | Decision | Effect on existing visits undefined |
| Trash review, Dependencies, Delete | Excluded | Part of Trash |
| Renewal: linked contract, source unchanged, notes in history | Verified | |
| Renewal for a different client | Decision | Reference allows; API refuses |

## Schedule Engine and Consolidated Monthly Schedule

| Requirement | Status | Note |
|---|---|---|
| Generation from validity and frequency, no duplicates, codes restart yearly | Verified | |
| Amount = annual basis ÷ services, remainder on last of a complete year | Verified | 83.333 × 5 + 83.335 |
| Explicit Regenerate with preview and reason | Verified | |
| Calculation Rule box, Generation History with reason and basis | Verified | Log entries, not copies of rows: approved difference |
| AMC Schedule hub: reference, Paid filter, rule text, Invoice No. | Verified | |
| Consolidated view: one row per contract, filters, Paid mark, export | Verified | |

## Five-Level Color Priority

| Requirement | Status | Note |
|---|---|---|
| Manual → Cancelled → Invoice Pending → First Service → Normal | Verified | Each state reached from real records |
| Invoice Pending follows the manual Invoice No. | Verified | |
| Manual colour set and cleared | Verified | Palette is a display choice |
| On AMC Schedule and the contract's schedule | Tested | |

## Monthly Calendar

| Requirement | Status | Note |
|---|---|---|
| Year and month views, per-month export, Paid and Unpaid figures, Paid filter, green/blue | Verified | |
| KPI rename and reorder on Calendar and Schedule stats | Missing | Browser-local convenience only |

## Service Status

| Requirement | Status | Note |
|---|---|---|
| Status, report number, save, four KPIs, export with hidden columns | Verified | |
| Independent of Paid, both directions | Changed | 2026-11-04: Invoice No. entry needs a completed service; completing never sets Paid (FINANCE_WORKFLOW.md) |
| Waiting for Renewal selectable | Decision | Derived today |

## Accounts

| Requirement | Status | Note |
|---|---|---|
| Column order, Invoice No. entry, Paid / Unpaid filter, contract filter, KPIs, export | Verified | |
| Service Report No. editable here | Decision | Editable on Service Status |

## Master AMC Status

| Requirement | Status | Note |
|---|---|---|
| Columns, four colours from the manual number, filters, Details, KPI rename, export | Verified | |

## Service Sales

| Requirement | Status | Note |
|---|---|---|
| Module and data preserved; rename; Service Report No. column; Quote Submitted filter | Tested | Submitted means a quotation number is recorded |

## AMC Renewal

| Requirement | Status | Note |
|---|---|---|
| 45-day queue, KPIs, history, renewal action, exports | Verified | |
| Daily job and automatic expiry | Decision | Live evaluation and a manual Expire action today |
| "AMC Contracts" tab | Decision | The reference itself marks it unverified |
| Alert dismiss | Decision | Mark-read only |

## Reports

| Requirement | Status | Note |
|---|---|---|
| 12 reports read and export to Excel and PDF | Verified | |
| Billing Schedule, Expiry & Renewal Due, Renewal History, Contract Value Review, Portfolio KPIs | Verified | KPI strip Tested |
| System, Status and Paid / Unpaid filters | Tested | |
| Totals match the source modules | Verified | |
| CSV export | Decision | Excel and PDF only |

## Security Center

| Requirement | Status | Note |
|---|---|---|
| Health checks, latest migration, Node, HTTPS, run mode, failed sign-ins, events with address | Verified | No score, by earlier decision |
| Editable security policy and settings | Decision | Read-only values today |
| Forced sign-out, session list | Excluded | Awaits approval |

## Roles & Permissions

| Requirement | Status | Note |
|---|---|---|
| Six-role model, matrix, server-side refusal, browser guards | Verified | Finance, Operations, Viewer, no sign-in |
| Reports grant separate | Verified | |
| Per-user Module & Column Access, custom role screen, multi-role, usernames | Decision | Reference differs from approved local decisions |

## Users, Login History, Audit Log

| Requirement | Status | Note |
|---|---|---|
| Users: edit name, search, status filter, paging, columns, export | Tested | Export Verified |
| Login History: user agent, columns, export | Tested | Export Verified |
| Audit Log: filters, columns, audited export | Tested | Export Verified |
| Network address on every audit row | Partial | Shown where already recorded |

## Recycle Bin (formerly Deletion Log)

History only: see [RECYCLE_BIN.md](RECYCLE_BIN.md).

| Requirement | Status | Note |
|---|---|---|
| Removal events, kinds, filters, export, columns, admin only | Verified | Filtered activity log, which the reference permits |

## Backup & Restore

| Requirement | Status | Note |
|---|---|---|
| Manual backup, verification, SHA-256, download, permission refusal | Verified | Isolated folder; archive listed by pg_restore |
| Automatic backups, retention, delete | Excluded | Awaits approval |
| Restore from the screen | Excluded | Documented manual procedure only |

## Contract Documents

| Requirement | Status | Note |
|---|---|---|
| Upload, content validation, integrity, versions, download, stated limits, 12 MB | Verified | |
| Upload on the create form; DOC and DOCX | Decision | The reference disagrees with itself on types |
| Production storage | Decision | Render's disk is not permanent; uploads stay off until storage is chosen |

## Invoice Tracking

Preserved and unchanged in its rules. No invoice is generated. `INVOICES/ - HIDE` from the meeting remains unexplained: see Decisions.

## Administration in the reference, not built

| Requirement | Status | Note |
|---|---|---|
| Trash, recovery, Permanent Delete | Excluded | |
| Active Sessions, Revoke | Excluded | |
| Admin Control hub, Sidebar Visibility, Database Migrations page | Decision | Security Center and Administration menu cover the reachable parts |
| System Settings: invoice and AMC defaults, thresholds, density, timezone | Decision | |
| Smart Edit | Decision | Meaning is unknown in the reference |
| Numeric health score, footer version | Decision | No source of truth for a version |

## Other known remainder

| Item | Status | Note |
|---|---|---|
| Hide Columns on Invoice Tracking and Consolidated | Missing | Invoice Tracking left untouched by instruction |
| Recent Invoices export honouring hidden columns | Missing | Needs the invoices module |
| AMC Schedule export honouring hidden columns | Missing | Hide Columns on the page does not change the file |
| Date format `DD-Mon-YYYY` | Decision | Pages show `01 Nov 2026` |
| Document list re-hashes each stored file | Note | Accurate; slower with many large files |

## Decisions

1. **Contract form:** make Sales Engineer, Final Credit and duration required, and system type a dropdown?
2. **Numbering:** manual AMC reference, and the rule.
3. **Frequencies:** activate Bi-Monthly, Every 4 Months and Custom in production; prefix T or S.
4. **`INVOICES/ - HIDE`:** what does it refer to?
5. **Recent Invoices:** keep Zoho records, or list manual numbers with their date as the reference does?
6. **Lifecycle:** Archive and Move to Draft; renewal for a different client; automatic expiry.
7. **Settings:** which become editable, and by whom.
8. **Access:** per-user column access, custom roles.
9. **Exports:** CSV.
10. **Paid on a cancelled contract:** see FINANCE_WORKFLOW.md.

## Awaiting separate approval

Production automatic backups, forced sign-out, full Trash and recovery, production document storage, and every commit, merge, migration on a shared database and release.
