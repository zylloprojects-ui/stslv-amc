import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { logActivity } from "../../shared/activity-log";
import { businessDateSql } from "../../shared/business-date";
import { withTransaction, type Queryable } from "../../shared/db";
import { AppError, conflict, notFound, validationError } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import { escapeLike } from "../../shared/validation";
import { hasStoredReference, referenceSql, versionSql } from "../amc/contract-reference";
import { IN_SCOPE } from "../amc/service-status.service";
import type { AuthContext } from "../auth/access";
import { cleanFileName, discardStoredFile, putStoredFile, readStoredFile, recogniseFile, type FileKind } from "../attachments/attachments.service";
import type { AcknowledgementFilters, AcknowledgementSort, AcknowledgementStatus, ListAcknowledgementsQuery, ReconciliationReason } from "./invoice-acknowledgements.schemas";
import { FAMILY_SQL, settleCurrent, SUBSTANTIVE_SQL, syncInvoices } from "./invoice-sync";

// Invoice Acknowledgements (migrations 0112, 0114): ONE acknowledgement per actual invoice, which may cover several
// services. The invoice identity is ack_invoices (see invoice-sync.ts): an Invoice Tracking record when one verifies
// the services, otherwise one service's Invoice No.; more services join it only through an authorised, reasoned
// reconciliation. Services are Accounts' own rows (same scope); an invoice is listed while at least one of its
// services still carries its Invoice No.
//
// Workflow: Attach stores the document in private storage and records it against the invoice's Pending
// acknowledgement; OK / Confirm turns it Acknowledged. Only the confirmation makes the status green. Once
// Acknowledged, the document can be replaced only with Edit and a reason; every version is kept. An invoice that needs
// reconciliation (equal numbers, or conflicting acknowledgements) takes no new acknowledgement until it is reconciled.
// Nothing here changes a visit, an Invoice No., the Paid reference status, an amount or an Invoice Tracking record.

const ENTITY_TYPE = "invoice_acknowledgements";
const CATEGORY = "INVOICE_ACKNOWLEDGEMENT";
const LOG_MODULE = "INVOICE_ACKNOWLEDGEMENTS";

const DOCUMENT_KINDS: readonly FileKind[] = ["PDF", "PNG", "JPEG"];
export const ACKNOWLEDGEMENT_TYPES_TEXT = "PDF, PNG and JPEG";

export const ACKNOWLEDGEMENT_NOTE =
  "Acknowledged means the client's acknowledgement document for this invoice is on file and was confirmed. It is not payment: it does not change the Invoice No., the Paid / Unpaid reference status or any amount.";

/** Whether this database can hold invoice-level acknowledgements (migrations 0112 to 0115). */
export function acknowledgementsAvailable(): Promise<boolean> {
  return schemaHas(["invoice_acknowledgements", "attachments_invoice_ack_uq", "ack_invoices", "ack_invoice_services"]);
}

function unavailable(): AppError {
  return new AppError(503, "FEATURE_UNAVAILABLE", "Invoice Acknowledgements need a database update (migrations 0112 to 0115) that has not been applied yet.");
}

/** Checks availability and brings the invoice identities up to date. Every route starts here. */
async function ready(): Promise<void> {
  if (!(await acknowledgementsAvailable())) throw unavailable();
  await syncInvoices();
}

const fileError = (message: string) => validationError(message, [{ field: "document", message }]);

/** Checks name, size and content of an uploaded document. Nothing is stored when it fails. */
export function checkAcknowledgementFile(rawName: string, data: Buffer) {
  const originalName = cleanFileName(rawName);

  if (data.length === 0) throw fileError("The chosen file is empty. Choose another file.");
  if (data.length > env.attachmentMaxMb * 1024 * 1024) throw fileError(`Acknowledgement documents can be at most ${env.attachmentMaxMb} MB.`);

  const match = recogniseFile(data, DOCUMENT_KINDS);

  if (!match) throw fileError(`Only ${ACKNOWLEDGEMENT_TYPES_TEXT} files can be uploaded as an acknowledgement.`);
  if (match.refused) throw fileError(match.refused);

  const { type } = match;
  const extension = originalName.includes(".") ? (originalName.split(".").pop() ?? "").toLowerCase() : "";

  if (!type.extensions.includes(extension)) {
    throw fileError(`This file is a ${type.kind} file; its name must end in .${type.ext}.`);
  }

  return { originalName, mime: type.mime, ext: type.ext };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AcknowledgementDocument {
  attachmentId: string;
  version: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: { id: string; fullName: string };
  uploadedAt: string;
}

export interface AcknowledgementItem {
  /** The invoice identity (ack_invoices.id): the key of every action. */
  invoiceId: string;
  /** ZOHO: an Invoice Tracking record verifies it; SERVICE: a service's Invoice No. (and any services linked to it). */
  basis: "ZOHO" | "SERVICE";
  invoiceNo: string;
  client: { id: string; name: string };
  /** Contract periods of its services, as Accounts labels them ("STS-AMC-001 (V2)"). Usually one. */
  contracts: { id: string; reference: string; version: number }[];
  /** Services currently linked (carrying this Invoice No.). */
  serviceCount: number;
  serviceReportNos: string[];
  /** Date of the Invoice Tracking record; null when none. Never invented. */
  invoiceDate: string | null;
  /** The Invoice Tracking record was cancelled after the invoice was identified: shown, not counted. */
  zohoCancelled: boolean;
  /** When the Invoice No. was first entered on one of its services (not the invoice date). */
  invoiceEnteredAt: string | null;
  amountsVisible: boolean;
  /** Invoice Tracking amount excluding VAT, counted once per invoice; null when none, cancelled, or not visible. */
  invoiceValue: string | null;
  /** Sum of the linked services' scheduled values (OMR excl. VAT); null when not visible or none set. */
  serviceValue: string | null;
  status: AcknowledgementStatus;
  acknowledgementId: string | null;
  document: AcknowledgementDocument | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; fullName: string } | null;
  /** Why the invoice waits for an authorised user. Empty when it does not. */
  reconciliation: ReconciliationReason[];
}

interface Row {
  invoice_id: string;
  basis: "ZOHO" | "SERVICE";
  invoice_no: string;
  client_id: string;
  client_name: string;
  contracts: { id: string; reference: string; version: number }[];
  service_count: number;
  report_nos: string[];
  invoice_date: string | null;
  zoho_cancelled: boolean;
  entered_at: Date | null;
  invoice_value: string | null;
  service_value: string | null;
  status: AcknowledgementStatus;
  acknowledgement_id: string | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  acknowledged_by_name: string | null;
  document_id: string | null;
  document_version: number | null;
  document_name: string | null;
  document_mime: string | null;
  document_size: number | null;
  document_uploaded_by: string | null;
  document_uploaded_by_name: string | null;
  document_uploaded_at: Date | null;
  same_number: boolean;
  ack_conflict: boolean;
}

