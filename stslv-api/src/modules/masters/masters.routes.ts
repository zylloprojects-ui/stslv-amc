import { Router, type RequestHandler } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import type { AuthContext } from "../auth/access";
import { requireSchema } from "../../middleware/require-schema";
import { forbidden } from "../../shared/errors";
import { parseIdParam } from "../../shared/validation";
import { sendExport } from "../../shared/export/send";
import { buildSalesEngineersExport, engineerUserOptions, getEngineerSummary } from "./sales-engineers.service";
import {
  departmentSchemas,
  exportSalesEngineersSchema,
  userOptionsSchema,
  listMastersSchema,
  maintenanceFrequencySchemas,
  masterHistorySchema,
  masterStatusSchema,
  salesEngineerSchemas,
  systemTypeSchemas,
} from "./masters.schemas";
import {
  createMaster,
  DEPARTMENTS,
  getMaster,
  listMasterHistory,
  listMasters,
  MAINTENANCE_FREQUENCIES,
  masterOptions,
  masterSummary,
  SALES_ENGINEERS,
  setMasterStatus,
  SYSTEM_TYPES,
  updateMaster,
  type MasterCategory,
  type MasterSpec,
} from "./masters.service";

// Mounted at /api/masters. The lists are managed in the Master Data Center
// (SETTINGS permissions); a user who may view AMC contracts may also read them,
// to pick from on a contract.
export const mastersRouter = Router();

mastersRouter.use(authenticate);

const mayRead = (permissions: AuthContext["permissions"]) => permissions.has("SETTINGS:VIEW") || permissions.has("AMC_CONTRACTS:VIEW");

const canRead: RequestHandler = (req, _res, next) => {
  if (!mayRead(requireAuth(req).permissions)) {
    throw forbidden();
  }

  next();
};

// Master Data Center: active-record counts for the categories this user may read.
// Answers even before the master-data migrations, marking those categories unavailable.
mastersRouter.get("/summary", async (req, res) => {
  const { permissions } = requireAuth(req);
  const categories: MasterCategory[] = [];

  if (permissions.has("CLIENTS:VIEW")) categories.push("clients");
  if (mayRead(permissions)) categories.push("sales-engineers", "system-types", "maintenance-frequencies", "departments");
  if (categories.length === 0) throw forbidden();

  res.json({ success: true, data: { categories: await masterSummary(categories) } });
});

interface Schemas {
  /** Absent for a list whose records cannot be added. */
  create?: { parse: (value: unknown) => unknown };
  update: { parse: (value: unknown) => unknown };
}

/** Mounts one list. `tables` come from its migration: until it is applied, every route answers FEATURE_UNAVAILABLE. */
function mount(path: string, spec: MasterSpec, schemas: Schemas, tables: string[]) {
  const ready = requireSchema(tables);

  mastersRouter.use(`/${path}`, ready);

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

  const create = schemas.create;

  if (create) {
    mastersRouter.post(`/${path}`, authorize("SETTINGS", "CREATE"), async (req, res) => {
      const created = await createMaster(requireAuth(req), spec, create.parse(req.body) as Record<string, unknown>);

      res.status(201).json({ success: true, data: created });
    });
  }

  mastersRouter.patch(`/${path}/:id`, authorize("SETTINGS", "EDIT"), async (req, res) => {
    const updated = await updateMaster(requireAuth(req), spec, parseIdParam(req.params.id), schemas.update.parse(req.body) as Record<string, unknown>);

    res.json({ success: true, data: updated });
  });

  mastersRouter.post(`/${path}/:id/status`, authorize("SETTINGS", "EDIT"), async (req, res) => {
    const { isActive } = masterStatusSchema.parse(req.body);

    res.json({ success: true, data: await setMasterStatus(requireAuth(req), spec, parseIdParam(req.params.id), isActive) });
  });
}

// Migration 0070. Sales engineers and system types join departments, so all three need it.
const MASTER_DATA = ["departments", "sales_engineers", "system_types"];

// Sales engineer routes beyond the shared ones. Declared before mount(), so "/:id" does not take "export" or "user-options".
const engineersReady = requireSchema(MASTER_DATA);

// The list as Excel or PDF, with the list's own filters. Needs SETTINGS:EXPORT on top of read access.
mastersRouter.get("/sales-engineers/export", engineersReady, canRead, authorize("SETTINGS", "EXPORT"), async (req, res) => {
  const query = exportSalesEngineersSchema.parse(req.query);
  const { report, recordExport } = await buildSalesEngineersExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// The accounts the engineer form may link to. For whoever may add or edit engineers; no USERS permission is needed.
mastersRouter.get("/sales-engineers/user-options", engineersReady, async (req, res) => {
  const { permissions } = requireAuth(req);

  if (!permissions.has("SETTINGS:CREATE") && !permissions.has("SETTINGS:EDIT")) throw forbidden();

  res.json({ success: true, data: await engineerUserOptions(userOptionsSchema.parse(req.query).engineerId) });
});

// Engineer 360 figures. Each section is included only when the role can see that module (checked in the service).
mastersRouter.get("/sales-engineers/:id/summary", engineersReady, canRead, async (req, res) => {
  res.json({ success: true, data: await getEngineerSummary(requireAuth(req), parseIdParam(req.params.id)) });
});

mount("departments", DEPARTMENTS, departmentSchemas, MASTER_DATA);
mount("sales-engineers", SALES_ENGINEERS, salesEngineerSchemas, MASTER_DATA);
mount("system-types", SYSTEM_TYPES, systemTypeSchemas, MASTER_DATA);
// Migration 0075. The four frequencies are fixed: there is no create.
mount("maintenance-frequencies", MAINTENANCE_FREQUENCIES, maintenanceFrequencySchemas, ["maintenance_frequencies"]);
