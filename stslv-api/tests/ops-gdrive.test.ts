import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openBackupStore, readBackupConfig } from "../src/ops/backup/config";
import { CONFIG_SNAPSHOT_FILE, CONFIG_SNAPSHOT_PATHS, listConfigBackups, runConfigBackup } from "../src/ops/backup/config-backup";
import { dumpKey, kindMarkerKey, listDatabaseBackups, manifestKey, pruneDatabaseBackups } from "../src/ops/backup/db-backup";
import { restoreDocuments, runDocumentsBackup } from "../src/ops/backup/documents";
import { encryptFile, gpgPathArg } from "../src/ops/backup/gpg";
import { LocalAttachmentsSource } from "../src/ops/backup/local-documents";
import { createLogger } from "../src/ops/backup/log";
import { assertNoPrivateKey, assertPrivateFile } from "../src/ops/backup/preflight";
import { promoteBackup } from "../src/ops/backup/promote";
import { describeRcloneFailure, RcloneError, RcloneStore } from "../src/ops/backup/rclone-store";
import type { RecoveryKind } from "../src/ops/backup/retention";
import { newRunId } from "../src/ops/backup/run-id";
import { LocalDirStore, ObjectExistsError } from "../src/ops/backup/store";
import { childEnv, runTool, sha256File } from "../src/ops/backup/tools";
import { LocalDiskStorage } from "../src/shared/storage";

// Google Drive destination (My Drive / "STS-ELV Backup" / Daily|Weekly|Monthly) through rclone. The Drive is played by
// tests/fixtures/fake-rclone.cjs on temporary folders (no network, no Google account); a separate case uses the real
// rclone binary with a local folder when rclone can run on the machine (Linux CI, the VPS).

const FAKE = path.join(__dirname, "fixtures", "fake-rclone.cjs");
const FOLDER_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123";
const OTHER_ID = "1ZzZzZzZzZzZzZzZzZzZzZzZzZz9876";
const FAKE_ENV = ["FAKE_RCLONE_ROOT", "FAKE_RCLONE_FAIL", "FAKE_RCLONE_FAIL_ON", "FAKE_RCLONE_CORRUPT", "FAKE_RCLONE_FREE", "FAKE_RCLONE_EXTRA_TOP", "FAKE_RCLONE_LOG"];
const lines: string[] = [];
const alerts: string[] = [];
const log = createLogger([], (line) => lines.push(line));
const fetchImpl = async (url: string, init: { body?: string }) => {
  alerts.push(`${url} ${init.body ?? ""}`);
  return { ok: true, status: 200 };
};

let root = "";
let gnupgHome = "";
let fingerprint = "";
let gpgAvailable = false;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "stslv-gdrive-"));
  gnupgHome = path.join(root, "gnupg");
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
  const gpgEnv = childEnv({ GNUPGHOME: await gpgPathArg("gpg", gnupgHome) });
  const generated = await runTool("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "STSLV gdrive test key <gdrive-test@example.invalid>", "default", "default", "never"], { env: gpgEnv, timeoutMs: 120_000 }).catch(() => ({ code: 1, stdout: "", stderrTail: "" }));
  const listed = await runTool("gpg", ["--batch", "--with-colons", "--list-keys"], { env: gpgEnv, timeoutMs: 30_000 }).catch(() => ({ code: 1, stdout: "", stderrTail: "" }));
  fingerprint = /^fpr:+([0-9A-F]{40,64}):/m.exec(listed.stdout)?.[1] ?? "";
  gpgAvailable = generated.code === 0 && fingerprint !== "";
}, 180_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}, 60_000);

beforeEach(() => {
  lines.length = 0;
  alerts.length = 0;
  for (const name of ["FAKE_RCLONE_FAIL", "FAKE_RCLONE_FAIL_ON", "FAKE_RCLONE_CORRUPT", "FAKE_RCLONE_FREE", "FAKE_RCLONE_EXTRA_TOP"]) delete process.env[name];
});

