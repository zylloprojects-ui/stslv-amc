import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { buildAccountsExport } from "./accounts.export";
import { exportAccountsSchema, listAccountsSchema } from "./accounts.schemas";
import { parseIdParam } from "../../shared/validation";
import { getAccountsOptions, listAccounts, readAccountsServiceReport } from "./accounts.service";

export const accountsRouter = Router();

// One row per scheduled visit with its service report number, manual Invoice No.
// and the Zoho invoices of Invoice Tracking. These routes only read: the page's
// Invoice No. field saves through PATCH /api/amc/visits/:id/manual-invoice. Its own module (0091): ACCOUNTS:VIEW
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

// The Service Report uploaded on Service Status for ONE visit listed here, for the page's read-only viewer and the
// Download inside it (client fixes, 2026-11-09). Read only, ACCOUNTS:VIEW, never a public or storage link.
accountsRouter.get("/:id/report", ...accountsView, async (req, res) => {
  const file = await readAccountsServiceReport(parseIdParam(req.params.id));
  // The stored name is already cleaned at upload; the ASCII fallback keeps only safe characters.
  const ascii = file.fileName.replace(/[^A-Za-z0-9._ -]/g, "_");

  res.set({
    "Content-Type": file.mimeType,
    "Content-Length": String(file.data.length),
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(file.data);
});

// Every row that matches the page's filters, across all pages, with the page's visible columns.
accountsRouter.get("/export", ...accountsView, authorize("ACCOUNTS", "EXPORT"), async (req, res) => {
  const query = exportAccountsSchema.parse(req.query);
  const { report, recordExport } = await buildAccountsExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});
