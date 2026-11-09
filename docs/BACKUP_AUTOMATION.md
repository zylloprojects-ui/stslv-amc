# Backup Automation and Recovery (P0)

Prepared 2026-11-09 on `feature/stslv-p0-security`. **Nothing here is scheduled, and no production backup
has been taken with it.** Every step that touches Neon, Supabase, the VPS or a real bucket needs approval
(see "Activation").

Code: `stslv-api/src/ops/` (CLI `dist/ops/cli.js`; from source in development: `npm run ops -- <command>`). Server units: `deploy/hostinger/systemd/`. Settings
template: `deploy/hostinger/env/backup.env.example`. Tests: `stslv-api/tests/ops-backup.test.ts`.

The in-app "Backup & Restore" page (docs/BACKUP_RESTORE.md) is unchanged and stays off on the VPS.

## What is protected, and how

| | Database (Neon) | Documents (Supabase private bucket) |
|---|---|---|
| Frequency | Daily, 02:15 server time | Daily, 02:45 |
| Method | `pg_dump` custom format inside an exported snapshot | Every object under `attachments/`, compared with the `attachments` table |
| Encryption | GnuPG, backup **public** key, AES-256 | Same, one encrypted file per document |
| Destination | Independent S3-compatible bucket, `db/<id>.dump.gpg` + `db/<id>.manifest.json` | Same bucket, `docs/files/<path>/<sha256>.gpg` + `docs/manifests/<run>.json` |
| Retention | 7 daily, 4 weekly, 12 monthly (configurable) | Kept indefinitely; never overwritten or deleted |
| Verification | Row counts in the snapshot, `pg_restore --list`, upload size, re-download checksum | SHA-256 against the database, upload size; full re-hash with `--verify-source` |
| Alerting | Webhook on failure, heartbeat ping (success / fail), state file for the monitor | Same, plus alert on missing or altered files |

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

Use an S3-compatible bucket at a provider independent of Neon, Supabase and Hostinger (e.g. Backblaze B2,
Cloudflare R2, Wasabi), in a separate account:

- private bucket, no public access, no public URL ever created by this code;
- an access key limited to that one bucket;
- bucket versioning on, and object lock / minimum retention where offered (protects history even if the key
  leaks); set `BACKUP_S3_CONDITIONAL_WRITES=true` when the provider supports `If-None-Match: *`;
- the job refuses a destination inside the production Supabase project.

Choice of provider and its cost is a business decision (Remaining approvals).

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
4. With written approval: create a **new** Neon branch or database, restore into it with
   `pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error --single-transaction`, check it
   again, then point `/etc/stslv-amc/api.env` at it and start the API.
5. Code and database must match: an API release older than the backup's newest migration refuses to start.
6. Documents: restore into a new bucket or folder (`docs-restore`), compare, and only then switch
   `SUPABASE_*` with approval. Files uploaded after the chosen backup exist only in the old bucket.
7. Record what was restored, from which backup id, by whom; keep the damaged copy until the business signs off.

Data written after the chosen backup is lost unless recovered separately (Neon's own point-in-time restore,
within its retention window, may be the better first option for very recent damage — check it first).

## Activation (each step needs approval)

1. Choose and create the off-site bucket and its scoped key.
2. Create the backup key pair offline; store the private key; import the public key on the VPS.
3. Create the read-only role on a Neon **branch** (`deploy/hostinger/sql/backup-role.sql`) and run one manual
   `db-backup` and drill A against the branch.
4. Fill `/etc/stslv-amc/backup.env` on the VPS (root:stslv-backup 0640).
5. One manual run of each job on production: `systemctl start stslv-amc-db-backup`, then
   `stslv-amc-docs-backup`; restore-drill both on an administrator machine.
6. Only then enable the timers: `systemctl enable --now stslv-amc-db-backup.timer stslv-amc-docs-backup.timer`.
7. Register the heartbeat URLs and alert webhook; confirm a test failure alert arrives (e.g. run once with a
   wrong `BACKUP_GPG_RECIPIENT`).

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
