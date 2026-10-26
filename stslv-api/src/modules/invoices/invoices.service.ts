import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, isUniqueViolation, notFound, validationError, type ErrorDetail } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { InvoiceEligibility } from "../amc/amc.constants";
import type { AuthContext } from "../auth/access";
import type { InvoiceState } from "../projects/projects.schemas";
import type {
  AllocationInput,
  CancelInvoiceInput,
  CreateInvoiceInput,
  InvoiceSource,
  InvoiceStatus,
  ListBillableQuery,
  ListInvoicesQuery,
  UpdateInvoiceInput,
} from "./invoices.schemas";

// Invoices are raised in Zoho. This module records what the Zoho invoice says
// and which completed work it covers. It calculates nothing from a rate: the
// amount excluding VAT and the VAT amount are both entered by the user.
//
// PROVISIONAL business rules, pending client confirmation:
//   * an invoice covers completed work only (no invoice before completion);
//   * every piece of work on an invoice belongs to the invoice's client;
//   * the allocations add up exactly to the amount excluding VAT;
//   * a visit or project may be covered by more than one invoice (Q5, Q21);
//   * a cancelled invoice is kept, counts nowhere, and cannot be changed.

interface InvoiceRow {
  id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  invoice_date: string;
  amount_excl_vat: string;
  vat_amount: string;
  total_amount: string;
  status: InvoiceStatus;
  source: InvoiceSource;
  source_reference: string | null;
  notes: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancelled_by_name: string | null;
  cancellation_reason: string | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  updated_at: Date;
}

interface AllocationRow {
  id: string;
  invoice_id: string;
  allocated_amount: string;
  amc_visit_id: string | null;
  project_id: string | null;
  amc_contract_id: string | null;
  system_description: string | null;
  sequence_no: number | null;
  period_start: string | null;
  period_end: string | null;
  visit_completed_date: string | null;
  job_number: string | null;
  project_description: string | null;
}

export interface InvoiceAllocation {
  id: string;
  /** Part of the invoice's amount excluding VAT. */
  amount: string;
  /** Exactly one of amcVisit and project is present. */
  amcVisit: {
    id: string;
    contractId: string;
    systemDescription: string;
    sequenceNo: number;
    periodStart: string;
    periodEnd: string;
    completedDate: string | null;
  } | null;
  project: { id: string; jobNumber: string; description: string } | null;
}

/** Money is a decimal string with three decimals, exactly as PostgreSQL holds it. */
export interface Invoice {
  id: string;
  invoiceNumber: string;
  client: { id: string; name: string };
  /** YYYY-MM-DD */
  invoiceDate: string;
  amountExclVat: string;
  vatAmount: string;
  /** amountExclVat + vatAmount, added by PostgreSQL. */
  totalAmount: string;
  status: InvoiceStatus;
  source: InvoiceSource;
  sourceReference: string | null;
  notes: string | null;
  cancelledAt: string | null;
  cancelledBy: { id: string; fullName: string } | null;
  cancellationReason: string | null;
  createdBy: { id: string; fullName: string };
  createdAt: string;
  updatedAt: string;
  allocations: InvoiceAllocation[];
}

// The date columns are read as text so a calendar day is never shifted by a time zone.
const SELECT_INVOICE = `
  SELECT i.id, i.invoice_number, i.client_id, c.name AS client_name, i.invoice_date::text AS invoice_date,
         i.amount_excl_vat, i.vat_amount, i.total_amount, i.status, i.source, i.source_reference, i.notes,
         i.cancelled_at, i.cancelled_by, cu.full_name AS cancelled_by_name, i.cancellation_reason,
         i.created_by, u.full_name AS created_by_name, i.created_at, i.updated_at
  FROM invoices i
  JOIN clients c ON c.id = i.client_id
  JOIN users u ON u.id = i.created_by
  LEFT JOIN users cu ON cu.id = i.cancelled_by`;

const SELECT_ALLOCATIONS = `
  SELECT al.id, al.invoice_id, al.allocated_amount, al.amc_visit_id, al.project_id,
         v.amc_contract_id, ac.system_description, v.sequence_no,
         v.period_start::text AS period_start, v.period_end::text AS period_end,
         v.completed_date::text AS visit_completed_date,
         p.job_number, p.description AS project_description
  FROM invoice_allocations al
  LEFT JOIN amc_visits v ON v.id = al.amc_visit_id
  LEFT JOIN amc_contracts ac ON ac.id = v.amc_contract_id
  LEFT JOIN projects p ON p.id = al.project_id
  WHERE al.invoice_id = ANY($1::bigint[])
  ORDER BY al.id`;

