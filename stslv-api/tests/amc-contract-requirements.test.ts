import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { env } from "../src/config/env";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { LocalDiskStorage, type FileStorage } from "../src/shared/storage";
import {
  activeContract,
  contractDocument,
  createClient,
  legacyContract,
  logsFor,
  newContractBody,
  renewalEngineer,
  systemTypeNamed,
  TEST_PDF,
  visitsOf,
  type Session,
} from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Add AMC Contract, 2026-11-03: a new contract names an active sales engineer and an active system type, records
// its Final Credit and carries its contract document (PDF or Word), saved with it or not at all. Older contracts
// stay valid and editable. Also the AMC Contracts page's four figures. Every record here is invented.

let admin: Session;
let execution: Session;
let clientId: string;
let folder: string;
let disk: LocalDiskStorage;

const post = (body: Record<string, unknown>, session: Session = admin) => api().post("/api/amc/contracts").set(session.headers).send(body);
const patch = (id: string, body: Record<string, unknown>) => api().patch(`/api/amc/contracts/${id}`).set(admin.headers).send(body);
const kpis = (session: Session = admin) => api().get("/api/amc/contracts/kpis").set(session.headers);
const contractCount = async () => ((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM amc_contracts_all")).rows[0] as { n: number }).n;
const attachmentCount = async () => ((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM attachments")).rows[0] as { n: number }).n;
const files = () => readdir(folder);
const fields = (response: { body: { error: { details: { field: string }[] } } }) => response.body.error.details.map((detail) => detail.field);

/** A real .docx package: a ZIP with a Word body (and, when asked, a macro project). */
async function docx(withMacros = false): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
  if (withMacros) zip.file("word/vbaProject.bin", "macro");

  return zip.generateAsync({ type: "nodebuffer" });
}

/** The start of an OLE compound file with a WordDocument stream name, as a .doc carries. */
function doc(withMacros = false): Buffer {
  const header = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const parts = [header, Buffer.alloc(504), Buffer.from("WordDocument", "utf16le"), Buffer.alloc(64)];
  if (withMacros) parts.push(Buffer.from("Macros", "utf16le"));

  return Buffer.concat(parts);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "stslv-contract-documents-"));
  disk = new LocalDiskStorage(folder);
  setStorageForTests(disk);

  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  clientId = await createClient(admin, "Requirements Hotel");
});
beforeEach(() => setStorageForTests(disk));
afterAll(async () => {
  setStorageForTests(null);
  await rm(folder, { recursive: true, force: true });
  await closePool();
});

describe("sales engineer", () => {
  it("is required, and must be an existing, active engineer", async () => {
    const missing = await post(await newContractBody(clientId, { salesEngineerId: undefined }));
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([{ field: "salesEngineerId", message: "Select a sales engineer." }]);

    expect(fields(await post(await newContractBody(clientId, { salesEngineerId: null })))).toEqual(["salesEngineerId"]);
    expect(fields(await post(await newContractBody(clientId, { salesEngineerId: "not-an-id" })))).toEqual(["salesEngineerId"]);

    const before = await contractCount();
    const unknown = await post(await newContractBody(clientId, { salesEngineerId: "99999999" }));
    expect(unknown.status).toBe(400);
    expect(fields(unknown)).toEqual(["salesEngineerId"]);

    const inactive = await renewalEngineer("Retired Engineer");
    await pool.query("UPDATE sales_engineers SET is_active = false WHERE id = $1", [inactive]);
    const refused = await post(await newContractBody(clientId, { salesEngineerId: inactive }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ field: "salesEngineerId", message: "Select an active sales engineer." }]);
    expect(await contractCount()).toBe(before);
  });

  it("is stored as the engineer's master record id, beside the typed engineer", async () => {
    const engineer = await renewalEngineer("Stored Engineer");
    const created = await post(await newContractBody(clientId, { salesEngineerId: engineer, responsibleEngineer: "Typed Name" }));

    expect(created.status).toBe(201);
    expect(created.body.data.responsibleEngineer).toBe("Typed Name");
    const stored = await pool.query("SELECT sales_engineer_id FROM amc_contracts WHERE id = $1", [created.body.data.id]);
    expect(stored.rows[0]).toEqual({ sales_engineer_id: engineer });
  });
});

