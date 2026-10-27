import { FREQUENCY_MONTHS, type MaintenanceFrequency, type VisitStatus } from "./amc.constants";

// Schedule arithmetic. Pure functions: no database, no clock.
// Dates are calendar days written "YYYY-MM-DD", which also sort correctly as text.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(date);

  if (!match) {
    throw new Error(`Invalid date "${date}".`);
  }

  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True for a real calendar day written YYYY-MM-DD (rejects 2026-02-30). */
export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  return year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/**
 * Adds whole months, keeping the day of the month where it exists and
 * otherwise using the last day of the target month (31 Jan + 1 month = 28/29 Feb).
 */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;

  return format(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

export function addDays(date: string, days: number): string {
  const { year, month, day } = parts(date);
  const result = new Date(Date.UTC(year, month - 1, day + days));

  return format(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

export interface SchedulePeriod {
  periodStart: string;
  periodEnd: string;
  /** PROVISIONAL (Q4): a visit is planned on the first day of its period. */
  scheduledDate: string;
}

/**
 * How a contract's visits are spaced (migration 0076).
 * - interval: one visit every `intervalMonths` months from the contract start.
 * - months: PROVISIONAL (custom frequency; the client has not confirmed the
 *   rule): one visit in each selected calendar month (1 = January) of every
 *   contract year, on the contract start's day of the month (clamped to the
 *   month end). Months before the first selected month get no visit.
 */
export type ScheduleRule = { kind: "interval"; intervalMonths: number } | { kind: "months"; months: readonly number[] };

/** One of the four built-in codes, or a rule from the frequency master. */
export function toScheduleRule(frequency: MaintenanceFrequency | ScheduleRule): ScheduleRule {
  return typeof frequency === "string" ? { kind: "interval", intervalMonths: FREQUENCY_MONTHS[frequency] } : frequency;
}

/** The months after the contract start month at which each visit of a contract year falls, ascending (0-11). */
function monthOffsets(validFrom: string, months: readonly number[]): number[] {
  const startMonth = parts(validFrom).month;
  const offsets = [...new Set(months.map((month) => (((month - startMonth) % 12) + 12) % 12))].sort((a, b) => a - b);

  if (offsets.length === 0 || months.some((month) => !Number.isInteger(month) || month < 1 || month > 12)) {
    throw new Error("A custom schedule needs at least one month from 1 to 12.");
  }

  return offsets;
}

/** Months from the contract start to the visit with this index (0, 1, 2, ...). */
function offsetFn(validFrom: string, rule: ScheduleRule): (index: number) => number {
  if (rule.kind === "interval") {
    if (!Number.isInteger(rule.intervalMonths) || rule.intervalMonths < 1) {
      throw new Error("A schedule interval must be a whole number of months.");
    }

    return (index) => index * rule.intervalMonths;
  }

  const offsets = monthOffsets(validFrom, rule.months);

  return (index) => 12 * Math.floor(index / offsets.length) + (offsets[index % offsets.length] as number);
}

/**
 * The maintenance periods of a contract.
 *
 * - Every period start is calculated from the contract start, not from the
 *   previous period, so month-end dates do not drift (31 Jan, 28 Feb, 31 Mar).
 * - A period runs to the day before the next visit's period starts.
 * - A period starts only on or before validTo: nothing is scheduled after the
 *   validity ends.
 * - The last period ends on validTo even when that makes it shorter than the
 *   others. PROVISIONAL (Q4): a short final period still gets a visit.
 * - With a cutover date (a contract imported from an earlier register), only
 *   the periods that start on or after it are returned. Earlier periods are
 *   history: they exist only where the source recorded them and are never
 *   generated. The later periods keep the dates they would have had anyway,
 *   because every period is still counted from the contract start.
 */
export function buildSchedulePeriods(
  validFrom: string,
  validTo: string,
  frequency: MaintenanceFrequency | ScheduleRule,
  cutoverDate: string | null = null
): SchedulePeriod[] {
  const offsetAt = offsetFn(validFrom, toScheduleRule(frequency));
  const periods: SchedulePeriod[] = [];

  for (let index = 0; ; index += 1) {
    const periodStart = addMonths(validFrom, offsetAt(index));

    if (periodStart > validTo) {
      break;
    }
    if (cutoverDate !== null && periodStart < cutoverDate) {
      continue;
    }

    const naturalEnd = addDays(addMonths(validFrom, offsetAt(index + 1)), -1);

    periods.push({
      periodStart,
      periodEnd: naturalEnd > validTo ? validTo : naturalEnd,
      scheduledDate: periodStart,
    });
  }

  return periods;
}

export interface ServiceLabel {
  /** Contract year, counted from the contract start: 1, 2, ... */
  cycleNo: number;
  /** Prefix and service number within that year, for example "Q3". */
  serviceCode: string;
}

/**
 * The label of the visit whose period starts on `periodStart`: its contract
 * year and its number within that year, after the frequency's prefix
 * ("Year 2 · Q3"). Taken once, when the visit is generated, and stored.
 */
export function serviceLabel(validFrom: string, rule: ScheduleRule, prefix: string, periodStart: string): ServiceLabel {
  const from = parts(validFrom);
  const at = parts(periodStart);
  const months = (at.year - from.year) * 12 + (at.month - from.month);
  const cycleNo = Math.floor(months / 12) + 1;
  let serviceNo: number;

  if (rule.kind === "interval") {
    serviceNo = (Math.floor(months / rule.intervalMonths) % Math.max(1, Math.round(12 / rule.intervalMonths))) + 1;
  } else {
    serviceNo = monthOffsets(validFrom, rule.months).indexOf(months % 12) + 1;
  }

  return { cycleNo, serviceCode: `${prefix}${Math.max(1, serviceNo)}` };
}

export interface ExistingVisit {
  id: string;
  sequenceNo: number;
  periodStart: string;
  periodEnd: string;
  scheduledDate: string;
  status: VisitStatus;
  /**
   * True once anyone has acted on the visit: any status other than SCHEDULED,
   * a changed date, a hand-set amount, an assignment or any note.
   */
  locked: boolean;
}

export interface SchedulePlan {
  /** Periods that have no visit yet. */
  toCreate: SchedulePeriod[];
  /** Untouched visits that no longer match the contract terms. */
  toRemove: ExistingVisit[];
  /** Visits left exactly as they are. */
  kept: ExistingVisit[];
  /** Visits someone has acted on that fall outside the validity period. They stop the change. */
  blocking: ExistingVisit[];
}

/**
 * Works out how to bring a contract's visits in line with its terms without
 * touching anything a person has acted on.
 *
 * 1. A locked visit is always kept, unchanged.
 * 2. An untouched visit is kept when it matches a period exactly; otherwise it
 *    is removed. It carries no information beyond what generation produces.
 * 3. A period gets a new visit unless a kept visit already starts inside it,
 *    so a period where work was recorded or cancelled is never scheduled twice.
 * 4. A locked visit (other than a cancelled one) whose period starts outside
 *    the validity is reported as blocking; the caller refuses the change.
 */
export function planSchedule(
  periods: SchedulePeriod[],
  existing: ExistingVisit[],
  validFrom: string,
  validTo: string
): SchedulePlan {
  const kept: ExistingVisit[] = [];
  const toRemove: ExistingVisit[] = [];
  const blocking: ExistingVisit[] = [];

  for (const visit of existing) {
    if (visit.locked) {
      const outside = visit.periodStart < validFrom || visit.periodStart > validTo;

      if (outside && visit.status !== "CANCELLED") {
        blocking.push(visit);
      }
      kept.push(visit);
      continue;
    }

    const matches = periods.some(
      (period) => period.periodStart === visit.periodStart && period.periodEnd === visit.periodEnd
    );

    if (matches) {
      kept.push(visit);
    } else {
      toRemove.push(visit);
    }
  }

  const toCreate = periods.filter(
    (period) => !kept.some((visit) => visit.periodStart >= period.periodStart && visit.periodStart <= period.periodEnd)
  );

  return { toCreate, toRemove, kept, blocking };
}
