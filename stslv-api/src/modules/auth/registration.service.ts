import { pool } from "../../config/database";
import { env } from "../../config/env";
import { logActivity } from "../../shared/activity-log";
import { withTransaction } from "../../shared/db";
import { isUniqueViolation } from "../../shared/errors";
import { sendInBackground } from "../../shared/mailer";
import { hashPassword } from "./password";

export interface RegistrationInput {
  email: string;
  fullName: string;
  password: string;
}

/**
 * Records a request for an account from the public Sign up page.
 *
 * The account is created PENDING and inactive, with no role, so it cannot sign
 * in or reach anything. An administrator assigns a role and activates it in
 * Users & Access. The caller never chooses a role, a permission or the status:
 * none of them is read from the request.
 *
 * Resolves the same way whether or not the email already belongs to an account,
 * so the public response does not reveal who has one. An existing account is
 * left exactly as it was.
 */
export async function registerAccount(input: RegistrationInput): Promise<void> {
  // Hashed before the email is looked at, so both outcomes take the same time.
  const passwordHash = await hashPassword(input.password);

  try {
    await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, is_active, approval_status)
         VALUES ($1, $2, $3, false, 'PENDING') RETURNING id`,
        [input.email, input.fullName, passwordHash]
      );
      const userId = (inserted.rows[0] as { id: string }).id;

      await logActivity(client, {
        userId,
        action: "auth.signup_submitted",
        module: "AUTH",
        entityType: "users",
        entityId: userId,
        description: `"${input.fullName}" (${input.email}) requested an account. It is waiting for an administrator's approval.`,
        metadata: { source: "sign-up page" },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error, "users_email_uq")) {
      throw error;
    }

    await recordDuplicateRegistration(input.email);
  }
}

async function recordDuplicateRegistration(email: string): Promise<void> {
  const existing = await pool.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [email]);
  const userId = existing.rows[0]?.id ?? null;

  await logActivity(pool, {
    userId: null,
    action: "auth.signup_duplicate",
    module: "AUTH",
    entityType: "users",
    entityId: userId,
    description: `A sign-up was attempted with the email of an existing account (${email}). Nothing was changed.`,
    metadata: { source: "sign-up page" },
  });

  // The owner of the address is told privately; the person at the keyboard is not.
  sendInBackground({
    to: email,
    subject: "STSLEV AMC account request",
    text: [
      "Someone asked for a new STSLEV AMC account using this email address.",
      "",
      "An account with this address already exists, so nothing was changed.",
      `If you have forgotten your password, choose a new one here: ${env.appUrl}/forgot-password`,
      "If this was not you, you can ignore this message.",
      "",
      "Smart Technical Service LLC",
    ].join("\n"),
  });
}
