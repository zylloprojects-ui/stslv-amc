# STSLV AMC — Application Foundation

| | |
|---|---|
| Status | Implemented and verified on 2026-10-01 |
| Scope | Shared foundation only: migrations, authentication, role permissions, Client Master, Users & Access, application shell. No AMC, project, procurement, expense, invoice or report functionality exists yet. |

This document records what the foundation is and why it was built this way. Business design remains in `PHASE1_SYSTEM_DESIGN.md`; spreadsheet analysis remains in `CLIENT_EXCEL_MAPPING.md`.

## 1. Running the application locally

Two terminals:

```
cd D:\Projects\STSLV-AMC\stslv-api
npm run dev            # API on http://localhost:3001

cd D:\Projects\STSLV-AMC\stslv-web
npm run dev            # Web on http://localhost:5173
```

Open `http://localhost:5173`. The web dev server forwards `/api/*` to the API, so the browser only ever talks to one origin.

First-time setup of a database:

```
cd stslv-api
npm run migrate:status   # shows what would be applied; changes nothing
npm run migrate          # applies pending migrations
npm run admin:create     # creates the first Admin (interactive, password hidden)
```

`stslv-api/.env` must contain the database settings plus `JWT_SECRET` (see `.env.example`). `.env` is never committed.

## 2. Migrations

### Approach

Plain, numbered SQL files in `stslv-api/migrations/`, applied by a small runner (`src/db/migrate.ts`, about 190 lines) that uses the `pg` driver the API already depends on.

### Why this and not an ORM or migration framework

- **Reviewable.** `CLAUDE.md` requires migrations to be reviewable and ordered. Each migration is the exact SQL that runs: there is no generated SQL and no schema-diffing step to trust.
- **No new dependency.** Drizzle ORM / drizzle-kit and similar tools were considered. They would add an ORM and a code generator to a project that so far needs neither; the API uses straightforward parameterised SQL.
- **The schema relies on PostgreSQL features** (check constraints, partial and expression unique indexes, triggers, generated columns later) that are clearest written directly in SQL.
- **Replaceable.** If the project later adopts a migration tool, the SQL files move across unchanged.

### Guarantees

| Behaviour | How |
|---|---|
| Ordered | Files are named `NNNN_description.sql` and applied in number order. |
| Never re-run | Applied versions are recorded in `schema_migrations`. A second run reports "Nothing to apply". |
| Atomic | Each migration runs in its own transaction, together with its tracking row. A failure rolls the whole migration back. |
| Tamper-evident | A SHA-256 checksum of each file is stored. If an applied file is later edited, the runner stops with an error. Fix mistakes with a new migration. |
| No out-of-order inserts | A new file numbered below the last applied one is refused. |
| No concurrent runs | A PostgreSQL advisory lock serialises runs. |

### Current migrations

| File | Creates |
|---|---|
| `0001_access_control.sql` | `set_updated_at()` trigger function; `roles`, `users`, `user_roles`, `role_permissions` |
| `0002_activity_logs.sql` | `activity_logs` |
| `0003_clients.sql` | `clients` |
| `0004_seed_roles_and_permissions.sql` | The five roles and the starting permission matrix (idempotent) |

`app_settings` was deliberately **not** created: nothing in the foundation needs a stored setting. It should be added by the module that first needs one (for example the VAT rate, with Projects).

No table holds money. Money-bearing tables must use three decimal places (see `CLIENT_EXCEL_MAPPING.md`, headline finding 1).

## 3. Authentication

- Login is by email and password (`POST /api/auth/login`).
- Passwords are hashed with bcrypt (`bcryptjs`, cost 12). Only the hash is stored. No API response contains a password or hash. Passwords must be 10 characters or more and at most 72 bytes (the bcrypt limit).
- A successful login returns a signed JWT (HS256) valid for `JWT_EXPIRES_IN` (default 8 hours). The secret comes from `JWT_SECRET` in `.env`; the API refuses to start without one of at least 32 characters.
- The token carries only the user id. On **every** request the API reloads the user, their roles and their permissions from PostgreSQL. Deactivating a user or changing a role therefore takes effect immediately, without waiting for a token to expire.
- Changing or resetting a password invalidates every token issued before the change.
- A failed login returns the same message whether the email exists, the password is wrong or the account is inactive.
- The web application keeps the token in the browser's `localStorage`. This is the usual approach for a bearer-token API; it should be reviewed, together with login rate limiting and HTTPS, as part of the production security review.

## 4. Permissions (database-backed RBAC)

```
users >──< roles            (user_roles)
            └──< role_permissions   one row = one role may do one ACTION on one MODULE
```

