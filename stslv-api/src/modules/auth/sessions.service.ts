import { randomUUID } from "node:crypto";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { logActivity } from "../../shared/activity-log";
import type { Queryable } from "../../shared/db";
import { notFound } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import type { AuthContext } from "./access";

// Server-side sessions (migration 0108). Each sign-in creates one user_sessions row, and the token carries its id
// ("sid"). authenticate accepts a token only while its session is open: not revoked, not expired, and used within
// SESSION_IDLE_TIMEOUT_MINUTES. On a database without 0108 none of this applies and tokens work as before.
//
// Inactivity is measured from the person's last real use of the application, not from the last request: the web
// application polls in the background (permissions every minute, notifications), which must not keep an unattended
// browser signed in. It sends X-Idle-Seconds (seconds since the last keyboard/pointer/touch input in any of its tabs)
// with every request; the session's last activity is "now minus that", never moved backwards. A client that sends
// no header (an API tool) counts as active at each request.

export type RevokeReason =
  | "LOGOUT"
  | "LOGOUT_ALL"
  | "REVOKED_BY_USER"
  | "REVOKED_BY_ADMIN"
  | "PASSWORD_CHANGED"
  | "TEMPORARY_PASSWORD"
  | "DEACTIVATED"
  | "IDLE_TIMEOUT";

export type SessionState = "open" | "missing" | "revoked" | "expired" | "idle";

/** A last-activity change smaller than this is not written, so a busy page does not write on every request. */
const ACTIVITY_WRITE_GRANULARITY_SECONDS = 30;
/** The longest idle time a client may report; anything larger is treated as this. */
const MAX_REPORTED_IDLE_SECONDS = 7 * 86_400;
/** Ended sessions older than this are removed when their user signs in. */
const RETAIN_ENDED_DAYS = 90;

export const sessionsEnabled = (): Promise<boolean> => schemaHas(["user_sessions"]);

/** The idle seconds a request reports, or null when it reports none (or nonsense). */
export function reportedIdleSeconds(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;

  if (raw === undefined || !/^\d{1,9}$/.test(raw.trim())) return null;

  return Math.min(Number(raw.trim()), MAX_REPORTED_IDLE_SECONDS);
}

export interface NewSession {
  userId: string;
  passwordChange: boolean;
  ip: string | null;
  userAgent: string | null;
}

/** Opens a session for a successful sign-in. Null when the database has no sessions table yet. */
export async function createSession(db: Queryable, input: NewSession): Promise<string | null> {
  if (!(await sessionsEnabled())) return null;

  const id = randomUUID();

  await db.query(
    `INSERT INTO user_sessions (id, user_id, expires_at, password_change, ip_address, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, left($5, 64), left($6, 300))`,
    [id, input.userId, env.jwtExpirySeconds, input.passwordChange, input.ip, input.userAgent]
  );
  await db.query(
    `DELETE FROM user_sessions
     WHERE user_id = $1 AND COALESCE(revoked_at, expires_at) < now() - make_interval(days => $2)`,
    [input.userId, RETAIN_ENDED_DAYS]
  );

  return id;
}

/**
 * Checks a request's session and records the person's activity. An open session that has been idle too long is
 * revoked here (IDLE_TIMEOUT), so it shows as ended everywhere at once.
 */
