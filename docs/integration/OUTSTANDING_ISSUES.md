# Outstanding Issues — Final Integration

2026-11-09, branch `integration/stslv-amc-final-20261109`. The long-term register is
`docs/handover/OUTSTANDING_ISSUES_REGISTER.md` (OI-xx, updated at integration); this list is what stands
between the integrated build and a production release.

No open defect was found in the integrated code: all automated suites, the migration checks and the browser
run pass (`TEST_RESULTS.md`). What remains is approvals, activation, client activities and minor items.

## Blocking a production release (needs the owner)

| # | Item | Why it blocks | Ref |
|---|---|---|---|
| B-1 | Approve applying migrations **0108** and **0109** to Neon production | Releasing the branch applies them automatically (start command) | `MIGRATION_READINESS.md`, OI-21 |
| B-2 | Fresh production backup and restore drill immediately before the release | Rollback pair for the release | `docs/handover/DEPLOYMENT_CHECKLIST.md` §B |
| B-3 | Release window and user notice: **every user signs in again once** (0108) | User impact | OI-20 |
| B-4 | Client UAT (`docs/uat/UAT_CHECKLIST.md`, incl. section 20) | Not executed | `UAT_CHECKLIST.md` |
| B-5 | Merge path: integration branch → develop/alpha, push, deploy | All require separate approval; nothing was pushed or merged | `INTEGRATION_REPORT.md` |

## Required before go-live on the Hostinger VPS

| # | Severity | Item | Ref |
|---|---|---|---|
| H-1 | High | Backups are still manual in production: create the off-site bucket and key, the GnuPG key pair, a named owner; install and enable the backup timers; run a first production restore drill | OI-01, OI-02, `docs/BACKUP_AUTOMATION.md` "Activation" |
| H-2 | High | VPS not provisioned: decisions in `HOSTINGER_READINESS.md` §4; install templates on a temporary host name; complete the VPS UAT list before any DNS switch | OI-05 |
| H-3 | Medium | Separate database roles (runtime role without DDL on `activity_logs`; read-only backup role) | OI-21, `deploy/hostinger/sql/` |
| H-4 | Medium | Contract-expiry scheduled job: no systemd timer exists; add one with `AMC_CONTRACT_EXPIRY_ENABLED` only in its unit, when activation is approved | `docs/CONTRACT_EXPIRY.md` |
| H-5 | Medium | CSP checked against an LF build only; verify in a real browser on the VPS (PDF viewer, exports, no console violations) | `HOSTINGER_READINESS.md` |

## Decisions and activations (owner)

| # | Severity | Item | Ref |
|---|---|---|---|
| D-1 | Medium | Switch on `SERVICE_REPORT_NO_LOCK_ENABLED` (API) and the contract-expiry job (`AMC_CONTRACT_EXPIRY_ENABLED`) — both approved as rules, **off** until a separately approved release | OI-19 |
| D-2 | Medium | Business time zone: expiry uses Asia/Muscat; Dashboard/Renewal "today" use the database's time zone. Make Asia/Muscat the single business zone (connection or database setting) as its own tested change | OI-12, `docs/P1_FIXES.md` "Date consistency" |
| D-3 | Medium | Demo records in production (DEMO clients/contracts/invoices) | OI-06 |
| D-4 | Low | Public repository: decide before client handover | OI-03 |

## Client activities (not done)

- Training: not delivered (`docs/training/TRAINING_GUIDE.md`; AD-5, AD-6 added for the new admin features).
- UAT: not executed. Sign-off: not given (`docs/handover/CLIENT_SIGNOFF_FORM.md`).
- Infrastructure Ownership Register, User Access Handover, Admin Handover Checklist: to be completed.

## Minor (do not block)

| # | Severity | Item |
|---|---|---|
| M-1 | Low | Role list (Settings → Organization) at phone width: the table scrolls horizontally inside its box and the Role column is very narrow; the page itself does not overflow. Cosmetic |
| M-2 | Low | Existing lint warnings (oxlint) in files not changed by the integration (e.g. `HelpPanel.tsx` fast-refresh export, `AuditLogPage.tsx` impure `Date` in render, `ui.tsx`); lint exits 0 |
| M-3 | Low | `npm ci` reports `esbuild`'s install script as not yet allowed by the new npm install-scripts policy; the platform binary is installed as an optional dependency and builds/tests work. Review the policy before CI |
| M-4 | Info | The main checkout `D:\Projects\STSLV-AMC` (alpha) has older uncommitted files not part of this work (`.gitignore`, `stslv-api/migrations-pending/`, two scripts in `src/scripts/`); left untouched |
| M-5 | Info | The "November 9 audit" document named in earlier briefs was never found in the repository | OI-18 |
