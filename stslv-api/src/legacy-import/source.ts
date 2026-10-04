import { readMoney, type Money } from "./money";
import { columnLetters, columnNumber, serialToIsoDate, type Cell, type Sheet } from "./xlsx";

// PARSE: turns the three source sheets into records, one per source row, with
// every value kept exactly as it was read. Nothing is judged or corrected here.
//
// The sheets are located by their headings, not by fixed cell addresses, so a
// register with more or fewer rows is read the same way.

export interface SourceRef {
  workbook: string;
  sheet: string;
  row: number;
  /** The cell the record starts at, where one sheet row holds several records. Otherwise "". */
  cell: string;
}

/** Every value of a source record, by column heading, exactly as read. Null is an empty cell. */
export type RawValues = Record<string, string | null>;

export type InvoiceCell = { kind: "BLANK" } | { kind: "NUMBER"; raw: string } | { kind: "TEXT"; raw: string };

export interface ContractSource {
  ref: SourceRef;
  raw: RawValues;
  serial: string | null;
  engineer: string | null;
  /** "YYYY-MM-DD", or null when the cell is not a date. */
  validFrom: string | null;
  validTo: string | null;
  clientRaw: string | null;
  system: string | null;
  value: Money;
  finalCredit: Money;
}

export interface ScheduleSource {
  ref: SourceRef;
  raw: RawValues;
  /** First day of the month block the row sits in, "YYYY-MM-DD". Null when the block has no date. */
  month: string | null;
  /** The "Client" cell: client, system and period label in one text. */
  label: string;
  systems: string | null;
  invoice: InvoiceCell;
  value: Money;
}

export interface JobSource {
  ref: SourceRef;
  raw: RawValues;
  serial: string | null;
  status: string | null;
  monthText: string | null;
  jobNumber: string | null;
  clientRaw: string | null;
  description: string | null;
  value: Money;
  /** The VAT cell, kept so the rate it implies can be confirmed. */
  vatCell: Cell | undefined;
  profit: Money;
  invoice: InvoiceCell;
}

export interface SourceTotal {
  ref: SourceRef;
  label: string;
  value: Money;
}

export interface SourceData {
  contracts: ContractSource[];
  schedule: ScheduleSource[];
  jobs: JobSource[];
  /** The year in the title of the job register, which its month names belong to. */
  jobsYear: number | null;
  /** The totals the workbooks show, to check the rows against. */
  totals: { contractValue: SourceTotal | null; finalCredit: SourceTotal | null; jobValue: SourceTotal | null; scheduleBlocks: SourceTotal[] };
  /** Cells that were read and deliberately left out, with the reason. */
  ignored: { ref: SourceRef; note: string }[];
}

const heading = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const textOf = (cell: Cell | undefined): string | null => (cell === undefined || cell.value.trim() === "" ? null : cell.value);

/** A cell as raw text for the audit trail: the stored value, never reformatted. */
function rawOf(cell: Cell | undefined): string | null {
  return cell === undefined ? null : cell.value;
}

function invoiceCell(cell: Cell | undefined): InvoiceCell {
  if (cell === undefined || cell.value.trim() === "") {
    return { kind: "BLANK" };
  }

  return cell.type === "number" ? { kind: "NUMBER", raw: cell.value } : { kind: "TEXT", raw: cell.value };
}

/** The row that holds all the given headings, and the column of each. */
function findHeaderRow(sheet: Sheet, required: string[]): { row: number; columns: Map<string, string>; labels: Map<string, string> } {
  const byRow = new Map<number, Cell[]>();

  for (const cell of sheet.cells.values()) {
    if (cell.type === "text") {
      byRow.set(cell.row, [...(byRow.get(cell.row) ?? []), cell]);
    }
  }

  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const cells = byRow.get(row) as Cell[];
    const columns = new Map(cells.map((cell) => [heading(cell.value), cell.column]));

    if (required.every((name) => columns.has(name))) {
      // The heading as written, with line breaks folded, to label raw values.
      const labels = new Map(cells.map((cell) => [cell.column, cell.value.replace(/\s+/g, " ").trim()]));

      return { row, columns, labels };
    }
  }

  throw new Error(`Sheet "${sheet.name}": the heading row (${required.join(", ")}) was not found.`);
}

/** The first row at or after `from` whose cell in `column` reads "total". */
function totalRow(sheet: Sheet, column: string, from: number): number | null {
  for (let row = from; row <= sheet.maxRow; row += 1) {
    const cell = sheet.cells.get(`${column}${row}`);

    if (cell && cell.type === "text" && heading(cell.value) === "total") {
      return row;
    }
  }

  return null;
}

