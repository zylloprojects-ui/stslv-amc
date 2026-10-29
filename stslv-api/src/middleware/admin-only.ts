import type { RequestHandler } from "express";
import { forbidden } from "../shared/errors";
import { hasAdminAccess, isSuperAdmin } from "../shared/role-model";
import { requireAuth } from "./authenticate";

/** For pages reserved to administrators (the Super Admin and Admin roles), whoever else is granted the module. Use after authenticate. */
export const adminOnly: RequestHandler = (req, _res, next) => {
  if (!hasAdminAccess(requireAuth(req).roles)) {
    throw forbidden();
  }

  next();
};

/** For actions reserved to Super Admin: role definitions and every role's permissions. Use after authenticate. */
export const superAdminOnly: RequestHandler = (req, _res, next) => {
  if (!isSuperAdmin(requireAuth(req).roles)) {
    throw forbidden("Only Super Admin can change roles and their permissions.");
  }

  next();
};
