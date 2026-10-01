import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { forbidden, notFound } from "../../shared/errors";
import { ADMIN_ROLE_CODE, permissionKey, type Action, type Module, type PermissionKey } from "../../shared/permissions";
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
  /** False for the built-in Admin role, whose permissions are fixed. */
  permissionsEditable: boolean;
}

const ROLE_SELECT = `
  SELECT r.id, r.code, r.name, r.description, r.is_active,
         (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
         COALESCE(
           (SELECT json_agg(json_build_object('module', rp.module, 'action', rp.action) ORDER BY rp.module, rp.action)
            FROM role_permissions rp WHERE rp.role_id = r.id),
           '[]'
         ) AS permissions
  FROM roles r`;

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    userCount: row.user_count,
    permissions: row.permissions,
    permissionsEditable: row.code !== ADMIN_ROLE_CODE,
  };
}

export async function listRoles(): Promise<Role[]> {
  const result = await pool.query<RoleRow>(`${ROLE_SELECT} ORDER BY r.id`);

  return result.rows.map(toRole);
}

async function findRole(db: Queryable, id: string): Promise<Role> {
  const result = await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Role not found.");
  }

  return toRole(row);
}

const keyOf = (permission: Permission): PermissionKey => permissionKey(permission.module, permission.action);

/** Replaces a role's permission set with the given one. */
export function setRolePermissions(auth: AuthContext, roleId: string, permissions: Permission[]): Promise<Role> {
  return withTransaction(async (client) => {
    // Lock the role so two concurrent edits cannot interleave.
    await client.query("SELECT 1 FROM roles WHERE id = $1 FOR UPDATE", [roleId]);
    const role = await findRole(client, roleId);

    if (!role.permissionsEditable) {
      throw forbidden("The Admin role always has full access. Its permissions cannot be changed.");
    }

    const wanted = new Map(permissions.map((permission) => [keyOf(permission), permission]));
    const current = new Map(role.permissions.map((permission) => [keyOf(permission), permission]));
    const added = [...wanted.values()].filter((permission) => !current.has(keyOf(permission)));
    const removed = [...current.values()].filter((permission) => !wanted.has(keyOf(permission)));

    if (added.length === 0 && removed.length === 0) {
      return role;
    }

    // Nobody may grant or revoke a permission they do not hold themselves.
    const beyond = [...added, ...removed].find((permission) => !auth.permissions.has(keyOf(permission)));

    if (beyond) {
      throw forbidden(`You cannot change the permission ${keyOf(beyond)} because you do not hold it yourself.`);
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

    return findRole(client, roleId);
  });
}
