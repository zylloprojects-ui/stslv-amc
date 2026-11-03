import { createReadStream } from "node:fs";
import { Router, type RequestHandler } from "express";
import { adminOnly } from "../../middleware/admin-only";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { forbidden } from "../../shared/errors";
import { isSuperAdmin } from "../../shared/role-model";
import { parseIdParam } from "../../shared/validation";
import { listDeletedContracts, restoreContract } from "../amc/contracts.service";
import { listBackups, startBackup, verifiedBackupFile } from "./backups.service";
import { sendExport } from "../../shared/export/send";
import { transportOf } from "../dashboard/readiness.service";
import { buildDeletionsExport, exportDeletionsSchema, getSecurityOverview, listDeletions, listDeletionsSchema, listSecurityEvents, listSecurityEventsSchema } from "./security.service";

// Mounted at /api/security. Administrators read; only Super Admin can run or download a
// backup, because a backup holds every record including password hashes.
export const securityRouter = Router();

securityRouter.use(authenticate);
securityRouter.use(adminOnly);

const superAdmin: RequestHandler = (req, _res, next) => {
  if (!isSuperAdmin(requireAuth(req).roles)) throw forbidden("Only Super Admin can run or download backups.");
  next();
};

securityRouter.get("/overview", async (req, res) => {
  res.json({ success: true, data: await getSecurityOverview(transportOf(req)) });
});

securityRouter.get("/events", async (req, res) => {
  res.json({ success: true, data: await listSecurityEvents(listSecurityEventsSchema.parse(req.query)) });
});

securityRouter.get("/deletions/export", async (req, res) => {
  const query = exportDeletionsSchema.parse(req.query);
  const { report, recordExport } = await buildDeletionsExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

securityRouter.get("/deletions", async (req, res) => {
  res.json({ success: true, data: await listDeletions(listDeletionsSchema.parse(req.query)) });
});

// AMC contracts in the Recycle Bin, and restoring one. Super Admin only (checked in the service).
securityRouter.get("/recycle-bin/amc-contracts", async (req, res) => {
  res.json({ success: true, data: await listDeletedContracts(requireAuth(req)) });
});

securityRouter.post("/recycle-bin/amc-contracts/:id/restore", async (req, res) => {
  res.json({ success: true, data: await restoreContract(requireAuth(req), parseIdParam(req.params.id)) });
});

securityRouter.get("/backups", async (_req, res) => {
  res.json({ success: true, data: await listBackups() });
});

securityRouter.post("/backups", superAdmin, async (req, res) => {
  res.status(202).json({ success: true, data: await startBackup(requireAuth(req)) });
});

securityRouter.get("/backups/:id/download", superAdmin, async (req, res) => {
  const { file, name, size } = await verifiedBackupFile(requireAuth(req), String(req.params.id));

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "no-store");
  createReadStream(file).pipe(res);
});
