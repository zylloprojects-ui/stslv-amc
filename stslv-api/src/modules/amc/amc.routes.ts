import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize, authorizeOnAny } from "../../middleware/authorize";
import { requireSchema } from "../../middleware/require-schema";
import { forbidden } from "../../shared/errors";
import { sendExport } from "../../shared/export/send";
import { parseIdParam } from "../../shared/validation";
import {
  changeContractStatusSchema,
  contractHistorySchema,
  contractMastersSchema,
  createContractSchema,
  expiringContractsSchema,
  renewalHistorySchema,
  saveServiceStatusSchema,
  exportServiceStatusSchema,
  exportVisitsSchema,
  listContractsSchema,
  listServiceStatusSchema,
  listExecutionSchema,
  listVisitsSchema,
  schedulePreviewSchema,
  summarySchema,
  updateContractSchema,
  updateExecutionSchema,
  updateVisitSchema,
  visitYearSummarySchema,
  workloadSchema,
} from "./amc.schemas";
import {
  changeContractStatus,
  createContract,
  generateSchedule,
  getContract,
  listContractFilterOptions,
  listContractHistory,
  listContracts,
  listSystems,
  previewSchedule,
  updateContract,
} from "./contracts.service";
import { getContractMasters, setContractMasters } from "./contract-masters.service";
import { getAmcManagementSummary } from "./management.service";
import { buildMasterStatusExport } from "./master-status.export";
import { exportMasterStatusSchema, listMasterStatusSchema } from "./master-status.schemas";
import { getMasterStatusOptions, listMasterStatus } from "./master-status.service";
import { buildRenewalHistoryExport, buildRenewalQueueExport } from "./renewal.export";
import { exportRenewalHistorySchema, exportRenewalQueueSchema, listRenewalQueueSchema } from "./renewal-queue.schemas";
import { listRenewalQueue } from "./renewal-queue.service";
import { getContractRenewals, listRenewalHistory } from "./renewals.service";
import { getWorkload, listExpiringContracts } from "./reports.service";
import { buildScheduleExport } from "./schedule.export";
import { buildServiceStatusExport } from "./service-status.export";
import { getServiceStatusOptions, listServiceStatus, saveServiceStatus } from "./service-status.service";
import { canViewSummary, getAmcSummary } from "./summary.service";
import {
  getExecutionVisit,
  getScheduleVisit,
  getVisitYearSummary,
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

// --- AMC Management (read-only) ---------------------------------------------
// The AMC Management page: contract, schedule, invoice and expiry figures in one
// request. Contract view is required; schedule and invoice sections are filled
// only for users holding those view permissions.
amcRouter.get("/management/summary", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getAmcManagementSummary(requireAuth(req)) });
});

// --- Reports (read-only) ------------------------------------------------------
// Declared before "/contracts/:id" style routes; each needs the module whose data it shows.
amcRouter.get("/reports/expiring", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listExpiringContracts(expiringContractsSchema.parse(req.query)) });
});

// Renewals (migration 0072).
const renewalsReady = requireSchema(["amc_contracts.renewed_from_id"]);

amcRouter.get("/reports/renewals", authorize("AMC_RENEWAL", "VIEW"), renewalsReady, async (req, res) => {
  res.json({ success: true, data: await listRenewalHistory(renewalHistorySchema.parse(req.query)) });
});

// Every renewal made, as an Excel workbook or a PDF.
amcRouter.get("/reports/renewals/export", authorize("AMC_RENEWAL", "VIEW"), authorize("AMC_RENEWAL", "EXPORT"), renewalsReady, async (req, res) => {
  const query = exportRenewalHistorySchema.parse(req.query);
  const { report, recordExport } = await buildRenewalHistoryExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// --- AMC Renewal queue (read-only) ---------------------------------------------
// Contracts due for renewal within the warning window, and those with a renewal,
// with their derived renewal state. Renewing, approving and cancelling use the
// contract routes below (POST /contracts/:id/renewals, POST /contracts/:id/status),
// so their permissions and checks are the same wherever they are started. The AMC
// Renewal page and its renewal history are governed by AMC_RENEWAL (migration 0080).
const renewalQueueReady = requireSchema(["amc_contracts.renewed_from_id", "system_types", "maintenance_frequencies"]);

amcRouter.get("/renewals/queue", authorize("AMC_RENEWAL", "VIEW"), renewalQueueReady, async (req, res) => {
  res.json({ success: true, data: await listRenewalQueue(listRenewalQueueSchema.parse(req.query)) });
});

// Every row that matches the queue's filters, across all pages, with the page's visible columns.
amcRouter.get("/renewals/queue/export", authorize("AMC_RENEWAL", "VIEW"), authorize("AMC_RENEWAL", "EXPORT"), renewalQueueReady, async (req, res) => {
  const query = exportRenewalQueueSchema.parse(req.query);
  const { report, recordExport } = await buildRenewalQueueExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

amcRouter.get("/reports/workload", authorize("AMC_SCHEDULE", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getWorkload(workloadSchema.parse(req.query)) });
});

// --- Contracts ---------------------------------------------------------------
amcRouter.get("/contracts", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listContracts(listContractsSchema.parse(req.query)) });
});

amcRouter.get("/contracts/systems", authorize("AMC_CONTRACTS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await listSystems() });
});

// The values present on contracts, for the register's filters. Declared before "/contracts/:id".
amcRouter.get("/contracts/filter-options", authorize("AMC_CONTRACTS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await listContractFilterOptions() });
});

amcRouter.get("/contracts/:id", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getContract(parseIdParam(req.params.id)) });
});

// The contract's optional links to master records (migration 0070).
const mastersReady = requireSchema(["sales_engineers", "system_types"]);

