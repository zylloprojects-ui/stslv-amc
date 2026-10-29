import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, isUniqueViolation, notFound, validationError } from "../../shared/errors";
import { ADMIN_ROLE_CODE, holdsPermission, type PermissionKey } from "../../shared/permissions";
import { hasAdminAccess, isPrivilegedRole, isSuperAdmin } from "../../shared/role-model";
import { loadUserPermissions, type AuthContext, type RoleSummary } from "../auth/access";
import { hashPassword } from "../auth/password";
import { revokeResetTokens } from "../auth/password-reset.service";
import { generateTemporaryPassword, TEMPORARY_PASSWORD_MINUTES } from "../auth/temporary-password";
import { ONE_ROLE_MESSAGE, type CreateUserInput } from "./users.schemas";

/**
 * PENDING: requested from the Sign up page and not yet decided by an administrator.
 * REJECTED: the request was refused; the account is inactive and holds no role.
 */
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  approval_status: ApprovalStatus;
  last_login_at: Date | null;
  created_at: Date;
  temporary_password_expires_at: Date | null;
  roles: RoleSummary[];
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  approvalStatus: ApprovalStatus;
  lastLoginAt: string | null;
  createdAt: string;
  /** Set while a temporary password is outstanding: when it stops working. */
  temporaryCredentialExpiresAt: string | null;
  roles: RoleSummary[];
}

// password_hash is deliberately never selected here.
const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.is_active, u.approval_status, u.last_login_at, u.created_at,
         u.temporary_password_expires_at,
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
    approvalStatus: row.approval_status,
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    temporaryCredentialExpiresAt: row.temporary_password_expires_at ? row.temporary_password_expires_at.toISOString() : null,
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

  const roles = await db.query<{ id: string; code: string; name: string; is_active: boolean }>(
    "SELECT id, code, name, is_active FROM roles WHERE id = ANY($1::bigint[])",
    [roleIds]
  );

  if (roles.rows.length !== roleIds.length) {
    throw validationError("One or more selected roles do not exist.", [
      { field: "roleIds", message: "One or more selected roles do not exist." },
    ]);
  }

  const privileged = roles.rows.find((role) => isPrivilegedRole(role.code));

  if (privileged && !isSuperAdmin(auth.roles)) {
    throw forbidden(`Only Super Admin can assign the ${privileged.name} role.`);
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
  const beyond = permissions.rows.find((row) => !holdsPermission(auth.permissions, row.key));

  if (beyond) {
    throw forbidden(`You cannot assign the role "${beyond.name}" because it grants permissions you do not hold.`);
  }
}

/**
 * A user may only manage (edit, deactivate, reset the password of, change the
 * roles of) someone whose permissions do not exceed their own.
 */
async function assertCanManageUser(auth: AuthContext, db: Queryable, targetUserId: string): Promise<void> {
  // Super Admin and Admin accounts are managed by Super Admin only, whatever permissions Admin is given.
  if (!isSuperAdmin(auth.roles)) {
    const held = await db.query<{ code: string }>(
      "SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1",
      [targetUserId]
    );

    if (held.rows.some((row) => isPrivilegedRole(row.code))) {
      throw forbidden(PRIVILEGED_ACCOUNT_ONLY);
    }
  }

  const targetPermissions = await loadUserPermissions(db, targetUserId);

  for (const key of targetPermissions) {
    if (!holdsPermission(auth.permissions, key)) {
      throw forbidden("You cannot manage a user who holds permissions you do not hold.");
    }
  }
}

/** Active users, other than the given one, who hold the active Super Admin role (code ADMIN). */
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

/** Makes concurrent decisions about one user (approve, reject, change roles) happen one after the other. */
async function lockUser(db: Queryable, id: string): Promise<void> {
  await db.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [id]);
}

const isAdmin = (user: User) => user.roles.some((role) => role.code === ADMIN_ROLE_CODE);

const PRIVILEGED_ACCOUNT_ONLY = "Only Super Admin can manage Super Admin and Admin accounts.";

const ROLE_REQUIRED_TO_APPROVE = "Assign a role before approving this user.";
const ONE_ROLE_TO_APPROVE = "This user has more than one role. Choose one role before approving.";

