import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { hashPassword } from "../src/modules/auth/password";

export const app = createApp();
export const api = () => request(app);

export const PASSWORD = "Correct-Horse-42";

// The seed migrations, in order. Each is idempotent, so they can be run again after the grants are emptied.
const SEED_MIGRATIONS = ["seed_roles_and_permissions", "seed_historical_data_permission"];
const seedSql = SEED_MIGRATIONS.map((name) => loadMigrationFiles().find((migration) => migration.name === name)?.sql ?? "").join("\n");
const seedsFound = SEED_MIGRATIONS.every((name) => loadMigrationFiles().some((migration) => migration.name === name));

/** Empties every table and restores the seeded roles and permissions. */
export async function resetData(): Promise<void> {
  const schema = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");

  if (schema.rows[0]?.schema !== "stslv_test" || !seedsFound) {
    throw new Error("Refusing to reset data: not connected to the stslv_test schema.");
  }

  await pool.query("TRUNCATE activity_logs, clients, user_roles, users RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM role_permissions");
  await pool.query("DELETE FROM roles WHERE code NOT IN ('ADMIN', 'ACCOUNTANT', 'PROCUREMENT', 'EXECUTION', 'INVOICING')");
  await pool.query("UPDATE roles SET is_active = true");
  await pool.query(seedSql);
}

/** Inserts a user directly, bypassing the API. Returns the new id. */
export async function insertUser(options: {
  email: string;
  fullName?: string;
  roles?: string[];
  isActive?: boolean;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO users (email, full_name, password_hash, is_active) VALUES ($1, $2, $3, $4) RETURNING id",
    [options.email, options.fullName ?? options.email, await hashPassword(PASSWORD), options.isActive ?? true]
  );
  const id = (result.rows[0] as { id: string }).id;

  await pool.query(
    "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = ANY($2::text[])",
    [id, options.roles ?? []]
  );

  return id;
}

export async function loginToken(email: string, password = PASSWORD): Promise<string> {
  const response = await api().post("/api/auth/login").send({ email, password });

  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${response.status}`);
  }

  return response.body.data.token as string;
}

/** Creates a user with the given roles and returns an Authorization header for them. */
export async function signedIn(email: string, roles: string[]): Promise<{ id: string; headers: { Authorization: string } }> {
  const id = await insertUser({ email, roles });

  return { id, headers: bearer(await loginToken(email)) };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function roleId(code: string): Promise<string> {
  const result = await pool.query<{ id: string }>("SELECT id FROM roles WHERE code = $1", [code]);

  return (result.rows[0] as { id: string }).id;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
