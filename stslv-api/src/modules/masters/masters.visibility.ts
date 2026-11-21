import type { RequestHandler } from "express";
import type { ReportColumn } from "../../shared/export/report";
import { hiddenFieldsFor, hiddenReportKeys, responseFields, type FieldVisibility, type ResponseFields } from "../../shared/visibility-fields";
import type { AuthContext } from "../auth/access";

// Role visibility on the master lists (migration 0123, step B "Lock it"). The lists also feed the pickers of other
// pages, so the id, code and name of a record always stay, and so do the figures an action or warning works from (the
// contract and engineer counts) and a frequency's scheduling rule. Only optional, descriptive fields are hideable. The
// record forms show a hidden field locked and do not send it; the services keep the stored value whatever is sent
// (createMaster / updateMaster, createFrequency / updateFrequency).

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const ENGINEER_FIELD_VISIBILITY = {
  page: "salesEngineers",
  fields: {
    employeeNo: ["employeeNo"],
    email: ["email"],
    phone: ["phone"],
    // The form sends departmentId and userId; answers carry department and user; history logs the ids.
    department: ["departmentId", "department"],
    linkedUser: ["userId", "user"],
    notes: ["notes"],
  },
} as const;

export const SYSTEM_TYPE_FIELD_VISIBILITY = {
  page: "systemTypes",
  fields: { description: ["description"], sortOrder: ["sortOrder"] },
} as const;

export const FREQUENCY_FIELD_VISIBILITY = {
  page: "maintenanceFrequencies",
  fields: { sortOrder: ["sortOrder"] },
} as const;

export const DEPARTMENT_FIELD_VISIBILITY = {
  page: "departments",
  fields: { description: ["description"] },
} as const;

/** The master lists by table, for the shared master-list service. */
const BY_TABLE: Record<string, FieldVisibility<string>> = {
  sales_engineers: ENGINEER_FIELD_VISIBILITY,
  system_types: SYSTEM_TYPE_FIELD_VISIBILITY,
  departments: DEPARTMENT_FIELD_VISIBILITY,
  maintenance_frequencies: FREQUENCY_FIELD_VISIBILITY,
};

/** The fields of a master list hidden from the user: a save never changes them (the stored values are kept). */
export function masterHiddenFields(auth: Pick<AuthContext, "hidden">, table: string): Set<string> {
  const spec = BY_TABLE[table];
  return spec ? hiddenFieldsFor(auth, spec) : new Set();
}

const engineerSpec: ResponseFields<keyof (typeof ENGINEER_FIELD_VISIBILITY)["fields"]> = {
  ...ENGINEER_FIELD_VISIBILITY,
  isItem: (value) => isObject(value) && "code" in value && "name" in value && "employeeNo" in value && "department" in value,
};
const systemTypeSpec: ResponseFields<keyof (typeof SYSTEM_TYPE_FIELD_VISIBILITY)["fields"]> = {
  ...SYSTEM_TYPE_FIELD_VISIBILITY,
  isItem: (value) => isObject(value) && "code" in value && "name" in value && "sortOrder" in value && "description" in value && !("codePrefix" in value),
};
const frequencySpec: ResponseFields<keyof (typeof FREQUENCY_FIELD_VISIBILITY)["fields"]> = {
  ...FREQUENCY_FIELD_VISIBILITY,
  isItem: (value) => isObject(value) && "code" in value && "sortOrder" in value && ("codePrefix" in value || "intervalMonths" in value),
};
const departmentSpec: ResponseFields<keyof (typeof DEPARTMENT_FIELD_VISIBILITY)["fields"]> = {
  ...DEPARTMENT_FIELD_VISIBILITY,
  isItem: (value) => isObject(value) && "code" in value && "name" in value && "engineerCount" in value && "description" in value,
};

/** Middleware for each list's routes (mounted in app.ts ahead of every router that answers them). */
export const MASTER_VISIBILITY: { path: string; handler: RequestHandler }[] = [
  { path: "/api/masters/sales-engineers", handler: responseFields(engineerSpec) },
  { path: "/api/masters/system-types", handler: responseFields(systemTypeSpec) },
  { path: "/api/masters/maintenance-frequencies", handler: responseFields(frequencySpec) },
  { path: "/api/masters/departments", handler: responseFields(departmentSpec) },
];

/** A list download's columns without those hidden from the user's role (each hideable column's report keys). */
export function visibleReportColumns<C extends string>(
  auth: Pick<AuthContext, "hidden">,
  spec: FieldVisibility<C>,
  reportKeys: Partial<Record<C, readonly string[]>>,
  columns: ReportColumn[]
): ReportColumn[] {
  const hidden = hiddenReportKeys(auth, spec, reportKeys);
  return columns.filter((column) => !hidden.has(column.key));
}
