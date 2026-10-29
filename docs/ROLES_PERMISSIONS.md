# Roles & Permissions

Status: 2026-10-29, branch `feature/roles-permissions-catalog` (worktree `D:\Projects\STSLV-AMC-permissions`), based on alpha 83fa3b0. Committed on this branch; not merged into alpha, not pushed.

Decisions (2026-10-29):

- **A — approved:** separate permission modules for AMC Renewal, Monthly Calendar, Service Status, Sales Engineers, System Types, Maintenance Frequencies and Departments; existing access preserved by copying grants.
- **B — approved:** Users: Approve governs approving and rejecting sign-up requests; Users: Edit stays for normal user editing.
- **C — deferred:** legacy grants, APIs and records of PROJECTS, PROCUREMENT, EXPENSES, HISTORICAL_DATA and REPORTS are kept, shown in a Retired section, pending a later cleanup.
- **One role per user — approved:** enforced in the API and UI (section 9) and by migration 0082 in the database.

Migrations 0080, 0081 and 0082 are **not applied** to `stslv_amc_dev` or Neon. They were applied to a throwaway copy of `stslv_amc_dev` (`stslv_amc_smoke_permissions`) to verify them. Order and prerequisites: section 10.

## 1. How permissions work

- Tables: `roles`, `user_roles`, `role_permissions(role_id, module, action)`. The CHECK constraint `role_permissions_module_ck` lists the allowed modules (0080 widens it to 21).
- Actions: VIEW, CREATE, EDIT, DELETE, APPROVE, EXPORT.
- The API checks every request with `authorize(module, action)`, `authorizeOnAny(modules, ...actions)` (a route that serves several pages) or a permission check in the service. A permission not held is refused (deny by default).
- `stslv-api/src/shared/permission-catalog.ts` describes, per module, the pages it opens and the actions the code checks. Roles & Permissions is drawn from it, and only those actions can be **newly** granted. A grant already held on an unused action or a retired module is kept, shown as "No effect", and can be removed.
- `tests/permission-catalog.test.ts` checks the catalog against every permission check in the API and the web app, the sidebar and the route guards.
- Self-escalation is blocked in the API: nobody grants or revokes a permission they do not hold, assigns a role beyond their own permissions, changes their own roles, or edits the Admin role. The last active Admin cannot be removed. A sign-up cannot be approved without an active role.

## 2. Current permission modules

