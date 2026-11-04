import { z } from "zod";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { describeStorage } from "../../config/storage-config";
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
      { id: "attachments", label: "Document storage", state: env.fileStorage ? "OK" : "UNAVAILABLE", detail: describeStorage(env.fileStorage).detail },
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
      attachmentsConfigured: env.fileStorage !== null,
      // R2, LOCAL or NONE: which kind of store, never its name, address or keys.
      attachmentsStorage: describeStorage(env.fileStorage).kind,
      backupsAvailable: backup.available,
    },
  };
}

// --- Deletion History (formerly Deletion Log; routes and logged actions keep that name) -----------------------------------------------------
//
// The history of removal events and their reversal, read from activity_logs. It is not the Recycle Bin:
// the Recycle Bin lists the records currently deleted (recycle-bin.service.ts), while this lists what
// happened, and no entry is ever removed. Each entry shows the record's current status alongside.

/**
 * DELETED: moved to the Recycle Bin (metadata.recycleBin), or deleted permanently: before the Recycle
 * Bin existed (client, system type, holiday, role) or, since 0106, from it (*.purged). A schedule update
 * counts only when it removed untouched visits.
 * VOIDED: the record stays, cancelled or voided.
 */
const DELETED = `(l.action IN ('holiday.deleted', 'system_type.deleted', 'sales_engineer.deleted', 'role.deleted', 'client.deleted', 'amc_contract.deleted',
                              'client.purged', 'system_type.purged', 'sales_engineer.purged')
  OR (l.action IN ('amc_contract.schedule_generated', 'amc_contract.schedule_regenerated') AND jsonb_array_length(COALESCE(l.metadata -> 'removed', '[]'::jsonb)) > 0))`;
const VOIDED = `(l.action IN ('invoice.cancelled', 'expense.voided', 'user.registration_rejected')
  OR (l.action LIKE '%.status_changed' AND l.metadata -> 'changes' -> 'status' ->> 'to' = 'CANCELLED'))`;
/** The record stays and can be switched back on: clients, masters, users. */
const DEACTIVATED = `(l.action LIKE '%.deactivated' OR l.action IN ('maintenance_frequency.disabled', 'maintenance_frequency.archived'))`;
/** The reversals: restored from the Recycle Bin, or switched back on. */
const RESTORED = `(l.action IN ('amc_contract.restored', 'client.restored', 'system_type.restored', 'sales_engineer.restored', 'user.activated', 'maintenance_frequency.activated')
  OR l.action LIKE '%.reactivated')`;
const ANY_REMOVAL = `(${DELETED} OR ${VOIDED} OR ${DEACTIVATED} OR ${RESTORED})`;

/**
 * The record's status now, for the record types that have one: LIVE, INACTIVE, CANCELLED, ARCHIVED,
 * IN_RECYCLE_BIN or PERMANENTLY_DELETED (no row any more). Null for other types. Rows are matched on the
 * *_all tables, so a record in the Recycle Bin is found.
 */
const CURRENT_JOINS = `
  LEFT JOIN amc_contracts_all s_c ON l.entity_type = 'amc_contracts' AND s_c.id = l.entity_id
  LEFT JOIN clients_all s_cl ON l.entity_type = 'clients' AND s_cl.id = l.entity_id
  LEFT JOIN system_types_all s_st ON l.entity_type = 'system_types' AND s_st.id = l.entity_id
  LEFT JOIN sales_engineers_all s_se ON l.entity_type = 'sales_engineers' AND s_se.id = l.entity_id
  LEFT JOIN departments s_d ON l.entity_type = 'departments' AND s_d.id = l.entity_id
  LEFT JOIN maintenance_frequencies s_mf ON l.entity_type = 'maintenance_frequencies' AND s_mf.id = l.entity_id
  LEFT JOIN users s_u ON l.entity_type = 'users' AND s_u.id = l.entity_id`;
