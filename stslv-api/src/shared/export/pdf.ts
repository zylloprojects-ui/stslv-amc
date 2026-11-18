import path from "node:path";
import pdfMake = require("pdfmake");
import type { Content, ContentTable, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { BRAND, COMPANY_NAME, SYSTEM_NAME, artworkHeight, logoArtwork } from "./branding";
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
// setting now only governs how its Excel workbook prints). Each page has a
// short company header: the official logo with the company name in Arabic and
// English (cut from the official artwork, never redrawn) on the left, the
// report title and period on the right, over a green and blue bar in the
// colours of the artwork. At the bottom, over a thin blue rule: the standing
// disclaimer (if any), who generated the report and when, and the page number.
// No background and no full-width artwork, so the data keeps the page.
// Tables have a navy heading row and a navy outer border with light inner
// grid lines; they fill the width between the margins, repeat their headings
// on each page and never split a row; long text wraps inside its column.

const hex = (rgb: string) => `#${rgb}`;

/** A4 landscape in points (297 × 210 mm). */
export const PDF_PAGE = { size: "A4", orientation: "landscape", width: 841.89, height: 595.28 } as const;
const SIDE_MARGIN = 28;
/** Distance from the top edge to the logo and title. */
const HEAD_TOP = 16;
/** Printed height of the logo, in points: short, so the data keeps the page. */
export const LOGO_HEIGHT = 30;
/** Distance from the top edge to the start of the content; holds the logo, title, period and brand bar. */
const MARGIN_TOP = 70;
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
const rule = (margin: [number, number, number, number] = [0, 0, 0, 0], colour: string = BRAND.line): Content => ({
  margin,
  canvas: [{ type: "line", x1: 0, y1: 0, x2: PDF_PAGE.width - SIDE_MARGIN * 2, y2: 0, lineWidth: 0.75, lineColor: hex(colour) }],
});
/** The brand bar under the header: a green line over a blue one, like the swoosh of the official artwork. */
const brandBar = (): Content => {
  const width = PDF_PAGE.width - SIDE_MARGIN * 2;

  return {
    margin: [0, 6, 0, 0],
    canvas: [
      { type: "rect", x: 0, y: 0, w: width, h: 2.2, color: hex(BRAND.green) },
      { type: "rect", x: 0, y: 3.2, w: width, h: 1.2, color: hex(BRAND.blue) },
    ],
  };
};
const CELL_PADDING = 3;
const CELL_PADDING_V = 3.5;
const FONT_SIZE = 8;
const LINE_WIDTH = 0.5;
const OUTER_LINE_WIDTH = 0.9;

/** The number of columns of a table: its first row has one cell (or colSpan placeholder) per column. */
const columnCount = (node: ContentTable): number => node.table.body[0]?.length ?? 0;

/**
 * Borders: a navy frame round the table and under its heading row, light lines between rows and columns.
 * `hLineWidth` decides which horizontal lines are drawn inside (a group block draws only its own middle line).
 */
const tableLayout = (hLineWidth: (index: number, rows: number) => number, framed = true) => ({
  hLineWidth: (index: number, node: ContentTable) => {
    const rows = node.table.body.length;

    return framed && (index === 0 || index === rows || index === 1) ? OUTER_LINE_WIDTH : hLineWidth(index, rows);
  },
  vLineWidth: (index: number, node: ContentTable) => {
    const columns = columnCount(node);

    return framed ? (index === 0 || index === columns ? OUTER_LINE_WIDTH : LINE_WIDTH) : LINE_WIDTH;
  },
  hLineColor: (index: number, node: ContentTable) =>
    framed && (index === 0 || index === 1 || index === node.table.body.length) ? hex(BRAND.navy) : hex(BRAND.line),
  vLineColor: (index: number, node: ContentTable) =>
    framed && (index === 0 || index === columnCount(node)) ? hex(BRAND.navy) : hex(BRAND.line),
  paddingLeft: () => CELL_PADDING,
  paddingRight: () => CELL_PADDING,
  paddingTop: () => CELL_PADDING_V,
  paddingBottom: () => CELL_PADDING_V,
});

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
  const widths = columnWidths(columns);
  const dataRow = (row: ReportTable["rows"][number], striped: boolean): TableCell[] =>
    columns.map((column) => ({
      text: pdfText(column.kind, row[column.pdfKey ?? column.key] ?? null),
      alignment: isNumeric(column.kind) ? "right" : "left",
      ...(striped ? { fillColor: hex(BRAND.zebra) } : {}),
    }));
  let group: string | null = null;
  let striped = false;

  for (const row of table.rows) {
    const heading = table.groupBy?.(row) ?? null;

    if (heading !== null && heading !== group) {
      group = heading;
      striped = false;
      // A group heading is never left alone at the foot of a page: it and the
      // group's first row are one row of the table, and a row is never split.
      // That row holds a table of its own, with the same columns, padding and
      // lines; the negative margin takes away the outer cell's padding so its
      // columns line up exactly with the rows around it.
      body.push(
        span({
          colSpan: columns.length,
          margin: [-CELL_PADDING, -CELL_PADDING_V, -CELL_PADDING, -CELL_PADDING_V],
          table: {
            widths,
            body: [
              [{ text: heading, colSpan: columns.length, bold: true, color: hex(BRAND.navy), fillColor: hex(BRAND.group) }, ...columns.slice(1).map(() => ({}))],
              dataRow(row, false),
            ],
          },
          // Only the line between the heading and the row: the outer table draws the lines above and below.
          layout: tableLayout((index) => (index === 1 ? LINE_WIDTH : 0), false),
        })
      );
    } else {
      body.push(dataRow(row, striped));
    }
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
    content.push({
      margin: [0, 12, 0, 5],
      columns: [
        { width: 3, canvas: [{ type: "rect", x: 0, y: 0, w: 3, h: 12, color: hex(BRAND.green) }] },
        { width: "*", text: table.name, bold: true, fontSize: 10.5, color: hex(BRAND.navy), margin: [6, 0, 0, 0] },
      ],
    });
  }
  // Above the table, so a remark is never left alone on a last page.
  if (table.notes && table.notes.length > 0) {
    content.push({ text: table.notes.map(cleanText).join("  "), italics: true, fontSize: 7.5, color: hex(BRAND.muted), margin: [0, 0, 0, 6] });
  }
  content.push({
    table: { headerRows: 1, dontBreakRows: true, widths, body },
    layout: tableLayout(() => LINE_WIDTH),
  });

  return content;
}

