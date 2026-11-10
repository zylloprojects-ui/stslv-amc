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

// Invoice Acknowledgements (migrations 0112, 0113). Synthetic records in the stslv_test schema only; documents go to a
// throwaway folder of this file (a spy around the local disk storage, so stores and removals can be checked).

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

let admin: Session; // Super Admin (0113 grants every action)
let execution: Session;
let viewOnly: Session; // VIEW only, no Accounts: no amounts, no actions
let acknowledger: Session; // VIEW + CREATE + Accounts VIEW
let editor: Session; // VIEW + CREATE + EDIT + EXPORT + Accounts VIEW
let exporterNoAmounts: Session; // VIEW + EXPORT, no Accounts
let finance: Session; // Finance Executive: Accounts, but no Invoice Acknowledgements (not granted by 0113)

let client: string;
let original: string;
let renewal: string;
let v1: string; // original period, service 1: INV-100, Zoho invoice INV-100 dated 2026-03-15
let v2: string; // original period, service 2: completed, no Invoice No. (never listed)
let r1: string; // renewal (V2) period, service 1: INV-200, only a cancelled Zoho invoice

async function customRole(code: string, permissions: [string, string][]) {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [code]);
  await grant(code, permissions);
}

const list = (session: Session, query: Record<string, unknown> = {}) => api().get(BASE).query({ clientId: client, ...query }).set(session.headers);
const item = async (visitId: string, session: Session = admin) => (await api().get(`${BASE}/${visitId}`).set(session.headers)).body.data;
const attach = (session: Session, visitId: string, data: Buffer = TEST_PDF, name = "acknowledgement.pdf") =>
  api().post(`${BASE}/${visitId}/document`).set(session.headers).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name)).send(data);
const confirm = (session: Session, visitId: string, attachmentId: string) => api().post(`${BASE}/${visitId}/confirm`).set(session.headers).send({ attachmentId });
const replace = (session: Session, visitId: string, reason: string | null, data: Buffer = TEST_PDF, name = "acknowledgement-v2.pdf") => {
  const request = api().post(`${BASE}/${visitId}/replace`).set(session.headers).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name));
  if (reason !== null) request.set("X-Replace-Reason", encodeURIComponent(reason));
  return request.send(data);
};
const setInvoiceNo = async (visitId: string, invoiceNo: string | null) => {
  const updatedAt = (await api().get(`/api/amc/visits/${visitId}`).set(admin.headers)).body.data.updatedAt;
  const response = await api().patch(`/api/amc/visits/${visitId}/manual-invoice`).set(admin.headers).send({ invoiceNo, expectedUpdatedAt: updatedAt });
  expect(response.status).toBe(200);
};
const complete = async (visitId: string) => {
  await withServiceReport(visitId);
  const row = (await api().get(`/api/amc/service-status/${visitId}`).set(admin.headers)).body.data;
  expect((await api().patch(`/api/amc/service-status/${visitId}`).set(execution.headers).send({ status: "COMPLETED", expectedUpdatedAt: row.updatedAt })).status).toBe(200);
};
const visitSnapshot = (id: string) =>
  pool.query("SELECT manual_invoice_no, manual_invoice_at, visit_amount, status, completed_date, updated_at FROM amc_visits_all WHERE id = $1", [id]).then((r) => r.rows[0]);

