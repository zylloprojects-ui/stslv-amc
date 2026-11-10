import ExcelJS from "exceljs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { HEADER_ROW } from "../src/shared/export/excel";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { LocalDiskStorage } from "../src/shared/storage";
import { businessDateOf } from "../src/shared/business-date";
import { activeContract, contractBody, createClient, grant, logsFor, renewalEngineer, TEST_PDF, visitsOf, withRenewalDocument, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { cancelInvoice, invoiceBody, newInvoice } from "./invoices-helpers";

// Invoice Acknowledgements, one acknowledgement per INVOICE (migrations 0112-0115). Synthetic records in the
// stslv_test schema only; documents go to a throwaway folder of this file (a spy around the local disk storage).
//
// Dataset (client A, contract STS-AMC-IA1 2026 and its renewal V2 2027; client B):
//   INV-100    A v1          Invoice Tracking record (300)              one service
//   INV-MULTI  A v2 + v3     one Invoice Tracking record (600)         two services, ONE invoice
//   INV-DUP    A v4 and r2   manual only, same number                  two invoices, flagged for reconciliation
//   INV-200    A r1 (V2)     manual only (its Zoho record cancelled)    renewal-version invoice
//   INV-LEG    A r3 + r4     one Invoice Tracking record (800)         two 0112-style acknowledgements (conflict)
//   INV-100    B b1          manual only: same number, other client    separate, not flagged
//   INV-SEP    B b2 and b3   manual only, same number                  confirmed separate

const BASE = "/api/invoice-acknowledgements";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

class SpyStorage extends LocalDiskStorage {
  puts: string[] = [];
  removes: string[] = [];
  failPut = false;
  override async put(key: string, data: Buffer) {
    if (this.failPut) throw new Error("simulated storage outage");
    this.puts.push(key);
    return super.put(key, data);
  }
  override async remove(key: string) {
    this.removes.push(key);
    return super.remove(key);
  }
}

const folder = mkdtempSync(path.join(tmpdir(), "stslv-ack-storage-"));
const storage = new SpyStorage(folder);

let admin: Session; // Super Admin
let administrator: Session; // Admin: V C E X (0115)
let finance: Session; // Finance Executive: V C X (0115), plus Accounts
let viewer: Session; // Viewer: nothing (approved default)
let operations: Session; // AMC Operations Executive: nothing
let viewOnly: Session; // custom: VIEW only, no Accounts
let exporterNoAmounts: Session; // custom: VIEW + EXPORT, no Accounts

let clientA: string;
let clientB: string;
let original: string;
let renewal: string;
const v: string[] = [];
const r: string[] = [];
const b: string[] = [];

interface Item {
  invoiceId: string;
  invoiceNo: string;
  basis: string;
  client: { id: string; name: string };
  contracts: { id: string; reference: string; version: number }[];
  serviceCount: number;
  invoiceDate: string | null;
  invoiceValue: string | null;
  serviceValue: string | null;
  amountsVisible: boolean;
  status: string;
  acknowledgementId: string | null;
  document: { attachmentId: string; version: number; originalName: string; mimeType: string; uploadedBy: { id: string } } | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string } | null;
  reconciliation: string[];
}

async function customRole(code: string, permissions: [string, string][]) {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [code]);
  await grant(code, permissions);
}

const list = async (session: Session = admin, query: Record<string, unknown> = {}) => (await api().get(BASE).query({ pageSize: 200, ...query }).set(session.headers)).body.data;
const items = async (session: Session = admin, query: Record<string, unknown> = {}): Promise<Item[]> => (await list(session, query)).items;
/** The invoice with this number of this client (exactly one expected). */
const invoice = async (number: string, client = clientA, session: Session = admin): Promise<Item> => {
  const found = (await items(session)).filter((row) => row.invoiceNo === number && row.client.id === client);
  expect(found, `${number} of ${client}`).toHaveLength(1);
  return found[0]!;
};
const attach = (session: Session, invoiceId: string, data: Buffer = TEST_PDF, name = "acknowledgement.pdf") =>
  api().post(`${BASE}/${invoiceId}/document`).set(session.headers).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name)).send(data);
const confirm = (session: Session, invoiceId: string, attachmentId: string) => api().post(`${BASE}/${invoiceId}/confirm`).set(session.headers).send({ attachmentId });
const replace = (session: Session, invoiceId: string, reason: string | null, data: Buffer = TEST_PDF, name = "acknowledgement-v2.pdf") => {
  const request = api().post(`${BASE}/${invoiceId}/replace`).set(session.headers).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name));
  if (reason !== null) request.set("X-Replace-Reason", encodeURIComponent(reason));
  return request.send(data);
};
const binary = (request: ReturnType<ReturnType<typeof api>["get"]>) =>
  request.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });
