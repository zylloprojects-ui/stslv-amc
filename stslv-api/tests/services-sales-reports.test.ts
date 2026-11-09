import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, createClient, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn, withAuditLogUnlocked } from "./helpers";

// Service Sales shows, views and downloads the Service Report uploaded on Service Status (migration 0104,
// feature/service-status-report-completion-lock). Service Sales only reads it.
//
// TEST FIXTURE, until 0104 is merged: 0104 is not on this branch, so the two pieces of it this page relies on (the
// 'amc_visits' entity type and the one-current-report index) are added to the test schema here, and removed again
// afterwards. Both statements are idempotent, so the fixture keeps working once 0104 is in the migrations; it can
// then be deleted. Report rows are inserted the way 0104's upload writes them (entity_type 'amc_visits', category
// 'SERVICE_REPORT', entity_id = the visit id, a version chain with one current row).

let admin: Session;
let invoicing: Session;
let accountant: Session;
let execution: Session;
let procurement: Session;
let folder: string;
/** True once migration 0104 itself is in the migrations: the fixture then neither adds nor removes anything. */
let nativeReports = false;

const PDF_A = Buffer.from("%PDF-1.4\n% Report A for service M1\n%%EOF\n");
const PDF_B = Buffer.from("%PDF-1.4\n% Report B for service M2\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function applyReportSchema(): Promise<void> {
  if (nativeReports) return;
  await pool.query(`ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_ck,
    ADD CONSTRAINT attachments_entity_type_ck CHECK (entity_type IN ('amc_contracts', 'procurement_requests', 'project_expenses', 'amc_visits'))`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS attachments_service_report_uq ON attachments (entity_id) WHERE entity_type = 'amc_visits' AND is_current");
}

async function removeReportSchema(): Promise<void> {
  if (nativeReports) return;
  await pool.query("DELETE FROM attachments WHERE entity_type = 'amc_visits'");
  await pool.query("DROP INDEX IF EXISTS attachments_service_report_uq");
  await pool.query(`ALTER TABLE attachments DROP CONSTRAINT attachments_entity_type_ck,
    ADD CONSTRAINT attachments_entity_type_ck CHECK (entity_type IN ('amc_contracts', 'procurement_requests', 'project_expenses'))`);
}

/** Stores a file and records it as the visit's current report, as Service Status' upload does. A second call replaces it. */
async function uploadReport(visitId: string, name: string, data: Buffer, mime = "application/pdf"): Promise<{ id: string; key: string }> {
  const key = `${randomUUID()}.${mime === "image/png" ? "png" : "pdf"}`;
  await writeFile(path.join(folder, key), data);
  const previous = await pool.query<{ id: string; document_id: string; version: number }>(
    "SELECT id, document_id, version FROM attachments WHERE entity_type = 'amc_visits' AND entity_id = $1 AND is_current",
    [visitId]
  );
  const prior = previous.rows[0];
  if (prior) await pool.query("UPDATE attachments SET is_current = false WHERE id = $1", [prior.id]);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO attachments (document_id, version, entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, $2, 'amc_visits', $3, 'SERVICE_REPORT', 'Service report', $4, $5, $6, $7, $8, $9) RETURNING id`,
    [prior?.document_id ?? null, (prior?.version ?? 0) + 1, visitId, name, mime, data.length, createHash("sha256").update(data).digest("hex"), key, admin.id]
  );
  const id = inserted.rows[0]?.id as string;
  if (!prior) await pool.query("UPDATE attachments SET document_id = id WHERE id = $1", [id]);
  return { id, key };
}

const list = (session: Session = admin) => api().get("/api/services-sales").query({ pageSize: 200 }).set(session.headers);
const report = (visitId: string, session: Session = admin) =>
  api()
    .get(`/api/services-sales/${visitId}/report`)
    .set(session.headers)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
const errorOf = (body: Buffer) => JSON.parse(body.toString("utf8")) as { error: { code: string; message: string } };

async function rowOf(visitId: string) {
  const items = (await list()).body.data.items as { id: string; serviceReport: unknown; serviceReportNo: string | null }[];
  const item = items.find((row) => row.id === visitId);
  if (!item) throw new Error(`Visit ${visitId} is not on the page.`);
  return item;
}

describe("Service Sales — Service Report view and download", () => {
  let contractA: string;
  let contractB: string;
  let m1: string;
  let m2: string;
  let otherContractVisit: string;

  beforeAll(async () => {
    nativeReports = (await pool.query<{ present: boolean }>("SELECT to_regclass('attachments_service_report_uq') IS NOT NULL AS present")).rows[0]?.present === true;
    folder = await mkdtemp(path.join(tmpdir(), "stslv-service-sales-reports-"));
    setStorageForTests(new LocalDiskStorage(folder));
    await resetData();
    admin = await signedIn("admin@example.com", ["ADMIN"]);
    invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
    accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
    execution = await signedIn("execution@example.com", ["EXECUTION"]);
    procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM attachments WHERE entity_type = 'amc_visits'").catch(() => undefined);
    await removeReportSchema();
    setStorageForTests(null);
    await rm(folder, { recursive: true, force: true });
    await closePool();
  });

  beforeEach(async () => {
    await withAuditLogUnlocked("TRUNCATE activity_logs, amc_visits_all, amc_contracts_all, clients_all RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM attachments WHERE entity_type = 'amc_visits'").catch(() => undefined);
    const clientId = await createClient(admin, "Alpha Towers");
    contractA = await activeContract(admin, clientId, { systemDescription: "FIRE", maintenanceFrequency: "MONTHLY" });
    contractB = await activeContract(admin, clientId, { systemDescription: "CCTV", maintenanceFrequency: "QUARTERLY" });
    const visitsA = await visitsOf(contractA);
    m1 = visitsA[0]!.id;
    m2 = visitsA[1]!.id;
    otherContractVisit = (await visitsOf(contractB))[0]!.id;
  });

  it("before migration 0104: every row shows no report and the file route answers 503", async (context) => {
    // Once 0104 is a real migration this state no longer exists in the test schema.
    if (nativeReports) context.skip();
    await removeReportSchema();
    const response = await list();

    expect(response.status).toBe(200);
    expect(response.body.data.serviceReportsAvailable).toBe(false);
    expect((response.body.data.items as { serviceReport: unknown }[]).every((item) => item.serviceReport === null)).toBe(true);

    const file = await report(m1);
    expect(file.status).toBe(503);
    expect(errorOf(file.body).error.code).toBe("FEATURE_UNAVAILABLE");

    await applyReportSchema();
  });

  describe("with service reports (0104)", () => {
    beforeAll(applyReportSchema);

    it("lists each visit's own current report by visit id, and none for visits without one", async () => {
      const a = await uploadReport(m1, "Report A.pdf", PDF_A);
      await uploadReport(m2, "Report B.pdf", PDF_B);
      await pool.query("UPDATE amc_visits SET service_report_no = 'SR-001' WHERE id = $1", [m1]);

      const response = await list();
      expect(response.body.data.serviceReportsAvailable).toBe(true);

      const first = await rowOf(m1);
      expect(first.serviceReport).toEqual({ id: a.id, originalName: "Report A.pdf", mimeType: "application/pdf", sizeBytes: PDF_A.length, uploadedAt: expect.any(String) });
      // The report number is untouched and independent of the document.
      expect(first.serviceReportNo).toBe("SR-001");
      expect((await rowOf(m2)).serviceReport).toMatchObject({ originalName: "Report B.pdf" });
      expect((await rowOf(otherContractVisit)).serviceReport).toBeNull();
      // Internal storage details never reach the page.
      expect(JSON.stringify(response.body)).not.toMatch(/storage_?key|sha256|[0-9a-f-]{36}\.pdf/i);
    });

    it("serves exactly the visit's own file with its original name, never another service's", async () => {
      await uploadReport(m1, "Report A.pdf", PDF_A);
      await uploadReport(m2, "Report B — M2.pdf", PDF_B);

      const fileA = await report(m1);
      expect(fileA.status).toBe(200);
      expect(fileA.headers["content-type"]).toBe("application/pdf");
      expect(fileA.headers["cache-control"]).toBe("no-store");
      expect(fileA.headers["content-disposition"]).toBe(`attachment; filename="Report A.pdf"; filename*=UTF-8''${encodeURIComponent("Report A.pdf")}`);
      expect(Buffer.compare(fileA.body as Buffer, PDF_A)).toBe(0);

      const fileB = await report(m2);
      expect(Buffer.compare(fileB.body as Buffer, PDF_B)).toBe(0);
      expect(fileB.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("Report B — M2.pdf")}`);

      const none = await report(otherContractVisit);
      expect(none.status).toBe(404);
      expect(errorOf(none.body).error).toEqual({ code: "SERVICE_REPORT_NOT_FOUND", message: "No service report has been uploaded for this service." });
    });

    it("shows and serves the latest saved report after a replacement on Service Status", async () => {
      await uploadReport(m1, "First.pdf", PDF_A);
      const replaced = await uploadReport(m1, "Second.png", PNG, "image/png");

      expect((await rowOf(m1)).serviceReport).toMatchObject({ id: replaced.id, originalName: "Second.png", mimeType: "image/png" });
      const file = await report(m1);
      expect(file.headers["content-type"]).toBe("image/png");
      expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
    });

    it("shows nothing once the report is removed before completion (row kept, not current)", async () => {
      const { id } = await uploadReport(m1, "Report A.pdf", PDF_A);
      await pool.query("UPDATE attachments SET is_current = false WHERE id = $1", [id]);

      expect((await rowOf(m1)).serviceReport).toBeNull();
      expect((await report(m1)).status).toBe(404);
    });

    it("returns a controlled error when the stored file is missing or altered", async () => {
      const { key } = await uploadReport(m1, "Report A.pdf", PDF_A);
      await writeFile(path.join(folder, key), Buffer.from("%PDF-1.4 altered"));
      const altered = await report(m1);
      expect(altered.status).toBe(409);
      expect(errorOf(altered.body).error.code).toBe("INTEGRITY_FAILED");

      await rm(path.join(folder, key));
      const missing = await report(m1);
      expect(missing.status).toBe(404);
      expect(errorOf(missing.body).error.code).toBe("FILE_MISSING");
      expect(missing.body.toString("utf8")).not.toContain(folder);
    });

    it("refuses visits that are not on the page: unknown, cancelled or in the Recycle Bin", async () => {
      expect((await report("999999")).status).toBe(404);
      // A malformed id names no record, as on every other route.
      expect((await report("abc")).status).toBe(404);

      await uploadReport(m1, "Report A.pdf", PDF_A);
      await pool.query("UPDATE amc_visits_all SET status = 'CANCELLED' WHERE id = $1", [m1]);
      expect(errorOf((await report(m1)).body).error.message).toBe("AMC visit not found.");

      await uploadReport(m2, "Report B.pdf", PDF_B);
      expect((await report(m2)).status).toBe(200);
      // Recycle Bin (0101): the contract's services leave the page, and so do their reports.
      await pool.query("UPDATE amc_contracts_all SET deleted_at = now(), deleted_by = $1 WHERE id = $2", [admin.id, contractA]);
      expect((await report(m2)).status).toBe(404);
      expect((await list()).body.data.items.some((item: { id: string }) => item.id === m2)).toBe(false);
    });

    it("needs Service Sales VIEW: signed out 401, Procurement 403; Admin, Invoicing, Accountant and Execution may view", async () => {
      await uploadReport(m1, "Report A.pdf", PDF_A);

      expect((await api().get(`/api/services-sales/${m1}/report`)).status).toBe(401);
      expect((await report(m1, procurement)).status).toBe(403);
      for (const session of [admin, invoicing, accountant, execution]) expect((await report(m1, session)).status).toBe(200);
    });

    it("is read only: no upload, replace or delete through Service Sales", async () => {
      await uploadReport(m1, "Report A.pdf", PDF_A);

      expect((await api().post(`/api/services-sales/${m1}/report`).set(admin.headers).send(PDF_B)).status).toBe(404);
      expect((await api().delete(`/api/services-sales/${m1}/report`).set(admin.headers)).status).toBe(404);
      expect((await pool.query("SELECT count(*)::int AS n FROM attachments WHERE entity_type = 'amc_visits'")).rows[0]).toEqual({ n: 1 });
    });
  });
});
