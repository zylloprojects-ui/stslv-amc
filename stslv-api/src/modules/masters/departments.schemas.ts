import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { listMastersSchema } from "./masters.schemas";

// Departments only: the list (with description search and name order) and its
// export. Create, edit, status and options are the shared master-list routes.

/** The list's own filters and order (search, status, sort, direction), with paging. */
export const listDepartmentsSchema = listMastersSchema.omit({ departmentId: true });

/** The same filters and order, without paging. */
export const exportDepartmentsSchema = listMastersSchema
  .pick({ search: true, status: true, sort: true, direction: true })
  .extend({ format: exportFormatSchema });

export type ListDepartmentsQuery = z.infer<typeof listDepartmentsSchema>;
export type ExportDepartmentsQuery = z.infer<typeof exportDepartmentsSchema>;

/** The stored flag in words, as the Departments page shows it. Archived needs a database update (not built). */
export const DEPARTMENT_STATUS_LABELS = { active: "Active", inactive: "Disabled" } as const;
