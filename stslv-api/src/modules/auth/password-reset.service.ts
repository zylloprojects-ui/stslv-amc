import type { Queryable } from "../../shared/db";

// Email reset links were retired in favour of temporary passwords issued by an
// administrator (see docs/AUTH_SIGNUP_AND_RECOVERY.md). Their routes are gone, so
// a stored token can no longer be used. The table and this clean-up stay: older
// rows are kept for the record, and any still outstanding are cancelled whenever
// the account's password or access changes.

/** Cancels every outstanding reset token of a user. Call it whenever their password or access changes. */
export async function revokeResetTokens(db: Queryable, userId: string): Promise<void> {
  await db.query(
    "UPDATE password_reset_tokens SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
    [userId]
  );
}
