import { isGrantable, PERMISSION_CATALOG } from "./permission-catalog";
import { ACTIONS, ADMIN_ROLE_CODE, permissionKey, type Action, type Module, type PermissionKey } from "./permissions";

// The six-role model (approved 2026-10-29), seeded by migration 0087.
//
// - ADMIN (shown as "Super Admin"): fixed full access. Its code is unchanged so every
//   existing assignment, audit entry and check keeps its meaning.
// - ADMINISTRATOR ("Admin"): operational and administrative access as configured by
//   Super Admin. Only Super Admin changes its permissions, assigns or removes it, or
//   manages the accounts that hold it.
// - FINANCE_EXECUTIVE, MASTER_DATA_EXECUTIVE, AMC_OPERATIONS_EXECUTIVE: start with the pages of
//   their section, plus Dashboard view. Where a page shows another module's data, the role holds
//   that module's data-only READ, which opens none of that module's pages (0090).
// - VIEWER: starts with View only, and submitting suggestions.
//
// Starting grants only: Super Admin may give these roles any supported permission of any module
// (approved 2026-10-31). The saved role_permissions decide access. Security administration
// (SECURITY_MODULES) stays out of their reach.
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

/** Modules that administer accounts and access: never held by the roles below. */
export const SECURITY_MODULES: readonly Module[] = ["USERS"];

/** Built-in operational roles: any supported permission, except security administration. */
const OPERATIONAL_ROLE_CODES: readonly string[] = ["FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER"];

/** Whether a role of this code may hold the permission. Only grantable permissions are ever in scope. */
export function isInRoleScope(roleCode: string, module: Module, action: Action): boolean {
  if (!isGrantable(module, action)) {
    return false;
  }

  return !(OPERATIONAL_ROLE_CODES.includes(roleCode) && SECURITY_MODULES.includes(module));
}

/** Every grantable permission a role may hold, or null for a role with no limit. Sent to Roles & Permissions. */
export function roleScope(roleCode: string): PermissionKey[] | null {
  if (!OPERATIONAL_ROLE_CODES.includes(roleCode)) {
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

const modulesOf = (title: string): Module[] =>
  PERMISSION_CATALOG.find((section) => section.title === title)?.modules.map((entry) => entry.module) ?? [];

/** Every used action of the modules, except data-only Read, which View covers. */
const wholeModules = (modules: Module[]): PermissionKey[] =>
  modules.flatMap((module) => ACTIONS.filter((action) => action !== "READ" && isGrantable(module, action)).map((action) => permissionKey(module, action)));

/** Every role could already submit and follow its own suggestions when the module was added (0092). */
const SUGGESTIONS: PermissionKey[] = ["SUGGESTIONS:VIEW", "SUGGESTIONS:CREATE"];

/**
 * The grants each role starts with (0087, revised by 0090 and 0092). They are what the migrations seeded, and
 * limit nothing: Super Admin changes them in Roles & Permissions. Changing this list changes no database.
 */
export function defaultGrants(roleCode: string): PermissionKey[] {
  const all = allGrantable();

  switch (roleCode) {
    case ADMINISTRATOR_ROLE_CODE:
      // Data-only Read is redundant next to View of the same module.
      return all.filter((key) => !(key.endsWith(":READ") && all.includes(key.replace(/:READ$/, ":VIEW") as PermissionKey)));
    case "FINANCE_EXECUTIVE":
      // Data only: Invoice Tracking and Accounts show the visits they invoice and reconcile.
      return ["DASHBOARD:VIEW", "AMC_SCHEDULE:READ", ...SUGGESTIONS, ...wholeModules(modulesOf("Finance"))];
    case "MASTER_DATA_EXECUTIVE":
      return ["DASHBOARD:VIEW", ...SUGGESTIONS, ...wholeModules(modulesOf("Master Data Center"))];
    case "AMC_OPERATIONS_EXECUTIVE":
      // Data only: the contract form and filters list clients; Master AMC Status, AMC Management
      // and the contract and visit details show invoice numbers.
      return ["DASHBOARD:VIEW", "CLIENTS:READ", "INVOICES:READ", ...SUGGESTIONS, ...wholeModules(modulesOf("AMC Operations"))];
    case "VIEWER": {
      const administration = new Set<Module>(modulesOf("Administration"));
      return ["SUGGESTIONS:CREATE", ...all.filter((key) => key.endsWith(":VIEW") && !administration.has(key.split(":")[0] as Module))];
    }
    default:
      return [];
  }
}

export const SIX_ROLE_CODES = [ADMIN_ROLE_CODE, ADMINISTRATOR_ROLE_CODE, "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER"] as const;

/** Kept with their grants, inactive from migration 0088. */
export const LEGACY_ROLE_CODES = ["ACCOUNTANT", "PROCUREMENT", "EXECUTION", "INVOICING"] as const;

/** Roles the migrations define. They are never deleted; only Super Admin renames, deactivates or reactivates them. */
export const BUILT_IN_ROLE_CODES: readonly string[] = [...SIX_ROLE_CODES, ...LEGACY_ROLE_CODES];

export const isBuiltInRole = (code: string) => BUILT_IN_ROLE_CODES.includes(code);