const STATUS_SQL = "(CASE WHEN ack.status = 'ACKNOWLEDGED' THEN 'ACKNOWLEDGED' ELSE 'PENDING' END)";

/**
 * The invoices with at least one active service (in Accounts' scope and still carrying the Invoice No.), aggregated
 * once per invoice, so an invoice's values are never repeated per service.
 */
const baseSql = (storedReference: boolean) => `
  WITH svc AS (
    SELECT s.ack_invoice_id, v.id AS visit_id, c.id AS contract_id, ${referenceSql("c", storedReference)} AS reference, ${versionSql("c")} AS version,
           v.visit_amount, v.service_report_no, v.manual_invoice_at
    FROM ack_invoice_services s
    JOIN amc_visits v ON v.id = s.amc_visit_id AND v.manual_invoice_no = s.invoice_number
    JOIN amc_contracts c ON c.id = v.amc_contract_id
    WHERE ${IN_SCOPE}
  ),
  agg AS (
    SELECT ack_invoice_id, count(*)::int AS service_count,
           jsonb_agg(DISTINCT jsonb_build_object('id', contract_id::text, 'reference', reference, 'version', version)) AS contracts,
           min(lower(reference)) AS first_reference,
           COALESCE(array_agg(DISTINCT service_report_no) FILTER (WHERE service_report_no IS NOT NULL), '{}') AS report_nos,
           sum(visit_amount)::numeric(16,3) AS service_value, min(manual_invoice_at) AS entered_at
    FROM svc GROUP BY ack_invoice_id
  )
  SELECT ai.id AS invoice_id, ai.basis, ai.invoice_number AS invoice_no, cl.id AS client_id, cl.name AS client_name,
         agg.contracts, agg.service_count, agg.report_nos, agg.first_reference,
         (CASE WHEN z.status = 'ISSUED' THEN z.invoice_date END)::text AS invoice_date, COALESCE(z.status = 'CANCELLED', false) AS zoho_cancelled, agg.entered_at,
         (CASE WHEN z.status = 'ISSUED' THEN z.amount_excl_vat END)::numeric(16,3)::text AS invoice_value, agg.service_value::text AS service_value,
         ${STATUS_SQL} AS status, ack.id AS acknowledgement_id, ack.acknowledged_at, ack.acknowledged_by, ab.full_name AS acknowledged_by_name,
         doc.id AS document_id, doc.version AS document_version, doc.original_name AS document_name, doc.mime_type AS document_mime,
         doc.size_bytes::int AS document_size, doc.uploaded_by AS document_uploaded_by, du.full_name AS document_uploaded_by_name,
         doc.uploaded_at AS document_uploaded_at,
         (NOT ai.confirmed_separate AND EXISTS (
            SELECT 1 FROM ack_invoices o JOIN agg oa ON oa.ack_invoice_id = o.id
            WHERE o.id <> ai.id AND o.merged_into_id IS NULL AND o.client_id = ai.client_id AND lower(o.invoice_number) = lower(ai.invoice_number)
         )) AS same_number,
         ai.acknowledgement_conflict AS ack_conflict
  FROM ack_invoices ai
  JOIN agg ON agg.ack_invoice_id = ai.id
  JOIN clients_all cl ON cl.id = ai.client_id
  LEFT JOIN invoices z ON z.id = ai.zoho_invoice_id
  LEFT JOIN invoice_acknowledgements ack ON ack.id = ai.current_acknowledgement_id
  LEFT JOIN users ab ON ab.id = ack.acknowledged_by
  LEFT JOIN attachments doc ON doc.entity_type = '${ENTITY_TYPE}' AND doc.entity_id = ack.id AND doc.is_current
  LEFT JOIN users du ON du.id = doc.uploaded_by
  WHERE ai.merged_into_id IS NULL`;

function toItem(row: Row, amountsVisible: boolean): AcknowledgementItem {
  const reconciliation: ReconciliationReason[] = [];
  if (row.same_number) reconciliation.push("SAME_NUMBER");
  if (row.ack_conflict) reconciliation.push("CONFLICTING_ACKNOWLEDGEMENTS");
  if (row.zoho_cancelled) reconciliation.push("ZOHO_CANCELLED");

  return {
    invoiceId: row.invoice_id,
    basis: row.basis,
    invoiceNo: row.invoice_no,
    client: { id: row.client_id, name: row.client_name },
    contracts: [...row.contracts].sort((a, b) => a.reference.localeCompare(b.reference)),
    serviceCount: row.service_count,
    serviceReportNos: [...row.report_nos].sort(),
    invoiceDate: row.invoice_date,
    zohoCancelled: row.zoho_cancelled,
    invoiceEnteredAt: row.entered_at?.toISOString() ?? null,
    amountsVisible,
    invoiceValue: amountsVisible ? row.invoice_value : null,
    serviceValue: amountsVisible ? row.service_value : null,
    status: row.status,
    acknowledgementId: row.acknowledgement_id,
    document:
      row.document_id && row.document_uploaded_at
        ? {
            attachmentId: row.document_id,
            version: row.document_version ?? 1,
            originalName: row.document_name ?? "",
            mimeType: row.document_mime ?? "",
            sizeBytes: row.document_size ?? 0,
            uploadedBy: { id: row.document_uploaded_by ?? "", fullName: row.document_uploaded_by_name ?? "" },
            uploadedAt: row.document_uploaded_at.toISOString(),
          }
        : null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    acknowledgedBy: row.acknowledged_by ? { id: row.acknowledged_by, fullName: row.acknowledged_by_name ?? "" } : null,
    reconciliation,
  };
}

