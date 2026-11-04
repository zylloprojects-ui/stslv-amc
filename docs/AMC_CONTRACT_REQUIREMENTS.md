# AMC Contracts: KPI cards and required fields (2026-11-03)

Branch `feature/amc-contract-kpis-required-fields` (Session 5). Not merged, not pushed, not deployed.

## Release blocker: production document storage

**A new AMC contract now needs its contract document, and production cannot store files yet.**
Until durable storage is configured and verified, no AMC contract can be added in production.
Do not release this branch to `develop` before that.

- Production has no `ATTACHMENTS_DIR`. `stslv-api/src/config/env.ts` deliberately leaves uploads off in
  production because the hosting disk may not be permanent. The API runs on a Render web service on the
  free plan (`render.yaml`), whose local disk must be treated as temporary: files written there can be lost
  on a restart or redeploy, while their rows would stay in PostgreSQL.
- With no storage, the API refuses Add AMC Contract with `503 STORAGE_UNAVAILABLE`: "No contract was created:
  a new AMC contract needs its contract document, and this server has no file storage configured
  (ATTACHMENTS_DIR)...". The check runs before any database write, so nothing is created.
  `GET /api/attachments/limits` reports `storageAvailable: false`, and the Add form then shows a warning and
  disables Add contract.

What is needed before release (each step needs approval, and none is done in this session):

1. Choose durable storage that survives restarts and redeploys. Either:
   - a persistent disk attached to the API service (a paid hosting option), mounted at a folder outside
     the application, with `ATTACHMENTS_DIR` set to that folder; or
   - object storage. This needs a new `FileStorage` implementation (`stslv-api/src/shared/storage.ts`
     defines the interface: `put`, `get`, optional `remove`). The business model does not change: only the
     metadata and a generated key are in PostgreSQL (`attachments`).
2. Include the files in the backup and restore procedure (`docs/BACKUP_RESTORE.md` covers the database only).
3. Apply migration 0103 to Neon (see below), with the usual backup and rehearsal.
4. Verify on the deployed service: add a contract with a PDF and a DOCX, download both, restart or redeploy
   the service, then download both again and check the integrity shows VERIFIED.

## KPI cards (AMC Contracts page)

`GET /api/amc/contracts/kpis` (AMC_CONTRACTS:VIEW). It reads the `amc_contracts` view, which leaves out the
Recycle Bin (migration 0101). Amounts are summed by PostgreSQL as numeric(16,3), in OMR excluding VAT.

| Card | Rule |
|---|---|
| All AMC Contracts | Count of every contract outside the Recycle Bin, any status |
| Total AMC Value | Sum of AMC Value / Year over the same contracts |
| Total Final Credit | Sum of Final Credit over the same contracts. A contract without one adds nothing; the card says how many have none. Never replaced by AMC Value or invoice totals. |
| Expired | Status Expired, or status Active with Valid to before today (the rule of AMC Management's expired figure). Each contract counts once; drafts and cancelled contracts are not expired. |

The cards show figures only. They are not filters: the Expired card would not match the "Expired" status
filter, and the Contract status dropdown still filters the register. They do not follow the register's
filters; the Filtered Total row under the register does that. Older AMC Values may be whole-term amounts,
and they are summed as stored (never reinterpreted).

## Required fields on Add AMC Contract

They apply to `POST /api/amc/contracts` (new contracts) and are checked by the API as well as the form.
Renewals (`POST /contracts/:id/renewals`) are unchanged in this session.

- **Sales engineer**: an existing, active Sales Engineers record, stored as `sales_engineer_id`. The typed
  Responsible engineer stays separate and optional.
- **System**: an existing, active System Types record, stored as `system_type_id`. The contract's
  `system_description` is set to the type's name, so the two agree. A typed system sent alongside is
  replaced by the name.
- **Final credit**: required. Zero is allowed; up to 3 decimals; negative or non-numeric values are refused.
  Never derived from AMC Value.
- **Contract document**: one PDF, DOC or DOCX, at most `ATTACHMENT_MAX_MB` (12 MB by default). Sent as
  base64 in the same request as the contract. The type is checked by the file's content, never by its name
  or the browser's reported type alone. Word files with macros are refused, and so is a file whose name does
  not match its content. It is stored under a generated key and recorded as the contract's
  "Contract document" (type Signed contract), downloadable from the contract's Documents tab under the
  usual AMC Contracts permissions.

Saving is all or nothing. The document is checked first, stored second, and recorded in the same
transaction as the contract. If anything fails, no contract or document row is created and the stored file
is removed. Only this one route accepts a large JSON body, and it reads it after sign-in and the
AMC_CONTRACTS:CREATE check. Every other JSON body keeps the 100 kB default.

## Existing contracts

No data is backfilled or rewritten. An older contract without a sales engineer, system type, Final Credit or
document stays valid and editable, and editing never asks for an upload. The edit form keeps an unlinked
typed system as it is until another system is chosen.

Once a value is recorded, it can be changed but not removed, on every route (the contract form and the
Link master records panel, both checked in `applyContractMasters`):

- Final Credit cannot be cleared.
- A sales engineer link cannot be removed.
- A system type link cannot be removed. Changing the link also sets the contract's system to the new type's
  name, and the change is recorded in the contract history.

A system type that has been disabled since stays on the contracts already linked to it, but cannot be chosen
anew. Renaming a type keeps every link, because links are by id. A contract keeps the system name it was
saved with until it is linked again.

## Renewals

The creation rules are unchanged. The renewal form now offers the System as a list. When the renewed contract
has no active system type, its typed system stays selectable as "(as on the renewed contract)" and is sent as
text, as before. Renewals need no document and no Final Credit.

## Migration 0103

`0103_contract_word_documents.sql` widens `attachments_mime_ck` to allow `application/msword` and the DOCX
type. It changes no table data. Only AMC contracts may hold Word files; procurement and expense records keep
PDF, PNG and JPEG. Rollback steps are in the file.

- Applied only to the isolated test database `stslv_amc_test_contract_enhancements`. Not applied to
  `stslv_amc_dev` or Neon.
- Without it, PDF contract documents still work. A Word file is refused with a clear 503
  (`FEATURE_UNAVAILABLE`) instead of a database error.
- **Order with 0102** (`0102_sales_engineer_code.sql`, Sales Engineers session): the two touch different
  tables and do not conflict. But the migration runner refuses a pending migration older than the last
  applied one. 0102 must therefore be applied before 0103, or both in the same run, on every database.
  Merge the Sales Engineers branch first, or together with this one, before migrating any database.
