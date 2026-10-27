import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { parseIdParam } from "../../shared/validation";
import { z } from "zod";
import { pagingSchema } from "../../shared/money";
import { createClientSchema, listClientsSchema, updateClientSchema } from "./clients.schemas";
import { clientFeatures, createClient, getClient, listClientHistory, listClients, setClientActive, updateClient } from "./clients.service";

export const clientsRouter = Router();

clientsRouter.use(authenticate);

clientsRouter.get("/", authorize("CLIENTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listClients(listClientsSchema.parse(req.query)) });
});

// What the client pages can offer on this database (fields that need migration 0074). Declared before "/:id".
clientsRouter.get("/features", authorize("CLIENTS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await clientFeatures() });
});

const historySchema = z.object(pagingSchema);

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
