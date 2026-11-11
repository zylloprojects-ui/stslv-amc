import { z } from "zod";

/**
 * The Service Status columns a user may hide, by the page's own column keys. AMC Reference always stays.
 * "serviceReport" (the uploaded document, 0104) is a page column only: the export has no file column, so hiding it
 * changes nothing in an export.
 */
export const SERVICE_STATUS_HIDEABLE_COLUMNS = [
  "client", "system", "frequency", "service", "due", "status", "engineer", "report", "engineerName", "amcValue", "serviceReport",
  // 2026-11-11: this service's own value (beside the contract's AMC Value), and the invoice acknowledgement indicator.
  "serviceValue", "acknowledgement",
] as const;
export type ServiceStatusColumn = (typeof SERVICE_STATUS_HIDEABLE_COLUMNS)[number];

/** The `hidden` query value of an export: a comma-separated list of known columns. An unknown column is refused. */
export function hiddenColumnsSchema<T extends string>(columns: readonly T[]) {
  return z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value, ctx) => {
      const ids = (value ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
      const unknown = ids.filter((id) => !(columns as readonly string[]).includes(id));

      if (unknown.length > 0) {
        ctx.addIssue({ code: "custom", message: `Unknown column: ${unknown.join(", ")}.` });
        return z.NEVER;
      }
      return [...new Set(ids)] as T[];
    });
}

export const serviceStatusHiddenSchema = hiddenColumnsSchema(SERVICE_STATUS_HIDEABLE_COLUMNS);
