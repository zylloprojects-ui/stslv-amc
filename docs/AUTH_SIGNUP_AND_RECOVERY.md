# STSLEV AMC — Sign Up and Password Recovery

What the public Sign up and Forgot password pages do, how a forgotten password is recovered with a temporary password issued by an Admin, how this is kept safe, and what is still to be decided. The rest of authentication (login, sessions, roles, permissions) is described in [`FOUNDATION.md`](FOUNDATION.md).

## 1. Sign up

STSLEV AMC is an internal system. Anyone can *ask* for an account; nobody can *give themselves* access.

```
Sign up page  →  account stored PENDING + inactive, no role
              →  administrator opens Users & Access
              →  assigns a role  →  Approve
              →  account APPROVED + active  →  the person can sign in

              or  →  Reject
              →  account REJECTED + inactive, no role  →  no access
              →  the same email may sign up again  →  PENDING once more
```

- `POST /api/auth/signup` accepts exactly `fullName`, `email` and `password`. Any other field (`role`, `roleIds`, `permissions`, `isActive`, …) makes the request fail with 400: it is refused, not ignored.
- The account is created with `is_active = false`, `approval_status = 'PENDING'` and no row in `user_roles`. The database itself refuses any account that is active without being approved (`users_unapproved_inactive_ck`).
- A pending account cannot sign in and cannot be issued a temporary password. Login answers it exactly as it answers a wrong password.
- The response is the same whether the email is new, pending, approved or rejected, so the page cannot be used to find out who has an account. An approved or pending account is never changed; its owner is told by email, and the attempt is written to the activity log. A rejected one is reopened (see below).
- The password is hashed with bcrypt before anything else happens. It is never stored, logged or returned.
- Users created by an administrator (**Create User**, `npm run admin:create`) are `APPROVED` and active immediately, as before.

### Approval in Users & Access

A pending account shows a **Pending approval** badge and an **Approve** action (the existing activate route, `POST /api/users/:id/activate`). Approving sets the account active and `APPROVED`. A notice above the table counts the requests that are waiting.

Approving an account that has no role is allowed, and the dialog says so: the person can sign in but sees no module until a role is assigned.

### Rejection in Users & Access

A pending account also has a **Reject** action (`POST /api/users/:id/reject`, needs `USERS:EDIT`), behind a confirmation dialog that names the person and email.

- Only a `PENDING`, inactive account can be rejected. An approved account, whether active or deactivated and however it was created, gets 409 and is not touched.
- The account becomes `REJECTED`. It is kept, not deleted, because the activity log refers to it. It stays inactive, any role given while it was pending is removed, and any old password reset tokens are revoked.
- A rejected account cannot sign in, cannot be issued a temporary password, and cannot be activated or given a role by an administrator. It is listed as **Rejected**, with no actions, and is not counted as waiting.
- Approve and reject lock the user row, so two administrators deciding at the same moment produce one outcome.

### Signing up again after a rejection

The same email may submit a new request. The existing account is put back to `PENDING`: still inactive, no role, with the newly entered name and password, and an administrator decides again. The statement that does this only matches a `REJECTED`, inactive row, so an approved or pending account can never be changed or downgraded by a sign-up.

## 2. Forgotten passwords: temporary password issued by an Admin

Email reset links were retired on 2026-10-29. There is no self-service recovery and no email involved: an Admin issues a temporary password after checking who is asking.

```
Employee forgets password  →  contacts an Admin (phone / in person)
Admin  →  Users & Access  →  Generate temporary password (key icon) on the employee's row
       →  ticks "I have verified that the person asking is …"
       →  POST /api/users/:id/temporary-password
       →  the password is shown once, with Copy  →  passed on privately
Employee  →  signs in with email + temporary password (within 15 minutes)
          →  only the Change password screen (/change-password) is open
          →  POST /api/auth/complete-password-change  (new password)
          →  every session ends  →  /login: "Your password has been changed…"
          →  signs in normally with the new password
```

The Forgot password page (`/forgot-password`) only says: "Forgot your password? Please contact your system administrator to receive a temporary password."

