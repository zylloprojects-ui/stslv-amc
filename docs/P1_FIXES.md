# Session 2: P1 fixes

Branch `feature/stslv-p1-fixes` (worktree `D:\Projects\STSLV-AMC-p1-fixes`), base `c6d8d19`.
Commits: `3e2cb28` (implementation) and the final verification commit that follows it. Not merged, not pushed,
not deployed. No migration.

## Approval and activation status

| Item | Business rule | Local / test enablement | Production activation | Scheduled execution (Hostinger VPS) |
|---|---|---|---|---|
| Shared service scope / cancelled-contract Paid handling | In force (follows the approved finance rules) | Always on | With the release (no switch) | n/a |
| Permission descriptions | Corrected text | Always on | With the release | n/a |
| Contract expiry | **Approved 2026-11-09** | Test DB only (`AMC_CONTRACT_EXPIRY_ENABLED=true`) | **Off** until the approved release | **Not set up**; see `CONTRACT_EXPIRY.md` |
| Service Report No. lock + override | **Approved 2026-11-09** | Test DB only (`SERVICE_REPORT_NO_LOCK_ENABLED=true`) | **Off** until the approved release | n/a |
| Historical Paid-but-not-Completed | **Approved 2026-11-09**: preserve, no automatic correction | Regression-tested | Review query prepared, **not run** on production | n/a |

## Approved rules (owner, 2026-11-09)

1. Automatic contract expiry: Active becomes Expired on the day after Valid To, calculated in Asia/Muscat.
2. Open visits on expiry keep their existing statuses and financial values.
3. Open renewals do not prevent expiry of the old contract; the renewal remains independent.
4. The Service Report Number is locked after the service is Paid.
5. Super Admin and Admin may change a locked number with a mandatory reason and an Audit Log entry.
6. Historical Paid-but-not-Completed services are preserved without automatic correction; exceptions are identified and reported.

Details: `CONTRACT_EXPIRY.md`, `SERVICE_REPORT_COMPLETION_LOCK.md`, `FINANCE_WORKFLOW.md`, `DASHBOARD_12_KPIS.md`,
`ROLES_PERMISSIONS.md`. Review query: `sql/paid-not-completed-review.sql`.

## Feature switches (API environment)

| Variable | Default | Effect | Where it belongs in production |
|---|---|---|---|
| `AMC_CONTRACT_EXPIRY_ENABLED` | unset (off) | Allows `contracts:expire --apply`. The dry run never needs it. | Only the scheduled job's environment (systemd unit), never the web server's |
| `SERVICE_REPORT_NO_LOCK_ENABLED` | unset (off) | Locks the Service Report No. of Paid services; enables the audited override | The API server's environment; restart the API to apply |

Only the exact value `true` (any case) switches either on.

## Dashboard reconciliation (verified)

One service scope (`stslv-api/src/modules/amc/service-scope.ts`): Scheduled, In Progress, Postponed or Completed,
and on a Cancelled contract only Completed or Paid services. Verified by tests:

* Services Overall = Invoices Generated + Invoices Not Generated = Service Status total = Accounts rows = Master AMC Status rows.
* Services This Month = this month's Generated + Not Generated = workload chart's first bar.
* Completed = Services Overall − Services Pending.
* Paid total equals Accounts' Invoice No. Filled and AMC Management's Paid count and amount.
* Cancelling a contract before work removes its open unpaid services from every figure; after completion and
  payment, those services stay in every figure.

## Date consistency

The rule each part of the application uses for "today":

| Where | "Today" comes from |
|---|---|
| Contract expiry (this session) | Database clock read as **Asia/Muscat** (`businessToday`) |
| Dashboard (expiring ≤45 days, past validity, this month, today/upcoming lists, mini calendar), AMC Renewal due / expired, Service Status "Waiting for Renewal" and overdue, AMC Management, Reports, completion date recorded on completion | Database `current_date` / `now()` in the **database session's time zone**. The API sets no time zone on its connections, so this is the database server's default (local development: Asia/Calcutta; not checked on any hosted database) |
| Web app default month and year (Service Status, Calendar), date fields' default | The **browser's** clock |
| Export "Generated" times | Asia/Muscat (`REPORT_TIME_ZONE`) |

Consequences, none caused by this session's changes:

* If the database runs in **UTC**, between 00:00 and 04:00 Oman time the expiry run (scheduled for 00:10 Oman)
  can already mark a contract Expired while the Dashboard and AMC Renewal still count Valid To = "today"
  (0 days left) and Service Status does not yet show Waiting for Renewal. The figures agree again at 04:00 Oman.
* If the database runs in **Asia/Calcutta** (UTC+5:30), between 22:30 and 24:00 Oman time the Dashboard already
  shows a contract as past validity before the expiry run makes it Expired.
* A browser outside Oman can open a different default month near month ends.

**Recommended follow-up (needs approval, not done here):** make Asia/Muscat the single business time zone by
setting it on the API's database connections (for example `options: -c timezone=Asia/Muscat` in
`config/database.ts`) or on the production database (`ALTER DATABASE … SET timezone = 'Asia/Muscat'`). That
changes every `current_date` calculation at once and must be regression-tested as its own change.

> **2026-11-09 (owner approval): done** on `feature/sts-elv-client-fixes-20261109`, without changing the database or
> session time zone: every business-date expression now uses the Oman date explicitly (`shared/business-date.ts`;
> web `lib/businessDate.ts`). See docs/STS_ELV_CLIENT_FIXES_20261109.md § 12.

## Final verification (2026-11-09)

Run one suite at a time, on the isolated test database `stslv_amc_test_p1_fixes` (never `stslv_amc_dev` or Neon):

| Check | Result |
|---|---|
| Full API suite (92 files, incl. `tests/p1-approved-rules.test.ts`) | 1685 passed, 2 skipped |
| Full web suite (`--maxWorkers=2`) | 808 passed (52 files) |
| API typecheck (`tsconfig.typecheck.json`, tests included) and build | Pass |
| Web lint (oxlint) and build (`tsc -b && vite build`) | Pass |

The earlier web run was cut off when the terminal sessions closed (worker start-up failures, not test failures).
Each approved rule has its own test: Oman day boundary and the day-after-Valid-To rule; open, postponed,
completed and Paid visits unchanged byte for byte; the open renewal untouched and still linked; idempotent and
concurrent runs; apply refused without the switch; lock after Paid with a mandatory reason; override by Super
Admin and Admin only (API and web), each in the Audit Log; historical Paid-but-not-Completed services preserved
and still counted as Paid. Both switches stay **off** by default (`.env.example`, not set in `render.yaml`).

## Known limitations

* The Today / Upcoming dashboard lists use the shared scope, so a Paid service on a cancelled contract can
  appear in Today's list.
* Admin still sees a sidebar link named "Recycle Bin" that opens Deletion History; only the permission
  descriptions were corrected.
* The override of a locked Service Report No. is decided by the Super Admin and Admin roles (as for the Audit
  Log), not by a configurable permission.
