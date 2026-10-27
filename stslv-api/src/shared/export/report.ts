import { z } from "zod";
import { AppError } from "../errors";
import { REPORT_TIME_ZONE, REPORT_TIME_ZONE_LABEL } from "./branding";

// A report is described once, as data, and the Excel and PDF renderers both
// draw it. A module that exports something supplies a ReportDefinition and
// nothing else: it never touches a workbook or a page.

export const EXPORT_FORMATS = ["xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const exportFormatSchema = z.enum(EXPORT_FORMATS, { error: "Choose Excel (xlsx) or PDF (pdf)." });

/**
 * What a column holds, which decides how it is written:
 *   text        free text
 *   identifier  a reference such as a job or invoice number: always text, so leading zeros survive
 *   date        a calendar day as YYYY-MM-DD
 *   money       a decimal string with up to three decimals, as PostgreSQL returns numeric
 *   count       a whole number
 *   percent     percentage points as a decimal string ("5.000" is 5%)
 */
export type ColumnKind = "text" | "identifier" | "date" | "money" | "count" | "percent";

export type CellValue = string | number | null;
export type ReportRow = Record<string, CellValue>;

export interface ReportColumn {
  key: string;
  header: string;
  kind: ColumnKind;
  /** Excel column width in characters. In a PDF the columns share the page width in the same proportions. */
  width: number;
  /** Long text that should wrap inside its cell. */
  wrap?: true;
  /** Left out of the PDF, where the page has no room for it. */
  excelOnly?: true;
  /** The row key the PDF reads instead of `key`, when the two formats word a value differently. */
  pdfKey?: string;
}

export interface ReportTotals {
  label: string;
  /** Totals by column key, calculated by PostgreSQL. */
  values: Record<string, string>;
  /**
   * The Excel formula that gives the same figure, by column key, so the total
   * stays live in the workbook. `range` is the data range of a column, for
   * example "K7:K16". A column without a formula gets the figure itself.
   */
  excelFormulas?: Record<string, (range: (key: string) => string) => string>;
}

export interface ReportTable {
  /** The worksheet name, and the section heading in a PDF that has several tables. */
  name: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportTotals;
  /** The table is a worksheet of the workbook only: detail that a PDF has no room for. */
  excelOnly?: true;
  /** PDF only: rows are grouped under a heading whenever this text changes. Rows must already be in that order. */
  groupBy?: (row: ReportRow) => string;
  /** Short remarks printed under the table. */
  notes?: string[];
}

export interface ReportDefinition {
  title: string;
  /** The reporting period in words, or null when the report has none. */
  period: string | null;
  /** The filters that were applied, in words. */
  filters: { label: string; value: string }[];
  generatedAt: Date;
  /** The full name of the user who asked for the export. */
  generatedBy: string;
  orientation: "portrait" | "landscape";
  tables: ReportTable[];
  /** A standing remark printed with the report, for example that it is not a tax invoice. */
  disclaimer?: string;
  /** The start of the file name, in lower case with hyphens: "amc-schedule". */
  fileStem: string;
}

export const EMPTY_MESSAGE = "No records match the selected filters.";

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

/** A PDF of thousands of rows is not readable and is slow to lay out; Excel is the format for bulk data. */
export const EXPORT_ROW_LIMITS: Record<ExportFormat, number> = { xlsx: 50_000, pdf: 2_000 };

export function assertExportSize(format: ExportFormat, rowCount: number): void {
  const limit = EXPORT_ROW_LIMITS[format];

  if (rowCount > limit) {
    throw new AppError(
      422,
      "EXPORT_TOO_LARGE",
      format === "pdf"
        ? `This export has ${rowCount} rows; a PDF can hold at most ${limit}. Narrow the filters or export to Excel.`
        : `This export has ${rowCount} rows; an Excel export can hold at most ${limit}. Narrow the filters.`
    );
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Control characters other than tab and line break have no place in a document and can corrupt a workbook.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "").replace(/\r\n?/g, "\n");
}

/**
 * Spreadsheet formula injection: text that starts with =, +, -, @, a tab or a
 * line break can be run as a formula when the workbook is saved as CSV or the
 * cell is re-entered. Such text is written with a leading apostrophe, which
 * every spreadsheet program reads as "this is text".
 */
export function excelSafeText(value: string): string {
  const text = cleanText(value);

  return /^[=+\-@\t\n]/.test(text) ? `'${text}` : text;
}

// ---------------------------------------------------------------------------
// Values in words
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2027-01-05" becomes "05 Jan 2027", the way the application shows a date. */
export function displayDate(value: string): string {
  const match = DATE_PATTERN.exec(value);

  return match ? `${match[3]} ${MONTHS[Number(match[2]) - 1]} ${match[1]}` : value;
}

/** "2027-01-05" becomes "January 2027". */
export function displayMonth(value: string): string {
  const match = DATE_PATTERN.exec(value);

  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : value;
}

/** "1234.5" becomes "1,234.500". Text handling only: the figure is never turned into a floating-point number. */
export function displayMoney(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");

  return `${negative ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(3, "0").slice(0, 3)}`;
}

/** "5.000" becomes "5%", "7.500" becomes "7.5%". */
export function displayPercent(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");

  return `${whole}${trimmed ? `.${trimmed}` : ""}%`;
}

/** A period in words from an optional first and last day. */
export function displayPeriod(from: string | null | undefined, to: string | null | undefined): string {
  if (from && to) {
    return `${displayDate(from)} to ${displayDate(to)}`;
  }
  if (from) {
    return `From ${displayDate(from)}`;
  }
  if (to) {
    return `Up to ${displayDate(to)}`;
  }

  return "All dates";
}

function zonedParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** "04 Oct 2026, 14:32 Oman time": when the report was made, in the business time zone. */
export function displayGeneratedAt(date: Date): string {
  const p = zonedParts(date);

  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute} ${REPORT_TIME_ZONE_LABEL}`;
}

/** "04 Oct 2026": the day the report was made, in the business time zone. */
export function displayToday(date: Date): string {
  const p = zonedParts(date);

  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export const contentType = (format: ExportFormat): string => CONTENT_TYPES[format];

/** "amc-schedule_20261004-1432.xlsx". Built from fixed text and the clock only, never from user input. */
export function exportFileName(report: Pick<ReportDefinition, "fileStem" | "generatedAt">, format: ExportFormat): string {
  const p = zonedParts(report.generatedAt);
  const stem = report.fileStem.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "export";

  return `${stem}_${p.year}${p.month}${p.day}-${p.hour}${p.minute}.${format}`;
}
