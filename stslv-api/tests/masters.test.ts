import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { requireSchema } from "../src/middleware/require-schema";
import { errorHandler } from "../src/shared/errors";
import { activeContract, createClient, logsFor } from "./amc-helpers";
import { api, closePool, insertUser, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// Master lists (departments, sales engineers, system types) and the optional
// link from an AMC contract to them (migration 0070). Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let procurement: Session;

const post = (path: string, body: Record<string, unknown>, session: Session = admin) =>
  api().post(`/api/masters/${path}`).set(session.headers).send(body);

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
});
afterAll(closePool);

describe("departments", () => {
  it("creates, lists, edits and deactivates a department, recording each change", async () => {
    const created = await post("departments", { code: "AMC", name: "AMC Operations", description: "Maintenance team" });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: "AMC", name: "AMC Operations", isActive: true, engineerCount: 0 });

    const id = created.body.data.id as string;
    const edited = await api().patch(`/api/masters/departments/${id}`).set(admin.headers).send({ name: "AMC Team" });
    expect(edited.body.data.name).toBe("AMC Team");

    const deactivated = await api().post(`/api/masters/departments/${id}/status`).set(admin.headers).send({ isActive: false });
    expect(deactivated.body.data.isActive).toBe(false);

    const list = await api().get("/api/masters/departments").query({ status: "inactive" }).set(admin.headers);
    expect(list.body.data.items.map((item: { id: string }) => item.id)).toEqual([id]);

    const logs = await logsFor("departments", id);
    expect(logs.map((log) => log.action)).toEqual(["department.created", "department.updated", "department.deactivated"]);
    expect(logs[1]?.metadata).toEqual({ changes: { name: { from: "AMC Operations", to: "AMC Team" } } });

    await api().post(`/api/masters/departments/${id}/status`).set(admin.headers).send({ isActive: true });
  });

  it("refuses a duplicate code in any letter case and validates the fields", async () => {
    await post("departments", { code: "FIN", name: "Finance" });

    const duplicate = await post("departments", { code: "fin ", name: "Finance two" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details).toEqual([{ field: "code", message: 'A department with code "fin" already exists.' }]);

    expect((await post("departments", { code: "", name: "No code" })).status).toBe(400);
    expect((await post("departments", { code: "BAD<code>", name: "Bad" })).status).toBe(400);
    expect((await post("departments", { code: "X", name: "X", extra: 1 })).status).toBe(400);
  });

  it("has no delete route", async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM departments LIMIT 1");

    expect((await api().delete(`/api/masters/departments/${rows[0]?.id}`).set(admin.headers)).status).toBe(404);
  });
});

describe("system types", () => {
  it("lists by sort order and searches by code or name", async () => {
    await post("system-types", { code: "FIRE", name: "Fire alarm", sortOrder: 2 });
    await post("system-types", { code: "CCTV", name: "CCTV", sortOrder: 1 });

    const list = await api().get("/api/masters/system-types").set(admin.headers);
    expect(list.body.data.items.map((item: { code: string }) => item.code)).toEqual(["CCTV", "FIRE"]);

    const searched = await api().get("/api/masters/system-types").query({ search: "alarm" }).set(admin.headers);
    expect(searched.body.data.items.map((item: { code: string }) => item.code)).toEqual(["FIRE"]);
    expect((await post("system-types", { code: "NEG", name: "Negative", sortOrder: -1 })).status).toBe(400);
  });
});

describe("sales engineers", () => {
  it("links an engineer to an active department and a user, and refuses an inactive department", async () => {
    const department = (await post("departments", { code: "SALES", name: "Sales" })).body.data.id as string;
    const userId = await insertUser({ email: "engineer@example.com", fullName: "Field Engineer" });

    const created = await post("sales-engineers", { name: "Test Engineer", employeeNo: "E-001", email: "engineer@example.com", departmentId: department, userId });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: "Test Engineer",
      employeeNo: "E-001",
      department: { id: department, code: "SALES" },
      user: { id: userId, fullName: "Field Engineer" },
      contractCount: 0,
    });

    await api().post(`/api/masters/departments/${department}/status`).set(admin.headers).send({ isActive: false });
    const refused = await post("sales-engineers", { name: "Second Engineer", departmentId: department });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].field).toBe("departmentId");

    // The first engineer keeps its link to the now inactive department.
    const kept = await api().patch(`/api/masters/sales-engineers/${created.body.data.id}`).set(admin.headers).send({ phone: "123" });
    expect(kept.status).toBe(200);
    expect(kept.body.data.department.id).toBe(department);
  });

  it("refuses a second engineer for the same user or employee number", async () => {
    const existing = (await api().get("/api/masters/sales-engineers").set(admin.headers)).body.data.items[0];

    expect((await post("sales-engineers", { name: "Other", userId: existing.user.id })).status).toBe(409);
    expect((await post("sales-engineers", { name: "Other", employeeNo: "e-001" })).status).toBe(409);
    expect((await post("sales-engineers", { name: "Other", email: "not-an-email" })).status).toBe(400);
    expect((await post("sales-engineers", { name: "Other", userId: "999999" })).status).toBe(400);
  });
});

