import { createHash } from "node:crypto";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { isGrantable } from "../../shared/permission-catalog";
import { ADMIN_ROLE_CODE, holdsPermission, permissionKey, type Action, type Module, type PermissionKey } from "../../shared/permissions";
import { dependencyProblem, hasAdminAccess, isBuiltInRole, isInRoleScope, isPrivilegedRole, isSuperAdmin, roleScope, SECURITY_MODULES } from "../../shared/role-model";
import type { AuthContext } from "../auth/access";

export interface Permission {
  module: Module;
  action: Action;
}

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  user_count: number;
  permissions: Permission[];
}

export interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  userCount: number;
  permissions: Permission[];
  /**
   * Whether the signed-in user may change this role's permissions: Super Admin (never Super Admin's own), or Admin
   * for a custom role within Admin's own permissions (see manageReason).
   */
  permissionsEditable: boolean;
  /** Why the signed-in user cannot change the permissions, or null. */
  lockedReason: string | null;
  /** Whether the signed-in user may rename, deactivate, reactivate or delete this role (deleting also needs a custom, unused role). */
  manageable: boolean;
  /** Why the signed-in user may not manage this role, or null. */
  manageReason: string | null;
  /**
   * Identifies the saved permission set. A save sends the version it started from and is refused
   * (409) when the set has changed since, so two administrators never silently overwrite each other.
   */
  permissionsVersion: string;
  /** Defined by the migrations: never deleted; it and its permissions are changed only by Super Admin. */
  builtIn: boolean;
  /** The permissions this role may be given ("MODULE:ACTION"), or null when it may be given any grantable permission. */
  scope: PermissionKey[] | null;
  /** Whether the signed-in user may give this role to someone: active, and within their own authority. */
  assignable: boolean;
}

const SUPER_ADMIN_LOCKED = "Super Admin always has full access. Its permissions cannot be changed.";
export const ROLE_ADMINISTRATORS_ONLY = "Only Super Admin, and Admin with Users & Access Edit, can change roles and their permissions.";
const BUILT_IN_SUPER_ADMIN_ONLY = "Only Super Admin can change a built-in role or its permissions.";
const OWN_ROLE = "You cannot change a role you hold yourself.";
const BEYOND_AUTHORITY = "This role grants permissions you do not hold. Only Super Admin can change it.";
const STALE_PERMISSIONS =
  "These permissions were changed by someone else since you opened them. Load the latest permissions and make your change again.";

const ROLE_SELECT = `
  SELECT r.id, r.code, r.name, r.description, r.is_active,
         (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
         COALESCE(
           (SELECT json_agg(json_build_object('module', rp.module, 'action', rp.action) ORDER BY rp.module, rp.action)
            FROM role_permissions rp WHERE rp.role_id = r.id),
           '[]'
         ) AS permissions
  FROM roles r`;

/**
 * Who manages roles (approved 2026-11-09): Super Admin, and Admin while holding Users & Access Edit. Super Admin
 * removing that permission from Admin takes role management away from Admin. Nobody else, whatever they hold.
 */
export function canManageRoles(auth: AuthContext): boolean {
  return isSuperAdmin(auth.roles) || (hasAdminAccess(auth.roles) && holdsPermission(auth.permissions, "USERS:EDIT"));
}

/**
 * Why the signed-in user may not change this role (its name, status, existence or permissions), or null.
 * Super Admin may change every role. Admin may change only a custom role that Admin does not hold and whose every
 * permission Admin holds: built-in roles (Super Admin, Admin, the executive roles, Viewer, the legacy roles) stay
 * with Super Admin, and a role reaching beyond Admin's own access (set up by Super Admin) cannot be touched.
 */
function manageReason(auth: AuthContext, row: Pick<RoleRow, "code" | "permissions">): string | null {
  if (isSuperAdmin(auth.roles)) return null;
  if (!canManageRoles(auth)) return ROLE_ADMINISTRATORS_ONLY;
  if (isBuiltInRole(row.code)) return BUILT_IN_SUPER_ADMIN_ONLY;
  if (auth.roles.some((role) => role.code === row.code)) return OWN_ROLE;
  if (!row.permissions.every((permission) => holdsPermission(auth.permissions, keyOf(permission)))) return BEYOND_AUTHORITY;
  return null;
}

/** Why the signed-in user may not change this role's permissions, or null. Super Admin's own are fixed for everyone. */
function lockedReason(auth: AuthContext, row: Pick<RoleRow, "code" | "permissions">): string | null {
  if (row.code === ADMIN_ROLE_CODE) return SUPER_ADMIN_LOCKED;
  return manageReason(auth, row);
}

/** A short fingerprint of a permission set, independent of order. */
export function permissionsVersionOf(permissions: Permission[]): string {
  const keys = permissions.map((permission) => keyOf(permission)).sort();
  return createHash("sha256").update(keys.join(",")).digest("hex").slice(0, 16);
}

