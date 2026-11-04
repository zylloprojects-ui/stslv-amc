import express, { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { requireSchema } from "../../middleware/require-schema";
import { forbidden, validationError } from "../../shared/errors";
import { parseIdParam } from "../../shared/validation";
import { ENTITY_TYPES, listAttachmentsSchema, uploadSchema, versionSchema } from "./attachments.schemas";
import { canAccess, listAttachments, storageConfigured, listRecordVersions, listVersions, readAttachment, uploadAttachment, uploadLimits, uploadVersion } from "./attachments.service";

// Mounted at /api/attachments. Permissions follow the record the file belongs
// to (checked in the service). There is no delete: a document is replaced by a
// new version and every version is kept.
export const attachmentsRouter = Router();

attachmentsRouter.use(authenticate);
// The table comes from migration 0071.
attachmentsRouter.use(requireSchema(["attachments"]));

// The file arrives as the raw request body; its name in the X-File-Name header
// (URI-encoded) and the other fields in the query string. The limit is a little
// above the configured maximum so an oversized file gets a clear message.
const rawFile = express.raw({ type: () => true, limit: (env.attachmentMaxMb + 1) * 1024 * 1024 });

function fileName(header: unknown): string {
  if (typeof header !== "string" || header.trim() === "") {
    throw validationError("The file name is missing.", [{ field: "file", message: "Choose a file to upload." }]);
  }

  return header;
}

function body(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
}

// The upload rules (size limit, file types) for one record type, for forms that state them before a file is chosen.
// Declared before "/:id". Open to whoever may view that record type's documents or add its records.
const limitsSchema = z.object({ entityType: z.enum(ENTITY_TYPES, { error: "Select a record type." }) });

attachmentsRouter.get("/limits", async (req, res) => {
  const auth = requireAuth(req);
  const { entityType } = limitsSchema.parse(req.query);

  if (!canAccess(auth, entityType, "VIEW") && !canAccess(auth, entityType, "CREATE")) throw forbidden();

  // storageAvailable: false when this server cannot store files (no ATTACHMENTS_DIR), so a form can say so first.
  res.json({ success: true, data: { ...uploadLimits(entityType), storageAvailable: storageConfigured() } });
});

attachmentsRouter.get("/", async (req, res) => {
  const { entityType, entityId } = listAttachmentsSchema.parse(req.query);

  res.json({ success: true, data: await listAttachments(requireAuth(req), entityType, entityId) });
});

// Every version of every document on a record, under the same permission as the list.
attachmentsRouter.get("/versions", async (req, res) => {
  const { entityType, entityId } = listAttachmentsSchema.parse(req.query);

  res.json({ success: true, data: await listRecordVersions(requireAuth(req), entityType, entityId) });
});

attachmentsRouter.post("/", rawFile, async (req, res) => {
  const input = uploadSchema.parse(req.query);
  const created = await uploadAttachment(requireAuth(req), input, fileName(req.get("X-File-Name")), body(req.body));

  res.status(201).json({ success: true, data: created });
});

attachmentsRouter.get("/:id/versions", async (req, res) => {
  res.json({ success: true, data: await listVersions(requireAuth(req), parseIdParam(req.params.id)) });
});

attachmentsRouter.post("/:id/versions", rawFile, async (req, res) => {
  const { notes } = versionSchema.parse(req.query);
  const created = await uploadVersion(requireAuth(req), parseIdParam(req.params.id), notes ?? null, fileName(req.get("X-File-Name")), body(req.body));

  res.status(201).json({ success: true, data: created });
});

attachmentsRouter.get("/:id/download", async (req, res) => {
  const file = await readAttachment(requireAuth(req), parseIdParam(req.params.id));
  // The stored name is already cleaned; the ASCII fallback keeps only safe characters.
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
