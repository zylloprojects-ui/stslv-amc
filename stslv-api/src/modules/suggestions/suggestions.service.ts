import type { PoolClient } from "pg";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import type {
  AssignInput,
  ChangeStatusInput,
  CommentInput,
  CreateSuggestionInput,
  ListManageQuery,
  ListMineQuery,
  ReopenInput,
} from "./suggestions.schemas";
import {
  allowedTransitions,
  canTransition,
  idFromReference,
  isReviewer,
  noteRequirement,
  OPEN_STATUSES,
  referenceOf,
  STATUSES,
  type Actor,
  type SuggestionCategory,
  type SuggestionStatus,
} from "./suggestions.workflow";

// Suggestions & feedback. Every signed-in user submits suggestions and sees
// their own; reviewers (isReviewer) see and manage all of them. A suggestion
// another user submitted is "not found" to a non-reviewer, so its existence
// is not revealed. Every change is recorded in suggestion_events (shown as the
// history) and in activity_logs (the Audit Log).

const MODULE = "SUGGESTIONS";
const ENTITY = "suggestions";

interface UserRef {
  id: string;
  fullName: string;
}

export interface SuggestionSummary {
  id: string;
  reference: string;
  category: SuggestionCategory;
  subject: string;
  status: SuggestionStatus;
  submittedBy: UserRef;
  assignedTo: UserRef | null;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  /** The latest comment or change by someone other than the submitter that the submitter can see. */
  lastResponseAt: string | null;
}

export interface SuggestionEvent {
  id: string;
  kind: "SUBMITTED" | "STATUS_CHANGED" | "ASSIGNED" | "COMMENT";
  actor: UserRef;
  /** True when the actor is the submitter. */
  bySubmitter: boolean;
  fromStatus: SuggestionStatus | null;
  toStatus: SuggestionStatus | null;
  assignedTo: UserRef | null;
  body: string | null;
  internal: boolean;
  createdAt: string;
}

export interface SuggestionDetail extends SuggestionSummary {
  description: string;
  pagePath: string | null;
  resolutionNotes: string | null;
  resolvedAt: string | null;
  resolvedBy: UserRef | null;
  closedAt: string | null;
  closedBy: UserRef | null;
  statusChangedBy: UserRef;
  events: SuggestionEvent[];
  /** What the signed-in user may do with this suggestion now. */
  access: {
    reviewer: boolean;
    isSubmitter: boolean;
    transitions: SuggestionStatus[];
    canComment: boolean;
    canAssign: boolean;
  };
}

