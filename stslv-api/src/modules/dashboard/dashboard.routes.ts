import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { getDashboardSummary } from "./dashboard.service";

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

// Every figure comes from the module that owns it and is filled only when the
// user may see that module; nothing is estimated. Invoice metrics are added
// here when the Invoice Tracking module exists.
dashboardRouter.get("/summary", authorize("DASHBOARD", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getDashboardSummary(requireAuth(req)) });
});
