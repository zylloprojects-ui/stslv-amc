# Hostinger VPS Readiness

Final local integration, 2026-11-09. **Nothing has been deployed to a VPS.** No server was contacted, no SSH,
DNS, Nginx, certificate, firewall or Hostinger setting was touched. This document states how ready the
templates are and what remains.

Main references: `docs/HOSTINGER_VPS.md` (plan and setup order), `deploy/hostinger/` (templates),
`docs/BACKUP_AUTOMATION.md` (backups), `docs/technical/TECHNICAL_HANDOVER.md` §9–§10.

## 1. Target

Nginx on 443 (TLS, security headers, CSP, request limits) serving the web build and proxying `/api/` to the
Node.js API on `127.0.0.1:3001` under systemd. Neon PostgreSQL 17 and the Supabase private bucket are kept
initially. Backup and monitoring run as separate systemd timers under their own users.

## 2. Template inventory

| Area | Template | Status |
|---|---|---|
| Nginx site, HTTP→HTTPS, SPA fallback, `/api` proxy, request limits | `nginx/stslv-amc.conf`, `snippets/stslv-api-proxy.conf` | Ready (placeholders `__APP_DOMAIN__`) |
| TLS settings and renewal hook | `snippets/stslv-tls.conf`, `certbot/reload-nginx.sh` | Ready |
| Security headers and CSP | `snippets/stslv-security-headers.conf` | Ready. **Integration fix:** the inline-script hash was computed from a Windows (CRLF) build and would not have matched a Linux build; replaced with the LF hash. Recompute on the server after every web build (`scripts/csp-hash.sh`) |
| Firewall | `firewall/ufw-setup.sh` | Ready (22/80/443 only; 5432 never opened) |
| SSH hardening, non-root deploy user | `ssh/50-stslv-hardening.conf` | Ready (`__DEPLOY_USER__`; keys only, no root, no passwords) |
| fail2ban | `fail2ban/stslv-jail.conf` | **Added at integration**: referenced by the setup guide but missing from P0. Stock `sshd` and `nginx-limit-req` filters; add administrator addresses to `ignoreip` first |
| API service with migrations first, sandboxing, restart | `systemd/stslv-amc-api.service` | Ready |
| Backup timers (database, documents) | `systemd/stslv-amc-db-backup.*`, `stslv-amc-docs-backup.*` | Ready, **not to be enabled without approval** |
| Monitoring (disk, memory, certificate, API health, backup age) | `systemd/stslv-amc-monitor.*`, `scripts/monitor.sh` | Ready |
| Log rotation, journald limits | `logrotate/stslv-amc`, `journald/stslv-journald.conf` | Ready |
| Least-privilege database roles | `sql/backup-role.sql`, `sql/runtime-role.sql` | Prepared; applying them is a Neon access change (approval) |
| Environment files | `env/api.env.example`, `env/backup.env.example`, `env/monitor.env.example` | Names only, no values. **Integration addition:** both P1 switches listed in `api.env.example`, commented out (off) |
| Contract-expiry scheduled job | — | **Not provided.** Needs its own timer with `AMC_CONTRACT_EXPIRY_ENABLED` only in that unit, after approval |

All templates are checked out with LF endings (`deploy/.gitattributes`). No IP address, domain, password or
key is hard-coded; placeholders only.

## 3. Environment variable checklist (no values)

**API** (`/etc/stslv-amc/api.env`, root:stslv 0640): `NODE_ENV`, `PORT`, `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD`, `PGSSLMODE`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `SESSION_IDLE_TIMEOUT_MINUTES`,
`CORS_ORIGIN`, `APP_URL`, `TRUST_PROXY`, `MAIL_TRANSPORT`, `LOGIN_RATE_LIMIT`, `LOGIN_FAILURE_LIMIT`,
`PUBLIC_AUTH_RATE_LIMIT`, `TEMPORARY_PASSWORD_RATE_LIMIT`, `BCRYPT_ROUNDS`, `SUPABASE_PROJECT_REF` and the other
`SUPABASE_S3_*` names, `ATTACHMENT_MAX_MB`. Off until approved: `SERVICE_REPORT_NO_LOCK_ENABLED`.
Never here: `AMC_CONTRACT_EXPIRY_ENABLED`, any `BACKUP_*` credential.

**Backups** (`/etc/stslv-amc/backup.env`, root:stslv-backup 0640): `BACKUP_ENVIRONMENT`, database connection
names (read-only backup role), `BACKUP_DB_SCHEMAS`, `PG_DUMP_PATH`, `PG_RESTORE_PATH`, `BACKUP_GPG_RECIPIENT`
(full fingerprint), `GNUPGHOME`, `BACKUP_WORK_DIR`, `BACKUP_STATE_DIR`, `BACKUP_RETAIN_DAILY/WEEKLY/MONTHLY`,
`BACKUP_PRUNE`, `BACKUP_VERIFY_DOWNLOAD`, off-site bucket settings, `BACKUP_ALERT_WEBHOOK_URL`,
`BACKUP_HEARTBEAT_DB_URL`, `BACKUP_HEARTBEAT_DOCS_URL`, Supabase read access for document backups.

**Monitoring** (`/etc/stslv-amc/monitor.env`): `MONITOR_*` (alert webhook, heartbeat, public and API URLs,
disk paths and thresholds, memory, certificate days, backup age, repeat interval, state directory).

**Web build:** `VITE_API_BASE_URL` empty (same origin).

## 4. Prerequisites still to be decided or obtained (owner)

1. VPS plan, OS (Ubuntu 24.04 LTS assumed), server time zone (see OI-12).
2. Domain name and DNS records; whether HSTS `includeSubDomains` is safe.
3. Deploy user name and administrators' SSH keys and fixed addresses (`AllowUsers`, `ignoreip`).
4. Off-site backup bucket (independent of Supabase and Neon), its scoped key, the GnuPG key pair (private key
   kept offline by a named person), alert webhook and heartbeat service.
5. Whether documents stay in Supabase (current plan) or move to a durable local folder.
6. Approval for: migrations 0108/0109 on Neon, separate database roles, enabling backup timers, the first
   production restore drill, the two P1 switches, the DNS switch.

## 5. What has and has not been verified

| Verified (locally) | Not verified |
|---|---|
| Backup and restore code against a disposable PostgreSQL database, a throwaway GnuPG key and temporary folders (14 tests) | Any run against Neon, Supabase or a real off-site bucket |
| The ops CLI builds and refuses incomplete configuration without printing values | Any systemd unit, timer, Nginx, certbot, UFW, SSH or fail2ban file on a real server |
| CSP hash against an LF build of `index.html` | CSP in a real browser on the VPS (PDF viewer, exports) — UAT on the VPS address |
| Web production build, API build | Performance and resource limits on the chosen plan |

The VPS UAT list in `docs/HOSTINGER_VPS.md` ("UAT checklist on the VPS") must be completed on a temporary
host name **before** any DNS switch.

## 6. Verdict

Templates are **ready for review and a supervised first installation**. The VPS is **not ready for production**
until the decisions in §4 are made, the templates are installed and checked on a non-production host name, and
a production backup with a restore drill exists.