const EDITABLE_FIELDS = ["invoiceNumber", "clientId", "invoiceDate", "amountExclVat", "vatAmount", "sourceReference", "notes"] as const;

function toAllocation(row: AllocationRow): InvoiceAllocation {
  return {
    id: row.id,
    amount: row.allocated_amount,
    amcVisit: row.amc_visit_id
      ? {
          id: row.amc_visit_id,
          contractId: row.amc_contract_id as string,
          systemDescription: row.system_description as string,
          sequenceNo: row.sequence_no as number,
          periodStart: row.period_start as string,
          periodEnd: row.period_end as string,
          completedDate: row.visit_completed_date,
        }
      : null,
    project: row.project_id
      ? { id: row.project_id, jobNumber: row.job_number as string, description: row.project_description as string }
      : null,
  };
}

function toInvoice(row: InvoiceRow, allocations: AllocationRow[]): Invoice {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    client: { id: row.client_id, name: row.client_name },
    invoiceDate: row.invoice_date,
    amountExclVat: row.amount_excl_vat,
    vatAmount: row.vat_amount,
    totalAmount: row.total_amount,
    status: row.status,
    source: row.source,
    sourceReference: row.source_reference,
    notes: row.notes,
    cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    cancelledBy: row.cancelled_by && row.cancelled_by_name ? { id: row.cancelled_by, fullName: row.cancelled_by_name } : null,
    cancellationReason: row.cancellation_reason,
    createdBy: { id: row.created_by, fullName: row.created_by_name },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    allocations: allocations.map(toAllocation),
  };
}

async function loadInvoices(db: Queryable, rows: InvoiceRow[]): Promise<Invoice[]> {
  if (rows.length === 0) {
    return [];
  }

  const allocations = await db.query<AllocationRow>(SELECT_ALLOCATIONS, [rows.map((row) => row.id)]);
  const byInvoice = new Map<string, AllocationRow[]>();

  for (const allocation of allocations.rows) {
    const list = byInvoice.get(allocation.invoice_id);

    if (list) {
      list.push(allocation);
    } else {
      byInvoice.set(allocation.invoice_id, [allocation]);
    }
  }

  return rows.map((row) => toInvoice(row, byInvoice.get(row.id) ?? []));
}

async function findInvoice(db: Queryable, id: string): Promise<Invoice> {
  const result = await db.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
  const [invoice] = await loadInvoices(db, result.rows);

  if (!invoice) {
    throw notFound("Invoice not found.");
  }

  return invoice;
}

/** Locks the invoice row for the rest of the transaction, then reads it. */
async function lockInvoice(db: Queryable, id: string): Promise<Invoice> {
  const locked = await db.query("SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE", [id]);

  if (locked.rowCount === 0) {
    throw notFound("Invoice not found.");
  }

  return findInvoice(db, id);
}

// ---------------------------------------------------------------------------
// Validation of what an invoice covers
// ---------------------------------------------------------------------------

interface VisitTarget {
  id: string;
  status: string;
  has_amount: boolean | null;
  sequence_no: number;
  client_id: string;
  client_name: string;
  system_description: string;
}

interface ProjectTarget {
  id: string;
  status: string;
  has_value: boolean;
  job_number: string;
  client_id: string;
}

/**
 * Locks the visits and projects an invoice is to cover, then checks each one:
 * it exists, is completed operational work with something to invoice, and
 * belongs to the invoice's client. The locks keep that true until the
 * transaction commits: a visit cannot be reopened, or have its amount changed,
 * while the invoice is being recorded.
 */
