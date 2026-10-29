import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize, authorizeRead } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { buildAccountsExport } from "./accounts.export";
import { exportAccountsSchema, listAccountsSchema } from "./accounts.schemas";
import { getAccountsOptions, listAccounts } from "./accounts.service";

export const accountsRouter = Router();

// Read only: one row per scheduled visit with its service report number and
// the invoices recorded in Invoice Tracking. A Finance page: viewing needs
// INVOICES:VIEW, and the visit data it shows needs AMC_SCHEDULE data-only read
// (View or Read, which opens no schedule page); exporting is a finance report
// and also needs INVOICES:EXPORT. Needs migration 0077; without
// it every route answers 503 FEATURE_UNAVAILABLE.
accountsRouter.use(authenticate);
const accountsView = [authorize("INVOICES", "VIEW"), authorizeRead("AMC_SCHEDULE"), requireSchema(["amc_visits.service_report_no"])];

accountsRouter.get("/", ...accountsView, async (req, res) => {
  res.json({ success: true, data: await listAccounts(listAccountsSchema.parse(req.query)) });
});

accountsRouter.get("/options", ...accountsView, async (_req, res) => {
  res.json({ success: true, data: await getAccountsOptions() });
});

// Every row that matches the page's filters, across all pages, with the page's visible columns.
accountsRouter.get("/export", ...accountsView, authorize("INVOICES", "EXPORT"), async (req, res) => {
  const query = exportAccountsSchema.parse(req.query);
  const { report, recordExport } = await buildAccountsExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});
