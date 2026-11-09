import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";
import type { BackupConfig } from "./config";
import { decryptFile, encryptFile, type GpgOptions } from "./gpg";
import { describeFailure, type Logger } from "./log";
import { pingHeartbeat, readState, sendAlert, writeState, type Fetch } from "./notify";
import { newestFirst, newRunId } from "./run-id";
import { assertObjectKey, ObjectExistsError, type ReadableStore, type WritableStore } from "./store";
import { sha256File } from "./tools";

// Encrypted, versioned copies of the private document bucket (contract documents, service reports, quotations,
// receipts: every row of the attachments table).
//
// Inventory: the attachments table (what the application believes it holds, with each file's SHA-256) and a
// listing of the bucket under "attachments/" (what is really there).
//
// Copy: each file is downloaded, its SHA-256 computed and compared with the database, encrypted with the backup
// PUBLIC key and stored at   docs/files/<original object path>/<sha256>.gpg
// The key contains the content's checksum, so:
//   - an unchanged file is already backed up and is skipped without downloading it again;
//   - a changed file gets a NEW key: the earlier version is kept, nothing is ever overwritten;
//   - nothing in the backup store is ever deleted by this job.
// The source is reached only through a ReadableStore (list / head / download), so this job cannot write to or
// delete from the production bucket.
//
// Each run writes docs/manifests/<run id>.json (last), listing every file with its path, size, checksum, its
// attachment record and its encrypted copy. A restore reads a manifest.
//
// Reported as problems (alert, exit code 2, manifest still written):
//   missing   a database row whose file is not in the bucket;
//   mismatch  a file whose content does not match the database checksum (kept and backed up as found).

export const DOCS_PREFIX = "docs/";
export const SOURCE_PREFIX = "attachments/";
const RUN_PREFIX = "stslv-docs";

export type DocumentStatus = "copied" | "already-backed-up" | "missing-in-bucket" | "checksum-mismatch" | "not-in-database";

export interface DocumentEntry {
  sourceKey: string;
  /** Actual content checksum (or the database's, when the file is missing). */
  sha256: string;
  bytes: number | null;
  encryptedKey: string | null;
  status: DocumentStatus;
  attachment: {
    id: string;
    documentId: string | null;
    version: number;
    isCurrent: boolean;
    entityType: string;
    entityId: string;
    category: string;
    originalName: string;
    mimeType: string;
    databaseSha256: string;
    uploadedAt: string;
  } | null;
}

export interface DocumentsManifest {
  format: 1;
  kind: "documents";
  id: string;
  environment: string;
  createdAt: string;
  finishedAt: string;
  source: string;
  summary: Record<DocumentStatus, number> & { databaseRows: number; bucketObjects: number };
  entries: DocumentEntry[];
}

interface AttachmentRow {
  id: string;
  document_id: string | null;
  version: number;
  is_current: boolean;
  entity_type: string;
  entity_id: string;
  category: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  uploaded_at: Date;
}

export const encryptedDocKey = (sourceKey: string, sha256: string) => `${DOCS_PREFIX}files/${sourceKey}/${sha256}.gpg`;
export const docsManifestKey = (id: string) => `${DOCS_PREFIX}manifests/${id}.json`;

/** Read-only inventory of the attachments table. */
export async function readAttachmentInventory(db: Pick<Client, "query">): Promise<AttachmentRow[]> {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await db.query<AttachmentRow>(
      `SELECT id::text, document_id::text, version, is_current, entity_type, entity_id::text, category, original_name, mime_type,
              size_bytes::text, sha256, storage_key, uploaded_at
       FROM attachments ORDER BY id`
    );
    return result.rows;
  } finally {
    await db.query("COMMIT");
  }
}

export interface DocsBackupDeps {
  config: Pick<BackupConfig, "environment" | "workDir" | "stateDir" | "gpg" | "alertWebhookUrl" | "heartbeatDocsUrl">;
  source: ReadableStore;
  store: WritableStore;
  inventory: () => Promise<AttachmentRow[]>;
  log: Logger;
  /** Download and re-hash files even when their encrypted copy exists (periodic full integrity check). */
  verifySource?: boolean;
  now?: () => Date;
  fetchImpl?: Fetch;
}

