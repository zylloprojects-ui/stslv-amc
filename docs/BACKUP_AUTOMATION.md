# Backup Automation and Recovery (P0)

Prepared 2026-11-09 on `feature/stslv-p0-security`. **Nothing here is scheduled, and no production backup
has been taken with it.** Every step that touches Neon, Supabase, the VPS or a real bucket needs approval
(see "Activation").

Code: `stslv-api/src/ops/` (CLI `dist/ops/cli.js`; from source in development: `npm run ops -- <command>`). Server units: `deploy/hostinger/systemd/`. Settings
template: `deploy/hostinger/env/backup.env.example`. Tests: `stslv-api/tests/ops-backup.test.ts` (backup, restore,
retention) and `stslv-api/tests/ops-schedule.test.ts` (schedule, no overlap, no duplicates, configuration backup).

## Schedule (approved 2026-11-18, final)

| Recovery point | When (18:00 IST = 12:30 UTC) | Started by | What | Kept off-site |
|---|---|---|---|---|
| **Daily** | Saturday–Thursday | `stslv-amc-backup-daily.timer` — `OnCalendar=Mon..Thu,Sat,Sun *-*-* 18:00:00 Asia/Kolkata` | Database + documents | newest **14** |
| **Weekly** | every Friday except the last Friday of the month | `stslv-amc-backup-weekly.timer` — `OnCalendar=Fri *-*-* 18:00:00 Asia/Kolkata` | Database + documents + VPS configuration | newest **8** |
| **Monthly** | the last Friday of each month | the same Friday timer; the job sees it is the last Friday | Database + documents + VPS configuration | newest **12** |

- **Exactly one backup a day.** Monthly replaces weekly, weekly replaces daily. A calendar expression cannot say
  "every Friday except the last one", so there is one Friday timer and the Friday job decides from the IST date
  whether it is the weekly or the monthly backup (`schedule.ts`: `isLastFridayOfMonth`, `fridayJobKind`). The daily
  job refuses to run on a Friday (IST). Checked by tests for 4- and 5-Friday months, a month ending on a Friday,
  the turn of the year and a whole year (2027: 12 monthly, 41 weekly, 312 daily, 365 days, one each).
- 18:00 IST is 12:30 UTC all year (India has no daylight saving time) and 16:30 in Oman. The VPS clock stays on
  UTC: the time zone is part of each timer. The IST date decides (Friday 23:59 IST is still Friday).
- **Recovery-point types.** Every database and configuration backup carries its type off-site as a small marker
  object (`db/<id>.kind-<type>.json`, `config/<id>.kind-<type>.json`) written before its manifest. Retention
  (`retention.ts` `selectByKind`) keeps the newest 14 daily, 8 weekly and 12 monthly backups, counted only over
  COMPLETE backups — the manifest is written after the off-site copy was verified — and always keeps the newest.
  Pruning never runs while 7 or fewer complete backups exist. A backup made by hand (or before types existed)
  counts as daily. Configuration copies: 8 weekly (never fewer than 4) and 12 monthly.
- **No overlap.** Every backup command — scheduled or run by hand (`db-backup`, `docs-backup`, `config-backup`) —
  takes one lock (`<state dir>/backup.lock`). A second job waits for the first to finish (up to 2 hours), then
  carries on; a lock whose process has died, that was written before the last reboot (the lock records the Linux
  boot id, because process ids are reused), or older than 4 hours, is reclaimed. Reclaiming is serialized by a short
  exclusive mutex, so jobs catching up together at boot can never both take it. If the wait runs out, the job sends an alert and
  exits 75 (the unit shows as failed, so the monitor reports it too).
