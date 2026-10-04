import { inflateRawSync } from "node:zlib";

// A small, read-only reader for .xlsx workbooks. It reads what the historical
// import needs and nothing else: cell values exactly as stored, formulas, and
// the font colour of a cell. It never writes a workbook.
//
// Numbers are returned as the text Excel stored, not as JavaScript numbers, so
// no floating-point conversion happens here.

export type CellType = "number" | "text" | "boolean" | "error";

export interface Cell {
  /** "G57" */
  ref: string;
  column: string;
  row: number;
  type: CellType;
  /** The stored value as text. A number is the text Excel wrote for it. */
  value: string;
  /** The formula text, "(shared)" for a cell that repeats a neighbour's formula, or null. */
  formula: string | null;
  /** The font colour as stored ("FF00B050"), or null when the cell uses the default. */
  fontColor: string | null;
}

export interface Sheet {
  name: string;
  /** Cells that hold a value or a formula, by reference. Empty formatted cells are not included. */
  cells: Map<string, Cell>;
  maxRow: number;
}

export interface Workbook {
  sheets: Sheet[];
}

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** The files of a ZIP archive, by path. Supports stored and deflated entries, which is all Excel writes. */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  let end = -1;

  // The end record is at the very end, after an optional comment of up to 65535 bytes.
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65535); offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }

  if (end < 0) {
    throw new Error("Not a ZIP archive: the end-of-central-directory record was not found.");
  }

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error("Corrupt ZIP archive: a central directory entry is missing.");
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported.");
    }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error(`Corrupt ZIP archive: the entry "${name}" has no local header.`);
    }

    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      files.set(name, Buffer.from(data));
    } else if (method === 8) {
      files.set(name, inflateRawSync(data));
    } else {
      throw new Error(`The entry "${name}" uses an unsupported compression method (${method}).`);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

// ---------------------------------------------------------------------------
// XML helpers. The workbook parts are machine-written and regular, so they are
// read with patterns rather than a general XML parser.
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }

    return ENTITIES[entity] ?? whole;
  });
}

const attribute = (attributes: string, name: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);

  return match ? unescapeXml(match[1] as string) : null;
};

/** The text of every <t> element in a fragment, joined. Phonetic guides are left out. */
function textOf(fragment: string): string {
  const withoutPhonetic = fragment.replace(/<rPh[\s\S]*?<\/rPh>/g, "");
  let text = "";

  for (const match of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    text += unescapeXml(match[1] as string);
  }

  return text;
}

function part(files: Map<string, Buffer>, name: string): string {
  const file = files.get(name);

  if (!file) {
    throw new Error(`The workbook has no "${name}" part.`);
  }

  return file.toString("utf8");
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

export function readWorkbook(buffer: Buffer): Workbook {
  const files = readZip(buffer);
  const workbookXml = part(files, "xl/workbook.xml");

  if (/<workbookPr[^>]*date1904="(1|true)"/.test(workbookXml)) {
    throw new Error("The workbook uses the 1904 date system, which is not supported.");
  }

  const relationships = new Map<string, string>();

  for (const match of part(files, "xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const id = attribute(match[1] as string, "Id");
    const target = attribute(match[1] as string, "Target");

    if (id && target) {
      relationships.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }

  const sharedStrings = files.has("xl/sharedStrings.xml")
    ? [...part(files, "xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((match) => textOf(match[1] ?? ""))
    : [];
  const fontColors = readFontColors(files.has("xl/styles.xml") ? part(files, "xl/styles.xml") : "");
  const sheets: Sheet[] = [];

  for (const match of workbookXml.matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const attributes = match[1] as string;
    const name = attribute(attributes, "name");
    const target = relationships.get(attribute(attributes, "r:id") ?? "");

    if (name === null || target === undefined) {
      throw new Error("The workbook lists a sheet that cannot be located.");
    }

    sheets.push(readSheet(name, part(files, target), sharedStrings, fontColors));
  }

  return { sheets };
}

/** The font colour of each cell style, by style index. */
function readFontColors(stylesXml: string): (string | null)[] {
  const fontsBlock = /<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml)?.[1] ?? "";
  const fonts = [...fontsBlock.matchAll(/<font>([\s\S]*?)<\/font>|<font\/>/g)].map(
    (match) => /<color\s[^>]*rgb="([^"]*)"/.exec(match[1] ?? "")?.[1] ?? null
  );
  const stylesBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";

  return [...stylesBlock.matchAll(/<xf\s([^>]*?)\/?>/g)].map((match) => fonts[Number(attribute(match[1] as string, "fontId") ?? "0")] ?? null);
}

function readSheet(name: string, xml: string, sharedStrings: string[], fontColors: (string | null)[]): Sheet {
  const cells = new Map<string, Cell>();
  let maxRow = 0;

  for (const match of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attributes = match[1] as string;
    const body = match[2] ?? "";
    const ref = attribute(attributes, "r");
    const position = ref ? /^([A-Z]+)(\d+)$/.exec(ref) : null;

    if (!ref || !position) {
      continue;
    }

    const formulaMatch = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>|<f(?:\s[^>]*)?\/>/.exec(body);
    const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
    const storedType = attribute(attributes, "t") ?? "n";
    let value: string | null = valueMatch ? unescapeXml(valueMatch[1] as string) : null;
    let type: CellType = "number";

    if (storedType === "s") {
      type = "text";
      value = value === null ? null : (sharedStrings[Number(value)] ?? "");
    } else if (storedType === "inlineStr") {
      type = "text";
      value = textOf(body);
    } else if (storedType === "str") {
      type = "text";
    } else if (storedType === "b") {
      type = "boolean";
    } else if (storedType === "e") {
      type = "error";
    }

    // A cell with formatting only holds nothing: it is the same as no cell.
    if (value === null && !formulaMatch) {
      continue;
    }

    const row = Number(position[2]);

    cells.set(ref, {
      ref,
      column: position[1] as string,
      row,
      type,
      value: value ?? "",
      formula: formulaMatch ? (formulaMatch[1] ? unescapeXml(formulaMatch[1]) : "(shared)") : null,
      fontColor: fontColors[Number(attribute(attributes, "s") ?? "0")] ?? null,
    });
    maxRow = Math.max(maxRow, row);
  }

  return { name, cells, maxRow };
}

// ---------------------------------------------------------------------------
// Addresses and dates
// ---------------------------------------------------------------------------

/** "A" -> 1, "Z" -> 26, "AA" -> 27. */
export function columnNumber(column: string): number {
  let number = 0;

  for (const letter of column) {
    number = number * 26 + (letter.charCodeAt(0) - 64);
  }

  return number;
}

/** 1 -> "A", 27 -> "AA". */
export function columnLetters(number: number): string {
  let letters = "";

  for (let rest = number; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }

  return letters;
}

/**
 * An Excel day serial as a calendar day, "YYYY-MM-DD". Null when the cell
 * does not hold a whole number of days in a plausible range.
 */
export function serialToIsoDate(serial: string): string | null {
  if (!/^\d{1,6}$/.test(serial)) {
    return null;
  }

  const days = Number(serial);

  // 1 Mar 1900 onwards: before that, Excel's serials include a day that never existed.
  if (days < 61 || days > 2_958_465) {
    return null;
  }

  return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000).toISOString().slice(0, 10);
}
