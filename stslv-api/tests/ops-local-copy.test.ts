import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readLocalCopySettings } from "../src/ops/backup/config";
import { configArchiveKey, configManifestKey, listConfigBackups } from "../src/ops/backup/config-backup";
import { dumpKey, kindMarkerKey, listDatabaseBackups, manifestKey } from "../src/ops/backup/db-backup";
import { localCopyAllowed, pruneLocalCopies, replicateBackup, runTypedStepWithLocalCopy, typedBackupKeys, uploadMissingBackups, type LocalCopySettings } from "../src/ops/backup/local-copy";
import { createLogger } from "../src/ops/backup/log";
import { readState } from "../src/ops/backup/notify";
import type { RecoveryKind } from "../src/ops/backup/retention";
import { newRunId } from "../src/ops/backup/run-id";
import { LocalDirStore, type WritableStore } from "../src/ops/backup/store";
import { sha256File } from "../src/ops/backup/tools";

// Encrypted copies on the VPS as well as in Google Drive (approved 2026-11-18). Temporary folders stand in for the
// VPS folder and the Drive folders; nothing touches a server, Drive or a database.

let root = "";
const lines: string[] = [];
const log = createLogger([], (line) => lines.push(line));
let counter = 0;
const freshDir = async (name: string) => {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "stslv-local-copy-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});
beforeEach(() => {
  lines.length = 0;
});

/** Writes a fake complete typed backup (data, type marker, manifest) into a store; returns its id. */
async function fakeBackup(store: WritableStore, step: "database" | "configuration", at: Date, kind: RecoveryKind = "daily"): Promise<string> {
  const id = newRunId(step === "database" ? "stslv-db" : "stslv-config", "test", at);
  const scratch = await freshDir("blob");
  for (const key of typedBackupKeys(step, id, kind)) {
    const file = path.join(scratch, path.basename(key));
    await writeFile(file, `${key} ${Math.random()}`);
    await store.upload(key, file);
  }
  return id;
}

/** Drive stand-in: one folder per recovery-point type, like STS-ELV Backup/Daily|Weekly|Monthly. */
async function fakeDrive() {
  const base = await freshDir("drive");
  const stores = new Map<RecoveryKind, WritableStore>();
  for (const kind of ["daily", "weekly", "monthly"] as const) stores.set(kind, new LocalDirStore(path.join(base, kind)));
  return { base, storeFor: async (kind: RecoveryKind) => stores.get(kind) as WritableStore, get: (kind: RecoveryKind) => stores.get(kind) as WritableStore };
}

async function localSettings(): Promise<LocalCopySettings> {
  const dir = await freshDir("vps-local");
  return { dir, store: new LocalDirStore(dir), retainDays: 7, minFreeBytes: 0 };
}

const configFor = async () => ({ stateDir: await freshDir("state"), workDir: await freshDir("work"), verifyDownload: true });

describe("a backup is made on the VPS first, then the SAME encrypted files go to Google Drive", () => {
  it("Drive available: the backup is complete on the VPS and byte-identical in the Drive folder of its type", async () => {
    const local = await localSettings();
    const drive = await fakeDrive();
    const at = new Date("2026-11-19T12:30:05Z");
    const { id } = await runTypedStepWithLocalCopy({
      step: "database",
      kind: "daily",
      job: "db-backup",
      local,
      config: await configFor(),
      log,
      makeLocal: async () => ({ id: await fakeBackup(local.store, "database", at) }),
      openRemote: drive.storeFor,
      pruneRemote: async () => [],
      now: () => at,
    });

    expect((await listDatabaseBackups(local.store)).map((b) => b.id)).toEqual([id]);
    expect((await listDatabaseBackups(drive.get("daily"))).map((b) => b.id)).toEqual([id]);
    for (const key of [dumpKey(id), kindMarkerKey(id, "daily"), manifestKey(id)]) {
      expect(await sha256File(path.join(drive.base, "daily", ...key.split("/")))).toBe(await sha256File(path.join(local.dir, ...key.split("/"))));
    }
    expect(await listDatabaseBackups(drive.get("weekly"))).toEqual([]);
  });

  it("Drive failure: the backup stays on the VPS, the step FAILS and says so, and the next run uploads it", async () => {
    const local = await localSettings();
    const drive = await fakeDrive();
    const config = await configFor();
    const first = new Date("2026-11-19T12:30:05Z");

    let firstId = "";
    await expect(
      runTypedStepWithLocalCopy({
        step: "database",
        kind: "daily",
        job: "db-backup",
        local,
        config,
        log,
        makeLocal: async () => ({ id: (firstId = await fakeBackup(local.store, "database", first)) }),
        openRemote: async () => {
          throw new Error("Google Drive authorization has expired or was revoked");
        },
        pruneRemote: async () => [],
        now: () => first,
      })
    ).rejects.toThrow(/stored on the VPS, but the Google Drive copy failed: Google Drive authorization has expired/);

    // On the VPS, complete; not in Drive; recorded as a failure (never as an off-site success).
    expect((await listDatabaseBackups(local.store)).map((b) => b.id)).toEqual([firstId]);
    expect(await listDatabaseBackups(drive.get("daily"))).toEqual([]);
    expect((await readState(config.stateDir, "db-backup")).lastFailure).toMatch(/Google Drive copy failed/);
    expect(lines.some((line) => line.includes('"offsite.failed"'))).toBe(true);

    // Next day Drive works again: yesterday's VPS backup is uploaded first, then today's.
    const second = new Date("2026-11-21T12:30:05Z");
    const { id: secondId } = await runTypedStepWithLocalCopy({
      step: "database",
      kind: "daily",
      job: "db-backup",
      local,
      config,
      log,
      makeLocal: async () => ({ id: await fakeBackup(local.store, "database", second) }),
      openRemote: drive.storeFor,
      pruneRemote: async () => [],
      now: () => second,
    });
    expect((await listDatabaseBackups(drive.get("daily"))).map((b) => b.id).sort()).toEqual([firstId, secondId].sort());
    expect(lines.some((line) => line.includes('"local_copy.uploaded_late"') && line.includes(firstId))).toBe(true);
  });

  it("an upload interrupted before the manifest leaves no listed (incomplete) backup in Drive; the VPS copy is complete", async () => {
    const local = await localSettings();
    const drive = await fakeDrive();
    const at = new Date("2026-11-19T12:30:05Z");
    const daily = drive.get("daily");
    const flaky: WritableStore = {
      label: daily.label,
      list: (prefix) => daily.list(prefix),
      head: (key) => daily.head(key),
      download: (key, file) => daily.download(key, file),
      remove: (key) => daily.remove(key),
      upload: async (key, file) => {
        if (key.endsWith(".manifest.json.gpg")) throw new Error("connection reset");
        return daily.upload(key, file);
      },
    };
    await expect(
      runTypedStepWithLocalCopy({
        step: "configuration",
        kind: "weekly",
        job: "config-backup",
        local,
        config: await configFor(),
        log,
        makeLocal: async () => ({ id: await fakeBackup(local.store, "configuration", at, "weekly") }),
        openRemote: async () => flaky,
        pruneRemote: async () => [],
        now: () => at,
      })
    ).rejects.toThrow(/stored on the VPS/);
    expect(await listConfigBackups(daily)).toEqual([]);
    expect(await listConfigBackups(local.store)).toHaveLength(1);
  });

  it("a promoted backup (weekly marker added on the VPS) is uploaded late into the Weekly folder, not Daily", async () => {
    const local = await localSettings();
    const drive = await fakeDrive();
    const id = await fakeBackup(local.store, "database", new Date("2026-11-20T12:30:05Z"));
    const marker = path.join(await freshDir("marker"), "m.json");
    await writeFile(marker, JSON.stringify({ id, kind: "weekly", promotedAt: "x" }));
    await local.store.upload(kindMarkerKey(id, "weekly"), marker);

    expect(await uploadMissingBackups({ local: local.store, storeFor: drive.storeFor, workDir: await freshDir("work"), verifyDownload: true, log })).toEqual([id]);
    expect((await listDatabaseBackups(drive.get("weekly"))).map((b) => [b.id, b.kind])).toEqual([[id, "weekly"]]);
    expect(await listDatabaseBackups(drive.get("daily"))).toEqual([]);
  });

  it("replicating twice changes nothing (an existing identical copy is accepted, never overwritten)", async () => {
    const local = await localSettings();
    const drive = await fakeDrive();
    const id = await fakeBackup(local.store, "database", new Date("2026-11-19T12:30:05Z"));
    const input = { step: "database" as const, id, kind: "daily" as const, from: local.store, to: drive.get("daily"), workDir: await freshDir("work"), verifyDownload: true };
    await replicateBackup(input);
    await replicateBackup(input);
    expect(await listDatabaseBackups(drive.get("daily"))).toHaveLength(1);
  });
});

describe("local retention: the latest 7 calendar days (IST), safely", () => {
  it("keeps the backups of the latest 7 IST days — daily, weekly and monthly alike — and removes older ones that are in Drive", async () => {
    const local = await localSettings();
    const drive = await fakeDrive();
    const ids: { id: string; day: string }[] = [];
    // One backup a day at 18:00 IST from 1 to 12 November; Fridays weekly, the last Friday monthly.
    for (let day = 1; day <= 12; day += 1) {
      const at = new Date(Date.UTC(2026, 10, day, 12, 30, 5));
      const kind: RecoveryKind = at.getUTCDay() === 5 ? "weekly" : "daily";
      const id = await fakeBackup(local.store, "database", at, kind);
      // The same backup in Drive: copy the local objects.
      await replicateBackup({ step: "database", id, kind, from: local.store, to: drive.get(kind), workDir: await freshDir("work"), verifyDownload: false });
      ids.push({ id, day: `2026-11-${String(day).padStart(2, "0")}` });
    }

    const removed = await pruneLocalCopies({
      local: local.store,
      retainDays: 7,
      now: new Date("2026-11-12T13:00:00Z"),
      log,
      confirmedOffsite: async (step, id, kind) => Boolean(await drive.get(kind).head(step === "database" ? manifestKey(id) : configManifestKey(id))),
    });

    const kept = (await listDatabaseBackups(local.store)).map((b) => b.id);
    expect(kept.sort()).toEqual(ids.filter((b) => b.day >= "2026-11-06").map((b) => b.id).sort());
    expect(removed.sort()).toEqual(ids.filter((b) => b.day < "2026-11-06").map((b) => b.id).sort());
    // Removed completely (manifest, markers and dump).
    const leftovers = (await local.store.list("db/")).filter((object) => removed.some((id) => object.key.includes(id)));
    expect(leftovers).toEqual([]);
  });

  it("never removes a backup that is not confirmed in Drive, nor anything when Drive cannot be asked, nor the newest one", async () => {
    const local = await localSettings();
    const old = await fakeBackup(local.store, "database", new Date("2026-10-01T12:30:05Z"));
    const older = await fakeBackup(local.store, "configuration", new Date("2026-09-01T12:30:05Z"), "weekly");
    const now = new Date("2026-11-19T13:00:00Z");

    expect(await pruneLocalCopies({ local: local.store, retainDays: 7, now, log, confirmedOffsite: async () => false })).toEqual([]);
    expect(
      await pruneLocalCopies({
        local: local.store,
        retainDays: 7,
        now,
        log,
        confirmedOffsite: async () => {
          throw new Error("rate limited");
        },
      })
    ).toEqual([]);
    // Each is the newest (only) backup of its kind: kept even when confirmed in Drive.
    expect(await pruneLocalCopies({ local: local.store, retainDays: 7, now, log, confirmedOffsite: async () => true })).toEqual([]);
    expect((await listDatabaseBackups(local.store)).map((b) => b.id)).toEqual([old]);
    expect((await listConfigBackups(local.store)).map((b) => b.id)).toEqual([older]);
  });

  it("only the local store's own folder is touched: the manual safety backups next to it are never removed", async () => {
    const parent = await freshDir("var-backups");
    const safety = path.join(parent, "stselv-safety", "stselv-amc_20261118T065421Z_POST-CLEANUP");
    await mkdir(safety, { recursive: true });
    await writeFile(path.join(safety, "stselv-amc_20261118T065421Z_POST-CLEANUP.tar.gpg"), "safety");
    const store = new LocalDirStore(path.join(parent, "local"));
    await fakeBackup(store, "database", new Date("2026-10-01T12:30:05Z"));
    await fakeBackup(store, "database", new Date("2026-11-19T12:30:05Z"));

    expect(await pruneLocalCopies({ local: store, retainDays: 7, now: new Date("2026-11-19T13:00:00Z"), log, confirmedOffsite: async () => true })).toHaveLength(1);
    expect(await readdir(safety)).toEqual(["stselv-amc_20261118T065421Z_POST-CLEANUP.tar.gpg"]);
    expect(await readFile(path.join(safety, "stselv-amc_20261118T065421Z_POST-CLEANUP.tar.gpg"), "utf8")).toBe("safety");
  });
});

describe("settings and disk space", () => {
  it("BACKUP_LOCAL_COPY_DIR: absolute, outside the work folder; 7 days and 5 GB minimum free by default; unset = Drive only", () => {
    expect(readLocalCopySettings({})).toBeNull();
    const settings = readLocalCopySettings({ BACKUP_LOCAL_COPY_DIR: path.join(root, "local"), BACKUP_WORK_DIR: path.join(root, "work") });
    expect(settings).toMatchObject({ retainDays: 7, minFreeBytes: 5 * 1024 ** 3 });
    expect(() => readLocalCopySettings({ BACKUP_LOCAL_COPY_DIR: "relative/local" })).toThrow(/absolute/);
    expect(() => readLocalCopySettings({ BACKUP_LOCAL_COPY_DIR: path.join(root, "work", "local"), BACKUP_WORK_DIR: path.join(root, "work") })).toThrow(/outside/);
    expect(() => readLocalCopySettings({ BACKUP_LOCAL_COPY_DIR: path.join(root, "x"), BACKUP_LOCAL_DIR: path.join(root, "x") })).toThrow(/must not be/);
    expect(readLocalCopySettings({ BACKUP_LOCAL_COPY_DIR: path.join(root, "local"), BACKUP_LOCAL_RETAIN_DAYS: "10" })?.retainDays).toBe(10);
  });

  it("below the minimum free space no local copy is made (logged as an error); above it, it is", async () => {
    const settings = await localSettings();
    const low = { ...settings, minFreeBytes: 5 * 1024 ** 3 };
    expect(await localCopyAllowed(low, log, async () => 1024 ** 3)).toBe(false);
    expect(lines.some((line) => line.includes('"local_copy.skipped_low_disk"') && line.includes('"level":"error"'))).toBe(true);
    expect(await localCopyAllowed(low, log, async () => 50 * 1024 ** 3)).toBe(true);
  });
});

// Keys used above, so a renamed key fails here first.
void configArchiveKey;
