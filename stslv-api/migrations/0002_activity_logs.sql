-- 0002_activity_logs
-- Append-only audit trail of important actions. Not event sourcing: business
-- tables hold current state, this table records who changed what and when.

CREATE TABLE activity_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  -- Null for system actions (for example a command-line script).
  user_id     bigint,
  action      text        NOT NULL,
  module      text        NOT NULL,
  entity_type text        NOT NULL,
  -- Deliberately not a foreign key: the log must be able to describe any table.
  entity_id   bigint,
  description text,
  -- Changed fields and context. Never passwords, hashes or tokens.
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_logs_pk PRIMARY KEY (id),
  CONSTRAINT activity_logs_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT activity_logs_action_ck CHECK (btrim(action) <> ''),
  CONSTRAINT activity_logs_module_ck CHECK (btrim(module) <> ''),
  CONSTRAINT activity_logs_entity_type_ck CHECK (btrim(entity_type) <> '')
);

CREATE INDEX activity_logs_entity_idx ON activity_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX activity_logs_user_id_idx ON activity_logs (user_id, created_at DESC);
CREATE INDEX activity_logs_created_at_idx ON activity_logs (created_at);