- Modules: `DASHBOARD`, `CLIENTS`, `AMC_CONTRACTS`, `AMC_SCHEDULE`, `AMC_EXECUTION`, `PROJECTS`, `PROCUREMENT`, `EXPENSES`, `INVOICES`, `REPORTS`, `USERS`, `SETTINGS`.
- Actions: `VIEW`, `CREATE`, `EDIT`, `DELETE`, `APPROVE`, `EXPORT`.
- The list of module and action **codes** lives in code (`src/shared/permissions.ts`) and in check constraints, because code has to name the permission it checks. **Which role holds which permission is data** in `role_permissions` and is edited in Users & Access.
- A user's permissions are the union of the permissions of their active roles.
- Every API route declares what it needs: `authorize("CLIENTS", "EDIT")`. The web application hides what a user cannot use, but that is a convenience; the API check is the protection.

### Safeguards

| Rule | Reason |
|---|---|
| Nobody can assign a role that grants a permission they do not hold themselves. | Stops a user with user-management access from creating a more powerful account. |
| Nobody can grant or revoke a role permission they do not hold themselves. | Same, for editing a role. |
| Nobody can manage (rename, deactivate, reset the password of, change the roles of) a user who holds permissions they do not. | Stops account takeover by password reset. |
| The Admin role's permissions cannot be changed. | Prevents locking everyone out. |
| A user cannot deactivate themselves or change their own roles. | Prevents self-lockout and self-promotion. |
| The last active Admin cannot be deactivated or lose the Admin role. | There is always someone who can administer the system. |

### The seeded matrix is provisional

Admin has everything. The matrix for Accountant, Procurement, Execution and Invoicing follows the draft in `PHASE1_SYSTEM_DESIGN.md` section 12.3 and **has not been approved by the business** (open question Q12). It grants no `APPROVE`, `DELETE` or `EXPORT` to any non-admin role, because no approval or export rule has been confirmed. An Admin can change it at any time without a code change.

## 5. Client Master

`GET /api/clients` (search, status filter, pagination), `GET /api/clients/:id`, `POST /api/clients`, `PATCH /api/clients/:id`, `POST /api/clients/:id/deactivate`, `POST /api/clients/:id/reactivate`.

- Only the name is required. There is no client code.
- Clients are never deleted; they are deactivated. Deactivation and reactivation are governed by the `CLIENTS:DELETE` permission.
- The same name with different letter case or outer spaces is rejected as a duplicate. Similar spellings (`HOLIDAY INN` / `HOLIDAYINN`) are **not** merged or matched; deciding which legacy names are the same client is a migration decision for the business (see `CLIENT_EXCEL_MAPPING.md` section 9).
- Every create, update (with the changed fields), deactivation and reactivation is written to `activity_logs` in the same transaction as the change.

## 6. API conventions

- Success: `{ "success": true, "data": ... }`
- Failure: `{ "success": false, "error": { "code", "message", "details"? } }` where `details` is a list of `{ field, message }` for validation problems.
- Codes in use: `VALIDATION_ERROR` (400), `INVALID_JSON` (400), `INVALID_CREDENTIALS` (401), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `INTERNAL_ERROR` (500).
- Unexpected errors are logged on the server; the response never contains a stack trace or SQL.
- Ids are PostgreSQL `bigint` and travel as strings.
- The two original health routes (`/api/health`, `/api/health/database`) keep their original response shape.

Code layout: `src/modules/<module>/` holds each module's routes (HTTP and validation), service (business rules and SQL) and schemas; `src/middleware/` holds authentication and authorisation; `src/shared/` holds errors, validation helpers, the transaction helper and the activity log.

## 7. Tests

| Command | What it covers |
|---|---|
| `cd stslv-api && npm test` | 73 tests against a real PostgreSQL: migrations and constraints, authentication, permission enforcement, privilege-escalation safeguards, client and user management. |
| `cd stslv-web && npm test` | 36 tests of the web application: login, protected routes, permission-based navigation, dashboard, clients, users and roles. |

The API tests use the database named in `.env` but a **separate PostgreSQL schema, `stslv_test`**, which they drop and rebuild from the migration files at the start of every run. Development data in the `public` schema is never read or changed by the tests. The optional `DB_SCHEMA` setting exists for this purpose.

## 8. Known limits of the foundation

- No login rate limiting or account lockout yet.
- No "forgot password" flow. An administrator resets a user's password in Users & Access; `npm run admin:create` can create a further Admin if every Admin is locked out.
- Roles cannot be created or renamed in the application; only their permissions and membership can be changed.
- The activity log is written but has no screen yet.
- CORS is restricted to the origins in `CORS_ORIGIN`; HTTPS, security headers and the token storage choice must be reviewed before production.
