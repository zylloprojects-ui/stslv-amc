import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { parseIdParam } from "../../shared/validation";
import { buildServicesSalesExport } from "./services-sales.export";
import { exportServicesSalesSchema, listServicesSalesSchema, saveQuotationSchema } from "./services-sales.schemas";
import { getServicesSalesOptions, listServicesSales, readServicesSalesReport, saveQuotation } from "./services-sales.service";

export const servicesSalesRouter = Router();

// Every route needs migration 0078 (the quotation number). Without it they
// answer 503 FEATURE_UNAVAILABLE and the rest of the application is unaffected.
servicesSalesRouter.use(authenticate);
const quotationReady = requireSchema(["amc_visits.quotation_no"]);

servicesSalesRouter.get("/", authorize("SERVICES_SALES", "VIEW"), quotationReady, async (req, res) => {
  res.json({ success: true, data: await listServicesSales(listServicesSalesSchema.parse(req.query)) });
});

servicesSalesRouter.get("/options", authorize("SERVICES_SALES", "VIEW"), quotationReady, async (_req, res) => {
  res.json({ success: true, data: await getServicesSalesOptions() });
});

servicesSalesRouter.get("/export", authorize("SERVICES_SALES", "VIEW"), authorize("SERVICES_SALES", "EXPORT"), quotationReady, async (req, res) => {
  const query = exportServicesSalesSchema.parse(req.query);
  const { report, recordExport } = await buildServicesSalesExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// The Service Report uploaded on Service Status for ONE visit (the visit id), for View and Download. Read only:
// this page never uploads, replaces or removes a report. Viewing it needs only this page's VIEW permission.
servicesSalesRouter.get("/:id/report", authorize("SERVICES_SALES", "VIEW"), quotationReady, async (req, res) => {
  const file = await readServicesSalesReport(parseIdParam(req.params.id));
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

// The quotation number of one visit. Completion is not changed here: it belongs to Service Status.
servicesSalesRouter.patch("/:id", authorize("SERVICES_SALES", "EDIT"), quotationReady, async (req, res) => {
  const input = saveQuotationSchema.parse(req.body);

  res.json({ success: true, data: await saveQuotation(requireAuth(req), parseIdParam(req.params.id), input) });
});
