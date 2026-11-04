import { createHash, randomUUID } from "node:crypto";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { AppError, conflict, notFound, validationError } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import type { AuthContext } from "../auth/access";
import { cleanFileName, recogniseFile, storage, type FileKind } from "../attachments/attachments.service";

// The Service Report of one scheduled AMC service (visit), migration 0104.
//
// Stored in the attachments table like every other document (metadata only, the
// file under a generated key in the configured storage), with entity_type
// 'amc_visits' and entity_id = the visit id, so each service has its own report.
// It is reached only through the Service Status routes, never through the
// generic attachment routes, so the completion rules below always apply:
//   * a service can be marked Completed only while it has a current report;
//   * before completion the report can be replaced (a new version of the same
//     document; earlier versions are kept) or removed (marked not current; the
//     row and the file are kept);
//   * once the service is completed, its report is locked with it.

const ENTITY_TYPE = "amc_visits";
const CATEGORY = "SERVICE_REPORT";

/** The message the page shows when a service is completed without a report. Kept identical to the page's popup. */
export const SERVICE_REPORT_REQUIRED_MESSAGE = "Please upload service report.";

/**
 * The file types a service report may be, recognised by their content (never by the name or the browser's stated
 * type alone) with the same rules as contract documents (0103): a .docx is a ZIP package with a Word body, a .doc an
 * OLE compound file with a WordDocument stream, and either is refused when it carries macros. The rules live in
 * attachments.service (recogniseFile); only the service-report wording is kept here.
 */
const SERVICE_REPORT_KINDS: readonly FileKind[] = ["PDF", "DOC", "DOCX"];

export const SERVICE_REPORT_TYPES_TEXT = "PDF, DOC and DOCX";

const fileError = (message: string) => validationError(message, [{ field: "serviceReport", message }]);

/** Checks name, size and content of an uploaded report. Nothing is stored when it fails. */
export function checkReportFile(rawName: string, data: Buffer) {
  const originalName = cleanFileName(rawName);

  if (data.length === 0) throw fileError("The chosen file is empty. Choose another file.");
  if (data.length > env.attachmentMaxMb * 1024 * 1024) throw fileError(`Service reports can be at most ${env.attachmentMaxMb} MB.`);

  const match = recogniseFile(data, SERVICE_REPORT_KINDS);

  if (!match) throw fileError(`Only ${SERVICE_REPORT_TYPES_TEXT} files can be uploaded as a service report.`);
  if (match.refused) throw fileError(match.refused);

  const { type } = match;
  const extension = originalName.includes(".") ? (originalName.split(".").pop() ?? "").toLowerCase() : "";

  if (!type.extensions.includes(extension)) {
    throw fileError(`This file is a ${type.kind === "PDF" ? "PDF" : "Word document"}; its name must end in .${type.ext}.`);
  }

  return { originalName, mime: type.mime, ext: type.ext };
}

/** Whether this database can hold service reports (migration 0104). */
export function serviceReportsAvailable(): Promise<boolean> {
  return schemaHas(["attachments_service_report_uq"]);
}

function reportsUnavailable(): AppError {
  return new AppError(
    503,
    "FEATURE_UNAVAILABLE",
    "Service reports cannot be stored until the database is updated (migration 0104), so services cannot be completed yet."
  );
}

export interface ServiceReport {
  id: string;
  documentId: string;
  version: number;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: { id: string; fullName: string };
  uploadedAt: string;
}

interface ReportRow {
  id: string;
  document_id: string;
  version: number;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  uploaded_by: string;
  full_name: string;
  uploaded_at: Date;
}

/** The SQL of a visit's current report as JSON, for list and detail queries ("v" is the visit). */
export const SERVICE_REPORT_JSON_SQL = `(
  SELECT jsonb_build_object('id', a.id::text, 'documentId', a.document_id::text, 'version', a.version, 'originalName', a.original_name,
                            'mimeType', a.mime_type, 'sizeBytes', a.size_bytes, 'uploadedAt', a.uploaded_at,
                            'uploadedBy', jsonb_build_object('id', a.uploaded_by::text, 'fullName', u.full_name))
  FROM attachments a JOIN users u ON u.id = a.uploaded_by
  WHERE a.entity_type = '${ENTITY_TYPE}' AND a.entity_id = v.id AND a.is_current)`;

