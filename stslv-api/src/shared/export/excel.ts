import ExcelJS from "exceljs";
import JSZip from "jszip";
import { BRAND, COMPANY_NAME, SYSTEM_NAME, artworkHeight, footerArtwork, headerArtwork } from "./branding";
import {
  EMPTY_MESSAGE,
  cleanText,
  displayGeneratedAt,
  excelSafeText,
  type CellValue,
  type ColumnKind,
  type ReportColumn,
  type ReportDefinition,
  type ReportTable,
} from "./report";

// The company workbook. Every sheet has the same shape:
//   row 1     the official header artwork (on screen)
//   rows 2-4  report title; period and filters; what the report is, when and by whom it was made
//   row 6     column headings (frozen, with filters)
//   row 7 on  the data, then the totals, any notes and the official footer artwork (on screen)
//
// On paper the artwork is the page header and page footer of every printed
// page, which is the one place Excel repeats a picture. The pictures in the
// sheet itself are for the screen and are not printed, so nothing prints twice.

const FONT = "Calibri";
/** The row that holds the column headings. */
export const HEADER_ROW = 6;
const FIRST_DATA_ROW = HEADER_ROW + 1;
/** The first row that is printed: the rows above it hold the on-screen artwork. */
const FIRST_PRINTED_ROW = 2;
/** The width of the artwork on screen, in pixels. */
const SCREEN_ART_WIDTH = 760;

// The sheet is set to A4, but a printer loaded with Letter paper prints on Letter. The printed artwork is
// sized to the narrower of the two in each orientation (points), so it is never cut off at the sides.
const PRINT_WIDTH = { portrait: 595.28, landscape: 792 };
const PRINT_SIDE_MARGIN = 20;
const PRINT_EDGE = 14;
const PRINT_GAP = 10;
const POINTS_PER_INCH = 72;

const argb = (rgb: string) => `FF${rgb}`;
const solid = (rgb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(rgb) } });
const thin = (rgb: string): Partial<ExcelJS.Border> => ({ style: "thin", color: { argb: argb(rgb) } });
const GRID: Partial<ExcelJS.Borders> = { top: thin(BRAND.line), bottom: thin(BRAND.line), left: thin(BRAND.line), right: thin(BRAND.line) };

