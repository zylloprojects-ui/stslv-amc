import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDocumentSource, readBackupConfig } from "../src/ops/backup/config";
import { looksEncrypted } from "../src/ops/backup/config-backup";
import { docsManifestKey, restoreDocuments, runDocumentsBackup, type DocumentsManifest } from "../src/ops/backup/documents";
import { gpgPathArg } from "../src/ops/backup/gpg";
import { LocalAttachmentsSource } from "../src/ops/backup/local-documents";
import { createLogger } from "../src/ops/backup/log";
import { readState } from "../src/ops/backup/notify";
import { LocalDirStore, ObjectExistsError, type WritableStore } from "../src/ops/backup/store";
import { childEnv, runTool } from "../src/ops/backup/tools";
import { LocalDiskStorage } from "../src/shared/storage";

// Document backup from a LOCAL folder, as on the Hostinger VPS (ATTACHMENTS_DIR=/var/lib/stslv-amc/attachments,
// flat "<uuid>.<ext>" files written by the API's LocalDiskStorage). Temporary folders and a throwaway GnuPG key
// only; the attachments table is replaced by an in-memory inventory. Nothing touches a server or a real database.

let root = "";
let gnupgHome = "";
let fingerprint = "";
let gpgAvailable = false;
const lines: string[] = [];
const alerts: string[] = [];
const fetchImpl = async (url: string, init: { body?: string }) => {
  alerts.push(`${url} ${init.body ?? ""}`);
  return { ok: true, status: 200 };
};
const log = createLogger([], (line) => lines.push(line));
const SECRET = "OUTSIDE-SECRET-must-never-be-backed-up";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "stslv-localdocs-"));
  gnupgHome = path.join(root, "gnupg");
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
  const gpgEnv = childEnv({ GNUPGHOME: await gpgPathArg("gpg", gnupgHome) });
  const generated = await runTool("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "STSLV local docs test key <docs-test@example.invalid>", "default", "default", "never"], { env: gpgEnv, timeoutMs: 120_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const listed = await runTool("gpg", ["--batch", "--with-colons", "--list-keys"], { env: gpgEnv, timeoutMs: 30_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  fingerprint = /^fpr:+([0-9A-F]{40,64}):/m.exec(listed.stdout)?.[1] ?? "";
  gpgAvailable = generated.code === 0 && fingerprint !== "";
}, 180_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}, 60_000);

beforeEach(() => {
  lines.length = 0;
  alerts.length = 0;
});

let counter = 0;
async function setup() {
  counter += 1;
  const base = path.join(root, `case-${counter}`);
  const docs = path.join(base, "srv", "attachments");
  const outside = path.join(base, "srv", "outside");
  await mkdir(docs, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "api.env"), `JWT_SECRET=${SECRET}\n`);
  const work = path.join(base, "work");
  const state = path.join(base, "state");
  const offsite = path.join(base, "offsite");
  const config = readBackupConfig({
    NODE_ENV: "test",
    BACKUP_WORK_DIR: work,
    BACKUP_STATE_DIR: state,
    BACKUP_GPG_RECIPIENT: fingerprint || "A".repeat(40),
    GNUPGHOME: gnupgHome,
    BACKUP_ALERT_WEBHOOK_URL: "https://alerts.example.invalid/hook",
    BACKUP_HEARTBEAT_DOCS_URL: "https://heartbeat.example.invalid/docs",
  });
  return { base, docs, outside, work, state, offsite, config, store: new LocalDirStore(offsite), source: new LocalAttachmentsSource(docs) };
}

type Row = {
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
};
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
let rowId = 100;
/** Writes a document as the API does (flat "<uuid>.pdf") and returns its attachments row. */
async function addDocument(docs: string, content: string, extra: Partial<Row> = {}): Promise<Row> {
  const key = `${randomUUID()}.pdf`;
  await new LocalDiskStorage(docs).put(key, Buffer.from(content));
  rowId += 1;
  return {
    id: String(rowId),
    document_id: String(rowId),
    version: 1,
    is_current: true,
    entity_type: "amc_contracts",
    entity_id: "7",
    category: "SIGNED_CONTRACT",
    original_name: `contract-${rowId}.pdf`,
    mime_type: "application/pdf",
    size_bytes: String(Buffer.byteLength(content)),
    sha256: sha(content),
    storage_key: key,
    uploaded_at: new Date("2026-11-18T10:00:00Z"),
    ...extra,
  };
}

const run = (c: Awaited<ReturnType<typeof setup>>, rows: Row[], store: WritableStore = c.store) =>
  runDocumentsBackup({ config: c.config, source: c.source, store, inventory: async () => rows, log, fetchImpl });

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
}

