import { readFileSync } from "node:fs";
import path from "node:path";

// The one place that says how an exported document is branded.
//
// The header and footer are the company's official artwork, used as supplied:
// never redrawn, recoloured or stretched. They carry the company name in Arabic
// and English, the logo and the contact details, so the templates print none of
// that as text. assets/branding/source/ holds the two files exactly as they were
// supplied; the copies used here differ only in that the grey frame of the
// screen capture (a few pixels at the edges) is cut off.

/** The company as the application names it. Used only in file properties, never printed over the artwork. */
export const COMPANY_NAME = "Smart Technical Service LLC";
/** The system name as the application shows it. */
export const SYSTEM_NAME = "STSLEV AMC";

/** Colours of the application's default theme, as RRGGBB. */
export const BRAND = {
  navy: "0B3B66",
  blue: "1479BD",
  line: "D7E5F2",
  zebra: "F4F8FC",
  group: "E6F0F8",
  text: "1F2937",
  muted: "64748B",
  white: "FFFFFF",
} as const;

/** Report times are printed in the business time zone. */
export const REPORT_TIME_ZONE = "Asia/Muscat";
export const REPORT_TIME_ZONE_LABEL = "Oman time";

const BRANDING_DIR = path.resolve(__dirname, "..", "..", "..", "assets", "branding");

export interface Artwork {
  png: Buffer;
  /** Pixels. The artwork is always drawn in this proportion. */
  width: number;
  height: number;
}

function loadArtwork(file: string): Artwork {
  const png = readFileSync(path.join(BRANDING_DIR, file));

  // A PNG states its size in its first chunk.
  return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

let header: Artwork | null = null;
let footer: Artwork | null = null;

export function headerArtwork(): Artwork {
  header ??= loadArtwork("report-header.png");

  return header;
}

export function footerArtwork(): Artwork {
  footer ??= loadArtwork("report-footer.png");

  return footer;
}

/** The height the artwork takes when it is drawn at the given width. */
export const artworkHeight = (art: Artwork, width: number): number => (width * art.height) / art.width;
