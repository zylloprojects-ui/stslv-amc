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
 * The maintenance periods of a contract.
 *
 * - Every period start is calculated from the contract start, not from the
 *   previous period, so month-end dates do not drift (31 Jan, 28 Feb, 31 Mar).
 * - A period starts only on or before validTo: nothing is scheduled after the
 *   validity ends.
 * - The last period ends on validTo even when that makes it shorter than the
 *   others. PROVISIONAL (Q4): a short final period still gets a visit.
 */
export function buildSchedulePeriods(
  validFrom: string,
  validTo: string,
  frequency: MaintenanceFrequency
): SchedulePeriod[] {
  const interval = FREQUENCY_MONTHS[frequency];
  const periods: SchedulePeriod[] = [];

  for (let index = 0; ; index += 1) {
    const periodStart = addMonths(validFrom, index * interval);

    if (periodStart > validTo) {
      break;
    }

    const naturalEnd = addDays(addMonths(validFrom, (index + 1) * interval), -1);

    periods.push({
      periodStart,
      periodEnd: naturalEnd > validTo ? validTo : naturalEnd,
      scheduledDate: periodStart,
    });
  }

  return periods;
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
