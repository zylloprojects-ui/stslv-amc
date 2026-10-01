# STSLV AMC — Project Development Instructions

## 1. Project Identity

Project Name: STSLV AMC

STSLV AMC is a new custom operations management / ERP-style web application.

It is being developed to replace the client's current Excel-based operational tracking for:

- AMC contracts
- AMC maintenance scheduling
- AMC execution tracking
- Project/job management
- Procurement
- Project expenses
- Invoice tracking
- Management reporting

The system is NOT intended to replace Zoho accounting/invoicing during Phase 1.

Invoices will continue to be generated in Zoho.

STSLV AMC will track the corresponding Zoho invoice number, invoice date, amount and status against the relevant AMC visit or project/job.

The main business objective is to make every AMC visit and every project financially and operationally traceable.

The system should help prevent:

- missed AMC visits
- missed invoices
- untracked project expenses
- unidentified money transfers
- disconnected procurement records
- poor project cost visibility
- dependence on multiple Excel trackers

The project must remain simple, reliable, auditable and suitable for daily business operations.

This is a standalone project. Do not copy code, database structures, assumptions, or business rules from any other project.

---

## 2. Existing Client Process

The client's business currently relies heavily on Excel.

Three important client spreadsheets have been supplied and analyzed:

### AMC - 2027

This represents the existing AMC contract/master information.

Observed information includes:

- serial number
- responsible engineer
- contract validity from date
- contract validity to date
- client
- system/description
- contract value
- final credit/agreed value

The new ERP must not simply reproduce this spreadsheet.

This information should become structured AMC contract data.

Additional fields requested during the client meeting include:

- maintenance frequency
- cost per visit

The ERP should use contract frequency and validity to generate the maintenance schedule automatically.

---

### AMC INVOICING - 2027

This represents the client's current AMC periodic/monthly invoice tracking.

Observed information includes:

- client
- system
- invoice number
- invoice value
- periodic/quarter references

Some invoice numbers are blank, demonstrating the business problem of pending or missed invoices.

The new ERP should replace manual monthly invoice tracking with a workflow:

AMC Contract
→ Auto-generated Visit/Schedule
→ Execution
→ Completed
→ Ready for Invoice
→ Invoice generated externally in Zoho
→ Zoho invoice details entered in STSLV AMC
→ Invoiced

Do not create separate database tables for January, February, March, etc.

Schedules must be date-based records.

---

### Jobs List

This represents the client's project/job register.

Observed information includes:

- serial number
- status
- month
- job number
- client
- job description
- job value
- VAT
- grand job value
- profit
- invoice number

Existing job numbers follow patterns such as GPSA0521, GPSA0522, etc.

Do NOT permanently hard-code this numbering convention until the client confirms the exact future numbering rule.

The spreadsheet indicates that some jobs may have more than one invoice.

Therefore, do NOT design Projects with only one invoice_number field.

The data model must support multiple invoices or invoice allocations where required.

---

## 3. Client's Required Business Flow

There are two primary operational flows.

### AMC Flow

Client
→ AMC Contract
→ System Type
→ Validity
→ Maintenance Frequency
→ Cost Per Visit
→ Automatic Maintenance Schedule
→ Monthly Schedule
→ Execution
→ Visit Completed
→ Ready for Invoice
→ Invoice generated in Zoho
→ Zoho invoice details entered in STSLV AMC
→ Invoiced
→ Reporting

The system should support AMC contracts lasting multiple years, potentially up to 5 years.

Maintenance schedules must be generated from contract frequency and validity.

Do not assume maintenance frequency and billing frequency are always identical unless the business rule is confirmed.

---

### Project Flow

Client
→ New Project
→ Automatic Job Number
→ Project Details
→ LPO Information
→ LPO / Job Value
→ Budget
→ Procurement
→ Quotations / Attachments
→ Procurement Status
→ Site Execution
→ Expenses
→ Project Completion
→ Ready for Invoice
→ Invoice generated in Zoho
→ Zoho invoice details entered in STSLV AMC
→ Project Financial Summary
→ Closed

