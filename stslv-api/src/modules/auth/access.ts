import type { Queryable } from "../../shared/db";
import type { PermissionKey } from "../../shared/permissions";
import { schemaHas } from "../../shared/schema-features";
import { sectionOfItem } from "../../shared/visibility-catalog";

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
  /** Signed in with a temporary password: only the change-password screen is open to them. */
  mustChangePassword: boolean;
  /** The server-side session of this request (migration 0108), or null/absent before it. */
  sessionId?: string | null;
  /**
   * The page items hidden from this user by role visibility (see shared/visibility-catalog.ts). Absent or empty:
   * everything is visible. Read through shows(), never directly.
   */
  hidden?: ReadonlySet<string>;
}

/** Whether a page item (shared/visibility-catalog.ts) is visible to this user. */
export function shows(auth: Pick<AuthContext, "hidden">, key: string): boolean {
  return auth.hidden?.has(key) !== true;
}

/**
 * The page items hidden from a user by role visibility. An item is hidden only when EVERY active role of the user
 * that may open its page (holds the section's permission) hides it, the same union as permissions: one role
 * showing it is enough. A role that cannot open the page has no say. Empty before migration 0123.
 */
export async function loadUserHidden(db: Queryable, userId: string): Promise<Set<string>> {
  if (!(await schemaHas(["role_hidden_items"]))) return new Set();

  const result = await db.query<{ permissions: string[]; hidden: string[] }>(
    `SELECT COALESCE(ARRAY(SELECT rp.module || ':' || rp.action FROM role_permissions rp WHERE rp.role_id = r.id), '{}') AS permissions,
            COALESCE(ARRAY(SELECT h.item_key FROM role_hidden_items h WHERE h.role_id = r.id), '{}') AS hidden
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.is_active`,
    [userId]
  );
  const roles = result.rows.map((row) => ({ permissions: new Set(row.permissions), hidden: new Set(row.hidden) }));
  const hidden = new Set<string>();

  for (const key of new Set(roles.flatMap((role) => [...role.hidden]))) {
    const section = sectionOfItem(key);
    if (!section) continue;
    const deciding = roles.filter((role) => role.permissions.has(section.requires));
    if (deciding.length > 0 && deciding.every((role) => role.hidden.has(key))) hidden.add(key);
  }

  return hidden;
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
    // Page items hidden from this user by role visibility (display only: the API enforces them itself).
    hidden: [...(auth.hidden ?? [])].sort(),
    credentialChangeRequired: auth.mustChangePassword,
  };
}