/** One WHERE clause (over the base query, aliased b) for the rows, the figures and the export. */
function filterSql(query: Omit<AcknowledgementFilters, "sort" | "dir">) {
  const conditions: string[] = ["true"];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.clientId) conditions.push(`b.client_id = ${add(query.clientId)}`);
  if (query.contractId) conditions.push(`b.contracts @> jsonb_build_array(jsonb_build_object('id', ${add(query.contractId)}::text))`);
  if (query.invoiceNo) conditions.push(`b.invoice_no ILIKE ${add(`%${escapeLike(query.invoiceNo)}%`)}`);
  if (query.status) conditions.push(`b.status = ${add(query.status)}`);
  if (query.reconciliation === "NEEDED") conditions.push("(b.same_number OR b.ack_conflict OR b.zoho_cancelled)");
  if (query.fromDate || query.toDate) {
    const date = query.dateBasis === "ACKNOWLEDGED_DATE" ? businessDateSql("b.acknowledged_at") : "b.invoice_date::date";

    if (query.fromDate) conditions.push(`${date} >= ${add(query.fromDate)}::date`);
    if (query.toDate) conditions.push(`${date} <= ${add(query.toDate)}::date`);
  }
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    conditions.push(
      `(${[
        `b.invoice_no ILIKE ${p}`,
        `b.client_name ILIKE ${p}`,
        `EXISTS (SELECT 1 FROM jsonb_array_elements(b.contracts) e WHERE e ->> 'reference' ILIKE ${p})`,
        `EXISTS (SELECT 1 FROM unnest(b.report_nos) n WHERE n ILIKE ${p})`,
        `b.document_name ILIKE ${p}`,
      ].join(" OR ")})`
    );
  }

  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

const SORT_SQL: Record<AcknowledgementSort, string> = {
  invoiceNo: "lower(b.invoice_no)",
  client: "lower(b.client_name)",
  contract: "b.first_reference",
  invoiceDate: "b.invoice_date",
  status: "b.status",
  acknowledgedAt: "b.acknowledged_at",
};

/** The default order puts the work first: invoices needing reconciliation, then Pending, newest Invoice No. first. */
function orderSql(query: Pick<AcknowledgementFilters, "sort" | "dir">): string {
  if (!query.sort) return "ORDER BY (b.same_number OR b.ack_conflict OR b.zoho_cancelled) DESC, (b.status = 'ACKNOWLEDGED'), b.entered_at DESC NULLS LAST, b.invoice_id DESC";
  const dir = query.dir === "desc" ? "DESC" : "ASC";

  return `ORDER BY ${SORT_SQL[query.sort]} ${dir} NULLS LAST, b.invoice_id ${dir}`;
}

export interface AcknowledgementKpis {
  /** Invoices listed. total = pending + acknowledged. */
  total: number;
  pending: number;
  awaitingConfirmation: number;
  acknowledged: number;
  needsReconciliation: number;
  /** Sum of Invoice Tracking amounts, each invoice once (OMR excl. VAT); null when amounts are not visible. */
  invoiceValueTotal: string | null;
  /** Sum of the listed invoices' service values; null when amounts are not visible. */
  serviceValueTotal: string | null;
}

async function kpis(storedReference: boolean, where: string, params: unknown[], amountsVisible: boolean): Promise<AcknowledgementKpis> {
  const result = await pool.query<{ total: number; acknowledged: number; awaiting: number; reconcile: number; invoice_value: string; service_value: string }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE b.status = 'ACKNOWLEDGED')::int AS acknowledged,
            count(*) FILTER (WHERE b.status = 'PENDING' AND b.document_id IS NOT NULL)::int AS awaiting,
            count(*) FILTER (WHERE b.same_number OR b.ack_conflict OR b.zoho_cancelled)::int AS reconcile,
            COALESCE(sum(b.invoice_value::numeric), 0)::numeric(16,3)::text AS invoice_value,
            COALESCE(sum(b.service_value::numeric), 0)::numeric(16,3)::text AS service_value
     FROM (${baseSql(storedReference)}) b ${where}`,
    params
  );
  const row = result.rows[0];
  const total = row?.total ?? 0;
  const acknowledged = row?.acknowledged ?? 0;

  return {
    total,
    pending: total - acknowledged,
    awaitingConfirmation: row?.awaiting ?? 0,
    acknowledged,
    needsReconciliation: row?.reconcile ?? 0,
    invoiceValueTotal: amountsVisible ? (row?.invoice_value ?? "0.000") : null,
    serviceValueTotal: amountsVisible ? (row?.service_value ?? "0.000") : null,
  };
}

export async function listAcknowledgements(query: ListAcknowledgementsQuery, amountsVisible: boolean) {
  await ready();

  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(query);
  const [figures, rows] = await Promise.all([
    kpis(storedReference, where, params, amountsVisible),
    pool.query<Row>(`SELECT b.* FROM (${baseSql(storedReference)}) b ${where} ${orderSql(query)} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ]),
  ]);

  return { items: rows.rows.map((row) => toItem(row, amountsVisible)), total: figures.total, page: query.page, pageSize: query.pageSize, kpis: figures };
}

/** Every invoice that matches the filters, in the page's order, for an export. */
export async function listAllAcknowledgements(filters: AcknowledgementFilters, amountsVisible: boolean, checkSize: (count: number) => void) {
  await ready();

  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(filters);
  const figures = await kpis(storedReference, where, params, amountsVisible);

  checkSize(figures.total);

  const rows = await pool.query<Row>(`SELECT b.* FROM (${baseSql(storedReference)}) b ${where} ${orderSql(filters)}`, params);

  return { items: rows.rows.map((row) => toItem(row, amountsVisible)), kpis: figures };
}

async function readItem(db: Queryable, invoiceId: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  const storedReference = await hasStoredReference();
  const result = await db.query<Row>(`SELECT b.* FROM (${baseSql(storedReference)}) b WHERE b.invoice_id = $1`, [invoiceId]);
  const row = result.rows[0];

  if (!row) throw notFound("Invoice not found. It may have no service carrying its Invoice No. any more.");
  return toItem(row, amountsVisible);
}

/** One invoice of the list. */
export async function getAcknowledgement(invoiceId: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();
  return readItem(pool, invoiceId, amountsVisible);
}

export interface LinkedService {
  visitId: string;
  contract: { id: string; reference: string; version: number };
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null };
  scheduledDate: string;
  completedDate: string | null;
  serviceReportNo: string | null;
  invoiceNo: string;
  /** How it joined: ZOHO (Invoice Tracking allocation), SERVICE (its own invoice), LINKED (authorised reconciliation). */
  basis: "ZOHO" | "SERVICE" | "LINKED";
  linkedAt: string;
  serviceValue: string | null;
}

