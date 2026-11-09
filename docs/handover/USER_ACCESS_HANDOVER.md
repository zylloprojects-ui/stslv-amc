# User Access Handover — STSLEV AMC

Records who has access to the production application and with which role at the moment of handover. **Not yet completed.** Fill it from Users & Access in production (the list can be exported by an administrator) together with the client. Do not write passwords here.

Date of record: ____________ Recorded by: ____________ Verified by (client): ____________

## 1. Application users

| # | Full name | Email | Role | Status (Active/Inactive/Pending) | Person / function | Keep after handover? (Y/N) | Action taken | Date |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| 6 | | | | | | | | |

Checks:
- ☐ At least two client Super Admins.
- ☐ No account shared by several people.
- ☐ Supplier accounts handled as agreed.
- ☐ Each user's role matches their job (see `docs/technical/ROLE_PERMISSION_MATRIX.md`).

## 2. Role permissions in force

Starting grants are in the role matrix; the **live** grants may differ. Record any role whose permissions differ from the starting grants:

| Role | Differences from starting grants (added / removed) | Approved by | Date |
|---|---|---|---|
| | | | |

## 3. Infrastructure access (non-application)

| System | Person | Access level | Granted / transferred on | Notes |
|---|---|---|---|---|
| GitHub repository | | | | |
| Cloudflare Pages | | | | |
| Render | | | | |
| Neon | | | | |
| Supabase | | | | |
| Hostinger VPS (when provisioned) | | | | |
| Domain / DNS | | | | |

## 4. Credential hand-over method

Credentials are exchanged only in person or through a password manager agreed by both parties — never by email, chat or in this repository. Record only *that* it happened:

| Credential | Handed to | Method | Date | Rotated afterwards (Y/N) |
|---|---|---|---|---|
| | | | | |
