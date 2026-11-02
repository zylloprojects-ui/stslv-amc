-- 0086_temporary_passwords
-- Password recovery by an administrator: the administrator issues a random
-- temporary password, which replaces the user's password hash (bcrypt, like any
-- password) and must be changed at the next sign-in, within 15 minutes.
--   must_change_password           the account may only reach the change-password screen
--   temporary_password_expires_at  after this the temporary password no longer signs in
-- The two are set and cleared together. Every existing user keeps their password
-- (false / NULL). The temporary password itself is never stored, only its hash.
-- Numbered after 0080/0081 (roles & permissions) and 0085 (suggestions), which
-- other branches add. No money-bearing columns.

ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN temporary_password_expires_at timestamptz,
  ADD CONSTRAINT users_temporary_password_ck CHECK (must_change_password = (temporary_password_expires_at IS NOT NULL));
