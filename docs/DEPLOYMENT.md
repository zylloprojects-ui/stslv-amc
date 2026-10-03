# Deployment (client-review environment)

How the STSLV AMC review copy is hosted and redeployed on free plans. No secret
value belongs in this file or anywhere else in the repository: secrets are
entered in the Neon, Render and Cloudflare dashboards only.

## Architecture

```
Browser
  ├── web application ── Cloudflare Pages (static files built from stslv-web)
  └── /api requests ──── Render free web service (stslv-api) ── Neon PostgreSQL 17
```

- The browser loads the web application from Cloudflare Pages and calls the API
  on Render directly. The API only accepts browser calls from the addresses
  listed in `CORS_ORIGIN`.
- The API reaches Neon over TLS with certificate verification.
- Cloudflare Pages and Render both deploy from the GitHub branch `develop`.

Local development is unchanged: the web application needs no `.env` (Vite
forwards `/api` to `http://localhost:3001`), `TRUST_PROXY` defaults to 0 and
`PGSSLMODE` stays unset. The hosted database is a separate copy; it has no
connection to the laptop databases or to the laptop-to-laptop synchronisation
in `D:\STSLV-DB-Backup\coworker-sync`.

## Configuration files

| File | Purpose |
|---|---|
| `render.yaml` | Render Blueprint for the API service |
| `stslv-api/.env.example` | Every API variable, with explanations |
| `stslv-web/.env.example` | Every web variable, with explanations |

Cloudflare Pages needs no file in the repository; its settings are entered in
the dashboard (below).

## 1. Neon (database)

Create one project:

| Setting | Value |
|---|---|
| PostgreSQL version | **17** (the local database is 17; a dump cannot be restored into an older version) |
| Region | The same area as the Render service (`render.yaml` uses Frankfurt; Neon: AWS Europe (Frankfurt)) |
| Database and role | Any names; note them for the Render variables |

From the project's connection details take the **direct** connection, not the
pooled one. The pooled host contains `-pooler` in its name. The migrations hold
a session lock while they run, which a connection pooler does not keep, so the
API must use the direct host.

Leave the database empty until the restore in step 2. Do not start the Render
service before the restore: it would create an empty schema first and the
restore would then collide with it.

## 2. Copy the local database to Neon

The hosted database starts as a one-time copy of `stslv_amc_dev`. Later changes
on either side do not reach the other.

Only the `public` schema is copied. The `stslv_test` schema (automated test
data) is left out, as are owners and privileges, because the local role names
do not exist on Neon.

Run from a terminal on the laptop. Passwords are typed at the prompt; do not
put them on the command line or in a file inside the repository. Write the dump
to a folder outside the repository and outside the synchronisation outbox.

```
REM 1. Dump (reads one consistent snapshot; the application may stay running)
"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" --host=localhost --username=postgres ^
  --dbname=stslv_amc_dev --schema=public --format=custom --no-owner --no-privileges ^
  --file="D:\Projects\STSLV-AMC-backups\neon\stslv_amc_dev_public_<date>.dump"

REM 2. Rehearse into a temporary local database, check it, then drop it
"C:\Program Files\PostgreSQL\17\bin\createdb.exe" --host=localhost --username=postgres stslv_amc_neon_rehearsal
"C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" --host=localhost --username=postgres ^
  --dbname=stslv_amc_neon_rehearsal --no-owner --no-privileges --single-transaction --exit-on-error ^
  "D:\Projects\STSLV-AMC-backups\neon\stslv_amc_dev_public_<date>.dump"
REM    compare row counts per table with stslv_amc_dev, then:
"C:\Program Files\PostgreSQL\17\bin\dropdb.exe" --host=localhost --username=postgres stslv_amc_neon_rehearsal

REM 3. Restore into Neon (direct host, TLS required)
"C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" ^
  --dbname="postgresql://<neon-user>@<neon-direct-host>/<neon-database>?sslmode=require" ^
  --no-owner --no-privileges --single-transaction --exit-on-error ^
  "D:\Projects\STSLV-AMC-backups\neon\stslv_amc_dev_public_<date>.dump"
```

`--single-transaction --exit-on-error` means a failed restore leaves Neon
empty rather than half-filled.

Check on Neon before going further:

- every table has the same number of rows as in `stslv_amc_dev`;
- `schema_migrations` lists all migrations, so the API has nothing to apply on
  its first start.

What the copy carries: users and their password hashes (existing passwords keep
working), roles and permissions, clients, contracts, visits, projects,
procurement, expenses, the historical import rows, the activity log and the
number sequences.

## 3. Render (API)

Create from `render.yaml` (Render dashboard → New → Blueprint → this
repository, branch `develop`).

| Item | Value |
|---|---|
| Service | `stslv-amc-api`, free plan, Node 24, root directory `stslv-api`, branch `develop` |
| Build | `npm ci --include=dev && npm run build` |
| Start | `node dist/db/migrate-cli.js && node dist/server.js` |
| Health check | `/api/health` |

### API environment variables