const setInvoiceNo = async (visitId: string, invoiceNo: string | null) => {
  const updatedAt = (await api().get(`/api/amc/visits/${visitId}`).set(admin.headers)).body.data.updatedAt;
  const response = await api().patch(`/api/amc/visits/${visitId}/manual-invoice`).set(admin.headers).send({ invoiceNo, expectedUpdatedAt: updatedAt });
  expect(response.status).toBe(200);
};
const complete = async (visitId: string) => {
  await withServiceReport(visitId);
  const row = (await api().get(`/api/amc/service-status/${visitId}`).set(admin.headers)).body.data;
  expect((await api().patch(`/api/amc/service-status/${visitId}`).set(admin.headers).send({ status: "COMPLETED", expectedUpdatedAt: row.updatedAt })).status).toBe(200);
};
const visitSnapshot = (ids: string[]) =>
  pool.query("SELECT id, manual_invoice_no, manual_invoice_at, visit_amount, status, completed_date, updated_at FROM amc_visits_all WHERE id = ANY($1::bigint[]) ORDER BY id", [ids]).then((res) => res.rows);

/** A 0112-style (per-service) acknowledgement, as the earlier release stored it: optionally with a document, optionally confirmed. */
async function legacyAcknowledgement(visitId: string, invoiceNo: string, options: { document?: string; acknowledged?: boolean }) {
  const ack = (await pool.query<{ id: string }>("INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, created_by) VALUES ($1, $2, $3) RETURNING id", [visitId, invoiceNo, admin.id])).rows[0]!.id;
  if (options.document) {
    const attachment = (
      await pool.query<{ id: string }>(
        `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ('invoice_acknowledgements', $1, 'INVOICE_ACKNOWLEDGEMENT', 'Invoice acknowledgement', $2, 'application/pdf', 1, repeat('0', 64), gen_random_uuid()::text || '.pdf', $3) RETURNING id`,
        [ack, options.document, admin.id]
      )
    ).rows[0]!.id;
    await pool.query("UPDATE attachments SET document_id = id WHERE id = $1", [attachment]);
  }
  if (options.acknowledged) {
    await pool.query("UPDATE invoice_acknowledgements SET status = 'ACKNOWLEDGED', acknowledged_at = '2026-11-05T09:15:00Z', acknowledged_by = $2 WHERE id = $1", [ack, finance.id]);
  }
  return ack;
}

