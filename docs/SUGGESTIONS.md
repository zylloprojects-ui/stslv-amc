# Suggestions & Feedback

Status: built on `feature/suggestions` (from alpha `4a180d6`), 2026-10-29. Not merged
into alpha: waiting for the Roles & Permissions branch (see "Integration with Roles &
Permissions" below).

## Approved decisions (2026-10-29)

1. Review and management of suggestions is **Admin-only** for now.
2. Every authenticated user can submit suggestions and view their own.
3. A user may reopen their own **Resolved** suggestion, giving a reason.
4. A **Closed** suggestion can be reopened only by Admin (or, later, an authorized reviewer).
5. Notifications are **in-app only**; email is not required for this release.
6. All suggestions and their audit history are preserved: nothing is deleted.

## Why it was rebuilt

Before this branch the header light-bulb popup (`stslv-web/src/layout/FeedbackWidget.tsx`)
was an interface only: `submit()` checked the description length and showed a
thank-you message reading "Suggestions are not stored or sent yet." There was no
API endpoint, no table and no review screen, so nothing a user typed reached
anyone.

## Workflow

```
Submitted → Under Review → In Progress → Resolved → Closed
Resolved / Closed → Reopened → (back into review)
```

| From | Reviewer may move to | Submitter may move to |
| --- | --- | --- |
| Submitted | Under Review, In Progress, Resolved, Closed | — |
| Under Review | In Progress, Resolved, Closed | — |
| In Progress | Under Review, Resolved, Closed | — |
| Reopened | Under Review, In Progress, Resolved, Closed | — |
| Resolved | Closed, Reopened | Reopened |
| Closed | Reopened | — |

- **Resolved** requires resolution notes (shown to the submitter).
- **Closed** from anything other than Resolved requires a reason (e.g. duplicate).
- **Reopened** requires a reason.
- Every change carries the status the caller saw (`fromStatus`); if it has changed
  meanwhile the API answers 409 and the page reloads.
- The rules live in `stslv-api/src/modules/suggestions/suggestions.workflow.ts`.

## Who can do what

| Action | Who | Enforced by |
| --- | --- | --- |
| Submit | Any signed-in user | `authenticate` |
| See own list / own suggestion | The submitter | Ownership check in the service |
| Comment on own suggestion | The submitter, unless Closed | Service |
| Reopen own Resolved suggestion | The submitter, with a reason | Service + workflow |
| See all, filter, search | Reviewer | `adminOnly` |
| Change status, resolve, close, reopen | Reviewer | `adminOnly` + workflow |
| Assign a responsible person | Reviewer; assignee must be an active reviewer | `adminOnly` + service |
| Internal note (hidden from submitter) | Reviewer | Service |

A non-reviewer asking for another user's suggestion gets **404**, so its existence
is not revealed. Nothing is ever deleted.

**Reviewer = the built-in Admin role**, for now. This grants nothing new to any
other role. A reviewer who submitted a suggestion acts as a reviewer on it.

## Permission requirements (for Roles & Permissions)

The permission catalog and `role_permissions_module_ck` are being changed on
`feature/roles-permissions-catalog` (migrations 0080/0081), so this branch adds
no permission module and calls no `authorize()`. Proposed codes once that work
is merged — **none is granted to a non-Admin role without approval**:

| Proposed | Meaning | Today |
| --- | --- | --- |
| *(none: every signed-in user)* | Submit, view own, comment on own, reopen own Resolved | Any signed-in user |
| `SUGGESTIONS:VIEW` | See every suggestion (Suggestions Review) | Admin only |
| `SUGGESTIONS:EDIT` | Respond, internal notes, change status (review, start, resolve, close, reopen) | Admin only |
| `SUGGESTIONS:APPROVE` *(optional)* | Assign a responsible person | Admin only |

Integration steps, after the catalog branch is merged and if the codes are approved:

1. A migration (after 0081) adding `SUGGESTIONS` to `role_permissions_module_ck`
   and granting every action to ADMIN only.
2. `SUGGESTIONS` in `MODULES` (API `shared/permissions.ts`, web `lib/types.ts`)
   and an entry in `shared/permission-catalog.ts`.
3. Replace `adminOnly` in `suggestions.routes.ts` with `authorize("SUGGESTIONS", …)`,
   and `isReviewer()` in `suggestions.workflow.ts` with the permission check.
4. Navigation: `module: 'SUGGESTIONS'` instead of `module: 'USERS', adminOnly: true`.

Until then, with the catalog branch merged, list the pages in its `FIXED_ACCESS`:
"Suggestions Review" (`/admin/suggestions`) under `adminOnly`, and "My Suggestions"
(`/suggestions`) with the pages every signed-in user has.

## Database (migration 0085)

- `suggestions` — one row per submission and its current state: category
  (Improvement / Bug / Feature, as in the popup), subject, description, the page
  it was sent from, status, assignee, resolution notes, resolved/closed by and
  when, who last changed the status and when, and `client_request_id`.
- `suggestion_events` — the history, append-only: submitted, each status change
  (with its note), assignment and comment (optionally internal), with actor and time.
- The reference (`SUG-00042`) is derived from the id, not stored.
- `UNIQUE (submitted_by, client_request_id)`: the popup sends one request id per
  opened form, so a double click or retry returns the first suggestion (200)
  instead of creating a copy (201).
- Numbered 0085 so it follows 0080/0081; the runner refuses a pending migration
  older than an applied one.
- Without the migration every `/api/suggestions` route answers 503
  `FEATURE_UNAVAILABLE`, and the pages say so.

## API (`/api/suggestions`)

| Method | Path | Who |
| --- | --- | --- |
| POST | `/` | Any user. 201 created, 200 for a repeated request id |
| GET | `/mine?status&category&search&page&pageSize` | Any user (own only) |
| GET | `/:id` | Submitter or reviewer (internal notes only to reviewers) |
| POST | `/:id/comments` `{ body, internal? }` | Submitter (not Closed) or reviewer |
| POST | `/:id/reopen` `{ fromStatus, reason }` | Submitter, Resolved only |
| GET | `/review?view=OPEN|ALL&status&category&submittedBy&assignedTo|none&from&to&search&page&pageSize` | Reviewer; includes counts per status |
| GET | `/review/options` | Reviewer: submitters and assignable reviewers |
| PATCH | `/:id/status` `{ status, fromStatus, note? }` | Reviewer |
| PATCH | `/:id/assignment` `{ assignedTo \| null }` | Reviewer |

Every change is also written to `activity_logs` (module `SUGGESTIONS`), so it
appears in the Audit Log. Comment text stays in `suggestion_events` only.

## Alerts

Two alerts in the existing Notifications (uses `notification_reads`, no new table):

- Reviewers: "Suggestions waiting for review" — Submitted or Reopened suggestions.
- Submitters: "Updates on your suggestions" — own suggestions whose latest visible
  activity in the last 30 days was by someone else.

## Pages

- Header light bulb → submission popup (any page). On success it shows the reference.
- `/suggestions` — My Suggestions (also in the user menu).
- `/suggestions/:id` — detail, resolution, history, comments; review controls for reviewers.
- `/admin/suggestions` — Suggestions Review (Administration menu, Admin only).

## Integration with Roles & Permissions

`feature/roles-permissions-catalog` (worktree `D:\Projects\STSLV-AMC-permissions`) was
still in progress when this branch was finished. Merge it into alpha **first**, then
this branch, and check each point below.

### Migration ordering

- That branch adds `0080_page_permission_modules.sql` and `0081_seed_page_permissions.sql`;
  this branch adds `0085_suggestions.sql`. No file names collide.
- The runner (`src/db/migrate.ts`) refuses a pending migration older than an applied
  one. On any database, apply **0080 and 0081 before 0085**. Do not apply 0085 to a
  database that will later receive 0080/0081.
- 0085 does not touch `role_permissions` or `role_permissions_module_ck`, so it does
  not depend on 0080/0081 functionally; only the order matters.
- If the permissions branch gains more migrations, keep their numbers below 0085, or
  renumber 0085 **before it is applied anywhere shared** (it is applied only to the
  throwaway test database `stslv_amc_test_suggestions` so far).
- Not applied to `stslv_amc_dev` or Neon. Applying it there needs approval, a backup
  first, and 0080/0081 applied first.

### `stslv-web/src/App.tsx`

Both branches edit this file. Expect a textual conflict near the admin routes. Keep
both sides:

- the three imports `MySuggestionsPage`, `SuggestionDetailPage`, `SuggestionReviewPage`;
- the `/admin/suggestions` route wrapped in `<RequireAdmin>` (placed just before
  `/notifications`);
- the `/suggestions` and `/suggestions/:id` routes with **no** permission wrapper
  (every signed-in user; the API enforces ownership).

The permissions branch changes other routes' `RequirePermission module=…` values; those
changes win wherever they touch other pages.

### `stslv-web/src/layout/navigation.ts`

Both branches edit this file. Keep the Administration entry:

```ts
{ label: 'Suggestions Review', path: '/admin/suggestions', module: 'USERS', adminOnly: true },
```

`adminOnly` items are exempt from the catalog test's "every nav page is in the catalog"
check (`tests/permission-catalog.test.ts` reads the `adminOnly: true` suffix), the same
as Audit Log. Keep it on one line in that exact form so the test's regex still matches.
`module: 'USERS'` only sets which section it sits in. Access is the Admin role
(`RequireAdmin` and the API's `adminOnly`). My Suggestions is not in the sidebar: it is
reached from the user menu, the light-bulb popup and the notification alert.

### `stslv-api/src/shared/permission-catalog.ts` (exists only on the permissions branch)

Add the two pages to `FIXED_ACCESS`, without new permission codes:

- under `adminOnly`: `{ label: "Suggestions Review", path: "/admin/suggestions" }`
- with the pages every signed-in user has (next to Notifications):
  `{ label: "My Suggestions and the suggestion popup", path: "/suggestions" }`

Then run `tests/permission-catalog.test.ts` and `src/test/page-permissions.test.tsx`.
This branch calls no `authorize()` and adds no module to `MODULES`, so nothing else in
the catalog should need changing.

### Other overlap to check

- `stslv-web/src/test/auth.test.tsx`: this branch adds `'Suggestions Review'` to the
  expected Administration items in "shows every section to an Admin". If the
  permissions branch changes that list, keep both.
- `stslv-web/src/lib/types.ts` and `stslv-api/src/shared/permissions.ts`: not changed here.
- `notifications.service.ts`: changed here only (two suggestion alerts).

### Combined verification after both merges

API and web full suites, web build, and a browser smoke test of submit → review →
respond → resolve → close as Admin and as a non-Admin user, on an isolated database
built from scratch (0080, 0081, then 0085).

### Later: a SUGGESTIONS permission module (only if approved)

If review is later opened to other roles, follow the "Permission requirements" steps
above: a new migration after 0085 widening `role_permissions_module_ck` and granting
ADMIN only, a catalog entry, and `authorize()` / a permission check in place of
`adminOnly` / `isReviewer()`.

## Known test-order issue (existing, not caused by this branch)

`stslv-api/tests/amc-service-status.test.ts` has this `afterAll`:

```ts
await pool.query("ALTER TABLE amc_visits DROP COLUMN IF EXISTS service_report_no");
```

It dates from when migration 0077 was staged and the test schema lacked the column.
Now that 0077 is in `migrations/`, the column is part of the schema, and dropping it
breaks every later test file in the same run that needs it. `accounts.test.ts` guards
its routes with `requireSchema(["amc_visits.service_report_no"])`, so they answer
503 `FEATURE_UNAVAILABLE` when it runs after Service Status:

- first full run on this branch: 18 of 19 `accounts.test.ts` tests failed with 503;
- `accounts.test.ts` alone: 19/19 passed; a second full run: all 65 files passed
  (different file order);
- the Roles & Permissions session reported the same 18/19 failure.

The Roles & Permissions branch (uncommitted, as seen on 2026-10-29) already replaces
that `afterAll` with `afterAll(closePool)`, which removes the drop. This branch leaves
the file unchanged, so the fix should arrive with that merge. During combined
integration testing, confirm it by running the full API suite several times and
checking that `accounts.test.ts` never answers 503.
