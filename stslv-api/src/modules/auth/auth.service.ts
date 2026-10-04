import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction } from "../../shared/db";
import { AppError, unauthorized, validationError } from "../../shared/errors";
import { loadUserPermissions, loadUserRoles, toSessionUser, type AuthContext } from "./access";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";
import { revokeResetTokens } from "./password-reset.service";
import { issueToken } from "./token";

// One message for every failure, so the response does not reveal whether the email exists.
const invalidCredentials = () => new AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");

export async function login(email: string, password: string) {
  const result = await pool.query<{
    id: string;
    email: string;
    full_name: string;
    password_hash: string;
    is_active: boolean;
  }>("SELECT id, email, full_name, password_hash, is_active FROM users WHERE lower(email) = $1", [email]);
  const user = result.rows[0];

  if (!user) {
    await verifyAgainstDummy(password);
    throw invalidCredentials();
  }

  const passwordMatches = await verifyPassword(password, user.password_hash);

  if (!passwordMatches || !user.is_active) {
    throw invalidCredentials();
  }

  await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  await logActivity(pool, {
    userId: user.id,
    action: "auth.login",
    module: "AUTH",
    entityType: "users",
    entityId: user.id,
    description: `${user.full_name} signed in.`,
  });

  const [roles, permissions] = await Promise.all([loadUserRoles(pool, user.id), loadUserPermissions(pool, user.id)]);
  const auth: AuthContext = {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    roles,
    permissions,
  };

  return { ...issueToken(user.id), user: toSessionUser(auth) };
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
