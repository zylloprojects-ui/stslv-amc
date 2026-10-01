import { Router } from "express";
import { pool } from "../../config/database";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";

export const dashboardRouter = Router();

dashboardRouter.use(authenticate);

// Only metrics backed by implemented modules are returned. AMC, project and
// invoice metrics are added here when those modules exist; nothing is estimated.
dashboardRouter.get("/summary", authorize("DASHBOARD", "VIEW"), async (_req, res) => {
  const result = await pool.query<{ active: number; inactive: number }>(
    `SELECT count(*) FILTER (WHERE is_active)::int AS active,
            count(*) FILTER (WHERE NOT is_active)::int AS inactive
     FROM clients`
  );

  res.json({
    success: true,
    data: { clients: { active: result.rows[0]?.active ?? 0, inactive: result.rows[0]?.inactive ?? 0 } },
  });
});