interface SummaryRow {
  id: string;
  category: SuggestionCategory;
  subject: string;
  status: SuggestionStatus;
  submitted_by: string;
  submitted_by_name: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_at: Date;
  updated_at: Date;
  status_changed_at: Date;
  last_response_at: Date | null;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const userRef = (id: string | null, fullName: string | null): UserRef | null =>
  id === null ? null : { id, fullName: fullName ?? "" };

// The latest visible activity by someone other than the submitter. Internal notes never count.
const LAST_RESPONSE = `(SELECT max(e.created_at) FROM suggestion_events e
                        WHERE e.suggestion_id = s.id AND e.actor_id <> s.submitted_by AND NOT e.is_internal) AS last_response_at`;

const SUMMARY_SELECT = `
  SELECT s.id, s.category, s.subject, s.status, s.submitted_by, sub.full_name AS submitted_by_name,
         s.assigned_to, asg.full_name AS assigned_to_name, s.created_at, s.updated_at, s.status_changed_at,
         ${LAST_RESPONSE}
  FROM suggestions s
  JOIN users sub ON sub.id = s.submitted_by
  LEFT JOIN users asg ON asg.id = s.assigned_to`;

function toSummary(row: SummaryRow): SuggestionSummary {
  return {
    id: row.id,
    reference: referenceOf(row.id),
    category: row.category,
    subject: row.subject,
    status: row.status,
    submittedBy: { id: row.submitted_by, fullName: row.submitted_by_name },
    assignedTo: userRef(row.assigned_to, row.assigned_to_name),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    statusChangedAt: row.status_changed_at.toISOString(),
    lastResponseAt: iso(row.last_response_at),
  };
}

/** Adds the shared filters (status, category, search) to a list query. */
function commonFilters(query: ListMineQuery, params: unknown[], conditions: string[]): void {
  if (query.status) {
    params.push(query.status);
    conditions.push(`s.status = $${params.length}`);
  }
  if (query.category) {
    params.push(query.category);
    conditions.push(`s.category = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    const id = idFromReference(query.search);
    let byId = "";

    if (id) {
      params.push(id);
      byId = ` OR s.id = $${params.length}`;
    }
    conditions.push(`(s.subject ILIKE ${p} OR s.description ILIKE ${p}${byId})`);
  }
}

const where = (conditions: string[]) => (conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "");

async function page(conditions: string[], params: unknown[], query: { page: number; pageSize: number }, order: string) {
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM suggestions s ${where(conditions)}`, params);
  const rows = await pool.query<SummaryRow>(
    `${SUMMARY_SELECT} ${where(conditions)} ORDER BY ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return { items: rows.rows.map(toSummary), total: total.rows[0]?.count ?? 0, page: query.page, pageSize: query.pageSize };
}

/** The signed-in user's own suggestions, newest first. */
export async function listMine(auth: AuthContext, query: ListMineQuery) {
  const params: unknown[] = [auth.user.id];
  const conditions = ["s.submitted_by = $1"];

  commonFilters(query, params, conditions);

  return page(conditions, params, query, "s.created_at DESC, s.id DESC");
}

/** Every suggestion, for reviewers: open ones by age by default, with counts per status. */
export async function listForReview(query: ListManageQuery) {
  const params: unknown[] = [];
  const conditions: string[] = [];

  commonFilters(query, params, conditions);
  if (query.view === "OPEN" && !query.status) {
    params.push(OPEN_STATUSES);
    conditions.push(`s.status = ANY($${params.length}::text[])`);
  }
  if (query.submittedBy) {
    params.push(query.submittedBy);
    conditions.push(`s.submitted_by = $${params.length}`);
  }
  if (query.assignedTo === "none") {
    conditions.push("s.assigned_to IS NULL");
  } else if (query.assignedTo) {
    params.push(query.assignedTo);
    conditions.push(`s.assigned_to = $${params.length}`);
  }
  // Calendar days in the database's time zone, both ends included.
  if (query.from) {
    params.push(query.from);
    conditions.push(`s.created_at >= $${params.length}::date`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`s.created_at < $${params.length}::date + 1`);
  }

  const [list, counts] = await Promise.all([
    page(conditions, params, query, "s.created_at DESC, s.id DESC"),
    pool.query<{ status: SuggestionStatus; count: number }>("SELECT status, count(*)::int AS count FROM suggestions GROUP BY status"),
  ]);
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<SuggestionStatus, number>;

  for (const row of counts.rows) byStatus[row.status] = row.count;

  return { ...list, counts: byStatus };
}

/** Filter choices for the review list: everyone who has submitted, and the reviewers who can be assigned. */
export async function getReviewOptions() {
  const [submitters, reviewers] = await Promise.all([
    pool.query<UserRef>(
      `SELECT u.id, u.full_name AS "fullName" FROM users u
       WHERE EXISTS (SELECT 1 FROM suggestions s WHERE s.submitted_by = u.id)
       ORDER BY u.full_name, u.id`
    ),
    listReviewers(pool),
  ]);

  return { submitters: submitters.rows, reviewers };
}

/** Active users holding the active Admin role: the people a suggestion can be assigned to. */
async function listReviewers(db: Queryable): Promise<UserRef[]> {
  const result = await db.query<UserRef>(
    `SELECT DISTINCT u.id, u.full_name AS "fullName"
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.is_active AND r.is_active AND r.code = 'ADMIN'
     ORDER BY "fullName", u.id`
  );

  return result.rows;
}

export async function createSuggestion(auth: AuthContext, input: CreateSuggestionInput): Promise<{ created: boolean; suggestion: SuggestionDetail }> {
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO suggestions (submitted_by, category, subject, description, page_path, status_changed_by, client_request_id)
       VALUES ($1, $2, $3, $4, $5, $1, $6)
       ON CONFLICT (submitted_by, client_request_id) DO NOTHING
       RETURNING id`,
      [auth.user.id, input.category, input.subject, input.description, input.pagePath, input.requestId ?? null]
    );
    const newId = inserted.rows[0]?.id;

    if (!newId) {
      // The same request was received before: return what it created.
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM suggestions WHERE submitted_by = $1 AND client_request_id = $2",
        [auth.user.id, input.requestId]
      );

      return { created: false, suggestion: await loadDetail(client, auth, existing.rows[0]!.id) };
    }

    await client.query("INSERT INTO suggestion_events (suggestion_id, actor_id, kind) VALUES ($1, $2, 'SUBMITTED')", [newId, auth.user.id]);
    await logActivity(client, {
      userId: auth.user.id,
      action: "suggestion.submitted",
      module: MODULE,
      entityType: ENTITY,
      entityId: newId,
      description: `Submitted suggestion ${referenceOf(newId)}: ${input.subject}`,
      metadata: { category: input.category, pagePath: input.pagePath },
    });

    return { created: true, suggestion: await loadDetail(client, auth, newId) };
  });
}