export async function checkSession(sessionId: string, userId: string, idleSeconds: number | null): Promise<SessionState> {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return "missing";

  const result = await pool.query<{
    user_id: string;
    revoked: boolean;
    expired: boolean;
    stored_activity: Date;
    activity: Date;
    idle_too_long: boolean;
    worth_writing: boolean;
  }>(
    `WITH s AS (
       SELECT user_id, revoked_at IS NOT NULL AS revoked, expires_at <= now() AS expired, last_activity_at,
              GREATEST(last_activity_at, now() - make_interval(secs => $2)) AS activity
       FROM user_sessions WHERE id = $1
     )
     -- Idle is judged on the activity recorded BEFORE this request: a request after 30 silent minutes is too
     -- late, whatever it reports. The request's own report only moves the record forward.
     SELECT user_id, revoked, expired, last_activity_at AS stored_activity, activity,
            last_activity_at < now() - make_interval(mins => $3) AS idle_too_long,
            activity > last_activity_at + make_interval(secs => $4) AS worth_writing
     FROM s`,
    [sessionId, idleSeconds ?? 0, env.sessionIdleTimeoutMinutes, ACTIVITY_WRITE_GRANULARITY_SECONDS]
  );
  const row = result.rows[0];

  if (!row || row.user_id !== userId) return "missing";
  if (row.revoked) return "revoked";
  if (row.expired) return "expired";
  if (row.idle_too_long) {
    await pool.query("UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'IDLE_TIMEOUT' WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
    return "idle";
  }
  if (row.worth_writing) {
    await pool.query("UPDATE user_sessions SET last_activity_at = GREATEST(last_activity_at, $2) WHERE id = $1", [sessionId, row.activity]);
  }

  return "open";
}

/** Ends one session of a user. Returns whether an open session was ended. */
export async function revokeSession(db: Queryable, input: { sessionId: string; userId: string; reason: RevokeReason; by: string | null }): Promise<boolean> {
  if (!(await sessionsEnabled())) return false;

  const result = await db.query(
    `UPDATE user_sessions SET revoked_at = now(), revoked_reason = $3, revoked_by = $4
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [input.sessionId, input.userId, input.reason, input.by]
  );

  return result.rowCount === 1;
}

/** Ends every open session of a user, except `exceptSessionId` when given. Returns how many were ended. */
export async function revokeUserSessions(db: Queryable, input: { userId: string; reason: RevokeReason; by: string | null; exceptSessionId?: string | null }): Promise<number> {
  if (!(await sessionsEnabled())) return 0;

  const result = await db.query(
    `UPDATE user_sessions SET revoked_at = now(), revoked_reason = $2, revoked_by = $3
     WHERE user_id = $1 AND revoked_at IS NULL AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [input.userId, input.reason, input.by, input.exceptSessionId ?? null]
  );

  return result.rowCount ?? 0;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  /** When the inactivity limit ends it, unless the person uses the application before then. */
  idleExpiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  passwordChange: boolean;
  current: boolean;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  last_activity_at: Date;
  expires_at: Date;
  idle_expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  password_change: boolean;
}

/** SQL condition for an open session; `$1` is the idle limit in minutes. */
const openSession = (alias: string) =>
  `${alias}.revoked_at IS NULL AND ${alias}.expires_at > now() AND ${alias}.last_activity_at > now() - make_interval(mins => $1)`;

const summary = (row: SessionRow, currentId: string | null): SessionSummary => ({
  id: row.id,
  createdAt: row.created_at.toISOString(),
  lastActivityAt: row.last_activity_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  idleExpiresAt: row.idle_expires_at.toISOString(),
  ipAddress: row.ip_address,
  userAgent: row.user_agent,
  passwordChange: row.password_change,
  current: row.id === currentId,
});

/** The open sessions of one user, newest activity first. */
export async function listUserSessions(userId: string, currentId: string | null = null): Promise<SessionSummary[]> {
  if (!(await sessionsEnabled())) return [];

  const result = await pool.query<SessionRow>(
    `SELECT id, user_id, created_at, last_activity_at, expires_at,
            last_activity_at + make_interval(mins => $1) AS idle_expires_at, ip_address, user_agent, password_change
     FROM user_sessions s WHERE s.user_id = $2 AND ${openSession("s")}
     ORDER BY s.last_activity_at DESC`,
    [env.sessionIdleTimeoutMinutes, userId]
  );

  return result.rows.map((row) => summary(row, currentId));
}

export interface ActiveSessionListItem extends SessionSummary {
  user: { id: string; fullName: string; email: string };
}

/** Every open session, for administrators (Security Center). */
export async function listAllOpenSessions(currentId: string | null): Promise<{ items: ActiveSessionListItem[]; idleTimeoutMinutes: number; enabled: boolean }> {
  if (!(await sessionsEnabled())) return { items: [], idleTimeoutMinutes: env.sessionIdleTimeoutMinutes, enabled: false };

  const result = await pool.query<SessionRow & { full_name: string; email: string }>(
    `SELECT s.id, s.user_id, s.created_at, s.last_activity_at, s.expires_at,
            s.last_activity_at + make_interval(mins => $1) AS idle_expires_at, s.ip_address, s.user_agent, s.password_change,
            u.full_name, u.email
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE ${openSession("s")}
     ORDER BY s.last_activity_at DESC
     LIMIT 500`,
    [env.sessionIdleTimeoutMinutes]
  );

  return {
    items: result.rows.map((row) => ({ ...summary(row, currentId), user: { id: row.user_id, fullName: row.full_name, email: row.email } })),
    idleTimeoutMinutes: env.sessionIdleTimeoutMinutes,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Actions of the signed-in user on their own sessions.
// ---------------------------------------------------------------------------------------------

/** Signs the user out of every device, this one included. */
export async function signOutEverywhere(auth: AuthContext, context: { ip: string | null }): Promise<number> {
  const ended = await revokeUserSessions(pool, { userId: auth.user.id, reason: "LOGOUT_ALL", by: auth.user.id });

  await logActivity(pool, {
    userId: auth.user.id,
    action: "auth.logout_all",
    module: "AUTH",
    entityType: "users",
    entityId: auth.user.id,
    description: `${auth.user.fullName} signed out of all devices (${ended} session${ended === 1 ? "" : "s"} ended).`,
    metadata: { ip: context.ip, sessionsEnded: ended },
  });

  return ended;
}

/** Ends one of the user's own sessions (another device, or this one). */
export async function revokeOwnSession(auth: AuthContext, sessionId: string): Promise<void> {
  const ended = await revokeSession(pool, { sessionId, userId: auth.user.id, reason: "REVOKED_BY_USER", by: auth.user.id });

  if (!ended) throw notFound("That session is not open.");

  await logActivity(pool, {
    userId: auth.user.id,
    action: "auth.session_revoked",
    module: "AUTH",
    entityType: "users",
    entityId: auth.user.id,
    description: `${auth.user.fullName} signed out one of their sessions${sessionId === auth.sessionId ? " (this device)" : ""}.`,
    metadata: { sessionId },
  });
}
