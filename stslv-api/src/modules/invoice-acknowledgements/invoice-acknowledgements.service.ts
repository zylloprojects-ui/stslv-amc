import { createHash, randomUUID } from "node:crypto";
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
import type { AcknowledgementFilters, AcknowledgementSort, AcknowledgementStatus, ListAcknowledgementsQuery } from "./invoice-acknowledgements.schemas";

// Invoice Acknowledgements (migration 0112): the client's acknowledgement document for an invoice.
//
// The invoice is the one Accounts shows: a scheduled service (visit) in Accounts' scope with a manual Invoice No.
// There is no standalone invoice table for AMC billing, so an invoice is identified by the visit id AND its Invoice No.
// (never by the number alone, which is not unique). The list reads exactly Accounts' rows (same scope, same contract
// period and renewal version label, same Zoho invoice values) and adds the acknowledgement state.
//
// Workflow (like the Service Report on Service Status): Attach stores the document in private storage at once and
// records it against a Pending acknowledgement; OK / Confirm turns it Acknowledged. Only the confirmation makes the
// status green. Once Acknowledged, the document can be replaced only with Edit and a reason; every version is kept.
// Nothing here changes a visit, an Invoice No., the Paid reference status, an amount or an invoice.

const ENTITY_TYPE = "invoice_acknowledgements";
const CATEGORY = "INVOICE_ACKNOWLEDGEMENT";
const LOG_MODULE = "INVOICE_ACKNOWLEDGEMENTS";

/** Scanned or signed acknowledgements: recognised by content (never by name or the browser's type alone). */
const DOCUMENT_KINDS: readonly FileKind[] = ["PDF", "PNG", "JPEG"];
export const ACKNOWLEDGEMENT_TYPES_TEXT = "PDF, PNG and JPEG";

/** Shown wherever Acknowledged appears, so nobody reads it as a payment. */
export const ACKNOWLEDGEMENT_NOTE =
  "Acknowledged means the client's acknowledgement document for this invoice is on file and was confirmed. It is not payment: it does not change the Invoice No., the Paid / Unpaid reference status or any amount.";

/** Whether this database can hold acknowledgements (migrations 0112 and 0113). */
export function acknowledgementsAvailable(): Promise<boolean> {
  return schemaHas(["invoice_acknowledgements", "attachments_invoice_ack_uq"]);
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
  /** The scheduled service whose Invoice No. this is: with invoiceNo, the invoice's identity. */
  visitId: string;
  acknowledgementId: string | null;
  /** Contract number with its version from the second version on, as on Accounts ("STS-AMC-001 (V2)"). */
  reference: string;
  contract: { id: string; version: number };
  client: { id: string; name: string };
  system: { description: string; typeName: string | null };
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null };
  scheduledDate: string;
  completedDate: string | null;
  serviceReportNo: string | null;
  /** The manual Invoice No. on the service, as entered on Accounts. */
  invoiceNo: string;
  /** When the Invoice No. was entered (not the invoice date). */
  invoiceEnteredAt: string | null;
  /** Date of the active Zoho invoice in Invoice Tracking with the same number covering this service; null when none. Never invented. */
  invoiceDate: string | null;
  /** Whether the amounts below were sent: only to a role that may view Accounts, the source of these values. */
  amountsVisible: boolean;
  /** The service's scheduled value (amc_visits.visit_amount), OMR excluding VAT; null when not set or not visible. */
  serviceValue: string | null;
  /** Active Zoho invoice amounts allocated to the service (Invoice Tracking), as Accounts shows; null when none or not visible. */
  invoiceValue: string | null;
  status: AcknowledgementStatus;
  /** The current document: attached and awaiting confirmation (Pending), or the confirmed one (Acknowledged). */
  document: AcknowledgementDocument | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; fullName: string } | null;
}

interface Row {
  visit_id: string;
  acknowledgement_id: string | null;
  reference: string;
  contract_id: string;
  contract_version: number;
  client_id: string;
  client_name: string;
  system_description: string;
  system_type_name: string | null;
  sequence_no: number;
  cycle_no: number | null;
  service_code: string | null;
  scheduled_date: string;
  completed_date: string | null;
  service_report_no: string | null;
  invoice_no: string;
  invoice_entered_at: Date | null;
  invoice_date: string | null;
  service_value: string | null;
  invoice_value: string | null;
  status: AcknowledgementStatus;
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
}