/**
 * Why the user cannot be approved yet, or null: an approval gives exactly one active role
 * (one role per user, approved 2026-10-29). An inactive role grants nothing, so it does not count.
 * An account given several roles before the rule is not changed here; an administrator chooses one.
 */
async function approvalRoleProblem(db: Queryable, userId: string): Promise<string | null> {
  const result = await db.query<{ total: number; active: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.is_active)::int AS active
     FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId]
  );
  const { total, active } = result.rows[0] ?? { total: 0, active: 0 };

  if (total > 1) return ONE_ROLE_TO_APPROVE;
  if (active === 0) return ROLE_REQUIRED_TO_APPROVE;

  return null;
}

/** One role per user: the routes' schema checks it, and so does every service that assigns roles. */
function assertOneRole(roleIds: string[]): void {
  if (roleIds.length !== 1) {
    throw validationError(ONE_ROLE_MESSAGE, [{ field: "roleIds", message: ONE_ROLE_MESSAGE }]);
  }
}

export async function createUser(auth: AuthContext, input: CreateUserInput): Promise<User> {
  assertOneRole(input.roleIds);
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
    await lockUser(client, id);
    const before = await findUser(client, id);

    // Approving a sign-up request needs USERS:APPROVE; activating or deactivating an account needs USERS:EDIT.
    const required: PermissionKey = isActive && before.approvalStatus === "PENDING" ? "USERS:APPROVE" : "USERS:EDIT";

    if (!auth.permissions.has(required)) {
      throw forbidden();
    }

    if (!isActive && id === auth.user.id) {
      throw conflict("You cannot deactivate your own account.");
    }
    if (isActive && before.approvalStatus === "REJECTED") {
      throw conflict("This registration was rejected and cannot be activated. The person must submit a new request.");
    }

    await assertCanManageUser(auth, client, id);

    if (before.isActive === isActive) {
      return before;
    }

    if (!isActive && isAdmin(before) && (await countOtherActiveAdmins(client, id)) === 0) {
      throw conflict("This is the only active Super Admin. Assign the Super Admin role to another active user first.");
    }

    // Activating an account requested from the Sign up page is its approval.
    const approving = isActive && before.approvalStatus === "PENDING";

    // An approval must give access through exactly one active role, assigned first.
    const roleProblem = approving ? await approvalRoleProblem(client, id) : null;

    if (roleProblem) {
      throw conflict(roleProblem, [{ field: "roleIds", message: roleProblem }]);
    }

    await client.query(
      "UPDATE users SET is_active = $1, approval_status = CASE WHEN $1 THEN 'APPROVED' ELSE approval_status END WHERE id = $2",
      [isActive, id]
    );

    if (!isActive) {
      await revokeResetTokens(client, id);
    }

    await logActivity(client, {
      userId: auth.user.id,
      action: approving ? "user.registration_approved" : isActive ? "user.activated" : "user.deactivated",
      module: "USERS",
      entityType: "users",
      entityId: id,
      description: approving
        ? `Sign-up request of "${before.fullName}" (${before.email}) approved and the account activated.`
        : `User "${before.fullName}" ${isActive ? "activated" : "deactivated"}.`,
      ...(approving ? { metadata: { roles: before.roles.map((role) => role.code) } } : {}),
    });

    return findUser(client, id);
  });
}

/**
 * Refuses a sign-up request. Only a PENDING account can be rejected: an approved
 * or active account is never touched by this action. The account is kept for the
 * audit trail, stays inactive, loses any role it was given while pending and has
 * its reset links cancelled. The same email may submit a new request later.
 */