The Job Number is a core business reference.

Procurement, expenses, execution and invoice information must remain traceable to the relevant project/job.

---

## 4. Phase 1 Scope

Phase 1 should focus only on stabilizing the client's core operations.

### 4.1 Authentication and Users

Support multiple users.

Initial business roles:

- Admin
- Accountant
- Procurement
- Execution
- Invoicing

Use role-based access control.

Permissions should be enforced in the backend, not only hidden in the frontend.

---

### 4.2 Client Master

Maintain reusable client records.

AMC contracts and projects should reference the Client Master instead of repeatedly storing unrelated free-text client records wherever practical.

---

### 4.3 AMC Contracts

Phase 1 should support:

- create contract
- edit contract
- view contract
- client
- responsible engineer/person
- system type
- description
- contract start date
- contract end date
- maintenance frequency
- cost per visit
- contract value
- final/agreed value where applicable
- contract status
- notes

Exact interpretation of "Final Credit" from the client's existing Excel is NOT yet confirmed.

Do not invent its accounting meaning.

---

### 4.4 AMC Schedule

The system must generate scheduled maintenance visits from:

- contract start date
- contract end date
- maintenance frequency

Support multi-year contracts up to the client's required limit.

The schedule should support:

- monthly view
- client filtering
- system filtering
- status filtering
- schedule export/download
- scheduled date/period
- visit status
- completion tracking

Do not create month-specific database structures.

---

### 4.5 AMC Execution

Execution users need to:

- view assigned/scheduled maintenance work
- update execution status
- mark a visit completed
- record completion date
- add appropriate notes

Completion should allow the visit to move into the invoice-ready workflow.

Do not invent a large field-service-report/checklist system unless separately approved.

---

### 4.6 Projects

Project creation should support:

- automatically generated Job Number
- client
- project/job description
- created date
- LPO number
- LPO date where applicable
- job/LPO value
- VAT
- grand value
- budget
- project status
- notes

The exact Job Number generation rule must remain configurable or provisional until confirmed by the client.

---

### 4.7 Procurement

Procurement records must be connected to a project/job.

Phase 1 should support:

- project/job reference
- procurement requirement
- supplier
- quotation reference
- quotation amount
- quotation attachment
- order/PO reference where applicable
- expected delivery
- procurement status
- remarks

Do not create unnecessarily complicated procurement approvals unless approved.

---

### 4.8 Project Expenses

The accountant must be able to record costs against a project/job.

Examples include:

- materials
- transport
- inspection
- labour
- supplier payment
- bills
- other approved project expenses

Expense records should support appropriate fields such as:

- project/job
- expense date
- expense category
- supplier/payee
- amount
- description
- receipt/bill attachment
- payment reference

Money must be attributable to jobs wherever applicable.

The client specifically identified unidentified/unallocated transfers as a current business problem.

Do not assume how split payments across multiple jobs should work until confirmed.

---

### 4.9 Invoice Tracking

STSLV AMC does NOT generate official Zoho invoices in Phase 1.

Workflow:

Completed work
→ Ready for Invoice
→ Invoice created in Zoho
→ Zoho invoice information entered into STSLV AMC
→ Invoiced

Track information such as:

- invoice number
- invoice date
- invoice amount
- invoice status
- source/reference
- relevant AMC visit or project/job

The design must allow more than one invoice against a project when required.

Do not assume every project has exactly one invoice.

---

### 4.10 Dashboard and Reports

The dashboard should eventually provide operational visibility such as:

AMC:
- active AMC contracts
- upcoming visits
- visits due this month
- completed visits
- pending visits
- ready-for-invoice visits
- invoiced visits
- pending invoices

Projects:
- active projects
- projects in procurement
- projects in execution
- completed projects
- ready for invoice
- invoiced projects
- total job/LPO value
- recorded project costs
- job/project margin

Pending invoices should receive strong visibility because missed invoicing is a major client pain point.

---

## 5. Financial Calculation Rules

Financial calculations must be deterministic and traceable.

Do not invent accounting rules.

