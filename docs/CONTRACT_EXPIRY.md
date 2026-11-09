# Contract expiry (controlled run)

P1 fixes, branch `feature/stslv-p1-fixes` (commits 3e2cb28 and the final P1 verification commit). No migration,
no schema change.

## Status at a glance

| Stage | State |
|---|---|
| **Business rule** | **Approved** by the owner on 2026-11-09 (rules below). |
| **Local / test enablement** | Done only in the disposable test database `stslv_amc_test_p1_fixes` (schema `stslv_test`): automated tests and the CLI were run with `AMC_CONTRACT_EXPIRY_ENABLED=true` there. |
| **Production activation** | **Not done.** The switch stays unset (off) in every shared and production environment until the approved release. |
| **Scheduled execution (Hostinger VPS)** | **Not set up.** Instructions below are for the future deployment, to be followed only after release approval. |

## Approved rules (2026-11-09)

1. An **Active** contract becomes **Expired** on the first day after its **Valid To** date, calculated in
   **Asia/Muscat** (`CONTRACT_TIME_ZONE`). A contract that ends today stays Active today. The Oman day is
   taken from the database clock read as Oman time, whatever the server's or database's own time zone
   (Asia/Muscat is UTC+4, no daylight saving: 19:59:59 UTC is still the same Oman day, 20:00:00 UTC is the next).
2. **Open visits** keep their existing statuses and financial values. Nothing about any visit changes.
3. An **open renewal** does not prevent expiry of the old contract. The renewal stays an independent
   contract and is not touched.

Never touched: Draft, Expired and Cancelled contracts, and contracts in the Recycle Bin.

## What it preserves

Only `amc_contracts.status` (ACTIVE → EXPIRED) changes. Visits of every status, amounts, the manual
Invoice No. (Paid), Zoho invoices and allocations, documents and attachments, renewals and their links,
and every earlier history entry are left exactly as they are (tested row for row). A person can still change
an expired contract back to Active through the normal status change.

## Audit

Each changed contract gets one `amc_contract.status_changed` entry (the same action a person's change
writes), with no user (a system action) and metadata
`{ changes: { status: { from: "ACTIVE", to: "EXPIRED" } }, automatic: true, rule, validTo, asOf, timeZone }`.

## Safety

* **Dry run by default.** Without `--apply` nothing is written and no lock is taken.
* **`--apply` needs explicit enablement**: `AMC_CONTRACT_EXPIRY_ENABLED=true` in that process's environment.
  Without it (or with any other value) the command exits with code 1 and changes nothing.
* **Idempotent.** A second run finds nothing to change and writes no audit entry.
* **Concurrent runs** are serialised by a transaction-scoped advisory lock; the UPDATE re-checks
  `status = 'ACTIVE'`, so each contract is expired and audited exactly once, and a contract a person changed
  meanwhile is skipped (`skipped`), never overwritten.
* **One transaction** per run: every listed contract and its audit entry is written, or none.
* An `--as-of` date later than the Oman today is refused, so nothing can be expired early.
* **No timer inside the API.** A restart or a second web instance can never run it twice or skip a day silently.

## The command

```
npm run contracts:expire                          # dry run: lists what would change (development, tsx)
npm run contracts:expire -- --as-of 2026-11-09    # dry run measured on a past or the current Oman date
AMC_CONTRACT_EXPIRY_ENABLED=true npm run contracts:expire -- --apply

node dist/scripts/expire-contracts.js             # the same, from the compiled build (servers)
```

Output lists reference, client, system and validity of each contract, then a count. It never prints
connection details. Exit code 0 on success, 1 on any error (including "disabled").

## Production activation (future, after release approval only)

1. Release the code to production through the approved process (develop → verification → release).
2. **Dry run on production** (read only), review the list with the client:
   `node dist/scripts/expire-contracts.js` with the production environment loaded.
3. Run once by hand with the switch, in the same environment:
   `AMC_CONTRACT_EXPIRY_ENABLED=true node dist/scripts/expire-contracts.js --apply`.
4. Check the Audit Log (`amc_contract.status_changed`, automatic) and AMC Renewal.
5. Only then enable the daily schedule below.

Keep `AMC_CONTRACT_EXPIRY_ENABLED` out of the **web server's** environment: only the scheduled job needs it.

## Scheduled execution on the Hostinger VPS (future)

Run it once a day shortly after Oman midnight, outside the web process. A systemd timer can name the
time zone itself, so the server's own time zone does not matter (systemd 235 or later). Paths and the user
are placeholders for the eventual layout.

`/etc/systemd/system/stslv-contract-expiry.service`
```
[Unit]
Description=STSLV AMC contract expiry (approved rule, Asia/Muscat)

[Service]
Type=oneshot
User=stslv
WorkingDirectory=/opt/stslv-amc/stslv-api
EnvironmentFile=/opt/stslv-amc/stslv-api/.env
Environment=NODE_ENV=production
Environment=AMC_CONTRACT_EXPIRY_ENABLED=true
ExecStart=/usr/bin/node dist/scripts/expire-contracts.js --apply
```

`/etc/systemd/system/stslv-contract-expiry.timer`
```
[Unit]
Description=Daily STSLV AMC contract expiry after Oman midnight

[Timer]
OnCalendar=*-*-* 00:10:00 Asia/Muscat
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl daemon-reload && systemctl enable --now stslv-contract-expiry.timer`; check with
`systemctl list-timers stslv-contract-expiry.timer` and `journalctl -u stslv-contract-expiry.service`.
`Persistent=true` runs a missed day after downtime; because the run is idempotent and measured on the Oman
date, a late or repeated run is harmless. A plain crontab is not recommended: Debian/Ubuntu cron does not
reliably honour a per-job time zone.

## Code and tests

* `stslv-api/src/modules/amc/contract-expiry.service.ts`: `runContractExpiry`, `businessToday`, `businessDateAt`, `expiryApplyEnabled`.
* `stslv-api/src/scripts/expire-contracts.ts`: the CLI.
* `stslv-api/tests/p1-fixes.test.ts` and `tests/p1-approved-rules.test.ts`: ended yesterday, ends today, future,
  already Expired, open and postponed visits, completed / Paid / Zoho-invoiced visits, open renewal,
  repeated runs, three concurrent runs, Oman midnight boundary (also from a UTC+14 session), dry-run default,
  disabled switch, future as-of date, and row-for-row preservation of visits, invoices, allocations,
  attachments and history.

## Date consistency (known, not changed here)

Expiry uses the Oman date. Most other screens (Dashboard expiring and past-validity figures, AMC Renewal
due dates, Service Status "Waiting for Renewal", overdue flags, completion dates) use the database's
`current_date`, which follows the database session's time zone; the web app's default month uses the
browser's clock. See `docs/P1_FIXES.md` § Date consistency for the windows where they can differ and the
recommended follow-up.
