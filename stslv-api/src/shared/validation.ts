import { z } from "zod";
import { notFound } from "./errors";

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

// bcrypt only uses the first 72 bytes of a password, so longer ones are refused
// rather than silently truncated.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

export const newPasswordSchema = z
  .string({ error: "Password is required." })
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .refine((value) => Buffer.byteLength(value, "utf8") <= PASSWORD_MAX_BYTES, {
    message: `Password must be at most ${PASSWORD_MAX_BYTES} bytes.`,
  });

/** Escapes % _ and \ so user text is matched literally inside ILIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
