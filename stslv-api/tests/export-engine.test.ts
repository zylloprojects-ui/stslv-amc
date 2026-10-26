import { readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vitest";
import { SYSTEM_NAME, artworkHeight, footerArtwork, headerArtwork } from "../src/shared/export/branding";
import { HEADER_ROW, excelValue, printLayout, renderExcel } from "../src/shared/export/excel";
import { pageLayout, pdfDefinition, pdfText, renderPdf } from "../src/shared/export/pdf";
import {
  EMPTY_MESSAGE,
  assertExportSize,
  displayGeneratedAt,
  displayMoney,
  displayPeriod,
  excelSafeText,
  exportFileName,
  type ReportDefinition,
  type ReportRow,
} from "../src/shared/export/report";
import { closePool } from "./helpers";

afterAll(closePool);

const GENERATED = new Date("2026-10-04T21:05:00Z"); // 01:05 on 5 October in Oman

function report(rows: ReportRow[], overrides: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    title: "Test Register",
    period: "01 Jan 2027 to 31 Jan 2027",
    filters: [{ label: "Client", value: "Test Hotel One" }],
    generatedAt: GENERATED,
    generatedBy: "Asha Admin",
    orientation: "landscape",
    fileStem: "test-register",
    tables: [
      {
        name: "Register",
        columns: [
          { key: "reference", header: "Reference", kind: "identifier", width: 14 },
          { key: "date", header: "Date", kind: "date", width: 14 },
          { key: "client", header: "Client", kind: "text", width: 30, wrap: true },
          { key: "status", header: "Status", kind: "text", width: 14 },
          { key: "amount", header: "Amount", kind: "money", width: 14 },
          { key: "rate", header: "VAT rate", kind: "percent", width: 10 },
          { key: "items", header: "Items", kind: "count", width: 8 },
          { key: "notes", header: "Notes", kind: "text", width: 40, wrap: true, excelOnly: true },
        ],
        rows,
        totals: {
          label: "Total",
          values: { amount: "1655.125" },
          excelFormulas: { amount: (range) => `SUM(${range("amount")})` },
        },
        notes: ["A remark."],
      },
    ],
    ...overrides,
  };
}

const ROWS: ReportRow[] = [
  { reference: "000123", date: "2027-01-05", client: "Test Hotel One", status: "Open", amount: "1250.500", rate: "5.000", items: 3, notes: null },
  { reference: "1E5", date: "2027-01-31", client: "=HYPERLINK(\"http://evil.test\",\"Click\")", status: "Open", amount: "404.625", rate: "7.500", items: 1200, notes: "-2+3" },
  { reference: "GPSA0521", date: null, client: "Test Hotel Two", status: "Closed", amount: null, rate: null, items: 0, notes: "@SUM(A1)" },
];

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  return workbook;
}

describe("formula injection", () => {
  it("writes text that could run as a formula with a leading apostrophe, and leaves other text alone", () => {
    for (const dangerous of ["=1+1", "+968 1234", "-2+3", "@SUM(A1)", "\tcmd", "=cmd|' /C calc'!A0"]) {
      expect(excelSafeText(dangerous)).toBe(`'${dangerous}`);
    }
    expect(excelSafeText("Test Hotel One")).toBe("Test Hotel One");
    expect(excelSafeText("A = B")).toBe("A = B");
    expect(excelSafeText("bad\u0000char\u0007")).toBe("badchar");
    expect(excelSafeText("\r\n=1+1")).toBe("'\n=1+1");
  });

  it("never writes a text value as a formula, in any column kind", () => {
    for (const kind of ["text", "identifier", "date", "money", "count", "percent"] as const) {
      expect(excelValue(kind, "=1+1")).toBe("'=1+1");
    }
  });
});

