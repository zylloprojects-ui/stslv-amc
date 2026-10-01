import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, signedIn } from "./helpers";
import {
  insertClient,
  logsFor,
  newProject,
  postProcurement,
  resetProjectData,
  setStatus,
  today,
  type Session,
} from "./projects-helpers";

let admin: Session;
let clientId: string;
let project: Awaited<ReturnType<typeof newProject>>;

beforeEach(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await insertClient("IBIS");
  project = await newProject(admin, clientId, { jobValue: "1000" });
});
afterAll(closePool);

const get = (path: string, session: Session = admin) => api().get(path).set(session.headers);
const patch = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().patch(`/api/procurement/${id}`).set(session.headers).send(body);
const changeStatus = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().post(`/api/procurement/${id}/status`).set(session.headers).send(body);

async function newRequest(overrides: Record<string, unknown> = {}, session: Session = admin) {
  const response = await postProcurement(session, {
    projectId: project.id,
    description: "Smoke detectors x 20",
    requestDate: "2026-09-05",
    ...overrides,
  });

  if (response.status !== 201) {
    throw new Error(`Procurement request was not created: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return response.body.data as Record<string, string | null> & { id: string };
}

describe("create procurement request", () => {
  it("saves the request against its project and records who created it", async () => {
    const response = await postProcurement(admin, {
      projectId: project.id,
      reference: "PR-01",
      description: "  Fire alarm panel  ",
      requestDate: "2026-09-05",
      supplierName: "Test Supplier LLC",
      quotationReference: "Q-2026-118",
      quotationDate: "2026-09-07",
      quotationAmount: "412.5",
      expectedDeliveryDate: "2026-09-20",
      notes: "",
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      projectId: project.id,
      jobNumber: "GPSA0001",
      clientName: "IBIS",
      reference: "PR-01",
      description: "Fire alarm panel",
      requestDate: "2026-09-05",
      supplierName: "Test Supplier LLC",
      quotationReference: "Q-2026-118",
      quotationDate: "2026-09-07",
      quotationAmount: "412.500",
      poReference: null,
      orderDate: null,
      expectedDeliveryDate: "2026-09-20",
      deliveredDate: null,
      status: "REQUESTED",
      notes: null,
    });

    const stored = await pool.query("SELECT project_id, quotation_amount, created_by FROM procurement_requests WHERE id = $1", [
      response.body.data.id,
    ]);
    expect(stored.rows[0]).toEqual({ project_id: project.id, quotation_amount: "412.500", created_by: admin.id });

    expect(await logsFor("procurement_requests", response.body.data.id)).toMatchObject([
      { action: "procurement.created", user_id: admin.id, module: "PROCUREMENT", metadata: { jobNumber: "GPSA0001" } },
    ]);
  });

  it("needs only a project, a requirement and a request date", async () => {
    const request = await newRequest();

    expect(request).toMatchObject({ supplierName: null, quotationAmount: null, status: "REQUESTED" });
  });

  it("rejects invalid data with field-level messages", async () => {
    const missing = await postProcurement(admin, {});
    const badAmount = await postProcurement(admin, { projectId: project.id, description: "Item", requestDate: "2026-09-05", quotationAmount: "12.3456" });
    const numberAmount = await postProcurement(admin, { projectId: project.id, description: "Item", requestDate: "2026-09-05", quotationAmount: 12.5 });
    const badDate = await postProcurement(admin, { projectId: project.id, description: "Item", requestDate: "05/09/2026" });
    const ownStatus = await postProcurement(admin, { projectId: project.id, description: "Item", requestDate: "2026-09-05", status: "DELIVERED" });

    for (const response of [missing, badAmount, numberAmount, badDate, ownStatus]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(missing.body.error.details).toEqual(
      expect.arrayContaining([
        { field: "projectId", message: "Project is required." },
        { field: "description", message: "Requirement is required." },
        { field: "requestDate", message: "Request date is required." },
      ])
    );
  });

  it("must belong to an existing project that is not cancelled", async () => {
    const cancelled = await newProject(admin, clientId);
    await setStatus(admin, cancelled.id, { status: "CANCELLED" });

    const unknown = await postProcurement(admin, { projectId: "999999", description: "Item", requestDate: "2026-09-05" });
    const closed = await postProcurement(admin, { projectId: cancelled.id, description: "Item", requestDate: "2026-09-05" });

    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([{ field: "projectId", message: "The selected project does not exist." }]);
    expect(closed.status).toBe(400);
    expect(closed.body.error.details[0].field).toBe("projectId");
    expect((await pool.query("SELECT 1 FROM procurement_requests")).rowCount).toBe(0);
  });

  it("is tied to its project by the database", async () => {
    await newRequest();

    await expect(
      pool.query("INSERT INTO procurement_requests (project_id, description, request_date) VALUES (999999, 'Orphan', '2026-01-01')")
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("INSERT INTO procurement_requests (description, request_date) VALUES ('No project', '2026-01-01')")
    ).rejects.toMatchObject({ code: "23502" });
    // A project that has procurement cannot be removed from under it.
    await expect(pool.query("DELETE FROM projects WHERE id = $1", [project.id])).rejects.toMatchObject({ code: "23503" });
  });

  it("does not count a quotation as a project cost", async () => {
    await newRequest({ quotationAmount: "800" });

    const reread = await get(`/api/projects/${project.id}`);

    expect(reread.body.data).toMatchObject({ trackedExpenses: "0.000", operationalJobMargin: "1000.000" });
  });
});

describe("read procurement requests", () => {
  it("lists requests newest first and filters by project, status and text", async () => {
    const otherProject = await newProject(admin, clientId, { description: "Second job" });
    await newRequest({ description: "Cable drums", requestDate: "2026-09-01", supplierName: "Alpha Traders" });
    const second = await newRequest({ description: "Control modules", requestDate: "2026-09-03", poReference: "PO-77" });
    await postProcurement(admin, { projectId: otherProject.id, description: "Batteries", requestDate: "2026-09-02" });
    await changeStatus(second.id, { status: "ORDERED" });

    const all = await get("/api/procurement");
    const byProject = await get(`/api/procurement?projectId=${project.id}`);
    const byStatus = await get("/api/procurement?status=ORDERED");
    const bySupplier = await get("/api/procurement?search=alpha");
    const byPo = await get("/api/procurement?search=po-77");
    const byJob = await get("/api/procurement?search=GPSA0002");
    const paged = await get("/api/procurement?page=2&pageSize=2");

    expect(all.body.data.items.map((item: { description: string }) => item.description)).toEqual(["Control modules", "Batteries", "Cable drums"]);
    expect(all.body.data).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(byProject.body.data.total).toBe(2);
    expect(byProject.body.data.items.every((item: { projectId: string }) => item.projectId === project.id)).toBe(true);
    expect(byStatus.body.data.items.map((item: { description: string }) => item.description)).toEqual(["Control modules"]);
    expect(bySupplier.body.data.total).toBe(1);
    expect(byPo.body.data.total).toBe(1);
    expect(byJob.body.data.items.map((item: { description: string }) => item.description)).toEqual(["Batteries"]);
    expect(paged.body.data.items.map((item: { description: string }) => item.description)).toEqual(["Cable drums"]);
  });

  it("returns one request, and 404 for a missing or malformed id", async () => {
    const request = await newRequest();

    expect((await get(`/api/procurement/${request.id}`)).body.data.description).toBe("Smoke detectors x 20");
    expect((await get("/api/procurement/999999")).status).toBe(404);
    expect((await get("/api/procurement/abc")).status).toBe(404);
  });
});

describe("update procurement request", () => {
  it("changes only the supplied fields and logs what changed", async () => {
    const request = await newRequest({ notes: "keep" });

    const response = await patch(request.id, { supplierName: "Beta Supplies", quotationAmount: "1234.567", quotationReference: "Q-9" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      supplierName: "Beta Supplies",
      quotationAmount: "1234.567",
      quotationReference: "Q-9",
      description: "Smoke detectors x 20",
      notes: "keep",
    });

    const logs = await logsFor("procurement_requests", request.id);
    expect(logs.map((log) => log.action)).toEqual(["procurement.created", "procurement.updated"]);
    expect(logs[1]?.metadata).toEqual({
      changes: {
        supplierName: { from: null, to: "Beta Supplies" },
        quotationAmount: { from: null, to: "1234.567" },
        quotationReference: { from: null, to: "Q-9" },
      },
    });
  });

  it("does not move a request to another project", async () => {
    const otherProject = await newProject(admin, clientId);
    const request = await newRequest();

    expect((await patch(request.id, { projectId: otherProject.id })).status).toBe(400);
    expect((await get(`/api/procurement/${request.id}`)).body.data.projectId).toBe(project.id);
  });

  it("rejects an empty update, invalid values and an unknown request, and logs nothing when unchanged", async () => {
    const request = await newRequest({ quotationAmount: "10" });

    expect((await patch(request.id, {})).status).toBe(400);
    expect((await patch(request.id, { description: "" })).status).toBe(400);
    expect((await patch(request.id, { quotationAmount: "-1" })).status).toBe(400);
    expect((await patch("999999", { description: "X" })).status).toBe(404);

    await patch(request.id, { quotationAmount: "10.000" });
    expect((await logsFor("procurement_requests", request.id)).map((log) => log.action)).toEqual(["procurement.created"]);
  });
});

describe("procurement status", () => {
  it("moves a request through its statuses and logs each change", async () => {
    const request = await newRequest();

    const quoted = await changeStatus(request.id, { status: "QUOTED" });
    const ordered = await changeStatus(request.id, { status: "ORDERED" });
    const delivered = await changeStatus(request.id, { status: "DELIVERED" });

    expect(quoted.body.data.status).toBe("QUOTED");
    expect(ordered.body.data.status).toBe("ORDERED");
    expect(delivered.body.data).toMatchObject({ status: "DELIVERED", deliveredDate: await today() });

    const logs = await logsFor("procurement_requests", request.id);
    expect(logs.slice(1).map((log) => log.metadata)).toMatchObject([
      { from: "REQUESTED", to: "QUOTED" },
      { from: "QUOTED", to: "ORDERED" },
      { from: "ORDERED", to: "DELIVERED" },
    ]);
  });

  it("records the delivered date that is given and clears it when the status moves back", async () => {
    const request = await newRequest();

    const delivered = await changeStatus(request.id, { status: "DELIVERED", deliveredDate: "2026-09-18" });
    const corrected = await changeStatus(request.id, { status: "DELIVERED", deliveredDate: "2026-09-19" });
    const back = await changeStatus(request.id, { status: "ORDERED" });

    expect(delivered.body.data.deliveredDate).toBe("2026-09-18");
    expect(corrected.body.data.deliveredDate).toBe("2026-09-19");
    expect(back.body.data).toMatchObject({ status: "ORDERED", deliveredDate: null });
  });

  it("rejects an unknown status and a delivered date on any other status", async () => {
    const request = await newRequest();

    expect((await changeStatus(request.id, { status: "APPROVED" })).status).toBe(400);
    expect((await changeStatus(request.id, { status: "ORDERED", deliveredDate: "2026-09-18" })).status).toBe(400);
    expect((await changeStatus("999999", { status: "ORDERED" })).status).toBe(404);
    expect((await get(`/api/procurement/${request.id}`)).body.data.status).toBe("REQUESTED");
  });

  it("cancels instead of deleting, and blocks edits while cancelled", async () => {
    const request = await newRequest();

    const cancelled = await changeStatus(request.id, { status: "CANCELLED" });
    expect(cancelled.body.data.status).toBe("CANCELLED");
    expect((await patch(request.id, { supplierName: "Late Change" })).status).toBe(409);
    expect((await api().delete(`/api/procurement/${request.id}`).set(admin.headers)).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM procurement_requests WHERE id = $1", [request.id])).rowCount).toBe(1);

    await changeStatus(request.id, { status: "REQUESTED" });
    expect((await patch(request.id, { supplierName: "Now Allowed" })).status).toBe(200);
  });

  it("is guarded by database constraints", async () => {
    const request = await newRequest();

    await expect(pool.query("UPDATE procurement_requests SET status = 'DELIVERED' WHERE id = $1", [request.id])).rejects.toMatchObject({
      code: "23514",
      constraint: "procurement_requests_delivered_date_ck",
    });
    await expect(pool.query("UPDATE procurement_requests SET status = 'APPROVED' WHERE id = $1", [request.id])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(pool.query("UPDATE procurement_requests SET quotation_amount = -1 WHERE id = $1", [request.id])).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("procurement permissions", () => {
  it("lets the Procurement role create, edit and change status", async () => {
    const procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);

    const created = await newRequest({}, procurement);

    expect((await patch(created.id, { supplierName: "Gamma" }, procurement)).status).toBe(200);
    expect((await changeStatus(created.id, { status: "QUOTED" }, procurement)).status).toBe(200);
    // The picker it needs for the form is available too.
    expect((await get("/api/projects/options", procurement)).status).toBe(200);
  });

  it("lets view-only roles read but not change procurement", async () => {
    const request = await newRequest();

    for (const [email, role] of [
      ["accountant@example.com", "ACCOUNTANT"],
      ["execution@example.com", "EXECUTION"],
    ] as const) {
      const session = await signedIn(email, [role]);

      expect((await get("/api/procurement", session)).status, role).toBe(200);
      expect((await get(`/api/procurement/${request.id}`, session)).status, role).toBe(200);

      const attempts = [
        await postProcurement(session, { projectId: project.id, description: "Not allowed", requestDate: "2026-09-05" }),
        await patch(request.id, { supplierName: "Not allowed" }, session),
        await changeStatus(request.id, { status: "CANCELLED" }, session),
      ];

      for (const response of attempts) {
        expect(response.status, role).toBe(403);
      }
    }

    const stored = await pool.query("SELECT supplier_name, status FROM procurement_requests");
    expect(stored.rows).toEqual([{ supplier_name: null, status: "REQUESTED" }]);
  });

  it("refuses a role without procurement access, and anyone not signed in", async () => {
    const invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);

    expect((await get("/api/procurement", invoicing)).status).toBe(403);
    expect((await api().get("/api/procurement")).status).toBe(401);
    expect((await api().post("/api/procurement").send({})).status).toBe(401);
  });
});
