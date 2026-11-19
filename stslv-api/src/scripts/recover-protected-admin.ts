import { createInterface } from "node:readline/promises";
import { pool } from "../config/database";
import { recoverProtectedAdmin } from "../modules/users/protected-account";

// Emergency recovery of the protected Super Admin account (migration 0119, docs/PROTECTED_SUPER_ADMIN.md).
//
//   npm run admin:recover-protected
//
// Run on the server only, by an operator the owner has authorized: shell access to the server is the authorization.
// The operator types the protected account's email as confirmation (or pipes it on standard input). The account is
// made active, holds exactly the Super Admin role again, is signed out everywhere and gets a new random temporary
// password, printed ONCE here, which must be replaced at the next sign-in within 15 minutes. Recorded in the audit log.

async function readEmail(): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdin.isTTY ? process.stdout : undefined });

  if (process.stdin.isTTY) {
    const email = await readline.question("Email of the protected Super Admin to recover: ");
    readline.close();
    return email;
  }

  for await (const line of readline) {
    return line;
  }

  throw new Error("Expected the protected account's email on standard input.");
}

async function main() {
  const recovered = await recoverProtectedAdmin(await readEmail());

  console.log("");
  console.log(`Protected Super Admin recovered: ${recovered.email} (user id ${recovered.userId})`);
  console.log(`Temporary password (shown once, not saved anywhere): ${recovered.temporaryPassword}`);
  console.log(`It must be used and replaced before ${recovered.expiresAt} (UTC).`);
  console.log("Give it to the account owner privately, then clear this terminal.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Could not recover the protected account.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