/** The services currently linked to an invoice (Linked Services viewer). */
export async function linkedServices(invoiceId: string, amountsVisible: boolean): Promise<LinkedService[]> {
  await ready();
  await readItem(pool, invoiceId, false);

  const storedReference = await hasStoredReference();
  const result = await pool.query<{
    visit_id: string; contract_id: string; reference: string; version: number; sequence_no: number; cycle_no: number | null; service_code: string | null;
    scheduled_date: string; completed_date: string | null; service_report_no: string | null; invoice_number: string; basis: LinkedService["basis"]; linked_at: Date; visit_amount: string | null;
  }>(
    `SELECT v.id AS visit_id, c.id AS contract_id, ${referenceSql("c", storedReference)} AS reference, ${versionSql("c")} AS version,
            v.sequence_no, v.cycle_no, v.service_code, v.scheduled_date::text AS scheduled_date, v.completed_date::text AS completed_date,
            v.service_report_no, s.invoice_number, s.basis, s.linked_at, v.visit_amount::text AS visit_amount
     FROM ack_invoice_services s
     JOIN amc_visits v ON v.id = s.amc_visit_id AND v.manual_invoice_no = s.invoice_number
     JOIN amc_contracts c ON c.id = v.amc_contract_id
     WHERE s.ack_invoice_id = $1 AND ${IN_SCOPE}
     ORDER BY v.scheduled_date, v.id`,
    [invoiceId]
  );

  return result.rows.map((row) => ({
    visitId: row.visit_id,
    contract: { id: row.contract_id, reference: row.reference, version: row.version },
    service: { sequenceNo: row.sequence_no, cycleNo: row.cycle_no, serviceCode: row.service_code },
    scheduledDate: row.scheduled_date,
    completedDate: row.completed_date,
    serviceReportNo: row.service_report_no,
    invoiceNo: row.invoice_number,
    basis: row.basis,
    linkedAt: row.linked_at.toISOString(),
    serviceValue: amountsVisible ? row.visit_amount : null,
  }));
}