const binned = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN 'PERMANENTLY_DELETED' WHEN ${alias}.deleted_at IS NOT NULL THEN 'IN_RECYCLE_BIN' WHEN NOT ${alias}.is_active THEN 'INACTIVE' ELSE 'LIVE' END`;
const CURRENT_STATUS_SQL = `CASE
  WHEN l.entity_id IS NULL THEN NULL
  WHEN l.entity_type = 'amc_contracts' THEN
    CASE WHEN s_c.id IS NULL THEN 'PERMANENTLY_DELETED' WHEN s_c.deleted_at IS NOT NULL THEN 'IN_RECYCLE_BIN' WHEN s_c.status = 'CANCELLED' THEN 'CANCELLED' ELSE 'LIVE' END
  WHEN l.entity_type = 'clients' THEN ${binned("s_cl")}
  WHEN l.entity_type = 'system_types' THEN ${binned("s_st")}
  WHEN l.entity_type = 'sales_engineers' THEN ${binned("s_se")}
  WHEN l.entity_type = 'departments' THEN CASE WHEN s_d.id IS NULL THEN 'PERMANENTLY_DELETED' WHEN NOT s_d.is_active THEN 'INACTIVE' ELSE 'LIVE' END
  WHEN l.entity_type = 'maintenance_frequencies' THEN
    CASE WHEN s_mf.id IS NULL THEN 'PERMANENTLY_DELETED' WHEN (to_jsonb(s_mf) ->> 'archived_at') IS NOT NULL THEN 'ARCHIVED' WHEN NOT s_mf.is_active THEN 'INACTIVE' ELSE 'LIVE' END
  WHEN l.entity_type = 'users' THEN CASE WHEN s_u.id IS NULL THEN 'PERMANENTLY_DELETED' WHEN NOT s_u.is_active THEN 'INACTIVE' ELSE 'LIVE' END
  ELSE NULL END`;

export const CURRENT_STATUS_LABELS: Record<string, string> = {
  LIVE: "Active",
  INACTIVE: "Inactive",
  CANCELLED: "Cancelled",
  ARCHIVED: "Archived",
  IN_RECYCLE_BIN: "In Recycle Bin",
  PERMANENTLY_DELETED: "Permanently deleted",
};

export const listDeletionsSchema = z.object({
  kind: z.enum(["DELETED", "VOIDED", "DEACTIVATED", "RESTORED"], { error: "Select Deleted, Cancelled, Deactivated or Restored." }).optional(),
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
  const conditions = [
    query.kind === "DELETED" ? DELETED : query.kind === "VOIDED" ? VOIDED : query.kind === "DEACTIVATED" ? DEACTIVATED : query.kind === "RESTORED" ? RESTORED : ANY_REMOVAL,
  ];

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
const KIND_SQL = `CASE WHEN ${DELETED} THEN 'DELETED' WHEN ${RESTORED} THEN 'RESTORED' WHEN ${DEACTIVATED} THEN 'DEACTIVATED' ELSE 'VOIDED' END`;
/** For DELETED: RECYCLE_BIN when moved there, PERMANENT when the row was removed. Null otherwise. */
const DELETION_SQL = `CASE WHEN NOT ${DELETED} THEN NULL WHEN l.metadata ->> 'recycleBin' = 'true' AND l.action NOT LIKE '%.purged' THEN 'RECYCLE_BIN' ELSE 'PERMANENT' END`;

export async function listDeletions(query: z.infer<typeof listDeletionsSchema>) {
  const { where, params } = deletionFilter(query);
  const from = DELETION_FROM;
  const [total, rows, entityTypes, users] = await Promise.all([
    pool.query<{ count: number }>(`SELECT count(*)::int AS count ${from} WHERE ${where}`, params),
    pool.query<{
      id: string; action: string; entity_type: string; entity_id: string | null; description: string | null; full_name: string | null; reason: string | null;
      kind: string; deletion: string | null; current_status: string | null; created_at: Date;
    }>(
      `SELECT l.id, l.action, l.entity_type, l.entity_id, l.description, u.full_name, l.metadata ->> 'reason' AS reason,
              ${KIND_SQL} AS kind, ${DELETION_SQL} AS deletion, ${CURRENT_STATUS_SQL} AS current_status, l.created_at
       ${from} ${CURRENT_JOINS} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      params
    ),
    pool.query<{ entity_type: string }>(`SELECT DISTINCT l.entity_type FROM activity_logs l WHERE ${ANY_REMOVAL} ORDER BY 1`),
    pool.query<{ id: string; full_name: string }>(`SELECT DISTINCT u.id, u.full_name ${from} WHERE ${ANY_REMOVAL} ORDER BY u.full_name`),
  ]);

  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      deletion: row.deletion,
      currentStatus: row.current_status,
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