async function lockAndCheckTargets(db: Queryable, clientId: string, allocations: AllocationInput[]): Promise<void> {
  const details: ErrorDetail[] = [];
  const visitIds = allocations.flatMap((allocation) => (allocation.amcVisitId ? [allocation.amcVisitId] : []));
  const projectIds = allocations.flatMap((allocation) => (allocation.projectId ? [allocation.projectId] : []));
  const visits = new Map<string, VisitTarget>();
  const projects = new Map<string, ProjectTarget>();

  if (visitIds.length > 0) {
    // The contract carries the client, so it is held against a change of client.
    await db.query(
      `SELECT c.id FROM amc_contracts c
       WHERE c.id IN (SELECT amc_contract_id FROM amc_visits WHERE id = ANY($1::bigint[]))
       ORDER BY c.id FOR SHARE`,
      [visitIds]
    );
    await db.query("SELECT id FROM amc_visits WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE", [visitIds]);

    const result = await db.query<VisitTarget>(
      `SELECT v.id, v.status, v.visit_amount > 0 AS has_amount, v.sequence_no,
              c.client_id, cl.name AS client_name, c.system_description
       FROM amc_visits v
       JOIN amc_contracts c ON c.id = v.amc_contract_id
       JOIN clients cl ON cl.id = c.client_id
       WHERE v.id = ANY($1::bigint[])`,
      [visitIds]
    );

    for (const row of result.rows) {
      visits.set(row.id, row);
    }
  }

  if (projectIds.length > 0) {
    await db.query("SELECT id FROM projects WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE", [projectIds]);

    const result = await db.query<ProjectTarget>(
      "SELECT id, status, job_value > 0 AS has_value, job_number, client_id FROM projects WHERE id = ANY($1::bigint[])",
      [projectIds]
    );

    for (const row of result.rows) {
      projects.set(row.id, row);
    }
  }

  const seen = new Set<string>();

  allocations.forEach((allocation, index) => {
    const field = `allocations.${index}`;
    const key = allocation.amcVisitId ? `visit:${allocation.amcVisitId}` : `project:${allocation.projectId}`;

    if (seen.has(key)) {
      details.push({ field, message: "The same visit or project is listed more than once on this invoice." });
      return;
    }
    seen.add(key);

    if (allocation.amcVisitId) {
      const visit = visits.get(allocation.amcVisitId);

      if (!visit) {
        details.push({ field, message: "The selected AMC visit does not exist." });
        return;
      }

      const label = `Visit ${visit.sequence_no} for "${visit.client_name}" (${visit.system_description})`;

      if (visit.status === "HISTORICAL") {
        details.push({ field, message: `${label} is a historical record. An invoice cannot be recorded against it.` });
      } else if (visit.status !== "COMPLETED") {
        details.push({ field, message: `${label} is not completed. An invoice can only be recorded against completed work.` });
      } else if (visit.has_amount === null) {
        details.push({ field, message: `${label} has no amount. Enter the visit amount first.` });
      } else if (!visit.has_amount) {
        details.push({ field, message: `${label} has an amount of zero: there is nothing to invoice.` });
      } else if (visit.client_id !== clientId) {
        details.push({ field, message: `${label} does not belong to the client of this invoice.` });
      }
      return;
    }

    const project = projects.get(allocation.projectId as string);

    if (!project) {
      details.push({ field, message: "The selected project does not exist." });
      return;
    }

    const label = `Project ${project.job_number}`;

    if (project.status === "HISTORICAL") {
      details.push({ field, message: `${label} is a historical record. An invoice cannot be recorded against it.` });
    } else if (project.status !== "COMPLETED") {
      details.push({ field, message: `${label} is not completed. An invoice can only be recorded against completed work.` });
    } else if (!project.has_value) {
      details.push({ field, message: `${label} has a job value of zero: there is nothing to invoice.` });
    } else if (project.client_id !== clientId) {
      details.push({ field, message: `${label} does not belong to the client of this invoice.` });
    }
  });

  if (details.length > 0) {
    throw validationError("Some allocations are invalid.", details);
  }
}

/** The allocations must add up to the amount excluding VAT, to the third decimal. PostgreSQL does the arithmetic. */
async function assertReconciles(db: Queryable, amountExclVat: string, allocations: AllocationInput[]): Promise<void> {
  const result = await db.query<{ total: string; reconciles: boolean }>(
    `SELECT COALESCE(sum(a), 0)::numeric(18,3)::text AS total, COALESCE(sum(a), 0) = $2::numeric AS reconciles
     FROM unnest($1::numeric[]) AS a`,
    [allocations.map((allocation) => allocation.amount), amountExclVat]
  );
  const row = result.rows[0] as { total: string; reconciles: boolean };

  if (!row.reconciles) {
    const message = `The allocations add up to ${row.total}, but the invoice amount excluding VAT is ${amountExclVat}. They must be equal.`;

    throw validationError(message, [{ field: "allocations", message }]);
  }
}

async function requireClient(db: Queryable, clientId: string): Promise<void> {
  const result = await db.query("SELECT 1 FROM clients WHERE id = $1", [clientId]);

  if (result.rowCount === 0) {
    throw validationError("Some fields are invalid.", [{ field: "clientId", message: "The selected client does not exist." }]);
  }
}

