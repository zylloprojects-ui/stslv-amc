import { z } from 'zod'

// The rules the API enforces on every newly chosen password (stslv-api/src/shared/password-policy.ts); keep the
// two in step. Checked here first so the person sees the problem before submitting. The API additionally refuses a
// password containing the person's name or email name, and reports that against the field.

export const PASSWORD_MIN_LENGTH = 12
const MAX_BYTES = 72
const MIN_CLASSES = 3
const MIN_DISTINCT = 5

export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, using three of: lower-case, upper-case, digits, symbols. Not a common word such as "password".`

const WEAK_BASES = new Set([
  'password', 'passwd', 'pass', 'passw', 'pwd', 'welcome', 'admin', 'administrator', 'root', 'user', 'guest', 'login', 'test', 'testing',
  'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'abc', 'abcd', 'abcdef', 'abcdefg', 'abcdefgh', 'letmein', 'changeme',
  'secret', 'default', 'temp', 'temporary', 'newpassword', 'mypassword', 'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'master', 'trustno', 'summer', 'winter', 'spring', 'autumn', 'january', 'december', 'company', 'office', 'oman', 'muscat',
  'stslv', 'stslev', 'stselv', 'stslvamc', 'stslevamc', 'stselvamc', 'amc', '',
])
const SUBSTITUTIONS: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' }

const substituted = (text: string) => [...text.toLowerCase()].map((char) => SUBSTITUTIONS[char] ?? char).join('').replace(/[^a-z]/g, '')

function isCommon(password: string): boolean {
  const candidates = [
    substituted(password.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')),
    password.toLowerCase().replace(/[^a-z]/g, ''),
    substituted(password),
  ]

  return candidates.some((candidate) => WEAK_BASES.has(candidate) || [...WEAK_BASES].some((weak) => weak.length >= 4 && candidate === weak + weak))
}

/** Every rule the password breaks, in the API's words. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = []

  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  if (new TextEncoder().encode(password).length > MAX_BYTES) problems.push(`Password must be at most ${MAX_BYTES} bytes.`)
  if ([/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length < MIN_CLASSES) {
    problems.push('Password must use at least three of: lower-case letters, upper-case letters, digits, symbols.')
  }
  if (new Set(password).size < MIN_DISTINCT) problems.push(`Password must contain at least ${MIN_DISTINCT} different characters.`)
  if (isCommon(password)) problems.push('This password is too easy to guess. Avoid common words such as "password" or "welcome".')

  return problems
}

export const passwordRule = z.string().superRefine((value, context) => {
  for (const message of passwordProblems(value)) context.addIssue({ code: 'custom', message })
})
