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

export type FileKind = "PDF" | "PNG" | "JPEG" | "DOC" | "DOCX";

export interface FileType {
  kind: FileKind;
  mime: string;
  ext: "pdf" | "png" | "jpg" | "doc" | "docx";
  extensions: string[];
  magic: number[];
  /** A further check of the content, after the leading bytes match. Returns why the file is refused, or null. */
  inspect?: (data: Buffer) => string | null;
}

const has = (data: Buffer, text: string, encoding: BufferEncoding = "latin1") => data.includes(Buffer.from(text, encoding));

/**
 * The file types accepted, recognised by their content, and the file name extensions allowed for each.
 * Word files (migration 0103): a .docx is a ZIP package with a Word body; a .doc is an OLE compound file with a
 * WordDocument stream. Either is refused when it carries macros (a VBA project), so no macro-enabled file is stored.
 * The names inside both formats are stored uncompressed, so they can be found without unpacking the file.
 */
const TYPES: FileType[] = [
  { kind: "PDF", mime: "application/pdf", ext: "pdf", extensions: ["pdf"], magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { kind: "PNG", mime: "image/png", ext: "png", extensions: ["png"], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: "JPEG", mime: "image/jpeg", ext: "jpg", extensions: ["jpg", "jpeg"], magic: [0xff, 0xd8, 0xff] },
  {
    kind: "DOCX",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
    extensions: ["docx"],
    magic: [0x50, 0x4b, 0x03, 0x04],
    inspect: (data) =>
      !has(data, "[Content_Types].xml") || !has(data, "word/document.xml")
        ? "This file is not a Word document."
        : has(data, "vbaProject.bin")
          ? "Word documents with macros cannot be uploaded."
          : null,
  },
  {
    kind: "DOC",
    mime: "application/msword",
    ext: "doc",
    extensions: ["doc"],
    magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    inspect: (data) =>
      !has(data, "WordDocument", "utf16le")
        ? "This file is not a Word document."
        : has(data, "Macros", "utf16le") || has(data, "_VBA_PROJECT", "utf16le")
          ? "Word documents with macros cannot be uploaded."
          : null,
  },
];

/** The kinds each record type may hold. Word files only on AMC contracts (the contract document, 0103). */
const KINDS_BY_ENTITY: Record<EntityType, FileKind[]> = {
  amc_contracts: ["PDF", "PNG", "JPEG", "DOC", "DOCX"],
  procurement_requests: ["PDF", "PNG", "JPEG"],
  project_expenses: ["PDF", "PNG", "JPEG"],
};

/** The kinds a new contract's mandatory contract document may be (Add AMC Contract). */
export const CONTRACT_DOCUMENT_KINDS: FileKind[] = ["PDF", "DOC", "DOCX"];

function kindList(kinds: FileKind[]): string {
  const names = kinds.map((kind) => (kind === "DOC" || kind === "DOCX" ? `Word (.${kind.toLowerCase()})` : kind));

  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

let storageOverride: FileStorage | null = null;

/** For tests: replace the storage. */
export function setStorageForTests(storage: FileStorage | null): void {
  storageOverride = storage;
}

export function storage(): FileStorage {
  if (storageOverride) return storageOverride;
  if (!env.attachmentsDir) {
    throw new AppError(503, "STORAGE_UNAVAILABLE", "File storage is not configured on this server, so attachments cannot be uploaded or opened yet.");
  }

  return new LocalDiskStorage(env.attachmentsDir);
}

/** Whether this server can store files at all (ATTACHMENTS_DIR, or a test storage). */
export function storageConfigured(): boolean {
  return storageOverride !== null || env.attachmentsDir !== null;
}

/** The refusal for a new AMC contract on a server that cannot store its mandatory contract document. */
export function contractDocumentStorageUnavailable(): AppError {
  return new AppError(
    503,
    "STORAGE_UNAVAILABLE",
    "No contract was created: a new AMC contract needs its contract document, and this server has no file storage configured (ATTACHMENTS_DIR). Ask the system administrator to configure durable document storage."
  );
}

export function canAccess(auth: AuthContext, entityType: EntityType, action: Action): boolean {
  // A record type not listed here (a visit's service report, 0104) is never reached through these routes: it has its own.
  const entity = ENTITY[entityType] as (typeof ENTITY)[EntityType] | undefined;

  return entity !== undefined && auth.permissions.has(`${entity.module}:${action}`);
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

/**
 * Recognises a file by its content among the allowed kinds. Returns null when it is none of them; otherwise the type
 * and, when its content is refused (not really a Word file, or one carrying macros), why. The single place these
 * content rules live: contract documents, attachments and visit service reports (0104) all use it.
 */
export function recogniseFile(data: Buffer, kinds: readonly FileKind[]): { type: FileType; refused: string | null } | null {
  const type = TYPES.filter((candidate) => kinds.includes(candidate.kind)).find((candidate) => candidate.magic.every((byte, index) => data[index] === byte));

  return type ? { type, refused: type.inspect?.(data) ?? null } : null;
}

/**
 * Recognises the file by its content and checks that its name agrees. `kinds` are the types allowed here (by default
 * PDF, PNG and JPEG, as before 0103); `field` names the form field an error belongs to.
 */
export function detectType(data: Buffer, fileName: string, kinds: FileKind[] = ["PDF", "PNG", "JPEG"], field = "file") {
  const match = recogniseFile(data, kinds);
  const onlyMessage = `Only ${kindList(kinds)} files can be uploaded.`;

  if (!match) {
    throw validationError(onlyMessage, [{ field, message: onlyMessage }]);
  }

  const { type, refused } = match;

  if (refused) {
    throw validationError(refused, [{ field, message: refused }]);
  }

  const extension = fileName.includes(".") ? (fileName.split(".").pop() ?? "").toLowerCase() : "";

  if (!type.extensions.includes(extension)) {
    throw validationError("The file name does not match the file's content.", [
      { field, message: `This file is a ${type.kind === "DOC" || type.kind === "DOCX" ? "Word document" : type.ext.toUpperCase()}; its name must end in ${type.extensions.map((item) => `.${item}`).join(" or ")}.` },
    ]);
  }

  return type;
}

function checkSize(data: Buffer, field = "file"): void {
  if (data.length === 0) {
    throw validationError("The file is empty.", [{ field, message: field === "file" ? "Choose a file to upload." : "The chosen file is empty. Choose another file." }]);
  }
  if (data.length > env.attachmentMaxMb * 1024 * 1024) {
    throw validationError("The file is too large.", [{ field, message: `Files can be at most ${env.attachmentMaxMb} MB.` }]);
  }
}

/** The upload rules for a record type, as the pages state them. */
export function uploadLimits(entityType: EntityType) {
  return { maxMb: env.attachmentMaxMb, allowedTypes: KINDS_BY_ENTITY[entityType].map((kind) => (kind === "DOC" || kind === "DOCX" ? `Word (.${kind.toLowerCase()})` : kind)) };
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
  /** The stored file checked against its recorded SHA-256 just now (the two list reads only). */
  integrity?: IntegrityState;
}

/** VERIFIED: the file matches its checksum. FAILED: it does not. MISSING: no stored file. UNAVAILABLE: no storage to check on this server. */
export type IntegrityState = "VERIFIED" | "FAILED" | "MISSING" | "UNAVAILABLE";

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

/** Reads the stored file and compares it with the checksum recorded at upload. Never throws: the answer is the state. */
async function checkIntegrity(row: Row): Promise<IntegrityState> {
  let files: FileStorage;

  try {
    files = storage();
  } catch {
    return "UNAVAILABLE";
  }

  try {
    const data = await files.get(row.storage_key);

    return createHash("sha256").update(data).digest("hex") === row.sha256 ? "VERIFIED" : "FAILED";
  } catch {
    return "MISSING";
  }
}

/** One file at a time, so a record with many large files does not hold them all in memory together. */
async function withIntegrity(rows: Row[]): Promise<Attachment[]> {
  const checked: Attachment[] = [];

  for (const row of rows) {
    checked.push({ ...toAttachment(row), integrity: await checkIntegrity(row) });
  }

  return checked;
}

/** The current version of every document on a record, newest first. */
export async function listAttachments(auth: AuthContext, entityType: EntityType, entityId: string): Promise<Attachment[]> {
  assertCan(auth, entityType, "VIEW");
  await assertRecordExists(pool, entityType, entityId);

  const result = await pool.query<Row>(`${SELECT} WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.is_current ORDER BY a.uploaded_at DESC, a.id DESC`, [
    entityType,
    entityId,
  ]);

  return withIntegrity(result.rows);
}

/** Every version of every document on a record, newest first, with the upload rules the page states. */
export async function listRecordVersions(auth: AuthContext, entityType: EntityType, entityId: string) {
  assertCan(auth, entityType, "VIEW");
  await assertRecordExists(pool, entityType, entityId);

  const result = await pool.query<Row>(`${SELECT} WHERE a.entity_type = $1 AND a.entity_id = $2 ORDER BY a.uploaded_at DESC, a.id DESC`, [entityType, entityId]);

  return {
    items: await withIntegrity(result.rows),
    limits: uploadLimits(entityType),
  };
}

/** Every version of the document an attachment belongs to, newest first. */
export async function listVersions(auth: AuthContext, id: string): Promise<Attachment[]> {
  const row = await findRow(pool, id);

  assertCan(auth, row.entity_type, "VIEW");

  const result = await pool.query<Row>(`${SELECT} WHERE a.document_id = $1 ORDER BY a.version DESC`, [row.document_id]);

  return result.rows.map(toAttachment);
}

async function storeFile(data: Buffer, fileName: string, kinds: FileKind[]) {
  checkSize(data);

  const type = detectType(data, fileName, kinds);
  const key = `${randomUUID()}.${type.ext}`;
  const sha256 = createHash("sha256").update(data).digest("hex");

  await storage().put(key, data);

  return { key, sha256, mime: type.mime };
}

/** Best effort: removes a stored file that no attachment row records (its save failed). Never throws. */
export async function discardStoredFile(key: string): Promise<void> {
  try {
    await storage().remove?.(key);
  } catch {
    // The file stays behind; with no row it is never listed or served.
  }
}

/** The database refuses a Word file until migration 0103 widens the type check: say so instead of failing with a 500. */
function wordNeedsMigration(error: unknown): never {
  if (typeof error === "object" && error !== null && (error as { code?: string; constraint?: string }).code === "23514" && (error as { constraint?: string }).constraint === "attachments_mime_ck") {
    throw new AppError(503, "FEATURE_UNAVAILABLE", "Word documents cannot be stored until the database is updated (migration 0103). Upload a PDF instead.");
  }

  throw error;
}

interface StoredFile {
  key: string;
  sha256: string;
  mime: string;
  originalName: string;
  sizeBytes: number;
}

/** Within the caller's transaction: records a stored file as the first version of a new document, and logs it. */
async function recordAttachment(db: Queryable, auth: AuthContext, input: { entityType: EntityType; entityId: string; category: string; title: string; notes: string | null }, file: StoredFile): Promise<string> {
  const inserted = await db
    .query<{ id: string }>(
      `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, notes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [input.entityType, input.entityId, input.category, input.title, file.originalName, file.mime, file.sizeBytes, file.sha256, file.key, input.notes, auth.user.id]
    )
    .catch(wordNeedsMigration);
  const id = (inserted.rows[0] as { id: string }).id;

  await db.query("UPDATE attachments SET document_id = id WHERE id = $1", [id]);
  await logActivity(db, {
    userId: auth.user.id,
    action: "attachment.uploaded",
    module: ENTITY[input.entityType].logModule,
    entityType: input.entityType,
    entityId: input.entityId,
    description: `Document "${input.title}" (${file.originalName}) attached to the ${ENTITY[input.entityType].label}.`,
    metadata: { attachmentId: id, sha256: file.sha256, sizeBytes: file.sizeBytes },
  });

  return id;
}

export async function uploadAttachment(auth: AuthContext, input: UploadInput, rawName: string, data: Buffer): Promise<Attachment> {
  assertCan(auth, input.entityType, "EDIT");
  await assertRecordExists(pool, input.entityType, input.entityId);

  const originalName = cleanFileName(rawName);
  const file = await storeFile(data, originalName, KINDS_BY_ENTITY[input.entityType]);

  try {
    return await withTransaction(async (db) => {
      const id = await recordAttachment(db, auth, { entityType: input.entityType, entityId: input.entityId, category: input.category, title: input.title, notes: input.notes ?? null }, { ...file, originalName, sizeBytes: data.length });

      return toAttachment(await findRow(db, id));
    });
  } catch (error) {
    await discardStoredFile(file.key);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The contract document of a new AMC contract (Add AMC Contract, 2026-11-03)
// ---------------------------------------------------------------------------

/** The title and document type the mandatory contract document is recorded under. */
export const CONTRACT_DOCUMENT = { category: "SIGNED_CONTRACT", title: "Contract document" } as const;

export interface PreparedDocument {
  originalName: string;
  data: Buffer;
  mime: string;
  ext: string;
}

/**
 * Checks a new contract's contract document before anything is saved: its name, size and content (PDF or Word,
 * recognised by content, never by the name or the browser's stated type alone). Errors belong to "contractDocument".
 */
export function prepareContractDocument(rawName: string, data: Buffer): PreparedDocument {
  const originalName = cleanFileName(rawName);

  checkSize(data, "contractDocument");
  const type = detectType(data, originalName, CONTRACT_DOCUMENT_KINDS, "contractDocument");

  return { originalName, data, mime: type.mime, ext: type.ext };
}

/** Writes a prepared document to storage under a new key. Nothing records it until attachStoredDocument. */
export async function storePreparedDocument(document: PreparedDocument): Promise<StoredFile> {
  if (!storageConfigured()) {
    throw contractDocumentStorageUnavailable();
  }

  const key = `${randomUUID()}.${document.ext}`;

  await storage().put(key, document.data);

  return { key, sha256: createHash("sha256").update(document.data).digest("hex"), mime: document.mime, originalName: document.originalName, sizeBytes: document.data.length };
}

/** Within the contract's own transaction: records the stored contract document against the new contract. */
export function attachStoredDocument(db: Queryable, auth: AuthContext, contractId: string, file: StoredFile): Promise<string> {
  return recordAttachment(db, auth, { entityType: "amc_contracts", entityId: contractId, category: CONTRACT_DOCUMENT.category, title: CONTRACT_DOCUMENT.title, notes: null }, file);
}

/** A replacement file for a document: becomes its current version; earlier versions are kept. */
export async function uploadVersion(auth: AuthContext, id: string, notes: string | null, rawName: string, data: Buffer): Promise<Attachment> {
  const current = await findRow(pool, id);

  assertCan(auth, current.entity_type, "EDIT");

  const originalName = cleanFileName(rawName);
  const file = await storeFile(data, originalName, KINDS_BY_ENTITY[current.entity_type]);

  try {
    return await withTransaction(async (db) => {
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
    ).catch(wordNeedsMigration);
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
  } catch (error) {
    await discardStoredFile(file.key);
    throw error;
  }
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