beforeAll(async () => {
  setStorageForTests(storage);
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  administrator = await signedIn("administrator@example.com", ["ADMINISTRATOR"]);
  finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
  viewer = await signedIn("viewer@example.com", ["VIEWER"]);
  operations = await signedIn("operations@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
  await customRole("IA_VIEW", [["INVOICE_ACKNOWLEDGEMENTS", "VIEW"]]);
  await customRole("IA_EXPORT", [
    ["INVOICE_ACKNOWLEDGEMENTS", "VIEW"],
    ["INVOICE_ACKNOWLEDGEMENTS", "EXPORT"],
  ]);
  viewOnly = await signedIn("view@example.com", ["IA_VIEW"]);
  exporterNoAmounts = await signedIn("export@example.com", ["IA_EXPORT"]);

  clientA = await createClient(admin, "Acknowledgement Client");
  clientB = await createClient(admin, "Other Client");
  const engineer = await renewalEngineer();
  original = await activeContract(admin, clientA, { amcReference: "STS-AMC-IA1", systemDescription: "ACK SYSTEM", validFrom: "2026-01-01", validTo: "2026-12-31", contractValue: "1200.000", defaultVisitAmount: "300.000" });
  const renewed = await api()
    .post(`/api/amc/contracts/${original}/renewals`)
    .set(admin.headers)
    .send(withRenewalDocument(contractBody(clientA, { systemDescription: "ACK SYSTEM", validFrom: "2027-01-01", validTo: "2027-12-31", status: "DRAFT", salesEngineerId: engineer, contractValue: "1600.000", defaultVisitAmount: "400.000" })));
  expect(renewed.status).toBe(201);
  renewal = renewed.body.data.id;
  expect((await api().post(`/api/amc/contracts/${renewal}/status`).set(admin.headers).send({ status: "ACTIVE" })).status).toBe(200);
  const other = await activeContract(admin, clientB, { amcReference: "STS-AMC-OTHER", systemDescription: "OTHER", validFrom: "2026-01-01", validTo: "2026-12-31", contractValue: "800.000", defaultVisitAmount: "200.000" });

  v.push(...(await visitsOf(original)).map((visit) => visit.id));
  r.push(...(await visitsOf(renewal)).map((visit) => visit.id));
  b.push(...(await visitsOf(other)).map((visit) => visit.id));
  for (const id of [...v, ...r, b[0]!, b[1]!, b[2]!]) await complete(id);

  for (const [id, number] of [
    [v[0], "INV-100"], [v[1], "INV-MULTI"], [v[2], "INV-MULTI"], [v[3], "INV-DUP"],
    [r[0], "INV-200"], [r[1], "INV-DUP"], [r[2], "INV-LEG"], [r[3], "INV-LEG"],
    [b[0], "INV-100"], [b[1], "INV-SEP"], [b[2], "INV-SEP"],
  ] as [string, string][]) await setInvoiceNo(id, number);

  await newInvoice(admin, invoiceBody(clientA, [{ amcVisitId: v[0]!, amount: "300.000" }], { invoiceNumber: "INV-100", amountExclVat: "300.000", vatAmount: "0.000", invoiceDate: "2026-03-15" }));
  await newInvoice(admin, invoiceBody(clientA, [{ amcVisitId: v[1]!, amount: "300.000" }, { amcVisitId: v[2]!, amount: "300.000" }], { invoiceNumber: "INV-MULTI", amountExclVat: "600.000", vatAmount: "0.000", invoiceDate: "2026-09-30" }));
  await newInvoice(admin, invoiceBody(clientA, [{ amcVisitId: r[2]!, amount: "400.000" }, { amcVisitId: r[3]!, amount: "400.000" }], { invoiceNumber: "INV-LEG", amountExclVat: "800.000", vatAmount: "0.000", invoiceDate: "2027-12-31" }));
  const cancelled = await newInvoice(admin, invoiceBody(clientA, [{ amcVisitId: r[0]!, amount: "400.000" }], { invoiceNumber: "INV-200", amountExclVat: "400.000", vatAmount: "0.000", invoiceDate: "2027-03-15" }));
  expect((await cancelInvoice(admin, cancelled.id)).status).toBe(200);

  // Two acknowledgements recorded per service by the earlier release, for the two services of INV-LEG (both
  // confirmed, with documents): a conflict that must not be resolved automatically.
  await legacyAcknowledgement(r[2]!, "INV-LEG", { document: "leg-r3.pdf", acknowledged: true });
  await legacyAcknowledgement(r[3]!, "INV-LEG", { document: "leg-r4.pdf", acknowledged: true });
});

afterAll(async () => {
  setStorageForTests(null);
  rmSync(folder, { recursive: true, force: true });
  await closePool();
});

describe("one row per invoice", () => {
  it("lists each invoice once, with all its services, on the right contract period", async () => {
    const rows = await items();
    const keys = rows.map((row) => `${row.client.id === clientA ? "A" : "B"}:${row.invoiceNo}:${row.serviceCount}`).sort();

    expect(keys).toEqual(["A:INV-100:1", "A:INV-200:1", "A:INV-DUP:1", "A:INV-DUP:1", "A:INV-LEG:2", "A:INV-MULTI:2", "B:INV-100:1", "B:INV-SEP:1", "B:INV-SEP:1"]);
    expect(await invoice("INV-MULTI")).toMatchObject({ basis: "ZOHO", invoiceDate: "2026-09-30", invoiceValue: "600.000", serviceValue: "600.000", contracts: [{ id: original, reference: "STS-AMC-IA1", version: 1 }] });
    expect(await invoice("INV-200")).toMatchObject({ basis: "SERVICE", invoiceDate: null, invoiceValue: null, contracts: [{ id: renewal, reference: "STS-AMC-IA1 (V2)", version: 2 }] });
    // The Zoho record of client A is not client B's invoice of the same number.
    expect(await invoice("INV-100", clientB)).toMatchObject({ basis: "SERVICE", invoiceValue: null, reconciliation: [] });
  });

  it("counts each invoice once in the totals", async () => {
    const data = await list(admin, { clientId: clientA });
    // Invoice values: 300 (INV-100) + 600 (INV-MULTI, two services, once) + 800 (INV-LEG, two services, once); INV-200's
    // record is cancelled. Service values: the eight services, 4 x 300 + 4 x 400.
    expect(data.kpis).toMatchObject({ total: 6, invoiceValueTotal: "1700.000", serviceValueTotal: "2800.000" });
  });

  it("shows several invoices of one contract separately", async () => {
    const rows = await items(admin, { contractId: original });
    expect(rows.map((row) => row.invoiceNo).sort()).toEqual(["INV-100", "INV-DUP", "INV-MULTI"]);
  });

  it("lists the linked services of an invoice, with values only for Accounts viewers", async () => {
    const multi = await invoice("INV-MULTI");
    const services = (await api().get(`${BASE}/${multi.invoiceId}/services`).set(finance.headers)).body.data;
    expect(services.map((service: { visitId: string; basis: string; serviceValue: string }) => [service.visitId, service.basis, service.serviceValue])).toEqual([
      [v[1], "ZOHO", "300.000"],
      [v[2], "ZOHO", "300.000"],
    ]);
    const hidden = (await api().get(`${BASE}/${multi.invoiceId}/services`).set(viewOnly.headers)).body.data;
    expect(hidden.every((service: { serviceValue: string | null }) => service.serviceValue === null)).toBe(true);
  });

  it("matches Accounts: the same invoice numbers on the same services, and no service without one", async () => {
    const accounts = (await api().get("/api/accounts").query({ invoiceStatus: "RECORDED", pageSize: 200 }).set(admin.headers)).body.data.items as { id: string; manualInvoiceNo: string }[];
    const linked: string[] = [];
    for (const row of await items()) {
      const services = (await api().get(`${BASE}/${row.invoiceId}/services`).set(admin.headers)).body.data as { visitId: string; invoiceNo: string }[];
      for (const service of services) {
        expect(accounts.find((account) => account.id === service.visitId)?.manualInvoiceNo).toBe(row.invoiceNo);
        linked.push(service.visitId);
      }
    }
    expect(linked.sort()).toEqual(accounts.map((account) => account.id).sort());
  });
});

describe("permissions (approved defaults) and financial visibility", () => {
  it("gives Super Admin, Admin and Finance Executive the page; Viewer and AMC Operations nothing", async () => {
    for (const session of [admin, administrator, finance]) expect((await api().get(BASE).set(session.headers)).status).toBe(200);
    for (const session of [viewer, operations]) {
      expect((await api().get(BASE).set(session.headers)).status).toBe(403);
      expect((await api().get(`${BASE}/options`).set(session.headers)).status).toBe(403);
    }
    const grants = await pool.query(
      "SELECT r.code, array_agg(p.action ORDER BY p.action) AS actions FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE p.module = 'INVOICE_ACKNOWLEDGEMENTS' AND r.code NOT LIKE 'IA\\_%' GROUP BY r.code ORDER BY r.code"
    );
    expect(grants.rows).toEqual([
      { code: "ADMIN", actions: ["APPROVE", "CREATE", "DELETE", "EDIT", "EXPORT", "READ", "VIEW"] },
      { code: "ADMINISTRATOR", actions: ["CREATE", "EDIT", "EXPORT", "VIEW"] },
      { code: "FINANCE_EXECUTIVE", actions: ["CREATE", "EXPORT", "VIEW"] },
    ]);
  });

  it("refuses every route to a role without the module", async () => {
    const multi = await invoice("INV-MULTI");
    const id = multi.invoiceId;
    const calls = [
      api().get(`${BASE}/export`).query({ format: "xlsx" }).set(viewer.headers),
      api().get(`${BASE}/${id}`).set(viewer.headers),
      api().get(`${BASE}/${id}/services`).set(viewer.headers),
      api().get(`${BASE}/${id}/history`).set(viewer.headers),
      api().get(`${BASE}/${id}/document`).set(viewer.headers),
      attach(viewer, id),
      api().delete(`${BASE}/${id}/document`).set(viewer.headers),
      confirm(viewer, id, "1"),
      replace(viewer, id, "Because"),
      api().get(`${BASE}/${id}/reconciliation`).set(viewer.headers),
      api().post(`${BASE}/${id}/separate`).set(viewer.headers).send({ reason: "Because" }),
    ];
    for (const response of await Promise.all(calls)) expect(response.status).toBe(403);
    expect((await api().get(BASE)).status).toBe(401);
  });

  it("Finance can attach and export but not replace or reconcile; View only can do neither", async () => {
    const dup = (await items()).find((row) => row.invoiceNo === "INV-DUP")!;
    expect((await api().get(`${BASE}/${dup.invoiceId}/reconciliation`).set(finance.headers)).status).toBe(403);
    expect((await api().post(`${BASE}/${dup.invoiceId}/separate`).set(finance.headers).send({ reason: "Because" })).status).toBe(403);
    expect((await replace(finance, dup.invoiceId, "Because")).status).toBe(403);
    expect((await attach(viewOnly, dup.invoiceId)).status).toBe(403);
    expect((await api().get(`${BASE}/export`).query({ format: "xlsx" }).set(viewOnly.headers)).status).toBe(403);
  });

  it("hides amounts from a role that cannot view Accounts", async () => {
    const data = await list(viewOnly);
    expect(data.items.every((row: Item) => !row.amountsVisible && row.invoiceValue === null && row.serviceValue === null)).toBe(true);
    expect(data.kpis).toMatchObject({ invoiceValueTotal: null, serviceValueTotal: null });
    expect((await invoice("INV-MULTI", clientA, finance)).invoiceValue).toBe("600.000");
  });
});

describe("attach and confirm one acknowledgement for a multi-service invoice", () => {
  it("refuses an invalid, empty or wrongly named file, stores nothing and creates no acknowledgement", async () => {
    const multi = await invoice("INV-MULTI");
    const before = storage.puts.length;
    for (const response of [
      await attach(finance, multi.invoiceId, Buffer.from("plain text, not a document"), "ack.pdf"),
      await attach(finance, multi.invoiceId, Buffer.alloc(0), "ack.pdf"),
      await attach(finance, multi.invoiceId, TEST_PDF, "ack.png"),
    ]) {
      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe("document");
    }
    const big = await attach(finance, multi.invoiceId, Buffer.concat([TEST_PDF, Buffer.alloc(12 * 1024 * 1024)]), "big.pdf");
    expect(big.status).toBe(400);
    expect(storage.puts.length).toBe(before);
    expect((await invoice("INV-MULTI")).acknowledgementId).toBeNull();
  });

  it("cannot confirm before a document is attached", async () => {
    const multi = await invoice("INV-MULTI");
    const response = await confirm(finance, multi.invoiceId, "1");
    expect(response.status).toBe(409);
    expect((await api().get(`${BASE}/${multi.invoiceId}/document`).set(finance.headers)).status).toBe(404);
  });

  it("attaches one document for the whole invoice, still Pending, without changing any service", async () => {
    const multi = await invoice("INV-MULTI");
    const before = await visitSnapshot([v[1]!, v[2]!]);
    const response = await attach(finance, multi.invoiceId, TEST_PDF, "Client stamp INV-MULTI.pdf");

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: "PENDING", serviceCount: 2, document: { originalName: "Client stamp INV-MULTI.pdf", version: 1, uploadedBy: { id: finance.id } } });
    expect(JSON.stringify(response.body)).not.toMatch(/storage_?key|sha256|https?:\/\//i);
    const file = await binary(api().get(`${BASE}/${multi.invoiceId}/document`).set(viewOnly.headers));
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, TEST_PDF)).toBe(0);
    expect(file.headers["cache-control"]).toBe("no-store");
    expect(file.headers["content-disposition"]).toContain("attachment;");
    expect(await visitSnapshot([v[1]!, v[2]!])).toEqual(before);
  });

  it("confirms only the document the user saw, and one of two simultaneous confirmations", async () => {
    const multi = await invoice("INV-MULTI");
    expect((await confirm(finance, multi.invoiceId, "999999")).status).toBe(409);

    const before = await visitSnapshot([v[1]!, v[2]!]);
    const invoicesBefore = (await pool.query("SELECT * FROM invoices ORDER BY id")).rows;
    const [first, second] = await Promise.all([confirm(finance, multi.invoiceId, multi.document!.attachmentId), confirm(administrator, multi.invoiceId, multi.document!.attachmentId)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);

    const acknowledged = await invoice("INV-MULTI", clientA, viewOnly);
    expect(acknowledged).toMatchObject({ status: "ACKNOWLEDGED", serviceCount: 2 });
    expect(businessDateOf(new Date(acknowledged.acknowledgedAt!))).toBe(businessDateOf());
    expect((await pool.query("SELECT count(*)::int AS n FROM invoice_acknowledgements WHERE ack_invoice_id = $1", [multi.invoiceId])).rows[0].n).toBe(1);
    expect(await visitSnapshot([v[1]!, v[2]!])).toEqual(before);
    expect((await pool.query("SELECT * FROM invoices ORDER BY id")).rows).toEqual(invoicesBefore);
    // Accounts is untouched: both services keep their Paid reference status and values.
    const accounts = (await api().get("/api/accounts").query({ clientId: clientA, pageSize: 200 }).set(admin.headers)).body.data.items as { id: string; paymentStatus: string; visitValue: string }[];
    expect(accounts.filter((row) => row.id === v[1] || row.id === v[2]).map((row) => [row.paymentStatus, row.visitValue])).toEqual([
      ["PAID", "300.000"],
      ["PAID", "300.000"],
    ]);
    expect((await logsFor("invoice_acknowledgements", acknowledged.acknowledgementId!)).map((log) => log.action)).toEqual([
      "invoice_acknowledgement.document_uploaded",
      "invoice_acknowledgement.confirmed",
    ]);
  });

  it("prevents a second acknowledgement, a silent overwrite and removal once acknowledged", async () => {
    const multi = await invoice("INV-MULTI");
    expect((await attach(finance, multi.invoiceId, PNG, "other.png")).status).toBe(409);
    expect((await api().delete(`${BASE}/${multi.invoiceId}/document`).set(finance.headers)).status).toBe(409);
    expect((await confirm(finance, multi.invoiceId, multi.document!.attachmentId)).status).toBe(409);
    expect((await invoice("INV-MULTI")).document!.version).toBe(1);
  });

  it("replaces only with Edit and a reason, keeping the earlier version, date and user", async () => {
    const multi = await invoice("INV-MULTI");
    expect((await replace(administrator, multi.invoiceId, null)).status).toBe(400);
    expect((await replace(administrator, (await invoice("INV-100")).invoiceId, "Wrong scan")).status).toBe(409);

    const response = await replace(administrator, multi.invoiceId, "Clearer scan received from the client", PNG, "stamped copy.png");
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedAt: multi.acknowledgedAt, acknowledgedBy: multi.acknowledgedBy, document: { version: 2, originalName: "stamped copy.png", mimeType: "image/png" } });
    const history = (await api().get(`${BASE}/${multi.invoiceId}/history`).set(viewOnly.headers)).body.data;
    expect(history.map((entry: { version: number; isCurrent: boolean }) => [entry.version, entry.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);
    // The earlier version stays downloadable, from this invoice only.
    const earlier = history[1].attachmentId as string;
    expect((await binary(api().get(`${BASE}/${multi.invoiceId}/documents/${earlier}`).set(viewOnly.headers))).status).toBe(200);
    expect((await api().get(`${BASE}/${(await invoice("INV-100")).invoiceId}/documents/${earlier}`).set(admin.headers)).status).toBe(404);
    const log = (await logsFor("invoice_acknowledgements", multi.acknowledgementId!)).at(-1)!;
    expect(log).toMatchObject({ action: "invoice_acknowledgement.document_replaced", user_id: administrator.id });
    expect(log.metadata).toMatchObject({ reason: "Clearer scan received from the client" });
  });
});