/** A report as read by SERVICE_REPORT_JSON_SQL. */
export function toServiceReport(value: unknown): ServiceReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as ServiceReport & { uploadedAt: string | Date };

  return { ...report, uploadedAt: new Date(report.uploadedAt).toISOString() };
}

async function currentReport(db: Queryable, visitId: string): Promise<ReportRow | null> {
  const result = await db.query<ReportRow>(
    `SELECT a.id, a.document_id, a.version, a.original_name, a.mime_type, a.size_bytes::int AS size_bytes, a.sha256, a.storage_key,
            a.uploaded_by, u.full_name, a.uploaded_at
     FROM attachments a JOIN users u ON u.id = a.uploaded_by
     WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.is_current`,
    [ENTITY_TYPE, visitId]
  );

  return result.rows[0] ?? null;
}

function toReport(row: ReportRow): ServiceReport {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    uploadedBy: { id: row.uploaded_by, fullName: row.full_name },
    uploadedAt: row.uploaded_at.toISOString(),
  };
}

interface LockedVisit {
  id: string;
  status: string;
  sequence_no: number;
  client_name: string;
  system_description: string;
}

/** Reads the visit; inside a transaction, locks it first, so a completion and a report change of the same visit run one after the other. */
async function lockVisit(db: Queryable, visitId: string, lock = true): Promise<LockedVisit> {
  if (lock) await db.query("SELECT id FROM amc_visits WHERE id = $1 FOR UPDATE", [visitId]);
  const result = await db.query<LockedVisit>(
    `SELECT v.id, v.status, v.sequence_no, cl.name AS client_name, c.system_description
     FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id JOIN clients cl ON cl.id = c.client_id
     WHERE v.id = $1`,
    [visitId]
  );
  const row = result.rows[0];

  if (!row) throw notFound("AMC visit not found.");
  return row;
}

function assertReportEditable(visit: LockedVisit): void {
  if (visit.status === "COMPLETED") {
    throw conflict("This service is completed and locked, so its service report cannot be changed.");
  }
  if (visit.status === "HISTORICAL" || visit.status === "CANCELLED") {
    throw conflict(`This visit is ${visit.status === "HISTORICAL" ? "a historical record" : "cancelled"} and is not managed on the Service Status page.`);
  }
}

const label = (visit: LockedVisit) => `AMC visit ${visit.sequence_no} for "${visit.client_name}" (${visit.system_description})`;

/** Best effort: removes a stored file that no row records (its save failed). Never throws. */
async function discard(key: string): Promise<void> {
  try {
    await storage().remove?.(key);
  } catch {
    // The file stays behind; with no row it is never listed or served.
  }
}

/** The current report of one visit, or null. */
export async function getServiceReport(visitId: string): Promise<ServiceReport | null> {
  if (!(await serviceReportsAvailable())) return null;

  const visit = await pool.query("SELECT 1 FROM amc_visits WHERE id = $1", [visitId]);

  if (visit.rowCount === 0) throw notFound("AMC visit not found.");

  const row = await currentReport(pool, visitId);

  return row ? toReport(row) : null;
}

/**
 * Uploads (or replaces) the report of one service that is not yet completed. The file is checked before anything is
 * stored; the row is written in one transaction with the visit locked; a failed save removes the stored file again.
 */