interface DetailRow extends SummaryRow {
  description: string;
  page_path: string | null;
  resolution_notes: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  closed_by_name: string | null;
  status_changed_by: string;
  status_changed_by_name: string;
}

/**
 * Loads one suggestion as the given user may see it. Not found when it does
 * not exist or belongs to someone else and the user is not a reviewer.
 * With lock, the row is locked for the rest of the transaction.
 */
async function loadRow(db: Queryable, auth: AuthContext, id: string, lock = false): Promise<DetailRow> {
  // FOR UPDATE cannot lock the nullable side of an outer join, so only the suggestion itself is locked.
  if (lock) {
    await db.query("SELECT 1 FROM suggestions WHERE id = $1 FOR UPDATE", [id]);
  }

  const result = await db.query<DetailRow>(
    `SELECT s.id, s.category, s.subject, s.status, s.submitted_by, sub.full_name AS submitted_by_name,
            s.assigned_to, asg.full_name AS assigned_to_name, s.created_at, s.updated_at, s.status_changed_at,
            ${LAST_RESPONSE},
            s.description, s.page_path, s.resolution_notes,
            s.resolved_at, s.resolved_by, rb.full_name AS resolved_by_name,
            s.closed_at, s.closed_by, cb.full_name AS closed_by_name,
            s.status_changed_by, scb.full_name AS status_changed_by_name
     FROM suggestions s
     JOIN users sub ON sub.id = s.submitted_by
     JOIN users scb ON scb.id = s.status_changed_by
     LEFT JOIN users asg ON asg.id = s.assigned_to
     LEFT JOIN users rb ON rb.id = s.resolved_by
     LEFT JOIN users cb ON cb.id = s.closed_by
     WHERE s.id = $1`,
    [id]
  );
  const row = result.rows[0];

  if (!row || (row.submitted_by !== auth.user.id && !isReviewer(auth))) {
    throw notFound("Suggestion not found.");
  }

  return row;
}

async function loadDetail(db: Queryable, auth: AuthContext, id: string): Promise<SuggestionDetail> {
  const row = await loadRow(db, auth, id);
  const reviewer = isReviewer(auth);
  const isSubmitter = row.submitted_by === auth.user.id;
  const events = await db.query<{
    id: string;
    kind: SuggestionEvent["kind"];
    actor_id: string;
    actor_name: string;
    from_status: SuggestionStatus | null;
    to_status: SuggestionStatus | null;
    assigned_to: string | null;
    assigned_to_name: string | null;
    body: string | null;
    is_internal: boolean;
    created_at: Date;
  }>(
    `SELECT e.id, e.kind, e.actor_id, a.full_name AS actor_name, e.from_status, e.to_status,
            e.assigned_to, asg.full_name AS assigned_to_name, e.body, e.is_internal, e.created_at
     FROM suggestion_events e
     JOIN users a ON a.id = e.actor_id
     LEFT JOIN users asg ON asg.id = e.assigned_to
     WHERE e.suggestion_id = $1 ${reviewer ? "" : "AND NOT e.is_internal"}
     ORDER BY e.created_at, e.id`,
    [id]
  );
  const actor: Actor | null = reviewer ? "REVIEWER" : isSubmitter ? "SUBMITTER" : null;

  return {
    ...toSummary(row),
    description: row.description,
    pagePath: row.page_path,
    resolutionNotes: row.resolution_notes,
    resolvedAt: iso(row.resolved_at),
    resolvedBy: userRef(row.resolved_by, row.resolved_by_name),
    closedAt: iso(row.closed_at),
    closedBy: userRef(row.closed_by, row.closed_by_name),
    statusChangedBy: { id: row.status_changed_by, fullName: row.status_changed_by_name },
    events: events.rows.map((event) => ({
      id: event.id,
      kind: event.kind,
      actor: { id: event.actor_id, fullName: event.actor_name },
      bySubmitter: event.actor_id === row.submitted_by,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      assignedTo: userRef(event.assigned_to, event.assigned_to_name),
      body: event.body,
      internal: event.is_internal,
      createdAt: event.created_at.toISOString(),
    })),
    access: {
      reviewer,
      isSubmitter,
      // A reviewer who submitted the suggestion acts as a reviewer.
      transitions: actor ? [...allowedTransitions(row.status, actor)] : [],
      canComment: reviewer || (isSubmitter && row.status !== "CLOSED"),
      canAssign: reviewer,
    },
  };
}

