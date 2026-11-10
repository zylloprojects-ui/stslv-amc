import express, { Router, type Response } from "express";
import { env } from "../../config/env";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validationError } from "../../shared/errors";
import { sendExport } from "../../shared/export/send";
import { parseIdParam } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { buildAcknowledgementsExport } from "./invoice-acknowledgements.export";
import { confirmAcknowledgementSchema, exportAcknowledgementsSchema, listAcknowledgementsSchema, replaceReasonSchema } from "./invoice-acknowledgements.schemas";
import {
  attachDocument,
  confirmAcknowledgement,
  documentHistory,
  getAcknowledgement,
  getAcknowledgementOptions,
  listAcknowledgements,
  readDocument,
  replaceDocument,
  withdrawDocument,
} from "./invoice-acknowledgements.service";

// Finance -> Invoice Acknowledgements (migrations 0112, 0113). Its own permission module:
//   VIEW    the list, the filter lists, one invoice, the document viewer and its Download, the document history
//   CREATE  Attach Acknowledgement, remove an attached document before confirming, OK / Confirm
//   EDIT    Replace Document of an Acknowledged invoice (with a reason)
//   EXPORT  the Excel / PDF export (with VIEW)
// Nothing is ever deleted. Amounts (service value, Zoho invoice value) are sent only to a role that also holds
// ACCOUNTS:VIEW, the page they come from. The document travels only through these routes, with the user's token:
// never a storage path or a public link.

export const invoiceAcknowledgementsRouter = Router();

invoiceAcknowledgementsRouter.use(authenticate);

/** Amounts come from Accounts: a role that cannot view Accounts is shown none, here or in the export. */
const amountsVisible = (auth: AuthContext) => auth.permissions.has("ACCOUNTS:VIEW");

// The file arrives as the raw request body with its name URI-encoded in X-File-Name, as for Service Reports.
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

invoiceAcknowledgementsRouter.get("/", authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW"), async (req, res) => {
  const auth = requireAuth(req);

  res.json({ success: true, data: await listAcknowledgements(listAcknowledgementsSchema.parse(req.query), amountsVisible(auth)) });
});

invoiceAcknowledgementsRouter.get("/options", authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await getAcknowledgementOptions() });
});

// Every invoice that matches the page's filters, across all pages, with the page's visible columns.
invoiceAcknowledgementsRouter.get("/export", authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW"), authorize("INVOICE_ACKNOWLEDGEMENTS", "EXPORT"), async (req, res) => {
  const auth = requireAuth(req);
  const query = exportAcknowledgementsSchema.parse(req.query);
  const { report, recordExport } = await buildAcknowledgementsExport(auth, query, amountsVisible(auth));

  await sendExport(res, report, query.format, recordExport);
});

invoiceAcknowledgementsRouter.get("/:visitId", authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getAcknowledgement(parseIdParam(req.params.visitId), amountsVisible(requireAuth(req))) });
});

invoiceAcknowledgementsRouter.get("/:visitId/history", authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await documentHistory(parseIdParam(req.params.visitId)) });
});

function sendDocument(res: Response, file: { data: Buffer; mimeType: string; fileName: string }) {
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
}

// The current document (attached or confirmed), for the viewer and the Download inside it.
invoiceAcknowledgementsRouter.get("/:visitId/document", authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW"), async (req, res) => {
  sendDocument(res, await readDocument(parseIdParam(req.params.visitId)));
});

// Attach Acknowledgement: stored at once, status stays Pending until OK / Confirm.
invoiceAcknowledgementsRouter.post("/:visitId/document", authorize("INVOICE_ACKNOWLEDGEMENTS", "CREATE"), rawDocument, async (req, res) => {
  const { name, body } = uploadedFile(req);

  res.status(201).json({ success: true, data: await attachDocument(requireAuth(req), parseIdParam(req.params.visitId), name, body, amountsVisible(requireAuth(req))) });
});

// Removes an attached document before it is confirmed (kept, not current).
invoiceAcknowledgementsRouter.delete("/:visitId/document", authorize("INVOICE_ACKNOWLEDGEMENTS", "CREATE"), async (req, res) => {
  res.json({ success: true, data: await withdrawDocument(requireAuth(req), parseIdParam(req.params.visitId), amountsVisible(requireAuth(req))) });
});

// OK / Confirm: Pending -> Acknowledged.
invoiceAcknowledgementsRouter.post("/:visitId/confirm", authorize("INVOICE_ACKNOWLEDGEMENTS", "CREATE"), async (req, res) => {
  const { attachmentId } = confirmAcknowledgementSchema.parse(req.body);

  res.json({ success: true, data: await confirmAcknowledgement(requireAuth(req), parseIdParam(req.params.visitId), attachmentId, amountsVisible(requireAuth(req))) });
});

// Replace Document of an Acknowledged invoice: Edit, and a reason in X-Replace-Reason (URI-encoded).
invoiceAcknowledgementsRouter.post("/:visitId/replace", authorize("INVOICE_ACKNOWLEDGEMENTS", "VIEW"), authorize("INVOICE_ACKNOWLEDGEMENTS", "EDIT"), rawDocument, async (req, res) => {
  const reasonResult = replaceReasonSchema.safeParse(decodeHeader(req.get("X-Replace-Reason")));

  if (!reasonResult.success) {
    const message = reasonResult.error.issues[0]?.message ?? "Give the reason for replacing the acknowledgement document.";
    throw validationError(message, [{ field: "reason", message }]);
  }

  const { name, body } = uploadedFile(req);

  res.status(201).json({
    success: true,
    data: await replaceDocument(requireAuth(req), parseIdParam(req.params.visitId), name, body, reasonResult.data, amountsVisible(requireAuth(req))),
  });
});
