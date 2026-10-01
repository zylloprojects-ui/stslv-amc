import { createHash, randomBytes } from "node:crypto";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { AppError } from "../../shared/errors";
import { sendInBackground } from "../../shared/mailer";
import { hashPassword } from "./password";

// A reset token is 32 random bytes from the operating system, sent to the user
// inside a link. It is unrelated to the login token (JWT) and cannot be used as
// one. Only its SHA-256 hash is stored: the token is long and random, so a fast
// hash is enough, and a copy of the table cannot be turned back into tokens.

export type ResetTokenState = "valid" | "invalid" | "expired" | "used";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cancels every outstanding reset token of a user. Call it whenever their password or access changes. */
export async function revokeResetTokens(db: Queryable, userId: string): Promise<void> {
  await db.query(
    "UPDATE password_reset_tokens SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
    [userId]
  );
}

/**
 * Starts a password reset for the account with this email, if there is an
 * active one. Resolves the same way when there is not, so the public response
 * does not reveal which emails have accounts.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const found = await pool.query<{ id: string; email: string; full_name: string; is_active: boolean }>(
    "SELECT id, email, full_name, is_active FROM users WHERE lower(email) = $1",
    [email]
  );
  const user = found.rows[0];

  // Unknown, deactivated or not-yet-approved accounts get no token.
  if (!user || !user.is_active) {
    return;
  }

  const token = randomBytes(32).toString("base64url");

  await withTransaction(async (client) => {
    // Serialises two requests for the same user, so only the later token survives.
    await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [user.id]);
    await revokeResetTokens(client, user.id);
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [user.id, hashToken(token), env.passwordResetMinutes]
    );
    await logActivity(client, {
      userId: user.id,
      action: "auth.password_reset_requested",
      module: "AUTH",
      entityType: "users",
      entityId: user.id,
      description: `A password reset link was requested for ${user.full_name}.`,
    });
  });

  // The token travels in the part of the address after "#", which browsers do
  // not send to any server, so it stays out of web server logs.
  sendInBackground({
    to: user.email,
    subject: "Reset your STSLEV AMC password",
    text: [
      `Hello ${user.full_name},`,
      "",
      "We received a request to reset the password of your STSLEV AMC account.",
      "Open this link to choose a new password:",
      "",
      `${env.appUrl}/reset-password#token=${token}`,
      "",
      `The link works once and expires in ${env.passwordResetMinutes} minutes.`,
      "If you did not ask for this, ignore this message: your password stays as it is.",
      "",
      "Smart Technical Service LLC",
    ].join("\n"),
  });
}

interface TokenRow {
  id: string;
  user_id: string;
  full_name: string;
  is_active: boolean;
  used_at: Date | null;
  revoked_at: Date | null;
  expired: boolean;
}

async function findToken(db: Queryable, token: string, lock = false): Promise<TokenRow | undefined> {
  const result = await db.query<TokenRow>(
    `SELECT t.id, t.user_id, u.full_name, u.is_active, t.used_at, t.revoked_at, t.expires_at <= now() AS expired
     FROM password_reset_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1${lock ? " FOR UPDATE OF t" : ""}`,
    [hashToken(token)]
  );

  return result.rows[0];
}

function stateOf(row: TokenRow | undefined): ResetTokenState {
  if (!row) {
    return "invalid";
  }
  if (row.used_at) {
    return "used";
  }
  // Replaced by a newer link, or the account can no longer sign in.
  if (row.revoked_at || !row.is_active) {
    return "invalid";
  }

  return row.expired ? "expired" : "valid";
}

/** Whether a reset link can still be used. Lets the page explain a dead link before asking for a password. */
export async function checkResetToken(token: string): Promise<ResetTokenState> {
  return stateOf(await findToken(pool, token));
}

function assertUsable(row: TokenRow | undefined): TokenRow {
  const state = stateOf(row);

  if (state === "expired") {
    throw new AppError(400, "RESET_TOKEN_EXPIRED", "This password reset link has expired. Request a new one.");
  }
  if (state === "used") {
    throw new AppError(400, "RESET_TOKEN_USED", "This password reset link has already been used. Request a new one.");
  }
  if (state === "invalid" || !row) {
    throw new AppError(400, "RESET_TOKEN_INVALID", "This password reset link is not valid. Request a new one.");
  }

  return row;
}

/** Sets a new password using a reset token, and spends the token. */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
  // Refused before the (deliberately slow) password hash is computed.
  assertUsable(await findToken(pool, token));

  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async (client) => {
    // Locked and checked again, so the same link cannot be spent twice at once.
    const row = assertUsable(await findToken(client, token, true));

    // Moving password_changed_at signs the user out of every existing session.
    await client.query("UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2", [
      passwordHash,
      row.user_id,
    ]);
    await client.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [row.id]);
    await logActivity(client, {
      userId: row.user_id,
      action: "auth.password_reset_completed",
      module: "AUTH",
      entityType: "users",
      entityId: row.user_id,
      description: `${row.full_name} chose a new password using a reset link.`,
    });
  });
}
