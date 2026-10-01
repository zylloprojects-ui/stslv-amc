# STSLV AMC — Phase 1 System Architecture and Database Design

| | |
|---|---|
| Status | **DRAFT — for review. Nothing in this document has been implemented.** |
| Date | 2026-10-01 |
| Basis | `CLAUDE.md` (project guardrails) and the confirmed STSLV AMC Phase 1 requirements |
| Scope | Design and documentation only. No migrations, tables, API endpoints or UI exist for anything described here. |

## How to read this document

Three markers are used throughout:

- **[RECOMMENDED]** — a technical design choice proposed by this document. It can be approved or changed at review without asking the client.
- **[PROVISIONAL]** — a working assumption that lets the design proceed, but which depends on a business rule the client has not confirmed. It must not be treated as final.
- **[UNRESOLVED — Qn]** — an open business question, listed in full in [Section 19](#19-unresolved-business-questions). The design deliberately avoids deciding it.

The client spreadsheets (`AMC - 2027`, `AMC INVOICING - 2027`, `Jobs List`) are **not present in the repository**. Everything said about them comes from the field lists recorded in `CLAUDE.md` Section 2. No spreadsheet column has been assumed beyond those lists.

## Contents

1. [Business architecture](#1-business-architecture)
2. [Proposed database entities](#2-proposed-database-entities)
3. [Common conventions for every table](#3-common-conventions-for-every-table)
4. [Client master](#4-client-master)
5. [AMC contract model](#5-amc-contract-model)
6. [AMC schedule generation](#6-amc-schedule-generation)
7. [Project / job model](#7-project--job-model)
8. [Procurement](#8-procurement)
9. [Expenses](#9-expenses)
10. [Invoice architecture](#10-invoice-architecture)
11. [Attachments](#11-attachments)
12. [Users, roles and permissions](#12-users-roles-and-permissions)
13. [Audit log](#13-audit-log)
14. [Status design](#14-status-design)
15. [Financial calculation map](#15-financial-calculation-map)
16. [Dashboard data sources](#16-dashboard-data-sources)
17. [Relationship diagram](#17-relationship-diagram)
18. [Excel migration mapping](#18-excel-migration-mapping)
19. [Unresolved business questions](#19-unresolved-business-questions)
20. [Implementation order](#20-implementation-order)

---

## 1. Business architecture

### 1.1 Operational flow

```
                              CLIENT MASTER
                                    │
            ┌───────────────────────┴────────────────────────┐
            │                                                │
      AMC CONTRACTS                                  PROJECTS / JOBS
   (client, system, validity,                    (job number, client, LPO,
    frequency, cost per visit)                    job value, VAT, budget)
            │                                                │
            ▼                                                ▼
      AMC SCHEDULE                                     PROCUREMENT
   (date-based visit records,                    (requirement, supplier,
    generated from the contract)                  quotation, order, delivery)
            │                                                │
            ▼                                                ▼
      AMC EXECUTION                                  SITE EXECUTION
   (status, completion date, notes)                (project status and dates)
            │                                                │
            ▼                                                ▼
      VISIT COMPLETED                                    EXPENSES
            │                                    (costs recorded against the job)
            ▼                                                │
     READY FOR INVOICE                                       ▼
            │                                            COMPLETED
            ▼                                                │
   ZOHO INVOICE REFERENCE                                    ▼
   (invoice raised in Zoho,                          READY FOR INVOICE
    details entered here)                                    │
            │                                                ▼
            ▼                                    ZOHO INVOICE REFERENCE(S)
        INVOICED                                 (one project → many invoices)
                                                             │
                                                             ▼
                                                  JOB FINANCIAL SUMMARY
                                               (job value, recorded cost,
                                                invoiced value, margin)
                                                             │
                                                             ▼
                                                          CLOSED
```

Zoho remains the system that generates invoices. STSLV AMC records the Zoho invoice number, date, amount and status against the AMC visit or project it covers.

### 1.2 Cross-cutting services

```
┌──────────────────────────────────────────────────────────────────────────┐
│ USERS + ROLES / PERMISSIONS                                              │
│ Every API request is authenticated and authorised in the backend.        │
│ Every business record stores who created it and who last changed it.     │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   CLIENTS ── AMC CONTRACTS ── AMC VISITS ──┐                             │
│      │                                     ├── INVOICE ALLOCATIONS ──    │
│      └────── PROJECTS ─────────────────────┘        INVOICES             │
│                 ├── PROCUREMENT REQUESTS                                 │
│                 └── PROJECT EXPENSES                                     │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ ATTACHMENTS                                                              │
│ Files sit in controlled file storage. PostgreSQL holds metadata and a    │
│ real foreign key to the owning record: project (LPO, documents),         │
│ procurement request (quotation), expense (receipt/bill), AMC contract,   │
│ AMC visit.                                                               │
├──────────────────────────────────────────────────────────────────────────┤
│ ACTIVITY / AUDIT LOG                                                     │
│ Append-only record of important operational and financial actions on     │
│ any of the entities above: who, what, when, before and after.            │
└──────────────────────────────────────────────────────────────────────────┘
```

| Concern | Where it fits |
|---|---|
| Users | Actors on every record (`created_by`, `updated_by`), assignees of AMC visits, responsible engineer on contracts, uploader of attachments, actor in the audit log. |
| Roles / permissions | Checked by backend middleware before a route handler runs. The frontend hides what a user cannot do, but the backend is the enforcement point. |
| Attachments | A shared table owned by exactly one business record through a real foreign key. Not a separate module with its own workflow. |
| Activity log | Written by the service layer in the same database transaction as the change it describes, so a change cannot be committed without its log entry. |

### 1.3 Design principles applied

1. **Enter once, reuse.** Client, contract, project and supplier data is referenced by key, never retyped.
2. **Date-based records, never month-based structures.** A visit is a row with dates. "January" is a filter, not a table or column.
3. **Workflow state is derived where it can be.** "Ready for invoice" and "invoiced" are computed from completion status and invoice allocations rather than stored a second time, so they cannot drift out of step with the facts.
4. **Unconfirmed rules are isolated.** Each unresolved rule sits behind one column, one lookup table or one service function, so confirming it later is a small change.
5. **Referential integrity is enforced by PostgreSQL**, not by convention.

---

## 2. Proposed database entities

### 2.1 Decision on each candidate

| Candidate | Decision | Reason |
|---|---|---|
| `users` | **Create** | Required for login, ownership and audit. |
| `roles` | **Create** | Five initial roles; stored as data so a role can be added without a schema change. |
| `role_permissions` | **Create** | Maps a role to permission codes. Lets the permission matrix be adjusted after business approval without redeploying code. |
| `permissions` (catalog table) | **Do not create** | The list of permission codes is defined by the code that checks them. A table would only duplicate that list. |
| `user_roles` | **Create** | In a small business one person often covers two functions (for example Accountant and Invoicing). A join table supports one or many roles per user at the cost of one small table. |
| `clients` | **Create** | Client master. |
| `client_contacts` | **Do not create** | One primary contact on the client row is enough for Phase 1. No CRM. |
| `system_types` | **Create** (small lookup) | The schedule must be filterable by system. Filtering free text is unreliable. |
| `amc_contracts` | **Create** | Core entity. |
| `amc_contract_systems` | **Do not create yet** | Only justified if one contract covers several systems with different frequency or price. Not confirmed — **[UNRESOLVED — Q15]**. |
| `amc_visits` | **Create** | The schedule. One row per generated visit. |
| `amc_execution` | **Do not create** | Phase 1 execution is status, completion date and notes — a 1:1 extension of the visit. These live on `amc_visits`. A separate table becomes justified only if detailed execution fields or checklists are approved **[UNRESOLVED — Q13]**. |
| `projects` | **Create** | Core entity. |
| `number_sequences` | **Create** | Holds the configurable counter for Job Numbers, so the format is data and not code. |
| `suppliers` | **Create — pending scope approval** | Supplier appears in both procurement and expenses. A minimal master avoids duplicate spellings. It is not named in the Phase 1 scope list, so it needs explicit approval **[UNRESOLVED — Q16]**. Fallback: a free-text `supplier_name` column. |
| `procurement_requests` | **Create** | One row per procurement requirement on a project. |
| `procurement_quotations` | **Do not create yet** | The Phase 1 field list describes one supplier and one quotation per requirement. A second table is justified only if the client compares several quotations per requirement **[UNRESOLVED — Q17]**. See [Section 8](#8-procurement). |
| `expense_categories` | **Create** (small lookup) | The category list in the requirements is given as examples, so it must be editable. |
| `project_expenses` | **Create** | Core entity for job cost. |
| `payments` (parent of expenses) | **Do not create** | Would encode a split-payment rule that is not confirmed **[UNRESOLVED — Q9]**. |
| `invoices` | **Create** | One row per Zoho invoice. |
| `invoice_allocations` | **Create** | Links an invoice to the AMC visits or projects it covers, with an amount. See [Section 10](#10-invoice-architecture). |
| `attachments` | **Create** | File metadata. |
| `activity_logs` | **Create** | Audit trail. |
| `app_settings` | **Create** (small key/value) | Holds configurable values such as the default VAT rate, so they are not hard-coded. |
| Month tables or month columns | **Never** | Prohibited by `CLAUDE.md`. |
| Status history tables | **Do not create** | Status changes are recorded in `activity_logs`. |

### 2.2 Resulting Phase 1 model — 19 tables

| Group | Tables |
|---|---|
| Access | `users`, `roles`, `user_roles`, `role_permissions` |
| Configuration | `app_settings`, `number_sequences`, `system_types`, `expense_categories` |
| Masters | `clients`, `suppliers` |
| AMC | `amc_contracts`, `amc_visits` |
| Projects | `projects`, `procurement_requests`, `project_expenses` |
| Invoicing | `invoices`, `invoice_allocations` |
| Cross-cutting | `attachments`, `activity_logs` |

Full column definitions are in Sections 4 to 13.

---

## 3. Common conventions for every table

These apply to every table below and are not repeated in each table definition.

### 3.1 Identifier strategy — [RECOMMENDED]

- **Internal primary key:** `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` on every table (except `app_settings` and `number_sequences`, which use a natural text key, and pure join tables, which use a composite key).
- **Business references are separate columns**, never the primary key: `client_code`, `contract_number`, `job_number`, `invoice_number`. Each has its own `UNIQUE` constraint.

Why this and not UUIDs:

- The system is a single PostgreSQL database behind one API. Nothing generates IDs offline or merges data from several databases, which is the main reason to choose UUIDs.
- `bigint` keys are smaller and faster in indexes and joins, and are easy to read when supporting users.
- Keeping business references out of the primary key means the Job Number format can change after client confirmation without touching any foreign key.
- Sequential IDs in URLs reveal record counts but nothing else, because every route is authorised in the backend. If that becomes a concern, an opaque public identifier can be added as an extra column later without redesign.

### 3.2 Data types — [RECOMMENDED]

| Kind of value | Type | Note |
|---|---|---|
| Money | `numeric(14,2)` | Exact decimal. Never `real`, `double precision` or `money`. |
| Percentage rate | `numeric(5,2)` | Example: `5.00` means 5%. |
| Business date (contract start, invoice date, expense date) | `date` | A calendar day with no time zone, exactly as it appears on a document. |
| Point in time (created, completed-at, logged) | `timestamptz` | Stored in UTC, displayed in the business time zone. |
| Short status or code | `text` with a `CHECK` constraint | Chosen over PostgreSQL `ENUM` types because adding or renaming a value in a `CHECK` is a simple reviewable migration, and several status lists are not yet confirmed. |
| Client-editable list | Lookup table with a foreign key | Used where the business will add values themselves (`system_types`, `expense_categories`). |
| Free text | `text` | Length limits are enforced by API validation. |

Currency: the design assumes **one operating currency** and stores no currency column. This is a working assumption **[PROVISIONAL — Q18]**.

### 3.3 Standard columns

| Column | Type | Applies to |
|---|---|---|
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | All tables. |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | All tables whose rows can change. Maintained by one shared `BEFORE UPDATE` trigger function so it cannot be forgotten. Not present on `activity_logs` (append-only) or pure join tables. |
| `created_by` | `bigint NULL REFERENCES users(id)` | All business tables. Null only for seeded or migrated rows. |
| `updated_by` | `bigint NULL REFERENCES users(id)` | All editable business tables. |

### 3.4 Deletion and integrity rules — [RECOMMENDED]

- All foreign keys use `ON DELETE RESTRICT`. Nothing cascades.
- Business records are **not hard-deleted**. Masters are deactivated (`is_active = false`); operational records are cancelled through their status; expenses are voided; attachments are soft-deleted.
- The only rows the application may physically delete are generated AMC visits that have never been touched, and only during controlled schedule regeneration (see [Section 6.5](#65-editing-a-contract-after-visits-exist)).
- Every foreign key column gets an index. PostgreSQL does not create these automatically.
- Naming: `snake_case`, plural table names, foreign keys named `<entity>_id`, constraints named `<table>_<columns>_<pk|fk|uq|ck>`.

---

## 4. Client master

### 4.1 `clients`

**Purpose:** one reusable record per client, referenced by AMC contracts, projects and invoices, and the grouping key for client-level reporting.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `client_code` | `text` | No | Short business code. Unique. Generation rule is **[PROVISIONAL — Q19]**: suggested by the system, editable by Admin. |
| `name` | `text` | No | Display name used across the application. |
| `legal_name` | `text` | Yes | Full legal name where it differs from the display name. |
| `contact_person` | `text` | Yes | Primary contact. |
| `phone` | `text` | Yes | |
| `email` | `text` | Yes | |
| `address` | `text` | Yes | Single free-text address block. Structured address fields are not needed in Phase 1. |
| `is_active` | `boolean` | No | Default `true`. Inactive clients cannot be selected on new contracts or projects but remain on existing records. |
| `notes` | `text` | Yes | |
| standard columns | | | `created_at`, `updated_at`, `created_by`, `updated_by`. |

- **Primary key:** `id`
- **Foreign keys:** `created_by`, `updated_by` → `users(id)`
- **Unique:** `client_code`; a unique index on `lower(btrim(name))` so "ABC Trading" and "abc trading " cannot both exist.
- **Check:** `btrim(name) <> ''`; `btrim(client_code) <> ''`.
- **Indexes:** the two unique indexes above; `(is_active)` is not needed at this volume.

### 4.2 How this avoids duplicated client names

- `amc_contracts.client_id`, `projects.client_id` and `invoices.client_id` are all `NOT NULL` foreign keys. No table stores a client name as text.
- AMC visits reach their client through the contract; procurement and expenses reach it through the project. The name is stored once.
- Reporting groups by `client_id`.

### 4.3 Deliberately left out

Tax registration number, Zoho customer reference, multiple contacts and multiple addresses are **not included** because they are not in the confirmed requirements. Each can be added later as a nullable column without affecting existing data.

---

## 5. AMC contract model

### 5.1 `system_types`

**Purpose:** controlled list of maintained system types, so contracts and the schedule can be filtered reliably by system.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `name` | `text` | No | Unique on `lower(btrim(name))`. |
| `is_active` | `boolean` | No | Default `true`. |
| `created_at`, `updated_at` | `timestamptz` | No | |

The actual list of system types must come from the client's `AMC - 2027` data. It cannot be seeded until the spreadsheet is supplied again.

### 5.2 `amc_contracts`

**Purpose:** one AMC agreement with a client for a system over a validity period. The source from which the visit schedule is generated.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `contract_number` | `text` | Yes | Business reference if the client uses one. Unique when present. The existing spreadsheet only has a serial number, so this is **[PROVISIONAL — Q19]**. |
| `client_id` | `bigint` | No | FK → `clients(id)`. |
| `system_type_id` | `bigint` | No | FK → `system_types(id)`. One system type per contract in Phase 1 **[PROVISIONAL — Q15]**. |
| `description` | `text` | Yes | Free-text system or scope description from the contract. |
| `responsible_user_id` | `bigint` | Yes | FK → `users(id)`. Responsible engineer or person. **[PROVISIONAL — Q20]**: assumes responsible engineers are system users, so that execution users can see their own work. |
| `start_date` | `date` | No | Contract validity from. |
| `end_date` | `date` | No | Contract validity to. |
| `maintenance_frequency` | `text` | Yes | `monthly`, `quarterly`, `semi_annual`, `annual`. Option list is **[UNRESOLVED — Q2]**. Null allowed only in `draft`. |
| `cost_per_visit` | `numeric(14,2)` | Yes | Null allowed only in `draft`. |
| `contract_value` | `numeric(14,2)` | No | Total contract value as agreed. |
| `final_agreed_value` | `numeric(14,2)` | Yes | Holds the spreadsheet's "Final Credit" figure. **Meaning is [UNRESOLVED — Q1]. It is stored as entered and used in no calculation, report total or validation until the client confirms what it is.** |
| `status` | `text` | No | Default `draft`. See [Section 14](#14-status-design). |
| `notes` | `text` | Yes | |
| standard columns | | | `created_at`, `updated_at`, `created_by`, `updated_by`. |

- **Primary key:** `id`
- **Foreign keys:** `client_id` → `clients`; `system_type_id` → `system_types`; `responsible_user_id`, `created_by`, `updated_by` → `users`.
- **Unique:** `contract_number` (partial unique index `WHERE contract_number IS NOT NULL`).
- **Check constraints:**
  - `end_date >= start_date`
  - `contract_value >= 0`; `cost_per_visit IS NULL OR cost_per_visit >= 0`; `final_agreed_value IS NULL OR final_agreed_value >= 0`
  - `maintenance_frequency` is null or one of the allowed codes
  - `status` is one of the allowed codes
  - `status = 'draft' OR (maintenance_frequency IS NOT NULL AND cost_per_visit IS NOT NULL)` — a contract cannot become active without the two fields the schedule and billing depend on.
- **Indexes:** `(client_id)`, `(system_type_id)`, `(responsible_user_id)`, `(status)`, `(end_date)` for expiry reporting.

The maximum contract length ("up to 5 years") is enforced by API validation against a value in `app_settings`, not by a database constraint, because the limit is described as potential rather than fixed.

### 5.3 Why draft status allows incomplete data

The existing spreadsheet has no maintenance frequency or cost per visit — these were requested as new fields. Migrated contracts will therefore arrive incomplete. They are imported as `draft`, completed by a user, and only then activated. Activation is what generates the schedule.

### 5.4 Maintenance frequency versus billing frequency

The design does **not** assume the two are the same **[UNRESOLVED — Q3]**.

- `maintenance_frequency` drives visit generation only. It has no role in invoicing.
- Invoices are linked to visits through `invoice_allocations` ([Section 10](#10-invoice-architecture)), and one invoice can cover several visits. Billing quarterly for monthly visits therefore needs **no schema change**: one invoice, three allocations.
- If the client bills on a schedule that does not line up with visits at all (for example monthly billing for quarterly maintenance), two additive changes cover it: a nullable `billing_frequency` column on `amc_contracts`, and a nullable `amc_contract_id` target on `invoice_allocations`. Neither alters existing rows.

No `billing_frequency` column is created now, because creating it would imply a rule nobody has confirmed.

### 5.5 How a multi-year contract becomes visit records

A contract is one row. Activating it generates one `amc_visits` row for every maintenance occurrence between `start_date` and `end_date`. A 5-year monthly contract produces 60 rows; a 5-year annual contract produces 5. No month columns exist anywhere. The algorithm is described in [Section 6](#6-amc-schedule-generation).

Renewal is treated as a **new contract row** rather than an extension of the old one, which keeps each validity period and its value separate **[PROVISIONAL — Q4]**.

---

## 6. AMC schedule generation

**Design only. Not implemented.**

### 6.1 `amc_visits`

**Purpose:** one scheduled maintenance occurrence under a contract. Carries the schedule, the execution outcome and the billable amount. This is the record the invoice workflow attaches to.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `amc_contract_id` | `bigint` | No | FK → `amc_contracts(id)`. |
| `sequence_no` | `integer` | No | Running number within the contract. Never reused. |
| `period_start` | `date` | No | First day of the maintenance period this visit covers. |
| `period_end` | `date` | No | Last day of that period. |
| `original_scheduled_date` | `date` | No | Date assigned at generation. Never changed afterwards. |
| `scheduled_date` | `date` | No | Current planned date. Equals `original_scheduled_date` until rescheduled. |
| `assigned_user_id` | `bigint` | Yes | FK → `users(id)`. Defaults from the contract's responsible user. |
| `status` | `text` | No | Default `scheduled`. See [Section 14](#14-status-design). |
| `visit_amount` | `numeric(14,2)` | Yes | Copy of the contract's `cost_per_visit` taken at generation. See 6.6. |
| `completed_date` | `date` | Yes | Date the work was completed. |
| `completed_by` | `bigint` | Yes | FK → `users(id)`. Who marked it completed. |
| `execution_notes` | `text` | Yes | |
| `cancellation_reason` | `text` | Yes | |
| `created_at`, `updated_at`, `updated_by` | | | Standard. |

- **Primary key:** `id`
- **Foreign keys:** `amc_contract_id` → `amc_contracts`; `assigned_user_id`, `completed_by`, `updated_by` → `users`.
- **Unique:**
  - `(amc_contract_id, sequence_no)`
  - partial unique index on `(amc_contract_id, period_start) WHERE status <> 'cancelled'` — the guard against duplicate generation.
- **Check constraints:**
  - `period_end >= period_start`
  - `status` is one of the allowed codes
  - `status <> 'completed' OR completed_date IS NOT NULL`
  - `visit_amount IS NULL OR visit_amount >= 0`
- **Indexes:** `(scheduled_date)`; `(status, scheduled_date)` for the monthly view and dashboard; `(assigned_user_id, scheduled_date)` for "my work"; `(amc_contract_id)` is covered by the unique indexes.

### 6.2 Algorithm

```
Contract (start_date, end_date, maintenance_frequency)
        │
        ▼
interval_months = 1 (monthly) | 3 (quarterly) | 6 (semi-annual) | 12 (annual)
        │
        ▼
for k = 0, 1, 2, ...
    period_start = start_date + (k × interval_months) months
    stop when period_start > end_date
    period_end   = (start_date + ((k+1) × interval_months) months) − 1 day,
                   capped at end_date
    scheduled_date = period_start                      [PROVISIONAL — Q4]
        │
        ▼
one amc_visits row per k
```

| Frequency | Interval | Visits in a 1-year contract | Visits in a 5-year contract |
|---|---|---|---|
| Monthly | 1 month | 12 | 60 |
| Quarterly | 3 months | 4 | 20 |
| Semi-annual | 6 months | 2 | 10 |
| Annual | 12 months | 1 | 5 |

**These four options are conceptual. The actual list requires client confirmation [UNRESOLVED — Q2].** If the client uses a frequency that is not a whole number of months, the algorithm needs a different interval unit.

### 6.3 How visits receive dates

- Each period start is calculated **from the contract start date**, not from the previous visit. Adding one month repeatedly drifts: 31 January → 28 February → 28 March. Calculating from the anchor gives 31 January → 28 February → 31 March.
- `original_scheduled_date` and `scheduled_date` are both set to `period_start` at generation.
- Open points that the client must decide **[UNRESOLVED — Q4]**:
  - Whether the visit falls at the start, middle or end of its period, or on a date the user chooses.
  - Whether a short final period (contract ends mid-period) still produces a visit.
  - Whether weekends and public holidays shift the date.

### 6.4 Preventing duplicate generation

Four layers, so a double-click, a retried request or two users acting at once cannot create duplicates:

1. Generation runs when a contract moves from `draft` to `active`, inside **one transaction**.
2. The transaction first locks the contract row (`SELECT ... FOR UPDATE`), so two generations for the same contract cannot run at the same time.
3. Rows are inserted with `ON CONFLICT DO NOTHING`, making the operation safe to repeat.
4. The partial unique index on `(amc_contract_id, period_start)` rejects a duplicate period at the database level even if application logic is wrong.

### 6.5 Editing a contract after visits exist

A visit is **locked** if any of these is true:

- its status is `in_progress`, `completed` or `cancelled`
- it has an invoice allocation
- it has been manually rescheduled (`scheduled_date <> original_scheduled_date`)
- it has execution notes or attachments

All other visits are **open**: still `scheduled` and exactly as generated.

Proposed behaviour when contract dates or frequency are edited — **[PROVISIONAL — Q4]**:

| Change | Open visits | Locked visits |
|---|---|---|
| End date extended | New visits are generated for the added period. | Unchanged. |
| End date shortened | Open visits after the new end date are removed. | Unchanged. Any locked visit beyond the new end date is reported to the user and the edit is blocked until it is dealt with. |
| Frequency changed | Open visits from today onward are removed and regenerated at the new frequency. | Unchanged. |
| Start date changed | Blocked once any visit is locked. | Unchanged. |
| `cost_per_visit` changed | See 6.6. | Unchanged. |

The user is always shown a **preview** of what will be added, removed and kept before confirming. Every regeneration writes an `activity_logs` entry listing the affected visits.

Who may edit an active contract, and whether a mid-term change should instead be a new contract, is a business rule and is not decided here.

### 6.6 Why completed visits must not silently change

- A completed visit records that work was done on a date. It may already have been invoiced in Zoho for a specific amount. If a later contract edit moved its date, changed its amount or removed it, STSLV AMC would disagree with the invoice the client already issued.
- "Ready for invoice" and "uninvoiced" figures are calculated from completed visits. Changing them retroactively would change reported totals without anyone having taken an action.
- For this reason `visit_amount` is a **snapshot** copied from the contract at generation. This is a deliberate exception to the rule against storing derived values: the amount billable for a visit must not move when the contract is edited later. Whether a change to `cost_per_visit` should update open future visits is **[UNRESOLVED — Q4]**; it never updates locked ones.

### 6.7 Rescheduling

The model supports rescheduling without deciding the rules:

- Changing `scheduled_date` while keeping `original_scheduled_date` preserves both the plan and the change.
- The change, the user and the reason are recorded in `activity_logs`.
- "Overdue" is not a stored status. It is derived: `status = 'scheduled' AND scheduled_date < current date`.

Not decided **[UNRESOLVED — Q4]**: whether a visit may be moved outside its period, whether a reason is mandatory, who may reschedule, whether a postponed visit shifts later visits, and whether a missed visit is skipped or carried forward.

### 6.8 Why visits are stored rows and not calculated on demand

A visit must carry a status, a completion date, notes, attachments and an invoice link. Those need a row to attach to. The volume is trivial: a 5-year monthly contract is 60 rows.

---

## 7. Project / job model

### 7.1 `projects`

**Purpose:** one job for a client. The anchor for procurement, expenses, invoices and the job financial summary.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. Internal. Used by all foreign keys. |
| `job_number` | `text` | No | Business Job Number. Unique. Format is **[UNRESOLVED — Q6]**. |
| `client_id` | `bigint` | No | FK → `clients(id)`. |
| `description` | `text` | No | Project / job description. |
| `job_date` | `date` | No | Business date the job was opened. Defaults to today. Source for the "month" shown in the existing Jobs List. |
| `lpo_number` | `text` | Yes | |
| `lpo_date` | `date` | Yes | |
| `job_value` | `numeric(14,2)` | No | Job / LPO value **excluding VAT**. |
| `vat_rate` | `numeric(5,2)` | Yes | Rate applied to this job, copied from settings at creation. Null where VAT does not apply or the rate is unknown (migrated data). |
| `vat_amount` | `numeric(14,2)` | No | Default `0`. |
| `grand_value` | `numeric(14,2)` | No | **Generated column:** `job_value + vat_amount`. Cannot be edited and cannot disagree with its parts. |
| `budget_amount` | `numeric(14,2)` | Yes | Planned cost budget. |
| `status` | `text` | No | Default `new`. See [Section 14](#14-status-design). |
| `expected_completion_date` | `date` | Yes | |
| `completed_date` | `date` | Yes | |
| `closed_date` | `date` | Yes | |
| `notes` | `text` | Yes | |
| standard columns | | | `created_at`, `updated_at`, `created_by`, `updated_by`. |

- **Primary key:** `id`
- **Foreign keys:** `client_id` → `clients`; `created_by`, `updated_by` → `users`.
- **Unique:** `job_number`.
- **Check constraints:**
  - `job_value >= 0`, `vat_amount >= 0`, `budget_amount IS NULL OR budget_amount >= 0`
  - `vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100)`
  - `status` is one of the allowed codes
  - `status NOT IN ('completed','closed') OR completed_date IS NOT NULL`
  - `btrim(job_number) <> ''`
- **Indexes:** `(client_id)`, `(status)`, `(job_date)`, `(lpo_number)` for lookup by LPO.

There is **no `invoice_number` column** on `projects`. Invoices relate to projects through `invoice_allocations`, so a project can have any number of invoices.

Site execution in Phase 1 is represented by the project status and its dates. Detailed site execution fields are **[UNRESOLVED — Q13]** and no columns are invented for them.

### 7.2 Job Number generation — configurable, not hard-coded

`job_number` is plain unique text. The database does not know or enforce the `GPSA0521` pattern. The format lives in configuration.

#### `number_sequences`

**Purpose:** a configurable, gap-free counter for business numbers.

| Column | Type | Null | Notes |
|---|---|---|---|
| `sequence_key` | `text` | No | Primary key. Example: `job_number`. |
| `prefix` | `text` | No | Default empty string. |
| `next_number` | `bigint` | No | Next value to issue. `CHECK (next_number > 0)`. |
| `pad_length` | `smallint` | No | Zero-padding width. `CHECK (pad_length BETWEEN 0 AND 12)`. |
| `updated_at` | `timestamptz` | No | |

How it would work:

1. One service function, `generateJobNumber`, is the only code that produces a Job Number.
2. Inside the same transaction that inserts the project, it locks the sequence row (`SELECT ... FOR UPDATE`), builds the number from `prefix` and the padded `next_number`, and increments the counter.
3. If the project insert fails, the transaction rolls back and the number is not consumed. A plain PostgreSQL `SEQUENCE` is not used because it leaves gaps on rollback.
4. The `UNIQUE` constraint on `job_number` is the final safeguard.

If the confirmed rule turns out to include a year, a client code or a reset period, only this one function and this one table's columns change. Legacy job numbers are imported exactly as they appear, and the counter is then set above the highest imported value.

**The prefix, padding and starting number must not be seeded until the client confirms the rule [UNRESOLVED — Q6].**

---

## 8. Procurement

### 8.1 Flow

```
PROJECT
   │
   └──< PROCUREMENT REQUEST            one row per requirement
            requirement                 "what is needed"
            supplier                    → suppliers
            quotation reference/amount  + quotation file in attachments
            PO reference / PO date      order information
            expected / actual delivery
            status
            remarks
```

### 8.2 `suppliers` — pending scope approval [UNRESOLVED — Q16]

**Purpose:** minimal supplier list shared by procurement and expenses, so the same supplier is not typed in different ways.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `name` | `text` | No | Unique on `lower(btrim(name))`. |
| `contact_person` | `text` | Yes | |
| `phone` | `text` | Yes | |
| `email` | `text` | Yes | |
| `is_active` | `boolean` | No | Default `true`. |
| `notes` | `text` | Yes | |
| standard columns | | | |

This is a pick-list, not a supplier management module: no supplier portal, pricing, ratings or approval. If it is not approved, `supplier_id` in the two tables below is replaced by a free-text `supplier_name text` column.

### 8.3 `procurement_requests`

**Purpose:** one procurement requirement for a project, tracked from request to delivery.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `project_id` | `bigint` | No | FK → `projects(id)`. Every procurement record belongs to a job. |
| `requirement` | `text` | No | What is needed. |
| `supplier_id` | `bigint` | Yes | FK → `suppliers(id)`. Null until a supplier is identified. |
| `quotation_reference` | `text` | Yes | |
| `quotation_date` | `date` | Yes | |
| `quotation_amount` | `numeric(14,2)` | Yes | |
| `po_reference` | `text` | Yes | Order / PO reference where applicable. |
| `po_date` | `date` | Yes | |
| `expected_delivery_date` | `date` | Yes | |
| `delivered_date` | `date` | Yes | |
| `status` | `text` | No | Default `requested`. See [Section 14](#14-status-design). |
| `remarks` | `text` | Yes | |
| standard columns | | | |

- **Primary key:** `id`
- **Foreign keys:** `project_id` → `projects`; `supplier_id` → `suppliers`; `created_by`, `updated_by` → `users`.
- **Unique:** `(project_id, id)` — redundant for uniqueness, but it lets `project_expenses` reference a procurement request with a composite foreign key that guarantees both belong to the same project.
- **Check constraints:** `quotation_amount IS NULL OR quotation_amount >= 0`; `status` is one of the allowed codes; `status <> 'delivered' OR delivered_date IS NOT NULL`.
- **Indexes:** `(project_id)`, `(supplier_id)`, `(status)`, `(expected_delivery_date)`.

The quotation file is stored through `attachments` with `document_type = 'quotation'`. A request can hold several attachment files.

### 8.4 One table or two?

**Recommendation: one table in Phase 1.**

The confirmed field list describes a single supplier, quotation reference and quotation amount per procurement record. One table matches that exactly and gives the simplest screen: one row, one form.

A separate `procurement_quotations` table would be justified only if the client records **several competing quotations for the same requirement** and needs to compare amounts and mark one as selected **[UNRESOLVED — Q17]**. The shape would then be:

```
procurement_requests   (project, requirement, status, PO, delivery)
        └──< procurement_quotations   (supplier, reference, date, amount, is_selected)
```

Moving to that later is a straightforward, non-destructive migration: each existing row becomes one request plus one selected quotation. Until then, additional quotation documents can be attached as files to the single row.

### 8.5 Procurement is not job cost

A quotation amount or PO is a commitment, not a recorded cost. **Job cost comes only from `project_expenses`.** A procurement request can be linked to the expense that pays for it ([Section 9](#9-expenses)), which gives traceability from requirement to quotation to payment without counting the amount twice.

No approval chain is designed **[UNRESOLVED — Q12]**.

---

## 9. Expenses

### 9.1 `expense_categories`

**Purpose:** editable list of expense categories.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `code` | `text` | No | Unique. Stable key for reports. |
| `name` | `text` | No | Display label. |
| `is_active` | `boolean` | No | Default `true`. |
| `created_at`, `updated_at` | | | |

Proposed initial values, taken from the requirement examples and subject to client confirmation: materials, transport, inspection, labour, supplier payment, bills, other.

### 9.2 `project_expenses`

**Purpose:** one recorded cost against one project. The only source of job cost.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `project_id` | `bigint` | No | FK → `projects(id)`. **Not nullable**: an expense cannot be saved without a job. |
| `expense_date` | `date` | No | |
| `expense_category_id` | `bigint` | No | FK → `expense_categories(id)`. |
| `supplier_id` | `bigint` | Yes | FK → `suppliers(id)`. |
| `payee_name` | `text` | Yes | Used when the payee is not a supplier (for example labour). |
| `amount` | `numeric(14,2)` | No | Whether this is inclusive or exclusive of VAT is **[UNRESOLVED — Q11]**. |
| `description` | `text` | Yes | |
| `payment_reference` | `text` | Yes | Transfer, cheque or bill reference. Deliberately **not unique** — see 9.4. |
| `procurement_request_id` | `bigint` | Yes | Optional link to the procurement record this payment relates to. |
| `voided_at` | `timestamptz` | Yes | Set when the expense is voided. |
| `voided_by` | `bigint` | Yes | FK → `users(id)`. |
| `void_reason` | `text` | Yes | |
| `created_by` | `bigint` | **No** | FK → `users(id)`. Required here: every expense must show who recorded it. |
| `created_at`, `updated_at`, `updated_by` | | | Standard. |

- **Primary key:** `id`
- **Foreign keys:** `project_id` → `projects`; `expense_category_id` → `expense_categories`; `supplier_id` → `suppliers`; `(project_id, procurement_request_id)` → `procurement_requests(project_id, id)`; user columns → `users`.
- **Check constraints:**
  - `amount > 0`
  - `(voided_at IS NULL) = (voided_by IS NULL)`
  - `voided_at IS NULL OR btrim(void_reason) <> ''`
- **Indexes:** `(project_id) WHERE voided_at IS NULL` for cost totals; `(expense_date)`; `(expense_category_id)`; `(supplier_id)`; `(payment_reference)`.

The receipt or bill is stored through `attachments` with `document_type` `receipt` or `bill`.

### 9.3 How expenses contribute to job cost

```
Total Recorded Cost (project) = SUM(project_expenses.amount)
                                WHERE project_id = :project
                                  AND voided_at IS NULL
```

The total is always calculated, never stored on `projects`. Expenses are voided rather than deleted, so a figure that once appeared in a report can always be explained.

### 9.4 Split payments — [UNRESOLVED — Q9]

**No rule is designed for one payment covering several jobs.** What the model does and does not do:

- One row is one amount on one project.
- `payment_reference` is not unique, so the model neither forbids nor defines the same reference appearing on rows for different projects.
- The database does **not** check that rows sharing a reference add up to anything, because there is no confirmed rule to check against.
- If the client confirms that split allocation is needed, the additive path is a `payments` parent table (one row per transfer, with its total) and a `payment_id` on `project_expenses`, with a rule that allocations must equal the payment total.

### 9.5 Unallocated transfers — related open point

The client named unidentified and unallocated transfers as a current problem. Making `project_id` mandatory prevents new unattributed costs from entering this table. It does **not** provide a place to record a payment whose job is not yet known. Whether the client wants such a holding list, and who clears it, is part of **Q9**.

---

## 10. Invoice architecture

Zoho generates the invoice. STSLV AMC records it and links it to the work it covers. **No Zoho API integration is part of this design.**

### 10.1 `invoices`

**Purpose:** one row per invoice issued in Zoho. A reference record, not an accounting document.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `invoice_number` | `text` | No | Zoho invoice number. Unique. |
| `client_id` | `bigint` | No | FK → `clients(id)`. The client the invoice was issued to. |
| `invoice_date` | `date` | No | |
| `net_amount` | `numeric(14,2)` | No | Invoice value excluding VAT. |
| `vat_amount` | `numeric(14,2)` | No | Default `0`. |
| `total_amount` | `numeric(14,2)` | No | **Generated column:** `net_amount + vat_amount`. |
| `status` | `text` | No | Default `issued`. See [Section 14](#14-status-design). |
| `source` | `text` | No | Default `zoho`. Allows other sources later without redesign. |
| `source_reference` | `text` | Yes | Zoho internal ID or link, if the client wants it recorded. |
| `notes` | `text` | Yes | |
| standard columns | | | `created_by` records who entered the invoice. |

- **Primary key:** `id`
- **Foreign keys:** `client_id` → `clients`; `created_by`, `updated_by` → `users`.
- **Unique:** `invoice_number`.
- **Check constraints:** `net_amount >= 0`; `vat_amount >= 0`; `status` is one of the allowed codes; `btrim(invoice_number) <> ''`.
- **Indexes:** `(client_id)`, `(invoice_date)`, `(status)`.

Whether the client wants net, VAT and total recorded separately, or only one invoice figure, is **[UNRESOLVED — Q11]**. Storing net and VAT separately is recommended because job value is ex-VAT, and comparing an ex-VAT job value with a VAT-inclusive invoice amount would produce wrong "uninvoiced" figures.

### 10.2 `invoice_allocations`

**Purpose:** states which AMC visit or which project an invoice covers, and for how much.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `invoice_id` | `bigint` | No | FK → `invoices(id)`. |
| `project_id` | `bigint` | Yes | FK → `projects(id)`. |
| `amc_visit_id` | `bigint` | Yes | FK → `amc_visits(id)`. |
| `allocated_amount` | `numeric(14,2)` | No | Portion of the invoice's **net** amount covering this target. |
| `created_at`, `created_by` | | | Standard. |

- **Primary key:** `id`
- **Foreign keys:** `invoice_id` → `invoices`; `project_id` → `projects`; `amc_visit_id` → `amc_visits`; `created_by` → `users`.
- **Check constraints:**
  - `num_nonnulls(project_id, amc_visit_id) = 1` — every allocation points at exactly one target.
  - `allocated_amount > 0`
- **Unique:**
  - `(invoice_id, project_id) WHERE project_id IS NOT NULL`
  - `(invoice_id, amc_visit_id) WHERE amc_visit_id IS NOT NULL`
- **Indexes:** `(invoice_id)`; `(project_id) WHERE project_id IS NOT NULL`; `(amc_visit_id) WHERE amc_visit_id IS NOT NULL`.

Rules enforced by the service layer inside the write transaction (they span rows or tables, so a simple `CHECK` cannot express them):

| Rule | Status |
|---|---|
| Sum of allocations for an invoice ≤ the invoice `net_amount`. | [RECOMMENDED] |
| The allocated project or visit belongs to the same client as the invoice. | [RECOMMENDED] |
| An AMC visit can only be allocated once it is `completed`. | [PROVISIONAL — Q5] |
| An AMC visit has at most one non-cancelled invoice. | **[UNRESOLVED — Q5]** — not enforced until confirmed. |
| A project may be invoiced before it is completed (advance or progress invoices). | **[UNRESOLVED — Q21]** — the model permits it; the rule is not decided. |

### 10.3 Why this structure — three options compared

| Option | Shape | Referential integrity | Assessment |
|---|---|---|---|
| A. Polymorphic source | `invoices.source_type` + `invoices.source_id` | **None.** PostgreSQL cannot put a foreign key on a column that points at different tables. An ID can reference a row that does not exist or the wrong kind of row. One invoice can also cover only one thing. | **Rejected.** |
| B. One link table per target | `invoice_project_links`, `invoice_amc_visit_links` | Full foreign keys. | Sound, but the "how much of this invoice is allocated" check and every invoice-coverage query must combine two tables. |
| C. One allocation table with one nullable foreign key per target and a check that exactly one is set | `invoice_allocations` as above | Full foreign keys on every target. | **Recommended.** Same integrity as B, one place to total allocations, and a new target type is one added column plus an updated check. |

Option C is safer than a polymorphic relationship because **every link is a real foreign key**: a project or visit that has an allocation cannot be deleted, and an allocation cannot point at something that does not exist.

What this supports:

- **AMC Visit → Invoice:** one allocation row.
- **Project → Invoices:** any number of allocation rows for the same project, each on a different invoice.
- **One invoice covering several visits** (for example quarterly billing of monthly visits): several allocation rows on one invoice.
- **One invoice covering several projects:** possible in the model; whether the client does this is not assumed.

### 10.4 Derived billing state

Billing state is **calculated**, not stored, so it cannot disagree with the invoice records.

"Active allocation" below means an allocation whose invoice status is not `cancelled`.

| Subject | State | Definition |
|---|---|---|
| AMC visit | Not billable yet | `status` is `scheduled`, `in_progress` or `cancelled`. |
| AMC visit | **Ready for invoice** | `status = 'completed'` and no active allocation. |
| AMC visit | **Invoiced** | `status = 'completed'` and at least one active allocation. |
| Project | Invoiced value | Sum of active `allocated_amount` for the project. |
| Project | Uninvoiced value | `job_value` − invoiced value. |
| Project | **Ready for invoice** | `status = 'completed'` and uninvoiced value > 0. **[PROVISIONAL — Q21]** |
| Project | **Fully invoiced** | Uninvoiced value ≤ 0. **[PROVISIONAL — Q21]** |

Two database views, `v_amc_visit_billing` and `v_project_billing`, would hold these definitions so that the dashboard, lists and reports all use the same one.

If the client requires an explicit "release for invoicing" step — a person confirming that completed work may be billed — it is added as `invoice_released_at` / `invoice_released_by` columns on the visit and project. That is an additive change **[UNRESOLVED — Q12]**.

### 10.5 How the model answers the required questions

These are illustrative queries to prove the model works. They are not implementation.

**Which invoices belong to this project?**
```sql
SELECT i.invoice_number, i.invoice_date, i.status, a.allocated_amount
FROM invoice_allocations a
JOIN invoices i ON i.id = a.invoice_id
WHERE a.project_id = :project_id
ORDER BY i.invoice_date;
```

**Which invoice covers this AMC visit?**
```sql
SELECT i.invoice_number, i.invoice_date, i.status, a.allocated_amount
FROM invoice_allocations a
JOIN invoices i ON i.id = a.invoice_id
WHERE a.amc_visit_id = :visit_id;
```

**What work is ready for invoice?** (AMC visits; the project version uses the definition in 10.4)
```sql
SELECT v.*
FROM amc_visits v
WHERE v.status = 'completed'
  AND NOT EXISTS (
        SELECT 1
        FROM invoice_allocations a
        JOIN invoices i ON i.id = a.invoice_id
        WHERE a.amc_visit_id = v.id
          AND i.status <> 'cancelled');
```

**What is still uninvoiced?** (projects)
```sql
SELECT p.job_number,
       p.job_value,
       COALESCE(SUM(a.allocated_amount) FILTER (WHERE i.status <> 'cancelled'), 0) AS invoiced_value,
       p.job_value
         - COALESCE(SUM(a.allocated_amount) FILTER (WHERE i.status <> 'cancelled'), 0) AS uninvoiced_value
FROM projects p
LEFT JOIN invoice_allocations a ON a.project_id = p.id
LEFT JOIN invoices i ON i.id = a.invoice_id
WHERE p.status <> 'cancelled'
GROUP BY p.id;
```

**Total invoiced value by project** — the `invoiced_value` column above.

**Total invoiced value by AMC contract and by client**
```sql
SELECT c.id AS client_id, c.name, ac.id AS amc_contract_id,
       SUM(a.allocated_amount) AS invoiced_value
FROM invoice_allocations a
JOIN invoices i       ON i.id = a.invoice_id AND i.status <> 'cancelled'
JOIN amc_visits v     ON v.id = a.amc_visit_id
JOIN amc_contracts ac ON ac.id = v.amc_contract_id
JOIN clients c        ON c.id = ac.client_id
GROUP BY c.id, c.name, ac.id;
```
Client-level totals across AMC and projects together come from `invoices.client_id` directly.

**Control report: invoices not fully allocated** — invoices where the sum of allocations is less than `net_amount`. This catches invoices entered but not linked to any work.

---

## 11. Attachments

### 11.1 `attachments`

**Purpose:** metadata for one stored file, owned by exactly one business record.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `project_id` | `bigint` | Yes | FK → `projects(id)`. LPO documents, general project documents. |
| `procurement_request_id` | `bigint` | Yes | FK → `procurement_requests(id)`. Quotations. |
| `project_expense_id` | `bigint` | Yes | FK → `project_expenses(id)`. Receipts and bills. |
| `amc_contract_id` | `bigint` | Yes | FK → `amc_contracts(id)`. Contract documents. |
| `amc_visit_id` | `bigint` | Yes | FK → `amc_visits(id)`. Visit documents, if required. |
| `document_type` | `text` | No | `quotation`, `lpo`, `receipt`, `bill`, `contract`, `other`. List is **[UNRESOLVED — Q14]**. |
| `storage_backend` | `text` | No | Default `local`. Later `s3` or similar. |
| `storage_key` | `text` | No | Server-generated path or object key. Unique. **Never derived from the uploaded filename.** |
| `original_filename` | `text` | No | Shown to users and used for the download name only. Never used to build a path. |
| `mime_type` | `text` | No | Determined by the server from the file content, not trusted from the browser. |
| `size_bytes` | `bigint` | No | |
| `checksum_sha256` | `text` | No | Integrity check and duplicate detection. |
| `description` | `text` | Yes | |
| `uploaded_by` | `bigint` | No | FK → `users(id)`. |
| `created_at` | `timestamptz` | No | Upload time. |
| `deleted_at` | `timestamptz` | Yes | Soft delete. |
| `deleted_by` | `bigint` | Yes | FK → `users(id)`. |

- **Primary key:** `id`
- **Foreign keys:** the five owner columns; `uploaded_by`, `deleted_by` → `users`.
- **Unique:** `storage_key`.
- **Check constraints:**
  - `num_nonnulls(project_id, procurement_request_id, project_expense_id, amc_contract_id, amc_visit_id) = 1`
  - `size_bytes > 0`
  - `document_type` and `storage_backend` are in their allowed lists
  - `(deleted_at IS NULL) = (deleted_by IS NULL)`
- **Indexes:** one partial index per owner column (`WHERE <column> IS NOT NULL`).
- **No `updated_at`:** a stored file is never modified. Replacing a document means uploading a new one and soft-deleting the old.

This uses the same pattern as `invoice_allocations` — real foreign keys with an "exactly one owner" check — in preference to an `entity_type` / `entity_id` pair, which PostgreSQL cannot protect.

### 11.2 Storage design

```
Browser ──upload──► API ──► validate (size, type by content, permission on the owner record)
                              │
                              ├──► write file to controlled storage under a server-generated key
                              │       e.g.  <storage root>/2026/10/<random id>
                              │
                              └──► insert attachments row (same request; file removed if the insert fails)

Browser ──download──► API ──► check permission on the owner record ──► stream file
```

- The file binary is **never stored in PostgreSQL**. The database holds metadata and the storage key only.
- The storage root is outside the web server's public folder and outside the source tree. Files are served only through an authorised API route.
- The code talks to storage through one small interface (`put`, `get`, `delete`). Phase 1 implements it on the local or server disk. Moving to object storage later means adding a second implementation and setting `storage_backend` — no change to the business tables.
- Allowed file types and the maximum size are configuration values, pending **Q14**.
- The storage folder must be included in the backup procedure along with the database.

---

## 12. Users, roles and permissions

**Design only. Authentication is not implemented, and the mechanism (session or token) is not chosen here.**

### 12.1 Tables

#### `users`

**Purpose:** a person who can sign in, be assigned work, or be named as responsible for a contract.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `email` | `text` | No | Login identifier. Unique on `lower(email)`. |
| `full_name` | `text` | No | |
| `password_hash` | `text` | Yes | Hash from a slow, salted algorithm (argon2id or bcrypt). Never the password. Null for a person who exists only as an assignee and cannot sign in. |
| `is_active` | `boolean` | No | Default `true`. Deactivation replaces deletion. |
| `last_login_at` | `timestamptz` | Yes | |
| `created_at`, `updated_at` | | | |

- **Unique:** `lower(email)`.
- **Check:** `btrim(full_name) <> ''`.
- Users are never deleted, because business records and the audit log reference them.
- The authentication step may add a table for sessions or refresh tokens, depending on the mechanism chosen at that time.

#### `roles`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `code` | `text` | No | Unique. `admin`, `accountant`, `procurement`, `execution`, `invoicing`. |
| `name` | `text` | No | Display label. |
| `description` | `text` | Yes | |
| `created_at`, `updated_at` | | | |

#### `user_roles`

| Column | Type | Null | Notes |
|---|---|---|---|
| `user_id` | `bigint` | No | FK → `users(id)`. |
| `role_id` | `bigint` | No | FK → `roles(id)`. |
| `created_at` | `timestamptz` | No | |

- **Primary key:** `(user_id, role_id)`. Index on `(role_id)`.

#### `role_permissions`

| Column | Type | Null | Notes |
|---|---|---|---|
| `role_id` | `bigint` | No | FK → `roles(id)`. |
| `permission_code` | `text` | No | Example: `project_expenses.create`. |
| `created_at` | `timestamptz` | No | |

- **Primary key:** `(role_id, permission_code)`.

### 12.2 How authorisation would work

- Permission codes follow `<module>.<action>`: `clients.read`, `clients.write`, `amc_visits.complete`, `invoices.write`, and so on. The list is defined once in backend code.
- Each API route declares the permission it needs. Middleware loads the user's roles and their permissions and rejects the request with `403` if the permission is missing. This runs in the backend for every request.
- The frontend receives the user's permission list only to hide controls. Hiding a button is never the protection.
- A user's effective permissions are the union of their roles' permissions.

### 12.3 Draft module access

**This matrix is a starting point for discussion. The final matrix requires business approval [UNRESOLVED — Q12].**

`R` = view, `W` = create and edit, `—` = no access.

| Module | Admin | Accountant | Procurement | Execution | Invoicing |
|---|---|---|---|---|---|
| Users and roles | W | — | — | — | — |
| Settings and lookups | W | — | — | — | — |
| Clients | W | R | R | R | R |
| AMC contracts | W | R | — | R | R |
| AMC schedule | W | R | — | R | R |
| AMC execution (update status, complete) | W | — | — | W | — |
| Projects | W | R | R | R | R |
| Project status (site execution) | W | — | — | W | — |
| Procurement | W | R | W | R | — |
| Project expenses | W | W | R | — | — |
| Invoice tracking | W | R | — | — | W |
| Job financial summary | W | R | — | — | R |
| Dashboard and reports | W | R | Limited | Limited | R |
| Activity log | R | — | — | — | — |

Open points inside this matrix: who creates AMC contracts and projects besides Admin; whether execution and procurement users may see financial values; whether Execution users see all visits or only those assigned to them.

---

## 13. Audit log

### 13.1 `activity_logs`

**Purpose:** append-only record of important operational and financial actions.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `bigint` identity | No | Primary key. |
| `occurred_at` | `timestamptz` | No | Default `now()`. |
| `actor_user_id` | `bigint` | Yes | FK → `users(id)`. Null for system actions such as an import. |
| `action` | `text` | No | Example: `amc_visit.completed`. |
| `entity_type` | `text` | No | Table name of the affected record. |
| `entity_id` | `bigint` | No | ID of the affected record. |
| `summary` | `text` | Yes | Short readable description. |
| `changes` | `jsonb` | Yes | Changed fields only: `{"status": {"from": "scheduled", "to": "completed"}}`. |

- **Primary key:** `id`
- **Foreign key:** `actor_user_id` → `users`.
- **Indexes:** `(entity_type, entity_id, occurred_at DESC)` for a record's history; `(actor_user_id, occurred_at DESC)`; `(occurred_at)`.
- **No `updated_at`.** Rows are never updated or deleted. The application's database role is granted `INSERT` and `SELECT` only on this table.

`entity_type` / `entity_id` is intentionally **not** a foreign key here. This is the one place a polymorphic reference is appropriate: the log must be able to describe any table, and must never prevent a legitimate operation on the record it describes. The integrity argument that rules this pattern out for invoices does not apply to a history record.

### 13.2 What is logged

| Area | Actions |
|---|---|
| AMC | Contract created, edited, activated, status changed. Schedule generated or regenerated. Visit rescheduled, reassigned, completed, cancelled. |
| Projects | Created, edited (especially value, VAT, budget), status changed. |
| Procurement | Created, edited, status changed. |
| Expenses | Created, edited, voided. |
| Invoices | Invoice reference entered, edited, cancelled. Allocation added or removed. |
| Attachments | Uploaded, deleted. |
| Access | User created or deactivated, role assignment changed, role permissions changed. |

### 13.3 What it deliberately is not

- Not event sourcing. The business tables hold current state; the log explains how it got there.
- Not a read log. Viewing a record is not logged.
- Not automatic for every table. The service layer decides which actions are logged, and writes the entry in the same transaction as the change.
- Passwords, password hashes and tokens are never written to `changes`.

---

## 14. Status design

Statuses are stored as short lowercase codes and shown to users with a readable label. Every list below has two parts, kept separate on purpose.

### 14.1 AMC contracts

**RECOMMENDED TECHNICAL STATUS**

| Code | Meaning |
|---|---|
| `draft` | Being prepared, or migrated with incomplete data. No schedule. |
| `active` | In force. Schedule generated. |
| `expired` | End date has passed. |
| `cancelled` | Ended early. |

`draft → active → expired`, with `cancelled` reachable from `draft` or `active`.

**BUSINESS RULE REQUIRING CLIENT CONFIRMATION:** whether a contract expires automatically on its end date or by user action; whether cancellation exists and what happens to its remaining visits; whether a suspended or on-hold state is needed; how renewal is recorded.

### 14.2 AMC visits

**RECOMMENDED TECHNICAL STATUS**

| Code | Meaning |
|---|---|
| `scheduled` | Generated and planned. |
| `in_progress` | Work has started. |
| `completed` | Work done. `completed_date` recorded. |
| `cancelled` | Will not be performed. |

Derived, not stored: **overdue** (scheduled and past its date), **ready for invoice** and **invoiced** ([Section 10.4](#104-derived-billing-state)).

**BUSINESS RULE REQUIRING CLIENT CONFIRMATION:** whether `in_progress` is used at all or visits go straight to completed; how postponed and missed visits are treated; whether a completed visit can be reopened and by whom; whether cancelled visits are billable; whether a separate approval precedes invoicing.

### 14.3 Projects

**RECOMMENDED TECHNICAL STATUS**

| Code | Meaning |
|---|---|
| `new` | Created, work not yet started. |
| `procurement` | Procurement under way. |
| `execution` | Site execution under way. |
| `completed` | Work finished. |
| `closed` | Financially closed. No further changes expected. |
| `cancelled` | Abandoned. |

Derived, not stored: **ready for invoice**, **partly invoiced**, **fully invoiced**.

**BUSINESS RULE REQUIRING CLIENT CONFIRMATION [UNRESOLVED — Q7]:** the actual status list and order; whether procurement and execution can overlap (a single status column assumes they do not); whether an on-hold status is needed; what conditions must be met to close a project; who can move a project between statuses; how the existing "status" values in the Jobs List map to these.

### 14.4 Procurement

**RECOMMENDED TECHNICAL STATUS**

| Code | Meaning |
|---|---|
| `requested` | Requirement recorded. |
| `quoted` | Quotation received. |
| `ordered` | Order or PO placed. |
| `delivered` | Received. |
| `cancelled` | No longer required. |

**BUSINESS RULE REQUIRING CLIENT CONFIRMATION [UNRESOLVED — Q8]:** the actual status list; whether approval is needed before ordering; whether partial delivery must be tracked.

### 14.5 Invoices

**RECOMMENDED TECHNICAL STATUS**

| Code | Meaning |
|---|---|
| `issued` | Exists in Zoho and is recorded here. |
| `cancelled` | Voided in Zoho. Its allocations are kept for history but ignored in all totals. |

**BUSINESS RULE REQUIRING CLIENT CONFIRMATION [UNRESOLVED — Q22]:** whether STSLV AMC should also track payment (`paid`, `partly paid`). Payment tracking belongs to Zoho accounting and is not in the confirmed Phase 1 scope, so it is not included. If wanted, it is one more status code plus a payment date.

---

## 15. Financial calculation map

Every figure has one named source. Nothing is calculated in two places.

### 15.1 Projects

```
projects.job_value            (stored — entered by user, excluding VAT)
        │
        ├── × projects.vat_rate ──► projects.vat_amount   (stored — see VAT below)
        │
        └── + vat_amount ─────────► projects.grand_value  (generated by the database)

project_expenses.amount       (stored — one row per cost, voided rows excluded)
        │
        └── SUM per project ──────► Total Recorded Cost   (calculated on read)

job_value − Total Recorded Cost ──► Job Margin            (calculated on read — PROVISIONAL)

invoice_allocations.allocated_amount  (stored)
        │
        └── SUM per project, non-cancelled invoices ──► Invoiced Value   (calculated on read)

job_value − Invoiced Value ───────► Uninvoiced Value      (calculated on read)

budget_amount − Total Recorded Cost ► Budget Remaining    (calculated on read)
```

**Job Margin = Job / LPO Value − Recorded Project Costs** is **[PROVISIONAL — Q10]**. Until the client confirms the definition:

- it is labelled "Job Margin", never "Profit"
- it uses the ex-VAT job value
- it counts only expenses recorded in STSLV AMC
- it is never stored

### 15.2 VAT

| Item | Treatment |
|---|---|
| Default VAT rate | Stored in `app_settings`. Not hard-coded. |
| Rate on a project | Copied to `projects.vat_rate` when the project is created, so a later change to the default does not alter existing jobs. |
| `vat_amount` | Stored. Proposed as `round(job_value × vat_rate / 100, 2)`, calculated by the API. |
| `grand_value` | Generated column. Always `job_value + vat_amount`. |

**[UNRESOLVED — Q11]:** whether VAT is always a fixed percentage of job value, whether some jobs are zero-rated or exempt, whether the user may override the VAT amount, the rounding rule, and whether expenses and AMC values are entered inclusive or exclusive of VAT. `vat_amount` is stored as its own column so that any of these answers can be supported without a schema change.

### 15.3 AMC

| Value | Treatment |
|---|---|
| `amc_contracts.contract_value` | **Stored.** Entered by the user. |
| `amc_contracts.cost_per_visit` | **Stored.** Entered by the user. |
| `amc_contracts.final_agreed_value` | **Stored. Used in nothing.** Meaning is **[UNRESOLVED — Q1]**. |
| Number of visits | **Derived:** count of non-cancelled `amc_visits` for the contract. |
| `amc_visits.visit_amount` | **Stored snapshot** of `cost_per_visit` at generation. |
| Scheduled contract total | **Calculated:** sum of `visit_amount` over non-cancelled visits. |
| Reconciliation | **Validated:** scheduled contract total compared with `contract_value`. |
| AMC invoiced value | **Calculated:** sum of active allocations to the contract's visits. |
| AMC ready-for-invoice value | **Calculated:** sum of `visit_amount` over completed visits with no active allocation. |

**Reconciliation is shown as a warning, not enforced as a block.** Whether `contract_value` must equal `cost_per_visit × number of visits` is a business rule the client has not stated. A contract may include items that are not per-visit, and "Final Credit" may be part of the explanation. The system shows the difference and lets the user proceed until the rule is confirmed **[UNRESOLVED — Q1, Q3]**.

### 15.4 Invoices

| Value | Treatment |
|---|---|
| `invoices.net_amount`, `vat_amount` | **Stored.** Copied by the user from the Zoho invoice. STSLV AMC does not compute them. |
| `invoices.total_amount` | **Generated.** |
| `invoice_allocations.allocated_amount` | **Stored.** |
| Allocated total per invoice | **Calculated** and **validated** ≤ `net_amount`. |
| Unallocated remainder | **Calculated.** |

### 15.5 Summary

| Category | Values |
|---|---|
| **Stored** (entered) | Job value, VAT rate and amount, budget, contract value, cost per visit, final/agreed value, expense amount, invoice net and VAT, allocated amount, visit amount snapshot. |
| **Generated by the database** | Project grand value, invoice total. |
| **Calculated on read** (never stored) | Total recorded cost, job margin, invoiced value, uninvoiced value, budget remaining, scheduled contract total, number of visits, all dashboard totals. |
| **Validated** | Allocations ≤ invoice net; contract value against scheduled total (warning); amounts not negative; end date ≥ start date. |

All money arithmetic happens either in PostgreSQL `numeric` or in a decimal library in the API. JavaScript floating-point numbers are never used for money, and amounts travel through the API as strings.

---

## 16. Dashboard data sources

Design only. Every metric is a query over the tables above. No totals table is maintained.

### 16.1 AMC

| Metric | Source |
|---|---|
| Active AMC contracts | `amc_contracts` where `status = 'active'`. |
| Upcoming visits | `amc_visits` where `status = 'scheduled'` and `scheduled_date` is within a chosen number of days ahead. |
| Visits due this month | `amc_visits` where `scheduled_date` falls in the current month and status is not `cancelled`. |
| Completed visits | `amc_visits` where `status = 'completed'`, for the selected period by `completed_date`. |
| Pending visits | `amc_visits` where `status` is `scheduled` or `in_progress`. |
| Overdue visits | `amc_visits` where `status = 'scheduled'` and `scheduled_date` is before today. |
| Ready-for-invoice visits | `v_amc_visit_billing`: completed with no active allocation. Count and sum of `visit_amount`. |
| Invoiced visits | `v_amc_visit_billing`: completed with an active allocation. |
| Pending invoices (AMC) | Same set as ready-for-invoice visits, shown with age since `completed_date`. |

### 16.2 Projects

| Metric | Source |
|---|---|
| Active projects | `projects` where `status` is `new`, `procurement` or `execution`. |
| Projects in procurement | `projects` where `status = 'procurement'`. |
| Projects in execution | `projects` where `status = 'execution'`. |
| Completed projects | `projects` where `status = 'completed'`. |
| Ready for invoice | `v_project_billing`: completed with uninvoiced value > 0. |
| Invoiced projects | `v_project_billing`: uninvoiced value ≤ 0. |
| Total job / LPO value | `SUM(projects.job_value)` for non-cancelled projects in the selected period. |
| Recorded project costs | `SUM(project_expenses.amount)` where not voided. |
| Job margin | `job_value` − recorded project costs. **[PROVISIONAL — Q10]** |
| Budget against cost | `projects.budget_amount` compared with recorded project costs. |

### 16.3 Pending invoices

"Pending invoices" is the combined list of **completed AMC visits with no invoice** and **completed projects with uninvoiced value**, each with the number of days since completion. Because the client named missed invoicing as a major pain point, this list should be the most prominent item on the dashboard and available to both Admin and Invoicing roles.

A second control list, **invoices not fully allocated**, catches invoices entered but not linked to work.

---

## 17. Relationship diagram

`──<` means "one to many", reading left to right or top to bottom.

```
USERS >──< ROLES                      (through USER_ROLES)
             │
             └──< ROLE_PERMISSIONS


CLIENTS
   │
   ├──< AMC_CONTRACTS >── SYSTEM_TYPES
   │        │      └───── USERS (responsible)
   │        │
   │        └──< AMC_VISITS >── USERS (assigned, completed by)
   │                  │
   │                  └──────────────────────────────┐
   │                                                 │
   ├──< PROJECTS                                     │
   │        │                                        │
   │        ├──< PROCUREMENT_REQUESTS >── SUPPLIERS  │
   │        │            │                           │
   │        │            └──< (optional link)        │
   │        │                      │                 │
   │        ├──< PROJECT_EXPENSES ─┘                 │
   │        │        ├──> EXPENSE_CATEGORIES         │
   │        │        └──> SUPPLIERS                  │
   │        │                                        │
   │        └──────────────┐                         │
   │                       ▼                         ▼
   │                 ┌──────────────────────────────────┐
   │                 │       INVOICE_ALLOCATIONS        │
   │                 │  exactly one of:                 │
   │                 │    project_id   or  amc_visit_id │
   │                 └────────────────┬─────────────────┘
   │                                  │ many
   │                                  ▼ one
   └──< INVOICES ─────────────────────┘


ATTACHMENTS  ── exactly one owner ──►  PROJECTS
                                       PROCUREMENT_REQUESTS
                                       PROJECT_EXPENSES
                                       AMC_CONTRACTS
                                       AMC_VISITS

ACTIVITY_LOGS ── actor ──► USERS
              ── entity_type + entity_id ──► any business record (not a foreign key)

Standalone configuration:  APP_SETTINGS,  NUMBER_SEQUENCES
```

Cardinalities:

| Relationship | Cardinality |
|---|---|
| Client → AMC contracts | 1 : many |
| Client → Projects | 1 : many |
| Client → Invoices | 1 : many |
| AMC contract → AMC visits | 1 : many |
| System type → AMC contracts | 1 : many |
| Project → Procurement requests | 1 : many |
| Project → Project expenses | 1 : many |
| Procurement request → Project expenses | 1 : many (optional) |
| Invoice → Invoice allocations | 1 : many |
| Project → Invoice allocations | 1 : many (a project can have many invoices) |
| AMC visit → Invoice allocations | 1 : many in the schema; restricted to one by rule if Q5 confirms it |
| User ↔ Role | many : many |

---

## 18. Excel migration mapping

**The three spreadsheets are not in the repository. This mapping uses only the fields recorded in `CLAUDE.md` Section 2. Column headers, formats, sample values and data quality are unknown. No migration may be implemented until the original files are supplied again.**

### 18.1 `AMC - 2027` → `clients`, `system_types`, `amc_contracts`

| Spreadsheet field | Target | Notes |
|---|---|---|
| Serial number | Not migrated as a key | Row order only. May be kept in `notes` for traceability during reconciliation. |
| Responsible engineer | `amc_contracts.responsible_user_id` | Needs a `users` row per engineer. **Requires file:** the list of distinct names. Depends on **Q20**. |
| Contract validity from | `amc_contracts.start_date` | **Requires file:** date format. |
| Contract validity to | `amc_contracts.end_date` | |
| Client | `clients.name` → `amc_contracts.client_id` | Names must be de-duplicated across all three files before clients are created. **Requires file.** |
| System / description | `amc_contracts.system_type_id` and `amc_contracts.description` | **Requires file:** whether the cell holds a clean type, free text, or several systems in one cell (**Q15**). |
| Contract value | `amc_contracts.contract_value` | |
| Final credit / agreed value | `amc_contracts.final_agreed_value` | Copied as-is. **Meaning unresolved (Q1).** |
| *(not in spreadsheet)* Maintenance frequency | `amc_contracts.maintenance_frequency` | Must be supplied by the client for each contract. |
| *(not in spreadsheet)* Cost per visit | `amc_contracts.cost_per_visit` | Must be supplied by the client for each contract. |

All migrated contracts are created as `draft`. No visits are generated until frequency and cost per visit are filled in and the contract is activated.

### 18.2 `AMC INVOICING - 2027` → `invoices`, `invoice_allocations`, `amc_visits`

| Spreadsheet field | Target | Notes |
|---|---|---|
| Client | Match to `clients` | Must match the same client record as in `AMC - 2027`. |
| System | Match to `amc_contracts` (client + system) | **Requires file:** whether client + system identifies exactly one contract. |
| Periodic / quarter reference | Identifies the `amc_visits` row by its period | **Requires file:** how periods are laid out (the description suggests one column per period, which becomes one visit **row** per period — never a column). |
| Invoice number | `invoices.invoice_number` | A blank means the period is **uninvoiced**: no invoice row is created, and the visit appears as pending. |
| Invoice value | `invoices.net_amount` and `invoice_allocations.allocated_amount` | **Requires file and Q11:** whether the value includes VAT. |
| *(not in spreadsheet)* Invoice date | `invoices.invoice_date` | Required by the model. Must come from Zoho or the client. |

Open migration decisions that need the file and the client:

- Whether historical periods should be imported as completed visits at all, or whether the system starts from a cut-over date with only open items carried forward.
- Whether a period with no invoice number means "visit done, not invoiced" or "visit not done". The spreadsheet as described does not record completion.
- Whether one invoice number appears against several periods (which would be several allocations on one invoice).

### 18.3 `Jobs List` → `clients`, `projects`, `invoices`, `invoice_allocations`

| Spreadsheet field | Target | Notes |
|---|---|---|
| Serial number | Not migrated as a key | |
| Status | `projects.status` | **Requires file and Q7:** the distinct status values and their mapping. |
| Month | `projects.job_date` | **Requires file:** format, and whether a year is present. A month alone is not a date. |
| Job number | `projects.job_number` | Imported exactly as written. `number_sequences` is then set above the highest value once the rule is confirmed (**Q6**). |
| Client | `clients.name` → `projects.client_id` | De-duplicated together with the AMC files. |
| Job description | `projects.description` | |
| Job value | `projects.job_value` | |
| VAT | `projects.vat_amount` | **Requires file:** whether the column holds an amount or a rate. `vat_rate` is left null if it cannot be determined. |
| Grand job value | Validated against `job_value + vat_amount` | Not imported directly, because `grand_value` is generated. Rows that do not reconcile are reported for review. |
| Profit | **No target — decision needed** | There are no legacy expense rows, so the figure cannot be recalculated, and storing it conflicts with the rule against stored derived values and with **Q10**. Options: (a) do not migrate; (b) keep in a clearly labelled legacy reference column that no calculation uses. To be decided at review. |
| Invoice number | `invoices` + `invoice_allocations` | Some jobs have more than one invoice. **Requires file:** how multiple numbers are written in a cell. Each becomes its own invoice row and allocation. |
| *(not in spreadsheet)* Invoice date and per-invoice amount | `invoices.invoice_date`, `net_amount` | Required by the model. Must come from Zoho or the client. Where a job has several invoices, the split of value between them is unknown. |
| *(not in spreadsheet)* LPO number, LPO date, budget | `projects` | Nullable. Left empty for migrated jobs. |

### 18.4 Migration approach

1. Supply the three original files.
2. Profile them: headers, types, blanks, duplicates, client name variants.
3. Finalise this mapping against the real columns.
4. Import through a validate-and-preview step: rows are checked, problems listed, and nothing is written until a user confirms.
5. Reconcile totals (contract count and value, job count and value, invoice count) between the spreadsheets and the database.

Excel migration is step 17 in the development order. It is described here only so that the schema is known to be able to receive the data.

---

## 19. Unresolved business questions

Classification:

- **BLOCKS DATABASE DESIGN** — the answer could change tables, columns or constraints. Must be settled before the migration for that table is written.
- **BLOCKS FEATURE IMPLEMENTATION** — the schema can accommodate either answer, but the feature's behaviour cannot be built without it.
- **CAN BE CONFIGURED LATER** — the design holds the value as data or configuration, so it can be decided or changed without redesign.

### 19.1 Questions from `CLAUDE.md` Section 16

| # | Question | Classification | Affects | How the design contains it |
|---|---|---|---|---|
| Q1 | What does AMC "Final Credit" mean? Is it a discounted value, a credit note, an amount received, or something else? Does it replace contract value for billing? | **BLOCKS FEATURE IMPLEMENTATION** | AMC reports, reconciliation | Stored in a nullable column and used in no calculation. |
| Q2 | What are the exact AMC maintenance frequency options? Are there any that are not a whole number of months? | **BLOCKS FEATURE IMPLEMENTATION** (schedule generation). **BLOCKS DATABASE DESIGN** only if a non-monthly unit exists. | `amc_contracts`, schedule algorithm | A check-constraint list that is simple to change. |
| Q3 | Is billing frequency always the same as maintenance frequency? If not, how is AMC billed? | **BLOCKS DATABASE DESIGN** for AMC invoicing only if billing is not tied to visits. Otherwise **BLOCKS FEATURE IMPLEMENTATION**. | `invoice_allocations`, AMC invoicing | One invoice can already cover several visits. Contract-level billing is an additive change. |
| Q4 | How are postponed or missed visits handled? Can a visit move outside its period? Does it shift later visits? Is a reason required? Where in the period does a visit fall? What happens to future visits when a contract is edited or renewed? | **BLOCKS FEATURE IMPLEMENTATION** | Schedule and execution | `original_scheduled_date` and `scheduled_date` are separate; locked visits are never changed. |
| Q5 | Can one AMC visit have more than one invoice? Can one invoice cover several visits? | **BLOCKS FEATURE IMPLEMENTATION** | Invoice entry rules | The schema allows many-to-many; the restriction is one rule in the service layer. |
| Q6 | What is the exact Job Number format going forward? Prefix, length, starting number, any year or reset? Can it be entered manually? | **BLOCKS FEATURE IMPLEMENTATION** (project creation). Not a database blocker. | `number_sequences`, project creation | `job_number` is free unique text; format lives in data. |
| Q7 | What is the exact project status workflow? Can procurement and execution overlap? What closes a project? | **BLOCKS FEATURE IMPLEMENTATION**. **BLOCKS DATABASE DESIGN** if stages can overlap. | `projects.status` | Single status column with a draft list. |
| Q8 | What are the exact procurement statuses? Is partial delivery tracked? | **BLOCKS FEATURE IMPLEMENTATION** | `procurement_requests.status` | Draft list in a check constraint. |
| Q9 | Can one payment or transfer be allocated across several jobs? If so, how is it split? Is a holding list needed for payments whose job is not yet known? | **BLOCKS DATABASE DESIGN** for the expenses module | `project_expenses`, possible `payments` table | One row per project; `payment_reference` not unique; no split rule built. |
| Q10 | What is the formal definition of Profit / Job Margin? Which costs count? Ex-VAT or inc-VAT? | **BLOCKS FEATURE IMPLEMENTATION** (financial summary and reports) | Calculations only | Calculated on read, never stored, labelled "Job Margin". |
| Q11 | VAT rules: fixed or configurable rate? Any zero-rated or exempt jobs? May the amount be overridden? Rounding? Are expenses, AMC values and tracked invoice amounts inclusive or exclusive of VAT? | **BLOCKS FEATURE IMPLEMENTATION**. Rate value itself **CAN BE CONFIGURED LATER**. | `projects`, `invoices`, `project_expenses` | Rate in settings; VAT amount stored separately; invoice net and VAT stored separately. |
| Q12 | What approvals are required (procurement, expenses, release for invoicing, project closure)? What is the final permission matrix per role? | Approvals: **BLOCKS FEATURE IMPLEMENTATION**. Permission matrix: **CAN BE CONFIGURED LATER**. | Workflow, `role_permissions` | No approval steps built. Permissions are data. |
| Q13 | What site execution fields are required for AMC visits and for projects (beyond status, completion date and notes)? | **BLOCKS DATABASE DESIGN** for execution detail only | `amc_visits`, `projects`, possible execution table | Minimum fields only; a detail table can be added. |
| Q14 | Which attachments are required, at which step, and are any mandatory? Allowed file types and size limit? | **CAN BE CONFIGURED LATER** (types, limits). Mandatory-document rules **BLOCK FEATURE IMPLEMENTATION**. | `attachments` | Generic model; document types in a check list. |

### 19.2 Additional questions raised by this design

| # | Question | Classification | Affects |
|---|---|---|---|
| Q15 | Can one AMC contract cover more than one system, each with its own frequency or cost? | **BLOCKS DATABASE DESIGN** for AMC | Whether `amc_contract_systems` is needed. |
| Q16 | Is a minimal Supplier master approved for Phase 1, or should supplier be free text? | **BLOCKS DATABASE DESIGN** for procurement and expenses | `suppliers`. |
| Q17 | Does the client record several competing quotations per procurement requirement? | **BLOCKS DATABASE DESIGN** for procurement | Whether `procurement_quotations` is needed. |
| Q18 | Is all business in a single currency? | **BLOCKS DATABASE DESIGN** only if the answer is no | All money columns. |
| Q19 | Do clients and AMC contracts have existing business codes or reference numbers that must be kept? | **CAN BE CONFIGURED LATER** | `clients.client_code`, `amc_contracts.contract_number`. |
| Q20 | Are responsible engineers always users of the system? Should Execution users see all visits or only their own? | **BLOCKS DATABASE DESIGN** for AMC (minor) | `responsible_user_id`, `assigned_user_id`. |
| Q21 | Can a project be invoiced before completion (advance or progress invoices)? When is a project considered fully invoiced? Can one invoice cover several projects? | **BLOCKS FEATURE IMPLEMENTATION** | Ready-for-invoice logic. |
| Q22 | Should STSLV AMC track whether an invoice has been paid, or is that left entirely to Zoho? | **CAN BE CONFIGURED LATER** | `invoices.status`. |
| Q23 | Can one user hold more than one role? | **CAN BE CONFIGURED LATER** | Supported either way by `user_roles`. |
| Q24 | At migration, should history be imported, or only open items from a cut-over date? What should happen to the legacy "Profit" column? | **BLOCKS FEATURE IMPLEMENTATION** (migration only) | Section 18. |

### 19.3 Summary by classification

| Classification | Questions |
|---|---|
| **BLOCKS DATABASE DESIGN** | Q9, Q13 (execution detail), Q15, Q16, Q17, Q20; and conditionally Q2, Q3, Q7, Q18 |
| **BLOCKS FEATURE IMPLEMENTATION** | Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q10, Q11, Q12 (approvals), Q14 (mandatory documents), Q21, Q24 |
| **CAN BE CONFIGURED LATER** | Q11 (rate value), Q12 (permission matrix), Q14 (types and limits), Q19, Q22, Q23 |

None of the "blocks database design" questions affect `users`, `roles`, `user_roles`, `role_permissions`, `app_settings`, `clients` or `activity_logs`.

---

## 20. Implementation order

### 20.1 Recommended database and module order

| Step | Module | Tables | Why here |
|---|---|---|---|
| 0 | Foundation | none | PostgreSQL connection (in progress in another session), environment configuration, **choice of migration tool**, the shared `updated_at` trigger function, error and validation conventions. |
| 1 | Users and roles | `users`, `roles`, `user_roles`, `role_permissions` | Every other table references `users`. Permissions must exist before the first business route. |
| 2 | Audit and settings | `activity_logs`, `app_settings` | Moved **earlier** than in the example order. If the log exists before the first business module, every module writes audit entries from its first day instead of being retrofitted. |
| 3 | Client master | `clients` | First business table. Referenced by everything after it. |
| 4 | AMC contracts | `system_types`, `amc_contracts` | Needs clients and users. |
| 5 | AMC schedule and execution | `amc_visits` | Needs contracts. Schedule generation and execution update share this table. |
| 6 | Projects | `number_sequences`, `projects` | Needs clients. |
| 7 | Attachments | `attachments` | Moved **earlier** than in the example order. Procurement needs quotation files and expenses need receipts, so the upload mechanism must exist first. Created with the owner columns for tables that exist; later steps add their own owner column. |
| 8 | Procurement | `suppliers`, `procurement_requests` (+ attachment owner column) | Needs projects and attachments. |
| 9 | Project expenses | `expense_categories`, `project_expenses` (+ attachment owner column) | Needs projects, suppliers and procurement requests. |
| 10 | Invoice tracking | `invoices`, `invoice_allocations`, billing views | Needs both `amc_visits` and `projects`. |
| 11 | Dashboard | views only | Reads everything above. |
| 12 | Reports and exports | none | |
| 13 | Excel migration | none | Needs the full schema and the original files. |

Changes from the example order, and why:

- **Audit log moves forward** to step 2, so no module is built without it.
- **Attachments move forward** to before procurement, because procurement and expenses depend on file upload.
- **Invoices stay after both AMC visits and projects**, because `invoice_allocations` has foreign keys to both.

This remains consistent with the development order in `CLAUDE.md` Section 10.

### 20.2 What blocks the first migrations

The first migrations are steps 1 to 3: users and roles, audit and settings, clients.

**No unresolved business question blocks them.** The blockers are technical and procedural:

1. **This document must be reviewed and approved.** `CLAUDE.md` requires the schema to be reviewed before implementation.
2. **No migration tool has been chosen.** The repository has no migration tooling. A tool that produces ordered, reviewable SQL migrations must be selected and installed, which needs approval as a new dependency.
3. **The PostgreSQL connection is not yet complete.** It is being configured in a separate session and must be finished and verified first.
4. **Decisions to confirm at review:**
   - the identifier strategy (`bigint` identity keys with separate business reference columns)
   - text-plus-check-constraint for statuses instead of PostgreSQL enum types
   - email as the login identifier
   - `user_roles` as a many-to-many table
   - the password hashing algorithm and authentication mechanism (needed for step 1 code, not for the table)
5. **Housekeeping before any repository is created:** `stslv-api` has no `.gitignore` and no `.env.example`.

What blocks later migrations:

| Migration | Blocked by |
|---|---|
| `amc_contracts`, `amc_visits` | Q15, Q20; Q2 if any frequency is not month-based. |
| `projects` | Nothing for the table. Q6 blocks seeding `number_sequences` and automatic numbering. Q7 if stages can overlap. |
| `suppliers`, `procurement_requests` | Q16, Q17. |
| `project_expenses` | Q9, Q16. |
| `invoices`, `invoice_allocations` | Q3 if billing is not tied to visits; Q11 for net and VAT columns. |
| Any data migration | The three original spreadsheets, and Q24. |

---

*End of document. This is a design proposal for review. No part of it has been implemented.*