function toRole(auth: AuthContext, row: RoleRow): Role {
  const locked = lockedReason(auth, row);
  const unmanageable = manageReason(auth, row);

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    userCount: row.user_count,
    permissions: row.permissions,
    permissionsEditable: locked === null,
    lockedReason: locked,
    manageable: unmanageable === null,
    manageReason: unmanageable,
    permissionsVersion: permissionsVersionOf(row.permissions),
    builtIn: isBuiltInRole(row.code),
    scope: roleScope(row.code),
    assignable:
      row.is_active &&
      (!isPrivilegedRole(row.code) || isSuperAdmin(auth.roles)) &&
      row.permissions.every((permission) => holdsPermission(auth.permissions, keyOf(permission))),
  };
}

export async function listRoles(auth: AuthContext): Promise<Role[]> {
  const result = await pool.query<RoleRow>(`${ROLE_SELECT} ORDER BY r.id`);

  return result.rows.map((row) => toRole(auth, row));
}

async function findRole(auth: AuthContext, db: Queryable, id: string): Promise<Role> {
  const result = await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Role not found.");
  }

  return toRole(auth, row);
}

/** Role definitions are changed by Super Admin, and by Admin with Users & Access Edit (the routes check the same). */
function assertRoleAdministrator(auth: AuthContext): void {
  if (!canManageRoles(auth)) {
    throw forbidden(ROLE_ADMINISTRATORS_ONLY);
  }
}

/** Refuses a change to a role the signed-in user may not manage (see manageReason). */
function assertManageable(role: Role): void {
  if (role.manageReason) {
    throw forbidden(role.manageReason);
  }
}

const keyOf = (permission: Permission): PermissionKey => permissionKey(permission.module, permission.action);

/**
 * Replaces a role's permission set with the given one. Super Admin for any role but its own; Admin for a custom
 * role it may manage. expectedVersion is the permissionsVersion the change started from: a set changed meanwhile
 * is not overwritten (409).
 */
export function setRolePermissions(auth: AuthContext, roleId: string, permissions: Permission[], expectedVersion: string): Promise<Role> {
  assertRoleAdministrator(auth);

  return withTransaction(async (client) => {
    // Lock the role so two concurrent edits cannot interleave.
    await client.query("SELECT 1 FROM roles WHERE id = $1 FOR UPDATE", [roleId]);
    const role = await findRole(auth, client, roleId);

    if (role.lockedReason) {
      throw forbidden(role.lockedReason);
    }
    if (role.permissionsVersion !== expectedVersion) {
      throw conflict(STALE_PERMISSIONS);
    }

    const wanted = new Map(permissions.map((permission) => [keyOf(permission), permission]));
    const current = new Map(role.permissions.map((permission) => [keyOf(permission), permission]));
    const added = [...wanted.values()].filter((permission) => !current.has(keyOf(permission)));
    const removed = [...current.values()].filter((permission) => !wanted.has(keyOf(permission)));

    if (added.length === 0 && removed.length === 0) {
      return role;
    }

    // Deny by default: only a permission the current application checks can be newly granted.
    // Grants already held (of a retired module, say) are kept as they are and may be removed.
    const unused = added.find((permission) => !isGrantable(permission.module, permission.action));

    if (unused) {
      throw validationError(`The permission ${keyOf(unused)} is not used by the current application and cannot be granted.`);
    }

    // Nobody may grant or revoke a permission they do not hold themselves.
    const beyond = [...added, ...removed].find((permission) => !holdsPermission(auth.permissions, keyOf(permission)));

    if (beyond) {
      throw forbidden(`You cannot change the permission ${keyOf(beyond)} because you do not hold it yourself.`);
    }

    // Account and access administration is delegated by Super Admin only: Admin cannot create another
    // user-administering role. Removing such a permission (one Admin holds) stays possible.
    const security = isSuperAdmin(auth.roles) ? undefined : added.find((permission) => SECURITY_MODULES.includes(permission.module));

    if (security) {
      throw forbidden(`Only Super Admin can give a role ${keyOf(security)}: account and access administration is delegated by Super Admin only.`);
    }

    // Security administration (Users & Access) stays out of the operational roles' reach.
    const outside = added.find((permission) => !isInRoleScope(role.code, permission.module, permission.action));

    if (outside) {
      throw forbidden(`The role "${role.name}" cannot be given ${keyOf(outside)}: account and access administration is reserved to Super Admin and Admin.`);
    }

    // Every action needs View of its module (and cancelling a contract needs Edit), so no role is left half-able.
    const problem = dependencyProblem(new Set(wanted.keys()));

    if (problem) {
      throw validationError(`${problem.key} also needs ${problem.missing}. Grant both, or neither.`);
    }

    for (const permission of removed) {
      await client.query("DELETE FROM role_permissions WHERE role_id = $1 AND module = $2 AND action = $3", [
        roleId,
        permission.module,
        permission.action,
      ]);
    }
    for (const permission of added) {
      await client.query("INSERT INTO role_permissions (role_id, module, action) VALUES ($1, $2, $3)", [
        roleId,
        permission.module,
        permission.action,
      ]);
    }

    await logActivity(client, {
      userId: auth.user.id,
      action: "role.permissions_changed",
      module: "USERS",
      entityType: "roles",
      entityId: roleId,
      description: `Permissions changed for role "${role.name}".`,
      metadata: { added: added.map(keyOf), removed: removed.map(keyOf) },
    });

    return findRole(auth, client, roleId);
  });
}

