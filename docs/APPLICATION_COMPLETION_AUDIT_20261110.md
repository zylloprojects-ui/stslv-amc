# STS-ELV AMC — Application Completion Audit (2026-11-10)

Branch `feature/sts-elv-client-fixes-20261109` (worktree `STSLV-AMC-client-fixes`), from baseline 81788d0. Local only:
not pushed, not merged, not deployed. Backup & Restore, Hostinger and production were not touched (next phase).

## 1. Branding

Correct brand: **STS-ELV** (company display name), **STS-ELV AMC** (application title), `stselv` (new technical ids).

### Corrected
| Where | Before | After |
|---|---|---|
| Dashboard / AMC Management — AMC Portfolio Status panel description | "all statuses STSLV supports" | "all statuses STS-ELV AMC supports" |
| Storage check probe file (operator script, `src/scripts/storage-check.ts`) | "STSLV AMC storage check" | "STS-ELV AMC storage check" |
| Code comments (dashboard operations/readiness, contract expiry) | "STSLV" | "STS-ELV AMC" |
| Client-facing documents: handover (admin checklist, sign-off form, deployment checklist, infrastructure register, outstanding issues, completion report, release notes, training attendance, user access), docs index, API reference, technical handover | "STSLEV AMC" | "STS-ELV AMC" |

Already correct before this audit (verified):
- browser title (`STS-ELV AMC`), page titles (`… · STS-ELV AMC`), header, sidebar and login page;
- export headers (`SYSTEM_NAME = "STS-ELV AMC"`) for every Excel/PDF report;
- emails ("STS-ELV AMC account request");
- Help and User Guide;
- API health message.

The browser sweep (§3) checked every page title against "STS-ELV AMC".

### Retained legacy technical identifiers (deliberately unchanged)
| Identifier | Where | Why kept | Safe future rename |
|---|---|---|---|
| `admin@stslev.com` | dev Admin login (stslv_amc_dev) | An authentication identity, not a label. Renaming it is an identity migration. | **Client decision pending.** Add the new address as a second Super Admin, verify sign-in, then deactivate the old one (Users & Access). Never edit the email in place without approval. |
| `stslv-amc.token`, `stslv-amc.lastActivity`, `stslev.*` (theme, palette, sidebar, column and filter choices, cookie consent) | browser localStorage keys | Renaming signs everyone out and resets every saved preference. | Read the old key, write `stselv.*`, delete the old key once, in one release. |
| `/stslv-logo.png` | web public asset (favicon, header, loaders) | Cached by browsers and referenced by deployed HTML and CSP. | Add `/stselv-logo.png`, switch references, keep the old file one release. |
| `stslv-api`, `stslv-web`, `STSLV-AMC*` folders, Git repository and branches | filesystem / Git | Paths used by scripts, CI, Render and docs. | Only with a coordinated repository move. |
| `stslv_amc_dev`, `stslv_test`, `stslv_restore_*`, `stslv-db`, `stslv-docs` | database names, restore pattern, backup run ids | Operational identifiers; backups and restores depend on them. | Backup phase. |
| `[STSLV AMC …]` backup alert prefix, `stslv-amc-backup` application name | `src/ops/backup/*` | Backup & Restore is out of scope for this task (next phase). | Change in the Backup phase (one-line strings). |
| `deploy/hostinger/*` file names (`stslv-*.conf`, `stslv-amc.conf`) | VPS templates | Hostinger is out of scope; names are referenced by install steps. | Hostinger phase. |
| Migration file contents and history | `stslv-api/migrations` | Applied migrations are never edited. | — |
| `stslv`/`stslev`/`stselv` in password deny-lists | password policy (API and web) | Deliberate: blocks the brand as a password. | Keep. |
| Historical engineering logs (`docs/ACCOUNTS.md`, `docs/INTEGRATION_*`, `docs/integration/*`, session reports, `CLAUDE.md`) | docs | Historical records; not rewritten to change original wording. | — |

## 2. Functional work in this pass

1. **Cancelled Invoice Tracking record** (Invoice Acknowledgements, migration **0116**). The invoice shows a non-blocking
   warning. An Edit user can **Re-associate** it with a verified re-entered record (same client and number, allocated to
   every linked service, held by no other invoice), with a reason, audited. The invoice identity, services,
   acknowledgement and history are unchanged. Nothing is automatic; unverifiable records are listed with the reason.
   The database refuses any record change other than cancelled → active of the same client and number.
2. **Accounts acknowledgement indicator** (read only). "Ack: Acknowledged / Pending" under the Invoice No., only for
   users who also hold Invoice Acknowledgements: View. It is not in the Accounts export and never affects Paid / Unpaid
   or row colours.