const NUMBER_FORMATS: Record<ColumnKind, string | null> = {
  text: null,
  // Text format: Excel never reinterprets "000123" or "1E5" as a number.
  identifier: "@",
  date: "dd-mmm-yyyy",
  money: "#,##0.000",
  count: "#,##0",
  percent: "0.###%",
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * The value written to a cell. Dates, amounts and counts are written as real
 * dates and numbers so they can be sorted, filtered and summed in Excel; all
 * other values are text, made safe against formula injection.
 */
export function excelValue(kind: ColumnKind, value: CellValue): ExcelJS.CellValue {
  if (value === null || value === "") {
    return null;
  }

  if (kind === "date") {
    const match = typeof value === "string" ? DATE_PATTERN.exec(value) : null;

    // Midnight UTC: Excel then shows exactly this calendar day, whatever the time zone of the computer.
    return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : excelSafeText(String(value));
  }
  if (kind === "money" || kind === "count" || kind === "percent") {
    if (typeof value === "number") {
      return kind === "percent" ? value / 100 : value;
    }
    if (!DECIMAL_PATTERN.test(value)) {
      return excelSafeText(value);
    }

    // numeric(14,3) has at most 14 significant digits, which a double holds exactly.
    return kind === "percent" ? Number(value) / 100 : Number(value);
  }

  return excelSafeText(String(value));
}

/** Excel limits a sheet name to 31 characters and forbids \ / ? * [ ] : */
function sheetName(name: string, taken: Set<string>): string {
  const base = cleanText(name).replace(/[\\/?*[\]:]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Sheet";
  let candidate = base;

  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;

    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  taken.add(candidate.toLowerCase());

  return candidate;
}

function alignment(column: ReportColumn): Partial<ExcelJS.Alignment> {
  const numeric = column.kind === "money" || column.kind === "count" || column.kind === "percent";

  // A right-aligned figure keeps a small gap from the text of the next column.
  return { horizontal: numeric ? "right" : "left", vertical: "top", wrapText: column.wrap === true, ...(numeric ? { indent: 1 } : {}) };
}

/** The printed size of the artwork and the page margins that keep the data clear of it, in points. */
export function printLayout(orientation: ReportDefinition["orientation"]) {
  const artWidth = PRINT_WIDTH[orientation] - PRINT_SIDE_MARGIN * 2;
  const headerHeight = artworkHeight(headerArtwork(), artWidth);
  const footerHeight = artworkHeight(footerArtwork(), artWidth);

  return {
    artWidth,
    headerHeight,
    footerHeight,
    marginTop: PRINT_EDGE + headerHeight + PRINT_GAP,
    marginBottom: PRINT_EDGE + footerHeight + PRINT_GAP,
  };
}

function writeBanner(sheet: ExcelJS.Worksheet, report: ReportDefinition, headerId: number, columnCount: number): void {
  const context = [
    ...(report.period ? [`Period: ${report.period}`] : []),
    ...report.filters.map((filter) => `${filter.label}: ${filter.value}`),
  ].join("   ·   ");
  const generated = `Generated ${displayGeneratedAt(report.generatedAt)} by ${report.generatedBy}   ·   ${SYSTEM_NAME}`;
  const lines: { text: string; font: Partial<ExcelJS.Font>; height: number }[] = [
    { text: report.title, font: { name: FONT, size: 14, bold: true, color: { argb: argb(BRAND.navy) } }, height: 22 },
    { text: context, font: { name: FONT, size: 10, color: { argb: argb(BRAND.text) } }, height: 16 },
    {
      text: report.disclaimer ? `${report.disclaimer}   ·   ${generated}` : generated,
      font: { name: FONT, size: 9, color: { argb: argb(BRAND.muted) } },
      height: 15,
    },
  ];
  const art = headerArtwork();
  const artHeight = artworkHeight(art, SCREEN_ART_WIDTH);

  // Row 1 is exactly as tall as the artwork (a pixel is three quarters of a point).
  sheet.getRow(1).height = Math.ceil(artHeight * 0.75) + 4;
  sheet.addImage(headerId, { tl: { col: 0, row: 0 }, ext: { width: SCREEN_ART_WIDTH, height: artHeight }, editAs: "absolute" });

  lines.forEach((line, index) => {
    const row = sheet.getRow(FIRST_PRINTED_ROW + index);
    const cell = row.getCell(1);

    row.height = line.height;
    cell.value = excelSafeText(line.text);
    cell.font = line.font;
    cell.alignment = { vertical: "middle" };
  });

  // A rule under the banner, in the brand blue.
  const rule = sheet.getRow(HEADER_ROW - 1);

  rule.height = 6;
  for (let column = 1; column <= columnCount; column += 1) {
    rule.getCell(column).border = { top: { style: "medium", color: { argb: argb(BRAND.blue) } } };
  }
}

/** Writes the headings, the data, the totals and the notes. Returns the last row it used. */
function writeTable(sheet: ExcelJS.Worksheet, table: ReportTable): number {
  const { columns, rows } = table;
  const header = sheet.getRow(HEADER_ROW);

  header.height = 24;
  columns.forEach((column, index) => {
    const cell = header.getCell(index + 1);

    sheet.getColumn(index + 1).width = column.width;
    cell.value = column.header;
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: argb(BRAND.white) } };
    cell.fill = solid(BRAND.navy);
    cell.border = GRID;
    cell.alignment = { horizontal: alignment(column).horizontal ?? "left", vertical: "middle", wrapText: true };
  });

  rows.forEach((row, rowIndex) => {
    const sheetRow = sheet.getRow(FIRST_DATA_ROW + rowIndex);

    columns.forEach((column, index) => {
      const cell = sheetRow.getCell(index + 1);
      const format = NUMBER_FORMATS[column.kind];

      cell.value = excelValue(column.kind, row[column.key] ?? null);
      cell.font = { name: FONT, size: 10, color: { argb: argb(BRAND.text) } };
      cell.border = GRID;
      cell.alignment = alignment(column);
      if (format) {
        cell.numFmt = format;
      }
      if (rowIndex % 2 === 1) {
        cell.fill = solid(BRAND.zebra);
      }
    });
  });

  const lastDataRow = FIRST_DATA_ROW + rows.length - 1;
  let next = Math.max(lastDataRow, HEADER_ROW) + 1;

  // The filter covers the headings and the data only, so sorting never moves the totals.
  sheet.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: Math.max(lastDataRow, HEADER_ROW), column: columns.length } };

  if (rows.length === 0) {
    const cell = sheet.getRow(next).getCell(1);

    cell.value = EMPTY_MESSAGE;
    cell.font = { name: FONT, size: 10, italic: true, color: { argb: argb(BRAND.muted) } };
    next += 1;
  }

  if (table.totals && rows.length > 0) {
    const totals = table.totals;
    const totalsRow = sheet.getRow(next);
    const letter = (key: string) => sheet.getColumn(columns.findIndex((column) => column.key === key) + 1).letter;
    const range = (key: string) => `${letter(key)}${FIRST_DATA_ROW}:${letter(key)}${lastDataRow}`;
    const firstTotal = columns.findIndex((column) => totals.values[column.key] !== undefined);

    columns.forEach((column, index) => {
      const cell = totalsRow.getCell(index + 1);
      const value = totals.values[column.key];

      cell.font = { name: FONT, size: 10, bold: true, color: { argb: argb(BRAND.navy) } };
      cell.fill = solid(BRAND.group);
      cell.border = { top: { style: "medium", color: { argb: argb(BRAND.navy) } }, bottom: thin(BRAND.line) };

      if (value !== undefined) {
        const formula = totals.excelFormulas?.[column.key];
        const figure = excelValue(column.kind, value);

        // The formula keeps the total live in Excel; the figure PostgreSQL calculated is stored as its result.
        cell.value = formula && typeof figure === "number" ? { formula: formula(range), result: figure } : figure;
        cell.numFmt = NUMBER_FORMATS[column.kind] ?? "General";
        cell.alignment = { horizontal: "right", vertical: "middle", indent: 1 };
      } else if (index === Math.max(firstTotal - 1, 0)) {
        cell.value = totals.label;
        cell.alignment = { horizontal: "right", vertical: "middle" };
      }
    });
    next += 1;
  }

  for (const note of table.notes ?? []) {
    const cell = sheet.getRow(next + 1).getCell(1);

    cell.value = excelSafeText(note);
    cell.font = { name: FONT, size: 9, italic: true, color: { argb: argb(BRAND.muted) } };
    next += 1;
  }

  return next;
}

