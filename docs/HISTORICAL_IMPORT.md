# STSLEV AMC — Historical Excel Import (Dry Run)

| | |
|---|---|
| Status | Dry-run tooling implemented. **No historical data has been imported, and this tooling cannot import any.** |
| Code | `stslv-api/src/legacy-import/`, `stslv-api/src/scripts/legacy-import.ts` |
| Depends on | `docs/HISTORICAL_DATA.md` (migrations `0030`, `0031`) |

## What it does

It reads the client's three workbooks and the database, works out what an
import would create and what it must hold, writes a reconciliation report, and
stops.

```
SOURCE -> PARSE -> NORMALIZE SAFE VALUES -> VALIDATE -> CLASSIFY -> DRY-RUN PLAN -> REPORT -> STOP
```

It writes nothing to the database: the database is read inside a
`READ ONLY` transaction, in which PostgreSQL refuses any write. It opens the
workbooks for reading only and checks their checksums again at the end.

There is no import mode. The script has two options, `--config` and `--out`;
any other argument stops it.

## Running it

```
cd stslv-api
npm run legacy-import:dry-run
```

It needs a local configuration file, by default
`docs/client-source/legacy-import.config.json`:

```json
{
  "sourceDirectory": "<folder holding the three workbooks>",
  "workbooks": {
    "contracts": { "file": "<contract register>.xlsx", "sheet": "<sheet name>", "sha256": "<64 hex characters>" },
    "schedule":  { "file": "<maintenance schedule>.xlsx", "sheet": "<sheet name>", "sha256": "<64 hex characters>" },
    "jobs":      { "file": "<job register>.xlsx", "sheet": "<sheet name>", "sha256": "<64 hex characters>" }
  },
  "approvedClientAliases": []
}
```

The run stops before parsing anything if a workbook is missing, if its
checksum differs from the one in the configuration, or if its sheet is named
differently.

Output goes to `docs/client-source/import-dry-run/`:

- `dry-run-report.md` — the reconciliation report, for a person to read;
- `dry-run-plan.json` — the same plan as data, including the staging rows.

**Confidentiality.** The configuration and both output files name clients, jobs
and amounts. `docs/client-source/` is ignored by Git; none of it is committed.
The code and the tests contain no client data: the test workbooks are invented.

## Rules the plan follows

| Subject | Rule |
|---|---|
| Missing values | A value the source does not give is never supplied. An empty money cell is blank, not zero. |
| Source values | A source value is never corrected. A row that cannot be used as it stands is held, with the reason. |
| Client names | Outer and repeated spaces are removed and letter case is ignored when comparing. Nothing else. |
| Client aliases | A spacing-only difference, or a schedule name that reconciles to exactly one contract, is *proposed* as an alias. It is applied only when listed in `approvedClientAliases`; until then the rows under the alias are held. |
| Client identity | When one name is the opening words of another, both are held: the workbooks cannot say whether they are the same customer. |
| Existing clients | A client already in the database is matched by name (case and spaces ignored), never by resemblance. |
| Contracts | Proposed as `DRAFT`, with the import date as `schedule_cutover_date`. The frequency is taken from the schedule only when the rows are evenly spaced, carry equal amounts and add up to the contract value; otherwise the contract is held. |
| Historical visits | One per source row of the schedule that lies inside its contract's validity and starts before the cutover date. **No visit is created for a period the source does not list.** |
| After the validity | A schedule row that starts after its contract's validity ended is held as a possible renewal. No date is extended and no renewal is created. |
| On or after the cutover | Such a period is not history. The operational schedule generates it when the contract is activated. |
| Projects | Proposed as `HISTORICAL`, the source status kept verbatim, the date as the first of the month with `MONTH` precision, and no completion date. |
| Job numbers | Kept exactly. A number on more than one row holds every such row; none is renumbered. |
| VAT | The 5% rate is confirmed line by line against the register's VAT column; the amount is the one PostgreSQL will generate. |
| Legacy profit | Kept in the staging row for audit. It is not the operational job margin and feeds nothing. |
| Invoice cells | Classified and kept in the staging row. A word in an invoice cell is a marker, not a number. No invoice record is created and nothing is stored on a project or a visit. |
| Job-number sequence | Not read from the register and not changed. |

## Staging

The plan lists the rows a real import would write to `legacy_import_rows`:
one per source record, with its workbook, sheet, row, cell, kind, original
identifier, raw values, disposition and hold reason. In a dry run they are
only listed.

## Not done here

- The import itself: no code writes clients, contracts, visits or projects.
- Setting the job-number sequence.
- Removing the smoke-test records.
- Invoice Tracking.