export async function runDocumentsBackup(deps: DocsBackupDeps): Promise<DocumentsManifest> {
  const { config, source, store, log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const id = newRunId(RUN_PREFIX, config.environment, startedAt);
  const runDir = path.join(config.workDir, id);
  const state = await readState(config.stateDir, "docs-backup");

  log.info("docs_backup.start", { id, source: source.label, store: store.label, verifySource: Boolean(deps.verifySource) });

  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });

    const rows = await deps.inventory();
    const objects = await source.list(SOURCE_PREFIX);
    const bySourceKey = new Map(objects.map((object) => [object.key, object]));
    const known = new Set<string>();
    const entries: DocumentEntry[] = [];
    let counter = 0;

    const copy = async (sourceKey: string, expectedSha: string | null): Promise<{ sha256: string; bytes: number; encryptedKey: string; copied: boolean }> => {
      assertObjectKey(sourceKey);
      const plain = path.join(runDir, `f${counter}`);
      const encrypted = path.join(runDir, `f${counter}.gpg`);
      counter += 1;

      await source.download(sourceKey, plain);
      try {
        const sha256 = await sha256File(plain);
        const bytes = (await stat(plain)).size;
        const encryptedKey = encryptedDocKey(sourceKey, sha256);

        if (await store.head(encryptedKey)) return { sha256, bytes, encryptedKey, copied: false };

        await encryptFile(config.gpg, config.gpg.recipient, plain, encrypted);
        await rm(plain, { force: true });

        const size = (await stat(encrypted)).size;
        try {
          await store.upload(encryptedKey, encrypted, "application/pgp-encrypted");
        } catch (error) {
          // Another run stored the same content at the same moment: the copy exists, which is what matters.
          if (!(error instanceof ObjectExistsError)) throw error;
        }
        const uploaded = await store.head(encryptedKey);
        if (!uploaded || (uploaded.size !== size && expectedSha !== null)) throw new Error(`The encrypted copy of ${sourceKey} has the wrong size in the backup store.`);

        return { sha256, bytes, encryptedKey, copied: true };
      } finally {
        await rm(plain, { force: true });
        await rm(encrypted, { force: true });
      }
    };

    for (const row of rows) {
      const sourceKey = `${SOURCE_PREFIX}${row.storage_key}`;
      known.add(sourceKey);

      const attachment = {
        id: row.id,
        documentId: row.document_id,
        version: row.version,
        isCurrent: row.is_current,
        entityType: row.entity_type,
        entityId: row.entity_id,
        category: row.category,
        originalName: row.original_name,
        mimeType: row.mime_type,
        databaseSha256: row.sha256,
        uploadedAt: row.uploaded_at.toISOString(),
      };

      if (!bySourceKey.has(sourceKey)) {
        entries.push({ sourceKey, sha256: row.sha256, bytes: Number(row.size_bytes), encryptedKey: null, status: "missing-in-bucket", attachment });
        log.error("docs_backup.missing", { attachmentId: row.id, sourceKey });
        continue;
      }

      const existing = encryptedDocKey(sourceKey, row.sha256);
      if (!deps.verifySource && (await store.head(existing))) {
        entries.push({ sourceKey, sha256: row.sha256, bytes: Number(row.size_bytes), encryptedKey: existing, status: "already-backed-up", attachment });
        continue;
      }

      const result = await copy(sourceKey, row.sha256);
      const matches = result.sha256 === row.sha256;

      if (!matches) log.error("docs_backup.checksum_mismatch", { attachmentId: row.id, sourceKey });
      entries.push({
        sourceKey,
        sha256: result.sha256,
        bytes: result.bytes,
        encryptedKey: result.encryptedKey,
        status: !matches ? "checksum-mismatch" : result.copied ? "copied" : "already-backed-up",
        attachment,
      });
    }

    // Objects the database does not know about are copied too: nothing in the bucket is left without a copy.
    for (const object of objects) {
      if (known.has(object.key)) continue;
      const result = await copy(object.key, null);
      entries.push({ sourceKey: object.key, sha256: result.sha256, bytes: result.bytes, encryptedKey: result.encryptedKey, status: "not-in-database", attachment: null });
      log.warn("docs_backup.not_in_database", { sourceKey: object.key });
    }

    const summary = {
      databaseRows: rows.length,
      bucketObjects: objects.length,
      copied: 0,
      "already-backed-up": 0,
      "missing-in-bucket": 0,
      "checksum-mismatch": 0,
      "not-in-database": 0,
    } as DocumentsManifest["summary"];
    for (const entry of entries) summary[entry.status] += 1;

    const manifest: DocumentsManifest = {
      format: 1,
      kind: "documents",
      id,
      environment: config.environment,
      createdAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      source: source.label,
      summary,
      entries,
    };
    const manifestFile = path.join(runDir, "manifest.json");

    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await store.upload(docsManifestKey(id), manifestFile, "application/json");

    const problems = summary["missing-in-bucket"] + summary["checksum-mismatch"];

    log[problems > 0 ? "error" : "info"]("docs_backup.done", { id, ...summary });
    await writeState(config.stateDir, {
      ...state,
      ...(problems > 0 ? { lastFailureAt: now().toISOString(), lastFailure: `${problems} document problem(s)` } : { lastSuccessAt: now().toISOString() }),
      lastRunId: id,
      details: summary,
    });

    if (problems > 0) {
      await sendAlert(
        config.alertWebhookUrl,
        `[STSLV AMC ${config.environment}] DOCUMENT BACKUP PROBLEMS (${id}): ${summary["missing-in-bucket"]} file(s) missing from the bucket, ${summary["checksum-mismatch"]} checksum mismatch(es). Every other file is backed up.`,
        log,
        deps.fetchImpl
      );
    }
    await pingHeartbeat(config.heartbeatDocsUrl, problems === 0, log, deps.fetchImpl);

    return manifest;
  } catch (error) {
    const reason = describeFailure(error, log);

    log.error("docs_backup.failed", { id, reason });
    await writeState(config.stateDir, { ...state, lastFailureAt: now().toISOString(), lastFailure: reason, lastRunId: id }).catch(() => undefined);
    await sendAlert(config.alertWebhookUrl, `[STSLV AMC ${config.environment}] DOCUMENT BACKUP FAILED (${id}): ${reason}`, log, deps.fetchImpl);
    await pingHeartbeat(config.heartbeatDocsUrl, false, log, deps.fetchImpl);
    throw error;
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

/** The newest document backup run, by the time in its identifier (see run-id.ts). */
export async function latestDocumentsRun(store: ReadableStore): Promise<string> {
  const ids = (await store.list(`${DOCS_PREFIX}manifests/`))
    .map((object) => /^docs\/manifests\/(.+)\.json$/.exec(object.key)?.[1])
    .filter((id): id is string => typeof id === "string");
  const newest = newestFirst(RUN_PREFIX, ids)[0];

  if (!newest) throw new Error("There is no document backup manifest in the store.");

  return newest.id;
}

export interface DocsRestoreReport {
  runId: string;
  restored: number;
  skippedExisting: number;
  unavailable: number;
  failed: string[];
}

/**
 * Restores the files listed in a documents manifest into an ISOLATED destination (a folder, or a different
 * bucket). An existing file at the destination is never replaced. Each decrypted file is checked against the
 * manifest checksum before it is written. Needs the backup PRIVATE key.
 */
export async function restoreDocuments(input: {
  store: ReadableStore;
  runId: string;
  destination: WritableStore;
  /** The production document store, so it can never be the destination. */
  productionLabel?: string | null;
  gpg: GpgOptions;
  workDir: string;
  log: Logger;
  /** Only current versions (what the application shows), instead of every version. */
  currentOnly?: boolean;
}): Promise<DocsRestoreReport> {
  const { store, destination, log } = input;

  if (input.productionLabel && destination.label === input.productionLabel) throw new Error("The restore destination is the production document store. Refused.");

  const runId = input.runId === "latest" ? await latestDocumentsRun(store) : input.runId;
  const runDir = path.join(input.workDir, `docs-restore-${runId}`);

  await mkdir(runDir, { recursive: true, mode: 0o700 });

  try {
    const manifestFile = path.join(runDir, "manifest.json");
    await store.download(docsManifestKey(runId), manifestFile);
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as DocumentsManifest;

    if (manifest.kind !== "documents" || manifest.id !== runId) throw new Error("The manifest is not a documents manifest of this run.");

    const report: DocsRestoreReport = { runId, restored: 0, skippedExisting: 0, unavailable: 0, failed: [] };
    let counter = 0;

    for (const entry of manifest.entries) {
      if (input.currentOnly && entry.attachment && !entry.attachment.isCurrent) continue;
      if (!entry.encryptedKey) {
        report.unavailable += 1;
        continue;
      }
      if (await destination.head(entry.sourceKey)) {
        report.skippedExisting += 1;
        continue;
      }

      const encrypted = path.join(runDir, `r${counter}.gpg`);
      const plain = path.join(runDir, `r${counter}`);
      counter += 1;
      try {
        await store.download(entry.encryptedKey, encrypted);
        await decryptFile(input.gpg, encrypted, plain);
        if ((await sha256File(plain)) !== entry.sha256) throw new Error("checksum does not match the manifest");
        await destination.upload(entry.sourceKey, plain, entry.attachment?.mimeType);
        report.restored += 1;
      } catch (error) {
        report.failed.push(`${entry.sourceKey}: ${describeFailure(error, log)}`);
      } finally {
        await rm(encrypted, { force: true });
        await rm(plain, { force: true });
      }
    }

    log[report.failed.length > 0 ? "error" : "info"]("docs_restore.done", { ...report, failed: report.failed.length });

    return report;
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
