import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { sendExport } from "../../shared/export/send";
import { parseIdParam } from "../../shared/validation";
import { buildInvoicesExport, buildPendingInvoicesExport } from "./invoices.export";
import {
  cancelInvoiceSchema,
  createInvoiceSchema,
  exportBillableSchema,
  exportInvoicesSchema,
  listBillableSchema,
  listInvoicesSchema,
  updateInvoiceSchema,
} from "./invoices.schemas";
import {
  cancelInvoice,
  createInvoice,
  getInvoice,
  getInvoiceSummary,
  listBillableWork,
  listInvoices,
  updateInvoice,
} from "./invoices.service";

// Mounted at /api/invoices.
export const invoicesRouter = Router();

invoicesRouter.use(authenticate);

invoicesRouter.get("/", authorize("INVOICES", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listInvoices(listInvoicesSchema.parse(req.query)) });
});

// The fixed paths are declared before "/:id".

// Dashboard and reporting contract.
invoicesRouter.get("/summary", authorize("INVOICES", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getInvoiceSummary(requireAuth(req)) });
});

// Completed work waiting for an invoice. Visits need AMC_SCHEDULE:VIEW and
// projects PROJECTS:VIEW as well (checked in the service).
invoicesRouter.get("/billable", authorize("INVOICES", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listBillableWork(requireAuth(req), listBillableSchema.parse(req.query)) });
});

// Reports. Exporting needs the EXPORT permission on top of VIEW. Both are internal
// tracking reports of what is recorded here; neither is, or produces, an invoice.
invoicesRouter.get("/export", authorize("INVOICES", "VIEW"), authorize("INVOICES", "EXPORT"), async (req, res) => {
  const query = exportInvoicesSchema.parse(req.query);
  const { report, recordExport } = await buildInvoicesExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// Like the list it exports, a section needs AMC_SCHEDULE:VIEW or PROJECTS:VIEW as well (checked in the service).
invoicesRouter.get("/billable/export", authorize("INVOICES", "VIEW"), authorize("INVOICES", "EXPORT"), async (req, res) => {
  const query = exportBillableSchema.parse(req.query);
  const { report, recordExport } = await buildPendingInvoicesExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

invoicesRouter.get("/:id", authorize("INVOICES", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getInvoice(parseIdParam(req.params.id)) });
});

invoicesRouter.post("/", authorize("INVOICES", "CREATE"), async (req, res) => {
  const invoice = await createInvoice(requireAuth(req), createInvoiceSchema.parse(req.body));

  res.status(201).json({ success: true, data: invoice });
});

invoicesRouter.patch("/:id", authorize("INVOICES", "EDIT"), async (req, res) => {
  const invoice = await updateInvoice(requireAuth(req), parseIdParam(req.params.id), updateInvoiceSchema.parse(req.body));

  res.json({ success: true, data: invoice });
});

// Invoices are never deleted. PROVISIONAL: cancelling needs INVOICES:EDIT and a reason.
invoicesRouter.post("/:id/cancel", authorize("INVOICES", "EDIT"), async (req, res) => {
  const invoice = await cancelInvoice(requireAuth(req), parseIdParam(req.params.id), cancelInvoiceSchema.parse(req.body));

  res.json({ success: true, data: invoice });
});
