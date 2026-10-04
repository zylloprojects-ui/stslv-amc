import type { Cell } from "./xlsx";

// Money read from a workbook. Amounts are exact: they are carried as whole
// thousandths in a bigint or as three-decimal text, never as a JavaScript number.

/**
 * What a money cell holds.
 *   BLANK    the cell is empty. It is not zero.
 *   VALUE    a number of zero or more with at most three decimals. `isZero`
 *            marks a zero that was actually entered.
 *   INVALID  the cell holds something that is not such a number.
 */
export type Money =
  | { kind: "BLANK" }
  | { kind: "VALUE"; amount: string; isZero: boolean }
  | { kind: "INVALID"; raw: string; reason: string };

const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const SCALE = 20;
const THOUSANDTH = 10n ** BigInt(SCALE - 3);
// Excel stores numbers in binary, so 1577.276 may be written 1577.2760000000001.
// A value is accepted as three-decimal when it is within this distance of one.
const TOLERANCE = 10n ** BigInt(SCALE - 9);

/** The number written in `text`, scaled by 10^20, exactly. Null when it is not a plain decimal number. */
function scaled(text: string): bigint | null {
  const match = NUMBER_TEXT.exec(text.trim());

  if (!match) {
    return null;
  }

  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  const digits = BigInt(`${match[2]}${fraction}`);
  const shift = SCALE - fraction.length + exponent;

  if (shift < -40 || shift > 60) {
    return null;
  }

  const value = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);

  return match[1] === "-" ? -value : value;
}

/** Whole thousandths nearest to a scaled value, and how far the value is from them. */
function nearestThousandth(value: bigint): { thousandths: bigint; distance: bigint } {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const quotient = magnitude / THOUSANDTH;
  const remainder = magnitude % THOUSANDTH;
  const rounded = remainder * 2n >= THOUSANDTH ? quotient + 1n : quotient;
  const distance = rounded * THOUSANDTH - magnitude;

  return { thousandths: negative ? -rounded : rounded, distance: distance < 0n ? -distance : distance };
}

/** 1577276n -> "1577.276". */
export function fromThousandths(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(4, "0");

  return `${negative ? "-" : ""}${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

/** "1577.276" -> 1577276n. The text must be a three-decimal amount as produced here. */
export function toThousandths(amount: string): bigint {
  const match = /^(-?)(\d+)\.(\d{3})$/.exec(amount);

  if (!match) {
    throw new Error(`"${amount}" is not a three-decimal amount.`);
  }

  const value = BigInt(`${match[2]}${match[3]}`);

  return match[1] === "-" ? -value : value;
}

export function readMoney(cell: Cell | undefined): Money {
  if (cell === undefined || (cell.type === "text" && cell.value.trim() === "")) {
    return { kind: "BLANK" };
  }
  if (cell.type !== "number") {
    return { kind: "INVALID", raw: cell.value, reason: "not a number" };
  }

  const value = scaled(cell.value);

  if (value === null) {
    return { kind: "INVALID", raw: cell.value, reason: "not a number" };
  }

  const { thousandths, distance } = nearestThousandth(value);

  if (distance > TOLERANCE) {
    return { kind: "INVALID", raw: cell.value, reason: "more than three decimal places" };
  }
  if (thousandths < 0n) {
    return { kind: "INVALID", raw: cell.value, reason: "negative" };
  }

  return { kind: "VALUE", amount: fromThousandths(thousandths), isZero: thousandths === 0n };
}

/**
 * True when a number cell equals `amount` multiplied by `rate`, where rate is
 * written as a decimal fraction ("0.05"). Used to confirm that a VAT cell is
 * the stated percentage of the job value, without rounding either side.
 */
export function equalsProduct(cell: Cell | undefined, amount: string, rate: string): boolean {
  if (cell === undefined || cell.type !== "number") {
    return false;
  }

  const actual = scaled(cell.value);
  const factor = scaled(rate);

  if (actual === null || factor === null) {
    return false;
  }

  const expected = (toThousandths(amount) * THOUSANDTH * factor) / 10n ** BigInt(SCALE);
  const difference = actual - expected;

  return (difference < 0n ? -difference : difference) <= TOLERANCE;
}

/**
 * VAT as PostgreSQL will generate it: round(job_value * vat_rate / 100, 3),
 * half away from zero. `ratePercent` is three-decimal text, "5.000".
 */
export function vatAmount(jobValue: string, ratePercent: string): string {
  const product = toThousandths(jobValue) * toThousandths(ratePercent);
  const divisor = 100_000n;
  const quotient = product / divisor;

  return fromThousandths(product % divisor * 2n >= divisor ? quotient + 1n : quotient);
}

export const addAmounts = (amounts: string[]): string => fromThousandths(amounts.reduce((sum, amount) => sum + toThousandths(amount), 0n));
