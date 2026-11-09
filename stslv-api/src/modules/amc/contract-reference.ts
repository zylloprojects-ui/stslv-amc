import { pool } from "../../config/database";
import { conflict, isUniqueViolation } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import { AMC_REFERENCE_HISTORY_KEY, AMC_REFERENCE_UNIQUE_INDEX, DUPLICATE_AMC_REFERENCE, RETIRED_AMC_REFERENCE } from "./amc-reference.rules";

// The AMC Reference Number of a contract.
//
// From migration 0105 it is stored in amc_contracts.amc_reference: typed by the
// user when the contract (or a renewal) is created, never generated, and
// editable afterwards (2026-11-04). Migration 0107 keeps every number a contract
// has held (amc_contract_references), so a number given up by an edit is never
// given to another contract. Every contract that existed before 0105 was given the
// reference it already showed ("AMC-0007" for contract 7), so nothing was
// renumbered. Relationships always use the contract id, never this text.
//
// On a database without 0105 the old derived reference is shown, and new
// contracts cannot be created (the typed reference could not be kept).

/** Whether this database stores the reference (migration 0105). */
export function hasStoredReference(): Promise<boolean> {
  return schemaHas(["amc_contracts.amc_reference"]);
}

/**
 * The version of a contract row (migration 0111, contract versions), read through to_jsonb so the SQL also runs on a
 * database without the column (every contract is then version 1).
 */
export function versionSql(alias: string): string {
  return `COALESCE((to_jsonb(${alias}) ->> 'contract_version')::int, 1)`;
}

/**
 * Display text of a contract period: the visible contract number, plus " (V2)" from the second version on (0111), so
 * the original and its renewals show the SAME number and each period can still be told apart. Version 1, and every
 * contract made before 0111, shows the number alone, exactly as before.
 */
function labelled(numberSql: string, alias: string): string {
  const version = versionSql(alias);
  return `(${numberSql} || CASE WHEN ${version} > 1 THEN ' (V' || ${version} || ')' ELSE '' END)`;
}

/** The visible contract number itself (never with a version), as stored: the value a user types and edits. */
export function rawReferenceSql(alias: string, stored: boolean): string {
  return stored ? `${alias}.amc_reference` : `('AMC-' || lpad(${alias}.id::text, greatest(4, length(${alias}.id::text)), '0'))`;
}

/**
 * SQL for the reference of the contract row with the given alias, as shown on every list, report and export: the
 * contract number with its version from the second version on. Without 0105: the derived text the 0105 backfill stores.
 */
export function referenceSql(alias: string, stored: boolean): string {
  return labelled(rawReferenceSql(alias, stored), alias);
}

/**
 * SQL for the reference that needs no schema check, for fixed query text: reads the column through to_jsonb (as
 * the visit queries read 0076 columns), falling back to the derived text on a database without 0105.
 */
export function referenceStaticSql(alias: string): string {
  return labelled(`COALESCE(to_jsonb(${alias}) ->> 'amc_reference', ${rawReferenceSql(alias, false)})`, alias);
}

/** SQL for the reference of the contract whose id is the given expression (any contract, Recycle Bin included). */
export function referenceOfIdSql(idSql: string, stored: boolean): string {
  return stored
    ? `(SELECT ${referenceSql("rc", true)} FROM amc_contracts_all rc WHERE rc.id = ${idSql})`
    : `('AMC-' || lpad((${idSql})::text, greatest(4, length((${idSql})::text)), '0'))`;
}

/** The reference of one contract (Recycle Bin included), or null when no contract has this id. For report headings and messages. */
export async function findContractReference(contractId: string): Promise<string | null> {
  const stored = await hasStoredReference();
  const result = await pool.query<{ reference: string }>(
    `SELECT ${referenceSql("c", stored)} AS reference FROM ${stored ? "amc_contracts_all" : "amc_contracts"} c WHERE c.id = $1`,
    [contractId]
  );

  return result.rows[0]?.reference ?? null;
}

/**
 * Turns a reference conflict into its message; anything else is rethrown unchanged. 0105's unique index: another
 * contract holds the number now. 0107's history key: another contract held it before (it was changed by an edit).
 */
export function rethrowDuplicateReference(error: unknown): never {
  if (isUniqueViolation(error, AMC_REFERENCE_UNIQUE_INDEX)) {
    throw conflict(DUPLICATE_AMC_REFERENCE, [{ field: "amcReference", message: DUPLICATE_AMC_REFERENCE }]);
  }
  if (isUniqueViolation(error, AMC_REFERENCE_HISTORY_KEY)) {
    throw conflict(RETIRED_AMC_REFERENCE, [{ field: "amcReference", message: RETIRED_AMC_REFERENCE }]);
  }
  throw error;
}
