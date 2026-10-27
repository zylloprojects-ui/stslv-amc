import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { parseIdParam } from "../../shared/validation";
import { exportSystemTypesSchema, linkedContractsSchema } from "./system-types.schemas";
import { buildSystemTypesExport, deleteSystemType, listLinkedContracts } from "./system-types.service";

// Mounted at /api/masters/system-types, ahead of the master-list routes, which
// still serve the list, create, edit and status of a system type. Middleware is
// attached per route, so a request this router does not answer passes straight
// on without being authenticated twice.
export const systemTypesRouter = Router();

// Migration 0070: the table and amc_contracts.system_type_id.
const ready = requireSchema(["system_types", "amc_contracts.system_type_id"]);

// Declared before "/:id" routes. Exports the list with the page's filters and order.
systemTypesRouter.get("/export", authenticate, ready, authorize("SETTINGS", "VIEW"), authorize("SETTINGS", "EXPORT"), async (req, res) => {
  const query = exportSystemTypesSchema.parse(req.query);
  const { report, recordExport } = await buildSystemTypesExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// The contracts are AMC contract data, so they need contract view permission.
systemTypesRouter.get("/:id/contracts", authenticate, ready, authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  const { page, pageSize } = linkedContractsSchema.parse(req.query);

  res.json({ success: true, data: await listLinkedContracts(parseIdParam(req.params.id), page, pageSize) });
});

// Only a type that no contract uses; otherwise 409 with a reason.
systemTypesRouter.delete("/:id", authenticate, ready, authorize("SETTINGS", "DELETE"), async (req, res) => {
  await deleteSystemType(requireAuth(req), parseIdParam(req.params.id));

  res.json({ success: true, data: { deleted: true } });
});
