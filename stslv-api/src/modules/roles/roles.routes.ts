import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { ACTIONS, MODULES } from "../../shared/permissions";
import { parseIdParam } from "../../shared/validation";
import { listRoles, setRolePermissions } from "./roles.service";

const setPermissionsSchema = z.strictObject({
  permissions: z
    .array(z.strictObject({ module: z.enum(MODULES), action: z.enum(ACTIONS) }))
    .max(MODULES.length * ACTIONS.length),
});

export const rolesRouter = Router();

rolesRouter.use(authenticate);

// Roles and their permissions are part of user administration, so they are
// governed by the USERS module permissions.
rolesRouter.get("/", authorize("USERS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: { roles: await listRoles(), modules: MODULES, actions: ACTIONS } });
});

rolesRouter.put("/:id/permissions", authorize("USERS", "EDIT"), async (req, res) => {
  const { permissions } = setPermissionsSchema.parse(req.body);

  res.json({ success: true, data: await setRolePermissions(requireAuth(req), parseIdParam(req.params.id), permissions) });
});
