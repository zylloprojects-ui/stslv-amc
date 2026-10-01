import { Router, type RequestHandler } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { forbidden } from "../../shared/errors";
import { parseIdParam } from "../../shared/validation";
import { changeProjectStatusSchema, createProjectSchema, listProjectsSchema, updateProjectSchema } from "./projects.schemas";
import {
  changeProjectStatus,
  createProject,
  getProject,
  getProjectDefaults,
  getProjectSummary,
  listProjectOptions,
  listProjects,
  updateProject,
} from "./projects.service";

export const projectsRouter = Router();

projectsRouter.use(authenticate);

// The project picker is needed on procurement and expense forms, so any of
// the three VIEW permissions is enough. It carries no financial information.
const canPickProject: RequestHandler = (req, _res, next) => {
  const { permissions } = requireAuth(req);

  if (!permissions.has("PROJECTS:VIEW") && !permissions.has("PROCUREMENT:VIEW") && !permissions.has("EXPENSES:VIEW")) {
    throw forbidden();
  }

  next();
};

projectsRouter.get("/", authorize("PROJECTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await listProjects(requireAuth(req), listProjectsSchema.parse(req.query)) });
});

// The fixed paths are declared before "/:id".
projectsRouter.get("/options", canPickProject, async (_req, res) => {
  res.json({ success: true, data: await listProjectOptions() });
});

projectsRouter.get("/defaults", authorize("PROJECTS", "CREATE"), async (_req, res) => {
  res.json({ success: true, data: await getProjectDefaults() });
});

// Dashboard and reporting contract.
projectsRouter.get("/summary", authorize("PROJECTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getProjectSummary(requireAuth(req)) });
});

projectsRouter.get("/:id", authorize("PROJECTS", "VIEW"), async (req, res) => {
  res.json({ success: true, data: await getProject(requireAuth(req), parseIdParam(req.params.id)) });
});

projectsRouter.post("/", authorize("PROJECTS", "CREATE"), async (req, res) => {
  const project = await createProject(requireAuth(req), createProjectSchema.parse(req.body));

  res.status(201).json({ success: true, data: project });
});

projectsRouter.patch("/:id", authorize("PROJECTS", "EDIT"), async (req, res) => {
  const project = await updateProject(requireAuth(req), parseIdParam(req.params.id), updateProjectSchema.parse(req.body));

  res.json({ success: true, data: project });
});

// Projects are never deleted; one that will not go ahead is cancelled.
projectsRouter.post("/:id/status", authorize("PROJECTS", "EDIT"), async (req, res) => {
  const project = await changeProjectStatus(
    requireAuth(req),
    parseIdParam(req.params.id),
    changeProjectStatusSchema.parse(req.body)
  );

  res.json({ success: true, data: project });
});
