import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { applyImport, type ApplyResult } from "../src/legacy-import/apply";
import { stagingRows } from "../src/legacy-import/dry-run";
import { grant } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { writeFixtureWorkbooks } from "./legacy-import-fixtures";
import { resetProjectData, type Session } from "./projects-helpers";

// GET /api/historical-data: the read-only review of the staged source records.
// The data is the fixture import (invented content), so every count below can
// be checked against the plan that produced it.

let admin: Session;
let result: ApplyResult;
let directory: string;

const get = (path: string, session: Session = admin) => api().get(`/api/historical-data${path}`).set(session.headers);
const rows = async (query: string, session: Session = admin) => (await get(`/rows?pageSize=100${query}`, session)).body.data as { items: Record<string, any>[]; total: number; page: number; pageSize: number };

async function fingerprint(): Promise<string> {
  const digest = await pool.query<{ digest: string }>(
    `SELECT md5(
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM legacy_import_rows t) ||
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM legacy_import_batches t) ||
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM projects t) ||
       (SELECT string_agg(t::text, '|' ORDER BY t.id) FROM clients t)
     ) AS digest`
  );

  return digest.rows[0]?.digest as string;
}

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);

  const fixture = writeFixtureWorkbooks();

  directory = fixture.directory;
  result = await applyImport(fixture.config, pool);
});
afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await closePool();
});

describe("access", () => {
  it("requires a signed-in user", async () => {
    for (const path of ["/summary", "/rows", "/rows/1"]) {
      expect((await api().get(`/api/historical-data${path}`)).status).toBe(401);
    }
  });

  it("is open to Admin and to no other seeded role", async () => {
    expect((await get("/summary")).status).toBe(200);

    for (const role of ["ACCOUNTANT", "PROCUREMENT", "EXECUTION", "INVOICING"]) {
      const user = await signedIn(`${role.toLowerCase()}@example.com`, [role]);

      for (const path of ["/summary", "/rows", "/rows/1"]) {
        const response = await get(path, user);

        expect(response.status).toBe(403);
        // A refusal carries no data.
        expect(response.body).toEqual({ success: false, error: { code: "FORBIDDEN", message: expect.any(String) } });
      }
    }
  });

  it("opens for a role once it is granted HISTORICAL_DATA:VIEW, and not on any other permission", async () => {
    await pool.query("INSERT INTO roles (code, name) VALUES ('REVIEWER', 'Reviewer'), ('OTHER', 'Other')");
    await grant("REVIEWER", [["HISTORICAL_DATA", "VIEW"]]);
    await grant("OTHER", [["PROJECTS", "VIEW"], ["CLIENTS", "VIEW"], ["REPORTS", "VIEW"], ["SETTINGS", "VIEW"]]);

    const reviewer = await signedIn("reviewer@example.com", ["REVIEWER"]);
    const other = await signedIn("other@example.com", ["OTHER"]);

    expect((await get("/rows", reviewer)).status).toBe(200);
    expect((await get("/rows", other)).status).toBe(403);
  });

  it("lists the module among the permission modules", async () => {
    const roles = await api().get("/api/roles").set(admin.headers);

    expect(roles.body.data.modules).toContain("HISTORICAL_DATA");
  });
});

describe("read-only", () => {
  it("has no route that writes", async () => {
    const id = (await rows("")).items[0]?.id as string;
    const before = await fingerprint();

    for (const path of ["/rows", `/rows/${id}`, "/summary", "/import", "/apply", `/rows/${id}/release`, `/rows/${id}/approve`]) {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const response = await api()[method](`/api/historical-data${path}`).set(admin.headers).send({ disposition: "IMPORTED" });

        expect(response.status).toBe(404);
      }
    }

    expect(await fingerprint()).toBe(before);
  });

  it("changes nothing when it is read", async () => {
    const before = await fingerprint();

    await get("/summary");
    await rows("&kind=PROJECT&status=provisional&search=JOB");

    expect(await fingerprint()).toBe(before);
  });
});