| Section | Module | Pages | Actions |
|---|---|---|---|
| Dashboard | DASHBOARD | Dashboard | View |
| Master Data Center | CLIENTS | Clients, Client 360 | View, Create, Edit, Delete (= deactivate/reactivate), Export |
| Master Data Center | SALES_ENGINEERS | Sales Engineers, Engineer 360 | View, Create, Edit, Export |
| Master Data Center | SYSTEM_TYPES | System Types | View, Create, Edit, Delete (unused types), Export |
| Master Data Center | MAINTENANCE_FREQUENCIES | Maintenance Frequencies | View, Create, Edit, Export |
| Master Data Center | DEPARTMENTS | Departments | View, Create, Edit, Export |
| AMC Operations | AMC_CONTRACTS | AMC Management, AMC Contracts, contract details | View, Create, Edit (edit, status, schedule generation, master links), Delete (= cancel contract, with Edit), Export (a client's contracts) |
| AMC Operations | AMC_RENEWAL | AMC Renewal | View, Create (renew, from AMC Renewal or the contract page), Export |
| AMC Operations | AMC_SCHEDULE | AMC Schedule; Master AMC Status (+INVOICES, SERVICES_SALES) | View, Edit (scheduled visit, also from the calendar), Export |
| AMC Operations | MONTHLY_CALENDAR | Monthly Calendar | View, Export (month download) |
| AMC Operations | SERVICE_STATUS | Service Status | View, Export |
| AMC Operations | AMC_EXECUTION | no page: visit actions on Schedule and Service Status | View, Edit (start/postpone/complete, report no., saving a Service Status row), Approve (= reopen a completed visit) |
| AMC Operations | SERVICES_SALES | Services Sales; Master AMC Status | View, Edit (quotation no.), Export |
| Finance | INVOICES | Invoice Tracking; Accounts (+AMC_SCHEDULE) | View, Create, Edit (incl. cancel), Export |
| Administration | USERS | Users & Access, Roles & Permissions, Login History | View, Create, Edit (users, activation, roles, role permissions, passwords), Approve (**approve/reject sign-ups**), Delete (role) |
| Administration | SETTINGS | Settings (holidays) | View, Create, Edit, Delete |
| Retired | PROJECTS | none; API live (Settings VAT panel reads it) | View, Create, Edit |
| Retired | PROCUREMENT | none; API live | View, Create, Edit |
| Retired | EXPENSES | none; API live | View, Create, Edit, Delete (= void) |
| Retired | HISTORICAL_DATA | none; API live | View |
| Retired | REPORTS | none; checked nowhere | — |

Shared read access, unchanged in effect: anyone with AMC_CONTRACTS View may read the four master lists (contract pickers); Sales Engineers View may read Departments, and Departments View may read Sales Engineers (each page needs the other list). The visit list and its export serve both AMC Schedule and Monthly Calendar; the visit filter options serve Schedule, Calendar and Service Status.

Not set by role permissions: **Admin role only** — Audit Log, Suggestions Review, Dashboard system readiness, historical import audit. **Every signed-in user** — Notifications (filtered by module), My Suggestions and the suggestion popup, My account.

## 3. Before and after (approved matrix)

V view · C create · E edit · D delete · A approve · X export. Admin holds every action of every module, before and after. The four non-Admin roles have no users on `stslv_amc_dev`.

| Module | Accountant | Procurement | Execution | Invoicing |
|---|---|---|---|---|
| DASHBOARD | V | V | V | V |
| CLIENTS | V | V | V | V |
| AMC_CONTRACTS | V | — | V | V |
| **AMC_RENEWAL (new)** | before via AMC_CONTRACTS V → **V** | — | → **V** | → **V** |
| AMC_SCHEDULE | V | — | V | V |
| **MONTHLY_CALENDAR (new)** | before via AMC_SCHEDULE V → **V** | — | → **V** | → **V** |
| **SERVICE_STATUS (new)** | before via AMC_SCHEDULE V → **V** | — | → **V** | → **V** |
| AMC_EXECUTION | — | — | V, E | — |
| SERVICES_SALES | V | — | V | V, E |
| INVOICES | V | — | — | V, C, E |
| **SALES_ENGINEERS, SYSTEM_TYPES, MAINTENANCE_FREQUENCIES, DEPARTMENTS (new)** | — | — | — | — |
| SETTINGS | — | — | — | — |
| USERS (incl. **A**) | — | — | — | — |
| *Retired: PROJECTS / PROCUREMENT / EXPENSES / REPORTS* | V / V / V,C,E / V | V / V,C,E / V / — | V / V / — / — | V / — / — / V |
| *Retired: HISTORICAL_DATA* | — | — | — | — |

Every page each role could open before, it opens after; nothing new opens. The new rows only carry the access the role already had through the module the page used to share. Admin gains 42 grants (7 new modules × 6 actions).

Verified on a copy of `stslv_amc_dev` (2026-10-29): 123 grants before, 174 after; 0 removed; non-Admin additions exactly the 9 in **bold** above; 42 Admin additions; roles (ids 1–5) and the user's role assignment unchanged.

## 4. Migrations

**0080_page_permission_modules** — replaces `role_permissions_module_ck` with the 21-module list (the 14 existing plus the 7 new). Grants and removes nothing. Brief lock on `role_permissions`.

**0081_seed_page_permissions** — idempotent (`ON CONFLICT DO NOTHING`):

1. ADMIN: every action of the 7 new modules.
2. Every role: the new module's actions copied from the module it is split from, only for actions the new module uses —
   AMC_CONTRACTS → AMC_RENEWAL (V, C, X); AMC_SCHEDULE → MONTHLY_CALENDAR (V, X) and SERVICE_STATUS (V, X);
   SETTINGS → SALES_ENGINEERS (V, C, E, X), SYSTEM_TYPES (V, C, E, D, X), MAINTENANCE_FREQUENCIES (V, C, E, X), DEPARTMENTS (V, C, E, X).
3. Every role holding USERS:EDIT receives USERS:APPROVE, so whoever could approve sign-ups still can.

Nothing is deleted; the old grants stay and keep governing their remaining pages. 0080 and 0081 must be applied together. Before applying to `stslv_amc_dev`: backup, `npm run migrate:status`, then `npm run migrate`. Neon only with separate approval.

Reverse (only with approval): delete the grants on the 7 new modules (and, if wanted, the USERS:APPROVE grants 0081 added), then restore the constraint as 0078 left it.

## 5. Approval of sign-ups (decision B)

- `POST /api/users/:id/activate` on a PENDING account (its approval) needs USERS:APPROVE; on any other account (reactivation) it needs USERS:EDIT. Deactivating needs USERS:EDIT.
- `POST /api/users/:id/reject` needs USERS:APPROVE.
- Assigning roles, editing, resetting passwords stay on USERS:EDIT. An approval still needs an active role first, and the approver may not approve someone whose permissions exceed their own.
- Users & Access shows Approve/Reject only to USERS:APPROVE, and Change roles/Reset password/Activate/Deactivate only to USERS:EDIT.

## 6. Legacy permissions (decision C, deferred)

| Role | Retired grant | Effect today |
|---|---|---|
| Accountant | PROJECTS V, PROCUREMENT V, EXPENSES V/C/E, REPORTS V | Projects/Procurement/Expenses API still answer; REPORTS nothing |
| Procurement | PROJECTS V, PROCUREMENT V/C/E, EXPENSES V | API still answers — the only access this role has besides Dashboard and Clients |
| Execution | PROJECTS V, PROCUREMENT V | API still answers |
| Invoicing | PROJECTS V, REPORTS V | API still answers; REPORTS nothing |

Kept unchanged and shown in Roles & Permissions under "Retired modules". No new grant on a retired module is accepted.

## 7. Related fixes on the branch

- Accounts tests answered 503 in a full run: `tests/amc-service-status.test.ts` dropped `amc_visits.service_report_no` in its teardown, a leftover from when 0077 was staged. Any later file needing the column (Accounts) then failed the schema check. Test-only; the teardown no longer drops it.
- Roles & Permissions never showed "Permissions saved" after a real save (the matrix is re-created when the reloaded grants arrive); the confirmation is now kept by the panel.
- The Settings VAT-rate panel checks PROJECTS Create, the permission its API needs.

## 8. Integration with other branches

### Order and migrations

- Merge this branch into alpha **before or together with** `feature/suggestions`. Its migration is numbered 0085 so it follows 0080/0081: the runner refuses a pending migration older than one already applied, so wherever both are applied, 0080 and 0081 go first.
- AMC Contracts filters (alpha `4a180d6`): no permission change; its new route `GET /api/amc/contracts/filter-options` uses AMC_CONTRACTS View, which the catalog covers. Checked 2026-10-29: this branch applies onto `4a180d6` without conflicts, and the combined API (1155 passed, 1 skipped) and web (534) suites passed.
- Forgot Password fix: the public auth routes (`/api/auth/forgot-password`, `/reset-password`, `/signup`, `/login`) are outside the permission catalog and are not changed here. This branch touches `stslv-api/tests/helpers.ts` (seed list) and `tests/auth-rejection.test.ts` (an added block at the end); a fix that also edits those files may need a small manual merge.

### Suggestions (`feature/suggestions`, 466d591): what the catalog needs

Suggestions adds no permission module (approved: review is the built-in Admin role until a SUGGESTIONS module is approved). Its access is therefore **fixed access**, not role permissions:

| Page / route | Who | Guard |
|---|---|---|
| `/admin/suggestions` (Suggestions Review), `GET /api/suggestions/review`, `/review/options` | Admin role only | `RequireAdmin` / `adminOnly` |
| `PATCH /api/suggestions/:id/status`, `/:id/assignment` | Admin role only | `adminOnly` |
| `/suggestions`, `/suggestions/:id`, `POST /api/suggestions`, `GET /mine`, `/:id`, comments, reopen own | every signed-in user (own suggestions; another user's only for a reviewer, checked in the service) | `authenticate` |

When merging, in the same change:

1. Add to `FIXED_ACCESS` in `stslv-api/src/shared/permission-catalog.ts`:
   - `adminOnly`: `{ label: "Suggestions Review", path: "/admin/suggestions" }`;
   - `everyone`: `{ label: "My suggestions", path: "/suggestions" }`.
   Roles & Permissions then lists them under "Not set by role permissions".
2. Keep the sidebar entry `{ label: 'Suggestions Review', path: '/admin/suggestions', module: 'USERS', adminOnly: true }`. The catalog test skips `adminOnly` items, so it needs no catalog page; `USERS` there only hides the item from users without Users & Access view, on top of the Admin check.
3. Run `tests/permission-catalog.test.ts`: Suggestions adds no `authorize(...)`, `permissions.has(...)` or `can(...)` literal, so it should pass unchanged. If a later Suggestions change checks a module permission, that module/action must be in the catalog or the test fails.
4. A future SUGGESTIONS module would need: a migration widening `role_permissions_module_ck` (after 0081), ADMIN grants, an entry in `MODULES` (API and web), a catalog entry with its pages and used actions, and replacing `adminOnly` with `authorize("SUGGESTIONS", …)`. Which roles receive it is a business decision.

### Shared files likely to need a manual merge

| File | This branch | Others |
|---|---|---|
| `stslv-web/src/layout/navigation.ts` | module codes of 7 items | Suggestions adds one item |
| `stslv-web/src/App.tsx` | route guards of 8 routes, Master Data Center hub | Suggestions adds 3 routes |
| `stslv-api/src/modules/amc/amc.routes.ts` | renewal, visit and Service Status guards | `4a180d6` adds filter-options (applies cleanly) |
| `stslv-web/src/test/amc-helpers.ts` | fixture permissions via `afterPageSplit` | `4a180d6` adds a mock route (applies cleanly) |

## 9. One role per user (approved 2026-10-29)

Every user holds exactly one role. Enforced in the API and the UI (commit 4717f4e) and, from migration 0082, by the database (at most one role per user).

- `POST /api/users` and `PUT /api/users/:id/roles` take `roleIds` as a list of **exactly one** role id (the shape the API already used). No role, or several, answers 400 `Select exactly one role.` on the field `roleIds`; the same id twice counts as one. The services check the rule again.
- Changing a role replaces whatever the user held, in one transaction under the user's row lock, and is recorded as `user.roles_changed` with `added` / `removed`.
- Approving a sign-up (`POST /api/users/:id/activate` on a pending account, USERS:APPROVE) needs exactly one active role: none answers 409 `Assign a role before approving this user.`; several answer 409 `This user has more than one role. Choose one role before approving.` Nothing is removed by a refusal.
- Unchanged: nobody changes their own role; a role can be given only by someone holding all of its permissions; the last active Admin cannot lose the Admin role; a rejected request cannot be given a role; rejecting removes the role given while pending.
- A user can no longer be left with no role through the API. Taking someone's access away is done by deactivating the account.
- UI: Create User and Change role use one radio group of the roles (inactive roles shown, not selectable), with the current role shown; Save is enabled only for a change. The Users table shows the role in a **Role** column; an account holding several roles from before the rule is marked "Several roles: choose one", and its approval is disabled until one is chosen, which replaces them all.

Existing data: read-only audit of local `stslv_amc_dev` (2026-10-29): 1 user, 1 role, 0 users with several roles, 0 pending. No cleanup needed there. Neon was not queried.

### Migration 0082_one_role_per_user (approved 2026-10-29)

`ALTER TABLE user_roles ADD CONSTRAINT user_roles_one_role_uq UNIQUE (user_id)`: the database refuses a second role for a user from any writer (error 23505 on `user_roles_one_role_uq`). At most one, not exactly one: a sign-up request has no role until one is assigned, and a rejected request keeps none. The primary key `(user_id, role_id)` stays.

- **Fails safely.** A guard first counts the users holding several roles; if any, it raises `0082: N user(s) hold more than one role. Choose one role for each in Users & Access, then apply 0082 again. Nothing was changed.` The runner wraps each migration in a transaction and rolls it back: no assignment is removed, no constraint is created, 0082 is not recorded. Only a count is reported, no personal data.
- **Changes no data.** Replacing a role through the API still works with the constraint: the old row is deleted and the new one inserted in the same transaction.
- **Reverse** (only with approval; the API keeps enforcing one role):
  ```sql
  BEGIN;
  ALTER TABLE user_roles DROP CONSTRAINT user_roles_one_role_uq;
  DELETE FROM schema_migrations WHERE version = '0082';
  COMMIT;
  ```
  Every assignment is kept; `npm run migrate` applies 0082 again afterwards.

Verified 2026-10-29 on isolated databases only:

| Check | Where | Result |
|---|---|---|
| Applied after 0080/0081 from an empty schema | `stslv_amc_test_permissions` (test schema rebuilt by every API run) | applied in order; `UNIQUE (user_id)` |
| Guard with a user holding two roles, real runner | `stslv_amc_smoke_permissions` (copy of local dev data, already at 0081) | stopped, rolled back; 8 assignments unchanged; no constraint; 0082 not recorded |
| Recovery: one role chosen through the API, then `npm run migrate` | same | applied |
| Direct `INSERT` of a second role | same | refused, `duplicate key value violates unique constraint "user_roles_one_role_uq"`; first role kept |
| API replace role, refuse two roles, create user with one role | same, API on port 3301 | 200 / 400 / 201 |
| Reverse statement, then `npm run migrate` again | same | constraint removed then re-created; assignments identical throughout |
| Automated: `tests/one-role-constraint.test.ts` | test schema | constraint, direct insert refused, API replace, guard stops and leaves data, applies after one role is chosen, reverse and re-apply |

Tests that cover databases where 0082 is not applied yet (a user with several roles from before the rule) run inside `withoutOneRoleConstraint()` in `tests/helpers.ts`, which drops the constraint on the test schema only and restores it afterwards.

## 10. Migration order and deployment prerequisites

Order on every database: **0080 → 0081 → 0082 → (Suggestions) 0085**. The runner refuses a pending migration numbered below one already applied, so 0080–0082 must be applied before 0085 anywhere both are applied. 0080 and 0081 belong together (0081 needs 0080's module codes); 0082 is independent of them but numbered after.

None of 0080–0082 is applied to `stslv_amc_dev` or Neon. Before applying to a shared or production database (each step separately approved):

1. **Backup** taken and its restore checked (custom-format `pg_dump`, timestamped, never overwriting an earlier dump).
2. **Read-only audit** of role assignments, counts only:
   ```sql
   SELECT count(*) AS users_with_several_roles FROM (SELECT user_id FROM user_roles GROUP BY user_id HAVING count(*) > 1) x;
   SELECT count(*) AS users_without_role FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id);
   ```
   If any user holds several roles, an administrator chooses one in Users & Access before 0082 (the migration stops otherwise). Users without a role do not block it.
3. **Grant check** for 0081: record `SELECT r.code, rp.module, rp.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id` before, compare after; only additions on the seven new modules and `USERS:APPROVE` are expected, nothing removed (section 3).
4. `npm run migrate:status` shows exactly the expected pending migrations, then `npm run migrate`.
5. The API version that knows the new modules (this branch) is deployed together with the migrations: an older API does not know the new module codes, and the web app of this branch hides pages whose new codes the user does not hold.

Local `stslv_amc_dev` audit 2026-10-29: 1 user with 1 role; 0 with several; 0 pending. Neon has not been audited.
