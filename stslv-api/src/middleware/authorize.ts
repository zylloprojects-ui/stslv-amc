import type { RequestHandler } from "express";
import { forbidden } from "../shared/errors";
import { permissionKey, type Action, type Module } from "../shared/permissions";
import { requireAuth } from "./authenticate";

/** Requires the signed-in user to hold the given permission. Use after authenticate. */
export function authorize(module: Module, action: Action): RequestHandler {
  const key = permissionKey(module, action);

  return (req, _res, next) => {
    if (!requireAuth(req).permissions.has(key)) {
      throw forbidden();
    }

    next();
  };
}
