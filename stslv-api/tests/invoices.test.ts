import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { grant } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { insertHistoricalProject, insertHistoricalVisit, insertImportedContract } from "./historical-helpers";
import {
  cancelInvoice,
  completeVisit,
  completedProject,
  invoiceBody,
  invoiceFixture,
  invoiceNumber,
  newInvoice,
  patchInvoice,
  postInvoice,
  projectState,
  visitEligibility,
  type Fixture,
  type Session,
} from "./invoices-helpers";
import { logsFor, newProject, resetProjectData } from "./projects-helpers";

// Invoice Tracking: recording a Zoho invoice against completed AMC visits and
// projects. Every invoice in these tests is invented; no client data is used.

let admin: Session;
let invoicing: Session;
let accountant: Session;
let execution: Session;
let fixture: Fixture;

const visitId = (index: number) => fixture.visits[index]?.id as string;
const setAmount = (index: number, visitAmount: string | null) =>
  api().patch(`/api/amc/visits/${visitId(index)}`).set(admin.headers).send({ visitAmount });
const list = (query: Record<string, string> = {}, session: Session = admin) =>
  api().get("/api/invoices").query(query).set(session.headers);
const billable = (query: Record<string, string> = {}, session: Session = admin) =>
  api().get("/api/invoices/billable").query(query).set(session.headers);
const counts = async () =>
  (
    await pool.query<{ invoices: number; allocations: number }>(
      "SELECT (SELECT count(*)::int FROM invoices) AS invoices, (SELECT count(*)::int FROM invoice_allocations) AS allocations"
    )
  ).rows[0];

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  fixture = await invoiceFixture(admin);

  // Visits 0-2 and 6-9 are completed with their amount of 405.000; 3 stays scheduled.
  for (const index of [0, 1, 2, 4, 5, 6, 7, 8, 9]) {
    await completeVisit(admin, visitId(index));
  }
  await setAmount(4, "0");
  await setAmount(5, null);
});
afterAll(closePool);

describe("recording an invoice", () => {
  it("records a Zoho invoice against a completed visit", async () => {
    const body = invoiceBody(fixture.clientId, [{ amcVisitId: visitId(0), amount: "405.000" }], {
      invoiceNumber: "3201",
      sourceReference: "ZB-INV-000123",
      notes: "Quarter one",
    });
    const response = await postInvoice(invoicing, body);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      invoiceNumber: "3201",
      client: { id: fixture.clientId, name: "Test Hotel" },
      invoiceDate: "2026-09-15",
      amountExclVat: "405.000",
      vatAmount: "20.250",
      totalAmount: "425.250",
      status: "ISSUED",
      source: "ZOHO",
      sourceReference: "ZB-INV-000123",
      notes: "Quarter one",
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      createdBy: { id: invoicing.id },
    });
    expect(response.body.data.allocations).toEqual([
      {
        id: expect.any(String),
        amount: "405.000",
        amcVisit: {
          id: visitId(0),
          contractId: fixture.contractId,
          systemDescription: "FIRE",
          sequenceNo: 1,
          periodStart: "2025-01-01",
          periodEnd: "2025-01-31",
          completedDate: "2025-12-15",
        },
        project: null,
      },
    ]);
    expect(await visitEligibility(visitId(0))).toEqual({ invoice_eligibility: "INVOICED", invoiced_amount: "405.000" });
  });

  it("stores exactly what was entered: nothing is defaulted or calculated from a rate", async () => {
    const invoice = await newInvoice(
      admin,
      invoiceBody(fixture.clientId, [{ amcVisitId: visitId(1), amount: "405" }], { amountExclVat: "405", vatAmount: "0" })
    );
    const stored = await pool.query(
      "SELECT amount_excl_vat, vat_amount, total_amount, source, source_reference, notes, status FROM invoices WHERE id = $1",
      [invoice.id]
    );

    expect(stored.rows[0]).toEqual({
      amount_excl_vat: "405.000",
      vat_amount: "0.000",
      total_amount: "405.000",
      source: "ZOHO",
      source_reference: null,
      notes: null,
      status: "ISSUED",
    });
  });

  it("writes the invoice and its allocations to the activity log", async () => {
    const invoice = (await list({ search: "3201" })).body.data.items[0];
    const logs = await logsFor("invoices", invoice.id);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "invoice.created", module: "INVOICES", user_id: invoicing.id });
    expect(logs[0]?.metadata).toMatchObject({
      invoiceNumber: "3201",
      amountExclVat: "405.000",
      vatAmount: "20.250",
      totalAmount: "425.250",
      allocations: [{ amcVisitId: visitId(0), amount: "405.000" }],
    });
  });

  it("lets one invoice cover a visit and a project of the same client", async () => {
    const project = await completedProject(admin, fixture.clientId, "1000.000");
    const response = await postInvoice(
      admin,
      invoiceBody(
        fixture.clientId,
        [
          { amcVisitId: visitId(2), amount: "405.000" },
          { projectId: project.id, amount: "1000.000" },
        ],
        { amountExclVat: "1405.000", vatAmount: "70.250" }
      )
    );

    expect(response.status).toBe(201);
    expect(response.body.data.totalAmount).toBe("1475.250");
    expect(response.body.data.allocations.map((allocation: { amount: string }) => allocation.amount)).toEqual(["405.000", "1000.000"]);
    expect(response.body.data.allocations[1].project).toEqual({ id: project.id, jobNumber: project.jobNumber, description: project.description });
    expect(await projectState(project.id)).toEqual({ invoice_state: "INVOICED", invoiced_value: "1000.000", uninvoiced_value: "0.000" });
  });

  it("lets several invoices cover one project, which is partly invoiced until its job value is reached", async () => {
    const project = await completedProject(admin, fixture.clientId, "1000.001");

    expect(await projectState(project.id)).toEqual({ invoice_state: "READY_FOR_INVOICE", invoiced_value: "0.000", uninvoiced_value: "1000.001" });

    await newInvoice(admin, invoiceBody(fixture.clientId, [{ projectId: project.id, amount: "400.250" }], { amountExclVat: "400.250" }));
    expect(await projectState(project.id)).toEqual({ invoice_state: "PARTLY_INVOICED", invoiced_value: "400.250", uninvoiced_value: "599.751" });

    await newInvoice(admin, invoiceBody(fixture.clientId, [{ projectId: project.id, amount: "599.750" }], { amountExclVat: "599.750" }));
    // One thousandth short of the job value is still partly invoiced.
    expect(await projectState(project.id)).toEqual({ invoice_state: "PARTLY_INVOICED", invoiced_value: "1000.000", uninvoiced_value: "0.001" });

    await newInvoice(admin, invoiceBody(fixture.clientId, [{ projectId: project.id, amount: "0.001" }], { amountExclVat: "0.001", vatAmount: "0" }));
    expect(await projectState(project.id)).toEqual({ invoice_state: "INVOICED", invoiced_value: "1000.001", uninvoiced_value: "0.000" });

    const response = await api().get(`/api/projects/${project.id}`).set(admin.headers);
    expect(response.body.data).toMatchObject({ invoiceState: "INVOICED", readyForInvoice: false });
  });

  it("shows the invoiced state on the AMC schedule", async () => {
    const visit = await api().get(`/api/amc/visits/${visitId(0)}`).set(admin.headers);
    const invoiced = await api().get("/api/amc/visits").query({ invoiceEligibility: "INVOICED" }).set(admin.headers);

    expect(visit.body.data.invoiceEligibility).toBe("INVOICED");
    expect(invoiced.body.data.items.map((item: { id: string }) => item.id).sort()).toEqual([visitId(0), visitId(1), visitId(2)].sort());
  });
});

