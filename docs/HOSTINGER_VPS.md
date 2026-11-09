# Hostinger VPS — Hosting Plan and Security Configuration (P0)

Prepared 2026-11-09 on `feature/stslv-p0-security`. **Templates only. Nothing has been installed, no SSH
session was opened, no VPS setting was changed.** Current production stays on Cloudflare Pages + Render +
Neon + Supabase until a migration is approved.

Templates: `deploy/hostinger/`. Placeholders that must be confirmed before use:

| Placeholder | Meaning |
|---|---|
| `__APP_DOMAIN__` | the confirmed public host name (no IP address or domain is assumed anywhere) |
| `__DEPLOY_USER__` | the confirmed non-root administrator account for SSH |

## Target architecture

```
Internet ── 443 ── Nginx (TLS, security headers, CSP, rate limits)
                    ├── /            static web build   /var/www/stslv-amc/web/current
                    └── /api/        127.0.0.1:3001     Node.js API (systemd: stslv-amc-api, user "stslv")
API ── TLS ── Neon PostgreSQL 17 (retained)      API ── HTTPS ── Supabase private bucket (retained)
Timers: stslv-amc-db-backup, stslv-amc-docs-backup (user "stslv-backup") ── HTTPS ── independent backup bucket
Timer:  stslv-amc-monitor (user "stslv-monitor") ── alerts webhook / heartbeat
```

Same-origin: the web build uses an **empty** `VITE_API_BASE_URL`, so the browser calls `/api` on the same host;
the API's `CORS_ORIGIN` is `https://__APP_DOMAIN__` and `TRUST_PROXY=1`.

Process manager: **systemd** (chosen over PM2: no extra runtime, built-in restart, resource limits, sandboxing,
journald logs, and timers for backups/monitoring).

## Files

| Template | Installed as |
|---|---|
| `nginx/stslv-amc.conf` | `/etc/nginx/sites-available/stslv-amc.conf` (+ link in `sites-enabled`) |
| `nginx/snippets/*.conf` | `/etc/nginx/snippets/` |
| `systemd/*.service`, `*.timer` | `/etc/systemd/system/` |
| `env/api.env.example` | `/etc/stslv-amc/api.env` (root:stslv 0640) |
| `env/backup.env.example` | `/etc/stslv-amc/backup.env` (root:stslv-backup 0640) |
| `env/monitor.env.example` | `/etc/stslv-amc/monitor.env` (root:stslv-monitor 0640) |
| `scripts/monitor.sh` | `/usr/local/lib/stslv-amc/monitor.sh` (root 0755) |
| `scripts/csp-hash.sh` | admin tool |
| `ssh/50-stslv-hardening.conf` | `/etc/ssh/sshd_config.d/` |
| `firewall/ufw-setup.sh` | run once by hand |
| `fail2ban/stslv-jail.conf` | `/etc/fail2ban/jail.d/stslv.local` |
| `logrotate/stslv-amc` | `/etc/logrotate.d/` |
| `journald/stslv-journald.conf` | `/etc/systemd/journald.conf.d/` |
| `certbot/reload-nginx.sh` | `/etc/letsencrypt/renewal-hooks/deploy/` |
| `sql/backup-role.sql`, `sql/runtime-role.sql` | Neon, by the owner, with approval |

## Setup order (for the approved migration day; Ubuntu 24.04 LTS assumed)

1. **Access first.** In hPanel: add the administrator's SSH public key. Create `__DEPLOY_USER__` with sudo and
   the key in `~/.ssh/authorized_keys`. Open a second session as that user and confirm `sudo` works.
2. **SSH hardening.** Install `ssh/50-stslv-hardening.conf`, `sshd -t`, `systemctl reload ssh`, and test a NEW
   session before closing the old one. Keep the hPanel browser console as the fallback.
3. **Firewall.** Review and run `firewall/ufw-setup.sh` (22 rate-limited or restricted, 80, 443 only). If
   Hostinger's panel firewall is used too, allow the same ports there.
