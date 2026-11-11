# User Acceptance Test Checklist — STS-ELV AMC Phase 1

Prepared 2026-11-09 against commit `c6d8d19` + `feature/stslv-p3-handover`; section 20 added at the final local integration (`integration/stslv-amc-final-20261109`) for the P0, P1 and P2 changes. **No test in this checklist has been executed.** Actual result, Pass/Fail, Tester and Date are left blank on purpose; fill them only when the test is run. Never mark a test Passed that was not executed.

## How to use

- Run in a UAT environment with synthetic data (see `docs/training/TRAINING_GUIDE.md` §2), not the live client database, unless the client approves specific read-only tests on production.
- **Priority:** C = Critical (must pass for sign-off), H = High, M = Medium.
- **Pass/Fail:** `Pass`, `Fail`, `Blocked` or `Not run`. A Fail gets an entry in `docs/handover/OUTSTANDING_ISSUES_REGISTER.md`; put its ID in Comments.
- Roles: SA = Super Admin, AD = Admin, OPS = AMC Operations Executive, FIN = Finance Executive, MD = Master Data Executive, VW = Viewer.
- Test data names start with `UAT-` or `TRN`.

UAT environment: ____________ Application version: ____________ Test period: ____________

---

## 1. Authentication and Help

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| AUTH-01 | C | Any | Active account | Sign in with correct email/password | Lands on the first page the role may open | | | | | |
| AUTH-02 | C | Any | — | Sign in with a wrong password | "Incorrect email or password."; entry in Login History as Failed / Wrong password | | | | | |
| AUTH-03 | H | — | — | Sign up with a new email | "Your registration has been submitted…"; account Pending; cannot sign in | | | | | |
| AUTH-04 | C | AD | Pending account exists | Assign role, Approve | Account Active; user can sign in | | | | | |
| AUTH-05 | C | AD | Active user | Generate temporary password (tick verification); user signs in with it | Shown once; user must choose a new password; old password no longer works | | | | | |
| AUTH-06 | H | AD | Temporary password issued > 15 min ago | User signs in with it | "Your temporary password has expired…" | | | | | |
| AUTH-07 | H | Any | Signed in | My Profile → change password | Saved; new password works at next sign-in | | | | | |
| AUTH-08 | M | Any | — | 6 wrong passwords for one email within 15 min | Further attempts refused: "Too many attempts…" | | | | | |
| HELP-01 | H | OPS | Signed in | On AMC Contracts click **?** | Help panel opens on "AMC Contracts" with "This page: AMC Contracts" | | | | | |
| HELP-02 | H | FIN | Signed in | Open Help → All topics | Only topics for the role's pages + general topics; no AMC Contracts, no Audit Log | | | | | |
| HELP-03 | M | Any | Phone-width browser (≤ 430 px) | Open **?**; open Help & User Guide from account menu | Panel fills the screen and scrolls; Help page shows a Topic drop-down | | | | | |
| HELP-04 | M | Any | Signed in | Search Help for "Regenerate"; open a result; use "Go to …" | Result opens; link opens the page and closes Help | | | | | |

## 2. Dashboard

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| DASH-01 | C | AD | Contracts and services exist | Open Dashboard | Four KPI rows (AMC Portfolio, Current Month, Overall, Current Year (YTD)); figures load | | | | | |
| DASH-02 | C | AD | Known count of Active contracts | Compare Active AMCs with AMC Contracts filtered to Active | Same number | | | | | |
| DASH-03 | C | FIN | One service marked Paid this month | Check Invoices Generated (Current Month) | Count and OMR include it; hint says reference status, not verified payment | | | | | |
| DASH-04 | H | MD | Role without schedule/invoice access | Open Dashboard | Only permitted figures shown; no errors | | | | | |
| DASH-05 | M | OPS | Service today | Click it in Today panel | Service details with payment status wording | | | | | |
| DASH-06 | H | OPS | Services this year before, on and after today | Compare Current Year (YTD) with AMC Schedule filtered from January 1 to today | Due = services in that range (cancelled excluded); Completed + Pending = Due; services after today not counted | | | | | |

