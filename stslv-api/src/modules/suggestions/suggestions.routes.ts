import { Router } from "express";
import { authorize, authorizeOnAny } from "../../middleware/authorize";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { requireSchema } from "../../middleware/require-schema";
import { parseIdParam } from "../../shared/validation";
import {
  assignSchema,
  changeStatusSchema,
  commentSchema,
  createSuggestionSchema,
  listManageSchema,
  listMineSchema,
  reopenSchema,
} from "./suggestions.schemas";
import {
  addComment,
  assignSuggestion,
  changeStatus,
  createSuggestion,
  getReviewOptions,
  getSuggestion,
  listForReview,
  listMine,
  reopenOwn,
} from "./suggestions.service";

// Mounted at /api/suggestions. Needs migration 0085; without it every route
// answers 503 FEATURE_UNAVAILABLE.
//
// SUGGESTIONS: View shows one's own suggestions; Create submits, comments on one's own and
// reopens a resolved one (ownership is checked in the service). SUGGESTIONS_REVIEW: View shows
// all of them with internal notes; Edit responds, changes status and assigns.
export const suggestionsRouter = Router();

suggestionsRouter.use(authenticate);
suggestionsRouter.use(requireSchema(["suggestions", "suggestion_events"]));

suggestionsRouter.post("/", authorize("SUGGESTIONS", "CREATE"), async (req, res) => {
  const { created, suggestion } = await createSuggestion(requireAuth(req), createSuggestionSchema.parse(req.body));

  res.status(created ? 201 : 200).json({ success: true, data: suggestion });
});

suggestionsRouter.get("/mine", authorize("SUGGESTIONS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listMine(requireAuth(req), listMineSchema.parse(req.query)) });
});

suggestionsRouter.get("/review", authorize("SUGGESTIONS_REVIEW", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listForReview(listManageSchema.parse(req.query)) });
});

suggestionsRouter.get("/review/options", authorize("SUGGESTIONS_REVIEW", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await getReviewOptions() });
});

// The submitter or a reviewer; anyone else is told it does not exist.
suggestionsRouter.get("/:id", authorizeOnAny(["SUGGESTIONS", "SUGGESTIONS_REVIEW"], "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getSuggestion(requireAuth(req), parseIdParam(req.params.id)) });
});

suggestionsRouter.post("/:id/comments", authorizeOnAny(["SUGGESTIONS", "SUGGESTIONS_REVIEW"], "VIEW"), async (req, res) => {
  res.json({ success: true, data: await addComment(requireAuth(req), parseIdParam(req.params.id), commentSchema.parse(req.body)) });
});

suggestionsRouter.post("/:id/reopen", authorize("SUGGESTIONS", "CREATE"), async (req, res) => {
  res.json({ success: true, data: await reopenOwn(requireAuth(req), parseIdParam(req.params.id), reopenSchema.parse(req.body)) });
});

suggestionsRouter.patch("/:id/status", authorize("SUGGESTIONS_REVIEW", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await changeStatus(requireAuth(req), parseIdParam(req.params.id), changeStatusSchema.parse(req.body)) });
});

suggestionsRouter.patch("/:id/assignment", authorize("SUGGESTIONS_REVIEW", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await assignSuggestion(requireAuth(req), parseIdParam(req.params.id), assignSchema.parse(req.body)) });
});
