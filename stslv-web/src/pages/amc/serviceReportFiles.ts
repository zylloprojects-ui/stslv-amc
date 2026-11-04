import { download, saveFile } from '../../lib/api'
import type { ServiceReport } from './serviceStatusTypes'

/** Saves the current report of one service to the user's device. The API checks the permission and the file's checksum. */
export async function downloadServiceReport(visitId: string, report: ServiceReport): Promise<void> {
  saveFile(await download(`/amc/service-status/${visitId}/report/download`), report.originalName)
}

/** Opens a PDF report in a new tab; Word files cannot be shown by the browser and are saved instead. */
export async function openServiceReport(visitId: string, report: ServiceReport): Promise<void> {
  if (report.mimeType !== 'application/pdf') return downloadServiceReport(visitId, report)

  // Opened first, inside the click, so the browser does not block it; filled once the file has arrived.
  const tab = window.open('', '_blank')
  const file = await download(`/amc/service-status/${visitId}/report/download`)
  const url = URL.createObjectURL(new Blob([file.blob], { type: 'application/pdf' }))

  if (tab) tab.location.href = url
  else saveFile(file, report.originalName)
  // Kept long enough for the tab to load it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
