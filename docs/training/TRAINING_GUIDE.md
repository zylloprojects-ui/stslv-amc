# STSLEV AMC — Training Guide

Prepared 2026-11-09. **No training has been delivered yet.** Record each session on `docs/handover/TRAINING_ATTENDANCE_TEMPLATE.md`.

Reference material: `docs/user-guide/USER_GUIDE.md` (chapter numbers below refer to it) and the in-app **?** Help.

## 1. Rules for every session

1. **Use a training environment, never the live client database.** A local or staging copy restored from a sanitised dump, or an empty database with the synthetic data in §2. Exercises create, complete and invoice records; in production those actions are permanent (completion cannot be undone; contracts are never deleted).
2. **Use only the synthetic data in §2.** Every name starts with `TRN`; no real client, engineer, invoice or person.
3. Each trainee signs in with their own training account of the role being trained. The trainer keeps a Super Admin account.
4. Invoice numbers used in exercises are fictitious (`TRN-INV-…`). Do not type real Zoho numbers.

## 2. Synthetic training data (set up by the trainer, as Super Admin)

| Type | Records |
|---|---|
| Departments | `TRN-OPS` Training Operations; `TRN-FIN` Training Finance |
| Sales Engineers | `TRN-SE-01` Training Engineer One (TRN-OPS); `TRN-SE-02` Training Engineer Two (TRN-OPS) |
| System Types | `TRN-FA` Training Fire Alarm; `TRN-CCTV` Training CCTV |
| Maintenance Frequencies | Built-in Quarterly and Half-yearly; trainer adds `TRN Every 2 Months` (code `TRN_EVERY_2_MONTHS`, interval 2, 6 per year, prefix B) for OP-3. Trainees add `TRN Every 4 Months` in MD-3 |
| Clients | `TRN Alpha Facilities LLC`, `TRN Beta Towers LLC`, `TRN Gamma Clinic` (contact "Training Desk", email `desk@trn.example`) |
| Contract documents | Any small PDF named `TRN-contract.pdf` with the text "Training document — not a contract" |
| Service reports | `TRN-report-1.pdf`, `TRN-report-2.pdf` with "Training service report" |
| Users | `trn.admin@trn.example` (Admin), `trn.ops@…` (AMC Operations Executive), `trn.fin@…` (Finance Executive), `trn.md@…` (Master Data Executive), `trn.view@…` (Viewer). Use temporary passwords (Users & Access) so each trainee sets their own |

Grant **Reports: View, Export** to the Admin, Finance and AMC Operations training roles if the reports exercise is included (no built-in role starts with Reports).

## 3. Tracks

| Track | Audience | Duration (guide) | Exercises |
|---|---|---|---|
| A. Super Admin | System owner(s) | 3 h | GS-1, SA-1…SA-6, all of B–E as demonstration |
| B. Admin | Office administrators | 2 h | GS-1, AD-1…AD-4, OP-1, RP-1 |
| C. AMC Operations | Operations executives, coordinators | 2.5 h | GS-1, OP-1…OP-6, RP-1 |
| D. Finance | Accounts / invoicing staff | 2 h | GS-1, FN-1…FN-5, RP-1 |
| E. Master Data | Master data maintainers | 1.5 h | GS-1, MD-1…MD-4 |
| F. View-only | Managers, viewers | 1 h | GS-1, VW-1, VW-2, RP-1 (view only) |

### Key messages for every track

- Pages you do not see are not in your role; the server checks every action.
- A **new contract is Active** and its services are generated immediately.
- **Completing a service is final**: upload the Service Report first; there is no reopen.
- **Invoice No. = Paid** is a **reference status**: it does not prove money was received. Zoho remains the invoicing system; Invoice Tracking holds Zoho details and does not change Paid / Unpaid.
- **Regenerate** is the only way existing service amounts change, and it keeps completed, Paid, Zoho-invoiced and hand-set amounts.

## 4. Exercises

Each exercise lists the expected result. The trainee ticks it on the attendance sheet only when they reached that result themselves.

### Getting started (all tracks)

**GS-1 Sign in and find help**
1. Sign in with the temporary password; choose a new password when asked.
2. Open the **?** Help on the Dashboard; search "Paid"; open *Paid status and Zoho invoices*.
3. Open **Help & User Guide** from the account menu; pick your role's first module.
4. Send a test suggestion (light bulb): type *Improvement*, subject "TRN test suggestion".
*Expected:* new password accepted; Help shows only topics for your pages; suggestion gets a reference visible under My Suggestions.