export interface NewRole {
  code: string;
  name: string;
  description: string | null;
}

export interface RoleChanges {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

/**
 * Adds a custom role. Super Admin, or Admin with Users & Access Edit. It starts with no permissions; they are
 * granted separately, so a new role can do nothing until someone who may manage it decides.
 */
export function createRole(auth: AuthContext, input: NewRole): Promise<Role> {
  assertRoleAdministrator(auth);

  // A built-in code carries fixed meaning (Super Admin, Admin, the scoped roles), so a custom role never takes one.
  if (isBuiltInRole(input.code)) {
    throw conflict("This code belongs to a built-in role. Choose another code.");
  }

  return withTransaction(async (client) => {
    const existing = await client.query("SELECT 1 FROM roles WHERE code = $1 OR lower(name) = lower($2)", [input.code, input.name]);

    if ((existing.rowCount ?? 0) > 0) {
      throw conflict("A role with this code or name already exists.");
    }

    const inserted = await client.query<{ id: string }>("INSERT INTO roles (code, name, description) VALUES ($1, $2, $3) RETURNING id", [
      input.code,
      input.name,
      input.description,
    ]);
    const id = (inserted.rows[0] as { id: string }).id;

    await logActivity(client, {
      userId: auth.user.id,
      action: "role.created",
      module: "USERS",
      entityType: "roles",
      entityId: id,
      description: `Role "${input.name}" (${input.code}) was added.`,
      metadata: { code: input.code },
    });

    return findRole(auth, client, id);
  });
}

/**
 * Changes a role's name, description or status (renaming, deactivating, reactivating). Super Admin for every
 * role, built-in roles included; Admin for a custom role it may manage. Its code never changes: permissions and
 * history refer to it.
 */
export function updateRole(auth: AuthContext, roleId: string, changes: RoleChanges): Promise<Role> {
  assertRoleAdministrator(auth);

  return withTransaction(async (client) => {
    await client.query("SELECT 1 FROM roles WHERE id = $1 FOR UPDATE", [roleId]);
    const role = await findRole(auth, client, roleId);

    assertManageable(role);

    if (changes.isActive === false && role.isActive) {
      if (role.code === ADMIN_ROLE_CODE) {
        throw forbidden("The Super Admin role cannot be deactivated.");
      }
      if (role.userCount > 0) {
        throw conflict(`${role.userCount} ${role.userCount === 1 ? "person still has" : "people still have"} this role. Move them to another role first.`);
      }
    }
    if (changes.name !== undefined && changes.name.toLowerCase() !== role.name.toLowerCase()) {
      const taken = await client.query("SELECT 1 FROM roles WHERE lower(name) = lower($1) AND id <> $2", [changes.name, roleId]);

      if ((taken.rowCount ?? 0) > 0) {
        throw conflict("A role with this name already exists.");
      }
    }

    const name = changes.name ?? role.name;
    const description = changes.description === undefined ? role.description : changes.description;
    const isActive = changes.isActive ?? role.isActive;

    if (name === role.name && description === role.description && isActive === role.isActive) {
      return role;
    }

    await client.query("UPDATE roles SET name = $2, description = $3, is_active = $4 WHERE id = $1", [roleId, name, description, isActive]);

    await logActivity(client, {
      userId: auth.user.id,
      action: "role.updated",
      module: "USERS",
      entityType: "roles",
      entityId: roleId,
      description: `Role "${role.name}" was updated.`,
      metadata: {
        ...(name !== role.name ? { name: { from: role.name, to: name } } : {}),
        ...(description !== role.description ? { description: "changed" } : {}),
        ...(isActive !== role.isActive ? { isActive: { from: role.isActive, to: isActive } } : {}),
      },
    });

    return findRole(auth, client, roleId);
  });
}

/** Deletes a custom role that nobody holds. Super Admin, or Admin for a role it may manage. A built-in role is never deleted. */
export function deleteRole(auth: AuthContext, roleId: string): Promise<void> {
  assertRoleAdministrator(auth);

  return withTransaction(async (client) => {
    await client.query("SELECT 1 FROM roles WHERE id = $1 FOR UPDATE", [roleId]);
    const role = await findRole(auth, client, roleId);

    // A built-in role is never deleted, by anyone: say so rather than "only Super Admin".
    if (!role.builtIn) assertManageable(role);
    if (role.builtIn) {
      throw forbidden("A built-in role cannot be deleted. Deactivate it instead.");
    }
    if (role.userCount > 0) {
      throw conflict(`${role.userCount} ${role.userCount === 1 ? "person still has" : "people still have"} this role. Move them to another role first.`);
    }

    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    await client.query("DELETE FROM roles WHERE id = $1", [roleId]);

    await logActivity(client, {
      userId: auth.user.id,
      action: "role.deleted",
      module: "USERS",
      entityType: "roles",
      entityId: roleId,
      description: `Role "${role.name}" (${role.code}) was deleted.`,
      metadata: { code: role.code, permissionsRemoved: role.permissions.length },
    });
  });
}
