# Release Notes — STSLEV AMC

## Unreleased — Help and handover documentation (branch `feature/stslv-p3-handover`)

Not merged, not deployed. Built on `c6d8d19`.

**New**
- In-app **Help**: a **?** button in the header opens help for the current page (side panel; full screen on phones), with search and a list of all topics the user's role may read. **Help & User Guide** in the account menu opens a full Help page (`/help`, `/help/<topic>`) with a topic list (drop-down on narrow screens).
- Help topics cover every sidebar page plus Contract 360, the Schedule Engine, Billing Basis, Regenerate, and Paid status versus Zoho Invoice Tracking. Topics follow the same access rule as the sidebar.
- Documentation: user guide, technical handover, API reference, role permission matrix, training guide, UAT checklist and handover documents (`docs/README.md`).

**Changed**
- `vite.config.ts`: under Vitest only, the test runner may read `docs/user-guide` (the Help test checks each topic's chapter exists). The development server and the build are unchanged.

**Database:** no migration. **API:** no change.

## Released

Current production (client-review hosting) runs commit **`c6d8d19`** from `develop`, released 2026-11-04 (night), database at migration **0107** (49 migrations).

Summary of what is live, by area (details in the module documents under `docs/`):

| Area | Capabilities |
|---|---|
| Access | Six-role model (Super Admin, Admin, Finance, Master Data, AMC Operations, Viewer); configurable permissions by Super Admin; sign-up with approval; administrator-issued 15-minute temporary passwords; sign-in rate limits; Login History; Audit Log; Security Center |
| Master data | Clients (Client 360), Sales Engineers (Engineer 360, codes), System Types, Maintenance Frequencies (rules, lock), Departments; deactivate instead of delete |
| AMC contracts | Manual AMC Reference Number with history (0105, 0107); mandatory contract document (PDF/Word); Billing Basis (0093); validity and duration; status workflow; Contract 360 |
| Schedule | Automatic generation from validity and frequency; Regenerate with preview and reason; manual service colour (0094); Monthly by AMC; Monthly Calendar with year/month views and downloads |
| Execution | Service Status with mandatory Service Report and completion lock (0104) |
| Finance | Manual Invoice No. = Paid reference status (0100); Accounts reconciliation; Invoice Tracking of Zoho invoices with allocations; Service Sales quotation numbers |
| Renewal | Renewal queue (45 days), draft → approve, history |
| Reports | 12 reports with Excel/PDF export |
| Administration | Recycle Bin for contracts, clients, system types, sales engineers (0101, 0106); Suggestions; Notifications; Holidays |
| Documents | Private Supabase Storage bucket for all documents (2026-11-04) |

Earlier production releases: 2026-10-28/29, 2026-10-31, 2026-11-02, 2026-11-04 (afternoon), 2026-11-04 (night). Release evidence (backups, checks) is kept outside the repository by the delivery team.

## Template for the next release

```
## <version / date> — <title>
Commit: <sha>   Released by: <name>   Approved by: <name>
Database: migrations <from> → <to> (list)   Backup before release: <file, sha256>
New:
Changed:
Fixed:
Known issues: (Outstanding Issues Register IDs)
Rollback: <previous commit> + <backup>
```