## 3. Master Data Center

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| MD-01 | C | MD | — | Add client UAT-Client-1 | Saved, Active, code assigned | | | | | |
| MD-02 | H | MD | — | Add client with empty name; invalid email | "Client name is required."; "Enter a valid email address." | | | | | |
| MD-03 | C | MD | Client used by a contract | Deactivate client | Not offered for new contracts; existing contract unchanged | | | | | |
| MD-04 | H | MD | — | Add sales engineer with an existing code | Refused as duplicate | | | | | |
| MD-05 | H | MD | — | Add frequency interval 3, services per year 3 | "With a 3-month interval, services per year must be 4." | | | | | |
| MD-06 | H | MD | Frequency used by a contract | Edit it | Only name and sort order editable | | | | | |
| MD-07 | M | MD | — | Add system type and department; disable department | Saved; disable shows linked engineers | | | | | |
| MD-08 | M | MD | Filters applied | Export clients Excel and PDF | Files contain filtered rows, no hidden columns | | | | | |
| MD-09 | H | VW | — | Open Clients | No Add/Edit/Deactivate buttons | | | | | |

## 4. AMC Contracts and Contract 360

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| CON-01 | C | OPS | Masters exist | Add contract UAT-AMC-001, Quarterly, 1 year, AMC Value / Year 1,200.000, basis AMC Value / Year, PDF document | Active; 4 services of 300.000 | | | | | |
| CON-02 | C | OPS | — | Add contract without document | "Attach the contract document." | | | | | |
| CON-03 | C | OPS | UAT-AMC-001 exists | Add another contract with reference `uat-amc-001` | "AMC Reference Number already exists…" | | | | | |
| CON-04 | H | OPS | — | Valid to before Valid from; validity 11 years | Respective errors | | | | | |
| CON-05 | C | OPS | Active contract, no services worked on | Edit Valid to (+1 year) | "Confirm schedule change" lists services added; after save the schedule has them | | | | | |
| CON-06 | C | OPS | A service completed | Try to change Valid from | "Valid from cannot be changed: … already been worked on…" | | | | | |
| CON-07 | C | OPS | Active contract | Mark as expired (tick cancel open visits) | Expired; open services cancelled except those with an Invoice No. | | | | | |
| CON-08 | C | OPS | Active contract | Cancel contract with reason | Cancelled (red); nothing deleted; history shows the reason | | | | | |
| CON-09 | H | OPS | Expired contract | Reactivate | Active again | | | | | |
| CON-10 | H | OPS | Contract | Change AMC reference | New reference shown everywhere; old one in history; old cannot be reused | | | | | |
| CON-11 | M | OPS | Filters | Filter by client/year/status; export | Filtered Total matches; export matches | | | | | |
| CON-12 | H | SA | Contract | Delete → Move to Recycle Bin | Disappears from lists; appears in Recycle Bin | | | | | |
| CON-13 | H | OPS | — | Try Delete (not SA) | Not offered / refused | | | | | |

## 5. Schedule Engine, Billing Basis and Regenerate

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| SCH-01 | C | OPS | Frequency 6/year | Contract 1 year, AMC Value / Year 500.000, basis AMC Value / Year | 5 × 83.333 + last 83.335 = 500.000 | | | | | |
| SCH-02 | C | OPS | — | Contract 18 months, quarterly, 1,200.000/year | Year 1: 4 × 300.000; partial year 2: 2 × 300.000 (no proration) | | | | | |
| SCH-03 | C | OPS | Contract without basis, Default visit amount 75.000 | Create | Every service 75.000 | | | | | |
| SCH-04 | C | OPS | Monthly contract starting 31 Jan | Create | Services 31 Jan, 28/29 Feb, 31 Mar… (no drift) | | | | | |
| SCH-05 | C | OPS | Active contract with basis; one service Paid, one completed, one amount set by hand | Change basis to Custom 2,000.000; Regenerate with reason | Preview lists kept services with reasons; others recalculated; Schedule history entry; Audit Log old/new amounts | | | | | |
| SCH-06 | H | OPS | Contract without basis | Regenerate | "Select a Billing Basis first…" | | | | | |
| SCH-07 | H | OPS | — | Regenerate with reason of 2 characters | Button disabled / "Enter the reason for regenerating." | | | | | |
| SCH-08 | C | OPS | Basis changed but not regenerated | Check existing service amounts | Unchanged | | | | | |
| SCH-09 | H | AD | Older multi-year contract | Run Contract Value Review report | Classification shown; nothing changed | | | | | |

