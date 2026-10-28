import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { parseIdParam } from "../../shared/validation";
import { buildServicesSalesExport } from "./services-sales.export";
import { exportServicesSalesSchema, listServicesSalesSchema, saveQuotationSchema } from "./services-sales.schemas";
import { getServicesSalesOptions, listServicesSales, saveQuotation } from "./services-sales.service";

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

// The quotation number of one visit. Completion is not changed here: it belongs to Service Status.
servicesSalesRouter.patch("/:id", authorize("SERVICES_SALES", "EDIT"), quotationReady, async (req, res) => {
  const input = saveQuotationSchema.parse(req.body);

  res.json({ success: true, data: await saveQuotation(requireAuth(req), parseIdParam(req.params.id), input) });
});