For Phase 1, project financial visibility may use:

Job / LPO Value
- Recorded Project Costs
= Job Margin

Do not automatically describe this as formal accounting profit unless the client confirms the accounting definition.

VAT must not be permanently assumed to be a fixed rate without confirming whether it should be configurable.

AMC contract value, cost per visit and number of visits must reconcile where the client's business rules require it.

If a financial business rule is ambiguous, STOP and ask for clarification instead of inventing it.

---

## 6. Phase 1 Exclusions

Unless explicitly approved later, Phase 1 does NOT include:

- full accounting/general ledger
- replacing Zoho
- automatic Zoho invoice generation
- CRM
- sales pipeline
- HR/payroll
- advanced inventory/warehouse management
- supplier portal
- customer portal
- mobile application
- complex workflow engines
- unnecessary microservices
- advanced AI functionality
- advanced analytics beyond required operational reports

Do not expand Phase 1 scope automatically.

---

## 7. Technology Stack

Use the existing project architecture.

### Frontend

- React
- TypeScript
- Vite

Planned supporting libraries may include:

- Tailwind CSS
- shadcn/ui
- TanStack Query
- TanStack Table
- React Hook Form
- Zod

Do not install libraries merely because they are listed here.

Install dependencies only when they are actually required for an approved implementation step.

---

### Backend

- Node.js
- Express
- TypeScript
- REST API

Existing backend packages include Express, CORS, dotenv and PostgreSQL pg driver.

Use modular backend architecture.

Avoid one giant route/controller file.

---

### Database

- PostgreSQL 17
- Local development database: stslv_amc_dev

Database relationships and constraints should enforce important business integrity where practical.

Do not expose PostgreSQL directly to the public internet in production.

Do not put database credentials into source code.

---

### Files

Phase 1 may initially use controlled local/server storage for:

- quotations
- LPO documents
- expense receipts
- bills
- relevant project documents

Store file metadata in PostgreSQL.

Do not store large uploaded file binaries directly in normal relational columns unless there is a specifically approved reason.

Design file handling so object storage can be introduced later without redesigning the business model.

---

### Excel

The client currently depends on Excel.

The system should eventually support appropriate Excel import/export.

Existing client spreadsheets should be treated as migration/reference data, not as the desired future database structure.

Imports should eventually support validation/preview before permanent insertion.

---

## 8. Current Technical State

Baseline recorded on 2026-10-01, after inspecting the repository.

Before relying on this section in future sessions, inspect the repository because implementation may have progressed.

Project root:
D:\Projects\STSLV-AMC

Root contents:

- CLAUDE.md (this file)
- stslv-web
- stslv-api
- docs (exists, currently empty)

The project root is NOT a Git repository. There is no root .gitignore, no root package.json and no workspace/monorepo tooling. stslv-web and stslv-api are independent npm projects, each with its own node_modules and package-lock.json.

### Frontend — stslv-web

- React + TypeScript + Vite has been created (React 19, Vite 8, TypeScript 6).
- It is still the unmodified Vite starter template (src/App.tsx, src/main.tsx, App.css, index.css, starter assets, template README.md). No application code exists yet.
- None of the planned supporting libraries (Tailwind CSS, shadcn/ui, TanStack Query, TanStack Table, React Hook Form, Zod) are installed.
- No router, API client or test framework is installed.
- Linting uses oxlint (.oxlintrc.json).
- A template .gitignore exists (ignores node_modules, dist, *.local). It does not explicitly ignore .env.
- Scripts: `npm run dev` (Vite), `npm run build` (`tsc -b && vite build`), `npm run lint` (oxlint), `npm run preview`.
- The development server has been reported as running successfully on localhost:5173.

### Backend — stslv-api

