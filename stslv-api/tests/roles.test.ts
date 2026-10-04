import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, insertUser, resetData, roleId, signedIn } from "./helpers";

let admin: Awaited<ReturnType<typeof signedIn>>;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("departments (roles): add, edit, delete", () => {
  it("adds a department with no permissions and logs it", async () => {
    const response = await api().post("/api/roles").set(admin.headers).send({ code: "workshop", name: "Workshop", description: "Fabrication and repairs." });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ code: "WORKSHOP", name: "Workshop", description: "Fabrication and repairs.", isActive: true, userCount: 0, permissions: [] });

    const log = await pool.query("SELECT user_id FROM activity_logs WHERE action = 'role.created' AND entity_id = $1", [response.body.data.id]);
    expect(log.rows).toEqual([{ user_id: admin.id }]);
  });

  it("rejects a duplicate code or name, and an invalid code", async () => {
    expect((await api().post("/api/roles").set(admin.headers).send({ code: "WORKSHOP", name: "Another" })).status).toBe(409);
    expect((await api().post("/api/roles").set(admin.headers).send({ code: "OTHER", name: "workshop" })).status).toBe(409);
    expect((await api().post("/api/roles").set(admin.headers).send({ code: "1bad code", name: "X" })).status).toBe(400);
    expect((await api().post("/api/roles").set(admin.headers).send({ code: "NONAME", name: "  " })).status).toBe(400);
  });

  it("edits the name, description and status, but never the code", async () => {
    const id = await roleId("WORKSHOP");
    const response = await api().patch(`/api/roles/${id}`).set(admin.headers).send({ name: "Workshop team", description: "", isActive: false });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ code: "WORKSHOP", name: "Workshop team", description: null, isActive: false });
    expect((await api().patch(`/api/roles/${id}`).set(admin.headers).send({ code: "CHANGED" })).status).toBe(400);
    expect((await api().patch(`/api/roles/${id}`).set(admin.headers).send({})).status).toBe(400);
  });

  it("will not give a department the name of another one", async () => {
    const id = await roleId("WORKSHOP");

    expect((await api().patch(`/api/roles/${id}`).set(admin.headers).send({ name: "accountant" })).status).toBe(409);
  });

  it("will not deactivate or delete a department that people still hold", async () => {
    await insertUser({ email: "exec@example.com", roles: ["EXECUTION"] });
    const id = await roleId("EXECUTION");

    expect((await api().patch(`/api/roles/${id}`).set(admin.headers).send({ isActive: false })).status).toBe(409);
    expect((await api().delete(`/api/roles/${id}`).set(admin.headers)).status).toBe(409);
    expect((await pool.query("SELECT 1 FROM roles WHERE id = $1", [id])).rowCount).toBe(1);
  });

  it("protects the Admin department", async () => {
    const id = await roleId("ADMIN");

    expect((await api().patch(`/api/roles/${id}`).set(admin.headers).send({ isActive: false })).status).toBe(403);
    expect((await api().delete(`/api/roles/${id}`).set(admin.headers)).status).toBe(403);
  });

  it("deletes an unused department together with its permissions, and logs it", async () => {
    const id = await roleId("WORKSHOP");
    await pool.query("INSERT INTO role_permissions (role_id, module, action) VALUES ($1, 'DASHBOARD', 'VIEW')", [id]);

    const response = await api().delete(`/api/roles/${id}`).set(admin.headers);

    expect(response.status).toBe(200);
    expect((await pool.query("SELECT 1 FROM roles WHERE id = $1", [id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM role_permissions WHERE role_id = $1", [id])).rowCount).toBe(0);
    const log = await pool.query("SELECT metadata FROM activity_logs WHERE action = 'role.deleted' AND entity_id = $1", [id]);
    expect(log.rows).toEqual([{ metadata: { code: "WORKSHOP", permissionsRemoved: 1 } }]);
    expect((await api().delete(`/api/roles/${id}`).set(admin.headers)).status).toBe(404);
  });

  it("is for people who hold the matching permission only", async () => {
    const accountant = await signedIn("acc@example.com", ["ACCOUNTANT"]);
    const id = await roleId("PROCUREMENT");

    expect((await api().post("/api/roles").set(accountant.headers).send({ code: "NEWDEPT", name: "New" })).status).toBe(403);
    expect((await api().patch(`/api/roles/${id}`).set(accountant.headers).send({ name: "X" })).status).toBe(403);
    expect((await api().delete(`/api/roles/${id}`).set(accountant.headers)).status).toBe(403);
    expect((await api().post("/api/roles").send({ code: "NEWDEPT", name: "New" })).status).toBe(401);
  });
});
