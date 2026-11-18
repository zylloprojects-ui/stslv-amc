import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readBackupConfig } from "../src/ops/backup/config";
import { CONFIG_SNAPSHOT_FILE, CONFIG_SNAPSHOT_PATHS, configArchiveKey, configManifestKey, listConfigBackups, looksEncrypted, restoreConfigBackup, runConfigBackup, type ConfigManifest } from "../src/ops/backup/config-backup";
import { readEncryptedJson } from "../src/ops/backup/manifest-crypto";
import { encryptFile, gpgPathArg } from "../src/ops/backup/gpg";
import { createLogger } from "../src/ops/backup/log";
import { readState } from "../src/ops/backup/notify";
import { newRunId } from "../src/ops/backup/run-id";
import { runScheduledBackup, type StepRunner } from "../src/ops/backup/scheduled";
import {
  acquireBackupLock,
  backupDay,
  BackupLockedError,
  isLastFridayOfMonth,
  nextScheduledRuns,
  planRun,
  readScheduleState,
  recordStepDone,
  scheduledKind,
  scheduleSlot,
  STEPS,
  type BackupStep,
} from "../src/ops/backup/schedule";
import { LocalDirStore } from "../src/ops/backup/store";
import { dumpKey, kindMarkerKey, listDatabaseBackups, manifestKey, promoteDatabaseBackup, pruneDatabaseBackups } from "../src/ops/backup/db-backup";
import { selectByKind } from "../src/ops/backup/retention";
import { childEnv, runTool, sha256File } from "../src/ops/backup/tools";

// The backup schedule approved on 2026-11-18: every day except Friday at 18:00 IST a daily backup (database +
// documents); every Friday at 18:00 IST only the weekly full backup (database + documents + configuration).
// Never two backups at once, never the same step twice in a day. Disposable temporary folders and a throwaway
// GnuPG key only; nothing touches a server, a bucket or a real database.

