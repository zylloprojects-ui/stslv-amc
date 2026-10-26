import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, signedIn } from "./helpers";
import {
  cancelInvoice,
  completeVisit,
  completedProject,
  executeVisit,
  invoiceBody,
  invoiceFixture,
  newInvoice,
  patchInvoice,
  postInvoice,
  projectState,
  visitEligibility,
  type Fixture,
  type Session,
} from "./invoices-helpers";
import { logsFor, resetProjectData, setStatus } from "./projects-helpers";

// Work that an active invoice covers is locked: its amount, its completion and
// its client cannot change underneath the invoice. Cancelling the invoice, or
// taking the work off it, lifts the lock.

let admin: Session;
let fixture: Fixture;

const visitId = (index: number) => fixture.visits[index]?.id as string;
const patchVisit = (index: number, body: Record<string, unknown>) =>
  api().patch(`/api/amc/visits/${visitId(index)}`).set(admin.headers).send(body);
const patchProject = (id: string, body: Record<string, unknown>) => api().patch(`/api/projects/${id}`).set(admin.headers).send(body);
const patchContract = (body: Record<string, unknown>) =>
  api().patch(`/api/amc/contracts/${fixture.contractId}`).set(admin.headers).send(body);
const visitInvoice = (index: number, overrides: Record<string, unknown> = {}) =>
  newInvoice(admin, invoiceBody(fixture.clientId, [{ amcVisitId: visitId(index), amount: "405.000" }], overrides));
const storedVisit = async (index: number) =>
  (await pool.query<{ status: string; visit_amount: string | null }>("SELECT status, visit_amount FROM amc_visits WHERE id = $1", [visitId(index)]))
    .rows[0];

beforeAll(async () => {
  await resetProjectData();
  // The administrator holds every permission, including the approval needed to reopen a visit.
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  fixture = await invoiceFixture(admin);

  for (const index of [0, 1, 2, 3, 4]) {
    await completeVisit(admin, visitId(index));
  }
});
afterAll(closePool);

describe("an invoiced AMC visit", () => {
  let invoiceId: string;

  beforeAll(async () => {
    invoiceId = (await visitInvoice(0, { invoiceNumber: "8101" })).id;
  });

  it("cannot be given another amount", async () => {
    for (const visitAmount of ["500.000", "0", null]) {
      const response = await patchVisit(0, { visitAmount });

      expect(response.status, String(visitAmount)).toBe(409);
      expect(response.body.error.message).toBe(
        "This visit is covered by invoice 8101 and cannot be given another amount. Cancel the invoice first."
      );
    }
    expect(await storedVisit(0)).toEqual({ status: "COMPLETED", visit_amount: "405.000" });
  });

  it("cannot be reopened, by any status change, even with approval permission", async () => {
    for (const status of ["SCHEDULED", "IN_PROGRESS", "POSTPONED", "CANCELLED"]) {
      const response = await executeVisit(admin, visitId(0), { status });

      expect(response.status, status).toBe(409);
      expect(response.body.error.message).toBe("This visit is covered by invoice 8101 and cannot be reopened. Cancel the invoice first.");
    }
    expect(await storedVisit(0)).toEqual({ status: "COMPLETED", visit_amount: "405.000" });
    expect((await visitEligibility(visitId(0))).invoice_eligibility).toBe("INVOICED");
  });

  it("writes nothing to the activity log when a locked change is refused", async () => {
    const actions = (await logsFor("amc_visits", visitId(0))).map((log) => log.action);

    expect(actions).toEqual(["amc_visit.completed"]);
  });

  it("can still have its notes, assignment and work details changed", async () => {
    const planning = await patchVisit(0, { notes: "Invoice sent to the client", assignedTo: "Engineer B" });
    const work = await executeVisit(admin, visitId(0), { workPerformed: "Panel tested", completedDate: "2025-12-16" });
    const sameAmount = await patchVisit(0, { visitAmount: "405.000" });

    expect(planning.status).toBe(200);
    expect(work.status).toBe(200);
    expect(work.body.data).toMatchObject({ status: "COMPLETED", completedDate: "2025-12-16" });
    // Sending the amount it already has is not a change.
    expect(sameAmount.status).toBe(200);
  });

  it("is unlocked when its invoice is cancelled", async () => {
    expect((await cancelInvoice(admin, invoiceId)).status).toBe(200);
    expect((await visitEligibility(visitId(0))).invoice_eligibility).toBe("READY_FOR_INVOICE");

    const amount = await patchVisit(0, { visitAmount: "450.000" });
    const reopened = await executeVisit(admin, visitId(0), { status: "IN_PROGRESS" });

    expect(amount.status).toBe(200);
    expect(amount.body.data).toMatchObject({ visitAmount: "450.000", invoiceEligibility: "READY_FOR_INVOICE" });
    expect(reopened.status).toBe(200);
    expect(await storedVisit(0)).toEqual({ status: "IN_PROGRESS", visit_amount: "450.000" });
  });

  it("cannot be invoiced again while it is reopened", async () => {
    const response = await postInvoice(admin, invoiceBody(fixture.clientId, [{ amcVisitId: visitId(0), amount: "405.000" }]));

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].message).toMatch(/is not completed/);

    await completeVisit(admin, visitId(0));
    expect((await visitEligibility(visitId(0))).invoice_eligibility).toBe("READY_FOR_INVOICE");
  });

  it("still needs approval permission to be reopened once it is unlocked", async () => {
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);
    const response = await executeVisit(execution, visitId(0), { status: "IN_PROGRESS" });

    expect(response.status).toBe(403);
  });
});