beforeAll(async () => {
  setStorageForTests(storage);
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
  await customRole("IA_VIEW", [["INVOICE_ACKNOWLEDGEMENTS", "VIEW"]]);
  await customRole("IA_ACK", [
    ["INVOICE_ACKNOWLEDGEMENTS", "VIEW"],
    ["INVOICE_ACKNOWLEDGEMENTS", "CREATE"],
    ["ACCOUNTS", "VIEW"],
  ]);
  await customRole("IA_EDIT", [
    ["INVOICE_ACKNOWLEDGEMENTS", "VIEW"],
    ["INVOICE_ACKNOWLEDGEMENTS", "CREATE"],
    ["INVOICE_ACKNOWLEDGEMENTS", "EDIT"],
    ["INVOICE_ACKNOWLEDGEMENTS", "EXPORT"],
    ["ACCOUNTS", "VIEW"],
  ]);
  await customRole("IA_EXPORT", [
    ["INVOICE_ACKNOWLEDGEMENTS", "VIEW"],
    ["INVOICE_ACKNOWLEDGEMENTS", "EXPORT"],
  ]);
  viewOnly = await signedIn("view@example.com", ["IA_VIEW"]);
  acknowledger = await signedIn("ack@example.com", ["IA_ACK"]);
  editor = await signedIn("editor@example.com", ["IA_EDIT"]);
  exporterNoAmounts = await signedIn("export@example.com", ["IA_EXPORT"]);

  client = await createClient(admin, "Acknowledgement Client");
  const engineer = await renewalEngineer();
  original = await activeContract(admin, client, {
    amcReference: "STS-AMC-IA1",
    systemDescription: "ACK SYSTEM",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    contractValue: "1200.000",
    defaultVisitAmount: "300.000",
  });
  const renewed = await api()
    .post(`/api/amc/contracts/${original}/renewals`)
    .set(admin.headers)
    .send(withRenewalDocument(contractBody(client, { systemDescription: "ACK SYSTEM", validFrom: "2027-01-01", validTo: "2027-12-31", status: "DRAFT", salesEngineerId: engineer, contractValue: "1600.000", defaultVisitAmount: "400.000" })));
  expect(renewed.status).toBe(201);
  renewal = renewed.body.data.id;
  expect((await api().post(`/api/amc/contracts/${renewal}/status`).set(admin.headers).send({ status: "ACTIVE" })).status).toBe(200);

  [v1, v2] = (await visitsOf(original)).map((visit) => visit.id) as [string, string];
  r1 = (await visitsOf(renewal))[0]!.id;
  for (const id of [v1, v2, r1]) await complete(id);

  await setInvoiceNo(v1, "INV-100");
  await setInvoiceNo(r1, "INV-200");
  await newInvoice(admin, invoiceBody(client, [{ amcVisitId: v1, amount: "300.000" }], { invoiceNumber: "INV-100", amountExclVat: "300.000", vatAmount: "0.000", invoiceDate: "2026-03-15" }));
  const cancelled = await newInvoice(admin, invoiceBody(client, [{ amcVisitId: r1, amount: "400.000" }], { invoiceNumber: "INV-200", amountExclVat: "400.000", vatAmount: "0.000", invoiceDate: "2027-03-15" }));
  expect((await cancelInvoice(admin, cancelled.id)).status).toBe(200);
});

afterAll(async () => {
  setStorageForTests(null);
  rmSync(folder, { recursive: true, force: true });
  await closePool();
});

describe("linkage to the invoices Accounts shows", () => {
  it("lists exactly the services with an Invoice No., each Pending, on the right contract period", async () => {
    const response = await list(admin, { sort: "invoiceNo" });

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.items.map((row: { visitId: string }) => row.visitId)).toEqual([v1, r1]);
    expect(data.kpis).toMatchObject({ total: 2, pending: 2, acknowledged: 0, awaitingConfirmation: 0 });
    expect(data.items[0]).toMatchObject({
      reference: "STS-AMC-IA1",
      contract: { id: original, version: 1 },
      client: { id: client, name: "Acknowledgement Client" },
      invoiceNo: "INV-100",
      invoiceDate: "2026-03-15",
      status: "PENDING",
      document: null,
      acknowledgedAt: null,
    });
    expect(data.items[1]).toMatchObject({ reference: "STS-AMC-IA1 (V2)", contract: { id: renewal, version: 2 }, invoiceNo: "INV-200", invoiceDate: null, invoiceValue: null });
  });

  it("shows the same invoice numbers, values and links as Accounts, without invented dates or amounts", async () => {
    const acks = (await list(admin)).body.data.items as { visitId: string; invoiceNo: string; serviceValue: string | null; invoiceValue: string | null; reference: string }[];
    const accounts = (await api().get("/api/accounts").query({ clientId: client, invoiceStatus: "RECORDED" }).set(admin.headers)).body.data.items as {
      id: string;
      manualInvoiceNo: string;
      visitValue: string | null;
      invoiceValue: string | null;
      reference: string;
    }[];

    expect(acks).toHaveLength(accounts.length);
    for (const row of acks) {
      const match = accounts.find((account) => account.id === row.visitId);
      expect(match).toBeDefined();
      expect([row.invoiceNo, row.serviceValue, row.invoiceValue, row.reference]).toEqual([match!.manualInvoiceNo, match!.visitValue, match!.invoiceValue, match!.reference]);
    }
    // The cancelled Zoho invoice adds nothing; the only active one is 300.000.
    expect((await list(admin)).body.data.kpis).toMatchObject({ serviceValueTotal: "700.000", invoiceValueTotal: "300.000" });
  });

  it("never lists a service without an Invoice No., and refuses actions on it", async () => {
    expect((await list(admin)).body.data.items.map((row: { visitId: string }) => row.visitId)).not.toContain(v2);
    expect((await api().get(`${BASE}/${v2}`).set(admin.headers)).status).toBe(404);
    const refused = await attach(admin, v2);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("no Invoice No.");
    expect((await api().get(`${BASE}/999999`).set(admin.headers)).status).toBe(404);
  });
});