async function insertAllocations(db: Queryable, invoiceId: string, userId: string, allocations: AllocationInput[]): Promise<void> {
  for (const allocation of allocations) {
    await db.query(
      `INSERT INTO invoice_allocations (invoice_id, amc_visit_id, project_id, allocated_amount, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [invoiceId, allocation.amcVisitId ?? null, allocation.projectId ?? null, allocation.amount, userId]
    );
  }
}

/** What the activity log keeps about the allocations of an invoice. */
const allocationLog = (invoice: Invoice) =>
  invoice.allocations.map((allocation) =>
    allocation.amcVisit
      ? { amcVisitId: allocation.amcVisit.id, amount: allocation.amount }
      : { projectId: allocation.project?.id, jobNumber: allocation.project?.jobNumber, amount: allocation.amount }
  );

const toInputs = (invoice: Invoice): AllocationInput[] =>
  invoice.allocations.map((allocation) =>
    allocation.amcVisit
      ? { amcVisitId: allocation.amcVisit.id, amount: allocation.amount }
      : { projectId: allocation.project?.id as string, amount: allocation.amount }
  );

/** Order-independent text form of a set of allocations, to tell whether it changed. */
const allocationKey = (allocations: AllocationInput[]) =>
  allocations
    .map((allocation) => `${allocation.amcVisitId ? `visit:${allocation.amcVisitId}` : `project:${allocation.projectId}`}=${allocation.amount}`)
    .sort()
    .join("|");

function duplicateNumber(invoiceNumber: string) {
  const message = `Invoice ${invoiceNumber} is already recorded. Cancel that record first if it was entered by mistake.`;

  return conflict(message, [{ field: "invoiceNumber", message }]);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The filters of the invoice list, without paging: the list and the export share them, so they always select the same invoices. */
export type InvoiceFilters = Omit<ListInvoicesQuery, "page" | "pageSize">;

function invoiceFilter(query: InvoiceFilters): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status) {
    params.push(query.status);
    conditions.push(`i.status = $${params.length}`);
  }
  if (query.clientId) {
    params.push(query.clientId);
    conditions.push(`i.client_id = $${params.length}`);
  }
  if (query.projectId) {
    params.push(query.projectId);
    conditions.push(`EXISTS (SELECT 1 FROM invoice_allocations al WHERE al.invoice_id = i.id AND al.project_id = $${params.length})`);
  }
  if (query.amcVisitId) {
    params.push(query.amcVisitId);
    conditions.push(`EXISTS (SELECT 1 FROM invoice_allocations al WHERE al.invoice_id = i.id AND al.amc_visit_id = $${params.length})`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    conditions.push(`i.invoice_date >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    conditions.push(`i.invoice_date <= $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(i.invoice_number ILIKE ${p} OR c.name ILIKE ${p} OR i.source_reference ILIKE ${p}
        OR EXISTS (SELECT 1 FROM invoice_allocations al JOIN projects pj ON pj.id = al.project_id
                   WHERE al.invoice_id = i.id AND pj.job_number ILIKE ${p}))`
    );
  }

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

const INVOICE_ORDER = "ORDER BY i.invoice_date DESC, i.id DESC";

/**
 * Totals cover every invoice that matches the filters, not only the page shown.
 * Cancelled invoices never count towards an amount.
 */
async function invoiceTotals(where: string, params: unknown[]) {
  const totals = await pool.query<{ count: number; amount_excl_vat: string; vat_amount: string; total_amount: string }>(
    `SELECT count(*)::int AS count,
            COALESCE(sum(i.amount_excl_vat) FILTER (WHERE i.status <> 'CANCELLED'), 0)::numeric(18,3) AS amount_excl_vat,
            COALESCE(sum(i.vat_amount) FILTER (WHERE i.status <> 'CANCELLED'), 0)::numeric(18,3) AS vat_amount,
            COALESCE(sum(i.total_amount) FILTER (WHERE i.status <> 'CANCELLED'), 0)::numeric(18,3) AS total_amount
     FROM invoices i
     JOIN clients c ON c.id = i.client_id
     ${where}`,
    params
  );

  return {
    total: totals.rows[0]?.count ?? 0,
    totals: {
      amountExclVat: totals.rows[0]?.amount_excl_vat ?? "0.000",
      vatAmount: totals.rows[0]?.vat_amount ?? "0.000",
      totalAmount: totals.rows[0]?.total_amount ?? "0.000",
    },
  };
}

export async function listInvoices(query: ListInvoicesQuery) {
  const { where, params } = invoiceFilter(query);
  const { total, totals } = await invoiceTotals(where, params);
  const rows = await pool.query<InvoiceRow>(
    `${SELECT_INVOICE} ${where}
     ${INVOICE_ORDER}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return { items: await loadInvoices(pool, rows.rows), total, page: query.page, pageSize: query.pageSize, totals };
}

/**
 * Every invoice that matches the filters, in the order of the list, for an
 * export. `checkSize` is given the number of invoices before any is read, and
 * throws when that is more than the export can hold.
 */
export async function listAllInvoices(filters: InvoiceFilters, checkSize: (count: number) => void) {
  const { where, params } = invoiceFilter(filters);
  const { total, totals } = await invoiceTotals(where, params);

  checkSize(total);

  const rows = await pool.query<InvoiceRow>(`${SELECT_INVOICE} ${where} ${INVOICE_ORDER}`, params);

  return { items: await loadInvoices(pool, rows.rows), total, totals };
}

export function getInvoice(id: string): Promise<Invoice> {
  return findInvoice(pool, id);
}

// ---------------------------------------------------------------------------
// Work that can be invoiced
// ---------------------------------------------------------------------------

export interface BillableVisit {
  id: string;
  contractId: string;
  client: { id: string; name: string };
  systemDescription: string;
  sequenceNo: number;
  periodStart: string;
  periodEnd: string;
  completedDate: string;
  /** As entered on the visit. Whether it includes VAT is unconfirmed. */
  visitAmount: string;
  invoiceEligibility: InvoiceEligibility;
  /** Sum of what active invoices allocate to the visit, excluding VAT. */
  invoicedAmount: string;
}

export interface BillableProject {
  id: string;
  jobNumber: string;
  description: string;
  client: { id: string; name: string };
  completedDate: string;
  /** Excluding VAT. */
  jobValue: string;
  invoiceState: InvoiceState;
  invoicedValue: string;
  /** Job value not yet covered by an active invoice. */
  uninvoicedValue: string;
}

export interface BillableWork {
  /** Null without AMC_SCHEDULE:VIEW: visit amounts are not disclosed through Invoice Tracking. */
  amcVisits: { items: BillableVisit[]; pendingCount: number; pendingAmount: string } | null;
  /** Null without PROJECTS:VIEW: job values are not disclosed through Invoice Tracking. */
  projects: { items: BillableProject[]; pendingCount: number; pendingValue: string } | null;
}

const PENDING_VISIT = "b.invoice_eligibility = 'READY_FOR_INVOICE'";
const PENDING_PROJECT = "f.invoice_state IN ('READY_FOR_INVOICE', 'PARTLY_INVOICED')";

/**
 * Completed work waiting for an invoice: the work list of Invoice Tracking.
 * With includeInvoiced, the work of one client that an invoice already covers
 * is listed too, so a further invoice can be recorded against it. The pending
 * figures always count the waiting work only.
 */
export async function listBillableWork(auth: AuthContext, query: ListBillableQuery): Promise<BillableWork> {
  const includeInvoiced = query.includeInvoiced === "true";
  const params: unknown[] = [];
  let clientCondition = "";

  if (query.clientId) {
    params.push(query.clientId);
    clientCondition = "AND cl.id = $1";
  }

  const work: BillableWork = { amcVisits: null, projects: null };

  if (auth.permissions.has("AMC_SCHEDULE:VIEW")) {
    const result = await pool.query<{
      id: string;
      amc_contract_id: string;
      client_id: string;
      client_name: string;
      system_description: string;
      sequence_no: number;
      period_start: string;
      period_end: string;
      completed_date: string;
      visit_amount: string;
      invoice_eligibility: InvoiceEligibility;
      invoiced_amount: string;
      pending_count: number;
      pending_amount: string;
    }>(
      `SELECT v.id, v.amc_contract_id, cl.id AS client_id, cl.name AS client_name, c.system_description, v.sequence_no,
              v.period_start::text AS period_start, v.period_end::text AS period_end,
              v.completed_date::text AS completed_date, v.visit_amount, b.invoice_eligibility, b.invoiced_amount,
              (count(*) FILTER (WHERE ${PENDING_VISIT}) OVER ())::int AS pending_count,
              COALESCE(sum(v.visit_amount) FILTER (WHERE ${PENDING_VISIT}) OVER (), 0)::numeric(18,3) AS pending_amount
       FROM amc_visits v
       JOIN amc_contracts c ON c.id = v.amc_contract_id
       JOIN clients cl ON cl.id = c.client_id
       JOIN v_amc_visit_billing b ON b.amc_visit_id = v.id
       WHERE (${PENDING_VISIT}${includeInvoiced ? " OR b.invoice_eligibility = 'INVOICED'" : ""}) ${clientCondition}
       ORDER BY v.completed_date, lower(cl.name), v.id`,
      params
    );

    work.amcVisits = {
      items: result.rows.map((row) => ({
        id: row.id,
        contractId: row.amc_contract_id,
        client: { id: row.client_id, name: row.client_name },
        systemDescription: row.system_description,
        sequenceNo: row.sequence_no,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        completedDate: row.completed_date,
        visitAmount: row.visit_amount,
        invoiceEligibility: row.invoice_eligibility,
        invoicedAmount: row.invoiced_amount,
      })),
      pendingCount: result.rows[0]?.pending_count ?? 0,
      pendingAmount: result.rows[0]?.pending_amount ?? "0.000",
    };
  }

  if (auth.permissions.has("PROJECTS:VIEW")) {
    const result = await pool.query<{
      id: string;
      job_number: string;
      description: string;
      client_id: string;
      client_name: string;
      completed_date: string;
      job_value: string;
      invoice_state: InvoiceState;
      invoiced_value: string;
      uninvoiced_value: string;
      pending_count: number;
      pending_value: string;
    }>(
      `SELECT p.id, p.job_number, p.description, cl.id AS client_id, cl.name AS client_name,
              p.completed_date::text AS completed_date, p.job_value, f.invoice_state, f.invoiced_value, f.uninvoiced_value,
              (count(*) FILTER (WHERE ${PENDING_PROJECT}) OVER ())::int AS pending_count,
              COALESCE(sum(f.uninvoiced_value) FILTER (WHERE ${PENDING_PROJECT}) OVER (), 0)::numeric(18,3) AS pending_value
       FROM projects p
       JOIN clients cl ON cl.id = p.client_id
       JOIN v_project_financials f ON f.project_id = p.id
       WHERE (${PENDING_PROJECT}${includeInvoiced ? " OR f.invoice_state = 'INVOICED'" : ""}) ${clientCondition}
       ORDER BY p.completed_date, lower(cl.name), p.id`,
      params
    );

    work.projects = {
      items: result.rows.map((row) => ({
        id: row.id,
        jobNumber: row.job_number,
        description: row.description,
        client: { id: row.client_id, name: row.client_name },
        completedDate: row.completed_date,
        jobValue: row.job_value,
        invoiceState: row.invoice_state,
        invoicedValue: row.invoiced_value,
        uninvoicedValue: row.uninvoiced_value,
      })),
      pendingCount: result.rows[0]?.pending_count ?? 0,
      pendingValue: result.rows[0]?.pending_value ?? "0.000",
    };
  }

  return work;
}

// ---------------------------------------------------------------------------
// Summary (dashboard and reports)
// ---------------------------------------------------------------------------

export interface InvoiceSummary {
  /** Active invoices; a cancelled invoice is in none of the amounts. */
  issued: { count: number; amountExclVat: string; vatAmount: string; totalAmount: string };
  cancelled: { count: number };
  /**
   * Requires AMC_SCHEDULE:VIEW. AMC and project amounts are never added
   * together: whether visit amounts include VAT is unconfirmed.
   */
  amc: {
    /** Completed visits with an amount, not yet covered by an invoice. */
    pending: { count: number; amount: string };
    invoiced: { count: number; invoicedAmount: string };
  } | null;
  /** Requires PROJECTS:VIEW. All values exclude VAT. */
  projects: {
    /** Completed projects with job value not yet covered by an invoice (ready or partly invoiced). */
    pending: { count: number; uninvoicedValue: string };
    partlyInvoiced: { count: number };
    invoiced: { count: number };
    /** What active invoices allocate to projects. */
    invoicedValue: string;
  } | null;
}

export async function getInvoiceSummary(auth: AuthContext): Promise<InvoiceSummary> {
  const invoices = await pool.query<{
    issued_count: number;
    cancelled_count: number;
    amount_excl_vat: string;
    vat_amount: string;
    total_amount: string;
  }>(
    `SELECT count(*) FILTER (WHERE status <> 'CANCELLED')::int AS issued_count,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_count,
            COALESCE(sum(amount_excl_vat) FILTER (WHERE status <> 'CANCELLED'), 0)::numeric(18,3) AS amount_excl_vat,
            COALESCE(sum(vat_amount) FILTER (WHERE status <> 'CANCELLED'), 0)::numeric(18,3) AS vat_amount,
            COALESCE(sum(total_amount) FILTER (WHERE status <> 'CANCELLED'), 0)::numeric(18,3) AS total_amount
     FROM invoices`
  );
  const row = invoices.rows[0];
  const summary: InvoiceSummary = {
    issued: {
      count: row?.issued_count ?? 0,
      amountExclVat: row?.amount_excl_vat ?? "0.000",
      vatAmount: row?.vat_amount ?? "0.000",
      totalAmount: row?.total_amount ?? "0.000",
    },
    cancelled: { count: row?.cancelled_count ?? 0 },
    amc: null,
    projects: null,
  };

  if (auth.permissions.has("AMC_SCHEDULE:VIEW")) {
    const result = await pool.query<{ pending_count: number; pending_amount: string; invoiced_count: number; invoiced_amount: string }>(
      `SELECT count(*) FILTER (WHERE ${PENDING_VISIT})::int AS pending_count,
              COALESCE(sum(v.visit_amount) FILTER (WHERE ${PENDING_VISIT}), 0)::numeric(18,3) AS pending_amount,
              count(*) FILTER (WHERE b.invoice_eligibility = 'INVOICED')::int AS invoiced_count,
              COALESCE(sum(b.invoiced_amount), 0)::numeric(18,3) AS invoiced_amount
       FROM amc_visits v
       JOIN v_amc_visit_billing b ON b.amc_visit_id = v.id`
    );
    const amc = result.rows[0];

    summary.amc = {
      pending: { count: amc?.pending_count ?? 0, amount: amc?.pending_amount ?? "0.000" },
      invoiced: { count: amc?.invoiced_count ?? 0, invoicedAmount: amc?.invoiced_amount ?? "0.000" },
    };
  }

  if (auth.permissions.has("PROJECTS:VIEW")) {
    const result = await pool.query<{
      pending_count: number;
      pending_value: string;
      partly_count: number;
      invoiced_count: number;
      invoiced_value: string;
    }>(
      `SELECT count(*) FILTER (WHERE ${PENDING_PROJECT})::int AS pending_count,
              COALESCE(sum(f.uninvoiced_value) FILTER (WHERE ${PENDING_PROJECT}), 0)::numeric(18,3) AS pending_value,
              count(*) FILTER (WHERE f.invoice_state = 'PARTLY_INVOICED')::int AS partly_count,
              count(*) FILTER (WHERE f.invoice_state = 'INVOICED')::int AS invoiced_count,
              COALESCE(sum(f.invoiced_value), 0)::numeric(18,3) AS invoiced_value
       FROM projects p
       JOIN v_project_financials f ON f.project_id = p.id`
    );
    const projects = result.rows[0];

    summary.projects = {
      pending: { count: projects?.pending_count ?? 0, uninvoicedValue: projects?.pending_value ?? "0.000" },
      partlyInvoiced: { count: projects?.partly_count ?? 0 },
      invoiced: { count: projects?.invoiced_count ?? 0 },
      invoicedValue: projects?.invoiced_value ?? "0.000",
    };
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function createInvoice(auth: AuthContext, input: CreateInvoiceInput): Promise<Invoice> {
  try {
    return await withTransaction(async (client) => {
      await requireClient(client, input.clientId);
      await lockAndCheckTargets(client, input.clientId, input.allocations);
      await assertReconciles(client, input.amountExclVat, input.allocations);

      // total_amount is added by PostgreSQL from the two amounts entered.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO invoices (invoice_number, client_id, invoice_date, amount_excl_vat, vat_amount,
                               source_reference, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING id`,
        [
          input.invoiceNumber,
          input.clientId,
          input.invoiceDate,
          input.amountExclVat,
          input.vatAmount,
          input.sourceReference ?? null,
          input.notes ?? null,
          auth.user.id,
        ]
      );
      const id = (inserted.rows[0] as { id: string }).id;

      await insertAllocations(client, id, auth.user.id, input.allocations);

      const created = await findInvoice(client, id);

      await logActivity(client, {
        userId: auth.user.id,
        action: "invoice.created",
        module: "INVOICES",
        entityType: "invoices",
        entityId: id,
        description: `Invoice ${created.invoiceNumber} recorded for ${created.client.name}.`,
        metadata: {
          invoiceNumber: created.invoiceNumber,
          invoiceDate: created.invoiceDate,
          amountExclVat: created.amountExclVat,
          vatAmount: created.vatAmount,
          totalAmount: created.totalAmount,
          allocations: allocationLog(created),
        },
      });

      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error, "invoices_invoice_number_uq")) {
      throw duplicateNumber(input.invoiceNumber);
    }
    throw error;
  }
}