describe("a visit covered by two invoices", () => {
  let first: string;
  let second: string;

  beforeAll(async () => {
    first = (
      await newInvoice(
        admin,
        invoiceBody(fixture.clientId, [{ amcVisitId: visitId(1), amount: "200.000" }], { invoiceNumber: "8201", amountExclVat: "200.000" })
      )
    ).id;
    second = (
      await newInvoice(
        admin,
        invoiceBody(fixture.clientId, [{ amcVisitId: visitId(1), amount: "205.000" }], { invoiceNumber: "8202", amountExclVat: "205.000" })
      )
    ).id;
  });

  it("names both invoices and stays locked until the last one is cancelled", async () => {
    const locked = await executeVisit(admin, visitId(1), { status: "SCHEDULED" });

    expect(locked.status).toBe(409);
    expect(locked.body.error.message).toBe("This visit is covered by invoices 8201, 8202 and cannot be reopened. Cancel the invoice first.");
    expect(await visitEligibility(visitId(1))).toEqual({ invoice_eligibility: "INVOICED", invoiced_amount: "405.000" });

    await cancelInvoice(admin, first);

    expect(await visitEligibility(visitId(1))).toEqual({ invoice_eligibility: "INVOICED", invoiced_amount: "205.000" });
    expect((await patchVisit(1, { visitAmount: "300.000" })).status).toBe(409);
    expect((await executeVisit(admin, visitId(1), { status: "SCHEDULED" })).body.error.message).toMatch(/covered by invoice 8202 and/);

    await cancelInvoice(admin, second);

    expect(await visitEligibility(visitId(1))).toEqual({ invoice_eligibility: "READY_FOR_INVOICE", invoiced_amount: "0.000" });
    expect((await patchVisit(1, { visitAmount: "300.000" })).status).toBe(200);
    expect((await executeVisit(admin, visitId(1), { status: "SCHEDULED" })).status).toBe(200);
  });
});

describe("taking a visit off an invoice", () => {
  it("unlocks the visit left out and locks the visit added", async () => {
    const invoice = await visitInvoice(2);

    expect((await patchVisit(2, { visitAmount: "410.000" })).status).toBe(409);
    expect((await patchInvoice(admin, invoice.id, { allocations: [{ amcVisitId: visitId(3), amount: "405.000" }] })).status).toBe(200);

    expect((await patchVisit(2, { visitAmount: "410.000" })).status).toBe(200);
    expect((await executeVisit(admin, visitId(2), { status: "IN_PROGRESS" })).status).toBe(200);
    expect((await patchVisit(3, { visitAmount: "410.000" })).status).toBe(409);
    expect((await executeVisit(admin, visitId(3), { status: "IN_PROGRESS" })).status).toBe(409);
  });
});

