import bcrypt from "bcryptjs";
import { env } from "../../config/env";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.bcryptRounds);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

// Compared against when the email is unknown, so a failed login takes the same
// time whether or not the account exists.
const dummyHash = bcrypt.hashSync("no-such-account", env.bcryptRounds);

export async function verifyAgainstDummy(password: string): Promise<void> {
  await bcrypt.compare(password, dummyHash);
}
