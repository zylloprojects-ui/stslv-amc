import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { ImportConfig } from "../src/legacy-import/config";
import { fromThousandths, toThousandths, type Money } from "../src/legacy-import/money";
import type { DatabaseState } from "../src/legacy-import/plan";
import type { ContractSource, InvoiceCell, JobSource, ScheduleSource, SourceData } from "../src/legacy-import/source";
import type { Cell } from "../src/legacy-import/xlsx";

// Fixtures for the historical import. Everything here is invented: the shapes
// follow the client's registers, the names, numbers and amounts do not.

// ---------------------------------------------------------------------------
// Source records, for tests of the plan
// ---------------------------------------------------------------------------

export const money = (amount: string | null): Money =>
  amount === null ? { kind: "BLANK" } : { kind: "VALUE", amount, isZero: toThousandths(amount) === 0n };

export const invoice = (value: string | number | null): InvoiceCell =>
  value === null ? { kind: "BLANK" } : typeof value === "number" ? { kind: "NUMBER", raw: String(value) } : { kind: "TEXT", raw: value };

const numberCell = (ref: string, value: string, formula: string | null = null): Cell => ({
  ref,
  column: ref.replace(/\d+/g, ""),
  row: Number(ref.replace(/\D+/g, "")),
  type: "number",
  value,
  formula,
  fontColor: null,
});

/** Five percent of an amount, written the way a spreadsheet stores it: unrounded. */
export function fivePercent(amount: string): string {
  const hundredThousandths = (toThousandths(amount) * 5n).toString().padStart(6, "0");

  return `${hundredThousandths.slice(0, -5)}.${hundredThousandths.slice(-5)}`.replace(/\.?0+$/, "") || "0";
}

export function contract(row: number, overrides: Partial<ContractSource> & { amount?: string | null; credit?: string | null } = {}): ContractSource {
  const { amount = "1600.000", credit, ...rest } = overrides;

  return {
    ref: { workbook: "Contracts.xlsx", sheet: "Contracts", row, cell: "" },
    raw: {},
    serial: String(row),
    engineer: "ENGINEER",
    validFrom: "2025-07-01",
    validTo: "2026-06-30",
    clientRaw: "ALPHA HOTEL",
    system: "FIRE",
    value: money(amount),
    finalCredit: money(credit === undefined ? amount : credit),
    ...rest,
  };
}

export function period(cell: string, month: string | null, label: string, amount: string | null, invoiceCell: string | number | null = null): ScheduleSource {
  return {
    ref: { workbook: "Schedule.xlsx", sheet: "Schedule", row: Number(cell.replace(/\D+/g, "")), cell },
    raw: {},
    month,
    label,
    systems: "FA/FM",
    invoice: invoice(invoiceCell),
    value: money(amount),
  };
}

export interface JobOverrides {
  jobNumber?: string | null;
  client?: string | null;
  status?: string | null;
  month?: string | null;
  description?: string | null;
  amount?: string | null;
  /** The VAT cell as text; by default five percent of the amount. */
  vat?: string;
  profit?: string | null;
  invoice?: string | number | null;
  serial?: string | null;
}

export function job(row: number, overrides: JobOverrides = {}): JobSource {
  const amount = overrides.amount === undefined ? "1000.000" : overrides.amount;

  return {
    ref: { workbook: "Jobs.xlsx", sheet: "Register", row, cell: "" },
    raw: {},
    serial: overrides.serial === undefined ? String(row) : overrides.serial,
    status: overrides.status === undefined ? "Completed" : overrides.status,
    monthText: overrides.month === undefined ? "FEB" : overrides.month,
    jobNumber: overrides.jobNumber === undefined ? `JOB${String(row).padStart(4, "0")}` : overrides.jobNumber,
    clientRaw: overrides.client === undefined ? "ALPHA HOTEL" : overrides.client,
    description: overrides.description === undefined ? "Panel repair" : overrides.description,
    value: money(amount),
    vatCell: numberCell(`H${row}`, overrides.vat ?? (amount === null ? "0" : fivePercent(amount)), "(shared)"),
    profit: money(overrides.profit ?? null),
    invoice: invoice(overrides.invoice ?? null),
  };
}

export function sourceData(parts: Partial<SourceData>): SourceData {
  return {
    contracts: [],
    schedule: [],
    jobs: [],
    jobsYear: 2025,
    totals: { contractValue: null, finalCredit: null, jobValue: null, scheduleBlocks: [] },
    ignored: [],
    ...parts,
  };
}

