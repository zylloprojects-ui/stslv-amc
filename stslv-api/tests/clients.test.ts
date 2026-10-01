import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, resetData, signedIn } from "./helpers";

let admin: Awaited<ReturnType<typeof signedIn>>;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

async function createClient(body: Record<string, unknown>) {
  return api().post("/api/clients").set(admin.headers).send(body);
}

async function logsFor(clientId: string) {
  const result = await pool.query<{ action: string; user_id: string; module: string; metadata: unknown }>(
    "SELECT action, user_id, module, metadata FROM activity_logs WHERE entity_type = 'clients' AND entity_id = $1 ORDER BY id",
    [clientId]
  );

  return result.rows;
}

describe("create client", () => {
  it("saves the client to PostgreSQL and records who created it", async () => {
    const response = await createClient({
      name: "  IBIS  ",
      contactPerson: "Front Office",
      email: "ops@ibis.example",
      phone: "",
      address: "Muscat",
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name: "IBIS",
      contactPerson: "Front Office",
      email: "ops@ibis.example",
      phone: null,
      address: "Muscat",
      notes: null,
      isActive: true,
    });

    const stored = await pool.query("SELECT name, phone, created_by, updated_by FROM clients WHERE id = $1", [
      response.body.data.id,
    ]);
    expect(stored.rows[0]).toEqual({ name: "IBIS", phone: null, created_by: admin.id, updated_by: admin.id });

    expect(await logsFor(response.body.data.id)).toMatchObject([
      { action: "client.created", user_id: admin.id, module: "CLIENTS" },
    ]);
  });

  it("requires only the name", async () => {
    const response = await createClient({ name: "MERCURE" });

    expect(response.status).toBe(201);
    expect(response.body.data).not.toHaveProperty("clientCode");
  });

  it("rejects invalid data with field-level messages", async () => {
    const missingName = await createClient({ contactPerson: "Someone" });
    const blankName = await createClient({ name: "   " });
    const badEmail = await createClient({ name: "Bad Email Co", email: "not-an-email" });
    const unknownField = await createClient({ name: "Extra Field Co", isActive: false });

    for (const response of [missingName, blankName, badEmail, unknownField]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(missingName.body.error.details).toEqual([{ field: "name", message: "Client name is required." }]);
    expect(badEmail.body.error.details).toEqual([{ field: "email", message: "Enter a valid email address." }]);
  });

  it("rejects an exact duplicate name but keeps similarly spelled names separate", async () => {
    const duplicate = await createClient({ name: "ibis" });
    const first = await createClient({ name: "HOLIDAY INN" });
    const second = await createClient({ name: "HOLIDAYINN" });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatchObject({ code: "CONFLICT", details: [{ field: "name" }] });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});

describe("read clients", () => {
  it("lists active clients by name, with a total", async () => {
    const response = await api().get("/api/clients").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((client: { name: string }) => client.name)).toEqual([
      "HOLIDAY INN",
      "HOLIDAYINN",
      "IBIS",
      "MERCURE",
    ]);
    expect(response.body.data).toMatchObject({ total: 4, page: 1, pageSize: 25 });
  });

  it("searches by name, contact, email and phone, treating wildcards literally", async () => {
    const byName = await api().get("/api/clients").query({ search: "holiday" }).set(admin.headers);
    const byContact = await api().get("/api/clients").query({ search: "front office" }).set(admin.headers);
    const wildcard = await api().get("/api/clients").query({ search: "%" }).set(admin.headers);

    expect(byName.body.data.total).toBe(2);
    expect(byContact.body.data.items.map((client: { name: string }) => client.name)).toEqual(["IBIS"]);
    expect(wildcard.body.data.total).toBe(0);
  });

  it("paginates", async () => {
    const response = await api().get("/api/clients").query({ page: 2, pageSize: 3 }).set(admin.headers);

    expect(response.body.data.items.map((client: { name: string }) => client.name)).toEqual(["MERCURE"]);
    expect(response.body.data.total).toBe(4);
  });

  it("returns one client, and 404 for a missing or malformed id", async () => {
    const created = await createClient({ name: "Single Client" });
    const found = await api().get(`/api/clients/${created.body.data.id}`).set(admin.headers);
    const missing = await api().get("/api/clients/999999").set(admin.headers);
    const malformed = await api().get("/api/clients/abc").set(admin.headers);

    expect(found.body.data.name).toBe("Single Client");
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});

describe("update client", () => {
  it("changes only the supplied fields and logs what changed", async () => {
    const created = await createClient({ name: "Update Me", phone: "111", notes: "keep" });
    const id = created.body.data.id;

    const response = await api()
      .patch(`/api/clients/${id}`)
      .set(admin.headers)
      .send({ name: "Updated Name", phone: "222", contactPerson: "New Contact" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ name: "Updated Name", phone: "222", contactPerson: "New Contact", notes: "keep" });

    // Read back through a separate request: the data comes from PostgreSQL.
    const reread = await api().get(`/api/clients/${id}`).set(admin.headers);
    expect(reread.body.data).toMatchObject({ name: "Updated Name", phone: "222", notes: "keep" });

    const logs = await logsFor(id);
    expect(logs.map((log) => log.action)).toEqual(["client.created", "client.updated"]);
    expect(logs[1]?.metadata).toEqual({
      changes: {
        name: { from: "Update Me", to: "Updated Name" },
        phone: { from: "111", to: "222" },
        contactPerson: { from: null, to: "New Contact" },
      },
    });
  });

  it("clears an optional field when given an empty value", async () => {
    const created = await createClient({ name: "Clear Field", phone: "123" });
    const response = await api().patch(`/api/clients/${created.body.data.id}`).set(admin.headers).send({ phone: "" });

    expect(response.body.data.phone).toBeNull();
  });

  it("does not write a log entry when nothing changed", async () => {
    const created = await createClient({ name: "No Change" });
    await api().patch(`/api/clients/${created.body.data.id}`).set(admin.headers).send({ name: "No Change" });

    expect((await logsFor(created.body.data.id)).map((log) => log.action)).toEqual(["client.created"]);
  });

  it("rejects an empty update, a duplicate name and an unknown client", async () => {
    const created = await createClient({ name: "Rename Target" });
    const id = created.body.data.id;

    expect((await api().patch(`/api/clients/${id}`).set(admin.headers).send({})).status).toBe(400);
    expect((await api().patch(`/api/clients/${id}`).set(admin.headers).send({ name: "" })).status).toBe(400);
    expect((await api().patch(`/api/clients/${id}`).set(admin.headers).send({ name: "IBIS" })).status).toBe(409);
    expect((await api().patch("/api/clients/999999").set(admin.headers).send({ name: "X" })).status).toBe(404);
    expect((await api().patch(`/api/clients/${id}`).set(admin.headers).send({ isActive: false })).status).toBe(400);
  });
});

describe("deactivate client", () => {
  it("deactivates instead of deleting, and can be reversed", async () => {
    const created = await createClient({ name: "Leaving Client" });
    const id = created.body.data.id;

    const deactivated = await api().post(`/api/clients/${id}/deactivate`).set(admin.headers);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.isActive).toBe(false);

    // The row still exists.
    const stored = await pool.query<{ is_active: boolean }>("SELECT is_active FROM clients WHERE id = $1", [id]);
    expect(stored.rows[0]?.is_active).toBe(false);

    const active = await api().get("/api/clients").query({ search: "Leaving" }).set(admin.headers);
    const inactive = await api().get("/api/clients").query({ search: "Leaving", status: "inactive" }).set(admin.headers);
    const all = await api().get("/api/clients").query({ search: "Leaving", status: "all" }).set(admin.headers);
    expect(active.body.data.total).toBe(0);
    expect(inactive.body.data.total).toBe(1);
    expect(all.body.data.total).toBe(1);

    const reactivated = await api().post(`/api/clients/${id}/reactivate`).set(admin.headers);
    expect(reactivated.body.data.isActive).toBe(true);

    expect((await logsFor(id)).map((log) => log.action)).toEqual([
      "client.created",
      "client.deactivated",
      "client.reactivated",
    ]);
  });

  it("offers no route that deletes a client", async () => {
    const created = await createClient({ name: "Cannot Delete" });
    const response = await api().delete(`/api/clients/${created.body.data.id}`).set(admin.headers);

    expect(response.status).toBe(404);
    expect((await pool.query("SELECT 1 FROM clients WHERE id = $1", [created.body.data.id])).rowCount).toBe(1);
  });
});

describe("dashboard summary", () => {
  it("counts clients from the database", async () => {
    const counts = await pool.query<{ active: number; inactive: number }>(
      "SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE NOT is_active)::int AS inactive FROM clients"
    );
    const response = await api().get("/api/dashboard/summary").set(admin.headers);

    expect(response.body.data).toEqual({ clients: counts.rows[0] });
  });
});
