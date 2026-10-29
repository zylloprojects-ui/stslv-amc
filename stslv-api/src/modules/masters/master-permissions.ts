import type { RequestHandler } from "express";
import type { AuthContext } from "../auth/access";
import { authorizeOnAny } from "../../middleware/authorize";
import type { Module } from "../../shared/permissions";

// Each master list has its own permission module (migration 0080; before, all
// four used SETTINGS). Adding, editing, deleting and exporting need that
// module's permission. Reading is also open to the pages that pick from the
// list, so they keep working without managing it.

export type MasterPath = "departments" | "sales-engineers" | "system-types" | "maintenance-frequencies";

export const MASTER_MODULE: Record<MasterPath, Module> = {
  departments: "DEPARTMENTS",
  "sales-engineers": "SALES_ENGINEERS",
  "system-types": "SYSTEM_TYPES",
  "maintenance-frequencies": "MAINTENANCE_FREQUENCIES",
};

// Contracts pick an engineer, a system type and a frequency (AMC_CONTRACTS:VIEW, as before);
// the Sales Engineers page filters and assigns by department, and a department lists its engineers.
const READERS: Record<MasterPath, Module[]> = {
  departments: ["DEPARTMENTS", "SALES_ENGINEERS", "AMC_CONTRACTS"],
  "sales-engineers": ["SALES_ENGINEERS", "DEPARTMENTS", "AMC_CONTRACTS"],
  "system-types": ["SYSTEM_TYPES", "AMC_CONTRACTS"],
  "maintenance-frequencies": ["MAINTENANCE_FREQUENCIES", "AMC_CONTRACTS"],
};

export function mayReadMaster(permissions: AuthContext["permissions"], path: MasterPath): boolean {
  return READERS[path].some((module) => permissions.has(`${module}:VIEW`));
}

/** Route guard: the user may read this master list. Use after authenticate. */
export function canReadMaster(path: MasterPath): RequestHandler {
  return authorizeOnAny(READERS[path], "VIEW");
}
