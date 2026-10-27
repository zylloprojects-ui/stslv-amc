import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { pagingSchema } from "../../shared/money";
import { listMastersSchema } from "./masters.schemas";

// System types only: the export, the linked-contracts list and deletion.
// Create, edit, status and the list itself are the shared master-list routes.

/** The list's own filters and order (search, status, sort, direction), without paging. */
export const exportSystemTypesSchema = listMastersSchema
  .pick({ search: true, status: true, sort: true, direction: true })
  .extend({ format: exportFormatSchema });

export const linkedContractsSchema = z.object(pagingSchema);

export type ExportSystemTypesQuery = z.infer<typeof exportSystemTypesSchema>;

/** The stored flag in words, as the System Types page shows it. */
export const SYSTEM_TYPE_STATUS_LABELS = { active: "Active", inactive: "Disabled" } as const;