const STATUS_SQL = "(CASE WHEN ack.status = 'ACKNOWLEDGED' THEN 'ACKNOWLEDGED' ELSE 'PENDING' END)";

/**
 * Accounts' own rows (same FROM and scope: service-status IN_SCOPE), limited to services with an Invoice No., plus
 * the acknowledgement of exactly that Invoice No. Zoho invoices are read as Accounts reads them: cancelled ones never count.
 */
const FROM = `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN system_types st ON st.id = c.system_type_id
  LEFT JOIN invoice_acknowledgements ack ON ack.amc_visit_id = v.id AND ack.invoice_number = v.manual_invoice_no
  LEFT JOIN users ab ON ab.id = ack.acknowledged_by
  LEFT JOIN attachments doc ON doc.entity_type = '${ENTITY_TYPE}' AND doc.entity_id = ack.id AND doc.is_current
  LEFT JOIN users du ON du.id = doc.uploaded_by
  LEFT JOIN LATERAL (
    SELECT sum(al.allocated_amount)::numeric(16,3) AS amount,
           min(i.invoice_date) FILTER (WHERE lower(i.invoice_number) = lower(v.manual_invoice_no)) AS invoice_date
    FROM invoice_allocations al
    JOIN invoices i ON i.id = al.invoice_id
    WHERE al.amc_visit_id = v.id AND i.status <> 'CANCELLED'
  ) inv ON true`;

const BASE_SCOPE = `${IN_SCOPE} AND v.manual_invoice_no IS NOT NULL`;

const selectSql = (storedReference: boolean) => `
  SELECT v.id AS visit_id, ack.id AS acknowledgement_id, ${referenceSql("c", storedReference)} AS reference,
         c.id AS contract_id, ${versionSql("c")} AS contract_version,
         cl.id AS client_id, cl.name AS client_name, c.system_description, st.name AS system_type_name,
         v.sequence_no, v.cycle_no, v.service_code,
         v.scheduled_date::text AS scheduled_date, v.completed_date::text AS completed_date, v.service_report_no,
         v.manual_invoice_no AS invoice_no, v.manual_invoice_at AS invoice_entered_at, inv.invoice_date::text AS invoice_date,
         v.visit_amount::text AS service_value, inv.amount::text AS invoice_value,
         ${STATUS_SQL} AS status, ack.acknowledged_at, ack.acknowledged_by, ab.full_name AS acknowledged_by_name,
         doc.id AS document_id, doc.version AS document_version, doc.original_name AS document_name, doc.mime_type AS document_mime,
         doc.size_bytes::int AS document_size, doc.uploaded_by AS document_uploaded_by, du.full_name AS document_uploaded_by_name,
         doc.uploaded_at AS document_uploaded_at`;

function toItem(row: Row, amountsVisible: boolean): AcknowledgementItem {
  return {
    visitId: row.visit_id,
    acknowledgementId: row.acknowledgement_id,
    reference: row.reference,
    contract: { id: row.contract_id, version: row.contract_version },
    client: { id: row.client_id, name: row.client_name },
    system: { description: row.system_description, typeName: row.system_type_name },
    service: { sequenceNo: row.sequence_no, cycleNo: row.cycle_no, serviceCode: row.service_code },
    scheduledDate: row.scheduled_date,
    completedDate: row.completed_date,
    serviceReportNo: row.service_report_no,
    invoiceNo: row.invoice_no,
    invoiceEnteredAt: row.invoice_entered_at?.toISOString() ?? null,
    invoiceDate: row.invoice_date,
    amountsVisible,
    serviceValue: amountsVisible ? row.service_value : null,
    invoiceValue: amountsVisible ? row.invoice_value : null,
    status: row.status,
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
  };
}