## 6. AMC Schedule and Monthly Calendar

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| VIS-01 | H | OPS | Services exist | Filter month/client/status/Paid | List and footer total follow filters | | | | | |
| VIS-02 | H | OPS | Scheduled service | Edit: date, assignee, amount | Saved; amount applies to this service only | | | | | |
| VIS-03 | C | OPS | Paid service | Change amount | Refused: "…it is Paid with Invoice No. … Clear the Invoice No. first." | | | | | |
| VIS-04 | H | OPS | Scheduled service | Visit actions → Postponed with new date | Postponed (grey) with new date | | | | | |
| VIS-05 | M | OPS | Service | Set manual colour Purple; then Clear manual color | Colour shows "Manual · Purple"; cleared returns to automatic | | | | | |
| VIS-06 | M | OPS | — | Monthly by AMC for a month; export | One row per contract; chips show Paid/Unpaid | | | | | |
| CAL-01 | H | OPS | Services in year | Year view; download one month Excel and PDF | Month figures match Accounts for that month | | | | | |
| CAL-02 | H | OPS | Paid and Unpaid services | Month view | Green square = Paid; blue = Unpaid; red dot = overdue | | | | | |
| CAL-03 | M | OPS | Contract ending in ≤45 days | Open Calendar | Renewal warning lists it | | | | | |

## 7. Service Status (completion)

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| SS-01 | C | OPS | Scheduled service, no report | Choose Completed, Save | Popup "Please upload service report."; nothing saved | | | | | |
| SS-02 | C | OPS | — | Upload a .txt or .exe renamed .pdf | Refused (type checked by content) | | | | | |
| SS-03 | C | OPS | — | Upload PDF; Completed; report no. UAT-SR-1; Save | Completed (green), locked; completion date today | | | | | |
| SS-04 | C | AD | Completed service | Try to change status/report as Admin | Refused; lock tooltip | | | | | |
| SS-05 | H | OPS | Report uploaded, not completed | Replace report; then Remove | New version; removal leaves no current report | | | | | |
| SS-06 | H | OPS | Contract expired, no renewal | View its open service | "Waiting for Renewal" (red) | | | | | |
| SS-07 | M | VW | — | View report | View/Download works; no Save/Upload | | | | | |

## 8. Service Sales

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| SAL-01 | H | OPS | Completed service | Enter Quote No. UAT-Q-1, Save | Green; saved by/at shown | | | | | |
| SAL-02 | H | OPS | Not completed service | Try Quote No. | N/A; "Available once the service is completed…" | | | | | |
| SAL-03 | M | OPS | — | Enter "N/A" as Quote No. | "N/A is not a quotation number…" | | | | | |

## 9. Accounts (manual Invoice No.)

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| ACC-01 | C | FIN | Not completed service | Try to enter Invoice No. | Disabled: "Complete the service before entering an invoice number." | | | | | |
| ACC-02 | C | FIN | Completed service | Enter UAT-INV-1, OK | Row green, Paid; Paid note visible | | | | | |
| ACC-03 | C | FIN | Paid service | Clear, OK | Unpaid (blue) | | | | | |
| ACC-04 | C | FIN | Completed service with Zoho record only | View row | Blue (Unpaid) with "Zoho: …" line | | | | | |
| ACC-05 | H | FIN | Two users open the same row | Both save different numbers | Second gets "…changed by someone else… Reload…" | | | | | |
| ACC-06 | H | FIN | Filters | Paid / Unpaid filter, export | KPIs and export match filters | | | | | |
| ACC-07 | C | OPS | Role without Invoice Tracking: Edit | Open Accounts (if granted View) | Invoice No. read-only | | | | | |

## 10. Invoice Tracking (Zoho)

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| INV-01 | C | FIN | Completed service with amount | Record Invoice covering it, allocation = amount | Issued; service Invoiced; leaves "Waiting for an invoice" | | | | | |
| INV-02 | C | FIN | — | Allocations ≠ amount excl. VAT | "The allocations add up to … They must be equal." | | | | | |
| INV-03 | H | FIN | INV-01 recorded | Record same number again | "Invoice … is already recorded…" | | | | | |
| INV-04 | C | FIN | INV-01 recorded | Cancel with reason | Cancelled (grey), excluded from totals; work ready for invoice again | | | | | |
| INV-05 | C | FIN | INV-01 recorded, no manual number | Check Accounts | Still Unpaid (Zoho record does not decide Paid) | | | | | |

## 11. Master AMC Status

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| MAS-01 | H | OPS | Services in each state | Open page | Red not completed; Yellow completed unpaid; Blue paid no quote; Green paid and quoted | | | | | |
| MAS-02 | M | OPS | — | Filter Row Colour, Apply; export | Filtered rows; export matches | | | | | |

