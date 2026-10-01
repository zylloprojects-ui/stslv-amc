import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { parseIdParam } from "../../shared/validation";
import { createClientSchema, listClientsSchema, updateClientSchema } from "./clients.schemas";
import { createClient, getClient, listClients, setClientActive, updateClient } from "./clients.service";

export const clientsRouter = Router();

clientsRouter.use(authenticate);

clientsRouter.get("/", authorize("CLIENTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listClients(listClientsSchema.parse(req.query)) });
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
