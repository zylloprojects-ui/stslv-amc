import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, contractBody, createClient, grant, logsFor, newContractBody, renewalEngineer, visitsOf, withRenewalDocument } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Manual AMC Reference Number (migration 0105): typed when a contract or renewal is created, never generated,
// unique without regard to case (cancelled and Recycle Bin contracts included), and editable afterwards (2026-11-04).
// Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;
let admin: Session;
let clientId: string;

const DUPLICATE = "AMC Reference Number already exists. Please enter a different number.";
const RETIRED = "AMC Reference Number was used before by another contract and cannot be reused. Please enter a different number.";

beforeAll(async () => {
  await resetData();
  admin = await signedIn("reference-admin@example.com", ["ADMIN"]);
  clientId = await createClient(admin, "Reference Test Hotel");
});
afterAll(closePool);

// A new contract also carries its sales engineer, system type, Final Credit and contract document (0103).
const create = async (amcReference: unknown, overrides: Record<string, unknown> = {}) =>
  api().post("/api/amc/contracts").set(admin.headers).send(await newContractBody(clientId, { amcReference, ...overrides }));
const get = (id: string) => api().get(`/api/amc/contracts/${id}`).set(admin.headers);

describe("creating a contract with a manual AMC Reference Number", () => {
  it("saves the reference as typed, trimmed, with its case kept", async () => {
    const response = await create("  STSLV-AMC-2026-015  ");

    expect(response.status).toBe(201);
    expect(response.body.data.amcReference).toBe("STSLV-AMC-2026-015");
    expect((await get(response.body.data.id)).body.data.amcReference).toBe("STSLV-AMC-2026-015");

    const stored = await pool.query("SELECT amc_reference FROM amc_contracts WHERE id = $1", [response.body.data.id]);
    expect(stored.rows[0]).toEqual({ amc_reference: "STSLV-AMC-2026-015" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["a number instead of text", 15],
    ["characters outside the convention", "AMC#001"],
    ["a leading symbol", "-AMC-001"],
    ["longer than 50 characters", `AMC-${"9".repeat(47)}`],
  ])("rejects a reference that is %s", async (_label, value) => {
    const response = await create(value);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe("amcReference");
  });

  it("accepts the documented examples", async () => {
    for (const reference of ["AMC-0901", "AMC-2026-001", "STSLV-AMC-2026-016", "AMC 2026/17 & B.1"]) {
      expect((await create(reference)).status, reference).toBe(201);
    }
  });

  it("rejects a duplicate, without regard to case, with the agreed message", async () => {
    expect((await create("DUP-REF-001")).status).toBe(201);

    for (const again of ["DUP-REF-001", "dup-ref-001", "  Dup-Ref-001 "]) {
      const response = await create(again);

      expect(response.status, again).toBe(409);
      expect(response.body.error).toMatchObject({ code: "CONFLICT", message: DUPLICATE, details: [{ field: "amcReference", message: DUPLICATE }] });
    }
  });

  it("never lets a cancelled contract's reference be reused", async () => {
    const id = (await create("CANCELLED-REF-001")).body.data.id as string;
    const cancel = await api().post(`/api/amc/contracts/${id}/status`).set(admin.headers).send({ status: "CANCELLED", reason: "Test" });
    expect(cancel.status).toBe(200);

    const response = await create("CANCELLED-REF-001");
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe(DUPLICATE);
  });

  it("never lets a Recycle Bin contract's reference be reused, and restores it unchanged", async () => {
    const id = (await create("BIN-REF-001")).body.data.id as string;
    expect((await api().delete(`/api/amc/contracts/${id}`).set(admin.headers)).status).toBe(200);
    expect((await get(id)).status).toBe(404);

    const bin = await api().get("/api/security/recycle-bin/amc-contracts").set(admin.headers);
    expect(bin.body.data.find((row: { id: string }) => row.id === id)).toMatchObject({ amcReference: "BIN-REF-001" });

    const reuse = await create("bin-ref-001");
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.message).toBe(DUPLICATE);

    expect((await api().post(`/api/security/recycle-bin/amc-contracts/${id}/restore`).set(admin.headers)).status).toBe(200);
    expect((await get(id)).body.data.amcReference).toBe("BIN-REF-001");
  });

  it("lets only one of two simultaneous requests with the same reference succeed", async () => {
    const responses = await Promise.all([1, 2, 3].map(() => create("RACE-REF-001")));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    const stored = await pool.query("SELECT count(*)::int AS count FROM amc_contracts_all WHERE lower(amc_reference) = 'race-ref-001'");
    expect(stored.rows[0]).toEqual({ count: 1 });
  });

  it("is enforced by the database as well (required, trimmed, allowed characters, unique)", async () => {
    const insert = (reference: string | null) =>
      pool.query(
        `INSERT INTO amc_contracts (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, amc_reference)
         VALUES ($1, '2027-01-01', '2027-12-31', 'FIRE', 100, 'QUARTERLY', $2)`,
        [clientId, reference]
      );

    await expect(insert(null)).rejects.toMatchObject({ code: "23502" });
    await expect(insert(" PADDED")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("BAD#REF")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("dup-ref-001")).rejects.toMatchObject({ code: "23505", constraint: "amc_contracts_reference_uq" });
  });
});

// Editing the reference (2026-11-04): AMC Contracts Edit permission, the creation rules, unique over every contract,
// and only the text changes: the id, services, money, renewal links and history stay as they are.
describe("editing the reference", () => {
  const patch = (session: Session, id: string, body: Record<string, unknown>) => api().patch(`/api/amc/contracts/${id}`).set(session.headers).send(body);
  const snapshot = async (id: string) => {
    const contract = await pool.query("SELECT id, client_id, contract_value, final_credit, default_visit_amount, valid_from, valid_to, status FROM amc_contracts WHERE id = $1", [id]);
    const visits = await pool.query("SELECT id, amc_contract_id, scheduled_date, visit_amount, status FROM amc_visits WHERE amc_contract_id = $1 ORDER BY id", [id]);
    return { contract: contract.rows, visits: visits.rows };
  };

  it("changes the reference, keeps the contract's id, services and money, and records old and new in the Audit Log", async () => {
    const id = await activeContract(admin, clientId, { amcReference: "EDIT-OLD-001", validFrom: "2027-01-01", validTo: "2027-12-31" });
    const before = await snapshot(id);
    expect(before.visits.length).toBeGreaterThan(0);

    const response = await patch(admin, id, { amcReference: "  EDIT-NEW-001 " });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id, amcReference: "EDIT-NEW-001" });
    expect(response.body.data.scheduleChange).toBeNull();
    expect((await get(id)).body.data.amcReference).toBe("EDIT-NEW-001");
    expect(await snapshot(id)).toEqual(before);

    // Read live everywhere: the schedule shows the new reference; the old one is no longer found.
    const visits = (await api().get(`/api/amc/visits?contractId=${id}`).set(admin.headers)).body.data.items;
    expect(new Set(visits.map((visit: { contract: { reference: string } }) => visit.contract.reference))).toEqual(new Set(["EDIT-NEW-001"]));
    expect((await api().get("/api/amc/contracts?search=EDIT-OLD-001").set(admin.headers)).body.data.total).toBe(0);

    const logs = (await logsFor("amc_contracts", id)).filter((log) => log.action === "amc_contract.updated");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ user_id: admin.id, module: "AMC_CONTRACTS", metadata: { changes: { amcReference: { from: "EDIT-OLD-001", to: "EDIT-NEW-001" } } } });
    const described = await pool.query("SELECT description FROM activity_logs WHERE entity_type = 'amc_contracts' AND entity_id = $1 AND action = 'amc_contract.updated'", [id]);
    expect(described.rows[0].description).toContain("AMC Reference Number changed from EDIT-OLD-001 to EDIT-NEW-001.");
  });

  it("saves the reference together with other fields in one edit", async () => {
    const id = (await create("EDIT-BOTH-001")).body.data.id as string;
    const response = await patch(admin, id, { amcReference: "EDIT-BOTH-002", notes: "Edited with the reference" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ amcReference: "EDIT-BOTH-002", notes: "Edited with the reference" });
    const [log] = (await logsFor("amc_contracts", id)).filter((entry) => entry.action === "amc_contract.updated");
    expect(log?.metadata).toMatchObject({ changes: { amcReference: { from: "EDIT-BOTH-001", to: "EDIT-BOTH-002" }, notes: { to: "Edited with the reference" } } });
  });

  it("keeps the reference when it is left out or sent unchanged, and logs no reference change", async () => {
    const id = (await create("EDIT-SAME-001")).body.data.id as string;

    const leftOut = await patch(admin, id, { notes: "Edited" });
    expect(leftOut.status).toBe(200);
    expect(leftOut.body.data.amcReference).toBe("EDIT-SAME-001");

    const same = await patch(admin, id, { amcReference: "EDIT-SAME-001", notes: "Edited again" });
    expect(same.status).toBe(200);
    expect(same.body.data.amcReference).toBe("EDIT-SAME-001");

    // Only the reference, unchanged: nothing to save, nothing logged.
    const onlySame = await patch(admin, id, { amcReference: " EDIT-SAME-001 " });
    expect(onlySame.status).toBe(200);

    const logs = (await logsFor("amc_contracts", id)).filter((log) => log.action === "amc_contract.updated");
    expect(logs).toHaveLength(2);
    for (const log of logs) expect((log.metadata as { changes: Record<string, unknown> }).changes).not.toHaveProperty("amcReference");
  });

  it("accepts a change of letter case of its own reference", async () => {
    const id = (await create("edit-case-001")).body.data.id as string;
    const response = await patch(admin, id, { amcReference: "EDIT-CASE-001" });

    expect(response.status).toBe(200);
    expect(response.body.data.amcReference).toBe("EDIT-CASE-001");
  });

  it("refuses a reference used by another contract (any case, cancelled and Recycle Bin included) and saves nothing", async () => {
    const id = (await create("EDIT-DUP-MINE")).body.data.id as string;
    expect((await create("EDIT-DUP-TAKEN")).status).toBe(201);
    const cancelled = (await create("EDIT-DUP-CANCELLED")).body.data.id as string;
    expect((await api().post(`/api/amc/contracts/${cancelled}/status`).set(admin.headers).send({ status: "CANCELLED", reason: "Test" })).status).toBe(200);
    const binned = (await create("EDIT-DUP-BIN")).body.data.id as string;
    expect((await api().delete(`/api/amc/contracts/${binned}`).set(admin.headers)).status).toBe(200);

    for (const taken of ["EDIT-DUP-TAKEN", "edit-dup-taken", "EDIT-DUP-CANCELLED", "edit-dup-bin"]) {
      const response = await patch(admin, id, { amcReference: taken, notes: "Must not be saved" });

      expect(response.status, taken).toBe(409);
      expect(response.body.error).toMatchObject({ code: "CONFLICT", message: DUPLICATE, details: [{ field: "amcReference", message: DUPLICATE }] });
    }

    // The whole edit was rolled back.
    const after = (await get(id)).body.data;
    expect(after.amcReference).toBe("EDIT-DUP-MINE");
    expect(after.notes).not.toBe("Must not be saved");
    expect((await logsFor("amc_contracts", id)).filter((log) => log.action === "amc_contract.updated")).toHaveLength(0);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["characters outside the convention", "AMC#001"],
    ["a leading symbol", "-AMC-001"],
    ["longer than 50 characters", `AMC-${"9".repeat(47)}`],
    ["not text", 7],
    ["null", null],
  ])("refuses a reference that is %s", async (_label, value) => {
    const id = (await create(`EDIT-BAD-${String(_label).replace(/[^a-z]/gi, "").slice(0, 20).toUpperCase()}`)).body.data.id as string;
    const response = await patch(admin, id, { amcReference: value });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe("amcReference");
  });

  it("is refused without the AMC Contracts Edit permission, and allowed to a non-admin role that has it", async () => {
    const id = (await create("EDIT-PERM-001")).body.data.id as string;
    const viewer = await signedIn("reference-viewer@example.com", ["VIEWER"]);
    await grant("VIEWER", [["AMC_CONTRACTS", "VIEW"]]);

    const refused = await patch(viewer, id, { amcReference: "EDIT-PERM-002" });
    expect(refused.status).toBe(403);
    expect((await get(id)).body.data.amcReference).toBe("EDIT-PERM-001");

    await grant("AMC_OPERATIONS_EXECUTIVE", [["AMC_CONTRACTS", "VIEW"], ["AMC_CONTRACTS", "EDIT"]]);
    const editor = await signedIn("reference-editor@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
    const allowed = await patch(editor, id, { amcReference: "EDIT-PERM-002" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.amcReference).toBe("EDIT-PERM-002");

    const unauthenticated = await api().patch(`/api/amc/contracts/${id}`).send({ amcReference: "EDIT-PERM-003" });
    expect(unauthenticated.status).toBe(401);
  });

  it("lets only one of two simultaneous edits take the same new reference", async () => {
    const a = (await create("EDIT-RACE-A")).body.data.id as string;
    const b = (await create("EDIT-RACE-B")).body.data.id as string;
    const responses = await Promise.all([patch(admin, a, { amcReference: "EDIT-RACE-NEW" }), patch(admin, b, { amcReference: "EDIT-RACE-NEW" })]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const stored = await pool.query("SELECT count(*)::int AS count FROM amc_contracts_all WHERE lower(amc_reference) = 'edit-race-new'");
    expect(stored.rows[0]).toEqual({ count: 1 });
  });

  it("never gives a number given up by an edit to another contract, in any case, by any route", async () => {
    const owner = (await create("REUSE-OLD-001")).body.data.id as string;
    expect((await patch(admin, owner, { amcReference: "REUSE-NEW-001" })).status).toBe(200);

    // A new contract, an edit of another contract and a renewal are all refused, without regard to case.
    const created = await create("reuse-old-001");
    expect(created.status).toBe(409);
    expect(created.body.error).toMatchObject({ code: "CONFLICT", message: RETIRED, details: [{ field: "amcReference", message: RETIRED }] });

    const other = (await create("REUSE-OTHER-001")).body.data.id as string;
    const edited = await patch(admin, other, { amcReference: "  Reuse-Old-001 ", notes: "Must not be saved" });
    expect(edited.status).toBe(409);
    expect(edited.body.error.message).toBe(RETIRED);
    expect((await get(other)).body.data).toMatchObject({ amcReference: "REUSE-OTHER-001" });
    expect((await get(other)).body.data.notes).not.toBe("Must not be saved");

    const engineer = await renewalEngineer();
    const sourceId = await activeContract(admin, clientId, { amcReference: "REUSE-SRC-001", validFrom: "2031-01-01", validTo: "2031-12-31" });
    // A renewal keeps its source's number (0111): typing any other number, a retired one included, is refused.
    const renewal = await api()
      .post(`/api/amc/contracts/${sourceId}/renewals`)
      .set(admin.headers)
      .send({ ...withRenewalDocument(contractBody(clientId, { validFrom: "2032-01-01", validTo: "2032-12-31", status: "DRAFT", salesEngineerId: engineer })), amcReference: "REUSE-OLD-001" });
    expect(renewal.status).toBe(400);
    expect(renewal.body.error.details[0]).toMatchObject({ field: "amcReference" });
    expect((await pool.query("SELECT count(*)::int AS count FROM amc_contracts_all WHERE lower(amc_reference) = 'reuse-old-001'")).rows[0]).toEqual({ count: 0 });

    // The current number of a contract still answers with the "already exists" message.
    expect((await create("REUSE-NEW-001")).body.error.message).toBe(DUPLICATE);
  });

  it("lets a contract take back a number it held itself, and then keeps the one it gave up", async () => {
    const id = (await create("BACK-A-001")).body.data.id as string;
    expect((await patch(admin, id, { amcReference: "BACK-B-001" })).status).toBe(200);

    const back = await patch(admin, id, { amcReference: "back-a-001" });
    expect(back.status).toBe(200);
    expect(back.body.data.amcReference).toBe("back-a-001");

    expect((await create("BACK-B-001")).body.error.message).toBe(RETIRED);
    expect((await create("BACK-A-001")).body.error.message).toBe(DUPLICATE);
  });

  it("keeps the history of every number in the database, with who changed it", async () => {
    const id = (await create("HIST-001")).body.data.id as string;
    expect((await patch(admin, id, { amcReference: "HIST-002" })).status).toBe(200);
    expect((await patch(admin, id, { amcReference: "Hist-003" })).status).toBe(200);
    expect((await patch(admin, id, { amcReference: "HIST-003" })).status).toBe(200); // letter case only: the same entry

    const rows = await pool.query(
      "SELECT reference_key, reference, assigned_by::text, retired_by::text, retired_at IS NOT NULL AS retired FROM amc_contract_references WHERE amc_contract_id = $1 ORDER BY reference_key",
      [id]
    );
    expect(rows.rows).toEqual([
      { reference_key: "hist-001", reference: "HIST-001", assigned_by: admin.id, retired_by: admin.id, retired: true },
      { reference_key: "hist-002", reference: "HIST-002", assigned_by: admin.id, retired_by: admin.id, retired: true },
      { reference_key: "hist-003", reference: "HIST-003", assigned_by: admin.id, retired_by: null, retired: false },
    ]);
  });

  it("is enforced by the database for any writer, not only the API", async () => {
    const id = (await create("DBH-OLD-001")).body.data.id as string;
    expect((await patch(admin, id, { amcReference: "DBH-NEW-001" })).status).toBe(200);
    const other = (await create("DBH-OTHER-001")).body.data.id as string;

    await expect(pool.query("UPDATE amc_contracts_all SET amc_reference = 'dbh-old-001' WHERE id = $1", [other])).rejects.toMatchObject({
      code: "23505",
      constraint: "amc_contract_references_pk",
    });
    await expect(
      pool.query(
        `INSERT INTO amc_contracts (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, amc_reference)
         VALUES ($1, '2027-01-01', '2027-12-31', 'FIRE', 100, 'QUARTERLY', 'DBH-OLD-001')`,
        [clientId]
      )
    ).rejects.toMatchObject({ code: "23505", constraint: "amc_contract_references_pk" });
  });

  it("keeps exactly one current entry per contract number, held by its original, equal to its reference (Recycle Bin included)", async () => {
    const binned = (await create("INV-BIN-001")).body.data.id as string;
    expect((await api().delete(`/api/amc/contracts/${binned}`).set(admin.headers)).status).toBe(200);

    // 0111: a number is recorded once, for its original (version 1) contract; a renewal version shares it.
    const mismatched = await pool.query(
      `SELECT c.id FROM amc_contracts_all c
       LEFT JOIN amc_contract_references r ON r.amc_contract_id = c.id AND r.retired_at IS NULL
       WHERE c.contract_version = 1 AND r.reference IS DISTINCT FROM c.amc_reference`
    );
    expect(mismatched.rows).toEqual([]);
    const versions = await pool.query(
      `SELECT v.id FROM amc_contracts_all v JOIN amc_contracts_all o ON o.id = v.version_root_id
       WHERE v.contract_version > 1 AND (v.amc_reference <> o.amc_reference
         OR EXISTS (SELECT 1 FROM amc_contract_references r WHERE r.amc_contract_id = v.id))`
    );
    expect(versions.rows).toEqual([]);
    const current = await pool.query("SELECT count(*)::int AS count FROM amc_contract_references WHERE retired_at IS NULL");
    const originals = await pool.query("SELECT count(*)::int AS count FROM amc_contracts_all WHERE contract_version = 1");
    expect(current.rows[0].count).toBe(originals.rows[0].count);
  });

  it("refuses another contract a number being given up at the same moment, whichever request runs first", async () => {
    for (let round = 1; round <= 3; round++) {
      const holder = (await create(`RACE-OLD-${round}`)).body.data.id as string;
      const [edit, take] = await Promise.all([patch(admin, holder, { amcReference: `RACE-MOVED-${round}` }), create(`race-old-${round}`)]);

      expect(edit.status, `round ${round}`).toBe(200);
      expect(take.status, `round ${round}`).toBe(409);
      expect([DUPLICATE, RETIRED]).toContain(take.body.error.message);
      const holders = await pool.query("SELECT count(*)::int AS count FROM amc_contracts_all WHERE lower(amc_reference) = $1", [`race-old-${round}`]);
      expect(holders.rows[0]).toEqual({ count: 0 });
    }
  });

  it("keeps renewal links on the id: both sides show the edited reference", async () => {
    const engineer = await renewalEngineer();
    const sourceId = await activeContract(admin, clientId, { amcReference: "EDIT-RSRC-001", validFrom: "2029-01-01", validTo: "2029-12-31" });
    const renewal = await api()
      .post(`/api/amc/contracts/${sourceId}/renewals`)
      .set(admin.headers)
      .send(withRenewalDocument(contractBody(clientId, { validFrom: "2030-01-01", validTo: "2030-12-31", status: "DRAFT", salesEngineerId: engineer })));
    expect(renewal.status).toBe(201);
    expect(renewal.body.data).toMatchObject({ amcReference: "EDIT-RSRC-001", contractVersion: 2, versionRootId: sourceId });

    // The number belongs to the whole chain (0111): editing it on the original renames every version...
    expect((await patch(admin, sourceId, { amcReference: "EDIT-RSRC-002" })).status).toBe(200);
    expect((await get(renewal.body.data.id)).body.data.amcReference).toBe("EDIT-RSRC-002");
    // ...and editing it on a later version renames the original (and so the chain) the same way.
    expect((await patch(admin, renewal.body.data.id, { amcReference: "EDIT-RNEW-002" })).status).toBe(200);
    expect((await get(sourceId)).body.data.amcReference).toBe("EDIT-RNEW-002");

    const links = (await api().get(`/api/amc/contracts/${renewal.body.data.id}/renewals`).set(admin.headers)).body.data;
    expect(links.renewedFrom).toMatchObject({ id: sourceId, reference: "EDIT-RNEW-002" });
    const history = (await api().get("/api/amc/reports/renewals").set(admin.headers)).body.data.items;
    expect(history.find((item: { renewal: { id: string } }) => item.renewal.id === renewal.body.data.id)).toMatchObject({
      renewal: { reference: "EDIT-RNEW-002 (V2)" },
      source: { id: sourceId, reference: "EDIT-RNEW-002" },
    });
    // Each number the chain gave up stays retired for every other contract.
    expect((await create("EDIT-RSRC-001")).status).toBe(409);
    expect((await create("edit-rsrc-002")).status).toBe(409);
  });
});

describe("renewals", () => {
  it("keep the contract number of the contract they renew, as its next version (0111)", async () => {
    const engineer = await renewalEngineer();
    const sourceId = await activeContract(admin, clientId, { amcReference: "RENEW-SRC-001", validFrom: "2027-01-01", validTo: "2027-12-31" });
    const renew = (overrides: Record<string, unknown>) =>
      api()
        .post(`/api/amc/contracts/${sourceId}/renewals`)
        .set(admin.headers)
        .send(withRenewalDocument({ ...contractBody(clientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId: engineer }), ...overrides }));

    const renewAs = (amcReference: string) =>
      api()
        .post(`/api/amc/contracts/${sourceId}/renewals`)
        .set(admin.headers)
        .send({ ...withRenewalDocument(contractBody(clientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId: engineer })), amcReference });

    // A different number is refused; nothing is created.
    const other = await renewAs("RENEW-NEW-001");
    expect(other.status).toBe(400);
    expect(other.body.error.details[0].field).toBe("amcReference");

    // The same number (any case), or none at all: the renewal is version 2 of RENEW-SRC-001, with its own id.
    const renewed = await renewAs("renew-src-001");
    expect(renewed.status).toBe(201);
    expect(renewed.body.data).toMatchObject({ amcReference: "RENEW-SRC-001", contractVersion: 2, versionRootId: sourceId });
    expect(renewed.body.data.id).not.toBe(sourceId);
    expect((await get(sourceId)).body.data).toMatchObject({ amcReference: "RENEW-SRC-001", contractVersion: 1, versionRootId: sourceId });

    const links = (await api().get(`/api/amc/contracts/${renewed.body.data.id}/renewals`).set(admin.headers)).body.data;
    expect(links.renewedFrom).toMatchObject({ id: sourceId, reference: "RENEW-SRC-001" });
    const history = (await api().get("/api/amc/reports/renewals").set(admin.headers)).body.data.items;
    expect(history.find((item: { renewal: { id: string } }) => item.renewal.id === renewed.body.data.id)).toMatchObject({
      renewal: { reference: "RENEW-SRC-001 (V2)" },
      source: { id: sourceId, reference: "RENEW-SRC-001" },
    });
    // The number still belongs to this chain only.
    expect((await create("RENEW-SRC-001")).status).toBe(409);
  });
});

