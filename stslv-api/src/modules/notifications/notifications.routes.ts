import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { requireSchema } from "../../middleware/require-schema";
import { listAlerts, markAlertRead, markAllAlertsRead } from "./notifications.service";

// Mounted at /api/notifications. Every signed-in user has alerts, filtered to
// what their permissions allow; there is no separate permission. The read
// state comes from migration 0073.
export const notificationsRouter = Router();

notificationsRouter.use(authenticate);
notificationsRouter.use(requireSchema(["notification_reads"]));

const alertKey = z.string().regex(/^[a-z_.]{1,60}$/, "Unknown alert.");

notificationsRouter.get("/", async (req, res) => {
  res.json({ success: true, data: await listAlerts(requireAuth(req)) });
});

notificationsRouter.post("/read-all", async (req, res) => {
  res.json({ success: true, data: await markAllAlertsRead(requireAuth(req)) });
});

notificationsRouter.post("/:key/read", async (req, res) => {
  res.json({ success: true, data: await markAlertRead(requireAuth(req), alertKey.parse(req.params.key)) });
});