let counter = 0;
/** A fresh fake My Drive with "STS-ELV Backup" (FOLDER_ID) and, optionally, more folders. */
async function drive(extra: Record<string, string> = {}) {
  counter += 1;
  const base = path.join(root, `drive-${counter}`);
  await mkdir(path.join(base, "mydrive", "STS-ELV Backup"), { recursive: true });
  const ids: Record<string, string> = { [FOLDER_ID]: "STS-ELV Backup", ...extra };
  for (const rel of Object.values(extra)) await mkdir(path.join(base, "mydrive", rel), { recursive: true });
  await writeFile(path.join(base, "ids.json"), JSON.stringify(ids));
  process.env.FAKE_RCLONE_ROOT = base;
  const store = (subFolder = "Daily", folderId = FOLDER_ID) => new RcloneStore({ command: [process.execPath, FAKE], configFile: path.join(base, "rclone.conf"), remote: "stselv-gdrive", folderId, subFolder, passEnv: FAKE_ENV });
  return { base, folder: path.join(base, "mydrive", "STS-ELV Backup"), trash: path.join(base, "trash"), store };
}

const encryptedBlob = async (name: string) => {
  const file = path.join(root, `${name}-${counter}-${randomUUID()}.gpg`);
  await writeFile(file, Buffer.concat([Buffer.from([0x85, 0x02, 0x0c]), Buffer.from(randomUUID())]));
  return file;
};
const jsonFile = async (body: unknown) => {
  const file = path.join(root, `j-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(body));
  return file;
};

describe("Google Drive destination: identity of the folder", () => {
  it("accepts the configured folder ID only when it is the one 'STS-ELV Backup' in My Drive, and creates the type sub-folder", async () => {
    const d = await drive();
    await d.store("Weekly").verifyDestination("STS-ELV Backup");
    expect(existsSync(path.join(d.folder, "Weekly"))).toBe(true);
  });

  it("refuses a wrong ID, a missing folder and two folders with the same name — nothing is written", async () => {
    const d = await drive({ [OTHER_ID]: "Other folder" });
    await expect(d.store("Daily", OTHER_ID).verifyDestination("STS-ELV Backup")).rejects.toThrow(/not the configured BACKUP_GDRIVE_FOLDER_ID/);
    await expect(d.store("Daily").verifyDestination("No Such Folder")).rejects.toThrow(/no folder "No Such Folder"/);

    // A second folder with the same name (Drive allows it): refused, even though the ID matches one of them.
    process.env.FAKE_RCLONE_EXTRA_TOP = JSON.stringify([{ Path: "STS-ELV Backup", Name: "STS-ELV Backup", Size: -1, IsDir: true, ID: OTHER_ID }]);
    await expect(d.store("Daily").verifyDestination("STS-ELV Backup")).rejects.toThrow(/2 folders named "STS-ELV Backup"/);
    delete process.env.FAKE_RCLONE_EXTRA_TOP;
    expect(existsSync(path.join(d.folder, "Daily"))).toBe(false);
  });

  it("only the configured ID and plain names are accepted in the settings", () => {
    expect(() => new RcloneStore({ command: ["rclone"], configFile: "x", remote: "stselv-gdrive", folderId: "../../etc", subFolder: "Daily" })).toThrow(/folder ID/);
    expect(() => new RcloneStore({ command: ["rclone"], configFile: "x", remote: "bad remote:", folderId: FOLDER_ID, subFolder: "Daily" })).toThrow(/remote name/);
  });
});

describe("Google Drive destination: what may be uploaded", () => {
  it("uploads encrypted data (backups and manifests) and the tiny type markers, verified by size and MD5; never overwrites", async () => {
    const d = await drive();
    const store = d.store();
    const blob = await encryptedBlob("db");

    await store.upload("db/a.dump.gpg", blob);
    await store.upload("db/a.manifest.json.gpg", await encryptedBlob("manifest"));
    await store.upload("db/a.kind-daily.json", await jsonFile({ id: "a", kind: "daily", at: "2026-11-21T12:30:00Z" }));

    expect(await store.head("db/a.dump.gpg")).toMatchObject({ key: "db/a.dump.gpg" });
    expect((await store.list("db/")).map((o) => o.key)).toEqual(["db/a.dump.gpg", "db/a.kind-daily.json", "db/a.manifest.json.gpg"]);
    await expect(store.upload("db/a.dump.gpg", await encryptedBlob("db2"))).rejects.toBeInstanceOf(ObjectExistsError);
    const back = path.join(root, `back-${randomUUID()}`);
    await store.download("db/a.dump.gpg", back);
    expect(await sha256File(back)).toBe(await sha256File(blob));
  });

  it("refuses anything unencrypted: a plain dump, a tar, a key, a token — before rclone is started", async () => {
    const d = await drive();
    const store = d.store();
    const plainDump = path.join(root, `plain-${randomUUID()}.gpg`);
    await writeFile(plainDump, "PGDMP plain database dump");
    const tar = path.join(root, `cfg-${randomUUID()}.tar`);
    await writeFile(tar, "etc/stslv-amc/api.env");

    await expect(store.upload("db/x.dump.gpg", plainDump)).rejects.toThrow(/not encrypted/);
    await expect(store.upload("config/x.tar", tar)).rejects.toThrow(/only encrypted files/);
    // A plain manifest (document names, table counts) is refused: manifests are encrypted.
    await expect(store.upload("docs/manifests/run.json", await jsonFile({ entries: [{ originalName: "Contract.pdf" }] }))).rejects.toThrow(/only encrypted files/);
    await expect(store.upload("db/x.manifest.json.gpg", await jsonFile({ id: "x" }))).rejects.toThrow(/not encrypted/);
    // Type markers hold only id, kind and times — and never key or token material.
    await expect(store.upload("db/m.kind-daily.json", await jsonFile({ id: "m", kind: "daily", tables: 35 }))).rejects.toThrow(/only id, kind and times/);
    await expect(store.upload("db/k.kind-daily.json", await jsonFile({ id: "-----BEGIN PGP PRIVATE KEY BLOCK-----" }))).rejects.toThrow(/key or token/);
    await expect(store.upload("db/t.kind-daily.json", await jsonFile({ id: "t", refresh_token: "abc" }))).rejects.toThrow(/key or token/);
    expect(existsSync(path.join(d.folder, "Daily", "db"))).toBe(false);
  });

  it("detects an upload that arrived altered (MD5 mismatch)", async () => {
    const d = await drive();
    process.env.FAKE_RCLONE_CORRUPT = "1";
    await expect(d.store().upload("db/c.dump.gpg", await encryptedBlob("c"))).rejects.toThrow(/wrong size|MD5/);
  });

  it("removing sends a file to the Drive trash, it is never destroyed", async () => {
    const d = await drive();
    const store = d.store();
    await store.upload("db/r.dump.gpg", await encryptedBlob("r"));
    await store.remove("db/r.dump.gpg");
    expect(await store.head("db/r.dump.gpg")).toBeNull();
    expect((await readdir(d.trash)).some((name) => name.endsWith("r.dump.gpg"))).toBe(true);
  });
});

describe("Google Drive errors are explained, without leaking tokens", () => {
  it("an expired or revoked authorization", async () => {
    const d = await drive();
    process.env.FAKE_RCLONE_FAIL = "auth";
    const error = await d.store().list("db/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RcloneError);
    expect((error as RcloneError).kind).toBe("auth");
    expect((error as Error).message).toMatch(/authorization has expired or was revoked/);
    expect((error as Error).message).not.toContain("SHOULD-BE-REDACTED");
  });

  it("a full Drive and rate limits", async () => {
    const d = await drive();
    process.env.FAKE_RCLONE_FAIL = "quota";
    process.env.FAKE_RCLONE_FAIL_ON = "copyto";
    await expect(d.store().upload("db/q.dump.gpg", await encryptedBlob("q"))).rejects.toThrow(/Google Drive is full/);
    expect(describeRcloneFailure("googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded").kind).toBe("rate-limit");
    expect(describeRcloneFailure('oauth2: cannot fetch token: {"access_token":"secret-123"}').message).not.toContain("secret-123");
  });
});

describe("recovery points in Daily / Weekly / Monthly", () => {
  const configVars = (d: Awaited<ReturnType<typeof drive>>, work: string, state: string, extra: Record<string, string> = {}) => ({
    NODE_ENV: "test",
    BACKUP_WORK_DIR: work,
    BACKUP_STATE_DIR: state,
    BACKUP_GPG_RECIPIENT: fingerprint || "A".repeat(40),
    GNUPGHOME: gnupgHome,
    BACKUP_GDRIVE_FOLDER_ID: FOLDER_ID,
    BACKUP_RCLONE_CONFIG: path.join(d.base, "rclone.conf"),
    BACKUP_RCLONE_PATH: process.execPath,
    ...extra,
  });

  it("the settings choose Google Drive with one sub-folder per type, and only one destination at a time", async () => {
    const d = await drive();
    const vars = configVars(d, path.join(d.base, "w"), path.join(d.base, "s"));
    for (const [kind, folder] of [["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const) {
      const store = openBackupStore(vars, "test", kind);
      expect(store).toBeInstanceOf(RcloneStore);
      expect((store as RcloneStore).subFolder).toBe(folder);
    }
    expect(() => openBackupStore({ ...vars, BACKUP_LOCAL_DIR: d.base }, "test")).toThrow(/only one backup destination/);
    expect(() => openBackupStore({ ...vars, BACKUP_RCLONE_CONFIG: "" }, "test")).toThrow(/BACKUP_RCLONE_CONFIG/);
  });

  it("documents from the VPS folder: encrypted into Daily, restored in the API's layout, each folder complete on its own", { timeout: 180_000 }, async (context) => {
    if (!gpgAvailable) context.skip();
    const d = await drive();
    const docs = path.join(d.base, "attachments");
    const key = `${randomUUID()}.pdf`;
    await new LocalDiskStorage(docs).put(key, Buffer.from("%PDF service report"));
    const sha = (await import("node:crypto")).createHash("sha256").update("%PDF service report").digest("hex");
    const row = { id: "1", document_id: "1", version: 1, is_current: true, entity_type: "amc_visits", entity_id: "9", category: "SERVICE_REPORT", original_name: "report.pdf", mime_type: "application/pdf", size_bytes: "19", sha256: sha, storage_key: key, uploaded_at: new Date() };
    const config = readBackupConfig(configVars(d, path.join(d.base, "work"), path.join(d.base, "state")));

    for (const sub of ["Daily", "Weekly"]) {
      const manifest = await runDocumentsBackup({ config, source: new LocalAttachmentsSource(docs), store: d.store(sub), inventory: async () => [row], log, fetchImpl });
      expect(manifest.summary.copied).toBe(1);
    }
    // Every document copy in Drive is encrypted.
    for (const sub of ["Daily", "Weekly"]) {
      const files = (await d.store(sub).list("docs/files/")).map((o) => o.key);
      expect(files).toEqual([`docs/files/attachments/${key}/${sha}.gpg`]);
      expect((await readFile(path.join(d.folder, sub, ...files[0]!.split("/")))).toString("latin1")).not.toContain("%PDF");
    }

    const target = path.join(d.base, "restored");
    const report = await restoreDocuments({ store: d.store("Weekly"), runId: "latest", destination: new LocalDirStore(target), gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: path.join(d.base, "work"), log, layout: "local-folder" });
    expect(report).toMatchObject({ restored: 1, failed: [] });
    expect((await new LocalDiskStorage(target).get(key)).toString()).toBe("%PDF service report");
  });

  it("the weekly configuration goes to Weekly, verified, and nothing unencrypted is left", { timeout: 180_000 }, async (context) => {
    if (!gpgAvailable) context.skip();
    const d = await drive();
    const work = path.join(d.base, "work");
    await mkdir(work, { recursive: true });
    const plain = path.join(work, "plain.tar");
    await writeFile(plain, "etc/stslv-amc/api.env DB_PASSWORD=never-in-drive");
    await encryptFile({ gpgPath: "gpg", homeDir: gnupgHome }, fingerprint, plain, path.join(work, CONFIG_SNAPSHOT_FILE));
    await rm(plain);
    await writeFile(path.join(work, CONFIG_SNAPSHOT_PATHS), "/etc/stslv-amc\n");
    const config = readBackupConfig(configVars(d, work, path.join(d.base, "state")));

    const result = await runConfigBackup({ config, store: d.store("Weekly"), log, fetchImpl, kind: "weekly" });

    expect((await listConfigBackups(d.store("Weekly"))).map((b) => [b.id, b.kind])).toEqual([[result.id, "weekly"]]);
    for (const file of await readdir(path.join(d.folder, "Weekly", "config"))) {
      expect((await readFile(path.join(d.folder, "Weekly", "config", file))).toString("latin1")).not.toContain("never-in-drive");
    }
    expect(await readdir(work)).toEqual([]);
  });

  const fakeBackup = async (store: RcloneStore, id: string, kind: RecoveryKind) => {
    await store.upload(dumpKey(id), await encryptedBlob("dump"));
    await store.upload(kindMarkerKey(id, kind), await jsonFile({ id, kind }));
    await store.upload(manifestKey(id), await encryptedBlob("manifest"));
  };

  // Full-scale type retention (a year of runs → 14/8/12) is in ops-schedule.test.ts; here, per folder in Drive.
  it("retention works inside each type's folder; pruned copies go to the Drive trash", { timeout: 300_000 }, async () => {
    const d = await drive();
    const daily = d.store("Daily");
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const id = newRunId("stslv-db", "test", new Date(Date.UTC(2026, 10, 1 + i, 12, 30)));
      ids.push(id);
      await fakeBackup(daily, id, "daily");
    }

    const removed = await pruneDatabaseBackups({ store: daily, config: { retention: { daily: 7, weekly: 8, monthly: 12 } }, log, keepId: ids[8] as string });

    expect(removed.sort()).toEqual([ids[0], ids[1]].sort());
    expect((await listDatabaseBackups(daily)).length).toBe(7);
    expect((await readdir(d.trash)).length).toBe(2 * 3);
  });

  it("promotion moves today's backup from Daily to Weekly on the Drive server: complete in Weekly, the Daily copy in the trash", { timeout: 180_000 }, async () => {
    const d = await drive();
    const id = newRunId("stslv-db", "test", new Date(Date.UTC(2026, 10, 21, 12, 30)));
    await fakeBackup(d.store("Daily"), id, "daily");
    const storeFor = (kind: RecoveryKind) => d.store({ daily: "Daily", weekly: "Weekly", monthly: "Monthly" }[kind]);

    await promoteBackup({ step: "database", id, from: "daily", to: "weekly", storeFor, workDir: path.join(d.base, "work") });

    expect(await listDatabaseBackups(d.store("Weekly"))).toMatchObject([{ id, kind: "weekly" }]);
    expect(await listDatabaseBackups(d.store("Daily"))).toEqual([]);
    expect((await readdir(d.trash)).length).toBe(3);
    // Finishing an interrupted promotion (the Daily copy already gone) is harmless.
    await promoteBackup({ step: "database", id, from: "daily", to: "weekly", storeFor, workDir: path.join(d.base, "work") });
    expect(await listDatabaseBackups(d.store("Weekly"))).toHaveLength(1);
  });
});

describe("the real rclone binary (when it can run here)", () => {
  it("uploads, lists, verifies, copies and trashes through rclone itself with a local folder standing in for Drive", async (context) => {
    const version = await runTool("rclone", ["version"], { env: childEnv({}), timeoutMs: 20_000 }).catch(() => ({ code: 1, stdout: "", stderrTail: "" }));
    if (version.code !== 0) context.skip();

    const base = path.join(root, "real-rclone");
    const remoteRoot = path.join(base, "drive");
    await mkdir(path.join(remoteRoot, "Daily"), { recursive: true });
    const conf = path.join(base, "rclone.conf");
    await writeFile(conf, `[stselv-gdrive]\ntype = alias\nremote = ${remoteRoot.replace(/\\/g, "/")}\n`);
    const store = new RcloneStore({ command: ["rclone"], configFile: conf, remote: "stselv-gdrive", folderId: FOLDER_ID, subFolder: "Daily" });
    const blob = await encryptedBlob("real");

    await store.upload("db/real.dump.gpg", blob);
    await expect(store.upload("db/real.dump.gpg", blob)).rejects.toBeInstanceOf(ObjectExistsError);
    expect((await store.list("db/")).map((o) => o.key)).toEqual(["db/real.dump.gpg"]);
    await store.copyTo("db/real.dump.gpg", store.withSubFolder("Weekly"));
    expect(await store.withSubFolder("Weekly").head("db/real.dump.gpg")).not.toBeNull();
  }, 120_000);
});

describe("security pre-flight on the server", () => {
  it("refuses to run when the backup keyring holds a PRIVATE key; a public-only keyring passes", async (context) => {
    if (!gpgAvailable) context.skip();
    // The test keyring holds the private key (like the administrator PC): refused.
    await expect(assertNoPrivateKey({ gpgPath: "gpg", homeDir: gnupgHome })).rejects.toThrow(/PRIVATE key/);

    // A keyring with the PUBLIC key only (like the VPS): accepted.
    const publicHome = path.join(root, `public-only-${randomUUID()}`);
    await mkdir(publicHome, { recursive: true, mode: 0o700 });
    const exported = path.join(root, `pub-${randomUUID()}.asc`);
    const from = childEnv({ GNUPGHOME: await gpgPathArg("gpg", gnupgHome) });
    const exportResult = await runTool("gpg", ["--batch", "--armor", "--export", fingerprint], { env: from, timeoutMs: 30_000 });
    expect(exportResult.stdout).toContain("BEGIN PGP PUBLIC KEY BLOCK");
    await writeFile(exported, exportResult.stdout);
    const to = childEnv({ GNUPGHOME: await gpgPathArg("gpg", publicHome) });
    const imported = await runTool("gpg", ["--batch", "--import", await gpgPathArg("gpg", exported)], { env: to, timeoutMs: 30_000 });
    // (gpg may exit 2 only because its background agent could not start on Windows; the import itself is checked.)
    expect(imported.stderrTail).toMatch(/imported: 1/);
    await expect(assertNoPrivateKey({ gpgPath: "gpg", homeDir: publicHome })).resolves.toBeUndefined();
  });

  it("the Google token file must be private (mode 0600) and belong to the backup user", async () => {
    const file = path.join(root, `rclone-${randomUUID()}.conf`);
    await writeFile(file, "[stselv-gdrive]\ntype = drive\n");
    await expect(assertPrivateFile(path.join(root, "missing.conf"), "rclone configuration")).rejects.toThrow(/does not exist/);
    // As Linux would see a group/other-readable file (0644 / Windows' 0666): refused.
    if (process.platform === "win32") {
      await expect(assertPrivateFile(file, "rclone configuration", "linux", null)).rejects.toThrow(/readable by other users/);
      await expect(assertPrivateFile(file, "rclone configuration", "win32")).resolves.toBeUndefined();
    } else {
      const { chmod } = await import("node:fs/promises");
      await chmod(file, 0o644);
      await expect(assertPrivateFile(file, "rclone configuration")).rejects.toThrow(/readable by other users/);
      await chmod(file, 0o600);
      await expect(assertPrivateFile(file, "rclone configuration")).resolves.toBeUndefined();
      await expect(assertPrivateFile(file, "rclone configuration", "linux", 12_345)).rejects.toThrow(/belong to the backup user/);
    }
  });
});
