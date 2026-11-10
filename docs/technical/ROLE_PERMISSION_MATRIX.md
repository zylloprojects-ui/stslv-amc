# Role Permission Matrix

Source: `stslv-api/src/shared/permission-catalog.ts` (what each permission does) and `stslv-api/src/shared/role-model.ts` `defaultGrants()` (the grants each built-in role **starts** with, as seeded by migrations 0087, 0090 and 0092), at commit `c6d8d19`.

> **These are starting grants, not necessarily the live grants.** Super Admin can change any role's permissions in Administration → Roles & Permissions (Admin only custom roles, within its own permissions), and the saved `role_permissions` rows decide access. Before handover, record the live grants of the production database (Roles & Permissions page, or a read-only query of `role_permissions`) in `docs/handover/USER_ACCESS_HANDOVER.md`.

Legend: **V** View · **C** Create · **E** Edit · **D** Delete · **A** Approve · **X** Export · **R** Data read (the module's data inside another page, without its own pages) · — none · *n/a* the action does not exist for the module.

## 1. Starting grants

| Module (section) | Actions that exist | Super Admin | Admin | Finance Exec. | Master Data Exec. | AMC Operations Exec. | Viewer |
|---|---|---|---|---|---|---|---|
| Dashboard | V | all | V | V | V | V | V |
| Clients (Master Data) | V C E D X R | all | V C E D X | — | V C E D X | R | V |
| Sales Engineers | V C E X | all | V C E X | — | V C E X | — | V |
| System Types | V C E D X | all | V C E D X | — | V C E D X | — | V |
| Maintenance Frequencies | V C E X | all | V C E X | — | V C E X | — | V |
| Departments | V C E X | all | V C E X | — | V C E X | — | V |
| AMC Contracts (AMC Ops) | V C E D X | all | V C E D X | — | — | V C E D X | V |
| AMC Renewal | V C X | all | V C X | — | — | V C X | V |
| AMC Schedule | V E X R | all | V E X | R | — | V E X | V |
| Monthly Calendar | V X | all | V X | — | — | V X | V |
| Service Status | V X | all | V X | — | — | V X | V |
| AMC Execution | V E A | all | V E A | — | — | V E A | V |
| Master AMC Status | V X | all | V X | — | — | V X | V |
| Invoice Tracking (Finance) | V C E X R | all | V C E X | V C E X | — | R | V |
| Accounts | V X | all | V X | V X | — | — | V |
| Invoice Acknowledgements (Finance, 0112/0113) | V C E X | all | — | — | — | — | — |
| Service Sales | V E X | all | V E X | — | — | V E X | V |
| Suggestions | V C | all | V C | V C | V C | V C | V C |
| Reports (Reporting) | V X | all | — | — | — | — | — |
| Users (Administration) | V C E A | all | V C E A | never | never | never | never |
| Suggestions Review | V E | all | V E | — | — | — | — |
| Settings | V C E D | all | V C E D | — | — | — | — |

Notes:

- **Reports** came after the role migrations; no built-in role except Super Admin starts with it. Grant it deliberately. Each report also needs View of its source module (Export for its export): AMC Contracts (AMC Contract Summary, Contract Value Review), AMC Renewal (AMC Renewal, Expiry & Renewal Due, Renewal History), Accounts (Billing Schedule, Completed Services, Pending Services, Monthly Maintenance, Accounts / Paid and Unpaid Summary, Client-wise, Sales Engineer-wise). Enforced by the API (P2, 2026-11-09).
- **Invoice Acknowledgements** (2026-11-10) starts with Super Admin only (migration 0113). Proposed grants awaiting approval are in `docs/INVOICE_ACKNOWLEDGEMENTS.md` §6. Amounts on the page and in its export also need Accounts: View.
- **AMC Execution: Approve** has no effect at present (completed services are locked and cannot be reopened). Retiring it is an open decision (Outstanding Issues OI-08).
- **Service Sales** is listed under Finance but starts with AMC Operations Executive, as originally seeded; moving a module in the catalog never changes starting grants.
- **Users** permissions can never be given to the four operational roles (Finance, Master Data, AMC Operations, Viewer).
- **Retired modules** (Projects, Procurement, Expenses, Historical Data) keep any existing grants, but no new grant is accepted. Their pages were removed from the web application.
- Legacy roles Accountant, Procurement, Execution and Invoicing are kept with their grants but **inactive** (migration 0088).

## 2. Dependencies

- Every action needs **View** of the same module.
- **AMC Contracts: Delete** (cancel a contract) also needs **Edit**.
- **Data read** stands alone.
- Saving a role with a missing dependency is refused: "X also needs Y. Grant both, or neither."

## 3. Fixed access (not configurable)

| Who | What |
|---|---|
| Super Admin only | Change built-in roles and their permissions (never Super Admin's own); give any role Users & Access permissions; manage Super Admin and Admin accounts and assign those roles; use the Recycle Bin (move in, restore, delete permanently); run and download backups; move contracts, clients, system types and sales engineers to the Recycle Bin |
| Super Admin and Admin | Custom roles: add, rename, deactivate, reactivate, delete and set permissions — Admin only with Users & Access Edit, only for custom roles whose every permission Admin holds, never its own role, never adding Users & Access (removing is allowed); assign custom roles within one's own permissions (approved 2026-11-09). Audit Log, Deletion History, Security Center (including Active sessions), Backup & Restore status, temporary passwords, user and login-history exports |
| No other role | Manages roles, whatever Users & Access permissions it holds |
| Every signed-in user | Notifications, My account, Help |

## 4. Cross-module page requirements

| Page | Needs |
|---|---|
| Contract form (client list) | AMC Contracts: Create or Edit (client names via Clients data read or the contract permission) |
| Schedule / Calendar client filter | Clients: View or Data read |
| Contract detail and visit details — invoice numbers | Invoice Tracking: View or Data read |
| Invoice Tracking — visits waiting for an invoice | AMC Schedule: View or Data read |
| Manual Invoice No. (Accounts, Schedule, Contract 360) | Invoice Tracking: Edit |
| Completing a service, uploading a Service Report | AMC Execution: Edit |
| Invoice Acknowledgements — service and invoice values | Accounts: View |
| Renewal: Approve / Cancel | AMC Contracts: Edit / Edit + Delete |
| Dashboard figures | Dashboard: View plus View on each figure's module |

The API enforces every rule above on each request; the web application only hides what a user cannot use.
