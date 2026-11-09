# Administrator Handover Checklist — STSLEV AMC

For handing day-to-day administration of the application to the client's administrator(s). Tick only when done together with the client administrator; record who and when. **Nothing on this list has been completed yet.**

Client administrator(s): ____________________ Supplier contact: ____________________

## 1. Accounts and roles

| # | Item | Done | By / date | Notes |
|---|---|---|---|---|
| 1.1 | At least **two** client staff hold **Super Admin** (no single point of failure) | ☐ | | |
| 1.2 | Supplier/developer accounts reviewed: removed, deactivated or downgraded as agreed | ☐ | | |
| 1.3 | Every active user has exactly one appropriate role (Users & Access, filter Active) | ☐ | | |
| 1.4 | No pending sign-ups left unanswered | ☐ | | |
| 1.5 | Role permissions reviewed with the client; Reports granted where wanted | ☐ | | |
| 1.6 | Live permission matrix exported/recorded in `USER_ACCESS_HANDOVER.md` | ☐ | | |
| 1.7 | Training/UAT/demo accounts deactivated in production | ☐ | | |

## 2. Everyday administration (demonstrated and practised)

| # | Task | Done | By / date |
|---|---|---|---|
| 2.1 | Approve or reject a sign-up | ☐ | |
| 2.2 | Issue a temporary password after verifying identity | ☐ | |
| 2.3 | Deactivate a leaver's account the same day | ☐ | |
| 2.4 | Read Login History for failed sign-ins | ☐ | |
| 2.5 | Search the Audit Log for a change | ☐ | |
| 2.6 | Read the Security Center checks and know which "Attention" items are expected | ☐ | |
| 2.7 | Review and answer Suggestions | ☐ | |
| 2.8 | Restore an item from the Recycle Bin (Super Admin) | ☐ | |
| 2.9 | Add the year's public holidays (Settings → Holidays) | ☐ | |
| 2.10 | Recover when no Super Admin can sign in (`docs/AUTH_SIGNUP_AND_RECOVERY.md`) — procedure understood; needs database access | ☐ | |

## 3. Data

| # | Item | Done | By / date | Notes |
|---|---|---|---|---|
| 3.1 | Demo records in production removed by an approved plan, or explicitly accepted (OI-06) | ☐ | | |
| 3.2 | Master data reviewed: duplicate clients, inactive engineers, unused system types | ☐ | | |
| 3.3 | Older multi-year contracts checked with the Contract Value Review report before choosing a Billing Basis | ☐ | | |

## 4. Infrastructure and backups

| # | Item | Done | By / date | Notes |
|---|---|---|---|---|
| 4.1 | Infrastructure Ownership Register completed and signed | ☐ | | |
| 4.2 | Hosting, database, storage and repository accounts transferred to or shared with the client as agreed | ☐ | | |
| 4.3 | Named backup owner; schedule and retention agreed (OI-01) | ☐ | | |
| 4.4 | One backup restore performed by the client's owner and recorded | ☐ | | |
| 4.5 | Secrets rotated after handover where the supplier held them (`JWT_SECRET`, DB password, storage keys) — note: changing `JWT_SECRET` signs everyone out | ☐ | | |
| 4.6 | Escalation contacts for hosting incidents recorded | ☐ | | |

## 5. Documents handed over

| # | Document | Done |
|---|---|---|
| 5.1 | User guide (`docs/user-guide/USER_GUIDE.md`) and in-app Help shown | ☐ |
| 5.2 | Technical handover, API reference, role matrix (`docs/technical/`) | ☐ |
| 5.3 | Training guide and attendance records | ☐ |
| 5.4 | UAT checklist with results | ☐ |
| 5.5 | Outstanding Issues Register reviewed | ☐ |
| 5.6 | Release notes | ☐ |

Signatures — Client administrator: ____________ Date: ______ · Supplier: ____________ Date: ______