describe("reconciliation", () => {
  it("refuses allocations that do not add up exactly to the amount excluding VAT", async () => {
    const before = await counts();
    const cases: [string, Record<string, string>[], string][] = [
      ["405.000", [{ amcVisitId: visitId(6), amount: "404.999" }], "404.999"],
      ["405.000", [{ amcVisitId: visitId(6), amount: "405.001" }], "405.001"],
      [
        "810.000",
        [
          { amcVisitId: visitId(6), amount: "405.000" },
          { amcVisitId: visitId(7), amount: "404.999" },
        ],
        "809.999",
      ],
    ];

    for (const [amountExclVat, allocations, total] of cases) {
      const response = await postInvoice(admin, invoiceBody(fixture.clientId, allocations, { amountExclVat }));

      expect(response.status, total).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details).toEqual([
        {
          field: "allocations",
          message: `The allocations add up to ${total}, but the invoice amount excluding VAT is ${amountExclVat}. They must be equal.`,
        },
      ]);
    }
    expect(await counts()).toEqual(before);
  });

  it("does not count the VAT amount towards the allocations", async () => {
    // 405.000 + 20.250 VAT: allocating the total including VAT is refused.
    const response = await postInvoice(admin, invoiceBody(fixture.clientId, [{ amcVisitId: visitId(6), amount: "425.250" }]));

    expect(response.status).toBe(400);
  });

  it("accepts allocations that add up exactly, to the third decimal", async () => {
    const project = await completedProject(admin, fixture.clientId, "33.333");
    const response = await postInvoice(
      admin,
      invoiceBody(
        fixture.clientId,
        [
          { amcVisitId: visitId(6), amount: "0.001" },
          { projectId: project.id, amount: "33.333" },
        ],
        { amountExclVat: "33.334", vatAmount: "1.667" }
      )
    );

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ amountExclVat: "33.334", vatAmount: "1.667", totalAmount: "35.001" });
  });

  it("is enforced by the database as well: a transaction cannot commit an invoice that does not reconcile", async () => {
    const insert = async (allocated: string | null) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const invoice = await client.query<{ id: string }>(
          `INSERT INTO invoices (invoice_number, client_id, invoice_date, amount_excl_vat, vat_amount, created_by)
           VALUES ($1, $2, '2026-09-15', 405.000, 0, $3) RETURNING id`,
          [invoiceNumber(), fixture.clientId, admin.id]
        );

        if (allocated !== null) {
          await client.query(
            "INSERT INTO invoice_allocations (invoice_id, amc_visit_id, allocated_amount, created_by) VALUES ($1, $2, $3, $4)",
            [invoice.rows[0]?.id, visitId(7), allocated, admin.id]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const before = await counts();

    await expect(insert(null)).rejects.toMatchObject({ code: "23514", constraint: "invoice_allocations_total_ck" });
    await expect(insert("404.999")).rejects.toMatchObject({ code: "23514", constraint: "invoice_allocations_total_ck" });
    expect(await counts()).toEqual(before);

    const invoice = (await list({ search: "3201" })).body.data.items[0];

    await expect(pool.query("UPDATE invoices SET amount_excl_vat = 500 WHERE id = $1", [invoice.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("DELETE FROM invoice_allocations WHERE invoice_id = $1", [invoice.id])).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE invoice_allocations SET allocated_amount = 1 WHERE invoice_id = $1", [invoice.id])
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("validation", () => {
  const valid = () => invoiceBody(fixture.clientId, [{ amcVisitId: visitId(7), amount: "405.000" }]);

  it("requires every invoice detail: none is supplied by the system", async () => {
    for (const field of ["invoiceNumber", "clientId", "invoiceDate", "amountExclVat", "vatAmount", "allocations"]) {
      const body: Record<string, unknown> = valid();
      delete body[field];

      const response = await postInvoice(admin, body);

      expect(response.status, field).toBe(400);
      expect(response.body.error.details.map((detail: { field: string }) => detail.field), field).toContain(field);
    }
  });

  it("refuses invalid values", async () => {
    const cases: Record<string, unknown>[] = [
      { invoiceNumber: "   " },
      { invoiceDate: "2026-02-30" },
      { invoiceDate: "15/09/2026" },
      { amountExclVat: "0" },
      { amountExclVat: "-405.000" },
      { amountExclVat: "405.0001" },
      { amountExclVat: 405 },
      { vatAmount: "-1" },
      { vatAmount: "20.2501" },
      { allocations: [] },
      { allocations: [{ amount: "405.000" }] },
      { allocations: [{ amcVisitId: visitId(7), projectId: "1", amount: "405.000" }] },
      { allocations: [{ amcVisitId: visitId(7), amount: "0" }] },
      { allocations: [{ amcVisitId: visitId(7) }] },
      { status: "CANCELLED" },
      { totalAmount: "425.250" },
      { source: "MANUAL" },
    ];
    const before = await counts();

    for (const override of cases) {
      const response = await postInvoice(admin, { ...valid(), ...override });

      expect(response.status, JSON.stringify(override)).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await counts()).toEqual(before);
  });

  it("refuses an invoice number that is already recorded, whatever its letter case", async () => {
    await newInvoice(admin, { ...valid(), invoiceNumber: "INV-7001" });

    const before = await counts();
    const response = await postInvoice(admin, invoiceBody(fixture.clientId, [{ amcVisitId: visitId(8), amount: "405.000" }], { invoiceNumber: "inv-7001" }));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.details[0].field).toBe("invoiceNumber");
    expect(await counts()).toEqual(before);
  });

  it("refuses work that cannot be invoiced, naming each allocation", async () => {
    const open = await newProject(admin, fixture.clientId);
    const zeroValue = await completedProject(admin, fixture.clientId, "0");
    const otherClients = await completedProject(admin, fixture.otherClientId);
    const historicalProject = await insertHistoricalProject(fixture.clientId, { jobNumber: "GPSA9901" });
    const importedContract = await insertImportedContract(fixture.clientId, { validFrom: "2024-01-01", validTo: "2024-12-31", cutoverDate: "2026-10-01" });
    const historicalVisit = await insertHistoricalVisit(importedContract, { sequenceNo: 1, periodStart: "2024-01-01", periodEnd: "2024-03-31" });
    const cases: [Record<string, string>, RegExp][] = [
      [{ amcVisitId: visitId(3), amount: "405.000" }, /is not completed/],
      [{ amcVisitId: visitId(4), amount: "405.000" }, /amount of zero/],
      [{ amcVisitId: visitId(5), amount: "405.000" }, /has no amount/],
      [{ amcVisitId: historicalVisit, amount: "405.000" }, /historical record/],
      [{ amcVisitId: "999999", amount: "405.000" }, /does not exist/],
      [{ projectId: open.id, amount: "405.000" }, /is not completed/],
      [{ projectId: zeroValue.id, amount: "405.000" }, /job value of zero/],
      [{ projectId: otherClients.id, amount: "405.000" }, /does not belong to the client/],
      [{ projectId: historicalProject, amount: "405.000" }, /historical record/],
      [{ projectId: "999999", amount: "405.000" }, /does not exist/],
    ];
    const before = await counts();

    for (const [allocation, message] of cases) {
      const response = await postInvoice(admin, invoiceBody(fixture.clientId, [allocation]));

      expect(response.status, JSON.stringify(allocation)).toBe(400);
      expect(response.body.error.details).toEqual([{ field: "allocations.0", message: expect.stringMatching(message) }]);
    }

    const visitOfAnotherClient = await postInvoice(admin, invoiceBody(fixture.otherClientId, [{ amcVisitId: visitId(8), amount: "405.000" }]));
    const twice = await postInvoice(
      admin,
      invoiceBody(
        fixture.clientId,
        [
          { amcVisitId: visitId(8), amount: "200.000" },
          { amcVisitId: visitId(8), amount: "205.000" },
        ]
      )
    );
    const unknownClient = await postInvoice(admin, invoiceBody("999999", [{ amcVisitId: visitId(8), amount: "405.000" }]));

    expect(visitOfAnotherClient.status).toBe(400);
    expect(visitOfAnotherClient.body.error.details[0].message).toMatch(/does not belong to the client/);
    expect(twice.status).toBe(400);
    expect(twice.body.error.details).toEqual([{ field: "allocations.1", message: expect.stringMatching(/more than once/) }]);
    expect(unknownClient.status).toBe(400);
    expect(unknownClient.body.error.details[0].field).toBe("clientId");
    expect(await counts()).toEqual(before);
  });
});

describe("reading invoices", () => {
  it("lists invoices newest first with totals over every match", async () => {
    const response = await list();
    const stored = await pool.query<{ count: number; net: string; vat: string; total: string }>(
      `SELECT count(*)::int AS count, sum(amount_excl_vat)::numeric(18,3) AS net, sum(vat_amount)::numeric(18,3) AS vat,
              sum(total_amount)::numeric(18,3) AS total FROM invoices`
    );
    const dates = response.body.data.items.map((item: { invoiceDate: string }) => item.invoiceDate);

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(stored.rows[0]?.count);
    expect(response.body.data.totals).toEqual({
      amountExclVat: stored.rows[0]?.net,
      vatAmount: stored.rows[0]?.vat,
      totalAmount: stored.rows[0]?.total,
    });
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("filters by client, date, the work covered and free text", async () => {
    const byVisit = await list({ amcVisitId: visitId(0) });
    const byNumber = await list({ search: "inv-7001" });
    const byClient = await list({ clientId: fixture.otherClientId });
    const byDate = await list({ dateFrom: "2026-09-16" });
    const project = await completedProject(admin, fixture.clientId, "250.000");
    const invoice = await newInvoice(admin, invoiceBody(fixture.clientId, [{ projectId: project.id, amount: "250.000" }], { amountExclVat: "250.000" }));
    const byProject = await list({ projectId: project.id });
    const byJobNumber = await list({ search: project.jobNumber });

    expect(byVisit.body.data.items.map((item: { invoiceNumber: string }) => item.invoiceNumber)).toEqual(["3201"]);
    expect(byNumber.body.data.items.map((item: { invoiceNumber: string }) => item.invoiceNumber)).toEqual(["INV-7001"]);
    expect(byClient.body.data.total).toBe(0);
    expect(byDate.body.data.total).toBe(0);
    expect(byProject.body.data.items.map((item: { id: string }) => item.id)).toEqual([invoice.id]);
    expect(byJobNumber.body.data.items.map((item: { id: string }) => item.id)).toEqual([invoice.id]);
    expect((await list({ status: "PAID" })).status).toBe(400);
    expect((await list({ pageSize: "1000" })).status).toBe(400);
  });

  it("returns one invoice, and 404 for one that does not exist", async () => {
    const invoice = (await list({ search: "3201" })).body.data.items[0];
    const found = await api().get(`/api/invoices/${invoice.id}`).set(admin.headers);

    expect(found.status).toBe(200);
    expect(found.body.data).toEqual(invoice);
    expect((await api().get("/api/invoices/999999").set(admin.headers)).status).toBe(404);
    expect((await api().get("/api/invoices/abc").set(admin.headers)).status).toBe(404);
  });
});

describe("work waiting for an invoice", () => {
  it("lists completed work no active invoice covers, with pending figures", async () => {
    const response = await billable();
    const visits = response.body.data.amcVisits;
    const projects = response.body.data.projects;
    const storedVisits = await pool.query<{ count: number; amount: string }>(
      `SELECT count(*)::int AS count, COALESCE(sum(v.visit_amount), 0)::numeric(18,3) AS amount
       FROM amc_visits v
       WHERE v.status = 'COMPLETED' AND v.visit_amount > 0
         AND NOT EXISTS (SELECT 1 FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id
                         WHERE a.amc_visit_id = v.id AND i.status <> 'CANCELLED')`
    );

    expect(response.status).toBe(200);
    expect(visits.items.map((item: { id: string }) => item.id).sort()).toEqual([visitId(8), visitId(9)].sort());
    expect(visits.items.every((item: { invoiceEligibility: string }) => item.invoiceEligibility === "READY_FOR_INVOICE")).toBe(true);
    expect({ count: visits.pendingCount, amount: visits.pendingAmount }).toEqual(storedVisits.rows[0]);
    // Completed projects of both clients that no invoice covers yet.
    expect(projects.items.every((item: { invoiceState: string }) => ["READY_FOR_INVOICE", "PARTLY_INVOICED"].includes(item.invoiceState))).toBe(true);
    expect(projects.pendingCount).toBe(projects.items.length);
    expect(projects.items.length).toBeGreaterThan(0);
  });

  it("can include the invoiced work of one client, without changing the pending figures", async () => {
    const pending = (await billable({ clientId: fixture.clientId })).body.data;
    const all = (await billable({ clientId: fixture.clientId, includeInvoiced: "true" })).body.data;

    expect(all.amcVisits.items.length).toBeGreaterThan(pending.amcVisits.items.length);
    expect(all.amcVisits.items.find((item: { id: string }) => item.id === visitId(0))).toMatchObject({
      invoiceEligibility: "INVOICED",
      invoicedAmount: "405.000",
    });
    expect(all.amcVisits.pendingCount).toBe(pending.amcVisits.pendingCount);
    expect(all.amcVisits.pendingAmount).toBe(pending.amcVisits.pendingAmount);
    expect(all.projects.pendingValue).toBe(pending.projects.pendingValue);
    expect((await billable({ includeInvoiced: "true" })).status).toBe(400);
  });

  it("never lists historical records, open work or work with nothing to invoice", async () => {
    const data = (await billable({ clientId: fixture.clientId, includeInvoiced: "true" })).body.data;
    const ids = data.amcVisits.items.map((item: { id: string }) => item.id);
    const jobNumbers = data.projects.items.map((item: { jobNumber: string }) => item.jobNumber);

    expect(ids).not.toContain(visitId(3));
    expect(ids).not.toContain(visitId(4));
    expect(ids).not.toContain(visitId(5));
    expect(jobNumbers).not.toContain("GPSA9901");
  });

  it("states no uninvoiced value for a historical or cancelled project", async () => {
    const cancelled = await newProject(admin, fixture.clientId);
    await api().post(`/api/projects/${cancelled.id}/status`).set(admin.headers).send({ status: "CANCELLED" });

    const rows = await pool.query<{ status: string; invoice_state: string; invoiced_value: string; uninvoiced_value: string | null }>(
      `SELECT p.status, f.invoice_state, f.invoiced_value, f.uninvoiced_value
       FROM projects p JOIN v_project_financials f ON f.project_id = p.id
       WHERE p.job_number = 'GPSA9901' OR p.id = $1 ORDER BY p.status`,
      [cancelled.id]
    );

    expect(rows.rows).toEqual([
      { status: "CANCELLED", invoice_state: "NOT_APPLICABLE", invoiced_value: "0.000", uninvoiced_value: null },
      { status: "HISTORICAL", invoice_state: "HISTORICAL", invoiced_value: "0.000", uninvoiced_value: null },
    ]);
    expect((await api().get(`/api/projects/${cancelled.id}`).set(admin.headers)).body.data).toMatchObject({
      invoicedValue: "0.000",
      uninvoicedValue: null,
    });
  });

  it("discloses visit amounts and job values only with the AMC Schedule and Projects permissions", async () => {
    await pool.query("INSERT INTO roles (code, name) VALUES ('INVOICES_ONLY', 'Invoices only')");
    await grant("INVOICES_ONLY", [["INVOICES", "VIEW"]]);
    const invoicesOnly = await signedIn("invoices-only@example.com", ["INVOICES_ONLY"]);
    const work = await billable({}, invoicesOnly);
    const summary = await api().get("/api/invoices/summary").set(invoicesOnly.headers);

    expect(work.status).toBe(200);
    expect(work.body.data).toEqual({ amcVisits: null, projects: null });
    expect(summary.body.data.amc).toBeNull();
    expect(summary.body.data.projects).toBeNull();
    expect(summary.body.data.issued.count).toBeGreaterThan(0);
  });
});

describe("editing an invoice", () => {
  let invoiceId: string;

  it("changes the details entered and records what changed", async () => {
    invoiceId = (await newInvoice(admin, invoiceBody(fixture.clientId, [{ amcVisitId: visitId(8), amount: "405.000" }]))).id;

    const response = await patchInvoice(invoicing, invoiceId, { invoiceNumber: "3300", invoiceDate: "2026-09-20", vatAmount: "20.000", notes: "Corrected" });
    const logs = await logsFor("invoices", invoiceId);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ invoiceNumber: "3300", invoiceDate: "2026-09-20", vatAmount: "20.000", totalAmount: "425.000", notes: "Corrected" });
    expect(logs.at(-1)).toMatchObject({ action: "invoice.updated", user_id: invoicing.id });
    expect(logs.at(-1)?.metadata).toMatchObject({
      changes: { invoiceDate: { from: "2026-09-15", to: "2026-09-20" }, vatAmount: { from: "20.250", to: "20.000" } },
    });
  });

  it("writes nothing when nothing changes", async () => {
    const before = (await logsFor("invoices", invoiceId)).length;
    const response = await patchInvoice(admin, invoiceId, { invoiceNumber: "3300", allocations: [{ amcVisitId: visitId(8), amount: "405" }] });

    expect(response.status).toBe(200);
    expect((await logsFor("invoices", invoiceId)).length).toBe(before);
  });

  it("moves the invoice to other work: the visit left out is ready for invoice again", async () => {
    const response = await patchInvoice(admin, invoiceId, { allocations: [{ amcVisitId: visitId(9), amount: "405.000" }] });
    const logs = await logsFor("invoices", invoiceId);

    expect(response.status).toBe(200);
    expect(response.body.data.allocations.map((allocation: { amcVisit: { id: string } }) => allocation.amcVisit.id)).toEqual([visitId(9)]);
    expect((await visitEligibility(visitId(8))).invoice_eligibility).toBe("READY_FOR_INVOICE");
    expect((await visitEligibility(visitId(9))).invoice_eligibility).toBe("INVOICED");
    expect(logs.at(-1)?.metadata).toMatchObject({
      changes: {
        allocations: { from: [{ amcVisitId: visitId(8), amount: "405.000" }], to: [{ amcVisitId: visitId(9), amount: "405.000" }] },
      },
    });
  });

  it("keeps every rule of a new invoice", async () => {
    const amountOnly = await patchInvoice(admin, invoiceId, { amountExclVat: "500.000" });
    const unreconciled = await patchInvoice(admin, invoiceId, { allocations: [{ amcVisitId: visitId(9), amount: "400.000" }] });
    const openWork = await patchInvoice(admin, invoiceId, { allocations: [{ amcVisitId: visitId(3), amount: "405.000" }] });
    const otherClient = await patchInvoice(admin, invoiceId, { clientId: fixture.otherClientId });
    const duplicate = await patchInvoice(admin, invoiceId, { invoiceNumber: "3201" });
    const nothing = await patchInvoice(admin, invoiceId, {});
    const status = await patchInvoice(admin, invoiceId, { status: "CANCELLED" });

    expect(amountOnly.status).toBe(400);
    expect(amountOnly.body.error.details[0].field).toBe("allocations");
    expect(unreconciled.status).toBe(400);
    expect(openWork.status).toBe(400);
    expect(otherClient.status).toBe(400);
    expect(otherClient.body.error.details[0].message).toMatch(/does not belong to the client/);
    expect(duplicate.status).toBe(409);
    expect(nothing.status).toBe(400);
    expect(status.status).toBe(400);
    expect((await api().get(`/api/invoices/${invoiceId}`).set(admin.headers)).body.data).toMatchObject({
      invoiceNumber: "3300",
      amountExclVat: "405.000",
      client: { id: fixture.clientId },
    });
    expect((await patchInvoice(admin, "999999", { notes: "x" })).status).toBe(404);
  });

  it("changes the amount together with allocations that reconcile", async () => {
    const response = await patchInvoice(admin, invoiceId, {
      amountExclVat: "810.000",
      vatAmount: "40.500",
      allocations: [
        { amcVisitId: visitId(8), amount: "405.000" },
        { amcVisitId: visitId(9), amount: "405.000" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ amountExclVat: "810.000", totalAmount: "850.500" });
    expect(response.body.data.allocations).toHaveLength(2);
  });
});

describe("cancelling an invoice", () => {
  let invoiceId: string;
  let projectId: string;

  beforeAll(async () => {
    const project = await completedProject(admin, fixture.clientId, "600.000");

    projectId = project.id;
    invoiceId = (
      await newInvoice(admin, invoiceBody(fixture.clientId, [{ projectId, amount: "600.000" }], { invoiceNumber: "3400", amountExclVat: "600.000", vatAmount: "30.000" }))
    ).id;
  });

  it("requires a reason", async () => {
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(501) }, { reason: "Mistake", extra: true }]) {
      const response = await cancelInvoice(admin, invoiceId, body);

      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await api().get(`/api/invoices/${invoiceId}`).set(admin.headers)).body.data.status).toBe("ISSUED");
    expect((await projectState(projectId)).invoice_state).toBe("INVOICED");
  });

  it("keeps the record, says who cancelled it and why, and writes the activity log", async () => {
    const response = await cancelInvoice(invoicing, invoiceId, { reason: "  Voided in Zoho: raised against the wrong job.  " });
    const logs = await logsFor("invoices", invoiceId);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "CANCELLED",
      invoiceNumber: "3400",
      amountExclVat: "600.000",
      cancelledBy: { id: invoicing.id },
      cancellationReason: "Voided in Zoho: raised against the wrong job.",
    });
    expect(response.body.data.cancelledAt).toEqual(expect.any(String));
    // The allocations are kept for the record.
    expect(response.body.data.allocations).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({ action: "invoice.cancelled", module: "INVOICES", user_id: invoicing.id });
    expect(logs.at(-1)?.metadata).toMatchObject({
      reason: "Voided in Zoho: raised against the wrong job.",
      invoiceNumber: "3400",
      amountExclVat: "600.000",
      allocations: [{ projectId, amount: "600.000" }],
    });
  });

  it("returns the work it covered to ready for invoice and leaves every total", async () => {
    const all = await list({ projectId });
    const active = await list({ projectId, status: "ISSUED" });

    expect(await projectState(projectId)).toEqual({ invoice_state: "READY_FOR_INVOICE", invoiced_value: "0.000", uninvoiced_value: "600.000" });
    expect(all.body.data.total).toBe(1);
    expect(all.body.data.totals).toEqual({ amountExclVat: "0.000", vatAmount: "0.000", totalAmount: "0.000" });
    expect(active.body.data.total).toBe(0);
    expect((await billable()).body.data.projects.items.map((item: { id: string }) => item.id)).toContain(projectId);
  });

  it("cannot be cancelled twice, edited or brought back", async () => {
    const again = await cancelInvoice(admin, invoiceId);
    const edited = await patchInvoice(admin, invoiceId, { notes: "Changed after cancelling" });
    const logs = await logsFor("invoices", invoiceId);

    expect(again.status).toBe(409);
    expect(edited.status).toBe(409);
    expect(logs.map((log) => log.action)).toEqual(["invoice.created", "invoice.cancelled"]);
    expect((await cancelInvoice(admin, "999999")).status).toBe(404);
    await expect(pool.query("UPDATE invoices SET status = 'ISSUED' WHERE id = $1", [invoiceId])).rejects.toMatchObject({
      constraint: "invoices_cancellation_ck",
    });
  });

  it("frees the invoice number, so an invoice entered by mistake can be entered again", async () => {
    const response = await postInvoice(
      admin,
      invoiceBody(fixture.clientId, [{ projectId, amount: "600.000" }], { invoiceNumber: "3400", amountExclVat: "600.000", vatAmount: "30.000" })
    );

    expect(response.status).toBe(201);
    expect((await projectState(projectId)).invoice_state).toBe("INVOICED");
    expect((await list({ projectId })).body.data.total).toBe(2);
  });
});

describe("permissions", () => {
  const body = () => invoiceBody(fixture.clientId, [{ amcVisitId: visitId(8), amount: "405.000" }]);
  let invoiceId: string;

  beforeAll(async () => {
    invoiceId = (await list({ search: "3201" })).body.data.items[0].id;
  });

  it("requires a signed-in user", async () => {
    expect((await api().get("/api/invoices")).status).toBe(401);
    expect((await api().get("/api/invoices/summary")).status).toBe(401);
    expect((await api().get("/api/invoices/billable")).status).toBe(401);
    expect((await api().post("/api/invoices").send(body())).status).toBe(401);
    expect((await api().patch(`/api/invoices/${invoiceId}`).send({ notes: "x" })).status).toBe(401);
    expect((await api().post(`/api/invoices/${invoiceId}/cancel`).send({ reason: "x" })).status).toBe(401);
  });

  it("gives a role without the Invoices permission nothing", async () => {
    for (const path of ["/api/invoices", "/api/invoices/summary", "/api/invoices/billable", `/api/invoices/${invoiceId}`]) {
      expect((await api().get(path).set(execution.headers)).status, path).toBe(403);
    }
    expect((await postInvoice(execution, body())).status).toBe(403);
    expect((await patchInvoice(execution, invoiceId, { notes: "x" })).status).toBe(403);
    expect((await cancelInvoice(execution, invoiceId)).status).toBe(403);
  });

  it("lets the Accountant view but not record, change or cancel", async () => {
    const before = await counts();

    expect((await list({}, accountant)).status).toBe(200);
    expect((await api().get(`/api/invoices/${invoiceId}`).set(accountant.headers)).status).toBe(200);
    expect((await billable({}, accountant)).status).toBe(200);
    expect((await postInvoice(accountant, body())).status).toBe(403);
    expect((await patchInvoice(accountant, invoiceId, { notes: "x" })).status).toBe(403);
    expect((await cancelInvoice(accountant, invoiceId)).status).toBe(403);
    expect(await counts()).toEqual(before);
    expect((await api().get(`/api/invoices/${invoiceId}`).set(admin.headers)).body.data.status).toBe("ISSUED");
  });

  it("separates recording from changing and cancelling", async () => {
    await pool.query("INSERT INTO roles (code, name) VALUES ('INVOICE_ENTRY', 'Invoice entry')");
    await grant("INVOICE_ENTRY", [
      ["INVOICES", "VIEW"],
      ["INVOICES", "CREATE"],
    ]);
    const entry = await signedIn("invoice-entry@example.com", ["INVOICE_ENTRY"]);
    const created = await postInvoice(entry, body());

    expect(created.status).toBe(201);
    expect((await patchInvoice(entry, created.body.data.id, { notes: "x" })).status).toBe(403);
    expect((await cancelInvoice(entry, created.body.data.id)).status).toBe(403);
    expect((await cancelInvoice(invoicing, created.body.data.id)).status).toBe(200);
  });
});

describe("summary", () => {
  it("reports invoice figures that match the stored records, cancelled invoices left out", async () => {
    const response = await api().get("/api/invoices/summary").set(admin.headers);
    const stored = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'ISSUED')::int AS issued,
              count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              sum(amount_excl_vat) FILTER (WHERE status = 'ISSUED')::numeric(18,3) AS net,
              sum(vat_amount) FILTER (WHERE status = 'ISSUED')::numeric(18,3) AS vat,
              sum(total_amount) FILTER (WHERE status = 'ISSUED')::numeric(18,3) AS total
       FROM invoices`
    );
    const allocated = await pool.query(
      `SELECT COALESCE(sum(a.allocated_amount) FILTER (WHERE a.amc_visit_id IS NOT NULL), 0)::numeric(18,3) AS visits,
              COALESCE(sum(a.allocated_amount) FILTER (WHERE a.project_id IS NOT NULL), 0)::numeric(18,3) AS projects
       FROM invoice_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE i.status = 'ISSUED'`
    );
    const work = (await billable()).body.data;

    expect(response.status).toBe(200);
    expect(stored.rows[0].cancelled).toBeGreaterThan(0);
    expect(response.body.data.issued).toEqual({
      count: stored.rows[0].issued,
      amountExclVat: stored.rows[0].net,
      vatAmount: stored.rows[0].vat,
      totalAmount: stored.rows[0].total,
    });
    expect(response.body.data.cancelled).toEqual({ count: stored.rows[0].cancelled });
    expect(response.body.data.amc.pending).toEqual({ count: work.amcVisits.pendingCount, amount: work.amcVisits.pendingAmount });
    expect(response.body.data.amc.invoiced.invoicedAmount).toBe(allocated.rows[0].visits);
    expect(response.body.data.projects.pending).toEqual({ count: work.projects.pendingCount, uninvoicedValue: work.projects.pendingValue });
    expect(response.body.data.projects.invoicedValue).toBe(allocated.rows[0].projects);
    // Every allocated amount belongs to a visit or to a project, never to both.
    expect(
      (await pool.query("SELECT ($1::numeric + $2::numeric)::numeric(18,3) = $3::numeric AS ok", [allocated.rows[0].visits, allocated.rows[0].projects, stored.rows[0].net])).rows[0].ok
    ).toBe(true);
  });

  it("takes invoiced work out of the AMC and Projects ready-for-invoice figures", async () => {
    const amc = (await api().get("/api/amc/summary").set(admin.headers)).body.data.invoicing;
    const projects = (await api().get("/api/projects/summary").set(admin.headers)).body.data;
    const summary = (await api().get("/api/invoices/summary").set(admin.headers)).body.data;
    const dashboard = (await api().get("/api/dashboard/summary").set(admin.headers)).body.data;

    expect(amc.readyForInvoice).toEqual(summary.amc.pending);
    expect(projects.counts.readyForInvoice + summary.projects.partlyInvoiced.count).toBe(summary.projects.pending.count);
    expect(dashboard.invoices).toEqual(summary);
  });
});

describe("database constraints", () => {
  it("refuse an allocation with no target or two, a zero amount and an invalid invoice", async () => {
    const invoice = (await list({ search: "3201" })).body.data.items[0];
    const allocation = (visit: string | null, project: string | null, amount: string) =>
      pool.query("INSERT INTO invoice_allocations (invoice_id, amc_visit_id, project_id, allocated_amount, created_by) VALUES ($1, $2, $3, $4, $5)", [
        invoice.id,
        visit,
        project,
        amount,
        admin.id,
      ]);
    const project = await completedProject(admin, fixture.clientId);
    const row = (overrides: Record<string, unknown>) => {
      const values = { invoice_number: invoiceNumber(), amount_excl_vat: "10", vat_amount: "0", status: "ISSUED", source: "ZOHO", ...overrides };

      return pool.query(
        `INSERT INTO invoices (invoice_number, client_id, invoice_date, amount_excl_vat, vat_amount, status, source, created_by)
         VALUES ($1, $2, '2026-09-15', $3, $4, $5, $6, $7)`,
        [values.invoice_number, fixture.clientId, values.amount_excl_vat, values.vat_amount, values.status, values.source, admin.id]
      );
    };

    await expect(allocation(null, null, "1")).rejects.toMatchObject({ constraint: "invoice_allocations_target_ck" });
    await expect(allocation(visitId(0), project.id, "1")).rejects.toMatchObject({ constraint: "invoice_allocations_target_ck" });
    await expect(allocation(null, project.id, "0")).rejects.toMatchObject({ constraint: "invoice_allocations_allocated_amount_ck" });
    await expect(allocation(visitId(0), null, "1")).rejects.toMatchObject({ constraint: "invoice_allocations_invoice_visit_uq" });
    await expect(row({ invoice_number: " 9 " })).rejects.toMatchObject({ constraint: "invoices_invoice_number_ck" });
    await expect(row({ amount_excl_vat: "0" })).rejects.toMatchObject({ constraint: "invoices_amount_excl_vat_ck" });
    await expect(row({ vat_amount: "-1" })).rejects.toMatchObject({ constraint: "invoices_vat_amount_ck" });
    await expect(row({ status: "PAID" })).rejects.toMatchObject({ constraint: "invoices_status_ck" });
    await expect(row({ status: "CANCELLED" })).rejects.toMatchObject({ constraint: "invoices_cancellation_ck" });
    await expect(row({ source: "MANUAL" })).rejects.toMatchObject({ constraint: "invoices_source_ck" });
    await expect(row({ invoice_number: "3201" })).rejects.toMatchObject({ constraint: "invoices_invoice_number_uq" });
  });

  it("keep invoiced work from being deleted", async () => {
    await expect(pool.query("DELETE FROM amc_visits WHERE id = $1", [visitId(0)])).rejects.toMatchObject({
      constraint: "invoice_allocations_amc_visit_id_fk",
    });
  });
});