describe("Excel workbook", () => {
  it("writes dates, amounts, rates and counts as real values and identifiers as text", async () => {
    const sheet = (await load(await renderExcel(report(ROWS)))).getWorksheet("Register") as ExcelJS.Worksheet;
    const first = sheet.getRow(HEADER_ROW + 1);
    const second = sheet.getRow(HEADER_ROW + 2);
    const third = sheet.getRow(HEADER_ROW + 3);

    // Leading zeros and "1E5" survive: text cells in text format.
    expect(first.getCell(1).value).toBe("000123");
    expect(first.getCell(1).numFmt).toBe("@");
    expect(second.getCell(1).value).toBe("1E5");

    expect(first.getCell(2).value).toEqual(new Date(Date.UTC(2027, 0, 5)));
    expect(first.getCell(2).numFmt).toBe("dd-mmm-yyyy");
    expect(third.getCell(2).value).toBeNull();

    expect(first.getCell(5).value).toBe(1250.5);
    expect(first.getCell(5).numFmt).toBe("#,##0.000");
    expect(third.getCell(5).value).toBeNull();

    expect(first.getCell(6).value).toBe(0.05);
    expect(second.getCell(6).value).toBe(0.075);
    expect(second.getCell(7).value).toBe(1200);

    // Dangerous text arrives as text, never as a formula.
    expect(second.getCell(3).value).toBe("'=HYPERLINK(\"http://evil.test\",\"Click\")");
    expect(second.getCell(3).type).toBe(ExcelJS.ValueType.String);
    expect(second.getCell(8).value).toBe("'-2+3");
    expect(third.getCell(8).value).toBe("'@SUM(A1)");
  });

  it("has the official artwork, the report banner, a frozen and filtered heading row and print settings", async () => {
    const workbook = await load(await renderExcel(report(ROWS)));
    const sheet = workbook.getWorksheet("Register") as ExcelJS.Worksheet;

    // The company name is in the artwork; the banner text is the report's own.
    expect(sheet.getCell("A1").value).toBeNull();
    expect(sheet.getCell("A2").value).toBe("Test Register");
    expect(sheet.getCell("A3").value).toBe("Period: 01 Jan 2027 to 31 Jan 2027   ·   Client: Test Hotel One");
    expect(sheet.getCell("A4").value).toBe(`Generated 05 Oct 2026, 01:05 Oman time by Asha Admin   ·   ${SYSTEM_NAME}`);
    // Header artwork above the banner, footer artwork under the report.
    expect(sheet.getImages().map((image) => image.range.tl.nativeRow)).toEqual([0, HEADER_ROW + 7]);
    // Printing leaves out the on-screen artwork row and the workbook-only Notes column.
    expect(sheet.pageSetup.printArea).toBe(`A2:G${HEADER_ROW + 7}`);

    expect(sheet.getRow(HEADER_ROW).getCell(1).value).toBe("Reference");
    expect(sheet.getRow(HEADER_ROW).getCell(5).font?.bold).toBe(true);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: HEADER_ROW });
    expect(sheet.autoFilter).toBe(`A${HEADER_ROW}:H${HEADER_ROW + 3}`);
    expect(sheet.pageSetup).toMatchObject({ orientation: "landscape", fitToWidth: 1, printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}` });
    expect(sheet.getColumn(3).width).toBe(30);
  });

  it("puts a live total under the data, outside the filter, with PostgreSQL's figure as its result", async () => {
    const sheet = (await load(await renderExcel(report(ROWS)))).getWorksheet("Register") as ExcelJS.Worksheet;
    const totals = sheet.getRow(HEADER_ROW + 4);

    expect(totals.getCell(4).value).toBe("Total");
    expect(totals.getCell(5).value).toMatchObject({ formula: `SUM(E${HEADER_ROW + 1}:E${HEADER_ROW + 3})`, result: 1655.125 });
    expect(totals.getCell(5).numFmt).toBe("#,##0.000");
    expect(sheet.getRow(HEADER_ROW + 6).getCell(1).value).toBe("A remark.");
  });

  it("says so when there is nothing to list, and writes no total", async () => {
    const sheet = (await load(await renderExcel(report([])))).getWorksheet("Register") as ExcelJS.Worksheet;

    expect(sheet.getRow(HEADER_ROW + 1).getCell(1).value).toBe(EMPTY_MESSAGE);
    expect(sheet.getRow(HEADER_ROW + 2).getCell(5).value).toBeNull();
    expect(sheet.autoFilter).toBe(`A${HEADER_ROW}:H${HEADER_ROW}`);
  });

  it("gives every table its own worksheet with a name Excel accepts", async () => {
    const base = report(ROWS).tables[0] as ReportDefinition["tables"][number];
    const workbook = await load(
      await renderExcel(report(ROWS, { tables: [{ ...base, name: "Invoices: 2027/2028 [all] and a very long name" }, { ...base, name: "Invoices: 2027/2028 [all] and a very long name" }] }))
    );

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Invoices  2027 2028  all  and a", "Invoices  2027 2028  all  a (2)"]);
  });
});

describe("PDF", () => {
  it("repeats the headings, never splits a row, and leaves out the Excel-only columns", () => {
    const definition = pdfDefinition(report(ROWS));
    const table = (definition.content as { table?: { headerRows: number; dontBreakRows: boolean; body: { text?: string }[][]; widths: number[] } }[]).find((node) => node.table)?.table;

    expect(definition.pageOrientation).toBe("landscape");
    expect(table).toMatchObject({ headerRows: 1, dontBreakRows: true });
    expect(table?.body[0]?.map((cell) => cell.text)).toEqual(["Reference", "Date", "Client", "Status", "Amount", "VAT rate", "Items"]);
    expect(table?.body[1]?.map((cell) => cell.text)).toEqual(["000123", "05 Jan 2027", "Test Hotel One", "Open", "1,250.500", "5%", "3"]);
    expect(table?.body[3]?.map((cell) => cell.text)).toEqual(["GPSA0521", "—", "Test Hotel Two", "Closed", "—", "—", "0"]);
    expect(table?.body[4]?.map((cell) => cell.text ?? "")).toEqual(["Total", "", "", "", "1,655.125", "", ""]);
    // The columns fill the width of a landscape A4 page between the margins, and no more.
    expect((table?.widths ?? []).reduce((sum, width) => sum + width, 0) + 7 * 6).toBeLessThanOrEqual(841.89 - 56);
  });

  it("prints the report, what it is, who made it and the page numbers on every page", () => {
    const definition = pdfDefinition(report(ROWS, { disclaimer: "Internal tracking report. Not an official tax invoice." }));
    const header = JSON.stringify((definition.header as () => unknown)());
    const footer = JSON.stringify((definition.footer as (page: number, pages: number) => unknown)(2, 5));

    expect(header).toContain("Test Register");
    expect(header).toContain("Period: 01 Jan 2027 to 31 Jan 2027");
    expect(footer).toContain("Generated 05 Oct 2026, 01:05 Oman time by Asha Admin");
    expect(footer).toContain("Internal tracking report. Not an official tax invoice.");
    expect(footer).toContain("Page 2 of 5");
  });

  it("renders a real, multi-page PDF, and an empty one that says there is nothing to list", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({ ...ROWS[0], reference: String(index).padStart(6, "0"), client: `Client ${"with a long name ".repeat(index % 4)}${"X".repeat(60)}` }));
    const long = await renderPdf(report(many));
    const empty = await renderPdf(report([]));
    const pages = (buffer: Buffer) => (buffer.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

    expect(long.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pages(long)).toBeGreaterThan(3);
    expect(pages(empty)).toBe(1);
    expect(JSON.stringify(pdfDefinition(report([])).content)).toContain(EMPTY_MESSAGE);
  });

  it("words values the way the application shows them", () => {
    expect(pdfText("money", "1234.5")).toBe("1,234.500");
    expect(pdfText("money", null)).toBe("—");
    expect(pdfText("date", "2027-12-31")).toBe("31 Dec 2027");
    expect(pdfText("identifier", "000123")).toBe("000123");
  });
});

describe("shared rules", () => {
  it("formats money as text, without floating-point arithmetic", () => {
    expect(displayMoney("99999999999.999")).toBe("99,999,999,999.999");
    expect(displayMoney("0")).toBe("0.000");
    expect(displayMoney("-620.5")).toBe("-620.500");
  });

  it("describes a period and stamps the time in Oman", () => {
    expect(displayPeriod("2027-01-01", "2027-01-31")).toBe("01 Jan 2027 to 31 Jan 2027");
    expect(displayPeriod("2027-01-01", undefined)).toBe("From 01 Jan 2027");
    expect(displayPeriod(null, null)).toBe("All dates");
    expect(displayGeneratedAt(GENERATED)).toBe("05 Oct 2026, 01:05 Oman time");
  });

  it("names the file from fixed text and the clock only", () => {
    expect(exportFileName({ fileStem: "amc-schedule", generatedAt: GENERATED }, "xlsx")).toBe("amc-schedule_20261005-0105.xlsx");
    expect(exportFileName({ fileStem: "../../etc/pass wd\"", generatedAt: GENERATED }, "pdf")).toBe("etc-pass-wd_20261005-0105.pdf");
  });

  it("refuses an export that is too large for its format", () => {
    expect(() => assertExportSize("pdf", 2000)).not.toThrow();
    expect(() => assertExportSize("pdf", 2001)).toThrow(/at most 2000.*export to Excel/);
    expect(() => assertExportSize("xlsx", 50_001)).toThrow(/at most 50000/);
  });

});

describe("official header and footer artwork", () => {
  const assets = path.resolve(__dirname, "..", "assets", "branding");
  const size = (file: string) => {
    const png = readFileSync(path.join(assets, file));

    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };

  it("is the supplied artwork, with only the frame of the screen capture cut off", () => {
    expect(size("source/header-as-supplied.png")).toEqual([1330, 229]);
    expect(size("source/footer-as-supplied.png")).toEqual([1318, 181]);
    // Header: 4 px left, 1 px right, 6 px top. Footer: 1 px bottom. Nothing is scaled.
    expect([headerArtwork().width, headerArtwork().height]).toEqual([1325, 223]);
    expect([footerArtwork().width, footerArtwork().height]).toEqual([1318, 180]);
  });

  it("is drawn in a PDF on every page, edge to edge, in its own proportions, clear of the content", () => {
    for (const orientation of ["portrait", "landscape"] as const) {
      const definition = pdfDefinition(report(ROWS, { orientation, disclaimer: "Internal tracking report. Not an official tax invoice." }));
      const layout = pageLayout(orientation);
      const background = (definition.background as () => unknown)();
      const [, top, , bottom] = definition.pageMargins as number[];

      expect(layout.headerHeight).toBeCloseTo((layout.page.width * 223) / 1325, 5);
      expect(layout.footerHeight).toBeCloseTo((layout.page.width * 180) / 1318, 5);
      // Only a width is given, so the proportions are the artwork's own.
      expect(background).toEqual([
        { image: "header", width: layout.page.width, absolutePosition: { x: 0, y: 0 } },
        { image: "footer", width: layout.page.width, absolutePosition: { x: 0, y: layout.page.height - layout.footerHeight } },
      ]);
      // The content starts below the header artwork and its title band, and ends above the footer band and artwork.
      expect(top).toBeGreaterThanOrEqual(layout.headerHeight + 28);
      expect(bottom).toBeGreaterThanOrEqual(layout.footerHeight + 26);
      expect(Object.keys(definition.images ?? {})).toEqual(["header", "footer"]);
    }
  });

  it("is the page header and footer of every printed Excel page, and is not printed twice", async () => {
    const base = report(ROWS).tables[0] as ReportDefinition["tables"][number];
    const zip = await JSZip.loadAsync(await renderExcel(report(ROWS, { orientation: "portrait", tables: [base, { ...base, name: "Second" }] })));
    const text = (name: string) => (zip.file(name) as JSZip.JSZipObject).async("string");
    const layout = printLayout("portrait");

    for (const number of [1, 2]) {
      const sheet = await text(`xl/worksheets/sheet${number}.xml`);
      const vml = await text(`xl/drawings/vmlDrawingHF${number}.vml`);
      const drawing = await text(`xl/drawings/drawing${number}.xml`);

      expect(sheet).toContain('<headerFooter scaleWithDoc="0" alignWithMargins="0"');
      expect(sheet).toContain("<oddHeader>&amp;C&amp;G</oddHeader>");
      expect(sheet).toContain("<oddFooter>&amp;C&amp;G</oddFooter>");
      expect(sheet).toMatch(/<drawing r:id="[^"]+"\/><legacyDrawingHF r:id="rIdHF"\/>/);
      expect(await text(`xl/worksheets/_rels/sheet${number}.xml.rels`)).toContain(`Target="../drawings/vmlDrawingHF${number}.vml"`);
      expect(vml).toContain('id="CH"');
      expect(vml).toContain('id="CF"');
      expect(vml).toContain(`width:${layout.artWidth.toFixed(2)}pt;height:${artworkHeight(headerArtwork(), layout.artWidth).toFixed(2)}pt`);
      expect(vml).toContain(`width:${layout.artWidth.toFixed(2)}pt;height:${artworkHeight(footerArtwork(), layout.artWidth).toFixed(2)}pt`);
      // The pictures in the sheet are for the screen only.
      expect(drawing.match(/fPrintsWithSheet="0"/g)).toHaveLength(2);
      expect(drawing).not.toMatch(/<xdr:clientData\s*\/>/);
    }

    // The printed pictures are the artwork files themselves, byte for byte.
    expect((await (zip.file("xl/media/report-header-print.png") as JSZip.JSZipObject).async("nodebuffer")).equals(headerArtwork().png)).toBe(true);
    expect((await (zip.file("xl/media/report-footer-print.png") as JSZip.JSZipObject).async("nodebuffer")).equals(footerArtwork().png)).toBe(true);
    expect(await text("[Content_Types].xml")).toContain('Extension="vml"');

    // The page margins leave room for the artwork (inches).
    const sheet = (await load(await renderExcel(report(ROWS, { orientation: "portrait" })))).getWorksheet("Register") as ExcelJS.Worksheet;

    expect((sheet.pageSetup.margins?.top ?? 0) * 72).toBeGreaterThan(layout.headerHeight + 14);
    expect((sheet.pageSetup.margins?.bottom ?? 0) * 72).toBeGreaterThan(layout.footerHeight + 14);
  });
});