export function pdfDefinition(report: ReportDefinition): TDocumentDefinitions {
  const { margins } = pageLayout();
  const logo = logoArtwork();
  const logoWidth = Math.round((LOGO_HEIGHT * logo.width) / logo.height);
  const generated = `Generated ${displayGeneratedAt(report.generatedAt)} by ${cleanText(report.generatedBy)}  ·  ${SYSTEM_NAME}`;
  const content: Content[] = [];

  if (report.filters.length > 0) {
    // The filters applied, in a light panel with a blue edge, so the reader knows what the figures cover.
    content.push({
      margin: [0, 0, 0, 10],
      table: {
        widths: ["*"],
        body: [
          [
            {
              fillColor: hex(BRAND.zebra),
              fontSize: 8,
              margin: [4, 2, 4, 2],
              text: [
                { text: "Filters applied:  ", bold: true, color: hex(BRAND.navy) },
                ...report.filters.flatMap((filter, index) => [
                  { text: `${index > 0 ? "   ·   " : ""}${filter.label}: `, color: hex(BRAND.muted) },
                  { text: cleanText(filter.value), bold: true },
                ]),
              ],
            },
          ],
        ],
      },
      layout: {
        hLineWidth: () => LINE_WIDTH,
        vLineWidth: (index: number) => (index === 0 ? 3 : LINE_WIDTH),
        hLineColor: () => hex(BRAND.line),
        vLineColor: (index: number) => (index === 0 ? hex(BRAND.blue) : hex(BRAND.line)),
      },
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
    images: { logo: `data:image/png;base64,${logo.png.toString("base64")}` },
    header: () => ({
      margin: [SIDE_MARGIN, HEAD_TOP, SIDE_MARGIN, 0],
      stack: [
        {
          columns: [
            { width: logoWidth, image: "logo", fit: [logoWidth, LOGO_HEIGHT] },
            {
              width: "*",
              alignment: "right",
              stack: [
                { text: report.title, bold: true, fontSize: 13, color: hex(BRAND.navy), lineHeight: 1 },
                {
                  text: report.period ? `Period: ${report.period}` : SYSTEM_NAME,
                  fontSize: 8.5,
                  color: hex(BRAND.blue),
                  bold: Boolean(report.period),
                  margin: [0, 3, 0, 0],
                },
              ],
              margin: [16, 2, 0, 0],
            },
          ],
        },
        brandBar(),
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      margin: [SIDE_MARGIN, FOOT_TEXT_TOP, SIDE_MARGIN, 0],
      stack: [
        rule([0, 0, 0, 0], BRAND.blue),
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