export async function getSuggestion(auth: AuthContext, id: string): Promise<SuggestionDetail> {
  return loadDetail(pool, auth, id);
}

const STATUS_LABELS: Record<SuggestionStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under Review",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};

/** Moves a locked suggestion to a new status and records it. The caller has checked who may. */
async function applyStatus(client: PoolClient, auth: AuthContext, row: DetailRow, to: SuggestionStatus, note: string | null): Promise<void> {
  const from = row.status;

  // Resolving records the resolution; reopening clears it (the history keeps it); closing keeps it.
  await client.query(
    `UPDATE suggestions SET
       status = $2::text,
       resolution_notes = CASE WHEN $2 = 'RESOLVED' THEN $3::text WHEN $2 = 'REOPENED' THEN NULL ELSE resolution_notes END,
       resolved_at      = CASE WHEN $2 = 'RESOLVED' THEN now() WHEN $2 = 'REOPENED' THEN NULL ELSE resolved_at END,
       resolved_by      = CASE WHEN $2 = 'RESOLVED' THEN $4::bigint WHEN $2 = 'REOPENED' THEN NULL ELSE resolved_by END,
       closed_at        = CASE WHEN $2 = 'CLOSED' THEN now() WHEN $2 = 'REOPENED' THEN NULL ELSE closed_at END,
       closed_by        = CASE WHEN $2 = 'CLOSED' THEN $4::bigint WHEN $2 = 'REOPENED' THEN NULL ELSE closed_by END,
       status_changed_at = now(), status_changed_by = $4, updated_at = now()
     WHERE id = $1`,
    [row.id, to, note, auth.user.id]
  );
  await client.query(
    `INSERT INTO suggestion_events (suggestion_id, actor_id, kind, from_status, to_status, body)
     VALUES ($1, $2, 'STATUS_CHANGED', $3, $4, $5)`,
    [row.id, auth.user.id, from, to, note]
  );
  await logActivity(client, {
    userId: auth.user.id,
    action: "suggestion.status_changed",
    module: MODULE,
    entityType: ENTITY,
    entityId: row.id,
    description: `${referenceOf(row.id)}: ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`,
    metadata: { changes: { status: { from, to } }, ...(note ? { reason: note } : {}) },
  });
}

function assertCurrent(row: DetailRow, fromStatus: SuggestionStatus): void {
  if (row.status !== fromStatus) {
    throw conflict(`This suggestion is now ${STATUS_LABELS[row.status]}: it was updated by someone else. Reload it and try again.`);
  }
}

/** A reviewer's status change, validated against the workflow. */
export async function changeStatus(auth: AuthContext, id: string, input: ChangeStatusInput): Promise<SuggestionDetail> {
  return withTransaction(async (client) => {
    const row = await loadRow(client, auth, id, true);

    assertCurrent(row, input.fromStatus);
    if (!canTransition(row.status, input.status, "REVIEWER")) {
      throw validationError(`A suggestion that is ${STATUS_LABELS[row.status]} cannot be moved to ${STATUS_LABELS[input.status]}.`, [
        { field: "status", message: "This status change is not allowed." },
      ]);
    }

    const required = noteRequirement(row.status, input.status);

    if (required && !input.note) {
      throw validationError(required === "resolution" ? "Describe how the suggestion was resolved." : "Give a reason for this change.", [
        { field: "note", message: required === "resolution" ? "Resolution notes are required." : "A reason is required." },
      ]);
    }

    await applyStatus(client, auth, row, input.status, input.note);

    return loadDetail(client, auth, id);
  });
}

/** The submitter reopens their own resolved suggestion, saying why. */
export async function reopenOwn(auth: AuthContext, id: string, input: ReopenInput): Promise<SuggestionDetail> {
  return withTransaction(async (client) => {
    const row = await loadRow(client, auth, id, true);

    if (row.submitted_by !== auth.user.id) {
      throw forbidden("Only the person who submitted this suggestion can reopen it here.");
    }
    assertCurrent(row, input.fromStatus);
    if (!canTransition(row.status, "REOPENED", "SUBMITTER")) {
      throw validationError(`A suggestion that is ${STATUS_LABELS[row.status]} cannot be reopened by its submitter.`, [
        { field: "status", message: "Only a resolved suggestion can be reopened." },
      ]);
    }

    await applyStatus(client, auth, row, "REOPENED", input.reason);

    return loadDetail(client, auth, id);
  });
}

