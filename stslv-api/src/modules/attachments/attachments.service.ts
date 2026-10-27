import { createHash, randomUUID } from "node:crypto";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { AppError, conflict, forbidden, notFound, validationError } from "../../shared/errors";
import type { Action, Module } from "../../shared/permissions";
import { LocalDiskStorage, type FileStorage } from "../../shared/storage";
import type { AuthContext } from "../auth/access";
import type { EntityType, UploadInput } from "./attachments.schemas";

// Which module's permission governs the attachments of each record type, and how to name the record.
const ENTITY: Record<EntityType, { module: Module; table: string; logModule: string; label: string }> = {
  amc_contracts: { module: "AMC_CONTRACTS", table: "amc_contracts", logModule: "AMC_CONTRACTS", label: "AMC contract" },
  procurement_requests: { module: "PROCUREMENT", table: "procurement_requests", logModule: "PROCUREMENT", label: "procurement request" },
  project_expenses: { module: "EXPENSES", table: "project_expenses", logModule: "EXPENSES", label: "expense" },
};

/** The file types accepted, recognised by their content, and the file name extensions allowed for each. */
const TYPES: { mime: string; ext: "pdf" | "png" | "jpg"; extensions: string[]; magic: number[] }[] = [
  { mime: "application/pdf", ext: "pdf", extensions: ["pdf"], magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: "image/png", ext: "png", extensions: ["png"], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", ext: "jpg", extensions: ["jpg", "jpeg"], magic: [0xff, 0xd8, 0xff] },
];

let storageOverride: FileStorage | null = null;

/** For tests: replace the storage. */
export function setStorageForTests(storage: FileStorage | null): void {
  storageOverride = storage;
}

function storage(): FileStorage {
  if (storageOverride) return storageOverride;
  if (!env.attachmentsDir) {
    throw new AppError(503, "STORAGE_UNAVAILABLE", "File storage is not configured on this server, so attachments cannot be uploaded or opened yet.");
  }

  return new LocalDiskStorage(env.attachmentsDir);
}

export function canAccess(auth: AuthContext, entityType: EntityType, action: Action): boolean {
  return auth.permissions.has(`${ENTITY[entityType].module}:${action}`);
}

function assertCan(auth: AuthContext, entityType: EntityType, action: Action): void {
  if (!canAccess(auth, entityType, action)) {
    throw forbidden();
  }
}

async function assertRecordExists(db: Queryable, entityType: EntityType, entityId: string): Promise<void> {
  const result = await db.query(`SELECT 1 FROM ${ENTITY[entityType].table} WHERE id = $1`, [entityId]);

  if (result.rowCount === 0) {
    throw notFound(`The ${ENTITY[entityType].label} was not found.`);
  }
}

/** The user's file name, reduced to a safe display name: no folders, no control characters, bounded length. */
export function cleanFileName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the raw text when it is not URI-encoded.
  }

  const base = decoded.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim().slice(0, 200);

  return clean || "file";
}

/** Recognises the file by its content and checks that its name agrees. */
export function detectType(data: Buffer, fileName: string) {
  const type = TYPES.find((candidate) => candidate.magic.every((byte, index) => data[index] === byte));

  if (!type) {
    throw validationError("Only PDF, PNG and JPEG files can be uploaded.", [{ field: "file", message: "Only PDF, PNG and JPEG files can be uploaded." }]);
  }

  const extension = fileName.includes(".") ? (fileName.split(".").pop() ?? "").toLowerCase() : "";

  if (!type.extensions.includes(extension)) {
    throw validationError("The file name does not match the file's content.", [
      { field: "file", message: `This file is a ${type.ext.toUpperCase()}; its name must end in ${type.extensions.map((item) => `.${item}`).join(" or ")}.` },
    ]);
  }

  return type;
}

function checkSize(data: Buffer): void {
  if (data.length === 0) {
    throw validationError("The file is empty.", [{ field: "file", message: "Choose a file to upload." }]);
  }
  if (data.length > env.attachmentMaxMb * 1024 * 1024) {
    throw validationError("The file is too large.", [{ field: "file", message: `Files can be at most ${env.attachmentMaxMb} MB.` }]);
  }
}

export interface Attachment {
  id: string;
  documentId: string;
  version: number;
  isCurrent: boolean;
  entityType: EntityType;
  entityId: string;
  category: string;
  title: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  uploadedBy: { id: string; fullName: string };
  uploadedAt: string;
  /** How many versions the document has (current list only). */
  versionCount?: number;
}

const SELECT = `
  SELECT a.id, a.document_id, a.version, a.is_current, a.entity_type, a.entity_id, a.category, a.title, a.original_name,
         a.mime_type, a.size_bytes::int AS size_bytes, a.sha256, a.storage_key, a.notes, a.uploaded_by, u.full_name, a.uploaded_at,
         (SELECT count(*)::int FROM attachments x WHERE x.document_id = a.document_id) AS version_count
  FROM attachments a JOIN users u ON u.id = a.uploaded_by`;

