# Integration Report — P0, P1, P2, P3

| | |
|---|---|
| Date | 2026-11-09 |
| Branch | `integration/stslv-amc-final-20261109` (local only, not pushed) |
| Worktree | `D:\Projects\STSLV-AMC-final-integration` |
| Base | `c6d8d19` (Merge feature/r2-document-storage into alpha; current production) |
| Scope | Local integration and testing only. No push, merge into alpha/develop/main, deployment, production database, storage, DNS or VPS change |

## 1. Sources (verified before integration)

| Session | Branch | Head | Commits on base | Worktree state |
|---|---|---|---|---|
| P0 Production Safety | `feature/stslv-p0-security` | `91b4da7` | 1 | clean |
| P1 Mandatory Fixes | `feature/stslv-p1-fixes` | `597e356` (after `3e2cb28`) | 2 | clean |
| P2 Improvements | `feature/stslv-p2-improvements` | `051906c` (after `6b56038`) | 2 | clean |
| P3 Handover | `feature/stslv-p3-handover` | `c0ea7d5` | 1 | clean |

All four descend from `c6d8d19`. Only P0 adds migrations (0108, 0109); no migration numbers collide. The four
feature branches and `alpha` were not changed.

## 2. Merge history (first parent, `--no-ff`, history preserved)

| Merge | Source | Change |
|---|---|---|
| `f778fb1` | P0 | 91 files, +5380 / −90 |
| `0a10b5a` | P1 | 27 files, +1602 / −50 — **1 conflict** |
| `ed15130` | P2 | 44 files, +2143 / −159 — no textual conflict |
| `2c37ca7` | P3 | 32 files, +3975 / −2 — no textual conflict |

Followed by the integration commit (this documentation, the Help/guide synchronisation, the cross-branch test
and the template fixes).

## 3. Conflicts and resolutions

| File | Branches | Resolution |
|---|---|---|
| `stslv-api/package.json` (scripts) | P0 `ops` vs P1 `contracts:expire` | Kept **both** scripts |

Files changed by two branches and merged automatically — reviewed by hand for intent:

| File | Branches | Review |
|---|---|---|
| `stslv-api/src/shared/permission-catalog.ts` | P1, P2 | Both kept: P1's Recycle Bin rows (Super Admin only; Deletion History for Admin) and P2's custom-role rows in `FIXED_ACCESS`; P2's USERS description |
| `stslv-api/src/modules/amc/master-status.service.ts` | P1, P2 | Both kept: P1's shared `SERVICE_IN_SCOPE`; P2's `invoice_references` beside `invoice_numbers` |
| `stslv-api/.env.example` | P0, P1 | Both kept: `SESSION_IDLE_TIMEOUT_MINUTES`; the two P1 switches, commented out |
| `stslv-api/tests/amc-master-status.test.ts` | P0, P2 | Both kept |
| `docs/ROLES_PERMISSIONS.md` | P1, P2 | Both kept |

Semantic checks after merging: P2 removed the `superAdminOnly` middleware — no other branch used it (API
typecheck clean). P1's override of the Service Report No. relies on the Super Admin/Admin **roles**, which P2's
custom roles cannot imitate — tested in `tests/integration-cross-branch.test.ts`.

## 4. Changes made during integration

