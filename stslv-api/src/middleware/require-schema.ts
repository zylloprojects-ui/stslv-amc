import type { RequestHandler } from "express";
import { AppError } from "../shared/errors";
import { schemaHas } from "../shared/schema-features";

export const featureUnavailable = () =>
  new AppError(503, "FEATURE_UNAVAILABLE", "This feature needs a database update that has not been applied yet.");

/**
 * For routes whose tables or columns come from a migration a database may not
 * have yet. They answer 503 FEATURE_UNAVAILABLE instead of failing, so the rest
 * of the application keeps working on a database that is a migration behind.
 * Each item is a table ("attachments") or a column ("amc_contracts.renewed_from_id").
 */
export function requireSchema(items: readonly string[]): RequestHandler {
  return async (_req, _res, next) => {
    if (!(await schemaHas(items))) {
      throw featureUnavailable();
    }

    next();
  };
}
