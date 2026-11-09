# Contract expiry (controlled run)

P1 fixes, 2026-11-09. Branch `feature/stslv-p1-fixes`. No migration, no schema change.

**Status: built and tested, applying is switched OFF.** The expiry rule below is a proposal. It needs the
client's explicit approval before `AMC_CONTRACT_EXPIRY_ENABLED=true` is set anywhere, and before any
scheduled (production) run. A dry run is always allowed and changes nothing.

## Proposed rule

An **Active** contract becomes **Expired** on the first day after its **Valid To** date. The day is measured
in the business time zone **Asia/Muscat** (`CONTRACT_TIME_ZONE`, the time zone every STSLV report is printed
in), not the server's or database's own time zone. A contract that ends today stays Active today.

Never touched: Draft, Expired and Cancelled contracts, and contracts in the Recycle Bin.

## What it preserves

Only `amc_contracts.status` (ACTIVE → EXPIRED) changes. Visits of any status, amounts, the manual
Invoice No. (Paid), Zoho invoices, documents, renewals and earlier history are left exactly as they are.
A person can still change an expired contract back to Active through the normal status change.

## Audit

Each changed contract gets one `amc_contract.status_changed` entry, the action a person's change writes,
with no user (a system action) and metadata `{ changes: { status: { from: "ACTIVE", to: "EXPIRED" } },
automatic: true, rule, validTo, asOf, timeZone }`.

## Safety

* **Idempotent.** A second run finds nothing to change.
* **Concurrent runs** are serialised by a transaction-scoped advisory lock. The UPDATE re-checks
  `status = 'ACTIVE'`, so a contract a person changed meanwhile is skipped (`skipped`), never overwritten.
* **One transaction** for the whole run: either every listed contract and its audit entry is written, or none.
* An as-of date later than today is refused, so contracts can never be expired early.
* **No timer in the API.** Nothing runs by itself inside the web process, so a restart or a second
  instance can never run it twice or miss a day silently.

## Running it

```
npm run contracts:expire                         # dry run: lists what would change
npm run contracts:expire -- --as-of 2026-11-09   # dry run on a past or current date
AMC_CONTRACT_EXPIRY_ENABLED=true npm run contracts:expire -- --apply
```

`--apply` without the switch is refused. After approval, the intended rollout is: dry run against a copy
of production data, review the list with the client, one manual run, then a daily host scheduler job
(for example a Render cron job) running the same command. Production only with explicit approval.

## Code and tests

* `stslv-api/src/modules/amc/contract-expiry.service.ts`: `runContractExpiry`, `businessToday`, `expiryApplyEnabled`.
* `stslv-api/src/scripts/expire-contracts.ts`: the CLI.
* `stslv-api/tests/p1-fixes.test.ts`, "contract expiry": dry run, disabled switch, future date, apply,
  preservation, audit entry, second run, reactivation.

## Open decisions

* Approve the rule itself (day after Valid To, Asia/Muscat).
* Whether a contract that already has an open renewal should expire the same way (currently yes: the
  renewal is a separate contract and is not touched).
* Whether open (Scheduled / Postponed) visits of an expired contract should be cancelled (currently no).
