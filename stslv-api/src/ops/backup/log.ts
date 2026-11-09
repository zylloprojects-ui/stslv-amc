// Structured logging for the backup jobs. One JSON object per line on stdout, which systemd's journal keeps.
// Every line passes through redact(): the configured secret values (database password, storage keys, webhook
// address...) are replaced, as are credentials embedded in URLs, so a log can be shared for diagnosis.

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Applies the same redaction to any text (an alert message, an error). */
  redact(text: string): string;
}

/** Replaces each secret (3+ characters) and any user:password@ or token-like query value in a URL. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;

  // Longest first, so a secret containing another is replaced whole.
  for (const secret of [...secrets].filter((value) => value.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("<redacted>");
  }

  return out
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1<redacted>@")
    .replace(/([?&](?:token|key|secret|signature|password|X-Amz-[A-Za-z-]+)=)[^&\s"]+/gi, "$1<redacted>")
    .replace(/(password|passwd|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2<redacted>");
}

export function createLogger(secrets: readonly string[], write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });

    write(redactText(line, secrets));
  };

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    redact: (text) => redactText(text, secrets),
  };
}

/** A short, redacted description of an error for logs and alerts. Never a stack trace. */
export function describeFailure(error: unknown, log: Pick<Logger, "redact">): string {
  const message = error instanceof Error ? error.message : String(error);

  return log.redact(message.split(/\r?\n/)[0] ?? "").slice(0, 300);
}