describe("summary", () => {
  it("counts every source record, imported and provisional, by kind", async () => {
    const expected = stagingRows(result.plan);
    const count = (kind: string, disposition?: string) => expected.filter((row) => row.record_kind === kind && (!disposition || row.disposition === disposition)).length;
    const summary = (await get("/summary")).body.data;

    expect(summary.totals).toEqual({
      records: expected.length,
      imported: expected.filter((row) => row.disposition === "IMPORTED").length,
      provisional: expected.filter((row) => row.disposition === "HELD").length,
    });
    expect(summary.byKind.map((kind: { kind: string }) => kind.kind)).toEqual(["CLIENT", "AMC_CONTRACT", "AMC_VISIT", "PROJECT"]);

    for (const kind of summary.byKind) {
      expect(kind).toMatchObject({ total: count(kind.kind), imported: count(kind.kind, "IMPORTED"), provisional: count(kind.kind, "HELD") });
    }

    expect(summary.byKind.find((kind: { kind: string }) => kind.kind === "AMC_CONTRACT")).toMatchObject({ total: 3, imported: 2, provisional: 1 });
    expect(summary.byKind.find((kind: { kind: string }) => kind.kind === "AMC_VISIT")).toMatchObject({ total: 12, imported: 2, provisional: 10 });
    expect(summary.byKind.find((kind: { kind: string }) => kind.kind === "PROJECT")).toMatchObject({ total: 14, imported: 8, provisional: 6 });
  });

  it("adds up the source amounts exactly, and never counts an empty amount as zero", async () => {
    const summary = (await get("/summary")).body.data;
    const of = (kind: string) => summary.byKind.find((item: { kind: string }) => item.kind === kind);

    // The plan's own totals, to three decimals.
    expect(of("PROJECT")).toMatchObject({ importedAmount: result.plan.totals.projects.importableValue, provisionalAmount: result.plan.totals.projects.heldValue, withoutAmount: 1 });
    expect(of("AMC_VISIT")).toMatchObject({ importedAmount: result.plan.totals.visits.importableAmount, provisionalAmount: result.plan.totals.visits.heldAmount, withoutAmount: 0 });
    expect(of("AMC_CONTRACT")).toMatchObject({ importedAmount: result.plan.totals.contracts.importableValue, provisionalAmount: result.plan.totals.contracts.heldValue });
    expect(of("PROJECT").importedAmount).toBe("4810.609");
    // Client names carry no amount.
    expect(of("CLIENT")).toMatchObject({ importedAmount: null, provisionalAmount: null });
  });

  it("reports why records are provisional, the invoice references and the batch", async () => {
    const summary = (await get("/summary")).body.data;
    const reasons = Object.fromEntries(summary.holdReasons.filter((reason: { kind: string }) => reason.kind === "PROJECT").map((reason: { code: string; count: number }) => [reason.code, reason.count]));

    expect(reasons).toEqual(result.plan.totals.projects.heldByReason);
    expect(summary.clientNames.distinct).toBe(result.plan.totals.clients.rawNames);
    expect(summary.invoiceReferences.numbersMentioned).toBe(result.plan.totals.invoices.jobMentions + result.plan.totals.invoices.scheduleNumbers);
    expect(summary.invoiceReferences.byClassification).toContainEqual({ kind: "PROJECT", classification: "INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT", count: 2 });
    expect(summary.batches).toHaveLength(1);
    expect(summary.batches[0]).toMatchObject({ id: result.batchId, label: "Historical Excel import", cutoverDate: result.cutoverDate, rows: summary.totals.records });
    expect(summary.batches[0].sourceFiles.map((file: { name: string }) => file.name)).toEqual(["Contracts.xlsx", "Schedule.xlsx", "Jobs.xlsx"]);
  });
});

