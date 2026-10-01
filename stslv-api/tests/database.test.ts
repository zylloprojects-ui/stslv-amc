import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles, MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";
import { ACTIONS, MODULES } from "../src/shared/permissions";
import { closePool, insertUser, resetData } from "./helpers";

beforeAll(resetData);
afterAll(closePool);

describe("migrations", () => {
  it("creates exactly the foundation tables", async () => {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name"
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "activity_logs",
      "clients",
      "role_permissions",
      "roles",
      "schema_migrations",
      "user_roles",
      "users",
    ]);
  });

  it("records every migration file as applied", async () => {
    const result = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");

    expect(result.rows.map((row) => row.version)).toEqual(loadMigrationFiles().map((migration) => migration.version));
  });

  it("does not re-run applied migrations", async () => {
    const result = await runMigrations(pool, { schema: "stslv_test" });

    expect(result.applied).toEqual([]);
    expect(result.status.every((migration) => migration.state === "applied")).toBe(true);
  });

  it("refuses to run when an applied migration file has been edited", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stslv-migrations-"));

    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      const file = path.join(dir, "0003_clients.sql");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n-- edited after being applied\n`);

      await expect(runMigrations(pool, { dir, schema: "stslv_test" })).rejects.toThrow(/changed after it was applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a new migration numbered below the last applied one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "stslv-migrations-"));

    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(path.join(dir, "0000_too_early.sql"), "SELECT 1;\n");

      await expect(runMigrations(pool, { dir, schema: "stslv_test" })).rejects.toThrow(/older than the last applied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("seed data", () => {
  it("seeds the five initial roles", async () => {
    const result = await pool.query<{ code: string }>("SELECT code FROM roles ORDER BY id");

    expect(result.rows.map((row) => row.code)).toEqual(["ADMIN", "ACCOUNTANT", "PROCUREMENT", "EXECUTION", "INVOICING"]);
  });

  it("gives ADMIN every module and action", async () => {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'ADMIN'`
    );

    expect(result.rows[0]?.count).toBe(MODULES.length * ACTIONS.length);
  });

  it("is idempotent: running the seed again changes nothing", async () => {
    const count = async () =>
      (await pool.query<{ roles: number; permissions: number }>(
        "SELECT (SELECT count(*)::int FROM roles) AS roles, (SELECT count(*)::int FROM role_permissions) AS permissions"
      )).rows[0];
    const before = await count();
    const seed = loadMigrationFiles().find((migration) => migration.name === "seed_roles_and_permissions");

    await pool.query(seed?.sql ?? "");

    expect(await count()).toEqual(before);
  });
});

describe("constraints", () => {
  it("rejects a second user with the same email in different letter case", async () => {
    await insertUser({ email: "case@example.com" });

    await expect(insertUser({ email: "CASE@example.com" })).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a duplicate role assignment", async () => {
    const id = await insertUser({ email: "dup-role@example.com", roles: ["ACCOUNTANT"] });

    await expect(
      pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'ACCOUNTANT'", [id])
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a duplicate role code", async () => {
    await expect(pool.query("INSERT INTO roles (code, name) VALUES ('ADMIN', 'Again')")).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("rejects an unknown permission module or action", async () => {
    await expect(
      pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, 'PAYROLL', 'VIEW' FROM roles WHERE code = 'ADMIN'")
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, 'CLIENTS', 'DESTROY' FROM roles WHERE code = 'ADMIN'")
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires a client name and rejects the same name in different case or spacing", async () => {
    await expect(pool.query("INSERT INTO clients (name) VALUES ('   ')")).rejects.toMatchObject({ code: "23514" });

    await pool.query("INSERT INTO clients (name) VALUES ('IBIS')");
    await expect(pool.query("INSERT INTO clients (name) VALUES (' ibis ')")).rejects.toMatchObject({ code: "23505" });
  });

  it("does not treat similarly spelled client names as the same client", async () => {
    await pool.query("INSERT INTO clients (name) VALUES ('HOLIDAY INN'), ('HOLIDAYINN')");

    const result = await pool.query("SELECT 1 FROM clients WHERE name IN ('HOLIDAY INN', 'HOLIDAYINN')");
    expect(result.rowCount).toBe(2);
  });

  it("does not allow a user referenced by other records to be deleted", async () => {
    const id = await insertUser({ email: "referenced@example.com", roles: ["ACCOUNTANT"] });

    await expect(pool.query("DELETE FROM users WHERE id = $1", [id])).rejects.toMatchObject({ code: "23503" });
  });

  it("maintains updated_at automatically", async () => {
    const inserted = await pool.query<{ id: string; updated_at: Date }>(
      "INSERT INTO clients (name, updated_at) VALUES ('Trigger Test', now() - interval '1 day') RETURNING id, updated_at"
    );
    const row = inserted.rows[0] as { id: string; updated_at: Date };
    const updated = await pool.query<{ updated_at: Date }>(
      "UPDATE clients SET notes = 'changed' WHERE id = $1 RETURNING updated_at",
      [row.id]
    );

    expect(updated.rows[0]?.updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
  });
});
