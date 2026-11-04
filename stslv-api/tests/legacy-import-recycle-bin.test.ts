import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { applyImport } from "../src/legacy-import/apply";
import type { ImportConfig } from "../src/legacy-import/config";
import { closePool, signedIn } from "./helpers";
import { writeFixtureWorkbooks } from "./legacy-import-fixtures";
import { insertClient, resetProjectData } from "./projects-helpers";

// Migration 0106: a client in the Recycle Bin keeps its name, but the import's snapshot does not see it. The
// import refuses a register naming that client, and writes nothing, rather than fail on the unique index.
// Workbooks and data are invented.

let config: ImportConfig;
let directory: string;

const counts = async () =>
  (
    await pool.query<{ batches: number; rows: number; clients: number; contracts: number }>(
      `SELECT (SELECT count(*)::int FROM legacy_import_batches) AS batches, (SELECT count(*)::int FROM legacy_import_rows) AS rows,
              (SELECT count(*)::int FROM clients_all) AS clients, (SELECT count(*)::int FROM amc_contracts_all) AS contracts`
    )
  ).rows[0];

beforeAll(async () => {
  await resetProjectData();
  ({ config, directory } = writeFixtureWorkbooks());
});
afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await closePool();
});

describe("a register naming a client in the Recycle Bin", () => {
  it("is refused with the reason, and nothing is imported", async () => {
    const superAdmin = await signedIn("import-superadmin@example.com", ["ADMIN"]);
    const id = await insertClient("Alpha Hotel");
    await pool.query("UPDATE clients_all SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [id, superAdmin.id]);
    const before = await counts();

    await expect(applyImport(config, pool)).rejects.toThrow(/is in the Recycle Bin\. Restore it, or rename the client in the register, and import again\. Nothing was imported\./);

    expect(await counts()).toEqual(before);
    expect((await pool.query("SELECT deleted_at IS NOT NULL AS binned FROM clients_all WHERE id = $1", [id])).rows[0]?.binned).toBe(true);
  });
});