const REPO = path.resolve(__dirname, "..", "..");
const SYSTEMD = path.join(REPO, "deploy", "hostinger", "systemd");

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
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "stslv-schedule-"));
  gnupgHome = path.join(root, "gnupg");
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });
  const gpgEnv = childEnv({ GNUPGHOME: await gpgPathArg("gpg", gnupgHome) });
  const generated = await runTool("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "STSLV schedule test key <schedule-test@example.invalid>", "default", "default", "never"], { env: gpgEnv, timeoutMs: 120_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
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
const freshDir = async (name: string) => {
  counter += 1;
  const dir = path.join(root, `${name}-${counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

describe("the schedule: 18:00 IST — daily Saturday–Thursday, weekly on Fridays, monthly on the last Friday", () => {
  it("dates each instant in IST, whatever the server's time zone", () => {
    // Thursday 23:59:59 IST and Friday 00:00:00 IST.
    expect(backupDay(at("2026-11-19T18:29:59Z"))).toMatchObject({ date: "2026-11-19", weekday: 4 });
    expect(backupDay(at("2026-11-19T18:30:00Z"))).toMatchObject({ date: "2026-11-20", weekday: 5 });
    expect(scheduledKind(at("2026-11-20T12:30:00Z"))).toBe("weekly");
    expect(scheduledKind(at("2026-11-21T12:30:00Z"))).toBe("daily");
  });

  it("runs exactly once a day at 18:00 IST (12:30 UTC); the last Friday of the month is the monthly backup", () => {
    const runs = nextScheduledRuns(at("2026-11-16T00:00:00Z"), 14);

    expect(runs.map((run) => run.at.toISOString().slice(11))).toEqual(Array(14).fill("12:30:00.000Z"));
    expect(new Set(runs.map((run) => run.day)).size).toBe(14);
    expect(runs.map((run) => `${run.day} ${run.kind}`)).toEqual([
      "2026-11-16 daily", "2026-11-17 daily", "2026-11-18 daily", "2026-11-19 daily", "2026-11-20 weekly",
      "2026-11-21 daily", "2026-11-22 daily", "2026-11-23 daily", "2026-11-24 daily", "2026-11-25 daily",
      // 27 November 2026 is the last Friday of November.
      "2026-11-26 daily", "2026-11-27 monthly", "2026-11-28 daily", "2026-11-29 daily",
    ]);
    // A run starting exactly now is not "next".
    expect(nextScheduledRuns(at("2026-11-20T12:30:00Z"), 1)[0]?.day).toBe("2026-11-21");
  });

  const fridaysOf = (year: number, month: number) => {
    const out: string[] = [];
    for (let day = 1; day <= 31; day += 1) {
      const date = new Date(Date.UTC(year, month - 1, day, 12, 30));
      if (date.getUTCMonth() !== month - 1) break;
      if (date.getUTCDay() === 5) out.push(`${date.toISOString().slice(0, 10)} ${scheduledKind(date)}`);
    }
    return out;
  };

  it("a 5-Friday month: four weekly backups, the fifth Friday is the monthly one (January 2027)", () => {
    expect(fridaysOf(2027, 1)).toEqual(["2027-01-01 weekly", "2027-01-08 weekly", "2027-01-15 weekly", "2027-01-22 weekly", "2027-01-29 monthly"]);
    expect(isLastFridayOfMonth(at("2027-01-29T12:30:00Z"))).toBe(true);
  });

  it("a 4-Friday month: three weekly backups, the fourth is the monthly one (February 2027)", () => {
    expect(fridaysOf(2027, 2)).toEqual(["2027-02-05 weekly", "2027-02-12 weekly", "2027-02-19 weekly", "2027-02-26 monthly"]);
  });

  it("a month that ends on a Friday, and the turn of the year", () => {
    // 30 April 2027 is both the last day and the last Friday of April.
    expect(scheduledKind(at("2027-04-30T12:30:00Z"))).toBe("monthly");
    expect(scheduledKind(at("2027-04-23T12:30:00Z"))).toBe("weekly");
    // December 2026: Friday 25th is the monthly backup; Friday 1 January 2027 is an ordinary weekly one.
    expect(fridaysOf(2026, 12)).toEqual(["2026-12-04 weekly", "2026-12-11 weekly", "2026-12-18 weekly", "2026-12-25 monthly"]);
    const turn = nextScheduledRuns(at("2026-12-24T13:00:00Z"), 9).map((run) => `${run.day} ${run.kind}`);
    expect(turn).toEqual([
      "2026-12-25 monthly", "2026-12-26 daily", "2026-12-27 daily", "2026-12-28 daily", "2026-12-29 daily",
      "2026-12-30 daily", "2026-12-31 daily", "2027-01-01 weekly", "2027-01-02 daily",
    ]);
  });

  it("the IST date decides, not the UTC date", () => {
    // Friday 29 January 2027, 23:59:59 IST, is still the last Friday; one second later it is Saturday.
    expect(scheduledKind(at("2027-01-29T18:29:59Z"))).toBe("monthly");
    expect(scheduledKind(at("2027-01-29T18:30:00Z"))).toBe("daily");
    // 20:00 UTC on Friday 30 April 2027 is already Saturday 1 May in India.
    expect(scheduledKind(at("2027-04-30T20:00:00Z"))).toBe("daily");
  });

  it("a whole year (2027): one backup per day — 12 monthly, 41 weekly, 312 daily", () => {
    const runs = nextScheduledRuns(at("2026-12-31T13:00:00Z"), 365);
    const count = (kind: string) => runs.filter((run) => run.kind === kind).length;

    expect(runs[0]?.day).toBe("2027-01-01");
    expect(runs.at(-1)?.day).toBe("2027-12-31");
    expect(new Set(runs.map((run) => run.day)).size).toBe(365);
    expect([count("monthly"), count("weekly"), count("daily")]).toEqual([12, 41, 312]);
    // Exactly one monthly backup in each month, on that month's last Friday.
    const monthly = runs.filter((run) => run.kind === "monthly").map((run) => run.day);
    expect(monthly.map((day) => day.slice(5, 7))).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
    for (const day of monthly) expect(Number(day.slice(8)) + 7).toBeGreaterThan(new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate());
  });

  it("weekly and monthly backups cover everything the daily backup does, plus the configuration", () => {
    expect(STEPS.daily).toEqual(["database", "documents"]);
    expect(STEPS.weekly).toEqual(["database", "documents", "configuration"]);
    expect(STEPS.monthly).toEqual(["database", "documents", "configuration"]);
  });
});

describe("what a started job does", () => {
  const friday = at("2026-11-20T12:30:00Z");
  const lastFriday = at("2026-11-27T12:30:00Z");
  const saturday = at("2026-11-21T12:30:00Z");
  const empty = { days: {} };

  it("a daily job does nothing on a Friday; the Friday job is weekly, or monthly on the last Friday", () => {
    expect(planRun("daily", friday, empty)).toEqual({ action: "skip", day: "2026-11-20", kind: "daily", reason: "friday-full-backup-only" });
    expect(planRun("weekly", friday, empty)).toEqual({ action: "run", day: "2026-11-20", kind: "weekly", steps: ["database", "documents", "configuration"], promote: [] });
    expect(planRun("weekly", lastFriday, empty)).toEqual({ action: "run", day: "2026-11-27", kind: "monthly", steps: ["database", "documents", "configuration"], promote: [] });
    expect(planRun("daily", lastFriday, empty)).toMatchObject({ action: "skip", reason: "friday-full-backup-only" });
    expect(planRun("daily", saturday, empty)).toEqual({ action: "run", day: "2026-11-21", kind: "daily", steps: ["database", "documents"], promote: [] });
  });

  it("a Friday job caught up on another day keeps the type of the Friday it stands for", () => {
    // Server off over the last Friday of November: the catch-up on Saturday 28th (08:30 IST, before that day's
    // 18:00 slot) is still the monthly backup, recorded for Friday 27th's slot.
    expect(planRun("weekly", at("2026-11-28T03:00:00Z"), empty)).toMatchObject({ action: "run", kind: "monthly", day: "2026-11-27" });
    // Missed the ordinary Friday 20th: caught up on Sunday 22nd as the weekly backup.
    expect(planRun("weekly", at("2026-11-22T03:00:00Z"), empty)).toMatchObject({ kind: "weekly" });
  });

  it("never repeats a step already done that day; a higher type promotes the earlier backups instead", () => {
    const afterDaily = { days: { "2026-11-21": { completed: ["database", "documents"] as BackupStep[], kind: "daily" as const, ids: { database: "stslv-db-test-x" }, updatedAt: "" } } };
    expect(planRun("daily", saturday, afterDaily)).toMatchObject({ action: "skip", reason: "already-done" });
    // A weekly catch-up on the same day: no second database backup — today's is promoted to weekly (moved to the
    // Weekly folder in Google Drive); the documents are copied into the weekly set so that it is complete on its
    // own, and the configuration is added.
    expect(planRun("weekly", saturday, afterDaily)).toMatchObject({ action: "run", kind: "weekly", steps: ["documents", "configuration"], promote: [{ step: "database", id: "stslv-db-test-x", from: "daily" }] });

    const afterWeekly = { days: { "2026-11-20": { completed: ["database", "documents", "configuration"] as BackupStep[], kind: "weekly" as const, ids: { database: "db-1", configuration: "cfg-1" }, updatedAt: "" } } };
    expect(planRun("weekly", friday, afterWeekly)).toMatchObject({ action: "skip", reason: "already-done" });
    expect(planRun("daily", saturday, afterWeekly)).toMatchObject({ action: "run", steps: ["database", "documents"] });
    // A monthly run by hand after the weekly one: both typed backups promoted, nothing made twice.
    expect(planRun("monthly", friday, afterWeekly)).toMatchObject({ action: "run", kind: "monthly", steps: ["documents"], promote: [{ step: "database", id: "db-1", from: "weekly" }, { step: "configuration", id: "cfg-1", from: "weekly" }] });

    const afterMonthly = { days: { "2026-11-27": { completed: ["database", "documents", "configuration"] as BackupStep[], kind: "monthly" as const, updatedAt: "" } } };
    expect(planRun("weekly", lastFriday, afterMonthly)).toMatchObject({ action: "skip", reason: "already-done" });
  });

  it("records completed steps per day, keeps only recent days and survives a missing or damaged file", async () => {
    const dir = await freshDir("state");
    expect(await readScheduleState(dir)).toEqual({ days: {} });

    await recordStepDone(dir, "2026-11-21", "database", saturday);
    await recordStepDone(dir, "2026-11-21", "database", saturday);
    const state = await recordStepDone(dir, "2026-11-21", "documents", saturday);
    expect(state.days["2026-11-21"]?.completed).toEqual(["database", "documents"]);

    // 45 earlier days: only the newest 40 days are kept, today among them.
    for (let i = 0; i < 45; i += 1) await recordStepDone(dir, new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10), "database", saturday);
    const kept = Object.keys((await readScheduleState(dir)).days).sort();
    expect(kept.length).toBe(40);
    expect(kept.at(-1)).toBe("2026-11-21");
    expect(kept[0]! > "2026-09-01").toBe(true);

    await writeFile(path.join(dir, "schedule.json"), "{ not json");
    expect(await readScheduleState(dir)).toEqual({ days: {} });
  });
});

describe("one backup at a time", () => {
  it("a second backup waits for the first and then runs", async () => {
    const dir = await freshDir("lock-wait");
    const releaseFirst = await acquireBackupLock(dir, { label: "first" });
    let waited = 0;

    const second = await acquireBackupLock(dir, {
      label: "second",
      pollMs: 1,
      sleep: async () => {
        waited += 1;
        if (waited === 2) await releaseFirst();
      },
    });

    expect(waited).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(await readFile(path.join(dir, "backup.lock"), "utf8")).job).toBe("second");
    await second();
    await expect(stat(path.join(dir, "backup.lock"))).rejects.toThrow();
  });

  it("gives up with a clear error when the running backup does not finish in time", async () => {
    const dir = await freshDir("lock-timeout");
    let clock = Date.parse("2026-11-21T12:30:00Z");
    const release = await acquireBackupLock(dir, { label: "running", now: () => new Date(clock) });

    await expect(
      acquireBackupLock(dir, { waitMs: 60_000, pollMs: 15_000, now: () => new Date(clock), sleep: async (ms) => void (clock += ms) })
    ).rejects.toBeInstanceOf(BackupLockedError);
    await release();
  });

  it("reclaims a lock left by a backup that crashed, or one that is far too old", async () => {
    const dir = await freshDir("lock-stale");
    await writeFile(path.join(dir, "backup.lock"), JSON.stringify({ pid: 999_999, host: (await import("node:os")).hostname(), job: "crashed", since: new Date().toISOString() }));
    const release = await acquireBackupLock(dir, { isAlive: () => false });
    await release();

    await writeFile(path.join(dir, "backup.lock"), JSON.stringify({ pid: process.pid, host: "elsewhere", job: "ancient", since: "2026-01-01T00:00:00Z" }));
    const again = await acquireBackupLock(dir, { staleMs: 60_000 });
    await again();
  });

  it("releasing never removes a lock that another backup took over", async () => {
    const dir = await freshDir("lock-owner");
    const release = await acquireBackupLock(dir);
    await writeFile(path.join(dir, "backup.lock"), JSON.stringify({ pid: 4242, host: "other", job: "other", since: new Date().toISOString() }));
    await release();
    expect(JSON.parse(await readFile(path.join(dir, "backup.lock"), "utf8")).job).toBe("other");
  });
});

describe("scheduled backup jobs", () => {
  const recorder = () => {
    const calls: BackupStep[] = [];
    const step = (name: BackupStep, code = 0): StepRunner => async () => {
      calls.push(name);
      return code;
    };
    return { calls, step };
  };
  const configFor = (stateDir: string, workDir: string) => ({ environment: "test", stateDir, workDir, alertWebhookUrl: "https://alerts.example.invalid/hook" });

  it("Friday: the weekly job runs database, documents and configuration once; a second start that day does nothing", async () => {
    const stateDir = await freshDir("job-state");
    const workDir = await freshDir("job-work");
    const { calls, step } = recorder();
    const steps = { database: step("database"), documents: step("documents"), configuration: step("configuration") };
    const now = () => at("2026-11-20T12:30:05Z");

    const first = await runScheduledBackup({ kind: "weekly", config: configFor(stateDir, workDir), log, steps, now });
    expect(first).toMatchObject({ exitCode: 0, completed: ["database", "documents", "configuration"], failed: [] });

    const repeat = await runScheduledBackup({ kind: "weekly", config: configFor(stateDir, workDir), log, steps, now });
    expect(repeat.exitCode).toBe(0);
    expect(repeat.plan).toMatchObject({ action: "skip", reason: "already-done" });
    expect(calls).toEqual(["database", "documents", "configuration"]);
    // The lock is released.
    await expect(stat(path.join(stateDir, "backup.lock"))).rejects.toThrow();
  });

  it("Friday: a daily job runs nothing and never touches the weekly job's configuration snapshot", async () => {
    const stateDir = await freshDir("job-state");
    const workDir = await freshDir("job-work");
    await writeFile(path.join(workDir, CONFIG_SNAPSHOT_FILE), "x");
    const { calls, step } = recorder();

    const result = await runScheduledBackup({ kind: "daily", config: configFor(stateDir, workDir), log, steps: { database: step("database"), documents: step("documents"), configuration: step("configuration") }, now: () => at("2026-11-20T12:30:05Z") });

    expect(result.plan).toMatchObject({ action: "skip", reason: "friday-full-backup-only" });
    expect(calls).toEqual([]);
    // Both catch-up jobs may start together after downtime: the weekly snapshot must survive the daily job.
    expect(await readdir(workDir)).toEqual([CONFIG_SNAPSHOT_FILE]);
  });

  it("a weekly job that finds the configuration already done today discards its new snapshot", async () => {
    const stateDir = await freshDir("job-state");
    const workDir = await freshDir("job-work");
    await recordStepDone(stateDir, "2026-11-20", "configuration", at("2026-11-20T10:00:00Z"));
    await writeFile(path.join(workDir, CONFIG_SNAPSHOT_FILE), "x");
    const { calls, step } = recorder();

    const result = await runScheduledBackup({ kind: "weekly", config: configFor(stateDir, workDir), log, steps: { database: step("database"), documents: step("documents"), configuration: step("configuration") }, now: () => at("2026-11-20T12:30:05Z") });

    expect(result.completed).toEqual(["database", "documents"]);
    expect(calls).toEqual(["database", "documents"]);
    expect(await readdir(workDir)).toEqual([]);
  });

  it("a failed step does not stop the others, is not recorded, and is retried by the next job that day", async () => {
    const stateDir = await freshDir("job-state");
    const workDir = await freshDir("job-work");
    const { calls, step } = recorder();
    const now = () => at("2026-11-20T12:30:05Z");
    const failing: StepRunner = async () => {
      calls.push("documents");
      throw new Error("bucket unreachable");
    };

    const result = await runScheduledBackup({ kind: "weekly", config: configFor(stateDir, workDir), log, steps: { database: step("database"), documents: failing, configuration: step("configuration") }, now });
    expect(result).toMatchObject({ exitCode: 1, completed: ["database", "configuration"], failed: ["documents"] });
    expect((await readScheduleState(stateDir)).days["2026-11-20"]?.completed).toEqual(["database", "configuration"]);

    const retry = await runScheduledBackup({ kind: "weekly", config: configFor(stateDir, workDir), log, steps: { database: step("database"), documents: step("documents"), configuration: step("configuration") }, now });
    expect(retry.completed).toEqual(["documents"]);
    expect(calls).toEqual(["database", "documents", "configuration", "documents"]);
  });

  it("a step that finished with findings (exit 2) is recorded and reported with exit code 2", async () => {
    const stateDir = await freshDir("job-state");
    const { step } = recorder();
    const result = await runScheduledBackup({ kind: "daily", config: configFor(stateDir, await freshDir("job-work")), log, steps: { database: step("database"), documents: step("documents", 2), configuration: step("configuration") }, now: () => at("2026-11-21T12:30:05Z") });
    expect(result).toMatchObject({ exitCode: 2, completed: ["database", "documents"] });
  });

  it("two jobs started together never overlap: the second waits, then finds the work done", async () => {
    const stateDir = await freshDir("job-state");
    const workDir = await freshDir("job-work");
    let running = 0;
    let maxRunning = 0;
    const calls: BackupStep[] = [];
    const slow = (name: BackupStep): StepRunner => async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      calls.push(name);
      await new Promise((resolve) => setTimeout(resolve, 60));
      running -= 1;
      return 0;
    };
    const steps = { database: slow("database"), documents: slow("documents"), configuration: slow("configuration") };
    const now = () => at("2026-11-21T12:30:05Z");

    const [a, b] = await Promise.all([
      runScheduledBackup({ kind: "daily", config: configFor(stateDir, workDir), log, steps, now, lock: { pollMs: 10 } }),
      runScheduledBackup({ kind: "daily", config: configFor(stateDir, workDir), log, steps, now, lock: { pollMs: 10 } }),
    ]);

    expect(maxRunning).toBe(1);
    expect(calls).toEqual(["database", "documents"]);
    expect([a.plan?.action, b.plan?.action].sort()).toEqual(["run", "skip"]);
  });

  it("when another backup is still running at the end of the wait, the job alerts and exits 75 without running", async () => {
    const stateDir = await freshDir("job-state");
    let clock = Date.parse("2026-11-21T12:30:00Z");
    const release = await acquireBackupLock(stateDir, { label: "db-backup by hand", now: () => new Date(clock) });
    const { calls, step } = recorder();

    const result = await runScheduledBackup({
      kind: "daily",
      config: configFor(stateDir, await freshDir("job-work")),
      log,
      steps: { database: step("database"), documents: step("documents"), configuration: step("configuration") },
      now: () => new Date(clock),
      lock: { waitMs: 60_000, pollMs: 15_000, sleep: async (ms) => void (clock += ms) },
      fetchImpl,
    });

    expect(result.exitCode).toBe(75);
    expect(calls).toEqual([]);
    expect(alerts.some((alert) => alert.includes("DAILY BACKUP NOT STARTED") && alert.includes("db-backup by hand"))).toBe(true);
    await release();
  });
});

describe("systemd timers and services (deploy/hostinger/systemd)", () => {
  const unit = async (name: string) => readFile(path.join(SYSTEMD, name), "utf8");
  const setting = (text: string, key: string) => text.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // The weekday part of an OnCalendar expression ("Fri", "Mon..Thu,Sat,Sun", "Mon,Wed") as weekday numbers.
  // Like systemd, a range must not wrap around the week: "Sat..Thu" is refused (systemd-analyze on the VPS,
  // 2026-11-18: "Failed to parse calendar specification"; this helper used to accept it).
  const weekdaysOf = (calendar: string): Set<number> => {
    const days = new Set<number>();
    for (const part of (calendar.split(" ")[0] ?? "").split(",")) {
      const [from, to] = part.split("..").map((name) => WEEKDAYS.indexOf(name));
      if (from === undefined || from < 0) throw new Error(`weekday spec ${part}`);
      if (to !== undefined && (to < 0 || to < from)) throw new Error(`systemd rejects the weekday range ${part}`);
      for (let day = from; ; day = (day + 1) % 7) {
        days.add(day);
        if (to === undefined || day === to) break;
      }
    }
    return days;
  };

  it("daily: 18:00 Asia/Kolkata every day except Friday; weekly: Friday 18:00 Asia/Kolkata; together exactly one run a day", async () => {
    const daily = setting(await unit("stslv-amc-backup-daily.timer"), "OnCalendar");
    const weekly = setting(await unit("stslv-amc-backup-weekly.timer"), "OnCalendar");

    expect(daily).toEqual(["Mon..Thu,Sat,Sun *-*-* 18:00:00 Asia/Kolkata"]);
    expect(() => weekdaysOf("Sat..Thu *-*-* 18:00:00 Asia/Kolkata")).toThrow(/rejects/);
    expect(weekly).toEqual(["Fri *-*-* 18:00:00 Asia/Kolkata"]);

    const dailyDays = weekdaysOf(daily[0]!);
    const weeklyDays = weekdaysOf(weekly[0]!);
    expect([...dailyDays].sort()).toEqual([0, 1, 2, 3, 4, 6]);
    expect([...weeklyDays]).toEqual([5]);
    expect([...dailyDays].filter((day) => weeklyDays.has(day))).toEqual([]);

    for (const name of ["stslv-amc-backup-daily.timer", "stslv-amc-backup-weekly.timer"]) {
      const text = await unit(name);
      expect(setting(text, "Persistent")).toEqual(["true"]);
      // An exact 18:00 start: no random delay.
      expect(setting(text, "RandomizedDelaySec")).toEqual([]);
    }
  });

  it("the services run the scheduled job; the weekly one makes the encrypted configuration snapshot first, as root", async () => {
    const daily = await unit("stslv-amc-backup-daily.service");
    const weekly = await unit("stslv-amc-backup-weekly.service");

    expect(setting(daily, "ExecStart")).toEqual(["/usr/bin/node /opt/stslv-amc/api/current/dist/ops/cli.js scheduled-backup --kind daily"]);
    expect(setting(daily, "ExecStartPre")).toEqual([]);
    // "-": a failed snapshot must not cancel the Friday database and document backups (review 2026-11-18).
    expect(setting(weekly, "ExecStartPre")).toEqual(["-+/usr/local/sbin/stslv-amc-config-snapshot"]);
    expect(setting(weekly, "ExecStart")).toEqual(["/usr/bin/node /opt/stslv-amc/api/current/dist/ops/cli.js scheduled-backup --kind weekly"]);
    for (const text of [daily, weekly]) {
      expect(setting(text, "User")).toEqual(["stslv-backup"]);
      expect(setting(text, "Type")).toEqual(["oneshot"]);
      expect(setting(text, "EnvironmentFile")).toEqual(["/etc/stslv-amc/backup.env"]);
    }
  });

  it("no other timer starts a backup (the old 02:15 / 02:45 timers are gone)", async () => {
    const timers = (await readdir(SYSTEMD)).filter((name) => name.endsWith(".timer"));
    expect(timers.sort()).toEqual(["stslv-amc-backup-daily.timer", "stslv-amc-backup-weekly.timer", "stslv-amc-monitor.timer"]);
  });
});

describe("weekly configuration backup", () => {
  const tarHead = () => {
    const head = Buffer.alloc(512);
    head.write("etc/stslv-amc/api.env", 0, "latin1");
    head.write("ustar", 257, "latin1");
    return head;
  };

  it("recognises an encrypted file and refuses a plain archive", async (context) => {
    expect(looksEncrypted(tarHead())).toBe(false);
    expect(looksEncrypted(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(false);
    expect(looksEncrypted(Buffer.from("DB_PASSWORD=secret\n"))).toBe(false);
    expect(looksEncrypted(Buffer.alloc(0))).toBe(false);
    if (!gpgAvailable) context.skip();

    const dir = await freshDir("gpg");
    await writeFile(path.join(dir, "plain.tar"), tarHead());
    await encryptFile({ gpgPath: "gpg", homeDir: gnupgHome }, fingerprint, path.join(dir, "plain.tar"), path.join(dir, "enc.gpg"));
    expect(looksEncrypted(await readFile(path.join(dir, "enc.gpg")))).toBe(true);
  });

  const vars = (workDir: string, stateDir: string, extra: Record<string, string> = {}) => ({
    NODE_ENV: "test",
    BACKUP_WORK_DIR: workDir,
    BACKUP_STATE_DIR: stateDir,
    BACKUP_GPG_RECIPIENT: fingerprint || "A".repeat(40),
    GNUPGHOME: gnupgHome,
    BACKUP_ALERT_WEBHOOK_URL: "https://alerts.example.invalid/hook",
    BACKUP_HEARTBEAT_CONFIG_URL: "https://heartbeat.example.invalid/config",
    ...extra,
  });

  it("refuses a plain, missing or stale snapshot: nothing uploaded, an alert sent, the failure recorded", async () => {
    const workDir = await freshDir("cfg-work");
    const stateDir = await freshDir("cfg-state");
    const store = new LocalDirStore(await freshDir("cfg-offsite"));
    const config = readBackupConfig(vars(workDir, stateDir));

    await writeFile(path.join(workDir, CONFIG_SNAPSHOT_FILE), tarHead());
    await expect(runConfigBackup({ config, store, log, fetchImpl })).rejects.toThrow(/not encrypted/);
    expect(await store.list("config/")).toEqual([]);
    expect(await readdir(workDir)).toEqual([]);
    expect(alerts.some((alert) => alert.includes("CONFIGURATION BACKUP FAILED"))).toBe(true);
    expect(alerts.some((alert) => alert.startsWith("https://heartbeat.example.invalid/config/fail"))).toBe(true);
    expect((await readState(stateDir, "config-backup")).lastFailure).toMatch(/not encrypted/);

    await expect(runConfigBackup({ config, store, log, fetchImpl })).rejects.toThrow(/No configuration snapshot/);

    await writeFile(path.join(workDir, CONFIG_SNAPSHOT_FILE), Buffer.from([0x85, 1, 2, 3]));
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    await utimes(path.join(workDir, CONFIG_SNAPSHOT_FILE), old, old);
    await expect(runConfigBackup({ config, store, log, fetchImpl })).rejects.toThrow(/too old/);
  });

  it("uploads the encrypted snapshot with its manifest, verifies it, leaves nothing behind and applies retention", async (context) => {
    if (!gpgAvailable) context.skip();
    const workDir = await freshDir("cfg-work");
    const stateDir = await freshDir("cfg-state");
    const offsite = await freshDir("cfg-offsite");
    const store = new LocalDirStore(offsite);
    const config = readBackupConfig(vars(workDir, stateDir, { BACKUP_RETAIN_WEEKLY: "4", BACKUP_RETAIN_MONTHLY: "0" }));

    // Ten older weekly configuration backups already off-site.
    for (let week = 10; week >= 1; week -= 1) {
      const id = newRunId("stslv-config", "test", new Date(Date.now() - week * 7 * 86_400_000));
      const file = path.join(root, `old-${counter}-${week}.json`);
      await writeFile(file, "{}");
      await store.upload(configArchiveKey(id), file);
      await store.upload(configManifestKey(id), file);
    }

    await writeFile(path.join(workDir, "plain.tar"), tarHead());
    await encryptFile({ gpgPath: "gpg", homeDir: gnupgHome }, fingerprint, path.join(workDir, "plain.tar"), path.join(workDir, CONFIG_SNAPSHOT_FILE));
    await rm(path.join(workDir, "plain.tar"));
    await writeFile(path.join(workDir, CONFIG_SNAPSHOT_PATHS), "/etc/stslv-amc\n/etc/letsencrypt\n");
    const expectedSha = await sha256File(path.join(workDir, CONFIG_SNAPSHOT_FILE));

    const result = await runConfigBackup({ config, store, log, fetchImpl });

    // The manifest (it lists the configuration paths) is stored ENCRYPTED; readable only with the private key.
    const manifestFile = path.join(offsite, ...configManifestKey(result.id).split("/"));
    const storedManifest = await readFile(manifestFile);
    expect(looksEncrypted(storedManifest)).toBe(true);
    expect(storedManifest.toString("latin1")).not.toContain("/etc/letsencrypt");
    const manifest = await readEncryptedJson<ConfigManifest>({ store, key: configManifestKey(result.id), gpg: { gpgPath: "gpg", homeDir: gnupgHome }, scratchDir: await freshDir("decrypt") });
    expect(manifest).toMatchObject({ format: 1, id: result.id, kind: "weekly", paths: ["/etc/stslv-amc", "/etc/letsencrypt"], encrypted: { key: configArchiveKey(result.id), sha256: expectedSha, recipient: fingerprint } });

    // Restore: the archive decrypts to exactly what was archived (the plain tar used above).
    const restored = await restoreConfigBackup({ store, backupId: "latest", toDir: await freshDir("cfg-restore"), gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: await freshDir("cfg-restore-work"), log });
    expect(restored.id).toBe(result.id);
    expect((await readFile(restored.archive)).equals(tarHead())).toBe(true);
    expect(await sha256File(path.join(offsite, ...configArchiveKey(result.id).split("/")))).toBe(expectedSha);
    expect(await readdir(workDir)).toEqual([]);
    expect((await readState(stateDir, "config-backup")).lastRunId).toBe(result.id);
    expect(alerts.some((alert) => alert.startsWith("https://heartbeat.example.invalid/config "))).toBe(true);

    // Retention: 4 weekly copies kept, the new one among them.
    const remaining = await listConfigBackups(store);
    expect(remaining.length).toBe(4);
    expect(remaining[0]?.id).toBe(result.id);
    expect(result.pruned.length).toBe(7);
  });
});

describe("recovery-point types: promotion and retention (14 daily, 8 weekly, 12 monthly)", () => {
  it("passes the job's type to each step; the last Friday's job runs as the monthly backup", async () => {
    const stateDir = await freshDir("kind-state");
    const kinds: string[] = [];
    const step = (name: BackupStep): StepRunner => async (kind) => {
      kinds.push(`${name}:${kind}`);
      return { code: 0, id: `${name}-id` };
    };

    const result = await runScheduledBackup({ kind: "weekly", config: { environment: "test", stateDir, workDir: await freshDir("kind-work"), alertWebhookUrl: null }, log, steps: { database: step("database"), documents: step("documents"), configuration: step("configuration") }, now: () => at("2026-11-27T12:30:05Z") });

    expect(result.plan).toMatchObject({ kind: "monthly" });
    expect(kinds).toEqual(["database:monthly", "documents:monthly", "configuration:monthly"]);
    expect((await readScheduleState(stateDir)).days["2026-11-27"]).toMatchObject({ kind: "monthly", ids: { database: "database-id", configuration: "configuration-id" } });
  });

  it("a weekly catch-up after the day's daily backup promotes it instead of backing up twice", async () => {
    const stateDir = await freshDir("promo-state");
    const workDir = await freshDir("promo-work");
    const calls: string[] = [];
    const step = (name: BackupStep): StepRunner => async (kind) => {
      calls.push(`${name}:${kind}`);
      return { code: 0, id: `${name}-${kind}` };
    };
    const steps = { database: step("database"), documents: step("documents"), configuration: step("configuration") };
    const promote = async (stepName: BackupStep, id: string, kind: string, from: string) => void calls.push(`promote ${stepName} ${id} ${from} -> ${kind}`);
    const config = { environment: "test", stateDir, workDir, alertWebhookUrl: null };
    // Saturday: the daily backup, then systemd's catch-up of the missed Friday (weekly) on the same day.
    const now = () => at("2026-11-21T12:31:00Z");

    await runScheduledBackup({ kind: "daily", config, log, steps, promote, now });
    const caughtUp = await runScheduledBackup({ kind: "weekly", config, log, steps, promote, now });

    expect(calls).toEqual(["database:daily", "documents:daily", "promote database database-daily daily -> weekly", "documents:weekly", "configuration:weekly"]);
    expect(caughtUp).toMatchObject({ exitCode: 0, completed: ["documents", "configuration"], promoted: ["database"] });
    expect((await readScheduleState(stateDir)).days["2026-11-21"]?.kind).toBe("weekly");
  });

  const backupsDir = async () => new LocalDirStore(await freshDir("retention-offsite"));
  const blob = async () => {
    const file = path.join(root, `blob-${counter}.txt`);
    await writeFile(file, "x");
    return file;
  };

  it("keeps exactly the newest 14 daily, 8 weekly and 12 monthly backups of a year of scheduled runs", async () => {
    const store = await backupsDir();
    const file = await blob();
    const runs = nextScheduledRuns(at("2026-12-31T13:00:00Z"), 365);
    for (const run of runs) {
      const id = newRunId("stslv-db", "test", run.at);
      await store.upload(dumpKey(id), file);
      await store.upload(kindMarkerKey(id, run.kind), file);
      await store.upload(manifestKey(id), file);
    }
    // An incomplete backup (no manifest: never verified) is not a recovery point and is never counted.
    const incomplete = newRunId("stslv-db", "test", at("2027-12-31T13:00:00Z"));
    await store.upload(dumpKey(incomplete), file);

    const before = await listDatabaseBackups(store);
    const newest = before[0]?.id as string;
    const removed = await pruneDatabaseBackups({ store, config: { retention: { daily: 14, weekly: 8, monthly: 12 } }, log, keepId: newest });
    const kept = await listDatabaseBackups(store);
    const byKind = (kind: string) => kept.filter((backup) => backup.kind === kind);

    expect(byKind("daily").length).toBe(14);
    expect(byKind("weekly").length).toBe(8);
    expect(byKind("monthly").length).toBe(12);
    expect(kept.length).toBe(34);
    expect(kept[0]?.id).toBe(newest);
    expect(removed.length).toBe(365 - 34);
    // The 12 monthly recovery points are one per month of the year; the weekly ones are the newest 8 Fridays.
    expect(new Set(byKind("monthly").map((backup) => backup.createdAt.toISOString().slice(0, 7))).size).toBe(12);
    // A removed backup loses its dump, its type markers and its manifest.
    const gone = removed[0] as string;
    expect(await store.head(dumpKey(gone))).toBeNull();
    expect(await store.head(manifestKey(gone))).toBeNull();
    for (const kind of ["daily", "weekly", "monthly"] as const) expect(await store.head(kindMarkerKey(gone, kind))).toBeNull();
  }, 180_000);

  it("a promoted backup counts as its highest type; a backup without a type counts as daily; 7 or fewer are never pruned", async () => {
    const store = await backupsDir();
    const file = await blob();
    const ids: string[] = [];
    for (let day = 0; day < 7; day += 1) {
      const id = newRunId("stslv-db", "test", new Date(Date.UTC(2026, 10, 10 + day, 12, 30)));
      ids.push(id);
      await store.upload(dumpKey(id), file);
      await store.upload(manifestKey(id), file);
    }

    await promoteDatabaseBackup(store, ids[2] as string, "weekly", await freshDir("promote-work"));
    await promoteDatabaseBackup(store, ids[2] as string, "weekly", await freshDir("promote-work"));
    const listed = await listDatabaseBackups(store);
    expect(listed.find((backup) => backup.id === ids[2])?.kind).toBe("weekly");
    expect(listed.filter((backup) => backup.kind === "daily").length).toBe(6);

    expect(await pruneDatabaseBackups({ store, config: { retention: { daily: 1, weekly: 0, monthly: 0 } }, log, keepId: ids[6] as string })).toEqual([]);
    await expect(promoteDatabaseBackup(store, "stslv-db-test-20990101T000000000Z-000000", "monthly", await freshDir("promote-work"))).rejects.toThrow(/not complete/);
  });

  it("the type-based policy keeps the newest of each type and always the newest backup", () => {
    const stamp = (day: number, kind: "daily" | "weekly" | "monthly") => ({ id: `b${day}`, createdAt: new Date(Date.UTC(2027, 0, day)), kind });
    const decision = selectByKind([stamp(1, "monthly"), stamp(2, "weekly"), stamp(3, "daily"), stamp(4, "daily"), stamp(5, "weekly")], { daily: 1, weekly: 1, monthly: 0 });

    expect(decision.keep).toEqual(["b5", "b4"]);
    expect(decision.remove).toEqual(["b3", "b2", "b1"]);
    expect(decision.reasons.b5).toEqual(["newest", "weekly"]);
  });
});

describe("recovery after an interrupted run", () => {
  it("a scheduled job removes run folders left by a killed run (they may hold plain copies) and keeps the Friday snapshot", async () => {
    const stateDir = await freshDir("abandon-state");
    const workDir = await freshDir("abandon-work");
    const leftover = path.join(workDir, "stslv-db-test-20261120T123000000Z-abcdef");
    await mkdir(leftover, { recursive: true });
    await writeFile(path.join(leftover, "database.dump"), "PGDMP plain dump from a killed run");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(leftover, old, old);
    await writeFile(path.join(workDir, CONFIG_SNAPSHOT_FILE), "encrypted snapshot");

    const ran: string[] = [];
    const step = (name: BackupStep): StepRunner => async () => {
      ran.push(name);
      return 0;
    };
    await runScheduledBackup({ kind: "weekly", config: { environment: "test", stateDir, workDir, alertWebhookUrl: null }, log, steps: { database: step("database"), documents: step("documents"), configuration: step("configuration") }, now: () => at("2026-11-20T12:30:05Z") });

    expect(await readdir(workDir)).toEqual([CONFIG_SNAPSHOT_FILE]);
    expect(lines.some((line) => line.includes("scheduled_backup.abandoned_runs_removed"))).toBe(true);
    expect(ran).toEqual(["database", "documents", "configuration"]);
  });
});

describe("review fixes (2026-11-18)", () => {
  const empty = { days: {} };

  it("a run belongs to the most recent 18:00 IST slot: a morning catch-up never uses up that evening's backup", () => {
    expect(scheduleSlot(at("2026-11-21T12:30:00Z")).toISOString()).toBe("2026-11-21T12:30:00.000Z");
    expect(scheduleSlot(at("2026-11-21T12:29:59Z")).toISOString()).toBe("2026-11-20T12:30:00.000Z");
    expect(scheduleSlot(at("2026-11-21T20:00:00Z")).toISOString()).toBe("2026-11-21T12:30:00.000Z");

    // Server off from Thursday 17:00 to Saturday 09:00 IST. At boot both timers catch up: the Friday job is
    // Friday's weekly backup; the daily catch-up falls in Friday's slot and does nothing.
    const boot = at("2026-11-21T03:30:00Z");
    expect(planRun("weekly", boot, empty)).toMatchObject({ action: "run", kind: "weekly", day: "2026-11-20" });
    expect(planRun("daily", boot, empty)).toMatchObject({ action: "skip", reason: "friday-full-backup-only", day: "2026-11-20" });
    // Saturday 18:00 still makes Saturday's backup.
    const afterCatchUp = { days: { "2026-11-20": { completed: ["database", "documents", "configuration"] as BackupStep[], kind: "weekly" as const, updatedAt: "" } } };
    expect(planRun("daily", at("2026-11-21T12:30:00Z"), afterCatchUp)).toMatchObject({ action: "run", kind: "daily", day: "2026-11-21", steps: ["database", "documents"] });

    // A daily catch-up on Friday morning makes Thursday's missing backup (no longer refused as "Friday").
    expect(planRun("daily", at("2026-11-20T03:30:00Z"), empty)).toMatchObject({ action: "run", kind: "daily", day: "2026-11-19" });
  });

  it("a lock written before the last reboot is reclaimed even if its process id is alive again", async () => {
    const dir = await freshDir("lock-boot");
    await writeFile(path.join(dir, "backup.lock"), JSON.stringify({ pid: process.pid, host: hostname(), job: "before-reboot", since: new Date().toISOString(), boot: "old-boot" }));
    const release = await acquireBackupLock(dir, {
      bootId: "new-boot",
      waitMs: 0,
      sleep: async () => {
        throw new Error("must not wait");
      },
    });
    expect(JSON.parse(await readFile(path.join(dir, "backup.lock"), "utf8"))).toMatchObject({ boot: "new-boot" });
    await release();
  });

  it("two jobs reclaiming the same abandoned lock at once never run together", async () => {
    // Repeated, with four jobs: an earlier rename-and-put-back design passed with two jobs and failed now and then
    // with three (a fresh lock could be created while the reclaimed one was moved aside).
    for (let round = 0; round < 15; round += 1) {
      const dir = await freshDir("lock-race");
      await writeFile(path.join(dir, "backup.lock"), JSON.stringify({ pid: 999_999, host: hostname(), job: "crashed", since: new Date().toISOString() }));
      let active = 0;
      let most = 0;
      const job = async (label: string) => {
        const release = await acquireBackupLock(dir, { label, bootId: null, pollMs: 1, isAlive: (pid) => pid !== 999_999 });
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        await release();
      };
      await Promise.all([job("a"), job("b"), job("c"), job("d")]);
      expect(most).toBe(1);
      expect((await readdir(dir)).filter((name) => name.startsWith("backup.lock"))).toEqual([]);
    }
  }, 60_000);

  it("pruning removes the manifest first: an interrupted prune never leaves a recovery point without its dump", async () => {
    const dir = await freshDir("prune-order");
    const inner = new LocalDirStore(dir);
    const blob = `${dir}-blob.bin`;
    await writeFile(blob, "x");
    const ids: string[] = [];
    for (let day = 0; day < 12; day += 1) {
      const id = newRunId("stslv-db", "test", new Date(Date.UTC(2026, 10, 18 - day, 12, 30)));
      ids.push(id);
      await inner.upload(dumpKey(id), blob);
      await inner.upload(manifestKey(id), blob);
    }
    const removals: string[] = [];
    let failAfter = Number.POSITIVE_INFINITY;
    const store = {
      label: inner.label,
      list: (prefix: string) => inner.list(prefix),
      head: (key: string) => inner.head(key),
      download: (key: string, file: string) => inner.download(key, file),
      upload: (key: string, file: string) => inner.upload(key, file),
      remove: async (key: string) => {
        if (removals.length >= failAfter) throw new Error("connection reset");
        removals.push(key);
        await inner.remove(key);
      },
    };
    const retention = { daily: 7, weekly: 0, monthly: 0 };

    failAfter = 1; // interrupted right after the first removal
    await expect(pruneDatabaseBackups({ store, config: { retention }, log, keepId: ids[0] as string })).rejects.toThrow();
    expect(removals[0]?.endsWith(".manifest.json.gpg")).toBe(true);
    for (const backup of await listDatabaseBackups(inner)) expect(await inner.head(dumpKey(backup.id))).not.toBeNull();

    failAfter = Number.POSITIVE_INFINITY;
    removals.length = 0;
    await pruneDatabaseBackups({ store, config: { retention }, log, keepId: ids[0] as string });
    const oldest = ids[11] as string;
    expect(removals.indexOf(manifestKey(oldest))).toBeGreaterThanOrEqual(0);
    expect(removals.indexOf(manifestKey(oldest))).toBeLessThan(removals.indexOf(dumpKey(oldest)));
  });

  it("an older backup with a plain manifest (before manifests were encrypted) is never removed as an orphan", async () => {
    const dir = await freshDir("legacy");
    const store = new LocalDirStore(dir);
    const blob = `${dir}-blob.bin`;
    await writeFile(blob, "x");
    const ids: string[] = [];
    for (let day = 0; day < 9; day += 1) {
      const id = newRunId("stslv-db", "test", new Date(Date.UTC(2026, 10, 18 - day, 12, 30)));
      ids.push(id);
      await store.upload(dumpKey(id), blob);
      await store.upload(manifestKey(id), blob);
    }
    const legacy = newRunId("stslv-db", "test", new Date(Date.UTC(2026, 9, 1, 2, 15)));
    const orphan = newRunId("stslv-db", "test", new Date(Date.UTC(2026, 9, 2, 2, 15)));
    await store.upload(dumpKey(legacy), blob);
    await store.upload(`db/${legacy}.manifest.json`, blob);
    await store.upload(dumpKey(orphan), blob);
    const old = new Date(Date.UTC(2026, 9, 2));
    for (const key of [dumpKey(legacy), `db/${legacy}.manifest.json`, dumpKey(orphan)]) await utimes(path.join(dir, ...key.split("/")), old, old);

    await pruneDatabaseBackups({ store, config: { retention: { daily: 14, weekly: 0, monthly: 0 } }, log, keepId: ids[0] as string });
    expect(await store.head(dumpKey(legacy))).not.toBeNull();
    expect(await store.head(dumpKey(orphan))).toBeNull();
  });

  it("only an OpenPGP session-key packet counts as encrypted: plain PNG, JPEG and other packets are refused", () => {
    expect(looksEncrypted(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false); // PNG
    expect(looksEncrypted(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false); // JPEG
    expect(looksEncrypted(Buffer.from([0xa3, 0x01]))).toBe(false); // compressed data, not encrypted
    expect(looksEncrypted(Buffer.from([0xcb, 0x10]))).toBe(false); // literal data (new format)
    expect(looksEncrypted(Buffer.from([0x85, 0x01, 0x0c]))).toBe(true); // public-key session key (old format)
    expect(looksEncrypted(Buffer.from([0xc1, 0x5e]))).toBe(true); // public-key session key (new format)
    expect(looksEncrypted(Buffer.from([0x8c, 0x0d]))).toBe(true); // passphrase session key
  });
});

describe("email alerting through the heartbeats (Healthchecks.io, 2026-11-18)", () => {
  const heartbeats = {
    heartbeatDbUrl: "https://hc.example.invalid/db",
    heartbeatDocsUrl: "https://hc.example.invalid/docs",
    heartbeatConfigUrl: "https://hc.example.invalid/config",
  };

  it("a failure before a step's own handling (expired Google authorization, failed pre-flight) pings /fail with the reason", async () => {
    const stateDir = await freshDir("hb-state");
    const workDir = await freshDir("hb-work");
    const ok = async () => 0;
    const result = await runScheduledBackup({
      kind: "daily",
      config: { environment: "test", stateDir, workDir, alertWebhookUrl: null, ...heartbeats },
      log,
      fetchImpl,
      now: () => at("2026-11-21T12:30:05Z"),
      steps: {
        database: async () => {
          throw new Error("Google Drive authorization has expired or was revoked: authorize rclone again");
        },
        documents: ok,
        configuration: ok,
      },
    });

    expect(result).toMatchObject({ exitCode: 1, failed: ["database"], completed: ["documents"] });
    const failPing = alerts.find((alert) => alert.startsWith("https://hc.example.invalid/db/fail "));
    expect(failPing).toContain("authorization has expired");
    expect(failPing).toContain("[STSLV AMC test]");
    expect(alerts.some((alert) => alert.startsWith("https://hc.example.invalid/docs/fail"))).toBe(false);
  });

  it("a job that cannot start (another backup still running) pings /fail on every check it was due to update", async () => {
    const stateDir = await freshDir("hb-lock");
    let clock = Date.parse("2026-11-20T12:30:00Z");
    const release = await acquireBackupLock(stateDir, { label: "running", now: () => new Date(clock) });
    const result = await runScheduledBackup({
      kind: "weekly",
      config: { environment: "test", stateDir, workDir: await freshDir("hb-lock-work"), alertWebhookUrl: null, ...heartbeats },
      log,
      fetchImpl,
      now: () => new Date(clock),
      lock: { waitMs: 60_000, pollMs: 15_000, sleep: async (ms) => void (clock += ms) },
      steps: { database: async () => 0, documents: async () => 0, configuration: async () => 0 },
    });
    await release();

    expect(result.exitCode).toBe(75);
    for (const check of ["db", "docs", "config"]) {
      expect(alerts.find((alert) => alert.startsWith(`https://hc.example.invalid/${check}/fail `))).toContain("NOT STARTED");
    }
  });
});

