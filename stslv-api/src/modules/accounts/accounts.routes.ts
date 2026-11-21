import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { buildAccountsExport } from "./accounts.export";
import { exportAccountsSchema, listAccountsSchema } from "./accounts.schemas";
import { parseIdParam } from "../../shared/validation";
import { holdsPermission } from "../../shared/permissions";
import { getAccountsOptions, listAccounts, readAccountsContractDocument, readAccountsServiceReport } from "./accounts.service";
import { mayDownloadContract, mayOpenServiceReport, roleHiddenColumns } from "./accounts.visibility";
import { forbidden } from "../../shared/errors";

const HIDDEN_FOR_ROLE = "This is not available to your role.";

export const accountsRouter = Router();

// One row per scheduled visit with its service report number, manual Invoice No.
// and the Zoho invoices of Invoice Tracking. These routes only read: the page's
// Invoice No. field saves through PATCH /api/amc/visits/:id/manual-invoice. Its own module (0091): ACCOUNTS:VIEW
// opens it, with everything it shows, and exporting also needs ACCOUNTS:EXPORT.
// Needs migration 0077; without it every route answers 503 FEATURE_UNAVAILABLE.
accountsRouter.use(authenticate);
const accountsView = [authorize("ACCOUNTS", "VIEW"), requireSchema(["amc_visits.service_report_no"])];

accountsRouter.get("/", ...accountsView, async (req, res) => {
  const auth = requireAuth(req);
  const { permissions } = auth;
  // The read-only acknowledgement indicator only for users who may view Invoice Acknowledgements. The contract's AMC
  // Value (client UAT CR-013) is part of this page for everyone who may open it (Accounts: View): the client asked for
  // it so Accounts can invoice. Only that one figure per service; no other contract data, and no AMC Contracts access.
  // The contract's AMC Value / Year under each service value needs AMC Contracts: View, exactly as on Master AMC Status.
  const access = {
    acknowledgements: permissions.has("INVOICE_ACKNOWLEDGEMENTS:VIEW"),
    amcValue: true,
    annualAmcValue: holdsPermission(permissions, "AMC_CONTRACTS:VIEW"),
    // The AMC Contract column (the contract document) is part of this page for everyone who may open it (owner decision
    // 2026-11-21): Accounts needs the contract to invoice. It is downloaded through GET /api/accounts/:id/contract-document
    // below, which serves only the contract document of a service listed here. AMC Contracts itself (its pages, the
    // contract link, its other documents) still needs AMC Contracts: View.
    contractDocument: true,
    // Role visibility (0123): the columns the user's role does not see are not sent at all.
    hiddenColumns: roleHiddenColumns(auth),
  };

  res.json({ success: true, data: await listAccounts(listAccountsSchema.parse(req.query), access) });
});

accountsRouter.get("/options", ...accountsView, async (_req, res) => {
  res.json({ success: true, data: await getAccountsOptions() });
});

// The Service Report uploaded on Service Status for ONE visit listed here, for the page's read-only viewer and the
// Download inside it (client fixes, 2026-11-09). Read only, ACCOUNTS:VIEW, never a public or storage link.
accountsRouter.get("/:id/report", ...accountsView, async (req, res) => {
  // Role visibility: the Service Report column or its action may be hidden from the user's role.
  if (!mayOpenServiceReport(requireAuth(req))) throw forbidden(HIDDEN_FOR_ROLE);
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

// The contract document of ONE service listed here (the AMC Contract column), for its Download (owner decision
// 2026-11-21). ACCOUNTS:VIEW only: no AMC Contracts permission is needed, and no other document of the contract is reachable.
accountsRouter.get("/:id/contract-document", ...accountsView, async (req, res) => {
  // Role visibility: the AMC Contract column or the Download AMC contract action may be hidden from the user's role.
  if (!mayDownloadContract(requireAuth(req))) throw forbidden(HIDDEN_FOR_ROLE);
  const file = await readAccountsContractDocument(parseIdParam(req.params.id));
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
