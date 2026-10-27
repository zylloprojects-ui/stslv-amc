import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { contractBody, createClient } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// Master Data Center: client details (migration 0074), sorting and history for
// clients and sales engineers, and choosing a sales engineer on an AMC contract
// (migration 0070). Every record here is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;

const postClient = (body: Record<string, unknown>, session: Session = admin) => api().post("/api/clients").set(session.headers).send(body);
const listClients = (query: Record<string, string>) => api().get("/api/clients").query({ status: "all", ...query }).set(admin.headers);
const postEngineer = (body: Record<string, unknown>) => api().post("/api/masters/sales-engineers").set(admin.headers).send(body);

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
});
afterAll(closePool);

describe("client details", () => {
  it("reports that client type and VAT number are available on this database", async () => {
    expect((await api().get("/api/clients/features").set(admin.headers)).body.data).toEqual({ clientDetails: true });
  });

  it("creates a client with type and VAT number and persists them", async () => {
    const created = await postClient({ name: "Alpha Test Co", clientType: "COMPANY", vatNumber: "OM1100223344", contactPerson: "Front Desk", phone: "111" });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: "Alpha Test Co", clientType: "COMPANY", vatNumber: "OM1100223344" });

    const fetched = (await api().get(`/api/clients/${created.body.data.id}`).set(admin.headers)).body.data;
    expect(fetched).toMatchObject({ clientType: "COMPANY", vatNumber: "OM1100223344", contactPerson: "Front Desk" });
  });

  it("requires a client type for a new client and leaves an omitted VAT number empty", async () => {
    for (const clientType of [undefined, "", null]) {
      const refused = await postClient({ name: "Beta Test Person", ...(clientType === undefined ? {} : { clientType }) });

      expect(refused.status).toBe(400);
      expect(refused.body.error.details).toEqual([{ field: "clientType", message: "Select Company or Individual." }]);
    }

    const created = await postClient({ name: "Delta Test Co", clientType: "COMPANY" });
    expect(created.body.data).toMatchObject({ clientType: "COMPANY", vatNumber: null });
  });

  it("keeps a client recorded without a type editable, and does not let a stored type be cleared", async () => {
    // A client recorded before the type existed (an import, or a database before migration 0074).
    await pool.query("INSERT INTO clients (name) VALUES ('Beta Test Person')");
    const id = (await listClients({ search: "Beta Test" })).body.data.items[0].id as string;

    const edited = await api().patch(`/api/clients/${id}`).set(admin.headers).send({ phone: "333" });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ phone: "333", clientType: null });

    const typed = (await listClients({ search: "Delta Test" })).body.data.items[0].id as string;
    const cleared = await api().patch(`/api/clients/${typed}`).set(admin.headers).send({ clientType: null });
    expect(cleared.status).toBe(400);
    expect(cleared.body.error.details).toEqual([{ field: "clientType", message: "Select Company or Individual." }]);
  });

  it("rejects an unknown type and a duplicate name in any letter case", async () => {
    expect((await postClient({ name: "Gamma", clientType: "PARTNERSHIP" })).status).toBe(400);

    const duplicate = await postClient({ name: "alpha test co ", clientType: "COMPANY" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details).toEqual([{ field: "name", message: "A client with this name already exists." }]);
  });

  it("records changes to type and VAT number in the client's history", async () => {
    const id = (await listClients({ search: "Beta Test" })).body.data.items[0].id as string;
    const updated = await api().patch(`/api/clients/${id}`).set(admin.headers).send({ clientType: "INDIVIDUAL", vatNumber: "VAT-77" });

    expect(updated.body.data).toMatchObject({ clientType: "INDIVIDUAL", vatNumber: "VAT-77" });

    const history = (await api().get(`/api/clients/${id}/history`).set(admin.headers)).body.data;
    expect(history.items.map((item: { action: string }) => item.action)).toEqual(["client.updated", "client.updated"]);
    expect(history.items[0].changes).toEqual({ clientType: { from: null, to: "INDIVIDUAL" }, vatNumber: { from: null, to: "VAT-77" } });
    expect((await api().get("/api/clients/999999/history").set(admin.headers)).status).toBe(404);
  });

  it("searches by VAT number, filters by type and sorts", async () => {
    expect((await listClients({ search: "OM1100" })).body.data.items.map((item: { name: string }) => item.name)).toEqual(["Alpha Test Co"]);
    expect((await listClients({ clientType: "INDIVIDUAL" })).body.data.items.map((item: { name: string }) => item.name)).toEqual(["Beta Test Person"]);

    const newest = (await listClients({ sort: "createdAt", direction: "desc" })).body.data.items as { name: string }[];
    expect(newest[0]?.name).toBe("Beta Test Person");
    expect((await listClients({ sort: "password" })).status).toBe(400);
  });

  it("keeps creating and editing for roles that may", async () => {
    expect((await postClient({ name: "Not allowed" }, execution)).status).toBe(403);
    expect((await api().get("/api/clients/features").set(execution.headers)).status).toBe(200);
  });
});