describe("system", () => {
  it("is required, as an active system type, and its name becomes the contract's system", async () => {
    expect((await post(await newContractBody(clientId, { systemTypeId: undefined }))).body.error.details).toEqual([{ field: "systemTypeId", message: "Select a system." }]);
    expect(fields(await post(await newContractBody(clientId, { systemTypeId: "99999999" })))).toEqual(["systemTypeId"]);

    const typeId = await systemTypeNamed("Fire Fighting");
    // A typed system sent alongside is replaced by the type's name, so the two never disagree.
    const created = await post(await newContractBody(clientId, { systemTypeId: typeId, systemDescription: "Something else" }));

    expect(created.status).toBe(201);
    expect(created.body.data.systemDescription).toBe("Fire Fighting");
    const masters = await api().get(`/api/amc/contracts/${created.body.data.id}/masters`).set(admin.headers);
    expect(masters.body.data.systemType).toMatchObject({ id: typeId, name: "Fire Fighting", isActive: true });
  });

  it("refuses a disabled system type for a new contract", async () => {
    const typeId = await systemTypeNamed("Disabled System");
    await pool.query("UPDATE system_types SET is_active = false WHERE id = $1", [typeId]);

    const refused = await post(await newContractBody(clientId, { systemDescription: "Disabled System", systemTypeId: typeId }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ field: "systemTypeId", message: "Select an active system from the System Types list." }]);
  });

  it("keeps the contract linked when the system type is renamed: the link is by id", async () => {
    const typeId = await systemTypeNamed("Rename Me");
    const id = (await post(await newContractBody(clientId, { systemDescription: "Rename Me" }))).body.data.id as string;

    expect((await api().patch(`/api/masters/system-types/${typeId}`).set(admin.headers).send({ name: "Renamed" })).status).toBe(200);

    const masters = await api().get(`/api/amc/contracts/${id}/masters`).set(admin.headers);
    expect(masters.body.data.systemType).toMatchObject({ id: typeId, name: "Renamed" });
    // The contract keeps the system name it was saved with until it is given a system again.
    expect((await api().get(`/api/amc/contracts/${id}`).set(admin.headers)).body.data.systemDescription).toBe("Rename Me");
    expect((await api().get(`/api/masters/system-types/${typeId}/contracts`).set(admin.headers)).body.data.items.map((item: { id: string }) => item.id)).toContain(id);
  });
});

describe("Final Credit", () => {
  it("is required; zero and decimals are accepted with three decimals, other values refused", async () => {
    expect((await post(await newContractBody(clientId, { finalCredit: undefined }))).body.error.details).toEqual([{ field: "finalCredit", message: "Final credit is required." }]);
    expect(fields(await post(await newContractBody(clientId, { finalCredit: "" })))).toEqual(["finalCredit"]);
    expect(fields(await post(await newContractBody(clientId, { finalCredit: null })))).toEqual(["finalCredit"]);

    for (const bad of ["-1", "abc", "1,000", "1.2345", 100]) {
      const response = await post(await newContractBody(clientId, { finalCredit: bad }));
      expect(response.status, String(bad)).toBe(400);
      expect(fields(response)).toEqual(["finalCredit"]);
    }

    expect((await post(await newContractBody(clientId, { finalCredit: "0" }))).body.data.finalCredit).toBe("0.000");
    expect((await post(await newContractBody(clientId, { finalCredit: "1234.5" }))).body.data.finalCredit).toBe("1234.500");
  });

  it("is never taken from the AMC Value", async () => {
    const created = await post(await newContractBody(clientId, { contractValue: "5000.000", finalCredit: "0.000" }));

    expect(created.body.data).toMatchObject({ contractValue: "5000.000", finalCredit: "0.000" });
  });
});

