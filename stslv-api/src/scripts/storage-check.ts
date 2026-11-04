import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { describeStorage, resolveStorageConfig } from "../config/storage-config";
import { StoredFileNotFoundError } from "../shared/storage";
import { createFileStorage } from "../shared/storage-factory";

/**
 * npm run storage:check
 * Checks the configured document storage end to end: writes a small probe file under attachments/, reads it back,
 * compares its SHA-256 with what was written, deletes it, and confirms it is gone.
 *
 * Standalone on purpose: it reads only the storage settings (storage-config.ts) and never loads the database
 * configuration, the session secret or any API module, so it needs no DB_* or JWT_SECRET variable and touches no
 * database. It prints only the kind of store and each step's outcome (with an error's name and HTTP status on
 * failure): never a key, secret, project, account, region, bucket or address.
 * Exit code 0 when every step passed, 1 otherwise.
 */

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** An error reduced to what is safe to print: its name and, for an S3 error, its HTTP status. */
function describeError(error: unknown): string {
  const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } };

  return `${name ?? "error"}${$metadata?.httpStatusCode ? ` (HTTP ${$metadata.httpStatusCode})` : ""}`;
}

async function main(): Promise<boolean> {
  let config;

  try {
    config = resolveStorageConfig(process.env, process.env.NODE_ENV, process.cwd());
  } catch (error) {
    // The configuration messages name variables only, never values.
    console.log(`FAIL configuration: ${(error as Error).message}`);
    return false;
  }

  const kind = describeStorage(config).kind;
  console.log(`Document storage: ${kind}`);

  if (!config) {
    console.log("FAIL no document storage is configured.");
    return false;
  }

  const files = createFileStorage(config);
  const key = `${randomUUID()}.pdf`;
  const probe = Buffer.from(`%PDF-1.4\n% STSLV AMC storage check ${new Date().toISOString()} ${randomUUID()}\n%%EOF\n`, "latin1");
  let written = false;

  const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
    try {
      await run();
      console.log(`OK   ${name}`);
      return true;
    } catch (error) {
      console.log(`FAIL ${name}: ${describeError(error)}`);
      return false;
    }
  };

  try {
    if (!(await step(`upload a ${probe.length}-byte probe file`, () => files.put(key, probe)))) return false;
    written = true;

    let data: Buffer = Buffer.alloc(0);
    if (!(await step("download it", async () => void (data = await files.get(key))))) return false;
    if (
      !(await step("SHA-256 of the download matches the upload", async () => {
        if (sha256(data) !== sha256(probe)) throw Object.assign(new Error("mismatch"), { name: "ChecksumMismatch" });
      }))
    ) {
      return false;
    }

    if (!(await step("delete it", async () => void (await files.remove?.(key))))) return false;
    written = false;

    return await step("confirm it is gone", async () => {
      const gone = await files.get(key).then(
        () => false,
        (error: unknown) => {
          if (error instanceof StoredFileNotFoundError) return true;
          throw error;
        }
      );
      if (!gone) throw Object.assign(new Error("still present"), { name: "ProbeNotDeleted" });
    });
  } finally {
    // A failed step after the upload still removes the probe file.
    if (written) await files.remove?.(key).catch(() => console.log("NOTE the probe file could not be removed; it lies under attachments/ and is never referenced."));
  }
}

void main().then((passed) => {
  console.log(passed ? "Storage check passed." : "Storage check FAILED.");
  process.exitCode = passed ? 0 : 1;
});
