import { z } from "zod";

// Money and rates travel through the API as decimal strings ("1234.567") and
// are stored as PostgreSQL numeric. They are never converted to a JavaScript
// number: all arithmetic on them is done by PostgreSQL.

// numeric(14,3): up to 11 digits before the point and up to 3 after.
const MONEY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;
const RATE_PATTERN = /^\d{1,3}(\.\d{1,3})?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isZero = (value: string) => /^0+(\.0+)?$/.test(value);

/**
 * Rewrites a validated decimal string the way PostgreSQL returns numeric(n,3):
 * no leading zeros and exactly three decimals ("0100.5" becomes "100.500").
 * Pure text handling, so a value can be compared with a stored one without arithmetic.
 */
export function canonicalDecimal(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");

  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(3, "0")}`;
}

/** A money amount as a decimal string with at most three decimal places. */
export const moneySchema = (label: string, options: { allowZero: boolean }) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .regex(MONEY_PATTERN, `${label} must be a number with at most 3 decimal places, for example 1250.500.`)
    .refine((value) => options.allowZero || !isZero(value), `${label} must be greater than zero.`)
    .transform(canonicalDecimal);

/** Optional money: an empty string is stored as null. */
export const optionalMoneySchema = (label: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) => value === "" || MONEY_PATTERN.test(value),
      `${label} must be a number with at most 3 decimal places, for example 1250.500.`
    )
    .transform((value) => (value === "" ? null : canonicalDecimal(value)))
    .nullable();

/** A percentage between 0 and 100 as a decimal string with at most three decimal places. */
export const rateSchema = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .regex(RATE_PATTERN, `${label} must be a percentage with at most 3 decimal places, for example 5.000.`)
    .refine((value) => {
      const [whole = "0", fraction = ""] = value.split(".");
      const wholeNumber = Number(whole);

      return wholeNumber < 100 || (wholeNumber === 100 && /^0*$/.test(fraction));
    }, `${label} must be between 0 and 100.`)
    .transform(canonicalDecimal);

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  return year >= 1900 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A calendar day as YYYY-MM-DD, exactly as it appears on a document. No time zone. */
export const dateSchema = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .refine(isCalendarDate, `${label} must be a valid date (YYYY-MM-DD).`);

/** Optional date: an empty string is stored as null. */
export const optionalDateSchema = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || isCalendarDate(value), `${label} must be a valid date (YYYY-MM-DD).`)
    .transform((value) => (value === "" ? null : value))
    .nullable();

/** Shared paging parameters for list endpoints. */
export const pagingSchema = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
