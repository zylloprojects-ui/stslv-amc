import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export interface ToolResult {
  code: number;
  stdout: string;
  /** The last part of stderr. It may name hosts or users, so callers redact it before logging. */
  stderrTail: string;
}

/**
 * Runs an external tool (pg_dump, pg_restore, gpg) without a shell, so no argument is ever interpreted.
 * Connection details reach PostgreSQL tools through `env` (PGHOST, PGPASSWORD...), never their arguments,
 * so they do not appear in the process list.
 */
export function runTool(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      // Only listings are read from stdout; cap it so a runaway tool cannot exhaust memory.
      if (stdout.length < 20_000_000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ code: -1, stdout: "", stderrTail: `could not start ${command}: ${error.code ?? "error"}` }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderrTail: stderr.trim() }));
  });
}

/** A minimal environment for a child process: the path, plus what it is given. Nothing else of ours leaks into it. */
export function childEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    // Windows needs these for networking and temporary files; harmless elsewhere.
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
  };
  const merged = { ...base, ...extra };

  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== "")) as NodeJS.ProcessEnv;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);

  return hash.digest("hex");
}

/** The major version of a PostgreSQL tool ("pg_dump (PostgreSQL) 17.11" -> 17), or null. */
export function parseToolMajorVersion(output: string): number | null {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(output);

  return match ? Number(match[1]) : null;
}
