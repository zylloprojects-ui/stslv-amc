# Infrastructure Ownership Register — STSLEV AMC

Prepared 2026-11-09 from the repository (`render.yaml`, `docs/DEPLOYMENT.md`, `docs/DOCUMENT_STORAGE.md`, `docs/BACKUP_RESTORE.md`). **Owners, account holders and billing contacts are not recorded in the repository and must be filled in and confirmed by the client and the supplier together.** No password, key, token or connection string belongs in this file.

Status key: **Live** = in use by the current client-review deployment. **Planned** = intended, not yet set up. **TBC** = to be confirmed.

## 1. Services

| # | Component | Purpose | Status | Where configured | Account owner (legal) | Day-to-day administrator | Billing / plan | Credentials held by | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GitHub repository `zylloprojects-ui/stslv-amc` | Source code; `develop` deploys | Live | GitHub | TBC | TBC | TBC | TBC | Repository is **public**. Decide whether it should become private before handover (see Outstanding Issues). Branch protection not configured. |
| 2 | Cloudflare Pages project (web application) | Hosts `stslv-web`; production branch `develop` | Live | Cloudflare dashboard | TBC | TBC | Free plan | TBC | Env: `VITE_API_BASE_URL`, `NODE_VERSION`. Alpha previews also build. |
| 3 | Render web service `stslv-amc-api` | Hosts `stslv-api`; runs migrations on start | Live | `render.yaml` + Render dashboard | TBC | TBC | Free plan (sleeps when idle) | TBC | Secrets entered in dashboard only. |
| 4 | Neon project (PostgreSQL 17) | Production database | Live | Neon console | TBC | TBC | Free plan | TBC | Direct host required (no pooler). Reachable from the internet with password + TLS; accepted for review copy only. |
| 5 | Supabase project — private Storage bucket | Contract documents, service reports, attachments | Live (from 2026-11-04) | Supabase dashboard + Render env | TBC | TBC | Free plan | TBC | S3 keys are server-side only; rotation steps in `docs/DOCUMENT_STORAGE.md`. |
| 6 | Hostinger VPS | Intended production host | Planned | — | TBC | TBC | TBC | TBC | Prerequisites in `docs/technical/TECHNICAL_HANDOVER.md` §9. Nothing is deployed there. |
| 7 | Domain name and DNS | Client-facing address | TBC | TBC | TBC | TBC | TBC | TBC | Currently the `*.pages.dev` and `*.onrender.com` addresses are used. |
| 8 | Zoho Books (client) | Official invoicing | Live (client system) | Zoho | Client | Client finance | Client | Client | Not integrated. STSLEV AMC only records Zoho invoice numbers. |
| 9 | Email sending | Not used | — | `MAIL_TRANSPORT=none` | — | — | — | — | Password recovery uses administrator-issued temporary passwords. |

## 2. Backups

| # | Item | Current arrangement | Owner | Frequency | Retention | Restore tested (date / by) |
|---|---|---|---|---|---|---|
| 1 | Neon database dumps | Taken manually with `pg_dump` from a trusted machine before each release (see `docs/DEPLOYMENT.md`, `docs/BACKUP_RESTORE.md`) | TBC | Before each release; routine schedule TBC | TBC | Release rehearsals restored dumps into local databases; a routine restore test owner is TBC |
| 2 | Neon built-in history | Free-plan point-in-time history (short) | TBC | Automatic | Plan limit | Not tested |
| 3 | In-app Backup & Restore | **Not enabled** in production (`BACKUP_DIR` unset; no durable disk) | — | — | — | Verified only on an isolated database |
| 4 | Supabase bucket files | No separate copy | TBC | TBC | TBC | Not tested |
| 5 | Off-site copy of dumps | TBC | TBC | TBC | TBC | — |

## 3. Access review

| Date | Reviewed by | Accounts checked | Changes made |
|---|---|---|---|
| | | | |

## 4. Confirmation

| Party | Name | Signature | Date |
|---|---|---|---|
| Client | | | |
| Supplier | | | |
