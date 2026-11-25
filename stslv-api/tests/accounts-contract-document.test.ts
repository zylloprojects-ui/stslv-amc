import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, contractBody, contractDocument, createClient, grant, legacyContract, renewalEngineer, type Session, visitsOf } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Accounts → Invoices: the AMC Contract column. Each service row names the contract document of ITS OWN contract (the
// SIGNED_CONTRACT document saved with Add AMC Contract or Start Renewal). Since 2026-11-21 (owner decision) it is part of
// the page for every Accounts: View user and is downloaded through GET /api/accounts/:id/contract-document, without any
// AMC Contracts access. Accounts writes nothing and copies no file. Every record here is invented.

let folder: string;
let disk: LocalDiskStorage;
let admin: Session;
let accountsOnly: Session; // ACCOUNTS:VIEW, but NOT AMC_CONTRACTS:VIEW
let accountsAndContracts: Session; // ACCOUNTS:VIEW and AMC_CONTRACTS:VIEW, nothing else

const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`, "latin1");
const ALPHA_PDF = pdf("alpha contract");
const BETA_PDF = pdf("beta contract");

type ContractDocument = { id: string; title: string; version: number; originalName: string; mimeType: string; sizeBytes: number; uploadedAt: string };
type Item = { id: string; contract: { id: string }; contractDocument: ContractDocument | null };

const list = async (session: Session, query: Record<string, unknown> = {}) => {
  const response = await api().get("/api/accounts").query({ pageSize: 200, ...query }).set(session.headers);
  expect(response.status).toBe(200);
  return response.body.data as { items: Item[]; contractDocumentVisible: boolean };
};

const download = (id: string, session?: Session) => {
  const request = api().get(`/api/attachments/${id}/download`);
  return (session ? request.set(session.headers) : request).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });
};

const contractDownload = (visitId: string, session?: Session) => {
  const request = api().get(`/api/accounts/${visitId}/contract-document`);
  return (session ? request.set(session.headers) : request).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });
};

async function customRole(code: string, permissions: [string, string][]) {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [code]);
  await grant(code, permissions);
}

const attachmentsSnapshot = async () =>
  (await pool.query("SELECT id, document_id, version, is_current, entity_type, entity_id, category, title, original_name, sha256, storage_key FROM attachments ORDER BY id")).rows;

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "stslv-accounts-contract-"));
  disk = new LocalDiskStorage(folder);
  setStorageForTests(disk);

  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  await customRole("ACC_ONLY_TEST", [["ACCOUNTS", "VIEW"]]);
  accountsOnly = await signedIn("accounts-only@example.com", ["ACC_ONLY_TEST"]);
  await customRole("ACC_CONTRACTS_TEST", [
    ["ACCOUNTS", "VIEW"],
    ["AMC_CONTRACTS", "VIEW"],
  ]);
  accountsAndContracts = await signedIn("accounts-contracts@example.com", ["ACC_CONTRACTS_TEST"]);
  await customRole("CONTRACTS_ONLY_TEST", [["AMC_CONTRACTS", "VIEW"]]);
});
beforeEach(() => setStorageForTests(disk));
afterAll(async () => {
  setStorageForTests(null);
  await rm(folder, { recursive: true, force: true });
  await closePool();
});

describe("Accounts: AMC Contract column", () => {
  let alphaContract: string;
  let betaContract: string;
  let legacy: string;
  let lpoOnly: string;

  beforeAll(async () => {
    const alpha = await createClient(admin, "Contract Column Alpha");
    const beta = await createClient(admin, "Contract Column Beta");
    alphaContract = await activeContract(admin, alpha, { contractDocument: contractDocument(ALPHA_PDF, "Alpha signed contract.pdf") });
    betaContract = await activeContract(admin, beta, { systemDescription: "CCTV", maintenanceFrequency: "HALF_YEARLY", contractDocument: contractDocument(BETA_PDF, "Beta contract.pdf") });
    // A contract added before contract documents were required: no document at all.
    legacy = await legacyContract(admin, alpha, { systemDescription: "PUMPS" });
    // An older contract with only an LPO attached: an LPO is not the contract document.
    lpoOnly = await legacyContract(admin, beta, { systemDescription: "ACCESS" });
    const lpo = await api()
      .post("/api/attachments")
      .query({ entityType: "amc_contracts", entityId: lpoOnly, category: "LPO", title: "Client LPO" })
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "lpo.pdf")
      .send(pdf("lpo"));
    expect(lpo.status).toBe(201);
  });

  it("gives every service row the contract document of its own contract", async () => {
    const { items, contractDocumentVisible } = await list(admin);
    expect(contractDocumentVisible).toBe(true);

    const alphaVisits = new Set((await visitsOf(alphaContract)).map((visit) => visit.id));
    const betaVisits = new Set((await visitsOf(betaContract)).map((visit) => visit.id));
    const alphaRows = items.filter((item) => alphaVisits.has(item.id));
    const betaRows = items.filter((item) => betaVisits.has(item.id));
    expect(alphaRows).toHaveLength(4);
    expect(betaRows).toHaveLength(2);

    const alphaDocument = (await pool.query<{ id: string }>("SELECT id::text FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1 AND is_current", [alphaContract])).rows;
    const betaDocument = (await pool.query<{ id: string }>("SELECT id::text FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1 AND is_current", [betaContract])).rows;
    expect(alphaDocument).toHaveLength(1);
    expect(betaDocument).toHaveLength(1);

    for (const row of alphaRows) {
      expect(row.contract.id).toBe(alphaContract);
      expect(row.contractDocument).toMatchObject({ id: alphaDocument[0]!.id, originalName: "Alpha signed contract.pdf", mimeType: "application/pdf", title: "Contract document", version: 1, sizeBytes: ALPHA_PDF.length });
    }
    for (const row of betaRows) {
      expect(row.contractDocument).toMatchObject({ id: betaDocument[0]!.id, originalName: "Beta contract.pdf" });
    }
  });

  it("downloads exactly that contract's file, under its own name, through the attachment download", async () => {
    const { items } = await list(admin);
    const alphaRow = items.find((item) => item.contract.id === alphaContract)!;
    const betaRow = items.find((item) => item.contract.id === betaContract)!;

    const alphaFile = await download(alphaRow.contractDocument!.id, admin);
    expect(alphaFile.status).toBe(200);
    expect(alphaFile.headers["content-type"]).toContain("application/pdf");
    expect(alphaFile.headers["content-disposition"]).toContain("Alpha%20signed%20contract.pdf");
    expect(alphaFile.headers["cache-control"]).toBe("no-store");
    expect(Buffer.compare(alphaFile.body as Buffer, ALPHA_PDF)).toBe(0);

    const betaFile = await download(betaRow.contractDocument!.id, accountsAndContracts);
    expect(betaFile.status).toBe(200);
    expect(Buffer.compare(betaFile.body as Buffer, BETA_PDF)).toBe(0);
  });

  it("shows no document for a contract without one, and never treats another document type as the contract", async () => {
    const { items } = await list(admin);
    const legacyRows = items.filter((item) => item.contract.id === legacy);
    const lpoRows = items.filter((item) => item.contract.id === lpoOnly);
    expect(legacyRows.length).toBeGreaterThan(0);
    expect(lpoRows.length).toBeGreaterThan(0);
    for (const row of [...legacyRows, ...lpoRows]) expect(row.contractDocument).toBeNull();
  });

  it("follows the document's current version after a replacement, and keeps every version", async () => {
    const original = (await list(admin)).items.find((item) => item.contract.id === betaContract)!.contractDocument!;
    const replacement = pdf("beta contract signed v2");
    const uploaded = await api()
      .post(`/api/attachments/${original.id}/versions`)
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "Beta contract v2.pdf")
      .send(replacement);
    expect(uploaded.status).toBe(201);

    const rows = (await list(admin)).items.filter((item) => item.contract.id === betaContract);
    for (const row of rows) expect(row.contractDocument).toMatchObject({ id: String(uploaded.body.data.id), originalName: "Beta contract v2.pdf", version: 2 });
    expect(Buffer.compare((await download(rows[0]!.contractDocument!.id, admin)).body as Buffer, replacement)).toBe(0);
    // The first version is still stored and still served.
    expect(Buffer.compare((await download(original.id, admin)).body as Buffer, BETA_PDF)).toBe(0);
  });

  it("follows the most recently uploaded contract document: a later Attach document, then a later Replace (owner decision 2026-11-25)", async () => {
    const client = await createClient(admin, "Contract Column Latest");
    const contract = await activeContract(admin, client, { contractDocument: contractDocument(pdf("first"), "first.pdf") });
    const first = (await list(admin, { clientId: client })).items.find((item) => item.contract.id === contract)!.contractDocument!;
    expect(first.originalName).toBe("first.pdf");

    // A second contract document added with Attach document (not a Replace) takes over on every service row.
    const added = pdf("added later");
    const attached = await api()
      .post("/api/attachments")
      .query({ entityType: "amc_contracts", entityId: contract, category: "SIGNED_CONTRACT", title: "Signed contract (updated)" })
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "added.pdf")
      .send(added);
    expect(attached.status).toBe(201);

    let rows = (await list(admin, { clientId: client })).items.filter((item) => item.contract.id === contract);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.contractDocument).toMatchObject({ id: String(attached.body.data.id), originalName: "added.pdf", version: 1 });
    expect(Buffer.compare((await contractDownload(rows[0]!.id, accountsOnly)).body as Buffer, added)).toBe(0);

    // Another document type added later never takes over.
    const lpo = await api()
      .post("/api/attachments")
      .query({ entityType: "amc_contracts", entityId: contract, category: "LPO", title: "Client LPO" })
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "lpo-later.pdf")
      .send(pdf("lpo later"));
    expect(lpo.status).toBe(201);
    rows = (await list(admin, { clientId: client })).items.filter((item) => item.contract.id === contract);
    for (const row of rows) expect(row.contractDocument?.originalName).toBe("added.pdf");

    // A new version of the first document, uploaded after that, is now the most recent upload.
    const replacement = pdf("first v2");
    const replaced = await api()
      .post(`/api/attachments/${first.id}/versions`)
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "first-v2.pdf")
      .send(replacement);
    expect(replaced.status).toBe(201);
    rows = (await list(admin, { clientId: client })).items.filter((item) => item.contract.id === contract);
    for (const row of rows) expect(row.contractDocument).toMatchObject({ id: String(replaced.body.data.id), originalName: "first-v2.pdf", version: 2 });
    expect(Buffer.compare((await contractDownload(rows[0]!.id, accountsOnly)).body as Buffer, replacement)).toBe(0);
  });

  it("shows a renewal's own renewal document on the renewal's services, never the renewed contract's", async () => {
    const client = await createClient(admin, "Contract Column Renewal");
    const source = await activeContract(admin, client, { validFrom: "2027-01-01", validTo: "2027-12-31", contractDocument: contractDocument(pdf("source"), "source.pdf") });
    const { amcReference: _ignored, ...body } = contractBody(client, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId: await renewalEngineer() });
    const renewed = await api()
      .post(`/api/amc/contracts/${source}/renewals`)
      .set(admin.headers)
      .send({ ...body, contractDocument: contractDocument(pdf("renewal"), "renewal-2028.pdf") });
    expect(renewed.status).toBe(201);
    const renewal = renewed.body.data.id as string;
    const activated = await api().post(`/api/amc/contracts/${renewal}/status`).set(admin.headers).send({ status: "ACTIVE" });
    expect(activated.status).toBe(200);

    const { items } = await list(admin, { clientId: client });
    const sourceRows = items.filter((item) => item.contract.id === source);
    const renewalRows = items.filter((item) => item.contract.id === renewal);
    expect(sourceRows.length).toBeGreaterThan(0);
    expect(renewalRows.length).toBeGreaterThan(0);
    for (const row of sourceRows) expect(row.contractDocument?.originalName).toBe("source.pdf");
    for (const row of renewalRows) expect(row.contractDocument).toMatchObject({ originalName: "renewal-2028.pdf", title: "Renewal contract document" });
  });

  it("sends no storage key or path, only the document's metadata", async () => {
    const { items } = await list(admin);
    const keys = (await pool.query<{ storage_key: string }>("SELECT storage_key FROM attachments")).rows.map((row) => row.storage_key);
    const body = JSON.stringify(items);
    for (const key of keys) expect(body).not.toContain(key);
    const document = items.find((item) => item.contractDocument)!.contractDocument!;
    expect(Object.keys(document).sort()).toEqual(["id", "mimeType", "originalName", "sizeBytes", "title", "uploadedAt", "version"]);
  });

  it("lists the contract document for an Accounts user without AMC Contracts: View (owner decision 2026-11-21)", async () => {
    const { items, contractDocumentVisible } = await list(accountsOnly);
    expect(contractDocumentVisible).toBe(true);
    const alphaDocument = (await list(admin)).items.find((item) => item.contract.id === alphaContract)!.contractDocument!;
    expect(items.find((item) => item.contract.id === alphaContract)?.contractDocument?.id).toBe(alphaDocument.id);
  });

  it("downloads each service's own contract document through the Accounts route with Accounts: View alone", async () => {
    const { items } = await list(accountsOnly);
    const alphaRow = items.find((item) => item.contract.id === alphaContract)!;
    const legacyRow = items.find((item) => item.contract.id === legacy)!;
    const lpoRow = items.find((item) => item.contract.id === lpoOnly)!;

    const file = await contractDownload(alphaRow.id, accountsOnly);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
    expect(file.headers["content-disposition"]).toContain("Alpha%20signed%20contract.pdf");
    expect(file.headers["cache-control"]).toBe("no-store");
    expect(Buffer.compare(file.body as Buffer, ALPHA_PDF)).toBe(0);

    // A contract without a document, or with only an LPO, has nothing to download.
    expect((await contractDownload(legacyRow.id, accountsOnly)).status).toBe(404);
    expect((await contractDownload(lpoRow.id, accountsOnly)).status).toBe(404);
    expect((await contractDownload("999999", accountsOnly)).status).toBe(404);
    expect((await contractDownload(alphaRow.id)).status).toBe(401);
  });

  it("gives an Accounts-only user no AMC Contracts access: the contract pages and their document routes stay refused", async () => {
    const alphaDocument = (await list(admin)).items.find((item) => item.contract.id === alphaContract)!.contractDocument!;
    expect((await download(alphaDocument.id, accountsOnly)).status).toBe(403);
    expect((await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: alphaContract }).set(accountsOnly.headers)).status).toBe(403);
    expect((await api().get(`/api/amc/contracts/${alphaContract}`).set(accountsOnly.headers)).status).toBe(403);
    expect((await api().get("/api/amc/contracts").set(accountsOnly.headers)).status).toBe(403);
  });

  it("refuses the Accounts contract download to a user without Accounts: View", async () => {
    const contractsOnly = await signedIn("contracts-only@example.com", ["CONTRACTS_ONLY_TEST"]);
    const alphaRow = (await list(admin)).items.find((item) => item.contract.id === alphaContract)!;
    expect((await contractDownload(alphaRow.id, contractsOnly)).status).toBe(403);
  });

  it("changes no document: listing and downloading leave every attachment row and stored file as they were", async () => {
    const rowsBefore = await attachmentsSnapshot();
    const filesBefore = (await readdir(folder)).sort();

    const { items } = await list(admin);
    for (const item of items.filter((row) => row.contractDocument)) await download(item.contractDocument!.id, admin);
    await list(accountsOnly);

    expect(await attachmentsSnapshot()).toEqual(rowsBefore);
    expect((await readdir(folder)).sort()).toEqual(filesBefore);
  });

  it("leaves the export unchanged: the document is not part of the downloads", async () => {
    const response = await api().get("/api/accounts/export").query({ format: "xlsx" }).set(admin.headers);
    expect(response.status).toBe(200);
    // The page-only column id is refused like any unknown column, so the page never sends it.
    expect((await api().get("/api/accounts/export").query({ format: "xlsx", hidden: "amcContract" }).set(admin.headers)).status).toBe(400);
  });
});
