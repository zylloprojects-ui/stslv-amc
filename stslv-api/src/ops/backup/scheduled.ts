import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BackupConfig } from "./config";
import { discardConfigSnapshot } from "./config-backup";
import { describeFailure, type Logger } from "./log";
import { pingHeartbeat, sendAlert, type Fetch } from "./notify";
import { acquireBackupLock, BackupLockedError, planRun, readScheduleState, recordStepDone, STEPS, type BackupKind, type BackupStep, type LockOptions } from "./schedule";

// A scheduled backup (systemd timer → `cli.js scheduled-backup --kind daily|weekly`; the Friday job becomes the
// monthly backup on the last Friday of the month, see schedule.ts):
//   1. takes the backup lock, waiting while another backup runs (never two at once);
//   2. plans the steps still missing for today's IST date (none for a daily job on a Friday);
//   3. runs them in order — database, documents, configuration — each one alerting on its own failure;
//      a failed step does not stop the following ones (a failed document copy must not cost the configuration);
//   4. records every completed step, so a second job on the same day does not repeat it.
// Exit codes: 0 done or nothing to do, 1 a step failed, 2 a step finished with warnings (e.g. a missing document),
// 75 the lock could not be taken in time (another backup still running; alerted).

/** Runs one step as a backup of the given type. Returns its exit code, or the code and the backup's identifier. */
export type StepRunner = (kind: BackupKind) => Promise<number | { code: number; id?: string }>;
/** Raises an existing typed backup (database or configuration) to a higher recovery-point type. */
export type Promoter = (step: BackupStep, id: string, kind: BackupKind, from: BackupKind) => Promise<void>;

export interface ScheduledBackupDeps {
  kind: BackupKind;
  config: Pick<BackupConfig, "environment" | "stateDir" | "workDir" | "alertWebhookUrl"> & Partial<Pick<BackupConfig, "heartbeatDbUrl" | "heartbeatDocsUrl" | "heartbeatConfigUrl">>;
  log: Logger;
  steps: Record<BackupStep, StepRunner>;
  promote?: Promoter;
  now?: () => Date;
  lock?: LockOptions;
  fetchImpl?: Fetch;
}

export interface ScheduledBackupResult {
  exitCode: number;
  plan: ReturnType<typeof planRun> | null;
  completed: BackupStep[];
  promoted?: BackupStep[];
  failed: BackupStep[];
}

