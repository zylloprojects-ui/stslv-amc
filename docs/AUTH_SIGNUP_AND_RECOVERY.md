# STSLEV AMC — Sign Up and Password Recovery

What the public Sign up, Forgot password and Reset password pages do, how they are kept safe, and what is still to be decided. The rest of authentication (login, sessions, roles, permissions) is described in [`FOUNDATION.md`](FOUNDATION.md).

## 1. Sign up

STSLEV AMC is an internal system. Anyone can *ask* for an account; nobody can *give themselves* access.

```
Sign up page  →  account stored PENDING + inactive, no role
              →  administrator opens Users & Access
              →  assigns a role  →  Approve
              →  account APPROVED + active  →  the person can sign in
```

- `POST /api/auth/signup` accepts exactly `fullName`, `email` and `password`. Any other field (`role`, `roleIds`, `permissions`, `isActive`, …) makes the request fail with 400: it is refused, not ignored.
- The account is created with `is_active = false`, `approval_status = 'PENDING'` and no row in `user_roles`. The database itself refuses an account that is both pending and active (`users_pending_inactive_ck`).
- A pending account cannot sign in and cannot request a password reset. Login answers it exactly as it answers a wrong password.
- The response is the same whether or not the email already has an account, so the page cannot be used to find out who has one. An existing account is never changed; its owner is told by email, and the attempt is written to the activity log.
- The password is hashed with bcrypt before anything else happens. It is never stored, logged or returned.
- Users created by an administrator (**Create User**, `npm run admin:create`) are `APPROVED` and active immediately, as before.

### Approval in Users & Access

A pending account shows a **Pending approval** badge and an **Approve** action (the existing activate route, `POST /api/users/:id/activate`). Approving sets the account active and `APPROVED`. A notice above the table counts the requests that are waiting.

Approving an account that has no role is allowed, and the dialog says so: the person can sign in but sees no module until a role is assigned.

There is no "reject" action. An unwanted request simply stays pending and inactive. See open questions.

## 2. Forgot password and reset

```
Forgot password page  →  POST /api/auth/forgot-password
                      →  same answer for every email
                      →  for an active account: token created, link emailed
Link  →  /reset-password#token=…
      →  POST /api/auth/reset-password/check   (valid | invalid | expired | used)
      →  POST /api/auth/reset-password         (new password; token spent)
      →  sign in with the new password
```

| Rule | How it is enforced |
|---|---|
| Unguessable token | 32 bytes from `crypto.randomBytes`, base64url. It is not a JWT and is not accepted as a session. |
| Token never stored | Only its SHA-256 hash is kept, in `password_reset_tokens.token_hash`. |
| Expiry | `expires_at`; `PASSWORD_RESET_EXPIRES_MINUTES` (default 30). |
| Single use | `used_at` is set in the same transaction that changes the password, with the row locked. |
| Newer request wins | A new request revokes the previous token (`revoked_at`). A partial unique index allows one outstanding token per user. |
| No account enumeration | Unknown, inactive and pending emails get the same response; no token and no email. The email is sent after the response, so timing does not differ. |
| Nothing sensitive in logs | The activity log records that a reset was requested and completed, never the token, its hash or a password. |
| Token kept out of server logs | It travels after `#` in the link (browsers do not send that part to a server) and in the request body, never in a URL path or query string. |
| Other routes cancel a pending link | Changing the password under My Account, an administrator's reset, and deactivation all revoke outstanding tokens. |

A successful reset moves `password_changed_at`, so every existing session of that account is signed out. It does not activate an inactive account and does not change roles.

The administrator's **Reset password** action in Users & Access is unchanged and remains available.

## 3. Email delivery

There is **no email provider configured yet**. `src/shared/mailer.ts` is the single place email is sent from; `MAIL_TRANSPORT` chooses how:

| Value | Behaviour |
|---|---|
| `none` (default) | Nothing is sent. Only `Email not sent … "<subject>"` is logged: no recipient, no body, no link. |
| `log` | **Local development only.** The whole message, including the reset link, is printed to the API console. The API refuses to start with `MAIL_TRANSPORT=log` when `NODE_ENV=production`. |
| `memory` | Automated tests only; refused outside them. |

Until a provider is chosen, a reset requested on a deployed system creates a token that is never delivered, and people continue to ask an administrator for a reset. Adding a provider means adding one transport to `mailer.ts` and its settings to `.env`; no caller changes.

### Testing a reset locally

1. In `stslv-api/.env` set `MAIL_TRANSPORT=log` (never on a server) and restart the API.
2. Open `/forgot-password`, enter the email of an active user.
3. Copy the `…/reset-password#token=…` link from the API console into the browser.

## 4. Abuse limits

`/signup`, `/forgot-password`, `/reset-password/check` and `/reset-password` are each limited to `PUBLIC_AUTH_RATE_LIMIT` requests per network address per 15 minutes (default 10). The count lives in the API process's memory. Before production, behind a reverse proxy, Express must be configured to trust the proxy or every visitor is counted as one address. `/login` is not rate limited (unchanged; see open questions).

## 5. Database

| Migration | Change |
|---|---|
| `0040_user_approval_status` | `users.approval_status` (`PENDING` / `APPROVED`, default `APPROVED`) and the pending-implies-inactive check. Existing users become `APPROVED`. |
| `0041_password_reset_tokens` | New table `password_reset_tokens`. |

Both only add; nothing is dropped or rewritten.

## 6. API

All four are public (no token) and return the standard `{ success, data | error }` shape.

| Route | Body | Result |
|---|---|---|
| `POST /api/auth/signup` | `fullName`, `email`, `password` | 202 `{ message }` |
| `POST /api/auth/forgot-password` | `email` | 200 `{ message }` |
| `POST /api/auth/reset-password/check` | `token` | 200 `{ status }` |
| `POST /api/auth/reset-password` | `token`, `password` | 200 `null`; 400 `RESET_TOKEN_INVALID` / `RESET_TOKEN_EXPIRED` / `RESET_TOKEN_USED` |

`GET /api/users` now includes `approvalStatus` for each user.

## 7. Activity log

| Action | When |
|---|---|
| `auth.signup_submitted` | A sign-up request was stored. |
| `auth.signup_duplicate` | A sign-up used the email of an existing account (nothing changed). |
| `user.registration_approved` | An administrator approved a pending account. |
| `auth.password_reset_requested` | A reset link was created. |
| `auth.password_reset_completed` | A password was changed with a reset link. |

## 8. Web pages

`/login`, `/signup`, `/forgot-password` and `/reset-password` share one frame (`AuthLayout` in `src/pages/LoginPage.tsx`): the redesigned login layout, logo, animations and reduced-motion handling. The shared inputs and buttons are in `src/pages/auth/authUi.tsx`.

## 9. Open questions

1. **Email provider.** Which service sends mail (SMTP relay, or an email API), and from which address?
2. **Duplicate sign-up wording.** The page deliberately does not say "this email already has an account". If the business prefers that message, it trades away the protection against finding out who has an account.
3. **Rejecting a request.** Should an administrator be able to reject or remove a pending request, and should the person be told?
4. **Telling a pending user why they cannot sign in.** Login currently answers "Incorrect email or password" for a pending account, the same as for any other failure.
5. **Notifying administrators** of a new request (today they see it in Users & Access).
6. **Login rate limiting** and a shared (not per-process) limiter for production.
7. **Who may sign up.** For example, only company email addresses.