| Rule | How it is enforced |
|---|---|
| Only Admins | The route needs `USERS:EDIT` **and** the built-in Admin role (checked in `issueTemporaryPassword`). A role that is granted `USERS:EDIT` does not get this; nothing is granted to any role. The existing rule that you cannot manage a user holding permissions you lack still applies. |
| Not your own account | 409. Use My account to change your own password. |
| Identity check | The request must carry `identityVerified: true`, sent by the checkbox in the dialog; it is recorded in the audit entry. |
| Strong and random | 16 characters from a 53-character alphabet without look-alikes (no 0/O/o, 1/l/I, 5/S/s), shown as `xxxx-xxxx-xxxx-xxxx`; about 92 bits, from `crypto.randomInt`. |
| Never stored or logged | Only its bcrypt hash, in `users.password_hash`, like any password. It appears in the one API response (sent with `Cache-Control: no-store`) and in the dialog, which forgets it when closed. Not in the activity log, the users list or any other response. |
| Replaces the old password | The old password stops working at once; `password_changed_at` moves, so every existing session of the user ends. |
| 15 minutes | `users.temporary_password_expires_at`. After it, sign-in answers `401 TEMPORARY_PASSWORD_EXPIRED` ("Your temporary password has expired. Please contact your system administrator to receive a new temporary password."), only to someone who typed the right temporary password; a wrong password still gets the usual answer. An unfinished change is refused too. |
| Change before anything else | `users.must_change_password`. Such a session is refused on every protected API route with `403 PASSWORD_CHANGE_REQUIRED`, except `GET /api/auth/me` and `POST /api/auth/complete-password-change` (the middleware denies by default, so a new route is closed to it too). The web app sends it to `/change-password` from any address. |
| One use | Completing the change clears the flag and expiry and moves `password_changed_at`; the token issued for the temporary password carries a `pc` claim and is refused once the flag is cleared, even within the same second. The temporary password no longer matches the stored hash. |
| Reissue | A new temporary password replaces the previous one (it stops working, and any session from it ends). |
| Deactivated / unapproved | Refused with 409. Deactivating a user later also stops a temporary password from signing in. |
| Rate limits | `TEMPORARY_PASSWORD_RATE_LIMIT` (default 10) per Admin per 15 minutes. Guessing a temporary password at sign-in meets the normal login limits (section 4). |
| New password | The usual rules (10+ characters, at most 72 bytes) and must differ from the temporary one. Hashed with bcrypt (`BCRYPT_ROUNDS`). |

Roles and permissions are never changed by any of this.

### Admin recovery

- **Another Admin exists:** they issue the locked-out Admin a temporary password exactly as above; the Admin must change it at sign-in.
- **No other Admin can sign in:** there is deliberately no public emergency route and no default password. Someone with verified access to the infrastructure (the hosting dashboard and the production database credentials) runs, from a trusted machine with `stslv-api/.env` pointing at that database:

  ```
  npm run admin:create
  ```

  It asks for an email, name and password interactively (never on the command line, never written to disk) and creates a new active Admin. That Admin signs in, issues the locked-out Admin a temporary password in Users & Access, and the new account can afterwards be deactivated. The creation is written to the activity log. Do this only after confirming the request through a second channel, and record who did it and why.

### Users created by an administrator

**Create User** still takes an initial password chosen by the administrator, as before; it is not a temporary password and does not force a change. (Open question 1.)

## 3. Email delivery

`src/shared/mailer.ts` is the single place email is sent from. Password recovery no longer uses it; the only message left is the private note to the owner of an existing account when someone signs up with their address. `MAIL_TRANSPORT` chooses how it is handled:

| Value | Behaviour |
|---|---|
| `none` (default) | Nothing is sent. Only `Email not sent … "<subject>"` is logged: no recipient, no body. |
| `log` | **Local development only.** The whole message is printed to the API console. The API refuses to start with `MAIL_TRANSPORT=log` when `NODE_ENV=production`. |
| `memory` | Automated tests only; refused outside them. |

No email provider is configured, and none is needed for recovery.

## 4. Abuse limits

`/signup` is limited to `PUBLIC_AUTH_RATE_LIMIT` requests per network address per 15 minutes (default 10). Issuing temporary passwords is limited per Admin (section 2). The counts live in the API process's memory. Behind a reverse proxy, Express must be configured to trust the proxy or every visitor is counted as one address.

`/login` has two limits, both per 15 minutes and kept in the same process memory:

- `LOGIN_RATE_LIMIT` (default 50) sign-in requests per network address, successful or not. Generous because an office's staff may share one address.
- `LOGIN_FAILURE_LIMIT` (default 5) failed sign-ins for one email from one network address. A successful sign-in clears the count. Because it is keyed on address and email together, failures from another network never block the real user, and no account is ever locked.

Over either limit the API answers `429 TOO_MANY_REQUESTS` ("Too many attempts. Please wait a few minutes and try again."), whatever the email, so the limit does not reveal which emails have accounts. Below the limits, every failure still gets the one `401 INVALID_CREDENTIALS` answer (except an expired temporary password typed correctly, see section 2). Requests that arrive at the same moment are checked before any of them finishes, so a burst can exceed the failure limit slightly; the per-address limit still bounds it.

