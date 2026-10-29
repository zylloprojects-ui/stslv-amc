# Roles & Permissions

Status: 2026-10-29, branch `feature/roles-permissions-catalog` (worktree `D:\Projects\STSLV-AMC-permissions`), based on alpha 83fa3b0. Committed on this branch; not merged into alpha, not pushed.

Decisions (2026-10-29):

- **A — approved:** separate permission modules for AMC Renewal, Monthly Calendar, Service Status, Sales Engineers, System Types, Maintenance Frequencies and Departments; existing access preserved by copying grants.
- **B — approved:** Users: Approve governs approving and rejecting sign-up requests; Users: Edit stays for normal user editing.
- **C — deferred:** legacy grants, APIs and records of PROJECTS, PROCUREMENT, EXPENSES, HISTORICAL_DATA and REPORTS are kept, shown in a Retired section, pending a later cleanup.

Migrations 0080 and 0081 are **not applied** to `stslv_amc_dev` or Neon. They were applied to a throwaway copy of `stslv_amc_dev` (`stslv_amc_smoke_permissions`) to verify them.

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

Not set by role permissions: **Admin role only** — Audit Log, Dashboard system readiness, historical import audit. **Every signed-in user** — Notifications (filtered by module), My account.

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

Every user holds exactly one role. Enforced in the API and the UI; the database is unchanged (see the proposal below).

- `POST /api/users` and `PUT /api/users/:id/roles` take `roleIds` as a list of **exactly one** role id (the shape the API already used). No role, or several, answers 400 `Select exactly one role.` on the field `roleIds`; the same id twice counts as one. The services check the rule again.
- Changing a role replaces whatever the user held, in one transaction under the user's row lock, and is recorded as `user.roles_changed` with `added` / `removed`.
- Approving a sign-up (`POST /api/users/:id/activate` on a pending account, USERS:APPROVE) needs exactly one active role: none answers 409 `Assign a role before approving this user.`; several answer 409 `This user has more than one role. Choose one role before approving.` Nothing is removed by a refusal.
- Unchanged: nobody changes their own role; a role can be given only by someone holding all of its permissions; the last active Admin cannot lose the Admin role; a rejected request cannot be given a role; rejecting removes the role given while pending.
- A user can no longer be left with no role through the API. Taking someone's access away is done by deactivating the account.
- UI: Create User and Change role use one radio group of the roles (inactive roles shown, not selectable), with the current role shown; Save is enabled only for a change. The Users table shows the role in a **Role** column; an account holding several roles from before the rule is marked "Several roles: choose one", and its approval is disabled until one is chosen, which replaces them all.

Existing data: read-only audit of local `stslv_amc_dev` (2026-10-29): 1 user, 1 role, 0 users with several roles, 0 pending. No cleanup needed there. Neon was not queried.

### Proposal (not implemented): a database constraint

The API is the only writer of `user_roles` besides `npm run admin:create` (one role) and the rejection (removes all), so the rule holds. A constraint would also stop a direct database write from adding a second role:

```sql
-- 0082_one_role_per_user (proposal)
-- Stops if any user holds several roles, so nothing is removed silently.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles GROUP BY user_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Some users hold several roles. Choose one for each before applying 0082.';
  END IF;
END $$;
CREATE UNIQUE INDEX user_roles_one_per_user_uq ON user_roles (user_id);
```

Needs approval, and on each database first a read-only count of users with several roles (Neon included). It would be numbered before Suggestions' 0085. Nothing in the application depends on it.
