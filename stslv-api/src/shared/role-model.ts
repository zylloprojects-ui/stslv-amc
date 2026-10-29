import { isGrantable, PERMISSION_CATALOG } from "./permission-catalog";
import { ACTIONS, ADMIN_ROLE_CODE, permissionKey, type Action, type Module, type PermissionKey } from "./permissions";

// The six-role model (approved 2026-10-29), seeded by migration 0087.
//
// - ADMIN (shown as "Super Admin"): fixed full access. Its code is unchanged so every
//   existing assignment, audit entry and check keeps its meaning.
// - ADMINISTRATOR ("Admin"): operational and administrative access as configured by
//   Super Admin. Only Super Admin changes its permissions, assigns or removes it, or
//   manages the accounts that hold it.
// - FINANCE_EXECUTIVE, MASTER_DATA_EXECUTIVE, AMC_OPERATIONS_EXECUTIVE: each limited to the
//   pages of its section, plus Dashboard view. Where a page shows another module's data, the
//   role holds that module's data-only READ, which opens none of that module's pages (0090).
// - VIEWER: View and Export only, never Administration.
//
// The legacy roles (ACCOUNTANT, PROCUREMENT, EXECUTION, INVOICING) are kept with their
// grants and made inactive by migration 0088.

export const ADMINISTRATOR_ROLE_CODE = "ADMINISTRATOR";

/** Roles whose holders only Super Admin may manage: assign, remove, edit, deactivate, reset passwords. */
export const PRIVILEGED_ROLE_CODES: readonly string[] = [ADMIN_ROLE_CODE, ADMINISTRATOR_ROLE_CODE];

export const isPrivilegedRole = (code: string) => PRIVILEGED_ROLE_CODES.includes(code);

/** Holds the built-in full-access role. */
export const isSuperAdmin = (roles: readonly { code: string }[]) => roles.some((role) => role.code === ADMIN_ROLE_CODE);

/** Holds Super Admin or Admin: the pages reserved to administrators (Audit Log, Suggestions Review). */
export const hasAdminAccess = (roles: readonly { code: string }[]) => roles.some((role) => isPrivilegedRole(role.code));

/** "*" allows every action the module uses except data-only Read, which View already covers; otherwise the listed actions. */
type ScopeRule = Partial<Record<Module, "*" | readonly Action[]>>;

const modulesOf = (title: string): Module[] =>
  PERMISSION_CATALOG.find((section) => section.title === title)?.modules.map((entry) => entry.module) ?? [];

const every = (modules: Module[]): ScopeRule => Object.fromEntries(modules.map((module) => [module, "*"]));

const FINANCE_SCOPE: ScopeRule = {
  ...every(modulesOf("Finance")),
  DASHBOARD: ["VIEW"],
  // Data only: Invoice Tracking and Accounts show the visits they invoice and reconcile.
  AMC_SCHEDULE: ["READ"],
};

const MASTER_DATA_SCOPE: ScopeRule = {
  ...every(modulesOf("Master Data Center")),
  DASHBOARD: ["VIEW"],
};

const AMC_OPERATIONS_SCOPE: ScopeRule = {
  ...every(modulesOf("AMC Operations")),
  DASHBOARD: ["VIEW"],
  // Data only: the contract form and filters list clients; Master AMC Status, AMC Management
  // and the contract and visit details show invoice numbers.
  CLIENTS: ["READ"],
  INVOICES: ["READ"],
};

const ADMINISTRATION = new Set(modulesOf("Administration"));

const VIEWER_SCOPE: ScopeRule = Object.fromEntries(
  PERMISSION_CATALOG.filter((section) => !section.retired)
    .flatMap((section) => section.modules.map((entry) => entry.module))
    .filter((module) => !ADMINISTRATION.has(module))
    .map((module) => [module, ["VIEW", "EXPORT"] as const])
);

/** Roles limited to part of the application. A role not listed here (Admin, a custom role) may hold any grantable permission. */
const ROLE_SCOPES: Record<string, ScopeRule> = {
  FINANCE_EXECUTIVE: FINANCE_SCOPE,
  MASTER_DATA_EXECUTIVE: MASTER_DATA_SCOPE,
  AMC_OPERATIONS_EXECUTIVE: AMC_OPERATIONS_SCOPE,
  VIEWER: VIEWER_SCOPE,
};

