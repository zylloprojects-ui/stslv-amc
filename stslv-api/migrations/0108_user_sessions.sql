-- 0108_user_sessions
-- PREPARED FOR REVIEW (P0 security, 2026-11-09). Applied to isolated test databases only.
-- A release applies it when the API starts, so releasing needs approval of this file too.
--
-- Server-side sessions. Until now a sign-in token stayed valid until it expired
-- (8 hours), whatever happened: signing out only discarded it in the browser.
-- From this migration every sign-in creates one row here, and the token carries
-- that row's id. The API accepts a token only while its row is:
--   * not revoked (sign-out, "sign out of all devices", an administrator, a
--     password change, a temporary password, deactivation);
--   * not past expires_at (the token's own lifetime, JWT_EXPIRES_IN);
--   * active within the inactivity limit (SESSION_IDLE_TIMEOUT_MINUTES, default
--     30): last_activity_at is the last time the person used the application.
--
-- Effect at release: tokens issued before this migration carry no session id
-- and are refused, so everyone signs in once more. Nothing else changes: no
-- user, password hash, role or permission is touched.
--
-- Columns:
--   id                 random UUID chosen by the API; also in the token ("sid").
--   user_id            the account. ON DELETE CASCADE: the application never
--                      deletes users (rejected sign-ups are kept), so in practice
--                      rows live as long as the account.
--   password_change    the session of a sign-in with a temporary password: only
--                      the change-password screen is open to it.
--   ip_address, user_agent  as the browser presented them, for the Active
--                      Sessions list. Sender-controlled text, length-limited.
--   revoked_reason     why it ended: LOGOUT, LOGOUT_ALL, REVOKED_BY_USER,
--                      REVOKED_BY_ADMIN, PASSWORD_CHANGED, TEMPORARY_PASSWORD,
--                      DEACTIVATED, IDLE_TIMEOUT.
--   revoked_by         who ended it (null for the system: idle timeout).
--
-- Old rows: the API removes a user's rows that ended more than 90 days ago when
-- that user signs in. Sign-ins and sign-outs stay in activity_logs regardless.
--
-- Reverse (only with approval; every signed-in user is signed out once more,
-- because the previous API version ignores the sid claim and keeps working):
--   DROP TABLE user_sessions;

CREATE TABLE user_sessions (
  id               uuid        NOT NULL,
  user_id          bigint      NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  password_change  boolean     NOT NULL DEFAULT false,
  ip_address       text,
  user_agent       text,
  revoked_at       timestamptz,
  revoked_reason   text,
  revoked_by       bigint,
  CONSTRAINT user_sessions_pk PRIMARY KEY (id),
  CONSTRAINT user_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_sessions_revoked_by_fk FOREIGN KEY (revoked_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT user_sessions_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT user_sessions_ip_ck CHECK (ip_address IS NULL OR length(ip_address) <= 64),
  CONSTRAINT user_sessions_user_agent_ck CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  CONSTRAINT user_sessions_revoked_ck CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT user_sessions_reason_ck CHECK (revoked_reason IS NULL OR revoked_reason IN (
    'LOGOUT', 'LOGOUT_ALL', 'REVOKED_BY_USER', 'REVOKED_BY_ADMIN', 'PASSWORD_CHANGED',
    'TEMPORARY_PASSWORD', 'DEACTIVATED', 'IDLE_TIMEOUT'
  ))
);

-- The open sessions of one user (authentication, Active Sessions, revocation).
CREATE INDEX user_sessions_user_open_idx ON user_sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;
-- Every open session (the administrators' list).
CREATE INDEX user_sessions_open_idx ON user_sessions (last_activity_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_revoked_by_idx ON user_sessions (revoked_by);
