# AMC Reference Number

Requested 2026-11-04. Migration `0105_amc_contract_reference.sql`.

## Rule

- Every AMC contract has an **AMC Reference Number**, stored in `amc_contracts.amc_reference`.
- It is **typed by the user** when a contract is added, or when a renewal is created. It is never generated or
  prefilled. Examples: `AMC-0001`, `AMC-2026-001`, `STSLV-AMC-2026-015`.
- It is **read-only after creation**. The edit route refuses it with "The AMC Reference Number cannot be changed
  after the contract is created." There is no renaming workflow.
- Relationships (visits, invoices, renewals, documents) use the contract **id**, never this text.

## Validation (API, database and form)

| Check | Rule |
| --- | --- |
| Required | Blank or whitespace-only is refused. |
| Trimmed | Leading and trailing spaces are removed before saving. |
| Length | 1 to 50 characters. |
| Characters | Letters, digits, spaces and `- _ . / &`, starting with a letter or digit (the master-code convention). |
| Case | Kept as typed. |
| Unique | Without regard to case, over **every** contract: active, draft, expired, cancelled and those in the Recycle Bin. A number is never reused. |
| Concurrency | The unique index `amc_contracts_reference_uq` on `lower(amc_reference)` decides; of two simultaneous requests with one number, one is refused. |

A duplicate is answered `409 CONFLICT` with "AMC Reference Number already exists. Please enter a different number."
(also as the field error on `amcReference`).

The database repeats the rules: `NOT NULL`, check constraint `amc_contracts_reference_ck`, unique index
`amc_contracts_reference_uq`.

## Existing contracts

Migration 0105 gave every existing contract the reference it already showed: `AMC-` and the id padded to four
digits (contract 7 = `AMC-0007`). Nothing was renumbered. The backfill runs with the `updated_at` trigger disabled,
so no contract looks edited by the migration. These numbers are reserved, so a new contract cannot take `AMC-0007`.

## Where it is shown

The same stored value everywhere: AMC Contracts register (column, search), Contract 360 (header, renewal links),
AMC Schedule (column, search, "Showing contract … only"), Monthly Calendar and Dashboard (visit details, renewal
warnings, expiring contracts), Master AMC Status, Service Status, Service Sales, Accounts (rows, contract filter,
export heading), AMC Management, AMC Renewal (queue, history, messages), Recycle Bin, Reports and every export.

Searches match the reference as text, in part or in full, without regard to case. The earlier shortcut where a bare
number such as `7` or `amc7` named contract id 7 is gone: the reference is no longer derived from the id.

## Other creation paths

- **Renewal**: needs its own new, unique number; the source keeps its number.
- **Legacy Excel import** (`legacy-import:apply`): the contract register must have an `AMC Reference` column with a
  valid, unique number on every importable contract. Otherwise the import stops before writing anything and lists
  the rows. Nothing is generated. (The client's AMC-2027 register has no such column today.)
- There is no contract duplication feature.

## Databases without 0105

The application still runs: references are shown in the old derived form, and **adding a contract or renewal is
refused** (`FEATURE_UNAVAILABLE`) until 0105 is applied, because the typed number could not be kept.
