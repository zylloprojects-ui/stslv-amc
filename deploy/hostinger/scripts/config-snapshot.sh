#!/usr/bin/env bash
# STSLV AMC — encrypted snapshot of the VPS configuration, for the weekly full backup.
# Installed as /usr/local/sbin/stslv-amc-config-snapshot (root:root 0755). Run as root by
# stslv-amc-backup-weekly.service (ExecStartPre=+) right before the weekly job; never on its own schedule.
#
# The configuration files belong to root and hold secrets (api.env, backup.env, TLS private keys). They are read
# here and streamed through `tar | gpg` straight into an encrypted file: the plain archive never touches the disk.
# GnuPG runs as the "stslv-backup" user with its own keyring, which holds the backup PUBLIC key only.
# Output (owner stslv-backup, 0600), uploaded by `cli.js scheduled-backup --kind weekly`:
#   $BACKUP_WORK_DIR/config-snapshot.tar.gpg   the encrypted archive
#   $BACKUP_WORK_DIR/config-snapshot.paths     the paths included (names only)
set -euo pipefail
umask 077

ENV_FILE="${STSLV_BACKUP_ENV:-/etc/stslv-amc/backup.env}"
BACKUP_USER="${STSLV_BACKUP_USER:-stslv-backup}"

setting() { awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); gsub(/^[ \t"]+|[ \t"]+$/, ""); print; exit }' "$ENV_FILE"; }

RECIPIENT="$(setting BACKUP_GPG_RECIPIENT | tr -d ' ')"
GNUPG_DIR="$(setting GNUPGHOME)"
WORK_DIR="$(setting BACKUP_WORK_DIR)"
[[ "$RECIPIENT" =~ ^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$ ]] || { echo "config-snapshot: BACKUP_GPG_RECIPIENT must be a full fingerprint" >&2; exit 1; }
[ -n "$GNUPG_DIR" ] && [ -n "$WORK_DIR" ] || { echo "config-snapshot: GNUPGHOME and BACKUP_WORK_DIR must be set in $ENV_FILE" >&2; exit 1; }

# What is needed to rebuild the server (application code comes from GitHub; data from the other backups).
CANDIDATES=(
  /etc/stslv-amc
  /etc/nginx/nginx.conf /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/snippets
  /etc/letsencrypt
  /etc/systemd/system/stslv-amc-api.service /etc/systemd/system/stslv-amc-api.service.d
  /etc/systemd/system/stslv-amc-backup-daily.service /etc/systemd/system/stslv-amc-backup-daily.timer
  /etc/systemd/system/stslv-amc-backup-weekly.service /etc/systemd/system/stslv-amc-backup-weekly.timer
  /usr/local/sbin/stselv-release /usr/local/sbin/stselv-deploy-receive /usr/local/sbin/stslv-amc-config-snapshot
  /etc/sudoers.d/91-stselvdeploy
  /etc/ssh/sshd_config.d
  /etc/ufw/user.rules /etc/ufw/user6.rules
  /etc/fail2ban/jail.local /etc/fail2ban/jail.d
  /etc/postgresql/17/main/postgresql.conf /etc/postgresql/17/main/pg_hba.conf
  /var/lib/stselv-deploy/state /var/lib/stselv-deploy/.ssh/authorized_keys
)
PATHS=()
for candidate in "${CANDIDATES[@]}"; do [ -e "$candidate" ] && PATHS+=("$candidate"); done
[ "${#PATHS[@]}" -gt 0 ] || { echo "config-snapshot: none of the configuration paths exist" >&2; exit 1; }

install -d -m 700 -o "$BACKUP_USER" -g "$BACKUP_USER" "$WORK_DIR"
OUT="$WORK_DIR/config-snapshot.tar.gpg"
LIST="$WORK_DIR/config-snapshot.paths"
PART="$OUT.part"
rm -f "$OUT" "$LIST" "$PART"

# tar (root, reads the files) | gpg (backup user, public key only) -> encrypted file owned by the backup user.
tar --create --file - --numeric-owner --absolute-names --ignore-failed-read "${PATHS[@]}" 2>/dev/null \
  | runuser -u "$BACKUP_USER" -- gpg --batch --quiet --homedir "$GNUPG_DIR" --trust-model always \
      --recipient "$RECIPIENT" --encrypt --output "$PART"

printf '%s\n' "${PATHS[@]}" > "$LIST"
chown "$BACKUP_USER:$BACKUP_USER" "$LIST" "$PART"
chmod 600 "$LIST" "$PART"
mv -f "$PART" "$OUT"
echo "config-snapshot: ${#PATHS[@]} paths, $(stat -c %s "$OUT") encrypted bytes"