/** Whether a role of this code may hold the permission. Only grantable permissions are ever in scope. */
export function isInRoleScope(roleCode: string, module: Module, action: Action): boolean {
  if (!isGrantable(module, action)) {
    return false;
  }

  const scope = ROLE_SCOPES[roleCode];

  if (!scope) {
    return true;
  }

  const rule = scope[module];

  return rule === "*" ? action !== "READ" : (rule?.includes(action) ?? false);
}

/** Every grantable permission a role may hold, or null for a role with no scope limit. Sent to Roles & Permissions. */
export function roleScope(roleCode: string): PermissionKey[] | null {
  if (!ROLE_SCOPES[roleCode]) {
    return null;
  }

  return PERMISSION_CATALOG.flatMap((section) =>
    section.modules.flatMap((entry) => ACTIONS.filter((action) => isInRoleScope(roleCode, entry.module, action)).map((action) => permissionKey(entry.module, action)))
  );
}

// ---------------------------------------------------------------------------
// Dependencies between the permissions of one module
// ---------------------------------------------------------------------------

/**
 * An action that only works together with another of the same module. Every action needs
 * View: each page and each action's dialog first reads the records. Cancelling a contract
 * also needs Edit (the API checks both). Data-only Read stands alone.
 */
export function requiredActions(module: Module, action: Action): Action[] {
  if (action === "VIEW" || action === "READ") {
    return [];
  }
  if (module === "AMC_CONTRACTS" && action === "DELETE") {
    return ["VIEW", "EDIT"];
  }

  return ["VIEW"];
}

export interface DependencyProblem {
  key: PermissionKey;
  missing: PermissionKey;
}

/** The first grantable permission in the set held without the permissions it depends on, or null. */
export function dependencyProblem(keys: ReadonlySet<PermissionKey>): DependencyProblem | null {
  for (const key of keys) {
    const [module, action] = key.split(":") as [Module, Action];

    // Retired grants are kept as they were; nothing new can be granted on them.
    if (!isGrantable(module, action)) {
      continue;
    }

    for (const needed of requiredActions(module, action)) {
      const missing = permissionKey(module, needed);

      if (!keys.has(missing)) {
        return { key, missing };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Starting grants (migration 0087 seeds exactly these; tests/role-model.test.ts compares)
// ---------------------------------------------------------------------------

/** Every grantable permission of the current (not retired) modules. */
function allGrantable(): PermissionKey[] {
  return PERMISSION_CATALOG.filter((section) => !section.retired).flatMap((section) =>
    section.modules.flatMap((entry) => ACTIONS.filter((action) => isGrantable(entry.module, action)).map((action) => permissionKey(entry.module, action)))
  );
}

/**
 * The grants each new role starts with (0087, revised by 0090). Super Admin can change them later
 * within the role's scope. Admin starts with everything grantable; the Executives with their whole scope;
 * Viewer with View only (Export can be added).
 */
export function defaultGrants(roleCode: string): PermissionKey[] {
  if (roleCode === ADMINISTRATOR_ROLE_CODE) {
    // Data-only Read is redundant next to View of the same module.
    const all = allGrantable();
    return all.filter((key) => !(key.endsWith(":READ") && all.includes(key.replace(/:READ$/, ":VIEW") as PermissionKey)));
  }

  const scope = roleScope(roleCode) ?? [];

  return roleCode === "VIEWER" ? scope.filter((key) => key.endsWith(":VIEW")) : scope;
}

export const SIX_ROLE_CODES = [ADMIN_ROLE_CODE, ADMINISTRATOR_ROLE_CODE, "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER"] as const;

/** Kept with their grants, inactive from migration 0088. */
export const LEGACY_ROLE_CODES = ["ACCOUNTANT", "PROCUREMENT", "EXECUTION", "INVOICING"] as const;

/** Roles the migrations define. They are never deleted; only Super Admin renames, deactivates or reactivates them. */
export const BUILT_IN_ROLE_CODES: readonly string[] = [...SIX_ROLE_CODES, ...LEGACY_ROLE_CODES];

export const isBuiltInRole = (code: string) => BUILT_IN_ROLE_CODES.includes(code);
