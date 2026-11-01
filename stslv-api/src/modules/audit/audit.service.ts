import { pool } from "../../config/database";
import { escapeLike } from "../../shared/validation";
import type { ActivityFilters, ListActivityQuery, ListLoginsQuery, LoginFilters } from "./audit.schemas";

// Read-only views over activity_logs. Only the parts of an entry's details that
// are meant to be read are returned (field changes, a reason, a sign-in's
// network address, browser and failure reason); other stored details stay internal.

type Changes = Record<string, { from: unknown; to: unknown }>;

// A field that should never have been logged is still not shown or exported.
const SENSITIVE_FIELD = /password|token|secret|hash|credential/i;

function asChanges(value: unknown): Changes | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return Object.fromEntries(Object.entries(value as Changes).filter(([field]) => !SENSITIVE_FIELD.test(field)));
}

function dateConditions(query: { from?: string | undefined; to?: string | undefined }, params: unknown[], conditions: string[]) {
  if (query.from) {
    params.push(query.from);
    conditions.push(`l.created_at >= $${params.length}::date`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`l.created_at < ($${params.length}::date + 1)`);
  }
}

const where = (conditions: string[]) => (conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "");

// ---------------------------------------------------------------------------
// Sign-in history
// ---------------------------------------------------------------------------

export interface LoginRecord {
  id: string;
  outcome: "SUCCESS" | "FAILED";
  /** The account, when the email belongs to one. Null for an email with no account. */
  user: { id: string; fullName: string; email: string } | null;
  /** The network address the request came from, when it was recorded. */
  ip: string | null;
  /** The browser's description of itself, as sent: untrusted text. Blank on entries from before it was recorded. */
  userAgent: string | null;
  /** Why a sign-in failed: unknown_account, wrong_password, inactive_account or temporary_password_expired. */
  reason: string | null;
  createdAt: string;
}

// A successful sign-in is recorded by the user who signed in; a failed one points to the account it was for.
const LOGIN_USER = "COALESCE(l.user_id, CASE WHEN l.entity_type = 'users' THEN l.entity_id END)";

const LOGIN_FROM = `FROM activity_logs l LEFT JOIN users u ON u.id = ${LOGIN_USER}`;

function loginFilter(query: LoginFilters) {
  const params: unknown[] = [];
  const conditions = ["l.action IN ('auth.login', 'auth.login_failed')"];

  if (query.outcome) {
    conditions.push(query.outcome === "SUCCESS" ? "l.action = 'auth.login'" : "l.action = 'auth.login_failed'");
  }
  if (query.userId) {
    params.push(query.userId);
    conditions.push(`${LOGIN_USER} = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR l.metadata ->> 'ip' ILIKE ${p})`);
  }
  dateConditions(query, params, conditions);

  return { params, conditions };
}

type LoginRow = {
  id: string;
  action: string;
  user_id: string | null;
  full_name: string | null;
  email: string | null;
  ip: string | null;
  user_agent: string | null;
  reason: string | null;
  created_at: Date;
};

const LOGIN_COLUMNS = `l.id, l.action, u.id AS user_id, u.full_name, u.email,
            l.metadata ->> 'ip' AS ip, l.metadata ->> 'userAgent' AS user_agent, l.metadata ->> 'reason' AS reason, l.created_at`;

const toLoginRecord = (row: LoginRow): LoginRecord => ({
  id: row.id,
  outcome: row.action === "auth.login" ? "SUCCESS" : "FAILED",
  user: row.user_id ? { id: row.user_id, fullName: row.full_name ?? "", email: row.email ?? "" } : null,
  ip: row.ip,
  userAgent: row.user_agent,
  reason: row.action === "auth.login" ? null : row.reason,
  createdAt: row.created_at.toISOString(),
});