- Node.js + Express + TypeScript has been created (Express 5, TypeScript 7, CommonJS package type, tsconfig module NodeNext, strict mode).
- src/server.ts is the only source file. It loads dotenv, enables CORS and JSON body parsing, defines GET /api/health and listens on `process.env.PORT` or 3001.
- GET /api/health has been reported as tested successfully on localhost:3001/api/health.
- Dependencies: express, cors, dotenv, pg.
- Dev dependencies: typescript, tsx, @types/node, @types/express, @types/cors, @types/pg.
- Scripts: `npm run dev` (`tsx watch src/server.ts`), `npm run build` (`tsc`), `npm run start` (`node dist/server.js`), `npm run typecheck` (`tsc --noEmit`).
- No .env or .env.example file exists yet.
- No .gitignore exists in stslv-api. One must be added (covering at least node_modules, dist and .env) before any Git repository is initialised.
- No modular structure (routes/controllers/services/data), validation library, authentication, migration tooling or test framework exists yet.
- CORS is currently open to all origins; this must be restricted before production.

### PostgreSQL

- PostgreSQL 17.11 is installed locally and the Windows service postgresql-x64-17 is running.
- Database stslv_amc_dev has been reported as created (not re-verified during the baseline inspection, because no credentials are stored in the project).
- Database connection from the API has NOT yet been completed: pg is installed but is not imported or used anywhere in the code.
- No tables, schema or migrations exist in the project.

### Documentation and client data

- docs/ is empty.
- The three client spreadsheets described in Section 2 are NOT stored in this project folder. Section 2 is based on earlier analysis; the spreadsheets must be supplied again before any migration mapping or data-dependent design decision.

---

## 9. Intended Architecture

Use a modular monolith.

High-level architecture:

React Web Application
        ↓
REST API
        ↓
Node.js / Express
        ↓
PostgreSQL

Do NOT introduce microservices unless there is a clear future requirement and explicit approval.

Conceptual business relationships:

CLIENTS
   ├── AMC CONTRACTS
   │       └── AMC VISITS / SCHEDULE
   │               └── EXECUTION
   │                       └── INVOICE TRACKING
   │
   └── PROJECTS
           ├── PROCUREMENT
           ├── EXPENSES
           ├── EXECUTION
           └── INVOICE TRACKING

Supporting entities may include:

- users
- roles / permissions
- attachments
- audit/activity logs

This is conceptual guidance, not permission to create all tables immediately.

Database schema must be reviewed before implementation.

---

## 10. Development Order

Unless explicitly changed, use this general implementation sequence:

1. Project foundation
2. Environment configuration
3. PostgreSQL connection
4. Database architecture/design
5. Authentication
6. Users and role permissions
7. Client Master
8. AMC Contracts
9. AMC Schedule generation
10. AMC execution
11. Projects
12. Procurement
13. Project expenses
14. Invoice tracking
15. Dashboard
16. Reports
17. Excel migration/import
18. Excel exports
19. Integration testing
20. UAT
21. Deployment preparation
22. Production deployment only after explicit approval

Do not jump ahead simply because later requirements are documented.

---

## 11. Development Rules for Claude

These rules are mandatory for future work on this repository.

### Before implementing

For every task:

1. Read this CLAUDE.md.
2. Inspect the existing implementation relevant to the task.
3. Understand existing database/schema/API/frontend behavior.
4. Preserve working behavior unless the requested change requires modification.
5. Identify ambiguity before implementing a business assumption.
6. Keep the requested scope narrow.

---

### Do not invent business rules

If the client requirement does not specify something important, do not silently decide it.

Examples requiring confirmation include:

- exact meaning of Final Credit
- future Job Number format
- maintenance frequency options
- whether maintenance and billing frequency differ
- rescheduling rules
- cancellation rules
- split payment allocation
- exact profit/margin definition
- VAT configuration
- approval chains
- invoice allocation behavior where ambiguous

Document the ambiguity and ask for clarification.

---

### Database rules

- PostgreSQL is authoritative persistent storage.
- Use proper foreign keys where appropriate.
- Use transactions for multi-step financial/operational writes where needed.
- Do not create duplicate month-specific tables.
- Avoid duplicated derived financial data unless there is a justified snapshot/audit requirement.
- Use appropriate numeric/decimal types for money; do not use floating-point arithmetic for financial values.
- Preserve auditability.
- Do not expose internal database credentials.
- Do not drop or destructively modify data without explicit approval.
- Migrations must be reviewable and ordered.
- Never edit an already-applied production migration as a shortcut.