describe("permissions and financial visibility", () => {
  it("hides amounts from a role that cannot view Accounts", async () => {
    const data = (await list(viewOnly, { sort: "invoiceNo" })).body.data;

    expect(data.items[0]).toMatchObject({ amountsVisible: false, serviceValue: null, invoiceValue: null, invoiceNo: "INV-100" });
    expect(data.kpis).toMatchObject({ serviceValueTotal: null, invoiceValueTotal: null });
    expect((await list(acknowledger, { sort: "invoiceNo" })).body.data.items[0]).toMatchObject({ amountsVisible: true, serviceValue: "300.000", invoiceValue: "300.000" });
  });

  it("refuses every route to a role without the module, though it holds Accounts", async () => {
    const calls = [
      api().get(BASE).set(finance.headers),
      api().get(`${BASE}/options`).set(finance.headers),
      api().get(`${BASE}/export`).query({ format: "xlsx" }).set(finance.headers),
      api().get(`${BASE}/${v1}`).set(finance.headers),
      api().get(`${BASE}/${v1}/history`).set(finance.headers),
      api().get(`${BASE}/${v1}/document`).set(finance.headers),
      attach(finance, v1),
      api().delete(`${BASE}/${v1}/document`).set(finance.headers),
      confirm(finance, v1, "1"),
      replace(finance, v1, "Because"),
    ];

    for (const response of await Promise.all(calls)) expect(response.status).toBe(403);
    expect((await api().get(BASE)).status).toBe(401);
  });

  it("lets View only look: no attach, confirm, replace or export", async () => {
    expect((await attach(viewOnly, v1)).status).toBe(403);
    expect((await confirm(viewOnly, v1, "1")).status).toBe(403);
    expect((await replace(viewOnly, v1, "Because")).status).toBe(403);
    expect((await api().get(`${BASE}/export`).query({ format: "xlsx" }).set(viewOnly.headers)).status).toBe(403);
    expect((await replace(acknowledger, v1, "Because")).status).toBe(403);
  });
});