describe("the saved reference across modules", () => {
  let id: string;
  const REF = "XMOD-Ref-2027/01";

  beforeAll(async () => {
    id = await activeContract(admin, clientId, { amcReference: REF, systemDescription: "XMOD SYSTEM", validFrom: "2027-01-01", validTo: "2027-12-31" });
    // Relationships stay on ids: the visits link to the contract id, not the text.
    const visits = await visitsOf(id);
    expect(visits.length).toBeGreaterThan(0);
    const linked = await pool.query("SELECT count(*)::int AS count FROM amc_visits WHERE amc_contract_id = $1", [id]);
    expect(linked.rows[0]).toEqual({ count: visits.length });
  });

  const list = async (path: string) => {
    const response = await api().get(path).set(admin.headers);
    expect(response.status, path).toBe(200);
    return response.body.data;
  };

  it("shows on the register and Contract 360, and the register searches it", async () => {
    expect((await get(id)).body.data.amcReference).toBe(REF);
    const found = await list(`/api/amc/contracts?search=${encodeURIComponent("xmod-ref")}`);
    expect(found.items.map((item: { id: string }) => item.id)).toEqual([id]);
    expect(found.items[0].amcReference).toBe(REF);
  });

  it("shows on the AMC Schedule, which searches it", async () => {
    const visits = await list(`/api/amc/visits?contractId=${id}`);
    expect(new Set(visits.items.map((visit: { contract: { reference: string } }) => visit.contract.reference))).toEqual(new Set([REF]));
    const searched = await list(`/api/amc/visits?search=${encodeURIComponent("XMOD-REF-2027")}`);
    expect(searched.total).toBe(visits.total);
    const month = (await visitsOf(id))[0]!.scheduled_date.slice(0, 7);
    const monthly = await list(`/api/amc/visits/monthly-consolidated?month=${month}`);
    expect(monthly.items.find((item: { id: string }) => item.id === id)).toMatchObject({ reference: REF });
  });

  it.each([
    ["Service Status", "/api/amc/service-status"],
    ["Master AMC Status", "/api/amc/master-status"],
    ["Accounts", "/api/accounts"],
    ["Service Sales", "/api/services-sales"],
  ])("shows on %s and is found by its search", async (_label, path) => {
    const searched = await list(`${path}?search=${encodeURIComponent("xmod-ref-2027")}&pageSize=200`);

    expect(searched.items.length).toBeGreaterThan(0);
    expect(new Set(searched.items.map((item: { reference: string }) => item.reference))).toEqual(new Set([REF]));
  });

  it("names the contract in the Accounts contract filter", async () => {
    const options = await list("/api/accounts/options");
    expect(options.contracts.find((contract: { id: string }) => contract.id === id)).toMatchObject({ reference: REF });
  });

  it("appears in the consolidated reports", async () => {
    const report = await list("/api/reports/contract-summary?pageSize=200");
    expect(report.rows.map((row: { reference: string }) => row.reference)).toContain(REF);
    const services = await list("/api/reports/scheduled-services?pageSize=200");
    expect(services.rows.map((row: { reference: string }) => row.reference)).toContain(REF);
  });
});
