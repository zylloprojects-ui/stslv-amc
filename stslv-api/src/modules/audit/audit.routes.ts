import { Router } from "express";
import { adminOnly } from "../../middleware/admin-only";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { listActivitySchema, listLoginsSchema } from "./audit.schemas";
import { activityFilterOptions, listActivity, listLogins } from "./audit.service";

// Mounted at /api/audit. Read-only: the log is written by the modules themselves.
export const auditRouter = Router();

auditRouter.use(authenticate);

// Sign-in history, for whoever manages users.
auditRouter.get("/logins", authorize("USERS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listLogins(listLoginsSchema.parse(req.query)) });
});

// The full activity log spans every module, so it is for the built-in Admin role only.
auditRouter.get("/activity", adminOnly, async (req, res) => {
  res.json({ success: true, data: await listActivity(listActivitySchema.parse(req.query)) });
});

auditRouter.get("/activity/options", adminOnly, async (_req, res) => {
  res.json({ success: true, data: await activityFilterOptions() });
});
