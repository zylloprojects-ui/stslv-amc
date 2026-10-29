import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { HEADER_ROW } from "../src/shared/export/excel";
import { EMPTY_MESSAGE, EXPORT_ROW_LIMITS } from "../src/shared/export/report";
import { activeContract, createClient, grant, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

let admin: Session;
let accountant: Session; // AMC_SCHEDULE:VIEW, no EXPORT
let procurement: Session; // given AMC_SCHEDULE:EXPORT without VIEW
let hotelOne: string;
let hotelTwo: string;
let cctv: string;

const DANGEROUS_NAME = '=HYPERLINK("http://evil.test","Pay here")';

beforeAll(async () => {
  await resetData();
  await grant("PROCUREMENT", [["AMC_SCHEDULE", "EXPORT"]]);
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  hotelOne = await createClient(admin, "Test Hotel One");
  hotelTwo = await createClient(admin, DANGEROUS_NAME);
  // Test Hotel One, FIRE, quarterly 2027, 405.000 per visit.
  await activeContract(admin, hotelOne);
  // The second client, CCTV, monthly Jan-Jun 2027, 150.000 per visit.
  cctv = await activeContract(admin, hotelTwo, {
    systemDescription: "CCTV",
    validTo: "2027-06-30",
    maintenanceFrequency: "MONTHLY",
    contractValue: "900.000",
    defaultVisitAmount: "150.000",
    responsibleEngineer: "Site Engineer",
  });
  // One cancelled visit: it is listed, and left out of the total.
  await pool.query("UPDATE amc_visits SET status = 'CANCELLED' WHERE id = $1", [(await visitsOf(cctv))[1]?.id]);
});
afterAll(closePool);

const exportAs = (query: Record<string, unknown>, session: Session | null = admin) => {
  const request = api().get("/api/amc/visits/export").query(query).responseType("blob");

  return session ? request.set(session.headers) : request;
};
const list = (query: Record<string, unknown>) => api().get("/api/amc/visits").query(query).set(admin.headers);
const errorOf = (response: { body: Buffer }) => JSON.parse(response.body.toString()).error as { code: string; message: string };

async function sheetOf(response: { body: Buffer }): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);

  return workbook.getWorksheet("AMC Schedule") as ExcelJS.Worksheet;
}

/** The data rows of the sheet, as arrays of cell values. */
function dataRows(sheet: ExcelJS.Worksheet, count: number): ExcelJS.CellValue[][] {
  return Array.from({ length: count }, (_, index) => {
    const row = sheet.getRow(HEADER_ROW + 1 + index);

    return Array.from({ length: 15 }, (_cell, column) => row.getCell(column + 1).value);
  });
}

describe("who may export the schedule", () => {
  it("needs a session", async () => {
    expect((await exportAs({ format: "xlsx" }, null)).status).toBe(401);
  });

  it("refuses a role that may view the schedule but does not hold EXPORT", async () => {
    const response = await exportAs({ format: "xlsx" }, accountant);

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("FORBIDDEN");
    // The legacy roles hold no EXPORT (the six-role model of 0087 grants it to Admin and the Executives).
    const granted = await pool.query("SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.action = 'EXPORT' AND r.code IN ('ACCOUNTANT', 'EXECUTION', 'INVOICING')");
    expect(granted.rowCount).toBe(0);
  });

  it("refuses EXPORT without VIEW: exporting never shows more than the screen does", async () => {
    expect((await exportAs({ format: "pdf" }, procurement)).status).toBe(403);
  });

  it("works for a role once an Admin grants it EXPORT", async () => {
    await grant("ACCOUNTANT", [["AMC_SCHEDULE", "EXPORT"]]);
    const response = await exportAs({ format: "xlsx", from: "2027-01-01", to: "2027-01-31" }, accountant);

    expect(response.status).toBe(200);
    await pool.query("DELETE FROM role_permissions WHERE action = 'EXPORT' AND role_id = (SELECT id FROM roles WHERE code = 'ACCOUNTANT')");
    expect((await exportAs({ format: "xlsx" }, accountant)).status).toBe(403);
  });

  it("rejects an unknown format or filter value", async () => {
    expect((await exportAs({ format: "csv" })).status).toBe(400);
    expect((await exportAs({})).status).toBe(400);
    expect((await exportAs({ format: "xlsx", from: "2027-13-01" })).status).toBe(400);
  });
});

