import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { highestKind, kindRank } from "./retention";

// The backup schedule, approved 2026-11-18 (final):
//   Daily    Saturday–Thursday at 18:00 India Standard Time (Asia/Kolkata): database + documents.
//   Weekly   every Friday at 18:00 IST except the last Friday of the month: database + documents + VPS configuration.
//   Monthly  the last Friday of each month at 18:00 IST: database + documents + VPS configuration.
// Monthly replaces weekly, weekly replaces daily: exactly one backup a day, never two for the same day.
//
// systemd starts the jobs (deploy/hostinger/systemd/stslv-amc-backup-{daily,weekly}.timer): the daily timer on
// Saturday–Thursday, the Friday timer every Friday. A calendar expression cannot say "every Friday except the
// last", so the Friday job decides from the IST date whether it is the weekly or the monthly backup. This module
// also makes sure two jobs never overlap and the same work is never done twice for a day:
//   - one lock for every backup command (scheduled or by hand): a second job waits for the first to finish;
//   - a record per IST day of the steps completed and of the recovery-point type reached: a job runs only the
//     steps still missing. When a higher type follows a lower one on the same day (after downtime, systemd may
//     catch up a daily and a Friday run together), the backups already made are PROMOTED to the higher type
//     (a marker beside them off-site) instead of being made twice.
// India has no daylight saving time, so 18:00 IST is always 12:30 UTC.

export const BACKUP_TIME_ZONE = "Asia/Kolkata";
export const SCHEDULED_HOUR = 18;
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const FRIDAY = 5;

export type BackupKind = "daily" | "weekly" | "monthly";
export type BackupStep = "database" | "documents" | "configuration";

export const STEPS: Readonly<Record<BackupKind, readonly BackupStep[]>> = {
  daily: ["database", "documents"],
  weekly: ["database", "documents", "configuration"],
  monthly: ["database", "documents", "configuration"],
};

/** Steps whose backups are pruned by type and therefore carry a type marker that can be raised. */
export const TYPED_STEPS: readonly BackupStep[] = ["database", "configuration"];

export function isBackupKind(value: unknown): value is BackupKind {
  return value === "daily" || value === "weekly" || value === "monthly";
}

/** The IST calendar day of an instant: its date (YYYY-MM-DD), weekday (0 = Sunday … 6 = Saturday) and day of month. */
export function backupDay(at: Date): { date: string; weekday: number; dayOfMonth: number; daysInMonth: number } {
  const local = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();

  return { date: local.toISOString().slice(0, 10), weekday: local.getUTCDay(), dayOfMonth: local.getUTCDate(), daysInMonth };
}

/** True when the IST day of this instant is the last Friday of its month. */
export function isLastFridayOfMonth(at: Date): boolean {
  const day = backupDay(at);

  return day.weekday === FRIDAY && day.dayOfMonth + 7 > day.daysInMonth;
}

/** Which backup the schedule makes on the IST day of this instant. */
export function scheduledKind(at: Date): BackupKind {
  if (backupDay(at).weekday !== FRIDAY) return "daily";

  return isLastFridayOfMonth(at) ? "monthly" : "weekly";
}

/**
 * The type of a Friday job started at `at`. On a Friday: weekly, or monthly on the last Friday. Started on another
 * day (systemd catching up a Friday missed while the server was off): the type of the Friday it stands for, the most
 * recent Friday within the last 6 days.
 */
export function fridayJobKind(at: Date): BackupKind {
  for (let back = 0; back <= 6; back += 1) {
    const day = new Date(at.getTime() - back * 86_400_000);
    if (backupDay(day).weekday === FRIDAY) return scheduledKind(day);
  }

  return "weekly";
}

/**
 * The scheduled slot a job started at `at` belongs to: the most recent 18:00 IST at or before `at`. A job started
 * before 18:00 (systemd catching up a run missed while the server was off, typically at boot) is the PREVIOUS day's
 * backup, so it never uses up the backup still due at 18:00 that day. (Found in review 2026-11-18: keyed by the
 * calendar date, a boot-time catch-up on Saturday morning made Saturday's 18:00 backup skip as "already-done".)
 */
export function scheduleSlot(at: Date): Date {
  const { date } = backupDay(at);
  const todaySlot = new Date(Date.parse(`${date}T${String(SCHEDULED_HOUR).padStart(2, "0")}:00:00.000Z`) - IST_OFFSET_MINUTES * 60_000);

  return todaySlot.getTime() <= at.getTime() ? todaySlot : new Date(todaySlot.getTime() - 86_400_000);
}