/** One WHERE clause for the rows, the figures and the export, so the three always agree. */
function filterSql(query: Omit<AcknowledgementFilters, "sort" | "dir">, storedReference: boolean) {
  const conditions: string[] = [BASE_SCOPE];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.clientId) conditions.push(`c.client_id = ${add(query.clientId)}`);
  if (query.contractId) conditions.push(`c.id = ${add(query.contractId)}`);
  if (query.invoiceNo) conditions.push(`v.manual_invoice_no ILIKE ${add(`%${escapeLike(query.invoiceNo)}%`)}`);
  if (query.status) conditions.push(`${STATUS_SQL} = ${add(query.status)}`);
  if (query.fromDate || query.toDate) {
    const date = query.dateBasis === "ACKNOWLEDGED_DATE" ? businessDateSql("ack.acknowledged_at") : "inv.invoice_date";

    if (query.fromDate) conditions.push(`${date} >= ${add(query.fromDate)}::date`);
    if (query.toDate) conditions.push(`${date} <= ${add(query.toDate)}::date`);
  }
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    conditions.push(
      `(${[
        `${referenceSql("c", storedReference)} ILIKE ${p}`,
        `cl.name ILIKE ${p}`,
        `v.manual_invoice_no ILIKE ${p}`,
        `v.service_report_no ILIKE ${p}`,
        `doc.original_name ILIKE ${p}`,
      ].join(" OR ")})`
    );
  }

  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

const SORT_SQL = (storedReference: boolean): Record<AcknowledgementSort, string> => ({
  reference: `lower(${referenceSql("c", storedReference)})`,
  client: "lower(cl.name)",
  invoiceNo: "lower(v.manual_invoice_no)",
  invoiceDate: "inv.invoice_date",
  status: STATUS_SQL,
  acknowledgedAt: "ack.acknowledged_at",
});

/** The default order puts the work first: Pending invoices, the most recently entered first. */
function orderSql(query: Pick<AcknowledgementFilters, "sort" | "dir">, storedReference: boolean): string {
  if (!query.sort) return "ORDER BY (ack.status = 'ACKNOWLEDGED') NULLS FIRST, v.manual_invoice_at DESC NULLS LAST, v.id DESC";
  const dir = query.dir === "desc" ? "DESC" : "ASC";

  return `ORDER BY ${SORT_SQL(storedReference)[query.sort]} ${dir} NULLS LAST, v.id ${dir}`;
}

export interface AcknowledgementKpis {
  /** Invoices listed: every service with an Invoice No. that the filters select. total = pending + acknowledged. */
  total: number;
  pending: number;
  /** Of the pending, those with a document attached and awaiting OK / Confirm. */
  awaitingConfirmation: number;
  acknowledged: number;
  /** PostgreSQL's sums over every selected invoice (OMR excluding VAT); null when the role may not see amounts. Missing values add nothing. */
  serviceValueTotal: string | null;
  invoiceValueTotal: string | null;
}

async function kpis(where: string, params: unknown[], amountsVisible: boolean): Promise<AcknowledgementKpis> {
  const result = await pool.query<{ total: number; acknowledged: number; awaiting: number; service_value: string; invoice_value: string }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ack.status = 'ACKNOWLEDGED')::int AS acknowledged,
            count(*) FILTER (WHERE ack.status = 'PENDING' AND doc.id IS NOT NULL)::int AS awaiting,
            COALESCE(sum(v.visit_amount), 0)::numeric(16,3)::text AS service_value,
            COALESCE(sum(inv.amount), 0)::numeric(16,3)::text AS invoice_value
     ${FROM} ${where}`,
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
    serviceValueTotal: amountsVisible ? (row?.service_value ?? "0.000") : null,
    invoiceValueTotal: amountsVisible ? (row?.invoice_value ?? "0.000") : null,
  };
}

function unavailable(): AppError {
  return new AppError(503, "FEATURE_UNAVAILABLE", "Invoice Acknowledgements need a database update (migrations 0112 and 0113) that has not been applied yet.");
}

export async function listAcknowledgements(query: ListAcknowledgementsQuery, amountsVisible: boolean) {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(query, storedReference);
  const [figures, rows] = await Promise.all([
    kpis(where, params, amountsVisible),
    pool.query<Row>(`${selectSql(storedReference)} ${FROM} ${where} ${orderSql(query, storedReference)} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ]),
  ]);

  return { items: rows.rows.map((row) => toItem(row, amountsVisible)), total: figures.total, page: query.page, pageSize: query.pageSize, kpis: figures };
}

/** Every invoice that matches the filters, in the page's order, for an export. `checkSize` throws when the export cannot hold that many. */
export async function listAllAcknowledgements(filters: AcknowledgementFilters, amountsVisible: boolean, checkSize: (count: number) => void) {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(filters, storedReference);
  const figures = await kpis(where, params, amountsVisible);

  checkSize(figures.total);

  const rows = await pool.query<Row>(`${selectSql(storedReference)} ${FROM} ${where} ${orderSql(filters, storedReference)}`, params);

  return { items: rows.rows.map((row) => toItem(row, amountsVisible)), kpis: figures };
}