const KIND_LABELS: Record<string, string> = { DELETED: "Deleted", DEACTIVATED: "Deactivated", RESTORED: "Restored", VOIDED: "Cancelled" };

function kindLabel(kind: string, deletion: string | null): string {
  if (kind === "DELETED" && deletion === "RECYCLE_BIN") return "To Recycle Bin";
  if (kind === "DELETED" && deletion === "PERMANENT") return "Deleted permanently";

  return KIND_LABELS[kind] ?? kind;
}

/** The Deletion History as a report, for the same filters. */
export async function buildDeletionsExport(auth: AuthContext, query: z.infer<typeof exportDeletionsSchema>) {
  const { format, ...filters } = query;
  const { where, params } = deletionFilter(filters);
  const rows = await pool.query<{
    created_at: Date; kind: string; deletion: string | null; current_status: string | null; action: string; entity_type: string; entity_id: string | null;
    full_name: string | null; description: string | null; reason: string | null;
  }>(
    `SELECT l.created_at, ${KIND_SQL} AS kind, ${DELETION_SQL} AS deletion, ${CURRENT_STATUS_SQL} AS current_status, l.action, l.entity_type, l.entity_id,
            u.full_name, l.description, l.metadata ->> 'reason' AS reason
     ${DELETION_FROM} ${CURRENT_JOINS} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC`,
    params
  );

  assertExportSize(format, rows.rows.length);

  const report: ReportDefinition = {
    title: "Deletion History",
    period: filters.from || filters.to ? `${filters.from ?? "Start"} to ${filters.to ?? "End"}` : null,
    filters: filters.kind ? [{ label: "Action", value: KIND_LABELS[filters.kind] ?? filters.kind }] : [],
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "deletion-history",
    tables: [
      {
        name: "Deletion History",
        columns: [
          { key: "when", header: "When (UTC)", kind: "text", width: 20 },
          { key: "kind", header: "Action", kind: "text", width: 16 },
          { key: "type", header: "Record Type", kind: "text", width: 18 },
          { key: "id", header: "Record No.", kind: "identifier", width: 10 },
          { key: "status", header: "Status now", kind: "text", width: 16 },
          { key: "user", header: "User", kind: "text", width: 20, wrap: true },
          { key: "details", header: "Details", kind: "text", width: 46, wrap: true },
          { key: "reason", header: "Reason", kind: "text", width: 24, wrap: true },
        ],
        rows: rows.rows.map((row) => ({
          when: row.created_at.toISOString().slice(0, 19).replace("T", " "),
          kind: kindLabel(row.kind, row.deletion),
          type: row.entity_type.replace(/_/g, " ").replace(/^amc/, "AMC").replace(/^./, (c) => c.toUpperCase()),
          id: row.entity_id,
          status: row.current_status ? (CURRENT_STATUS_LABELS[row.current_status] ?? row.current_status) : null,
          user: row.full_name ?? "System",
          details: row.description,
          reason: row.reason,
        })),
      },
    ],
  };
  const recordExport = () =>
    logActivity(pool, { userId: auth.user.id, action: "deletion_log.exported", module: "USERS", entityType: "activity_logs", entityId: null, description: `Exported the Deletion History as ${format === "xlsx" ? "Excel" : "PDF"} (${rows.rows.length} entries).`, metadata: { format, filters, rowCount: rows.rows.length } });

  return { report, recordExport };
}
