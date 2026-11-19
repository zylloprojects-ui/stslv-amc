import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, isUniqueViolation } from "../../shared/errors";
import { ADMIN_ROLE_CODE } from "../../shared/permissions";
import { schemaHas } from "../../shared/schema-features";
import type { AuthContext } from "../auth/access";
import { hashPassword } from "../auth/password";
import { revokeResetTokens } from "../auth/password-reset.service";
import { revokeUserSessions } from "../auth/sessions.service";
import { generateTemporaryPassword, TEMPORARY_PASSWORD_MINUTES } from "../auth/temporary-password";

// The one protected Super Admin account (migration 0119; procedure in docs/PROTECTED_SUPER_ADMIN.md).
//
// It is identified by its user id, recorded in protected_accounts, never by its name or email. Only the account
// itself may act on its own account; every other administrator, Super Admin included, is refused on every
// user-management action (users.service.ts calls assertMayManageProtectedAccount from its one shared check).
// The database adds a second line of defence: the account keeps the Super Admin role and stays active whatever
// path writes to it, and the protection record can be added once and never moved.
//
// The protection is created and recovered only by server-side scripts (shell access to the server is the
// authorization). No API endpoint creates, moves or removes it.

export const PROTECTED_ACCOUNT_MESSAGE = "This account is protected. Only its owner can manage it.";

/**
 * The protected account's user id, or null when none has been created. On a database without migration 0119 there
 * is none either, so user management works exactly as before the migration instead of failing.
 */
export async function protectedAccountId(db: Queryable): Promise<string | null> {
  if (!(await schemaHas(["protected_accounts"]))) {
    return null;
  }

  const result = await db.query<{ user_id: string }>("SELECT user_id::text AS user_id FROM protected_accounts");

  return result.rows[0]?.user_id ?? null;
}

/**
 * Refuses anyone but the account itself when the target is the protected account. Called for every
 * user-management action, including reading its sessions: another administrator learns nothing about them.
 */
export async function assertMayManageProtectedAccount(auth: AuthContext, db: Queryable, targetUserId: string): Promise<void> {
  if (targetUserId === auth.user.id) {
    return;
  }

  const protectedId = await protectedAccountId(db);

  if (protectedId !== null && protectedId === String(targetUserId)) {
    throw forbidden(PROTECTED_ACCOUNT_MESSAGE);
  }
}

export interface TemporaryCredential {
  userId: string;
  email: string;
  /** Shown once to the operator who ran the script. Never stored, logged or returned again. */
  temporaryPassword: string;
  expiresAt: string;
}

/**
 * One-time bootstrap: creates a new, active Super Admin and records it as the protected account, in one
 * transaction. Refused when a protected account already exists or the email is taken (an existing account is
 * never turned into the protected one). The account starts with a random temporary password that must be
 * replaced at the first sign-in, within TEMPORARY_PASSWORD_MINUTES, so the operator never knows the real one.
 */
