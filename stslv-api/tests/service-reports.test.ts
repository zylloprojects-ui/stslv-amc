import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { env } from "../src/config/env";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, createClient, logsFor, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Service Report of one AMC service (migration 0104) and the completion
// lock (2026-11-04): a service is completed only with its own uploaded report,
// and a completed service can never leave Completed or change its date, on any
// route, for any user. Every record here is invented.

let folder: string;
let admin: Session;
let execution: Session; // AMC_EXECUTION:VIEW/EDIT, SERVICE_STATUS:VIEW
let accountant: Session; // SERVICE_STATUS:VIEW, no AMC_EXECUTION:EDIT
let procurement: Session; // no AMC access
let visitIds: string[];

// Minimal files recognised by their content.
const PDF = Buffer.from("%PDF-1.4\n% service report\n%%EOF\n");
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("....[Content_Types].xml....word/document.xml....")]);
const DOCX_MACRO = Buffer.concat([DOCX, Buffer.from("word/vbaProject.bin")]);
const DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("WordDocument", "utf16le")]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const uploadReport = (id: string, file: Buffer, name: string, session: Session = execution) =>
  api()
    .post(`/api/amc/service-status/${id}/report`)
    .set(session.headers)
    .set("Content-Type", "application/octet-stream")
    .set("X-File-Name", encodeURIComponent(name))
    .send(file);
const removeReport = (id: string, session: Session = execution) => api().delete(`/api/amc/service-status/${id}/report`).set(session.headers);
const downloadReport = (id: string, session: Session = admin) =>
  api().get(`/api/amc/service-status/${id}/report/download`).set(session.headers).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });
const item = (id: string, session: Session = admin) => api().get(`/api/amc/service-status/${id}`).set(session.headers);
const save = async (id: string, body: Record<string, unknown>, session: Session = execution) => {
  const current = await item(id);

  return api().patch(`/api/amc/service-status/${id}`).set(session.headers).send({ expectedUpdatedAt: current.body.data.updatedAt, ...body });
};
const execute = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().patch(`/api/amc/execution/visits/${id}`).set(session.headers).send(body);

async function stored(id: string) {
  return (await pool.query("SELECT status, completed_date::text AS completed_date, service_report_no FROM amc_visits WHERE id = $1", [id])).rows[0];
}
async function reportRows(id: string) {
  return (
    await pool.query("SELECT id, document_id, version, is_current, original_name, mime_type FROM attachments WHERE entity_type = 'amc_visits' AND entity_id = $1 ORDER BY id", [id])
  ).rows;
}
const files = async () => (await readdir(folder).catch(() => [] as string[])).length;
const v = (index: number) => visitIds[index] as string;

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "stslv-service-reports-test-"));
  setStorageForTests(new LocalDiskStorage(folder));

  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);

  const clientId = await createClient(admin, "Report Hotel");
  const contractId = await activeContract(admin, clientId, { maintenanceFrequency: "MONTHLY", contractValue: "1200.000", defaultVisitAmount: "100.000" });
  visitIds = (await visitsOf(contractId)).map((visit) => visit.id);
});

afterAll(async () => {
  setStorageForTests(null);
  await rm(folder, { recursive: true, force: true });
  await closePool();
});

