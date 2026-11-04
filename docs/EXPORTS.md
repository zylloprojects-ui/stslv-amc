# STSLV AMC — PDF and Excel Exports

How exports work, what is built, and how to add one to another module.

## Status

| Step | Scope | State |
|---|---|---|
| 1 | Shared export engine, permissions, AMC Schedule | Built |
| 2a | Official header and footer artwork in both templates; Invoice Tracking and Pending Invoices reports | Built. Awaiting approval of the sample files. |
| 2b | Projects list, Project summary | Not started |
| 3 | Expenses, Procurement, AMC Contracts and contract summary, AMC Execution, internal visit record | Not started |
| 4 | Clients, Historical Data (Excel only), Dashboard summary (PDF only) | Not started |

No export exists for an individual invoice: a PDF of one would resemble a Zoho tax invoice. Users, Roles and Settings have no export.

## Decisions

| Subject | Decision |
|---|---|
| PDF page | Every application-generated PDF is A4 landscape (297 × 210 mm) with no letterhead: no header or footer artwork, logo or branded background (decided 2026-11-04). |
| Excel header and footer | The company's official artwork, on screen and on every printed Excel page. Never redrawn, recoloured or stretched. Unchanged by the PDF decision. |
| Company details | Excel: only what the artwork carries. PDF: none are printed; the company name is in the file properties only. |
| Uploaded documents | Signed contracts, service reports, attachments and other uploaded files are never re-rendered; a download returns the original bytes. |
| Invoice reports | Every page says "Internal tracking report. Not an official tax invoice." |
| Currency | Amounts keep three decimals and carry no currency label. The single-currency question (Q18) is still open. |
| Time zone | "Generated" times are in Asia/Muscat, printed as "Oman time". |
| Permission | Exporting needs `EXPORT` on the module as well as `VIEW`. Only Admin holds `EXPORT`; an Admin grants it per role in Roles & Permissions. No role is given it automatically. |
| Libraries | `exceljs`, `pdfmake` and `jszip`, in the API only. |

## The PDF page

Defined once in `stslv-api/src/shared/export/pdf.ts` (`PDF_PAGE`, `pageLayout()`), and used by every PDF export:

- A4 landscape, 841.89 × 595.28 pt, whatever `orientation` the report declares. `ReportDefinition.orientation` now only sets how the Excel workbook prints.
- Margins: 28 pt each side, 54 pt top, 40 pt bottom.
- Top of every page: the report title (bold, 12 pt) and, on the right, the period, over a thin rule.
- Bottom of every page: a thin rule; under it the standing disclaimer (if the report has one), "Generated <time> by <user> · STSLEV AMC", and "Page n of N" on the right.
- Under the title on the first page: the filters applied.
- Tables: Roboto 8 pt, a navy heading row repeated on every page, rows never split across pages, zebra striping, group headings and a totals row where the report defines them. A group heading (a month, for example) is never left alone at the foot of a page: it and the group's first row are laid out as one row, which moves to the next page together if it does not fit. Columns share the full width between the margins in proportion to their declared widths, so a table never runs off the page; long text wraps inside its column.
- No images of any kind are embedded.

## The artwork (Excel only)

- `stslv-api/assets/branding/source/` holds the two images exactly as supplied.
- `report-header.png` and `report-footer.png` beside it are the copies the templates use. They differ from the supplied files only in that the grey frame of the screen capture is cut off: header 4 px left, 1 px right, 6 px top; footer 1 px bottom. Every remaining pixel is identical.
- To replace the artwork (for example with a higher-resolution original), replace those two files. The layouts work out all sizes and margins from the image dimensions.

**Excel.** On screen, the header artwork is at the top of each sheet and the footer artwork under the report. On paper, the artwork is the page header and footer of every printed page. The on-screen pictures are marked not to print, so nothing prints twice. Workbook-only columns at the end of a sheet (notes and the like) are left out of the printed area. The printed Excel pages carry no page number: Excel cannot place text beside a picture in the same part of the footer without overlapping it.

## How it works

Exports are produced by the API, never in the browser, so the permission check, the filters and the figures are the same ones the list uses.

```
GET /api/amc/visits/export?format=xlsx|pdf&<the schedule's filters>
GET /api/invoices/export?format=xlsx|pdf&<the invoice list's filters>
GET /api/invoices/billable/export?format=xlsx|pdf[&clientId=]
```

- `stslv-api/src/shared/export/report.ts`: the report model. A module describes its report once (title, period, filters, tables, totals) and both formats are drawn from it.
- `excel.ts`, `pdf.ts`: the two templates.
- `branding.ts`: the Excel artwork, system name and colours.
- `send.ts`: sends the file as a download and writes the audit entry once the file exists.

Rules the engine enforces for every export:

- **Formula injection.** Text that starts with `=`, `+`, `-`, `@`, a tab or a line break is written with a leading apostrophe. Text is never written as a formula.
- **Identifiers.** Job and invoice numbers are text cells in text format, so leading zeros survive.
- **Real values.** Dates are Excel dates, amounts and counts are numbers, so they sort, filter and sum.
- **Totals.** Calculated by PostgreSQL. The workbook also carries a formula that gives the same figure.
- **Size.** A PDF holds at most 2,000 rows and a workbook 50,000; a larger request is refused with a message.
- **Audit.** Each export is written to `activity_logs` with the user, format, filters and row count.
- **File names.** Built from fixed text and the clock, never from user input.

## Reports

The orientation in brackets is how the Excel workbook prints; every PDF is A4 landscape.

**AMC Schedule** (landscape). Every visit that matches the schedule's filters, in the schedule's order. Cancelled visits are listed but not counted in the total. The PDF is grouped by month.

**Invoice Tracking Report** (portrait). The invoices recorded, for the list's filters, newest first, with the list's own totals. A cancelled invoice is listed and counted in no total. The workbook has a second sheet, Allocations, with one line per visit or project an invoice covers. Exporting reads only; no invoice is created or changed, and Zoho is not contacted.

**Pending Invoices Report** (portrait). Exactly the "Waiting for an invoice" list: completed AMC visits with an amount that no active invoice covers, and completed projects with job value that no active invoice covers yet. Fully invoiced work is never in it and cannot be requested. AMC and project figures are totalled separately. A section appears only for a role that may see it on the screen (AMC Schedule or Projects view).

## Adding an export to a module

1. Share the list's filter with an unpaged query (see `visitFilter`/`listAllVisits` and `invoiceFilter`/`listAllInvoices`).
2. Write `<module>.export.ts` returning a `ReportDefinition` and its audit entry.
3. Add `GET .../export` behind `authorize(MODULE, "VIEW")` and `authorize(MODULE, "EXPORT")`, declared before any `/:id` route.
4. Put `<ExportButtons>` on the page, shown only when `auth.can(MODULE, 'EXPORT')`.
5. Test permissions, filters, row count against the list, and totals.

## Samples

`npm run export:sample` in `stslv-api` writes a sample workbook and PDF of each report to `export-samples/` (ignored by Git). The data is invented; no database is read.

## Known limits

- The supplied artwork is about 1,330 pixels wide: sharp on screen, slightly soft when an Excel sheet is printed. A higher-resolution original would print crisper.
- The PDF font (Roboto, shipped with pdfmake) covers Latin, Greek and Cyrillic. Arabic text in the data would need another font and right-to-left layout.
- A single row taller than a whole page (which no current report produces) cannot be kept on one page.
