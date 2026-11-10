# STS-ELV AMC — User Guide

Version: handover draft, 2026-11-09. Describes the application at commit `c6d8d19` plus the in-app Help added on branch `feature/stslv-p3-handover`.
Chapters listed under **Sections awaiting integration review** may change when parallel work (P0 security, P1 fixes) is merged; see §27.

The same content, shortened, is available inside the application: click the **?** button in the header (help for the page you are on) or **Help & User Guide** in your account menu.

## Contents

1. [Getting started](#getting-started)
2. [Billing Basis, Regenerate and Paid status](#billing-basis-regenerate-and-paid-status)
3. [Dashboard](#dashboard)
4. [Master Data Center](#master-data-center)
5. [AMC Management](#amc-management)
6. [AMC Contracts](#amc-contracts)
7. [Contract 360](#contract-360)
8. [Schedule Engine](#schedule-engine)
9. [AMC Schedule](#amc-schedule)
10. [Monthly Calendar](#monthly-calendar)
11. [Service Status](#service-status)
12. [Service Sales](#service-sales)
13. [Accounts](#accounts)
14. [Invoice Acknowledgements](#invoice-acknowledgements)
15. [Invoice Tracking](#invoice-tracking)
16. [Master AMC Status](#master-amc-status)
17. [AMC Renewal](#amc-renewal)
18. [Reports](#reports)
19. [Users and Roles](#users-and-roles)
20. [Security Center](#security-center)
21. [Login History](#login-history)
22. [Audit Log](#audit-log)
23. [Recycle Bin](#recycle-bin)
24. [Suggestions](#suggestions)
25. [Backup status](#backup-status)
26. [Settings](#settings)
27. [Integration review (2026-11-09)](#integration-review-2026-11-09)

Conventions used in every chapter:

- **Permissions** are written as *Module: Action*, e.g. *AMC Contracts: Edit*. Actions are View, Create, Edit, Delete, Approve, Export and Data read. Every action also needs View on the same module. The server checks every request; a hidden button is a convenience, not the protection.
- **Exports** are always **Excel (.xlsx)** or **PDF**, never CSV. An export contains every row matching the current filters (not only the page on screen) and leaves out hidden columns.
- **Money** is OMR, excluding VAT, with three decimals.
- **Status colours** for contracts: Draft amber, Active green, Expired grey, Cancelled red. For visits: Scheduled blue, In progress amber, Completed green, Postponed grey, Cancelled red, Historical grey; a red **Overdue** pill marks a late visit.

---

## Getting started

### Purpose

STS-ELV AMC replaces the AMC Excel trackers. It holds every AMC contract, generates its maintenance services, records their completion and the invoice numbers raised for them, and warns about renewals, so that no visit and no invoice is missed.

STS-ELV AMC does **not** create official invoices. Invoices are still raised in Zoho; their numbers are recorded here.

### The everyday flow

```
Master Data ─► AMC Contract ─► Generated services ─► Service completed (report uploaded)
                                                      │
                     Zoho invoice raised ◄────────────┘
                              │
              Invoice No. entered on the service (Paid reference status)
              Zoho invoice recorded in Invoice Tracking (optional detail)
                              │
                       Reports / Dashboard ─► AMC Renewal before the end date
```

### Signing in

1. Open the application address and enter your email and password.
2. If an administrator gave you a **temporary password**, you are asked to choose a new password before anything else. A temporary password is valid for 15 minutes.
3. New users can **Sign up**; the account waits until an administrator approves it and assigns a role.
4. **Forgot password?** STS-ELV AMC sends no email. Ask an administrator to issue a temporary password in Users & Access.
5. **Sessions.** Each sign-in is a session the server keeps. You are signed out after **30 minutes without using the application** ("You were signed out after 30 minutes of inactivity. Please sign in again.") and, at the latest, when the sign-in itself expires. Signing out ends the session on the server at once. **My Profile → Active sessions** lists your devices and can sign out one or all of them. A password change, a temporary password or deactivation signs the account out everywhere.
6. **Password rules** (for every new password): at least **12 characters**; at least three of lower-case, upper-case, digits and symbols/spaces; at least 5 different characters; not a well-known password with digits added (such as "Welcome@123"); not containing your name or email name. Existing passwords keep working until you change them.

### The screen

| Area | What it does |
|---|---|
| Sidebar | Pages your role may open, grouped: Master Data Center, AMC Operations, Finance, Reporting, Administration. On a phone, open it with the menu button (☰). It can be collapsed on a desktop. |
| Header search | Finds the pages you may open (arrow keys, Enter, Esc). Records are searched on each page. |
| Bell | Alerts for your work: overdue services, contracts past validity, work waiting for an invoice. Mark them read individually or all at once. |
| **?** (Help) | Help for the current page, with search and a list of all topics you may read. |
| Light bulb | Send a suggestion or report a problem. |
| Palette / moon | Colour palette and light/dark mode. |
| Account menu | My Profile (change password), Help & User Guide, My Suggestions, Sign out. |

### Common errors

| Message | Meaning |
|---|---|
| Access denied | Your role does not include this page. Ask an administrator. |
| Cannot reach the server | The API is not reachable (for example waking up after idle time). Click **Try again**. |
| "You were signed out after 30 minutes of inactivity…" / "This session has been signed out. Please sign in again." | The session ended (inactivity, sign-out elsewhere, an administrator, a password change). Sign in again. |
| "…changed by someone else after the page was loaded…" | Another user saved the same record. Reload and save again. |

### FAQs

- **Why can't I see a page my colleague sees?** Roles differ. Access is configured in Administration → Roles & Permissions.
- **Is my data saved when I close a form?** No; forms with unsaved changes ask before you leave.

---

## Billing Basis, Regenerate and Paid status

These rules were approved by the project owner on 2026-11-01 (`docs/FINANCE_WORKFLOW.md`).

### Billing Basis

The Billing Basis on a contract chooses the **annual** amount that is split across each year's services.

| Option | Annual amount |
|---|---|
| AMC Value / Year | The contract's AMC Value / Year |
| Final Credit Value | The contract's Final Credit |
| Custom Billing Value | A value typed on the contract |
| *Not set* | No calculation: services keep the **Default visit amount** (Cost per Visit) entered by hand |

**Calculation**

- Amount per service = annual amount ÷ services in one annual cycle, rounded half up to 3 decimals.
- The **last service of each complete annual cycle** takes the rounding remainder: 500.000 ÷ 6 = 5 × 83.333 + **83.335** = 500.000.
- **No proration**: in a partial contract year, each service actually scheduled gets the standard amount; a cycle that never reaches its last service has no remainder.
- Services per year = 12 ÷ interval months, or the number of chosen months for a custom frequency.

**Older contracts**: values entered before these rules may be whole-term amounts. They are never reinterpreted automatically. Before choosing *AMC Value / Year* on an older multi-year contract, check the **Contract Value Review** report (§18).

### Regenerate

Editing a contract never changes the amounts of services that already exist. **Regenerate** on the contract page (Contract 360 → Service schedule) is the only way to recalculate them.

1. Open the contract; it must be **Active** and have a Billing Basis. You need *AMC Contracts: Edit*.
2. Click **Regenerate**. A preview shows the basis, the annual amount, how many amounts are recalculated, kept or already correct, services to be added or removed, and a Now / New table.
3. Enter the **Reason for regenerating** (3–300 characters) and confirm.

Kept unchanged (the preview shows why): Completed · Historical · Cancelled · Paid (Invoice No. entered) · Zoho invoice recorded · Amount set by hand. Every other service takes the calculated amount; missing services are added and untouched services outside the terms are removed. The reason and every old and new amount are written to the Audit Log. There is no undo button; the log keeps the old values.

Errors: "Select a Billing Basis first. A contract without one keeps its manually entered Cost per Visit." · "A schedule is regenerated only for an active contract." · "Enter the reason for regenerating."

### Service completion

A service is completed on **Service Status** (§11) after its Service Report is uploaded. Completion is **final**: the status, completion date and report are then locked for everyone, Admin included. Completing a service never makes it Paid.

### Paid (manual Invoice No.) versus Zoho payment reconciliation

| | Manual Invoice No. | Invoice Tracking (Zoho) |
|---|---|---|
| Where | Accounts, AMC Schedule, Contract 360 | Invoice Tracking |
| What is entered | Only the invoice number | Number, date, amount ex VAT, VAT, allocations to visits/projects |
| Effect | Entered = **Paid**; cleared = **Unpaid** | Work becomes **Invoiced**; does **not** make a service Paid |
| When allowed | Only on a **Completed** service (clearing is always allowed) | Only on completed work with an amount above 0 |
| Used by | Accounts colours, Master AMC Status, Calendar squares, Dashboard payment figures, AMC Management invoice KPIs, Reports Paid/Unpaid | Ready for Invoice / Invoiced, Pending Billing, Calendar "Billing status (Zoho)", Client 360 invoice figures |

> **Paid means a manual Invoice No. is entered on the service. It is a reference status and does not verify that money was received.**
> STS-ELV AMC holds no bank or receipt records. Confirming that a client actually paid is done in Zoho / the bank statement.

Where a Zoho record exists it is shown beneath the Invoice No. as "Zoho: INV-…", for reference only.

---

## Dashboard

**Page:** Dashboard (`/dashboard`). **Permission:** *Dashboard: View*; each figure also needs View on its own module (contracts, schedule, invoices).

### Purpose
"AMC Operations Dashboard": contracts, this month's services, invoice numbers and renewals at a glance.

### Key figures (fixed order)

| Row | Card | Meaning |
|---|---|---|
| AMC Portfolio (active contracts) | Active AMCs | Contracts with status Active; notes how many are past validity |
| | Annual AMC Value (Ex VAT) | Sum of AMC Value / Year of active contracts |
| | Final Credit (Ex VAT) | Sum of Final Credit; "Entered on X of Y active contracts" |
| | Expiring ≤45 Days | Active contracts ending within 45 days; notes how many have a renewal |
| Current Month | Services This Month | Planned services this month (cancelled excluded), with the number completed |
| | Services Pending | Scheduled, In progress or Postponed |
| | Invoices Generated | Services with a manual Invoice No. (count and OMR) |
| | Invoices Not Generated | Services without one |
| Overall | Same four service/invoice figures across all records, including earlier years and visits ahead | |

"Invoices Generated" is the Paid reference status (§2), not verified payment.

### Panels
- **AMC Maintenance Calendar** — *Today* and *Next 7 days*; click a service for its details (needs *AMC Schedule: View*; Zoho invoices need *Invoice Tracking: View*). Payment status reads "Paid · Invoice No. X (reference status, not verified payment)" or "Unpaid".
- **Upcoming Service Workload** — six months of planned / completed / open services; *Show as table* / *Show as graph*.
- **Payment Trend** — value of services marked Paid over the last six months.
- Status chip: *System online* (green), *System unreachable* (red), *Checking…* (amber). **Refresh** reloads; the footer shows the time of the figures.
- **+ New AMC** opens contract creation (*AMC Contracts: Create*).

### FAQs
- **A card is missing.** Your role lacks View on that module.
- **Why do Dashboard Paid figures differ from Invoice Tracking totals?** They use different sources (§2).

---

## Master Data Center

**Page:** Master Data Center (`/master-data`) and its five lists. Records are **deactivated, never deleted**, so history stays intact. Only Active records are offered for new contracts; disabling a record never changes contracts that already use it. Moving a record to the Recycle Bin is reserved to Super Admin. Status: Active (green), Disabled (grey); frequencies also Archived (amber).

### Clients (`/clients`) and Client 360 (`/clients/:id`)

| Field | Rule |
|---|---|
| Client name * | Required, up to 200 characters — "Client name is required." |
| Contact person, Phone, Address, Remarks | Optional |
| Email | Must be valid — "Enter a valid email address." |
| VAT number | Optional, up to 50 |
| Client type | Edit only: Company or Individual (new clients are saved as Company) |

- **Columns:** #, Code, Client name (opens Client 360), Type, VAT number, Contact person, Phone, Status, Actions.
- **Filters:** search (name, code, VAT, phone, email, contact), Status (default Active), Type, Sort; **Columns** menu.
- **Actions:** Add Client (*Clients: Create*), Edit (*Edit*), Deactivate/Reactivate (*Delete* — "will no longer be offered for new contracts. Existing contracts, invoices and history are kept."), Delete to Recycle Bin (Super Admin), Export (*Export*).
- **Client 360** tabs: Upcoming visits, AMC contracts, Invoices, Renewals, History; each tab exports with View + Export on its module.

### Sales Engineers (`/master-data/sales-engineers`)

| Field | Rule |
|---|---|
| Engineer code * | Unique ignoring capitals, ≤20 characters, letters/digits/spaces and - _ . / & ; a deleted engineer's code cannot be reused |
| Engineer name * | ≤150 |
| Employee no., Department, Email, Phone, Notes | Optional |
| User account | Optional link to a sign-in account |
| Status | Active / Disabled |

Filters: search, Status, Department, Sort. Disable/Enable needs *Sales Engineers: Edit* and warns about assignments. **Engineer 360** shows assigned and active contracts, active value, upcoming and overdue visits. Every new contract and renewal needs an **active** sales engineer.

### System Types (`/master-data/system-types`)
Code * (e.g. FA, CCTV), Name *, Sort order, Description. *Linked AMC contracts* opens the contracts that use the type. Delete only for an unused type, by Super Admin holding *System Types: Delete*.

### Maintenance Frequencies (`/master-data/maintenance-frequencies`)

| Field | Rule |
|---|---|
| Frequency name * | ≤50 |
| Internal code * | 2–30 letters, digits, underscores, starting with a letter (e.g. EVERY_4_MONTHS) |
| Service code prefix * | 1–4 letters (e.g. Q, BM); services are labelled Q1, Q2… |
| Sort order | 0–9999 |
| Custom month-selection frequency | Months chosen on each contract (1–11) |
| Interval (months) * / Services per year * | Every 1, 2, 3, 4, 6 or 12 months; services per year must equal 12 ÷ interval |

**Rule lock:** once a contract uses a frequency, only its name and sort order can change ("For a different rule, add a new frequency."). Disable or Archive keeps existing contracts and visits unchanged.

### Departments (`/master-data/departments`)
Department code * (permanent, e.g. AMC, FIN), Department name *, Description. Not the same as user roles. No delete; Disable shows the linked engineers.

### Common errors
"…is required." · "Engineer code may use letters, digits, spaces and - _ . / & only." · "With a 3-month interval, services per year must be 4."

---

## AMC Management

**Page:** `/amc/management`. **Permission:** *Dashboard: View* (the same as the Dashboard).

Since 2026-11-09 AMC Management shows **the Dashboard itself**: one shared page with exactly the same twelve cards in
the same order, the same values, the same AMC Maintenance Calendar, Upcoming Service Workload and Payment Trend, the
same links and the same behaviour on phones. See the Dashboard chapter. Each card and panel is shown only if your role
can view its module. The earlier KPI groups, Recent AMC Contracts and Expiry & Renewal panels are no longer shown here;
expiring contracts are followed on AMC Contracts (Validity filter) and AMC Renewal.

---

## AMC Contracts

> **Validity filter and Contract column (2026-11-09).** *Validity → Expired* lists contracts with status Expired or an
> Active contract whose Valid To has passed (the same rule as the Expired figure). *Validity → Due* lists Active contracts
> ending today or within 45 days. The Status filter still uses the stored status. Hide Columns can hide the Contract
> (Upload Contract) column.

**Page:** `/amc/contracts`. **Permissions:** View; Create to add; Edit to edit, change status, generate; Delete (+Edit) to cancel; Export.

### Columns
#, AMC Reference (opens Contract 360), Client, System, Engineer, Validity (progress bar and days remaining), Frequency, Contract value (and per-visit amount), Credit, Visits (% completed), Contract (Upload Contract link, Edit only), Status, Actions. Footer: **Filtered Total**. An amber **Validity ended** pill marks an Active contract past its end date.

KPI tiles: All AMC Contracts, Total AMC Value, Total Final Credit, Expired.

### Filters
Search (reference, client, system, engineer), Client, System, Year (validity covers any day of it), Sales engineer, Frequency, Contract status; **Reset filters**; **Columns**.

### Contract form

| Field | Required | Rule / message |
|---|---|---|
| AMC Reference Number | Yes | Typed by you, ≤50, unique ignoring case, never reused — "AMC Reference Number already exists…", "…was used before by another contract and cannot be reused." |
| Client | Yes | Active clients only |
| System | Yes | Active system types only |
| Sales engineer | Yes (new and renewal) | Active engineers; fills *Responsible engineer* |
| Responsible engineer | No | Free text |
| Maintenance frequency | Yes | Active frequencies; custom frequencies also need **Service months** (≤11) |
| Valid from / Valid to | Yes | Valid to ≥ Valid from; at most 10 years. *Contract duration* (1–6 years) fills Valid to |
| AMC Value / Year | Yes | Annual, ≥0, 3 decimals |
| Final credit | Yes (new) | Enter 0 when none; cannot be cleared once recorded |
| Default visit amount | No | Ignored while a Billing basis is selected |
| Billing basis / Custom Billing Value | No | §2 |
| Contract document | Yes (new) | PDF/DOC/DOCX, ≤12 MB — "Attach the contract document." |
| Description, Notes | No | ≤2000 |

A new contract is saved as **Active** and its services are generated immediately. Changing the reference later is allowed: it changes on every screen and export, while documents already issued (e.g. Zoho invoices) keep the old number, which stays in the Audit Log.

### Workflow — add a contract
1. Make sure the client, system type, engineer and frequency exist and are Active.
2. **Add Contract**, fill the form, attach the document, **Save**.
3. Open the contract (Contract 360) and check the Service schedule.

### Row actions
View · Edit (*Edit*) · Delete → "Move contract to the Recycle Bin" (Super Admin only; nothing is removed and it can be restored).

### Common errors
"Select a client." · "Valid to must be on or after Valid from." · "The validity period cannot be longer than 10 years." · "An inactive client cannot be selected. Reactivate the client first." · "Enter the final credit, or choose another billing basis." · "This maintenance frequency is not active…"

### FAQs
- **Can I add a Draft contract?** No; new contracts are Active. A renewal starts as a Draft (§17).
- **Can I delete a contract?** Cancel it (keeps history) or, as Super Admin, move it to the Recycle Bin.

---

## Contract 360

**Page:** `/amc/contracts/:id` (click a reference anywhere). **Permission:** *AMC Contracts: View*.

### Banner actions (*AMC Contracts: Edit*)

| Action | From → to | Notes |
|---|---|---|
| Activate | Draft → Active | Generates services; existing ones kept, missing ones added |
| Mark as expired | Active → Expired | Optional "Also cancel the scheduled and postponed visits"; services with an Invoice No. are never cancelled |
| Cancel contract | Draft/Active → Cancelled | Also needs *Delete*; **Reason for cancelling** required (≤500) |
| Reactivate | Expired/Cancelled → Active | |
| Edit | | Changing dates/frequency of an Active contract shows **Confirm schedule change** (services added, removed, kept) → **Save and update schedule** |

No status changes by itself.

### Figures
AMC Value / Year, Default visit amount, Final credit, Billing basis, Annual billing amount, Total of visit amounts, **Expected for the term less visits** (a difference is information, not an error; "Not compared" without a basis), First Service, Current Generation.

### Tabs
- **Service schedule** — Calculation rule panel (basis, visit amount, frequency, validity, colour priority), **Regenerate**, Schedule history, visits table (No., Scheduled, Period, Status, Completed, Amount, Quotation No., Invoice No., Paid date, Invoicing (Zoho), Color, Schedule). Invoice No. editable with *Invoice Tracking: Edit*; colour with *AMC Schedule: Edit*; export with *AMC Schedule: Export*.
- **Invoices** — Zoho invoices for this contract (needs Invoice Tracking read).
- **Renewals** — "Renews" / "Renewed by"; **Create renewal** (*AMC Renewal: Create*).
- **Documents** — contract document and files; upload needs *AMC Contracts: Edit*.
- **Contract history** — every change, who and when.
- **Details** — description, notes, duration, **Master records** links ("A link that is recorded can be changed, not removed.").

Toolbar links: Documents, Renew, Monthly Calendar, All Schedules.

---

## Schedule Engine

There is no background job. Services are generated when an Active contract is added, when a contract is activated, when the dates or frequency of an Active contract are edited, and by Regenerate.

- **Fixed interval:** one service every N months counted from Valid from (31 Jan → 28/29 Feb → 31 Mar, no drift). The service date is the first day of its period; nothing is planned after Valid to; a short last period still gets a service.
- **Custom months:** one service in each selected month of every contract year, on the start date's day.
- **Labels:** "Year N · {prefix}{n}", e.g. "Year 2 · Q3".
- **Imported contracts** generate only from their cutover date.
- **Kept on every change:** services already acted on — not Scheduled, rescheduled, amount set by hand, Invoice No., service report or quotation number, colour, assignee or notes.
- Untouched services that no longer fit are removed; missing periods are added.

Errors: "A schedule is generated only for an active contract. Activate the contract first." · "Valid from cannot be changed: N visit(s) have already been worked on, edited or rescheduled. Record a new contract for different terms." · "N visit(s) that have been worked on… fall outside the new validity period… Cancel those visits first…"

---

## AMC Schedule

**Page:** `/amc/schedule`. **Permissions:** *AMC Schedule: View*; Edit to edit visits and colours; *AMC Execution: Edit* for Visit actions; *Invoice Tracking: Edit* for Invoice No.; Export.

### Views
- **All Visits** — tiles Due this month, Overdue, Completed this month, Ready for invoice ("Raise these in Zoho"); tiles ignore filters.
- **Monthly by AMC** — one row per contract with its services of the month as chips ("· Paid/Unpaid"); export once a month is chosen.

### Filters
Month (‹ ›) or All dates, search, Client, Status, System, Invoicing (Zoho), Paid / Unpaid.

### Columns
#, Scheduled, AMC Reference, Client and system, Period, Assigned to, Status, Amount, Invoicing / Color, Actions. Footer: total amount (cancelled excluded).

### Actions
- **Edit** — Visit amount (this visit only; 0 = not invoiced), Scheduled date, Assigned to, Planning notes. Completed/cancelled visits cannot be rescheduled; a Paid visit or one covered by an active Zoho invoice keeps its amount.
- **Visit actions → Update visit** — Status (Scheduled, In progress, Completed, Postponed, Cancelled), Completion date (not in the future), Planned date, reason, Work performed, Execution notes. Completing needs the report uploaded on Service Status. Completed services are locked.
- **Invoice No. + OK** — Paid / Unpaid (§2).
- **Service colour** — priority Manual → Cancelled (grey) → Invoice Pending (amber) → First Service (light blue) → Normal (green). Manual colours: Red, Amber, Green, Blue, Purple, Grey; **Clear manual color**.

### Errors
"Complete the service before entering an invoice number." · "This visit cannot be given another amount: it is Paid with Invoice No. X. Clear the Invoice No. first." · "This service is completed and locked. Its status and completion date cannot be changed." · "Scheduled date is required."

---

## Monthly Calendar

**Page:** `/amc/calendar`. **Permissions:** *Monthly Calendar: View*; Export for month downloads.

- **Year view:** Services in year, Scheduled value, Paid, Unpaid (blue, as in Month view); a card per month with values, Zoho invoiced / not yet invoiced and completed / open / overdue / cancelled counts; per-month **Excel / PDF**. No By service / By contract switch here.
- **Month view — By service / By contract:** *By service* (default) is the calendar grid below. *By contract* lists the same services, with the same filters, as one entry per AMC contract: reference (opens the contract), client, system, engineer, state (Open, Partly completed, All completed, Overdue, Cancelled), each service with its date and status, and Services / Paid / Unpaid counts. The choice is kept in the address (`group=contract`).
- **Month view (By service):** card colour = status (Scheduled sky, In progress amber, Postponed violet, Completed green, Cancelled grey struck through, Historical grey); square = Paid (green) / Unpaid (blue); red dot = overdue. Click a visit for details (Edit with *AMC Schedule: Edit*).
- **Filters:** search, Client, Sales engineer, System, Frequency, Visit status, Paid / Unpaid, Billing status (Zoho).
- **Renewal warnings:** contracts ending within 45 days, or past validity and still Active.

---

## Service Status

> **AMC Value and Sales Engineer Name (2026-11-09).** *AMC Value (OMR)* shows the contract's AMC Value / Year on each
> service, only to users who may view AMC Contracts; it is not added up. *Sales Engineer Name* is typed beside the
> Service Report No. and saved with the row (up to 120 characters, recorded in the Audit Log). It is separate from the
> Sales Engineer column, which comes from the contract.

**Page:** `/amc/service-status`. **Permissions:** *Service Status: View*; *AMC Execution: Edit* to save, upload and use Actions; *Service Status: Export*.

### Purpose
One row per scheduled service (Scheduled, In progress, Postponed, Completed; open services of cancelled contracts excluded): completion, Service Report and report number.

### Statuses
| Status | Colour | Meaning |
|---|---|---|
| Completed | Green | Completed and locked |
| Not Completed | Blue | Not yet completed |
| Waiting for Renewal | Red | Contract expired or past validity with no open renewal |

KPI cards: Total Services, Completed, Not Completed, Waiting for Renewal (Customize to rename/reorder).

### Filters / columns
Search, Client, Sales Engineer, System, Maintenance Frequency, Scheduled month and year (default: current), Service Status; Reset Filters; Hide Columns. Columns: #, AMC Reference, Client, System, Frequency, Service, Scheduled Month / Due Date (red "overdue"), Service Status, Sales Engineer, Service Report No., Service Report, Actions.

### Workflow — complete a service
1. **Upload Report** — PDF, DOC or DOCX, within the size limit (12 MB by default).
2. Set the status to **Completed**; optionally enter the **Service Report No.** (≤50).
3. **Save** in the row ("Unsaved changes" → "Saved"). Today is recorded as the completion date.

Without a report: popup **"Service report required" — "Please upload service report."**, nothing saved. After saving: lock icon, "Completed services are locked: the status cannot be changed." Before completion a report can be replaced (earlier version kept) or removed.

### Service Report No. after Paid (approved 2026-11-09; switched on at release)
Once a service is **Paid** (an Invoice No. is entered in Accounts), its Service Report No. is **locked**: "Locked: this service is Paid (an Invoice No. is entered). Only an administrator can change the report number, with a reason." **Super Admin and Admin** may still change it by giving a **reason** (required); every such change is written to the Audit Log. Other roles are refused, also through the API. Clearing the Invoice No. (Unpaid) unlocks it again.
> This rule is approved but **switched off** until the approved production release (`SERVICE_REPORT_NO_LOCK_ENABLED`). While it is off, the number stays editable as before.

### Which services are counted
Scheduled, In progress, Postponed and Completed services count. On a **cancelled** contract only services already **Completed or Paid** count: they stay in Service Status, Accounts, Master AMC Status, Service Sales and the Dashboard; its open, unpaid services are left out. Historical services that are Paid but were never completed are kept exactly as they are (no automatic correction).

### Errors
"Only PDF, DOC and DOCX files can be uploaded as a service report." · "The chosen file is empty." · "Service reports can be at most N MB." · "This service is completed and locked, so its service report cannot be changed."

### FAQs
- **I completed the wrong service.** It cannot be reopened in the application. Record the correction in the notes and report it to an administrator.
- **An old completed service has no report.** It stays completed without one; a report cannot be added afterwards.

---

## Service Sales

> **AMC Value and total (2026-11-09).** For users who may view AMC Contracts, *AMC Value (OMR)* shows the AMC Value /
> Year of each service's contract period, and *Total AMC Value of matching contracts* adds up the matching contract
> periods on every page, each counted once. It is not an invoice value or a payment.

**Page:** `/amc/service-sales` (old `/amc/quotations` links redirect). **Permissions:** *Service Sales: View / Edit / Export*.

- **Purpose:** track completed services and record quotation numbers for follow-up sales.
- **KPIs:** Total Services, Not Completed, Completed / Quote Pending, Quoted.
- **Colours:** Not Completed (rose), Completed / Quote Pending (light blue), Completed with Quote No. (green).
- **Filters:** search, Client, Sales Engineer, System, Frequency, Scheduled month and year, Service Status, Quote Submitted / Not Submitted.
- **Quote No.:** only on completed services; ≤50 characters, no line breaks; empty when there is none ("N/A is not a quotation number…"); **Save** shows who saved it and when. "Complete the service before recording a quotation number."
- Service Report: view/download only.

---

## Accounts

> **Service Report viewer and filtered totals (2026-11-09).** *View Service Report* opens the uploaded report in a
> read-only viewer with Download inside it (Word documents: Download only). The *Total Filtered* row adds up every
> matching service on every page: Total Filtered Service Value (OMR), its Paid (Invoice No.) part, and Total Filtered
> Invoice Value (OMR) — the Zoho amounts allocated in Invoice Tracking (cancelled invoices excluded). A service with no
> value whose contract has no Billing Basis or Cost per Visit says so; no value is invented.

**Page:** `/finance/accounts`. **Permissions:** *Accounts: View / Export*; *Invoice Tracking: Edit* to change the Invoice No.

- **Purpose:** billing reconciliation of every scheduled service; enter the Invoice No. to mark a service Paid.
- **Row colours:** Red = service not completed · Blue = completed, Unpaid · Green = completed, Paid. A Zoho record does not make a row green.
- **KPIs:** Rows, Completed, Not Completed, Invoice No. Filled ("Paid: reference status, not verified payment"), Total Value (Ex VAT).
- **Filters (press Apply):** search, Client, Sales Engineer, AMC Contract, Scheduled month and year, Paid / Unpaid, Service Status; Hide Columns.
- **Columns:** AMC Reference, Client, System, Frequency, Service, Scheduled Month, Value (Ex VAT), Service Status, Service Report No., Invoice No. (with "Zoho: …"), Sales Engineer.

### Workflow — enter an invoice number
1. Raise the invoice in Zoho.
2. Filter Accounts to the month; find the blue (completed, Unpaid) row.
3. Type the number in **Invoice No.**, click **OK** → green, Paid.
4. Wrong number? Correct it and click OK (the first-entered date is kept). Clear it and click OK to return to Unpaid.

**Acknowledgement indicator (read only).** Users who may also view Invoice Acknowledgements see **Ack: Acknowledged** or **Ack: Pending** under the Invoice No. It opens Invoice Acknowledgements (§14), is not included in the Accounts export, and never changes Paid / Unpaid or the row colour.

### FAQs
- **The Invoice No. box is disabled.** The service is not completed: "Complete the service before entering an invoice number."
- **Does Paid mean the client paid?** No — see §2.

---

## Invoice Acknowledgements

> **Module (2026-11-10, migrations 0112–0115, prepared for review).** One acknowledgement per invoice, even when the
> invoice covers several services.

**Page:** Finance → Invoice Acknowledgements, `/finance/invoice-acknowledgements`. **Permissions:** *Invoice Acknowledgements: View* to see the page, view and download documents and the Linked Services; *Create* to attach a document and confirm; *Edit* to replace the document of an acknowledged invoice and to **Reconcile**; *Export* for Excel / PDF. Amounts are shown only to users who may also view Accounts. **Starting access:** Super Admin and Admin — View, Create, Edit, Export; Finance Executive — View, Create, Export; Viewer and other roles — none.

- **Purpose:** keep the client's signed or stamped acknowledgement that it received each invoice, next to that invoice.
- **One row per invoice.** An invoice may cover several services: one document and one confirmation acknowledge them all, and every linked service shows the same status. **Linked Services** (the count in the row) lists them.
- **How invoices are identified:** when Invoice Tracking holds a record of the invoice, that record decides which services it covers. Otherwise each service's Invoice No. starts as its own invoice. Equal Invoice Nos. are **never merged automatically**: they are flagged **Needs reconciliation** until an authorised user links them as one invoice or confirms they are separate. Invoices of different clients are never linked.
- **Corrected Invoice No.:** the new number is a new invoice and starts Pending; the earlier invoice and its acknowledgement are kept.
- **Statuses:** **Pending** (amber) — no confirmed acknowledgement yet; "Document attached, awaiting OK / Confirm" when a document is waiting. **Acknowledged** (green) — the document was confirmed. Green appears only after the server confirms. **Needs reconciliation** (red note) — no new acknowledgement is taken until it is resolved.
- **KPIs:** Invoices, Pending, Awaiting Confirmation, Acknowledged, Needs Reconciliation.
- **Filters (press Apply):** search (invoice no., client, contract, service report no., document name), Client, AMC Contract, Invoice No., Acknowledgement (Pending / Acknowledged), Reconciliation, Date filter (*Invoice date* or *Acknowledged date*, Oman time) with From and To. Click a column heading to sort. Hide Columns as on Accounts.
- **Columns:** Invoice No. (with the date it was entered), Client, AMC Contract / Version (e.g. *STS-AMC-001 (V2)*), Invoice Date, Invoice Value (Ex VAT, OMR), Service Value (Ex VAT, OMR), Linked Services, Acknowledgement Status, Acknowledged Date, Acknowledged By, Uploaded By, Document, Actions.
- **Invoice Date and Invoice Value** come from the invoice's Invoice Tracking record, counted **once per invoice** (cancelled records are ignored). A manual Invoice No. carries no date or amount, so the cell shows "—". Nothing is invented.

### Reconcile (Edit)
- **Same Invoice No.:** choose **Link as one invoice** (the services join one invoice; one acknowledgement covers them) or **They are separate invoices**. A reason is required and recorded.
- **More than one acknowledgement:** acknowledgements recorded per service by the earlier release, or brought together by a link, are all kept; none is chosen automatically. **Make current** picks the one that counts; the others stay in the document history.
- **Invoice Tracking record cancelled** (amber note, not a block — the invoice can still be acknowledged): when the invoice is re-entered in Invoice Tracking, **Re-associate** points the same invoice to the new record. Only an active record of the same client and number that covers every linked service is offered; any other record is listed with the reason it cannot be used. The invoice, its services, its acknowledgement and its history stay as they are. Nothing is re-associated automatically.

### Workflow — acknowledge an invoice
1. Find the invoice (Acknowledgement = Pending).
2. Click **Attach Acknowledgement** and **Choose document** (PDF, PNG or JPEG, up to 12 MB). The file is checked and saved to private storage; its name appears under *Selected document*. The invoice is still Pending.
3. Check the name (use **Choose a different file** or **Remove** if it is wrong).
4. Click **OK / Confirm**. The status turns green, **Acknowledged**, with the date and time (Oman) and your name.
5. If anything fails (wrong file type, storage unavailable, someone changed the document meanwhile), the message is shown and the invoice stays Pending.

### View, download, replace
- **View Document** opens the document in a viewer (PDF and images are shown; **Download** is inside the viewer). The file is fetched with your sign-in; there is no public link. The viewer also lists earlier versions.
- **Replace Document** (Edit permission, acknowledged invoices only) uploads a new version with a reason. The invoice keeps its original acknowledged date and user; the earlier document is kept and the reason goes to the Audit Log. Documents are never deleted.

### Acknowledged is not payment
Acknowledgement only records that the client received the invoice. It does not change the Invoice No., the Paid / Unpaid reference status (§2), any amount, the service status or anything in Zoho, and it does not mean money was received.

### FAQs
- **I cannot see the page.** Ask Super Admin for *Invoice Acknowledgements: View*.
- **No Attach button.** You need *Create*; or the invoice is already Acknowledged (use Replace Document with *Edit*); or it needs reconciliation first.
- **Two rows with the same Invoice No.** They were not proven to be one invoice. Someone with *Edit* uses **Reconcile**.
- **The amounts are empty.** Your role cannot view Accounts, or no value / Zoho invoice is recorded.

---

## Invoice Tracking

**Page:** `/invoices`. **Permissions:** *Invoice Tracking: View*; Create to record; Edit to edit/cancel; Export.

- **Waiting for an invoice:** completed visits (and projects) with an amount and no active invoice.
- **Invoices recorded:** search (number, client, Zoho reference, job number), Status (Issued green / Cancelled grey), From, To. Columns: #, Invoice no., Invoice date, Client, Covers, Excl. VAT, VAT, Total, Status. Footer: total invoiced excl. VAT.

### Record Invoice form
Client *, Invoice number * (as in Zoho, unique), Invoice date *, Amount excluding VAT * (>0, 3 decimals), VAT amount * (0 if none), **What this invoice covers** * (completed work of the same client, each with an amount; allocations must equal the amount excluding VAT), Zoho reference, Notes.

### Cancel
Requires a reason; the record is kept but excluded from totals, the work becomes ready for invoice again; cannot be undone; nothing changes in Zoho.

### Errors
"Invoice X is already recorded. Cancel that record first if it was entered by mistake." · "The allocations add up to X, but the invoice amount excluding VAT is Y. They must be equal." · "VAT amount is required. Enter 0 if the invoice has no VAT."

---

## Master AMC Status

> **Values (2026-11-09).** The Value cell also shows the Zoho invoice amount and, for users who may view AMC Contracts,
> the contract's AMC Value / Year. A Total Filtered row covers every matching service on every page.

**Page:** `/amc/master-status`. **Permissions:** *Master AMC Status: View / Export*. Read only.

| Row colour (first rule wins) | Meaning |
|---|---|
| Red | Not completed |
| Yellow | Completed, invoice pending (Unpaid) |
| Blue | Paid, quote pending |
| Green | Paid and quoted |

KPIs: Total Services, Green/Blue/Yellow/Red Rows, Total Value (Ex VAT). Filters (Apply/Reset): search, Client, Sales Engineer, Scheduled month and year, Service Status, Paid / Unpaid, Quotation Status, Row Colour. Details opens every field ("Paid / Unpaid: Paid (reference status)", Zoho invoices, Quote No.).

**Export (Excel / PDF):** the shown columns, plus after Invoice No. two Invoice Tracking columns: **Zoho Invoices (Tracking)** — the Zoho invoice numbers covering the service — and **Zoho References (Tracking)** — each of those invoices' Zoho reference in the same order, "—" for an invoice recorded without one. Hiding Invoice No. hides both. They never decide Paid or Unpaid.

---

## AMC Renewal

> **Start Renewal (2026-11-09).** The renewal form is the Add AMC Contract form, filled from the contract being renewed,
> which is named at the top. An **updated renewal contract document is required**; the old contract's document is never
> reused. The renewal **keeps the same contract number** and is saved as its next version: the original is version 1,
> the first renewal version 2, and so on. Lists, reports and exports show a renewal as "STS-AMC-001 (V2)", so services,
> invoices and documents stay with the right period. A version is never reused, and no other contract can take the number.

**Page:** `/amc/renewal`. A renewal is a **new contract**; the contract it renews is never changed.

### Statuses (derived)
Due / Expired (amber) · Under Client Approval (light blue, draft renewal) · Renewed (green) · Cancelled (grey).

### Workflow — renew
1. **Renewal Queue** lists Active/Expired contracts ending within 45 days or already ended.
2. **Start Renewal** (*AMC Renewal: Create*) → "Renew AMC Contract": a **new** AMC Reference Number, dates, values, an **active** sales engineer, renewal notes → **Create renewal**. Saved as a Draft, Under Client Approval, no schedule yet.
3. After client approval: **Approve** (*AMC Contracts: Edit*) → Active, services generated.
4. Or **Cancel** (*AMC Contracts: Edit + Delete*, reason required); **Restart Renewal** later if needed.

**Renewal History:** Source AMC, Client / System, Source Expiry, Renewed AMC, New Validity, Status, Created. Export needs *AMC Renewal: Export*.

Errors: "A renewal needs an active sales engineer." · "This contract already has a renewal. Open it above, or cancel it to renew again."

**Contract expiry (approved 2026-11-09; switched on at release):** an Active contract becomes **Expired on the day after its Valid To date**, by Oman time (Asia/Muscat). Its services keep their status and values; an open renewal does not stop the old contract from expiring, and the renewal itself is not changed. It runs as a scheduled job, once per day, and each change is in the Audit Log. Until the approved release the job only runs as a dry run (`AMC_CONTRACT_EXPIRY_ENABLED` off), so contracts past validity stay Active and show as "past validity".

**Moving a contract to the Recycle Bin:** the dialog lists what is kept (services by status, Paid services, invoices, documents, the contract it renews). A contract that has been renewed cannot be moved; the dialog names the renewal.

---

## Reports

> **Monthly invoice values (2026-11-09).** Monthly Maintenance and the client and sales engineer summaries show Value,
> Unpaid Value, Paid Value (Invoice No. entered, a reference status), Zoho Invoice Value and Services Without Value per
> month, over the same services as Accounts, so the totals match Accounts for the same filters.

**Page:** `/reports`. **Permissions:** *Reports: View / Export* (no built-in role starts with Reports; Super Admin grants it), **plus the source page of each report**: opening a report also needs *View* of its source, exporting also needs *Export* of its source. Sources: **AMC Contracts** — AMC Contract Summary, Contract Value Review; **AMC Renewal** — AMC Renewal, Expiry & Renewal Due, Renewal History; **Accounts** — Billing Schedule, Completed Services, Pending Services, Monthly Maintenance, Accounts / Paid and Unpaid Summary, Client-wise and Sales Engineer-wise Summary. The list shows only the reports you may open; "No reports available" when there is none. The server refuses the rest.

Choose a report; only its filters are shown (From, To, Client, Sales Engineer, System, Status…). "The From date is after the To date." Exports carry the filters and a "Total (N rows)" line.

| Report | Notes |
|---|---|
| AMC Contract Summary | KPIs: Contracts in Scope, AMC Value, Scheduled (Current Year), Unpaid Amount |
| Billing Schedule | Adds Paid / Unpaid filter; Invoice No., Zoho Invoices |
| Completed Services | Every row Completed |
| Pending Services | Scheduled / In Progress / Postponed |
| Monthly Maintenance | Grouped by month |
| AMC Renewal | Renewal Status column |
| Expiry & Renewal Due | Active contracts ending within 90 days or past validity |
| Renewal History | As AMC Renewal history |
| Accounts / Paid and Unpaid Summary | Same split as Accounts |
| Client-wise Summary / Sales Engineer-wise Summary | Grouped |
| Contract Value Review | Multi-year contracts whose value *May be whole-term*, *Looks annual* or *Unclear*. Changes nothing |

---

## Users and Roles

### Users & Access (`/admin/users`)
**Permissions:** *Users: View* to open; Create to add; Edit to rename, change role, activate/deactivate; Approve to approve or reject sign-ups. Temporary passwords: Super Admin and Admin only. Export: administrators only.

- **Columns:** #, Name ("(you)"), Email, Role (amber "Several roles: choose one" for older data), Status, Last sign-in, Actions.
- **Filters:** search (name, email, role), Status: All / Active / Inactive / Pending / Rejected.
- **Statuses:** Active, Inactive, Pending approval (amber), Rejected (grey); "Temporary password · expires …" (amber).
- **Create User:** Full name, Email, Temporary password (meets the password rules: 12+ characters, see *Getting started*), Role (one per user).

**Workflow — approve a sign-up:** filter Pending → Change role → Approve. A pending account cannot sign in. Reject when the request is not genuine.

**Workflow — forgotten password:** Generate temporary password → tick "I have verified that the person asking is <name>…" → hand over the password shown once (format `xxxx-xxxx-xxxx-xxxx`). It replaces the old password at once, signs the user out everywhere, works for **15 minutes** and one sign-in, and must be changed at sign-in. Limit: 10 per administrator per 15 minutes.

**Rules and messages:** "Only Super Admin can manage Super Admin and Admin accounts." · "Assign a role before approving this user." · "You cannot manage a user who holds permissions you do not hold." · "This is the only active Super Admin. Assign the Super Admin role to another active user first." · You cannot change your own role or deactivate yourself. Changes apply on the user's next request. A temporary password, a password change or deactivation signs the user out everywhere; administrators can also end any session in **Security Center → Active sessions**.

### Roles & Permissions (`/admin/roles`) and the Role list (Settings → Organization → Role list)
Anyone with *Users: View* can see roles. Who may change them (approved 2026-11-09, enforced by the server):

| | Super Admin | Admin (needs *Users: Edit*) | Any other role |
|---|---|---|---|
| Add a custom role | Yes | Yes | No |
| Rename, deactivate, reactivate, delete a custom role | Yes | Only a role whose every permission Admin holds | No |
| Change a custom role's permissions | Yes | Only within Admin's own permissions | No |
| Give a role *Users & Access* permissions | Yes | No (may remove them) | No |
| Change a built-in role or its permissions | Yes (never Super Admin's) | No | No |
| Assign a custom role to a user | Yes | Only if Admin holds all its permissions | No |
| Assign Super Admin or Admin | Yes | No | No |

Nobody changes their own role. A custom role cannot use a built-in code or an existing name. Built-in roles are never deleted. If Super Admin removes *Users: Edit* from Admin, Admin can no longer manage roles. Where you may not change a role, its row has no actions and says why.

| Role | Starts with |
|---|---|
| Super Admin | Fixed full access (cannot be changed) |
| Admin | All operational and administrative modules, as configured by Super Admin |
| Finance Executive | Dashboard; Invoice Tracking and Accounts; data read of AMC Schedule; Suggestions |
| Master Data Executive | Dashboard; the five Master Data modules; Suggestions |
| AMC Operations Executive | Dashboard; AMC Operations modules and Service Sales; data read of Clients and Invoice Tracking; Suggestions |
| Viewer | View of every non-administration module; submit suggestions |

Reports is granted by Super Admin on purpose (no built-in role starts with it). The four operational roles can never hold *Users* permissions. Full matrix: `docs/technical/ROLE_PERMISSION_MATRIX.md`.

- **Fixed access:** Super Admin only — built-in roles and their permissions, giving a role *Users & Access*, Super Admin/Admin accounts, running and downloading backups, the Recycle Bin view and its actions. Super Admin and Admin — custom roles (as above), Audit Log, Deletion History, Backup status, Security Center (including Active sessions). Everyone — Notifications, My account (including your Active sessions), Help.
- **Saving:** "Permissions saved. They apply immediately." If someone else saved first: "Not saved: someone else changed these permissions since you opened them. Nothing was overwritten."
- **Messages:** "X also needs Y. Grant both, or neither." · "A built-in role cannot be deleted. Deactivate it instead." · "N people still have this role. Move them to another role first."

---

## Security Center

**Page:** Settings → Security Center (`/settings/security`). Super Admin and Admin; read only.

| Check | OK / Attention / Not available |
|---|---|
| API · Database · Database updates | Pending migrations → Attention |
| Last verified backup | "Backups are not available from this application here…" while in-app backups are off |
| Allowed web origins | Attention if any origin is allowed |
| Sign-in limits · Failed sign-ins (last 24 hours) | |
| Node runtime · HTTPS · Run mode · Security headers | Run mode is Attention outside production |
| Document storage | Shows the storage in use (Supabase Storage in production) |

Also: user access tiles (active, inactive, administrators, awaiting approval, must change password, active without a role), roles with user counts, settings in force (sign-in duration, inactivity limit, password hashing, request limits, allowed web addresses, document storage), and security events of the last 30 days.

**Active sessions:** every open session (user, device, address, signed in, last active). An administrator can sign out one session — "Signing out another device ends its session at once; it must sign in again." Before migration 0108 is released the panel says "Server-side sessions are not enabled". Links to Users & Access, Roles & Permissions, Login History, Audit Log, Recycle Bin, Backup & Restore.

---

## Login History

**Page:** `/admin/login-history`. *Users: View*. Read only, newest first, 25 per page.

Columns: User · Outcome (Successful green / Failed amber) · Network address · Browser / device. Failure reasons: No account with this email · Wrong password · Account inactive or awaiting approval · Temporary password expired. Filters: search (name, email, address), Outcome, From/To. Export: administrators.

Sign-in limits (defaults, per 15 minutes): 50 sign-in requests per network address; 5 failures per email and address (cleared by a successful sign-in). The message is "Too many attempts. Please wait a few minutes and try again."

---

## Audit Log

**Page:** `/admin/audit-log`. Super Admin and Admin. "What was changed, by whom and when, across every module. Newest first."

Tiles: Entries, Modules, People, On this page. Quick ranges: Today / Last 7 days / Last 30 days. Filters: search, Module, Record type, User, From, To. Timeline dot colours: red removed or blocked; green created or enabled; blue changed; grey other. Optional columns: Module, User, Record, Changes, Reason, Network address. Export Excel/PDF.

Useful entries: `amc_contract.schedule_regenerated` (reason and old/new amounts), manual Invoice No. changes (old and new number), service report uploads, role and permission changes, sign-in failures.

---

## Recycle Bin

**Page:** Administration → Recycle Bin (`/admin/deletion-log`). Admin sees **Deletion History** only; Super Admin also sees the **Recycle Bin** tab.

- **Contents:** AMC contracts, clients, system types and sales engineers moved there by Super Admin. Items stay until restored (no automatic expiry).
- **Move to the bin:** from the record's Delete action. A record still in use cannot be moved: "This record is still in use and cannot be moved to the Recycle Bin. Deactivate it instead."
- **Restore:** same id, code and links; the dialog lists blockers and warnings.
- **Delete permanently:** only clients, system types and sales engineers never used; type the record's code to confirm. "This cannot be undone… the Audit Log keeps a copy." A deleted engineer's code can never be reused. **AMC contracts are never deleted permanently.**
- **Deletion History:** When, Action (Deleted red, Cancelled amber, Deactivated grey, Restored green), Record type, Record no., Status now, User, Details; filters and export.

---

## Suggestions

- **Send:** light-bulb button in the header (needs *Suggestions: Create*). Type Improvement / Bug / Feature; Subject 3–150 characters; Description 10–4000. The page you were on is recorded. You receive a reference.
- **My Suggestions** (account menu, `/suggestions`): Reference, Subject, Type, Status, Submitted, Last response. Open one to see responses; reopen a Resolved suggestion if the problem remains.
- **Suggestions Review** (`/admin/suggestions`, *Suggestions Review: View*, changes need *Edit*): all suggestions, open first; filters by status, type, submitter, assignee, dates; assign a responsible person; respond; internal notes are hidden from the submitter. Nothing is ever deleted.
- **Statuses:** Submitted (light blue) → Under Review (violet) → In Progress (amber) → Resolved (green) → Closed (grey); Reopened (rose). Resolving needs resolution notes; reopening or closing an unresolved one needs a reason.

---

## Backup status

**Page:** Settings → Backup & Restore (`/settings/backups`). Super Admin and Admin view; only Super Admin runs or downloads.

- **Current hosted copy:** in-app backups are **not configured**. The page says "Manual backups are not available here." with the reason, and tiles show *Not available / Not configured / None yet*. Database backups are taken by the system owner with `pg_dump` outside the application (see `docs/technical/TECHNICAL_HANDOVER.md` §8 and the Infrastructure Ownership Register).
- **When configured:** *Back up now* runs `pg_dump`, verifies with `pg_restore --list`, records size, tables and SHA-256. History: Running (blue), Verified (green), Failed (red). Only verified backups whose checksum still matches can be downloaded. Configuration checks: storage, durability, writable, pg_dump, pg_restore, tool version, free space.
- **Not provided on this page:** automatic backups, retention/expiry, restore from the screen.
- **Scheduled off-site backups (prepared, not active):** encrypted daily database backups and private-document backups with 7 daily / 4 weekly / 12 monthly retention, verification, alerts and restore drills into isolated copies are prepared for the Hostinger server (`docs/BACKUP_AUTOMATION.md`). They are **not switched on** and have **not been run against production**; activation needs the owner's approval.
- A backup holds every record, including password hashes — store downloads securely.

---

## Settings

**Page:** `/settings` (*Settings: View*).

- **My settings:** profile (read only), theme, colour palette, sidebar style (kept in this browser), change password, sign out.
- **Organization:** company profile; **Holidays** — browse by year, *Add Oman holidays* (official list) or *Add holiday* (date, name, religious, countries, divisions); needs Settings Create/Edit/Delete; tax setup (read only).
- **System:** API and database status; Security Center and Backup & Restore for administrators. "No business settings are configurable yet."

---

## Integration review (2026-11-09)

This guide was written against `c6d8d19` and updated during the final local integration of P0, P1, P2 and P3 (branch `integration/stslv-amc-final-20261109`). Updated chapters: Getting started (sessions, password rules), Monthly Calendar (By service / By contract), Service Status (Service Report No. lock, counted services), Master AMC Status (Zoho columns in the export), AMC Renewal (contract expiry, Recycle Bin check), Reports (source-page permissions), Users and Roles (custom-role management by Super Admin and Admin, active sessions), Security Center (Active sessions), Backup status (prepared off-site backups).

**Approved but switched off until the approved production release:** contract expiry (`AMC_CONTRACT_EXPIRY_ENABLED`) and the Service Report No. lock (`SERVICE_REPORT_NO_LOCK_ENABLED`). This guide describes both; while they are off, contracts past validity stay Active and report numbers stay editable.

**At the release with migration 0108, every user signs in once more:** sign-ins made before it carry no server-side session and are refused.

The in-app Help (`stslv-web/src/help/helpTopics.ts`) mirrors these chapters and must be updated together.
