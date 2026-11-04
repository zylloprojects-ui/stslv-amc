# Recycle Bin and Deletion History

Page: `/admin/deletion-log` (menu: Recycle Bin). Formerly named Deletion Log; the address, permissions and logged action names are unchanged, so links and audit history stay valid.

Approved 2026-11-03 for AMC contracts (migration 0101) and 2026-11-04 for clients, system types and sales engineers (migration 0106, decisions D1–D7 below).

The page has two views:

| View | Who | Source | Shows | Actions |
|---|---|---|---|---|
| **Recycle Bin** | Super Admin only | the records' current state (`deleted_at IS NOT NULL` on four tables) | records deleted **now** | Restore; Delete permanently (never-used clients, system types and sales engineers only) |
| **Deletion History** | Admin and Super Admin | `activity_logs` | every deletion, cancellation, deactivation, restore and reactivation, with each record's **status now** | none (history) |

The **Audit Log** keeps every event of every kind. No event is ever removed from it or from the Deletion History.

**Deactivated records never appear in the Recycle Bin.** Deactivation (Disable) is managed on the record's own page, where it can be switched back on. A record that is deactivated and reactivated leaves two entries in the Deletion History and nothing in the Recycle Bin. A record restored from the Recycle Bin leaves it at once; its "To Recycle Bin" and "Restored" entries stay in the history.

## What can be in the Recycle Bin

| Record | Delete (module page) | Restore | Permanent deletion |
|---|---|---|---|
| AMC contract | Super Admin; refused while a renewal of it exists | Super Admin; refused while its client, system type or sales engineer is in the Recycle Bin, or its source has another open renewal | **Never** (D4: it would free the AMC Reference for reuse) |
| Client | Super Admin; refused while any AMC contract outside the Recycle Bin (any status), any invoice (any status), project or import row uses it (D1, D2) | Super Admin | Super Admin, from the Recycle Bin only, never-used only, code typed to confirm |
| System type | Super Admin (also refused to roles holding System Types Delete); refused while any AMC contract outside the Recycle Bin uses it | Super Admin | as for clients |
| Sales engineer | Super Admin; refused while any AMC contract outside the Recycle Bin is linked to it | Super Admin | as for clients; the code is retired for good (`sales_engineer_retired_codes`) |

AMC contracts in the Recycle Bin never block moving their client, system type or engineer there too. They block their permanent deletion, and a contract cannot be restored before its client, system type and engineer.

Everything else keeps its own route back, and does not appear in the Recycle Bin:

| Record | What happens | How it comes back |
|---|---|---|
| Contract (cancelled) | Status Cancelled | Its own page (Cancelled to Active) |
| Scheduled visit | Status Cancelled | Not offered; regenerate cannot revive one |
| Untouched visit outside new terms | Row deleted; the log keeps id, number and period | Generated again if the terms return |
| Invoice | Status Cancelled | Not reversible; the number can be entered again |
| Expense | Voided | Not reversible |
| Client, sales engineer, system type, department | Disabled (deactivated) | Their own page |
| Maintenance frequency | Disabled or archived; never deleted (405) | Its own page (rules apply) |
| User | Deactivated | Users & Access |
| Holiday, custom role | Row deleted; log only | Create it again |

## How it works (migrations 0101 and 0106)

* The tables are `amc_contracts_all`, `amc_visits_all`, `clients_all`, `system_types_all` and `sales_engineers_all`. Views with the old names (`amc_contracts`, `amc_visits`, `clients`, `system_types`, `sales_engineers`) show only the rows not deleted, so every list, picker, schedule, KPI, report, export and endpoint treats a deleted record as not found, without each query being changed.
* **Nothing is removed** on Delete: `deleted_at` and `deleted_by` are set. Every other value stays, including `updated_at` (for the three master tables, a Recycle Bin move does not touch it; 0106).
* **Restore** clears `deleted_at` on the same row: same id, code, reference and links. The record comes back active or disabled, as it was.
* **Names and codes stay reserved** while a record is in the Recycle Bin (D5): the unique indexes cover the `*_all` tables, so a restore can never collide. Adding a duplicate gets "… is in the Recycle Bin. Ask Super Admin to restore it from the Recycle Bin instead." The legacy importer refuses a register naming a client in the Recycle Bin, and imports nothing.
* **Database guards** (0106), whatever the application does:
  * `RB001`: a record outside the Recycle Bin may not point at one in it. Guards on `amc_contracts_all` (client, system type, sales engineer, and restoring a contract), `invoices`, `projects` and `legacy_import_rows` (client).
  * `RB002`: a record still used outside the Recycle Bin may not be moved into it.
  * Locks: a move takes `FOR UPDATE` on the record; a new link takes `FOR KEY SHARE` on it (through its foreign key and the guard). The two wait for each other, so they can never both succeed.
