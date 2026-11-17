# Automatic deployment: GitHub `main` → Hostinger VPS

Every push to `main` runs `.github/workflows/deploy-hostinger.yml`:

1. **Test and build** on GitHub's runner (PostgreSQL 17 service): API typecheck, build and tests (all migrations applied
   from scratch); web build (typecheck), lint and tests; then `package-release.sh` makes one archive
   (`RELEASE`, `api/` with production dependencies and migrations, `web/`). A failure stops here — nothing is deployed.
2. **Deploy** (only on `main`, only when the repository variable `HOSTINGER_DEPLOY_ENABLED` is `true`): the archive is
   streamed over SSH to the dedicated user `stselvdeploy`, whose key can run **one** command
   (`stselv-deploy-receive`). That hands it to `sudo stselv-release deploy <commit>` (root, fixed script), which:
   - verifies the archive (only `RELEASE`, `api/`, `web/`; no absolute paths, no `..`, links stay inside; commit matches);
   - compares the release's migrations with the database. A migration the database lacks is **refused** unless an
     administrator approved it for that commit (below); a database newer than the release is refused;
   - takes a verified `pg_dump` recovery point before an approved migration;
   - installs `/opt/stslv-amc/api/releases/<commit>` and `/var/www/stslv-amc/web/releases/<commit>`, switches both
     `current` symlinks atomically, restarts `stslv-amc-api` (which applies approved migrations at start);
   - health-checks: API health, database name, authentication (`/api/auth/me` → 401 without a token), the web page and
     its bundle through Nginx, and `/api/health` through Nginx;
   - on failure **without** a migration: switches back to the previous release and restarts (code rollback);
     on failure **after** a migration: does not roll back (the previous code cannot run on the migrated database),
     reports the recovery point — restoring it needs the owner's approval;
   - records `/var/lib/stselv-deploy/state/deployed.json` and `history.log`; keeps the 5 newest releases.
3. A public check of `HOSTINGER_URL` and a summary in the Actions run (the `hostinger` environment shows the deployment).

Never touched by a deployment: the database contents (apart from approved migrations), `/etc/stslv-amc/api.env`,
uploaded documents (`/var/lib/stslv-amc`), users and passwords, Nginx, systemd units, TLS certificates.

## One-time server setup (as `stselvadmin`, reviewed by hand)

```bash
sudo useradd --system --create-home --home-dir /var/lib/stselv-deploy --shell /bin/bash stselvdeploy
sudo passwd -l stselvdeploy
sudo install -d -m 750 -o stselvdeploy -g stselvdeploy /var/lib/stselv-deploy/incoming
sudo install -d -m 755 /var/lib/stselv-deploy/state /var/lib/stselv-deploy/staging
sudo install -d -m 700 /etc/stslv-amc/deploy-approvals
sudo install -m 755 -o root -g root stselv-deploy-receive stselv-release /usr/local/sbin/
echo 'stselvdeploy ALL=(root) NOPASSWD: /usr/local/sbin/stselv-release' | sudo tee /etc/sudoers.d/91-stselvdeploy
sudo chmod 440 /etc/sudoers.d/91-stselvdeploy && sudo visudo -cf /etc/sudoers.d/91-stselvdeploy
# The deploy key's PUBLIC half, restricted to the forced command:
sudo install -d -m 700 -o stselvdeploy -g stselvdeploy /var/lib/stselv-deploy/.ssh
echo 'restrict,command="/usr/local/sbin/stselv-deploy-receive" ssh-ed25519 AAAA... github-actions-stselv-deploy' \
  | sudo tee /var/lib/stselv-deploy/.ssh/authorized_keys
sudo chown stselvdeploy:stselvdeploy /var/lib/stselv-deploy/.ssh/authorized_keys && sudo chmod 600 /var/lib/stselv-deploy/.ssh/authorized_keys
# SSH: allow the deploy user (keys only, as for everyone):
#   /etc/ssh/sshd_config.d/01-stselv-hardening.conf  ->  AllowUsers stselvadmin stselvdeploy
sudo sshd -t && sudo systemctl reload ssh
```

The scripts in this folder are copied to the server **by hand** after review. A deployment never replaces them, so a
pushed commit cannot change what runs as root.

## GitHub settings (Settings → Environments → `hostinger`)

- Deployment branches: `main` only. Secret `HOSTINGER_SSH_KEY` (the deploy key's private half; never the personal key).
- Environment variables: `HOSTINGER_HOST`, `HOSTINGER_USER` (`stselvdeploy`), `HOSTINGER_KNOWN_HOSTS` (the server's
  pinned ED25519 host key line), `HOSTINGER_URL`.
- `HOSTINGER_DEPLOY_ENABLED` = `true` to switch deployment on (repository or `hostinger` environment variable; any
  other value = tests and builds only). The deploy job checks it in its first step and stops without touching the VPS
  when it is not `true`.
- Redeploy without a new commit: Actions → *Hostinger deploy* → *Run workflow* on `main`.

## Approving a migration

A push whose release brings a new migration fails the deploy job with exit 3 and the message
`new migrations need a separate approval`, listing each file and any risky statements. Nothing is changed. After
review (and the backups the release plan requires), an administrator approves exactly those versions for that commit:

```bash
echo '0119' | sudo tee /etc/stslv-amc/deploy-approvals/<40-character commit>.migrations
```

then re-runs the failed job in GitHub Actions. The server takes a verified recovery point before migrating.

## Manual checks and rollback

```bash
sudo /usr/local/sbin/stselv-release status                 # deployed commit and history
cat /var/lib/stselv-deploy/state/history.log
ls -1t /opt/stslv-amc/api/releases /var/www/stslv-amc/web/releases
# Manual code rollback to a kept release (only if no migration was applied since):
sudo ln -sfn /opt/stslv-amc/api/releases/<commit> /opt/stslv-amc/api/current
sudo ln -sfn /var/www/stslv-amc/web/releases/<commit> /var/www/stslv-amc/web/current
sudo systemctl restart stslv-amc-api
```

Exit codes of `stselv-release`: 0 deployed · 2 bad request · 3 refused before any change · 4 health check failed,
code rolled back · 5 health check failed after a migration (not rolled back; recovery point reported) · 6 another
deployment running.