4. **Updates.** `apt full-upgrade`; enable `unattended-upgrades` for security updates.
5. **Packages.** `nginx`, `certbot`, `python3-certbot-nginx` (or webroot), `fail2ban`, `gnupg`, `curl`,
   `postgresql-client-17` (PGDG repository; must be ≥ Neon's major version), Node.js 24 (NodeSource).
6. **Service users (no shell, no SSH):**
   `useradd --system --home /var/lib/stslv-amc --shell /usr/sbin/nologin stslv` and likewise `stslv-backup`
   (home `/var/lib/stslv-amc-backup`) and `stslv-monitor` (home `/var/lib/stslv-amc-monitor`).
   Folders: `/var/lib/stslv-amc-backup` 0711 (traverse only), its `state/` 0755, `work/` and `gnupg/` 0700.
7. **Environment files** from `env/*.example` with the owners/modes above. New `JWT_SECRET` (not Render's).
8. **Release layout:** `/opt/stslv-amc/api/releases/<commit>/` (with `npm ci --omit=dev` after building
   elsewhere, or `npm ci && npm run build` on the server), `current` → symlink; same for
   `/var/www/stslv-amc/web/releases/<commit>/` (contents of `stslv-web/dist`).
9. **TLS.** Install the Nginx config with the port-80 server only, obtain the certificate
   (`certbot certonly --webroot -w /var/www/letsencrypt -d __APP_DOMAIN__`), then enable the 443 server.
   Create the self-signed placeholder for the default 443 server
   (`openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj /CN=invalid -keyout /etc/nginx/ssl/default-reject.key -out /etc/nginx/ssl/default-reject.crt`).
   Renewal: the certbot package's timer; install `certbot/reload-nginx.sh`; test with `certbot renew --dry-run`.
10. **Check the CSP hash** against the release: `scripts/csp-hash.sh /var/www/stslv-amc/web/current/index.html`.
11. **API service:** install the unit, `systemctl enable --now stslv-amc-api`. Migrations run in `ExecStartPre`.
12. **Monitoring:** install `monitor.sh`, its env and timer; register an external uptime check on
    `https://__APP_DOMAIN__/api/health` (e.g. UptimeRobot / Better Stack / healthchecks) and the monitor
    heartbeat. Journald and logrotate drop-ins.
13. **Backups:** follow docs/BACKUP_AUTOMATION.md "Activation" (separate approvals).
14. **fail2ban:** install the jail, `systemctl restart fail2ban`, `fail2ban-client status`.
15. **DNS switch** only after UAT on the VPS address with a temporary host name.

## Operating

- Restart after a release: `systemctl restart stslv-amc-api` (migrations first, then the server).
- Logs: `journalctl -u stslv-amc-api -f`; Nginx under `/var/log/nginx/stslv-amc.*.log` (30 days).
- Release rollback: point `current` back to the previous release and restart — only if no new migration was
  applied (an older API refuses a newer database; then the database backup procedure applies).
- Resources: the API is limited to 1 GB RAM (`MemoryMax`); the monitor alerts at 80 % disk, < 10 % memory,
  failed units, health failures, certificate < 14 days, and a backup older than 26 h.

## Security headers and CSP (reviewed against the web app at c6d8d19)

`default-src 'self'; script-src 'self' 'sha256-…'` (one inline theme script, by hash); `style-src 'self'
'unsafe-inline'` (inline style attributes); `img-src 'self' data: blob:`; `connect-src 'self'`; `object-src
'none'`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`; plus HSTS (1 year, no
includeSubDomains until confirmed), nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Permissions-Policy`, COOP and CORP. API responses additionally get `default-src 'none'`.

## UAT checklist on the VPS (before DNS switch)

- [ ] Sign in, sign out; the old token is refused afterwards.
- [ ] Idle 31 minutes on a page: signed out with the inactivity message.
- [ ] My Account → Active sessions; sign out another browser; sign out of all devices.
- [ ] Security Center → Active sessions; sign a test user out.
- [ ] Upload and open a contract document and a service report PDF (checks CSP `object-src` with the PDF
      viewer; if the PDF does not display, change `object-src` to `'self' blob:` only).
- [ ] Every export (Excel, PDF) downloads.
- [ ] Browser console: no CSP violations.
- [ ] `curl -I https://__APP_DOMAIN__/` shows the headers above; `https://__APP_DOMAIN__/api/health` → 200;
      port 3001 not reachable from outside.
- [ ] `certbot renew --dry-run` passes; monitor alert arrives when the API is stopped for 10 minutes.
