import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { sendExport } from "../../shared/export/send";
import { exportDepartmentsSchema, listDepartmentsSchema } from "./departments.schemas";
import { buildDepartmentsExport, listDepartments } from "./departments.service";
import { canReadMaster } from "./master-permissions";

// Mounted at /api/masters/departments, ahead of the master-list routes, which
// still serve options, one record, history, create, edit and status. There is
// no delete: a department is disabled instead, and its engineers keep it.
// Middleware is attached per route, so a request this router does not answer
// passes straight on without being authenticated twice.
export const departmentsRouter = Router();

// Migration 0070: the table, and sales_engineers for the linked counts.
const ready = requireSchema(["departments", "sales_engineers"]);

// The same read rule as the other department routes (master-permissions.ts).
const canRead = canReadMaster("departments");

// Declared before any "/:id" route. Exports the list with the page's filters and order.
departmentsRouter.get("/export", authenticate, ready, authorize("DEPARTMENTS", "VIEW"), authorize("DEPARTMENTS", "EXPORT"), async (req, res) => {
  const query = exportDepartmentsSchema.parse(req.query);
  const { report, recordExport } = await buildDepartmentsExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// The list: searches the description too, and orders by name, then code.
departmentsRouter.get("/", authenticate, ready, canRead, async (req, res) => {
  res.json({ success: true, data: await listDepartments(listDepartmentsSchema.parse(req.query)) });
});
