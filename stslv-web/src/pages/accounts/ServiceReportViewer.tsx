import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Modal, Spinner } from '../../components/ui'
import { download, errorMessage, saveFile } from '../../lib/api'
import { isBrowserViewable } from '../servicesSales/servicesSalesTypes'

/** What the viewer needs to know about the report before it is fetched (the row's own metadata). */
export interface ViewerReport {
  originalName: string
  mimeType: string
}

interface ServiceReportViewerProps {
  /** The visit whose report is shown; the file is fetched from /accounts/:visitId/report with the user's token. */
  visitId: string
  /** "AMC-0007 Q3": names the service in the title and in screen-reader labels. */
  subject: string
  report: ViewerReport
  onClose: () => void
}

/**
 * Accounts' read-only Service Report viewer (client fixes, 2026-11-09). The report uploaded on Service Status for this
 * one service is fetched through the API with the signed-in user's token (ACCOUNTS:VIEW, checked by the API) and shown
 * from a blob: address that exists only in this tab. No storage path or unauthenticated link reaches the browser.
 * Download is offered inside the viewer; a Word document cannot be previewed in the browser, so it offers Download only.
 */
export function ServiceReportViewer({ visitId, subject, report, onClose }: ServiceReportViewerProps) {
  const viewable = isBrowserViewable(report.mimeType)
  const file = useQuery({
    queryKey: ['accounts', 'service-report', visitId],
    queryFn: () => download(`/accounts/${visitId}/report`),
    // Never cached between openings: a replaced report must show its new version.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })
  const [saveError, setSaveError] = useState<string | null>(null)
  // The blob carries the type the row reported, so the browser shows a PDF as a PDF.
  const url = useMemo(() => (file.data && viewable ? URL.createObjectURL(new Blob([file.data.blob], { type: report.mimeType })) : null), [file.data, viewable, report.mimeType])

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])

  const save = () => {
    setSaveError(null)
    if (!file.data) return
    try {
      // The original name as uploaded (already cleaned by the API), never the server's ASCII fallback.
      saveFile({ blob: file.data.blob, filename: report.originalName }, report.originalName)
    } catch (error) {
      setSaveError(errorMessage(error))
    }
  }

  return (
    <Modal
      title={`Service Report · ${subject}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={save} disabled={!file.data} aria-label={`Download service report for ${subject}`}>
            Download
          </Button>
        </>
      }
    >
      <p className="mb-3 break-all text-sm text-slate-600">{report.originalName}</p>
      {file.isPending && <Spinner label="Loading the service report" />}
      {file.isError && <Alert>The service report could not be opened. {errorMessage(file.error)}</Alert>}
      {saveError && <Alert>{saveError}</Alert>}
      {file.data && url && (
        <iframe
          title={`Service report for ${subject}`}
          src={url}
          className="h-[65vh] w-full rounded-lg border border-slate-200 bg-slate-50"
        />
      )}
      {file.data && !viewable && (
        <Alert tone="info">This report is a Word document, which the browser cannot preview. Use Download to open it.</Alert>
      )}
    </Modal>
  )
}
