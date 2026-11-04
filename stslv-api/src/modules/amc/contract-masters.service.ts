import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { notFound, validationError } from "../../shared/errors";
import type { AuthContext } from "../auth/access";
import type { ContractMastersInput } from "./amc.schemas";

// The link from an AMC contract to a sales engineer and a system type (migration
// 0070). Linking never changes the contract's typed engineer, its schedule or its
// amounts. Since 2026-11-03 a system type link also sets the contract's system to
// the type's name, and a recorded link can be changed but not removed.

export interface ContractMasters {
  salesEngineer: { id: string; name: string; employeeNo: string | null; isActive: boolean } | null;
  systemType: { id: string; code: string; name: string; isActive: boolean } | null;
}

async function load(db: Queryable, contractId: string, lock = false): Promise<ContractMasters> {
  const result = await db.query<{
    se_id: string | null;
    se_name: string | null;
    se_employee_no: string | null;
    se_active: boolean | null;
    st_id: string | null;
    st_code: string | null;
    st_name: string | null;
    st_active: boolean | null;
  }>(
    `SELECT e.id AS se_id, e.name AS se_name, e.employee_no AS se_employee_no, e.is_active AS se_active,
            t.id AS st_id, t.code AS st_code, t.name AS st_name, t.is_active AS st_active
     FROM amc_contracts c
     LEFT JOIN sales_engineers e ON e.id = c.sales_engineer_id
     LEFT JOIN system_types t ON t.id = c.system_type_id
     WHERE c.id = $1 ${lock ? "FOR UPDATE OF c" : ""}`,
    [contractId]
  );
  const row = result.rows[0];

  if (!row) {
    throw notFound("AMC contract not found.");
  }

  return {
    salesEngineer: row.se_id ? { id: row.se_id, name: row.se_name ?? "", employeeNo: row.se_employee_no, isActive: row.se_active ?? false } : null,
    systemType: row.st_id ? { id: row.st_id, code: row.st_code ?? "", name: row.st_name ?? "", isActive: row.st_active ?? false } : null,
  };
}

export function getContractMasters(contractId: string): Promise<ContractMasters> {
  return load(pool, contractId);
}

async function assertActive(db: Queryable, table: "sales_engineers" | "system_types", id: string, field: string, label: string) {
  const result = await db.query<{ is_active: boolean }>(`SELECT is_active FROM ${table} WHERE id = $1`, [id]);

  if (!result.rows[0]?.is_active) {
    throw validationError(`Select an active ${label}.`, [{ field, message: `Select an active ${label}.` }]);
  }
}

export function setContractMasters(auth: AuthContext, contractId: string, input: ContractMastersInput): Promise<ContractMasters> {
  return withTransaction((db) => applyContractMasters(db, auth, contractId, input));
}

/** Within the caller's transaction: changes the links that are given, validates them and records the change. */
export async function applyContractMasters(db: Queryable, auth: AuthContext, contractId: string, input: ContractMastersInput): Promise<ContractMasters> {
  const before = await load(db, contractId, true);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const sets: string[] = [];
  const params: unknown[] = [];

  // Since 2026-11-03 both links are required on new contracts. A link that is recorded can be changed but never
  // removed, by any route (the contract form, the Link master records panel). An older contract without a link
  // stays valid and can be linked later; nothing is backfilled.
  if (input.salesEngineerId === null && before.salesEngineer !== null) {
    throw validationError("Select a sales engineer.", [{ field: "salesEngineerId", message: "A sales engineer is required. Choose another engineer instead of removing the link." }]);
  }
  if (input.systemTypeId === null && before.systemType !== null) {
    throw validationError("Select a system.", [{ field: "systemTypeId", message: "A system is required. Choose another system type instead of removing the link." }]);
  }

  let systemName: string | null = null;

  if (input.salesEngineerId !== undefined && input.salesEngineerId !== (before.salesEngineer?.id ?? null)) {
    if (input.salesEngineerId) await assertActive(db, "sales_engineers", input.salesEngineerId, "salesEngineerId", "sales engineer");
    params.push(input.salesEngineerId);
    sets.push(`sales_engineer_id = $${params.length}`);
  }
  if (input.systemTypeId !== undefined && input.systemTypeId !== (before.systemType?.id ?? null)) {
    if (input.systemTypeId) await assertActive(db, "system_types", input.systemTypeId, "systemTypeId", "system type");
    params.push(input.systemTypeId);
    sets.push(`system_type_id = $${params.length}`);
    // The contract's system is the linked type's name, so the two never disagree.
    systemName = ((await db.query<{ name: string }>("SELECT name FROM system_types WHERE id = $1", [input.systemTypeId])).rows[0] as { name: string }).name;
    params.push(systemName);
    sets.push(`system_description = $${params.length}`);
  }
  const beforeSystem = systemName === null ? null : ((await db.query<{ system_description: string }>("SELECT system_description FROM amc_contracts WHERE id = $1", [contractId])).rows[0] as { system_description: string }).system_description;

  if (sets.length === 0) {
    return before;
  }

  params.push(auth.user.id, contractId);
  await db.query(`UPDATE amc_contracts SET ${sets.join(", ")}, updated_by = $${params.length - 1} WHERE id = $${params.length}`, params);

  const after = await load(db, contractId);

  // Recorded by name, so the contract history reads in words.
  if ((before.salesEngineer?.id ?? null) !== (after.salesEngineer?.id ?? null)) {
    changes.salesEngineer = { from: before.salesEngineer?.name ?? null, to: after.salesEngineer?.name ?? null };
  }
  if ((before.systemType?.id ?? null) !== (after.systemType?.id ?? null)) {
    changes.systemType = {
      from: before.systemType ? `${before.systemType.code} — ${before.systemType.name}` : null,
      to: after.systemType ? `${after.systemType.code} — ${after.systemType.name}` : null,
    };
  }
  if (systemName !== null && beforeSystem !== systemName) {
    changes.systemDescription = { from: beforeSystem, to: systemName };
  }

  await logActivity(db, {
    userId: auth.user.id,
    action: "amc_contract.masters_linked",
    module: "AMC_CONTRACTS",
    entityType: "amc_contracts",
    entityId: contractId,
    description: "Master records linked to the AMC contract changed.",
    metadata: { changes },
  });

  return after;
}
