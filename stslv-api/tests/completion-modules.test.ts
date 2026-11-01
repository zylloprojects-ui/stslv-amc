import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { env } from "../src/config/env";
import { addDays } from "../src/modules/amc/amc.schedule";
import { REPORTS } from "../src/modules/reports/reports.service";
import { waitForBackups } from "../src/modules/security/backups.service";
import { activeContract, createClient, today, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { invoiceBody, newInvoice } from "./invoices-helpers";

// Billing Basis, consolidated schedule, Master AMC Status sorting, Reports,
// Security Center, Deletion Log and Backup & Restore.

let admin: Session;
let administrator: Session;
let viewer: Session;
let clientId: string;
let contractId: string;

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${url}`).query(query).set(session.headers);
const post = (url: string, body: Record<string, unknown> = {}, session: Session = admin) => api().post(`/api${url}`).set(session.headers).send(body);
const contract = (overrides: Record<string, unknown>) => ({ clientId, systemDescription: "FIRE", validFrom: "2027-01-01", validTo: "2027-12-31", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "300.000", status: "ACTIVE", ...overrides });

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  administrator = await signedIn("administrator@example.com", ["ADMINISTRATOR"]);
  viewer = await signedIn("viewer@example.com", ["VIEWER"]);
  clientId = await createClient(admin, "Completion Hotel");
  contractId = await activeContract(admin, clientId, contract({}));
});
afterAll(closePool);

describe("Billing Basis", () => {
  it("is optional, stays unset on existing contracts and changes no visit amount", async () => {
    expect((await get(`/amc/contracts/${contractId}`)).body.data.billingBasis).toBeNull();

    const before = await visitsOf(contractId);
    const saved = await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ billingBasis: "CONTRACT_VALUE" });
    expect(saved.status).toBe(200);
    expect(saved.body.data.billingBasis).toBe("CONTRACT_VALUE");
    expect((await visitsOf(contractId)).map((visit) => visit.visit_amount)).toEqual(before.map((visit) => visit.visit_amount));
  });

  it("generates visits from Cost per Visit whichever basis is chosen", async () => {
    const created = await post("/amc/contracts", contract({ billingBasis: "FINAL_CREDIT", finalCredit: "999.000", systemDescription: "BASIS" }));
    expect(created.status).toBe(201);
    expect((await visitsOf(created.body.data.id)).map((visit) => visit.visit_amount)).toEqual(["300.000", "300.000", "300.000", "300.000"]);
  });

  it("refuses an unknown basis, and Final Credit without an amount", async () => {
    expect((await post("/amc/contracts", contract({ billingBasis: "ANNUAL" }))).status).toBe(400);
    const missing = await post("/amc/contracts", contract({ billingBasis: "FINAL_CREDIT" }));
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toContainEqual({ field: "billingBasis", message: "This basis needs a final credit amount." });
  });

  it("is recorded in the contract's history", async () => {
    const history = await get(`/amc/contracts/${contractId}/history`);
    expect(JSON.stringify(history.body.data)).toContain("billingBasis");
  });
});

describe("Consolidated monthly schedule", () => {
  it("gives one row per contract with its services, and totals that match the visits", async () => {
    const monthly = await activeContract(admin, clientId, contract({ maintenanceFrequency: "MONTHLY", defaultVisitAmount: "100.000", systemDescription: "GROUPED", validFrom: "2028-01-01", validTo: "2028-12-31" }));
    const other = await activeContract(admin, clientId, contract({ defaultVisitAmount: "250.000", systemDescription: "GROUPED2", validFrom: "2028-01-15", validTo: "2028-12-31" }));

    const { data } = (await get("/amc/visits/monthly-consolidated", { month: "2028-01" })).body;
    expect(data.items.map((item: { id: string }) => item.id).sort()).toEqual([monthly, other].sort());
    expect(data.totals).toMatchObject({ contracts: 2, services: 2, totalValue: "350.000" });
    expect(data.items.find((item: { id: string }) => item.id === monthly).services[0]).toMatchObject({ serviceCode: "M1", scheduledDate: "2028-01-01", status: "SCHEDULED", visitValue: "100.000", invoiceNumbers: [] });

    // A row per contract, however many visits exist: visit records are untouched.
    expect(await visitsOf(monthly)).toHaveLength(12);
  });

  it("validates the month, follows filters and exports", async () => {
    expect((await get("/amc/visits/monthly-consolidated", {})).status).toBe(400);
    expect((await get("/amc/visits/monthly-consolidated", { month: "2028-13" })).status).toBe(400);
    expect((await get("/amc/visits/monthly-consolidated", { month: "2028-01", search: "GROUPED2" })).body.data.total).toBe(1);
    const excel = await get("/amc/visits/monthly-consolidated/export", { month: "2028-01", format: "xlsx" }).responseType("blob");
    expect(excel.status).toBe(200);
  });
});

describe("Master AMC Status sorting", () => {
  it("sorts by value and client and refuses an unknown column", async () => {
    const asc = (await get("/amc/master-status", { sort: "visitValue", direction: "asc", pageSize: 200 })).body.data.items as { visitValue: string }[];
    const desc = (await get("/amc/master-status", { sort: "visitValue", direction: "desc", pageSize: 200 })).body.data.items as { visitValue: string }[];
    expect(Number(asc[0]?.visitValue)).toBeLessThan(Number(desc[0]?.visitValue));
    expect((await get("/amc/master-status", { sort: "password" })).status).toBe(400);
  });
});

describe("Reports", () => {
  beforeAll(async () => {
    const [first, second] = await visitsOf(contractId);
    await api().patch(`/api/amc/execution/visits/${first!.id}`).set(admin.headers).send({ status: "COMPLETED", completedDate: await today() });
    await api().patch(`/api/amc/execution/visits/${second!.id}`).set(admin.headers).send({ status: "COMPLETED", completedDate: await today() });
    await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: first!.id, amount: "300.000" }], { amountExclVat: "300.000", vatAmount: "0.000", invoiceDate: await today() }));
    // One contract within the renewal window.
    await activeContract(admin, clientId, contract({ systemDescription: "DUE", validFrom: addDays(await today(), -300), validTo: addDays(await today(), 20) }));
  });

  it("offers the nine reports", async () => {
    const list = await get("/reports");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(9);
  });

  it.each(Object.keys(REPORTS))("%s reads, exports to Excel and PDF, and filters by client", async (type) => {
    const report = await get(`/reports/${type}`, { clientId });
    expect(report.status).toBe(200);
    expect(report.body.data.rows.length).toBeGreaterThan(0);

    const excel = await get(`/reports/${type}/export`, { clientId, format: "xlsx" }).responseType("blob");
    expect(excel.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel.body as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets[0]?.rowCount).toBeGreaterThan(1);

    const pdf = await get(`/reports/${type}/export`, { clientId, format: "pdf" }).responseType("blob");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect((await get(`/reports/${type}`, { clientId: "999999" })).body.data.total).toBe(0);
  });

  it("totals match the source modules", async () => {
    const accounts = (await get("/accounts", { pageSize: 1 })).body.data.kpis;
    const scheduled = (await get("/reports/scheduled-services")).body.data;
    expect(scheduled.total).toBe(accounts.rows);
    expect(scheduled.totals.value).toBe(accounts.totalValue);
    expect((await get("/reports/completed-services")).body.data.total).toBe(accounts.completed);
    expect((await get("/reports/pending-services")).body.data.total).toBe(accounts.notCompleted);

    const summary = (await get("/reports/accounts")).body.data;
    expect(summary.totals.services).toBe(String(accounts.rows));
    expect(summary.totals.value).toBe(accounts.totalValue);
    const recorded = (summary.rows as { invoice_state: string; services: number }[]).filter((row) => row.invoice_state === "Invoice Recorded").reduce((sum, row) => sum + row.services, 0);
    expect(recorded).toBe(accounts.invoiceFilled);

    const byClient = (await get("/reports/client-summary")).body.data;
    const byEngineer = (await get("/reports/engineer-summary")).body.data;
    const byMonth = (await get("/reports/monthly-maintenance")).body.data;
    for (const group of [byClient, byEngineer, byMonth]) {
      expect(group.totals.services).toBe(String(accounts.rows));
      expect(group.totals.value).toBe(accounts.totalValue);
    }

    const direct = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM amc_contracts");
    expect((await get("/reports/contract-summary")).body.data.total).toBe(direct.rows[0]?.n);
  });

  it("needs its own permissions, and never says paid", async () => {
    const report = JSON.stringify((await get("/reports/accounts")).body.data.rows);
    expect(report).not.toMatch(/"Paid"|"Unpaid"/);
    expect((await get("/reports/unknown")).status).toBe(400);
    expect((await api().get("/api/reports")).status).toBe(401);

    const noGrant = await signedIn("noreports@example.com", ["FINANCE_EXECUTIVE"]);
    expect((await get("/reports", {}, noGrant)).status).toBe(403);
    expect((await get("/reports/accounts/export", { format: "xlsx" }, noGrant)).status).toBe(403);
  });
});

describe("Security Center", () => {
  it("shows real counts and settings, without secrets, to administrators only", async () => {
    const response = await get("/security/overview", {}, administrator);
    expect(response.status).toBe(200);
    const { data } = response.body;
    const direct = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    expect(data.users.total).toBe(direct.rows[0]?.n);
    expect(data.configuration.sessionHours).toBeGreaterThan(0);
    expect(data.roles.some((role: { code: string; activeUsers: number }) => role.code === "ADMIN" && role.activeUsers > 0)).toBe(true);

    const text = JSON.stringify(data);
    for (const secret of [env.jwtSecret, process.env.DB_PASSWORD as string, process.env.DB_HOST as string]) expect(text).not.toContain(secret);

    expect((await get("/security/overview", {}, viewer)).status).toBe(403);
    expect((await api().get("/api/security/overview")).status).toBe(401);
  });
});

describe("Deletion Log", () => {
  it("lists recorded removals with type, id, user and time; filters and is restricted", async () => {
    const system = await post("/masters/system-types", { code: "DEL", name: "Delete Me" });
    expect((await api().delete(`/api/masters/system-types/${system.body.data.id}`).set(admin.headers)).status).toBeLessThan(300);

    const removed = await activeContract(admin, clientId, contract({ systemDescription: "SHRINK" }));
    await api().patch(`/api/amc/contracts/${removed}`).set(admin.headers).send({ validTo: "2027-06-30" });

    const all = (await get("/security/deletions")).body.data;
    const entry = (all.items as { action: string; entityId: string; user: string; kind: string; createdAt: string }[]).find((item) => item.action === "system_type.deleted");
    expect(entry).toMatchObject({ entityId: system.body.data.id, kind: "DELETED" });
    expect(entry?.user).toBeTruthy();
    expect(entry?.createdAt).toBeTruthy();
    expect((all.items as { action: string; entityId: string }[]).some((item) => item.action === "amc_contract.schedule_generated" && item.entityId === removed)).toBe(true);

    // A schedule update that removed nothing is not a deletion.
    expect((all.items as { action: string; entityId: string }[]).some((item) => item.action === "amc_contract.schedule_generated" && item.entityId === contractId)).toBe(false);

    expect((await get("/security/deletions", { kind: "VOIDED" })).body.data.items.every((item: { kind: string }) => item.kind === "VOIDED")).toBe(true);
    expect((await get("/security/deletions", { search: "Delete Me" })).body.data.total).toBeGreaterThan(0);
    expect((await get("/security/deletions", { entityType: "system_types" })).body.data.total).toBeGreaterThan(0);
    expect((await get("/security/deletions", {}, viewer)).status).toBe(403);
  });
});

const TOOLS = "C:/Program Files/PostgreSQL/17/bin";

describe("Backup & Restore", () => {
  const originalDir = env.backupDir;
  const originalDump = env.pgDumpPath;
  const originalRestore = env.pgRestorePath;
  let folder: string;

  beforeAll(() => {
    folder = mkdtempSync(path.join(tmpdir(), "stslv-backup-test-"));
  });
  afterAll(() => {
    env.backupDir = originalDir;
    env.pgDumpPath = originalDump;
    env.pgRestorePath = originalRestore;
    rmSync(folder, { recursive: true, force: true });
  });

  it("does nothing until storage is configured, and has no restore route", async () => {
    env.backupDir = null;
    const status = (await get("/security/backups")).body.data;
    expect(status.status).toMatchObject({ available: false, automaticSchedule: false });
    expect(status.status.checks.find((check: { id: string }) => check.id === "storage")).toMatchObject({ state: "ATTENTION" });
    expect(status.items).toEqual([]);
    expect((await post("/security/backups")).status).toBe(503);
    expect((await post("/security/backups/restore")).status).toBe(404);
  });

  it("is limited to Super Admin for running and downloading", async () => {
    expect((await get("/security/backups", {}, administrator)).status).toBe(200);
    expect((await post("/security/backups", {}, administrator)).status).toBe(403);
    expect((await get("/security/backups/x/download", {}, administrator)).status).toBe(403);
    expect((await get("/security/backups", {}, viewer)).status).toBe(403);
  });

  it.skipIf(!existsSync(`${TOOLS}/pg_dump.exe`))("creates, verifies and downloads a backup; refuses a changed file and a bad id", async () => {
    env.backupDir = folder;
    env.pgDumpPath = `${TOOLS}/pg_dump.exe`;
    env.pgRestorePath = `${TOOLS}/pg_restore.exe`;

    const started = await post("/security/backups");
    expect(started.status).toBe(202);
    expect((await post("/security/backups")).status).toBe(409);
    await waitForBackups();

    const { items, status } = (await get("/security/backups")).body.data;
    expect(status.available).toBe(true);
    expect(items[0]).toMatchObject({ id: started.body.data.id, state: "VERIFIED" });
    expect(items[0].tableEntries).toBeGreaterThan(10);
    expect(items[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const file = await get(`/security/backups/${items[0].id}/download`).responseType("blob");
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe("PGDMP");

    expect((await get("/security/backups/..%2F..%2Fsecret/download")).status).toBe(404);

    writeFileSync(path.join(folder, `${items[0].id}.dump`), "tampered");
    expect((await get(`/security/backups/${items[0].id}/download`)).status).toBe(409);
    expect(readdirSync(folder).length).toBeGreaterThan(0);

    const audit = await pool.query("SELECT action FROM activity_logs WHERE action LIKE 'backup.%'");
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual(expect.arrayContaining(["backup.created", "backup.downloaded"]));
  });

  it.skipIf(!existsSync(`${TOOLS}/pg_dump.exe`))("survives losing the backup folder mid-run, instead of stopping the API", async () => {
    const lost = mkdtempSync(path.join(tmpdir(), "stslv-backup-lost-"));
    env.backupDir = lost;
    env.pgDumpPath = `${TOOLS}/pg_dump.exe`;
    env.pgRestorePath = `${TOOLS}/pg_restore.exe`;

    expect((await post("/security/backups")).status).toBe(202);
    rmSync(lost, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await waitForBackups();

    // Vitest fails the run on an unhandled rejection; the API must also keep answering, and accept the next backup.
    expect((await api().get("/api/health")).status).toBe(200);
    env.backupDir = folder;
  });

  it.skipIf(!existsSync(`${TOOLS}/pg_dump.exe`))("records a failed backup without leaking details", async () => {
    env.backupDir = folder;
    env.pgDumpPath = `${TOOLS}/pg_dump.exe`;
    // Preflight refuses a missing tool before anything starts.
    env.pgRestorePath = path.join(folder, "no-such-tool");
    expect((await post("/security/backups")).status).toBe(503);
    env.pgRestorePath = `${TOOLS}/pg_restore.exe`;

    // A dump that fails part-way: the database name it is given does not exist.
    const database = process.env.DB_NAME;
    process.env.DB_NAME = "stslv_amc_no_such_database";
    const started = await post("/security/backups");
    expect(started.status).toBe(202);
    await waitForBackups();
    process.env.DB_NAME = database;

    const record = ((await get("/security/backups")).body.data.items as { id: string; state: string; failure: string }[]).find((item) => item.id === started.body.data.id);
    expect(record?.state).toBe("FAILED");
    expect(record?.failure).not.toContain(process.env.DB_HOST as string);
    expect(existsSync(path.join(folder, `${started.body.data.id}.dump`))).toBe(false);
  });
});
