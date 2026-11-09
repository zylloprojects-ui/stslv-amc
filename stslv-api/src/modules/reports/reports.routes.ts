import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { forbidden } from "../../shared/errors";
import { sendExport } from "../../shared/export/send";
import {
  assertReportAccess,
  buildReportExport,
  getReport,
  getReportOptions,
  reportCatalogue,
  reportExportSchema,
  reportQuerySchema,
  reportTypeSchema,
} from "./reports.service";

// Mounted at /api/reports. Read-only. REPORTS:VIEW opens the page; each report also needs
// View of its source modules, and its export REPORTS:EXPORT plus Export of those modules.
export const reportsRouter = Router();

reportsRouter.use(authenticate);

reportsRouter.get("/", authorize("REPORTS", "VIEW"), (req, res) => {
  res.json({ success: true, data: reportCatalogue(requireAuth(req).permissions) });
});

// The filter lists name clients and engineers, so they are given only to someone who may open at least one report.
reportsRouter.get("/options", authorize("REPORTS", "VIEW"), async (req, res) => {
  if (reportCatalogue(requireAuth(req).permissions).length === 0) throw forbidden();
  res.json({ success: true, data: await getReportOptions() });
});

reportsRouter.get("/:type/export", authorize("REPORTS", "VIEW"), authorize("REPORTS", "EXPORT"), async (req, res) => {
  const auth = requireAuth(req);
  const type = reportTypeSchema.parse(req.params.type);
  assertReportAccess(auth.permissions, type, "EXPORT");
  const query = reportExportSchema.parse(req.query);
  const { report, recordExport } = await buildReportExport(auth, type, query);

  await sendExport(res, report, query.format, recordExport);
});

reportsRouter.get("/:type", authorize("REPORTS", "VIEW"), async (req, res) => {
  const type = reportTypeSchema.parse(req.params.type);
  assertReportAccess(requireAuth(req).permissions, type, "VIEW");
  res.json({ success: true, data: await getReport(type, reportQuerySchema.parse(req.query)) });
});