/** The next `count` scheduled runs strictly after `from`: one per IST day at 18:00. */
export function nextScheduledRuns(from: Date, count: number): { at: Date; kind: BackupKind; day: string }[] {
  const runs: { at: Date; kind: BackupKind; day: string }[] = [];
  const today = backupDay(from).date;
  // 18:00 IST of the IST day of `from`, as a UTC instant.
  let at = new Date(`${today}T${String(SCHEDULED_HOUR).padStart(2, "0")}:00:00.000Z`);
  at = new Date(at.getTime() - IST_OFFSET_MINUTES * 60_000);

  while (runs.length < count) {
    if (at.getTime() > from.getTime()) runs.push({ at, kind: scheduledKind(at), day: backupDay(at).date });
    at = new Date(at.getTime() + 86_400_000);
  }

  return runs;
}

// -- What a started job does ----------------------------------------------------------------------------

export interface DayRecord {
  completed: BackupStep[];
  /** The highest recovery-point type reached that day. */
  kind?: BackupKind;
  /** Identifiers of the typed backups made that day (to promote them instead of making them twice). */
  ids?: Partial<Record<BackupStep, string>>;
  updatedAt: string;
}

export interface ScheduleState {
  days: Record<string, DayRecord>;
}

export type RunPlan =
  | { action: "run"; day: string; kind: BackupKind; steps: BackupStep[]; promote: { step: BackupStep; id: string; from: BackupKind }[] }
  | { action: "skip"; day: string; kind: BackupKind; reason: "friday-full-backup-only" | "already-done" };

/**
 * What a job must still do for its scheduled slot (scheduleSlot: the IST day of the most recent 18:00 IST).
 *   - A daily job does nothing for a Friday slot: the Friday job (weekly or monthly) is that day's only backup.
 *   - A Friday job ("weekly" from the timer) becomes the monthly backup on the last Friday of the month.
 *   - Steps already done that day are not repeated. Typed backups made earlier that day by a LOWER type are
 *     promoted to this job's type instead.
 */
export function planRun(requested: BackupKind, at: Date, state: ScheduleState): RunPlan {
  const slot = scheduleSlot(at);
  const { date, weekday } = backupDay(slot);

  if (requested === "daily" && weekday === FRIDAY) return { action: "skip", day: date, kind: requested, reason: "friday-full-backup-only" };

  const kind: BackupKind = requested === "daily" ? "daily" : requested === "monthly" ? "monthly" : fridayJobKind(slot);
  const record = state.days[date];
  const done = new Set(record?.completed ?? []);
  const reached = record?.kind ?? (done.size > 0 ? "daily" : undefined);
  const upgrade = reached !== undefined && kindRank(kind) > kindRank(reached);
  const promote = upgrade
    ? TYPED_STEPS.filter((step) => done.has(step) && STEPS[kind].includes(step) && record?.ids?.[step]).map((step) => ({ step, id: record?.ids?.[step] as string, from: reached as BackupKind }))
    : [];
  // Documents are not promoted but copied again for the higher type: each recovery-point folder (Google Drive
  // Daily/Weekly/Monthly) must hold its own complete document set. Into one shared store it copies nothing new.
  const steps = STEPS[kind].filter((step) => !done.has(step) || (upgrade && step === "documents"));

  if (steps.length === 0 && promote.length === 0) return { action: "skip", day: date, kind, reason: "already-done" };

  return { action: "run", day: date, kind, steps, promote };
}

const STATE_FILE = "schedule.json";
const KEEP_DAYS = 40;

export async function readScheduleState(stateDir: string): Promise<ScheduleState> {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir, STATE_FILE), "utf8")) as Partial<ScheduleState>;
    return { days: parsed.days && typeof parsed.days === "object" ? parsed.days : {} };
  } catch {
    return { days: {} };
  }
}

/**
 * Records a completed (or promoted) step for an IST day, with the type reached and the backup's identifier
 * (dates, step names, types and identifiers only: readable by the monitor).
 */
