import type { Queryable } from "../../shared/db";
import { validationError } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import { FREQUENCY_MONTHS, MAINTENANCE_FREQUENCIES, type MaintenanceFrequency } from "./amc.constants";
import { serviceLabel, type ScheduleRule, type ServiceLabel } from "./amc.schedule";

// The maintenance frequency of a contract as the schedule engine uses it.
//
// From migration 0076 the rule comes from the maintenance_frequencies master
// (interval or custom months, service-code prefix, status). On a database
// without 0076 the four built-in codes and their intervals apply, with no
// prefix, no custom months and no service codes, exactly as before.

export interface ContractFrequency {
  code: string;
  isActive: boolean;
  isCustom: boolean;
  /** Null for a custom frequency. */
  intervalMonths: number | null;
  /** Null on a database without migration 0076: no service codes are taken. */
  prefix: string | null;
}

/** Whether this database has the frequency rules, contract custom months and visit labels (migration 0076). */
export function hasFrequencyRules(): Promise<boolean> {
  return schemaHas(["maintenance_frequencies.code_prefix", "amc_contract_custom_months", "amc_visits.service_code"]);
}

/** The frequency with this code, or null when there is none. */
export async function findContractFrequency(db: Queryable, code: string): Promise<ContractFrequency | null> {
  if (await hasFrequencyRules()) {
    const result = await db.query<{ code: string; is_active: boolean; is_custom: boolean; interval_months: number | null; code_prefix: string }>(
      "SELECT code, is_active, is_custom, interval_months, code_prefix FROM maintenance_frequencies WHERE code = $1",
      [code]
    );
    const row = result.rows[0];

    return row ? { code: row.code, isActive: row.is_active, isCustom: row.is_custom, intervalMonths: row.interval_months, prefix: row.code_prefix } : null;
  }

  return (MAINTENANCE_FREQUENCIES as readonly string[]).includes(code)
    ? { code, isActive: true, isCustom: false, intervalMonths: FREQUENCY_MONTHS[code as MaintenanceFrequency], prefix: null }
    : null;
}

/** "2,5,8,11" <-> [2, 5, 8, 11]: custom months as one comparable, loggable value. */
export function monthsKey(months: readonly number[] | null | undefined): string | null {
  return months && months.length > 0 ? [...new Set(months)].sort((a, b) => a - b).join(",") : null;
}

export function monthsOf(key: string | null): number[] {
  return key ? key.split(",").map(Number) : [];
}

export interface ResolvedTerms {
  frequency: ContractFrequency;
  rule: ScheduleRule;
  /** Labels a visit generated for a period; null when no service codes are taken (no 0076). */
  label: ((validFrom: string, periodStart: string) => ServiceLabel) | null;
}

const fieldError = (field: string, message: string) => validationError(message, [{ field, message }]);

/**
 * Checks a contract's frequency and custom months and returns the schedule rule.
 * `newSelection`: the frequency is being chosen now (a new contract or renewal,
 * or a change of frequency), so it must be active. A contract keeps a frequency
 * that was disabled or archived after it was chosen.
 */
export async function resolveTerms(db: Queryable, code: string, months: readonly number[], newSelection: boolean): Promise<ResolvedTerms> {
  const frequency = await findContractFrequency(db, code);

  if (!frequency) {
    throw fieldError("maintenanceFrequency", "Select a maintenance frequency.");
  }
  if (newSelection && !frequency.isActive) {
    throw fieldError("maintenanceFrequency", "This maintenance frequency is not active. Only active frequencies can be selected for a contract.");
  }

  let rule: ScheduleRule;

  if (frequency.isCustom) {
    if (months.length === 0) {
      throw fieldError("customMonths", "Select the months in which visits take place.");
    }
    if (months.length > 11) {
      throw fieldError("customMonths", "Select at most 11 months. For a visit every month, choose the monthly frequency.");
    }
    rule = { kind: "months", months };
  } else {
    if (months.length > 0) {
      throw fieldError("customMonths", "Months are chosen only for a custom frequency.");
    }
    rule = { kind: "interval", intervalMonths: frequency.intervalMonths as number };
  }

  const prefix = frequency.prefix;

  return {
    frequency,
    rule,
    label: prefix ? (validFrom, periodStart) => serviceLabel(validFrom, rule, prefix, periodStart) : null,
  };
}
