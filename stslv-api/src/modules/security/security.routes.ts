import { createReadStream } from "node:fs";
import { Router, type RequestHandler } from "express";
import { adminOnly } from "../../middleware/admin-only";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { conflict, forbidden } from "../../shared/errors";
import { purgeSchema, listRecycleBinSchema, recycleTypeParamSchema } from "../recycle-bin/recycle-bin.schemas";
import { assertRecycleBinAdmin, checkRecycleItem, listRecycleBin, purgeMaster, restoreMaster } from "../recycle-bin/recycle-bin.service";
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

// Recycle Bin (migrations 0101 and 0106): the records currently in it, never past events. Super Admin
// only, checked in the services, so Admin gets 403 here although the router admits administrators.
securityRouter.get("/recycle-bin", async (req, res) => {
  res.json({ success: true, data: await listRecycleBin(requireAuth(req), listRecycleBinSchema.parse(req.query)) });
});

// Kept for a frontend released before 0106 (Pages and the API deploy separately): the deleted contracts as before.
securityRouter.get("/recycle-bin/amc-contracts", async (req, res) => {
  res.json({ success: true, data: await listDeletedContracts(requireAuth(req)) });
});

// What restoring and permanent deletion would do: blockers, warnings, and whether the record was ever used.
securityRouter.get("/recycle-bin/:type/:id/check", async (req, res) => {
  const type = recycleTypeParamSchema.parse(req.params.type);

  res.json({ success: true, data: await checkRecycleItem(requireAuth(req), type, parseIdParam(req.params.id)) });
});

securityRouter.post("/recycle-bin/:type/:id/restore", async (req, res) => {
  const auth = requireAuth(req);
  const type = recycleTypeParamSchema.parse(req.params.type);
  const id = parseIdParam(req.params.id);

  if (type === "AMC_CONTRACT") {
    // The response of the former route: the restored contract (the frontend of before 0106 reads it).
    res.json({ success: true, data: await restoreContract(auth, id) });
    return;
  }

  res.json({ success: true, data: await restoreMaster(auth, type, id) });
});

// Permanent deletion: clients, system types and sales engineers only, never used, code typed to confirm.
securityRouter.delete("/recycle-bin/:type/:id", async (req, res) => {
  const auth = requireAuth(req);
  const type = recycleTypeParamSchema.parse(req.params.type);

  assertRecycleBinAdmin(auth);
  if (type === "AMC_CONTRACT") {
    throw conflict("AMC contracts are never deleted permanently. Restore the contract, or leave it in the Recycle Bin.");
  }

  await purgeMaster(auth, type, parseIdParam(req.params.id), purgeSchema.parse(req.body ?? {}).confirm);
  res.json({ success: true, data: { deleted: true } });
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
