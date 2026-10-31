import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { buildAccountsExport } from "./accounts.export";
import { exportAccountsSchema, listAccountsSchema } from "./accounts.schemas";
import { getAccountsOptions, listAccounts } from "./accounts.service";

export const accountsRouter = Router();

// Read only: one row per scheduled visit with its service report number and
// the invoices recorded in Invoice Tracking. Its own module (0091): ACCOUNTS:VIEW
// opens it, with everything it shows, and exporting also needs ACCOUNTS:EXPORT.
// Needs migration 0077; without it every route answers 503 FEATURE_UNAVAILABLE.
accountsRouter.use(authenticate);
const accountsView = [authorize("ACCOUNTS", "VIEW"), requireSchema(["amc_visits.service_report_no"])];

accountsRouter.get("/", ...accountsView, async (req, res) => {
  res.json({ success: true, data: await listAccounts(listAccountsSchema.parse(req.query)) });
});

accountsRouter.get("/options", ...accountsView, async (_req, res) => {
  res.json({ success: true, data: await getAccountsOptions() });
});

// Every row that matches the page's filters, across all pages, with the page's visible columns.
accountsRouter.get("/export", ...accountsView, authorize("ACCOUNTS", "EXPORT"), async (req, res) => {
  const query = exportAccountsSchema.parse(req.query);
  const { report, recordExport } = await buildAccountsExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});
