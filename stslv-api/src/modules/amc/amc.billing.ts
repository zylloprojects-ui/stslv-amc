import { addMonths, buildSchedulePeriods, type ScheduleRule } from "./amc.schedule";

// The per-service amount of a contract with a Billing Basis. Pure functions on
// whole thousandths of an OMR (bigint), so no floating-point value is ever used.
//
// Approved rules (2026-11-01):
//   * The selected basis (AMC Value / Year, Final Credit Value or Custom Billing
//     Value) is an annual amount, in OMR excluding VAT, with three decimals.
//   * Per service = annual amount / services per annual cycle, rounded half up
//     to three decimals, the same in every year.
//   * The last service of each complete annual cycle takes the rounding
//     remainder, so a complete cycle adds up to the annual amount exactly:
//     500.000 / 6 = 5 x 83.333 + 83.335.
//   * A partial contract year is not prorated: the services actually scheduled
//     take the standard amount. A cycle that never reaches its last service has
//     no remainder to settle.

function toThousandths(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(amount.trim());

  if (!match) {
    throw new Error(`Invalid money value "${amount}".`);
  }

  return BigInt(match[1] as string) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
}

function fromThousandths(value: bigint): string {
  return `${value / 1000n}.${String(value % 1000n).padStart(3, "0")}`;
}

/** a - b to three decimals, without floating point. May be negative. */
export function subtractMoney(a: string, b: string): string {
  const difference = toThousandths(a) - toThousandths(b);

  return difference < 0n ? `-${fromThousandths(-difference)}` : fromThousandths(difference);
}

/** Services in one annual cycle: 12 / interval, or the number of selected months. */
export function servicesPerCycle(rule: ScheduleRule): number {
  return rule.kind === "interval" ? Math.round(12 / rule.intervalMonths) : new Set(rule.months).size;
}

/** The position (1 = first) of a service inside its annual cycle; null when the date is not on the rule. */
export function positionInCycle(validFrom: string, rule: ScheduleRule, periodStart: string): number | null {
  const start = new Date(`${validFrom}T00:00:00Z`);
  const at = new Date(`${periodStart}T00:00:00Z`);
  const months = (at.getUTCFullYear() - start.getUTCFullYear()) * 12 + (at.getUTCMonth() - start.getUTCMonth());

  if (months < 0) return null;

  if (rule.kind === "interval") {
    return months % rule.intervalMonths === 0 ? (months / rule.intervalMonths) % servicesPerCycle(rule) + 1 : null;
  }

  const startMonth = start.getUTCMonth() + 1;
  const offsets = [...new Set(rule.months.map((month) => (((month - startMonth) % 12) + 12) % 12))].sort((a, b) => a - b);
  const index = offsets.indexOf(months % 12);

  return index === -1 ? null : index + 1;
}

export interface ServiceAmounts {
  /** The standard amount per service. */
  standard: string;
  /** The amount of the last service of a complete annual cycle. */
  last: string;
  /** How many services make one annual cycle. */
  services: number;
}

/** The two amounts an annual amount divides into. */
export function serviceAmounts(annualAmount: string, services: number): ServiceAmounts {
  if (!Number.isInteger(services) || services < 1) {
    throw new Error("An annual cycle needs at least one service.");
  }

  const annual = toThousandths(annualAmount);
  const count = BigInt(services);
  // Half up: (2a + n) / 2n in whole numbers.
  const standard = (2n * annual + count) / (2n * count);

  return { standard: fromThousandths(standard), last: fromThousandths(annual - standard * (count - 1n)), services };
}

/** The amount of the service whose period starts on periodStart. */
export function amountForService(annualAmount: string, validFrom: string, rule: ScheduleRule, periodStart: string): string {
  const services = servicesPerCycle(rule);
  const amounts = serviceAmounts(annualAmount, services);

  return positionInCycle(validFrom, rule, periodStart) === services ? amounts.last : amounts.standard;
}

/** What the visits of a term should add up to: every scheduled period's amount, in thousandths, as a decimal. */
export function expectedTermTotal(annualAmount: string, validFrom: string, validTo: string, rule: ScheduleRule, cutoverDate: string | null): string {
  const total = buildSchedulePeriods(validFrom, validTo, rule, cutoverDate).reduce(
    (sum, period) => sum + toThousandths(amountForService(annualAmount, validFrom, rule, period.periodStart)),
    0n
  );

  return fromThousandths(total);
}

/** Whole contract years, rounded up: a partial year counts as a year. For display and review only. */
export function contractYears(validFrom: string, validTo: string): number {
  let years = 1;

  while (addMonths(validFrom, years * 12) <= validTo) years += 1;

  return years;
}
