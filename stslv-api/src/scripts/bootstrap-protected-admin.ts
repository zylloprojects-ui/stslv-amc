import { createInterface } from "node:readline/promises";
import { pool } from "../config/database";
import { bootstrapProtectedAdmin } from "../modules/users/protected-account";
import { emailSchema, requiredText } from "../shared/validation";

// One-time creation of the protected Super Admin account (migration 0119, docs/PROTECTED_SUPER_ADMIN.md).
//
//   npm run admin:bootstrap-protected
//
// Run on the server only: shell access to the server, with the API's database settings, is the authorization.
// Asks for the email and full name (or reads them from standard input, one per line). No password is typed or
// stored anywhere: a random temporary password is printed ONCE, here, and must be replaced at the first sign-in
// within 15 minutes. If it expires, run npm run admin:recover-protected.
//
// Refused, with nothing changed, when a protected account already exists or the email is already in use.

async function readInput(): Promise<{ email: string; fullName: string }> {
  const readline = createInterface({ input: process.stdin, output: process.stdin.isTTY ? process.stdout : undefined });

  if (process.stdin.isTTY) {
    const email = await readline.question("Protected Super Admin email: ");
    const fullName = await readline.question("Full name: ");
    const confirmation = await readline.question(`Create the ONE protected Super Admin ${email.trim()}? This cannot be undone from the application. Type CREATE to continue: `);
    readline.close();

    if (confirmation.trim() !== "CREATE") {
      throw new Error("Cancelled. Nothing was created.");
    }

    return { email, fullName };
  }

  const lines: string[] = [];

  for await (const line of readline) {
    lines.push(line);
  }

  if (lines.length < 2) {
    throw new Error("Expected two lines on standard input: email, full name.");
  }

  return { email: lines[0] as string, fullName: lines[1] as string };
}

async function main() {
  const raw = await readInput();
  const email = emailSchema.safeParse(raw.email);
  const fullName = requiredText("Full name", 200).safeParse(raw.fullName);

  if (!email.success || !fullName.success) {
    throw new Error((!email.success ? email.error : fullName.error)?.issues[0]?.message ?? "Invalid input.");
  }

  const created = await bootstrapProtectedAdmin({ email: email.data, fullName: fullName.data });

  console.log("");
  console.log(`Protected Super Admin created: ${created.email} (user id ${created.userId})`);
  console.log(`Temporary password (shown once, not saved anywhere): ${created.temporaryPassword}`);
  console.log(`It must be used and replaced before ${created.expiresAt} (UTC).`);
  console.log("Give it to the account owner privately, then clear this terminal.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not create the protected account.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
