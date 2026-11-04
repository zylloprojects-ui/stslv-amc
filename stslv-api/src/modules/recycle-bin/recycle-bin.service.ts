import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { isSuperAdmin } from "../../shared/role-model";
import { escapeLike } from "../../shared/validation";
import { schemaHas } from "../../shared/schema-features";
import type { AuthContext } from "../auth/access";
import { hasStoredReference, referenceSql } from "../amc/contract-reference";
import { contractParents, restoreBlockers, restoreWarnings } from "./contract-parents";
import { MASTER_KINDS, TYPE_LABELS, type MasterKind, type MasterRecycleType, type RecycleType } from "./recycle-bin.kinds";
import type { ListRecycleBinQuery } from "./recycle-bin.schemas";

// Recycle Bin for clients, system types and sales engineers (approved 2026-11-04,
// migration 0106), alongside AMC contracts (0101). Rules:
//   * Super Admin only: moving to the Recycle Bin, restoring, permanent deletion and
//     the Recycle Bin list itself (403 for everyone else, whatever their permissions).
//   * Moving to the Recycle Bin keeps the row and every link. It is refused while a
//     record outside the Recycle Bin refers to it (D1, D2): AMC contracts not in the
//     Recycle Bin in any status, and for a client also invoices, projects and import rows.
//   * Restoring clears deleted_at on the same row: same id, same code, same links.
//     Names and codes stay reserved while in the Recycle Bin, so nothing can collide.
//   * Permanent deletion only from the Recycle Bin, only for a record that has never been
//     used (see purgeEvidence), and only after the user types its code. Never for AMC contracts.
//   * Deactivation is separate: a deactivated record stays on its own page and never
//     appears here.

const SUPER_ADMIN_ONLY = "Only Super Admin can use the Recycle Bin.";