describe("attach, confirm, view", () => {
  it("refuses an invalid, empty or wrongly named file and stores nothing", async () => {
    const before = storage.puts.length;
    const cases = [
      await attach(acknowledger, v1, Buffer.from("plain text, not a document"), "ack.pdf"),
      await attach(acknowledger, v1, Buffer.alloc(0), "ack.pdf"),
      await attach(acknowledger, v1, TEST_PDF, "ack.png"),
      await attach(acknowledger, v1, Buffer.from("PK\u0003\u0004[Content_Types].xml word/document.xml", "latin1"), "ack.docx"),
    ];

    for (const response of cases) {
      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe("document");
    }
    const noName = await api().post(`${BASE}/${v1}/document`).set(acknowledger.headers).set("Content-Type", "application/octet-stream").send(TEST_PDF);
    expect(noName.status).toBe(400);
    expect(storage.puts.length).toBe(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM invoice_acknowledgements")).rows[0].n).toBe(0);
  });

  it("refuses a file over the size limit", async () => {
    const big = Buffer.concat([TEST_PDF, Buffer.alloc(12 * 1024 * 1024)]);
    const response = await attach(acknowledger, v1, big, "big.pdf");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("at most 12 MB");
  });

  it("cannot confirm before a document is attached, and has no document to view", async () => {
    const response = await confirm(acknowledger, v1, "1");
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("Attach the acknowledgement document");
    expect((await api().get(`${BASE}/${v1}/document`).set(acknowledger.headers)).status).toBe(404);
  });

  it("attaches the document to private storage and keeps the status Pending until confirmed", async () => {
    const before = await visitSnapshot(v1);
    const response = await attach(acknowledger, v1, TEST_PDF, "Client stamp INV-100.pdf");

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: "PENDING", document: { originalName: "Client stamp INV-100.pdf", version: 1, mimeType: "application/pdf", uploadedBy: { id: acknowledger.id } } });
    // No storage key, checksum or link ever reaches the client.
    expect(JSON.stringify(response.body)).not.toMatch(/storage_?key|sha256|https?:\/\//i);
    expect((await list(admin, { status: "PENDING" })).body.data.kpis).toMatchObject({ pending: 2, awaitingConfirmation: 1 });

    const file = await api().get(`${BASE}/${v1}/document`).set(viewOnly.headers).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body as Buffer, TEST_PDF)).toBe(0);
    expect(file.headers["cache-control"]).toBe("no-store");
    expect(file.headers["content-disposition"]).toContain("attachment;");

    expect(await visitSnapshot(v1)).toEqual(before);
    const logs = await logsFor("invoice_acknowledgements", response.body.data.acknowledgementId);
    expect(logs.map((log) => log.action)).toEqual(["invoice_acknowledgement.document_uploaded"]);
  });

  it("confirms only the document the user saw", async () => {
    const response = await confirm(acknowledger, v1, "999999");
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("changed");
    expect((await item(v1)).status).toBe("PENDING");
  });

  it("OK / Confirm marks the invoice Acknowledged, with date and user, and changes nothing else", async () => {
    const before = await visitSnapshot(v1);
    const invoicesBefore = (await pool.query("SELECT * FROM invoices ORDER BY id")).rows;
    const attached = await item(v1);
    const response = await confirm(acknowledger, v1, attached.document.attachmentId);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedBy: { id: acknowledger.id }, document: { attachmentId: attached.document.attachmentId } });
    expect(businessDateOf(new Date(response.body.data.acknowledgedAt))).toBe(businessDateOf());
    // Refresh and another user's session see the same state.
    expect(await item(v1, viewOnly)).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedBy: { id: acknowledger.id } });
    expect(await visitSnapshot(v1)).toEqual(before);
    expect((await pool.query("SELECT * FROM invoices ORDER BY id")).rows).toEqual(invoicesBefore);
    // Accounts still shows the same Paid reference status and values.
    const accountsRow = (await api().get("/api/accounts").query({ clientId: client }).set(admin.headers)).body.data.items.find((row: { id: string }) => row.id === v1);
    expect(accountsRow).toMatchObject({ manualInvoiceNo: "INV-100", paymentStatus: "PAID", visitValue: "300.000", invoiceValue: "300.000" });
    expect((await logsFor("invoice_acknowledgements", attached.acknowledgementId)).map((log) => log.action)).toEqual([
      "invoice_acknowledgement.document_uploaded",
      "invoice_acknowledgement.confirmed",
    ]);
  });

  it("prevents a second acknowledgement, a second confirmation and a silent overwrite", async () => {
    const attached = await item(v1);
    expect((await confirm(acknowledger, v1, attached.document.attachmentId)).status).toBe(409);
    const overwrite = await attach(acknowledger, v1, PNG, "other.png");
    expect(overwrite.status).toBe(409);
    expect(overwrite.body.error.message).toContain("already acknowledged");
    expect((await api().delete(`${BASE}/${v1}/document`).set(acknowledger.headers)).status).toBe(409);
    expect((await pool.query("SELECT count(*)::int AS n FROM invoice_acknowledgements WHERE amc_visit_id = $1", [v1])).rows[0].n).toBe(1);
    expect((await item(v1)).document.version).toBe(1);
  });
});

