import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { requireOpenProject } from "../projects/projects.service";
import type {
  ChangeProcurementStatusInput,
  CreateProcurementInput,
  ListProcurementQuery,
  ProcurementStatus,
  UpdateProcurementInput,
} from "./procurement.schemas";

interface ProcurementRow {
  id: string;
  project_id: string;
  job_number: string;
  project_description: string;
  client_name: string;
  reference: string | null;
  description: string;
  request_date: string;
  supplier_name: string | null;
  quotation_reference: string | null;
  quotation_date: string | null;
  quotation_amount: string | null;
  po_reference: string | null;
  order_date: string | null;
  expected_delivery_date: string | null;
  delivered_date: string | null;
  status: ProcurementStatus;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProcurementRequest {
  id: string;
  projectId: string;
  jobNumber: string;
  projectDescription: string;
  clientName: string;
  reference: string | null;
  description: string;
  requestDate: string;
  supplierName: string | null;
  quotationReference: string | null;
  quotationDate: string | null;
  /** A commitment, not a recorded cost. Decimal string with three decimals. */
  quotationAmount: string | null;
  poReference: string | null;
  orderDate: string | null;
  expectedDeliveryDate: string | null;
  deliveredDate: string | null;
  status: ProcurementStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const SELECT_PROCUREMENT = `
  SELECT r.id, r.project_id, p.job_number, p.description AS project_description, c.name AS client_name,
         r.reference, r.description, r.request_date::text AS request_date, r.supplier_name,
         r.quotation_reference, r.quotation_date::text AS quotation_date, r.quotation_amount,
         r.po_reference, r.order_date::text AS order_date,
         r.expected_delivery_date::text AS expected_delivery_date, r.delivered_date::text AS delivered_date,
         r.status, r.notes, r.created_at, r.updated_at
  FROM procurement_requests r
  JOIN projects p ON p.id = r.project_id
  JOIN clients c ON c.id = p.client_id`;

const EDITABLE_FIELDS = [
  "reference",
  "description",
  "requestDate",
  "supplierName",
  "quotationReference",
  "quotationDate",
  "quotationAmount",
  "poReference",
  "orderDate",
  "expectedDeliveryDate",
  "notes",
] as const;

function toProcurement(row: ProcurementRow): ProcurementRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    jobNumber: row.job_number,
    projectDescription: row.project_description,
    clientName: row.client_name,
    reference: row.reference,
    description: row.description,
    requestDate: row.request_date,
    supplierName: row.supplier_name,
    quotationReference: row.quotation_reference,
    quotationDate: row.quotation_date,
    quotationAmount: row.quotation_amount,
    poReference: row.po_reference,
    orderDate: row.order_date,
    expectedDeliveryDate: row.expected_delivery_date,
    deliveredDate: row.delivered_date,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findProcurement(db: Queryable, id: string, lock = false): Promise<ProcurementRequest> {
  const result = await db.query<ProcurementRow>(`${SELECT_PROCUREMENT} WHERE r.id = $1${lock ? " FOR UPDATE OF r" : ""}`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Procurement request not found.");
  }

  return toProcurement(row);
}

export async function listProcurement(query: ListProcurementQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.projectId) {
    params.push(query.projectId);
    conditions.push(`r.project_id = $${params.length}`);
  }
  if (query.status) {
    params.push(query.status);
    conditions.push(`r.status = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(r.description ILIKE ${p} OR r.reference ILIKE ${p} OR r.supplier_name ILIKE ${p}
        OR r.quotation_reference ILIKE ${p} OR r.po_reference ILIKE ${p} OR p.job_number ILIKE ${p})`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM procurement_requests r
     JOIN projects p ON p.id = r.project_id
     ${where}`,
    params
  );

  const rows = await pool.query<ProcurementRow>(
    `${SELECT_PROCUREMENT} ${where}
     ORDER BY r.request_date DESC, r.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toProcurement),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export function getProcurement(id: string): Promise<ProcurementRequest> {
  return findProcurement(pool, id);
}

export function createProcurement(auth: AuthContext, input: CreateProcurementInput): Promise<ProcurementRequest> {
  return withTransaction(async (client) => {
    const project = await requireOpenProject(client, input.projectId);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO procurement_requests (project_id, reference, description, request_date, supplier_name,
                                         quotation_reference, quotation_date, quotation_amount, po_reference,
                                         order_date, expected_delivery_date, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
       RETURNING id`,
      [
        input.projectId,
        input.reference ?? null,
        input.description,
        input.requestDate,
        input.supplierName ?? null,
        input.quotationReference ?? null,
        input.quotationDate ?? null,
        input.quotationAmount ?? null,
        input.poReference ?? null,
        input.orderDate ?? null,
        input.expectedDeliveryDate ?? null,
        input.notes ?? null,
        auth.user.id,
      ]
    );
    const id = (inserted.rows[0] as { id: string }).id;

    await logActivity(client, {
      userId: auth.user.id,
      action: "procurement.created",
      module: "PROCUREMENT",
      entityType: "procurement_requests",
      entityId: id,
      description: `Procurement request added to project ${project.jobNumber}.`,
      metadata: { projectId: project.id, jobNumber: project.jobNumber },
    });

    return findProcurement(client, id);
  });
}

export function updateProcurement(auth: AuthContext, id: string, input: UpdateProcurementInput): Promise<ProcurementRequest> {
  return withTransaction(async (client) => {
    const before = await findProcurement(client, id, true);

    if (before.status === "CANCELLED") {
      throw conflict("A cancelled procurement request cannot be edited. Change its status first.");
    }

    const after: ProcurementRequest = { ...before };

    for (const field of EDITABLE_FIELDS) {
      const value = input[field];
      if (value !== undefined) {
        (after[field] as string | null) = value;
      }
    }

    const changes = diffFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      EDITABLE_FIELDS
    );

    if (Object.keys(changes).length === 0) {
      return before;
    }

    await client.query(
      `UPDATE procurement_requests
       SET reference = $1, description = $2, request_date = $3, supplier_name = $4, quotation_reference = $5,
           quotation_date = $6, quotation_amount = $7, po_reference = $8, order_date = $9,
           expected_delivery_date = $10, notes = $11, updated_by = $12
       WHERE id = $13`,
      [
        after.reference,
        after.description,
        after.requestDate,
        after.supplierName,
        after.quotationReference,
        after.quotationDate,
        after.quotationAmount,
        after.poReference,
        after.orderDate,
        after.expectedDeliveryDate,
        after.notes,
        auth.user.id,
        id,
      ]
    );

    await logActivity(client, {
      userId: auth.user.id,
      action: "procurement.updated",
      module: "PROCUREMENT",
      entityType: "procurement_requests",
      entityId: id,
      description: `Procurement request on project ${before.jobNumber} updated.`,
      metadata: { changes },
    });

    return findProcurement(client, id);
  });
}

// PROVISIONAL (open question Q8): no order of statuses and no approval step
// is enforced, because none has been confirmed. A request may be moved to any
// status; each change is written to the activity log.
export function changeProcurementStatus(
  auth: AuthContext,
  id: string,
  input: ChangeProcurementStatusInput
): Promise<ProcurementRequest> {
  return withTransaction(async (client) => {
    const before = await findProcurement(client, id, true);

    if (input.deliveredDate && input.status !== "DELIVERED") {
      throw validationError("Some fields are invalid.", [
        { field: "deliveredDate", message: "A delivered date can only be given with the Delivered status." },
      ]);
    }

    let deliveredDate: string | null = null;

    if (input.status === "DELIVERED") {
      const today = await client.query<{ today: string }>("SELECT CURRENT_DATE::text AS today");
      deliveredDate = input.deliveredDate ?? before.deliveredDate ?? (today.rows[0] as { today: string }).today;
    }

    if (before.status === input.status && before.deliveredDate === deliveredDate) {
      return before;
    }

    await client.query("UPDATE procurement_requests SET status = $1, delivered_date = $2, updated_by = $3 WHERE id = $4", [
      input.status,
      deliveredDate,
      auth.user.id,
      id,
    ]);

    await logActivity(client, {
      userId: auth.user.id,
      action: "procurement.status_changed",
      module: "PROCUREMENT",
      entityType: "procurement_requests",
      entityId: id,
      description: `Procurement request on project ${before.jobNumber} changed from ${before.status} to ${input.status}.`,
      metadata: { from: before.status, to: input.status, deliveredDate },
    });

    return findProcurement(client, id);
  });
}