export function assertRecycleBinAdmin(auth: AuthContext, message = SUPER_ADMIN_ONLY): void {
  if (!isSuperAdmin(auth.roles)) {
    throw forbidden(message);
  }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const pgCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

// ---------------------------------------------------------------------------
// Usage: what refers to a record
// ---------------------------------------------------------------------------

export interface MasterUsage {
  /** AMC contracts outside the Recycle Bin that refer to the record, by status. */
  contracts: { total: number; byStatus: Record<string, number> };
  /** AMC contracts in the Recycle Bin that refer to it. They do not block moving it to the Recycle Bin. */
  recycledContracts: number;
  /** Clients only (null otherwise): invoices of any status, projects and historical import rows. */
  invoices: number | null;
  projects: number | null;
  importRows: number | null;
}

export async function masterUsage(db: Queryable, kind: MasterKind, id: string): Promise<MasterUsage> {
  const contracts = await db.query<{ status: string; deleted: boolean; count: number }>(
    `SELECT status, deleted_at IS NOT NULL AS deleted, count(*)::int AS count
     FROM amc_contracts_all WHERE ${kind.contractColumn} = $1 GROUP BY 1, 2`,
    [id]
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  let recycled = 0;

  for (const row of contracts.rows) {
    if (row.deleted) {
      recycled += row.count;
    } else {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
      total += row.count;
    }
  }

  if (kind.type !== "CLIENT") {
    return { contracts: { total, byStatus }, recycledContracts: recycled, invoices: null, projects: null, importRows: null };
  }

  const other = await db.query<{ invoices: number; projects: number; import_rows: number }>(
    `SELECT (SELECT count(*)::int FROM invoices WHERE client_id = $1) AS invoices,
            (SELECT count(*)::int FROM projects WHERE client_id = $1) AS projects,
            (SELECT count(*)::int FROM legacy_import_rows WHERE client_id = $1) AS import_rows`,
    [id]
  );
  const row = other.rows[0];

  return {
    contracts: { total, byStatus },
    recycledContracts: recycled,
    invoices: row?.invoices ?? 0,
    projects: row?.projects ?? 0,
    importRows: row?.import_rows ?? 0,
  };
}

const STATUS_WORDS: Record<string, string> = { ACTIVE: "Active", DRAFT: "Draft", EXPIRED: "Expired", CANCELLED: "Cancelled" };

/** "2 AMC contracts (1 Active, 1 Cancelled)", or null when there are none. */
function describeContracts(usage: MasterUsage): string | null {
  if (usage.contracts.total === 0) return null;

  const parts = Object.entries(usage.contracts.byStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${count} ${STATUS_WORDS[status] ?? status}`);

  return `${plural(usage.contracts.total, "AMC contract")} (${parts.join(", ")})`;
}

/** What stops the record from being moved to the Recycle Bin. Empty when it can be. */
export function moveBlockers(usage: MasterUsage): string[] {
  const blockers: string[] = [];
  const contracts = describeContracts(usage);

  if (contracts) blockers.push(contracts);
  if (usage.projects) blockers.push(plural(usage.projects, "project"));
  if (usage.invoices) blockers.push(plural(usage.invoices, "invoice"));
  if (usage.importRows) blockers.push(plural(usage.importRows, "historical import row"));

  return blockers;
}

function inUseMessage(kind: MasterKind, name: string, usage: MasterUsage): string {
  const blockers = moveBlockers(usage);
  const what = blockers.length > 0 ? blockers.join(", ") : "other records";

  return `${kind.label} "${name}" cannot be moved to the Recycle Bin: it is used by ${what}. Disable it instead; those records keep it.`;
}

interface MasterRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  deleted_at: Date | null;
  snapshot: Record<string, unknown>;
}

async function lockMaster(db: Queryable, kind: MasterKind, id: string): Promise<MasterRow | null> {
  const result = await db.query<MasterRow>(
    `SELECT t.id, ${kind.codeSql("t")} AS code, t.name, t.is_active, t.deleted_at, to_jsonb(t) AS snapshot
     FROM ${kind.table} t WHERE t.id = $1 FOR UPDATE`,
    [id]
  );

  return result.rows[0] ?? null;
}

/** Usage for the delete dialog of a record outside the Recycle Bin (404 otherwise). */
export async function getMasterUsage(type: MasterRecycleType, id: string) {
  const kind = MASTER_KINDS[type];
  const found = await pool.query<{ name: string }>(`SELECT name FROM ${kind.table} WHERE id = $1 AND deleted_at IS NULL`, [id]);

  if (!found.rows[0]) {
    throw notFound(`${kind.label} not found.`);
  }

  const usage = await masterUsage(pool, kind, id);
  const blockers = moveBlockers(usage);

  return { ...usage, canMoveToRecycleBin: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Move to the Recycle Bin
// ---------------------------------------------------------------------------

export async function moveMasterToRecycleBin(auth: AuthContext, type: MasterRecycleType, id: string): Promise<void> {
  const kind = MASTER_KINDS[type];

  assertRecycleBinAdmin(auth, `Only Super Admin can move a ${kind.label.toLowerCase()} to the Recycle Bin. Disable it instead.`);

  let name = "";

  try {
    await withTransaction(async (db) => {
      // FOR UPDATE waits for any transaction linking a new record to this one (it holds FOR KEY SHARE),
      // so the usage below sees every committed link.
      const row = await lockMaster(db, kind, id);

      if (!row || row.deleted_at) {
        throw notFound(`${kind.label} not found.`);
      }
      name = row.name;

      const usage = await masterUsage(db, kind, id);

      if (moveBlockers(usage).length > 0) {
        throw conflict(inUseMessage(kind, row.name, usage));
      }

      await db.query(`UPDATE ${kind.table} SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, auth.user.id]);
      await logActivity(db, {
        userId: auth.user.id,
        action: `${kind.actionPrefix}.deleted`,
        module: kind.module,
        entityType: kind.entityType,
        entityId: id,
        description: `${kind.label} "${row.name}" (${row.code}) moved to the Recycle Bin; nothing was removed.`,
        metadata: { recycleBin: true, recycledContracts: usage.recycledContracts, deleted: row.snapshot },
      });
    });
  } catch (error) {
    // The database refuses it again (0106) should a link be made between the check and the update.
    if (pgCode(error) === "RB002") {
      throw conflict(inUseMessage(kind, name, await masterUsage(pool, kind, id)));
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** What a restore keeps as it is. Never blocking: names and codes stay reserved, and links to departments and users are kept. */
async function masterRestoreWarnings(db: Queryable, kind: MasterKind, row: MasterRow): Promise<string[]> {
  const warnings: string[] = [];

  if (!row.is_active) {
    warnings.push(`It was deactivated before it was moved to the Recycle Bin and is restored as deactivated.`);
  }
  if (kind.type === "SALES_ENGINEER") {
    const links = await db.query<{ department: string | null; department_active: boolean | null; user_name: string | null; user_active: boolean | null }>(
      `SELECT d.code || ' — ' || d.name AS department, d.is_active AS department_active,
              u.full_name AS user_name, (u.is_active AND u.approval_status = 'APPROVED') AS user_active
       FROM sales_engineers_all e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.id = $1`,
      [row.id]
    );
    const link = links.rows[0];

    if (link?.department && link.department_active === false) {
      warnings.push(`Its department ${link.department} is deactivated; the engineer keeps the link.`);
    }
    if (link?.user_name && link.user_active === false) {
      warnings.push(`Its user account ${link.user_name} is not active; the engineer keeps the link.`);
    }
  }

  return warnings;
}

export interface RestoreResult {
  type: RecycleType;
  id: string;
  reference: string;
  name: string;
  warnings: string[];
}

export async function restoreMaster(auth: AuthContext, type: MasterRecycleType, id: string): Promise<RestoreResult> {
  const kind = MASTER_KINDS[type];

  assertRecycleBinAdmin(auth);

  return withTransaction(async (db) => {
    const row = await lockMaster(db, kind, id);

    if (!row || !row.deleted_at) {
      throw notFound(`No ${kind.label.toLowerCase()} with this id is in the Recycle Bin.`);
    }

    const warnings = await masterRestoreWarnings(db, kind, row);

    await db.query(`UPDATE ${kind.table} SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [id]);
    await logActivity(db, {
      userId: auth.user.id,
      action: `${kind.actionPrefix}.restored`,
      module: kind.module,
      entityType: kind.entityType,
      entityId: id,
      description: `${kind.label} "${row.name}" (${row.code}) restored from the Recycle Bin.`,
      metadata: { recycleBin: true, ...(warnings.length > 0 ? { warnings } : {}) },
    });

    return { type, id, reference: row.code, name: row.name, warnings };
  });
}

/** The warnings an AMC contract restore would give, for the check and for the restore result. */
export async function contractRestoreState(db: Queryable, id: string) {
  const parents = await contractParents(db, id);

  return { blockers: restoreBlockers(parents), warnings: restoreWarnings(parents) };
}

// ---------------------------------------------------------------------------
// Permanent deletion: only a record that has never been used
// ---------------------------------------------------------------------------

/**
 * Every reason the record might have been used. Empty means it has never been used, as far as the
 * database can tell, and may be deleted permanently. A reason is given whenever use cannot be ruled out:
 *   * anything that refers to it now, in any status, including records in the Recycle Bin;
 *   * a missing creation entry in the Audit Log: it was imported or seeded, so its past is unknown;
 *   * any other Audit Log entry that names it (by any name or code it has had) or stores its id,
 *     such as a contract once linked to it and since changed;
 *   * for an engineer, contracts that name it as the responsible engineer in their typed text.
 */
export async function purgeEvidence(db: Queryable, kind: MasterKind, row: MasterRow): Promise<string[]> {
  const reasons: string[] = [];
  const usage = await masterUsage(db, kind, row.id);
  const allContracts = usage.contracts.total + usage.recycledContracts;

  if (allContracts > 0) {
    reasons.push(
      `It is used by ${plural(allContracts, "AMC contract")}${usage.recycledContracts > 0 ? ` (${usage.recycledContracts} in the Recycle Bin)` : ""}.`
    );
  }
  if (usage.invoices) reasons.push(`It is used by ${plural(usage.invoices, "invoice")}.`);
  if (usage.projects) reasons.push(`It is used by ${plural(usage.projects, "project")}.`);
  if (usage.importRows) reasons.push(`It is used by ${plural(usage.importRows, "historical import row")}.`);

  const created = await db.query<{ found: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM activity_logs WHERE entity_type = $1 AND entity_id = $2 AND action = $3) AS found",
    [kind.entityType, row.id, `${kind.actionPrefix}.created`]
  );
  if (!created.rows[0]?.found) {
    reasons.push("Its creation is not recorded in the Audit Log (it was imported or added another way), so earlier use cannot be ruled out.");
  }

  // Every name and code the record has had: the current ones and those its own change history records.
  const names = await db.query<{ name: string }>(
    `SELECT DISTINCT lower(btrim(value)) AS name FROM (
       SELECT $3::text AS value UNION ALL SELECT $4::text
       UNION ALL SELECT l.metadata -> 'changes' -> f.field ->> 'from' FROM activity_logs l, (VALUES ('name'), ('code')) f(field)
         WHERE l.entity_type = $1 AND l.entity_id = $2
       UNION ALL SELECT l.metadata -> 'changes' -> f.field ->> 'to' FROM activity_logs l, (VALUES ('name'), ('code')) f(field)
         WHERE l.entity_type = $1 AND l.entity_id = $2
     ) n WHERE value IS NOT NULL AND btrim(value) <> ''`,
    [kind.entityType, row.id, row.name, row.code]
  );
  const nameList = names.rows.map((item) => item.name);
  const idPath = `lax $.** ? (${kind.idKeys.map((key) => `exists(@."${key}" ? (@ == $id || @ == $sid))`).join(" || ")})`;

  const mentions = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM activity_logs l
     WHERE l.metadata IS NOT NULL
       AND NOT (l.entity_type = $1 AND l.entity_id = $2)
       AND (EXISTS (SELECT 1 FROM jsonb_path_query(l.metadata, 'strict $.**') v
                    WHERE jsonb_typeof(v) = 'string' AND lower(btrim(v #>> '{}')) = ANY($3::text[]))
            OR jsonb_path_exists(l.metadata, $4::jsonpath, jsonb_build_object('id', $5::bigint, 'sid', $6::text), true))`,
    [kind.entityType, row.id, nameList, idPath, row.id, row.id]
  );
  const mentionCount = mentions.rows[0]?.count ?? 0;

  if (mentionCount > 0) {
    reasons.push(`The Audit Log refers to it in ${plural(mentionCount, "entry", "entries")} about other records, so it may have been used.`);
  }

  if (kind.type === "SALES_ENGINEER") {
    const typed = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM amc_contracts_all WHERE responsible_engineer IS NOT NULL AND lower(btrim(responsible_engineer)) = ANY($1::text[])",
      [nameList]
    );
    const count = typed.rows[0]?.count ?? 0;

    if (count > 0) {
      reasons.push(`${plural(count, "AMC contract")} ${count === 1 ? "names" : "name"} it as the responsible engineer.`);
    }
  }

  return reasons;
}

export async function purgeMaster(auth: AuthContext, type: MasterRecycleType, id: string, confirm: string): Promise<void> {
  const kind = MASTER_KINDS[type];

  assertRecycleBinAdmin(auth);

  try {
    await withTransaction(async (db) => {
      const row = await lockMaster(db, kind, id);

      if (!row || !row.deleted_at) {
        throw notFound(`No ${kind.label.toLowerCase()} with this id is in the Recycle Bin. Only a record in the Recycle Bin can be deleted permanently.`);
      }
      if (confirm.trim().toLowerCase() !== row.code.trim().toLowerCase()) {
        throw validationError(`Type ${row.code} to confirm the permanent deletion.`, [{ field: "confirm", message: `Type ${row.code} to confirm.` }]);
      }

      const reasons = await purgeEvidence(db, kind, row);

      if (reasons.length > 0) {
        throw conflict(`${kind.label} "${row.name}" cannot be deleted permanently because it may have been used. ${reasons.join(" ")} It stays in the Recycle Bin.`);
      }

      await db.query(`DELETE FROM ${kind.table} WHERE id = $1`, [id]);

      if (kind.type === "SALES_ENGINEER") {
        // The code is never given out again (migration 0102).
        await db.query(
          `INSERT INTO sales_engineer_retired_codes (code_key, code, engineer_id, name, retired_by)
           VALUES (lower($1), $1, $2, $3, $4) ON CONFLICT (code_key) DO NOTHING`,
          [row.code, id, row.name, auth.user.id]
        );
      }

      await logActivity(db, {
        userId: auth.user.id,
        action: `${kind.actionPrefix}.purged`,
        module: kind.module,
        entityType: kind.entityType,
        entityId: id,
        description: `${kind.label} "${row.name}" (${row.code}) deleted permanently from the Recycle Bin. It had never been used.`,
        // The record no longer exists; the log keeps all of it.
        metadata: { recycleBin: true, deleted: row.snapshot },
      });
    });
  } catch (error) {
    // ON DELETE RESTRICT is the last guard. Never report "0": say that other records refer to it.
    if (pgCode(error) === "23503") {
      throw conflict(`${kind.label} cannot be deleted permanently: other records refer to it. It stays in the Recycle Bin.`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Check: what restore and permanent deletion would do, for the Recycle Bin page
// ---------------------------------------------------------------------------

export interface RecycleCheck {
  type: RecycleType;
  id: string;
  reference: string;
  name: string;
  restore: { allowed: boolean; blockers: string[]; warnings: string[] };
  purge: { allowed: boolean; reasons: string[]; confirmText: string | null };
}

export async function checkRecycleItem(auth: AuthContext, type: RecycleType, id: string): Promise<RecycleCheck> {
  assertRecycleBinAdmin(auth);

  if (type === "AMC_CONTRACT") {
    const stored = await hasStoredReference();
    const found = await pool.query<{ reference: string; client_name: string }>(
      `SELECT ${referenceSql("c", stored)} AS reference, cl.name AS client_name
       FROM amc_contracts_all c JOIN clients_all cl ON cl.id = c.client_id WHERE c.id = $1 AND c.deleted_at IS NOT NULL`,
      [id]
    );
    const row = found.rows[0];

    if (!row) throw notFound("No AMC contract with this id is in the Recycle Bin.");

    const state = await contractRestoreState(pool, id);

    return {
      type,
      id,
      reference: row.reference,
      name: row.client_name,
      restore: { allowed: state.blockers.length === 0, ...state },
      purge: { allowed: false, reasons: ["AMC contracts are never deleted permanently; they stay in the Recycle Bin until restored."], confirmText: null },
    };
  }

  const kind = MASTER_KINDS[type];

  // A read in a transaction, so the evidence is one consistent view; the row lock is released at once.
  return withTransaction(async (db) => {
    const row = await lockMaster(db, kind, id);

    if (!row || !row.deleted_at) throw notFound(`No ${kind.label.toLowerCase()} with this id is in the Recycle Bin.`);

    const [warnings, reasons] = [await masterRestoreWarnings(db, kind, row), await purgeEvidence(db, kind, row)];

    return {
      type,
      id,
      reference: row.code,
      name: row.name,
      restore: { allowed: true, blockers: [], warnings },
      purge: { allowed: reasons.length === 0, reasons, confirmText: reasons.length === 0 ? row.code : null },
    };
  });
}

// ---------------------------------------------------------------------------
// List: the records currently in the Recycle Bin (current state, never events)
// ---------------------------------------------------------------------------

export interface RecycleBinItem {
  type: RecycleType;
  typeLabel: string;
  id: string;
  reference: string;
  name: string;
  details: string | null;
  status: string | null;
  isActive: boolean | null;
  deletedAt: string;
  deletedBy: { id: string; fullName: string } | null;
  /** AMC contracts only: what is kept with it. */
  contract: { validFrom: string; validTo: string; contractValue: string | null; services: number; invoices: number; documents: number } | null;
}

async function binSql(): Promise<string> {
  const stored = await hasStoredReference();

  return `
    SELECT 'AMC_CONTRACT'::text AS type, c.id, ${referenceSql("c", stored)} AS reference, cl.name AS name,
           c.system_description AS details, c.status, NULL::boolean AS is_active, c.deleted_at, c.deleted_by
    FROM amc_contracts_all c JOIN clients_all cl ON cl.id = c.client_id WHERE c.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'CLIENT', t.id, ${MASTER_KINDS.CLIENT.codeSql("t")}, t.name, t.contact_person, NULL, t.is_active, t.deleted_at, t.deleted_by
    FROM clients_all t WHERE t.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'SYSTEM_TYPE', t.id, t.code, t.name, t.description, NULL, t.is_active, t.deleted_at, t.deleted_by
    FROM system_types_all t WHERE t.deleted_at IS NOT NULL
    UNION ALL
    SELECT 'SALES_ENGINEER', t.id, t.code, t.name, t.email, NULL, t.is_active, t.deleted_at, t.deleted_by
    FROM sales_engineers_all t WHERE t.deleted_at IS NOT NULL`;
}

export async function listRecycleBin(auth: AuthContext, query: ListRecycleBinQuery) {
  assertRecycleBinAdmin(auth);

  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions: string[] = [];

  if (query.type) conditions.push(`b.type = ${add(query.type)}`);
  if (query.deletedBy) conditions.push(`b.deleted_by = ${add(query.deletedBy)}`);
  if (query.from) conditions.push(`b.deleted_at >= ${add(query.from)}::date`);
  if (query.to) conditions.push(`b.deleted_at < ${add(query.to)}::date + 1`);
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    conditions.push(`(b.reference ILIKE ${p} OR b.name ILIKE ${p} OR b.details ILIKE ${p})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const bin = await binSql();
  // The count takes the filter values only; the page query adds LIMIT and OFFSET to its own copy.
  const filterParams = [...params];
  const [total, rows, counts, deleters] = await Promise.all([
    pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM (${bin}) b ${where}`, filterParams),
    pool.query<{
      type: RecycleType; id: string; reference: string; name: string; details: string | null; status: string | null;
      is_active: boolean | null; deleted_at: Date; deleted_by: string | null; deleted_by_name: string | null;
    }>(
      `SELECT b.*, u.full_name AS deleted_by_name FROM (${bin}) b LEFT JOIN users u ON u.id = b.deleted_by ${where}
       ORDER BY b.deleted_at DESC, b.type, b.id DESC
       LIMIT ${add(query.pageSize)} OFFSET ${add((query.page - 1) * query.pageSize)}`,
      params
    ),
    // Per type, for the tabs; without the filters, so each tab shows what it holds.
    pool.query<{ type: RecycleType; count: number }>(`SELECT b.type, count(*)::int AS count FROM (${bin}) b GROUP BY b.type`),
    pool.query<{ id: string; full_name: string }>(
      `SELECT DISTINCT u.id, u.full_name FROM (${bin}) b JOIN users u ON u.id = b.deleted_by ORDER BY u.full_name, u.id`
    ),
  ]);

  const contractIds = rows.rows.filter((row) => row.type === "AMC_CONTRACT").map((row) => row.id);
  const contractExtras = new Map<string, NonNullable<RecycleBinItem["contract"]>>();

  if (contractIds.length > 0) {
    const documents = (await schemaHas(["attachments"]))
      ? "(SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'amc_contracts' AND a.entity_id = c.id AND a.is_current)"
      : "0";
    const extras = await pool.query<{ id: string; valid_from: string; valid_to: string; contract_value: string | null; services: number; invoices: number; documents: number }>(
      `SELECT c.id, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to, c.contract_value,
              (SELECT count(*)::int FROM amc_visits_all v WHERE v.amc_contract_id = c.id) AS services,
              (SELECT count(DISTINCT al.invoice_id)::int FROM invoice_allocations al JOIN amc_visits_all v ON v.id = al.amc_visit_id
               WHERE v.amc_contract_id = c.id) AS invoices,
              ${documents} AS documents
       FROM amc_contracts_all c WHERE c.id = ANY($1::bigint[])`,
      [contractIds]
    );

    for (const row of extras.rows) {
      contractExtras.set(row.id, {
        validFrom: row.valid_from,
        validTo: row.valid_to,
        contractValue: row.contract_value,
        services: row.services,
        invoices: row.invoices,
        documents: row.documents,
      });
    }
  }

  const byType = Object.fromEntries(counts.rows.map((row) => [row.type, row.count]));

  return {
    items: rows.rows.map(
      (row): RecycleBinItem => ({
        type: row.type,
        typeLabel: TYPE_LABELS[row.type],
        id: row.id,
        reference: row.reference,
        name: row.name,
        details: row.details,
        status: row.status,
        isActive: row.is_active,
        deletedAt: row.deleted_at.toISOString(),
        deletedBy: row.deleted_by ? { id: row.deleted_by, fullName: row.deleted_by_name ?? "" } : null,
        contract: row.type === "AMC_CONTRACT" ? (contractExtras.get(row.id) ?? null) : null,
      })
    ),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    counts: { AMC_CONTRACT: byType.AMC_CONTRACT ?? 0, CLIENT: byType.CLIENT ?? 0, SYSTEM_TYPE: byType.SYSTEM_TYPE ?? 0, SALES_ENGINEER: byType.SALES_ENGINEER ?? 0 },
    options: { deletedBy: deleters.rows.map((row) => ({ id: row.id, fullName: row.full_name })) },
  };
}
