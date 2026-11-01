# Backup & Restore

Page: `/admin/backups`. API: `/api/security/backups`. Everything below is off until configured. Nothing has been changed on the live hosting.

## What the application does

- A Super Admin starts a backup. The server runs `pg_dump` (custom format), checks the file with `pg_restore --list`, and records its size, table count and SHA-256 beside it.
- Only a verified backup whose file still matches its checksum can be downloaded. Each run and download is written to the activity log.
- Admin sees the status only. Other roles see nothing.
- Connection details reach the tools through their environment, never their arguments, and tool error output is never returned.
- It does not restore, schedule, prune or copy backups off the server.

## Settings

| Setting | Meaning |
|---|---|
| `BACKUP_DIR` | Folder for backups. No default in any environment |
| `BACKUP_STORAGE_DURABLE` | `true` states the folder survives restarts and redeploys. Required in production. The application cannot prove it |
| `PG_DUMP_PATH`, `PG_RESTORE_PATH` | Tools, if not on the path. `pg_dump` must not be older than the database |

The page's readiness checks show which of these is missing.

## Before enabling in production

Current hosting has no suitable storage: Render's disk is not permanent, and whether its runtime has the PostgreSQL 17 tools was not checked. One of these is needed, and it is an infrastructure and cost decision:

1. A persistent disk on the API service, mounted at `BACKUP_DIR`. It still shares a failure with the service, so copies should also be downloaded.
2. Object storage. This needs an upload step that does not exist yet.
3. Keep taking backups from a trusted machine with `pg_dump`, as today, and leave this feature off. Check Neon's own restore options as well.

Automatic backups are also a decision: the reference warns against leaving them off, but a schedule needs the storage above and a retention rule. How old a backup may be before it counts as stale is also undecided, so the health check shows the date and passes no judgement on its age.

## Restoring

Never over a live database. Restoring is deliberately not in the application, unlike the reference, whose restore flow also adds a safety snapshot.

1. Take a new backup of the live database and keep it.
2. Compare the file's SHA-256 with the one shown on the page.
3. Create a new, empty database on the same PostgreSQL major version and run `pg_restore --no-owner --exit-on-error --dbname=<new database> <file>`.
4. Compare record counts and money totals, then sign in to a copy of the application pointed at it.
5. Only with written approval: switch the application to the restored database during a planned stop.

Rollback note: an API version older than the backup's newest migration refuses to start on it, so restore and code version must match.

## Verified

On an isolated database: backup run, verification, download, refused altered file, failed run, and a restore of an application-made backup into a separate database with matching counts and totals. Never run against Neon.
