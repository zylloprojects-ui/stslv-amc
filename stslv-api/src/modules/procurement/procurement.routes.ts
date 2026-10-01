import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { parseIdParam } from "../../shared/validation";
import {
  changeProcurementStatusSchema,
  createProcurementSchema,
  listProcurementSchema,
  updateProcurementSchema,
} from "./procurement.schemas";
import {
  changeProcurementStatus,
  createProcurement,
  getProcurement,
  listProcurement,
  updateProcurement,
} from "./procurement.service";

export const procurementRouter = Router();

procurementRouter.use(authenticate);

procurementRouter.get("/", authorize("PROCUREMENT", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listProcurement(listProcurementSchema.parse(req.query)) });
});

procurementRouter.get("/:id", authorize("PROCUREMENT", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getProcurement(parseIdParam(req.params.id)) });
});

procurementRouter.post("/", authorize("PROCUREMENT", "CREATE"), async (req, res) => {
  const request = await createProcurement(requireAuth(req), createProcurementSchema.parse(req.body));

  res.status(201).json({ success: true, data: request });
});

procurementRouter.patch("/:id", authorize("PROCUREMENT", "EDIT"), async (req, res) => {
  const request = await updateProcurement(requireAuth(req), parseIdParam(req.params.id), updateProcurementSchema.parse(req.body));

  res.json({ success: true, data: request });
});

// Procurement requests are never deleted; one that is no longer needed is cancelled.
procurementRouter.post("/:id/status", authorize("PROCUREMENT", "EDIT"), async (req, res) => {
  const request = await changeProcurementStatus(
    requireAuth(req),
    parseIdParam(req.params.id),
    changeProcurementStatusSchema.parse(req.body)
  );

  res.json({ success: true, data: request });
});