describe("equal numbers are never merged automatically", () => {
  it("flags two invoices of one client with the same number and refuses acknowledgement until reconciled", async () => {
    const dups = (await items()).filter((row) => row.invoiceNo === "INV-DUP");
    expect(dups).toHaveLength(2);
    expect(dups.every((row) => row.reconciliation.includes("SAME_NUMBER"))).toBe(true);
    const refused = await attach(finance, dups[0]!.invoiceId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("same Invoice No.");
    expect((await list(admin, { reconciliation: "NEEDED" })).items.map((row: Item) => row.invoiceNo).sort()).toEqual(["INV-DUP", "INV-DUP", "INV-LEG", "INV-SEP", "INV-SEP"]);
  });

  it("links them as one invoice on an authorised, reasoned request; the services move, nothing else", async () => {
    const [first, second] = (await items()).filter((row) => row.invoiceNo === "INV-DUP");
    const view = (await api().get(`${BASE}/${first!.invoiceId}/reconciliation`).set(administrator.headers)).body.data;
    expect(view.reasons).toEqual(["SAME_NUMBER"]);
    expect(view.sameNumber.map((other: { invoiceId: string }) => other.invoiceId)).toEqual([second!.invoiceId]);

    expect((await api().post(`${BASE}/${first!.invoiceId}/link`).set(administrator.headers).send({ otherInvoiceId: second!.invoiceId })).status).toBe(400);
    const linked = await api().post(`${BASE}/${first!.invoiceId}/link`).set(administrator.headers).send({ otherInvoiceId: second!.invoiceId, reason: "One invoice covers both services" });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ invoiceId: first!.invoiceId, serviceCount: 2, reconciliation: [] });
    // Renewal version and original both listed on the one invoice.
    expect(linked.body.data.contracts.map((contract: { reference: string }) => contract.reference)).toEqual(["STS-AMC-IA1", "STS-AMC-IA1 (V2)"]);
    expect((await items()).filter((row) => row.invoiceNo === "INV-DUP")).toHaveLength(1);
    expect((await api().get(`${BASE}/${second!.invoiceId}`).set(admin.headers)).status).toBe(404);
    expect((await pool.query("SELECT merged_into_id FROM ack_invoices WHERE id = $1", [second!.invoiceId])).rows[0].merged_into_id).toBe(first!.invoiceId);
    expect((await logsFor("ack_invoices", first!.invoiceId)).map((log) => log.action)).toContain("invoice_acknowledgement.invoices_linked");
  });

  it("confirms invoices as separate on request, after which each is acknowledged on its own", async () => {
    const [first, second] = (await items()).filter((row) => row.invoiceNo === "INV-SEP");
    const response = await api().post(`${BASE}/${first!.invoiceId}/separate`).set(admin.headers).send({ reason: "Two invoices were issued with the same number" });
    expect(response.status).toBe(200);
    expect((await items()).filter((row) => row.invoiceNo === "INV-SEP").every((row) => row.reconciliation.length === 0)).toBe(true);
    expect((await attach(finance, second!.invoiceId)).status).toBe(201);
  });

  it("never links invoices of different clients, and the database refuses moving a service across", async () => {
    const a = await invoice("INV-100");
    const bInvoice = await invoice("INV-100", clientB);
    expect((await api().post(`${BASE}/${a.invoiceId}/link`).set(admin.headers).send({ otherInvoiceId: bInvoice.invoiceId, reason: "Wrong attempt" })).status).toBe(409);
    await expect(pool.query("UPDATE ack_invoice_services SET ack_invoice_id = $1 WHERE ack_invoice_id = $2", [a.invoiceId, bInvoice.invoiceId])).rejects.toThrow(/same client and Invoice No./);
    await expect(pool.query("DELETE FROM ack_invoice_services WHERE ack_invoice_id = $1", [a.invoiceId])).rejects.toThrow(/cannot be deleted/);
    await expect(pool.query("DELETE FROM ack_invoices WHERE id = $1", [a.invoiceId])).rejects.toThrow(/cannot be deleted/);
  });
});

