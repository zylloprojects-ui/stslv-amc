-- 0123_role_hidden_items
-- PREPARED FOR REVIEW (feature/role-visibility, 2026-11-21). Applied to isolated test databases only.
-- A release applies it when the API starts, so releasing needs approval of this file too.
--
-- Role visibility (owner request 2026-11-21): Roles & Permissions can hide single parts of a page from a role
-- (a Dashboard row or panel, a table column, an action such as a download) while the role keeps the page.
--
--   * One row per (role, hidden item). Nothing stored = everything visible, so no existing role changes:
--     the table starts empty and nothing is backfilled.
--   * item_key is one of the keys of src/shared/visibility-catalog.ts; the API refuses any other key. The
--     database checks only its shape, so a new item needs no migration.
--   * Removed with its role (a custom role that nobody holds can be deleted; built-in roles never are).
--   * Changes are written by PUT /api/roles/:id/visibility and recorded in activity_logs (role.visibility_changed).
--
-- To reverse (only with approval; it discards every visibility setting):
--   DROP TABLE role_hidden_items;

CREATE TABLE role_hidden_items (
  role_id    bigint      NOT NULL,
  item_key   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_hidden_items_pk PRIMARY KEY (role_id, item_key),
  CONSTRAINT role_hidden_items_role_id_fk FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT role_hidden_items_key_ck CHECK (item_key ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2}$')
);
