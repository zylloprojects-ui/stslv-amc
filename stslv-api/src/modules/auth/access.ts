import type { Queryable } from "../../shared/db";
import type { PermissionKey } from "../../shared/permissions";

export interface RoleSummary {
  id: string;
  code: string;
  name: string;
}

export interface AuthContext {
  user: { id: string; email: string; fullName: string };
  roles: RoleSummary[];
  /** Union of the permissions of the user's active roles. */
  permissions: ReadonlySet<PermissionKey>;
}

/** Active roles assigned to a user. */
export async function loadUserRoles(db: Queryable, userId: string): Promise<RoleSummary[]> {
  const result = await db.query<RoleSummary>(
    `SELECT r.id, r.code, r.name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.is_active
     ORDER BY r.name`,
    [userId]
  );

  return result.rows;
}

/** Effective permissions of a user: every permission of every active role they hold. */
export async function loadUserPermissions(db: Queryable, userId: string): Promise<Set<PermissionKey>> {
  const result = await db.query<{ key: PermissionKey }>(
    `SELECT DISTINCT rp.module || ':' || rp.action AS key
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     WHERE ur.user_id = $1 AND r.is_active`,
    [userId]
  );

  return new Set(result.rows.map((row) => row.key));
}

/** The session payload returned by login and /auth/me. Never includes the password hash. */
export function toSessionUser(auth: AuthContext) {
  return {
    id: auth.user.id,
    email: auth.user.email,
    fullName: auth.user.fullName,
    roles: auth.roles,
    permissions: [...auth.permissions].sort(),
  };
}
