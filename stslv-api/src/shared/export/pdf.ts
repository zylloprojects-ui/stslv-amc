import path from "node:path";
import pdfMake = require("pdfmake");
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { BRAND, COMPANY_NAME, SYSTEM_NAME } from "./branding";
import {
  EMPTY_MESSAGE,
  cleanText,
  displayDate,
  displayGeneratedAt,
  displayMoney,
  displayPercent,
  type CellValue,
  type ColumnKind,
  type ReportColumn,
  type ReportDefinition,
  type ReportTable,
} from "./report";

// The PDF standard for every report the application generates.
//
// Every PDF is A4 landscape, whatever orientation the report declares (that
// setting now only governs how its Excel workbook prints). There is no
// letterhead: no header or footer artwork, no logo, no branded background.
// Each page carries plain report lines only: the title and period at the top
// over a thin rule; under a thin rule at the bottom, the standing disclaimer
// (if any), who generated the report and when, and the page number.
// Tables fill the width between the margins, repeat their headings on each
// page and never split a row; long text wraps inside its column.

const hex = (rgb: string) => `#${rgb}`;

/** A4 landscape in points (297 × 210 mm). */
export const PDF_PAGE = { size: "A4", orientation: "landscape", width: 841.89, height: 595.28 } as const;
const SIDE_MARGIN = 28;
/** Distance from the top edge to the title line. */
const HEAD_TOP = 20;
/** Distance from the top edge to the start of the content; holds the title, period and rule. */
const MARGIN_TOP = 54;
/** Distance from the bottom edge to the end of the content; holds the rule, disclaimer, generation line and page number. */
const MARGIN_BOTTOM = 40;
const FOOT_TEXT_TOP = 8;
const FOOT_FONT_SIZE = 7;
const LINE_HEIGHT = 1.15;

/** Where everything sits on a page, in points. */
export function pageLayout() {
  return {
    page: { width: PDF_PAGE.width, height: PDF_PAGE.height },
    contentWidth: PDF_PAGE.width - SIDE_MARGIN * 2,
    margins: [SIDE_MARGIN, MARGIN_TOP, SIDE_MARGIN, MARGIN_BOTTOM] as [number, number, number, number],
  };
}

/** A thin full-width rule between the margins. */
const rule = (margin: [number, number, number, number] = [0, 0, 0, 0]): Content => ({
  margin,
  canvas: [{ type: "line", x1: 0, y1: 0, x2: PDF_PAGE.width - SIDE_MARGIN * 2, y2: 0, lineWidth: 0.75, lineColor: hex(BRAND.line) }],
});
const CELL_PADDING = 3;
const FONT_SIZE = 8;

// Roboto is shipped inside pdfmake, so no font is downloaded or installed.
const FONT_DIR = path.join(path.dirname(require.resolve("pdfmake/package.json")), "fonts", "Roboto");

pdfMake.setFonts({
  Roboto: {
    normal: path.join(FONT_DIR, "Roboto-Regular.ttf"),
    bold: path.join(FONT_DIR, "Roboto-Medium.ttf"),
    italics: path.join(FONT_DIR, "Roboto-Italic.ttf"),
    bolditalics: path.join(FONT_DIR, "Roboto-MediumItalic.ttf"),
  },
});
// A report is built from data only: it may read the bundled fonts and nothing else, and it never fetches a URL.
pdfMake.setLocalAccessPolicy((file) => path.resolve(file).startsWith(FONT_DIR + path.sep));
pdfMake.setUrlAccessPolicy(() => false);

const isNumeric = (kind: ColumnKind) => kind === "money" || kind === "count" || kind === "percent";

/** A value in words, as it is printed. */
export function pdfText(kind: ColumnKind, value: CellValue): string {
  if (value === null || value === "") {
    return "—";
  }

  const text = cleanText(String(value));

  switch (kind) {
    case "date":
      return displayDate(text);
    case "money":
      return /^-?\d+(\.\d+)?$/.test(text) ? displayMoney(text) : text;
    case "percent":
      return /^\d+(\.\d+)?$/.test(text) ? displayPercent(text) : text;
    default:
      return text;
  }
}

/** Column widths in points: the columns share the width of the page in proportion to their declared widths. */
function columnWidths(columns: ReportColumn[]): number[] {
  const available = PDF_PAGE.width - SIDE_MARGIN * 2 - columns.length * CELL_PADDING * 2;
  const total = columns.reduce((sum, column) => sum + column.width, 0);

  return columns.map((column) => Math.floor((available * column.width * 100) / total) / 100);
}

