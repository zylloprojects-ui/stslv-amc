import { Router } from "express";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { parseIdParam } from "../../shared/validation";
import { createUserSchema, resetPasswordSchema, setUserRolesSchema, updateUserSchema } from "./users.schemas";
import { createUser, listUsers, resetUserPassword, setUserActive, setUserRoles, updateUser } from "./users.service";

export const usersRouter = Router();

usersRouter.use(authenticate);

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

usersRouter.post("/:id/activate", authorize("USERS", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await setUserActive(requireAuth(req), parseIdParam(req.params.id), true) });
});

usersRouter.post("/:id/deactivate", authorize("USERS", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await setUserActive(requireAuth(req), parseIdParam(req.params.id), false) });
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
