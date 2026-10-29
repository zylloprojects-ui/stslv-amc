// The module and action codes the application checks. The grants themselves
// (which role holds which permission) live in the role_permissions table.
// These lists must match the CHECK constraints on role_permissions.

export const MODULES = [
  "DASHBOARD",
  "CLIENTS",
  "AMC_CONTRACTS",
  "AMC_SCHEDULE",
  "AMC_EXECUTION",
  "PROJECTS",
  "PROCUREMENT",
  "EXPENSES",
  "INVOICES",
  "REPORTS",
  "USERS",
  "SETTINGS",
  "HISTORICAL_DATA",
  // Migration 0078 (module), grants 0079.
  "SERVICES_SALES",
  // Migration 0080 (modules), grants 0081: pages that used to share another module's permissions.
  "AMC_RENEWAL",
  "MONTHLY_CALENDAR",
  "SERVICE_STATUS",
  "SALES_ENGINEERS",
  "SYSTEM_TYPES",
  "MAINTENANCE_FREQUENCIES",
  "DEPARTMENTS",
] as const;

export const ACTIONS = ["VIEW", "CREATE", "EDIT", "DELETE", "APPROVE", "EXPORT"] as const;

export type Module = (typeof MODULES)[number];
export type Action = (typeof ACTIONS)[number];

/** Permissions travel as "MODULE:ACTION" strings, for example "CLIENTS:EDIT". */
export type PermissionKey = `${Module}:${Action}`;

export function permissionKey(module: Module, action: Action): PermissionKey {
  return `${module}:${action}`;
}

/** The built-in administrator role. Its permissions cannot be edited through the API. */
export const ADMIN_ROLE_CODE = "ADMIN";
