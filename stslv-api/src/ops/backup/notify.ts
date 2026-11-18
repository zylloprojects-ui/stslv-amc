import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./log";

// Alerts and the job state file.
//   Alert webhook  one JSON POST per failure: {"text": ..., "content": ...} (Slack / Google Chat / Discord style).
//   Heartbeat      a dead-man's switch URL (healthchecks-style): pinged on success, "<url>/fail" on failure.
//                  The external service alerts when no ping arrives, which also catches a job that never ran.
//   State file     <stateDir>/<job>.json, readable by the monitor (deploy/hostinger/scripts/monitor.sh). No secrets.

export type Fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

const defaultFetch: Fetch = (url, init) => fetch(url, init);

export async function sendAlert(webhookUrl: string | null, message: string, log: Logger, fetchImpl: Fetch = defaultFetch): Promise<void> {
  const text = log.redact(message);

  if (!webhookUrl) {
    log.warn("alert.not_configured", { message: text });
    return;
  }
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) log.warn("alert.rejected", { status: response.status });
    else log.info("alert.sent");
  } catch {
    log.warn("alert.unreachable");
  }
}

/**
 * Pings the heartbeat: `<url>` on success, `<url>/fail` on failure. With a `reason`, the failure ping is a POST whose
 * plain-text body is that reason (secrets redacted, at most 1,000 characters): Healthchecks.io shows the body in its
 * email notification, so the alert says WHY the backup failed (email is the only alert channel on the VPS).
 */
export async function pingHeartbeat(url: string | null, ok: boolean, log: Logger, fetchImpl: Fetch = defaultFetch, reason?: string): Promise<void> {
  if (!url) return;
  const target = ok ? url : `${url.replace(/\/+$/, "")}/fail`;
  const init: Parameters<Fetch>[1] =
    !ok && reason
      ? { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: log.redact(reason).slice(0, 1_000), signal: AbortSignal.timeout(10_000) }
      : { method: "GET", signal: AbortSignal.timeout(10_000) };
  try {
    const response = await fetchImpl(target, init);
    if (!response.ok) log.warn("heartbeat.rejected", { status: response.status });
  } catch {
    log.warn("heartbeat.unreachable");
  }
}

export interface JobState {
  job: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
  lastRunId: string | null;
  details: Record<string, unknown>;
}

export async function readState(stateDir: string, job: string): Promise<JobState> {
  try {
    return JSON.parse(await readFile(path.join(stateDir, `${job}.json`), "utf8")) as JobState;
  } catch {
    return { job, lastSuccessAt: null, lastFailureAt: null, lastFailure: null, lastRunId: null, details: {} };
  }
}

export async function writeState(stateDir: string, state: JobState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, `${state.job}.json`);

  // Readable by the monitor user (0644): it holds dates, ids and counts only.
  await writeFile(`${target}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  await rename(`${target}.tmp`, target);
}