// ---------------------------------------------------------------------------
// Printed header and footer artwork
//
// Excel keeps a picture in a page header or footer as a VML drawing attached to
// the sheet. The library that writes the workbook has no call for that, so the
// parts are added to the finished file here. Nothing else in the file changes.
// ---------------------------------------------------------------------------

const VML_SHAPE_TYPE = `<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f">
  <v:stroke joinstyle="miter"/>
  <v:formulas>
   <v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/><v:f eqn="sum 0 0 @1"/><v:f eqn="prod @2 1 2"/>
   <v:f eqn="prod @3 21600 pixelWidth"/><v:f eqn="prod @3 21600 pixelHeight"/><v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/>
   <v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/><v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/>
  </v:formulas>
  <v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/>
  <o:lock v:ext="edit" aspectratio="t"/>
 </v:shapetype>`;

/** The drawing that puts the artwork in the centre header (CH) and centre footer (CF) of one sheet. */
function headerFooterVml(sheetNumber: number, layout: ReturnType<typeof printLayout>): string {
  const shape = (id: string, serial: number, relation: string, title: string, height: number) =>
    `<v:shape id="${id}" o:spid="_x0000_s${sheetNumber * 1024 + serial}" type="#_x0000_t75" style='position:absolute;margin-left:0;margin-top:0;width:${layout.artWidth.toFixed(2)}pt;height:${height.toFixed(2)}pt;z-index:${serial}'>
  <v:imagedata o:relid="${relation}" o:title="${title}"/>
  <o:lock v:ext="edit" rotation="t"/>
 </v:shape>`;

  return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
 <o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${sheetNumber}"/></o:shapelayout>
 ${VML_SHAPE_TYPE}
 ${shape("CH", 1, "rId1", "report-header", layout.headerHeight)}
 ${shape("CF", 2, "rId2", "report-footer", layout.footerHeight)}
</xml>`;
}

const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function addPrintedArtwork(file: Buffer, sheetCount: number, orientation: ReportDefinition["orientation"]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(file);
  const read = async (name: string): Promise<string> => {
    const entry = zip.file(name);

    if (!entry) {
      throw new Error(`The workbook has no ${name}.`);
    }

    return entry.async("string");
  };
  const layout = printLayout(orientation);

  zip.file("xl/media/report-header-print.png", headerArtwork().png);
  zip.file("xl/media/report-footer-print.png", footerArtwork().png);

  const types = await read("[Content_Types].xml");

  if (!types.includes('Extension="vml"')) {
    zip.file("[Content_Types].xml", types.replace("<Default ", '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default '));
  }

  for (let number = 1; number <= sheetCount; number += 1) {
    const sheetPath = `xl/worksheets/sheet${number}.xml`;
    const relsPath = `xl/worksheets/_rels/sheet${number}.xml.rels`;
    const sheet = await read(sheetPath);
    const rels = await read(relsPath);

    if (!/<drawing r:id="[^"]+"\/>/.test(sheet) || !sheet.includes("<headerFooter")) {
      throw new Error(`Sheet ${number} is not laid out as expected.`);
    }

    zip.file(`xl/drawings/vmlDrawingHF${number}.vml`, headerFooterVml(number, layout));
    zip.file(
      `xl/drawings/_rels/vmlDrawingHF${number}.vml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS}">` +
        `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/image" Target="../media/report-header-print.png"/>` +
        `<Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS}/image" Target="../media/report-footer-print.png"/></Relationships>`
    );
    zip.file(
      relsPath,
      rels.replace("</Relationships>", `<Relationship Id="rIdHF" Type="${OFFICE_RELATIONSHIPS}/vmlDrawing" Target="../drawings/vmlDrawingHF${number}.vml"/></Relationships>`)
    );
    zip.file(
      sheetPath,
      sheet
        // The header and footer keep their own size and span the page, whatever scale the sheet prints at.
        .replace("<headerFooter", '<headerFooter scaleWithDoc="0" alignWithMargins="0"')
        .replace(/(<drawing r:id="[^"]+"\/>)/, '$1<legacyDrawingHF r:id="rIdHF"/>')
    );

    // The pictures placed in the sheet are for the screen only.
    const drawingPath = /Target="\.\.\/drawings\/(drawing\d+\.xml)"/.exec(rels)?.[1];

    if (drawingPath) {
      const drawing = await read(`xl/drawings/${drawingPath}`);

      zip.file(`xl/drawings/${drawingPath}`, drawing.replace(/<xdr:clientData\s*\/>/g, '<xdr:clientData fPrintsWithSheet="0"/>'));
    }
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function renderExcel(report: ReportDefinition): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const names = new Set<string>();
  const layout = printLayout(report.orientation);

  workbook.creator = COMPANY_NAME;
  workbook.company = COMPANY_NAME;
  workbook.title = report.title;
  workbook.created = report.generatedAt;
  workbook.modified = report.generatedAt;

  const headerId = workbook.addImage({ buffer: headerArtwork().png as unknown as ExcelJS.Buffer, extension: "png" });
  const footerId = workbook.addImage({ buffer: footerArtwork().png as unknown as ExcelJS.Buffer, extension: "png" });

  for (const table of report.tables) {
    const sheet = workbook.addWorksheet(sheetName(table.name, names), {
      views: [{ state: "frozen", ySplit: HEADER_ROW, showGridLines: false }],
      pageSetup: {
        paperSize: 9, // A4
        orientation: report.orientation,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
        margins: {
          left: PRINT_SIDE_MARGIN / POINTS_PER_INCH,
          right: PRINT_SIDE_MARGIN / POINTS_PER_INCH,
          // Room for the artwork: the data starts below the header and stops above the footer.
          top: layout.marginTop / POINTS_PER_INCH,
          bottom: layout.marginBottom / POINTS_PER_INCH,
          header: PRINT_EDGE / POINTS_PER_INCH,
          // Excel hangs a header picture down from the header margin and stands a footer picture up from the footer margin.
          footer: PRINT_EDGE / POINTS_PER_INCH,
        },
      },
      // &G is the picture attached to that part of the page.
      headerFooter: { oddHeader: "&C&G", oddFooter: "&C&G" },
    });

    writeBanner(sheet, report, headerId, table.columns.length);

    const lastRow = writeTable(sheet, table);
    const footer = footerArtwork();

    sheet.addImage(footerId, {
      tl: { col: 0, row: lastRow + 1 },
      ext: { width: SCREEN_ART_WIDTH, height: artworkHeight(footer, SCREEN_ART_WIDTH) },
      editAs: "absolute",
    });
    // Printing starts under the on-screen header artwork and stops at the last row of the report. Columns at the
    // end that exist for the workbook only (notes and the like) stay on the screen, so the page keeps a readable size.
    const lastPrinted = table.columns.length - [...table.columns].reverse().findIndex((column) => !column.excelOnly);

    sheet.pageSetup.printArea = `A${FIRST_PRINTED_ROW}:${sheet.getColumn(Math.min(lastPrinted, table.columns.length)).letter}${lastRow + 1}`;
  }

  return addPrintedArtwork(Buffer.from(await workbook.xlsx.writeBuffer()), report.tables.length, report.orientation);
}
