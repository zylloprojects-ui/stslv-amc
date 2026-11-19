# Protected Super Admin account

Status: implemented on `feature/protected-super-admin` (migration 0119). Not applied to any live database and no
account created until the owner approves and provides the email.

## 1. What it is

Exactly **one** account can be the protected Super Admin. It is an ordinary Super Admin (role code `ADMIN`, full
access) with one difference: **no other user may manage it**, whatever their role, other Super Admins included.

Refused for everyone except the account itself (HTTP 403, "This account is protected. Only its owner can manage it."):

| Action (Users & Access / API) | Route |
|---|---|
| Edit account details | `PATCH /api/users/:id` |
| Change its role (remove Super Admin) | `PUT /api/users/:id/roles` |
| Deactivate | `POST /api/users/:id/deactivate` |
| Issue a temporary password (password reset) | `POST /api/users/:id/temporary-password` |
| View or end its sessions (sign it out) | `GET /api/users/:id/sessions`, `POST …/sessions/revoke`, `DELETE …/sessions/:sessionId` |

Its sessions are also left out of **Security Center > Active Sessions** (`GET /api/security/sessions`) for everyone
but the account itself. Its sign-ins stay in the Login History and Audit Log like everyone else's: the audit trail is
never hidden.

In **Users & Access** the account shows a **Protected** badge; other administrators see "Protected account" instead
of action buttons. The owner sees their own row with the actions they may take. The API reports it as
`isProtected: true` on the user (only that account). Hiding buttons is a convenience: the API is what enforces it.

Already impossible for every account and unchanged: deleting a user (users are never deleted), changing the Super
Admin role's permissions (fixed for everyone), deactivating or deleting the Super Admin role, changing an email
through the application (there is no such route).

The account still appears in the Users list, and its owner keeps every right a Super Admin has, including managing
all other accounts. The existing self-rules still apply to the owner: nobody can change their own role or deactivate
their own account; the owner changes their password under **My account**.

## 2. How it is protected

- **Identifier:** the account's user id, stored in the table `protected_accounts`. Never its name or email, so
  renaming an account or creating another account called "Super Admin" changes nothing.
- **Application:** every user-management action goes through one shared check (`assertCanManageUser` in
  `stslv-api/src/modules/users/users.service.ts`), which calls `assertMayManageProtectedAccount`
  (`stslv-api/src/modules/users/protected-account.ts`).
- **Database (second line of defence, migration 0119):**
  - `protected_accounts` holds at most one row and is insert-only: the protection cannot be moved to another user,
    removed or added a second time.
  - The protected user's Super Admin role cannot be removed, by any path (`user_roles` trigger).
  - The protected user cannot be deactivated or have its sign-up status changed, by any path (`users` trigger).
- **No API creates, moves or removes the protection.** Only the server-side bootstrap script writes it, so no
  administrator can give the protection to themselves.

## 3. One-time creation (bootstrap)

Requires shell access to the server (that is the authorization) and the owner's approval of the email.

1. Take a database backup first (owner-approved procedure).
2. Apply migration 0119 with the release (the VPS needs the migration approval file for the commit).
3. On the server, with the API's environment (exact release path to be confirmed on the VPS at the time):

   ```
   sudo bash -c 'set -a; . /etc/stslv-amc/api.env; set +a; cd /opt/stslv-amc/current && node dist/scripts/bootstrap-protected-admin.js'
   ```

   (On a development machine: `npm run admin:bootstrap-protected` in `stslv-api`.)
4. Type the email and full name, then `CREATE` to confirm.
5. The script prints a **random temporary password once**. Nothing is typed by the operator, stored in a file or
   written to the audit log. Give it to the owner privately and clear the terminal.
6. The owner signs in within **15 minutes** and must choose a new password at once. After that, nobody else knows
   the password.

The script refuses, with nothing changed, when a protected account already exists or the email is already used by
any account (an existing account is never turned into the protected one). The creation is recorded in the audit log
as `user.protected_account_created`.

## 4. Emergency recovery

For example the owner forgot the password, the temporary password expired, or the account must be signed out
everywhere. Only an operator with shell access, authorized by the owner, can do this.

```
sudo bash -c 'set -a; . /etc/stslv-amc/api.env; set +a; cd /opt/stslv-amc/current && node dist/scripts/recover-protected-admin.js'
```

(Development machine: `npm run admin:recover-protected`.)

The operator types the protected account's email as confirmation. The script then, in one transaction:

- makes the account active and approved, and gives it exactly the Super Admin role again;
- replaces the password with a new random temporary password, printed once, valid for 15 minutes;
- cancels reset links and ends every session of the account;
- records `user.protected_account_recovered` in the audit log (never the password).

A wrong email changes nothing.

## 5. Moving or removing the protection

Not possible from the application, by design. If the owner ever decides the protection must move to another account
or be removed, it is a deliberate database-owner change: a reviewed SQL script that disables
`protected_accounts_no_update_delete` inside one transaction, changes the row and re-enables the trigger, after a
backup and with the owner's written approval. It should be recorded in the audit log by the same script.

## 6. Before the account exists

Until the bootstrap script is run, the table is empty and every account behaves exactly as before. On a database
without migration 0119 the application also behaves as before (no protected account).