/** One invoice of the list, by its service. Not found when the service is outside Accounts' scope or has no Invoice No. */
export async function getAcknowledgement(visitId: string, amountsVisible: boolean, db: Queryable = pool): Promise<AcknowledgementItem> {
  const storedReference = await hasStoredReference();
  const result = await db.query<Row>(`${selectSql(storedReference)} ${FROM} WHERE ${BASE_SCOPE} AND v.id = $1`, [visitId]);
  const row = result.rows[0];

  if (!row) throw notFound("No invoice to acknowledge was found for this service. It may have no Invoice No. any more.");
  return toItem(row, amountsVisible);
}

/** The filter lists: clients and contract periods with at least one invoice listed. */
export async function getAcknowledgementOptions() {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  const storedReference = await hasStoredReference();
  const [clients, contracts] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `SELECT DISTINCT cl.id, cl.name FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id JOIN clients cl ON cl.id = c.client_id
       WHERE ${BASE_SCOPE} ORDER BY cl.name, cl.id`
    ),
    pool.query<{ id: string; reference: string; client_name: string; system_description: string }>(
      `SELECT c.id, ${referenceSql("c", storedReference)} AS reference, cl.name AS client_name, c.system_description
       FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
       WHERE EXISTS (SELECT 1 FROM amc_visits v WHERE v.amc_contract_id = c.id AND ${BASE_SCOPE})
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
  visit_id: string;
  invoice_no: string | null;
  sequence_no: number;
  client_name: string;
  reference: string;
}

/**
 * The invoice of one service, as listed: in Accounts' scope with an Invoice No. Inside a transaction the visit row is
 * locked first, so an Invoice No. being changed at the same moment waits (and the acknowledgement follows the number).
 */
async function lockInvoice(db: Queryable, visitId: string, lock: boolean): Promise<LockedInvoice & { invoice_no: string }> {
  if (lock) await db.query("SELECT id FROM amc_visits_all WHERE id = $1 FOR UPDATE", [visitId]);
  const storedReference = await hasStoredReference();
  const result = await db.query<LockedInvoice>(
    `SELECT v.id AS visit_id, v.manual_invoice_no AS invoice_no, v.sequence_no, cl.name AS client_name, ${referenceSql("c", storedReference)} AS reference
     FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id JOIN clients cl ON cl.id = c.client_id
     WHERE v.id = $1 AND ${IN_SCOPE}`,
    [visitId]
  );
  const row = result.rows[0];

  if (!row) throw notFound("AMC service not found.");
  if (!row.invoice_no) throw conflict("This service has no Invoice No., so there is no invoice to acknowledge. Enter the Invoice No. on Accounts first.");
  return row as LockedInvoice & { invoice_no: string };
}

interface AckRow {
  id: string;
  status: AcknowledgementStatus;
}

async function findAcknowledgement(db: Queryable, visitId: string, invoiceNo: string, lock: boolean): Promise<AckRow | null> {
  const result = await db.query<AckRow>(
    `SELECT id, status FROM invoice_acknowledgements WHERE amc_visit_id = $1 AND invoice_number = $2 ${lock ? "FOR UPDATE" : ""}`,
    [visitId, invoiceNo]
  );

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

const label = (invoice: LockedInvoice & { invoice_no: string }) => `Invoice ${invoice.invoice_no} of ${invoice.reference} (service ${invoice.sequence_no}, "${invoice.client_name}")`;

const ALREADY_ACKNOWLEDGED = "This invoice is already acknowledged. Its document can only be replaced with Replace Document, which needs Edit permission and a reason.";

interface StoredUpload {
  key: string;
  sha256: string;
  originalName: string;
  mime: string;
  size: number;
}

/** Checks and stores the file before any row is written. The caller removes it again if the save fails. */
async function storeUpload(rawName: string, data: Buffer): Promise<StoredUpload> {
  const file = checkAcknowledgementFile(rawName, data);
  const key = `${randomUUID()}.${file.ext}`;
  const sha256 = createHash("sha256").update(data).digest("hex");

  await putStoredFile(key, data, "no acknowledgement document was saved");
  return { key, sha256, originalName: file.originalName, mime: file.mime, size: data.length };
}

/**
 * Records the stored file as the acknowledgement's current document: the next version of its document (after the
 * current one, or after one removed before confirmation), or the first document when it has never had one.
 */
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

/**
 * Attach Acknowledgement: stores the document in private storage and records it against the invoice's Pending
 * acknowledgement (created on first use). The status stays Pending until OK / Confirm. Choosing another file before
 * confirming adds a new version (the earlier one is kept). Refused once the invoice is acknowledged.
 */
export async function attachDocument(auth: AuthContext, visitId: string, rawName: string, data: Buffer, amountsVisible: boolean): Promise<AcknowledgementItem> {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  // Refuse an invoice that cannot take a document before the file is stored.
  const precheck = await lockInvoice(pool, visitId, false);
  if ((await findAcknowledgement(pool, visitId, precheck.invoice_no, false))?.status === "ACKNOWLEDGED") throw conflict(ALREADY_ACKNOWLEDGED);

  const upload = await storeUpload(rawName, data);

  try {
    return await withTransaction(async (db) => {
      const invoice = await lockInvoice(db, visitId, true);

      await db.query(
        `INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, created_by) VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT invoice_acknowledgements_invoice_uq DO NOTHING`,
        [visitId, invoice.invoice_no, auth.user.id]
      );
      const ack = (await findAcknowledgement(db, visitId, invoice.invoice_no, true)) as AckRow;

      if (ack.status === "ACKNOWLEDGED") throw conflict(ALREADY_ACKNOWLEDGED);

      const previous = await currentDocument(db, ack.id);
      const attachmentId = await recordDocument(db, auth, ack.id, upload, previous);

      await logActivity(db, {
        userId: auth.user.id,
        action: "invoice_acknowledgement.document_uploaded",
        module: LOG_MODULE,
        entityType: ENTITY_TYPE,
        entityId: ack.id,
        description: `Acknowledgement document ${upload.originalName} attached to ${label(invoice)}${previous ? `, in place of ${previous.original_name} (kept as version ${previous.version})` : ""}. Awaiting confirmation.`,
        metadata: {
          visitId,
          invoiceNumber: invoice.invoice_no,
          attachmentId,
          ...(previous ? { previousAttachmentId: previous.id } : {}),
          sha256: upload.sha256,
          sizeBytes: upload.size,
        },
      });

      return getAcknowledgement(visitId, amountsVisible, db);
    });
  } catch (error) {
    // Nothing records the file: remove it from storage again (best effort).
    await discardStoredFile(upload.key);
    throw error;
  }
}

/** Removes the document attached to a Pending acknowledgement before it is confirmed. The row and the file are kept, no longer current. */
export async function withdrawDocument(auth: AuthContext, visitId: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  return withTransaction(async (db) => {
    const invoice = await lockInvoice(db, visitId, true);
    const ack = await findAcknowledgement(db, visitId, invoice.invoice_no, true);

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
      metadata: { visitId, invoiceNumber: invoice.invoice_no, attachmentId: current.id },
    });

    return getAcknowledgement(visitId, amountsVisible, db);
  });
}

/**
 * OK / Confirm: the invoice becomes Acknowledged, with the date, time and user recorded. Only the document the user
 * saw (attachmentId) is confirmed, and only after its file is read back from storage and matches its checksum, so a
 * green status always has a real document behind it. The database refuses a confirmation without a document too.
 */
export async function confirmAcknowledgement(auth: AuthContext, visitId: string, attachmentId: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  const precheck = await lockInvoice(pool, visitId, false);
  const pending = await findAcknowledgement(pool, visitId, precheck.invoice_no, false);
  const stored = pending ? await currentDocument(pool, pending.id) : null;

  if (pending?.status === "ACKNOWLEDGED") throw conflict("This invoice is already acknowledged.");
  if (!pending || !stored) throw conflict("Attach the acknowledgement document before confirming.");
  if (stored.id !== attachmentId) throw conflict("The attached document has changed since you selected it. Review the document and confirm again.");

  await readStoredFile(stored.storage_key, stored.sha256, "The attached document could not be found in storage. Attach it again, then confirm.");

  return withTransaction(async (db) => {
    const invoice = await lockInvoice(db, visitId, true);
    const ack = await findAcknowledgement(db, visitId, invoice.invoice_no, true);
    const current = ack ? await currentDocument(db, ack.id) : null;

    if (ack?.status === "ACKNOWLEDGED") throw conflict("This invoice is already acknowledged.");
    if (!ack || !current || current.id !== attachmentId) {
      throw conflict("The invoice or its attached document changed while confirming. Reload and confirm again.");
    }

    await db.query("UPDATE invoice_acknowledgements SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1", [ack.id, auth.user.id]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "invoice_acknowledgement.confirmed",
      module: LOG_MODULE,
      entityType: ENTITY_TYPE,
      entityId: ack.id,
      description: `${label(invoice)} marked Acknowledged with document ${current.original_name}. Not a payment: Invoice No., Paid / Unpaid and amounts are unchanged.`,
      metadata: { visitId, invoiceNumber: invoice.invoice_no, attachmentId: current.id },
    });

    return getAcknowledgement(visitId, amountsVisible, db);
  });
}

/**
 * Replace Document (Edit permission): a new version of an Acknowledged invoice's document, with a reason. The earlier
 * version is kept; the acknowledgement keeps its original date and user. Never silent: the reason is in the Audit Log.
 */
export async function replaceDocument(auth: AuthContext, visitId: string, rawName: string, data: Buffer, reason: string, amountsVisible: boolean): Promise<AcknowledgementItem> {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  const precheck = await lockInvoice(pool, visitId, false);
  if ((await findAcknowledgement(pool, visitId, precheck.invoice_no, false))?.status !== "ACKNOWLEDGED") {
    throw conflict("Only an acknowledged invoice's document can be replaced. Attach and confirm the document instead.");
  }

  const upload = await storeUpload(rawName, data);

  try {
    return await withTransaction(async (db) => {
      const invoice = await lockInvoice(db, visitId, true);
      const ack = await findAcknowledgement(db, visitId, invoice.invoice_no, true);

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
        metadata: {
          visitId,
          invoiceNumber: invoice.invoice_no,
          attachmentId,
          ...(previous ? { previousAttachmentId: previous.id } : {}),
          reason,
          sha256: upload.sha256,
          sizeBytes: upload.size,
        },
      });

      return getAcknowledgement(visitId, amountsVisible, db);
    });
  } catch (error) {
    await discardStoredFile(upload.key);
    throw error;
  }
}

/**
 * The current document of the invoice's acknowledgement (attached or confirmed), for the viewer and its Download.
 * Only an invoice the page lists is served, and the file is checked against its checksum.
 */
export async function readDocument(visitId: string) {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  const invoice = await lockInvoice(pool, visitId, false);
  const ack = await findAcknowledgement(pool, visitId, invoice.invoice_no, false);
  const document = ack ? await currentDocument(pool, ack.id) : null;

  if (!document) throw notFound("This invoice has no acknowledgement document.");

  const data = await readStoredFile(document.storage_key, document.sha256, "The stored acknowledgement document could not be found.");

  return { data, mimeType: document.mime_type, fileName: document.original_name };
}

export interface DocumentVersion {
  attachmentId: string;
  invoiceNumber: string;
  version: number;
  isCurrent: boolean;
  originalName: string;
  uploadedBy: { id: string; fullName: string };
  uploadedAt: string;
}

/** Every document ever recorded for this service's acknowledgements (all Invoice Nos. it has had), newest first. Metadata only. */
export async function documentHistory(visitId: string): Promise<DocumentVersion[]> {
  if (!(await acknowledgementsAvailable())) throw unavailable();

  await lockInvoice(pool, visitId, false);
  const result = await pool.query<{ id: string; invoice_number: string; version: number; is_current: boolean; original_name: string; uploaded_by: string; full_name: string; uploaded_at: Date }>(
    `SELECT a.id, ack.invoice_number, a.version, a.is_current, a.original_name, a.uploaded_by, u.full_name, a.uploaded_at
     FROM invoice_acknowledgements ack
     JOIN attachments a ON a.entity_type = $2 AND a.entity_id = ack.id
     JOIN users u ON u.id = a.uploaded_by
     WHERE ack.amc_visit_id = $1
     ORDER BY a.uploaded_at DESC, a.id DESC`,
    [visitId, ENTITY_TYPE]
  );

  return result.rows.map((row) => ({
    attachmentId: row.id,
    invoiceNumber: row.invoice_number,
    version: row.version,
    isCurrent: row.is_current,
    originalName: row.original_name,
    uploadedBy: { id: row.uploaded_by, fullName: row.full_name },
    uploadedAt: row.uploaded_at.toISOString(),
  }));
}
