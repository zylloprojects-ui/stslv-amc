import { ZodError } from "zod";
import { pool } from "../src/config/database";
import { createNewContractFieldsSchema } from "../src/modules/amc/amc.schemas";
import { createNewContract } from "../src/modules/amc/contracts.service";
import { discardStoredFile } from "../src/modules/attachments/attachments.service";
import { loadUserPermissions, loadUserRoles, type AuthContext } from "../src/modules/auth/access";
import { AppError } from "../src/shared/errors";
import { api, signedIn, withAuditLogUnlocked } from "./helpers";

export type Session = Awaited<ReturnType<typeof signedIn>>;

/** The database's current date, which "due" and "overdue" are measured against. */
export async function today(): Promise<string> {
  const result = await pool.query<{ today: string }>("SELECT current_date::text AS today");

  return (result.rows[0] as { today: string }).today;
}

export async function createClient(session: Session, name: string): Promise<string> {
  const response = await api().post("/api/clients").set(session.headers).send({ name, clientType: "COMPANY" });

  if (response.status !== 201) {
    throw new Error(`Could not create client ${name}: ${response.status}`);
  }

  return response.body.data.id as string;
}

/** A valid contract body; a 12-month quarterly contract unless overridden. */
/** An active sales engineer, which every renewal must name. Made active again if a test deactivated it. */
export async function renewalEngineer(name = "Renewal Test Engineer"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO sales_engineers (name, is_active) VALUES ($1, true)
     ON CONFLICT ((lower(btrim(name)))) DO UPDATE SET is_active = true
     RETURNING id`,
    [name]
  );

  return (result.rows[0] as { id: string }).id;
}

let referenceCount = 0;

/** A unique AMC Reference Number for a test contract (migration 0105 makes it required and unique for ever). */
export function testReference(prefix = "TEST"): string {
  referenceCount += 1;

  // Fixed width, so a search for one reference never matches another as a substring.
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${String(referenceCount).padStart(4, "0")}`;
}

/** The stored AMC Reference Number of a contract (Recycle Bin included). */
export async function referenceOf(contractId: string | number): Promise<string> {
  // As every list, report and export shows it: the number, plus " (V2)" from a renewal's second version on (0111).
  const result = await pool.query<{ amc_reference: string }>(
    "SELECT amc_reference || CASE WHEN contract_version > 1 THEN ' (V' || contract_version || ')' ELSE '' END AS amc_reference FROM amc_contracts_all WHERE id = $1",
    [String(contractId)]
  );
  const row = result.rows[0];

  if (!row) throw new Error(`No contract ${contractId}.`);
  return row.amc_reference;
}

export function contractBody(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    amcReference: testReference(),
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

/** The smallest file the API recognises as a PDF, for contracts whose document is not under test. */
export const TEST_PDF = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");

/** A contract document as POST /api/amc/contracts expects it. */
export function contractDocument(data: Buffer = TEST_PDF, fileName = "contract.pdf") {
  return { fileName, contentBase64: data.toString("base64") };
}

/**
 * A renewal body with its required renewal contract document (client fixes, 2026-11-09), for tests whose subject is
 * not the document. A body that already names a document keeps it.
 */
export function withRenewalDocument<T extends object>(body: T): Omit<T, "amcReference"> & { contractDocument: { fileName: string; contentBase64: string } } {
  // A renewal keeps the contract number of the contract it renews (0111): a typed number is left out.
  const { amcReference: _number, ...rest } = body as T & { amcReference?: unknown };
  return { contractDocument: contractDocument(TEST_PDF, "renewal.pdf"), ...(rest as Omit<T, "amcReference">) };
}

/**
 * An active system type named exactly `name`, so a contract saved with it keeps that system text. Its code is
 * made from the name. Made active again if a test deactivated it.
 */
export async function systemTypeNamed(name: string): Promise<string> {
  const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "SYSTEM";
  const result = await pool.query<{ id: string }>(
    `INSERT INTO system_types (code, name, is_active) VALUES ($1, $2, true)
     ON CONFLICT ((lower(btrim(code)))) DO UPDATE SET is_active = true, name = EXCLUDED.name
     RETURNING id`,
    [code, name]
  );

  return (result.rows[0] as { id: string }).id;
}

/**
 * A complete body for adding a contract (POST /api/amc/contracts, 2026-11-03): contractBody plus the fields a new
 * contract must carry — an active sales engineer, the system type of its system, Final Credit and a contract
 * document. Each can be overridden; set one to undefined to leave it out.
 */
export async function newContractBody(clientId: string, overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = contractBody(clientId, overrides);
  const system = typeof body.systemDescription === "string" && body.systemDescription.trim() !== "" ? body.systemDescription : "FIRE";

  return {
    salesEngineerId: "salesEngineerId" in overrides ? undefined : await renewalEngineer("Contract Test Engineer"),
    systemTypeId: "systemTypeId" in overrides ? undefined : await systemTypeNamed(system),
    finalCredit: "0.000",
    contractDocument: contractDocument(),
    ...body,
  };
}

/** A response as the API would send it: the status code and the parsed JSON body. */
interface FixtureResponse {
  status: number;
  body: { success: boolean; data?: any; error?: { code: string; message: string; details?: { field: string; message: string }[] } };
}

/**
 * Test setup only: adds a DRAFT contract through the service, because POST /api/amc/contracts adds Active contracts
 * only (2026-11-04) and refuses an explicit Draft. Everything else is as the endpoint does it: the same AMC Contracts
 * Create permission, the same field rules (createNewContractFieldsSchema, which still allows Draft for internal use),
 * the same contract document handling, and the same response shape.
 */
async function createDraftForTest(session: Session, body: Record<string, unknown>): Promise<FixtureResponse> {
  const fail = (status: number, code: string, message: string, details?: { field: string; message: string }[]): FixtureResponse => ({
    status,
    body: { success: false, error: { code, message, ...(details ? { details } : {}) } },
  });
  const found = await pool.query<{ id: string; email: string; full_name: string; must_change_password: boolean }>(
    "SELECT id, email, full_name, must_change_password FROM users WHERE id = $1",
    [session.id]
  );
  const user = found.rows[0];

  if (!user) return fail(401, "UNAUTHORIZED", "Authentication is required.");
  // As the authenticate middleware: a user still on a temporary password reaches no endpoint but the password change.
  if (user.must_change_password) return fail(403, "PASSWORD_CHANGE_REQUIRED", "Choose a new password before continuing.");

  const auth: AuthContext = {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    roles: await loadUserRoles(pool, user.id),
    permissions: await loadUserPermissions(pool, user.id),
    mustChangePassword: user.must_change_password,
  };

  if (!auth.permissions.has("AMC_CONTRACTS:CREATE")) return fail(403, "FORBIDDEN", "You do not have permission to perform this action.");

  try {
    const contract = await createNewContract(auth, createNewContractFieldsSchema.parse(JSON.parse(JSON.stringify(body))));

    return { status: 201, body: { success: true, data: JSON.parse(JSON.stringify(contract)) } };
  } catch (error) {
    if (error instanceof ZodError) {
      return fail(400, "VALIDATION_ERROR", "Some fields are invalid.", error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })));
    }
    if (error instanceof AppError) return fail(error.status, error.code, error.message, error.details);
    throw error;
  }
}