describe("uploading a service report", () => {
  it("stores a PDF against exactly this service, and no other service or contract", async () => {
    const response = await uploadReport(v(0), PDF, "Report Q1.pdf");

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ originalName: "Report Q1.pdf", mimeType: "application/pdf", version: 1, uploadedBy: { id: execution.id } });
    expect(await reportRows(v(0))).toEqual([expect.objectContaining({ is_current: true, original_name: "Report Q1.pdf" })]);
    expect(await reportRows(v(1))).toEqual([]);
    // Contracts carry their own mandatory contract document (0103); the report is stored against nothing but this visit.
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM attachments WHERE original_name = 'Report Q1.pdf' AND NOT (entity_type = 'amc_visits' AND entity_id = $1)", [v(0)])).rows[0].n
    ).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM attachments WHERE entity_type = 'amc_contracts' AND category = 'SERVICE_REPORT'")).rows[0].n).toBe(0);

    const listed = (await item(v(0))).body.data;
    expect(listed.serviceReport).toMatchObject({ originalName: "Report Q1.pdf" });
    expect((await item(v(1))).body.data.serviceReport).toBeNull();
    expect(await stored(v(0))).toMatchObject({ status: "SCHEDULED", completed_date: null });
  });

  it("accepts Word documents (.docx and .doc)", async () => {
    expect((await uploadReport(v(1), DOCX, "report.docx")).body.data).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect((await uploadReport(v(2), DOC, "report.doc")).body.data).toMatchObject({ mimeType: "application/msword" });
  });

  it("refuses other types, a name that does not match the content, macros, empty and oversized files, and stores nothing", async () => {
    const before = await files();
    const cases: [Buffer, string][] = [
      [PNG, "photo.png"],
      [Buffer.from("MZ executable"), "report.pdf"],
      [PDF, "report.docx"],
      [DOCX, "report.pdf"],
      [DOCX_MACRO, "report.docx"],
      [Buffer.alloc(0), "empty.pdf"],
      [Buffer.concat([PDF, Buffer.alloc(env.attachmentMaxMb * 1024 * 1024)]), "big.pdf"],
    ];

    for (const [file, name] of cases) {
      const response = await uploadReport(v(3), file, name);
      expect(response.status, name).toBe(400);
      expect(response.body.error.details[0].field).toBe("serviceReport");
    }
    expect(await reportRows(v(3))).toEqual([]);
    expect(await files()).toBe(before);
  });

  it("needs AMC_EXECUTION:EDIT to upload or remove", async () => {
    expect((await uploadReport(v(3), PDF, "r.pdf", accountant)).status).toBe(403);
    expect((await uploadReport(v(3), PDF, "r.pdf", procurement)).status).toBe(403);
    expect((await removeReport(v(0), accountant)).status).toBe(403);
    expect(await reportRows(v(3))).toEqual([]);
  });

  it("replaces a report as a new version, keeping the earlier one, and logs both", async () => {
    const replaced = await uploadReport(v(0), PDF, "Report Q1 v2.pdf");

    expect(replaced.status).toBe(201);
    expect(replaced.body.data).toMatchObject({ version: 2, originalName: "Report Q1 v2.pdf" });
    const rows = await reportRows(v(0));
    expect(rows.map((row) => [row.version, row.is_current])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(rows[0]?.document_id).toBe(rows[1]?.document_id);
    expect((await logsFor("amc_visits", v(0))).map((log) => log.action)).toEqual(
      expect.arrayContaining(["amc_visit.service_report_uploaded", "amc_visit.service_report_replaced"])
    );
  });

  it("keeps one current report when two uploads arrive together", async () => {
    const [first, second] = await Promise.all([uploadReport(v(4), PDF, "a.pdf"), uploadReport(v(4), PDF, "b.pdf")]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await reportRows(v(4))).filter((row) => row.is_current)).toHaveLength(1);
  });

  it("removes a report before completion without deleting the row or the file", async () => {
    const before = await files();

    expect((await removeReport(v(4))).status).toBe(200);
    expect((await reportRows(v(4))).every((row) => !row.is_current)).toBe(true);
    expect((await reportRows(v(4))).length).toBe(2);
    expect(await files()).toBe(before);
    expect((await removeReport(v(4))).status).toBe(404);
    expect((await logsFor("amc_visits", v(4))).map((log) => log.action)).toContain("amc_visit.service_report_removed");
  });

  it("is refused for an unknown visit", async () => {
    expect((await uploadReport("999999", PDF, "r.pdf")).status).toBe(404);
    expect((await item("999999")).status).toBe(404);
  });
});

describe("completion needs the service report", () => {
  it("refuses Completed without a report, on Service Status and on the execution API, and saves nothing", async () => {
    const onPage = await save(v(5), { status: "COMPLETED", reportNumber: "SR-5" });

    expect(onPage.status).toBe(409);
    expect(onPage.body.error).toMatchObject({ code: "SERVICE_REPORT_REQUIRED", message: "Please upload service report." });
    expect(await stored(v(5))).toMatchObject({ status: "SCHEDULED", completed_date: null, service_report_no: null });

    const direct = await execute(v(5), { status: "COMPLETED", completedDate: await today() });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe("SERVICE_REPORT_REQUIRED");
    // A removed report does not count.
    expect((await execute(v(4), { status: "COMPLETED", completedDate: await today() })).body.error.code).toBe("SERVICE_REPORT_REQUIRED");
    expect(await stored(v(4))).toMatchObject({ status: "SCHEDULED" });
  });

  it("completes once the report is uploaded, recording today's date automatically and keeping the report", async () => {
    const response = await save(v(0), { status: "COMPLETED" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ serviceStatus: "COMPLETED", completedDate: await today(), locked: true, serviceReport: { originalName: "Report Q1 v2.pdf" } });
    expect(await stored(v(0))).toMatchObject({ status: "COMPLETED", completed_date: await today() });
  });
});