describe("Excel export", () => {
  it("is sent as a download that no cache may keep", async () => {
    const response = await exportAs({ format: "xlsx" });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="amc-schedule_\d{8}-\d{4}\.xlsx"$/);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("lists every visit the schedule lists for the same filters, in the same order, with the same total", async () => {
    const filters = { from: "2027-01-01", to: "2027-12-31" };
    const listed = await list({ ...filters, pageSize: 200 });
    const sheet = await sheetOf(await exportAs({ format: "xlsx", ...filters }));
    const { items, total, totals } = listed.body.data;
    const rows = dataRows(sheet, total);

    // 4 quarterly + 6 monthly visits; the list pages them, the export does not.
    expect(total).toBe(10);
    expect(rows.map((row) => row[3])).toEqual(items.map((visit: { client: { name: string } }) => (visit.client.name === DANGEROUS_NAME ? `'${DANGEROUS_NAME}` : visit.client.name)));
    expect(rows.map((row) => row[1])).toEqual(items.map((visit: { scheduledDate: string }) => new Date(`${visit.scheduledDate}T00:00:00Z`)));
    expect(rows.map((row) => row[11])).toEqual(items.map((visit: { visitAmount: string }) => Number(visit.visitAmount)));
    expect(sheet.getRow(HEADER_ROW + 1 + total + 1).getCell(1).value).toBeNull();

    // 4 x 405 + 5 x 150: the cancelled visit is listed but not counted, exactly as on the screen.
    const totalCell = sheet.getRow(HEADER_ROW + 1 + total).getCell(12);
    expect(totals.visitAmount).toBe("2370.000");
    expect(totalCell.value).toMatchObject({ formula: `SUMIFS(L7:L16,J7:J16,"<>Cancelled")`, result: 2370 });
    expect(rows.filter((row) => row[9] === "Cancelled")).toHaveLength(1);
    expect(sheet.getRow(HEADER_ROW + 1 + total).getCell(11).value).toBe("Total amount (10 visits)");
  });

  it("writes one visit with real dates, a numeric amount and the application's wording", async () => {
    const sheet = await sheetOf(await exportAs({ format: "xlsx", clientId: hotelOne, from: "2027-01-01", to: "2027-01-31" }));

    expect(dataRows(sheet, 1)[0]).toEqual([
      1,
      new Date(Date.UTC(2027, 0, 1)),
      new Date(Date.UTC(2027, 0, 1)),
      "Test Hotel One",
      "FIRE",
      1,
      new Date(Date.UTC(2027, 0, 1)),
      new Date(Date.UTC(2027, 2, 31)),
      "Test Engineer",
      "Scheduled",
      // Overdue is measured against today, like the screen.
      expect.stringMatching(/^(Yes|No)$/),
      405,
      "Not completed",
      null,
      null,
    ]);
    expect(sheet.getCell("A3").value).toBe("Period: 01 Jan 2027 to 31 Jan 2027   ·   Client: Test Hotel One");
    expect(sheet.getCell("A4").value).toMatch(/^Generated \d{2} \w{3} \d{4}, \d{2}:\d{2} Oman time by admin@example\.com/);
  });

  it("respects every filter of the schedule", async () => {
    const count = async (query: Record<string, unknown>) => {
      const [listed, exported] = await Promise.all([list(query), exportAs({ format: "xlsx", ...query })]);
      const total = listed.body.data.total as number;
      const sheet = await sheetOf(exported);

      // The row after the last data row is the total (or the empty message), never another visit.
      expect(typeof sheet.getRow(HEADER_ROW + total).getCell(1).value).toBe(total > 0 ? "number" : "string");
      expect(sheet.getRow(HEADER_ROW + total + 1).getCell(1).value).toBe(total > 0 ? null : EMPTY_MESSAGE);

      return total;
    };

    expect(await count({ clientId: hotelTwo })).toBe(6);
    expect(await count({ contractId: cctv, status: "CANCELLED" })).toBe(1);
    expect(await count({ system: " cctv " })).toBe(6);
    expect(await count({ status: "SCHEDULED", from: "2027-04-01", to: "2027-04-30" })).toBe(2);
    expect(await count({ search: "site eng" })).toBe(6);
    expect(await count({ invoiceEligibility: "READY_FOR_INVOICE" })).toBe(0);
  });

  it("neutralises a client name that is a formula, and names the filter from the database", async () => {
    const sheet = await sheetOf(await exportAs({ format: "xlsx", clientId: hotelTwo }));
    const cell = sheet.getRow(HEADER_ROW + 1).getCell(4);

    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe(`'${DANGEROUS_NAME}`);
    expect(sheet.getCell("A3").value).toBe(`Period: All dates   ·   Client: ${DANGEROUS_NAME}`);
    expect(sheet.getCell("A3").type).toBe(ExcelJS.ValueType.String);
  });

  it("holds no account or security information", async () => {
    const sheet = await sheetOf(await exportAs({ format: "xlsx" }));
    const text: string[] = [];

    sheet.eachRow((row) => row.eachCell((cell) => text.push(String(cell.text))));
    // The only personal detail is the name of the user who made the export.
    expect(text.join("\n")).not.toMatch(/password|token|bearer|secret|\$2[aby]\$/i);
    expect(text.filter((value) => value.includes("@example.com"))).toHaveLength(1);
  });
});

describe("PDF export", () => {
  it("is a PDF download", async () => {
    const response = await exportAs({ format: "pdf", from: "2027-01-01", to: "2027-12-31" });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="amc-schedule_\d{8}-\d{4}\.pdf"$/);
    expect(response.body.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("is produced for an empty result too", async () => {
    const response = await exportAs({ format: "pdf", from: "2031-01-01", to: "2031-01-31" });

    expect(response.status).toBe(200);
    expect(response.body.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses a result too large for a PDF and says what to do", async () => {
    const limit = EXPORT_ROW_LIMITS.pdf;

    EXPORT_ROW_LIMITS.pdf = 3;
    try {
      const response = await exportAs({ format: "pdf" });

      expect(response.status).toBe(422);
      expect(errorOf(response)).toEqual({
        code: "EXPORT_TOO_LARGE",
        message: "This export has 10 rows; a PDF can hold at most 3. Narrow the filters or export to Excel.",
      });
      expect((await exportAs({ format: "xlsx" })).status).toBe(200);
    } finally {
      EXPORT_ROW_LIMITS.pdf = limit;
    }
  });
});

describe("audit", () => {
  it("records each export with who made it, the format, the filters and the row count, and nothing for a refused one", async () => {
    await pool.query("DELETE FROM activity_logs WHERE action = 'amc_schedule.exported'");
    await exportAs({ format: "pdf", clientId: hotelOne, status: "SCHEDULED" });
    await exportAs({ format: "xlsx" }, accountant);

    const logs = await pool.query("SELECT user_id, module, entity_type, description, metadata FROM activity_logs WHERE action = 'amc_schedule.exported'");

    expect(logs.rows).toEqual([
      {
        user_id: admin.id,
        module: "AMC_SCHEDULE",
        entity_type: "amc_visits",
        description: "Exported the AMC schedule as PDF (4 visits).",
        metadata: { format: "pdf", filters: { clientId: hotelOne, status: ["SCHEDULED"] }, rowCount: 4 },
      },
    ]);
  });
});