describe("database guards", () => {
  it("refuses a duplicate record, an un-acknowledge, a re-date, a deletion and a confirmation without a document", async () => {
    const ackId = (await item(v1)).acknowledgementId as string;
    const user = admin.id;

    await expect(pool.query("INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, created_by) VALUES ($1, 'INV-100', $2)", [v1, user])).rejects.toThrow(/invoice_acknowledgements_invoice_uq/);
    await expect(pool.query("UPDATE invoice_acknowledgements SET status = 'PENDING', acknowledged_at = NULL, acknowledged_by = NULL WHERE id = $1", [ackId])).rejects.toThrow(/cannot be undone/);
    await expect(pool.query("UPDATE invoice_acknowledgements SET acknowledged_at = now() - interval '1 day' WHERE id = $1", [ackId])).rejects.toThrow(/cannot be undone or re-dated/);
    await expect(pool.query("UPDATE invoice_acknowledgements SET invoice_number = 'X' WHERE id = $1", [ackId])).rejects.toThrow(/cannot change/);
    await expect(pool.query("DELETE FROM invoice_acknowledgements WHERE id = $1", [ackId])).rejects.toThrow(/cannot be deleted/);
    await expect(
      pool.query("INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, status, acknowledged_at, acknowledged_by, created_by) VALUES ($1, 'NEW', 'ACKNOWLEDGED', now(), $2, $2)", [r1, user])
    ).rejects.toThrow(/starts Pending/);

    const bare = (await pool.query<{ id: string }>("INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, created_by) VALUES ($1, 'BARE-1', $2) RETURNING id", [r1, user])).rows[0]!.id;
    await expect(pool.query("UPDATE invoice_acknowledgements SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1", [bare, user])).rejects.toThrow(/no document/);
    await pool.query("DELETE FROM invoice_acknowledgements WHERE id = $1", [bare]);
    // A second current document for one acknowledgement is refused by the partial unique index.
    await expect(
      pool.query(
        `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ('invoice_acknowledgements', $1, 'INVOICE_ACKNOWLEDGEMENT', 'x', 'x.pdf', 'application/pdf', 1, repeat('0', 64), gen_random_uuid()::text, $2)`,
        [ackId, user]
      )
    ).rejects.toThrow(/attachments_invoice_ack_uq/);
  });
});

