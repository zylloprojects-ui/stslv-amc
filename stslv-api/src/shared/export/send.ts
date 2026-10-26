import type { Response } from "express";
import { renderExcel } from "./excel";
import { renderPdf } from "./pdf";
import { contentType, exportFileName, type ExportFormat, type ReportDefinition } from "./report";

export function renderReport(report: ReportDefinition, format: ExportFormat): Promise<Buffer> {
  return format === "xlsx" ? renderExcel(report) : renderPdf(report);
}

/**
 * Renders the report and sends it as a download. The document is complete
 * before anything is sent, so a failure is still a normal error response.
 * `recordExport` writes the audit entry; it runs only once the file exists.
 */
export async function sendExport(res: Response, report: ReportDefinition, format: ExportFormat, recordExport: () => Promise<void>): Promise<void> {
  const file = await renderReport(report, format);

  await recordExport();

  res.setHeader("Content-Type", contentType(format));
  res.setHeader("Content-Disposition", `attachment; filename="${exportFileName(report, format)}"`);
  res.setHeader("Content-Length", String(file.length));
  // An export holds business data: it must not be kept by a browser or proxy cache.
  res.setHeader("Cache-Control", "no-store");
  res.send(file);
}
