import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { forbidden } from "../../shared/errors";
import { sendExport } from "../../shared/export/send";
import { shows, type AuthContext } from "../auth/access";
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

/** Role visibility (0123): "reports.report.<id in camelCase>" hides one report from the role. */
export const reportVisibilityKey = (type: string) => `reports.report.${type.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`;

const HIDDEN_REPORT = "This report is not available to your role.";

/** The reports the user may open: by permission, then without those hidden from their role. */
const visibleCatalogue = (auth: AuthContext) => reportCatalogue(auth.permissions).filter((report) => shows(auth, reportVisibilityKey(report.id)));

reportsRouter.get("/", authorize("REPORTS", "VIEW"), (req, res) => {
  res.json({ success: true, data: visibleCatalogue(requireAuth(req)) });
});

// The filter lists name clients and engineers, so they are given only to someone who may open at least one report.
reportsRouter.get("/options", authorize("REPORTS", "VIEW"), async (req, res) => {
  if (visibleCatalogue(requireAuth(req)).length === 0) throw forbidden();
  res.json({ success: true, data: await getReportOptions() });
});

reportsRouter.get("/:type/export", authorize("REPORTS", "VIEW"), authorize("REPORTS", "EXPORT"), async (req, res) => {
  const auth = requireAuth(req);
  const type = reportTypeSchema.parse(req.params.type);
  assertReportAccess(auth.permissions, type, "EXPORT");
  if (!shows(auth, reportVisibilityKey(type))) throw forbidden(HIDDEN_REPORT);
  const query = reportExportSchema.parse(req.query);
  const { report, recordExport } = await buildReportExport(auth, type, query);

  await sendExport(res, report, query.format, recordExport);
});

reportsRouter.get("/:type", authorize("REPORTS", "VIEW"), async (req, res) => {
  const type = reportTypeSchema.parse(req.params.type);
  assertReportAccess(requireAuth(req).permissions, type, "VIEW");
  if (!shows(requireAuth(req), reportVisibilityKey(type))) throw forbidden(HIDDEN_REPORT);
  res.json({ success: true, data: await getReport(type, reportQuerySchema.parse(req.query)) });
});
