import { pool } from "../src/config/database";
import { activeContract, createClient, visitsOf, type Session, type VisitRecord } from "./amc-helpers";
import { api } from "./helpers";
import { newProject, setStatus } from "./projects-helpers";

export type { Session };

export interface Fixture {
  clientId: string;
  otherClientId: string;
  contractId: string;
  /** Twelve monthly visits through 2025, each 405.000. None is completed. */
  visits: VisitRecord[];
}

/** Two clients and, for the first, an active contract with twelve past visits. */
export async function invoiceFixture(admin: Session): Promise<Fixture> {
  const clientId = await createClient(admin, "Test Hotel");
  const otherClientId = await createClient(admin, "Other Mall");
  const contractId = await activeContract(admin, clientId, {
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    maintenanceFrequency: "MONTHLY",
    contractValue: "4860.000",
    defaultVisitAmount: "405.000",
  });

  return { clientId, otherClientId, contractId, visits: await visitsOf(contractId) };
}

export const executeVisit = (session: Session, visitId: string, body: Record<string, unknown>) =>
  api().patch(`/api/amc/execution/visits/${visitId}`).set(session.headers).send(body);

export async function completeVisit(session: Session, visitId: string): Promise<void> {
  const response = await executeVisit(session, visitId, { status: "COMPLETED", completedDate: "2025-12-15" });

  if (response.status !== 200) {
    throw new Error(`Visit was not completed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

/** Creates a project through the API and completes it. */
export async function completedProject(session: Session, clientId: string, jobValue = "1000.000") {
  const project = await newProject(session, clientId, { jobValue });
  const response = await setStatus(session, project.id, { status: "COMPLETED", completedDate: "2026-09-10" });

  if (response.status !== 200) {
    throw new Error(`Project was not completed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return project;
}

let nextNumber = 5000;

/** A fresh invoice number, so tests do not collide. */
export const invoiceNumber = () => String(nextNumber++);

export function invoiceBody(clientId: string, allocations: Record<string, string>[], overrides: Record<string, unknown> = {}) {
  return {
    invoiceNumber: invoiceNumber(),
    clientId,
    invoiceDate: "2026-09-15",
    amountExclVat: "405.000",
    vatAmount: "20.250",
    allocations,
    ...overrides,
  };
}

export const postInvoice = (session: Session, body: Record<string, unknown>) =>
  api().post("/api/invoices").set(session.headers).send(body);

export const patchInvoice = (session: Session, id: string, body: Record<string, unknown>) =>
  api().patch(`/api/invoices/${id}`).set(session.headers).send(body);

export const cancelInvoice = (session: Session, id: string, body: Record<string, unknown> = { reason: "Entered against the wrong work." }) =>
  api().post(`/api/invoices/${id}/cancel`).set(session.headers).send(body);

/** Records an invoice through the API and returns its stored representation. */
export async function newInvoice(session: Session, body: Record<string, unknown>) {
  const response = await postInvoice(session, body);

  if (response.status !== 201) {
    throw new Error(`Invoice was not recorded: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return response.body.data as { id: string; invoiceNumber: string; status: string };
}

export async function visitEligibility(visitId: string): Promise<{ invoice_eligibility: string; invoiced_amount: string }> {
  const result = await pool.query<{ invoice_eligibility: string; invoiced_amount: string }>(
    "SELECT invoice_eligibility, invoiced_amount FROM v_amc_visit_billing WHERE amc_visit_id = $1",
    [visitId]
  );

  return result.rows[0] as { invoice_eligibility: string; invoiced_amount: string };
}

export async function projectState(projectId: string): Promise<{ invoice_state: string; invoiced_value: string; uninvoiced_value: string }> {
  const result = await pool.query<{ invoice_state: string; invoiced_value: string; uninvoiced_value: string }>(
    "SELECT invoice_state, invoiced_value, uninvoiced_value FROM v_project_financials WHERE project_id = $1",
    [projectId]
  );

  return result.rows[0] as { invoice_state: string; invoiced_value: string; uninvoiced_value: string };
}
