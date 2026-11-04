import { requiredText } from "../../shared/validation";

// The rules of the AMC Reference Number (migration 0105), with no database
// access, so the request schemas and the legacy importer can share them.

/** Longest AMC Reference Number (0105's check constraint). */
export const AMC_REFERENCE_MAX = 50;

/** The unique index over lower(amc_reference) on every contract, cancelled and Recycle Bin included. */
export const AMC_REFERENCE_UNIQUE_INDEX = "amc_contracts_reference_uq";

export const DUPLICATE_AMC_REFERENCE = "AMC Reference Number already exists. Please enter a different number.";

/**
 * Typed when a contract or renewal is created. Trimmed, required, at most 50 characters of letters, digits,
 * spaces and - _ . / & starting with a letter or digit (the master-code convention). Case is kept as typed;
 * uniqueness ignores case. The same pattern is 0105's check constraint.
 */
export const amcReferenceSchema = requiredText("AMC Reference Number", AMC_REFERENCE_MAX).refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9 _./&-]*$/.test(value),
  "AMC Reference Number may use letters, digits, spaces and - _ . / & only, and must start with a letter or digit."
);

/** Checks a reference outside a request body (the legacy importer). Returns the trimmed value or the first problem. */
export function checkAmcReference(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const parsed = amcReferenceSchema.safeParse(value);

  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid AMC Reference Number." };
}
