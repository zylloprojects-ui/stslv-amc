# STSLV AMC — Coworker Setup

How to get a working local copy of STSLV AMC and start contributing. Branch rules are in [`GIT_WORKFLOW.md`](../GIT_WORKFLOW.md); what the foundation contains is in [`FOUNDATION.md`](FOUNDATION.md).

> **This repository is public.** Never commit `.env`, a password, a JWT secret, a database dump or a client spreadsheet. Each developer uses their **own** local database, credentials and Admin account. Nothing is shared except the code.

## Prerequisites

| Tool | Version used so far |
|---|---|
| Git | 2.x |
| Node.js | 24 (with npm 11) |
| PostgreSQL | 17, running locally |

## 1. Clone the repository

```
git clone https://github.com/zylloprojects-ui/stslv-amc.git
cd stslv-amc
```

## 2. Check out `develop`

```
git checkout develop
```

`main` holds stable, release-ready code only. All work starts from `develop`.

## 3. Install backend dependencies

```
cd stslv-api
npm install
```

## 4. Install frontend dependencies

```
cd ../stslv-web
npm install
```

## 5. Create your local database

Create an empty PostgreSQL database named `stslv_amc_dev`, using your own PostgreSQL user:

```
psql -U postgres -c "CREATE DATABASE stslv_amc_dev"
```

(`psql` asks for **your** PostgreSQL password. pgAdmin works equally well: Databases → Create → Database → `stslv_amc_dev`.)

Do not ask for, or restore, anyone else's database dump. The schema is created by the migrations in step 8.

## 6. Create your local `.env`

```
cd ../stslv-api
copy .env.example .env        # Windows
cp .env.example .env          # macOS / Linux
```

## 7. Enter your own settings in `.env`

Open `stslv-api/.env` and fill in:

| Setting | Value |
|---|---|
| `DB_USER` | Your local PostgreSQL user |
| `DB_PASSWORD` | Your local PostgreSQL password |
| `JWT_SECRET` | A new random value of at least 32 characters — generate your own, do not reuse anyone else's |

Generate a `JWT_SECRET`:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Leave the other values as they are unless your PostgreSQL uses a different host or port. `.env` is ignored by Git and must stay that way.

## 8. Run the migrations

```
npm run migrate:status     # shows what would be applied; changes nothing
npm run migrate            # creates the tables and seeds roles and permissions
```

## 9. Create your own first Admin account

```
npm run admin:create
```

It asks for an email, a full name and a password (at least 10 characters; not shown while typing). This account exists only in your local database.

## 10. Start the backend

```
npm run dev                # API on http://localhost:3001
```

Check: `http://localhost:3001/api/health` and `http://localhost:3001/api/health/database`.

## 11. Start the frontend

In a second terminal:

```
cd stslv-web
npm run dev                # Web on http://localhost:5173
```

## 12. Open the application

Open `http://localhost:5173` and sign in with the Admin account from step 9.

## 13. Create a feature branch before you change anything

```
git checkout develop
git pull
git checkout -b feature/<module-name>
```

Planned branch names: `feature/amc`, `feature/projects`, `feature/finance`, `feature/dashboard-reports`.

## 14. Push your feature branch

Before pushing, run the checks:

```
cd stslv-api && npm run typecheck && npm test && npm run build
cd ../stslv-web && npm run typecheck && npm test && npm run lint && npm run build
```

Then:

```
git status                 # read the list before you add anything
git add <the files you changed>
git commit -m "feat(amc): short description"
git push -u origin feature/<module-name>
```

Open a pull request on GitHub from your feature branch **into `develop`**.

## 15. Never push `.env` or passwords

- Run `git status` before every commit and read what is staged.
- `git check-ignore -v stslv-api/.env` must print a matching rule. If it prints nothing, stop.
- Do not write a real password, token or secret in code, tests, documentation, commit messages or pull request text.
- Do not commit database dumps (`*.dump`, `*.backup`, `*.sql.gz`), client spreadsheets (`*.xlsx`) or uploaded documents.
- If a secret is committed by mistake, tell the other developer immediately and **change that secret**. Deleting the file in a later commit does not remove it from the history of a public repository.

## 16. Never work directly on `main`

- Do not commit to `main`. Do not push to `main`.
- Do not commit feature work directly to `develop` either; it arrives through a pull request from a feature branch.
- Never force-push (`git push --force`) to `main` or `develop`.

## Notes

- **`docs/CLIENT_EXCEL_MAPPING.md` is not in the repository.** Other documents refer to it, but it quotes real client data, so it is ignored by Git and shared privately. Ask for a copy, save it as `docs/CLIENT_EXCEL_MAPPING.md`, and never commit it.
- **Tests and your database.** `npm test` in `stslv-api` uses the database from your `.env` but a separate PostgreSQL schema, `stslv_test`, which it drops and rebuilds on every run. Your development data in the `public` schema is not touched.
- **Migrations.** Never edit a migration file that already exists in `develop`; the runner detects the change and stops. Add a new numbered file instead. If two branches both add a migration with the same number, the second one to merge must renumber its file before merging.