async function trySymlink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link);
    return true;
  } catch {
    // Windows without the symlink privilege: a folder link can still be made as a junction (reported as a link);
    // file links are skipped there and run on Linux (GitHub CI, the VPS).
    try {
      await symlink(target, link, "junction");
      return true;
    } catch {
      return false;
    }
  }
}

describe("local document folder (VPS layout)", () => {
  it("an empty folder is a normal, successful backup with an empty manifest", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();

    const manifest = await run(c, []);

    expect(manifest.entries).toEqual([]);
    expect(manifest.summary).toMatchObject({ databaseRows: 0, bucketObjects: 0, copied: 0, "missing-in-bucket": 0 });
    expect(manifest.source).toContain("local folder");
    expect((await readState(c.state, "docs-backup")).lastSuccessAt).not.toBeNull();
    expect(alerts.filter((a) => a.includes("alerts.example.invalid"))).toEqual([]);
    expect(alerts.some((a) => a.startsWith("https://heartbeat.example.invalid/docs "))).toBe(true);
    expect(await readdir(c.work)).toEqual([]);
  });

  it("copies every document encrypted with its metadata, and restores them in the exact layout the API reads", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const first = await addDocument(c.docs, "%PDF-1.7 contract one");
    const second = await addDocument(c.docs, "%PDF-1.7 service report", { entity_type: "amc_visits", category: "SERVICE_REPORT", entity_id: "41" });
    const older = await addDocument(c.docs, "%PDF-1.7 contract one, version 1", { is_current: false, version: 1 });
    first.document_id = older.id;
    first.version = 2;

    const manifest = await run(c, [older, first, second]);

    expect(manifest.summary).toMatchObject({ databaseRows: 3, bucketObjects: 3, copied: 3, "missing-in-bucket": 0, "checksum-mismatch": 0, "not-in-database": 0 });
    const entry = manifest.entries.find((e) => e.attachment?.id === second.id);
    expect(entry).toMatchObject({
      sourceKey: `attachments/${second.storage_key}`,
      sha256: second.sha256,
      bytes: Number(second.size_bytes),
      status: "copied",
      attachment: { entityType: "amc_visits", entityId: "41", category: "SERVICE_REPORT", originalName: second.original_name, mimeType: "application/pdf", databaseSha256: second.sha256, isCurrent: true },
    });
    expect(manifest.entries.find((e) => e.attachment?.id === first.id)?.attachment).toMatchObject({ documentId: older.id, version: 2 });

    // Encrypted before it leaves the server: every stored document copy is OpenPGP, none holds plain text.
    for (const file of (await allFiles(c.offsite)).filter((f) => f.endsWith(".gpg"))) {
      const bytes = await readFile(file);
      expect(looksEncrypted(bytes)).toBe(true);
      expect(bytes.toString("latin1")).not.toContain("%PDF");
    }
    expect(await readdir(c.work)).toEqual([]);

    // Restore into an empty folder in the VPS layout: "<key>" files, readable by the API's own storage class.
    const target = path.join(c.base, "restored");
    const report = await restoreDocuments({ store: c.store, runId: manifest.id, destination: new LocalDirStore(target), gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: c.work, log, layout: "local-folder" });
    expect(report).toMatchObject({ restored: 3, failed: [], unavailable: 0 });
    expect((await readdir(target)).sort()).toEqual([first, second, older].map((r) => r.storage_key).sort());
    const api = new LocalDiskStorage(target);
    for (const row of [first, second, older]) expect(sha(await api.get(row.storage_key))).toBe(row.sha256);

    // Current versions only.
    const currentOnly = path.join(c.base, "restored-current");
    const current = await restoreDocuments({ store: c.store, runId: "latest", destination: new LocalDirStore(currentOnly), gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: c.work, log, layout: "local-folder", currentOnly: true });
    expect(current.restored).toBe(2);
  });

  it("a second run (or a duplicate) copies nothing again, never overwrites, and writes its own manifest", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const rows = [await addDocument(c.docs, "%PDF a"), await addDocument(c.docs, "%PDF b")];

    const first = await run(c, rows);
    const before = (await allFiles(path.join(c.offsite, "docs", "files"))).length;
    const second = await run(c, rows);

    expect(second.summary).toMatchObject({ copied: 0, "already-backed-up": 2 });
    expect((await allFiles(path.join(c.offsite, "docs", "files"))).length).toBe(before);
    expect(second.id).not.toBe(first.id);
    expect(await c.store.head(docsManifestKey(second.id))).not.toBeNull();
  });

  it("never backs up links, folders or unrelated files, and reports them", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const row = await addDocument(c.docs, "%PDF real");
    await writeFile(path.join(c.docs, "notes.txt"), "unrelated");
    await writeFile(path.join(c.docs, `.${randomUUID()}.pdf.tmp`), "temporary");
    await mkdir(path.join(c.docs, "nested"));
    await writeFile(path.join(c.docs, "nested", `${randomUUID()}.pdf`), "inside a sub-folder");
    const linked = await trySymlink(path.join(c.outside, "api.env"), path.join(c.docs, `${randomUUID()}.pdf`));
    const linkedDir = await trySymlink(c.outside, path.join(c.docs, "outside-link"));

    const manifest = await run(c, [row]);

    expect(manifest.summary).toMatchObject({ databaseRows: 1, bucketObjects: 1, copied: 1, "not-in-database": 0 });
    expect(manifest.summary.ignoredEntries).toBe(3 + (linked ? 1 : 0) + (linkedDir ? 1 : 0));
    expect(manifest.entries.map((e) => e.sourceKey)).toEqual([`attachments/${row.storage_key}`]);
    expect(lines.some((l) => l.includes("docs_backup.ignored_entries"))).toBe(true);
  });

  it("a database record pointing at a link, outside the folder, or at an invalid key is reported missing; nothing outside is read", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const good = await addDocument(c.docs, "%PDF good");
    const linkKey = `${randomUUID()}.pdf`;
    const linked = await trySymlink(path.join(c.outside, "api.env"), path.join(c.docs, linkKey));
    const rows = [
      good,
      { ...good, id: "901", storage_key: "../outside/api.env", sha256: sha("x") },
      { ...good, id: "902", storage_key: "..\\outside\\api.env", sha256: sha("x") },
      { ...good, id: "903", storage_key: "nested/../../outside/api.env", sha256: sha("x") },
      ...(linked ? [{ ...good, id: "904", storage_key: linkKey, sha256: sha("x") }] : []),
    ];

    const manifest = await run(c, rows);

    expect(manifest.summary.copied).toBe(1);
    expect(manifest.summary["missing-in-bucket"]).toBe(rows.length - 1);
    for (const file of await allFiles(c.offsite)) expect((await readFile(file)).toString("latin1")).not.toContain(SECRET);
    expect(alerts.some((a) => a.includes("DOCUMENT BACKUP PROBLEMS") && a.includes("missing from document storage"))).toBe(true);
  });

  it("the source itself refuses keys outside the application's own and offers nothing else", async () => {
    const c = await setup();
    const row = await addDocument(c.docs, "%PDF x");
    const tmp = path.join(c.base, "out.bin");

    for (const bad of ["attachments/../outside/api.env", "attachments/notes.txt", `docs/${row.storage_key}`, row.storage_key, "attachments/" + row.storage_key + "/x"]) {
      expect(await c.source.head(bad)).toBeNull();
      await expect(c.source.download(bad, tmp)).rejects.toThrow();
    }
    expect(await c.source.list("docs/")).toEqual([]);
    expect((await c.source.list("attachments/")).map((o) => o.key)).toEqual([`attachments/${row.storage_key}`]);
    // It cannot write or delete: there is no such method.
    expect("upload" in c.source || "remove" in c.source).toBe(false);
  });

  it("missing and altered files are reported, the rest is still backed up, the earlier version kept", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const kept = await addDocument(c.docs, "%PDF stays");
    const changed = await addDocument(c.docs, "%PDF original");
    const gone = await addDocument(c.docs, "%PDF will vanish");

    await run(c, [kept, changed, gone]);
    await writeFile(path.join(c.docs, changed.storage_key), "%PDF tampered");
    await rm(path.join(c.docs, gone.storage_key));

    const manifest = await run(c, [kept, changed, gone]);

    expect(manifest.summary).toMatchObject({ "already-backed-up": 1, "checksum-mismatch": 1, "missing-in-bucket": 1 });
    // Both versions of the altered file exist: the earlier copy was not overwritten.
    const copies = (await allFiles(path.join(c.offsite, "docs", "files"))).filter((f) => f.includes(changed.storage_key));
    expect(copies.length).toBe(2);
    expect((await readState(c.state, "docs-backup")).lastFailure).toMatch(/2 document problem/);
    expect(alerts.some((a) => a.startsWith("https://heartbeat.example.invalid/docs/fail"))).toBe(true);
  });

  it("a missing document folder fails loudly with an alert, never as an empty backup", async () => {
    const c = await setup();
    await rm(c.docs, { recursive: true });

    await expect(run(c, [])).rejects.toThrow(/does not exist \(ATTACHMENTS_DIR\)/);
    expect(alerts.some((a) => a.includes("DOCUMENT BACKUP FAILED"))).toBe(true);
    expect((await readState(c.state, "docs-backup")).lastFailure).toMatch(/does not exist/);
  });

  it("an upload failure fails the run without a manifest or plain files left; the next run completes", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const rows = [await addDocument(c.docs, "%PDF one"), await addDocument(c.docs, "%PDF two")];
    let uploads = 0;
    const flaky: WritableStore = {
      label: "flaky",
      list: (p) => c.store.list(p),
      head: (k) => c.store.head(k),
      download: (k, f) => c.store.download(k, f),
      remove: (k) => c.store.remove(k),
      upload: async (k, f) => {
        uploads += 1;
        if (uploads === 2) throw new Error("connection reset");
        return c.store.upload(k, f);
      },
    };

    await expect(run(c, rows, flaky)).rejects.toThrow(/connection reset/);
    expect(await c.store.list("docs/manifests/")).toEqual([]);
    expect(await readdir(c.work)).toEqual([]);
    expect(alerts.some((a) => a.includes("DOCUMENT BACKUP FAILED"))).toBe(true);

    const retry = await run(c, rows);
    expect(retry.summary.copied + retry.summary["already-backed-up"]).toBe(2);
    expect(await c.store.head(docsManifestKey(retry.id))).not.toBeNull();
  });

  it("removes the plain leftovers of an interrupted run before starting", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const abandoned = path.join(c.work, "stslv-docs-test-20261101T120000000Z-abcdef");
    await mkdir(abandoned, { recursive: true });
    await writeFile(path.join(abandoned, "f0"), "%PDF plain copy from a killed run");
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(abandoned, old, old);
    const unrelated = path.join(c.work, "keep-me");
    await mkdir(unrelated);

    await run(c, []);

    expect((await readdir(c.work)).sort()).toEqual(["keep-me"]);
    expect(lines.some((l) => l.includes("docs_backup.abandoned_run_removed"))).toBe(true);
  });

  it("refuses to restore over files already present (never replaces)", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const row = await addDocument(c.docs, "%PDF original");
    const manifest = await run(c, [row]);
    const target = path.join(c.base, "restore-existing");
    await mkdir(target);
    await writeFile(path.join(target, row.storage_key), "already here");

    const report = await restoreDocuments({ store: c.store, runId: manifest.id, destination: new LocalDirStore(target), gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: c.work, log, layout: "local-folder" });

    expect(report).toMatchObject({ restored: 0, skippedExisting: 1 });
    expect(await readFile(path.join(target, row.storage_key), "utf8")).toBe("already here");
    await expect(new LocalDirStore(target).upload(row.storage_key, path.join(target, row.storage_key))).rejects.toBeInstanceOf(ObjectExistsError);
  });

  it("the server configuration (ATTACHMENTS_DIR) selects the safe local source, read-only", async () => {
    const c = await setup();
    const source = openDocumentSource({ ATTACHMENTS_DIR: c.docs }, "production");

    expect(source).toBeInstanceOf(LocalAttachmentsSource);
    expect(source.label).toContain(path.resolve(c.docs));
    expect("upload" in source || "remove" in source).toBe(false);
  });
});

