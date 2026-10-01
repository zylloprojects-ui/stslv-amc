import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, isUniqueViolation, notFound, validationError } from "../../shared/errors";
import { ADMIN_ROLE_CODE, type PermissionKey } from "../../shared/permissions";
import { loadUserPermissions, type AuthContext, type RoleSummary } from "../auth/access";
import { hashPassword } from "../auth/password";
import type { CreateUserInput } from "./users.schemas";

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  roles: RoleSummary[];
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: RoleSummary[];
}

// password_hash is deliberately never selected here.
const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
         COALESCE(
           json_agg(json_build_object('id', r.id::text, 'code', r.code, 'name', r.name) ORDER BY r.name)
             FILTER (WHERE r.id IS NOT NULL),
           '[]'
         ) AS roles
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id = ur.role_id`;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    roles: row.roles,
  };
}

export async function listUsers(): Promise<User[]> {
  const result = await pool.query<UserRow>(`${USER_SELECT} GROUP BY u.id ORDER BY lower(u.full_name), u.id`);

  return result.rows.map(toUser);
}

async function findUser(db: Queryable, id: string): Promise<User> {
  const result = await db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("User not found.");
  }

  return toUser(row);
}

/**
 * A user may only hand out a role whose permissions they hold themselves.
 * This stops anyone with user-management access from granting more than they have.
 */
async function assertCanGrantRoles(auth: AuthContext, db: Queryable, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) {
    return;
  }

  const roles = await db.query<{ id: string; name: string; is_active: boolean }>(
    "SELECT id, name, is_active FROM roles WHERE id = ANY($1::bigint[])",
    [roleIds]
  );

  if (roles.rows.length !== roleIds.length) {
    throw validationError("One or more selected roles do not exist.", [
      { field: "roleIds", message: "One or more selected roles do not exist." },
    ]);
  }

  const inactive = roles.rows.find((role) => !role.is_active);

  if (inactive) {
    throw validationError(`The role "${inactive.name}" is inactive and cannot be assigned.`, [
      { field: "roleIds", message: `The role "${inactive.name}" is inactive and cannot be assigned.` },
    ]);
  }

  const permissions = await db.query<{ name: string; key: PermissionKey }>(
    `SELECT r.name, rp.module || ':' || rp.action AS key
     FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     WHERE rp.role_id = ANY($1::bigint[])`,
    [roleIds]
  );
  const beyond = permissions.rows.find((row) => !auth.permissions.has(row.key));

  if (beyond) {
    throw forbidden(`You cannot assign the role "${beyond.name}" because it grants permissions you do not hold.`);
  }
}

/**
 * A user may only manage (edit, deactivate, reset the password of, change the
 * roles of) someone whose permissions do not exceed their own.
 */
async function assertCanManageUser(auth: AuthContext, db: Queryable, targetUserId: string): Promise<void> {
  const targetPermissions = await loadUserPermissions(db, targetUserId);

  for (const key of targetPermissions) {
    if (!auth.permissions.has(key)) {
      throw forbidden("You cannot manage a user who holds permissions you do not hold.");
    }
  }
}

/** Active users, other than the given one, who hold the active Admin role. */
async function countOtherActiveAdmins(db: Queryable, excludingUserId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(DISTINCT u.id)::int AS count
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = $1 AND r.is_active AND u.is_active AND u.id <> $2`,
    [ADMIN_ROLE_CODE, excludingUserId]
  );

  return result.rows[0]?.count ?? 0;
}

const isAdmin = (user: User) => user.roles.some((role) => role.code === ADMIN_ROLE_CODE);

