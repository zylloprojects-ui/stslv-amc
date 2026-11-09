# Hostinger VPS templates (STSLV AMC)

Configuration templates for moving the web application and API to a Hostinger VPS behind Nginx with HTTPS,
keeping Neon PostgreSQL and Supabase Storage. **Not deployed.** Nothing here contains a secret, IP address or
unconfirmed domain: fill the placeholders (`__APP_DOMAIN__`, `__DEPLOY_USER__`) on the server only.

Read first: [docs/HOSTINGER_VPS.md](../../docs/HOSTINGER_VPS.md) (setup order, UAT checklist) and
[docs/BACKUP_AUTOMATION.md](../../docs/BACKUP_AUTOMATION.md) (backups, keys, recovery runbook).

Never commit a filled-in `*.env` file. The repository is public.
