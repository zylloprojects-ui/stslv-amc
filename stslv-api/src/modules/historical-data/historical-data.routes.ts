import { Router, type RequestHandler } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { forbidden } from "../../shared/errors";
import { ADMIN_ROLE_CODE } from "../../shared/permissions";
import { parseIdParam } from "../../shared/validation";
import { listRowsSchema } from "./historical-data.schemas";
import { getImportAudit, getReviewRow, getReviewTotals, listReviewRows } from "./historical-data.service";

// Read-only. There is deliberately no POST, PATCH or DELETE route here: the
// staged source records are written by the controlled import only.
export const historicalDataRouter = Router();

historicalDataRouter.use(authenticate);

// The Import Audit is for the built-in Admin role only, whoever else is granted the module.
const adminOnly: RequestHandler = (req, _res, next) => {
  if (!requireAuth(req).roles.some((role) => role.code === ADMIN_ROLE_CODE)) {
    throw forbidden();
  }

  next();
};

historicalDataRouter.get("/summary", authorize("HISTORICAL_DATA", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await getReviewTotals() });
});

historicalDataRouter.get("/audit", authorize("HISTORICAL_DATA", "VIEW"), adminOnly, async (_req, res) => {
  res.json({ success: true, data: await getImportAudit() });
});

historicalDataRouter.get("/rows", authorize("HISTORICAL_DATA", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listReviewRows(listRowsSchema.parse(req.query)) });
});

historicalDataRouter.get("/rows/:id", authorize("HISTORICAL_DATA", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getReviewRow(parseIdParam(req.params.id)) });
});