* All foreign keys stay `ON DELETE RESTRICT`: the last guard against a permanent deletion of a used record.

### "Never used" (permanent deletion)

Permanent deletion is refused, with every reason listed, when any of these holds:

1. Any AMC contract refers to the record, in any status, including Historical, Cancelled, imported and Recycle Bin contracts.
2. For a client: any invoice (any status), project or historical import row.
3. Its creation is not in the Audit Log (`<type>.created`): it was imported or seeded, so its past cannot be known.
4. Any Audit Log entry about another record names it, by any name or code it has had (current, or earlier ones from its own change history), or stores its id under `clientId`, `systemTypeId`, `salesEngineerId` and similar keys. This catches a contract once linked to it and since changed.
5. For a sales engineer: any contract names it as the responsible engineer in its typed text.

When use cannot be ruled out, the record stays in the Recycle Bin. The check runs again inside the deletion's own transaction, after locking the record.

## API

| Method and path | Effect |
|---|---|
| `DELETE /api/clients/:id`, `/api/masters/system-types/:id`, `/api/masters/sales-engineers/:id`, `/api/amc/contracts/:id` | Move to the Recycle Bin |
| `GET /api/clients/:id/usage`, `/api/masters/system-types/:id/usage`, `/api/masters/sales-engineers/:id/usage` | Counts for the delete dialog: live contracts by status, Recycle Bin contracts apart, and for clients invoices, projects and import rows |
| `GET /api/security/recycle-bin` | The records in the Recycle Bin: `type`, `search`, `deletedBy`, `from`, `to`, `page`, `pageSize`; counts per type |
| `GET /api/security/recycle-bin/:type/:id/check` | What restore and permanent deletion would do: blockers, warnings, reasons, the code to type |
| `POST /api/security/recycle-bin/:type/:id/restore` | Restore |
| `DELETE /api/security/recycle-bin/:type/:id` with `{ "confirm": "<code>" }` | Permanent deletion |
| `GET /api/security/deletions`, `/deletions/export` | Deletion History (now with `RESTORED` events, `deletion` and `currentStatus`) |

`:type` is `amc-contracts`, `clients`, `system-types` or `sales-engineers`. `GET /api/security/recycle-bin/amc-contracts` is kept for a frontend released before 0106.

## Audit

| Action | Meaning |
|---|---|
| `<type>.deleted` with `metadata.recycleBin = true` | Moved to the Recycle Bin; `metadata.deleted` holds the whole row |
| `<type>.restored` | Restored from the Recycle Bin |
| `<type>.purged` | Deleted permanently from the Recycle Bin; `metadata.deleted` holds the whole row |
| `client.deleted`, `system_type.deleted`, `sales_engineer.deleted` without `recycleBin` | Deleted permanently before 0106; shown as "Deleted permanently" |

A client deleted permanently before 0106 (for example client 86 on the development database) has no row to restore, and none is ever recreated from the log.

## For later migrations

Alter the `*_all` tables, not the views; reference them in new foreign keys; and recreate the matching view afterwards (`CREATE OR REPLACE VIEW … SELECT * …`) so it shows any new column. A new table that refers to a client, system type or sales engineer needs the 0106 guard trigger too, and its references must be added to `recycle_bin_master_guard()` and to the usage and evidence checks (`stslv-api/src/modules/recycle-bin/recycle-bin.service.ts`).

## Decisions (2026-11-04)

* D1: a record used by a contract outside the Recycle Bin cannot be moved there; contracts in the Recycle Bin do not block.
* D2: a client with any invoice (any status) or project cannot be moved there.
* D3: permanent deletion only from the Recycle Bin.
* D4: AMC contracts are never deleted permanently.
* D5: names and codes stay reserved while in the Recycle Bin.
* D6: a contract can be restored while its client, system type or engineer is deactivated (with a warning), but not while one is in the Recycle Bin.
* D7: the Recycle Bin is Super Admin's; Admin keeps the Deletion History.
