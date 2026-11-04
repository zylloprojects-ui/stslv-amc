import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { applyImport } from "../src/legacy-import/apply";
import type { ImportConfig } from "../src/legacy-import/config";
import { closePool } from "./helpers";
import { writeFixtureWorkbooks } from "./legacy-import-fixtures";
import { resetProjectData } from "./projects-helpers";

// Migration 0105: the controlled import never generates an AMC Reference Number. A contract register without
// the "AMC Reference" column is refused before anything is written. Workbooks and data are invented.

let config: ImportConfig;
let directory: string;

/** Every row of every table, to prove that the refused run changed nothing. */
async function fingerprint(): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"
  );
  const parts: string[] = [];

  for (const { table_name: table } of tables.rows) {
    const rows = await pool.query<{ digest: string | null; count: number }>(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest, count(*)::int AS count FROM ${table} t`);
    parts.push(`${table}:${rows.rows[0]?.count}:${rows.rows[0]?.digest}`);
  }

  return parts.join("\n");
}

beforeAll(async () => {
  await resetProjectData();
  ({ config, directory } = writeFixtureWorkbooks({ withoutReferences: true }));
});
afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await closePool();
});

describe("a contract register without AMC Reference Numbers", () => {
  it("is refused before any contract, client, batch or staging row is written", async () => {
    const before = await fingerprint();

    await expect(applyImport(config, pool)).rejects.toThrow(/cannot be imported without a unique AMC Reference Number.*no AMC Reference Number.*Nothing was imported\./);

    // Nothing at all changed: no batch, staging row, client, contract or visit.
    expect(await fingerprint()).toBe(before);
  });
});
