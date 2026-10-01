import { pool } from "../src/config/database";
import { api, signedIn } from "./helpers";

export type Session = Awaited<ReturnType<typeof signedIn>>;

/** The database's current date, which "due" and "overdue" are measured against. */
export async function today(): Promise<string> {
  const result = await pool.query<{ today: string }>("SELECT current_date::text AS today");

  return (result.rows[0] as { today: string }).today;
}

export async function createClient(session: Session, name: string): Promise<string> {
  const response = await api().post("/api/clients").set(session.headers).send({ name });

  if (response.status !== 201) {
    throw new Error(`Could not create client ${name}: ${response.status}`);
  }

  return response.body.data.id as string;
}

/** A valid contract body; a 12-month quarterly contract unless overridden. */
export function contractBody(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    responsibleEngineer: "Test Engineer",
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    systemDescription: "FIRE",
    contractValue: "1620.000",
    maintenanceFrequency: "QUARTERLY",
    defaultVisitAmount: "405.000",
    ...overrides,
  };
}

export async function createContract(session: Session, clientId: string, overrides: Record<string, unknown> = {}) {
  return api().post("/api/amc/contracts").set(session.headers).send(contractBody(clientId, overrides));
}

/** Creates an ACTIVE contract (its schedule is generated) and returns its id. */
export async function activeContract(session: Session, clientId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await createContract(session, clientId, { status: "ACTIVE", ...overrides });

  if (response.status !== 201) {
    throw new Error(`Could not create contract: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return response.body.data.id as string;
}

export interface VisitRecord {
  id: string;
  sequence_no: number;
  period_start: string;
  period_end: string;
  scheduled_date: string;
  original_scheduled_date: string;
  status: string;
  visit_amount: string | null;
  amount_is_custom: boolean;
  completed_date: string | null;
  completed_by: string | null;
}

/** The stored visits of a contract, read straight from PostgreSQL. */
export async function visitsOf(contractId: string): Promise<VisitRecord[]> {
  const result = await pool.query<VisitRecord>(
    `SELECT id, sequence_no, period_start::text AS period_start, period_end::text AS period_end,
            scheduled_date::text AS scheduled_date, original_scheduled_date::text AS original_scheduled_date,
            status, visit_amount, amount_is_custom, completed_date::text AS completed_date, completed_by
     FROM amc_visits WHERE amc_contract_id = $1 ORDER BY period_start`,
    [contractId]
  );

  return result.rows;
}

export async function logsFor(entityType: string, entityId: string) {
  const result = await pool.query<{ action: string; user_id: string; module: string; metadata: Record<string, unknown> | null }>(
    "SELECT action, user_id, module, metadata FROM activity_logs WHERE entity_type = $1 AND entity_id = $2 ORDER BY id",
    [entityType, entityId]
  );

  return result.rows;
}

/** Grants extra permissions to a role directly in the database. */
export async function grant(roleCode: string, permissions: [string, string][]) {
  for (const [module, action] of permissions) {
    await pool.query(
      "INSERT INTO role_permissions (role_id, module, action) SELECT id, $2, $3 FROM roles WHERE code = $1 ON CONFLICT DO NOTHING",
      [roleCode, module, action]
    );
  }
}