export async function createUser(auth: AuthContext, input: CreateUserInput): Promise<User> {
  const passwordHash = await hashPassword(input.password);

  try {
    return await withTransaction(async (client) => {
      await assertCanGrantRoles(auth, client, input.roleIds);

      const inserted = await client.query<{ id: string }>(
        "INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [input.email, input.fullName, passwordHash]
      );
      const userId = (inserted.rows[0] as { id: string }).id;

      await client.query(
        "INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::bigint[])",
        [userId, input.roleIds]
      );

      const created = await findUser(client, userId);

      await logActivity(client, {
        userId: auth.user.id,
        action: "user.created",
        module: "USERS",
        entityType: "users",
        entityId: userId,
        description: `User "${created.fullName}" (${created.email}) created.`,
        metadata: { roles: created.roles.map((role) => role.code) },
      });

      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_uq")) {
      throw conflict("A user with this email already exists.", [
        { field: "email", message: "A user with this email already exists." },
      ]);
    }
    throw error;
  }
}

export function updateUser(auth: AuthContext, id: string, fullName: string): Promise<User> {
  return withTransaction(async (client) => {
    const before = await findUser(client, id);
    await assertCanManageUser(auth, client, id);

    if (before.fullName === fullName) {
      return before;
    }

    await client.query("UPDATE users SET full_name = $1 WHERE id = $2", [fullName, id]);
    await logActivity(client, {
      userId: auth.user.id,
      action: "user.updated",
      module: "USERS",
      entityType: "users",
      entityId: id,
      description: `User "${fullName}" updated.`,
      metadata: { changes: { fullName: { from: before.fullName, to: fullName } } },
    });

    return findUser(client, id);
  });
}

export function setUserActive(auth: AuthContext, id: string, isActive: boolean): Promise<User> {
  return withTransaction(async (client) => {
    const before = await findUser(client, id);

    if (!isActive && id === auth.user.id) {
      throw conflict("You cannot deactivate your own account.");
    }

    await assertCanManageUser(auth, client, id);

    if (before.isActive === isActive) {
      return before;
    }

    if (!isActive && isAdmin(before) && (await countOtherActiveAdmins(client, id)) === 0) {
      throw conflict("This is the only active Admin. Assign the Admin role to another active user first.");
    }

    await client.query("UPDATE users SET is_active = $1 WHERE id = $2", [isActive, id]);
    await logActivity(client, {
      userId: auth.user.id,
      action: isActive ? "user.activated" : "user.deactivated",
      module: "USERS",
      entityType: "users",
      entityId: id,
      description: `User "${before.fullName}" ${isActive ? "activated" : "deactivated"}.`,
    });

    return findUser(client, id);
  });
}

export function setUserRoles(auth: AuthContext, id: string, roleIds: string[]): Promise<User> {
  return withTransaction(async (client) => {
    const before = await findUser(client, id);

    if (id === auth.user.id) {
      throw conflict("You cannot change your own roles. Ask another administrator.");
    }

    await assertCanManageUser(auth, client, id);

    const currentIds = before.roles.map((role) => role.id);
    const added = roleIds.filter((roleId) => !currentIds.includes(roleId));
    const removed = before.roles.filter((role) => !roleIds.includes(role.id));

    if (added.length === 0 && removed.length === 0) {
      return before;
    }

    await assertCanGrantRoles(auth, client, added);

    if (
      before.isActive &&
      removed.some((role) => role.code === ADMIN_ROLE_CODE) &&
      (await countOtherActiveAdmins(client, id)) === 0
    ) {
      throw conflict("This is the only active Admin. Assign the Admin role to another active user first.");
    }

    await client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::bigint[])", [
      id,
      removed.map((role) => role.id),
    ]);
    await client.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, unnest($2::bigint[])", [id, added]);

    const updated = await findUser(client, id);

    await logActivity(client, {
      userId: auth.user.id,
      action: "user.roles_changed",
      module: "USERS",
      entityType: "users",
      entityId: id,
      description: `Roles changed for user "${before.fullName}".`,
      metadata: {
        added: updated.roles.filter((role) => added.includes(role.id)).map((role) => role.code),
        removed: removed.map((role) => role.code),
      },
    });

    return updated;
  });
}

export async function resetUserPassword(auth: AuthContext, id: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);

  await withTransaction(async (client) => {
    const target = await findUser(client, id);
    await assertCanManageUser(auth, client, id);

    // Moving password_changed_at signs the user out of every existing session.
    await client.query("UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2", [
      passwordHash,
      id,
    ]);
    await logActivity(client, {
      userId: auth.user.id,
      action: "user.password_reset",
      module: "USERS",
      entityType: "users",
      entityId: id,
      description: `Password reset for user "${target.fullName}".`,
    });
  });
}