describe("documents manifest stays compatible", () => {
  it("keeps the bucket key layout, so bucket and local backups restore the same way", async (context) => {
    if (!gpgAvailable) context.skip();
    const c = await setup();
    const row = await addDocument(c.docs, "%PDF compat");
    const manifest: DocumentsManifest = await run(c, [row]);

    expect(manifest.format).toBe(1);
    expect(manifest.kind).toBe("documents");
    expect(manifest.entries[0]?.sourceKey).toBe(`attachments/${row.storage_key}`);
    expect(manifest.entries[0]?.encryptedKey).toBe(`docs/files/attachments/${row.storage_key}/${row.sha256}.gpg`);

    // The run manifest names every document: it is stored ENCRYPTED, so no file name or record detail is readable.
    const stored = await readFile(path.join(c.offsite, ...docsManifestKey(manifest.id).split("/")));
    expect(docsManifestKey(manifest.id).endsWith(".json.gpg")).toBe(true);
    expect(looksEncrypted(stored)).toBe(true);
    for (const secret of [row.original_name, row.storage_key, "SIGNED_CONTRACT", "amc_contracts"]) expect(stored.toString("latin1")).not.toContain(secret);

    // Default (bucket) layout restores "attachments/<key>", as before.
    const target = path.join(c.base, "bucket-layout");
    await restoreDocuments({ store: c.store, runId: manifest.id, destination: new LocalDirStore(target), gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: c.work, log });
    expect(await readdir(path.join(target, "attachments"))).toEqual([row.storage_key]);
  });
});
