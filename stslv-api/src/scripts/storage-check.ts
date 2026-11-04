import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { describeStorage, resolveStorageConfig } from "../config/storage-config";
import { describeStorageError } from "../shared/object-storage";
import { StoredFileNotFoundError } from "../shared/storage";
import { createFileStorage } from "../shared/storage-factory";

/**
 * npm run storage:check
 * Checks the configured document storage end to end: writes a small probe file under attachments/, reads it back,
 * compares its SHA-256 with what was written, deletes it, and confirms it is gone.
 *
 * Standalone on purpose: it reads only the storage settings (storage-config.ts) and never loads the database
 * configuration, the session secret or any API module, so it needs no DB_* or JWT_SECRET variable and touches no
 * database. It prints only the kind of store and each step's outcome (on failure, the provider's error code, HTTP
 * status and a cleaned one-line message: describeStorageError): never a key, secret, project, account, region,
 * bucket, signed header or address.
 *
 * For Supabase on its default endpoint it first checks that the project reference names a real project: every
 * project has the address <ref>.supabase.co, while the shared storage host answers any unknown reference with a
 * plain-text HTTP 400 "Project not specified." (2026-11-04: a mistyped reference failed as a bare "Error (HTTP 400)").
 * Exit code 0 when every step passed, 1 otherwise.
 */

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Every configured value that must never be printed, so describeStorageError can blank it out of a message. */
const SENSITIVE_VARIABLES = [
  "SUPABASE_PROJECT_REF", "SUPABASE_S3_REGION", "SUPABASE_S3_BUCKET", "SUPABASE_S3_ACCESS_KEY_ID", "SUPABASE_S3_SECRET_ACCESS_KEY", "SUPABASE_S3_ENDPOINT",
  "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "ATTACHMENTS_DIR",
];
const sensitive = () => SENSITIVE_VARIABLES.map((name) => process.env[name]?.trim() ?? "").filter((value) => value !== "");
const describeError = (error: unknown) => describeStorageError(error, sensitive());

/** A hint for the failures whose cause is known, named by variable only. */
function hintFor(error: unknown): string | null {
  const body = (error as { $responseBodyText?: unknown } | null)?.$responseBodyText;

  if (typeof body === "string" && body.includes("Project not specified")) {
    return "Supabase did not recognise the project. Check SUPABASE_PROJECT_REF (Project Settings > General > Project ID).";
  }
  const name = (error as { name?: string } | null)?.name;
  if (name === "SignatureDoesNotMatch" || name === "InvalidAccessKeyId" || name === "AccessDenied") {
    return "The keys or the region were not accepted. Check SUPABASE_S3_REGION, SUPABASE_S3_ACCESS_KEY_ID and SUPABASE_S3_SECRET_ACCESS_KEY (Storage > S3 Connection).";
  }
  if (name === "NoSuchBucket") return "The bucket was not found. Check SUPABASE_S3_BUCKET (the name is case-sensitive).";

  return null;
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
      const hint = hintFor(error);
      if (hint) console.log(`     ${hint}`);
      return false;
    }
  };

  const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
  if (config.driver === "supabase" && projectRef && !process.env.SUPABASE_S3_ENDPOINT?.trim()) {
    const known = await step("the Supabase project reference names an existing project", async () => {
      try {
        await lookup(`${projectRef}.supabase.co`);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOTFOUND") {
          throw Object.assign(new Error("unknown project"), { code: "ENOTFOUND", name: "UnknownProject" });
        }
        throw error;
      }
    });
    if (!known) {
      console.log("     No Supabase project has this reference (its <ref>.supabase.co address does not exist). Check SUPABASE_PROJECT_REF:");
      console.log("     Supabase dashboard > Project Settings > General > Project ID (20 lowercase letters and digits).");
      return false;
    }
  }

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