describe("rows", () => {
  it("returns every source record in source order, page by page", async () => {
    const all = await rows("");
    const first = (await get("/rows?pageSize=5&page=1")).body.data;
    const second = (await get("/rows?pageSize=5&page=2")).body.data;

    expect(all.total).toBe(result.sourceRecords);
    expect(all.items).toHaveLength(result.sourceRecords);
    expect([...first.items, ...second.items].map((row: { id: string }) => row.id)).toEqual(all.items.slice(0, 10).map((row) => row.id));
    expect(first).toMatchObject({ total: result.sourceRecords, page: 1, pageSize: 5 });
    // Default page size.
    expect((await get("/rows")).body.data.items).toHaveLength(25);
  });

  it("shows the original values beside the proposed mapping, with the source reference", async () => {
    const job = (await rows("&kind=PROJECT&search=JOB0102")).items[0];

    expect(job).toMatchObject({
      kind: "PROJECT",
      status: "IMPORTED",
      identifier: "JOB0102",
      source: { workbook: "Jobs.xlsx", sheet: "Register", row: 6, cell: "" },
      rawValues: { Client: "ECHO ", "Job Value": "1577.276", "INVOICE NUMBER": "9002, 9003", Status: "Completed" },
      // The headings in the order of the sheet, which the stored JSON object does not keep.
      sourceColumns: ["S. No", "Status", "Month", "Job Number", "Client", "Job Description", "Job Value", "VAT", "VAT [formula]", "Grand Job Value", "Grand Job Value [formula]", "PROFIT", "INVOICE NUMBER", "[font colour]"],
      proposedValues: { clientName: "ECHO", jobValue: "1577.276", vatAmount: "78.864", grandValue: "1656.140", legacyStatus: "Completed", jobDate: "2025-01-01" },
      holdReasons: [],
      invoiceReference: { rawCell: "9002, 9003", numbers: ["9002", "9003"], classification: "JOB_HAS_MULTIPLE_INVOICES" },
      link: { type: "project", label: "JOB0102" },
    });
    // The link is the real project.
    expect((await pool.query("SELECT job_number FROM projects WHERE id = $1", [job?.link.id])).rows).toEqual([{ job_number: "JOB0102" }]);
    expect((await get(`/rows/${job?.id}`)).body.data).toEqual(job);
  });

  it("shows a provisional record with its reasons and no link to an application record", async () => {
    const duplicates = (await rows("&reason=DUPLICATE_JOB_NUMBER")).items;
    const blank = (await rows("&reason=JOB_VALUE_BLANK")).items;
    const contract = (await rows("&kind=AMC_CONTRACT&status=provisional")).items;

    expect(duplicates.map((row) => [row.identifier, row.source.row, row.status, row.link])).toEqual([
      ["JOB0109", 9, "PROVISIONAL", null],
      ["JOB0109", 13, "PROVISIONAL", null],
    ]);
    expect(duplicates[0]?.holdReasons[0]).toMatchObject({ code: "DUPLICATE_JOB_NUMBER", message: expect.stringContaining("rows 9, 13") });
    // Missing stays missing.
    expect(blank).toHaveLength(1);
    expect(blank[0]).toMatchObject({ identifier: "JOB0108", status: "PROVISIONAL", link: null, rawValues: { "Job Value": null }, proposedValues: { jobValue: null, grandValue: null } });
    expect(contract).toHaveLength(1);
    expect(contract[0]).toMatchObject({ proposedValues: { contractValue: "12000.000", finalCredit: "10000.000", maintenanceFrequency: null }, link: null });
    expect(contract[0]?.holdReasons.map((reason: { code: string }) => reason.code)).toEqual(["CLIENT_IDENTITY_UNCONFIRMED", "MAINTENANCE_FREQUENCY_UNRESOLVED"]);
    expect(contract[0]?.warnings.join(" ")).toContain("Final credit differs from the contract value");
  });

  it("shows every raw client name with its proposed mapping", async () => {
    const names = (await rows("&kind=CLIENT")).items;
    const alias = names.find((row) => row.identifier === "DELTAHOUSE");
    const spaced = names.find((row) => row.identifier === "ECHO ");

    expect(names).toHaveLength(result.plan.clientRows.length);
    expect(new Set(names.map((row) => row.identifier)).size).toBe(result.plan.totals.clients.rawNames);
    expect(alias).toMatchObject({ status: "PROVISIONAL", link: null, proposedValues: { masterName: "DELTA HOUSE", classification: "PROPOSED_ALIAS", outcome: "HELD_ALIAS_NOT_APPROVED" } });
    expect(spaced).toMatchObject({ status: "IMPORTED", rawValues: { Client: "ECHO " }, proposedValues: { masterName: "ECHO", classification: "SAFE_NORMALIZATION" }, link: { type: "client", label: "ECHO" } });
  });

  it("shows all the schedule rows, and links only the ones that became a visit", async () => {
    const visits = (await rows("&kind=AMC_VISIT")).items;

    expect(visits).toHaveLength(12);
    expect(visits.filter((row) => row.link !== null).map((row) => [row.source.cell, row.link.type, row.link.label])).toEqual([
      ["B6", "visit", "ALPHA HOTEL / FIRE / 2026-01-01"],
      ["B16", "visit", "ALPHA HOTEL / FIRE / 2026-04-01"],
    ]);
    expect(visits.find((row) => row.source.cell === "H6")).toMatchObject({
      status: "PROVISIONAL",
      proposedValues: { clientName: "BETA TOWER", periodStart: "2026-02-01", visitAmount: "775.000" },
      invoiceReference: { numbers: ["9102"], classification: "AMC_PERIOD_ONE_INVOICE" },
    });
    expect(visits.find((row) => row.source.cell === "N6")).toMatchObject({ invoiceReference: { rawCell: "DONE", numbers: [], classification: "NON_NUMERIC_MARKER" } });
  });

  it("filters by kind, status, reason, invoice reference and text", async () => {
    const expected = stagingRows(result.plan);

    expect((await rows("&kind=PROJECT&status=imported")).total).toBe(8);
    expect((await rows("&status=provisional")).total).toBe(expected.filter((row) => row.disposition === "HELD").length);
    expect((await rows("&reason=CLIENT_ALIAS_NOT_APPROVED&kind=AMC_VISIT")).total).toBe(4);
    expect((await rows("&invoice=shared")).items.map((row) => row.identifier)).toEqual(["JOB0102", "JOB0103", "JOB0104"]);
    expect((await rows("&invoice=marker")).total).toBe(3);
    expect((await rows("&invoice=with")).total).toBe(11);
    // Text is matched in the identifier, the original values and the proposal, literally.
    expect((await rows("&search=hydrant")).items.map((row) => row.identifier)).toEqual(["JOB0104"]);
    expect((await rows("&search=9004")).items.map((row) => row.identifier)).toEqual(["JOB0103", "JOB0104"]);
    expect((await rows("&search=%25")).total).toBe(0);
    expect((await rows("&kind=PROJECT&status=imported&search=nothing-like-this")).items).toEqual([]);
  });

  it("refuses a filter it does not know and an id that cannot exist", async () => {
    expect((await get("/rows?kind=INVOICE")).status).toBe(400);
    expect((await get("/rows?status=held")).status).toBe(400);
    expect((await get("/rows?reason=drop table")).status).toBe(400);
    expect((await get("/rows?pageSize=1000")).status).toBe(400);
    expect((await get("/rows/999999")).status).toBe(404);
    expect((await get("/rows/abc")).status).toBe(404);
  });
});
