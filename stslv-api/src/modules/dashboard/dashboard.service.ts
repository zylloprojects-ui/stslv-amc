import { pool } from "../../config/database";
import { summarySchema } from "../amc/amc.schemas";
import { canViewSummary, getAmcSummary, type AmcSummary } from "../amc/summary.service";
import type { AuthContext } from "../auth/access";
import { getProjectSummary } from "../projects/projects.service";

// The dashboard calculates nothing about AMC or projects itself. It puts the
// figures of the modules that own them side by side, each under the permission
// that module already requires. A section the user may not see is null.

export interface DashboardSummary {
  /** Requires CLIENTS:VIEW. */
  clients: { active: number; inactive: number } | null;
  /**
   * The AMC module's own summary. Requires at least one AMC view permission;
   * inside it, contracts, visits and invoicing are each null without theirs.
   */
  amc: AmcSummary | null;
  /**
   * The Projects module's own summary. Requires PROJECTS:VIEW; inside it,
   * costs is null without EXPENSES:VIEW.
   */
  projects: Awaited<ReturnType<typeof getProjectSummary>> | null;
}

async function getClientSummary(): Promise<{ active: number; inactive: number }> {
  const result = await pool.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE is_active)::int AS active,
            count(*) FILTER (WHERE NOT is_active)::int AS inactive
     FROM clients`
  );

  return { active: result.rows[0]?.active ?? 0, inactive: result.rows[0]?.inactive ?? 0 };
}

export async function getDashboardSummary(auth: AuthContext): Promise<DashboardSummary> {
  // The AMC summary's own default window for "upcoming" visits.
  const { upcomingDays } = summarySchema.parse({});

  const [clients, amc, projects] = await Promise.all([
    auth.permissions.has("CLIENTS:VIEW") ? getClientSummary() : null,
    canViewSummary(auth) ? getAmcSummary(auth, upcomingDays) : null,
    auth.permissions.has("PROJECTS:VIEW") ? getProjectSummary(auth) : null,
  ]);

  return { clients, amc, projects };
}