describe("master permissions", () => {
  it("lets contract viewers read the lists and only Settings editors change them", async () => {
    expect((await api().get("/api/masters/sales-engineers").set(execution.headers)).status).toBe(200);
    expect((await api().get("/api/masters/system-types/options").set(execution.headers)).status).toBe(200);
    expect((await post("system-types", { code: "AUTO", name: "Automation" }, execution)).status).toBe(403);
    expect((await api().get("/api/masters/departments").set(procurement.headers)).status).toBe(403);
    expect((await api().get("/api/masters/departments")).status).toBe(401);
  });

  it("offers only active records for picking", async () => {
    const options = (await api().get("/api/masters/departments/options").set(admin.headers)).body.data as { isActive: boolean }[];

    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.isActive)).toBe(true);
  });
});

describe("contract links to master records", () => {
  let contractId: string;
  let engineerId: string;
  let typeId: string;

  beforeAll(async () => {
    const clientId = await createClient(admin, "Link Test Client");
    contractId = await activeContract(admin, clientId, { responsibleEngineer: "Typed Engineer", systemDescription: "Typed system" });
    engineerId = (await post("sales-engineers", { name: "Linked Engineer" })).body.data.id as string;
    typeId = (await api().get("/api/masters/system-types").query({ search: "CCTV" }).set(admin.headers)).body.data.items[0].id as string;
  });

  it("starts unlinked and links without touching the contract's own fields", async () => {
    expect((await api().get(`/api/amc/contracts/${contractId}/masters`).set(admin.headers)).body.data).toEqual({ salesEngineer: null, systemType: null });

    const before = (await api().get(`/api/amc/contracts/${contractId}`).set(admin.headers)).body.data;
    const linked = await api().put(`/api/amc/contracts/${contractId}/masters`).set(admin.headers).send({ salesEngineerId: engineerId, systemTypeId: typeId });

    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ salesEngineer: { id: engineerId, name: "Linked Engineer" }, systemType: { id: typeId, code: "CCTV" } });

    const after = (await api().get(`/api/amc/contracts/${contractId}`).set(admin.headers)).body.data;
    expect(after.responsibleEngineer).toBe("Typed Engineer");
    expect(after.systemDescription).toBe("Typed system");
    expect(after.schedule).toEqual(before.schedule);
  });

  it("records the change in the contract history by name, and counts the link on the master", async () => {
    const history = (await api().get(`/api/amc/contracts/${contractId}/history`).set(admin.headers)).body.data.items;
    const entry = history.find((item: { action: string }) => item.action === "amc_contract.masters_linked");

    expect(entry.changes).toEqual({ salesEngineer: { from: null, to: "Linked Engineer" }, systemType: { from: null, to: "CCTV — CCTV" } });
    expect((await api().get(`/api/masters/sales-engineers/${engineerId}`).set(admin.headers)).body.data.contractCount).toBe(1);
  });

  it("removes a link with null and refuses an inactive master", async () => {
    const cleared = await api().put(`/api/amc/contracts/${contractId}/masters`).set(admin.headers).send({ systemTypeId: null });
    expect(cleared.body.data.systemType).toBeNull();
    expect(cleared.body.data.salesEngineer.id).toBe(engineerId);

    await api().post(`/api/masters/system-types/${typeId}/status`).set(admin.headers).send({ isActive: false });
    const refused = await api().put(`/api/amc/contracts/${contractId}/masters`).set(admin.headers).send({ systemTypeId: typeId });
    expect(refused.status).toBe(400);
    expect((await api().put(`/api/amc/contracts/${contractId}/masters`).set(admin.headers).send({})).status).toBe(400);
  });

  it("needs contract edit permission to change links", async () => {
    expect((await api().get(`/api/amc/contracts/${contractId}/masters`).set(execution.headers)).status).toBe(200);
    expect((await api().put(`/api/amc/contracts/${contractId}/masters`).set(execution.headers).send({ salesEngineerId: null })).status).toBe(403);
    expect((await api().get("/api/amc/contracts/999999/masters").set(admin.headers)).status).toBe(404);
  });
});

describe("requireSchema", () => {
  it("answers 503 FEATURE_UNAVAILABLE while a feature's table is missing", async () => {
    const app = express();
    app.get("/feature", requireSchema(["table_that_does_not_exist"]), (_req, res) => res.json({ success: true }));
    app.get("/ready", requireSchema(["clients"]), (_req, res) => res.json({ success: true }));
    app.use(errorHandler);

    const missing = await request(app).get("/feature");
    expect(missing.status).toBe(503);
    expect(missing.body.error.code).toBe("FEATURE_UNAVAILABLE");
    expect((await request(app).get("/ready")).status).toBe(200);
  });
});
