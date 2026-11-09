# UAT Checklist — Final Integration

**Client UAT has not been executed.** Nothing in this document records client acceptance. The automated and
browser checks below were run by the delivery team on an isolated local copy with synthetic data; they show
the build is ready **for** UAT, not that UAT passed.

The complete client checklist is `docs/uat/UAT_CHECKLIST.md` (sections 1–19 from P3, section **20 added at
integration** for the P0/P1/P2 changes, tests INT-01 … INT-19). Results, testers and dates are blank there
on purpose and must be filled only when tests are run.

## 1. Before UAT starts (owner approvals)

- [ ] A UAT environment separate from production (VPS on a temporary host name, or another approved copy),
      with synthetic `UAT-`/`TRN` data — not the live client database.
- [ ] Migrations 0108 and 0109 applied **in that UAT database** (approved for it).
- [ ] In UAT only: `SERVICE_REPORT_NO_LOCK_ENABLED=true`, and the expiry job runnable with
      `AMC_CONTRACT_EXPIRY_ENABLED=true`, to test INT-15 and INT-16. Production stays off.
- [ ] Test accounts for each role (SA, AD, OPS, FIN, MD, VW), passwords meeting the new rules.
- [ ] Testers briefed: everyone signs in again after the 0108 release (INT-01).

## 2. Pre-UAT evidence from the delivery team (isolated, synthetic)

Browser run on 2026-11-09 against web `127.0.0.1:5311` → API on database `stslv_amc_final_integration`,
schema `e2e` (headless Microsoft Edge driven over the DevTools protocol; see `TEST_RESULTS.md` §4). 23 of 23
checks passed. These map to the UAT cases as follows — **they do not replace them**:

| Brief workflow | Covered by browser check | Related UAT case |
|---|---|---|
| 1 Super Admin login and custom-role management | 1a–1e | USR-*, INT-07 |
| 2 Admin permitted role management | 2a, 2b | INT-07 |
| 3 Admin blocked from Users & Access | 3a, 3b, 3c | INT-08, INT-09 |
| 4 Unauthorized user blocked | 4 | INT-11 |
| 5 Create contract and schedule | 5 (contract created by the seed through the service layer; schedule and Contract 360 checked in the browser) | CON-*, SCH-* |
| 6 Calendar By service / By contract | 6 | INT-13 |
| 7 Completion and invoice reference | 7 (Invoice No. saved from the signed-in page; Accounts and Master AMC Status show it) | ACC-*, MAS-* |
| 8 Paid reference status | 8 | INT-14 |
| 9 Service Report No. lock and override | 9 | INT-15 |
| 10 Permitted report export | 10 | INT-12 |
| 11 Restricted report denied | 11 | INT-12 |
| 12 Expiry at Oman date boundaries | 12 (ended yesterday → Expired; ends today → Active; renewal untouched; second run no-op) | INT-16 |
| 13 Session revocation | 13 (Security Center → Active sessions → Sign out) | INT-03, INT-04 |
| 14 Role-filtered Help | 14 | INT-18 |
| Layout 390 px / 1440 px | L (no horizontal page scroll on 5 pages) | INT-19 |

Not covered by the browser run, to be done by people in UAT: creating a contract through the full form with a
document upload; uploading a service report through the UI; Excel/PDF files opened and read; dark mode; real
phones and tablets; the PDF viewer under the VPS CSP; the inactivity sign-out after 30 real minutes.

## 3. Sign-off

Client sign-off uses `docs/handover/CLIENT_SIGNOFF_FORM.md`. **Not signed.**