describe("contract document", () => {
  it("is required, and a missing or unreadable one creates nothing", async () => {
    const before = await contractCount();

    expect((await post(await newContractBody(clientId, { contractDocument: undefined }))).body.error.details).toEqual([{ field: "contractDocument", message: "Attach the contract document." }]);
    expect(fields(await post(await newContractBody(clientId, { contractDocument: null })))).toEqual(["contractDocument"]);
    expect(fields(await post(await newContractBody(clientId, { contractDocument: { fileName: "a.pdf", contentBase64: "" } })))).toEqual(["contractDocument.contentBase64"]);
    expect(fields(await post(await newContractBody(clientId, { contractDocument: { fileName: "a.pdf", contentBase64: "not base64!" } })))).toEqual(["contractDocument.contentBase64"]);
    expect(fields(await post(await newContractBody(clientId, { contractDocument: { fileName: "", contentBase64: TEST_PDF.toString("base64") } })))).toEqual(["contractDocument.fileName"]);
    expect(await contractCount()).toBe(before);
  });

  it("stores a PDF with the contract, under a generated name, as its Signed contract document", async () => {
    const before = await files();
    const created = await post(await newContractBody(clientId, { contractDocument: contractDocument(TEST_PDF, "..\\secret\\Signed <copy>.pdf"), status: "ACTIVE" }));

    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const listed = await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: id }).set(admin.headers);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({ category: "SIGNED_CONTRACT", title: "Contract document", originalName: "Signed copy.pdf", mimeType: "application/pdf", sizeBytes: TEST_PDF.length, integrity: "VERIFIED" });

    const added = (await files()).filter((file) => !before.includes(file));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^[0-9a-f-]{36}\.pdf$/);

    // Downloadable by whoever may view the contract, byte for byte.
    const download = await api().get(`/api/attachments/${listed.body.data[0].id}/download`).set(execution.headers).buffer(true);
    expect(download.status).toBe(200);
    expect(Buffer.from(download.body).equals(TEST_PDF)).toBe(true);

    // Logged with the contract; the schedule is generated as for any contract.
    expect((await logsFor("amc_contracts", id)).map((log) => log.action)).toEqual(["amc_contract.created", "amc_contract.masters_linked", "attachment.uploaded", "amc_contract.schedule_generated"]);
    expect(await visitsOf(id)).toHaveLength(4);
  });

  it("accepts Word documents (.docx and .doc)", async () => {
    const word = await post(await newContractBody(clientId, { contractDocument: contractDocument(await docx(), "contract.docx") }));
    expect(word.status).toBe(201);
    const older = await post(await newContractBody(clientId, { contractDocument: contractDocument(doc(), "contract.doc") }));
    expect(older.status).toBe(201);

    const types = await pool.query<{ mime_type: string; storage_key: string }>(
      "SELECT mime_type, storage_key FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id IN ($1, $2) ORDER BY entity_id",
      [word.body.data.id, older.body.data.id]
    );
    expect(types.rows.map((row) => row.mime_type)).toEqual(["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"]);
    expect(types.rows.map((row) => row.storage_key.split(".").pop())).toEqual(["docx", "doc"]);
  });

  it("refuses other types, mismatched names, macros, empty and oversized files, and creates nothing", async () => {
    const before = { contracts: await contractCount(), attachments: await attachmentCount(), files: (await files()).length };
    const cases: [Buffer, string, string][] = [
      [PNG, "scan.png", "Only PDF, Word (.doc) and Word (.docx) files can be uploaded."],
      [Buffer.from("MZ\x90\x00not a document", "latin1"), "contract.pdf", "Only PDF, Word (.doc) and Word (.docx) files can be uploaded."],
      [TEST_PDF, "contract.docx", "This file is a PDF; its name must end in .pdf."],
      [await docx(true), "contract.docx", "Word documents with macros cannot be uploaded."],
      [doc(true), "contract.doc", "Word documents with macros cannot be uploaded."],
      [Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "archive.docx", "This file is not a Word document."],
    ];

    for (const [data, name, message] of cases) {
      const response = await post(await newContractBody(clientId, { contractDocument: contractDocument(data, name) }));
      expect(response.status, name).toBe(400);
      expect(response.body.error.details, name).toEqual([{ field: "contractDocument", message }]);
    }

    const tooLarge = await post(await newContractBody(clientId, { contractDocument: contractDocument(Buffer.concat([TEST_PDF, Buffer.alloc(env.attachmentMaxMb * 1024 * 1024)]), "large.pdf") }));
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error.details).toEqual([{ field: "contractDocument", message: `Files can be at most ${env.attachmentMaxMb} MB.` }]);

    expect({ contracts: await contractCount(), attachments: await attachmentCount(), files: (await files()).length }).toEqual(before);
  });

  it("leaves no contract, document or file behind when the contract itself is refused after the file is stored", async () => {
    const inactive = await createClient(admin, "Closed Requirements Hotel");
    await api().post(`/api/clients/${inactive}/deactivate`).set(admin.headers);
    const before = { contracts: await contractCount(), attachments: await attachmentCount(), files: (await files()).sort() };

    const refused = await post(await newContractBody(inactive));

    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ field: "clientId", message: "An inactive client cannot be selected. Reactivate the client first." }]);
    expect({ contracts: await contractCount(), attachments: await attachmentCount(), files: (await files()).sort() }).toEqual(before);
  });

  it("creates no contract when the file cannot be stored", async () => {
    const failing: FileStorage = {
      put: () => Promise.reject(new Error("disk full")),
      get: () => Promise.reject(new Error("missing")),
    };
    setStorageForTests(failing);
    const before = await contractCount();

    const response = await post(await newContractBody(clientId));

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("disk full");
    expect(await contractCount()).toBe(before);
  });

  it("refuses with a clear message, and creates nothing, on a server without file storage (as production today)", async () => {
    const settings = env as { attachmentsDir: string | null };
    const configured = settings.attachmentsDir;
    setStorageForTests(null);
    settings.attachmentsDir = null;

    try {
      const before = { contracts: await contractCount(), attachments: await attachmentCount() };
      const limits = await api().get("/api/attachments/limits").query({ entityType: "amc_contracts" }).set(admin.headers);
      expect(limits.body.data).toMatchObject({ maxMb: env.attachmentMaxMb, storageAvailable: false });

      const response = await post(await newContractBody(clientId));

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("STORAGE_UNAVAILABLE");
      expect(response.body.error.message).toContain("No contract was created");
      expect(response.body.error.message).toContain("ATTACHMENTS_DIR");
      expect({ contracts: await contractCount(), attachments: await attachmentCount() }).toEqual(before);
    } finally {
      settings.attachmentsDir = configured;
      setStorageForTests(disk);
    }
    expect((await api().get("/api/attachments/limits").query({ entityType: "amc_contracts" }).set(admin.headers)).body.data.storageAvailable).toBe(true);
  });

  it("is not accepted from someone who may not add contracts, whose body is never read", async () => {
    const response = await post(await newContractBody(clientId), execution);
    expect(response.status).toBe(403);
    expect((await api().post("/api/amc/contracts").send(await newContractBody(clientId))).status).toBe(401);
  });

  it("raises the body size limit for adding a contract only", async () => {
    // A large note on any other route is still refused by the 100 kB default.
    const big = "x".repeat(200 * 1024);
    expect((await api().post("/api/clients").set(admin.headers).send({ name: big, clientType: "COMPANY" })).status).toBe(413);
  });
});

