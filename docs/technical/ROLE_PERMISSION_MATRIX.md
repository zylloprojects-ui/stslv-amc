# Role Permission Matrix

Source: `stslv-api/src/shared/permission-catalog.ts` (what each permission does) and `stslv-api/src/shared/role-model.ts` `defaultGrants()` (the grants each built-in role **starts** with, as seeded by migrations 0087, 0090 and 0092), at commit `c6d8d19`.

> **Role names (2026-11-11, migration 0117).** Display names only; codes, grants and assignments are unchanged:
>
> | Code | Old name | Name shown now |
> |---|---|---|
> | `ADMIN` | Super Admin | Super Admin (unchanged) |
> | `ADMINISTRATOR` | Admin | **Service Dept** |
> | `FINANCE_EXECUTIVE` | Finance Executive | **Accounts** |
> | `MASTER_DATA_EXECUTIVE` | Master Data Executive | **AMC Sales** |
> | `AMC_OPERATIONS_EXECUTIVE`, `VIEWER` | — | unchanged |
>
> The names are written down once, in `stslv-api/src/shared/role-names.ts` and `stslv-web/src/auth/roleNames.ts` (a test keeps them equal and equal to the database). Section titles such as "Finance" in the permission catalog are module groups, not roles, and are unchanged.

> **AMC Renewal role (2026-11-19, migration 0120).** A seventh built-in role, code `AMC_RENEWAL_EXECUTIVE`, shown as **AMC Renewal**. It is an operational role like Accounts and AMC Sales, and it **starts with no permissions** (every cell of its column below would be "—"). Super Admin grants it any supported permission in Roles & Permissions; Service Dept may also, within its own permissions (CR-031 rule); it can never hold Users. Not to be confused with the *AMC Renewal* permission module (code `AMC_RENEWAL`), which is a page.

> **These are starting grants, not necessarily the live grants.** Super Admin can change any role's permissions in Administration → Roles & Permissions (Service Dept only custom roles, within its own permissions), and the saved `role_permissions` rows decide access. Before handover, record the live grants of the production database (Roles & Permissions page, or a read-only query of `role_permissions`) in `docs/handover/USER_ACCESS_HANDOVER.md`.