export async function uploadServiceReport(auth: AuthContext, visitId: string, rawName: string, data: Buffer): Promise<ServiceReport> {
  if (!(await serviceReportsAvailable())) throw reportsUnavailable();

  // Refuse a visit that cannot take a report before the file is stored.
  assertReportEditable(await lockVisit(pool, visitId, false));

  const file = checkReportFile(rawName, data);
  const key = `${randomUUID()}.${file.ext}`;
  const sha256 = createHash("sha256").update(data).digest("hex");

  await storage().put(key, data);

  try {
    return await withTransaction(async (db) => {
      const visit = await lockVisit(db, visitId);

      assertReportEditable(visit);

      const previous = await currentReport(db, visitId);
      let id: string;

      if (previous) {
        await db.query("UPDATE attachments SET is_current = false WHERE id = $1", [previous.id]);
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO attachments (document_id, version, entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, 'Service report', $6, $7, $8, $9, $10, $11) RETURNING id`,
          [previous.document_id, previous.version + 1, ENTITY_TYPE, visitId, CATEGORY, file.originalName, file.mime, data.length, sha256, key, auth.user.id]
        );
        id = (inserted.rows[0] as { id: string }).id;
      } else {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
           VALUES ($1, $2, $3, 'Service report', $4, $5, $6, $7, $8, $9) RETURNING id`,
          [ENTITY_TYPE, visitId, CATEGORY, file.originalName, file.mime, data.length, sha256, key, auth.user.id]
        );
        id = (inserted.rows[0] as { id: string }).id;
        await db.query("UPDATE attachments SET document_id = id WHERE id = $1", [id]);
      }

      await logActivity(db, {
        userId: auth.user.id,
        action: previous ? "amc_visit.service_report_replaced" : "amc_visit.service_report_uploaded",
        module: "AMC_EXECUTION",
        entityType: "amc_visits",
        entityId: visitId,
        description: `Service report ${previous ? `of ${label(visit)} replaced with` : `attached to ${label(visit)}:`} ${file.originalName}.`,
        metadata: { attachmentId: id, ...(previous ? { replacedAttachmentId: previous.id } : {}), sha256, sizeBytes: data.length },
      });

      return toReport((await currentReport(db, visitId)) as ReportRow);
    });
  } catch (error) {
    await discard(key);
    throw error;
  }
}

/** Removes the report of a service that is not yet completed. The row and the file are kept, no longer current. */
export async function removeServiceReport(auth: AuthContext, visitId: string): Promise<void> {
  if (!(await serviceReportsAvailable())) throw reportsUnavailable();

  await withTransaction(async (db) => {
    const visit = await lockVisit(db, visitId);

    assertReportEditable(visit);

    const current = await currentReport(db, visitId);

    if (!current) throw notFound("This service has no service report to remove.");

    await db.query("UPDATE attachments SET is_current = false WHERE id = $1", [current.id]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "amc_visit.service_report_removed",
      module: "AMC_EXECUTION",
      entityType: "amc_visits",
      entityId: visitId,
      description: `Service report ${current.original_name} removed from ${label(visit)} before completion. The file is kept.`,
      metadata: { attachmentId: current.id },
    });
  });
}

/** The current report's file, after checking it against the checksum recorded at upload. */
export async function readServiceReport(visitId: string) {
  if (!(await serviceReportsAvailable())) throw reportsUnavailable();

  const visit = await pool.query("SELECT 1 FROM amc_visits WHERE id = $1", [visitId]);

  if (visit.rowCount === 0) throw notFound("AMC visit not found.");

  const row = await currentReport(pool, visitId);

  if (!row) throw notFound("This service has no service report.");

  const data = await storage()
    .get(row.storage_key)
    .catch(() => {
      throw new AppError(404, "FILE_MISSING", "The stored file could not be found.");
    });

  if (createHash("sha256").update(data).digest("hex") !== row.sha256) {
    throw new AppError(409, "INTEGRITY_FAILED", "The stored file does not match its recorded checksum, so it is not served.");
  }

  return { data, mimeType: row.mime_type, fileName: row.original_name };
}

/**
 * Within the completing transaction, with the visit already locked: a service may become Completed only while it has
 * a current report. Every completion path (Service Status, the execution API) goes through applyExecution, which calls this.
 */
export async function assertServiceReportPresent(db: Queryable, visitId: string): Promise<void> {
  if (!(await serviceReportsAvailable())) throw reportsUnavailable();

  if (!(await currentReport(db, visitId))) {
    throw new AppError(409, "SERVICE_REPORT_REQUIRED", SERVICE_REPORT_REQUIRED_MESSAGE, [{ field: "serviceReport", message: SERVICE_REPORT_REQUIRED_MESSAGE }]);
  }
}