/** The filter lists: clients and contract periods with at least one invoice listed. */
export async function getAcknowledgementOptions() {
  await ready();

  const storedReference = await hasStoredReference();
  const scope = `${IN_SCOPE} AND v.manual_invoice_no IS NOT NULL`;
  const [clients, contracts] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `SELECT DISTINCT cl.id, cl.name FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id JOIN clients cl ON cl.id = c.client_id
       WHERE ${scope} ORDER BY cl.name, cl.id`
    ),
    pool.query<{ id: string; reference: string; client_name: string; system_description: string }>(
      `SELECT c.id, ${referenceSql("c", storedReference)} AS reference, cl.name AS client_name, c.system_description
       FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
       WHERE EXISTS (SELECT 1 FROM amc_visits v WHERE v.amc_contract_id = c.id AND ${scope})
       ORDER BY lower(${referenceSql("c", storedReference)}), c.id`
    ),
  ]);

  return {
    clients: clients.rows,
    contracts: contracts.rows.map((row) => ({ id: row.id, reference: row.reference, client: row.client_name, system: row.system_description })),
    limits: { maxMb: env.attachmentMaxMb, types: ACKNOWLEDGEMENT_TYPES_TEXT },
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface LockedInvoice {
  id: string;
  client_id: string;
  invoice_number: string;
  basis: "ZOHO" | "SERVICE";
  zoho_invoice_id: string | null;
  current_acknowledgement_id: string | null;
  acknowledgement_conflict: boolean;
  confirmed_separate: boolean;
  merged_into_id: string | null;
  client_name: string;
}

/** The invoice row; inside a transaction it is locked first, so two actions on one invoice run one after the other. */
async function lockInvoice(db: Queryable, invoiceId: string, lock: boolean): Promise<LockedInvoice & { item: AcknowledgementItem }> {
  if (lock) await db.query("SELECT id FROM ack_invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
  const result = await db.query<LockedInvoice>(
    `SELECT ai.*, cl.name AS client_name FROM ack_invoices ai JOIN clients_all cl ON cl.id = ai.client_id WHERE ai.id = $1`,
    [invoiceId]
  );
  const row = result.rows[0];

  if (!row || row.merged_into_id) throw notFound("Invoice not found. It may have been linked into another invoice.");
  // Listed only while a service carries its number: the same rule as the page.
  const item = await readItem(db, invoiceId, false);

  return { ...row, item };
}

function assertNoReconciliation(invoice: { item: AcknowledgementItem }, allowSameNumber = false): void {
  if (invoice.item.reconciliation.includes("CONFLICTING_ACKNOWLEDGEMENTS")) {
    throw conflict("More than one acknowledgement exists for this invoice. An authorised user must choose the current one under Reconcile before anything else is done.");
  }
  if (!allowSameNumber && invoice.item.reconciliation.includes("SAME_NUMBER")) {
    throw conflict("Another invoice of this client has the same Invoice No. An authorised user must reconcile them first: link them as one invoice, or confirm they are separate.");
  }
}

interface AckRow {
  id: string;
  status: AcknowledgementStatus;
}

async function currentAcknowledgement(db: Queryable, invoice: LockedInvoice, lock: boolean): Promise<AckRow | null> {
  if (!invoice.current_acknowledgement_id) return null;
  const result = await db.query<AckRow>(`SELECT id, status FROM invoice_acknowledgements WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [invoice.current_acknowledgement_id]);
  return result.rows[0] ?? null;
}

interface DocumentRow {
  id: string;
  document_id: string;
  version: number;
  original_name: string;
  mime_type: string;
  sha256: string;
  storage_key: string;
}

async function currentDocument(db: Queryable, acknowledgementId: string): Promise<DocumentRow | null> {
  const result = await db.query<DocumentRow>(
    `SELECT id, document_id, version, original_name, mime_type, sha256, storage_key
     FROM attachments WHERE entity_type = $1 AND entity_id = $2 AND is_current`,
    [ENTITY_TYPE, acknowledgementId]
  );

  return result.rows[0] ?? null;
}

const label = (invoice: LockedInvoice & { item: AcknowledgementItem }) => `Invoice ${invoice.invoice_number} of "${invoice.client_name}" (${invoice.item.serviceCount} service${invoice.item.serviceCount === 1 ? "" : "s"})`;

const ALREADY_ACKNOWLEDGED = "This invoice is already acknowledged. Its document can only be replaced with Replace Document, which needs Edit permission and a reason.";

interface StoredUpload {
  key: string;
  sha256: string;
  originalName: string;
  mime: string;
  size: number;
}

async function storeUpload(rawName: string, data: Buffer): Promise<StoredUpload> {
  const file = checkAcknowledgementFile(rawName, data);
  const key = `${randomUUID()}.${file.ext}`;
  const sha256 = createHash("sha256").update(data).digest("hex");

  await putStoredFile(key, data, "no acknowledgement document was saved");
  return { key, sha256, originalName: file.originalName, mime: file.mime, size: data.length };
}

/** Records the stored file as the acknowledgement's current document: the next version of its document, or the first. */
async function recordDocument(db: Queryable, auth: AuthContext, acknowledgementId: string, upload: StoredUpload, current: DocumentRow | null): Promise<string> {
  const previous =
    current ??
    (
      await db.query<DocumentRow>(
        `SELECT id, document_id, version, original_name, mime_type, sha256, storage_key
         FROM attachments WHERE entity_type = $1 AND entity_id = $2 ORDER BY version DESC, id DESC LIMIT 1`,
        [ENTITY_TYPE, acknowledgementId]
      )
    ).rows[0] ??
    null;

  if (previous) {
    if (current) await db.query("UPDATE attachments SET is_current = false WHERE id = $1", [current.id]);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO attachments (document_id, version, entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, 'Invoice acknowledgement', $6, $7, $8, $9, $10, $11) RETURNING id`,
      [previous.document_id, previous.version + 1, ENTITY_TYPE, acknowledgementId, CATEGORY, upload.originalName, upload.mime, upload.size, upload.sha256, upload.key, auth.user.id]
    );
    return (inserted.rows[0] as { id: string }).id;
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, $2, $3, 'Invoice acknowledgement', $4, $5, $6, $7, $8, $9) RETURNING id`,
    [ENTITY_TYPE, acknowledgementId, CATEGORY, upload.originalName, upload.mime, upload.size, upload.sha256, upload.key, auth.user.id]
  );
  const id = (inserted.rows[0] as { id: string }).id;

  await db.query("UPDATE attachments SET document_id = id WHERE id = $1", [id]);
  return id;
}

/** Runs `work` with the stored upload; if it fails, the file is removed again (nothing records it). */
async function withUpload<T>(rawName: string, data: Buffer, work: (upload: StoredUpload) => Promise<T>): Promise<T> {
  const upload = await storeUpload(rawName, data);

  try {
    return await work(upload);
  } catch (error) {
    await discardStoredFile(upload.key);
    throw error;
  }
}

/**
 * Attach Acknowledgement: stores the document in private storage and records it against the invoice's Pending
 * acknowledgement (created on first use and made current). The status stays Pending until OK / Confirm.
 */
export async function attachDocument(auth: AuthContext, invoiceId: string, rawName: string, data: Buffer, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();

  // Refuse before anything is stored.
  const precheck = await lockInvoice(pool, invoiceId, false);
  assertNoReconciliation(precheck);
  if (precheck.item.status === "ACKNOWLEDGED") throw conflict(ALREADY_ACKNOWLEDGED);

  return withUpload(rawName, data, (upload) =>
    withTransaction(async (db) => {
      const invoice = await lockInvoice(db, invoiceId, true);
      assertNoReconciliation(invoice);

      let ack = await currentAcknowledgement(db, invoice, true);

      if (ack?.status === "ACKNOWLEDGED") throw conflict(ALREADY_ACKNOWLEDGED);
      if (!ack) {
        const created = await db.query<{ id: string }>(
          "INSERT INTO invoice_acknowledgements (invoice_number, ack_invoice_id, created_by) VALUES ($1, $2, $3) RETURNING id",
          [invoice.invoice_number, invoice.id, auth.user.id]
        );
        ack = { id: (created.rows[0] as { id: string }).id, status: "PENDING" };
        await db.query("UPDATE ack_invoices SET current_acknowledgement_id = $2 WHERE id = $1", [invoice.id, ack.id]);
      }

      const previous = await currentDocument(db, ack.id);
      const attachmentId = await recordDocument(db, auth, ack.id, upload, previous);

      await logActivity(db, {
        userId: auth.user.id,
        action: "invoice_acknowledgement.document_uploaded",
        module: LOG_MODULE,
        entityType: ENTITY_TYPE,
        entityId: ack.id,
        description: `Acknowledgement document ${upload.originalName} attached to ${label(invoice)}${previous ? `, in place of ${previous.original_name} (kept as version ${previous.version})` : ""}. Awaiting confirmation.`,
        metadata: { ackInvoiceId: invoice.id, invoiceNumber: invoice.invoice_number, attachmentId, ...(previous ? { previousAttachmentId: previous.id } : {}), sha256: upload.sha256, sizeBytes: upload.size },
      });

      return readItem(db, invoiceId, amountsVisible);
    })
  );
}

/** Removes the document attached to a Pending acknowledgement before it is confirmed. The row and the file are kept, no longer current. */
export async function withdrawDocument(auth: AuthContext, invoiceId: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();

  return withTransaction(async (db) => {
    const invoice = await lockInvoice(db, invoiceId, true);
    const ack = await currentAcknowledgement(db, invoice, true);

    if (ack?.status === "ACKNOWLEDGED") throw conflict("This invoice is acknowledged: its document cannot be removed.");
    const current = ack ? await currentDocument(db, ack.id) : null;

    if (!ack || !current) throw notFound("This invoice has no attached document to remove.");

    await db.query("UPDATE attachments SET is_current = false WHERE id = $1", [current.id]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "invoice_acknowledgement.document_removed",
      module: LOG_MODULE,
      entityType: ENTITY_TYPE,
      entityId: ack.id,
      description: `Acknowledgement document ${current.original_name} removed from ${label(invoice)} before confirmation. The file is kept.`,
      metadata: { ackInvoiceId: invoice.id, invoiceNumber: invoice.invoice_number, attachmentId: current.id },
    });

    return readItem(db, invoiceId, amountsVisible);
  });
}

/**
 * OK / Confirm: the invoice becomes Acknowledged, with date, time and user. Only the document the user saw is
 * confirmed, after its file is read back and matches its checksum. The invoice and its acknowledgement are locked, so
 * two confirmations at once give one Acknowledged and one refusal.
 */
export async function confirmAcknowledgement(auth: AuthContext, invoiceId: string, attachmentId: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();

  const precheck = await lockInvoice(pool, invoiceId, false);
  assertNoReconciliation(precheck);
  const pending = await currentAcknowledgement(pool, precheck, false);
  const stored = pending ? await currentDocument(pool, pending.id) : null;

  if (pending?.status === "ACKNOWLEDGED") throw conflict("This invoice is already acknowledged.");
  if (!pending || !stored) throw conflict("Attach the acknowledgement document before confirming.");
  if (stored.id !== attachmentId) throw conflict("The attached document has changed since you selected it. Review the document and confirm again.");

  await readStoredFile(stored.storage_key, stored.sha256, "The attached document could not be found in storage. Attach it again, then confirm.");

  return withTransaction(async (db) => {
    const invoice = await lockInvoice(db, invoiceId, true);
    assertNoReconciliation(invoice);
    const ack = await currentAcknowledgement(db, invoice, true);
    const current = ack ? await currentDocument(db, ack.id) : null;

    if (ack?.status === "ACKNOWLEDGED") throw conflict("This invoice is already acknowledged.");
    if (!ack || !current || current.id !== attachmentId) throw conflict("The invoice or its attached document changed while confirming. Reload and confirm again.");

    await db.query("UPDATE invoice_acknowledgements SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1", [ack.id, auth.user.id]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "invoice_acknowledgement.confirmed",
      module: LOG_MODULE,
      entityType: ENTITY_TYPE,
      entityId: ack.id,
      description: `${label(invoice)} marked Acknowledged with document ${current.original_name}. Not a payment: Invoice No., Paid / Unpaid and amounts are unchanged.`,
      metadata: { ackInvoiceId: invoice.id, invoiceNumber: invoice.invoice_number, attachmentId: current.id, services: invoice.item.serviceCount },
    });

    return readItem(db, invoiceId, amountsVisible);
  });
}

/** Replace Document (Edit): a new version of an Acknowledged invoice's document, with a reason. Earlier versions kept; date and user unchanged. */
export async function replaceDocument(auth: AuthContext, invoiceId: string, rawName: string, data: Buffer, reason: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();

  const precheck = await lockInvoice(pool, invoiceId, false);
  assertNoReconciliation(precheck, true);
  if (precheck.item.status !== "ACKNOWLEDGED") throw conflict("Only an acknowledged invoice's document can be replaced. Attach and confirm the document instead.");

  return withUpload(rawName, data, (upload) =>
    withTransaction(async (db) => {
      const invoice = await lockInvoice(db, invoiceId, true);
      assertNoReconciliation(invoice, true);
      const ack = await currentAcknowledgement(db, invoice, true);

      if (ack?.status !== "ACKNOWLEDGED") throw conflict("Only an acknowledged invoice's document can be replaced.");

      const previous = await currentDocument(db, ack.id);
      const attachmentId = await recordDocument(db, auth, ack.id, upload, previous);

      await logActivity(db, {
        userId: auth.user.id,
        action: "invoice_acknowledgement.document_replaced",
        module: LOG_MODULE,
        entityType: ENTITY_TYPE,
        entityId: ack.id,
        description: `Acknowledgement document of ${label(invoice)} replaced with ${upload.originalName}${previous ? ` (earlier ${previous.original_name} kept as version ${previous.version})` : ""}. Reason: ${reason}`,
        metadata: { ackInvoiceId: invoice.id, invoiceNumber: invoice.invoice_number, attachmentId, ...(previous ? { previousAttachmentId: previous.id } : {}), reason, sha256: upload.sha256, sizeBytes: upload.size },
      });

      return readItem(db, invoiceId, amountsVisible);
    })
  );
}

/**
 * A document of THIS invoice: the current one by default, or a named earlier version. Only attachments of the
 * acknowledgements belonging to this invoice (or to invoices linked into it) are served: never another invoice's.
 */
export async function readDocument(invoiceId: string, attachmentId?: string) {
  await ready();
  const invoice = await lockInvoice(pool, invoiceId, false);

  let document: DocumentRow | null = null;
  if (attachmentId) {
    document =
      (
        await pool.query<DocumentRow>(
          `SELECT a.id, a.document_id, a.version, a.original_name, a.mime_type, a.sha256, a.storage_key
           FROM attachments a JOIN invoice_acknowledgements k ON k.id = a.entity_id
           WHERE a.entity_type = $1 AND a.id = $2 AND k.ack_invoice_id IN ${FAMILY_SQL("$3")}`,
          [ENTITY_TYPE, attachmentId, invoiceId]
        )
      ).rows[0] ?? null;
  } else {
    const ack = await currentAcknowledgement(pool, invoice, false);
    document = ack ? await currentDocument(pool, ack.id) : null;
  }

  if (!document) throw notFound("This invoice has no such acknowledgement document.");

  const data = await readStoredFile(document.storage_key, document.sha256, "The stored acknowledgement document could not be found.");

  return { data, mimeType: document.mime_type, fileName: document.original_name };
}

export interface DocumentVersion {
  attachmentId: string;
  acknowledgementId: string;
  invoiceNumber: string;
  version: number;
  isCurrent: boolean;
  /** Belongs to the invoice's current acknowledgement (the others are earlier or conflicting acknowledgements). */
  ofCurrentAcknowledgement: boolean;
  acknowledgementStatus: AcknowledgementStatus;
  originalName: string;
  uploadedBy: { id: string; fullName: string };
  uploadedAt: string;
}

/** Every document recorded for this invoice's acknowledgements (and those of invoices linked into it), newest first. */
export async function documentHistory(invoiceId: string): Promise<DocumentVersion[]> {
  await ready();
  const invoice = await lockInvoice(pool, invoiceId, false);
  const result = await pool.query<{
    id: string; ack_id: string; invoice_number: string; version: number; is_current: boolean; status: AcknowledgementStatus; original_name: string; uploaded_by: string; full_name: string; uploaded_at: Date;
  }>(
    `SELECT a.id, k.id AS ack_id, k.invoice_number, a.version, a.is_current, k.status, a.original_name, a.uploaded_by, u.full_name, a.uploaded_at
     FROM invoice_acknowledgements k
     JOIN attachments a ON a.entity_type = $2 AND a.entity_id = k.id
     JOIN users u ON u.id = a.uploaded_by
     WHERE k.ack_invoice_id IN ${FAMILY_SQL("$1")}
     ORDER BY a.uploaded_at DESC, a.id DESC`,
    [invoiceId, ENTITY_TYPE]
  );

  return result.rows.map((row) => ({
    attachmentId: row.id,
    acknowledgementId: row.ack_id,
    invoiceNumber: row.invoice_number,
    version: row.version,
    isCurrent: row.is_current,
    ofCurrentAcknowledgement: row.ack_id === invoice.current_acknowledgement_id,
    acknowledgementStatus: row.status,
    originalName: row.original_name,
    uploadedBy: { id: row.uploaded_by, fullName: row.full_name },
    uploadedAt: row.uploaded_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Reconciliation (Edit): never automatic, always with a reason, always audited
// ---------------------------------------------------------------------------

export interface ReconciliationView {
  reasons: ReconciliationReason[];
  /** Other live invoices of the client with the same Invoice No. */
  sameNumber: { invoiceId: string; basis: "ZOHO" | "SERVICE"; serviceCount: number; contracts: string[]; status: AcknowledgementStatus; hasDocument: boolean }[];
  /** Acknowledgements with substance of this invoice, when more than one exists. */
  acknowledgements: { acknowledgementId: string; status: AcknowledgementStatus; acknowledgedAt: string | null; acknowledgedBy: string | null; documentName: string | null; legacyVisitId: string | null }[];
  /**
   * When the invoice's Invoice Tracking record is cancelled: active records of the same client and number. `verified`
   * only when the record is allocated to every service the invoice covers and no other invoice holds it; only a
   * verified record can be re-associated, and only on an authorised, reasoned request.
   */
  replacements: { zohoInvoiceId: string; invoiceNumber: string; invoiceDate: string; verified: boolean; problem: string | null }[];
}

interface ReplacementRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  covered: number;
  services: number;
  held_by: string | null;
}

/** Active Invoice Tracking records that could replace the invoice's cancelled record, with whether each is verified. */
async function replacementCandidates(db: Queryable, invoice: LockedInvoice): Promise<ReplacementRow[]> {
  const result = await db.query<ReplacementRow>(
    `WITH active_services AS (
       SELECT s.amc_visit_id FROM ack_invoice_services s
       JOIN amc_visits v ON v.id = s.amc_visit_id AND v.manual_invoice_no = s.invoice_number
       JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE s.ack_invoice_id = $1 AND ${IN_SCOPE}
     )
     SELECT i.id, i.invoice_number, i.invoice_date::text AS invoice_date,
            (SELECT count(*)::int FROM active_services a WHERE EXISTS (SELECT 1 FROM invoice_allocations al WHERE al.invoice_id = i.id AND al.amc_visit_id = a.amc_visit_id)) AS covered,
            (SELECT count(*)::int FROM active_services) AS services,
            (SELECT o.id FROM ack_invoices o WHERE o.zoho_invoice_id = i.id AND o.merged_into_id IS NULL AND o.id <> $1 LIMIT 1) AS held_by
     FROM invoices i
     WHERE i.status = 'ISSUED' AND i.client_id = $2 AND lower(i.invoice_number) = lower($3)
     ORDER BY i.id`,
    [invoice.id, invoice.client_id, invoice.invoice_number]
  );
  return result.rows;
}

function replacementProblem(row: ReplacementRow): string | null {
  if (row.held_by) return "This record already belongs to another invoice on this page. Reconcile that invoice instead.";
  if (row.covered < row.services) return `This record is allocated to ${row.covered} of the invoice's ${row.services} services, so it cannot be verified as the same invoice.`;
  return null;
}

export async function reconciliationView(invoiceId: string): Promise<ReconciliationView> {
  await ready();
  const invoice = await lockInvoice(pool, invoiceId, false);
  const storedReference = await hasStoredReference();
  const others = await pool.query<Row>(
    `SELECT b.* FROM (${baseSql(storedReference)}) b JOIN ack_invoices ai ON ai.id = b.invoice_id
     WHERE b.invoice_id <> $1 AND b.client_id = $2 AND lower(b.invoice_no) = lower($3) ORDER BY b.invoice_id`,
    [invoiceId, invoice.client_id, invoice.invoice_number]
  );
  const acks = invoice.acknowledgement_conflict
    ? await pool.query<{ id: string; status: AcknowledgementStatus; acknowledged_at: Date | null; full_name: string | null; original_name: string | null; amc_visit_id: string | null }>(
        `SELECT a.id, a.status, a.acknowledged_at, u.full_name, d.original_name, a.amc_visit_id
         FROM invoice_acknowledgements a
         LEFT JOIN users u ON u.id = a.acknowledged_by
         LEFT JOIN attachments d ON d.entity_type = '${ENTITY_TYPE}' AND d.entity_id = a.id AND d.is_current
         WHERE a.ack_invoice_id IN ${FAMILY_SQL("$1")} AND ${SUBSTANTIVE_SQL("a")} ORDER BY a.id`,
        [invoiceId]
      )
    : { rows: [] };

  return {
    reasons: invoice.item.reconciliation,
    sameNumber: invoice.item.reconciliation.includes("SAME_NUMBER")
      ? others.rows.map((row) => {
          const other = toItem(row, false);
          return { invoiceId: other.invoiceId, basis: other.basis, serviceCount: other.serviceCount, contracts: other.contracts.map((c) => c.reference), status: other.status, hasDocument: other.document !== null };
        })
      : [],
    acknowledgements: acks.rows.map((row) => ({
      acknowledgementId: row.id,
      status: row.status,
      acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
      acknowledgedBy: row.full_name,
      documentName: row.original_name,
      legacyVisitId: row.amc_visit_id,
    })),
    replacements: invoice.item.zohoCancelled
      ? (await replacementCandidates(pool, invoice)).map((row) => {
          const problem = replacementProblem(row);
          return { zohoInvoiceId: row.id, invoiceNumber: row.invoice_number, invoiceDate: row.invoice_date, verified: problem === null, problem };
        })
      : [],
  };
}

/**
 * Re-associate: the invoice's Invoice Tracking record was cancelled and re-entered; the invoice now refers to the
 * verified active record. Same invoice identity, same services, same acknowledgement and history: only the record it
 * is verified by changes. Never automatic: Edit, a reason, and an Audit Log entry. The database also refuses any
 * record change that is not cancelled -> active of the same client and number (0116).
 */
export async function reassociateInvoice(auth: AuthContext, invoiceId: string, zohoInvoiceId: string, reason: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();

  return withTransaction(async (db) => {
    const invoice = await lockInvoice(db, invoiceId, true);

    if (!invoice.item.zohoCancelled || !invoice.zoho_invoice_id) throw conflict("This invoice's Invoice Tracking record is not cancelled, so it keeps its record.");

    const candidate = (await replacementCandidates(db, invoice)).find((row) => row.id === zohoInvoiceId);

    if (!candidate) throw conflict("That record is not an active Invoice Tracking record of this client with this Invoice No.");
    const problem = replacementProblem(candidate);
    if (problem) throw conflict(problem);

    const from = invoice.zoho_invoice_id;
    await db.query("UPDATE ack_invoices SET zoho_invoice_id = $2 WHERE id = $1", [invoice.id, zohoInvoiceId]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "invoice_acknowledgement.invoice_record_reassociated",
      module: LOG_MODULE,
      entityType: "ack_invoices",
      entityId: invoice.id,
      description: `${label(invoice)}: its cancelled Invoice Tracking record ${from} replaced by active record ${zohoInvoiceId} (allocated to all ${candidate.services} services). The invoice, its services and its acknowledgement are unchanged. Reason: ${reason}`,
      metadata: { from, to: zohoInvoiceId, reason, services: candidate.services },
    });

    return readItem(db, invoiceId, amountsVisible);
  });
}