| Name | Source | Notes |
|---|---|---|
| `NODE_ENV` | `render.yaml` | `production` |
| `NODE_VERSION` | `render.yaml` | `24` |
| `PORT` | Render | Set automatically |
| `DB_HOST` | **Entered in the dashboard** | Neon **direct** host (no `-pooler`) |
| `DB_PORT` | `render.yaml` | `5432` |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | **Entered in the dashboard** | From the Neon project |
| `PGSSLMODE` | `render.yaml` | `require`: TLS with certificate verification |
| `JWT_SECRET` | Render, generated | Created once by Render. Changing it signs everyone out. |
| `JWT_EXPIRES_IN` | `render.yaml` | `8h` |
| `CORS_ORIGIN` | **Entered in the dashboard** | The Cloudflare Pages address, for example `https://stslv-amc.pages.dev`. Several addresses are separated by commas. No trailing slash. |
| `APP_URL` | **Entered in the dashboard** | The same Cloudflare Pages address. Used in password reset links. |
| `MAIL_TRANSPORT` | `render.yaml` | `none`: no email provider exists yet |
| `TRUST_PROXY` | `render.yaml` | `1`: see below |
| `PASSWORD_RESET_EXPIRES_MINUTES`, `PUBLIC_AUTH_RATE_LIMIT`, `BCRYPT_ROUNDS` | optional | Defaults apply when unset |
| `DB_SCHEMA` | leave unset | Used by the automated tests only |

The Cloudflare address is not known until step 4. Enter a temporary value such
as `https://example.invalid` for `CORS_ORIGIN` and `APP_URL`, then correct both
after step 4.

### Proxy trust

The sign-up and password-recovery routes are limited per network address.
Behind Render's load balancer the caller's address arrives in the
`X-Forwarded-For` header, so the API must be told how many proxies to trust
(`TRUST_PROXY`). With 0 every caller would share one address and one limit;
with too high a number a caller could invent an address. The value `1` must be
checked once on the live service (see "After the first deployment").

## 4. Cloudflare Pages (web application)

Create a Pages project connected to the GitHub repository.

| Setting | Value |
|---|---|
| Production branch | `develop` |
| Root directory | `stslv-web` |
| Framework preset | Vite (or None) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Build watch paths (include) | `stslv-web/*`, so API-only pushes do not rebuild the web application |

Environment variables (Production):

| Name | Value |
|---|---|
| `VITE_API_BASE_URL` | Address of the Render API, for example `https://stslv-amc-api.onrender.com`. No trailing slash, no `/api`. |
| `NODE_VERSION` | `24` |

`VITE_API_BASE_URL` is built into the web application, so changing it needs a
new deployment. It is an address, not a secret.

Page routing: Cloudflare Pages answers any address that is not a file with
`index.html` when the site has no top-level `404.html`. That is what makes
reloading or opening a deep link such as `/amc/contracts` work, so no routing
file is needed. Do not add `stslv-web/public/404.html`, and do not add a
`/* /index.html 200` rule to a `_redirects` file: Pages reports that rule as an
infinite loop and ignores it.

Preview deployments (other branches) get their own addresses, which are not in
`CORS_ORIGIN`, so they cannot call the API. They can be switched off in the
project's branch settings.

After the first build, put the Pages address into `CORS_ORIGIN` and `APP_URL`
on Render.

## Redeploys

- A push to `develop` that changes `stslv-api` redeploys the API on Render.
- A push to `develop` that changes `stslv-web` rebuilds the web application on
  Cloudflare Pages.

## Database migrations

Migrations run automatically each time the API starts on Render, before the
server accepts requests.

- Only migrations not yet recorded in `schema_migrations` are applied, in order.
- Each migration runs in its own transaction; a failure is rolled back.
- A failed migration stops the start. Render then keeps the previous version
  running.
- An applied migration whose file was edited afterwards stops the run. Changes
  are always made in a new, higher-numbered migration.
- A database lock prevents two runs at the same time (this is why the direct
  Neon host is required).
- No existing migration drops a table or column or deletes rows.

Before pushing a new migration to `develop`, review it for anything that
removes data.

## After the first deployment

- `https://<api>/api/health` and `/api/health/database` both report success.
- Sign in with an existing account, open the dashboard, reload a deep link.
- Compare a few totals (clients, projects, dashboard figures) with the local
  application.
- Proxy trust: make more than `PUBLIC_AUTH_RATE_LIMIT` password-recovery
  requests from one network and confirm they are refused, while a different
  network (for example a phone on mobile data) is still accepted. If the second
  network is refused too, `TRUST_PROXY` is too low.
- Push a small change to `stslv-web` and to `stslv-api` and confirm each
  redeploys on its own.

## Limits of the free plans

- The Render service sleeps after a period without requests; the next request
  then waits while it starts (roughly a minute). Neon also pauses when idle and
  adds a few seconds.
- Render's free plan has no shell, so the command-line scripts
  (`admin:create`, the historical import) cannot run there. Users are managed
  in the application by an administrator.
- No email provider: "forgot password" links are created but not delivered.
  An administrator resets passwords instead (see `AUTH_SIGNUP_AND_RECOVERY.md`).
- The rate limit is kept in the API's memory: it resets whenever the service
  sleeps or redeploys.
- Neon keeps only a short history on the free plan. The local dumps remain the
  real backup.
- The local database sorts text with a Windows locale; Neon uses its own
  default, so lists sorted by name may order upper and lower case differently.
- The Neon database is reachable from the internet, protected by its password
  and TLS. This is accepted for the review copy only; it is not the production
  arrangement (see CLAUDE.md, "Do not expose PostgreSQL directly to the public
  internet in production").
- No file uploads exist yet. When they are added they need object storage; the
  Render service's disk is erased on every deploy.