describe("acknowledgements recorded per service by the earlier release", () => {
  it("keeps conflicting confirmed acknowledgements, chooses none, and blocks new work", async () => {
    const leg = await invoice("INV-LEG");
    expect(leg).toMatchObject({ status: "PENDING", acknowledgementId: null, serviceCount: 2, reconciliation: ["CONFLICTING_ACKNOWLEDGEMENTS"] });
    const rows = await pool.query("SELECT status, acknowledged_at, acknowledged_by, ack_invoice_id FROM invoice_acknowledgements WHERE amc_visit_id = ANY($1::bigint[]) ORDER BY id", [[r[2], r[3]]]);
    expect(rows.rows.map((row) => [row.status, row.acknowledged_at.toISOString(), row.acknowledged_by, row.ack_invoice_id])).toEqual([
      ["ACKNOWLEDGED", "2026-11-05T09:15:00.000Z", finance.id, leg.invoiceId],
      ["ACKNOWLEDGED", "2026-11-05T09:15:00.000Z", finance.id, leg.invoiceId],
    ]);
    expect((await attach(finance, leg.invoiceId)).status).toBe(409);
    expect((await logsFor("ack_invoices", leg.invoiceId)).map((log) => log.action)).toContain("invoice_acknowledgement.conflict_flagged");
    const history = (await api().get(`${BASE}/${leg.invoiceId}/history`).set(admin.headers)).body.data;
    expect(history.map((entry: { originalName: string }) => entry.originalName).sort()).toEqual(["leg-r3.pdf", "leg-r4.pdf"]);
  });

  it("lets an authorised user choose the current one, with a reason; the other stays as history", async () => {
    const leg = await invoice("INV-LEG");
    const view = (await api().get(`${BASE}/${leg.invoiceId}/reconciliation`).set(administrator.headers)).body.data;
    expect(view.acknowledgements).toHaveLength(2);
    const chosen = view.acknowledgements[1].acknowledgementId as string;

    const response = await api().post(`${BASE}/${leg.invoiceId}/choose`).set(administrator.headers).send({ acknowledgementId: chosen, reason: "r4 copy is the signed original" });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "ACKNOWLEDGED", acknowledgementId: chosen, acknowledgedAt: "2026-11-05T09:15:00.000Z", reconciliation: [], document: { originalName: "leg-r4.pdf" } });
    expect((await api().get(`${BASE}/${leg.invoiceId}/history`).set(admin.headers)).body.data).toHaveLength(2);
    expect((await api().post(`${BASE}/${leg.invoiceId}/choose`).set(administrator.headers).send({ acknowledgementId: chosen, reason: "again" })).status).toBe(409);
  });

  it("adopts a single legacy acknowledgement as the invoice's current one, unchanged", async () => {
    const ack = await legacyAcknowledgement(r[0]!, "INV-200", { document: "legacy-200.pdf", acknowledged: true });
    const renewalInvoice = await invoice("INV-200");
    expect(renewalInvoice).toMatchObject({ status: "ACKNOWLEDGED", acknowledgementId: ack, acknowledgedAt: "2026-11-05T09:15:00.000Z", reconciliation: [] });
    expect((await logsFor("invoice_acknowledgements", ack)).map((log) => log.action)).toEqual(["invoice_acknowledgement.adopted"]);
  });
});