describe("existing contracts", () => {
  it("stay editable without a sales engineer, system type, Final Credit or document", async () => {
    const id = await legacyContract(admin, clientId, { systemDescription: "Old typed system" });

    // The edit form sends the unchanged empty Final Credit back: nothing changes, nothing is refused.
    const saved = await patch(id, { notes: "Still editable", finalCredit: "", responsibleEngineer: "Someone" });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ notes: "Still editable", finalCredit: null, systemDescription: "Old typed system" });
    // An unlinked older contract keeps its typed system, which may still be corrected as text.
    expect((await patch(id, { systemDescription: "Old typed system (corrected)" })).body.data.systemDescription).toBe("Old typed system (corrected)");
    expect((await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: id }).set(admin.headers)).body.data).toEqual([]);
  });

  it("take a system type when one is chosen, and then follow it", async () => {
    const id = await legacyContract(admin, clientId, { systemDescription: "Typed CCTV" });
    const typeId = await systemTypeNamed("CCTV");

    const linked = await patch(id, { systemTypeId: typeId });
    expect(linked.status).toBe(200);
    expect(linked.body.data.systemDescription).toBe("CCTV");
    expect((await api().get(`/api/amc/contracts/${id}/masters`).set(admin.headers)).body.data.systemType).toMatchObject({ id: typeId });

    // Once linked, other free text is refused; the same text, or the same type, is accepted.
    const typed = await patch(id, { systemDescription: "Free text" });
    expect(typed.status).toBe(400);
    expect(fields(typed)).toEqual(["systemTypeId"]);
    expect((await patch(id, { systemDescription: "CCTV", notes: "same" })).status).toBe(200);
    expect((await patch(id, { systemTypeId: typeId, notes: "same type" })).status).toBe(200);

    // A system type that has been disabled since stays on the contract, but cannot be chosen anew.
    const other = await systemTypeNamed("Old Panel");
    await pool.query("UPDATE system_types SET is_active = false WHERE id = $1", [other]);
    expect(fields(await patch(id, { systemTypeId: other }))).toEqual(["systemTypeId"]);
    await pool.query("UPDATE system_types SET is_active = false WHERE id = $1", [typeId]);
    expect((await patch(id, { systemTypeId: typeId, notes: "kept while disabled" })).status).toBe(200);
    await pool.query("UPDATE system_types SET is_active = true WHERE id = $1", [typeId]);
  });

  it("keep a recorded Final Credit and sales engineer: they can be changed, not removed", async () => {
    const id = await activeContract(admin, clientId, { finalCredit: "250.000", systemDescription: "KEEP" });

    expect(fields(await patch(id, { finalCredit: null }))).toEqual(["finalCredit"]);
    expect(fields(await patch(id, { salesEngineerId: null }))).toEqual(["salesEngineerId"]);
    expect((await patch(id, { finalCredit: "0" })).body.data.finalCredit).toBe("0.000");
    expect((await patch(id, { salesEngineerId: await renewalEngineer("Second Keeper") })).status).toBe(200);
  });
});