- **One record per scheduled slot, even after downtime.** A job belongs to the most recent 18:00 IST at or before
  its start (`scheduleSlot`): a run started before 18:00 is the PREVIOUS day's backup. The steps completed per slot,
  the type reached and the backup ids are recorded in `<state dir>/schedule.json`; a job runs only the steps still
  missing for its slot. `Persistent=true` starts a missed run once at boot. Example: server off from Thursday 17:00
  to Saturday 09:00 IST: at boot the Friday job makes Friday's weekly (or monthly) backup, the daily catch-up falls in
  Friday's slot and does nothing, and Saturday 18:00 makes Saturday's backup as usual. (Before this rule, review
  2026-11-18, the boot-time catch-up was recorded against Saturday and Saturday's 18:00 backup was skipped.) If a
  daily backup already ran for the slot, a Friday catch-up PROMOTES it (adds the weekly/monthly marker) instead of
  making a second backup, and adds only the configuration.
- **Runs by hand** (`systemctl start stslv-amc-backup-daily`) follow the same rule: before 18:00 IST they count for
  the previous day's slot and do nothing if that backup is already complete. For an extra backup at any time use
  `db-backup` / `docs-backup` directly (counted as daily, under the same lock).
- A failed step does not stop the following ones and is not recorded, so the next job that day retries it.
- Upcoming runs: `node dist/ops/cli.js schedule`; on the server also
  `systemd-analyze calendar --iterations=7 'Mon..Thu,Sat,Sun *-*-* 18:00:00 Asia/Kolkata'`,
  `systemd-analyze calendar --iterations=12 'Fri *-*~07/1 18:00:00 Asia/Kolkata'` (the last Fridays, for reference)
  and `systemctl list-timers 'stslv-amc-backup-*'`.
- **Independently restorable.** Each database backup is a full `pg_dump`; each document manifest lists every file
  with its encrypted copy; each configuration backup is a full archive. Restoring any one recovery point needs no
  other backup.

## Google Drive (the off-site destination, approved 2026-11-18)

Off-site copies go to the owner's Google Drive: **My Drive / "STS-ELV Backup"**, through
[rclone](https://rclone.org/drive/) (`stslv-api/src/ops/backup/rclone-store.ts`). S3-compatible buckets remain
supported (`BACKUP_S3_*`) but are not used.

```
STS-ELV Backup/            (Drive ID in BACKUP_GDRIVE_FOLDER_ID)
  Daily/    db/  docs/                  newest 14 recovery points
  Weekly/   db/  docs/  config/         newest 8
  Monthly/  db/  docs/  config/         newest 12
```

- **Each folder is complete on its own**: every recovery point there has its full database dump, a document
  manifest with every document's encrypted copy in the same folder, and (weekly/monthly) the configuration archive.
  Restore commands take `--kind daily|weekly|monthly` to choose the folder.
- **The destination is verified before every run**: `BACKUP_GDRIVE_FOLDER_ID` must be the single folder named
  "STS-ELV Backup" at the top of My Drive (Drive allows duplicate names; two such folders stop the run). The
  type sub-folder is created on first use. Nothing is written to an unverified destination.
- **Only encrypted data is uploaded — manifests included.** Database, document and configuration manifests (table
  names and row counts, document file names and record details, configuration paths) are encrypted with the backup
  public key like the backups (`manifest-crypto.ts`, `*.manifest.json.gpg`, `docs/manifests/<run>.json.gpg`). The
  server writes them but cannot read them; restores read them with the private key. The ONLY plain objects are the
  tiny type markers `<id>.kind-<daily|weekly|monthly>.json` (`{id, kind, time}`), which retention needs without
  decrypting. The store refuses, before rclone starts, any `.gpg` file that is not OpenPGP, any other plain file,
  a marker with any other field, and anything containing key or token material. Never uploaded: the private GPG
  key, its passphrase, plain dumps, plain documents, plain configuration, the rclone/OAuth configuration.
- **Production pre-flight** before every backup (`preflight.ts`): the backup keyring must hold NO private key
  (checked on disk and through GnuPG) and the rclone configuration must be mode 0600 and owned by the backup user;
  otherwise the run stops with an alert. After a crash, the next scheduled job removes leftover run folders (which
  may hold plain copies) before doing anything else.
- **Verified, never overwritten**: an existing name is never written again (`--immutable`, plus a check first);
  after each upload there must be exactly one file of that name with the right size and MD5 (Drive's checksum),
  then the job downloads it again and compares SHA-256 (`BACKUP_VERIFY_DOWNLOAD=true`). Uploads to Drive are
  resumable and atomic: an interrupted upload leaves no partial file; the next run uploads it again.
- **Promotion** (a weekly/monthly job on a day whose daily backup already ran): the database (and configuration)
  backup is *copied on the Drive server* into the higher folder, checked (size + MD5), the type marker added, the
  manifest copied last, and only then the lower copy is moved to the Drive trash. Documents are copied into the
  higher folder's set. Never a second database backup for the same day.
- **Pruning moves files to the Drive trash** (rclone's default): a pruned recovery point can be restored from the
  trash for 30 days. Trashed files still count toward the Drive quota until emptied.
- **Errors**: rclone retries API errors (`--retries 3 --low-level-retries 10`, its Drive pacer handles rate limits).
  What remains is reported in plain words, alerted and pinged to the heartbeat `/fail`: *authorization expired or
  revoked* (re-authorize, below), *Drive full*, *rate limited* (the next run retries). Tokens are never logged.
  Below 1 GB free space a warning is logged before each run.

### Authorization (OAuth) and least privilege

- rclone uses a Google OAuth **refresh token** for the owner's account, stored only in
  `/var/lib/stslv-amc-backup/rclone/rclone.conf` (owner `stslv-backup`, mode 0600; rclone rewrites it when the
  access token is refreshed). It is not in GitHub, the application, `backup.env`, the configuration backup or chat.
- **Account and scope (decided 2026-11-18)**: a **dedicated Google account used only for STSLV AMC backups**, with
  its existing "STS-ELV Backup" folder. Google's narrowest scope, `drive.file`, only reaches files *created by
  rclone itself* and cannot see a folder the owner created, so the existing folder needs the full `drive` scope.
  The application restricts itself to the verified folder ID (`--drive-root-folder-id` on every call, the ID/name
  check before every run, sub-folders created only inside it). **Remaining risk**: the token stored on the VPS
  could, if the VPS itself were compromised, read or trash anything in that Google account — which is acceptable
  because the account holds nothing but these encrypted backups (no mail, no personal files). Keep it that way;
  protect the account with a strong password and 2-step verification held by the business; deleted backups stay
  recoverable in the trash for 30 days.
- **OAuth client**: rclone's built-in client works but shares Google's API quota with all rclone users; a client
  created in the owner's Google Cloud project is more reliable. If that client stays in "Testing" status, Google
  expires its refresh tokens after **7 days** — publish it ("In production", no verification needed for personal
  use) or the backups will stop weekly with an authorization alert.
- **Authorizing without sharing anything in chat**: on the VPS, `rclone config` (remote `stselv-gdrive`, type
  `drive`, scope as decided above, *auto config* = no) prints a command for a machine with a browser. On this PC
  rclone is blocked by Windows application control, so instead run it on the VPS with an SSH tunnel: `ssh -L
  53682:127.0.0.1:53682 <admin-user>@<VPS>`, then on the VPS `sudo -u stslv-backup rclone authorize drive
  --auth-no-open-browser` and open the printed `http://127.0.0.1:53682/auth?...` link in the browser on this PC;
  the owner approves in Google's page; the token goes straight into the VPS configuration.
- **Revoking**: Google Account → Security → Third-party access → rclone → remove access. The backups then fail with
  an authorization alert until rclone is authorized again.

### Storage

Today's data is tiny: an encrypted database dump of ~0.5 MB, configuration ~0.1 MB, documents a few MB. With
14 + 8 + 12 recovery points (documents de-duplicated within each folder) the total stays well below 1 GB for a long
time. A free Google account has 15 GB shared with Gmail and Photos; check free space in Drive → Storage. If the
Drive fills, backups fail with a "Drive is full" alert — they never delete older recovery points to make room.

The in-app "Backup & Restore" page (docs/BACKUP_RESTORE.md) is unchanged and stays off on the VPS.

## What is protected, and how

| | Database | Documents (VPS folder or Supabase/R2 bucket) | VPS configuration |
|---|---|---|---|
| Frequency | Every day at 18:00 IST (daily, weekly or monthly job) | Same | Fridays 18:00 IST (weekly or monthly job) |
| Method | `pg_dump` custom format inside an exported snapshot, as the read-only role `stslv-backup` (peer authentication over the local socket, no password) | Every document (`ATTACHMENTS_DIR` files, or bucket objects under `attachments/`), compared with the `attachments` table | `config-snapshot.sh` (root, read-only): `tar` of `/etc/stslv-amc`, Nginx, Let's Encrypt, systemd units, deploy scripts, sudoers, SSH/UFW/fail2ban, PostgreSQL settings, plus PostgreSQL role definitions without passwords (`postgres/globals.sql`) and the schema with owners and grants (`postgres/schema.sql`), streamed straight into GnuPG |
| Encryption | GnuPG, backup **public** key, AES-256 | Same, one encrypted file per document | Same; the plain archive never touches the disk |
| Destination | Google Drive `<Daily\|Weekly\|Monthly>/db/<id>.dump.gpg` + `db/<id>.manifest.json.gpg` + type marker | Same folder, `docs/files/<path>/<sha256>.gpg` + `docs/manifests/<run>.json.gpg` | `<Weekly\|Monthly>/config/<id>.tar.gpg` + `config/<id>.manifest.json.gpg` + type marker |
| Retention | newest 14 daily, 8 weekly, 12 monthly by recovery-point type (`BACKUP_RETAIN_*`; code default 7/4/12) | Kept indefinitely; never overwritten or deleted | By type: 8 weekly (never fewer than 4) + 12 monthly |
| Verification | Row counts in the snapshot, `pg_restore --list`, upload size, re-download checksum | SHA-256 against the database, upload size; full re-hash with `--verify-source` | Refuses a file that is not OpenPGP-encrypted or older than 6 h; upload size; re-download checksum |
| Alerting | Webhook on failure, heartbeat ping (success / fail), state file for the monitor | Same, plus alert on missing or altered files | Webhook, `BACKUP_HEARTBEAT_CONFIG_URL`, state file (monitor limit 194 h) |

### Database backup, step by step (`db-backup`)

1. Checks the backup key can encrypt and that `pg_dump` is not older than the server.
2. Opens `REPEATABLE READ READ ONLY`, exports the snapshot, counts the rows of every table in the configured
   schemas and records the latest migration — all inside that snapshot.
3. Runs `pg_dump --snapshot=<that snapshot> --no-owner --no-privileges --schema=public`, so the dump holds
   exactly the counted rows.
4. `pg_restore --list` must read the dump and list a data entry for every counted table.
5. Encrypts with the public key, then deletes the plain dump immediately.
6. Uploads (never over an existing object), checks the stored size, downloads it again and compares SHA-256.
7. Uploads the manifest last. A backup without a manifest is incomplete: never listed, restored or counted.
8. Applies retention. Pruning never removes the backup just made, never runs while fewer than 7 complete
   backups exist, and a pruning error is alerted without failing the backup.

Connection details reach `pg_dump` through `PG*` environment variables, never arguments. Logs are one JSON
line per event in the journal; every configured secret (passwords, keys, webhook addresses, the database host)
is replaced by `<redacted>`.

### Document backup (`docs-backup`)

- Inventory: every row of `attachments` (all versions, current or not) and every object in the bucket.
- A file whose encrypted copy for its database checksum already exists is skipped without downloading.
- A file whose content no longer matches the database checksum is still copied (under its actual checksum) and
  reported (`checksum-mismatch`); a database row whose file is gone is reported (`missing-in-bucket`). Either
  sends an alert and exits with code 2.
- Bucket objects with no database row are copied too (`not-in-database`).
- The production bucket is opened through a read-only interface (list / head / download): the job has no code
  path that writes to or deletes from it. **However**, Supabase S3 keys are project-wide and can write: if a
  separate read-only key is unavailable, the protection is in the code only (see Risks).
- The manifest lists path, size, checksum, attachment record (id, version, entity, category, original name,
  MIME type, upload time) and the encrypted copy's key for every file.

## Keys

- Generate an **encryption key pair offline** on an administrator's machine (e.g. `gpg --full-generate-key`,
  ECC/Curve25519 or RSA 4096, no expiry or a long one, a strong passphrase).
- Export the **public** key only, import it on the VPS into `/var/lib/stslv-amc-backup/gnupg`, and put its full
  fingerprint in `BACKUP_GPG_RECIPIENT`.
- Keep the **private** key and its passphrase in two separate safe places controlled by the business (for
  example an offline USB key in the office safe and a password manager entry with the revocation certificate).
  **Without the private key no backup can be restored.** Test a restore with it before relying on it.
- The VPS can encrypt but never decrypt. A stolen backup bucket or a compromised server does not expose old
  backups.

## Off-site storage

**Google Drive is the approved destination** (see "Google Drive" above). The alternative, not in use: an S3-compatible bucket at a provider independent of Neon, Supabase and Hostinger (e.g. Backblaze B2,
Cloudflare R2, Wasabi), in a separate account:

- private bucket, no public access, no public URL ever created by this code;
- an access key limited to that one bucket;
- bucket versioning on, and object lock / minimum retention where offered (protects history even if the key
  leaks); set `BACKUP_S3_CONDITIONAL_WRITES=true` when the provider supports `If-None-Match: *`;
- the job refuses a destination inside the production Supabase project.

The provider was chosen on 2026-11-18: Google Drive.

## Restore procedures

### A. Restore drill into an isolated database (monthly, and before go-live)

On an administrator's machine that has the private key and PostgreSQL 17 tools:

```
node dist/ops/cli.js db-restore-drill --env-file <restore.env> --backup latest --target-db stslv_restore_<yyyymmdd> [--drop-after]
```

`restore.env` holds the same `BACKUP_*` destination settings (read access is enough) and
`RESTORE_DB_HOST/PORT/USER/PASSWORD` for a **non-production** server (e.g. local PostgreSQL 17 or a new Neon
branch/project). Guards: the target name must start with `stslv_restore_`, must not be the source database,
and must be empty or absent. The drill verifies both checksums, restores in one transaction, then compares
every table's row count and the latest migration with the manifest. Exit 0 = identical; 2 = differences
(listed); 1 = failed.

Documents: `node dist/ops/cli.js docs-restore --to-dir <new empty folder> [--run <id>|latest] [--current-only]`.
Every decrypted file is checked against its manifest checksum; an existing file is never replaced.

**Which run is `latest`.** Backup and run ids are `<stslv-db|stslv-docs>-<environment>-<UTC time>-<6 random hex>`,
the UTC time to the millisecond (`20261109T021500123Z`; ids with whole seconds are still read). `latest`,
`db-list` and retention order runs by that time, never by sorting ids as text: the random part says nothing
about order. (Before this rule, two document runs within the same second could make `latest` restore the
earlier run's manifest, i.e. an older version of a changed file. Found and fixed by the test on 2026-11-09.)

### B. Recovering production (manual, approval required)

Never restore over the live database. Order:

1. Declare the incident; stop writes (`systemctl stop stslv-amc-api`; the web application then reports that it
   cannot reach the server).
2. Take a fresh backup of the current database if it is reachable (`db-backup`), even if damaged.
3. Choose the backup (`db-list`), run drill A into `stslv_restore_<date>` and inspect it: counts, money totals,
   the latest records the business remembers, sign-in on a copy of the application pointed at it.
4. With written approval: create a **new** database on the VPS (owner: the application role; roles and grants
   are in the configuration backup's `postgres/globals.sql` and `postgres/schema.sql` if the cluster itself was
   lost), restore into it with
   `pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error --single-transaction` as that owner,
   check it again, grant `CONNECT` to `stslv-backup` (deploy/hostinger/sql/backup-role.sql), then point `DB_NAME`
   in `/etc/stslv-amc/api.env` (and `backup.env`) at it and start the API. The old database is kept, renamed.
5. Code and database must match: an API release older than the backup's newest migration refuses to start.
6. Documents: restore into a new folder (`docs-restore --local-layout`), compare, and only then switch
   `ATTACHMENTS_DIR` with approval. Files uploaded after the chosen backup exist only in the old folder.
7. Record what was restored, from which backup id, by whom; keep the damaged copy until the business signs off.

Data written after the chosen backup is lost unless recovered separately (WAL archiving is not enabled on the
VPS, so there is no point-in-time recovery: the newest daily backup is the recovery point).

## Activation on the Hostinger VPS (each step needs approval)

0. **Release** the code (`alpha` → `develop` → `main`; the Hostinger pipeline deploys it; no migrations). Nothing
   runs until the units below are installed and enabled.
1. **Packages and user** (as the administrator user, sudo):
   `apt install acl gnupg` and rclone from rclone.org's `.deb` (Ubuntu's package is too old for some Drive features);
   `useradd --system --home-dir /var/lib/stslv-amc-backup --create-home --shell /usr/sbin/nologin stslv-backup`;
   `install -d -m 700 -o stslv-backup -g stslv-backup /var/lib/stslv-amc-backup/{work,state,gnupg,rclone}`.
2. **Read access to documents only** (see "VPS permissions"): the three `setfacl` lines; check with
   `sudo -u stslv-backup ls /var/lib/stslv-amc/attachments` (works) and `sudo -u stslv-backup cat
   /etc/stslv-amc/api.env` (must be refused).
3. **Database backup role**: `deploy/hostinger/sql/backup-role.sql` on the local PostgreSQL (read-only role
   `stslv-backup`, peer authentication over the Unix socket, so no password exists); check `pg_dump` works as that
   role and a write inside `BEGIN READ WRITE` is refused with "permission denied" (the checks are in the file).
4. **Encryption key**: copy only `stselv-backup-public.asc` (fingerprint `1B1D 7F26 FFC7 3C97 B0CD D2BE 6A49 C984
   BF29 02ED`) to the VPS; `sudo -u stslv-backup gpg --homedir /var/lib/stslv-amc-backup/gnupg --import`; confirm
   the fingerprint; the private key never leaves the administrator's PC.
5. **Google Drive authorization** ("Authorization (OAuth) and least privilege"): sign in with the DEDICATED backup Google account, scope `drive`; run
   `sudo -u stslv-backup rclone config --config /var/lib/stslv-amc-backup/rclone/rclone.conf` (remote
   `stselv-gdrive`, type `drive`) with the SSH-tunnel browser approval; `chmod 600` the file. Identify the folder:
   `sudo -u stslv-backup rclone --config … lsjson --dirs-only stselv-gdrive:` → the single "STS-ELV Backup" entry
   and its `ID`; compare it with the ID in the folder's address in the browser.
6. **Settings**: `/etc/stslv-amc/backup.env` from `deploy/hostinger/env/backup.env.example` (root:stslv-backup 0640):
   database (`DB_HOST=/var/run/postgresql`, `DB_USER=stslv-backup`, empty `DB_PASSWORD`, `PGSSLMODE=disable`),
   `ATTACHMENTS_DIR`, `BACKUP_GPG_RECIPIENT`, `BACKUP_GDRIVE_FOLDER_ID`, retention 14/8/12,
   alert webhook and three heartbeat URLs (database, documents, configuration).
7. **Units**: `config-snapshot.sh` → `/usr/local/sbin/stslv-amc-config-snapshot` (root:root 0755); the four
   `stslv-amc-backup-{daily,weekly}.{service,timer}` → `/etc/systemd/system/`; `systemctl daemon-reload`.
   Check: `systemd-analyze calendar --iterations=7 'Mon..Thu,Sat,Sun *-*-* 18:00:00 Asia/Kolkata'`,
   `systemd-analyze calendar --iterations=5 'Fri *-*-* 18:00:00 Asia/Kolkata'`; `node …/cli.js schedule`.
   Timers stay **disabled**.
8. **First manual encrypted upload**: `systemctl start stslv-amc-backup-daily`; check the journal, the state files,
   `STS-ELV Backup/Daily` in the browser (only `.gpg` and `.json` files) and the heartbeats.
9. **Isolated restore test** on the administrator PC (private key there): download the Daily folder's newest
   recovery point; `db-restore-drill --kind daily --target-db stslv_restore_<date>` (row counts and migration must
   match), `docs-restore --kind daily --local-layout --to-dir <new folder>` (checksums), drop the test database.
   On another day, `systemctl start stslv-amc-backup-weekly` and the same test for `Weekly` plus
   `config-restore --kind weekly --to-dir <new folder>` (the archive decrypts; compare its file list with the server).
10. **Alert test**: one run with a wrong `BACKUP_GPG_RECIPIENT` (or rclone authorization removed) must send the
    alert and the heartbeat `/fail`; restore the setting.
11. **Activate**: `systemctl enable --now stslv-amc-backup-daily.timer stslv-amc-backup-weekly.timer`; confirm the
    first scheduled runs (`systemctl list-timers 'stslv-amc-backup-*'`) and the monitor.

**Rollback**: `systemctl disable --now stslv-amc-backup-daily.timer stslv-amc-backup-weekly.timer` stops all backups
without touching any data or any file in Drive. Further: remove the units and `/usr/local/sbin/stslv-amc-config-snapshot`,
remove the ACL entries (`setfacl -x u:stslv-backup …`), revoke rclone's access in the Google account. A code problem
is undone by the normal release rollback (previous release kept on the VPS).

The three encrypted safety backups of 2026-11-18 stay where they are (administrator PC and the VPS); they are not
uploaded to Drive or deleted without a separate approval.

## Independent review (2026-11-18) — fixed

- **Configuration snapshot privilege boundary**: root only reads (`tar`, `pg_dumpall`); every file in the backup
  user's work folder is created, moved and removed AS that user, and root never creates or changes that folder. (A
  link planted there could otherwise have made root `chown` a system file to the backup user.)
- **A failed snapshot no longer cancels the Friday backup**: `ExecStartPre=-+`; `tar` exit 1 (a file changed while
  read) is accepted with a warning; the configuration step then reports the missing snapshot (alert, heartbeat
  `/fail`) while the database and documents are still backed up.
- **Scheduled slot instead of calendar date** (see "Schedule"); **atomic stale-lock reclaim with boot id**.
- **Pruning removes the manifest first**, then markers, then the dump/archive: an interrupted prune never leaves a
  listed recovery point that cannot be restored. Dumps with a plain manifest from before manifests were encrypted
  are never removed as orphans. `db-prune --apply` takes the backup lock.
- **"Encrypted" means an OpenPGP session-key packet** (tag 1 or 3) at the start, not merely a high first byte (plain
  PNG/JPEG files passed the old check).
- Tests for each: `tests/ops-schedule.test.ts` "review fixes (2026-11-18)".

Known limitations (accepted, monitored):
- A run killed by systemd at `TimeoutStartSec` leaves its work folder (plain copies, mode 0600 inside the 0700 backup
  home) until the next scheduled run removes it.
- Failures before Node starts (a unit that cannot start at all) are not alerted by the job itself; the heartbeat
  service (no ping on time) and `monitor.sh` (failed units) catch them.
- Documents are checked on Drive one by one (a few rclone calls per new file): fine for thousands of files; review
  if the document count grows into the tens of thousands.

## Verified (2026-11-18, schedule and configuration backup, disposable resources only)

`tests/ops-schedule.test.ts` (34 tests) on temporary folders and a throwaway GnuPG key:
- IST dating (Thursday 23:59:59 vs Friday 00:00 IST), one run per day at 12:30 UTC, weekly exactly on Fridays;
- a daily job does nothing on a Friday; no step is repeated in a day; a weekly catch-up adds only what is missing;
- the lock: a second job waits and then runs; the wait times out with an alert and exit 75; a crashed or ancient
  lock is reclaimed; a job never releases another job's lock; two jobs started together never overlap;
- a failed step does not stop the others and is retried by the next job; exit 2 findings are recorded;
- the timer and service files: the exact `OnCalendar` expressions, daily ∩ weekly = ∅ and daily ∪ weekly = all
  seven days, `Persistent=true`, no random delay, the weekly `ExecStartPre=-+` snapshot, no other backup timer;
- the configuration upload refuses a plain archive, a missing or stale snapshot (alert, heartbeat `/fail`, state);
  a real encrypted snapshot is uploaded with its manifest, verified, removed locally, and retention keeps 4.
`tests/ops-backup.test.ts` (14 tests) still passes. `tests/ops-gdrive.test.ts` (17 tests: destination, encryption-only uploads, encrypted manifests, errors, retention, promotion, pre-flight) covers the Google Drive
destination with a stand-in for rclone (`tests/fixtures/fake-rclone.cjs`: folder IDs, duplicate names, trash, MD5,
expired authorization, full Drive, rate limits, altered uploads); its real-rclone case runs where rclone may run
(blocked by Windows application control on the administrator PC; Linux CI and the VPS). `tests/ops-local-documents.test.ts` (13 tests) covers the VPS
document folder (see "Documents on the VPS"). `systemd-analyze calendar` was not available locally (no Linux):
run it on the VPS at activation (step 5).

### Documents on the VPS: the local folder (added 2026-11-18)

The VPS stores documents in `ATTACHMENTS_DIR=/var/lib/stslv-amc/attachments`, flat `<uuid>.<ext>` files written
by the API (`LocalDiskStorage`). When `backup.env` sets `ATTACHMENTS_DIR` (and no `SUPABASE_*`/`R2_*`), the
document job reads that folder through `stslv-api/src/ops/backup/local-documents.ts` (`LocalAttachmentsSource`);
Supabase/R2 buckets keep working as before. The manifests and encrypted copies use the same `attachments/<key>`
layout either way, so bucket and folder backups restore alike.

- **Read-only, application files only.** Only regular files directly in the folder whose names are keys the API
  generates are listed or read. Symbolic links, sub-folders, hidden/temporary files and any other name are never
  read; they are counted (`summary.ignoredEntries`) and logged. Keys are validated before a path is built (no
  `..`, no separators); a record whose key is invalid, outside the folder or a link is reported `missing-in-bucket`.
- **No link tricks.** Each file is opened with `O_NOFOLLOW`, must be the same regular file (device + inode) that
  was checked and must lie inside the real folder; a file that changes size while copied fails the copy.
- **Every run re-hashes every file** (cheap on a local disk): a document altered or damaged on disk is reported
  the same day (`checksum-mismatch`, alert, exit 2) and kept under its actual checksum; the earlier copy remains.
- **Empty folder = normal** (no documents yet: empty manifest, success). **Missing folder = failure** with an alert.
- **Interrupted runs:** the next run removes abandoned work folders (which may hold a plain copy) before starting.
  Upload failures fail the run without a manifest; the next run completes it. Duplicate runs copy nothing again.
- **Encrypted before transfer:** each document is encrypted with the backup public key in the 0700 work folder,
  then uploaded; the plain copy is removed immediately.
- **Restore into the VPS layout:** `docs-restore --to-dir <new folder> --local-layout` writes `<key>` files the API
  reads directly (checked in the tests with the API's own `LocalDiskStorage`).

### VPS permissions (least privilege)

The backup jobs run as `stslv-backup`, which must READ the documents and nothing else of the application:

```
# Requires the "acl" package (apt install acl). The folder stays stslv:stslv 0750, never world-readable.
setfacl -m u:stslv-backup:--x /var/lib/stslv-amc                    # traverse only (cannot list it)
setfacl -m u:stslv-backup:r-x /var/lib/stslv-amc/attachments        # list and read the folder
setfacl -d -m u:stslv-backup:r-- /var/lib/stslv-amc/attachments     # every NEW document readable too
find /var/lib/stslv-amc/attachments -type f -exec setfacl -m u:stslv-backup:r-- {} +   # existing files
getfacl /var/lib/stslv-amc/attachments                              # check
```

The API writes documents with `UMask=0027` (mode 0640), so the default ACL gives `stslv-backup` read access.
Do **not** add `stslv-backup` to the `stslv` group: that group can read `/etc/stslv-amc/api.env` (database
password, JWT secret). The backup units list the folder as `ReadOnlyPaths=`; Nginx never serves `/var/lib`.

### Document retention (recommendation, not automated)

Encrypted document copies are content-addressed and **never deleted** by any job; only database and configuration
backups are pruned. A bounded policy that never removes the last recoverable copy of a document:

1. Prune document **manifests** like database backups (14 daily, 8 weekly, 12 monthly).
2. An encrypted document copy may be deleted only when (a) no retained manifest references it, **and** (b) its
   attachment no longer exists in the database (deleted or replaced) for longer than 12 months, **and** (c) a
   restore drill of the newest manifest has passed since.
3. Run it only by hand, as a dry run first, with approval — never from the timers.

At today's volume (a few MB a year) keeping every copy costs almost nothing, so the recommendation is to keep the
current "never delete" behaviour until the volume makes the bounded policy worth it.

The three encrypted safety backups of 2026-11-18 (PRE-CLEANUP-DEMO, PRE-CLEANUP-DEMO-FINAL, POST-CLEANUP; see
`D:/Projects/STSLV-AMC-backups/vps/backups/README-BACKUPS.md` on the administrator PC) are separate from these jobs and keep their own
policy (pre-cleanup copies until 2027-02-16).

## Verified (2026-11-09, disposable resources only)

On the local PostgreSQL 17.11 with a throwaway database, a throwaway GnuPG key and temporary folders standing
in for both buckets (`tests/ops-backup.test.ts`, 14 tests):

- backup → encrypt → store → re-download verification → restore into `stslv_restore_*` with every row count
  and the latest migration identical; restore database dropped afterwards; no plain file left behind;
- a tampered backup, a non-isolated target name, the source as target, and a non-empty target are refused;
- a failing backup sends a redacted alert and a failing heartbeat, records the failure and leaves no files;
- an existing object is never overwritten; the read-only view has no write method;
- 400 daily backups pruned to the 7/4/12 policy (12 distinct months kept);
- documents: encrypted copies, missing / altered / orphan files reported, unchanged files skipped, a changed
  file stored as a new version while the old copy stays, restore verified by checksum and never overwriting;
- `latest` is the newest run even when several runs fall within the same second (document restore returns the
  edited version; database backups listed newest first; whole-second ids still ordered correctly).

Not verified: a real S3 provider (only the folder store was exercised end-to-end), the VPS units, Neon.
