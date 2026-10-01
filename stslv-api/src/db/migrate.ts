import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

// stslv-api/migrations, whether running from src/ (tsx) or dist/ (node).
export const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "migrations");

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

// Arbitrary constant: serialises concurrent migration runs on one database.
const ADVISORY_LOCK_KEY = 784_512_001;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  state: "applied" | "pending";
  appliedAt: Date | null;
}

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  const migrations = files.map((filename) => {
    const match = FILE_PATTERN.exec(filename);

    if (!match) {
      throw new Error(`Migration file "${filename}" must be named NNNN_description.sql (lowercase).`);
    }

    // Line endings are normalised so a checkout on another OS does not change the checksum.
    const sql = readFileSync(path.join(dir, filename), "utf8").replace(/\r\n/g, "\n");

    return {
      version: match[1] as string,
      name: match[2] as string,
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  });

  const versions = new Set<string>();

  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}.`);
    }
    versions.add(migration.version);
  }

  return migrations;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

/**
 * Applies pending migrations in version order, each inside its own transaction.
 * Already-applied migrations are never re-run. A changed or missing applied
 * migration, or a pending migration older than an applied one, stops the run.
 */
export async function runMigrations(
  pool: Pool,
  options: { dir?: string; schema?: string | null; dryRun?: boolean; log?: (message: string) => void } = {}
): Promise<{ applied: string[]; status: MigrationStatus[] }> {
  const log = options.log ?? (() => {});
  const migrations = loadMigrationFiles(options.dir);
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    try {
      if (options.schema && !options.dryRun) {
        // The schema name is validated as an identifier in config/database.ts.
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
      }

      const tracking = await client.query<{ exists: boolean }>(
        "SELECT to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS exists"
      );
      const trackingExists = tracking.rows[0]?.exists ?? false;

      if (!trackingExists && !options.dryRun) {
        await client.query(`
          CREATE TABLE schema_migrations (
            version    text        PRIMARY KEY,
            name       text        NOT NULL,
            checksum   text        NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `);
      }

      const appliedRows =
        trackingExists || !options.dryRun
          ? (await client.query<AppliedRow>("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version"))
              .rows
          : [];
      const applied = new Map(appliedRows.map((row) => [row.version, row]));

      for (const row of appliedRows) {
        const file = migrations.find((migration) => migration.version === row.version);

        if (!file) {
          throw new Error(`Applied migration ${row.version}_${row.name} has no file in the migrations folder.`);
        }
        if (file.checksum !== row.checksum) {
          throw new Error(
            `Migration ${file.filename} was changed after it was applied. ` +
              "Applied migrations must not be edited; add a new migration instead."
          );
        }
      }

      const lastApplied = appliedRows.at(-1)?.version ?? "";
      const pending = migrations.filter((migration) => !applied.has(migration.version));

      for (const migration of pending) {
        if (migration.version < lastApplied) {
          throw new Error(
            `Migration ${migration.filename} is older than the last applied migration (${lastApplied}). ` +
              "New migrations must use a higher number."
          );
        }
      }

      const newlyApplied: string[] = [];

      if (!options.dryRun) {
        for (const migration of pending) {
          log(`Applying ${migration.filename} ...`);
          await client.query("BEGIN");

          try {
            await client.query(migration.sql);
            await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
              migration.version,
              migration.name,
              migration.checksum,
            ]);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            const reason = error instanceof Error ? error.message : "Unknown error";
            throw new Error(`Migration ${migration.filename} failed and was rolled back: ${reason}`);
          }

          newlyApplied.push(migration.filename);
        }
      }

      const status: MigrationStatus[] = migrations.map((migration) => {
        const row = applied.get(migration.version);
        const justApplied = newlyApplied.includes(migration.filename);

        return {
          version: migration.version,
          name: migration.name,
          state: row || justApplied ? "applied" : "pending",
          appliedAt: row?.applied_at ?? null,
        };
      });

      return { applied: newlyApplied, status };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