### Master Data (track E; A demonstrates)

**MD-1 Add a client** — Add `TRN Delta Stores` with contact and email. *Expected:* client listed as Active with a code.
**MD-2 Deactivate and reactivate** — Deactivate `TRN Delta Stores`; check it is not offered in the contract form (trainer shows); reactivate. *Expected:* status changes; nothing deleted.
**MD-3 Frequency rule** — Add `TRN Every 4 Months` (interval 4 → services per year 3, prefix T). Try services per year 4. *Expected:* error "With a 4-month interval, services per year must be 3."
**MD-4 Engineer and department** — Add engineer `TRN-SE-03` in `TRN-OPS`; try the code `TRN-SE-01` again. *Expected:* duplicate refused.

### AMC Operations (track C; also B and A)

**OP-1 Create a contract** — Add Contract: reference `TRN-AMC-001`, client `TRN Alpha Facilities LLC`, system `TRN-FA`, engineer `TRN-SE-01`, Quarterly, Valid from 1st of the current month, duration 1 year, AMC Value / Year **1,200.000**, Final credit 0, Billing basis **AMC Value / Year**, document `TRN-contract.pdf`.
*Expected:* status Active; 4 services generated; each **300.000**; Visits 0 of 4.

**OP-2 Schedule generation check** — Open the contract (Contract 360) → Service schedule. Read the Calculation rule and the service labels (Year 1 · Q1…Q4). Then add `TRN-AMC-002` for `TRN Beta Towers LLC`, Half-yearly, 2 years, AMC Value / Year **500.000**, Billing basis AMC Value / Year.
*Expected:* 4 services of **250.000**; "Expected for the term less visits" shows 0.000.

**OP-3 Rounding remainder** — Add `TRN-AMC-003` (`TRN Gamma Clinic`, `TRN-CCTV`, frequency **TRN Every 2 Months**, which the trainer adds beforehand: interval 2, 6 services per year, prefix B) with AMC Value / Year **500.000** and basis AMC Value / Year, 1 year.
*Expected:* 5 services of 83.333 and the last of **83.335** (total 500.000).

**OP-4 Complete a service** — On Service Status, filter to the current month, find `TRN-AMC-001` Q1.
a) Choose Completed without a report. *Expected:* "Please upload service report." — nothing saved.
b) Upload `TRN-report-1.pdf`, choose Completed, enter Service Report No. `TRN-SR-001`, Save. *Expected:* green Completed with a lock; completion date = today; the status can no longer be changed.

**OP-5 Postpone a service** — On AMC Schedule, Visit actions on `TRN-AMC-001` Q2 → Postponed, new planned date +7 days, reason "TRN access not available". *Expected:* grey Postponed; new date shown.

**OP-6 Renewal** — Trainer prepares `TRN-AMC-004` ending within 45 days. On AMC Renewal: Start Renewal → new reference `TRN-AMC-004-R1`, engineer `TRN-SE-02` → Create renewal. Then **Approve**.
*Expected:* Under Client Approval (light blue) → Renewed (green); `TRN-AMC-004` itself unchanged; the renewal has its own services.

### Finance (track D; also A)

**FN-1 Invoice No. requires completion** — In Accounts, try to enter `TRN-INV-0001` on `TRN-AMC-001` Q2 (not completed). *Expected:* field disabled: "Complete the service before entering an invoice number."

**FN-2 Mark Paid** — Enter `TRN-INV-0001` on `TRN-AMC-001` Q1 (completed in OP-4) → OK. *Expected:* row green, Paid; Dashboard "Invoices Generated" +1; hint says reference status, not verified payment.

**FN-3 Undo Paid** — Clear the number → OK, then enter it again. *Expected:* Unpaid (blue) then Paid; both changes in the Audit Log (trainer shows).

