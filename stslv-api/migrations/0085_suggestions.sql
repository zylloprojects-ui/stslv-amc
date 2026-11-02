-- 0085_suggestions
-- Suggestions & feedback: what a signed-in user submits from the header
-- "Suggestions & Improvements" popup, and the review of it.
--
-- Before this migration the popup stored nothing (it was an interface only).
-- No existing data is changed.
--
-- Numbered 0085 so it follows the Roles & Permissions migrations 0080 and
-- 0081 (feature/roles-permissions-catalog): the runner refuses a pending
-- migration older than an applied one, so 0080/0081 must be applied first
-- wherever both are applied.
--
-- No permission module is added here: role_permissions_module_ck is being
-- replaced by 0080 in another branch. Until a SUGGESTIONS module is approved,
-- the API lets every signed-in user submit and see their own suggestions, and
-- reserves review to the built-in Admin role (see docs/SUGGESTIONS.md).
--
--   suggestions        one row per submission, with its current state.
--                      The reference shown to users (SUG-00001) is derived
--                      from the id by the API; it is not stored.
--   suggestion_events  the history of a submission, oldest first: its
--                      submission, every status change, assignment and
--                      comment, each with who and when. Nothing is updated
--                      or deleted. is_internal marks a reviewer note the
--                      submitter does not see.
--
-- Users are never deleted (they are deactivated), so the user references
-- are ON DELETE RESTRICT, as elsewhere. Suggestions are never deleted.
--
-- To reverse (only with approval; it discards every suggestion):
--   DROP TABLE suggestion_events; DROP TABLE suggestions;

CREATE TABLE suggestions (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submitted_by      bigint      NOT NULL,
  category          text        NOT NULL,
  subject           text        NOT NULL,
  description       text        NOT NULL,
  -- The page the user was on when they opened the popup, for context.
  page_path         text,
  status            text        NOT NULL DEFAULT 'SUBMITTED',
  assigned_to       bigint,
  resolution_notes  text,
  resolved_at       timestamptz,
  resolved_by       bigint,
  closed_at         timestamptz,
  closed_by         bigint,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  status_changed_by bigint      NOT NULL,
  -- Sent by the browser with each submission, so a repeated request (double
  -- click, retry after a timeout) returns the first suggestion instead of a copy.
  client_request_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT suggestions_submitted_by_fk FOREIGN KEY (submitted_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT suggestions_assigned_to_fk FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT suggestions_resolved_by_fk FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT suggestions_closed_by_fk FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT suggestions_status_changed_by_fk FOREIGN KEY (status_changed_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT suggestions_category_ck CHECK (category IN ('IMPROVEMENT', 'BUG', 'FEATURE')),
  CONSTRAINT suggestions_status_ck CHECK (status IN ('SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED')),
  CONSTRAINT suggestions_subject_ck CHECK (char_length(subject) BETWEEN 3 AND 150 AND subject = btrim(subject)),
  CONSTRAINT suggestions_description_ck CHECK (char_length(description) BETWEEN 10 AND 4000),
  CONSTRAINT suggestions_page_path_ck CHECK (page_path IS NULL OR (char_length(page_path) BETWEEN 1 AND 300 AND page_path LIKE '/%')),
  CONSTRAINT suggestions_resolution_notes_ck CHECK (resolution_notes IS NULL OR char_length(resolution_notes) BETWEEN 1 AND 4000),
  -- A resolved suggestion records who resolved it, when, and how.
  CONSTRAINT suggestions_resolved_ck CHECK (
    status <> 'RESOLVED' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_notes IS NOT NULL)
  ),
  CONSTRAINT suggestions_closed_ck CHECK (status <> 'CLOSED' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  CONSTRAINT suggestions_request_uq UNIQUE (submitted_by, client_request_id)
);

CREATE INDEX suggestions_submitted_by_idx ON suggestions (submitted_by, created_at DESC);
CREATE INDEX suggestions_status_idx ON suggestions (status, created_at DESC);
CREATE INDEX suggestions_assigned_to_idx ON suggestions (assigned_to);
CREATE INDEX suggestions_resolved_by_idx ON suggestions (resolved_by);
CREATE INDEX suggestions_closed_by_idx ON suggestions (closed_by);
CREATE INDEX suggestions_status_changed_by_idx ON suggestions (status_changed_by);

CREATE TABLE suggestion_events (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  suggestion_id bigint      NOT NULL,
  actor_id      bigint      NOT NULL,
  kind          text        NOT NULL,
  from_status   text,
  to_status     text,
  -- ASSIGNED: the new assignee (null when unassigned).
  assigned_to   bigint,
  -- COMMENT: the comment. STATUS_CHANGED: the note given with the change, if any.
  body          text,
  is_internal   boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT suggestion_events_suggestion_fk FOREIGN KEY (suggestion_id) REFERENCES suggestions (id) ON DELETE RESTRICT,
  CONSTRAINT suggestion_events_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT suggestion_events_assigned_to_fk FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT suggestion_events_kind_ck CHECK (kind IN ('SUBMITTED', 'STATUS_CHANGED', 'ASSIGNED', 'COMMENT')),
  CONSTRAINT suggestion_events_status_ck CHECK (
    (kind = 'STATUS_CHANGED' AND from_status IS NOT NULL AND to_status IS NOT NULL AND from_status <> to_status)
    OR (kind <> 'STATUS_CHANGED' AND from_status IS NULL AND to_status IS NULL)
  ),
  CONSTRAINT suggestion_events_comment_ck CHECK (kind <> 'COMMENT' OR body IS NOT NULL),
  CONSTRAINT suggestion_events_body_ck CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 4000),
  -- Only a reviewer's comment can be internal; status changes and assignments are always visible.
  CONSTRAINT suggestion_events_internal_ck CHECK (NOT is_internal OR kind = 'COMMENT')
);

CREATE INDEX suggestion_events_suggestion_idx ON suggestion_events (suggestion_id, created_at, id);
CREATE INDEX suggestion_events_actor_idx ON suggestion_events (actor_id);
CREATE INDEX suggestion_events_assigned_to_idx ON suggestion_events (assigned_to);