export async function bootstrapProtectedAdmin(input: { email: string; fullName: string }): Promise<TemporaryCredential> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    return await withTransaction(async (client) => {
      // Serialises two bootstrap runs: the second waits, then sees the first one's row.
      await client.query("LOCK TABLE protected_accounts IN SHARE ROW EXCLUSIVE MODE");

      if ((await protectedAccountId(client)) !== null) {
        throw conflict("A protected account already exists. Nothing was changed. Use the recovery procedure instead.");
      }

      const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE code = $1 AND is_active", [ADMIN_ROLE_CODE]);
      const roleId = role.rows[0]?.id;

      if (!roleId) {
        throw conflict("The Super Admin role does not exist or is inactive. Nothing was changed.");
      }

      const inserted = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO users (email, full_name, password_hash, must_change_password, temporary_password_expires_at)
         VALUES ($1, $2, $3, true, now() + make_interval(mins => $4))
         RETURNING id::text AS id, temporary_password_expires_at AS expires_at`,
        [input.email, input.fullName, passwordHash, TEMPORARY_PASSWORD_MINUTES]
      );
      const { id: userId, expires_at } = inserted.rows[0] as { id: string; expires_at: Date };

      await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleId]);
      await client.query("INSERT INTO protected_accounts (user_id) VALUES ($1)", [userId]);
      await logActivity(client, {
        userId: null,
        action: "user.protected_account_created",
        module: "USERS",
        entityType: "users",
        entityId: userId,
        description: `Protected Super Admin "${input.fullName}" (${input.email}) created by the server bootstrap script.`,
        metadata: { roles: [ADMIN_ROLE_CODE], source: "admin:bootstrap-protected script" },
      });

      return { userId, email: input.email, temporaryPassword, expiresAt: expires_at.toISOString() };
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_uq")) {
      throw conflict(`A user with the email ${input.email} already exists. Nothing was changed.`);
    }
    throw error;
  }
}

/**
 * Emergency recovery, run on the server by an authorized operator: the protected account is made active and
 * approved, holds exactly the Super Admin role again, gets a new temporary password (to be replaced at the next
 * sign-in) and is signed out everywhere. `confirmEmail` must be the protected account's current email, so the
 * operator states which account they are recovering. Every change is recorded in the audit log.
 */
export async function recoverProtectedAdmin(confirmEmail: string): Promise<TemporaryCredential> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return withTransaction(async (client) => {
    const protectedId = await protectedAccountId(client);

    if (protectedId === null) {
      throw conflict("There is no protected account to recover. Nothing was changed.");
    }

    await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [protectedId]);
    const user = await client.query<{ email: string; full_name: string; is_active: boolean; approval_status: string }>(
      "SELECT email, full_name, is_active, approval_status FROM users WHERE id = $1",
      [protectedId]
    );
    const before = user.rows[0] as { email: string; full_name: string; is_active: boolean; approval_status: string };

    if (before.email.toLowerCase() !== confirmEmail.trim().toLowerCase()) {
      throw conflict("The email does not match the protected account. Nothing was changed.");
    }

    const roles = await client.query<{ id: string; code: string }>(
      "SELECT r.id::text AS id, r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1",
      [protectedId]
    );
    const adminRole = await client.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE code = $1", [ADMIN_ROLE_CODE]);
    const adminRoleId = (adminRole.rows[0] as { id: string }).id;
    const otherRoles = roles.rows.filter((role) => role.code !== ADMIN_ROLE_CODE);
    const hadAdmin = roles.rows.some((role) => role.code === ADMIN_ROLE_CODE);

    // One role per user: Super Admin only.
    if (otherRoles.length > 0) {
      await client.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::bigint[])", [protectedId, otherRoles.map((role) => role.id)]);
    }
    if (!hadAdmin) {
      await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [protectedId, adminRoleId]);
    }

    const updated = await client.query<{ expires_at: Date }>(
      `UPDATE users
       SET is_active = true, approval_status = 'APPROVED', password_hash = $1, must_change_password = true,
           temporary_password_expires_at = now() + make_interval(mins => $2), password_changed_at = now()
       WHERE id = $3
       RETURNING temporary_password_expires_at AS expires_at`,
      [passwordHash, TEMPORARY_PASSWORD_MINUTES, protectedId]
    );
    const expiresAt = (updated.rows[0] as { expires_at: Date }).expires_at.toISOString();

    await revokeResetTokens(client, protectedId);
    const sessionsEnded = await revokeUserSessions(client, { userId: protectedId, reason: "TEMPORARY_PASSWORD", by: null });
    await logActivity(client, {
      userId: null,
      action: "user.protected_account_recovered",
      module: "USERS",
      entityType: "users",
      entityId: protectedId,
      description: `Protected Super Admin "${before.full_name}" (${before.email}) recovered by the server recovery script: temporary password issued.`,
      // The password is never recorded.
      metadata: {
        source: "admin:recover-protected script",
        reactivated: !before.is_active || before.approval_status !== "APPROVED",
        superAdminRestored: !hadAdmin,
        removedRoles: otherRoles.map((role) => role.code),
        sessionsEnded,
        expiresAt,
      },
    });

    return { userId: protectedId, email: before.email, temporaryPassword, expiresAt };
  });
}