**FN-4 Record a Zoho invoice** — Invoice Tracking → Record Invoice: client `TRN Alpha Facilities LLC`, number `TRN-ZOHO-0001`, today, amount excl. VAT 300.000, VAT 15.000, covers `TRN-AMC-001` Q1 with 300.000.
*Expected:* invoice Issued; Q1 Invoicing = Invoiced; Accounts shows "Zoho: TRN-ZOHO-0001" under the Invoice No.; **Paid/Unpaid did not change because of it**. Try allocating 250.000 → "The allocations add up to 250.000, but the invoice amount excluding VAT is 300.000…".

**FN-5 Regenerate (with trainer)** — On `TRN-AMC-002` change Billing basis to Custom Billing Value **600.000**, save, then **Regenerate** with reason "TRN annual value revised".
*Expected:* preview shows recalculated amounts (300.000 each); Paid/completed services keep their amounts; Schedule history lists the generation; Audit Log holds old and new amounts.

### Reports (tracks B, C, D, F)

**RP-1 Reports and exports** — Reports → *Billing Schedule*, filter client `TRN Alpha Facilities LLC`, Paid / Unpaid = Paid; export Excel and PDF. Then *Contract Value Review*.
*Expected:* only TRN rows; export includes the filters and a total line; Contract Value Review changes nothing.

### View-only (track F)

**VW-1 Read the Dashboard and Calendar** — Explain the three KPI rows; open Monthly Calendar Month view and read a Paid (green square) and an Unpaid (blue square) service. *Expected:* trainee explains colours correctly.
**VW-2 No editing** — Open AMC Contracts and Accounts. *Expected:* no Add/Edit buttons; Invoice No. read-only.

### Admin (track B; also A)

**AD-1 Approve a sign-up** — Trainer signs up `trn.new@trn.example`. Filter Pending → assign Viewer → Approve. *Expected:* status Active; user can sign in.
**AD-2 Temporary password** — Generate a temporary password for `trn.view@…` after the verification tick. *Expected:* shown once; works 15 minutes; user must change it.
**AD-3 Login History and Audit Log** — Find the failed sign-in of a wrong password; find the FN-2 Invoice No. change. *Expected:* both found with user and time.
**AD-4 Security Center** — Read the checks; explain "Backups are not available from this application here" in the training environment.
**AD-5 Custom role (approved 2026-11-09)** — Settings → Organization → Role list → Add role `TRN_SITE`; in Roles & Permissions give it Dashboard View and AMC Schedule View; assign it to `trn.view@…`; then try to give it Users & Access View and try to rename Viewer. *Expected:* role created and assigned; the Users & Access grant and the Viewer change are refused (Super Admin only).
**AD-6 Sessions** — Security Center → Active sessions: sign out the trainee's second browser. *Expected:* that browser must sign in again. Explain the 30-minute inactivity sign-out and that a password change signs out everywhere.

### Super Admin (track A)

**SA-1 Roles & Permissions** — Give the Finance training role *Reports: View* and save; try saving *AMC Contracts: Delete* without *Edit*. *Expected:* saved / refused with the dependency message. As the Finance trainee, open Reports. *Expected:* only the Accounts-sourced reports are listed (each report also needs View of its source page).
**SA-2 Admin-only management** — As Admin (trainee second account) try to change a Super Admin's role. *Expected:* "Only Super Admin can manage Super Admin and Admin accounts."
**SA-3 Recycle Bin** — Move client `TRN Delta Stores` (unused) to the Recycle Bin, restore it, move it again and **Delete permanently** by typing its code. *Expected:* each step succeeds; Deletion History lists them.
**SA-4 Cancel a contract** — Cancel `TRN-AMC-003` with reason "TRN cancellation", ticking "Also cancel the scheduled and postponed visits". *Expected:* Cancelled (red); open services cancelled; nothing deleted.
**SA-5 Backup status** — Read Backup & Restore; explain who takes production backups (Infrastructure Ownership Register).
**SA-6 Suggestions Review** — Move the GS-1 suggestion to Under Review, then Resolved with notes. *Expected:* submitter sees the response.

## 5. Assessment

A trainee is considered trained for a track when every exercise of the track reached its expected result without the trainer's hands on the keyboard, and the trainee can explain in their own words:

1. what "Paid" means and what it does not;
2. why completion is final;
3. when service amounts change.

Record the result on the attendance sheet. Do not record a trainee as trained otherwise.

## 6. After training

- Remove or deactivate the training accounts in the training environment.
- Never copy training records into production.
- Add questions raised to the Outstanding Issues Register.
