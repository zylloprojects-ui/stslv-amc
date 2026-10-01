-- 0041_password_reset_tokens
-- One row per "Forgot password" request for an existing, active user.
-- The token itself is sent to the user and is never stored: only its SHA-256
-- hash is kept, so reading this table does not let anyone reset a password.
-- A token can be used once, expires, and is revoked when a newer one is
-- requested or the password changes by any other route.
-- No money-bearing columns.

CREATE TABLE password_reset_tokens (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  user_id    bigint      NOT NULL,
  -- Hex SHA-256 of the token. Never the token.
  token_hash text        NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Set when the token was used to choose a new password.
  used_at    timestamptz,
  -- Set when the token was replaced by a newer request or otherwise cancelled.
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_pk PRIMARY KEY (id),
  CONSTRAINT password_reset_tokens_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT password_reset_tokens_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT password_reset_tokens_token_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_expires_ck CHECK (expires_at > created_at)
);

-- At most one outstanding token per user: a new request must revoke the previous one first.
CREATE UNIQUE INDEX password_reset_tokens_one_outstanding_uq
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id, created_at DESC);
