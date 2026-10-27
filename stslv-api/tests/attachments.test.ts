import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, createClient } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { categoryId, newProject, postExpense, postProcurement, resetProjectData } from "./projects-helpers";

// Attachments: upload, versions, download, validation and permissions (migration 0071).
// Files go to a temporary folder that is removed afterwards. Every file here is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("test document body\n%%EOF\n")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);

let folder: string;
let admin: Session;
let execution: Session;
let procurementUser: Session;
let accountant: Session;
let contractId: string;
let requestId: string;
let expenseId: string;

function upload(session: Session, query: Record<string, string>, file: Buffer, name: string) {
  return api()
    .post("/api/attachments")
    .query(query)
    .set(session.headers)
    .set("Content-Type", "application/octet-stream")
    .set("X-File-Name", encodeURIComponent(name))
    .send(file);
}

const contractDoc = (session: Session, file: Buffer, name: string, extra: Record<string, string> = {}) =>
  upload(session, { entityType: "amc_contracts", entityId: contractId, category: "SIGNED_CONTRACT", title: "Signed contract", ...extra }, file, name);

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "stslv-attachments-test-"));
  setStorageForTests(new LocalDiskStorage(folder));

  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurementUser = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);

  const clientId = await createClient(admin, "Attachment Test Client");
  contractId = await activeContract(admin, clientId);
  const project = await newProject(admin, clientId);
  requestId = (await postProcurement(admin, { projectId: project.id, description: "Smoke detectors", requestDate: "2026-09-05" })).body.data.id as string;
  expenseId = (
    await postExpense(admin, { projectId: project.id, categoryId: await categoryId("MATERIALS"), expenseDate: "2026-09-10", description: "Cable", amount: "100" })
  ).body.data.id as string;
});
afterAll(async () => {
  setStorageForTests(null);
  await rm(folder, { recursive: true, force: true });
  await closePool();
});

describe("uploading", () => {
  it("stores a PDF under a generated name, with its checksum, and records it", async () => {
    const response = await contractDoc(admin, PDF, "Signed AMC 2027.pdf", { notes: "Signed copy" });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      version: 1,
      isCurrent: true,
      entityType: "amc_contracts",
      entityId: contractId,
      category: "SIGNED_CONTRACT",
      title: "Signed contract",
      originalName: "Signed AMC 2027.pdf",
      mimeType: "application/pdf",
      sizeBytes: PDF.length,
      sha256: createHash("sha256").update(PDF).digest("hex"),
      notes: "Signed copy",
      uploadedBy: { id: admin.id },
      versionCount: 1,
    });
    expect(response.body.data).not.toHaveProperty("storageKey");

    const files = await readdir(folder);
    expect(files.some((file) => /^[0-9a-f-]{36}\.pdf$/.test(file))).toBe(true);
    expect(files.some((file) => file.includes("Signed"))).toBe(false);

    const log = await pool.query("SELECT action, module FROM activity_logs WHERE action = 'attachment.uploaded' AND entity_id = $1", [contractId]);
    expect(log.rows).toEqual([{ action: "attachment.uploaded", module: "AMC_CONTRACTS" }]);
  });

  it("accepts PNG and JPEG and keeps only a safe display name", async () => {
    expect((await contractDoc(admin, PNG, "photo.png", { category: "SERVICE_REPORT", title: "Site photo" })).status).toBe(201);
    const jpeg = await contractDoc(admin, JPEG, "..\\..\\evil\\scan<1>.jpeg", { category: "OTHER", title: "Scan" });

    expect(jpeg.status).toBe(201);
    expect(jpeg.body.data.originalName).toBe("scan1.jpeg");
    expect(jpeg.body.data.mimeType).toBe("image/jpeg");
  });

  it("refuses a file whose content is not PDF, PNG or JPEG, whatever its name", async () => {
    const response = await contractDoc(admin, EXE, "invoice.pdf");

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([{ field: "file", message: "Only PDF, PNG and JPEG files can be uploaded." }]);
  });

  it("refuses a name that does not match the content", async () => {
    const response = await contractDoc(admin, PDF, "contract.png");

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].message).toContain("must end in .pdf");
  });

  it("refuses an empty file, a missing name and a document type of another record type", async () => {
    expect((await contractDoc(admin, Buffer.alloc(0), "empty.pdf")).status).toBe(400);
    expect(
      (await api().post("/api/attachments").query({ entityType: "amc_contracts", entityId: contractId, category: "OTHER", title: "x" }).set(admin.headers).set("Content-Type", "application/octet-stream").send(PDF))
        .status
    ).toBe(400);
    expect((await contractDoc(admin, PDF, "a.pdf", { category: "RECEIPT" })).status).toBe(400);
    expect((await contractDoc(admin, PDF, "a.pdf", { title: "" })).status).toBe(400);
  });

  it("refuses a file larger than the limit", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(10 * 1024 * 1024 + 10)]);
    const response = await contractDoc(admin, big, "big.pdf");

    expect([400, 413]).toContain(response.status);
  });

  it("answers 404 for a record that does not exist", async () => {
    expect((await upload(admin, { entityType: "amc_contracts", entityId: "999999", category: "OTHER", title: "x" }, PDF, "a.pdf")).status).toBe(404);
  });
});

