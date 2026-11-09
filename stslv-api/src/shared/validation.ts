import { z } from "zod";
import { notFound, validationError } from "./errors";
import { passwordProblems, type PasswordContext } from "./password-policy";

/** Database ids are bigint and travel through the API as numeric strings. */
export const idSchema = z.string().regex(/^[1-9]\d{0,17}$/, "Must be a valid id.");

/** Parses a route :id parameter. An id that cannot exist is reported as not found. */
export function parseIdParam(value: unknown): string {
  const result = idSchema.safeParse(value);

  if (!result.success) {
    throw notFound();
  }

  return result.data;
}

/** Required single-line text: trimmed, not empty, limited length. */
export const requiredText = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters.`);

/** Optional text: trimmed; an empty string is stored as null. */
export const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .transform((value) => (value === "" ? null : value))
    .nullable();

export const emailSchema = z
  .string({ error: "Email is required." })
  .trim()
  .toLowerCase()
  .max(254, "Email must be at most 254 characters.")
  .pipe(z.email("Enter a valid email address."));

// A newly chosen password (shared/password-policy.ts): at least 12 characters, at most 72 bytes (bcrypt ignores
// the rest), three kinds of character, not a well-known weak password. The rule about the person's name or email
// is checked where those are known (refinePersonalPassword in a schema, or assertPasswordAllowed in a service).
export { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "./password-policy";

export const newPasswordSchema = z.string({ error: "Password is required." }).superRefine((value, context) => {
  for (const message of passwordProblems(value)) context.addIssue({ code: "custom", message });
});

/** Adds the name/email rule to a schema whose object holds the password together with the person's details. */
export function refinePersonalPassword(value: { password?: unknown; email?: unknown; fullName?: unknown }, context: z.RefinementCtx): void {
  if (typeof value.password !== "string") return;

  const person = { email: typeof value.email === "string" ? value.email : null, fullName: typeof value.fullName === "string" ? value.fullName : null };
  const generic = new Set(passwordProblems(value.password));

  for (const message of passwordProblems(value.password, person)) {
    if (!generic.has(message)) context.addIssue({ code: "custom", message, path: ["password"] });
  }
}

/** For a service that knows whose password it is setting: refuses a password that breaks any rule. */
export function assertPasswordAllowed(password: string, person: PasswordContext, field = "newPassword"): void {
  const problems = passwordProblems(password, person);

  if (problems.length > 0) {
    throw validationError(problems[0] as string, problems.map((message) => ({ field, message })));
  }
}

/** Escapes % _ and \ so user text is matched literally inside ILIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
