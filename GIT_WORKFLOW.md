# STSLV AMC — Git Workflow

One repository, rooted at the project folder. `stslv-api` and `stslv-web` are folders inside it, not separate repositories.

Remote: `https://github.com/zylloprojects-ui/stslv-amc.git` — **public**.

## Branches

| Branch | Purpose | Who pushes to it |
|---|---|---|
| `main` | Stable, release-ready code. | Nobody directly. Updated only from `develop` after verification. |
| `develop` | Integration branch. Everything that is finished and verified meets here. | Nobody directly. Updated by merging feature branches. |
| `feature/<module>` | Actual module development. | The developer who owns the module. |

Planned feature branches (created when the work starts, not before):

- `feature/amc`
- `feature/projects`
- `feature/finance`
- `feature/dashboard-reports`

## Flow

```
feature branch
    ↓   pull request, reviewed by the other developer
develop
    ↓   verification (checks below + manual test of the affected flow)
main
```

## Day-to-day

Start a piece of work:

```
git checkout develop
git pull
git checkout -b feature/<module>
```

Stay up to date while working:

```
git fetch origin
git merge origin/develop
```

Publish and integrate:

```
git push -u origin feature/<module>
```

Then open a pull request into `develop`.

## Rules

1. No direct commits or pushes to `main`.
2. No direct feature work on `develop`; it arrives by pull request from a feature branch.
3. No force-push to `main` or `develop`, and no rewriting of their history.
4. `develop` is merged into `main` only when both developers agree it is verified.
5. Never commit `.env`, passwords, secrets, database dumps, client spreadsheets, `node_modules` or build output. Check `git status` before every commit.
6. Never edit a migration that already exists in `develop`. Add a new numbered migration. If two branches use the same number, the later one renumbers before merging.

## Checks before a pull request

```
cd stslv-api && npm run typecheck && npm test && npm run build
cd ../stslv-web && npm run typecheck && npm test && npm run lint && npm run build
```

## Not configured yet

- Branch protection on GitHub (rules 1–3 are an agreement until it is switched on).
- Continuous integration.
- Deployment of any kind.

First-time setup of a local copy: [`docs/COWORKER_SETUP.md`](docs/COWORKER_SETUP.md).
