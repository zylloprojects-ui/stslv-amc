# Security Review — Final Integration

2026-11-09, branch `integration/stslv-amc-final-20261109` (P0 + P1 + P2 + P3 on `c6d8d19`). A code and
behaviour review on local, isolated resources only. No external or production service was tested; no
disruptive testing was done.

Severity: **Critical** (exploitable now, data or account compromise) · **High** · **Medium** · **Low** · **Info**.

## 1. Findings

| # | Severity | Area | Finding | Status |
|---|---|---|---|---|
| S-1 | Medium | Hosting template (P0) | The CSP `script-src` hash in `deploy/hostinger/nginx/snippets/stslv-security-headers.conf` was computed from a Windows (CRLF) build of `index.html`; a Linux build (LF) has a different hash, so Nginx would have blocked the inline theme script on the VPS. Not a security weakness (the policy fails closed), but the template was wrong for its target. | **Fixed** in integration: LF hash `sha256-ZH6Lv…HSA=`, verified against an LF build; comment requires recomputing on the server after each build |
| S-2 | Medium | Hosting template (P0) | The VPS setup guide (step 14) installs `deploy/hostinger/fail2ban/stslv-jail.conf`, which did not exist. | **Fixed**: template added (stock `sshd`, `nginx-limit-req` jails, ufw ban action); administrators' addresses must be added to `ignoreip` before enabling |
| S-3 | Low | Configuration template | `deploy/hostinger/env/api.env.example` did not mention the two P1 switches; an operator could have set the expiry switch in the web API's environment. | **Fixed**: both listed, commented out (off), with the rule that `AMC_CONTRACT_EXPIRY_ENABLED` belongs only to the scheduled job |
| S-4 | Low | Database privileges | The single Neon role owns `activity_logs`, so it could drop the 0109 triggers with DDL. | **Open** (by design until the separate runtime role in `deploy/hostinger/sql/runtime-role.sql` is approved) — OI-21 |
| S-5 | Info | Legacy APIs | `/api/projects`, `/api/procurement`, `/api/expenses` remain mounted (as at `c6d8d19`); their screens were removed at the client's request. They are permission-checked. Not introduced by this integration. | Unchanged — OI-11 decision |
| S-6 | Info | Public repository | The repository is public (OI-03). The scan below found no secrets. | Owner decision |

No Critical or High finding. No integration-introduced security defect remains open.

## 2. Checks performed

| Check | Method | Result |
|---|---|---|
| Missing backend authorization on new routes | Read every new/changed route: `/api/auth/logout-all`, `/api/auth/sessions` (+ DELETE), `/api/users/:id/sessions` (GET, revoke, DELETE), `/api/security/sessions`, `/api/roles` (all writes), `/api/amc/contracts/:id/usage`, `/api/reports/*` | Every route authenticates; writes check permission **and** role where required; services re-check |
| Privilege escalation via roles | `tests/admin-custom-roles.test.ts` (Admin limits), `tests/integration-cross-branch.test.ts` (a custom role with **all** of Admin's permissions still cannot manage roles, end others' sessions or override the report-number lock; Admin cannot build a Users & Access "back door" role or assign Super Admin), browser E2E 3b/3c | Pass |
| Insecure direct object references | Own-session revoke is scoped by `user_id` (another user's session id → 404); admin session routes apply `assertCanManageUser` (Admin cannot touch Super Admin/Admin accounts); report and export routes check the source module | Pass (tests `sessions.test.ts`, cross-branch, `reports-permissions.test.ts`) |
| Cross-user data exposure | Help, reports and role lists filtered server-side by permission; E2E 4, 11, 14 | Pass |
| SQL injection | Scanned every SQL template in the 48 changed API files for interpolation: only code constants, numbered `$n` placeholders and a fixed table-name union are interpolated; all values are parameters | Pass |
| Unsafe file access | Unchanged attachment code (storage keys server-generated); backup restore refuses non-isolated targets and never overwrites (`ops-backup.test.ts`); the read-only store view has no write methods | Pass |
| Session invalidation | Logout, logout-all, admin revoke, password change, temporary password, deactivation, idle timeout (30 min), pre-0108 tokens refused: `sessions.test.ts`; E2E 13 through the Security Center UI | Pass |
| Password policy | `password-policy.test.ts` (12+ chars, classes, distinct, weak bases, personal parts; existing hashes still sign in); API and web share the rules | Pass |
| Audit Log modification | 0109 triggers: UPDATE/DELETE/TRUNCATE refused on fresh and upgraded schemas (`MIGRATION_READINESS.md`), `audit-log-protection.test.ts`, cross-branch test on override and role-change entries | Pass (S-4 residual) |
| Secrets in source | Pattern scan (private keys, connection strings with passwords, AWS/Stripe/GitHub tokens, JWTs, `*_PASSWORD=`/`*_SECRET=` values, non-documentation IP addresses, `.env` files) over all 191 files the integration adds or changes | Clean |
| Unsafe environment defaults | Both P1 switches off unless exactly `true`; `SESSION_IDLE_TIMEOUT_MINUTES` 30 (5–1440); `MAIL_TRANSPORT=memory` refused outside tests; backup CLI refuses incomplete configuration and does not read the API's `.env` | Pass |
| Backup credential exposure | Backup logs redact configured secrets (`log.ts`, tested); backup environment kept in its own file and service user; GnuPG public key only on the server | Pass (code); not exercised in production |
| Unintended destructive operations | Restore drills only into `stslv_restore_*` or empty folders; production document store refused as destination; retention never deletes the newest backup; `contracts:expire` changes only status, is idempotent, needs the switch | Pass |
| Rate limits and error disclosure | Existing sign-in, public-auth and temporary-password limits unchanged (`auth-login-limits.test.ts`); errors return codes/messages without stack traces (`admin-security-gaps.test.ts`) | Pass |

## 3. Residual risks (production)

- Nothing here was exercised against Neon, Supabase, Render, Cloudflare or a VPS.
- The CSP has not been checked in a real browser on the VPS (PDF viewer, exports) — VPS UAT.
- Session revocation is server-side, but a stolen token remains usable until revoked, idle-expired or expired;
  HTTPS and the 30-minute idle limit bound this.
- Backups exist only as code until activated; until then OI-01 (S1) stands.