amcRouter.get("/contracts/:id/masters", authorize("AMC_CONTRACTS", "VIEW"), mastersReady, async (req, res) => {
  res.json({ success: true, data: await getContractMasters(parseIdParam(req.params.id)) });
});

amcRouter.put("/contracts/:id/masters", authorize("AMC_CONTRACTS", "EDIT"), mastersReady, async (req, res) => {
  const links = contractMastersSchema.parse(req.body);

  res.json({ success: true, data: await setContractMasters(requireAuth(req), parseIdParam(req.params.id), links) });
});

amcRouter.get("/contracts/:id/renewals", authorize("AMC_CONTRACTS", "VIEW"), renewalsReady, async (req, res) => {
  res.json({ success: true, data: await getContractRenewals(parseIdParam(req.params.id)) });
});

// A renewal is a new contract (same fields and checks as adding one), linked to this contract, which stays unchanged.
// Renewing is an AMC Renewal action (AMC_RENEWAL:CREATE), from the AMC Renewal page or the contract page.
amcRouter.post("/contracts/:id/renewals", authorize("AMC_RENEWAL", "CREATE"), renewalsReady, async (req, res) => {
  const renewal = await createContract(requireAuth(req), createContractSchema.parse(req.body), { renewedFromId: parseIdParam(req.params.id) });

  res.status(201).json({ success: true, data: renewal });
});

// Read-only: the activity recorded against one contract (the contract page's history).
amcRouter.get("/contracts/:id/history", authorize("AMC_CONTRACTS", "VIEW"), async (req, res) => {
  res.json({
    success: true,
    data: await listContractHistory(parseIdParam(req.params.id), contractHistorySchema.parse(req.query)),
  });
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
// The visit list and its export serve both the AMC Schedule and the Monthly Calendar,
// so either page's permission opens them (migration 0080).
const SCHEDULE_PAGES: Parameters<typeof authorizeOnAny>[0] = ["AMC_SCHEDULE", "MONTHLY_CALENDAR"];

amcRouter.get("/visits", authorizeOnAny(SCHEDULE_PAGES, "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listVisits(listVisitsSchema.parse(req.query)) });
});

// The schedule as an Excel workbook or a PDF, with the list's own filters. Exporting needs
// the EXPORT permission on top of VIEW. Declared before /visits/:id, which would otherwise take it.
amcRouter.get("/visits/export", authorizeOnAny(SCHEDULE_PAGES, "VIEW", "EXPORT"), async (req, res) => {
  const query = exportVisitsSchema.parse(req.query);

  const { report, recordExport } = await buildScheduleExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

// The Monthly Calendar's year: counts and amounts per month, with the schedule's filters. Read-only.
amcRouter.get("/visits/year-summary", authorizeOnAny(SCHEDULE_PAGES, "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getVisitYearSummary(visitYearSummarySchema.parse(req.query)) });
});

amcRouter.get("/visits/:id", authorizeOnAny(SCHEDULE_PAGES, "VIEW"), async (req, res) => {
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

// --- Service Status ------------------------------------------------------------
// One row per scheduled visit, read from the same records as the schedule.
// Viewing needs SERVICE_STATUS:VIEW (migration 0080); saving changes the visit's
// execution, so it needs AMC_EXECUTION:EDIT, and reopening completed work also
// needs AMC_EXECUTION:APPROVE (checked by the execution rules).
amcRouter.get("/service-status", authorize("SERVICE_STATUS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listServiceStatus(listServiceStatusSchema.parse(req.query)) });
});

// The filter lists (sales engineers, frequencies, years on visits), shared with the Monthly Calendar.
amcRouter.get("/service-status/options", authorizeOnAny(["SERVICE_STATUS", "MONTHLY_CALENDAR", "AMC_SCHEDULE"], "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await getServiceStatusOptions() });
});

// Every row that matches the page's filters, across all pages.
amcRouter.get("/service-status/export", authorize("SERVICE_STATUS", "VIEW"), authorize("SERVICE_STATUS", "EXPORT"), async (req, res) => {
  const query = exportServiceStatusSchema.parse(req.query);
  const { report, recordExport } = await buildServiceStatusExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

amcRouter.patch("/service-status/:id", authorize("AMC_EXECUTION", "EDIT"), async (req, res) => {
  const item = await saveServiceStatus(requireAuth(req), parseIdParam(req.params.id), saveServiceStatusSchema.parse(req.body));

  res.json({ success: true, data: item });
});

// --- Master AMC Status ---------------------------------------------------------
// Read only: one row per scheduled visit with its invoice and quotation numbers.
// It shows invoice numbers (Invoice Tracking) and quotation numbers (Services
// Sales), so viewing needs VIEW on AMC_SCHEDULE, INVOICES and SERVICES_SALES:
// no role sees through this page what its own grants hide. Needs migration 0078.
const masterStatusReady = requireSchema(["amc_visits.quotation_no"]);
const masterStatusView = [authorize("AMC_SCHEDULE", "VIEW"), authorize("INVOICES", "VIEW"), authorize("SERVICES_SALES", "VIEW"), masterStatusReady];

amcRouter.get("/master-status", ...masterStatusView, async (req, res) => {
  res.json({ success: true, data: await listMasterStatus(listMasterStatusSchema.parse(req.query)) });
});

amcRouter.get("/master-status/options", ...masterStatusView, async (_req, res) => {
  res.json({ success: true, data: await getMasterStatusOptions() });
});

// Every row that matches the page's filters, across all pages, with the page's visible columns.
amcRouter.get("/master-status/export", ...masterStatusView, authorize("AMC_SCHEDULE", "EXPORT"), async (req, res) => {
  const query = exportMasterStatusSchema.parse(req.query);
  const { report, recordExport } = await buildMasterStatusExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});
