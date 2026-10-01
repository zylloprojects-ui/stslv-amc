import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, visitsOf, type Session, type VisitRecord } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// How a completed visit becomes "ready for invoice". The state is derived by
// the v_amc_visit_billing view; no invoice record of any kind is created.

let admin: Session;
let invoicing: Session;
let contractId: string;
let visits: VisitRecord[];

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
  const client = await createClient(admin, "Test Villa");
  // Monthly through 2025: twelve visits, all in the past.
  contractId = await activeContract(admin, client, {
    systemDescription: "Automation",
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    maintenanceFrequency: "MONTHLY",
    contractValue: "5000.000",
    defaultVisitAmount: "405.000",
  });
  visits = await visitsOf(contractId);
});
afterAll(closePool);

const visit = async (index: number, session: Session = admin) =>
  (await api().get(`/api/amc/visits/${visits[index]?.id}`).set(session.headers)).body.data;
const setAmount = (index: number, visitAmount: string | null) =>
  api().patch(`/api/amc/visits/${visits[index]?.id}`).set(admin.headers).send({ visitAmount });
const execute = (index: number, body: Record<string, unknown>) =>
  api().patch(`/api/amc/execution/visits/${visits[index]?.id}`).set(admin.headers).send(body);
const complete = (index: number) => execute(index, { status: "COMPLETED", completedDate: "2025-12-15" });
const ready = (session: Session = admin) =>
  api().get("/api/amc/visits").query({ invoiceEligibility: "READY_FOR_INVOICE" }).set(session.headers);

describe("invoice eligibility", () => {
  it("is NOT_COMPLETED until the visit is completed, whatever its status", async () => {
    await execute(1, { status: "IN_PROGRESS" });
    await execute(2, { status: "POSTPONED" });
    await execute(3, { status: "CANCELLED" });

    for (const index of [0, 1, 2, 3]) {
      expect((await visit(index)).invoiceEligibility, `visit ${index}`).toBe("NOT_COMPLETED");
    }
    expect((await ready()).body.data.total).toBe(0);
  });

  it("becomes READY_FOR_INVOICE when a visit with an amount above zero is completed", async () => {
    const response = await complete(0);
    expect(response.status).toBe(200);

    expect(await visit(0)).toMatchObject({ status: "COMPLETED", visitAmount: "405.000", invoiceEligibility: "READY_FOR_INVOICE" });

    const list = await ready();
    expect(list.body.data.items.map((item: { id: string }) => item.id)).toEqual([visits[0]?.id]);
    expect(list.body.data.totals.visitAmount).toBe("405.000");
  });

  it("is visible to the Invoicing role, which will record the Zoho invoice later", async () => {
    const list = await ready(invoicing);

    expect(list.status).toBe(200);
    expect(list.body.data.items[0]).toMatchObject({
      id: visits[0]?.id,
      client: { name: "Test Villa" },
      contract: { id: contractId, systemDescription: "Automation" },
      completedDate: "2025-12-15",
      visitAmount: "405.000",
      invoiceEligibility: "READY_FOR_INVOICE",
    });
  });

  it("uses the visit's own amount, including an override", async () => {
    await setAmount(4, "500.000");
    await complete(4);

    const list = await ready();
    expect(list.body.data.total).toBe(2);
    expect(list.body.data.totals.visitAmount).toBe("905.000");
  });

  it("returns to NOT_COMPLETED when a completed visit is reopened", async () => {
    await complete(5);
    expect((await visit(5)).invoiceEligibility).toBe("READY_FOR_INVOICE");

    await execute(5, { status: "SCHEDULED" });

    expect((await visit(5)).invoiceEligibility).toBe("NOT_COMPLETED");
    expect((await ready()).body.data.total).toBe(2);
  });
});

describe("zero-value and missing amounts", () => {
  it("marks a completed zero-value visit NO_INVOICE_REQUIRED, so it never waits for an invoice", async () => {
    await setAmount(6, "0.000");
    await complete(6);

    expect(await visit(6)).toMatchObject({ status: "COMPLETED", visitAmount: "0.000", invoiceEligibility: "NO_INVOICE_REQUIRED" });
    expect((await ready()).body.data.items.map((item: { id: string }) => item.id)).not.toContain(visits[6]?.id);

    const none = await api().get("/api/amc/visits").query({ invoiceEligibility: "NO_INVOICE_REQUIRED" }).set(admin.headers);
    expect(none.body.data.items.map((item: { id: string }) => item.id)).toEqual([visits[6]?.id]);
  });

  it("marks a completed visit with no amount AMOUNT_REQUIRED instead of losing it", async () => {
    await setAmount(7, null);
    await complete(7);

    expect(await visit(7)).toMatchObject({ status: "COMPLETED", visitAmount: null, invoiceEligibility: "AMOUNT_REQUIRED" });
    expect((await ready()).body.data.items.map((item: { id: string }) => item.id)).not.toContain(visits[7]?.id);
  });

  it("follows the amount when it is entered or corrected after completion", async () => {
    await setAmount(7, "405.000");
    expect((await visit(7)).invoiceEligibility).toBe("READY_FOR_INVOICE");

    await setAmount(7, "0");
    expect((await visit(7)).invoiceEligibility).toBe("NO_INVOICE_REQUIRED");

    await setAmount(6, "0.001");
    expect((await visit(6)).invoiceEligibility).toBe("READY_FOR_INVOICE");
  });
});

describe("how eligibility is held", () => {
  it("is defined once, in the v_amc_visit_billing view, and matches what the API returns", async () => {
    const view = await pool.query<{ amc_visit_id: string; invoice_eligibility: string }>(
      "SELECT amc_visit_id, invoice_eligibility FROM v_amc_visit_billing WHERE amc_contract_id = $1 ORDER BY amc_visit_id",
      [contractId]
    );
    const fromApi = await api().get("/api/amc/visits").query({ contractId, pageSize: 200 }).set(admin.headers);
    const byId = new Map(fromApi.body.data.items.map((item: { id: string; invoiceEligibility: string }) => [item.id, item.invoiceEligibility]));

    expect(view.rows).toHaveLength(12);
    for (const row of view.rows) {
      expect(byId.get(row.amc_visit_id)).toBe(row.invoice_eligibility);
    }
    expect(new Set(view.rows.map((row) => row.invoice_eligibility))).toEqual(
      new Set(["NOT_COMPLETED", "READY_FOR_INVOICE", "NO_INVOICE_REQUIRED"])
    );
  });

  it("is not stored on the visit, and no invoice table exists", async () => {
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'amc_visits'"
    );
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE '%invoice%'"
    );

    expect(columns.rows.map((row) => row.column_name).filter((name) => name.includes("invoice") || name.includes("eligib"))).toEqual([]);
    expect(tables.rows).toEqual([]);
  });
});
