import { z } from "zod";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { dateSchema, pagingSchema } from "../../shared/money";
import { escapeLike, idSchema } from "../../shared/validation";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, exportFormatSchema, type ReportDefinition } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import { getReadiness, type RequestTransport } from "../dashboard/readiness.service";
import { backupStatus } from "./backups.service";

// Security Center and Deletion Log: read-only views over what the application
// already records. Nothing here writes, and only recorded events are shown.

const SECURITY_ACTIONS = [
  "auth.login_failed",
  "auth.logout",
  "auth.password_changed",
  "auth.temporary_password_replaced",
  "user.created",
  "user.updated",
  "user.roles_changed",
  "user.registration_approved",
  "user.registration_rejected",
  "user.temporary_password_issued",
  "role.created",
  "role.updated",
  "role.deleted",
  "role.permissions_changed",
  "user.activated",
  "user.deactivated",
  "backup.created",
  "backup.downloaded",
];

export const listSecurityEventsSchema = z.object({
  action: z.string().trim().regex(/^[a-z_.]{1,60}$/, "Select an event type.").optional(),
  search: z.string().trim().max(200).optional(),
  from: dateSchema("From date").optional(),
  to: dateSchema("To date").optional(),
  ...pagingSchema,
});

/** The recorded security events, newest first, with the network address where one was recorded. */
export async function listSecurityEvents(query: z.infer<typeof listSecurityEventsSchema>) {
  const params: unknown[] = [SECURITY_ACTIONS];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions = ["l.action = ANY($1::text[])"];

  if (query.action) conditions.push(`l.action = ${add(query.action)}`);
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    conditions.push(`(l.description ILIKE ${p} OR u.full_name ILIKE ${p} OR l.metadata ->> 'ip' ILIKE ${p})`);
  }
  if (query.from) conditions.push(`l.created_at >= ${add(query.from)}::date`);
  if (query.to) conditions.push(`l.created_at < ${add(query.to)}::date + 1`);

  const from = "FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id";
  const where = conditions.join(" AND ");
  const [total, rows] = await Promise.all([
    pool.query<{ count: number }>(`SELECT count(*)::int AS count ${from} WHERE ${where}`, params),
    pool.query<{ id: string; action: string; description: string | null; full_name: string | null; ip: string | null; created_at: Date }>(
      `SELECT l.id, l.action, l.description, u.full_name, l.metadata ->> 'ip' AS ip, l.created_at
       ${from} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      params
    ),
  ]);

  return {
    items: rows.rows.map((row) => ({ id: row.id, action: row.action, description: row.description, user: row.full_name, ip: row.ip, createdAt: row.created_at.toISOString() })),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    actions: SECURITY_ACTIONS,
  };
}

export async function getSecurityOverview(transport: RequestTransport | null = null) {
  const [users, roles, signIns, backup, readiness] = await Promise.all([
    pool.query<{ total: number; active: number; inactive: number; pending: number; must_change: number; no_role: number; admins: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE u.is_active)::int AS active,
              count(*) FILTER (WHERE NOT u.is_active)::int AS inactive,
              count(*) FILTER (WHERE u.approval_status = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE u.must_change_password)::int AS must_change,
              count(*) FILTER (WHERE u.is_active AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id))::int AS no_role,
              count(*) FILTER (WHERE u.is_active AND EXISTS (
                SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code IN ('ADMIN', 'ADMINISTRATOR')))::int AS admins
       FROM users u`
    ),
    pool.query<{ id: string; code: string; name: string; is_active: boolean; users: number }>(
      `SELECT r.id, r.code, r.name, r.is_active,
              (SELECT count(*)::int FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.is_active) AS users
       FROM roles r ORDER BY r.is_active DESC, lower(r.name)`
    ),
    pool.query<{ succeeded: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE action = 'auth.login')::int AS succeeded, count(*) FILTER (WHERE action = 'auth.login_failed')::int AS failed
       FROM activity_logs WHERE created_at >= now() - interval '30 days' AND action IN ('auth.login', 'auth.login_failed')`
    ),
    backupStatus(),
    getReadiness(transport),
  ]);
  const user = users.rows[0];

  return {
    users: {
      total: user?.total ?? 0,
      active: user?.active ?? 0,
      inactive: user?.inactive ?? 0,
      pendingApproval: user?.pending ?? 0,
      mustChangePassword: user?.must_change ?? 0,
      activeWithoutRole: user?.no_role ?? 0,
      administrators: user?.admins ?? 0,
    },
    roles: roles.rows.map((role) => ({ id: role.id, code: role.code, name: role.name, isActive: role.is_active, activeUsers: role.users })),
    signIns30Days: { succeeded: signIns.rows[0]?.succeeded ?? 0, failed: signIns.rows[0]?.failed ?? 0 },
    // Each check on its own, with no combined score. Backed by the readiness checks (readiness.service.ts).
    checks: [
      ...readiness.checks,
      { id: "headers", label: "Security headers", state: "OK", detail: `nosniff, frame denial and referrer policy are sent by the API${process.env.NODE_ENV === "production" ? ", with HSTS." : "; HSTS only in production."}` },
      { id: "attachments", label: "Document storage", state: env.attachmentsDir ? "OK" : "UNAVAILABLE", detail: env.attachmentsDir ? "A folder is configured. Its durability cannot be checked from here." : "Not configured, so document uploads are off." },
    ],
    // Settings in force, as values safe to show. No secret, address or connection detail.
    configuration: {
      sessionHours: Math.round((env.jwtExpirySeconds / 3600) * 10) / 10,
      passwordHashRounds: env.bcryptRounds,
      loginRequestsPer15Min: env.loginRateLimit,
      failedLoginsPer15Min: env.loginFailureLimit,
      signUpRequestsPer15Min: env.publicAuthRateLimit,
      temporaryPasswordsPer15Min: env.temporaryPasswordRateLimit,
      allowedWebOrigins: env.corsOrigins.length,
      attachmentsConfigured: env.attachmentsDir !== null,
      backupsAvailable: backup.available,
    },
  };
}

// --- Recycle Bin (formerly Deletion Log; routes and logged actions keep that name) ---------------------------------------------------------

/**
 * The recorded removal events. DELETED: the row was removed from the database.
 * VOIDED: the record stays, cancelled or voided. A schedule update counts only
 * when it removed untouched visits. Reads activity_logs; deletion itself is unchanged.
 */
const DELETED = `(l.action IN ('holiday.deleted', 'system_type.deleted', 'role.deleted')
  OR (l.action IN ('amc_contract.schedule_generated', 'amc_contract.schedule_regenerated') AND jsonb_array_length(COALESCE(l.metadata -> 'removed', '[]'::jsonb)) > 0))`;
const VOIDED = `(l.action IN ('invoice.cancelled', 'expense.voided', 'user.registration_rejected')
  OR (l.action LIKE '%.status_changed' AND l.metadata -> 'changes' -> 'status' ->> 'to' = 'CANCELLED'))`;
/** The record stays and can be switched back on: clients, masters, users. */
const DEACTIVATED = `(l.action LIKE '%.deactivated' OR l.action IN ('maintenance_frequency.disabled', 'maintenance_frequency.archived'))`;
const ANY_REMOVAL = `(${DELETED} OR ${VOIDED} OR ${DEACTIVATED})`;

export const listDeletionsSchema = z.object({
  kind: z.enum(["DELETED", "VOIDED", "DEACTIVATED"], { error: "Select Deleted, Cancelled or Deactivated." }).optional(),
  entityType: z.string().trim().regex(/^[a-z_]{1,60}$/, "Select a record type.").optional(),
  userId: idSchema.optional(),
  search: z.string().trim().max(200).optional(),
  from: dateSchema("From date").optional(),
  to: dateSchema("To date").optional(),
  ...pagingSchema,
});

export const exportDeletionsSchema = listDeletionsSchema.omit({ page: true, pageSize: true }).extend({ format: exportFormatSchema });

function deletionFilter(query: Omit<z.infer<typeof listDeletionsSchema>, "page" | "pageSize">) {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions = [query.kind === "DELETED" ? DELETED : query.kind === "VOIDED" ? VOIDED : query.kind === "DEACTIVATED" ? DEACTIVATED : ANY_REMOVAL];

  if (query.entityType) conditions.push(`l.entity_type = ${add(query.entityType)}`);
  if (query.userId) conditions.push(`l.user_id = ${add(query.userId)}`);
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    conditions.push(`(l.description ILIKE ${p} OR l.entity_id::text = ${add(query.search)} OR u.full_name ILIKE ${p})`);
  }
  if (query.from) conditions.push(`l.created_at >= ${add(query.from)}::date`);
  if (query.to) conditions.push(`l.created_at < ${add(query.to)}::date + 1`);

  return { where: conditions.join(" AND "), params };
}

const DELETION_FROM = "FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id";
const KIND_SQL = `CASE WHEN ${DELETED} THEN 'DELETED' WHEN ${DEACTIVATED} THEN 'DEACTIVATED' ELSE 'VOIDED' END`;

export async function listDeletions(query: z.infer<typeof listDeletionsSchema>) {
  const { where, params } = deletionFilter(query);
  const from = DELETION_FROM;
  const [total, rows, entityTypes, users] = await Promise.all([
    pool.query<{ count: number }>(`SELECT count(*)::int AS count ${from} WHERE ${where}`, params),
    pool.query<{ id: string; action: string; entity_type: string; entity_id: string | null; description: string | null; full_name: string | null; reason: string | null; kind: string; created_at: Date }>(
      `SELECT l.id, l.action, l.entity_type, l.entity_id, l.description, u.full_name, l.metadata ->> 'reason' AS reason,
              ${KIND_SQL} AS kind, l.created_at
       ${from} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      params
    ),
    pool.query<{ entity_type: string }>(`SELECT DISTINCT l.entity_type FROM activity_logs l WHERE ${ANY_REMOVAL} ORDER BY 1`),
    pool.query<{ id: string; full_name: string }>(`SELECT DISTINCT u.id, u.full_name ${from} WHERE ${ANY_REMOVAL} ORDER BY u.full_name`),
  ]);

  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      description: row.description,
      reason: row.reason,
      user: row.full_name,
      createdAt: row.created_at.toISOString(),
    })),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    options: { entityTypes: entityTypes.rows.map((row) => row.entity_type), users: users.rows.filter((row) => row.id).map((row) => ({ id: row.id, fullName: row.full_name })) },
  };
}