describe("replacement, removal before confirmation, failures", () => {
  it("replaces an acknowledged document only with Edit and a reason, keeping the earlier version", async () => {
    const before = await item(v1);
    expect((await replace(editor, v1, null)).status).toBe(400);
    expect((await replace(editor, v1, "x")).status).toBe(400);
    expect((await replace(editor, r1, "Wrong scan")).status).toBe(409); // INV-200 is not acknowledged

    const response = await replace(editor, v1, "Clearer scan received from the client", PNG, "stamped copy.png");
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      status: "ACKNOWLEDGED",
      acknowledgedAt: before.acknowledgedAt,
      acknowledgedBy: before.acknowledgedBy,
      document: { version: 2, originalName: "stamped copy.png", mimeType: "image/png", uploadedBy: { id: editor.id } },
    });
    const history = (await api().get(`${BASE}/${v1}/history`).set(viewOnly.headers)).body.data;
    expect(history.map((entry: { version: number; isCurrent: boolean; invoiceNumber: string }) => [entry.version, entry.isCurrent, entry.invoiceNumber])).toEqual([
      [2, true, "INV-100"],
      [1, false, "INV-100"],
    ]);
    const log = (await logsFor("invoice_acknowledgements", before.acknowledgementId)).at(-1)!;
    expect(log).toMatchObject({ action: "invoice_acknowledgement.document_replaced", user_id: editor.id });
    expect(log.metadata).toMatchObject({ reason: "Clearer scan received from the client", previousAttachmentId: before.document.attachmentId });
  });

  it("removes an attached document before confirmation (kept as history) and attaches another", async () => {
    const first = await attach(acknowledger, r1, TEST_PDF, "first.pdf");
    expect(first.status).toBe(201);
    const removed = await api().delete(`${BASE}/${r1}/document`).set(acknowledger.headers);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toMatchObject({ status: "PENDING", document: null });
    expect((await api().delete(`${BASE}/${r1}/document`).set(acknowledger.headers)).status).toBe(404);

    const second = await attach(acknowledger, r1, PNG, "second.png");
    expect(second.body.data.document).toMatchObject({ version: 2, originalName: "second.png" });
    const third = await attach(acknowledger, r1, TEST_PDF, "third.pdf");
    expect(third.body.data.document).toMatchObject({ version: 3, originalName: "third.pdf" });
    expect(third.body.data.status).toBe("PENDING");
    const history = (await api().get(`${BASE}/${r1}/history`).set(admin.headers)).body.data;
    expect(history.map((entry: { originalName: string; isCurrent: boolean }) => [entry.originalName, entry.isCurrent])).toEqual([
      ["third.pdf", true],
      ["second.png", false],
      ["first.pdf", false],
    ]);
  });

  it("does not acknowledge when the stored file is missing", async () => {
    const attached = await item(r1);
    const key = (await pool.query<{ storage_key: string }>("SELECT storage_key FROM attachments WHERE id = $1", [attached.document.attachmentId])).rows[0]!.storage_key;
    await storage.remove(key);

    const response = await confirm(acknowledger, r1, attached.document.attachmentId);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("FILE_MISSING");
    expect((await item(r1)).status).toBe("PENDING");
  });

  it("stores nothing when storage is down", async () => {
    storage.failPut = true;
    try {
      const response = await attach(acknowledger, r1, TEST_PDF, "down.pdf");
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("STORAGE_ERROR");
    } finally {
      storage.failPut = false;
    }
    expect((await item(r1)).document.originalName).toBe("third.pdf");
  });

  it("rolls back and removes the stored file when the database save fails", async () => {
    await pool.query(`CREATE FUNCTION ack_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$`);
    await pool.query("CREATE TRIGGER ack_test_fail BEFORE INSERT ON attachments FOR EACH ROW WHEN (NEW.entity_type = 'invoice_acknowledgements') EXECUTE FUNCTION ack_test_fail()");
    const logsBefore = (await pool.query("SELECT count(*)::int AS n FROM activity_logs")).rows[0].n;
    const putsBefore = storage.puts.length;
    try {
      const response = await attach(acknowledger, r1, PNG, "fails.png");
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain("simulated failure");
    } finally {
      await pool.query("DROP TRIGGER ack_test_fail ON attachments");
      await pool.query("DROP FUNCTION ack_test_fail()");
    }
    const key = storage.puts[putsBefore]!;
    expect(storage.removes).toContain(key);
    await expect(storage.get(key)).rejects.toThrow();
    expect((await item(r1)).document.originalName).toBe("third.pdf");
    expect((await pool.query("SELECT count(*)::int AS n FROM activity_logs")).rows[0].n).toBe(logsBefore);
  });
});

describe("a corrected Invoice No. is a different invoice", () => {
  it("starts the new number Pending, keeps the earlier acknowledgement, and finds it again if the number returns", async () => {
    await setInvoiceNo(v1, "INV-100-B");
    expect(await item(v1)).toMatchObject({ invoiceNo: "INV-100-B", status: "PENDING", document: null, invoiceDate: null });
    expect((await pool.query("SELECT invoice_number, status FROM invoice_acknowledgements WHERE amc_visit_id = $1", [v1])).rows).toEqual([{ invoice_number: "INV-100", status: "ACKNOWLEDGED" }]);

    await setInvoiceNo(v1, null);
    expect((await list(admin)).body.data.items.map((row: { visitId: string }) => row.visitId)).not.toContain(v1);

    await setInvoiceNo(v1, "INV-100");
    expect(await item(v1)).toMatchObject({ invoiceNo: "INV-100", status: "ACKNOWLEDGED", document: { version: 2 } });
  });
});