/**
 * Adds a contract for a test. Like the old endpoint default, a fixture that names no status is a DRAFT: those are
 * added through the service (createDraftForTest). An ACTIVE fixture goes through POST /api/amc/contracts as a user's would.
 */
export async function createContract(session: Session, clientId: string, overrides: Record<string, unknown> = {}): Promise<FixtureResponse> {
  const body: Record<string, unknown> = { status: "DRAFT", ...(await newContractBody(clientId, overrides)) };

  if (body.status === "DRAFT") return createDraftForTest(session, body);

  const response = await api().post("/api/amc/contracts").set(session.headers).send(body);

  return { status: response.status, body: response.body };
}

/**
 * The error of a refused fixture request, with its field details (none listed = an empty list). Fails the test
 * with the actual response when the request was not refused with an error.
 */
export function fixtureError(response: FixtureResponse): { code: string; message: string; details: { field: string; message: string }[] } {
  const error = response.body.error;

  if (!error) throw new Error(`Expected an error response, got ${response.status} ${JSON.stringify(response.body)}`);

  return { code: error.code, message: error.message, details: error.details ?? [] };
}

/** Creates an ACTIVE contract (its schedule is generated) and returns its id. */
export async function activeContract(session: Session, clientId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await createContract(session, clientId, { status: "ACTIVE", ...overrides });

  if (response.status !== 201) {
    throw new Error(`Could not create contract: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return response.body.data.id as string;
}

const LEGACY_PLACEHOLDER = "Legacy Contract Placeholder";

/**
 * An ACTIVE contract as one added before 2026-11-03 could be: a typed system with no System Types link, no Sales
 * Engineer link, no Final Credit (unless given) and no contract document. Added through the API, so its schedule is
 * generated as usual, then returned to that older state directly in the database, with the creation's link and
 * document entries removed from its history. The placeholder system type it was added with is removed again.
 */
export async function legacyContract(session: Session, clientId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { systemDescription = "FIRE", finalCredit = null, ...rest } = overrides;
  const id = await activeContract(session, clientId, { ...rest, systemDescription: LEGACY_PLACEHOLDER, finalCredit: finalCredit ?? "0.000" });

  await pool.query("UPDATE amc_contracts_all SET sales_engineer_id = NULL, system_type_id = NULL, system_description = $2, final_credit = $3 WHERE id = $1", [id, systemDescription, finalCredit]);
  const documents = await pool.query<{ storage_key: string }>("DELETE FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1 RETURNING storage_key", [id]);
  for (const row of documents.rows) await discardStoredFile(row.storage_key);
  await withAuditLogUnlocked("DELETE FROM activity_logs WHERE entity_type = 'amc_contracts' AND entity_id = $1 AND action IN ('amc_contract.masters_linked', 'attachment.uploaded')", [id]);
  await pool.query("DELETE FROM system_types t WHERE t.name = $1 AND NOT EXISTS (SELECT 1 FROM amc_contracts_all c WHERE c.system_type_id = t.id)", [LEGACY_PLACEHOLDER]);

  return id;
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

/**
 * Records a current Service Report against one visit (migration 0104) directly in the database, so a test whose
 * subject is not the upload itself can complete the visit. Metadata only: no file is stored, so it cannot be
 * downloaded. tests/service-reports.test.ts covers the real upload. Returns the attachment id.
 */
export async function withServiceReport(visitId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ('amc_visits', $1, 'SERVICE_REPORT', 'Service report', 'fixture-report.pdf', 'application/pdf', 1, repeat('0', 64),
             gen_random_uuid()::text || '.pdf', (SELECT min(id) FROM users))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [visitId]
  );
  const id = result.rows[0]?.id;

  if (id) await pool.query("UPDATE attachments SET document_id = id WHERE id = $1", [id]);
  return id ?? "";
}

/** Attaches a fixture Service Report (withServiceReport) when a request body is about to complete the visit. */
export async function reportIfCompleting(visitId: string | undefined, body: Record<string, unknown>): Promise<void> {
  if (visitId && body.status === "COMPLETED") await withServiceReport(visitId);
}
