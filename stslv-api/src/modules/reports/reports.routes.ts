import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { sendExport } from "../../shared/export/send";
import { buildReportExport, getReport, reportCatalogue, reportExportSchema, reportQuerySchema, reportTypeSchema } from "./reports.service";

// Mounted at /api/reports. Read-only. REPORTS:VIEW opens the page and everything it shows.
export const reportsRouter = Router();

reportsRouter.use(authenticate);

reportsRouter.get("/", authorize("REPORTS", "VIEW"), (_req, res) => {
  res.json({ success: true, data: reportCatalogue() });
});

reportsRouter.get("/:type/export", authorize("REPORTS", "VIEW"), authorize("REPORTS", "EXPORT"), async (req, res) => {
  const query = reportExportSchema.parse(req.query);
  const { report, recordExport } = await buildReportExport(requireAuth(req), reportTypeSchema.parse(req.params.type), query);

  await sendExport(res, report, query.format, recordExport);
});

reportsRouter.get("/:type", authorize("REPORTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getReport(reportTypeSchema.parse(req.params.type), reportQuerySchema.parse(req.query)) });
});
