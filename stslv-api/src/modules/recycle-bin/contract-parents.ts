import type { Queryable } from "../../shared/db";

// The records an AMC contract points at, read from the *_all tables so a record in
// the Recycle Bin is seen too. Used before a contract is restored: a parent in the
// Recycle Bin blocks the restore (migration 0106 refuses it again, SQLSTATE RB001),
// and a deactivated or archived parent is only a warning, because a contract keeps
// a link to a since-deactivated record everywhere else as well.

export type ParentKind = "CLIENT" | "SYSTEM_TYPE" | "SALES_ENGINEER" | "MAINTENANCE_FREQUENCY";

export interface ContractParent {
  kind: ParentKind;
  id: string;
  code: string;
  name: string;
  inRecycleBin: boolean;
  isActive: boolean;
  archived: boolean;
}

const LABEL: Record<ParentKind, string> = {
  CLIENT: "client",
  SYSTEM_TYPE: "system type",
  SALES_ENGINEER: "sales engineer",
  MAINTENANCE_FREQUENCY: "maintenance frequency",
};

/** The contract's client, system type, sales engineer and frequency. Empty when no contract has this id. */
export async function contractParents(db: Queryable, contractId: string): Promise<ContractParent[]> {
  const result = await db.query<{
    client_id: string; client_code: string; client_name: string; client_deleted: boolean; client_active: boolean;
    type_id: string | null; type_code: string | null; type_name: string | null; type_deleted: boolean | null; type_active: boolean | null;
    engineer_id: string | null; engineer_code: string | null; engineer_name: string | null; engineer_deleted: boolean | null; engineer_active: boolean | null;
    frequency_id: string | null; frequency_code: string | null; frequency_label: string | null; frequency_active: boolean | null; frequency_archived: boolean | null;
  }>(
    `SELECT c.client_id, ('CL-' || lpad(cl.id::text, greatest(5, length(cl.id::text)), '0')) AS client_code, cl.name AS client_name,
            cl.deleted_at IS NOT NULL AS client_deleted, cl.is_active AS client_active,
            st.id AS type_id, st.code AS type_code, st.name AS type_name, st.deleted_at IS NOT NULL AS type_deleted, st.is_active AS type_active,
            se.id AS engineer_id, se.code AS engineer_code, se.name AS engineer_name, se.deleted_at IS NOT NULL AS engineer_deleted, se.is_active AS engineer_active,
            mf.id AS frequency_id, mf.code AS frequency_code, mf.label AS frequency_label, mf.is_active AS frequency_active,
            (to_jsonb(mf) ->> 'archived_at') IS NOT NULL AS frequency_archived
     FROM amc_contracts_all c
     JOIN clients_all cl ON cl.id = c.client_id
     LEFT JOIN system_types_all st ON st.id = c.system_type_id
     LEFT JOIN sales_engineers_all se ON se.id = c.sales_engineer_id
     LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
     WHERE c.id = $1`,
    [contractId]
  );
  const row = result.rows[0];

  if (!row) return [];

  const parents: ContractParent[] = [
    { kind: "CLIENT", id: row.client_id, code: row.client_code, name: row.client_name, inRecycleBin: row.client_deleted, isActive: row.client_active, archived: false },
  ];

  if (row.type_id) {
    parents.push({ kind: "SYSTEM_TYPE", id: row.type_id, code: row.type_code ?? "", name: row.type_name ?? "", inRecycleBin: row.type_deleted === true, isActive: row.type_active === true, archived: false });
  }
  if (row.engineer_id) {
    parents.push({
      kind: "SALES_ENGINEER", id: row.engineer_id, code: row.engineer_code ?? "", name: row.engineer_name ?? "",
      inRecycleBin: row.engineer_deleted === true, isActive: row.engineer_active === true, archived: false,
    });
  }
  if (row.frequency_id) {
    parents.push({
      kind: "MAINTENANCE_FREQUENCY", id: row.frequency_id, code: row.frequency_code ?? "", name: row.frequency_label ?? "",
      inRecycleBin: false, isActive: row.frequency_active === true, archived: row.frequency_archived === true,
    });
  }

  return parents;
}

const describe = (parent: ContractParent) => `${LABEL[parent.kind]} ${parent.code} "${parent.name}"`;

/** Why the contract cannot be restored: each parent in the Recycle Bin, to be restored first. */
export function restoreBlockers(parents: ContractParent[]): string[] {
  return parents
    .filter((parent) => parent.inRecycleBin)
    .map((parent) => `Its ${describe(parent)} is in the Recycle Bin. Restore the ${LABEL[parent.kind]} first.`);
}

/** What the restore keeps as it is: links to deactivated or archived records. */
export function restoreWarnings(parents: ContractParent[]): string[] {
  return parents
    .filter((parent) => !parent.inRecycleBin && (!parent.isActive || parent.archived))
    .map((parent) => `Its ${describe(parent)} is ${parent.archived ? "archived" : "deactivated"}; the contract keeps the link.`);
}