## 3. Defects found and fixed

| # | Defect | Fix |
|---|---|---|
| D1 | Dark mode: Help related-topic chips and the current topic (`text-[#0b5d8f]`) were dark blue on dark (contrast 1.9:1) | Dark override in `index.css` (#7cc0f0), same convention as `#0f62a3` |
| D2 | Invoice Acknowledgements: a cancelled Invoice Tracking record's date was still shown as the invoice date | Date and value come only from an ISSUED record |
| D3 | Invoice Acknowledgements: row tints had no dark-mode override | Dark overrides added |
| D4 | Dashboard panel text carried the old brand | Corrected (§1) |

## 4. Module checklist

Evidence sources:
- **A**: API regression, 112 files.
- **W**: web regression, 59 files.
- **S**: browser sweep, as Super Admin, of every route at 1440 / 820 / 390 px in light and dark. Per page it checks:
  - loads, title, no error banners;
  - no uncaught or console errors, no page-wide horizontal overflow;
  - text contrast in the page, the Help panel and the Hide Columns dialog;
  - Help opens.
- **E**: workflow E2E (Invoice Acknowledgements, Accounts indicator, role checks).

"n/a" means the module does not support that action by design (no feature invented).

| Module | Load / data | Create | Edit | Delete / archive | Search / filter / sort / page | Columns | Export | Permissions | Audit | Mobile + dark | Help |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard = AMC Management (same component and API) | A W S | n/a | n/a | n/a | n/a | n/a | n/a | A W | n/a | S | S |
| Clients / Client 360 | A W S | A W | A W | deactivate A W | A W | W | A | A W | A | S | S |
| Sales Engineers / Engineer 360 | A W S | A W | A W | delete-if-unused A | A W | W | A | A W | A | S | S |
| System Types, Departments, Maintenance Frequencies | A W S | A W | A W | as designed A | A W | W | A | A W | A | S | S |
| AMC Contracts / Contract 360 / Renewal (V1, V2…) | A W S | A W | A W | cancel / Recycle Bin A W | A W | W | A | A W | A | S | S |
| Service Status (report upload/viewer, AMC Value) | A W S | n/a | A W | report remove before completion A | A W | W | A | A W | A | S | S |
| Master AMC Status | A W S | n/a | n/a | n/a | A W | W | A | A W | A | S | S |
| Monthly Calendar, AMC Schedule | A W S | n/a | A W | n/a | A W | W | A | A W | A | S | S |
| Invoice Tracking | A W S | A W | A W | cancel A W | A W | n/a | A | A W | A | S | S |
| Accounts (+ indicator) | A W S E | n/a | Invoice No. A W | n/a | A W | W | A | A W E | A | S | S |
| Invoice Acknowledgements | A W S E | A W E | replace / reconcile A W E | never (retention) | A W E | W | A | A W E | A | S E | S |
| Service Sales | A W S | n/a | A W | n/a | A W | W | A | A W | A | S | S |
| Reports | A W S | n/a | n/a | n/a | A W | n/a | A | A W | A | S | S |
| Users, Roles & Permissions, Login History | A W S | A W | A W | deactivate A W | A W | W | n/a | A W | A | S | S |
| Audit Log, Recycle Bin / Deletion Log | A W S | n/a | restore A | purge (Super Admin) A | A W | n/a | n/a | A W | A | S | S |
| Suggestions / Review | A W S | A W | A W | n/a | A W | n/a | n/a | A W | A | S | S |
| Settings, Security Center, Backup status (view only) | A W S | holidays A W | A W | holidays A | n/a | n/a | n/a | A W | A | S | S |
| Help / User Guide | W S | n/a | n/a | n/a | topic search W | n/a | n/a | role-aware W | n/a | S | — |

Oman time: `business-date-oman.test.ts` and the Dashboard/date tests pass. No stored timestamp or date-only value was
rewritten.

## 5. Limits of this verification

- Responsive checks are emulated viewports in headless Edge (1440, 820, 390 px). No physical device was used.
- The sweep runs as Super Admin. Role-specific UI and server refusals are covered by the API/web permission suites
  and by the E2E role checks (Finance Executive, Admin, Viewer, View-only custom role).

## 6. Client decisions still open

1. `admin@stslev.com` identity migration (see §1).
2. Renaming browser storage keys, logo asset and operational identifiers (rename plans above).
3. A re-entered Invoice Tracking record covering only some of an invoice's services: no rule yet (not offered).
4. Release approval for migrations 0110–0116 (with 0108/0109 from the integration branch).
