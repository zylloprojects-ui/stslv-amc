import express, { Router, type Response } from "express";
import { env } from "../../config/env";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validationError } from "../../shared/errors";
import { sendExport } from "../../shared/export/send";
import { parseIdParam } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { buildAcknowledgementsExport } from "./invoice-acknowledgements.export";
import {
  chooseAcknowledgementSchema,
  confirmAcknowledgementSchema,
  confirmSeparateSchema,
  exportAcknowledgementsSchema,
  linkInvoicesSchema,
  listAcknowledgementsSchema,
  replaceReasonSchema,
} from "./invoice-acknowledgements.schemas";
import {
  attachDocument,
  chooseAcknowledgement,
  confirmAcknowledgement,
  confirmSeparate,
  documentHistory,
  getAcknowledgement,
  getAcknowledgementOptions,
  linkedServices,
  linkInvoices,
  listAcknowledgements,
  readDocument,
  reconciliationView,
  replaceDocument,
  withdrawDocument,
} from "./invoice-acknowledgements.service";

// Finance -> Invoice Acknowledgements (migrations 0112-0115). One row per INVOICE (ack_invoices); :invoiceId is its id.
//   VIEW    list, filter lists, one invoice, Linked Services, document viewer and Download, document history
//   CREATE  Attach Acknowledgement, remove before confirming, OK / Confirm
//   EDIT    Replace Document (with reason); reconciliation: view, link, confirm separate, choose current (with reason)
//   EXPORT  the Excel / PDF export (with VIEW)
// Nothing is ever deleted. Amounts are sent only to a role that also holds ACCOUNTS:VIEW. Documents travel only
// through these routes, with the user's token: never a storage path or a public link.

export const invoiceAcknowledgementsRouter = Router();

invoiceAcknowledgementsRouter.use(authenticate);

const amountsVisible = (auth: AuthContext) => auth.permissions.has("ACCOUNTS:VIEW");

const rawDocument = express.raw({ type: () => true, limit: (env.attachmentMaxMb + 1) * 1024 * 1024 });

function uploadedFile(req: express.Request): { name: string; body: Buffer } {
  const name = req.get("X-File-Name");

  if (typeof name !== "string" || name.trim() === "") {
    throw validationError("The file name is missing.", [{ field: "document", message: "Choose a file to upload." }]);
  }

  return { name, body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) };
}

function decodeHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const view = authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW");
const id = (req: express.Request) => parseIdParam(req.params.invoiceId);

invoiceAcknowledgementsRouter.get("/", view, async (req, res) => {
  res.json({ success: true, data: await listAcknowledgements(listAcknowledgementsSchema.parse(req.query), amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.get("/options", view, async (_req, res) => {
  res.json({ success: true, data: await getAcknowledgementOptions() });
});

invoiceAcknowledgementsRouter.get("/export", view, authorize("INVOICE_ACKNOWLEDGEMENTS", "EXPORT"), async (req, res) => {
  const auth = requireAuth(req);
  const query = exportAcknowledgementsSchema.parse(req.query);
  const { report, recordExport } = await buildAcknowledgementsExport(auth, query, amountsVisible(auth));

  await sendExport(res, report, query.format, recordExport);
});

invoiceAcknowledgementsRouter.get("/:invoiceId", view, async (req, res) => {
  res.json({ success: true, data: await getAcknowledgement(id(req), amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.get("/:invoiceId/services", view, async (req, res) => {
  res.json({ success: true, data: await linkedServices(id(req), amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.get("/:invoiceId/history", view, async (req, res) => {
  res.json({ success: true, data: await documentHistory(id(req)) });
});

function sendDocument(res: Response, file: { data: Buffer; mimeType: string; fileName: string }) {
  const ascii = file.fileName.replace(/[^A-Za-z0-9._ -]/g, "_");

  res.set({
    "Content-Type": file.mimeType,
    "Content-Length": String(file.data.length),
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(file.data);
}

// The current document, for the viewer and the Download inside it.
invoiceAcknowledgementsRouter.get("/:invoiceId/document", view, async (req, res) => {
  sendDocument(res, await readDocument(id(req)));
});

// An earlier version, only if it belongs to this invoice.
invoiceAcknowledgementsRouter.get("/:invoiceId/documents/:attachmentId", view, async (req, res) => {
  sendDocument(res, await readDocument(id(req), parseIdParam(req.params.attachmentId)));
});

invoiceAcknowledgementsRouter.post("/:invoiceId/document", authorize("INVOICE_ACKNOWLEDGEMENTS", "CREATE"), rawDocument, async (req, res) => {
  const { name, body } = uploadedFile(req);

  res.status(201).json({ success: true, data: await attachDocument(requireAuth(req), id(req), name, body, amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.delete("/:invoiceId/document", authorize("INVOICE_ACKNOWLEDGEMENTS", "CREATE"), async (req, res) => {
  res.json({ success: true, data: await withdrawDocument(requireAuth(req), id(req), amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.post("/:invoiceId/confirm", authorize("INVOICE_ACKNOWLEDGEMENTS", "CREATE"), async (req, res) => {
  const { attachmentId } = confirmAcknowledgementSchema.parse(req.body);

  res.json({ success: true, data: await confirmAcknowledgement(requireAuth(req), id(req), attachmentId, amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.post("/:invoiceId/replace", view, authorize("INVOICE_ACKNOWLEDGEMENTS", "EDIT"), rawDocument, async (req, res) => {
  const reasonResult = replaceReasonSchema.safeParse(decodeHeader(req.get("X-Replace-Reason")));

  if (!reasonResult.success) {
    const message = reasonResult.error.issues[0]?.message ?? "Give the reason for replacing the acknowledgement document.";
    throw validationError(message, [{ field: "reason", message }]);
  }

  const { name, body } = uploadedFile(req);

  res.status(201).json({ success: true, data: await replaceDocument(requireAuth(req), id(req), name, body, reasonResult.data, amountsVisible(requireAuth(req))) });
});

// Reconciliation: Edit, always with a reason, always audited.
const edit = [view, authorize("INVOICE_ACKNOWLEDGEMENTS", "EDIT")];

invoiceAcknowledgementsRouter.get("/:invoiceId/reconciliation", ...edit, async (req, res) => {
  res.json({ success: true, data: await reconciliationView(id(req)) });
});

invoiceAcknowledgementsRouter.post("/:invoiceId/link", ...edit, async (req, res) => {
  const { otherInvoiceId, reason } = linkInvoicesSchema.parse(req.body);

  res.json({ success: true, data: await linkInvoices(requireAuth(req), id(req), otherInvoiceId, reason, amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.post("/:invoiceId/separate", ...edit, async (req, res) => {
  const { reason } = confirmSeparateSchema.parse(req.body);

  res.json({ success: true, data: await confirmSeparate(requireAuth(req), id(req), reason, amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.post("/:invoiceId/choose", ...edit, async (req, res) => {
  const { acknowledgementId, reason } = chooseAcknowledgementSchema.parse(req.body);

  res.json({ success: true, data: await chooseAcknowledgement(requireAuth(req), id(req), acknowledgementId, reason, amountsVisible(requireAuth(req))) });
});