describe("database guards", () => {
  it("keeps one current acknowledgement per invoice and never moves an acknowledgement", async () => {
    const multi = await invoice("INV-MULTI");
    const other = await invoice("INV-100");
    await expect(pool.query("UPDATE ack_invoices SET current_acknowledgement_id = $1 WHERE id = $2", [multi.acknowledgementId, other.invoiceId])).rejects.toThrow(/ack_invoices_current_uq/);
    await expect(pool.query("UPDATE invoice_acknowledgements SET ack_invoice_id = $1 WHERE id = $2", [other.invoiceId, multi.acknowledgementId])).rejects.toThrow(/cannot be moved/);
    await expect(pool.query("UPDATE invoice_acknowledgements SET status = 'PENDING', acknowledged_at = NULL, acknowledged_by = NULL WHERE id = $1", [multi.acknowledgementId])).rejects.toThrow(/cannot be undone/);
    await expect(pool.query("DELETE FROM invoice_acknowledgements WHERE id = $1", [multi.acknowledgementId])).rejects.toThrow(/cannot be deleted/);
  });
});

describe("failures leave nothing behind", () => {
  it("removes the stored file and records nothing when the database save fails", async () => {
    const target = await invoice("INV-100");
    await pool.query(`CREATE FUNCTION ack_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$`);
    await pool.query("CREATE TRIGGER ack_test_fail BEFORE INSERT ON attachments FOR EACH ROW WHEN (NEW.entity_type = 'invoice_acknowledgements') EXECUTE FUNCTION ack_test_fail()");
    const putsBefore = storage.puts.length;
    try {
      const response = await attach(finance, target.invoiceId, PNG, "fails.png");
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain("simulated failure");
    } finally {
      await pool.query("DROP TRIGGER ack_test_fail ON attachments");
      await pool.query("DROP FUNCTION ack_test_fail()");
    }
    const key = storage.puts[putsBefore]!;
    expect(storage.removes).toContain(key);
    await expect(storage.get(key)).rejects.toThrow();
    expect(await invoice("INV-100")).toMatchObject({ acknowledgementId: null, document: null });
  });

  it("stores nothing when storage is down, and does not confirm when the stored file is missing", async () => {
    const target = await invoice("INV-100");
    storage.failPut = true;
    try {
      const response = await attach(finance, target.invoiceId, TEST_PDF, "down.pdf");
      expect(response.status).toBe(503);
    } finally {
      storage.failPut = false;
    }
    const attached = (await attach(finance, target.invoiceId, TEST_PDF, "ok.pdf")).body.data as Item;
    const key = (await pool.query<{ storage_key: string }>("SELECT storage_key FROM attachments WHERE id = $1", [attached.document!.attachmentId])).rows[0]!.storage_key;
    await storage.remove(key);
    const response = await confirm(finance, target.invoiceId, attached.document!.attachmentId);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("FILE_MISSING");
    expect((await invoice("INV-100")).status).toBe("PENDING");
    // Removed before confirmation, then attached again: one document history, never a second acknowledgement.
    expect((await api().delete(`${BASE}/${target.invoiceId}/document`).set(finance.headers)).status).toBe(200);
    const again = (await attach(finance, target.invoiceId, TEST_PDF, "again.pdf")).body.data as Item;
    expect(again).toMatchObject({ acknowledgementId: attached.acknowledgementId, document: { version: 2, originalName: "again.pdf" } });
  });
});