describe("listing, versions and download", () => {
  let firstId: string;

  beforeAll(async () => {
    firstId = (await contractDoc(admin, PDF, "LPO.pdf", { category: "LPO", title: "Client LPO" })).body.data.id as string;
  });

  it("adds a version, keeps the earlier one and lists only current versions", async () => {
    const replaced = await api()
      .post(`/api/attachments/${firstId}/versions`)
      .query({ notes: "Corrected LPO" })
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "LPO v2.pdf")
      .send(Buffer.concat([PDF, Buffer.from("v2")]));

    expect(replaced.status).toBe(201);
    expect(replaced.body.data).toMatchObject({ version: 2, documentId: firstId, title: "Client LPO", category: "LPO", notes: "Corrected LPO" });

    const list = (await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: contractId }).set(admin.headers)).body.data as {
      title: string;
      version: number;
      versionCount: number;
    }[];
    const lpo = list.filter((item) => item.title === "Client LPO");
    expect(lpo).toEqual([expect.objectContaining({ version: 2, versionCount: 2 })]);

    const versions = (await api().get(`/api/attachments/${firstId}/versions`).set(admin.headers)).body.data as { version: number; isCurrent: boolean }[];
    expect(versions.map((item) => [item.version, item.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);

    // Replacing an old version is refused: only the current one can be replaced.
    const stale = await api().post(`/api/attachments/${firstId}/versions`).set(admin.headers).set("Content-Type", "application/octet-stream").set("X-File-Name", "x.pdf").send(PDF);
    expect(stale.status).toBe(409);
  });

  it("downloads the exact file as an attachment, never shown inline", async () => {
    const response = await api().get(`/api/attachments/${firstId}/download`).set(admin.headers).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });

    expect(response.status).toBe(200);
    expect(Buffer.compare(response.body as Buffer, PDF)).toBe(0);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toContain('attachment; filename="LPO.pdf"');
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("refuses to serve a file that no longer matches its checksum", async () => {
    const { rows } = await pool.query<{ storage_key: string }>("SELECT storage_key FROM attachments WHERE id = $1", [firstId]);
    await writeFile(path.join(folder, rows[0]?.storage_key as string), Buffer.from("%PDF-tampered"));

    const response = await api().get(`/api/attachments/${firstId}/download`).set(admin.headers);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INTEGRITY_FAILED");
  });

  it("has no delete route", async () => {
    expect((await api().delete(`/api/attachments/${firstId}`).set(admin.headers)).status).toBe(404);
  });
});

describe("attachment permissions follow the record", () => {
  it("lets a viewer of contracts list but not upload contract documents", async () => {
    expect((await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: contractId }).set(execution.headers)).status).toBe(200);
    expect((await contractDoc(execution, PDF, "a.pdf")).status).toBe(403);
  });

  it("gives procurement users quotations, and accountants receipts, but not each other's", async () => {
    const quotation = await upload(procurementUser, { entityType: "procurement_requests", entityId: requestId, category: "QUOTATION", title: "Supplier quotation" }, PDF, "quote.pdf");
    expect(quotation.status).toBe(201);
    expect((await upload(procurementUser, { entityType: "project_expenses", entityId: expenseId, category: "RECEIPT", title: "Receipt" }, PDF, "r.pdf")).status).toBe(403);

    const receipt = await upload(accountant, { entityType: "project_expenses", entityId: expenseId, category: "RECEIPT", title: "Receipt" }, JPEG, "receipt.jpg");
    expect(receipt.status).toBe(201);
    // The accountant may view procurement, so may list and download its quotations, but not upload to it.
    expect((await api().get(`/api/attachments/${quotation.body.data.id}/download`).set(accountant.headers)).status).toBe(200);
    expect((await upload(accountant, { entityType: "procurement_requests", entityId: requestId, category: "QUOTATION", title: "Q" }, PDF, "q.pdf")).status).toBe(403);
    expect((await api().get(`/api/attachments/${receipt.body.data.id}/download`).set(execution.headers)).status).toBe(403);
  });

  it("needs a signed-in user", async () => {
    expect((await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: contractId })).status).toBe(401);
  });
});
