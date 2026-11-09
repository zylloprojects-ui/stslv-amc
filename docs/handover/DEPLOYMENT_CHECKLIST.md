# Deployment Checklist — STSLEV AMC

Use for every release to production. Tick each line only when it has been done and the evidence is recorded. **Every push to `develop` deploys** (Cloudflare Pages and Render build from it), so the push itself is the deployment and needs explicit approval from the project owner.

Release: ____________ Commit: ____________ Date: ____________ Release lead: ____________

## A. Before the release (no production change yet)

| # | Check | Evidence / notes | Done |
|---|---|---|---|
| A1 | Release scope agreed; release notes drafted (`docs/handover/RELEASE_NOTES.md`) | | ☐ |
| A2 | All branches for this release integrated into one candidate commit; no unrelated work included | | ☐ |
| A3 | API: `npm run typecheck`, `npm test` (on an isolated test database, never `stslv_amc_dev` or Neon), `npm run build` pass | | ☐ |
| A4 | Web: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` pass | | ☐ |
| A5 | New migrations listed; each reviewed for anything that drops, deletes or rewrites data; numbers continue after the last applied one | | ☐ |
| A6 | No applied migration file was edited (runner checks checksums and refuses) | | ☐ |
| A7 | Migrations rehearsed on a restored copy of the latest production dump; row counts and money totals compared before/after | | ☐ |
| A8 | UAT tests for changed modules executed and recorded (`docs/uat/UAT_CHECKLIST.md`) | | ☐ |
| A9 | New environment variables identified (names only) and entered in the hosting dashboard **before** the push | | ☐ |
| A10 | `.env`, dumps, client spreadsheets and secrets are not in the commit (`git status`, `git diff --stat`) | | ☐ |

## B. Backup immediately before the push

| # | Check | Evidence / notes | Done |
|---|---|---|---|
| B1 | Fresh `pg_dump` (custom format) of the production database to a folder outside the repository | File name: | ☐ |
| B2 | SHA-256 of the dump recorded | | ☐ |
| B3 | Dump restore-tested into a local scratch database; counts match | | ☐ |
| B4 | Rollback plan written: previous commit + this dump; note that an older API refuses a database with newer migrations | | ☐ |
| B5 | Read-only pre-check of production: applied migrations list equals the expected list | | ☐ |

## C. Release

| # | Check | Evidence / notes | Done |
|---|---|---|---|
| C1 | Project owner approval recorded (who, when) | | ☐ |
| C2 | Push to `develop` as a fast-forward; no force push | | ☐ |
| C3 | Render build and start succeed; migrations applied at start (Render logs) | | ☐ |
| C4 | Cloudflare Pages build succeeds; new bundle served | | ☐ |

## D. After the release

| # | Check | Evidence / notes | Done |
|---|---|---|---|
| D1 | `GET /api/health` and `/api/health/database` succeed | | ☐ |
| D2 | Security Center: all database updates applied, latest migration as expected; document storage OK | | ☐ |
| D3 | Sign in; open Dashboard; reload a deep link (e.g. `/amc/contracts`) | | ☐ |
| D4 | Read-only post-check of production: only the expected tables/columns/rows were added; existing row counts and money totals unchanged | | ☐ |
| D5 | Smoke test of the changed modules (read-only unless a write test is approved) | | ☐ |
| D6 | Help button opens and shows the page's topic | | ☐ |
| D7 | Release notes finalised; Outstanding Issues Register updated | | ☐ |

## E. Rollback (only if needed, with owner approval)

1. Stop further pushes to `develop`.
2. If the release contained **no** migration: redeploy the previous commit.
3. If it **did**: restore the pre-release dump into the production database during a planned stop, then redeploy the previous commit. Data entered after the push is lost; document storage objects uploaded after the push become orphaned.
4. Record the rollback in the Outstanding Issues Register.

## Hostinger VPS (future)

Not applicable until the VPS is provisioned. When it is, add the VPS-specific steps (service restart, reverse proxy reload, firewall check) from `docs/technical/TECHNICAL_HANDOVER.md` §9 to sections C and D.