describe("a corrected Invoice No. is a different invoice; history is kept", () => {
  it("starts the new number Pending and finds the earlier invoice again if the number returns", async () => {
    const multi = await invoice("INV-MULTI");
    await setInvoiceNo(v[1]!, "INV-MULTI-B");
    expect(await invoice("INV-MULTI")).toMatchObject({ invoiceId: multi.invoiceId, serviceCount: 1, status: "ACKNOWLEDGED" });
    expect(await invoice("INV-MULTI-B")).toMatchObject({ basis: "SERVICE", status: "PENDING", serviceCount: 1 });
    await setInvoiceNo(v[1]!, "INV-MULTI");
    expect(await invoice("INV-MULTI")).toMatchObject({ invoiceId: multi.invoiceId, serviceCount: 2, status: "ACKNOWLEDGED" });
    expect((await items()).some((row) => row.invoiceNo === "INV-MULTI-B")).toBe(false);
  });
});

describe("filters, sorting, export", () => {
  it("filters by status, invoice number, client, search and dates", async () => {
    const numbers = async (query: Record<string, unknown>) => (await items(admin, query)).map((row) => row.invoiceNo).sort();
    const today = businessDateOf();

    expect(await numbers({ status: "ACKNOWLEDGED", clientId: clientA })).toEqual(["INV-200", "INV-LEG", "INV-MULTI"]);
    expect(await numbers({ invoiceNo: "MULTI" })).toEqual(["INV-MULTI"]);
    expect(await numbers({ clientId: clientB })).toEqual(["INV-100", "INV-SEP", "INV-SEP"]);
    expect(await numbers({ search: "(V2)" })).toEqual(["INV-200", "INV-DUP", "INV-LEG"]);
    expect(await numbers({ search: "stamped copy" })).toEqual(["INV-MULTI"]);
    expect(await numbers({ dateBasis: "ACKNOWLEDGED_DATE", fromDate: today, toDate: today })).toEqual(["INV-MULTI"]);
    expect(await numbers({ dateBasis: "INVOICE_DATE", fromDate: "2026-09-01", toDate: "2026-09-30" })).toEqual(["INV-MULTI"]);
    expect((await items(admin, { clientId: clientA, sort: "invoiceNo", dir: "desc" })).map((row) => row.invoiceNo)).toEqual(["INV-MULTI", "INV-LEG", "INV-DUP", "INV-200", "INV-100"]);
    expect((await api().get(BASE).query({ fromDate: "2026-05-01", toDate: "2026-04-01" }).set(admin.headers)).status).toBe(400);
    expect((await api().get(BASE).query({ status: "PAID" }).set(admin.headers)).status).toBe(400);
  });

  it("offers clients and contract periods with invoices", async () => {
    const options = (await api().get(`${BASE}/options`).set(viewOnly.headers)).body.data;
    expect(options.clients.map((client: { name: string }) => client.name)).toEqual(["Acknowledgement Client", "Other Client"]);
    expect(options.contracts.map((contract: { reference: string }) => contract.reference)).toEqual(["STS-AMC-IA1", "STS-AMC-IA1 (V2)", "STS-AMC-OTHER"]);
  });

  const workbook = async (session: Session, query: Record<string, unknown>) => {
    const response = await binary(api().get(`${BASE}/export`).query({ format: "xlsx", ...query }).set(session.headers));
    expect(response.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const sheet = book.worksheets[0]!;
    return { headers: (sheet.getRow(HEADER_ROW).values as unknown[]).filter(Boolean), sheet };
  };

  it("exports one row per invoice, amounts only for Accounts viewers, and logs it", async () => {
    const full = await workbook(finance, { clientId: clientA, hidden: "document", sort: "invoiceNo" });
    expect(full.headers).toEqual(expect.arrayContaining(["Invoice No.", "AMC Contract / Version", "Invoice Value (Ex VAT, OMR)", "Linked Services", "Acknowledgement Status"]));
    expect(full.headers).not.toContain("Document");
    expect(full.sheet.getRow(HEADER_ROW + 5).values).toEqual(expect.arrayContaining(["INV-MULTI", 2]));

    const noAmounts = await workbook(exporterNoAmounts, {});
    expect(noAmounts.headers).not.toContain("Invoice Value (Ex VAT, OMR)");
    expect(noAmounts.headers).not.toContain("Service Value (Ex VAT, OMR)");

    const logs = await pool.query("SELECT user_id, metadata FROM activity_logs WHERE action = 'invoice_acknowledgements.exported' ORDER BY id");
    expect(logs.rows.map((row) => [row.user_id, row.metadata.amountsIncluded])).toEqual([
      [finance.id, true],
      [exporterNoAmounts.id, false],
    ]);
    expect((await api().get(`${BASE}/export`).query({ format: "pdf" }).set(administrator.headers)).status).toBe(200);
  });
});
