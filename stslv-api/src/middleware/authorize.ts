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

/**
 * For a route that serves several pages, each governed by its own module (the visit list
 * serves AMC Schedule and Monthly Calendar): requires every given action on at least one
 * of the modules. Holding VIEW on one and EXPORT on another is not enough. Use after authenticate.
 */
export function authorizeOnAny(modules: Module[], ...actions: Action[]): RequestHandler {
  return (req, _res, next) => {
    const held = requireAuth(req).permissions;

    if (!modules.some((module) => actions.every((action) => held.has(permissionKey(module, action))))) {
      throw forbidden();
    }

    next();
  };
}
