import { Router, type RequestHandler } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { forbidden } from "../../shared/errors";
import { parseIdParam } from "../../shared/validation";
import { createUserSchema, resetPasswordSchema, setUserRolesSchema, updateUserSchema } from "./users.schemas";
import {
  createUser,
  listUsers,
  rejectRegistration,
  resetUserPassword,
  setUserActive,
  setUserRoles,
  updateUser,
} from "./users.service";

export const usersRouter = Router();

usersRouter.use(authenticate);

const canEditOrApprove: RequestHandler = (req, _res, next) => {
  const { permissions } = requireAuth(req);

  if (!permissions.has("USERS:EDIT") && !permissions.has("USERS:APPROVE")) {
    throw forbidden();
  }

  next();
};

usersRouter.get("/", authorize("USERS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: await listUsers() });
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

usersRouter.post("/:id/reset-password", authorize("USERS", "EDIT"), async (req, res) => {
  const { password } = resetPasswordSchema.parse(req.body);

  await resetUserPassword(requireAuth(req), parseIdParam(req.params.id), password);
  res.json({ success: true, data: null });
});