function rawValues(sheet: Sheet, row: number, labels: Map<string, string>): RawValues {
  const raw: RawValues = {};

  for (const [column, label] of [...labels].sort((a, b) => columnNumber(a[0]) - columnNumber(b[0]))) {
    const cell = sheet.cells.get(`${column}${row}`);

    raw[label] = rawOf(cell);

    if (cell?.formula) {
      raw[`${label} [formula]`] = cell.formula;
    }
  }

  return raw;
}

/** The font colour of a row, taken from the first of the given cells that has one. Colour carries meaning in these registers. */
function fontColour(sheet: Sheet, refs: string[]): string | null {
  for (const ref of refs) {
    const colour = sheet.cells.get(ref)?.fontColor;

    if (colour) {
      return colour;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Contract register
// ---------------------------------------------------------------------------

const CONTRACT_HEADINGS = ["s. no", "engineer", "from (validity)", "to (validity)", "client", "description", "value", "final credit"];

export function parseContracts(workbook: string, sheet: Sheet): Pick<SourceData, "contracts"> & { totals: { contractValue: SourceTotal | null; finalCredit: SourceTotal | null } } {
  const header = findHeaderRow(sheet, CONTRACT_HEADINGS);
  const column = (name: string) => header.columns.get(name) as string;
  const first = column("s. no");
  const end = totalRow(sheet, first, header.row + 1);
  const contracts: ContractSource[] = [];

  for (let row = header.row + 1; row < (end ?? sheet.maxRow + 1); row += 1) {
    const cell = (name: string) => sheet.cells.get(`${column(name)}${row}`);

    // A row of the table that holds nothing is not a record.
    if (CONTRACT_HEADINGS.every((name) => cell(name) === undefined)) {
      continue;
    }

    const from = cell("from (validity)");
    const to = cell("to (validity)");

    contracts.push({
      ref: { workbook, sheet: sheet.name, row, cell: "" },
      raw: rawValues(sheet, row, header.labels),
      serial: textOf(cell("s. no")),
      engineer: textOf(cell("engineer")),
      validFrom: from?.type === "number" ? serialToIsoDate(from.value) : null,
      validTo: to?.type === "number" ? serialToIsoDate(to.value) : null,
      clientRaw: textOf(cell("client")),
      system: textOf(cell("description")),
      value: readMoney(cell("value")),
      finalCredit: readMoney(cell("final credit")),
    });
  }

  const total = (name: string, label: string): SourceTotal | null =>
    end === null ? null : { ref: { workbook, sheet: sheet.name, row: end, cell: `${column(name)}${end}` }, label, value: readMoney(sheet.cells.get(`${column(name)}${end}`)) };

  return { contracts, totals: { contractValue: total("value", "Value"), finalCredit: total("final credit", "FINAL CREDIT") } };
}

// ---------------------------------------------------------------------------
// Maintenance schedule: month blocks side by side, each with its own heading
// ---------------------------------------------------------------------------

const BLOCK_HEADINGS = ["s/n", "client", "systems", "inv. no.", "value"];

export function parseSchedule(workbook: string, sheet: Sheet): Pick<SourceData, "schedule" | "ignored"> & { blockTotals: SourceTotal[] } {
  const schedule: ScheduleSource[] = [];
  const ignored: SourceData["ignored"] = [];
  const blockTotals: SourceTotal[] = [];
  const blocks = [...sheet.cells.values()]
    .filter((cell) => cell.type === "text" && heading(cell.value) === "s/n")
    .sort((a, b) => a.row - b.row || columnNumber(a.column) - columnNumber(b.column));

  if (blocks.length === 0) {
    throw new Error(`Sheet "${sheet.name}": no month block (a row headed ${BLOCK_HEADINGS.join(", ")}) was found.`);
  }

  for (const start of blocks) {
    const columns = BLOCK_HEADINGS.map((_, index) => columnLetters(columnNumber(start.column) + index));
    const labels = new Map<string, string>();

    BLOCK_HEADINGS.forEach((name, index) => {
      const cell = sheet.cells.get(`${columns[index]}${start.row}`);

      if (cell === undefined || heading(cell.value) !== name) {
        throw new Error(`Sheet "${sheet.name}": the month block at ${start.ref} does not have the heading "${name}" in column ${columns[index]}.`);
      }
      labels.set(columns[index] as string, cell.value.replace(/\s+/g, " ").trim());
    });

    const [serialColumn, clientColumn, systemsColumn, invoiceColumn, valueColumn] = columns as [string, string, string, string, string];
    const monthCell = sheet.cells.get(`${serialColumn}${start.row - 1}`);
    const month = monthCell?.type === "number" ? serialToIsoDate(monthCell.value) : null;
    const end = totalRow(sheet, serialColumn, start.row + 1);

    if (end === null) {
      throw new Error(`Sheet "${sheet.name}": the month block at ${start.ref} has no Total row.`);
    }

    for (let row = start.row + 1; row < end; row += 1) {
      const client = sheet.cells.get(`${clientColumn}${row}`);
      const ref: SourceRef = { workbook, sheet: sheet.name, row, cell: `${clientColumn}${row}` };

      if (client === undefined || client.value.trim() === "") {
        // A serial number, or any other value, on a line with no client is not a record.
        for (const column of columns) {
          const stray = sheet.cells.get(`${column}${row}`);

          if (stray) {
            ignored.push({ ref: { ...ref, cell: stray.ref }, note: `value "${stray.value}" on a line of the month block with no client` });
          }
        }
        continue;
      }

      const raw = rawValues(sheet, row, labels);

      raw["[month block]"] = rawOf(monthCell);
      raw["[font colour]"] = fontColour(sheet, [client.ref]);
      schedule.push({
        ref,
        raw,
        month,
        label: client.value,
        systems: textOf(sheet.cells.get(`${systemsColumn}${row}`)),
        invoice: invoiceCell(sheet.cells.get(`${invoiceColumn}${row}`)),
        value: readMoney(sheet.cells.get(`${valueColumn}${row}`)),
      });
    }

    blockTotals.push({
      ref: { workbook, sheet: sheet.name, row: end, cell: `${valueColumn}${end}` },
      label: month ?? start.ref,
      value: readMoney(sheet.cells.get(`${valueColumn}${end}`)),
    });
  }

  return { schedule, ignored, blockTotals };
}

// ---------------------------------------------------------------------------
// Job register
// ---------------------------------------------------------------------------

const JOB_HEADINGS = ["s. no", "status", "month", "job number", "client", "job description", "job value", "vat", "grand job value", "profit", "invoice number"];

export function parseJobs(workbook: string, sheet: Sheet): Pick<SourceData, "jobs" | "jobsYear" | "ignored"> & { total: SourceTotal | null } {
  const header = findHeaderRow(sheet, JOB_HEADINGS);
  const column = (name: string) => header.columns.get(name) as string;
  const first = column("s. no");
  const end = totalRow(sheet, first, header.row + 1);
  const jobs: JobSource[] = [];
  const ignored: SourceData["ignored"] = [];
  const tableColumns = new Set(header.columns.values());
  let jobsYear: number | null = null;

  // The year the month names belong to is the title above the heading row.
  for (const cell of sheet.cells.values()) {
    if (cell.row < header.row && cell.type === "number" && /^(19|20)\d{2}$/.test(cell.value)) {
      jobsYear = Number(cell.value);
    }
  }

  for (let row = header.row + 1; row < (end ?? sheet.maxRow + 1); row += 1) {
    const cell = (name: string) => sheet.cells.get(`${column(name)}${row}`);

    // The VAT and grand value columns are formulas on every line, so they do not make a line a record.
    if (["s. no", "status", "month", "job number", "client", "job description", "job value", "profit", "invoice number"].every((name) => cell(name) === undefined)) {
      continue;
    }

    const raw = rawValues(sheet, row, header.labels);

    raw["[font colour]"] = fontColour(sheet, [`${column("job number")}${row}`, `${column("client")}${row}`]);
    jobs.push({
      ref: { workbook, sheet: sheet.name, row, cell: "" },
      raw,
      serial: textOf(cell("s. no")),
      status: textOf(cell("status")),
      monthText: textOf(cell("month")),
      jobNumber: textOf(cell("job number")),
      clientRaw: textOf(cell("client")),
      description: textOf(cell("job description")),
      value: readMoney(cell("job value")),
      vatCell: cell("vat"),
      profit: readMoney(cell("profit")),
      invoice: invoiceCell(cell("invoice number")),
    });
  }

  // Anything outside the table's columns is reported, not read as data.
  for (const cell of sheet.cells.values()) {
    if (cell.row > header.row && !tableColumns.has(cell.column)) {
      ignored.push({ ref: { workbook, sheet: sheet.name, row: cell.row, cell: cell.ref }, note: `value "${cell.value}" outside the columns of the register` });
    }
  }

  const total: SourceTotal | null =
    end === null
      ? null
      : {
          ref: { workbook, sheet: sheet.name, row: end, cell: `${column("job value")}${end}` },
          label: "Job Value",
          value: readMoney(sheet.cells.get(`${column("job value")}${end}`)),
        };

  return { jobs, jobsYear, ignored, total };
}