## 12. AMC Renewal

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| REN-01 | C | OPS | Active contract ending ≤45 days | Renewal Queue | Listed as Due / Expired (amber) | | | | | |
| REN-02 | C | OPS | REN-01 | Start Renewal, new reference, active engineer, Create | Draft, Under Client Approval; source unchanged | | | | | |
| REN-03 | H | OPS | Source has no active engineer | Start Renewal without choosing one | "A renewal needs an active sales engineer." | | | | | |
| REN-04 | C | OPS | Draft renewal | Approve | Renewed (green); renewal Active with services | | | | | |
| REN-05 | H | OPS | Draft renewal | Cancel with reason; Restart Renewal | Cancelled; new renewal allowed | | | | | |
| REN-06 | M | OPS | — | Renewal History; export | Rows include cancelled renewals | | | | | |

## 13. Reports

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| REP-01 | C | FIN | Reports granted | AMC Contract Summary for current year | Scheduled (Current Year) equals Accounts Total Value for the year | | | | | |
| REP-02 | C | FIN | — | Billing Schedule, Paid only | Same count as Accounts Paid filter | | | | | |
| REP-03 | H | AD | — | Run each of the 12 reports | All open without error | | | | | |
| REP-04 | H | AD | — | Export a report to Excel and PDF | Filters and Total line included | | | | | |
| REP-05 | M | AD | — | From date after To date | "The From date is after the To date." | | | | | |
| REP-06 | H | OPS | Reports not granted | Open /reports | Access denied | | | | | |

## 14. Users and Roles

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| USR-01 | C | SA | — | Create user with role Finance Executive | User can sign in and sees only Finance pages | | | | | |
| USR-02 | C | AD | Super Admin user exists | Try to change Super Admin's role | "Only Super Admin can manage Super Admin and Admin accounts." | | | | | |
| USR-03 | C | SA | Only one active Super Admin | Remove own Super Admin role | Refused ("This is the only active Super Admin…") | | | | | |
| USR-04 | C | SA | — | Grant Viewer *Reports: View*, save; sign in as Viewer | Reports visible immediately | | | | | |
| USR-05 | H | SA | — | Grant *AMC Contracts: Delete* without Edit | "… also needs … Grant both, or neither." | | | | | |
| USR-06 | H | AD | — | Try to change a **built-in** role's permissions (e.g. Viewer) | Not allowed: "Only Super Admin can change a built-in role or its permissions." | | | | | |
| USR-07 | C | SA | User active | Deactivate; user makes a request | Refused on next request | | | | | |

## 15. Security Center, Login History, Audit Log

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| SEC-01 | H | AD | — | Open Security Center | Checks listed with states; database updates all applied | | | | | |
| SEC-02 | H | OPS | — | Open /settings/security | Access denied | | | | | |
| LOG-01 | H | AD | AUTH-02 done | Login History, Outcome Failed | Entry with reason and address | | | | | |
| AUD-01 | C | AD | ACC-02 and SCH-05 done | Audit Log, search | Invoice No. change (old/new) and regeneration (reason, amounts) present | | | | | |
| AUD-02 | H | OPS | — | Open /admin/audit-log | Access denied | | | | | |

## 16. Recycle Bin

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| RB-01 | C | SA | Contract in bin (CON-12) | Restore | Back with same reference and services | | | | | |
| RB-02 | H | SA | Unused client in bin | Delete permanently typing code | Removed; Deletion History "Deleted permanently" | | | | | |
| RB-03 | C | SA | Contract in bin | Try permanent delete | "AMC contracts are never deleted permanently…" | | | | | |
| RB-04 | H | SA | Client used by a contract | Move to bin | "…still in use… Deactivate it instead." | | | | | |
| RB-05 | H | AD | — | Open Recycle Bin page | Deletion History only | | | | | |

## 17. Suggestions

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| SUG-01 | M | VW | — | Submit suggestion via light bulb | Reference shown; listed in My Suggestions | | | | | |
| SUG-02 | M | AD | SUG-01 | Review: Under Review → Resolved with notes | Submitter sees status and response | | | | | |
| SUG-03 | M | VW | Resolved suggestion | Reopen with reason | Reopened (rose) | | | | | |

## 18. Backup status

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| BAK-01 | H | AD | Backups not configured | Open Backup & Restore | "Manual backups are not available here." with reason; no Back up now | | | | | |
| BAK-02 | C | Owner | — | Take an outside-application `pg_dump` and restore it into a scratch database | Restore succeeds; counts match (record evidence) | | | | | |

