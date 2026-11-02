-- 0082_one_role_per_user
-- Every user holds at most one role (approved 2026-10-29). The API already
-- requires exactly one role when it creates a user, assigns a role or approves
-- a sign-up (commit 4717f4e); this constraint makes the database refuse a
-- second role from any other writer as well.
--
-- At most one, not exactly one: a sign-up request has no role until an
-- administrator assigns one, and a rejected request keeps none.
--
-- Requires 0080 and 0081 to be applied first (numbering order). Changes no
-- data. If any user already holds several roles, the migration stops with an
-- error naming how many users are affected, and the runner rolls it back: no
-- assignment is removed or changed. An administrator then chooses one role for
-- each of them (Users & Access, Change role) and the migration is run again.
--
-- Read-only check to run before applying (counts only):
--   SELECT count(*) FROM (SELECT user_id FROM user_roles GROUP BY user_id HAVING count(*) > 1) AS several;
--
-- The existing primary key (user_id, role_id) and user_roles_role_id_idx stay.
-- Lock: a brief ACCESS EXCLUSIVE lock on user_roles while the unique index is
-- built; the table holds one row per user.
--
-- To reverse (only with approval; the API keeps enforcing one role):
--   ALTER TABLE user_roles DROP CONSTRAINT user_roles_one_role_uq;
--   DELETE FROM schema_migrations WHERE version = '0082';

DO $$
DECLARE
  affected integer;
BEGIN
  SELECT count(*) INTO affected
  FROM (SELECT user_id FROM user_roles GROUP BY user_id HAVING count(*) > 1) AS several;

  IF affected > 0 THEN
    RAISE EXCEPTION '0082: % user(s) hold more than one role. Choose one role for each in Users & Access, then apply 0082 again. Nothing was changed.', affected;
  END IF;
END $$;

ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_one_role_uq UNIQUE (user_id);