/**
 * Link: the other invoice is the same invoice as this one. Its services move to the surviving invoice (the one
 * verified by Invoice Tracking, if either; otherwise this one), and it is kept as history (merged_into_id). Two
 * different Invoice Tracking records are never linked. If both had acknowledgement work, none is chosen: the survivor
 * waits for an authorised choice. Same client and Invoice No. are required (also enforced by the database).
 */
export async function linkInvoices(auth: AuthContext, invoiceId: string, otherInvoiceId: string, reason: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();
  if (invoiceId === otherInvoiceId) throw validationError("Choose another invoice to link.", [{ field: "otherInvoiceId", message: "Choose another invoice." }]);

  return withTransaction(async (db: PoolClient) => {
    // Locked in id order, so two opposite links cannot deadlock.
    const [first, second] = [invoiceId, otherInvoiceId].sort((a, b) => Number(a) - Number(b)) as [string, string];
    const locked = new Map([
      [first, await lockInvoice(db, first, true)],
      [second, await lockInvoice(db, second, true)],
    ]);
    const self = locked.get(invoiceId) as Awaited<ReturnType<typeof lockInvoice>>;
    const other = locked.get(otherInvoiceId) as Awaited<ReturnType<typeof lockInvoice>>;

    if (self.client_id !== other.client_id || self.invoice_number.toLowerCase() !== other.invoice_number.toLowerCase()) {
      throw conflict("Only invoices of the same client with the same Invoice No. can be linked.");
    }
    if (self.zoho_invoice_id && other.zoho_invoice_id) {
      throw conflict("Both invoices are separate Invoice Tracking records. They stay separate; confirm them as separate instead.");
    }

    const survivor = other.zoho_invoice_id ? other : self;
    const absorbed = survivor === self ? other : self;
    const moved = await db.query<{ amc_visit_id: string }>(
      "UPDATE ack_invoice_services SET ack_invoice_id = $2, basis = 'LINKED', linked_by = $3, linked_at = now() WHERE ack_invoice_id = $1 RETURNING amc_visit_id",
      [absorbed.id, survivor.id, auth.user.id]
    );

    await db.query("UPDATE ack_invoices SET merged_into_id = $2, current_acknowledgement_id = NULL, acknowledgement_conflict = false WHERE id = $1", [absorbed.id, survivor.id]);
    if (absorbed.acknowledgement_conflict) await db.query("UPDATE ack_invoices SET acknowledgement_conflict = true, current_acknowledgement_id = NULL WHERE id = $1", [survivor.id]);
    const outcome = absorbed.acknowledgement_conflict ? "CONFLICT" : await settleCurrent(db, survivor.id, auth.user.id);

    await logActivity(db, {
      userId: auth.user.id,
      action: "invoice_acknowledgement.invoices_linked",
      module: LOG_MODULE,
      entityType: "ack_invoices",
      entityId: survivor.id,
      description: `Invoice ${survivor.invoice_number} of "${survivor.client_name}": ${moved.rowCount} service(s) of invoice record ${absorbed.id} linked into invoice record ${survivor.id} as one invoice. Reason: ${reason}${outcome === "CONFLICT" ? " Both had acknowledgements: an authorised user must choose the current one." : ""}`,
      metadata: { from: absorbed.id, into: survivor.id, visits: moved.rows.map((row) => row.amc_visit_id), reason, outcome },
    });

    return readItem(db, survivor.id, amountsVisible);
  });
}