describe("the Link master records panel (PUT /contracts/:id/masters)", () => {
  const put = (id: string, body: Record<string, unknown>, session: Session = admin) => api().put(`/api/amc/contracts/${id}/masters`).set(session.headers).send(body);
  const contract = async (id: string) => (await api().get(`/api/amc/contracts/${id}`).set(admin.headers)).body.data;

  it("cannot remove the mandatory sales engineer or system type of a new contract", async () => {
    const id = (await post(await newContractBody(clientId, { systemDescription: "Panel Keep" }))).body.data.id as string;

    for (const body of [{ salesEngineerId: null }, { systemTypeId: null }, { salesEngineerId: null, systemTypeId: null }]) {
      const response = await put(id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const links = (await api().get(`/api/amc/contracts/${id}/masters`).set(admin.headers)).body.data;
    expect(links.salesEngineer).not.toBeNull();
    expect(links.systemType).toMatchObject({ name: "Panel Keep" });
  });

  it("changes the system type and the contract's system name together, and records both", async () => {
    const id = (await post(await newContractBody(clientId, { systemDescription: "Panel Before" }))).body.data.id as string;
    const after = await systemTypeNamed("Panel After");

    const response = await put(id, { systemTypeId: after });
    expect(response.status).toBe(200);
    expect(response.body.data.systemType).toMatchObject({ id: after, name: "Panel After" });
    expect((await contract(id)).systemDescription).toBe("Panel After");

    const logged = (await logsFor("amc_contracts", id)).filter((log) => log.action === "amc_contract.masters_linked").at(-1);
    expect(logged?.metadata).toMatchObject({ changes: { systemDescription: { from: "Panel Before", to: "Panel After" } } });
    // The schedule is not touched by a link.
    expect(await visitsOf(id)).toEqual([]);
  });

  it("links an older contract without changing anything else, and leaves unlinked contracts alone", async () => {
    const older = await legacyContract(admin, clientId, { systemDescription: "Typed pumps" });
    const untouched = await legacyContract(admin, clientId, { systemDescription: "Typed lifts" });
    const visits = await visitsOf(older);
    const typeId = await systemTypeNamed("Pumps");

    expect((await put(older, { systemTypeId: typeId, salesEngineerId: await renewalEngineer("Older Link Engineer") })).status).toBe(200);
    expect(await contract(older)).toMatchObject({ systemDescription: "Pumps", finalCredit: null });
    expect(await visitsOf(older)).toEqual(visits);
    // No backfill: another older contract keeps its typed system and no links.
    expect((await contract(untouched)).systemDescription).toBe("Typed lifts");
    expect((await api().get(`/api/amc/contracts/${untouched}/masters`).set(admin.headers)).body.data).toEqual({ salesEngineer: null, systemType: null });
  });

  it("is refused without contract edit permission", async () => {
    const id = (await post(await newContractBody(clientId))).body.data.id as string;

    expect((await put(id, { systemTypeId: await systemTypeNamed("Not Allowed") }, execution)).status).toBe(403);
    expect((await api().put(`/api/amc/contracts/${id}/masters`).send({ systemTypeId: "1" })).status).toBe(401);
  });
});

describe("the AMC Contracts page's figures", () => {
  it("count every contract outside the Recycle Bin, sum its amounts and count the expired once", async () => {
    await resetData();
    admin = await signedIn("admin@example.com", ["ADMIN"]);
    const superAdmin = await signedIn("superadmin@example.com", ["ADMIN"]);
    const hotel = await createClient(admin, "KPI Hotel");
    const today = ((await pool.query<{ d: string }>("SELECT current_date::text AS d")).rows[0] as { d: string }).d;
    const lastYear = `${Number(today.slice(0, 4)) - 1}`;
    const nextYear = `${Number(today.slice(0, 4)) + 1}`;

    // Active and current; draft; cancelled; expired by status; active but ended (expired by date); an older contract without Final Credit.
    await activeContract(admin, hotel, { systemDescription: "K1", contractValue: "1000.125", finalCredit: "900.100", validFrom: `${nextYear}-01-01`, validTo: `${nextYear}-12-31` });
    await post(await newContractBody(hotel, { systemDescription: "K2", contractValue: "200.000", finalCredit: "150.000", status: "DRAFT" }));
    const cancelled = (await post(await newContractBody(hotel, { systemDescription: "K3", contractValue: "300.500", finalCredit: "0.001", status: "DRAFT" }))).body.data.id as string;
    await api().post(`/api/amc/contracts/${cancelled}/status`).set(admin.headers).send({ status: "CANCELLED", reason: "Test" });
    const expired = await activeContract(admin, hotel, { systemDescription: "K4", contractValue: "50.000", finalCredit: "10.000", validFrom: `${lastYear}-01-01`, validTo: `${lastYear}-12-31` });
    await api().post(`/api/amc/contracts/${expired}/status`).set(admin.headers).send({ status: "EXPIRED" });
    await activeContract(admin, hotel, { systemDescription: "K5", contractValue: "25.000", finalCredit: "5.000", validFrom: `${lastYear}-01-01`, validTo: `${lastYear}-06-30` });
    await legacyContract(admin, hotel, { systemDescription: "K6", contractValue: "75.000", validFrom: `${nextYear}-01-01`, validTo: `${nextYear}-12-31` });
    // In the Recycle Bin: left out of every figure.
    const binned = (await post(await newContractBody(hotel, { systemDescription: "K7", contractValue: "99999.000", finalCredit: "99999.000", status: "DRAFT" }))).body.data.id as string;
    expect((await api().delete(`/api/amc/contracts/${binned}`).set(superAdmin.headers)).status).toBe(200);

    const response = await kpis();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      total: 6,
      contractValue: "1650.625",
      finalCredit: "1065.101",
      finalCreditMissing: 1,
      expired: 2,
    });

    // The same figures, worked out independently from the table that holds every contract.
    const independent = await pool.query(
      `SELECT count(*)::int AS total, sum(contract_value)::numeric(16,3)::text AS value, sum(final_credit)::numeric(16,3)::text AS credit,
              count(*) FILTER (WHERE status = 'EXPIRED' OR (status = 'ACTIVE' AND valid_to < current_date))::int AS expired
       FROM amc_contracts_all WHERE deleted_at IS NULL`
    );
    expect(independent.rows[0]).toEqual({ total: 6, value: "1650.625", credit: "1065.101", expired: 2 });

    // Restored from the Recycle Bin, it counts again.
    expect((await api().post(`/api/security/recycle-bin/amc-contracts/${binned}/restore`).set(superAdmin.headers)).status).toBe(200);
    expect((await kpis()).body.data).toMatchObject({ total: 7, contractValue: "101649.625" });
  });

  it("need AMC Contracts view permission", async () => {
    const stranger = await signedIn("stranger@example.com", []);

    expect((await kpis(stranger)).status).toBe(403);
    expect((await api().get("/api/amc/contracts/kpis")).status).toBe(401);
  });
});
