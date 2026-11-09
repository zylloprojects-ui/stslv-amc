// Password rules for every NEWLY SET password (sign-up, My account, the forced change after a temporary
// password, an administrator creating a user). Existing passwords and hashes are not re-checked: people keep
// signing in with what they have, and meet these rules the next time they choose a password.
//
// The web application shows the same rules (stslv-web/src/lib/password.ts); keep the two in step.
//
//   1. At least 12 characters (was 10).
//   2. At most 72 bytes: bcrypt ignores anything longer, so a longer password is refused, not silently cut.
//   3. Characters from at least three of: lower-case letters, upper-case letters, digits, symbols/spaces.
//   4. At least 5 different characters ("Aa1!Aa1!Aa1!" is refused).
//   5. Not a well-known weak password with digits and symbols added ("P@ssw0rd2026!", "Welcome@123").
//   6. Not containing the person's email name or a part of their name (4+ letters).

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_CLASSES = 3;
export const PASSWORD_MIN_DISTINCT = 5;

// Lower-case letter-only "bases" after common substitutions are undone. Short on purpose: the length and
// variety rules do most of the work; this stops the patterns people actually pick.
const WEAK_BASES = new Set([
  "password", "passwd", "pass", "passw", "pwd", "welcome", "admin", "administrator", "root", "user", "guest", "login", "test", "testing",
  "qwerty", "qwertyuiop", "asdf", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm", "abc", "abcd", "abcdef", "abcdefg", "abcdefgh", "letmein", "changeme",
  "secret", "default", "temp", "temporary", "newpassword", "mypassword", "iloveyou", "monkey", "dragon", "sunshine", "princess", "football",
  "baseball", "master", "trustno", "summer", "winter", "spring", "autumn", "january", "december", "company", "office", "oman", "muscat",
  "stslv", "stslev", "stselv", "stslvamc", "stslevamc", "stselvamc", "amc", "",
]);

const SUBSTITUTIONS: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };

const substituted = (text: string) => [...text.toLowerCase()].map((char) => SUBSTITUTIONS[char] ?? char).join("").replace(/[^a-z]/g, "");

/**
 * The word a password is built on: digits and symbols around it are dropped ("Welcome@2026" -> "welcome") and
 * look-alike characters inside it are undone ("P@ssw0rd" -> "password").
 */
export function passwordBase(password: string): string {
  return substituted(password.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ""));
}

/** Every reading of a password that is compared with the weak-word list. */
function baseCandidates(password: string): string[] {
  return [passwordBase(password), password.toLowerCase().replace(/[^a-z]/g, ""), substituted(password)];
}

export function characterClasses(password: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
}

export interface PasswordContext {
  email?: string | null;
  fullName?: string | null;
}

export const PASSWORD_MESSAGES = {
  tooShort: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  tooLong: `Password must be at most ${PASSWORD_MAX_BYTES} bytes.`,
  classes: "Password must use at least three of: lower-case letters, upper-case letters, digits, symbols.",
  distinct: `Password must contain at least ${PASSWORD_MIN_DISTINCT} different characters.`,
  common: "This password is too easy to guess. Avoid common words such as \"password\" or \"welcome\".",
  personal: "Password must not contain your name or email address.",
} as const;

/** Every rule the password breaks, as messages. Empty when it is acceptable. */
export function passwordProblems(password: string, context: PasswordContext = {}): string[] {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) problems.push(PASSWORD_MESSAGES.tooShort);
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) problems.push(PASSWORD_MESSAGES.tooLong);
  if (characterClasses(password) < PASSWORD_MIN_CLASSES) problems.push(PASSWORD_MESSAGES.classes);
  if (new Set(password).size < PASSWORD_MIN_DISTINCT) problems.push(PASSWORD_MESSAGES.distinct);

  const base = passwordBase(password);
  const isWeak = (candidate: string) => WEAK_BASES.has(candidate) || [...WEAK_BASES].some((weak) => weak.length >= 4 && candidate === weak + weak);
  if (baseCandidates(password).some(isWeak)) problems.push(PASSWORD_MESSAGES.common);

  const lower = password.toLowerCase();
  const personal = [
    ...(context.email ? [context.email.split("@")[0] ?? ""] : []),
    ...(context.fullName ? context.fullName.split(/[^\p{L}\p{N}]+/u) : []),
  ]
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 4);
  const containsPersonal = personal.some((part) => {
    const partBase = passwordBase(part);
    // Typed as is ("ahmed"), or disguised with substitutions ("4hm3d").
    return lower.includes(part) || (partBase.length >= 4 && base.includes(partBase));
  });
  if (containsPersonal) problems.push(PASSWORD_MESSAGES.personal);

  return problems;
}
