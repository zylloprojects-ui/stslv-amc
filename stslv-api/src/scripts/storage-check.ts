import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env";
import { describeStorage } from "../config/storage-config";
import { storage } from "../modules/attachments/attachments.service";

/**
 * npm run storage:check
 * Checks the configured document storage end to end: writes a small probe file, reads it back, compares it, and
 * removes it. Prints only the kind of store and the outcome: never a key, secret, account ID or bucket name.
 * Touches no database. Exit code 0 when the store works, 1 otherwise.
 */
async function main(): Promise<void> {
  const kind = describeStorage(env.fileStorage).kind;

  console.log(`Document storage: ${kind}`);
  if (kind === "NONE") {
    console.log("FAIL: no document storage is configured.");
    process.exitCode = 1;
    return;
  }

  const key = `${randomUUID()}.pdf`;
  const probe = Buffer.from(`%PDF-1.4\n% STSLV AMC storage check ${new Date().toISOString()}\n%%EOF\n`, "latin1");
  const files = storage();
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      console.log(`OK   ${name}`);
    } catch (error) {
      const code = (error as { name?: string; $metadata?: { httpStatusCode?: number } }) ?? {};
      console.log(`FAIL ${name}: ${code.name ?? "error"}${code.$metadata?.httpStatusCode ? ` (HTTP ${code.$metadata.httpStatusCode})` : ""}`);
      throw error;
    }
  };

  try {
    await step("write probe file", () => files.put(key, probe));
    await step("read it back and compare", async () => {
      const data = await files.get(key);
      if (createHash("sha256").update(data).digest("hex") !== createHash("sha256").update(probe).digest("hex")) {
        throw Object.assign(new Error("mismatch"), { name: "ContentMismatch" });
      }
    });
    await step("remove probe file", async () => {
      await files.remove?.(key);
    });
    console.log("Storage check passed.");
  } catch {
    process.exitCode = 1;
  }
}

void main();