/** The Recycle Bin as a report, for the same filters. */
export async function buildDeletionsExport(auth: AuthContext, query: z.infer<typeof exportDeletionsSchema>) {
  const { format, ...filters } = query;
  const { where, params } = deletionFilter(filters);
  const rows = await pool.query<{ created_at: Date; kind: string; action: string; entity_type: string; entity_id: string | null; full_name: string | null; description: string | null; reason: string | null }>(
    `SELECT l.created_at, ${KIND_SQL} AS kind, l.action, l.entity_type, l.entity_id, u.full_name, l.description, l.metadata ->> 'reason' AS reason
     ${DELETION_FROM} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC`,
    params
  );

  assertExportSize(format, rows.rows.length);

  const report: ReportDefinition = {
    title: "Recycle Bin",
    period: filters.from || filters.to ? `${filters.from ?? "Start"} to ${filters.to ?? "End"}` : null,
    filters: filters.kind ? [{ label: "Action", value: filters.kind }] : [],
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "recycle-bin",
    tables: [
      {
        name: "Recycle Bin",
        columns: [
          { key: "when", header: "When (UTC)", kind: "text", width: 20 },
          { key: "kind", header: "Action", kind: "text", width: 13 },
          { key: "type", header: "Record Type", kind: "text", width: 18 },
          { key: "id", header: "Record No.", kind: "identifier", width: 10 },
          { key: "user", header: "User", kind: "text", width: 20, wrap: true },
          { key: "details", header: "Details", kind: "text", width: 50, wrap: true },
          { key: "reason", header: "Reason", kind: "text", width: 26, wrap: true },
        ],
        rows: rows.rows.map((row) => ({ when: row.created_at.toISOString().slice(0, 19).replace("T", " "), kind: row.kind === "DELETED" ? "Deleted" : row.kind === "DEACTIVATED" ? "Deactivated" : "Cancelled", type: row.entity_type.replace(/_/g, " ").replace(/^amc/, "AMC").replace(/^./, (c) => c.toUpperCase()), id: row.entity_id, user: row.full_name ?? "System", details: row.description, reason: row.reason })),
      },
    ],
  };
  const recordExport = () =>
    logActivity(pool, { userId: auth.user.id, action: "deletion_log.exported", module: "USERS", entityType: "activity_logs", entityId: null, description: `Exported the Recycle Bin as ${format === "xlsx" ? "Excel" : "PDF"} (${rows.rows.length} entries).`, metadata: { format, filters, rowCount: rows.rows.length } });

  return { report, recordExport };
}