---

### API rules

- Validate input.
- Return consistent errors.
- Do not leak stack traces, passwords or secrets.
- Enforce authorization server-side.
- Keep route/controller/service/data responsibilities understandable.
- Avoid duplicating business logic across endpoints.

---

### Frontend rules

The application is an operations/business ERP.

Prioritize:

- clarity
- consistency
- readable tables
- clear statuses
- efficient forms
- responsive layout
- accessible controls
- predictable navigation

Avoid unnecessary animation or decorative complexity.

Do not hide important financial or operational information merely for visual minimalism.

---

### Financial safety

Any calculation involving:

- contract value
- cost per visit
- project value
- LPO value
- VAT
- expenses
- invoice values
- margins

must have a clearly identifiable source and calculation path.

Do not silently change financial formulas.

Tests should cover important financial calculations.

---

### Security

- Never hard-code passwords.
- Never commit .env secrets.
- Validate uploaded files.
- Apply authorization on backend routes.
- Treat user-supplied filenames and paths as untrusted.
- Use password hashing for application users.
- Do not log credentials or tokens.
- Production security configuration must be reviewed before deployment.

---

## 12. Git and Deployment Safety

Do NOT automatically:

- git add
- git commit
- git push
- merge branches
- modify remote branches
- deploy
- connect production
- modify VPS configuration
- run destructive database operations

unless explicitly instructed.

Development should remain local until the user explicitly approves repository/deployment actions.

When Git is introduced, maintain a controlled workflow such as:

feature work
→ develop/integration
→ verification/UAT
→ main/release
→ production

The exact branch workflow should be established before repository operations begin.

---

## 13. Testing Expectations

Every substantial module should be tested before being considered complete.

Testing should include where appropriate:

- TypeScript type checking
- backend/API tests
- frontend component/business-rule tests
- validation tests
- permission tests
- financial calculation tests
- integration tests
- end-to-end workflow tests
- manual verification of critical business flows

A successful build alone does not mean a feature is complete.

---

## 14. Definition of Done

A feature is not complete merely because the UI exists.

A feature is considered complete only when the relevant parts are addressed:

Requirement
→ Database
→ Backend/API
→ Permissions
→ Frontend
→ Validation
→ Error handling
→ Tests
→ Manual verification
→ Documentation where needed

For financial/operational features, also verify the calculation and data source path.

---

## 15. Documentation

Keep useful project documentation under:

docs/

Important future documents may include:

- client requirements
- Phase 1 scope
- system architecture
- database schema
- business rules
- Excel migration mapping
- API documentation
- UAT checklist
- deployment procedure
- change log / release notes

Do not treat CLAUDE.md as a replacement for detailed business documentation.

CLAUDE.md defines the persistent development guardrails.

---

## 16. Important Unconfirmed Requirements

The following must remain explicitly unresolved until confirmed:

1. Exact meaning of AMC "Final Credit".
2. Exact AMC frequency options.
3. Whether billing frequency and maintenance frequency are always the same.
4. AMC rescheduling/postponement behavior.
5. Whether one AMC visit can have multiple invoices.
6. Exact future Job Number generation format.
7. Exact project status workflow.
8. Exact procurement statuses/workflow.
9. Whether one payment/transfer can be allocated across multiple jobs.
10. Formal Profit/Job Margin calculation.
11. VAT configuration rules.
12. Required approval hierarchy.
13. Detailed site execution fields.
14. Exact attachment/document requirements.

Do not guess these rules.

---

## 17. Primary Project Principle

STSLV AMC should convert the client's disconnected Excel-driven process into one connected operational workflow.

The intended outcome is:

Enter information once
→ reuse it throughout the workflow
→ maintain traceability
→ prevent missed work
→ prevent missed invoicing
→ attribute spending to jobs
→ provide management visibility.

Do not simply recreate Excel sheets as isolated web pages.

Build connected business workflows.
