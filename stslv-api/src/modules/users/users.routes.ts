import { Router, type RequestHandler } from "express";
import { env } from "../../config/env";
import { adminOnly } from "../../middleware/admin-only";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { rateLimit } from "../../middleware/rate-limit";
import { forbidden } from "../../shared/errors";
import { parseIdParam } from "../../shared/validation";
import { sendExport } from "../../shared/export/send";
import { buildUsersExport } from "./users.export";
import { createUserSchema, exportUsersSchema, issueTemporaryPasswordSchema, listUsersSchema, setUserRolesSchema, updateUserSchema } from "./users.schemas";
import {
  createUser,
  issueTemporaryPassword,
  listUsers,
  listUsersPage,
  rejectRegistration,
  setUserActive,
  setUserRoles,
  updateUser,
} from "./users.service";

// Temporary passwords one administrator may issue per 15 minutes, whatever the network address.
const temporaryPasswordLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => env.temporaryPasswordRateLimit,
  key: (req) => `user:${req.auth?.user.id ?? "unknown"}`,
});

export const usersRouter = Router();

usersRouter.use(authenticate);

const canEditOrApprove: RequestHandler = (req, _res, next) => {
  const { permissions } = requireAuth(req);

  if (!permissions.has("USERS:EDIT") && !permissions.has("USERS:APPROVE")) {
    throw forbidden();
  }

  next();
};

// Without a filter or paging parameter: the whole list, as an array, for the pages that show or count every user.
// With one: { items, total, pendingTotal, page, pageSize }.
usersRouter.get("/", authorize("USERS", "VIEW"), async (req, res) => {
  const paged = ["page", "pageSize", "search", "status"].some((key) => key in req.query);

  res.json({ success: true, data: paged ? await listUsersPage(listUsersSchema.parse(req.query)) : await listUsers() });
});

// USERS has no Export action, and adding one would change what roles can be granted: administrators only.
usersRouter.get("/export", authorize("USERS", "VIEW"), adminOnly, async (req, res) => {
  const query = exportUsersSchema.parse(req.query);
  const { report, recordExport } = await buildUsersExport(requireAuth(req), query);

  await sendExport(res, report, query.format, recordExport);
});

usersRouter.post("/", authorize("USERS", "CREATE"), async (req, res) => {
  const user = await createUser(requireAuth(req), createUserSchema.parse(req.body));

  res.status(201).json({ success: true, data: user });
});

usersRouter.patch("/:id", authorize("USERS", "EDIT"), async (req, res) => {
  const { fullName } = updateUserSchema.parse(req.body);

  res.json({ success: true, data: await updateUser(requireAuth(req), parseIdParam(req.params.id), fullName) });
});

// Activating a pending sign-up request is its approval, which needs USERS:APPROVE instead
// of USERS:EDIT (checked in the service, which knows the account's state).
usersRouter.post("/:id/activate", canEditOrApprove, async (req, res) => {
  res.json({ success: true, data: await setUserActive(requireAuth(req), parseIdParam(req.params.id), true) });
});

usersRouter.post("/:id/deactivate", authorize("USERS", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await setUserActive(requireAuth(req), parseIdParam(req.params.id), false) });
});

// Refuses a pending sign-up request. Approval is the activate route above. Both need USERS:APPROVE.
usersRouter.post("/:id/reject", authorize("USERS", "APPROVE"), async (req, res) => {
  res.json({ success: true, data: await rejectRegistration(requireAuth(req), parseIdParam(req.params.id)) });
});

usersRouter.put("/:id/roles", authorize("USERS", "EDIT"), async (req, res) => {
  const { roleIds } = setUserRolesSchema.parse(req.body);

  res.json({ success: true, data: await setUserRoles(requireAuth(req), parseIdParam(req.params.id), roleIds) });
});

// Admin only (checked in the service, on top of USERS:EDIT). The password is in this
// response and nowhere else, so the response must not be cached.
usersRouter.post("/:id/temporary-password", authorize("USERS", "EDIT"), temporaryPasswordLimit, async (req, res) => {
  issueTemporaryPasswordSchema.parse(req.body);

  const issued = await issueTemporaryPassword(requireAuth(req), parseIdParam(req.params.id));

  res.set("Cache-Control", "no-store");
  res.json({ success: true, data: issued });
});
