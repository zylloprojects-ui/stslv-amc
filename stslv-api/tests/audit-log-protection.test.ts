import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { logActivity } from "../src/shared/activity-log";
import { closePool, insertUser, loginToken, resetData, withAuditLogUnlocked } from "./helpers";

// Migration 0109: the Audit Log (activity_logs) is append-only. Inserts work as before; UPDATE, DELETE and
// TRUNCATE are refused by the database whoever sends them.

beforeEach(async () => {
  await resetData();
});

afterAll(async () => {
  await closePool();
});

const count = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_logs")).rows[0]?.n ?? 0;

describe("activity_logs is append-only", () => {
  it("still records entries written by the application", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const before = await count();

    await loginToken("ana@example.com");
    await logActivity(pool, { userId: null, action: "test.entry", module: "TEST", entityType: "users", entityId: null, description: "Inserted by a test." });

    expect(await count()).toBe(before + 2);
  });

  it("refuses UPDATE, DELETE and TRUNCATE, even of no row, and leaves every entry unchanged", async () => {
    await logActivity(pool, { userId: null, action: "test.entry", module: "TEST", entityType: "users", entityId: null, description: "Original text." });
    const before = await pool.query("SELECT id, action, description, created_at FROM activity_logs ORDER BY id");

    for (const sql of [
      "UPDATE activity_logs SET description = 'rewritten'",
      "UPDATE activity_logs SET description = 'rewritten' WHERE false",
      "DELETE FROM activity_logs",
      "DELETE FROM activity_logs WHERE action = 'no-such-action'",
      "TRUNCATE activity_logs",
    ]) {
      await expect(pool.query(sql), sql).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("append-only") });
    }

    // A cascade from another table reaches the audit log the same way and is refused too.
    await expect(pool.query("TRUNCATE users CASCADE")).rejects.toMatchObject({ code: "42501" });

    expect((await pool.query("SELECT id, action, description, created_at FROM activity_logs ORDER BY id")).rows).toEqual(before.rows);
  });

  it("the protection is restored after the tests' own maintenance helper", async () => {
    await withAuditLogUnlocked("DELETE FROM activity_logs WHERE action = 'nothing'");

    await expect(pool.query("DELETE FROM activity_logs")).rejects.toMatchObject({ code: "42501" });
    const triggers = await pool.query<{ tgname: string; tgenabled: string }>(
      "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'activity_logs'::regclass AND NOT tgisinternal ORDER BY tgname"
    );
    expect(triggers.rows).toEqual([
      { tgname: "activity_logs_no_truncate", tgenabled: "O" },
      { tgname: "activity_logs_no_update_delete", tgenabled: "O" },
    ]);
  });
});
