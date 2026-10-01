import "dotenv/config";
import { Pool } from "pg";

// Must be present and non-empty.
const REQUIRED_DB_ENV_VARS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER"] as const;

function readDatabaseConfig() {
  const missing: string[] = REQUIRED_DB_ENV_VARS.filter(
    (name) => !process.env[name]?.trim()
  );

  // DB_PASSWORD must be defined, but may be blank until it is entered in .env.
  if (process.env.DB_PASSWORD === undefined) {
    missing.push("DB_PASSWORD");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required database environment variable(s): ${missing.join(", ")}. ` +
        "Set them in stslv-api/.env (see .env.example)."
    );
  }

  const port = Number(process.env.DB_PORT);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid database environment variable: DB_PORT must be a port number between 1 and 65535.");
  }

  // Optional. When set, every connection uses this PostgreSQL schema instead of
  // "public". Used by the automated tests to keep their data apart from
  // development data inside the same database.
  const schema = process.env.DB_SCHEMA?.trim() || null;

  if (schema !== null && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error("Invalid database environment variable: DB_SCHEMA must be a lowercase PostgreSQL identifier.");
  }

  return {
    host: process.env.DB_HOST,
    port,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema,
  };
}

const { schema, ...databaseConfig } = readDatabaseConfig();

export const isDatabasePasswordSet = databaseConfig.password !== "";

// Null means the default "public" schema.
export const databaseSchema = schema;

// Single shared pool for the whole API. Import this instead of creating new pools.
export const pool = new Pool({
  ...databaseConfig,
  ...(schema ? { options: `-c search_path=${schema}` } : {}),
});

// Errors on idle clients must not crash the process.
pool.on("error", (error) => {
  console.error(`Unexpected PostgreSQL pool error: ${error.message}`);
});

export interface DatabaseHealth {
  currentTime: Date;
  databaseName: string;
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const result = await pool.query<{ current_time: Date; database_name: string }>(
    "SELECT NOW() AS current_time, current_database() AS database_name"
  );
  const row = result.rows[0];

  if (!row) {
    throw new Error("Database health check returned no rows.");
  }

  return {
    currentTime: row.current_time,
    databaseName: row.database_name,
  };
}