describe("sales engineers in the Master Data Center", () => {
  let engineerA: string;
  let engineerB: string;

  beforeAll(async () => {
    engineerA = (await postEngineer({ name: "Zed Engineer", employeeNo: "E-200" })).body.data.id as string;
    engineerB = (await postEngineer({ name: "Amy Engineer", employeeNo: "E-100" })).body.data.id as string;
  });

  it("sorts by the columns the list offers and refuses others", async () => {
    const byNo = await api().get("/api/masters/sales-engineers").query({ sort: "employeeNo", direction: "desc" }).set(admin.headers);
    expect(byNo.body.data.items.map((item: { employeeNo: string }) => item.employeeNo)).toEqual(["E-200", "E-100"]);

    expect((await api().get("/api/masters/sales-engineers").query({ sort: "constructor" }).set(admin.headers)).status).toBe(400);
    expect((await api().get("/api/masters/sales-engineers").query({ sort: "password" }).set(admin.headers)).status).toBe(400);
  });

  it("shows an engineer's history", async () => {
    await api().patch(`/api/masters/sales-engineers/${engineerA}`).set(admin.headers).send({ phone: "999" });

    const history = (await api().get(`/api/masters/sales-engineers/${engineerA}/history`).set(execution.headers)).body.data;
    expect(history.items.map((item: { action: string }) => item.action)).toEqual(["sales_engineer.updated", "sales_engineer.created"]);
  });

  it("is chosen on a new contract, keeping the typed engineer text, and lists the engineer's contracts", async () => {
    const clientId = await createClient(admin, "Engineer Contract Client");
    const created = await api()
      .post("/api/amc/contracts")
      .set(admin.headers)
      .send(contractBody(clientId, { responsibleEngineer: "Amy Engineer", salesEngineerId: engineerB }));

    expect(created.status).toBe(201);
    const contractId = created.body.data.id as string;
    expect(created.body.data.responsibleEngineer).toBe("Amy Engineer");
    expect((await api().get(`/api/amc/contracts/${contractId}/masters`).set(admin.headers)).body.data.salesEngineer).toMatchObject({ id: engineerB });

    const linked = await api().get("/api/amc/contracts").query({ salesEngineerId: engineerB }).set(admin.headers);
    expect(linked.body.data.items.map((item: { id: string }) => item.id)).toEqual([contractId]);
    expect((await api().get(`/api/masters/sales-engineers/${engineerB}`).set(admin.headers)).body.data.contractCount).toBe(1);
  });

  it("is changed on an existing contract, alone or with other fields, without touching its schedule", async () => {
    const clientId = await createClient(admin, "Engineer Change Client");
    const contractId = (await api().post("/api/amc/contracts").set(admin.headers).send(contractBody(clientId, { status: "ACTIVE" }))).body.data.id as string;
    const visitsBefore = await pool.query("SELECT id, scheduled_date, visit_amount FROM amc_visits WHERE amc_contract_id = $1 ORDER BY id", [contractId]);

    const only = await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ salesEngineerId: engineerA });
    expect(only.status).toBe(200);
    const both = await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ salesEngineerId: null, notes: "Changed engineer" });
    expect(both.body.data.notes).toBe("Changed engineer");
    expect((await api().get(`/api/amc/contracts/${contractId}/masters`).set(admin.headers)).body.data.salesEngineer).toBeNull();

    const visitsAfter = await pool.query("SELECT id, scheduled_date, visit_amount FROM amc_visits WHERE amc_contract_id = $1 ORDER BY id", [contractId]);
    expect(visitsAfter.rows).toEqual(visitsBefore.rows);

    const actions = (await api().get(`/api/amc/contracts/${contractId}/history`).set(admin.headers)).body.data.items.map((item: { action: string }) => item.action);
    expect(actions.filter((action: string) => action === "amc_contract.masters_linked")).toHaveLength(2);
  });

  it("refuses a deactivated engineer on a contract but keeps existing links readable", async () => {
    await api().post(`/api/masters/sales-engineers/${engineerB}/status`).set(admin.headers).send({ isActive: false });

    const clientId = await createClient(admin, "Inactive Engineer Client");
    const refused = await api().post("/api/amc/contracts").set(admin.headers).send(contractBody(clientId, { salesEngineerId: engineerB }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].field).toBe("salesEngineerId");

    const existing = await api().get("/api/amc/contracts").query({ salesEngineerId: engineerB }).set(admin.headers);
    expect(existing.body.data.items).toHaveLength(1);
  });

  it("does not create the contract when the engineer is refused", async () => {
    const count = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id WHERE cl.name = 'Inactive Engineer Client'");
    expect(count.rows[0]?.count).toBe(0);
  });
});
