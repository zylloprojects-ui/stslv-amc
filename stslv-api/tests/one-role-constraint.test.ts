import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { api, closePool, insertUser, resetData, roleId, signedIn } from "./helpers";

// Migration 0082: the database itself refuses a second role for a user, and
// the migration stops without changing anything while any user holds several.

const MIGRATION = loadMigrationFiles().find((migration) => migration.version === "0082")?.sql as string;
const REVERSE = "ALTER TABLE user_roles DROP CONSTRAINT user_roles_one_role_uq";

beforeEach(resetData);
afterAll(closePool);

const rolesOf = async (userId: string) =>
  (await pool.query<{ code: string }>("SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code", [userId])).rows.map(
    (row) => row.code
  );

const constraintDefinition = async () =>
  (await pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'user_roles_one_role_uq' AND conrelid = 'user_roles'::regclass")).rows[0]?.def;

/** Runs the migration's SQL in a transaction, as the migration runner does: all of it or nothing. */
async function applyMigration(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(MIGRATION);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("migration 0082: one role per user in the database", () => {
  it("is applied after 0080 and 0081, as a unique constraint on the user", async () => {
    const applied = await pool.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version IN ('0080', '0081', '0082') ORDER BY version");

    expect(applied.rows.map((row) => row.version)).toEqual(["0080", "0081", "0082"]);
    expect(await constraintDefinition()).toBe("UNIQUE (user_id)");
  });

  it("refuses a second role written directly to the database, and keeps the first", async () => {
    const userId = await insertUser({ email: "direct@example.com", roles: ["EXECUTION"] });

    await expect(pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, await roleId("ADMIN")])).rejects.toMatchObject({
      code: "23505",
      constraint: "user_roles_one_role_uq",
    });
    expect(await rolesOf(userId)).toEqual(["EXECUTION"]);
  });

  it("still lets an administrator replace a user's role through the API", async () => {
    const admin = await signedIn("admin@example.com", ["ADMIN"]);
    const userId = await insertUser({ email: "replace@example.com", roles: ["EXECUTION"] });

    const response = await api().put(`/api/users/${userId}/roles`).set(admin.headers).send({ roleIds: [await roleId("INVOICING")] });

    expect(response.status).toBe(200);
    expect(await rolesOf(userId)).toEqual(["INVOICING"]);
  });

  it("stops without changing anything while a user holds several roles, and applies once one role is chosen", async () => {
    const admin = await signedIn("admin@example.com", ["ADMIN"]);
    await pool.query(REVERSE);

    try {
      const userId = await insertUser({ email: "several@example.com", roles: ["ACCOUNTANT", "INVOICING"] });

      await expect(applyMigration()).rejects.toThrow("0082: 1 user(s) hold more than one role. Choose one role for each in Users & Access, then apply 0082 again. Nothing was changed.");
      // Nothing removed, and no constraint half-made.
      expect(await rolesOf(userId)).toEqual(["ACCOUNTANT", "INVOICING"]);
      expect(await constraintDefinition()).toBeUndefined();

      // An administrator chooses one role; then the migration goes through.
      expect((await api().put(`/api/users/${userId}/roles`).set(admin.headers).send({ roleIds: [await roleId("INVOICING")] })).status).toBe(200);
      await applyMigration();

      expect(await constraintDefinition()).toBe("UNIQUE (user_id)");
      expect(await rolesOf(userId)).toEqual(["INVOICING"]);
    } finally {
      // Leave the test schema as the migrations built it, whatever happened above.
      if (!(await constraintDefinition())) {
        await pool.query("DELETE FROM user_roles a USING user_roles b WHERE a.user_id = b.user_id AND a.role_id > b.role_id");
        await pool.query("ALTER TABLE user_roles ADD CONSTRAINT user_roles_one_role_uq UNIQUE (user_id)");
      }
    }
  });

  it("can be reversed with the documented statement and applied again, keeping every assignment", async () => {
    const userId = await insertUser({ email: "reverse@example.com", roles: ["EXECUTION"] });

    await pool.query(REVERSE);
    expect(await constraintDefinition()).toBeUndefined();
    expect(await rolesOf(userId)).toEqual(["EXECUTION"]);

    await applyMigration();
    expect(await constraintDefinition()).toBe("UNIQUE (user_id)");
    expect(await rolesOf(userId)).toEqual(["EXECUTION"]);
  });
});
