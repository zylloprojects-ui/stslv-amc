import { pool } from "../src/config/database";
import { api, resetData, signedIn } from "./helpers";

export type Session = Awaited<ReturnType<typeof signedIn>>;

/**
 * resetData() empties clients and users, which also empties projects,
 * procurement requests and expenses (they reference them). The job-number
 * counter and the default VAT rate are configuration, so they are put back here.
 */
export async function resetProjectData(): Promise<void> {
  await resetData();
  await pool.query("UPDATE number_sequences SET prefix = 'GPSA', next_number = 1, pad_length = 4 WHERE sequence_key = 'job_number'");
  await pool.query("UPDATE app_settings SET value = '5.000' WHERE key = 'projects.default_vat_rate'");
  await pool.query("UPDATE expense_categories SET is_active = true");
}

/** Inserts a client directly, bypassing the API. Returns the new id. */
export async function insertClient(name: string, isActive = true): Promise<string> {
  const result = await pool.query<{ id: string }>("INSERT INTO clients (name, is_active) VALUES ($1, $2) RETURNING id", [
    name,
    isActive,
  ]);

  return (result.rows[0] as { id: string }).id;
}

export async function today(): Promise<string> {
  const result = await pool.query<{ today: string }>("SELECT CURRENT_DATE::text AS today");

  return (result.rows[0] as { today: string }).today;
}

export async function categoryId(code: string): Promise<string> {
  const result = await pool.query<{ id: string }>("SELECT id FROM expense_categories WHERE code = $1", [code]);

  return (result.rows[0] as { id: string }).id;
}

export function postProject(session: Session, body: Record<string, unknown>) {
  return api().post("/api/projects").set(session.headers).send(body);
}

/** Creates a project through the API and returns its stored representation. */
export async function newProject(session: Session, clientId: string, overrides: Record<string, unknown> = {}) {
  const response = await postProject(session, {
    clientId,
    description: "Fire alarm panel replacement",
    jobDate: "2026-09-01",
    jobValue: "1000.000",
    ...overrides,
  });

  if (response.status !== 201) {
    throw new Error(`Project was not created: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return response.body.data as Record<string, string | null> & { id: string; jobNumber: string };
}

export function setStatus(session: Session, projectId: string, body: Record<string, unknown>) {
  return api().post(`/api/projects/${projectId}/status`).set(session.headers).send(body);
}

export function postExpense(session: Session, body: Record<string, unknown>) {
  return api().post("/api/expenses").set(session.headers).send(body);
}

export function postProcurement(session: Session, body: Record<string, unknown>) {
  return api().post("/api/procurement").set(session.headers).send(body);
}

export async function logsFor(entityType: string, entityId: string) {
  const result = await pool.query<{ action: string; user_id: string; module: string; metadata: Record<string, unknown> | null }>(
    "SELECT action, user_id, module, metadata FROM activity_logs WHERE entity_type = $1 AND entity_id = $2 ORDER BY id",
    [entityType, entityId]
  );

  return result.rows;
}
