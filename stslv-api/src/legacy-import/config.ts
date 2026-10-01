import { readFileSync } from "node:fs";
import { z } from "zod";

// The local configuration of a historical import. It names the client's
// workbooks, so it is kept with them in docs/client-source/ (which Git
// ignores) and is never committed.

const workbook = z.strictObject({
  /** File name inside sourceDirectory. */
  file: z.string().trim().min(1),
  /** The sheet to read. The import stops if the workbook's sheet is named differently. */
  sheet: z.string().min(1),
  /** SHA-256 of the file as it was analysed. The import stops if the file no longer matches. */
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "sha256 must be 64 hexadecimal characters."),
});

export const importConfigSchema = z.strictObject({
  sourceDirectory: z.string().trim().min(1),
  workbooks: z.strictObject({
    /** The contract register: one row per maintenance contract. */
    contracts: workbook,
    /** The maintenance schedule: month blocks of period rows. */
    schedule: workbook,
    /** The job register: one row per job. */
    jobs: workbook,
  }),
  /**
   * Client aliases that have been explicitly approved. Only an alias the
   * import itself proposes can be approved; anything else stops the run.
   * Empty until someone approves one.
   */
  approvedClientAliases: z.array(z.strictObject({ alias: z.string().trim().min(1), master: z.string().trim().min(1) })).default([]),
});

export type ImportConfig = z.infer<typeof importConfigSchema>;
export type WorkbookRole = keyof ImportConfig["workbooks"];

export function loadConfig(path: string): ImportConfig {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`The import configuration was not found at ${path}. See docs/HISTORICAL_IMPORT.md.`);
  }

  const parsed = importConfigSchema.safeParse(JSON.parse(text));

  if (!parsed.success) {
    throw new Error(`The import configuration at ${path} is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }

  return parsed.data;
}
