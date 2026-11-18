#!/usr/bin/env bash
# STSLV AMC — encrypted snapshot of the VPS configuration, for the weekly/monthly full backup.
# Installed as /usr/local/sbin/stslv-amc-config-snapshot (root:root 0755). Run as root by
# stslv-amc-backup-weekly.service (ExecStartPre=-+) right before the Friday job; never on its own schedule.
#
# The configuration files belong to root and hold secrets (api.env, backup.env, TLS private keys). They are read
# here and streamed through `tar | gpg` straight into an encrypted file: the plain archive never touches the disk.
# GnuPG runs as the "stslv-backup" user with its own keyring, which holds the backup PUBLIC key only.
#
# Privilege boundary (review 2026-11-18): root ONLY READS (tar, pg_dumpall). Every file created, moved or removed in
# the backup user's work folder is handled AS THAT USER (runuser), so a link planted there by a compromised backup
# job can never make root write, chown or chmod anything else. Root never creates or changes the work folder.
#
# Also included, in "postgres/" inside the archive: the cluster's role definitions WITHOUT passwords
# (pg_dumpall --globals-only --no-role-passwords) and the application database's schema WITH owners and grants
# (pg_dump --schema-only): the daily database backup is made --no-owner --no-privileges, so this is what rebuilds
# the roles and permissions around it.
#
# Output (owner stslv-backup, 0600), uploaded by `cli.js scheduled-backup --kind weekly`:
#   $BACKUP_WORK_DIR/config-snapshot.tar.gpg   the encrypted archive
#   $BACKUP_WORK_DIR/config-snapshot.paths     the paths included (names only)
# A failure here does not stop the Friday database and document backups (ExecStartPre=-): the configuration step
# then finds no fresh snapshot and alerts.
set -euo pipefail
umask 077

ENV_FILE="${STSLV_BACKUP_ENV:-/etc/stslv-amc/backup.env}"
BACKUP_USER="${STSLV_BACKUP_USER:-stslv-backup}"
log() { echo "config-snapshot: $*" >&2; }

setting() { awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); gsub(/^[ \t"]+|[ \t"]+$/, ""); print; exit }' "$ENV_FILE"; }
as_backup_user() { runuser -u "$BACKUP_USER" -- "$@"; }

RECIPIENT="$(setting BACKUP_GPG_RECIPIENT | tr -d ' ')"
GNUPG_DIR="$(setting GNUPGHOME)"
WORK_DIR="$(setting BACKUP_WORK_DIR)"
DB_NAME="$(setting DB_NAME)"
[[ "$RECIPIENT" =~ ^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$ ]] || { log "BACKUP_GPG_RECIPIENT must be a full fingerprint"; exit 1; }
[ -n "$GNUPG_DIR" ] && [ -n "$WORK_DIR" ] || { log "GNUPGHOME and BACKUP_WORK_DIR must be set in $ENV_FILE"; exit 1; }
# The work folder is created at installation (docs/BACKUP_AUTOMATION.md); here it must be a real directory owned by
# the backup user. Root does not create or repair it.
[ -d "$WORK_DIR" ] && [ ! -L "$WORK_DIR" ] && [ "$(stat -c %U "$WORK_DIR")" = "$BACKUP_USER" ] \
  || { log "$WORK_DIR must be an existing directory owned by $BACKUP_USER"; exit 1; }

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
[ "${#PATHS[@]}" -gt 0 ] || { log "none of the configuration paths exist"; exit 1; }

# PostgreSQL roles and schema: written by the postgres user into a private root-owned temporary folder (mktemp -d,
# 0700), streamed into the same encrypted archive, removed on exit. No passwords: --no-role-passwords.
PGTMP="$(mktemp -d)"
trap 'rm -rf "$PGTMP"' EXIT
chmod 711 "$PGTMP"   # postgres may enter (not list) it to reach its own 0700 sub-folder
install -d -m 700 -o postgres -g postgres "$PGTMP/postgres"
EXTRA=()
if runuser -u postgres -- pg_dumpall --globals-only --no-role-passwords --file="$PGTMP/postgres/globals.sql" \
   && { [ -z "$DB_NAME" ] || runuser -u postgres -- pg_dump --schema-only --dbname="$DB_NAME" --file="$PGTMP/postgres/schema.sql"; }; then
  EXTRA=(-C "$PGTMP" postgres)
else
  log "WARNING: PostgreSQL roles/schema could not be exported; the snapshot continues without them"
fi

OUT="$WORK_DIR/config-snapshot.tar.gpg"
LIST="$WORK_DIR/config-snapshot.paths"
PART="$OUT.part"
as_backup_user rm -f -- "$OUT" "$LIST" "$PART" "$LIST.part"

# tar (root, reads the files) | gpg (backup user, public key only) -> encrypted file created by the backup user.
# tar exit 1 = "some files differ" (a file changed while read, e.g. a certificate renewal): logged, accepted.
set +o pipefail
tar --create --file - --numeric-owner --absolute-names --ignore-failed-read "${PATHS[@]}" "${EXTRA[@]}" \
  | as_backup_user gpg --batch --quiet --homedir "$GNUPG_DIR" --trust-model always \
      --recipient "$RECIPIENT" --encrypt --output "$PART"
STATUS=("${PIPESTATUS[@]}")
set -o pipefail
if [ "${STATUS[1]}" -ne 0 ]; then log "gpg failed (exit ${STATUS[1]})"; as_backup_user rm -f -- "$PART"; exit 1; fi
if [ "${STATUS[0]}" -gt 1 ]; then log "tar failed (exit ${STATUS[0]})"; as_backup_user rm -f -- "$PART"; exit 1; fi
if [ "${STATUS[0]}" -eq 1 ]; then log "WARNING: tar reported files that changed while being read; snapshot kept"; fi

LISTED=("${PATHS[@]}")
if [ "${#EXTRA[@]}" -gt 0 ]; then LISTED+=(postgres/globals.sql postgres/schema.sql); fi
printf '%s\n' "${LISTED[@]}" | as_backup_user sh -c 'umask 077; cat > "$1"' sh "$LIST.part"
as_backup_user mv -f -- "$LIST.part" "$LIST"
as_backup_user mv -f -- "$PART" "$OUT"
log "${#PATHS[@]} paths$([ "${#EXTRA[@]}" -gt 0 ] && echo " + PostgreSQL roles/schema"), $(as_backup_user stat -c %s -- "$OUT") encrypted bytes"