export async function updateInvoice(auth: AuthContext, id: string, input: UpdateInvoiceInput): Promise<Invoice> {
  try {
    return await withTransaction(async (client) => {
      const before = await lockInvoice(client, id);

      if (before.status === "CANCELLED") {
        throw conflict(`Invoice ${before.invoiceNumber} is cancelled and cannot be changed.`);
      }

      const beforeValues = {
        invoiceNumber: before.invoiceNumber,
        clientId: before.client.id,
        invoiceDate: before.invoiceDate,
        amountExclVat: before.amountExclVat,
        vatAmount: before.vatAmount,
        sourceReference: before.sourceReference,
        notes: before.notes,
      };
      const afterValues: Record<(typeof EDITABLE_FIELDS)[number], string | null> = { ...beforeValues };

      for (const field of EDITABLE_FIELDS) {
        const value = input[field];
        if (value !== undefined) {
          afterValues[field] = value;
        }
      }

      const changes: Record<string, unknown> = diffFields(beforeValues, afterValues, EDITABLE_FIELDS);
      const beforeAllocations = toInputs(before);
      const allocations = input.allocations ?? beforeAllocations;
      const allocationsChanged = allocationKey(allocations) !== allocationKey(beforeAllocations);

      if (Object.keys(changes).length === 0 && !allocationsChanged) {
        return before;
      }

      const clientId = afterValues.clientId as string;
      const amountExclVat = afterValues.amountExclVat as string;

      if ("clientId" in changes) {
        await requireClient(client, clientId);
      }
      // What the invoice covers is checked again whenever the client, the
      // amount or the allocations change, so the rules hold for the result.
      if ("clientId" in changes || "amountExclVat" in changes || allocationsChanged) {
        await lockAndCheckTargets(client, clientId, allocations);
        await assertReconciles(client, amountExclVat, allocations);
      }

      if (allocationsChanged) {
        await client.query("DELETE FROM invoice_allocations WHERE invoice_id = $1", [id]);
      }

      await client.query(
        `UPDATE invoices
         SET invoice_number = $1, client_id = $2, invoice_date = $3, amount_excl_vat = $4, vat_amount = $5,
             source_reference = $6, notes = $7, updated_by = $8
         WHERE id = $9`,
        [
          afterValues.invoiceNumber,
          clientId,
          afterValues.invoiceDate,
          amountExclVat,
          afterValues.vatAmount,
          afterValues.sourceReference,
          afterValues.notes,
          auth.user.id,
          id,
        ]
      );

      if (allocationsChanged) {
        await insertAllocations(client, id, auth.user.id, allocations);
      }

      const updated = await findInvoice(client, id);

      if (allocationsChanged) {
        changes.allocations = { from: allocationLog(before), to: allocationLog(updated) };
      }

      await logActivity(client, {
        userId: auth.user.id,
        action: "invoice.updated",
        module: "INVOICES",
        entityType: "invoices",
        entityId: id,
        description: `Invoice ${before.invoiceNumber} updated.`,
        metadata: { changes },
      });

      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error, "invoices_invoice_number_uq")) {
      throw duplicateNumber(input.invoiceNumber ?? "with this number");
    }
    throw error;
  }
}

/**
 * Invoices are never deleted. A cancelled invoice keeps its allocations for
 * the record, but they count nowhere: the work it covered is ready for
 * invoice again and is no longer locked.
 */
export function cancelInvoice(auth: AuthContext, id: string, input: CancelInvoiceInput): Promise<Invoice> {
  return withTransaction(async (client) => {
    const before = await lockInvoice(client, id);

    if (before.status === "CANCELLED") {
      throw conflict(`Invoice ${before.invoiceNumber} is already cancelled.`);
    }

    await client.query(
      `UPDATE invoices
       SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $1, cancellation_reason = $2, updated_by = $1
       WHERE id = $3`,
      [auth.user.id, input.reason, id]
    );

    await logActivity(client, {
      userId: auth.user.id,
      action: "invoice.cancelled",
      module: "INVOICES",
      entityType: "invoices",
      entityId: id,
      description: `Invoice ${before.invoiceNumber} for ${before.client.name} cancelled.`,
      metadata: {
        reason: input.reason,
        invoiceNumber: before.invoiceNumber,
        amountExclVat: before.amountExclVat,
        vatAmount: before.vatAmount,
        totalAmount: before.totalAmount,
        allocations: allocationLog(before),
      },
    });

    return findInvoice(client, id);
  });
}
