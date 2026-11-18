# Hostinger VPS templates (STSLV AMC)

Configuration templates for moving the web application and API to a Hostinger VPS behind Nginx with HTTPS,
keeping Neon PostgreSQL and Supabase Storage. Nothing here contains a secret: fill the remaining placeholders
(`__DEPLOY_USER__`) on the server only.

**Production host names (2026-11-18):** `https://stsamc.com` (primary), `www.stsamc.com` (301 to the primary)
and `srv2167443.hstgr.cloud` (Hostinger host name, still serves the application). `nginx/stslv-amc.conf` and the
`CORS_ORIGIN`/`APP_URL` lines in `env/api.env.example` match the VPS. A GitHub deployment never changes Nginx,
certificates or `/etc/stslv-amc/api.env`; change them by hand and update these copies in the same pull request.

Read first: [docs/HOSTINGER_VPS.md](../../docs/HOSTINGER_VPS.md) (setup order, UAT checklist) and
[docs/BACKUP_AUTOMATION.md](../../docs/BACKUP_AUTOMATION.md) (backups, keys, recovery runbook).

Never commit a filled-in `*.env` file. The repository is public.
