import { Router } from "express";
import { adminOnly } from "../../middleware/admin-only";
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
// Every signed-in user may submit, see their own suggestions, comment on them
// and reopen them when resolved (ownership is checked in the service). Review
// (the list of all suggestions, status changes, assignment) is for reviewers:
// the built-in Admin role until a SUGGESTIONS permission module is approved.
export const suggestionsRouter = Router();

suggestionsRouter.use(authenticate);
suggestionsRouter.use(requireSchema(["suggestions", "suggestion_events"]));

suggestionsRouter.post("/", async (req, res) => {
  const { created, suggestion } = await createSuggestion(requireAuth(req), createSuggestionSchema.parse(req.body));

  res.status(created ? 201 : 200).json({ success: true, data: suggestion });
});

suggestionsRouter.get("/mine", async (req, res) => {
  res.json({ success: true, data: await listMine(requireAuth(req), listMineSchema.parse(req.query)) });
});

suggestionsRouter.get("/review", adminOnly, async (req, res) => {
  res.json({ success: true, data: await listForReview(listManageSchema.parse(req.query)) });
});

suggestionsRouter.get("/review/options", adminOnly, async (_req, res) => {
  res.json({ success: true, data: await getReviewOptions() });
});

// The submitter or a reviewer; anyone else is told it does not exist.
suggestionsRouter.get("/:id", async (req, res) => {
  res.json({ success: true, data: await getSuggestion(requireAuth(req), parseIdParam(req.params.id)) });
});

suggestionsRouter.post("/:id/comments", async (req, res) => {
  res.json({ success: true, data: await addComment(requireAuth(req), parseIdParam(req.params.id), commentSchema.parse(req.body)) });
});

suggestionsRouter.post("/:id/reopen", async (req, res) => {
  res.json({ success: true, data: await reopenOwn(requireAuth(req), parseIdParam(req.params.id), reopenSchema.parse(req.body)) });
});

suggestionsRouter.patch("/:id/status", adminOnly, async (req, res) => {
  res.json({ success: true, data: await changeStatus(requireAuth(req), parseIdParam(req.params.id), changeStatusSchema.parse(req.body)) });
});

suggestionsRouter.patch("/:id/assignment", adminOnly, async (req, res) => {
  res.json({ success: true, data: await assignSuggestion(requireAuth(req), parseIdParam(req.params.id), assignSchema.parse(req.body)) });
});
