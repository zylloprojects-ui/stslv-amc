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
