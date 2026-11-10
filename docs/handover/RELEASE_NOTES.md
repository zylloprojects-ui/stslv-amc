# Release Notes — STS-ELV AMC

## Unreleased — Final integration of P0, P1, P2 and P3 (branch `integration/stslv-amc-final-20261109`)

Integrated and tested **locally only** on 2026-11-09. Not pushed, not merged into alpha/develop, not deployed. Sources: P0 `91b4da7`, P1 `597e356` (with `3e2cb28`), P2 `051906c` (with `6b56038`), P3 `c0ea7d5`, all on `c6d8d19`. Details: `docs/integration/INTEGRATION_REPORT.md`.

**Database:** two new migrations, **0108_user_sessions** and **0109_activity_logs_append_only** (0107 → 0109). Applied only to disposable local databases. The API's start command applies pending migrations, so the release itself applies them: approval required (`docs/integration/MIGRATION_READINESS.md`).

**Security (P0)**
- Server-side sessions: each sign-in is a session; sign-out, sign out of all devices, administrator sign-out, password change, temporary password and deactivation end sessions at once; **30-minute inactivity limit** (`SESSION_IDLE_TIMEOUT_MINUTES`). Active sessions on My Profile and in Security Center. **Every user signs in again once at this release.**
- Stronger rules for every new password (12+ characters, variety, no well-known or personal passwords); existing passwords keep working.
- Audit Log is append-only in the database (UPDATE, DELETE, TRUNCATE refused).
- Prepared, **not active**: encrypted off-site database and document backups with retention, verification, alerts and isolated restore drills; Hostinger VPS templates (Nginx, TLS, CSP, UFW, SSH, systemd, logrotate, journald, monitoring).

**Business rules (P1, approved 2026-11-09)**
- One service scope for every page: on a cancelled contract, Completed or Paid services stay counted; historical Paid-but-not-Completed services are preserved.
- Contract expiry the day after Valid To (Oman time) and Service Report No. lock after Paid (override by Super Admin/Admin with a reason, audited). **Both switched off** (`AMC_CONTRACT_EXPIRY_ENABLED`, `SERVICE_REPORT_NO_LOCK_ENABLED`) until a separately approved release.

**Improvements (P2)**
- Super Admin and Admin manage custom roles (Admin within its own permissions; never built-in roles, its own role, Super Admin/Admin, or Users & Access).
- Reports need View (and Export) of their source page as well as Reports; Monthly Maintenance belongs to Accounts.
- Monthly Calendar Month view: By service / By contract. Year view Unpaid in blue.
- First Service = earliest non-cancelled visit by date on both Contracts and Schedule.
- Master AMC Status export: Zoho Invoices (Tracking) and Zoho References (Tracking). Recent Invoices export writes only the visible columns. Recycle Bin dialog shows a contract's dependencies.

**Help (P3)**: in-app Help and the documents below, updated for all of the above.

## Help and handover documentation (branch `feature/stslv-p3-handover`) — included in the integration above

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
