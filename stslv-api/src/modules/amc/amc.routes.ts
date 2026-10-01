import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { forbidden } from "../../shared/errors";
import { parseIdParam } from "../../shared/validation";
import {
  changeContractStatusSchema,
  createContractSchema,
  listContractsSchema,
  listExecutionSchema,
  listVisitsSchema,
  schedulePreviewSchema,
  summarySchema,
  updateContractSchema,
  updateExecutionSchema,
  updateVisitSchema,
} from "./amc.schemas";
import {
  changeContractStatus,
  createContract,
  generateSchedule,
  getContract,
  listContracts,
  listSystems,
  previewSchedule,
  updateContract,
} from "./contracts.service";
import { canViewSummary, getAmcSummary } from "./summary.service";
import {
  getExecutionVisit,
  getScheduleVisit,
  listExecutionVisits,
  listVisits,
  updateExecution,
  updateVisit,
} from "./visits.service";

// Mounted at /api/amc.
export const amcRouter = Router();

amcRouter.use(authenticate);

// --- Summary (dashboard and reports) ----------------------------------------
// Open to anyone holding at least one AMC view permission; each section of the
// answer is filled only when the user may see it.
amcRouter.get("/summary", async (req, res) => {
  const auth = requireAuth(req);

  if (!canViewSummary(auth)) {
    throw forbidden();
  }

  res.json({ success: true, data: await getAmcSummary(auth, summarySchema.parse(req.query).upcomingDays) });
});

// --- Contracts ---------------------------------------------------------------
amcRouter.get("/contracts", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listContracts(listContractsSchema.parse(req.query)) });
});

amcRouter.get("/contracts/systems", authorize("AMC_CONTRACTS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await listSystems() });
});

amcRouter.get("/contracts/:id", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getContract(parseIdParam(req.params.id)) });
});

amcRouter.post("/contracts", authorize("AMC_CONTRACTS", "CREATE"), async (req, res) => {
  const contract = await createContract(requireAuth(req), createContractSchema.parse(req.body));

  res.status(201).json({ success: true, data: contract });
});

amcRouter.patch("/contracts/:id", authorize("AMC_CONTRACTS", "EDIT"), async (req, res) => {
  const contract = await updateContract(requireAuth(req), parseIdParam(req.params.id), updateContractSchema.parse(req.body));

  res.json({ success: true, data: contract });
});

// Cancelling additionally needs AMC_CONTRACTS:DELETE (checked in the service).
amcRouter.post("/contracts/:id/status", authorize("AMC_CONTRACTS", "EDIT"), async (req, res) => {
  const contract = await changeContractStatus(
    requireAuth(req),
    parseIdParam(req.params.id),
    changeContractStatusSchema.parse(req.body)
  );

  res.json({ success: true, data: contract });
});

// Read-only: what generating the schedule would add, remove and keep.
amcRouter.get("/contracts/:id/schedule/preview", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({
    success: true,
    data: await previewSchedule(parseIdParam(req.params.id), schedulePreviewSchema.parse(req.query)),
  });
});

amcRouter.post("/contracts/:id/schedule/generate", authorize("AMC_CONTRACTS", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await generateSchedule(requireAuth(req), parseIdParam(req.params.id)) });
});

// --- Schedule ----------------------------------------------------------------
amcRouter.get("/visits", authorize("AMC_SCHEDULE", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listVisits(listVisitsSchema.parse(req.query)) });
});

amcRouter.get("/visits/:id", authorize("AMC_SCHEDULE", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getScheduleVisit(parseIdParam(req.params.id)) });
});

amcRouter.patch("/visits/:id", authorize("AMC_SCHEDULE", "EDIT"), async (req, res) => {
  const visit = await updateVisit(requireAuth(req), parseIdParam(req.params.id), updateVisitSchema.parse(req.body));

  res.json({ success: true, data: visit });
});

// --- Execution ---------------------------------------------------------------
// The same visit records, without amounts or invoicing state.
amcRouter.get("/execution/visits", authorize("AMC_EXECUTION", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listExecutionVisits(listExecutionSchema.parse(req.query)) });
});

amcRouter.get("/execution/visits/:id", authorize("AMC_EXECUTION", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getExecutionVisit(parseIdParam(req.params.id)) });
});

// Reopening a completed visit additionally needs AMC_EXECUTION:APPROVE (checked in the service).
amcRouter.patch("/execution/visits/:id", authorize("AMC_EXECUTION", "EDIT"), async (req, res) => {
  const visit = await updateExecution(requireAuth(req), parseIdParam(req.params.id), updateExecutionSchema.parse(req.body));

  res.json({ success: true, data: visit });
});