export function rejectRegistration(auth: AuthContext, id: string): Promise<User> {
  return withTransaction(async (client) => {
    await lockUser(client, id);
    const before = await findUser(client, id);

    if (before.approvalStatus !== "PENDING" || before.isActive) {
      throw conflict("Only a pending sign-up request can be rejected.");
    }

    await assertCanManageUser(auth, client, id);

    // The status is checked again inside the statement itself.
    const rejected = await client.query(
      "UPDATE users SET approval_status = 'REJECTED' WHERE id = $1 AND approval_status = 'PENDING' AND NOT is_active",
      [id]
    );

    if (rejected.rowCount !== 1) {
      throw conflict("Only a pending sign-up request can be rejected.");
    }

    await client.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
    await revokeResetTokens(client, id);
    await logActivity(client, {
      userId: auth.user.id,
      action: "user.registration_rejected",
      module: "USERS",
      entityType: "users",
      entityId: id,
      description: `Sign-up request of "${before.fullName}" (${before.email}) rejected.`,
      metadata: { removedRoles: before.roles.map((role) => role.code) },
    });

    return findUser(client, id);
  });
}

/**
 * Gives the user exactly one role (roleIds holds one id; the schema checks it), replacing
 * whatever they held before, in one transaction under the user's row lock.
 */
export function setUserRoles(auth: AuthContext, id: string, roleIds: string[]): Promise<User> {
  assertOneRole(roleIds);

  return withTransaction(async (client) => {
    await lockUser(client, id);
    const before = await findUser(client, id);

    if (id === auth.user.id) {
      throw conflict("You cannot change your own role. Ask another administrator.");
    }
    if (before.approvalStatus === "REJECTED") {
      throw conflict("This registration was rejected and cannot be given a role.");
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
      throw conflict("This is the only active Super Admin. Assign the Super Admin role to another active user first.");
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
      description: `Role of user "${before.fullName}" changed to ${updated.roles.map((role) => role.name).join(", ") || "none"}.`,
      metadata: {
        added: updated.roles.filter((role) => added.includes(role.id)).map((role) => role.code),
        removed: removed.map((role) => role.code),
      },
    });

    return updated;
  });
}

export interface IssuedTemporaryPassword {
  /** Shown to the administrator once. Never stored, logged or returned again. */
  temporaryPassword: string;
  expiresAt: string;
}

/**
 * Replaces a user's password with a random temporary one that must be changed at
 * the next sign-in, within TEMPORARY_PASSWORD_MINUTES. Only Super Admin or Admin may do this (Admin not for Super Admin or Admin accounts),
 * never for their own account, and only for an active account. The user is signed
 * out everywhere, and an earlier temporary password stops working.
 */
export async function issueTemporaryPassword(auth: AuthContext, id: string): Promise<IssuedTemporaryPassword> {
  // On top of USERS:EDIT (checked by the route): a role granted user editing does not get this.
  if (!hasAdminAccess(auth.roles)) {
    throw forbidden("Only an administrator can issue a temporary password.");
  }
  if (id === auth.user.id) {
    throw conflict("You cannot issue a temporary password for your own account. Change your password under My account.");
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return withTransaction(async (client) => {
    await lockUser(client, id);
    const target = await findUser(client, id);
    await assertCanManageUser(auth, client, id);

    if (!target.isActive) {
      throw conflict(
        target.approvalStatus === "APPROVED"
          ? "This account is deactivated. Activate it before issuing a temporary password."
          : "This account has not been approved. Approve it before issuing a temporary password."
      );
    }

    // Moving password_changed_at signs the user out of every existing session; the
    // new hash replaces the old password and any earlier temporary password.
    const updated = await client.query<{ expires_at: Date }>(
      `UPDATE users
       SET password_hash = $1, must_change_password = true,
           temporary_password_expires_at = now() + make_interval(mins => $2), password_changed_at = now()
       WHERE id = $3
       RETURNING temporary_password_expires_at AS expires_at`,
      [passwordHash, TEMPORARY_PASSWORD_MINUTES, id]
    );
    const expiresAt = (updated.rows[0] as { expires_at: Date }).expires_at.toISOString();

    await revokeResetTokens(client, id);
    await logActivity(client, {
      userId: auth.user.id,
      action: "user.temporary_password_issued",
      module: "USERS",
      entityType: "users",
      entityId: id,
      description: `Temporary password issued for user "${target.fullName}" (${target.email}).`,
      // Who, for whom and when are the entry itself; the password is never recorded.
      metadata: { identityVerified: true, expiresAt },
    });

    return { temporaryPassword, expiresAt };
  });
}
