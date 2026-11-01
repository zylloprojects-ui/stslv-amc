# Recycle Bin

Page: `/admin/deletion-log`. API: `/api/security/deletions`. Formerly named Deletion Log; the address, API, permissions and logged action names are unchanged, so links and audit history stay valid.

**It is a history page. Nothing can be recovered from it.** It reads `activity_logs` and holds no removed records. There is no Restore button, by decision (2026-11-01).

## How removal works

There is no general soft-delete mechanism: no `deleted_at` column and no trash table. All 68 foreign keys are `ON DELETE RESTRICT`, so a record in use cannot be deleted and nothing cascades.

| Record | What happens | Kept? | How it comes back |
|---|---|---|---|
| Contract | Status Cancelled | Yes | Its own page (Cancelled to Active). Visits cancelled with it stay cancelled |
| Scheduled visit | Status Cancelled | Yes | Not offered as a recovery; regenerate cannot revive one |
| Untouched visit outside new terms | Row deleted | Log keeps id, number and period | Generated again if the terms return |
| Invoice | Status Cancelled | Yes | Not reversible; the number can be entered again |
| Expense | Voided | Yes | Not reversible; enter a new one |
| Client, Sales Engineer, System Type, Department | Deactivated | Yes | Their own page |
| Maintenance Frequency | Disabled or archived | Yes | Its own page (rules apply) |
| User | Deactivated | Yes | Users & Access |
| Pending sign-up | Rejected; role links removed | Yes | A new sign-up |
| Unused System Type | Row deleted | Log keeps its values | Create it again |
| Holiday, custom role | Row deleted | Log only | Create it again |

## Why Restore is not needed now

Everything with business value is already retained, and the reversible cases already have a checked route on the record's own page. Only small, unused or re-creatable rows are truly deleted, and those are refused when in use.

## Why a Restore button would be unsafe today

* **Cancelled contract:** reactivating leaves its cancelled visits cancelled, and may conflict with a renewal that replaced it (the API refuses that). Reviving visits would need a rule for dates already passed.
* **Cancelled visit:** recovering it changes schedule totals, and reconciliation, and it may overlap a period since regenerated.
* **Cancelled invoice:** its number may have been reused, and its allocations must still reconcile. The visit's Invoice Tracking state would change underneath completed work.
* **Deleted rows:** the log is not a full copy. Restored ids and references could not be guaranteed.
* **Audit:** a log entry is history. Acting on it would make one page both the record of an event and a way of undoing it.

## If it is ever wanted

1. A business decision on which record types, who may restore, and for how long. This is the Trash and recovery item awaiting approval.
2. A rule per type for its dependants, conflicts and financial effects, such as restored visits, reused invoice numbers and renewals.
3. Stored snapshots, or `deleted_at` on chosen tables with every list and total updated to exclude them. Either needs migrations.
4. A permission of its own, an audited restore action, and tests that totals still reconcile after a restore.
5. A retention rule, and a decision on permanent removal.

Roughly a separate module, not a button. The safer first step would be a link from each entry to the record's own page, where the checked actions already exist.
