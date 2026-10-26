import path from "node:path";
import pdfMake = require("pdfmake");
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { BRAND, COMPANY_NAME, SYSTEM_NAME, artworkHeight, footerArtwork, headerArtwork } from "./branding";
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

// The company PDF. Every page carries the official header artwork across the
// top and the official footer artwork across the bottom, each over the full
// width of the page and in its own proportions. The report's own lines sit
// between them: title and period under the header; what the report is, who made
// it and the page number above the footer. The page margins are worked out from
// the height of the artwork, so the content can never run into either.
// Tables repeat their headings on each page and never split a row.

const hex = (rgb: string) => `#${rgb}`;

// A4 in points.
const PAGE = { portrait: { width: 595.28, height: 841.89 }, landscape: { width: 841.89, height: 595.28 } };
const SIDE_MARGIN = 28;
/** The band under the header artwork that holds the report title and period. */
const TITLE_BAND = 30;
/** The band above the footer artwork that holds the disclaimer, the generation line and the page number. */
const FOOT_BAND = 28;
const FOOT_TEXT_TOP = 4;
const FOOT_FONT_SIZE = 7;
const LINE_HEIGHT = 1.15;

/** Where everything sits on a page of the given orientation, in points. */
export function pageLayout(orientation: ReportDefinition["orientation"]) {
  const page = PAGE[orientation];
  const headerHeight = artworkHeight(headerArtwork(), page.width);
  const footerHeight = artworkHeight(footerArtwork(), page.width);

  return {
    page,
    headerHeight,
    footerHeight,
    marginTop: Math.ceil(headerHeight + TITLE_BAND),
    marginBottom: Math.ceil(footerHeight + FOOT_BAND),
  };
}
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
function columnWidths(columns: ReportColumn[], orientation: ReportDefinition["orientation"]): number[] {
  const available = PAGE[orientation].width - SIDE_MARGIN * 2 - columns.length * CELL_PADDING * 2;
  const total = columns.reduce((sum, column) => sum + column.width, 0);

  return columns.map((column) => Math.floor((available * column.width * 100) / total) / 100);
}

function tableContent(table: ReportTable, report: ReportDefinition, withHeading: boolean): Content[] {
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
    table: { headerRows: 1, dontBreakRows: true, widths: columnWidths(columns, report.orientation), body },
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
  const { page, headerHeight, footerHeight, marginTop, marginBottom } = pageLayout(report.orientation);
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
    content.push(...tableContent(table, report, tables.length > 1));
  }

  return {
    pageSize: "A4",
    pageOrientation: report.orientation,
    pageMargins: [SIDE_MARGIN, marginTop, SIDE_MARGIN, marginBottom],
    info: { title: report.title, author: COMPANY_NAME, creator: SYSTEM_NAME, creationDate: report.generatedAt },
    defaultStyle: { font: "Roboto", fontSize: FONT_SIZE, color: hex(BRAND.text), lineHeight: LINE_HEIGHT },
    // Each artwork is stored in the file once and drawn on every page.
    images: {
      header: `data:image/png;base64,${headerArtwork().png.toString("base64")}`,
      footer: `data:image/png;base64,${footerArtwork().png.toString("base64")}`,
    },
    // The artwork is drawn on every page at fixed places: the header from the top edge, the footer up from the bottom edge.
    background: () => [
      { image: "header", width: page.width, absolutePosition: { x: 0, y: 0 } },
      { image: "footer", width: page.width, absolutePosition: { x: 0, y: page.height - footerHeight } },
    ],
    header: () => ({
      stack: [
        {
          margin: [SIDE_MARGIN, headerHeight + 6, SIDE_MARGIN, 0],
          columns: [
            { width: "*", text: report.title, bold: true, fontSize: 12, color: hex(BRAND.navy) },
            { width: "auto", text: report.period ? `Period: ${report.period}` : "", fontSize: 8.5, margin: [0, 3, 0, 0], alignment: "right" },
          ],
        },
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      stack: [
        {
          margin: [SIDE_MARGIN, FOOT_TEXT_TOP, SIDE_MARGIN, 0],
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