describe("monitoring is optional (decision 2026-11-18: no external service)", () => {
  it("with no heartbeat or webhook configured, a backup runs normally, a failure is still recorded, and nothing is sent anywhere", async () => {
    const stateDir = await freshDir("nomon-state");
    const sent: string[] = [];
    const recordFetch = async (url: string) => {
      sent.push(url);
      return { ok: true, status: 200 };
    };
    const result = await runScheduledBackup({
      kind: "daily",
      config: { environment: "test", stateDir, workDir: await freshDir("nomon-work"), alertWebhookUrl: null, heartbeatDbUrl: null, heartbeatDocsUrl: null, heartbeatConfigUrl: null },
      log,
      fetchImpl: recordFetch,
      now: () => at("2026-11-21T12:30:05Z"),
      steps: {
        database: async () => {
          throw new Error("Google Drive authorization has expired");
        },
        documents: async () => 0,
        configuration: async () => 0,
      },
    });

    expect(result).toMatchObject({ exitCode: 1, failed: ["database"], completed: ["documents"] });
    expect(sent).toEqual([]);
    // The failure is visible locally: the journal (log line) and the unit's exit status.
    expect(lines.some((line) => line.includes("scheduled_backup.step_failed") && line.includes("authorization has expired"))).toBe(true);
    expect((await readScheduleState(stateDir)).days["2026-11-21"]?.completed).toEqual(["documents"]);
  });

  it("the settings accept empty monitoring values in production", () => {
    const config = readBackupConfig({
      NODE_ENV: "production",
      BACKUP_GPG_RECIPIENT: "1B1D7F26FFC73C97B0CDD2BE6A49C984BF2902ED",
      BACKUP_WORK_DIR: "/var/lib/stslv-amc-backup/work",
      BACKUP_ALERT_WEBHOOK_URL: "",
      BACKUP_HEARTBEAT_DB_URL: "",
      BACKUP_HEARTBEAT_DOCS_URL: "",
      BACKUP_HEARTBEAT_CONFIG_URL: "",
    });
    expect([config.alertWebhookUrl, config.heartbeatDbUrl, config.heartbeatDocsUrl, config.heartbeatConfigUrl]).toEqual([null, null, null, null]);
  });
});
