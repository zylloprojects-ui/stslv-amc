import type { RequestHandler } from "express";
import { forbidden } from "../shared/errors";
import { hasAdminAccess } from "../shared/role-model";
import { requireAuth } from "./authenticate";

/** For pages reserved to administrators (the Super Admin and Admin roles), whoever else is granted the module. Use after authenticate. */
export const adminOnly: RequestHandler = (req, _res, next) => {
  if (!hasAdminAccess(requireAuth(req).roles)) {
    throw forbidden();
  }

  next();
};

// Role management is no longer Super Admin only (approved 2026-11-09): see roleAdministrators in
// modules/roles/roles.routes.ts and canManageRoles / manageReason in roles.service.ts.