export async function runScheduledBackup(deps: ScheduledBackupDeps): Promise<ScheduledBackupResult> {
  const { kind, config, log } = deps;
  const now = deps.now ?? (() => new Date());
  let release: (() => Promise<void>) | null = null;
  // Every failure the scheduled job sees is reported to that step's heartbeat ("<url>/fail", with the reason), not
  // only failures inside a step: a failed pre-flight (private key on the server, token file permissions), an expired
  // or revoked Google authorization or a wrong Drive folder is raised BEFORE the step's own error handling, and must
  // reach the email alert at once instead of waiting for the missed-run alert (review of email-only alerting,
  // 2026-11-18). A second /fail ping for a failure the step already reported changes nothing.
  const heartbeat = (step: BackupStep): string | null =>
    (step === "database" ? config.heartbeatDbUrl : step === "documents" ? config.heartbeatDocsUrl : config.heartbeatConfigUrl) ?? null;
  const reportFailure = (step: BackupStep, reason: string) => pingHeartbeat(heartbeat(step), false, log, deps.fetchImpl, `[STSLV AMC ${config.environment}] ${reason}`);

  try {
    release = await acquireBackupLock(config.stateDir, { ...deps.lock, label: `scheduled ${kind}`, now });
  } catch (error) {
    if (error instanceof BackupLockedError) {
      log.error("scheduled_backup.locked", { kind, holder: error.holder });
      await sendAlert(config.alertWebhookUrl, `[STSLV AMC ${config.environment}] ${kind.toUpperCase()} BACKUP NOT STARTED: ${error.message}`, log, deps.fetchImpl);
      for (const step of STEPS[kind]) await reportFailure(step, `${kind.toUpperCase()} BACKUP NOT STARTED: ${error.message}`);
      return { exitCode: 75, plan: null, completed: [], failed: [] };
    }
    throw error;
  }

  try {
    // With the lock held no other backup runs: any run folder left in the work directory belongs to a run that
    // was interrupted (killed, power loss) and may hold a plain copy. Removed before anything else. Plain files
    // (the Friday configuration snapshot, encrypted) are left to their owner.
    await removeAbandonedRunFolders(config.workDir, log);
    const plan = planRun(kind, now(), await readScheduleState(config.stateDir));

    if (plan.action === "skip") {
      log.info("scheduled_backup.skipped", { kind, day: plan.day, reason: plan.reason });
      if (kind !== "daily") await discardConfigSnapshot(config.workDir);
      return { exitCode: 0, plan, completed: [], failed: [] };
    }

    log.info("scheduled_backup.start", { kind, day: plan.day, steps: plan.steps });
    // Only the Friday job (weekly or monthly) owns the configuration snapshot (made by its ExecStartPre). A daily job never touches
    // it: after downtime systemd may start both catch-up jobs together, and the Friday snapshot must survive.
    if (kind !== "daily" && !plan.steps.includes("configuration")) await discardConfigSnapshot(config.workDir);

    const completed: BackupStep[] = [];
    const failed: BackupStep[] = [];
    let warnings = false;

    const promoted: BackupStep[] = [];

    // Backups already made today by a lower type: raised to this job's type (no second backup).
    for (const { step, id, from } of plan.promote) {
      try {
        if (!deps.promote) throw new Error("no promoter configured");
        await deps.promote(step, id, plan.kind, from);
        promoted.push(step);
        await recordStepDone(config.stateDir, plan.day, step, now(), { kind: plan.kind, id });
      } catch (error) {
        failed.push(step);
        log.error("scheduled_backup.promote_failed", { kind: plan.kind, step, id, reason: describeFailure(error, log) });
        const reason = `${plan.kind.toUpperCase()} BACKUP: raising today's ${step} backup ${id} failed: ${describeFailure(error, log)}`;
        await sendAlert(config.alertWebhookUrl, `[STSLV AMC ${config.environment}] ${reason}`, log, deps.fetchImpl);
        await reportFailure(step, reason);
      }
    }

    for (const step of plan.steps) {
      try {
        const result = await deps.steps[step](plan.kind);
        const code = typeof result === "number" ? result : result.code;
        const id = typeof result === "number" ? undefined : result.id;
        if (code === 0 || code === 2) {
          // Code 2 = stored, with findings already alerted (e.g. a document missing from storage).
          completed.push(step);
          await recordStepDone(config.stateDir, plan.day, step, now(), { kind: plan.kind, ...(id ? { id } : {}) });
          if (code === 2) warnings = true;
        } else {
          failed.push(step);
          await reportFailure(step, `${plan.kind.toUpperCase()} BACKUP: the ${step} step ended with exit code ${code}`);
        }
      } catch (error) {
        // A failure inside the backup has already been alerted by the step; one before it (pre-flight, Google
        // authorization, Drive folder check) has not: both are reported to the heartbeat here.
        failed.push(step);
        const reason = describeFailure(error, log);
        log.error("scheduled_backup.step_failed", { kind: plan.kind, step, reason });
        await reportFailure(step, `${plan.kind.toUpperCase()} BACKUP FAILED (${step}): ${reason}`);
      }
    }

    log.info("scheduled_backup.done", { kind: plan.kind, day: plan.day, completed, promoted, failed });

    return { exitCode: failed.length > 0 ? 1 : warnings ? 2 : 0, plan, completed, promoted, failed };
  } finally {
    await release?.();
  }
}

/** Removes sub-folders of the work directory (only runs create them) that are older than a minute. */
export async function removeAbandonedRunFolders(workDir: string, log: Logger, minAgeMs = 60_000): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(workDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const full = path.join(workDir, entry.name);
    const info = await stat(full).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < minAgeMs) continue;
    await rm(full, { recursive: true, force: true });
    removed.push(entry.name);
  }
  if (removed.length > 0) log.warn("scheduled_backup.abandoned_runs_removed", { folders: removed });
  return removed;
}