interface Row {
  id: string;
  document_id: string;
  version: number;
  is_current: boolean;
  entity_type: EntityType;
  entity_id: string;
  category: string;
  title: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  notes: string | null;
  uploaded_by: string;
  full_name: string;
  uploaded_at: Date;
  version_count: number;
}

function toAttachment(row: Row): Attachment {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    isCurrent: row.is_current,
    entityType: row.entity_type,
    entityId: row.entity_id,
    category: row.category,
    title: row.title,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    notes: row.notes,
    uploadedBy: { id: row.uploaded_by, fullName: row.full_name },
    uploadedAt: row.uploaded_at.toISOString(),
    versionCount: row.version_count,
  };
}

async function findRow(db: Queryable, id: string): Promise<Row> {
  const result = await db.query<Row>(`${SELECT} WHERE a.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Attachment not found.");
  }

  return row;
}

/** The current version of every document on a record, newest first. */
export async function listAttachments(auth: AuthContext, entityType: EntityType, entityId: string): Promise<Attachment[]> {
  assertCan(auth, entityType, "VIEW");
  await assertRecordExists(pool, entityType, entityId);

  const result = await pool.query<Row>(`${SELECT} WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.is_current ORDER BY a.uploaded_at DESC, a.id DESC`, [
    entityType,
    entityId,
  ]);

  return result.rows.map(toAttachment);
}

/** Every version of the document an attachment belongs to, newest first. */
export async function listVersions(auth: AuthContext, id: string): Promise<Attachment[]> {
  const row = await findRow(pool, id);

  assertCan(auth, row.entity_type, "VIEW");

  const result = await pool.query<Row>(`${SELECT} WHERE a.document_id = $1 ORDER BY a.version DESC`, [row.document_id]);

  return result.rows.map(toAttachment);
}

async function storeFile(data: Buffer, fileName: string) {
  checkSize(data);

  const type = detectType(data, fileName);
  const key = `${randomUUID()}.${type.ext}`;
  const sha256 = createHash("sha256").update(data).digest("hex");

  await storage().put(key, data);

  return { key, sha256, mime: type.mime };
}

export async function uploadAttachment(auth: AuthContext, input: UploadInput, rawName: string, data: Buffer): Promise<Attachment> {
  assertCan(auth, input.entityType, "EDIT");
  await assertRecordExists(pool, input.entityType, input.entityId);

  const originalName = cleanFileName(rawName);
  const file = await storeFile(data, originalName);

  return withTransaction(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, notes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [input.entityType, input.entityId, input.category, input.title, originalName, file.mime, data.length, file.sha256, file.key, input.notes ?? null, auth.user.id]
    );
    const id = (inserted.rows[0] as { id: string }).id;

    await db.query("UPDATE attachments SET document_id = id WHERE id = $1", [id]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "attachment.uploaded",
      module: ENTITY[input.entityType].logModule,
      entityType: input.entityType,
      entityId: input.entityId,
      description: `Document "${input.title}" (${originalName}) attached to the ${ENTITY[input.entityType].label}.`,
      metadata: { attachmentId: id, sha256: file.sha256, sizeBytes: data.length },
    });

    return toAttachment(await findRow(db, id));
  });
}

/** A replacement file for a document: becomes its current version; earlier versions are kept. */
export async function uploadVersion(auth: AuthContext, id: string, notes: string | null, rawName: string, data: Buffer): Promise<Attachment> {
  const current = await findRow(pool, id);

  assertCan(auth, current.entity_type, "EDIT");

  const originalName = cleanFileName(rawName);
  const file = await storeFile(data, originalName);

  return withTransaction(async (db) => {
    // Lock the document's versions so two replacements cannot take the same number.
    const versions = await db.query<{ version: number; is_current: boolean }>(
      "SELECT version, is_current FROM attachments WHERE document_id = $1 ORDER BY version DESC FOR UPDATE",
      [current.document_id]
    );
    const latest = versions.rows[0];

    if (!latest) {
      throw notFound("Attachment not found.");
    }
    if (current.version !== latest.version) {
      throw conflict("A newer version of this document exists. Replace the current version instead.");
    }

    await db.query("UPDATE attachments SET is_current = false WHERE document_id = $1 AND is_current", [current.document_id]);
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO attachments (document_id, version, entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, notes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [current.document_id, latest.version + 1, current.entity_type, current.entity_id, current.category, current.title, originalName, file.mime, data.length, file.sha256, file.key, notes, auth.user.id]
    );
    const newId = (inserted.rows[0] as { id: string }).id;

    await logActivity(db, {
      userId: auth.user.id,
      action: "attachment.version_uploaded",
      module: ENTITY[current.entity_type].logModule,
      entityType: current.entity_type,
      entityId: current.entity_id,
      description: `Document "${current.title}" replaced with version ${latest.version + 1} (${originalName}).`,
      metadata: { attachmentId: newId, documentId: current.document_id, sha256: file.sha256, sizeBytes: data.length },
    });

    return toAttachment(await findRow(db, newId));
  });
}

/** The stored file, after checking it against the checksum recorded at upload. */
export async function readAttachment(auth: AuthContext, id: string) {
  const row = await findRow(pool, id);

  assertCan(auth, row.entity_type, "VIEW");

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
