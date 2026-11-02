import { Router } from "express";
import { z } from "zod";
import { superAdminOnly } from "../../middleware/admin-only";
import { authenticate, requireAuth } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { FIXED_ACCESS, PERMISSION_CATALOG } from "../../shared/permission-catalog";
import { ACTIONS, MODULES } from "../../shared/permissions";
import { parseIdParam } from "../../shared/validation";
import { createRole, deleteRole, listRoles, setRolePermissions, updateRole } from "./roles.service";

const setPermissionsSchema = z.strictObject({
  permissions: z
    .array(z.strictObject({ module: z.enum(MODULES), action: z.enum(ACTIONS) }))
    .max(MODULES.length * ACTIONS.length),
  // The permissionsVersion the change started from (GET /api/roles): a set changed meanwhile is not overwritten.
  expectedVersion: z.string().regex(/^[0-9a-f]{16}$/, "Reload the role permissions and try again."),
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

// Seeing roles is part of user administration (USERS:VIEW). Changing a role or any role's
// permissions is reserved to Super Admin (approved 2026-10-29), whatever USERS permissions
// another role holds; the service checks the same.
rolesRouter.get("/", authorize("USERS", "VIEW"), async (req, res) => {
  // catalog: what each module governs and which of its actions are used, for Roles & Permissions.
  res.json({ success: true, data: { roles: await listRoles(requireAuth(req)), modules: MODULES, actions: ACTIONS, catalog: PERMISSION_CATALOG, fixedAccess: FIXED_ACCESS } });
});

rolesRouter.post("/", superAdminOnly, async (req, res) => {
  res.status(201).json({ success: true, data: await createRole(requireAuth(req), createRoleSchema.parse(req.body)) });
});

rolesRouter.patch("/:id", superAdminOnly, async (req, res) => {
  res.json({ success: true, data: await updateRole(requireAuth(req), parseIdParam(req.params.id), updateRoleSchema.parse(req.body)) });
});

rolesRouter.delete("/:id", superAdminOnly, async (req, res) => {
  await deleteRole(requireAuth(req), parseIdParam(req.params.id));
  res.json({ success: true, data: null });
});

rolesRouter.put("/:id/permissions", superAdminOnly, async (req, res) => {
  const { permissions, expectedVersion } = setPermissionsSchema.parse(req.body);

  res.json({ success: true, data: await setRolePermissions(requireAuth(req), parseIdParam(req.params.id), permissions, expectedVersion) });
});
