-- 0040_user_approval_status
-- Lets a person request an account from the Sign up page without being able to use it.
-- A self-registered user is stored PENDING and inactive, with no role. An
-- administrator assigns a role and activates the account in Users & Access,
-- which marks it APPROVED.
-- Every existing user, and every user created by an administrator, is APPROVED.
-- No money-bearing columns.

ALTER TABLE users
  ADD COLUMN approval_status text NOT NULL DEFAULT 'APPROVED',
  ADD CONSTRAINT users_approval_status_ck CHECK (approval_status IN ('PENDING', 'APPROVED')),
  -- A pending account can never be an active one, whatever the application does.
  ADD CONSTRAINT users_pending_inactive_ck CHECK (approval_status <> 'PENDING' OR NOT is_active);
