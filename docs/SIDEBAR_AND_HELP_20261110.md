# Sidebar reorganisation, Help icon and Help audit — 2026-11-10

Local alpha only. No routes, API endpoints, tables, permissions or migrations changed.

## Sidebar (client-approved hierarchy)

```
STS-ELV                     (brand; subtitle "AMC ERP System")
Dashboard                   /dashboard
Master AMC Status           /amc/master-status
AMC Contracts               /amc/contracts
AMC Execution ▸
    Service Status          /amc/service-status
    Monthly Calendar        /amc/calendar
    AMC Schedule            /amc/schedule            (kept; not in the client picture)
Accounts ▸
    Invoices                /finance/accounts        (the Accounts page)
    Invoice Ack             /finance/invoice-acknowledgements
    Invoice Tracking        /invoices                (kept; not in the client picture)
AMC Sales ▸
    Service Sales           /amc/service-sales
    AMC Renewals            /amc/renewal             (the AMC Renewal page)
Master Data Center ▸        /master-data (hub) + Clients, Sales Engineers, System Types, Maintenance Frequencies, Departments
Reports                     /reports
Administration ▸            Users & Access, Roles & Permissions, Login History, Audit Log, Recycle Bin, Suggestions Review
Footer: Dark/Light Mode · Settings (Security Center, Backup & Restore inside) · Sign Out
Account menu: My Profile, Help & User Guide, My Suggestions, Sign out
```

- **AMC Management** is no longer listed. *Update (owner decision, later on 2026-11-10):* it is its own page again
  (see DASHBOARD_AMC_MANAGEMENT_SPLIT_20261110.md) and stays out of the sidebar; `/amc/management` opens with
  *AMC Contracts: View*, and its Help topic is tied to that permission instead of a sidebar entry.
- Schedule Engine is a Help topic (no page: generation runs on save / Activate / Regenerate). Security Center and Backup &
  Restore stay in Settings (`settingsArea`), as before. Nothing previously reachable was hidden.
- Visibility is unchanged: each item still needs View on its module (`navItemVisible`); a group appears only when one of
  its items does. The server enforces every permission.
- Roles & Permissions keeps the permission catalog groups (AMC Operations, Finance, …); only the sidebar moved.

Source: `stslv-web/src/layout/navigation.ts`, `stslv-web/src/layout/Sidebar.tsx` (new icons for Master AMC Status,
AMC Contracts, Reports, AMC Execution, Accounts, AMC Sales).

## Help icon

The header Help button is an open book (`data-icon="open-book"`), tooltip **Help & User Guide**; its accessible name
stays "Help for this page". The Help panel header uses the same icon. Panel, search, context topic, related topics,
User Guide links, Escape/keyboard, dark mode and mobile layout are unchanged.

## Help coverage (topic ↔ User Guide chapter)

| Area | Help topic (group) | User Guide chapter |
|---|---|---|
| Dashboard; AMC Management (separate pages, shared KPI cards) | dashboard (Getting started), amc-management (AMC) | Dashboard; AMC Management |
| Master AMC Status | master-amc-status (AMC) | Master AMC Status |
| AMC Contracts, Due/Expired, Hide Columns | amc-contracts (AMC) | AMC Contracts |
| Contract 360 | contract-360 (AMC) | Contract 360 |
| Schedule Engine | schedule-engine (AMC) | Schedule Engine |
| AMC Schedule | amc-schedule (AMC Execution) | AMC Schedule |
| Monthly Calendar | monthly-calendar (AMC Execution) | Monthly Calendar |
| Service Status, Sales Engineer Name, AMC Value, Service Reports | service-status (AMC Execution) | Service Status |
| Accounts (Invoices), filtered totals, View Service Report, Ack indicator | accounts (Accounts) | Accounts |
| Invoice Acknowledgements: multi-service, upload + OK/Confirm, green Acknowledged, Reconcile, cancelled Tracking record / Re-associate | invoice-acknowledgements (Accounts) | Invoice Acknowledgements |
| Invoice Tracking | invoice-tracking (Accounts) | Invoice Tracking |
| Service Sales, Total AMC Value | service-sales (AMC Sales) | Service Sales |
| AMC Renewal: same number, versions, renewal document | amc-renewal (AMC Sales) | AMC Renewal |
| Reports, monthly invoice values, Oman time | reports (Reports) | Reports |
| Oman business dates | getting-started | Getting started |
| Billing Basis / Regenerate / Paid | billing-basis, regenerate, paid-vs-zoho | Billing Basis, Regenerate and Paid status |
| Users & Access, Roles & Permissions | users-and-roles, roles-permissions | Users and Roles |
| Login History, Audit Log, Recycle Bin | login-history, audit-log, recycle-bin | same names |
| Security Center, Backup & Restore, Settings | security-center, backup-status, settings | same names / Backup status |
| Suggestions, Suggestions Review | suggestions, suggestions-review | Suggestions |

Help groups now follow the sidebar: Getting started · AMC · AMC Execution · Accounts · AMC Sales · Master Data Center ·
Reports · Administration. Topics whose menu label differs from the page title gained a "Where to find it" line.

## Verification

- Web: typecheck, lint (warnings only, pre-existing), build; full suite 59 files / 893 tests passed (new tests: group
  order and children, automatic expansion and current link for six pages, brand, Help icon/keyboard, context topic for
  eight pages, AMC Management topic visibility, Help groups).
- API: not changed; `permission-catalog` and `role-model` tests (they read the web navigation) 42 passed on an
  isolated database.
- Browser (headless Edge, isolated stack 5411 → 3411, schema `e2e_ack`): Super Admin desktop/tablet/mobile × light/dark
  116/116; Admin, Finance Executive and Viewer desktop/mobile × light/dark — hierarchy, children, no duplicates,
  automatic expansion, current-page highlight, collapsed tooltips, Help icon and context topics all as expected for each
  role's grants (Reports hidden for roles without *Reports: View*; Invoice Ack hidden for Viewer; Finance Executive sees
  Dashboard and Accounts only).