/** Separate: invoices of this client with this Invoice No. are separate invoices. Marks every one of them. */
export async function confirmSeparate(auth: AuthContext, invoiceId: string, reason: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();

  return withTransaction(async (db) => {
    const invoice = await lockInvoice(db, invoiceId, true);

    if (!invoice.item.reconciliation.includes("SAME_NUMBER")) throw conflict("No other invoice of this client has the same Invoice No.");

    const marked = await db.query<{ id: string }>(
      "UPDATE ack_invoices SET confirmed_separate = true WHERE client_id = $1 AND lower(invoice_number) = lower($2) AND merged_into_id IS NULL RETURNING id",
      [invoice.client_id, invoice.invoice_number]
    );

    await logActivity(db, {
      userId: auth.user.id,
      action: "invoice_acknowledgement.invoices_confirmed_separate",
      module: LOG_MODULE,
      entityType: "ack_invoices",
      entityId: invoice.id,
      description: `Invoices numbered ${invoice.invoice_number} of "${invoice.client_name}" confirmed as ${marked.rowCount} separate invoices. Reason: ${reason}`,
      metadata: { invoices: marked.rows.map((row) => row.id), reason },
    });

    return readItem(db, invoiceId, amountsVisible);
  });
}

/** Choose: which of the conflicting acknowledgements is the invoice's current one. The others stay as history. */
export async function chooseAcknowledgement(auth: AuthContext, invoiceId: string, acknowledgementId: string, reason: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  await ready();

  return withTransaction(async (db) => {
    const invoice = await lockInvoice(db, invoiceId, true);

    if (!invoice.acknowledgement_conflict) throw conflict("This invoice has no conflicting acknowledgements to choose between.");

    const candidate = await db.query<{ id: string }>(
      `SELECT a.id FROM invoice_acknowledgements a WHERE a.id = $2 AND a.ack_invoice_id IN ${FAMILY_SQL("$1")} AND ${SUBSTANTIVE_SQL("a")}`,
      [invoiceId, acknowledgementId]
    );

    if (candidate.rowCount === 0) throw notFound("That acknowledgement is not one of this invoice's conflicting acknowledgements.");

    await db.query("UPDATE ack_invoices SET current_acknowledgement_id = NULL WHERE current_acknowledgement_id = $1", [acknowledgementId]);
    await db.query("UPDATE ack_invoices SET current_acknowledgement_id = $2, acknowledgement_conflict = false WHERE id = $1", [invoiceId, acknowledgementId]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "invoice_acknowledgement.current_chosen",
      module: LOG_MODULE,
      entityType: "ack_invoices",
      entityId: invoiceId,
      description: `Acknowledgement ${acknowledgementId} chosen as the current acknowledgement of ${label(invoice)}. The others are kept as history. Reason: ${reason}`,
      metadata: { acknowledgementId, reason },
    });

    return readItem(db, invoiceId, amountsVisible);
  });
}