Every failed sign-in writes an `auth.login_failed` activity entry (module `AUTH`, no acting user) with `metadata.reason` (`unknown_account`, `wrong_password`, `inactive_account` or `temporary_password_expired`) and `metadata.ip`. For an existing account the entry points to that user; for an email with no account the email is not stored, because people sometimes type their password into the email field. Passwords and tokens are never logged.

## 5. Database

| Migration | Change |
|---|---|
| `0040_user_approval_status` | `users.approval_status` (`PENDING` / `APPROVED`, default `APPROVED`) and the pending-implies-inactive check. Existing users become `APPROVED`. |
| `0041_password_reset_tokens` | New table `password_reset_tokens`. No longer written since email reset links were retired; kept, with its rows, for the record. Outstanding rows are still revoked when a password or access changes. |
| `0042_user_registration_rejection` | Adds `REJECTED` to `users.approval_status`; the check becomes "only an approved account can be active". Replaces the two CHECK constraints from 0040; no row changes. |
| `0086_temporary_passwords` | `users.must_change_password` (default false) and `users.temporary_password_expires_at` (null), set and cleared together (`users_temporary_password_ck`). Existing users are unaffected. Numbered after 0080/0081 (roles & permissions) and 0085 (suggestions) from other branches. |

No table, column or row is dropped or rewritten.

## 6. API

| Route | Who | Body | Result |
|---|---|---|---|
| `POST /api/auth/signup` | public | `fullName`, `email`, `password` | 202 `{ message }` |
| `POST /api/users/:id/temporary-password` | Admin with `USERS:EDIT` | `identityVerified: true` | 200 `{ temporaryPassword, expiresAt }`; 403 not an Admin; 409 own account, deactivated or unapproved; 429 over the limit |
| `POST /api/auth/complete-password-change` | a temporary-password session | `newPassword` | 200 `null` (every session ends); 400 invalid or same as the temporary one; 401 expired; 409 no change required |
| `GET /api/auth/me` | any session | | `user.credentialChangeRequired` is true for a temporary-password session |

`POST /api/auth/login` returns `user.credentialChangeRequired`. `GET /api/users` includes `temporaryCredentialExpiresAt` (null unless a temporary password is outstanding). (The JSON names avoid the word "password", which the tests forbid in user responses.)

Removed: `POST /api/auth/forgot-password`, `POST /api/auth/reset-password/check`, `POST /api/auth/reset-password` and the administrator-chosen `POST /api/users/:id/reset-password`. They now answer 404.

## 7. Activity log

| Action | When |
|---|---|
| `auth.signup_submitted` | A sign-up request was stored. After a rejection, the metadata has `previouslyRejected: true`. |
| `auth.signup_duplicate` | A sign-up used the email of an existing account (nothing changed). |
| `user.registration_approved` | An administrator approved a pending account. |
| `user.registration_rejected` | An administrator rejected a pending account. The metadata lists any roles removed. |
| `user.temporary_password_issued` | An Admin (the entry's user) issued a temporary password for the account in `entity_id`, at `created_at`. Metadata: `identityVerified: true`, `expiresAt`. Never the password. |
| `auth.login` | As before; `metadata.temporaryPassword: true` when the sign-in used a temporary password. |
| `auth.temporary_password_replaced` | The user chose their own password in place of the temporary one. |
| `auth.password_reset_requested`, `auth.password_reset_completed` | Earlier entries from email reset links; no longer written. |

## 8. Web pages

`/login`, `/signup`, `/forgot-password` and `/change-password` share one frame (`AuthLayout` in `src/pages/LoginPage.tsx`): the redesigned login layout, logo, animations and reduced-motion handling. The shared inputs and buttons are in `src/pages/auth/authUi.tsx`. `/reset-password` no longer exists.

`ProtectedRoute` and `AuthLayout` send a session with `credentialChangeRequired` to `/change-password` from any address; the screen offers the new-password form and Sign out. The temporary-password dialog is `TemporaryPasswordModal` in `src/pages/users/UserDialogs.tsx`; the action is shown only to Admins, and disabled on their own row and on inactive accounts.

## 9. Open questions

1. **Create User's initial password.** Should a new account also get a generated temporary password with a forced change, instead of a password the administrator types?
2. **Duplicate sign-up wording.** The page deliberately does not say "this email already has an account". If the business prefers that message, it trades away the protection against finding out who has an account.
3. **After a rejection.** The person is not told (no email provider). A rejection cannot be undone by an administrator; the person signs up again. Rejected accounts stay listed. Are these the wanted rules?
4. **Telling a pending user why they cannot sign in.** Login currently answers "Incorrect email or password" for a pending account, the same as for any other failure.
5. **Notifying administrators** of a new request (today they see it in Users & Access).
6. **A shared (not per-process) limiter for production.** The counts live in one process's memory.
7. **Who may sign up.** For example, only company email addresses.