describe("filters, sorting, export", () => {
  it("filters by status, invoice number, contract, client, search and dates", async () => {
    const ids = async (query: Record<string, unknown>) => (await list(admin, query)).body.data.items.map((row: { visitId: string }) => row.visitId);
    const today = businessDateOf();

    expect(await ids({ status: "ACKNOWLEDGED" })).toEqual([v1]);
    expect(await ids({ status: "PENDING" })).toEqual([r1]);
    expect(await ids({ invoiceNo: "200" })).toEqual([r1]);
    expect(await ids({ contractId: renewal })).toEqual([r1]);
    expect(await ids({ search: "stamped copy" })).toEqual([v1]);
    expect(await ids({ search: "(V2)" })).toEqual([r1]);
    expect(await ids({ dateBasis: "ACKNOWLEDGED_DATE", fromDate: today, toDate: today })).toEqual([v1]);
    expect(await ids({ dateBasis: "INVOICE_DATE", fromDate: "2026-03-01", toDate: "2026-03-31" })).toEqual([v1]);
    expect(await ids({ dateBasis: "INVOICE_DATE", fromDate: "2027-01-01" })).toEqual([]);
    expect(await ids({ sort: "invoiceNo", dir: "desc" })).toEqual([r1, v1]);
    // Default order: the work first (Pending).
    expect(await ids({})).toEqual([r1, v1]);
    expect((await list(admin, { fromDate: "2026-05-01", toDate: "2026-04-01" })).status).toBe(400);
    expect((await list(admin, { fromDate: "2026-02-30" })).status).toBe(400);
    expect((await list(admin, { status: "PAID" })).status).toBe(400);
  });

  it("offers the clients and contract periods with invoices", async () => {
    const options = (await api().get(`${BASE}/options`).set(viewOnly.headers)).body.data;
    expect(options.clients).toEqual([{ id: client, name: "Acknowledgement Client" }]);
    expect(options.contracts.map((contract: { reference: string }) => contract.reference)).toEqual(["STS-AMC-IA1", "STS-AMC-IA1 (V2)"]);
    expect(options.limits).toEqual({ maxMb: 12, types: "PDF, PNG and JPEG" });
  });

  const workbook = async (session: Session, query: Record<string, unknown>) => {
    const response = await api()
      .get(`${BASE}/export`)
      .query({ clientId: client, format: "xlsx", ...query })
      .set(session.headers)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
    expect(response.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const sheet = book.worksheets[0]!;
    return { headers: (sheet.getRow(HEADER_ROW).values as unknown[]).filter(Boolean), sheet };
  };

  it("exports the page's columns, with amounts only for a role that may view Accounts, and logs it", async () => {
    const full = await workbook(editor, { hidden: "document" });
    expect(full.headers).toEqual(expect.arrayContaining(["AMC Contract", "Invoice No.", "Service Value (Ex VAT, OMR)", "Zoho Invoice Value (Ex VAT, OMR)", "Acknowledgement Status"]));
    expect(full.headers).not.toContain("Document");
    expect(full.sheet.getRow(HEADER_ROW + 1).values).toEqual(expect.arrayContaining(["STS-AMC-IA1 (V2)", "INV-200"]));

    const noAmounts = await workbook(exporterNoAmounts, {});
    expect(noAmounts.headers).not.toContain("Service Value (Ex VAT, OMR)");
    expect(noAmounts.headers).not.toContain("Zoho Invoice Value (Ex VAT, OMR)");
    expect(noAmounts.headers).toContain("Document");

    const logs = await pool.query("SELECT user_id, metadata FROM activity_logs WHERE action = 'invoice_acknowledgements.exported' ORDER BY id");
    expect(logs.rows.map((row) => [row.user_id, row.metadata.amountsIncluded])).toEqual([
      [editor.id, true],
      [exporterNoAmounts.id, false],
    ]);
    expect((await api().get(`${BASE}/export`).query({ format: "xlsx", hidden: "nonsense" }).set(editor.headers)).status).toBe(400);
  });

  it("exports a PDF", async () => {
    const response = await api().get(`${BASE}/export`).query({ format: "pdf" }).set(admin.headers);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
  });
});

describe("permission catalog and starting grants", () => {
  it("gives the new module to Super Admin only (0113)", async () => {
    const holders = await pool.query("SELECT DISTINCT r.code FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE p.module = 'INVOICE_ACKNOWLEDGEMENTS' AND r.code NOT LIKE 'IA\\_%' ORDER BY r.code");
    expect(holders.rows.map((row) => row.code)).toEqual(["ADMIN"]);
    // Roles & Permissions offers it (the catalog travels with the role list).
    const offered = await api().get("/api/roles").set(admin.headers);
    expect(offered.status).toBe(200);
    expect(JSON.stringify(offered.body.data)).toContain("INVOICE_ACKNOWLEDGEMENTS");
  });
});
