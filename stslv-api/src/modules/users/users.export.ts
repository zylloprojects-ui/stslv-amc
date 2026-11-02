import type { z } from "zod";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, type ReportDefinition } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { exportUsersSchema } from "./users.schemas";
import { listUsersMatching, type User } from "./users.service";

const STATUS_LABELS = { ACTIVE: "Active", INACTIVE: "Inactive", PENDING: "Pending approval", REJECTED: "Rejected" };

const statusOf = (user: User) => (user.approvalStatus === "PENDING" ? "Pending approval" : user.approvalStatus === "REJECTED" ? "Rejected" : user.isActive ? "Active" : "Inactive");
const utc = (value: string) => value.slice(0, 19).replace("T", " ");

/** The Users table as a report, for the page's filters. Holds no password, hash or temporary-password detail. */
export async function buildUsersExport(auth: AuthContext, query: z.infer<typeof exportUsersSchema>) {
  const { format, ...filters } = query;
  const users = await listUsersMatching(filters);

  assertExportSize(format, users.length);

  const report: ReportDefinition = {
    title: "Users",
    period: null,
    filters: [...(filters.search ? [{ label: "Search", value: filters.search }] : []), ...(filters.status ? [{ label: "Status", value: STATUS_LABELS[filters.status] }] : [])],
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "users",
    tables: [
      {
        name: "Users",
        columns: [
          { key: "name", header: "Name", kind: "text", width: 28, wrap: true },
          { key: "email", header: "Email", kind: "text", width: 34, wrap: true },
          { key: "role", header: "Role", kind: "text", width: 26, wrap: true },
          { key: "status", header: "Status", kind: "text", width: 18 },
          { key: "lastSignIn", header: "Last Sign-in (UTC)", kind: "text", width: 20 },
          { key: "created", header: "Created (UTC)", kind: "text", width: 20 },
        ],
        rows: users.map((user) => ({
          name: user.fullName,
          email: user.email,
          role: user.roles.map((role) => role.name).join(", ") || "No role",
          status: statusOf(user),
          lastSignIn: user.lastLoginAt ? utc(user.lastLoginAt) : "Never",
          created: utc(user.createdAt),
        })),
      },
    ],
  };
  const recordExport = () =>
    logActivity(pool, { userId: auth.user.id, action: "users.exported", module: "USERS", entityType: "users", entityId: null, description: `Exported the Users list as ${format === "xlsx" ? "Excel" : "PDF"} (${users.length} users).`, metadata: { format, filters, rowCount: users.length } });

  return { report, recordExport };
}
