import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { ACTIONS, MODULES } from "../../shared/permissions";
import { parseIdParam } from "../../shared/validation";
import { createRole, deleteRole, listRoles, setRolePermissions, updateRole } from "./roles.service";

const setPermissionsSchema = z.strictObject({
  permissions: z
    .array(z.strictObject({ module: z.enum(MODULES), action: z.enum(ACTIONS) }))
    .max(MODULES.length * ACTIONS.length),
});

const name = z.string().trim().min(1, "Name is required.").max(80, "Name must be at most 80 characters.");
const description = z
  .string()
  .trim()
  .max(300, "Description must be at most 300 characters.")
  .transform((value) => (value === "" ? null : value))
  .nullable();

const createRoleSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Use 2 to 40 capital letters, digits or underscores, starting with a letter."),
  name,
  description: description.optional().transform((value) => value ?? null),
});

const updateRoleSchema = z
  .strictObject({ name: name.optional(), description: description.optional(), isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change." });

export const rolesRouter = Router();

rolesRouter.use(authenticate);

// Roles and their permissions are part of user administration, so they are
// governed by the USERS module permissions. In the business they are the departments.
rolesRouter.get("/", authorize("USERS", "VIEW"), async (_req, res) => {
  res.json({ success: true, data: { roles: await listRoles(), modules: MODULES, actions: ACTIONS } });
});

rolesRouter.post("/", authorize("USERS", "CREATE"), async (req, res) => {
  res.status(201).json({ success: true, data: await createRole(requireAuth(req), createRoleSchema.parse(req.body)) });
});

rolesRouter.patch("/:id", authorize("USERS", "EDIT"), async (req, res) => {
  res.json({ success: true, data: await updateRole(requireAuth(req), parseIdParam(req.params.id), updateRoleSchema.parse(req.body)) });
});

rolesRouter.delete("/:id", authorize("USERS", "DELETE"), async (req, res) => {
  await deleteRole(requireAuth(req), parseIdParam(req.params.id));
  res.json({ success: true, data: null });
});

rolesRouter.put("/:id/permissions", authorize("USERS", "EDIT"), async (req, res) => {
  const { permissions } = setPermissionsSchema.parse(req.body);

  res.json({ success: true, data: await setRolePermissions(requireAuth(req), parseIdParam(req.params.id), permissions) });
});
