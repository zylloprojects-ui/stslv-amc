// The rules of a maintenance frequency (migration 0076). Pure functions: no
// database. The CHECK constraints in 0076 enforce the same rules again.

/** Months between services that divide the year evenly. */
export const VALID_INTERVALS = [1, 2, 3, 4, 6, 12] as const;

export const FREQUENCY_STATUSES = ["active", "disabled", "archived"] as const;
export type FrequencyStatus = (typeof FREQUENCY_STATUSES)[number];

export const FREQUENCY_STATUS_LABELS: Record<FrequencyStatus, string> = { active: "Active", disabled: "Disabled", archived: "Archived" };

export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,29}$/;
export const PREFIX_PATTERN = /^[A-Z]{1,4}$/;

/** "every 4 months" -> "EVERY_4_MONTHS": upper case, runs of spaces and hyphens become one underscore. */
export function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function normalizePrefix(value: string): string {
  return value.trim().toUpperCase();
}

export interface FrequencyRule {
  isCustom: boolean;
  serviceCount: number | null;
  intervalMonths: number | null;
}

export interface FieldProblem {
  field: string;
  message: string;
}

/**
 * Whether a rule is internally consistent. A fixed rule needs services per year
 * and an interval that divide the year evenly; a custom rule has neither (its
 * months are chosen on each contract).
 */
export function ruleProblems(rule: FrequencyRule): FieldProblem[] {
  if (rule.isCustom) {
    const problems: FieldProblem[] = [];

    if (rule.serviceCount !== null) {
      problems.push({ field: "serviceCount", message: "A custom frequency has no services per year: the months are chosen on each contract." });
    }
    if (rule.intervalMonths !== null) {
      problems.push({ field: "intervalMonths", message: "A custom frequency has no interval: the months are chosen on each contract." });
    }

    return problems;
  }

  const problems: FieldProblem[] = [];
  const interval = rule.intervalMonths;
  const count = rule.serviceCount;

  if (interval === null) {
    problems.push({ field: "intervalMonths", message: "Enter the months between services." });
  } else if (!(VALID_INTERVALS as readonly number[]).includes(interval)) {
    problems.push({ field: "intervalMonths", message: `The interval must be one of ${VALID_INTERVALS.join(", ")} months, so that services divide the year evenly.` });
  }
  if (count === null) {
    problems.push({ field: "serviceCount", message: "Enter the number of services per year." });
  } else if (!Number.isInteger(count) || count < 1) {
    problems.push({ field: "serviceCount", message: "Services per year must be a whole number of at least 1." });
  }
  if (problems.length === 0 && count !== null && interval !== null && count * interval !== 12) {
    problems.push({
      field: "serviceCount",
      message: `${count} ${count === 1 ? "service" : "services"} every ${interval} ${interval === 1 ? "month" : "months"} does not make one year. With a ${interval}-month interval, services per year is ${12 / interval}.`,
    });
  }

  return problems;
}

/**
 * Whether the schedule engine (amc.schedule.ts) can generate visits for a rule.
 * Since migration 0076 it generates every valid rule: any interval in
 * VALID_INTERVALS, and custom months (PROVISIONAL rule). A frequency the engine
 * cannot generate may not be active, so it cannot be chosen for a contract.
 */
export function engineSupports(rule: FrequencyRule): boolean {
  return ruleProblems(rule).length === 0;
}

export const ENGINE_UNSUPPORTED_MESSAGE =
  "The schedule engine cannot generate visits for this rule yet, so it cannot be made active. Save it as disabled; it can be activated once the engine supports it.";

/** The scheduling fields that cannot change once any AMC contract uses the frequency. */
export const LOCKED_FIELDS = ["code", "isCustom", "serviceCount", "intervalMonths", "codePrefix"] as const;
export type LockedField = (typeof LOCKED_FIELDS)[number];

export const LOCKED_FIELD_LABELS: Record<LockedField, string> = {
  code: "Internal code",
  isCustom: "Custom month selection",
  serviceCount: "Services per year",
  intervalMonths: "Interval",
  codePrefix: "Service code prefix",
};

/** The locked fields an edit would change. */
export function lockedChanges(before: Record<LockedField, unknown>, after: Record<LockedField, unknown>): LockedField[] {
  return LOCKED_FIELDS.filter((field) => before[field] !== after[field]);
}

export function statusOf(row: { isActive: boolean; archivedAt: string | null }): FrequencyStatus {
  if (row.archivedAt !== null) return "archived";
  return row.isActive ? "active" : "disabled";
}

/** "4 services · every 3 months", or the custom note. */
export function describeRule(rule: FrequencyRule): string {
  if (rule.isCustom) return "Months chosen on each contract";
  const count = rule.serviceCount ?? 0;
  const interval = rule.intervalMonths ?? 0;

  return `${count} ${count === 1 ? "service" : "services"} · every ${interval === 1 ? "month" : `${interval} months`}`;
}
