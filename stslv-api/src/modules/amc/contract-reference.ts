import { pool } from "../../config/database";
import { conflict, isUniqueViolation } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import { AMC_REFERENCE_UNIQUE_INDEX, DUPLICATE_AMC_REFERENCE } from "./amc-reference.rules";

// The AMC Reference Number of a contract.
//
// From migration 0105 it is stored in amc_contracts.amc_reference: typed by the
// user when the contract (or a renewal) is created, never generated, and
// read-only afterwards. Every contract that existed before 0105 was given the
// reference it already showed ("AMC-0007" for contract 7), so nothing was
// renumbered. Relationships always use the contract id, never this text.
//
// On a database without 0105 the old derived reference is shown, and new
// contracts cannot be created (the typed reference could not be kept).

/** Whether this database stores the reference (migration 0105). */
export function hasStoredReference(): Promise<boolean> {
  return schemaHas(["amc_contracts.amc_reference"]);
}

/** SQL for the reference of the contract row with the given alias. Without 0105: the derived text the 0105 backfill stores. */
export function referenceSql(alias: string, stored: boolean): string {
  return stored ? `${alias}.amc_reference` : `('AMC-' || lpad(${alias}.id::text, greatest(4, length(${alias}.id::text)), '0'))`;
}

/**
 * SQL for the reference that needs no schema check, for fixed query text: reads the column through to_jsonb (as
 * the visit queries read 0076 columns), falling back to the derived text on a database without 0105.
 */
export function referenceStaticSql(alias: string): string {
  return `COALESCE(to_jsonb(${alias}) ->> 'amc_reference', ${referenceSql(alias, false)})`;
}

/** SQL for the reference of the contract whose id is the given expression (any contract, Recycle Bin included). */
export function referenceOfIdSql(idSql: string, stored: boolean): string {
  return stored
    ? `(SELECT rc.amc_reference FROM amc_contracts_all rc WHERE rc.id = ${idSql})`
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

/** Turns the unique-index violation into the duplicate message; anything else is rethrown unchanged. */
export function rethrowDuplicateReference(error: unknown): never {
  if (isUniqueViolation(error, AMC_REFERENCE_UNIQUE_INDEX)) {
    throw conflict(DUPLICATE_AMC_REFERENCE, [{ field: "amcReference", message: DUPLICATE_AMC_REFERENCE }]);
  }
  throw error;
}