describe("an invoiced project", () => {
  let project: { id: string; jobNumber: string };
  let invoiceId: string;

  beforeAll(async () => {
    project = await completedProject(admin, fixture.clientId, "1000.000");
    invoiceId = (
      await newInvoice(admin, invoiceBody(fixture.clientId, [{ projectId: project.id, amount: "400.000" }], { invoiceNumber: "8301", amountExclVat: "400.000" }))
    ).id;
  });

  it("cannot be reopened, whether partly or fully invoiced", async () => {
    const partly = await setStatus(admin, project.id, { status: "IN_PROGRESS" });

    expect((await projectState(project.id)).invoice_state).toBe("PARTLY_INVOICED");
    expect(partly.status).toBe(409);
    expect(partly.body.error.message).toBe(
      `Project ${project.jobNumber} is covered by invoice 8301 and cannot be reopened. Cancel the invoice first.`
    );

    const rest = await newInvoice(
      admin,
      invoiceBody(fixture.clientId, [{ projectId: project.id, amount: "600.000" }], { invoiceNumber: "8302", amountExclVat: "600.000" })
    );
    const fully = await setStatus(admin, project.id, { status: "IN_PROGRESS" });

    expect((await projectState(project.id)).invoice_state).toBe("INVOICED");
    expect(fully.status).toBe(409);
    expect(fully.body.error.message).toMatch(/covered by invoices 8301, 8302 and cannot be reopened/);

    await cancelInvoice(admin, rest.id);
    expect((await api().get(`/api/projects/${project.id}`).set(admin.headers)).body.data.status).toBe("COMPLETED");
  });

  it("cannot be moved to another client", async () => {
    const response = await patchProject(project.id, { clientId: fixture.otherClientId });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/cannot be moved to another client/);
    expect((await api().get(`/api/projects/${project.id}`).set(admin.headers)).body.data.clientId).toBe(fixture.clientId);
  });

  it("can still be edited otherwise; its invoice state follows its job value", async () => {
    const response = await patchProject(project.id, { notes: "LPO received", jobValue: "400.000" });

    expect(response.status).toBe(200);
    expect(response.body.data.invoiceState).toBe("INVOICED");
    expect((await patchProject(project.id, { jobValue: "1000.000" })).body.data.invoiceState).toBe("PARTLY_INVOICED");
  });

  it("is unlocked when its invoice is cancelled", async () => {
    expect((await cancelInvoice(admin, invoiceId)).status).toBe(200);
    expect(await projectState(project.id)).toEqual({ invoice_state: "READY_FOR_INVOICE", invoiced_value: "0.000", uninvoiced_value: "1000.000" });

    const moved = await patchProject(project.id, { clientId: fixture.otherClientId });
    const reopened = await setStatus(admin, project.id, { status: "IN_PROGRESS" });

    expect(moved.status).toBe(200);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ status: "IN_PROGRESS", invoiceState: "NOT_READY", completedDate: null });
  });

  it("cannot be invoiced while it is reopened", async () => {
    const response = await postInvoice(
      admin,
      invoiceBody(fixture.otherClientId, [{ projectId: project.id, amount: "405.000" }])
    );

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].message).toMatch(/is not completed/);
  });
});

describe("recording an invoice while the work is being reopened", () => {
  it("never leaves an active invoice on work that is not completed", async () => {
    for (let round = 0; round < 5; round += 1) {
      const project = await completedProject(admin, fixture.clientId, "405.000");
      const [invoice, reopened] = await Promise.all([
        postInvoice(admin, invoiceBody(fixture.clientId, [{ projectId: project.id, amount: "405.000" }])),
        setStatus(admin, project.id, { status: "IN_PROGRESS" }),
      ]);

      // Exactly one of the two wins, whichever reaches the project row first.
      expect([invoice.status, reopened.status], `round ${round}`).toSatisfy(
        (statuses: number[]) => (statuses[0] === 201 && statuses[1] === 409) || (statuses[0] === 400 && statuses[1] === 200)
      );
    }

    const broken = await pool.query(
      `SELECT 1 FROM invoice_allocations a
       JOIN invoices i ON i.id = a.invoice_id AND i.status <> 'CANCELLED'
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN amc_visits v ON v.id = a.amc_visit_id
       WHERE COALESCE(p.status, v.status) <> 'COMPLETED'`
    );

    expect(broken.rowCount).toBe(0);
  });
});

describe("the client of an AMC contract", () => {
  it("cannot be changed while an invoice covers one of its visits", async () => {
    const invoice = await visitInvoice(4, { invoiceNumber: "8401" });
    const locked = await patchContract({ clientId: fixture.otherClientId });

    expect(locked.status).toBe(409);
    expect(locked.body.error.message).toMatch(/covered by invoices? .*8401.*its client cannot be changed/);

    // Other contract details are not locked.
    expect((await patchContract({ notes: "Renewal under discussion" })).status).toBe(200);

    // Visit 3 was put on an invoice above; both invoices are cancelled to free the contract.
    const others = await api().get("/api/invoices").query({ status: "ISSUED", clientId: fixture.clientId }).set(admin.headers);

    for (const item of others.body.data.items as { id: string; allocations: { amcVisit: unknown }[] }[]) {
      if (item.allocations.some((allocation) => allocation.amcVisit !== null)) {
        await cancelInvoice(admin, item.id);
      }
    }
    expect(invoice.id).toEqual(expect.any(String));
    expect((await patchContract({ clientId: fixture.otherClientId })).status).toBe(200);
  });
});
