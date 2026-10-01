-- 0042_user_registration_rejection
-- Lets an administrator reject a sign-up request instead of leaving it pending.
-- Adds REJECTED to users.approval_status. A rejected account is kept (the audit
-- trail refers to it) but is inactive and holds no role. The same email may
-- submit a new request later, which moves the account back to PENDING.
-- Only the two CHECK constraints added by 0040 are replaced; no row changes.
-- No money-bearing columns.

ALTER TABLE users
  DROP CONSTRAINT users_approval_status_ck,
  DROP CONSTRAINT users_pending_inactive_ck,
  ADD CONSTRAINT users_approval_status_ck CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  -- Only an approved account can ever be active, whatever the application does.
  ADD CONSTRAINT users_unapproved_inactive_ck CHECK (approval_status = 'APPROVED' OR NOT is_active);