export async function listLogins(query: ListLoginsQuery) {
  const { params, conditions } = loginFilter(query);
  const from = LOGIN_FROM;
  const total = await pool.query<{ count: number; failed: number }>(
    `SELECT count(*)::int AS count, count(*) FILTER (WHERE l.action = 'auth.login_failed')::int AS failed ${from} ${where(conditions)}`,
    params
  );
  const rows = await pool.query<LoginRow>(
    `SELECT ${LOGIN_COLUMNS}
     ${from} ${where(conditions)}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toLoginRecord),
    total: total.rows[0]?.count ?? 0,
    failedTotal: total.rows[0]?.failed ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Every sign-in matching the filters, for the export. The count comes first, so an oversized export is refused before it is read. */
export async function loginsForExport(filters: LoginFilters, assertSize: (count: number) => void): Promise<LoginRecord[]> {
  const { params, conditions } = loginFilter(filters);
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count ${LOGIN_FROM} ${where(conditions)}`, params);

  assertSize(total.rows[0]?.count ?? 0);

  const rows = await pool.query<LoginRow>(`SELECT ${LOGIN_COLUMNS} ${LOGIN_FROM} ${where(conditions)} ORDER BY l.created_at DESC, l.id DESC`, params);

  return rows.rows.map(toLoginRecord);
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export interface ActivityRecord {
  id: string;
  action: string;
  module: string;
  entityType: string;
  entityId: string | null;
  description: string | null;
  /** The user who acted. Null for an action not made by a signed-in user. */
  user: { id: string; fullName: string } | null;
  changes: Changes | null;
  reason: string | null;
  /** The network address, on the entries that recorded one. */
  ip: string | null;
  createdAt: string;
}

function activityFilter(query: ActivityFilters) {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query.module) {
    params.push(query.module);
    conditions.push(`l.module = $${params.length}`);
  }
  if (query.userId) {
    params.push(query.userId);
    conditions.push(`l.user_id = $${params.length}`);
  }
  if (query.entityType) {
    params.push(query.entityType);
    conditions.push(`l.entity_type = $${params.length}`);
  }
  if (query.entityId) {
    params.push(query.entityId);
    conditions.push(`l.entity_id = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(`(l.action ILIKE ${p} OR l.description ILIKE ${p})`);
  }
  dateConditions(query, params, conditions);

  return { params, conditions };
}

type ActivityRow = {
  id: string;
  action: string;
  module: string;
  entity_type: string;
  entity_id: string | null;
  description: string | null;
  user_id: string | null;
  full_name: string | null;
  changes: unknown;
  reason: string | null;
  ip: string | null;
  created_at: Date;
};

const ACTIVITY_SELECT = `SELECT l.id, l.action, l.module, l.entity_type, l.entity_id, l.description, l.user_id, u.full_name,
            l.metadata -> 'changes' AS changes, l.metadata ->> 'reason' AS reason, l.metadata ->> 'ip' AS ip, l.created_at
     FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id`;

const toActivityRecord = (row: ActivityRow): ActivityRecord => ({
  id: row.id,
  action: row.action,
  module: row.module,
  entityType: row.entity_type,
  entityId: row.entity_id,
  description: row.description,
  user: row.user_id ? { id: row.user_id, fullName: row.full_name ?? "" } : null,
  changes: asChanges(row.changes),
  reason: row.reason,
  ip: row.ip,
  createdAt: row.created_at.toISOString(),
});

export async function listActivity(query: ListActivityQuery) {
  const { params, conditions } = activityFilter(query);
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM activity_logs l ${where(conditions)}`, params);
  const rows = await pool.query<ActivityRow>(
    `${ACTIVITY_SELECT}
     ${where(conditions)}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return { items: rows.rows.map(toActivityRecord), total: total.rows[0]?.count ?? 0, page: query.page, pageSize: query.pageSize };
}

/** Every entry matching the filters, for the export. The count comes first, so an oversized export is refused before it is read. */
export async function activityForExport(filters: ActivityFilters, assertSize: (count: number) => void): Promise<ActivityRecord[]> {
  const { params, conditions } = activityFilter(filters);
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM activity_logs l ${where(conditions)}`, params);

  assertSize(total.rows[0]?.count ?? 0);

  const rows = await pool.query<ActivityRow>(`${ACTIVITY_SELECT} ${where(conditions)} ORDER BY l.created_at DESC, l.id DESC`, params);

  return rows.rows.map(toActivityRecord);
}

/** The modules, record types and acting users that occur in the log, for the filters. */
export async function activityFilterOptions() {
  const [modules, entityTypes, users] = await Promise.all([
    pool.query<{ module: string }>("SELECT DISTINCT module FROM activity_logs ORDER BY module"),
    pool.query<{ entity_type: string }>("SELECT DISTINCT entity_type FROM activity_logs ORDER BY entity_type"),
    pool.query<{ id: string; full_name: string; email: string }>(
      "SELECT u.id, u.full_name, u.email FROM users u WHERE EXISTS (SELECT 1 FROM activity_logs l WHERE l.user_id = u.id) ORDER BY lower(u.full_name), lower(u.email)"
    ),
  ]);

  return {
    modules: modules.rows.map((row) => row.module),
    entityTypes: entityTypes.rows.map((row) => row.entity_type),
    users: users.rows.map((row) => ({ id: row.id, fullName: row.full_name, email: row.email })),
  };
}