describe("the completion lock", () => {
  it("refuses Not Completed for every user, Admin included", async () => {
    for (const session of [execution, admin]) {
      const response = await save(v(0), { status: "NOT_COMPLETED" }, session);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("COMPLETION_LOCKED");
    }
    expect(await stored(v(0))).toMatchObject({ status: "COMPLETED", completed_date: await today() });
  });

  it("refuses every other status and a new completion date on the execution API", async () => {
    for (const status of ["SCHEDULED", "IN_PROGRESS", "POSTPONED", "CANCELLED"]) {
      const response = await execute(v(0), { status, statusReason: "Test" });
      expect(response.status, status).toBe(409);
      expect(response.body.error.code).toBe("COMPLETION_LOCKED");
    }
    expect((await execute(v(0), { completedDate: "2026-01-01" })).body.error.code).toBe("COMPLETION_LOCKED");
    expect((await save(v(0), { completedDate: "2026-01-01" })).body.error.code).toBe("COMPLETION_LOCKED");
    expect(await stored(v(0))).toMatchObject({ status: "COMPLETED", completed_date: await today() });
  });

  it("still saves work notes and the report number of a completed service", async () => {
    expect((await execute(v(0), { executionNotes: "Checked panel." })).status).toBe(200);
    expect((await save(v(0), { reportNumber: "SR-100" })).status).toBe(200);
    expect(await stored(v(0))).toMatchObject({ status: "COMPLETED", service_report_no: "SR-100" });
  });

  it("locks the report of a completed service: no replace, no remove", async () => {
    const before = await files();

    expect((await uploadReport(v(0), PDF, "late.pdf")).status).toBe(409);
    expect((await removeReport(v(0))).status).toBe(409);
    expect(await files()).toBe(before);
    expect((await reportRows(v(0))).filter((row) => row.is_current)).toEqual([expect.objectContaining({ original_name: "Report Q1 v2.pdf" })]);
  });

  it("is enforced by the database too, for any other writer", async () => {
    await expect(pool.query("UPDATE amc_visits SET status = 'SCHEDULED', completed_date = NULL WHERE id = $1", [v(0)])).rejects.toMatchObject({
      constraint: "amc_visits_completion_lock",
    });
    await expect(pool.query("UPDATE amc_visits_all SET completed_date = '2026-01-01' WHERE id = $1", [v(0)])).rejects.toMatchObject({
      constraint: "amc_visits_completion_lock",
    });
    // Other columns of a completed visit are not locked.
    await pool.query("UPDATE amc_visits SET execution_notes = 'ok' WHERE id = $1", [v(0)]);
  });

  it("keeps a service completed before reports were required exactly as it is, locked, with no report", async () => {
    // A completed visit from before 0104: completed with a fixture report, which is then taken away in the database.
    const reportId = await withServiceReport(v(6));
    expect((await execute(v(6), { status: "COMPLETED", completedDate: "2026-10-01" })).status).toBe(200);
    await pool.query("DELETE FROM attachments WHERE id = $1", [reportId]);

    const listed = (await item(v(6))).body.data;
    expect(listed).toMatchObject({ serviceStatus: "COMPLETED", completedDate: "2026-10-01", locked: true, serviceReport: null });
    expect((await save(v(6), { status: "NOT_COMPLETED" })).body.error.code).toBe("COMPLETION_LOCKED");
    expect((await uploadReport(v(6), PDF, "retro.pdf")).status).toBe(409);
    expect(await stored(v(6))).toMatchObject({ status: "COMPLETED", completed_date: "2026-10-01" });
  });
});

describe("viewing and downloading", () => {
  it("returns the stored bytes to a user who may view Service Status", async () => {
    for (const session of [admin, execution, accountant]) {
      const response = await downloadReport(v(0), session);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.headers["content-disposition"]).toContain("Report%20Q1%20v2.pdf");
      expect(Buffer.compare(response.body as Buffer, PDF)).toBe(0);
    }
  });

  it("blocks a user without SERVICE_STATUS:VIEW, and the generic attachment routes", async () => {
    expect((await downloadReport(v(0), procurement)).status).toBe(403);
    expect((await item(v(0), procurement)).status).toBe(403);

    const current = (await reportRows(v(0))).find((row) => row.is_current);
    expect((await api().get(`/api/attachments/${current?.id}/download`).set(admin.headers)).status).toBe(403);
    expect((await api().get(`/api/attachments/${current?.id}/versions`).set(admin.headers)).status).toBe(403);
    expect((await api().get("/api/attachments").query({ entityType: "amc_visits", entityId: v(0) }).set(admin.headers)).status).toBe(400);
  });

  it("says when a service has no report", async () => {
    expect((await downloadReport(v(7))).status).toBe(404);
  });

  it("lists the report on the Service Status page, and keeps the export working", async () => {
    const list = await api().get("/api/amc/service-status").query({ pageSize: 200 }).set(admin.headers);

    expect(list.body.data.serviceReportsAvailable).toBe(true);
    expect(list.body.data.serviceReportLimits).toEqual({ maxMb: env.attachmentMaxMb, allowedTypes: "PDF, DOC and DOCX" });
    const row = (list.body.data.items as { id: string; serviceReport: { originalName: string } | null }[]).find((entry) => entry.id === v(0));
    expect(row?.serviceReport?.originalName).toBe("Report Q1 v2.pdf");

    const exported = await api().get("/api/amc/service-status/export").query({ format: "xlsx", hidden: "serviceReport" }).set(admin.headers);
    expect(exported.status).toBe(200);
  });
});
