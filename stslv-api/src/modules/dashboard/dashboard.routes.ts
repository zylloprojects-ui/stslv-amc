import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { adminOnly } from "../../middleware/admin-only";
import { authorize } from "../../middleware/authorize";
import { forbidden } from "../../shared/errors";
import { getDashboardSummary } from "./dashboard.service";
import { canViewVisitCounts, getCalendarMonth, getOperationsDashboard } from "./operations.service";
import { getReadiness } from "./readiness.service";

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

// Every figure comes from the module that owns it and is filled only when the
// user may see that module; nothing is estimated.
dashboardRouter.get("/summary", authorize("DASHBOARD", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getDashboardSummary(requireAuth(req)) });
});

// The AMC Operations Dashboard: KPIs, portfolio, expiry, workload and today's
// work. Each section is null without the permission of the module it reads.
dashboardRouter.get("/operations", authorize("DASHBOARD", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getOperationsDashboard(requireAuth(req)) });
});

const calendarSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM."),
});

// Visit counts per day of a month. Counts only, so schedule or execution view is enough.
dashboardRouter.get("/calendar", authorize("DASHBOARD", "VIEW"), async (req, res) => {
  if (!canViewVisitCounts(requireAuth(req))) {
    throw forbidden();
  }

  res.json({ success: true, data: await getCalendarMonth(calendarSchema.parse(req.query).month) });
});

// Configuration and database posture: built-in Admin role only, like the Audit Log.
dashboardRouter.get("/readiness", authorize("DASHBOARD", "VIEW"), adminOnly, async (_req, res) => {
  res.json({ success: true, data: await getReadiness() });
});
