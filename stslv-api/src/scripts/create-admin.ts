import { createInterface } from "node:readline/promises";
import { pool } from "../config/database";
import { hashPassword } from "../modules/auth/password";
import { logActivity } from "../shared/activity-log";
import { withTransaction } from "../shared/db";
import { isUniqueViolation } from "../shared/errors";
import { ADMIN_ROLE_CODE } from "../shared/permissions";
import { emailSchema, newPasswordSchema, requiredText } from "../shared/validation";

// Creates a user with the Admin role.
//
//   npm run admin:create
//
// The email, name and password are asked for interactively. The password is
// not echoed, is never accepted as a command-line argument (it would be saved
// in shell history) and is never written to disk or printed.
//
// For automation, the three values may instead be piped on standard input,
// one per line: email, full name, password.

/** Reads one line from the terminal without showing what is typed. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";

    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const finish = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("Cancelled."));
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function readInteractive() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const email = await readline.question("Admin email: ");
  const fullName = await readline.question("Full name: ");
  readline.close();

  const password = await askHidden("Password (hidden): ");
  const confirmation = await askHidden("Repeat password: ");

  if (password !== confirmation) {
    throw new Error("The two passwords do not match. Nothing was created.");
  }

  return { email, fullName, password };
}

async function readPiped() {
  const lines: string[] = [];

  for await (const line of createInterface({ input: process.stdin })) {
    lines.push(line);
  }

  if (lines.length < 3) {
    throw new Error("Expected three lines on standard input: email, full name, password.");
  }

  return { email: lines[0] as string, fullName: lines[1] as string, password: lines[2] as string };
}

async function main() {
  const raw = process.stdin.isTTY ? await readInteractive() : await readPiped();

  const email = emailSchema.safeParse(raw.email);
  const fullName = requiredText("Full name", 200).safeParse(raw.fullName);
  const password = newPasswordSchema.safeParse(raw.password);
  const firstIssue = [email, fullName, password].find((result) => !result.success);

  if (!email.success || !fullName.success || !password.success) {
    throw new Error(firstIssue?.error?.issues[0]?.message ?? "Invalid input.");
  }

  const passwordHash = await hashPassword(password.data);

  try {
    await withTransaction(async (client) => {
      const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE code = $1", [ADMIN_ROLE_CODE]);
      const roleId = role.rows[0]?.id;

      if (!roleId) {
        throw new Error("The Admin role does not exist. Run the migrations first: npm run migrate");
      }

      const inserted = await client.query<{ id: string }>(
        "INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [email.data, fullName.data, passwordHash]
      );
      const userId = (inserted.rows[0] as { id: string }).id;

      await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, roleId]);
      await logActivity(client, {
        userId: null,
        action: "user.created",
        module: "USERS",
        entityType: "users",
        entityId: userId,
        description: `Admin user "${fullName.data}" (${email.data}) created by the admin:create script.`,
        metadata: { roles: [ADMIN_ROLE_CODE], source: "admin:create script" },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_uq")) {
      throw new Error(`A user with the email ${email.data} already exists. Nothing was changed.`);
    }
    throw error;
  }

  console.log(`Admin user created: ${email.data}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not create the admin user.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
