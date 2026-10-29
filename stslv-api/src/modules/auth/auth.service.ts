import { pool } from "../../config/database";
import { TEMPORARY_PASSWORD_EXPIRED_MESSAGE } from "../../middleware/authenticate";
import { logActivity } from "../../shared/activity-log";
import { withTransaction } from "../../shared/db";
import { AppError, unauthorized, validationError } from "../../shared/errors";
import { loadUserPermissions, loadUserRoles, toSessionUser, type AuthContext } from "./access";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";
import { revokeResetTokens } from "./password-reset.service";
import { issueToken } from "./token";

// One message for every failure, so the response does not reveal whether the email exists.
const invalidCredentials = () => new AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");

type LoginFailureReason = "unknown_account" | "wrong_password" | "inactive_account" | "temporary_password_expired";

/**
 * Records a failed sign-in. Every failure writes one entry, so the response takes
 * the same time whether or not the email has an account. An email with no account
 * is not stored: people sometimes type their password into the email field.
 */
async function recordFailedLogin(
  user: { id: string; full_name: string } | undefined,
  reason: LoginFailureReason,
  ip: string | null
) {
  await logActivity(pool, {
    userId: null,
    action: "auth.login_failed",
    module: "AUTH",
    entityType: "users",
    entityId: user?.id ?? null,
    description: user ? `Failed sign-in for ${user.full_name}.` : "Failed sign-in for an email with no account.",
    metadata: { reason, ip },
  });
}

export async function login(email: string, password: string, context: { ip: string | null } = { ip: null }) {
  const result = await pool.query<{
    id: string;
    email: string;
    full_name: string;
    password_hash: string;
    is_active: boolean;
    must_change_password: boolean;
    temporary_password_expired: boolean;
  }>(
    `SELECT id, email, full_name, password_hash, is_active, must_change_password,
            COALESCE(temporary_password_expires_at <= now(), false) AS temporary_password_expired
     FROM users WHERE lower(email) = $1`,
    [email]
  );
  const user = result.rows[0];

  if (!user) {
    await verifyAgainstDummy(password);
    await recordFailedLogin(undefined, "unknown_account", context.ip);
    throw invalidCredentials();
  }

  const passwordMatches = await verifyPassword(password, user.password_hash);

  if (!passwordMatches || !user.is_active) {
    await recordFailedLogin(user, passwordMatches ? "inactive_account" : "wrong_password", context.ip);
    throw invalidCredentials();
  }
  // Said plainly, because only someone who typed the right temporary password gets this far.
  if (user.must_change_password && user.temporary_password_expired) {
    await recordFailedLogin(user, "temporary_password_expired", context.ip);
    throw new AppError(401, "TEMPORARY_PASSWORD_EXPIRED", TEMPORARY_PASSWORD_EXPIRED_MESSAGE);
  }

  await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  await logActivity(pool, {
    userId: user.id,
    action: "auth.login",
    module: "AUTH",
    entityType: "users",
    entityId: user.id,
    description: user.must_change_password
      ? `${user.full_name} signed in with a temporary password.`
      : `${user.full_name} signed in.`,
    metadata: user.must_change_password ? { ip: context.ip, temporaryPassword: true } : { ip: context.ip },
  });

  const [roles, permissions] = await Promise.all([loadUserRoles(pool, user.id), loadUserPermissions(pool, user.id)]);
  const auth: AuthContext = {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    roles,
    permissions,
    mustChangePassword: user.must_change_password,
  };

  return { ...issueToken(user.id, { passwordChange: user.must_change_password }), user: toSessionUser(auth) };
}

/**
 * Replaces a temporary password with one the user chooses. Every session of the
 * account ends, including the one used here: the user signs in again with the new password.
 */
export async function completeRequiredPasswordChange(auth: AuthContext, newPassword: string): Promise<void> {
  if (!auth.mustChangePassword) {
    throw new AppError(409, "PASSWORD_CHANGE_NOT_REQUIRED", "Your password does not need to be changed. Use My account instead.");
  }

  const current = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [auth.user.id]);
  const row = current.rows[0];

  if (!row) {
    throw unauthorized();
  }
  if (await verifyPassword(newPassword, row.password_hash)) {
    throw validationError("Choose a password different from the temporary one.", [
      { field: "newPassword", message: "Choose a password different from the temporary one." },
    ]);
  }

  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async (client) => {
    // Matches only while the temporary password is still outstanding and unexpired, so
    // two submissions at once, or one after a reissue or expiry, cannot both succeed.
    const updated = await client.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = false, temporary_password_expires_at = NULL, password_changed_at = now()
       WHERE id = $2 AND is_active AND must_change_password AND temporary_password_expires_at > now()`,
      [passwordHash, auth.user.id]
    );

    if (updated.rowCount !== 1) {
      throw unauthorized("Your session is no longer valid. Please sign in again.");
    }

    await revokeResetTokens(client, auth.user.id);
    await logActivity(client, {
      userId: auth.user.id,
      action: "auth.temporary_password_replaced",
      module: "AUTH",
      entityType: "users",
      entityId: auth.user.id,
      description: `${auth.user.fullName} replaced their temporary password with a new password.`,
    });
  });
}

export async function changeOwnPassword(auth: AuthContext, currentPassword: string, newPassword: string) {
  const result = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
    auth.user.id,
  ]);
  const row = result.rows[0];

  if (!row) {
    throw unauthorized();
  }
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw validationError("The current password is incorrect.", [
      { field: "currentPassword", message: "The current password is incorrect." },
    ]);
  }
  if (currentPassword === newPassword) {
    throw validationError("The new password must be different from the current password.", [
      { field: "newPassword", message: "The new password must be different from the current password." },
    ]);
  }

  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async (client) => {
    // Moving password_changed_at invalidates every token issued before now.
    await client.query("UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2", [
      passwordHash,
      auth.user.id,
    ]);
    // A reset link requested before this change must not be able to undo it.
    await revokeResetTokens(client, auth.user.id);
    await logActivity(client, {
      userId: auth.user.id,
      action: "auth.password_changed",
      module: "AUTH",
      entityType: "users",
      entityId: auth.user.id,
      description: `${auth.user.fullName} changed their own password.`,
    });
  });

  // A fresh token so the current session continues.
  return issueToken(auth.user.id);
}