| Change | Why |
|---|---|
| `stslv-api/tests/integration-cross-branch.test.ts` (6 tests) | Paths that only exist once branches combine: a custom role with all of Admin's permissions is still not Admin (no role management, no session control over others, no report-number override); Admin ends a custom-role holder's session; Admin cannot end a Super Admin's sessions or build a Users & Access role; role and override audit entries are append-only |
| CSP hash in `deploy/hostinger/nginx/snippets/stslv-security-headers.conf` | Was computed from a CRLF (Windows) build; replaced with the LF hash a Linux build produces (verified) |
| `deploy/hostinger/fail2ban/stslv-jail.conf` (new) | Referenced by the VPS guide, missing from P0 |
| `deploy/hostinger/env/api.env.example` | P1 switches listed, off; expiry switch never in the API environment |
| User guide, in-app Help (`helpTopics.ts`) | P3 was written before the final P0/P1/P2 corrections: sessions and password rules, custom-role rules (Super Admin and Admin), report source permissions, calendar By contract, Zoho references, Service Report No. lock, contract expiry, counted services, Active sessions, prepared backups; "Sections awaiting integration review" replaced by "Integration review (2026-11-09)" |
| Handover, technical, UAT, training docs | Release notes; Outstanding Issues Register (OI-01, 02, 05, 07, 17, 19 updated; OI-20–22 added); completion report; API reference (session, role, usage, report, master-status endpoints); role permission matrix; technical handover (migrations, env names, backups, VPS, troubleshooting); UAT section 20 (INT-01…19) and USR-06; training AD-5, AD-6, SA-1; `AMC_MODULE.md` expiry note |
| `docs/integration/*` | This report and the six companion documents |

## 5. Final permissions (summary)

Full matrix: `docs/technical/ROLE_PERMISSION_MATRIX.md`. Role management (approved 2026-11-09, enforced in
`roles.service.ts` / `roles.routes.ts`):

| Action | Super Admin | Admin (needs Users & Access **Edit**) | Any other role (even with Users & Access Edit) |
|---|---|---|---|
| Add a custom role | Yes | Yes | No |
| Rename / deactivate / reactivate / delete a custom role | Yes | Only if Admin holds every permission of that role; never its own role | No |
| Change a custom role's permissions | Yes | Within Admin's own permissions | No |
| Give a role Users & Access permissions | Yes | **No** (removing is allowed) | No |
| Change a built-in role or its permissions | Yes (never Super Admin's own) | No | No |
| Assign a custom role to a user | Yes | Only if Admin holds all its permissions | Per USERS:EDIT, same limit |
| Assign Super Admin or Admin; manage their accounts | Yes | No | No |
| End other users' sessions | Yes | Yes, except Super Admin/Admin accounts | No |
| Override a locked Service Report No. (reason, audited) | Yes | Yes | No |

Reports: Reports View/Export **and** the source module's View/Export (AMC Contracts, AMC Renewal, Accounts);
Monthly Maintenance belongs to Accounts.

## 6. Verification summary

Details and counts: `TEST_RESULTS.md`. Migrations: `MIGRATION_READINESS.md`. Security: `SECURITY_REVIEW.md`.
Hosting: `HOSTINGER_READINESS.md`. UAT: `UAT_CHECKLIST.md`. Open items: `OUTSTANDING_ISSUES.md`.

## 7. Feature flags

| Flag | Default | Status |
|---|---|---|
| `AMC_CONTRACT_EXPIRY_ENABLED` | unset (off) | **Off.** Enabled only inside the isolated E2E run of the expiry job |
| `SERVICE_REPORT_NO_LOCK_ENABLED` | unset (off) | **Off.** Enabled only in tests and the isolated E2E API |

Neither is set in `render.yaml`, `stslv-api/.env.example` (commented) or `deploy/hostinger/env/api.env.example`
(commented).

## 8. Rollback strategy (for the eventual release)

1. Before release: production `pg_dump`, SHA-256, restore-tested; record `c6d8d19` + dump as the rollback pair.
2. Code-only problem after release: forward-fix. Reverting code needs the database to match (an older API
   refuses a database with newer migrations).
3. To return to `c6d8d19`: drop 0109's triggers and function and 0108's table, remove their
   `schema_migrations` rows (approval required; statements in `MIGRATION_READINESS.md` §5), redeploy `c6d8d19`.
4. Last resort: restore the pre-release dump into a new database and switch to it (loses later data).

## 9. Production approvals still required

See `OUTSTANDING_ISSUES.md` "Blocking a production release" and "Decisions and activations": migrations
0108/0109 on Neon; pre-release backup and drill; release window (forced re-sign-in); merging and pushing this
branch; deployment; the two P1 switches; backup activation; database roles; the VPS move and DNS switch.
