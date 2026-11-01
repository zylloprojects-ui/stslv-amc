import { Router } from "express";
import { adminOnly } from "../../middleware/admin-only";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { sendExport } from "../../shared/export/send";
import { buildActivityExport, buildLoginsExport } from "./audit.export";
import { exportActivitySchema, exportLoginsSchema, listActivitySchema, listLoginsSchema } from "./audit.schemas";
import { activityFilterOptions, listActivity, listLogins } from "./audit.service";

// Mounted at /api/audit. Read-only: the log is written by the modules themselves.
export const auditRouter = Router();

auditRouter.use(authenticate);

// Sign-in history, for whoever manages users.
auditRouter.get("/logins", authorize("USERS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listLogins(listLoginsSchema.parse(req.query)) });
});

// USERS has no Export action, and adding one would change what roles can be granted: administrators only.
auditRouter.get("/logins/export", authorize("USERS", "VIEW"), adminOnly, async (req, res) => {
  const query = exportLoginsSchema.parse(req.query);
  const { report, recordExport } = await buildLoginsExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// The full activity log spans every module, so it is for the built-in Admin role only.
auditRouter.get("/activity", adminOnly, async (req, res) => {
  res.json({ success: true, data: await listActivity(listActivitySchema.parse(req.query)) });
});

auditRouter.get("/activity/export", adminOnly, async (req, res) => {
  const query = exportActivitySchema.parse(req.query);
  const { report, recordExport } = await buildActivityExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

auditRouter.get("/activity/options", adminOnly, async (_req, res) => {
  res.json({ success: true, data: await activityFilterOptions() });
});
