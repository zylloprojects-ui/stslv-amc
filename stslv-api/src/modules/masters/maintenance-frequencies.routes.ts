import { Router, type RequestHandler } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { AppError, forbidden } from "../../shared/errors";
import { sendExport } from "../../shared/export/send";
import { canReadMaster } from "./master-permissions";
import { parseIdParam } from "../../shared/validation";
import {
  createFrequencySchema,
  exportFrequenciesSchema,
  frequencyPagingSchema,
  frequencyStatusSchema,
  listFrequenciesSchema,
  updateFrequencySchema,
} from "./maintenance-frequencies.schemas";
import {
  buildFrequenciesExport,
  createFrequency,
  frequencyOptions,
  getFrequency,
  listFrequencies,
  listFrequencyHistory,
  listLinkedContracts,
  setFrequencyStatus,
  updateFrequency,
} from "./maintenance-frequencies.service";

// To be mounted at /api/masters/maintenance-frequencies, ahead of /api/masters
// (an approved integration step). It answers every frequency route itself, so
// the generic master-list routes for frequencies are no longer reached.
// Every route needs migration 0076; until it is applied they answer 503
// FEATURE_UNAVAILABLE.
export const maintenanceFrequenciesRouter = Router();

const ready = requireSchema(["maintenance_frequencies", "maintenance_frequencies.code_prefix", "maintenance_frequencies.archived_at"]);

maintenanceFrequenciesRouter.use(authenticate, ready);

// As for the other master lists: managed with MAINTENANCE_FREQUENCIES permissions; a user
// who may view AMC contracts may also read the list, to pick from on a contract.
const canRead = canReadMaster("maintenance-frequencies");

maintenanceFrequenciesRouter.get("/", canRead, async (req, res) => {
  res.json({ success: true, data: await listFrequencies(listFrequenciesSchema.parse(req.query)) });
});

// Declared before "/:id".
maintenanceFrequenciesRouter.get("/options", canRead, async (_req, res) => {
  res.json({ success: true, data: await frequencyOptions() });
});

maintenanceFrequenciesRouter.get("/export", authorize("MAINTENANCE_FREQUENCIES", "VIEW"), authorize("MAINTENANCE_FREQUENCIES", "EXPORT"), async (req, res) => {
  const query = exportFrequenciesSchema.parse(req.query);
  const { report, recordExport } = await buildFrequenciesExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

maintenanceFrequenciesRouter.get("/:id", canRead, async (req, res) => {
  res.json({ success: true, data: await getFrequency(parseIdParam(req.params.id)) });
});

maintenanceFrequenciesRouter.get("/:id/history", canRead, async (req, res) => {
  const { page, pageSize } = frequencyPagingSchema.parse(req.query);

  res.json({ success: true, data: await listFrequencyHistory(parseIdParam(req.params.id), page, pageSize) });
});

// The contracts are AMC contract data, so they need contract view permission.
maintenanceFrequenciesRouter.get("/:id/contracts", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  const { page, pageSize } = frequencyPagingSchema.parse(req.query);

  res.json({ success: true, data: await listLinkedContracts(parseIdParam(req.params.id), page, pageSize) });
});

maintenanceFrequenciesRouter.post("/", authorize("MAINTENANCE_FREQUENCIES", "CREATE"), async (req, res) => {
  res.status(201).json({ success: true, data: await createFrequency(requireAuth(req), createFrequencySchema.parse(req.body)) });
});

maintenanceFrequenciesRouter.patch("/:id", authorize("MAINTENANCE_FREQUENCIES", "EDIT"), async (req, res) => {
  const id = parseIdParam(req.params.id);

  res.json({ success: true, data: await updateFrequency(requireAuth(req), id, updateFrequencySchema.parse(req.body)) });
});

maintenanceFrequenciesRouter.post("/:id/status", authorize("MAINTENANCE_FREQUENCIES", "EDIT"), async (req, res) => {
  const { status, confirm } = frequencyStatusSchema.parse(req.body);

  res.json({ success: true, data: await setFrequencyStatus(requireAuth(req), parseIdParam(req.params.id), status, confirm === true) });
});

// Frequencies are never deleted: contracts and their visit history refer to them.
maintenanceFrequenciesRouter.delete("/:id", (_req, _res) => {
  throw new AppError(
    405,
    "METHOD_NOT_ALLOWED",
    "Maintenance frequencies cannot be deleted, because AMC contracts and their visit history refer to them. Disable or archive the frequency instead."
  );
});