Legend: **V** View · **C** Create · **E** Edit · **D** Delete · **A** Approve · **X** Export · **R** Data read (the module's data inside another page, without its own pages) · — none · *n/a* the action does not exist for the module.

## 1. Starting grants

| Module (section) | Actions that exist | Super Admin | Service Dept | Accounts (role) | AMC Sales | AMC Operations Exec. | Viewer |
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
| Invoice Acknowledgements (Finance, 0112–0115) | V C E X | all | V C E X | V C X | — | — | — |
| Service Sales | V E X | all | V E X | — | — | V E X | V |
| Suggestions | V C | all | V C | V C | V C | V C | V C |
| Reports (Reporting) | V X | all | — | — | — | — | — |
| Users (Administration) | V C E A | all | V C E A | never | never | never | never |
| Suggestions Review | V E | all | V E | — | — | — | — |
| Settings | V C E D | all | V C E D | — | — | — | — |

Notes:

- **Reports** came after the role migrations; no built-in role except Super Admin starts with it. Grant it deliberately. Each report also needs View of its source module (Export for its export): AMC Contracts (AMC Contract Summary, Contract Value Review), AMC Renewal (AMC Renewal, Expiry & Renewal Due, Renewal History), Accounts (Billing Schedule, Completed Services, Pending Services, Monthly Maintenance, Accounts / Paid and Unpaid Summary, Client-wise, Sales Engineer-wise). Enforced by the API (P2, 2026-11-09).
- **Invoice Acknowledgements** (2026-11-10, approved defaults): Super Admin all (0113); Service Dept View, Create, Edit, Export and Accounts (role) View, Create, Export (0115, insert-only, never overwrites a customised role); Viewer and other roles none. Create = attach and confirm; Edit = reasoned replacement and reconciliation. Amounts on the page and in its export also need Accounts: View.
- **AMC Execution: Approve** has no effect at present (completed services are locked and cannot be reopened). Retiring it is an open decision (Outstanding Issues OI-08).
- **Service Sales** is listed under Finance but starts with AMC Operations Executive, as originally seeded; moving a module in the catalog never changes starting grants.
- **Users** permissions can never be given to the five operational roles (Accounts, AMC Sales, AMC Operations Executive, AMC Renewal, Viewer).
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
| Super Admin only | Change built-in roles and their permissions (never Super Admin's own); give any role Users & Access permissions; manage Super Admin and Service Dept accounts and assign those roles; use the Recycle Bin (move in, restore, delete permanently); run and download backups; move contracts, clients, system types and sales engineers to the Recycle Bin |
| Super Admin and Service Dept | Custom roles: add, rename, deactivate, reactivate, delete and set permissions — Service Dept only with Users & Access Edit, only for custom roles whose every permission Service Dept holds, never its own role, never adding Users & Access (removing is allowed); assign custom roles within one's own permissions (approved 2026-11-09). Audit Log, Deletion History, Security Center (including Active sessions), Backup & Restore status, temporary passwords, user and login-history exports |
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

## 5. Page visibility (role visibility, migration 0123, 2026-11-21)

Within a page a role may open, Roles & Permissions can hide single items from that role. It only takes away; it never opens a page. The catalogue of hideable items is `stslv-api/src/shared/visibility-catalog.ts`; nothing is hidden by default.

| Page | Items | Enforced by the API |
|---|---|---|
| Dashboard (`DASHBOARD:VIEW`) | Rows: AMC Portfolio, Current Month, Current Year (YTD), Overall Till Date, Overall Contract. Panels: AMC Maintenance Calendar, Upcoming Service Workload, Payment Trend | `/api/dashboard/operations` leaves out the hidden row's figures and the hidden panel's data |
| Master AMC Status (`MASTER_AMC_STATUS:VIEW`) | Columns: Client, System, Frequency, Service, Value, Service Engineer, Invoice No., Quote No., Invoice Acknowledged, Sales Engineer | `/api/amc/master-status` blanks them and drops value totals; `/export` leaves them out |
| Service Status (`SERVICE_STATUS:VIEW`) | Read-only columns: Client, System, Frequency, Service, AMC Value, Service Value, Invoice Acknowledgement, Sales Engineer (columns edited there are not hideable) | `/api/amc/service-status` (list and one service) blanks them and their totals; `/export` leaves them out |
| AMC Management (`AMC_CONTRACTS:VIEW`) | KPI groups: Contract, Schedule, Invoice. Panels: Recent AMC Contracts, Expiry & Renewal | `/api/amc/management/summary` leaves them out |
| Invoice Acknowledgements (`INVOICE_ACKNOWLEDGEMENTS:VIEW`) | Columns: Client, AMC Contract, Invoice Date, Invoice Value, Service Value, Acknowledged On/By, Uploaded By | Router-wide response filter (`invoice-acknowledgements.visibility.ts`): list, one invoice, linked services and value totals; `/export` leaves them out |
| Service Sales (`SERVICES_SALES:VIEW`) | Columns: Client, System, Frequency, Service, Service Report No., Service Report, Service Engineer, Sales Engineer, AMC Value, Service Value (Quote No. is not hideable) | Router-wide filter; `/:id/report` answers 403 when Service Report is hidden; `/export` leaves them out |
| AMC Renewals (`AMC_RENEWAL:VIEW`) | Columns: Client, System, Frequency, Services, Contract Status, AMC Value, Remarks. Panel: Renewal History | `/amc/renewals/queue` blanks them; `/queue/export` leaves them out; `/amc/reports/renewals` (+ export) answer 403 when the panel is hidden |
| Reports (`REPORTS:VIEW`) | Each report (`reports.report.<id>`) | `/api/reports` leaves it out; `/:type` and `/:type/export` answer 403 |
| Accounts › Invoices (`ACCOUNTS:VIEW`) | Columns: Client, System, Frequency, Service, Service Report No., Service Report, AMC Contract, Sales Engineer, Service Engineer, AMC Value, Service Value, Invoice No., Zoho Invoice Value. Actions: Download AMC contract, View and download Service Report | `/api/accounts` blanks hidden columns and drops totals built from them; `/export` leaves them out; `/:id/contract-document` and `/:id/report` answer 403 when hidden |
| Invoice Tracking (`INVOICES:VIEW`) | Columns: Total, Zoho Reference, Notes, Recorded By | Router-wide filter (`invoices.visibility.ts`): list, one invoice, `totals.totalAmount`, `/summary` `issued.totalAmount`; `/export` (also Recent Invoices) leaves them out; create/update ignore hidden fields |
| AMC Contracts (`AMC_CONTRACTS:VIEW`) | Columns: Cost per Visit (`defaultVisitAmount`), Customer PO Value, Description, Notes | Filter on every `/api/amc/contracts*` answer (`contracts.visibility.ts`), history changes included; `/contracts/export` and the client's contracts export leave them out; create/update/renew ignore hidden fields (a renewal copies the source's Cost per Visit and Description) |
| Clients (`CLIENTS:VIEW`) | Columns: Contact Person, Email, Phone, Address, VAT Number, Remarks (never id, code or name) | Router-wide filter (`clients.visibility.ts`), history included; `/export` leaves them out; create/update ignore hidden fields |
| Sales Engineers, System Types, Maintenance Frequencies, Departments (each list's `:VIEW`) | Engineers: Employee No., Email, Phone, Department, Linked User, Notes. System Types: Description, Sort Order. Frequencies: Sort Order. Departments: Description | Filter mounted in `app.ts` ahead of every router of the list (`masters.visibility.ts`), `/options` included; each `/export` leaves them out; create/update ignore hidden fields |

**Step B rule ("Lock it", owner 2026-11-21).** On the last four rows' pages the edit forms save every field back, so a hidden field is shown locked ("Hidden for your role") and left out of the save, and the service layer drops every field hidden from the saving user before reading the input (`shared/visibility-fields.ts` `keepHiddenFields`). The stored value is therefore always kept, whatever the request sends. Not hideable there: row-identifying fields, fields required to add a record (Invoice Tracking: number, client, date, amounts, VAT, allocations; AMC Contracts: reference, client, system, Sales Engineer, validity, frequency, AMC Value / Year, Final Credit; Clients: type; Frequencies: name, code, prefix, rule), the Billing Basis and Custom Billing Value (they decide service amounts; the custom value is required with its basis), and counts that an action or warning works from.

- A user with several roles sees an item when any of their active roles that holds the page's permission shows it. A role without that permission has no say.
- Super Admin's role never hides anything. The same people who may change a role's permissions may change its visibility; Admin only for items of pages Admin may open.