export async function recordStepDone(stateDir: string, day: string, step: BackupStep, now: Date, info: { kind?: BackupKind; id?: string } = {}): Promise<ScheduleState> {
  const state = await readScheduleState(stateDir);
  const record = state.days[day] ?? { completed: [], updatedAt: now.toISOString() };

  if (!record.completed.includes(step)) record.completed.push(step);
  if (info.kind) record.kind = highestKind([record.kind ?? info.kind, info.kind]);
  if (info.id) record.ids = { ...record.ids, [step]: info.id };
  record.updatedAt = now.toISOString();
  state.days[day] = record;

  // Only recent days matter for duplicate checks.
  for (const old of Object.keys(state.days).sort().slice(0, -KEEP_DAYS)) delete state.days[old];

  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, STATE_FILE);
  await writeFile(`${target}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  await rename(`${target}.tmp`, target);

  return state;
}

// -- One backup at a time -----------------------------------------------------------------------------------

export class BackupLockedError extends Error {
  constructor(readonly holder: string) {
    super(`Another backup is still running (${holder}).`);
    this.name = "BackupLockedError";
  }
}

export interface LockOptions {
  /** How long to wait for a running backup to finish before giving up. */
  waitMs?: number;
  pollMs?: number;
  /** A lock older than this is considered abandoned (the longest job is limited to 2 hours by systemd). */
  staleMs?: number;
  now?: () => Date;
  /** Whether a process id is still running on this server. */
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Identifies the lock holder in messages. */
  label?: string;
  /** This boot's identifier (tests); default: /proc/sys/kernel/random/boot_id, null where unavailable. */
  bootId?: string | null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_FILE = "backup.lock";

/**
 * Windows only (development): creating a file that another handle has just deleted fails with EPERM while the
 * deletion is pending; it means "busy, try again", like EEXIST. On Linux (the VPS) EPERM is a real error.
 */
function isDeletePending(error: unknown): boolean {
  return process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM";
}

/** Linux boot identifier: a lock written before a reboot is abandoned whatever its process id (ids are reused). */
async function currentBootId(): Promise<string | null> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim() || null;
}

/**
 * Takes the backup lock (an exclusively created file in the state folder) and returns the function that releases
 * it. Waits while another backup holds it; reclaims a lock whose process has gone, that was written before the last
 * reboot, or that is too old.
 *
 * Reclaiming is serialized by a short exclusive "reclaim" mutex: if several jobs find the same abandoned lock at
 * once (both timers catching up at boot), only one removes it, and only if it is still the abandoned one; a job can
 * never delete a lock another job has just taken (review 2026-11-18).
 */
export async function acquireBackupLock(stateDir: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const waitMs = options.waitMs ?? 2 * 60 * 60_000;
  const pollMs = options.pollMs ?? 15_000;
  const staleMs = options.staleMs ?? 4 * 60 * 60_000;
  const now = options.now ?? (() => new Date());
  const isAlive = options.isAlive ?? processIsAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const file = path.join(stateDir, LOCK_FILE);
  const started = now().getTime();
  const bootId = options.bootId !== undefined ? options.bootId : await currentBootId();
  // `token` identifies this holder exactly (two jobs in one process share a pid and may share a millisecond).
  const owner = { pid: process.pid, host: hostname(), job: options.label ?? "backup", since: now().toISOString(), token: randomBytes(8).toString("hex"), ...(bootId ? { boot: bootId } : {}) };

  await mkdir(stateDir, { recursive: true });

  for (;;) {
    try {
      const handle = await open(file, "wx", 0o644);
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.close();

      return async () => {
        // Release only our own lock.
        const current = await readFile(file, "utf8").catch(() => "");
        if (current.includes(`"token":"${owner.token}"`)) await rm(file, { force: true });
      };
    } catch (error) {
      if (isDeletePending(error)) {
        await sleep(Math.min(pollMs, 1_000));
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let holder: { pid?: number; host?: string; job?: string; since?: string; boot?: string } = {};
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) continue; // released meanwhile
    try {
      holder = JSON.parse(raw) as typeof holder;
    } catch {
      // Half-written: judged by its age below.
    }
    const since = holder.since ? Date.parse(holder.since) : (await stat(file).catch(() => null))?.mtimeMs ?? 0;
    const sameHost = !holder.host || holder.host === owner.host;
    const beforeReboot = sameHost && Boolean(bootId && holder.boot && holder.boot !== bootId);
    const abandoned = beforeReboot || (sameHost && typeof holder.pid === "number" && !isAlive(holder.pid)) || now().getTime() - since > staleMs;

    if (abandoned) {
      // Only one job at a time may remove an abandoned lock: the one that creates the reclaim mutex exclusively.
      // It re-reads the lock and removes it only if it is still exactly the abandoned one. The lock file exists
      // throughout that check, so no other job can create a new lock in between; then everyone races for the
      // lock again through the exclusive create above.
      const mutex = `${file}.reclaim`;
      let mine = false;
      try {
        await (await open(mutex, "wx", 0o644)).close();
        mine = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !isDeletePending(error)) throw error;
        // A reclaim mutex left by a job that crashed in the middle of reclaiming (it is held for milliseconds).
        const age = now().getTime() - ((await stat(mutex).catch(() => null))?.mtimeMs ?? now().getTime());
        if (age > 60_000) await rm(mutex, { force: true });
      }
      if (mine) {
        try {
          if ((await readFile(file, "utf8").catch(() => null)) === raw) await rm(file, { force: true });
        } finally {
          await rm(mutex, { force: true });
        }
      } else {
        await sleep(Math.min(pollMs, 1_000));
      }
      continue;
    }
    if (now().getTime() - started >= waitMs) throw new BackupLockedError(`${holder.job ?? "backup"} since ${holder.since ?? "unknown"}`);
    await sleep(pollMs);
  }
}
