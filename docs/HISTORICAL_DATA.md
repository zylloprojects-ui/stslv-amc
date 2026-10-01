# STSLEV AMC — Historical Data Support

| | |
|---|---|
| Status | Implemented. **No historical data has been imported.** |
| Migrations | `0030_historical_records`, `0031_legacy_import_staging` |
| Scope | How records from the client's earlier registers are stored and shown. The import itself is a separate, later step. |

## Principle

A historical record keeps what the source register said and nothing more. The
system does not fill in what the source does not give: no completion date, no
day of the month, no visit for a period the source does not list.

Historical records are not operational work. They are in none of the
dashboard's operational figures and are never "ready for invoice".

## Projects

| Element | Meaning |
|---|---|
| `projects.status = 'HISTORICAL'` | A job imported from an earlier register. |
| `projects.legacy_status` | The status exactly as written in the source. Set on historical projects only. |
| `projects.job_date_precision` | `DAY` (default) or `MONTH`. `MONTH` means the source gave a month and year only; `job_date` then holds the first of that month as a placeholder. |
| Invoice state `HISTORICAL` | Returned by `v_project_financials` for a historical project, whatever its value. |

Database rules:

- A project is historical exactly when it has a `legacy_status`.
- Only a historical project may have a `MONTH` date, and its day must be 1.
- A historical project has no `completed_date` (the existing completion rule is unchanged).

## AMC visits

| Element | Meaning |
|---|---|
| `amc_visits.status = 'HISTORICAL'` | A period row imported from an earlier schedule. Whether and when the visit took place is not recorded. |
| Invoice eligibility `HISTORICAL` | Returned by `v_amc_visit_billing` for a historical visit, whatever its amount. |
| `amc_contracts.schedule_cutover_date` | Set only by the import, to the date of that import. |

### Source-faithful schedule

Only period rows that exist in the source become historical visits. A period
the source does not list is **not** created.

To stop the schedule generator from creating those periods later, an imported
contract carries `schedule_cutover_date`. Schedule generation
(`buildSchedulePeriods`) returns only the periods that **start on or after**
that date. Earlier periods are history and come from the source alone.

- A contract entered in the application has no cutover date and is generated
  in full, exactly as before.
- The cutover date is taken from the database at the moment of the import
  (`legacy_import_batches.cutover_date` defaults to `CURRENT_DATE`). It is not
  a fixed date in the code.
- The cutover date is not accepted by any API route.

## Read-only in the application

No application route can create a historical record, move a record into or
out of `HISTORICAL`, or change one:

- Project create, edit and status routes refuse it.
- A historical project takes no new procurement request or expense.
- The schedule and execution routes refuse changes to a historical visit.

Historical records are written only by the controlled import process.

## Figures

| Figure | Treatment |
|---|---|
| Visits due, overdue, upcoming, due this month | Historical visits excluded. |
| AMC ready for invoice (count and amount) | Historical visits excluded. |
| Active projects, projects ready for invoice, ready-for-invoice value | Historical projects excluded. |
| Total job value, tracked expenses, operational job margin (summary) | Historical projects excluded. |
| Historical projects | Reported separately: count, job value, grand value, tracked expenses. |
| Operational job margin of one project | Unchanged: job value minus recorded expenses. |

## Staging and audit

`legacy_import_batches` holds one row per import run, with its cutover date
and the source files read.

`legacy_import_rows` holds one row per source record:

- workbook, sheet, row and (where one sheet row holds several records) cell;
- the kind of record and its original identifier;
- every source value, as read;
- whether it was imported or held, and why it was held;
- a link to the client, contract, visit or project it produced.

The same source record cannot be staged twice. Invoice references from the
source registers stay in these rows until the Invoice Tracking module
reconciles them. They are not stored on projects or visits.

These tables have no API and no page.

## Not done here

- No data has been imported.
- No import script exists yet.
- Invoice Tracking is not part of this change.
- A way to bring a historical record into the live workflow is not provided.
