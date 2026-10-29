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

// READ (migration 0089): data-only read. The module's data may be shown inside another
// section's page (visit details in Accounts, say), without opening this module's own pages.
// Checked only through canRead() / authorizeRead() at the places listed in the catalog.
export const ACTIONS = ["VIEW", "CREATE", "EDIT", "DELETE", "APPROVE", "EXPORT", "READ"] as const;

export type Module = (typeof MODULES)[number];
export type Action = (typeof ACTIONS)[number];

/** Permissions travel as "MODULE:ACTION" strings, for example "CLIENTS:EDIT". */
export type PermissionKey = `${Module}:${Action}`;

export function permissionKey(module: Module, action: Action): PermissionKey {
  return `${module}:${action}`;
}

/**
 * Data-only read of a module: its View, or its Read grant. Use only where another section's page
 * shows this module's data; the module's own pages and lists keep requiring View.
 */
export function canRead(permissions: ReadonlySet<PermissionKey>, module: Module): boolean {
  return permissions.has(permissionKey(module, "VIEW")) || permissions.has(permissionKey(module, "READ"));
}

/** Whether the held set includes the permission. A Read grant is covered by View of the same module. */
export function holdsPermission(permissions: ReadonlySet<PermissionKey>, key: PermissionKey): boolean {
  if (permissions.has(key)) return true;
  const [module, action] = key.split(":") as [Module, Action];
  return action === "READ" && permissions.has(permissionKey(module, "VIEW"));
}

/** The built-in administrator role. Its permissions cannot be edited through the API. */
export const ADMIN_ROLE_CODE = "ADMIN";