function tableContent(table: ReportTable, withHeading: boolean): Content[] {
  const columns = table.columns.filter((column) => !column.excelOnly);
  const span = (cell: TableCell): TableCell[] => [cell, ...columns.slice(1).map(() => ({}))];
  const body: TableCell[][] = [
    columns.map((column) => ({
      text: column.header,
      bold: true,
      color: hex(BRAND.white),
      fillColor: hex(BRAND.navy),
      alignment: isNumeric(column.kind) ? "right" : "left",
    })),
  ];
  let group: string | null = null;
  let striped = false;

  for (const row of table.rows) {
    const heading = table.groupBy?.(row) ?? null;

    if (heading !== null && heading !== group) {
      group = heading;
      striped = false;
      body.push(span({ text: heading, colSpan: columns.length, bold: true, color: hex(BRAND.navy), fillColor: hex(BRAND.group) }));
    }

    body.push(
      columns.map((column) => ({
        text: pdfText(column.kind, row[column.pdfKey ?? column.key] ?? null),
        alignment: isNumeric(column.kind) ? "right" : "left",
        ...(striped ? { fillColor: hex(BRAND.zebra) } : {}),
      }))
    );
    striped = !striped;
  }

  if (table.rows.length === 0) {
    body.push(span({ text: EMPTY_MESSAGE, colSpan: columns.length, italics: true, color: hex(BRAND.muted), margin: [0, 8, 0, 8], alignment: "center" }));
  }

  if (table.totals && table.rows.length > 0) {
    const totals = table.totals;
    const firstTotal = columns.findIndex((column) => totals.values[column.key] !== undefined);
    const labelSpan = Math.max(firstTotal, 1);
    const style = { bold: true, color: hex(BRAND.navy), fillColor: hex(BRAND.group) };
    const cells: TableCell[] = [{ text: totals.label, colSpan: labelSpan, alignment: "right", ...style }];

    for (let index = 1; index < columns.length; index += 1) {
      const column = columns[index] as ReportColumn;
      const value = totals.values[column.key];

      cells.push(index < labelSpan ? {} : { text: value === undefined ? "" : pdfText(column.kind, value), alignment: "right", ...style });
    }
    body.push(cells);
  }

  const content: Content[] = [];

  if (withHeading) {
    content.push({ text: table.name, bold: true, fontSize: 10, color: hex(BRAND.navy), margin: [0, 10, 0, 4] });
  }
  // Above the table, so a remark is never left alone on a last page.
  if (table.notes && table.notes.length > 0) {
    content.push({ text: table.notes.map(cleanText).join("  "), italics: true, fontSize: 7.5, color: hex(BRAND.muted), margin: [0, 0, 0, 6] });
  }
  content.push({
    table: { headerRows: 1, dontBreakRows: true, widths: columnWidths(columns), body },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => hex(BRAND.line),
      paddingLeft: () => CELL_PADDING,
      paddingRight: () => CELL_PADDING,
      paddingTop: () => 3.5,
      paddingBottom: () => 3.5,
    },
  });

  return content;
}

export function pdfDefinition(report: ReportDefinition): TDocumentDefinitions {
  const { margins } = pageLayout();
  const generated = `Generated ${displayGeneratedAt(report.generatedAt)} by ${cleanText(report.generatedBy)}  ·  ${SYSTEM_NAME}`;
  const content: Content[] = [];

  if (report.filters.length > 0) {
    content.push({
      margin: [0, 0, 0, 8],
      fontSize: 8,
      text: [
        { text: "Filters:  ", bold: true, color: hex(BRAND.navy) },
        ...report.filters.flatMap((filter, index) => [
          { text: `${index > 0 ? "   ·   " : ""}${filter.label}: `, color: hex(BRAND.muted) },
          { text: cleanText(filter.value) },
        ]),
      ],
    });
  }
  const tables = report.tables.filter((table) => !table.excelOnly);

  for (const table of tables) {
    content.push(...tableContent(table, tables.length > 1));
  }

  return {
    pageSize: PDF_PAGE.size,
    pageOrientation: PDF_PAGE.orientation,
    pageMargins: margins,
    info: { title: report.title, author: COMPANY_NAME, creator: SYSTEM_NAME, creationDate: report.generatedAt },
    defaultStyle: { font: "Roboto", fontSize: FONT_SIZE, color: hex(BRAND.text), lineHeight: LINE_HEIGHT },
    header: () => ({
      margin: [SIDE_MARGIN, HEAD_TOP, SIDE_MARGIN, 0],
      stack: [
        {
          columns: [
            { width: "*", text: report.title, bold: true, fontSize: 12, color: hex(BRAND.navy) },
            { width: "auto", text: report.period ? `Period: ${report.period}` : "", fontSize: 8.5, margin: [12, 3, 0, 0], alignment: "right" },
          ],
        },
        rule([0, 5, 0, 0]),
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      margin: [SIDE_MARGIN, FOOT_TEXT_TOP, SIDE_MARGIN, 0],
      stack: [
        rule(),
        {
          margin: [0, 4, 0, 0],
          fontSize: FOOT_FONT_SIZE,
          color: hex(BRAND.muted),
          columns: [
            {
              width: "*",
              stack: [
                ...(report.disclaimer ? [{ text: report.disclaimer, bold: true, color: hex(BRAND.navy) }] : []),
                { text: generated },
              ],
            },
            { width: 70, alignment: "right", text: `Page ${currentPage} of ${pageCount}` },
          ],
        },
      ],
    }),
    content,
  };
}

export async function renderPdf(report: ReportDefinition): Promise<Buffer> {
  return pdfMake.createPdf(pdfDefinition(report)).getBuffer();
}