export const database = (overrides: Partial<DatabaseState> = {}): DatabaseState => ({ asOf: "2026-10-01", clients: [], jobNumbers: [], ...overrides });

export const total = (amounts: (string | null)[]): string =>
  fromThousandths(amounts.filter((amount): amount is string => amount !== null).reduce((sum, amount) => sum + toThousandths(amount), 0n));

// ---------------------------------------------------------------------------
// Workbooks, for tests of the reader and of the whole dry run
// ---------------------------------------------------------------------------

export interface FixtureCell {
  ref: string;
  /** A number is written as a number cell, a string as shared text. Undefined writes a formatted empty cell. */
  value?: number | string;
  formula?: string;
  /** Index into the fixture's cell styles: 0 default, 1 green font, 2 red font. */
  style?: number;
}

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A ZIP archive of the given files. Odd entries are stored and even ones deflated, so both are exercised. */
export function zip(files: [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  files.forEach(([name, content], index) => {
    const raw = Buffer.from(content, "utf8");
    const method = index % 2 === 0 ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** A one-sheet .xlsx workbook holding the given cells. */
export function workbook(sheetName: string, cells: FixtureCell[]): Buffer {
  const strings: string[] = [];
  const rows = new Map<number, string[]>();

  for (const cell of cells) {
    const row = Number(cell.ref.replace(/\D+/g, ""));
    const style = cell.style === undefined ? "" : ` s="${cell.style}"`;
    const formula = cell.formula === undefined ? "" : cell.formula === "(shared)" ? '<f t="shared" si="0"/>' : `<f>${xmlEscape(cell.formula)}</f>`;
    let xml: string;

    if (cell.value === undefined) {
      xml = formula === "" ? `<c r="${cell.ref}"${style}/>` : `<c r="${cell.ref}"${style}>${formula}</c>`;
    } else if (typeof cell.value === "number") {
      xml = `<c r="${cell.ref}"${style}>${formula}<v>${cell.value}</v></c>`;
    } else {
      let index = strings.indexOf(cell.value);

      if (index < 0) {
        index = strings.push(cell.value) - 1;
      }
      xml = `<c r="${cell.ref}"${style} t="s"><v>${index}</v></c>`;
    }

    rows.set(row, [...(rows.get(row) ?? []), xml]);
  }

  const sheetData = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([row, items]) => `<row r="${row}">${items.join("")}</row>`)
    .join("");
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  return zip([
    [
      "xl/workbook.xml",
      `${header}<workbook xmlns:r="r"><workbookPr/><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `${header}<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
    [
      "xl/sharedStrings.xml",
      `${header}<sst>${strings.map((text) => `<si><t xml:space="preserve">${xmlEscape(text)}</t></si>`).join("")}</sst>`,
    ],
    [
      "xl/styles.xml",
      `${header}<styleSheet><fonts count="3"><font><sz val="11"/></font><font><color rgb="FF00B050"/></font><font><color rgb="FFFF0000"/></font></fonts>` +
        '<cellXfs count="3"><xf fontId="0"/><xf fontId="1"/><xf fontId="2"/></cellXfs></styleSheet>',
    ],
    ["xl/worksheets/sheet1.xml", `${header}<worksheet><sheetData>${sheetData}</sheetData></worksheet>`],
  ]);
}

/** The day serial Excel stores for a date. */
export const serial = (iso: string): number => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

/**
 * A contract register, a maintenance schedule and a job register laid out like
 * the client's, with invented content, written to a temporary folder.
 */
export function writeFixtureWorkbooks(): { config: ImportConfig; directory: string } {
  const contracts = workbook("Contracts", [
    { ref: "A2", value: "CONTRACTS" },
    ...["S. No", "Engineer", "From\r\n(Validity)", "To\r\n(Validity)", "Client", "Description", "Value", "FINAL CREDIT"].map((value, index) => ({
      ref: `${"ABCDEFGH"[index]}4`,
      value,
    })),
    // An ordinary quarterly contract.
    { ref: "A5", value: 1 }, { ref: "B5", value: "ENGINEER" }, { ref: "C5", value: serial("2025-07-01") }, { ref: "D5", value: serial("2026-06-30") },
    { ref: "E5", value: "ALPHA HOTEL" }, { ref: "F5", value: "FIRE" }, { ref: "G5", value: 1600 }, { ref: "H5", value: 1600, formula: "G5" },
    // Named differently in the schedule.
    { ref: "A6", value: 2 }, { ref: "B6", value: "ENGINEER" }, { ref: "C6", value: serial("2026-02-01") }, { ref: "D6", value: serial("2027-01-31") },
    { ref: "E6", value: "BETA TOWER" }, { ref: "F6", value: "CCTV" }, { ref: "G6", value: 3100 }, { ref: "H6", value: 3100, formula: "G6" },
    // Uneven amounts, a trailing space, and a final credit below the value.
    { ref: "A7", value: 3 }, { ref: "B7", value: "ENGINEER" }, { ref: "C7", value: serial("2026-03-01") }, { ref: "D7", value: serial("2027-02-28") },
    { ref: "E7", value: "GAMMA " }, { ref: "F7", value: "Automation" }, { ref: "G7", value: 12000 }, { ref: "H7", value: 10000 },
    // Formatted, empty rows inside the table.
    { ref: "A8", style: 1 }, { ref: "G8", style: 1 },
    { ref: "A12", value: "TOTAL" }, { ref: "G12", value: 16700, formula: "SUM(G5:G11)" }, { ref: "H12", value: 14700, formula: "SUM(H5:H11)" },
  ]);

  const block = (column: string, header: number, month: string, lines: [string, string, number | string | undefined, number][], sum: number): FixtureCell[] => {
    const letters = "ABCDEFGHIJKLMNOPQ";
    const at = (offset: number, row: number) => `${letters[letters.indexOf(column) + offset]}${row}`;

    return [
      { ref: at(0, header - 1), value: serial(month) },
      ...["S/N", "Client", "Systems", "Inv. No.", "Value"].map((value, offset) => ({ ref: at(offset, header), value })),
      ...lines.flatMap(([label, systems, invoiceValue, amount], index): FixtureCell[] => [
        { ref: at(0, header + 1 + index), value: index + 1 },
        { ref: at(1, header + 1 + index), value: label, style: invoiceValue === undefined ? 2 : 1 },
        { ref: at(2, header + 1 + index), value: systems },
        ...(invoiceValue === undefined ? [] : [{ ref: at(3, header + 1 + index), value: invoiceValue }]),
        { ref: at(4, header + 1 + index), value: amount },
      ]),
      { ref: at(0, header + 6), value: "Total" },
      { ref: at(4, header + 6), value: sum, formula: "SUM()" },
    ];
  };
  const schedule = workbook("Schedule", [
    { ref: "A2", value: "SCHEDULE" },
    ...block("A", 5, "2026-01-01", [["ALPHA HOTEL FIRE Q3", "FA/FF", 9101, 400]], 400),
    ...block("G", 5, "2026-02-01", [["BT CCTV Q1", "CCTV", 9102, 775]], 775),
    ...block("M", 5, "2026-03-01", [["GAMMA VILLA AUTOMATION Q1", "AUTOMATION", "DONE", 6000]], 6000),
    ...block("A", 15, "2026-04-01", [["ALPHA HOTEL FIRE Q4", "FA", undefined, 400]], 400),
    ...block("G", 15, "2026-05-01", [["BT CCTV Q2", "CCTV", undefined, 775]], 775),
    ...block("M", 15, "2026-06-01", [["GAMMA VILLA AUTOMATION Q2", "AUTOMATION", "DONE", 0]], 0),
    // After the first contract's validity: a possible renewal.
    ...block("A", 25, "2026-07-01", [["ALPHA HOTEL FIRE Q1 ", "FA/FF", undefined, 400]], 400),
    ...block("G", 25, "2026-08-01", [["BT CCTV Q3", "CCTV", undefined, 775]], 775),
    ...block("M", 25, "2026-09-01", [["GAMMA VILLA AUTOMATION Q3", "AUTOMATION", undefined, 6000]], 6000),
    ...block("A", 35, "2026-10-01", [["ALPHA HOTEL FIRE Q2", "FA/FF", undefined, 400]], 400),
    ...block("G", 35, "2026-11-01", [["BT CCTV Q4", "CCTV", undefined, 775]], 775),
    ...block("M", 35, "2026-12-01", [["GAMMA VILLA AUTOMATION Q2", "AUTOMATION", undefined, 0]], 0),
    // A stray serial number on a line with no client.
    { ref: "A38", value: 40 },
  ]);

  const jobRow = (row: number, values: [number, string, string, string, string, string, number | undefined, number | undefined, number | string | undefined]): FixtureCell[] => {
    const [serialNo, status, month, number, client, description, value, profit, invoiceValue] = values;

    return [
      { ref: `A${row}`, value: serialNo }, { ref: `B${row}`, value: status }, { ref: `C${row}`, value: month },
      { ref: `D${row}`, value: number, style: status === "Completed" ? 1 : 2 }, { ref: `E${row}`, value: client }, { ref: `F${row}`, value: description },
      ...(value === undefined ? [{ ref: `G${row}`, style: 1 }] : [{ ref: `G${row}`, value }]),
      { ref: `H${row}`, value: (value ?? 0) * 0.05, formula: row === 5 ? `G${row}*0.05` : "(shared)" },
      { ref: `I${row}`, value: (value ?? 0) * 1.05, formula: row === 5 ? `G${row}*1.05` : "(shared)" },
      ...(profit === undefined ? [] : [{ ref: `J${row}`, value: profit }]),
      ...(invoiceValue === undefined ? [] : [{ ref: `K${row}`, value: invoiceValue }]),
    ];
  };
  const jobs = workbook("Register", [
    { ref: "A3", value: 2025 },
    ...["S. No", "Status", "Month", "Job Number", "Client", "Job Description", "Job Value", "VAT", "Grand Job Value", "PROFIT", "INVOICE NUMBER"].map((value, index) => ({
      ref: `${"ABCDEFGHIJK"[index]}4`,
      value,
    })),
    ...jobRow(5, [101, "Completed", "JAN", "JOB0101", "ALPHA HOTEL", "Detector supply", 240, 50, 9001]),
    ...jobRow(6, [102, "Completed", "JAN", "JOB0102", "ECHO ", "Panel repair", 1577.276, undefined, "9002, 9003"]),
    ...jobRow(7, [103, "Completed", "FEB", "JOB0103", "ECHO", "Loop detector", 33.333, undefined, 9004]),
    ...jobRow(8, [104, "Completed", "FEB", "JOB0104", "FOXTROT", "Hydrant supply", 610, undefined, 9004]),
    // The same number on two rows; the first has the serial of the missing number.
    ...jobRow(9, [105, "Completed", "FEB", "JOB0109", "HOTEL INDIA", "Spares", 230, undefined, 9005]),
    ...jobRow(10, [106, "Completed", "MAR", "JOB0106", "ALPHA HOTEL", "Gate rectification", 0, undefined, undefined]),
    ...jobRow(11, [107, "Completed", "MAR", "JOB0107", "ALPHA HOTEL", "Alarm rectification", 0, undefined, undefined]),
    ...jobRow(12, [108, "Completed", "MAY", "JOB0108", "JULIET", "Building rectification", undefined, undefined, undefined]),
    ...jobRow(13, [109, "Completed", "FEB", "JOB0109", "KILO HOTEL", "Panel repair", 576, undefined, 9006]),
    ...jobRow(14, [110, "Not Completed", "JUNE", "JOB0110", "GAMMA HOLDINGS", "Home automation", 5000, undefined, undefined]),
    ...jobRow(15, [111, "Completed", "JULY", "JOB0111", "DELTAHOUSE", "Valve works", 265, undefined, undefined]),
    ...jobRow(16, [112, "Completed", "DEC", "JOB0112", "DELTA HOUSE", "Generator", 1850, undefined, "DONE"]),
    ...jobRow(17, [113, "Not Completed", "DEC", "JOB0113", "DELTA HOUSE", "CCTV and fire", 500, undefined, undefined]),
    ...jobRow(18, [114, "Completed", "SEP", "JOB0114", "BT", "Speakers", 570, undefined, undefined]),
    { ref: "A20", value: "Total" },
    { ref: "G20", value: 240 + 1577.276 + 33.333 + 610 + 230 + 576 + 5000 + 265 + 1850 + 500 + 570, formula: "SUM(G5:G19)" },
    // A stray value beside the table.
    { ref: "N10", value: 3 },
  ]);

  const directory = mkdtempSync(path.join(tmpdir(), "stslv-legacy-import-"));
  const write = (file: string, sheet: string, buffer: Buffer) => {
    writeFileSync(path.join(directory, file), buffer);

    return { file, sheet, sha256: createHash("sha256").update(buffer).digest("hex") };
  };

  return {
    directory,
    config: {
      sourceDirectory: directory,
      workbooks: {
        contracts: write("Contracts.xlsx", "Contracts", contracts),
        schedule: write("Schedule.xlsx", "Schedule", schedule),
        jobs: write("Jobs.xlsx", "Register", jobs),
      },
      approvedClientAliases: [],
    },
  };
}
