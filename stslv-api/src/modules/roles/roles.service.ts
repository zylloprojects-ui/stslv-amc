import { createHash } from "node:crypto";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { isGrantable } from "../../shared/permission-catalog";
import { ADMIN_ROLE_CODE, holdsPermission, permissionKey, type Action, type Module, type PermissionKey } from "../../shared/permissions";
import { dependencyProblem, isBuiltInRole, isInRoleScope, isPrivilegedRole, isSuperAdmin, roleScope } from "../../shared/role-model";
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
  /** Whether the signed-in user may change this role's permissions: only Super Admin, and never Super Admin's own. */
  permissionsEditable: boolean;
  /** Why the signed-in user cannot change the permissions, or null. */
  lockedReason: string | null;
  /**
   * Identifies the saved permission set. A save sends the version it started from and is refused
   * (409) when the set has changed since, so two administrators never silently overwrite each other.
   */
  permissionsVersion: string;
  /** Defined by the migrations: never deleted; renamed, deactivated or reactivated only by Super Admin. */
  builtIn: boolean;
  /** The permissions this role may be given ("MODULE:ACTION"), or null when it may be given any grantable permission. */
  scope: PermissionKey[] | null;
  /** Whether the signed-in user may give this role to someone: active, and within their own authority. */
  assignable: boolean;
}

const SUPER_ADMIN_LOCKED = "Super Admin always has full access. Its permissions cannot be changed.";
const SUPER_ADMIN_ONLY = "Only Super Admin can change role permissions.";
const ROLE_CHANGES_SUPER_ADMIN_ONLY = "Only Super Admin can change roles and their permissions.";
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

/** Why the signed-in user may not change this role's permissions: only Super Admin may, and never Super Admin's own. */
function lockedReason(auth: AuthContext, code: string): string | null {
  if (code === ADMIN_ROLE_CODE) return SUPER_ADMIN_LOCKED;
  if (!isSuperAdmin(auth.roles)) return SUPER_ADMIN_ONLY;
  return null;
}

/** A short fingerprint of a permission set, independent of order. */
export function permissionsVersionOf(permissions: Permission[]): string {
  const keys = permissions.map((permission) => keyOf(permission)).sort();
  return createHash("sha256").update(keys.join(",")).digest("hex").slice(0, 16);
}

function toRole(auth: AuthContext, row: RoleRow): Role {
  const locked = lockedReason(auth, row.code);

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

/** Role definitions are changed by Super Admin only (the routes check the same). */
function assertSuperAdmin(auth: AuthContext): void {
  if (!isSuperAdmin(auth.roles)) {
    throw forbidden(ROLE_CHANGES_SUPER_ADMIN_ONLY);
  }
}

const keyOf = (permission: Permission): PermissionKey => permissionKey(permission.module, permission.action);

/**
 * Replaces a role's permission set with the given one. Super Admin only. expectedVersion is the
 * permissionsVersion the change started from: a set changed meanwhile is not overwritten (409).
 */
export function setRolePermissions(auth: AuthContext, roleId: string, permissions: Permission[], expectedVersion: string): Promise<Role> {
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

/** Adds a custom role. Super Admin only. It starts with no permissions; they are granted separately, so a new role can do nothing until Super Admin decides. */
export function createRole(auth: AuthContext, input: NewRole): Promise<Role> {
  assertSuperAdmin(auth);

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
 * Changes a role's name, description or status (renaming, deactivating, reactivating). Super Admin
 * only, built-in roles included. Its code never changes: permissions and history refer to it.
 */
export function updateRole(auth: AuthContext, roleId: string, changes: RoleChanges): Promise<Role> {
  assertSuperAdmin(auth);

  return withTransaction(async (client) => {
    await client.query("SELECT 1 FROM roles WHERE id = $1 FOR UPDATE", [roleId]);
    const role = await findRole(auth, client, roleId);

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

/** Deletes a custom role that nobody holds. Super Admin only. A built-in role is never deleted. */
export function deleteRole(auth: AuthContext, roleId: string): Promise<void> {
  assertSuperAdmin(auth);

  return withTransaction(async (client) => {
    await client.query("SELECT 1 FROM roles WHERE id = $1 FOR UPDATE", [roleId]);
    const role = await findRole(auth, client, roleId);

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
