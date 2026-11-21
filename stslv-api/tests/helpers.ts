import { createServer, type RequestListener, type Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll } from "vitest";
import { createApp } from "../src/app";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { hashPassword } from "../src/modules/auth/password";
import { permissionsVersionOf } from "../src/modules/roles/roles.service";
import type { Action, Module } from "../src/shared/permissions";
import { BUILT_IN_ROLE_NAMES, LEGACY_ROLE_NAMES } from "../src/shared/role-names";
import { restoreSeededFrequencies } from "./frequency-fixtures";

export const app = createApp();

// Test servers listen on 127.0.0.1 explicitly, and supertest is handed the running server. Left to itself, supertest
// listens on a random port on every address ("::") and connects to 127.0.0.1; on macOS a port another program holds
// on 127.0.0.1 alone can still be taken that way, and the request reaches that program instead (a stray 404 or 400
// with an empty body, or a hang). That failed a few random tests on every full run. tests/setup-loopback.ts refuses
// the old pattern, so a new test cannot bring it back.
const servers = new Set<Server>();

function listenOnLoopback(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);

  servers.add(server);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

afterAll(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});

/** For an app a test builds itself: `const call = await serve(app); await call().get("/x")`. */
export async function serve(handler: RequestListener): Promise<() => ReturnType<typeof request>> {
  const server = await listenOnLoopback(handler);

  return () => request(server);
}

/**
 * For an app built once per test file (at the top of the file): one server, started before the file's tests.
 * Returns a request factory like api().
 */
export function loopbackApi(handler: RequestListener): () => ReturnType<typeof request> {
  let server: Server | null = null;

  beforeAll(async () => {
    server = await listenOnLoopback(handler);
  });

  return () => {
    if (!server) {
      throw new Error("The test server has not started yet; send requests inside a test or hook.");
    }

    return request(server);
  };
}

/** The application under test. */
export const api = loopbackApi(app);

export const PASSWORD = "Correct-Horse-42";

// The seed migrations, in order. Each is idempotent, so they can be run again after the grants are emptied.
const SEED_MIGRATIONS = ["seed_roles_and_permissions", "seed_historical_data_permission", "seed_services_sales_permission", "seed_page_permissions", "six_role_model", "role_model_refinements", "seed_independent_page_permissions", "seed_invoice_acknowledgement_permissions", "seed_invoice_acknowledgement_defaults"];
const seedSql = SEED_MIGRATIONS.map((name) => loadMigrationFiles().find((migration) => migration.name === name)?.sql ?? "").join("\n");
// Migrations that add a built-in role after the seeds (0120 AMC Renewal). They are not idempotent: resetData
// deletes the role first, so the role is re-added exactly as on a migrated database, with no permissions.
const POST_SEED_MIGRATIONS = ["amc_renewal_role"];
const postSeedSql = POST_SEED_MIGRATIONS.map((name) => loadMigrationFiles().find((migration) => migration.name === name)?.sql ?? "").join("\n");
const seedsFound = [...SEED_MIGRATIONS, ...POST_SEED_MIGRATIONS].every((name) => loadMigrationFiles().some((migration) => migration.name === name));

/**
 * Runs SQL that empties or deletes from activity_logs, which migration 0109 makes append-only. Test schema only.
 * The two protecting triggers are disabled and re-enabled inside one transaction, so no other connection ever
 * sees the table unprotected. This is the same deliberate step an owner would need; the application never takes it.
 */
export async function withAuditLogUnlocked(sql: string, params: unknown[] = []): Promise<void> {
  const client = await pool.connect();

  try {
    const schema = await client.query<{ schema: string }>("SELECT current_schema() AS schema");

    if (schema.rows[0]?.schema !== "stslv_test") {
      throw new Error("Refusing to unlock the audit log: not connected to the stslv_test schema.");
    }

    await client.query("BEGIN");
    await client.query("ALTER TABLE activity_logs DISABLE TRIGGER activity_logs_no_update_delete, DISABLE TRIGGER activity_logs_no_truncate");
    await client.query(sql, params);
    await client.query("ALTER TABLE activity_logs ENABLE TRIGGER activity_logs_no_update_delete, ENABLE TRIGGER activity_logs_no_truncate");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Empties every table and restores the seeded roles and permissions. */
export async function resetData(): Promise<void> {
  const schema = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");

  if (schema.rows[0]?.schema !== "stslv_test" || !seedsFound) {
    throw new Error("Refusing to reset data: not connected to the stslv_test schema.");
  }

  await withAuditLogUnlocked("TRUNCATE activity_logs, clients_all, user_roles, users RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM role_permissions");
  // Role visibility (0123): every role starts showing everything again.
  await pool.query("DELETE FROM role_hidden_items");
  await pool.query(
    "DELETE FROM roles WHERE code NOT IN ('ADMIN', 'ADMINISTRATOR', 'FINANCE_EXECUTIVE', 'MASTER_DATA_EXECUTIVE', 'AMC_OPERATIONS_EXECUTIVE', 'VIEWER', 'ACCOUNTANT', 'PROCUREMENT', 'EXECUTION', 'INVOICING')"
  );
  // Migration 0088 makes the legacy roles inactive. The tests keep them active: their fixed grant
  // sets are what most permission tests sign in with. tests/role-model.test.ts covers 0088 itself.
  await pool.query("UPDATE roles SET is_active = true");
  // Tests may rename a built-in role (Super Admin is allowed to); put the current names back (0087, 0117).
  const names = Object.entries({ ...BUILT_IN_ROLE_NAMES, ...LEGACY_ROLE_NAMES });
  await pool.query(
    `UPDATE roles r SET name = v.name FROM unnest($1::text[], $2::text[]) AS v (code, name) WHERE r.code = v.code AND r.name <> v.name`,
    [names.map(([code]) => code), names.map(([, name]) => name)]
  );
  await pool.query(seedSql);
  // Roles added after the seeds, in migration order: the seeds above grant some modules to every existing role
  // (0092: Suggestions), which a role added later never received. Deleted above, they are added again here.
  await pool.query(postSeedSql);
  // The TRUNCATE above also empties maintenance_frequencies (its created_by refers to users).
  // From migration 0076 contracts refer to its codes, so the seeded rows are put back.
  await restoreSeededFrequencies();
}

/**
 * Runs `test` as on a database where migration 0082 (one role per user) is not applied yet, so a
 * user can hold several roles, as data from before the rule may. Test schema only. Afterwards the
 * extra roles the test left are removed (keeping each user's first) and the constraint is restored.
 */
export async function withoutOneRoleConstraint(test: () => Promise<void>): Promise<void> {
  const schema = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");

  if (schema.rows[0]?.schema !== "stslv_test") {
    throw new Error("Refusing to drop a constraint: not connected to the stslv_test schema.");
  }

  await pool.query("ALTER TABLE user_roles DROP CONSTRAINT user_roles_one_role_uq");
  try {
    await test();
  } finally {
    await pool.query("DELETE FROM user_roles a USING user_roles b WHERE a.user_id = b.user_id AND a.role_id > b.role_id");
    await pool.query("ALTER TABLE user_roles ADD CONSTRAINT user_roles_one_role_uq UNIQUE (user_id)");
  }
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

/** The permissionsVersion a permission save must send: the role's current set, as GET /api/roles reports it. */
export async function permissionsVersion(id: string): Promise<string> {
  const result = await pool.query<{ module: Module; action: Action }>("SELECT module, action FROM role_permissions WHERE role_id = $1", [id]);

  return permissionsVersionOf(result.rows);
}
