import type { RequestHandler } from "express";
import { ADMIN_ROLE_CODE } from "../shared/permissions";
import { forbidden } from "../shared/errors";
import { requireAuth } from "./authenticate";

/** For pages reserved to the built-in Admin role, whoever else is granted the module. Use after authenticate. */
export const adminOnly: RequestHandler = (req, _res, next) => {
  if (!requireAuth(req).roles.some((role) => role.code === ADMIN_ROLE_CODE)) {
    throw forbidden();
  }

  next();
};
