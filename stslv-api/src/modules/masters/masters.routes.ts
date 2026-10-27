import { Router, type RequestHandler } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { forbidden } from "../../shared/errors";
import { parseIdParam } from "../../shared/validation";
import { departmentSchemas, listMastersSchema, masterHistorySchema, masterStatusSchema, salesEngineerSchemas, systemTypeSchemas } from "./masters.schemas";
import {
  createMaster,
  DEPARTMENTS,
  getMaster,
  listMasterHistory,
  listMasters,
  masterOptions,
  SALES_ENGINEERS,
  setMasterStatus,
  SYSTEM_TYPES,
  updateMaster,
  type MasterSpec,
} from "./masters.service";

// Mounted at /api/masters. The lists are managed under Settings; a user who
// may view AMC contracts may also read them, to pick from on a contract.
export const mastersRouter = Router();

mastersRouter.use(authenticate);
// The tables come from migration 0070.
mastersRouter.use(requireSchema(["departments", "sales_engineers", "system_types"]));

const canRead: RequestHandler = (req, _res, next) => {
  const { permissions } = requireAuth(req);

  if (!permissions.has("SETTINGS:VIEW") && !permissions.has("AMC_CONTRACTS:VIEW")) {
    throw forbidden();
  }

  next();
};

function mount(path: string, spec: MasterSpec, schemas: { create: { parse: (value: unknown) => unknown }; update: { parse: (value: unknown) => unknown } }) {
  mastersRouter.get(`/${path}`, canRead, async (req, res) => {
    res.json({ success: true, data: await listMasters(spec, listMastersSchema.parse(req.query)) });
  });

  // Declared before "/:id": active records only, for pickers.
  mastersRouter.get(`/${path}/options`, canRead, async (_req, res) => {
    res.json({ success: true, data: await masterOptions(spec) });
  });

  mastersRouter.get(`/${path}/:id/history`, canRead, async (req, res) => {
    const { page, pageSize } = masterHistorySchema.parse(req.query);

    res.json({ success: true, data: await listMasterHistory(spec, parseIdParam(req.params.id), page, pageSize) });
  });

  mastersRouter.get(`/${path}/:id`, canRead, async (req, res) => {
    res.json({ success: true, data: await getMaster(spec, parseIdParam(req.params.id)) });
  });

  mastersRouter.post(`/${path}`, authorize("SETTINGS", "CREATE"), async (req, res) => {
    const created = await createMaster(requireAuth(req), spec, schemas.create.parse(req.body) as Record<string, unknown>);

    res.status(201).json({ success: true, data: created });
  });

  mastersRouter.patch(`/${path}/:id`, authorize("SETTINGS", "EDIT"), async (req, res) => {
    const updated = await updateMaster(requireAuth(req), spec, parseIdParam(req.params.id), schemas.update.parse(req.body) as Record<string, unknown>);

    res.json({ success: true, data: updated });
  });

  mastersRouter.post(`/${path}/:id/status`, authorize("SETTINGS", "EDIT"), async (req, res) => {
    const { isActive } = masterStatusSchema.parse(req.body);

    res.json({ success: true, data: await setMasterStatus(requireAuth(req), spec, parseIdParam(req.params.id), isActive) });
  });
}

mount("departments", DEPARTMENTS, departmentSchemas);
mount("sales-engineers", SALES_ENGINEERS, salesEngineerSchemas);
mount("system-types", SYSTEM_TYPES, systemTypeSchemas);
