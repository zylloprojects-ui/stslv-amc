# AMC Reference Number

Requested 2026-11-04. Migrations `0105_amc_contract_reference.sql` and `0107_amc_reference_history.sql`.

## Rule

- Every AMC contract has an **AMC Reference Number**, stored in `amc_contracts.amc_reference`.
- It is **typed by the user** when a contract is added, or when a renewal is created. It is never generated or
  prefilled. Examples: `AMC-0001`, `AMC-2026-001`, `STSLV-AMC-2026-015`.
- It is **editable after creation** (requested 2026-11-04) in Edit AMC Contract, by any role with the AMC Contracts
  **Edit** permission (`PATCH /api/amc/contracts/:id`, field `amcReference`). See [Editing](#editing-the-reference).
- Relationships (visits, invoices, renewals, documents) use the contract **id**, never this text.

## Editing the reference

- The same rules as at creation (table below), including uniqueness over every contract.
- Left out of the request, or sent unchanged: the reference is kept and no reference change is logged. A change of
  letter case only (`amc-0007` to `AMC-0007`) is a change.
- Only `amc_contracts.amc_reference` changes. The contract id, its services, amounts, invoices, renewal links,
  documents and history are untouched, and every screen, report and export shows the new value at once, because
  they all read it live through the contract id. No other table stores a copy of the text.
- The edit is one transaction: a duplicate refuses the whole edit (any other fields sent with it are not saved).
- Audit: the `amc_contract.updated` activity entry records `changes.amcReference = { from, to }` and its description
  says "AMC Reference Number changed from … to …". Shown in the Audit Log and the contract's history.
- **Outside the system** the old number does not change: Zoho invoices, PDFs and Excel files already exported, and
  documents sent to the client keep it. Activity entries written before the change also keep the old number in their
  text. A search for the old number no longer finds the contract (the Audit Log still does).
- **A number given up by an edit is never given to another contract** (approved 2026-11-04, migration 0107; see
  [Reference history](#reference-history-migration-0107)). The contract itself may take back a number it held before.

## Reference history (migration 0107)

`amc_contract_references` keeps every number each contract has held: one current entry (`retired_at` empty) and one
retired entry per number it gave up, with who and when (`assigned_by`/`assigned_at`, `retired_by`/`retired_at`). The
key is `lower(reference)`, so the rule ignores case.

- Triggers on `amc_contracts_all` maintain it for **every writer** (API, renewals, legacy import, scripts): on insert
  the number is registered; on a change of reference the old entry is retired and the new number registered. A number
  any other contract has ever held is refused with a unique violation on `amc_contract_references_pk`. A change of
  letter case only keeps the same entry.
- Messages (409, field `amcReference`):
  - held now by another contract: "AMC Reference Number already exists. Please enter a different number."
  - held before by another contract: "AMC Reference Number was used before by another contract and cannot be reused.
    Please enter a different number."
- Concurrency: the primary key makes a second simultaneous request for one number wait and then be refused.
- The migration registered every existing contract's current number (Recycle Bin and cancelled included). Nothing
  else changed: no contract, reference, service, invoice, audit entry or relationship, and no `updated_at`.
- The contract link is `ON DELETE CASCADE`. The application never deletes contract rows (the Recycle Bin only marks
  them), so a reservation lasts as long as its contract; only an administrative reset that removes contract rows also
  removes their reservations.

## Validation (API, database and form)

| Check | Rule |
| --- | --- |
| Required | Blank or whitespace-only is refused. |
| Trimmed | Leading and trailing spaces are removed before saving. |
| Length | 1 to 50 characters. |
| Characters | Letters, digits, spaces and `- _ . / &`, starting with a letter or digit (the master-code convention). |
| Case | Kept as typed. |
| Unique | Without regard to case, over **every** contract: active, draft, expired, cancelled and those in the Recycle Bin. A number a contract holds, or has ever held, can never be given to another one (migration 0107). |
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