export async function addComment(auth: AuthContext, id: string, input: CommentInput): Promise<SuggestionDetail> {
  return withTransaction(async (client) => {
    const row = await loadRow(client, auth, id, true);
    const reviewer = isReviewer(auth);

    if (input.internal && !reviewer) {
      throw forbidden("Only reviewers can add internal notes.");
    }
    if (!reviewer && row.status === "CLOSED") {
      throw conflict("This suggestion is closed. Submit a new suggestion if the matter needs more attention.");
    }

    await client.query(
      "INSERT INTO suggestion_events (suggestion_id, actor_id, kind, body, is_internal) VALUES ($1, $2, 'COMMENT', $3, $4)",
      [id, auth.user.id, input.body, input.internal]
    );
    await client.query("UPDATE suggestions SET updated_at = now() WHERE id = $1", [id]);
    // The comment itself stays in suggestion_events; the Audit Log records that one was made.
    await logActivity(client, {
      userId: auth.user.id,
      action: input.internal ? "suggestion.internal_note_added" : "suggestion.commented",
      module: MODULE,
      entityType: ENTITY,
      entityId: id,
      description: `${input.internal ? "Internal note on" : "Comment on"} ${referenceOf(id)}`,
    });

    return loadDetail(client, auth, id);
  });
}

/** A reviewer assigns the suggestion to a reviewer, or clears the assignment. */
export async function assignSuggestion(auth: AuthContext, id: string, input: AssignInput): Promise<SuggestionDetail> {
  return withTransaction(async (client) => {
    const row = await loadRow(client, auth, id, true);

    if (input.assignedTo !== null && !(await listReviewers(client)).some((reviewer) => reviewer.id === input.assignedTo)) {
      throw validationError("Choose an active reviewer.", [{ field: "assignedTo", message: "Only an active Admin user can be assigned." }]);
    }
    if (row.assigned_to === input.assignedTo) {
      return loadDetail(client, auth, id);
    }

    await client.query("UPDATE suggestions SET assigned_to = $2, updated_at = now() WHERE id = $1", [id, input.assignedTo]);
    await client.query("INSERT INTO suggestion_events (suggestion_id, actor_id, kind, assigned_to) VALUES ($1, $2, 'ASSIGNED', $3)", [
      id,
      auth.user.id,
      input.assignedTo,
    ]);
    await logActivity(client, {
      userId: auth.user.id,
      action: "suggestion.assigned",
      module: MODULE,
      entityType: ENTITY,
      entityId: id,
      description: input.assignedTo ? `Assigned ${referenceOf(id)}` : `Unassigned ${referenceOf(id)}`,
      metadata: { changes: { assignedTo: { from: row.assigned_to, to: input.assignedTo } } },
    });

    return loadDetail(client, auth, id);
  });
}

// ---------------------------------------------------------------------------
// Alerts (notifications.service.ts)
// ---------------------------------------------------------------------------

/** Reviewers: suggestions waiting for a first look or reopened. The fingerprint changes when the set changes. */
export async function awaitingReview(): Promise<{ count: number; fingerprint: string }> {
  const result = await pool.query<{ count: number; ids: string | null }>(
    `SELECT count(*)::int AS count, string_agg(id::text || ':' || status, ',' ORDER BY id) AS ids
     FROM suggestions WHERE status IN ('SUBMITTED', 'REOPENED')`
  );

  return { count: result.rows[0]?.count ?? 0, fingerprint: result.rows[0]?.ids ?? "" };
}

/**
 * Submitters: their suggestions whose latest visible activity in the last 30
 * days is by someone else (a response or a status change they have not
 * answered). The fingerprint changes with every new response.
 */
export async function responsesFor(userId: string): Promise<{ count: number; fingerprint: string }> {
  const result = await pool.query<{ count: number; latest: string | null }>(
    `WITH latest AS (
       SELECT DISTINCT ON (e.suggestion_id) e.suggestion_id, e.id, e.actor_id, e.created_at
       FROM suggestion_events e
       JOIN suggestions s ON s.id = e.suggestion_id
       WHERE s.submitted_by = $1 AND NOT e.is_internal
       ORDER BY e.suggestion_id, e.created_at DESC, e.id DESC
     )
     SELECT count(*)::int AS count, string_agg(id::text, ',' ORDER BY id) AS latest
     FROM latest WHERE actor_id <> $1 AND created_at > now() - interval '30 days'`,
    [userId]
  );

  return { count: result.rows[0]?.count ?? 0, fingerprint: result.rows[0]?.latest ?? "" };
}
