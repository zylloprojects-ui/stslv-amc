import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { parseIdParam } from "../../shared/validation";
import { listRowsSchema } from "./historical-data.schemas";
import { getReviewRow, getReviewSummary, listReviewRows } from "./historical-data.service";

// Read-only. There is deliberately no POST, PATCH or DELETE route here: the
// staged source records are written by the controlled import only.
export const historicalDataRouter = Router();

historicalDataRouter.use(authenticate);

historicalDataRouter.get("/summary", authorize("HISTORICAL_DATA", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await getReviewSummary() });
});

historicalDataRouter.get("/rows", authorize("HISTORICAL_DATA", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listReviewRows(listRowsSchema.parse(req.query)) });
});

historicalDataRouter.get("/rows/:id", authorize("HISTORICAL_DATA", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getReviewRow(parseIdParam(req.params.id)) });
});