## 19. Responsiveness and general

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| GEN-01 | H | Any | Phone | Open menu, navigate 3 pages, open Help | Usable without horizontal page scroll (tables scroll inside) | | | | | |
| GEN-02 | M | Any | — | Dark mode; open Help, Accounts, Calendar | Readable contrast | | | | | |
| GEN-03 | M | Any | Unsaved form | Navigate away | Asked to confirm | | | | | |
| GEN-04 | H | Any | — | Reload a deep link (e.g. /amc/contracts) | Page loads | | | | | |

## 20. Integration additions (P0 security, P1 rules, P2 improvements)

Rules marked *switch* need `SERVICE_REPORT_NO_LOCK_ENABLED=true` or `AMC_CONTRACT_EXPIRY_ENABLED=true` **in the UAT environment only**; both stay off in production until approved.

| Test ID | Pri | Role | Preconditions | Test steps | Expected result | Actual result | Pass/Fail | Tester | Date | Comments |
|---|---|---|---|---|---|---|---|---|---|---|
| INT-01 | C | any | Signed in before the 0108 release | After the release, open any page | Asked to sign in again (once) | | | | | |
| INT-02 | C | any | Signed in | Leave the application unused for 30 minutes, then click | "You were signed out after 30 minutes of inactivity. Please sign in again." | | | | | |
| INT-03 | C | any | Signed in on two browsers | My Profile → Active sessions → sign out the other device | The other browser is signed out on its next request | | | | | |
| INT-04 | C | AD | Another user signed in | Security Center → Active sessions → sign that session out | That user must sign in again | | | | | |
| INT-05 | H | any | — | Change password to `Welcome@123`, then to a 12+ character varied password | First refused with the rule; second accepted; other sessions signed out | | | | | |
| INT-06 | H | SA | — | Try to edit or delete an Audit Log entry (any route or tool available to the application) | Not possible; entries are only added | | | | | |
| INT-07 | C | AD | AD holds Users & Access Edit | Settings → Role list → Add role `UAT_SITE`; give it Dashboard View and AMC Schedule View; assign to a test user | Saved; the user sees only those pages | | | | | |
| INT-08 | C | AD | INT-07 | Try to give `UAT_SITE` Users & Access View | Refused: only Super Admin can give a role Users & Access | | | | | |
| INT-09 | C | AD | — | Try to rename or change permissions of Viewer, Admin or Super Admin; try to assign Super Admin to a user | All refused | | | | | |
| INT-10 | C | SA | A custom role with Reports View exists (Admin lacks Reports) | As Admin, try to rename, delete or assign that role | Refused; the row says the role grants permissions Admin does not hold | | | | | |
| INT-11 | H | SA | — | Remove Users & Access Edit from Admin; as Admin open Role list | No Add/Edit/Delete; server refuses role changes. Restore afterwards | | | | | |
| INT-12 | C | VW+ | Viewer granted Reports View, not Accounts View | Open Reports | Only reports of permitted source pages listed; Monthly Maintenance needs Accounts View | | | | | |
| INT-13 | H | OPS | Calendar data | Monthly Calendar → Month → By contract; then Year view | One entry per contract with counts; no switch in Year view | | | | | |
| INT-14 | H | OPS | A service with two Zoho invoices, one with a reference | Master AMC Status → Export Excel | Zoho Invoices (Tracking) and Zoho References (Tracking) columns, reference beside its invoice, "—" for the other | | | | | |
| INT-15 | C | OPS/AD | *switch* SERVICE_REPORT_NO_LOCK; a Paid service | Change its Service Report No. as OPS; then as Admin with a reason | OPS refused; Admin succeeds only with a reason; Audit Log entry | | | | | |
| INT-16 | C | SA | *switch* AMC_CONTRACT_EXPIRY; contract with Valid To = yesterday (Oman) and an open renewal; contract with Valid To = today | Run the expiry job | Yesterday's contract Expired; today's still Active; services and the renewal unchanged; Audit Log entry | | | | | |
| INT-17 | C | FIN | A cancelled contract with a Completed+Paid service and an open service | Compare Dashboard, Accounts, Service Status, Master AMC Status, Service Sales | The Paid service counted everywhere; the open one nowhere | | | | | |
| INT-18 | H | VW | — | Open Help on several pages | Only topics for pages the role may open; Help text matches the screen | | | | | |
| INT-19 | M | any | Phone (about 390 px wide) and desktop (about 1440 px) | Help panel, Role list, Active sessions, Calendar By contract | Usable on both, no horizontal page scroll | | | | | |

---

## Summary (fill after execution)

| Area | Tests | Pass | Fail | Blocked | Not run |
|---|---|---|---|---|---|
| All | | | | | |

UAT lead: ____________ Signature: ____________ Date: ____________
