import type { z } from "zod";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, type ReportDefinition } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { exportActivitySchema, exportLoginsSchema } from "./audit.schemas";
import { activityForExport, loginsForExport } from "./audit.service";

// Login History and the Audit Log as reports, for the filters of the page. Both exports
// are written to the activity log. Only what the pages show is included. Stored text is
// untrusted (a user agent is whatever the sender says); the Excel renderer keeps it as text.

const FAILURE_REASONS: Record<string, string> = {
  unknown_account: "No account with this email",
  wrong_password: "Wrong password",
  inactive_account: "Account inactive or awaiting approval",
  temporary_password_expired: "Temporary password expired",
};

const utc = (value: string) => value.slice(0, 19).replace("T", " ");
const period = (filters: { from?: string | undefined; to?: string | undefined }) => (filters.from || filters.to ? `${filters.from ?? "Start"} to ${filters.to ?? "End"}` : null);
const words = (code: string) => code.replace(/[._]+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const formatName = (format: string) => (format === "xlsx" ? "Excel" : "PDF");

async function userName(userId: string | undefined): Promise<{ label: string; value: string }[]> {
  if (!userId) return [];

  const user = await pool.query<{ full_name: string }>("SELECT full_name FROM users WHERE id = $1", [userId]);

  return [{ label: "User", value: user.rows[0]?.full_name ?? `No. ${userId}` }];
}

const changeValue = (value: unknown) => (value === null || value === undefined || value === "" ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value));

export async function buildLoginsExport(auth: AuthContext, query: z.infer<typeof exportLoginsSchema>) {
  const { format, ...filters } = query;
  const logins = await loginsForExport(filters, (count) => assertExportSize(format, count));

  const report: ReportDefinition = {
    title: "Login History",
    period: period(filters),
    filters: [
      ...(filters.outcome ? [{ label: "Outcome", value: filters.outcome === "SUCCESS" ? "Successful" : "Failed" }] : []),
      ...(await userName(filters.userId)),
      ...(filters.search ? [{ label: "Search", value: filters.search }] : []),
    ],
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "login-history",
    tables: [
      {
        name: "Login History",
        columns: [
          { key: "when", header: "When (UTC)", kind: "text", width: 20 },
          { key: "user", header: "User", kind: "text", width: 24, wrap: true },
          { key: "email", header: "Email", kind: "text", width: 30, wrap: true },
          { key: "outcome", header: "Outcome", kind: "text", width: 12 },
          { key: "reason", header: "Reason", kind: "text", width: 24, wrap: true },
          { key: "ip", header: "Network Address", kind: "identifier", width: 18 },
          { key: "userAgent", header: "Browser / Device", kind: "text", width: 50, wrap: true },
        ],
        rows: logins.map((login) => ({
          when: utc(login.createdAt),
          user: login.user?.fullName ?? "No account",
          email: login.user?.email ?? null,
          outcome: login.outcome === "SUCCESS" ? "Successful" : "Failed",
          reason: login.reason ? (FAILURE_REASONS[login.reason] ?? words(login.reason)) : null,
          ip: login.ip,
          userAgent: login.userAgent,
        })),
      },
    ],
  };
  const recordExport = () =>
    logActivity(pool, { userId: auth.user.id, action: "login_history.exported", module: "USERS", entityType: "activity_logs", entityId: null, description: `Exported Login History as ${formatName(format)} (${logins.length} sign-ins).`, metadata: { format, filters, rowCount: logins.length } });

  return { report, recordExport };
}

export async function buildActivityExport(auth: AuthContext, query: z.infer<typeof exportActivitySchema>) {
  const { format, ...filters } = query;
  const entries = await activityForExport(filters, (count) => assertExportSize(format, count));

  const report: ReportDefinition = {
    title: "Audit Log",
    period: period(filters),
    filters: [
      ...(filters.module ? [{ label: "Module", value: words(filters.module) }] : []),
      ...(filters.entityType ? [{ label: "Record type", value: words(filters.entityType) }] : []),
      ...(filters.entityId ? [{ label: "Record no.", value: filters.entityId }] : []),
      ...(await userName(filters.userId)),
      ...(filters.search ? [{ label: "Search", value: filters.search }] : []),
    ],
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "audit-log",
    tables: [
      {
        name: "Audit Log",
        columns: [
          { key: "when", header: "When (UTC)", kind: "text", width: 20 },
          { key: "user", header: "User", kind: "text", width: 22, wrap: true },
          { key: "module", header: "Module", kind: "text", width: 18, wrap: true },
          { key: "action", header: "Action", kind: "text", width: 26, wrap: true },
          { key: "type", header: "Record Type", kind: "text", width: 18, wrap: true },
          { key: "id", header: "Record No.", kind: "identifier", width: 10 },
          { key: "details", header: "Details", kind: "text", width: 50, wrap: true },
          { key: "changes", header: "Changes", kind: "text", width: 50, wrap: true, excelOnly: true },
          { key: "reason", header: "Reason", kind: "text", width: 24, wrap: true },
          { key: "ip", header: "Network Address", kind: "identifier", width: 18 },
        ],
        rows: entries.map((entry) => ({
          when: utc(entry.createdAt),
          user: entry.user?.fullName ?? "System",
          module: words(entry.module),
          action: words(entry.action),
          type: words(entry.entityType),
          id: entry.entityId,
          details: entry.description,
          changes: entry.changes ? Object.entries(entry.changes).map(([field, change]) => `${field}: ${changeValue(change?.from)} -> ${changeValue(change?.to)}`).join("\n") || null : null,
          reason: entry.reason,
          ip: entry.ip,
        })),
      },
    ],
  };
  const recordExport = () =>
    logActivity(pool, { userId: auth.user.id, action: "audit_log.exported", module: "USERS", entityType: "activity_logs", entityId: null, description: `Exported the Audit Log as ${formatName(format)} (${entries.length} entries).`, metadata: { format, filters, rowCount: entries.length } });

  return { report, recordExport };
}
