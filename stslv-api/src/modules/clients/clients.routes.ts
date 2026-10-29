import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize, authorizeRead } from "../../middleware/authorize";
import { parseIdParam } from "../../shared/validation";
import { z } from "zod";
import { pagingSchema } from "../../shared/money";
import { sendExport } from "../../shared/export/send";
import { getClientSummary } from "./client-summary.service";
import { buildClientContractsExport, buildClientsExport } from "./clients.export";
import { createClientSchema, exportClientContractsSchema, exportClientsSchema, listClientsSchema, updateClientSchema } from "./clients.schemas";
import { clientFeatures, createClient, getClient, listClientHistory, listClients, setClientActive, updateClient } from "./clients.service";

export const clientsRouter = Router();

clientsRouter.use(authenticate);

// The list also feeds the client pickers and filters of AMC pages, so data-only CLIENTS:READ is
// enough here. Everything else about a client (details, Client 360, history, export) needs View.
clientsRouter.get("/", authorizeRead("CLIENTS"), async (req, res) => {
  res.json({ success: true, data: await listClients(listClientsSchema.parse(req.query)) });
});

// What the client pages can offer on this database (fields that need migration 0074). Declared before "/:id".
clientsRouter.get("/features", authorize("CLIENTS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await clientFeatures() });
});

// The list as Excel or PDF, with the list's own filters. Needs EXPORT on top of VIEW. Declared before "/:id".
clientsRouter.get("/export", authorize("CLIENTS", "VIEW"), authorize("CLIENTS", "EXPORT"), async (req, res) => {
  const query = exportClientsSchema.parse(req.query);
  const { report, recordExport } = await buildClientsExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

const historySchema = z.object(pagingSchema);

// Client 360 figures. Each section is included only when the role can see that module (checked in the service).
clientsRouter.get("/:id/summary", authorize("CLIENTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getClientSummary(requireAuth(req), parseIdParam(req.params.id)) });
});

// One client's AMC contracts as a report: contract data, so the AMC contract permissions apply as well.
clientsRouter.get(
  "/:id/contracts/export",
  authorize("CLIENTS", "VIEW"),
  authorize("AMC_CONTRACTS", "VIEW"),
  authorize("AMC_CONTRACTS", "EXPORT"),
  async (req, res) => {
    const query = exportClientContractsSchema.parse(req.query);
    const { report, recordExport } = await buildClientContractsExport(requireAuth(req), parseIdParam(req.params.id), query);

    await sendExport(res, report, query.format, recordExport);
  }
);

clientsRouter.get("/:id/history", authorize("CLIENTS", "VIEW"), async (req, res) => {
  const { page, pageSize } = historySchema.parse(req.query);

  res.json({ success: true, data: await listClientHistory(parseIdParam(req.params.id), page, pageSize) });
});

clientsRouter.get("/:id", authorize("CLIENTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getClient(parseIdParam(req.params.id)) });
});

clientsRouter.post("/", authorize("CLIENTS", "CREATE"), async (req, res) => {
  const client = await createClient(requireAuth(req), createClientSchema.parse(req.body));

  res.status(201).json({ success: true, data: client });
});

clientsRouter.patch("/:id", authorize("CLIENTS", "EDIT"), async (req, res) => {
  const client = await updateClient(requireAuth(req), parseIdParam(req.params.id), updateClientSchema.parse(req.body));

  res.json({ success: true, data: client });
});

// Clients are never hard-deleted, so the DELETE permission governs deactivation.
clientsRouter.post("/:id/deactivate", authorize("CLIENTS", "DELETE"), async (req, res) => {
  res.json({ success: true, data: await setClientActive(requireAuth(req), parseIdParam(req.params.id), false) });
});

clientsRouter.post("/:id/reactivate", authorize("CLIENTS", "DELETE"), async (req, res) => {
  res.json({ success: true, data: await setClientActive(requireAuth(req), parseIdParam(req.params.id), true) });
});
